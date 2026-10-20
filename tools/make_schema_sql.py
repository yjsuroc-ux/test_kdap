"""supabase/schema.sql 만들기: db.py의 PostgreSQL 표 정의를 Supabase SQL Editor에 붙여 넣을 수 있는 파일로 쓴다.

실행: python tools\\make_schema_sql.py
(앱은 첫 요청 때 표를 자동으로 만들므로 이 파일은 미리 만들거나 구조를 확인할 때만 쓴다.)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.pop("VERCEL", None)
import db  # noqa: E402

TABLES = ("staff", "task", "step", "template", "template_step", "settings", "import_session")

lines = [
    "-- 문서 처리 기한 관리 도구: Supabase(PostgreSQL) 표 정의",
    "-- 이 파일은 tools/make_schema_sql.py가 db.py에서 만든다. 직접 고치지 말 것.",
    "-- 앱이 첫 요청 때 같은 표를 자동으로 만들므로, 미리 만들거나 구조를 확인할 때만 SQL Editor에서 실행한다.",
    "",
]
for stmt in db.PG_SCHEMA.split(";"):
    stmt = stmt.strip()
    if stmt:
        lines += [stmt + ";", ""]
lines += [
    "CREATE INDEX IF NOT EXISTS ix_task_docno ON task(doc_no_norm);",
    "CREATE INDEX IF NOT EXISTS ix_task_receipt ON task(receipt_no_norm);",
    "",
    "-- 행 수준 보안(RLS): Supabase 자동 REST API(anon 키)로는 읽기·쓰기를 막는다.",
    "-- 앱은 표 소유자(postgres)로 접속하므로 영향을 받지 않는다.",
]
lines += [f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;" for t in TABLES]
lines += [
    "",
    "-- 기본 템플릿",
    "INSERT INTO settings(key, value) VALUES ('seeded', '1') ON CONFLICT (key) DO NOTHING;",
]
for name, steps in db.SEED_TEMPLATES:
    lines.append(
        f"WITH t AS (INSERT INTO template(name) SELECT '{name}' "
        f"WHERE NOT EXISTS (SELECT 1 FROM template WHERE name='{name}') RETURNING id)"
    )
    vals = ", ".join(f"({i}, '{s}', {d})" for i, (s, d) in enumerate(steps))
    lines.append(
        f"INSERT INTO template_step(template_id, ord, name, days_before) "
        f"SELECT t.id, v.ord, v.name, v.days FROM t, (VALUES {vals}) AS v(ord, name, days);"
    )

out = os.path.join(ROOT, "supabase", "schema.sql")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write(re.sub(r"\n{3,}", "\n\n", "\n".join(lines)) + "\n")
print("wrote", out)
