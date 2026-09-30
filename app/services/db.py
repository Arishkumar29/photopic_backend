"""SQLite file holding the face index and analytics (events live in event_store)."""
import sqlite3
import threading
from contextlib import contextmanager

from ..config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS faces (
    event_id  TEXT NOT NULL,
    file_id   TEXT NOT NULL,
    face_no   INTEGER NOT NULL,
    det_score REAL NOT NULL,
    box       TEXT NOT NULL,
    vector    BLOB NOT NULL,
    PRIMARY KEY (event_id, file_id, face_no)
);
-- One row per photo that finished indexing (with or without faces), so an
-- interrupted or re-run index only processes photos it has not seen yet.
CREATE TABLE IF NOT EXISTS indexed_files (
    event_id   TEXT NOT NULL,
    file_id    TEXT NOT NULL,
    faces      INTEGER NOT NULL,
    indexed_at REAL NOT NULL,
    PRIMARY KEY (event_id, file_id)
);
CREATE TABLE IF NOT EXISTS analytics (
    event_id TEXT NOT NULL,
    day      TEXT NOT NULL,
    kind     TEXT NOT NULL,
    count    INTEGER NOT NULL,
    PRIMARY KEY (event_id, day, kind)
);
"""

_lock = threading.Lock()
_ready = False


@contextmanager
def connect():
    """Serialised connection: commit on success, roll back on error, always close."""
    global _ready
    with _lock:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30)
        try:
            if not _ready:
                conn.executescript(_SCHEMA)
                _ready = True
            with conn:
                yield conn
        finally:
            conn.close()
