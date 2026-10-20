"""DB 백업: data/tasks.db → backup/tasks_YYYYMMDD_HHMMSS.db (서버 실행 중에도 안전). 30일 지난 백업은 삭제."""
import glob
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import db  # noqa: E402

KEEP_DAYS = 30


def main():
    if not os.path.exists(db.DB_PATH):
        print(f"DB 파일이 없습니다: {db.DB_PATH}")
        return 1
    dest = db.backup()
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in glob.glob(os.path.join(db.BACKUP_DIR, "tasks_*.db")):
        if os.path.getmtime(f) < cutoff:
            os.remove(f)
    print(f"백업 완료: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
