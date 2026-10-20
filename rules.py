"""규칙 기반 자동 식별: 문서번호, 처리 유형(회신/전파/해당 없음), 회신 기한 (PRD 7장)."""
import datetime as dt
import json
import os
import re

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules_config.json")

TYPE_REPLY = "회신"
TYPE_SPREAD = "전파"
TYPE_NONE = "해당없음"


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def compact(s):
    return re.sub(r"\s+", "", s or "")


# ---------------------------------------------------------------- 문서번호 (7-1)

_DASHES = str.maketrans({"－": "-", "–": "-", "—": "-", "‐": "-", "‑": "-", "−": "-"})


def normalize_docno(s):
    """공백·괄호를 지우고 '부서명-숫자' 부분만 남긴다."""
    if s is None:
        return ""
    s = str(s).translate(_DASHES)
    s = re.sub(r"[(（\[［].*?[)）\]］]", "", s)  # 괄호 안 내용(날짜 등) 제거
    s = re.sub(r"[\s()（）\[\]［］{}<>「」『』]", "", s)
    m = re.match(r"(.*-\d+)", s)
    return m.group(1) if m else s


_SIHAENG = re.compile(r"(?<![가-힣])시\s?행\s*[:：]?\s+(?!일)([^\n\r\t()（:：]{1,40}?)\s*[-－–—]\s*(\d+)")


def find_docno(text):
    """공문 하단 '시행' 줄의 '부서명-숫자'를 찾는다. 없으면 None."""
    return _find_numbered(_SIHAENG, text)


_JEOPSU = re.compile(r"(?<![가-힣])접\s?수\s*[:：]?\s+(?!일)([^\n\r\t()（:：]{1,40}?)\s*[-－–—]\s*(\d+)")


def find_receipt_no(text):
    """공문 하단 '접수' 칸의 접수번호(우리 부서 번호)를 찾는다. 없으면 None."""
    return _find_numbered(_JEOPSU, text)


def _find_numbered(pattern, text):
    for m in pattern.finditer(text or ""):
        dept = m.group(1).strip()
        if re.search(r"[가-힣A-Za-z]", dept):
            return f"{dept}-{m.group(2)}", m.group(0).strip()
    return None, None


# ---------------------------------------------------------------- 문장 나누기

_FOOTER_LINE = re.compile(r"(?<![가-힣])(시\s?행|접\s?수)\s+[^\n]{0,40}?-\s*\d+")


def split_sentences(text):
    out = []
    for line in re.split(r"[\r\n]+", text or ""):
        line = re.sub(r"[ \t　]+", " ", line).strip()
        if not line:
            continue
        for part in re.split(r"(?<=[다요음함])\.\s+", line):
            part = part.strip()
            if part:
                out.append(part)
    return out


def _ignored(sentence, cfg):
    if _FOOTER_LINE.search(sentence):
        return True
    for pat in cfg.get("ignore_line_patterns", []):
        if re.search(pat, sentence):
            return True
    return False


# ---------------------------------------------------------------- 처리 유형 (7-2)

def classify(sentences, cfg):
    reply_kw = [compact(k) for k in cfg.get("reply_keywords", [])]
    spread_kw = [compact(k) for k in cfg.get("spread_keywords", [])]
    reply_hits, spread_hits = [], []
    for s in sentences:
        if _ignored(s, cfg):
            continue
        c = compact(s)
        if any(k and k in c for k in reply_kw):
            reply_hits.append(s)
        if any(k and k in c for k in spread_kw):
            spread_hits.append(s)
    if reply_hits:
        # 회신과 전파 문구가 모두 있으면 회신. 근거에 두 문장을 모두 보여 준다.
        ev = reply_hits[:2] + spread_hits[:1]
        return TYPE_REPLY, ev
    if spread_hits:
        return TYPE_SPREAD, spread_hits[:2]
    return TYPE_NONE, []


# ---------------------------------------------------------------- 회신 기한 (7-3)

_WD = r"(?:\s*[(（]\s*[월화수목금토일]\s*[)）])?"
_FULL = r"(?<!\d)(?P<y>(?:19|20)\d{2}|['’‘]\d{2})\s*[.\-/]\s*(?P<m>\d{1,2})\s*[.\-/]\s*(?P<d>\d{1,2})(?!\d)\.?"
_KOR = r"(?:(?P<ky>(?:19|20)\d{2})\s*년\s*)?(?<!\d)(?P<km>\d{1,2})\s*월\s*(?P<kd>\d{1,2})\s*일"
_SHORT = (r"(?<![\d.'’])(?P<sm>\d{1,2})\s*\.\s*(?P<sd>\d{1,2})"
          r"(?:\s*\.(?!\s*\d{1,2}\s*\.)|(?=\s*[(（][월화수목금토일]))")
DATE_RE = re.compile(f"(?:{_FULL}|{_KOR}|{_SHORT}){_WD}(?P<suf>\\s*(?:까지|한))?")


def parse_dates(sentence, ref):
    """문장 안의 날짜들 → [(date, '까지/한' 접미 여부)]. 연도가 없으면 ref 연도, ref보다 이르면 다음 해."""
    out = []
    for m in DATE_RE.finditer(sentence):
        if m.group("m"):
            y = m.group("y")
            year = 2000 + int(y[1:]) if not y[0].isdigit() else int(y)
            mon, day, has_year = int(m.group("m")), int(m.group("d")), True
        elif m.group("km"):
            has_year = bool(m.group("ky"))
            year = int(m.group("ky")) if has_year else ref.year
            mon, day = int(m.group("km")), int(m.group("kd"))
        else:
            has_year, year = False, ref.year
            mon, day = int(m.group("sm")), int(m.group("sd"))
        try:
            d = dt.date(year, mon, day)
        except ValueError:
            continue
        if not has_year and d < ref:
            try:
                d = dt.date(year + 1, mon, day)
            except ValueError:
                continue
        out.append((d, bool(m.group("suf"))))
    return out


def find_deadline(sentences, received, cfg):
    ref = received or dt.date.today()
    ctx_kw = [compact(k) for k in cfg.get("deadline_context_keywords", [])]
    ctx, suffixed = [], []
    for s in sentences:
        if _ignored(s, cfg):
            continue
        dates = parse_dates(s, ref)
        if not dates:
            continue
        c = compact(s)
        in_ctx = any(k and k in c for k in ctx_kw)
        for d, suf in dates:
            if received and d < received:
                continue  # 접수일 이전 날짜는 기한이 아님
            if in_ctx:
                ctx.append((d, suf, s))
            if suf:
                suffixed.append((d, suf, s))
    if ctx:
        # 같은 문장 안 날짜 우선. '까지/한'이 붙은 날짜가 있으면 그중에서, 가장 이른 날짜
        pool = [c for c in ctx if c[1]] or ctx
        best = min(pool, key=lambda c: c[0])
        return best[0], best[2]
    if suffixed:
        best = min(suffixed, key=lambda c: c[0])
        return best[0], best[2]
    return None, None


# ---------------------------------------------------------------- 전체 식별

def classify_title(title, cfg):
    """본문이 없을 때 제목만으로 유형을 추정한다. 못 찾으면 None."""
    c = compact(title)
    if not c:
        return None
    for typ, key in ((TYPE_REPLY, "title_reply_keywords"), (TYPE_SPREAD, "title_spread_keywords")):
        if any(k and compact(k) in c for k in cfg.get(key, [])):
            return typ
    return None


def identify(text, received=None, cfg=None, title=None):
    """본문 텍스트 → 유형·기한 식별 결과와 근거 문장.
    type_basis: 'body'(본문 문구) / 'title'(제목으로 추정) / None"""
    cfg = cfg or load_config()
    sentences = split_sentences(text)
    typ, type_ev = classify(sentences, cfg)
    basis = "body" if typ != TYPE_NONE else None
    if typ == TYPE_NONE:
        t = classify_title(title, cfg)
        if t:
            typ, type_ev, basis = t, [f"제목: {title}"], "title"
    deadline, dl_ev = find_deadline(sentences, received, cfg)
    return {
        "type": typ,
        "type_auto": typ != TYPE_NONE,
        "type_basis": basis,
        "type_check": basis == "title",
        "deadline": deadline.isoformat() if deadline else None,
        "deadline_auto": deadline is not None,
        "deadline_check": deadline is None and typ != TYPE_NONE,
        "evidence": {"type": type_ev, "deadline": dl_ev},
    }


def no_body_result(title=None, cfg=None):
    """본문이 없거나 읽을 수 없을 때. 제목에 단서가 있으면 유형만 추정해 둔다."""
    cfg = cfg or load_config()
    t = classify_title(title, cfg)
    return {
        "type": t or "",
        "type_auto": bool(t),
        "type_basis": "title" if t else None,
        "type_check": True,
        "deadline": None,
        "deadline_auto": False,
        "deadline_check": True,
        "evidence": {"type": [f"제목: {title}"] if t else [], "deadline": None},
    }
