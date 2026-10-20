"""SQLite 저장소 (PRD 8장)."""
import datetime as dt
import os
import sqlite3

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DEADLINE_DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA_DIR, "tasks.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,                 -- 가져오기 / 직접
    doc_no TEXT,                          -- 발신 문서번호(시행번호)
    doc_no_norm TEXT,
    receipt_no TEXT,                      -- 우리 부서 접수번호
    receipt_no_norm TEXT,
    title TEXT NOT NULL,
    sender TEXT,
    produced_date TEXT,                   -- 생산일자(발신부서가 생산한 날)
    received_date TEXT,
    assignee_id INTEGER NOT NULL REFERENCES staff(id),
    type TEXT NOT NULL,                   -- 회신 / 전파
    deadline TEXT,
    type_source TEXT NOT NULL DEFAULT 'manual',      -- auto / manual
    deadline_source TEXT NOT NULL DEFAULT 'manual',  -- auto / manual
    evidence TEXT,                        -- JSON
    status TEXT NOT NULL DEFAULT '진행중', -- 진행중 / 완료
    completed_at TEXT,
    memo TEXT,
    body_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);
CREATE TABLE IF NOT EXISTS step (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    name TEXT NOT NULL,
    deadline TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_step_task ON step(task_id);
CREATE TABLE IF NOT EXISTS template (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS template_step (
    id INTEGER PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    name TEXT NOT NULL,
    days_before INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

SEED_TEMPLATES = [
    ("심의위원회형", [("소요 검토", 7), ("심의위원회 개최", 4), ("결과 회신", 0)]),
    ("단순 회신형", [("검토 및 자료 작성", 3), ("회신", 0)]),
    ("전파형", [("관련부서 전파", 0)]),
]


def now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


BACKUP_DIR = os.environ.get("DEADLINE_BACKUP_DIR", os.path.join(BASE, "backup"))


def backup(prefix="tasks"):
    """DB를 backup/ 폴더에 복사한다(서버 실행 중에도 안전). 기존 백업은 덮어쓰지 않는다. → 백업 파일 경로"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stem = os.path.join(BACKUP_DIR, f"{prefix}_{dt.datetime.now():%Y%m%d_%H%M%S}")
    dest, n = stem + ".db", 1
    while os.path.exists(dest):
        n += 1
        dest = f"{stem}_{n}.db"
    src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # 이전 버전 DB 갱신: 접수번호·생산일자 열 추가. 문서번호는 기관이 달라 겹칠 수 있어 고유 제약을 없앤다.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(task)")}
        for col in ("receipt_no", "receipt_no_norm", "produced_date"):
            if col not in cols:
                conn.execute(f"ALTER TABLE task ADD COLUMN {col} TEXT")
        conn.execute("DROP INDEX IF EXISTS ux_task_docno")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_task_docno ON task(doc_no_norm)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_task_receipt ON task(receipt_no_norm)")
        if conn.execute("SELECT COUNT(*) FROM template").fetchone()[0] == 0 and \
                conn.execute("SELECT value FROM settings WHERE key='seeded'").fetchone() is None:
            for name, steps in SEED_TEMPLATES:
                tid = conn.execute("INSERT INTO template(name) VALUES (?)", (name,)).lastrowid
                for i, (sname, days) in enumerate(steps):
                    conn.execute(
                        "INSERT INTO template_step(template_id, ord, name, days_before) VALUES (?,?,?,?)",
                        (tid, i, sname, days),
                    )
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('seeded', '1')")
        conn.commit()
    finally:
        conn.close()
