"""Vercel entry point: every request is rewritten here (see vercel.json) and served by FastAPI."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402,F401
