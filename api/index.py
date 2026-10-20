"""Vercel 진입점: 모든 요청을 Flask 앱(app.py)으로 넘긴다. (vercel.json의 rewrites 참고)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402,F401
