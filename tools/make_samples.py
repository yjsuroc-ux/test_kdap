"""시험용 샘플 파일 만들기: samples_test/ 폴더에 접수 목록 엑셀 1개와 HWP 본문 여러 개를 만든다.
(samples/ 폴더의 실제 형식 샘플은 건드리지 않는다.)

실행: python tools\\make_samples.py
"""
import datetime as dt
import os
import struct
import zlib

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples_test")

# ---------------------------------------------------------------- 최소 HWP 5.0 (OLE 복합 문서) 작성기

SECTOR = 512
FREESECT, ENDOFCHAIN, FATSECT, NOSTREAM = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF


def _pad(data, size):
    return data + b"\0" * (-len(data) % size)


def _dir_entry(name, typ, child=NOSTREAM, left=NOSTREAM, right=NOSTREAM, start=ENDOFCHAIN, size=0):
    n = name.encode("utf-16le") + b"\0\0"
    return (n.ljust(64, b"\0") + struct.pack("<HBB", len(n), typ, 1) + struct.pack("<III", left, right, child)
            + b"\0" * 16 + b"\0" * 4 + b"\0" * 16 + struct.pack("<IQ", start, size))


def write_ole(path, file_header, section0):
    # 미니 스트림을 쓰지 않도록 두 스트림 모두 4096바이트 이상으로 맞춘다.
    fh = file_header.ljust(4096, b"\0")
    s0 = section0 if len(section0) >= 4096 else section0 + b"\0" * (4096 - len(section0))
    fh_secs = len(_pad(fh, SECTOR)) // SECTOR
    s0_secs = len(_pad(s0, SECTOR)) // SECTOR
    fh_start = 2
    s0_start = fh_start + fh_secs
    total = s0_start + s0_secs
    assert total <= 128, "샘플이 너무 큼"
    fat = [FATSECT, ENDOFCHAIN]
    for start, cnt in ((fh_start, fh_secs), (s0_start, s0_secs)):
        fat += [start + i + 1 for i in range(cnt - 1)] + [ENDOFCHAIN]
    fat += [FREESECT] * (128 - len(fat))
    # 디렉터리: 0 Root, 1 FileHeader, 2 BodyText, 3 Section0  (BodyText < FileHeader: 이름 길이순)
    dirs = (_dir_entry("Root Entry", 5, child=1)
            + _dir_entry("FileHeader", 2, left=2, start=fh_start, size=len(fh))
            + _dir_entry("BodyText", 1, child=3)
            + _dir_entry("Section0", 2, start=s0_start, size=len(s0)))
    header = (bytes.fromhex("D0CF11E0A1B11AE1") + b"\0" * 16 + struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6)
              + b"\0" * 6 + struct.pack("<IIIIIIIII", 0, 1, 1, 0, 4096, ENDOFCHAIN, 0, ENDOFCHAIN, 0)
              + struct.pack("<I", 0) + struct.pack("<I", FREESECT) * 108)
    with open(path, "wb") as f:
        f.write(header.ljust(SECTOR, b"\0"))
        f.write(struct.pack("<128I", *fat))
        f.write(dirs)
        f.write(_pad(fh, SECTOR))
        f.write(_pad(s0, SECTOR))


def _record(tag, data, level=0):
    size = len(data)
    if size >= 0xFFF:
        return struct.pack("<II", tag | (level << 10) | (0xFFF << 20), size) + data
    return struct.pack("<I", tag | (level << 10) | (size << 20)) + data


def make_hwp(path, paragraphs, distribution=False):
    props = 0x01 | (0x04 if distribution else 0)
    file_header = b"HWP Document File".ljust(32, b"\0") + struct.pack("<II", 0x05000300, props)
    recs = b""
    for p in paragraphs:
        text = p.encode("utf-16le") + struct.pack("<H", 13)
        recs += _record(66, b"\0" * 22) + _record(67, text, level=1)
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    write_ole(path, file_header, comp.compress(recs) + comp.flush())


# ---------------------------------------------------------------- 샘플 내용

def body(title, sender, lines, docno, sihaeng_date, recv_no, recv_date):
    return [f"{sender}", "수신  수신자 참조", "(경유)", f"제목  {title}", "", *lines, "", "끝.", "",
            f"{sender}장", f"시행  {docno}  ({sihaeng_date})    접수  {recv_no}  ({recv_date})",
            "우 04383  서울특별시 용산구 ○○로 22  / 전화 02-123-4567"]


def main():
    os.makedirs(OUT, exist_ok=True)
    t = dt.date.today()
    rd = lambda n: t - dt.timedelta(days=n)  # noqa: E731
    fd = lambda d: f"{d.year}. {d.month}. {d.day}."  # noqa: E731
    md = lambda d: f"{d.month}. {d.day}."  # noqa: E731
    wd = lambda d: "월화수목금토일"[d.weekday()]  # noqa: E731
    docs = [
        dict(no="정보통신과-1234", title="2027년 정보화 소요 검토 결과 회신 요청", sender="○○본부 정보통신과", recv=rd(1), who="김민수",
             lines=["1. 관련: 정보통신과-1100(2026. 9. 30.) 「정보화 사업 추진 계획」",
                    "2. 위 호와 관련하여 2027년 정보화 소요를 검토하고 심의위원회를 개최하여 그 결과를 "
                    f"{md(t + dt.timedelta(days=8))}({wd(t + dt.timedelta(days=8))})까지 회신하여 주시기 바랍니다.",
                    "3. 제출 양식: 붙임 참조"]),
        dict(no="총무과-567", title="동절기 화재 예방 교육 실시 알림", sender="○○본부 총무과", recv=rd(2), who="이서연",
             lines=["1. 동절기 화재 예방을 위하여 아래와 같이 교육을 실시하니 소속 직원에게 알려 주시기 바랍니다.",
                    f"  가. 일시: {fd(t + dt.timedelta(days=12))} 14:00", "  나. 장소: 대강당",
                    f"2. 각 부서는 {md(t + dt.timedelta(days=5))}까지 게시판에 게시하여 전파하여 주시기 바랍니다."]),
        dict(no="기획예산과-890", title="2026년 하반기 예산 집행 실적 제출", sender="○○청 기획예산과", recv=rd(3), who="김민수",
             lines=["1. 2026년 하반기 예산 집행 실적을 붙임 서식에 따라 작성하여",
                    f"'{t.year % 100}. {(t + dt.timedelta(days=2)).month}. {(t + dt.timedelta(days=2)).day}.한 제출하여 주시기 바랍니다.",
                    "2. 기한 내 미제출 시 집행 실적이 없는 것으로 간주합니다."]),
        dict(no="인사과-321", title="2026년 하반기 인사 발령 통보", sender="○○본부 인사과", recv=rd(1), who="박지훈",
             lines=["1. 2026년 하반기 정기 인사 발령 사항을 붙임과 같이 통보합니다.",
                    "2. 업무에 참고하시기 바랍니다."]),
        dict(no="감사과-445", title="청렴 서약서 제출 요청", sender="○○본부 감사과", recv=rd(10), who="이서연",
             lines=["1. 연말 청렴 서약서를 작성하여 제출하여 주시기 바랍니다.",
                    f"2. 제출 기한: {(t - dt.timedelta(days=2)).month}월 {(t - dt.timedelta(days=2)).day}일까지"]),
        dict(no="시설과-778", title="청사 시설 점검 결과 보고", sender="○○본부 시설과", recv=rd(0), who="박지훈",
             lines=["1. 각 부서는 소관 시설을 점검하고 그 결과를 보고하여 주시기 바랍니다.",
                    "2. 제출 일정은 추후 별도 안내 예정입니다."]),
        dict(no="교육과-112", title="정보보호 교육 계획 전파", sender="○○청 교육과", recv=rd(1), who="최유진",
             lines=["1. 2026년 4분기 정보보호 교육 계획을 붙임과 같이 하달하니 예하부대에 알려 주시기 바랍니다.",
                    f"2. 교육 기간: {fd(t + dt.timedelta(days=20))} ~ {fd(t + dt.timedelta(days=24))}"]),
        dict(no="정보통신과-1240", title="보안 점검표 제출(배포용 문서)", sender="○○본부 정보통신과", recv=rd(1), who="최유진",
             lines=["(배포용 문서)"], dist=True),
    ]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "접수문서"
    ws.append(["접수문서 목록"])
    ws.append([])
    ws.append(["순번", "접수일자", "문서번호", "제목", "발신기관", "처리자", "처리상태"])
    for i, d in enumerate(docs, 1):
        ws.append([i, dt.datetime.combine(d["recv"], dt.time(9, 30)), d["no"], d["title"], d["sender"], d["who"], "접수"])
    # 본문 파일이 없는 행
    ws.append([len(docs) + 1, dt.datetime.combine(rd(0), dt.time(10, 0)), "법무과-99", "규정 개정안 의견 조회", "○○본부 법무과", "김민수", "접수"])
    for col, w in zip("ABCDEFG", (6, 18, 18, 44, 22, 10, 10)):
        ws.column_dimensions[col].width = w
    wb.save(os.path.join(OUT, "접수목록.xlsx"))

    for i, d in enumerate(docs, 1):
        name = f"{i:02d}_{d['title'][:20]}.hwp".replace("/", "_")
        paras = body(d["title"], d["sender"], d["lines"], d["no"], fd(d["recv"] - dt.timedelta(days=1)),
                     f"우리과-{500 + i}", fd(d["recv"]))
        if i == 6:
            # 문서번호(시행 줄)가 없는 문서 → 미매칭 예시
            paras = [p for p in paras if not p.startswith("시행")]
        make_hwp(os.path.join(OUT, name), paras, distribution=d.get("dist", False))
    print(f"샘플 파일을 만들었습니다: {OUT}")


if __name__ == "__main__":
    main()
