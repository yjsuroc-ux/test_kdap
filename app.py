"""문서 처리 기한 관리 도구 - 서버.

실행: python app.py  (기본 포트 8000, 환경변수 PORT로 변경)
"""
import datetime as dt
import json
import os
import socket
import threading
import time
import uuid

from flask import Flask, g, jsonify, request, send_from_directory

import db
import parsers
import rules

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=STATIC, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # 화면 파일을 고치면 바로 반영되도록
try:
    app.json.ensure_ascii = False
except AttributeError:
    app.config["JSON_AS_ASCII"] = False

TYPES = (rules.TYPE_REPLY, rules.TYPE_SPREAD)


class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.msg, self.status = msg, status


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify(error=e.msg), e.status


@app.errorhandler(413)
def _too_large(e):
    return jsonify(error="파일이 너무 큽니다(최대 300MB)."), 413


def conn():
    if "db" not in g:
        g.db = db.connect()
    return g.db


@app.teardown_appcontext
def _close(exc):
    c = g.pop("db", None)
    if c is not None:
        c.close()


def body():
    return request.get_json(silent=True) or {}


def actor():
    """화면에서 선택한 담당자(X-Staff-Id 헤더)."""
    sid = request.headers.get("X-Staff-Id", "")
    row = conn().execute("SELECT * FROM staff WHERE id=?", (sid,)).fetchone() if sid.isdigit() else None
    if row is None:
        raise ApiError("담당자를 먼저 선택해 주세요.", 401)
    return row


def valid_date(s, field="기한"):
    if s in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(str(s)[:10]).isoformat()
    except ValueError:
        raise ApiError(f"{field} 날짜 형식이 올바르지 않습니다.")


# ================================================================ 담당자

@app.get("/api/staff")
def staff_list():
    rows = conn().execute("SELECT * FROM staff ORDER BY active DESC, name").fetchall()
    return jsonify([dict(r) for r in rows])


def get_or_create_staff(name):
    name = (name or "").strip()
    if not name:
        return None
    c = conn()
    row = c.execute("SELECT * FROM staff WHERE name=?", (name,)).fetchone()
    if row:
        if not row["active"]:
            c.execute("UPDATE staff SET active=1 WHERE id=?", (row["id"],))
        return row["id"]
    return c.execute("INSERT INTO staff(name) VALUES (?)", (name,)).lastrowid


@app.post("/api/staff")
def staff_create():
    name = (body().get("name") or "").strip()
    if not name:
        raise ApiError("이름을 입력해 주세요.")
    if conn().execute("SELECT 1 FROM staff WHERE name=?", (name,)).fetchone():
        raise ApiError("이미 있는 이름입니다.")
    sid = conn().execute("INSERT INTO staff(name) VALUES (?)", (name,)).lastrowid
    conn().commit()
    return jsonify(id=sid)


@app.put("/api/staff/<int:sid>")
def staff_update(sid):
    b = body()
    c = conn()
    row = c.execute("SELECT * FROM staff WHERE id=?", (sid,)).fetchone()
    if not row:
        raise ApiError("담당자를 찾을 수 없습니다.", 404)
    name = (b.get("name", row["name"]) or "").strip()
    if not name:
        raise ApiError("이름을 입력해 주세요.")
    dup = c.execute("SELECT 1 FROM staff WHERE name=? AND id<>?", (name, sid)).fetchone()
    if dup:
        raise ApiError("같은 이름이 이미 있습니다.")
    active = 1 if b.get("active", row["active"]) else 0
    c.execute("UPDATE staff SET name=?, active=? WHERE id=?", (name, active, sid))
    c.commit()
    return jsonify(ok=True)


# ================================================================ 템플릿

def templates_all():
    c = conn()
    out = []
    for t in c.execute("SELECT * FROM template ORDER BY name").fetchall():
        steps = c.execute(
            "SELECT name, days_before FROM template_step WHERE template_id=? ORDER BY ord", (t["id"],)
        ).fetchall()
        out.append({"id": t["id"], "name": t["name"], "steps": [dict(s) for s in steps]})
    return out


def save_template_steps(tid, steps):
    c = conn()
    c.execute("DELETE FROM template_step WHERE template_id=?", (tid,))
    for i, s in enumerate(steps or []):
        name = (s.get("name") or "").strip()
        if not name:
            continue
        try:
            days = int(s.get("days_before") or 0)
        except (TypeError, ValueError):
            raise ApiError("'며칠 전' 값은 숫자여야 합니다.")
        c.execute(
            "INSERT INTO template_step(template_id, ord, name, days_before) VALUES (?,?,?,?)",
            (tid, i, name, days),
        )


@app.get("/api/templates")
def template_list():
    return jsonify(templates_all())


@app.post("/api/templates")
def template_create():
    b = body()
    name = (b.get("name") or "").strip()
    if not name:
        raise ApiError("템플릿 이름을 입력해 주세요.")
    tid = conn().execute("INSERT INTO template(name) VALUES (?)", (name,)).lastrowid
    save_template_steps(tid, b.get("steps"))
    conn().commit()
    return jsonify(id=tid)


@app.put("/api/templates/<int:tid>")
def template_update(tid):
    b = body()
    name = (b.get("name") or "").strip()
    if not name:
        raise ApiError("템플릿 이름을 입력해 주세요.")
    if not conn().execute("SELECT 1 FROM template WHERE id=?", (tid,)).fetchone():
        raise ApiError("템플릿을 찾을 수 없습니다.", 404)
    conn().execute("UPDATE template SET name=? WHERE id=?", (name, tid))
    save_template_steps(tid, b.get("steps"))
    conn().commit()
    return jsonify(ok=True)


@app.delete("/api/templates/<int:tid>")
def template_delete(tid):
    conn().execute("DELETE FROM template WHERE id=?", (tid,))
    conn().commit()
    return jsonify(ok=True)


# ================================================================ 업무

TASK_COLS = """t.id, t.source, t.doc_no, t.receipt_no, t.title, t.sender, t.produced_date, t.received_date,
    t.assignee_id,
    s.name AS assignee_name, t.type, t.deadline, t.type_source, t.deadline_source, t.status,
    t.completed_at, t.memo, t.created_at, t.updated_at, t.updated_by"""


def steps_of(task_ids):
    if not task_ids:
        return {}
    out = {i: [] for i in task_ids}
    q = ",".join("?" * len(task_ids))
    for r in conn().execute(f"SELECT * FROM step WHERE task_id IN ({q}) ORDER BY ord, id", task_ids):
        d = dict(r)
        d["done"] = bool(d["done"])
        out[r["task_id"]].append(d)
    return out


def load_task(tid, full=False):
    cols = TASK_COLS + (", t.evidence, t.body_text" if full else "")
    row = conn().execute(
        f"SELECT {cols} FROM task t LEFT JOIN staff s ON s.id=t.assignee_id WHERE t.id=?", (tid,)
    ).fetchone()
    if not row:
        raise ApiError("업무를 찾을 수 없습니다.", 404)
    d = dict(row)
    d["steps"] = steps_of([tid])[tid]
    if full:
        d["evidence"] = json.loads(d["evidence"]) if d["evidence"] else None
    return d


def own_task(tid):
    """수정 권한 검사: 선택한 담당자가 업무 담당자일 때만."""
    me = actor()
    row = conn().execute("SELECT assignee_id FROM task WHERE id=?", (tid,)).fetchone()
    if not row:
        raise ApiError("업무를 찾을 수 없습니다.", 404)
    if row["assignee_id"] != me["id"]:
        raise ApiError("본인 업무만 수정할 수 있습니다. (읽기 전용)", 403)
    return me


def touch(tid, me):
    conn().execute("UPDATE task SET updated_at=?, updated_by=? WHERE id=?", (db.now(), me["name"], tid))


@app.get("/api/tasks")
def task_list():
    rows = conn().execute(
        f"SELECT {TASK_COLS} FROM task t LEFT JOIN staff s ON s.id=t.assignee_id ORDER BY t.deadline"
    ).fetchall()
    tasks = [dict(r) for r in rows]
    steps = steps_of([t["id"] for t in tasks])
    for t in tasks:
        t["steps"] = steps.get(t["id"], [])
    return jsonify(tasks)


@app.get("/api/tasks/<int:tid>")
def task_get(tid):
    return jsonify(load_task(tid, full=True))


def docno_taken(norm, exclude_id=None):
    if not norm:
        return False
    row = conn().execute(
        "SELECT id FROM task WHERE doc_no_norm=? AND id<>?", (norm, exclude_id or 0)
    ).fetchone()
    return row is not None


def already_registered(rkey, dkey):
    """가져오기 중복 검사. 접수번호가 있으면 접수번호로 판단한다(문서번호는 기관이 달라도 겹칠 수 있음).
    접수번호가 없는 쪽이 있으면 문서번호로 판단한다."""
    c = conn()
    if rkey and c.execute("SELECT 1 FROM task WHERE receipt_no_norm=?", (rkey,)).fetchone():
        return True
    if dkey:
        q = "SELECT 1 FROM task WHERE doc_no_norm=?"
        if rkey:
            q += " AND (receipt_no_norm IS NULL OR receipt_no_norm='')"
        return c.execute(q, (dkey,)).fetchone() is not None
    return False


@app.post("/api/tasks")
def task_create():
    me = actor()
    b = body()
    title = (b.get("title") or "").strip()
    if not title:
        raise ApiError("제목을 입력해 주세요.")
    typ = b.get("type")
    if typ not in TYPES:
        raise ApiError("유형(회신/전파)을 골라 주세요.")
    assignee = int(b.get("assignee_id") or me["id"])
    if not conn().execute("SELECT 1 FROM staff WHERE id=?", (assignee,)).fetchone():
        raise ApiError("담당자를 찾을 수 없습니다.")
    doc_no = (b.get("doc_no") or "").strip() or None
    norm = rules.normalize_docno(doc_no) or None
    if docno_taken(norm):
        raise ApiError(f"문서번호 {doc_no}는 이미 등록되어 있습니다.")
    ts = db.now()
    tid = conn().execute(
        """INSERT INTO task(source, doc_no, doc_no_norm, title, sender, received_date, assignee_id, type,
           deadline, type_source, deadline_source, memo, created_at, updated_at, updated_by)
           VALUES ('직접',?,?,?,?,?,?,?,?, 'manual','manual',?,?,?,?)""",
        (doc_no, norm, title, (b.get("sender") or "").strip() or None,
         valid_date(b.get("received_date"), "접수일"), assignee, typ, valid_date(b.get("deadline")),
         (b.get("memo") or "").strip() or None, ts, ts, me["name"]),
    ).lastrowid
    conn().commit()
    return jsonify(id=tid)


@app.put("/api/tasks/<int:tid>")
def task_update(tid):
    me = own_task(tid)
    b = body()
    cur = load_task(tid)
    sets, vals = [], []

    def put(col, val):
        sets.append(f"{col}=?")
        vals.append(val)

    if "title" in b:
        title = (b["title"] or "").strip()
        if not title:
            raise ApiError("제목을 입력해 주세요.")
        put("title", title)
    if "type" in b and b["type"] != cur["type"]:
        if b["type"] not in TYPES:
            raise ApiError("유형은 회신 또는 전파입니다.")
        put("type", b["type"])
        put("type_source", "manual")
    if "deadline" in b:
        d = valid_date(b["deadline"])
        if d != cur["deadline"]:
            put("deadline", d)
            put("deadline_source", "manual")
    if "memo" in b:
        put("memo", (b["memo"] or "").strip() or None)
    if "sender" in b:
        put("sender", (b["sender"] or "").strip() or None)
    if "received_date" in b:
        put("received_date", valid_date(b["received_date"], "접수일"))
    if "produced_date" in b:
        put("produced_date", valid_date(b["produced_date"], "생산일자"))
    if "doc_no" in b:
        doc_no = (b["doc_no"] or "").strip() or None
        norm = rules.normalize_docno(doc_no) or None
        if not cur.get("receipt_no") and docno_taken(norm, tid):
            raise ApiError(f"문서번호 {doc_no}는 이미 다른 업무에 등록되어 있습니다.")
        put("doc_no", doc_no)
        put("doc_no_norm", norm)
    if "assignee_id" in b and int(b["assignee_id"]) != cur["assignee_id"]:
        new = conn().execute("SELECT * FROM staff WHERE id=?", (int(b["assignee_id"]),)).fetchone()
        if not new:
            raise ApiError("담당자를 찾을 수 없습니다.")
        put("assignee_id", new["id"])
    put("updated_at", db.now())
    put("updated_by", me["name"])
    conn().execute(f"UPDATE task SET {', '.join(sets)} WHERE id=?", (*vals, tid))
    conn().commit()
    return jsonify(load_task(tid, full=True))


@app.delete("/api/tasks/<int:tid>")
def task_delete(tid):
    own_task(tid)
    conn().execute("DELETE FROM task WHERE id=?", (tid,))
    conn().commit()
    return jsonify(ok=True)


@app.post("/api/tasks/<int:tid>/complete")
def task_complete(tid):
    me = own_task(tid)
    conn().execute("UPDATE task SET status='완료', completed_at=? WHERE id=?", (db.now(), tid))
    touch(tid, me)
    conn().commit()
    return jsonify(load_task(tid, full=True))


@app.post("/api/tasks/<int:tid>/reopen")
def task_reopen(tid):
    me = own_task(tid)
    conn().execute("UPDATE task SET status='진행중', completed_at=NULL WHERE id=?", (tid,))
    touch(tid, me)
    conn().commit()
    return jsonify(load_task(tid, full=True))


# ---------------------------------------------------------------- 단계

@app.post("/api/tasks/<int:tid>/steps")
def step_add(tid):
    me = own_task(tid)
    b = body()
    name = (b.get("name") or "").strip()
    if not name:
        raise ApiError("단계명을 입력해 주세요.")
    c = conn()
    nxt = c.execute("SELECT COALESCE(MAX(ord), -1) + 1 FROM step WHERE task_id=?", (tid,)).fetchone()[0]
    c.execute("INSERT INTO step(task_id, ord, name, deadline) VALUES (?,?,?,?)",
              (tid, nxt, name, valid_date(b.get("deadline"))))
    touch(tid, me)
    c.commit()
    return jsonify(load_task(tid, full=True))


def step_row(sid):
    row = conn().execute("SELECT * FROM step WHERE id=?", (sid,)).fetchone()
    if not row:
        raise ApiError("단계를 찾을 수 없습니다.", 404)
    return row


@app.put("/api/steps/<int:sid>")
def step_update(sid):
    st = step_row(sid)
    me = own_task(st["task_id"])
    b = body()
    c = conn()
    if "name" in b:
        name = (b["name"] or "").strip()
        if not name:
            raise ApiError("단계명을 입력해 주세요.")
        c.execute("UPDATE step SET name=? WHERE id=?", (name, sid))
    if "deadline" in b:
        c.execute("UPDATE step SET deadline=? WHERE id=?", (valid_date(b["deadline"]), sid))
    if "done" in b:
        done = 1 if b["done"] else 0
        c.execute("UPDATE step SET done=?, done_at=? WHERE id=?", (done, db.now() if done else None, sid))
    touch(st["task_id"], me)
    c.commit()
    return jsonify(load_task(st["task_id"], full=True))


@app.delete("/api/steps/<int:sid>")
def step_delete(sid):
    st = step_row(sid)
    me = own_task(st["task_id"])
    conn().execute("DELETE FROM step WHERE id=?", (sid,))
    touch(st["task_id"], me)
    conn().commit()
    return jsonify(load_task(st["task_id"], full=True))


@app.post("/api/tasks/<int:tid>/steps/reorder")
def step_reorder(tid):
    me = own_task(tid)
    order = body().get("order") or []
    c = conn()
    for i, sid in enumerate(order):
        c.execute("UPDATE step SET ord=? WHERE id=? AND task_id=?", (i, int(sid), tid))
    touch(tid, me)
    c.commit()
    return jsonify(load_task(tid, full=True))


@app.post("/api/tasks/<int:tid>/apply_template")
def step_apply_template(tid):
    me = own_task(tid)
    b = body()
    c = conn()
    tpl = c.execute("SELECT * FROM template WHERE id=?", (b.get("template_id"),)).fetchone()
    if not tpl:
        raise ApiError("템플릿을 찾을 수 없습니다.", 404)
    task = load_task(tid)
    final = dt.date.fromisoformat(task["deadline"]) if task["deadline"] else None
    if b.get("mode") == "replace":
        c.execute("DELETE FROM step WHERE task_id=?", (tid,))
    nxt = c.execute("SELECT COALESCE(MAX(ord), -1) + 1 FROM step WHERE task_id=?", (tid,)).fetchone()[0]
    tsteps = c.execute(
        "SELECT * FROM template_step WHERE template_id=? ORDER BY ord", (tpl["id"],)
    ).fetchall()
    for i, s in enumerate(tsteps):
        d = (final - dt.timedelta(days=s["days_before"])).isoformat() if final else None
        c.execute("INSERT INTO step(task_id, ord, name, deadline) VALUES (?,?,?,?)",
                  (tid, nxt + i, s["name"], d))
    touch(tid, me)
    c.commit()
    return jsonify(load_task(tid, full=True))


# ================================================================ 접수문서 가져오기

IMPORTS = {}
IMPORT_LOCK = threading.Lock()
IMPORT_TTL = 3 * 3600


def _store_import(data):
    with IMPORT_LOCK:
        cutoff = time.time() - IMPORT_TTL
        for k in [k for k, v in IMPORTS.items() if v["created"] < cutoff]:
            del IMPORTS[k]
        iid = uuid.uuid4().hex
        data["created"] = time.time()
        IMPORTS[iid] = data
        return iid


def _get_import(iid):
    with IMPORT_LOCK:
        imp = IMPORTS.get(iid)
    if not imp:
        raise ApiError("가져오기 세션이 만료되었습니다. 파일을 다시 올려 주세요.", 404)
    return imp


def get_setting(key, default=None):
    row = conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row and row["value"] else default


def set_setting(key, value):
    conn().execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)",
                   (key, json.dumps(value, ensure_ascii=False)))


MAP_FIELDS = ["doc_no", "receipt_no", "title", "sender", "sender_dept", "produced", "received", "assignee",
              "status"]
REQUIRED_FIELDS = ["title"]


@app.get("/api/settings/mapping")
def mapping_get():
    return jsonify(get_setting("excel_mapping", {}))


@app.get("/api/settings/rules")
def rules_get():
    return jsonify(path=rules.CONFIG_PATH, config=rules.load_config())


# ---------------------------------------------------------------- 데이터 초기화

RESET_WORD = "초기화"


def data_stats():
    c = conn()
    one = lambda q: c.execute(q).fetchone()[0]  # noqa: E731
    return {
        "tasks": one("SELECT COUNT(*) FROM task"),
        "imported": one("SELECT COUNT(*) FROM task WHERE source='가져오기'"),
        "direct": one("SELECT COUNT(*) FROM task WHERE source<>'가져오기'"),
        "steps": one("SELECT COUNT(*) FROM step"),
        "staff": one("SELECT COUNT(*) FROM staff"),
        "has_mapping": c.execute("SELECT 1 FROM settings WHERE key='excel_mapping'").fetchone() is not None,
    }


@app.get("/api/admin/stats")
def admin_stats():
    return jsonify(data_stats())


@app.post("/api/admin/reset")
def admin_reset():
    """등록 업무 일괄 삭제. 실행 전에 DB를 backup/ 폴더에 자동 백업한다."""
    me = actor()
    b = body()
    if (b.get("confirm") or "").strip() != RESET_WORD:
        raise ApiError(f"확인 문구 '{RESET_WORD}'를 정확히 입력해 주세요.")
    scope = b.get("scope")
    if scope not in ("imported", "all"):
        raise ApiError("삭제 범위를 골라 주세요.")
    before = data_stats()
    path = db.backup("before_reset")
    c = conn()
    where = "WHERE source='가져오기'" if scope == "imported" else ""
    c.execute(f"DELETE FROM step WHERE task_id IN (SELECT id FROM task {where})")
    deleted = c.execute(f"DELETE FROM task {where}").rowcount
    staff_deleted = 0
    if b.get("staff"):
        # 남은 업무의 담당자는 지우지 않는다.
        staff_deleted = c.execute(
            "DELETE FROM staff WHERE id NOT IN (SELECT DISTINCT assignee_id FROM task)").rowcount
    if b.get("mapping"):
        c.execute("DELETE FROM settings WHERE key='excel_mapping'")
    c.commit()
    with IMPORT_LOCK:
        IMPORTS.clear()  # 진행 중이던 가져오기 미리보기도 무효화
    app.logger.warning("데이터 초기화: %s님, 범위=%s, 업무 %d건 삭제, 백업=%s", me["name"], scope, deleted, path)
    return jsonify(deleted=deleted, steps_before=before["steps"], staff_deleted=staff_deleted,
                   mapping_cleared=bool(b.get("mapping")),
                   backup=os.path.relpath(path, BASE) if path.startswith(BASE) else path,
                   stats=data_stats())


@app.post("/api/import/parse")
def import_parse():
    actor()
    files = request.files.getlist("files")
    excels = [f for f in files if f.filename.lower().endswith(parsers.EXCEL_EXTS)]
    bodies = [f for f in files if f.filename.lower().endswith(parsers.BODY_EXTS)]
    others = [f.filename for f in files if f not in excels and f not in bodies]
    if len(excels) != 1:
        raise ApiError("접수 목록 엑셀 파일을 1개 올려 주세요. (.xlsx / .xls / .csv)")
    ex = excels[0]
    try:
        headers, rows, sheet = parsers.read_list(ex.filename, ex.read())
    except parsers.UnreadableFile as e:
        raise ApiError(f"엑셀을 읽을 수 없습니다: {e}")
    except Exception as e:  # noqa: BLE001 - 파일 손상 등
        raise ApiError(f"엑셀을 읽을 수 없습니다: {e}")

    body_files = []
    for f in bodies:
        item = {"name": f.filename, "text": None, "error": None,
                "docno": None, "docno_line": None, "receipt": None, "receipt_line": None}
        try:
            item["text"] = parsers.extract_body(f.filename, f.read())
            item["docno"], item["docno_line"] = rules.find_docno(item["text"])
            item["receipt"], item["receipt_line"] = rules.find_receipt_no(item["text"])
        except parsers.UnreadableFile as e:
            item["error"] = str(e)
        except Exception as e:  # noqa: BLE001
            item["error"] = f"읽기 실패({e.__class__.__name__})"
        body_files.append(item)

    saved = get_setting("excel_mapping", {})
    guessed = parsers.guess_mapping(headers)
    if saved and all(saved.get(k) in headers for k in REQUIRED_FIELDS) and \
            (saved.get("doc_no") in headers or saved.get("receipt_no") in headers):
        mapping = {k: v for k, v in saved.items() if v in headers}
        # 저장된 매핑에 없던 항목(새로 생긴 열 등)은 추정값으로 채운다.
        for k, v in guessed.items():
            if k not in mapping and v not in mapping.values():
                mapping[k] = v
        need_mapping = False
    else:
        mapping = guessed
        need_mapping = True
    iid = _store_import({"excel": ex.filename, "headers": headers, "rows": rows, "files": body_files})
    return jsonify(
        import_id=iid, excel=ex.filename, sheet=sheet, headers=headers, sample=rows[:3], row_count=len(rows),
        file_count=len(body_files), ignored=others, mapping=mapping, need_mapping=need_mapping,
    )


def _row_fields(imp, idx):
    m = imp["mapping"]
    r = imp["rows"][idx]
    get = lambda k: r[imp["headers"].index(m[k])].strip() if m.get(k) in imp["headers"] else ""  # noqa: E731
    received = parsers.parse_date(get("received"))
    produced = parsers.parse_date(get("produced"))
    sender, dept = get("sender"), get("sender_dept")
    if dept and dept not in sender:
        sender = f"{sender} {dept}".strip()
    return {
        "doc_no": get("doc_no"), "receipt_no": get("receipt_no"), "title": get("title"), "sender": sender,
        "produced": produced.isoformat() if produced else None,
        "received": received.isoformat() if received else None, "assignee": get("assignee"),
        "status": get("status"),
    }


def _produced_of(r, f):
    """생산일자(발신부서가 문서를 생산한 날). 엑셀에 없으면 본문 '시행 ○○과-123 (2026. 9. 8.)'의 날짜."""
    if r.get("produced"):
        return r["produced"], "엑셀"
    line = (f or {}).get("docno_line") or ""
    d = parsers.parse_date(line[line.find("("):] if "(" in line else "")
    return (d.isoformat(), "본문 시행일") if d else (None, None)


def _identify_row(row, f, cfg):
    received = dt.date.fromisoformat(row["received"]) if row["received"] else None
    if f is None or f["text"] is None:
        res = rules.no_body_result(row["title"], cfg)
    else:
        res = rules.identify(f["text"], received, cfg, title=row["title"])
    if f is not None:
        res["evidence"]["docno"] = f.get("match_note") or f.get("docno_line")
    return res


def _match_files(imp, rows, dup_keys):
    """본문 파일을 엑셀 행과 짝짓는다. 접수번호 → 문서번호 → 본문/파일명 속 번호 순."""
    by_rcpt, by_doc = {}, {}
    for p, r in enumerate(rows):
        if r["rkey"]:
            by_rcpt[r["rkey"]] = p
        if r["dkey"]:
            by_doc.setdefault(r["dkey"], []).append(p)
    free = lambda ps: [p for p in ps if rows[p]["file_index"] is None]  # noqa: E731

    unmatched = []
    for fi, fl in enumerate(imp["files"]):
        fl["match_note"] = None
        if fl["error"]:
            unmatched.append({"file_index": fi, "name": fl["name"], "reason": fl["error"], "readable": False})
            continue
        rk = rules.normalize_docno(fl["receipt"]) if fl["receipt"] else ""
        dk = rules.normalize_docno(fl["docno"]) if fl["docno"] else ""
        if (rk and rk in dup_keys) or (dk and dk in dup_keys and not (rk and rk in by_rcpt)):
            continue  # 이미 등록된 문서의 본문
        target, reason = None, None
        if rk and rk in by_rcpt:
            target = by_rcpt[rk]
            fl["match_note"] = f"{fl['receipt_line']} / {fl['docno_line'] or ''}".strip(" /")
        elif dk and dk in by_doc:
            cands = free(by_doc[dk])
            if len(cands) == 1:
                target = cands[0]
            elif len(cands) > 1:
                reason = f"문서번호({fl['docno']})가 같은 엑셀 행이 {len(cands)}개 — 직접 골라 주세요"
            else:
                reason = f"같은 문서번호({fl['docno']})의 파일이 이미 짝지어짐"
        if target is None and reason is None:
            # 본문·파일명 안에서 엑셀의 접수번호/문서번호를 찾아본다(한 건만 맞을 때).
            hay = rules.compact(fl["text"]) + rules.compact(fl["name"])
            cands = {p for k, p in by_rcpt.items() if k in hay} or \
                {p for k, ps in by_doc.items() if k in hay for p in ps}
            cands = free(sorted(cands))
            if len(cands) == 1:
                target = cands[0]
                r = rows[target]
                fl["match_note"] = f"본문/파일명에서 번호 {r['receipt_no'] or r['doc_no']} 발견"
        if target is not None and rows[target]["file_index"] is None:
            rows[target]["file_index"] = fi
            continue
        if reason is None:
            if target is not None:
                reason = "같은 문서의 파일이 이미 짝지어짐"
            elif fl["docno"] or fl["receipt"]:
                reason = f"엑셀에 없는 문서번호({fl['docno'] or fl['receipt']})"
            else:
                reason = "본문에서 문서번호를 찾지 못함"
        unmatched.append({"file_index": fi, "name": fl["name"], "reason": reason, "readable": True,
                          "docno": fl["docno"]})
    return unmatched


@app.post("/api/import/<iid>/preview")
def import_preview(iid):
    actor()
    imp = _get_import(iid)
    b = body()
    mapping = {k: v for k, v in (b.get("mapping") or {}).items() if k in MAP_FIELDS and v}
    if mapping.get("title") not in imp["headers"] or \
            not (mapping.get("doc_no") in imp["headers"] or mapping.get("receipt_no") in imp["headers"]):
        raise ApiError("제목 열과, 문서번호·접수번호 중 하나 이상의 열은 반드시 지정해야 합니다.")
    imp["mapping"] = mapping
    set_setting("excel_mapping", mapping)
    conn().commit()

    cfg = rules.load_config()
    rows, dup_rows, dup_keys, seen = [], [], set(), set()
    for i in range(len(imp["rows"])):
        f = _row_fields(imp, i)
        if not (f["doc_no"] or f["receipt_no"]) and not f["title"]:
            continue
        rkey, dkey = rules.normalize_docno(f["receipt_no"]), rules.normalize_docno(f["doc_no"])
        key = f"r:{rkey}" if rkey else (f"d:{dkey}" if dkey else None)
        if already_registered(rkey, dkey) or (key and key in seen):
            dup_rows.append(f["receipt_no"] or f["doc_no"])
            dup_keys.update(k for k in (rkey, dkey) if k)
            continue
        if key:
            seen.add(key)
        f.update(idx=i, rkey=rkey, dkey=dkey, file_index=None)
        rows.append(f)

    unmatched = _match_files(imp, rows, dup_keys)
    out_rows = []
    for r in rows:
        f = imp["files"][r["file_index"]] if r["file_index"] is not None else None
        out_rows.append(_preview_row(r, f, cfg))
    imp["preview_rows"] = {r["idx"]: r for r in rows}
    return jsonify(rows=out_rows, unmatched=unmatched, skipped_dup=len(dup_rows), skipped_list=dup_rows[:50])


def _preview_row(r, f, cfg):
    ident = _identify_row(r, f, cfg)
    produced, produced_src = _produced_of(r, f)
    return {
        "idx": r["idx"], "doc_no": r["doc_no"], "receipt_no": r["receipt_no"], "title": r["title"],
        "sender": r["sender"], "produced": produced, "produced_src": produced_src,
        "received": r["received"], "assignee": r["assignee"], "status": r["status"],
        "file": f["name"] if f else None, "file_index": r["file_index"],
        "has_body": bool(f and f["text"] is not None), "ident": ident,
        # 결재상태는 접수 처리 상태일 뿐이라 등록 여부와 관계없다. 회신·전파로 식별되면 모두 기본 등록.
        "include": ident["type"] in TYPES,
    }


@app.post("/api/import/<iid>/pair")
def import_pair(iid):
    actor()
    imp = _get_import(iid)
    b = body()
    rows = imp.get("preview_rows") or {}
    r = rows.get(int(b.get("row_idx", -1)))
    fi = int(b.get("file_index", -1))
    if r is None or not (0 <= fi < len(imp["files"])):
        raise ApiError("짝지을 행 또는 파일을 찾을 수 없습니다.")
    r["file_index"] = fi
    f = imp["files"][fi]
    f["match_note"] = "사용자가 직접 짝지음"
    return jsonify(_preview_row(r, f, rules.load_config()))


@app.post("/api/import/<iid>/commit")
def import_commit(iid):
    me = actor()
    imp = _get_import(iid)
    rows = imp.get("preview_rows") or {}
    items = body().get("items") or []
    c = conn()
    cfg = rules.load_config()
    created, skipped, errors = 0, [], []
    ts = db.now()
    for it in items:
        r = rows.get(int(it.get("idx", -1)))
        if r is None:
            continue
        label = r["receipt_no"] or r["doc_no"] or r["title"]
        typ = it.get("type")
        if typ not in TYPES:
            errors.append(f"{label}: 유형을 회신/전파 중에서 골라 주세요.")
            continue
        try:
            deadline = valid_date(it.get("deadline"))
        except ApiError as e:
            errors.append(f"{label}: {e.msg}")
            continue
        if already_registered(r["rkey"], r["dkey"]):
            skipped.append(label)
            continue
        assignee_id = get_or_create_staff(it.get("assignee") or r["assignee"]) or me["id"]
        f = imp["files"][r["file_index"]] if r["file_index"] is not None else None
        ident = _identify_row(r, f, cfg)
        c.execute(
            """INSERT INTO task(source, doc_no, doc_no_norm, receipt_no, receipt_no_norm, title, sender,
               produced_date, received_date, assignee_id, type, deadline, type_source, deadline_source,
               evidence, memo, body_text, created_at, updated_at, updated_by)
               VALUES ('가져오기',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r["doc_no"] or None, r["dkey"] or None, r["receipt_no"] or None, r["rkey"] or None,
             r["title"] or "(제목 없음)", r["sender"] or None, _produced_of(r, f)[0], r["received"],
             assignee_id, typ, deadline,
             "auto" if it.get("type_source") == "auto" else "manual",
             "auto" if it.get("deadline_source") == "auto" else "manual",
             json.dumps(dict(ident["evidence"], file=f["name"] if f else None,
                             type_basis=ident.get("type_basis")), ensure_ascii=False),
             (it.get("memo") or "").strip() or None,
             f["text"] if f else None, ts, ts, me["name"]),
        )
        created += 1
    c.commit()
    return jsonify(created=created, skipped=len(skipped), skipped_list=skipped, errors=errors)


# ================================================================ 화면

@app.get("/")
def index():
    resp = send_from_directory(STATIC, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    db.init()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    print("=" * 60)
    print(" 문서 처리 기한 관리 도구")
    print(f"  이 PC에서 접속:   http://localhost:{port}")
    for ip in _local_ips():
        print(f"  다른 PC에서 접속: http://{ip}:{port}")
    print(f"  DB 파일: {db.DB_PATH}")
    print("  종료: Ctrl+C")
    print("=" * 60)
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=16)
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
