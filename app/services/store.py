"""Persistence for events, the face index, analytics and indexing leases.

MongoDB when MONGODB_URI is set (required on Vercel: nothing on disk survives there),
otherwise a local SQLite file plus events.json. Every function here is synchronous
and is called through asyncio.to_thread by the async layers.
"""
import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass

from ..config import DB_PATH, EVENTS_FILE, MONGODB_URI

log = logging.getLogger("store")

FAILED = -1          # indexed_files.faces for a photo that could not be read
MAX_ATTEMPTS = 3     # after this many failures a photo is given up on


@dataclass
class FaceRow:
    file_id: str
    face_no: int
    score: float
    box: list[int]
    vector: bytes
    thumb: bytes | None


# ── SQLite ──────────────────────────────────────────────────────────────────

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
CREATE TABLE IF NOT EXISTS leases (
    event_id TEXT PRIMARY KEY,
    until    REAL NOT NULL
);
"""
# Columns added after the first release; applied once to older databases.
_MIGRATIONS = [
    ("faces", "thumb", "ALTER TABLE faces ADD COLUMN thumb BLOB"),
    ("indexed_files", "attempts", "ALTER TABLE indexed_files ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1"),
]

_lock = threading.Lock()
_ready = False


@contextmanager
def _sqlite():
    global _ready
    with _lock:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30)
        try:
            if not _ready:
                conn.executescript(_SCHEMA)
                for table, column, sql in _MIGRATIONS:
                    if column not in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}:
                        conn.execute(sql)
                _ready = True
            with conn:
                yield conn
        finally:
            conn.close()


# ── MongoDB ─────────────────────────────────────────────────────────────────

_mongo = None  # pymongo Database


def connect() -> None:
    global _mongo
    if not MONGODB_URI or _mongo is not None:
        return
    try:
        from pymongo import ASCENDING, MongoClient

        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000, socketTimeoutMS=20000,
                             maxPoolSize=10, appname="photopic")
        client.admin.command("ping")
        db = client.get_default_database("test")
        db.faces.create_index([("e", ASCENDING), ("f", ASCENDING), ("n", ASCENDING)], unique=True)
        db.indexed.create_index([("e", ASCENDING), ("f", ASCENDING)], unique=True)
        db.analytics.create_index([("e", ASCENDING), ("d", ASCENDING), ("k", ASCENDING)], unique=True)
        db.events.create_index("eventId", unique=True)
        _mongo = db
        log.info("Using MongoDB for events, faces and analytics.")
    except Exception as err:
        log.error("MongoDB unavailable, using local files instead: %s", err)


def mongo_connected() -> bool:
    return _mongo is not None


# ── Events ──────────────────────────────────────────────────────────────────

def load_events() -> list[dict]:
    if _mongo is not None:
        return list(_mongo.events.find({}, {"_id": 0}))
    try:
        return list(json.loads(EVENTS_FILE.read_text(encoding="utf-8")).values())
    except FileNotFoundError:
        return []


def load_event(event_id: str) -> dict | None:
    if _mongo is not None:
        return _mongo.events.find_one({"eventId": event_id}, {"_id": 0})
    return next((e for e in load_events() if e.get("eventId") == event_id), None)


def save_event(event: dict, all_events: dict[str, dict]) -> None:
    if _mongo is not None:
        _mongo.events.update_one({"eventId": event["eventId"]}, {"$set": event}, upsert=True)
        return
    _write_events_file(all_events)


def delete_event(event_id: str, all_events: dict[str, dict]) -> None:
    if _mongo is not None:
        _mongo.events.delete_one({"eventId": event_id})
        return
    _write_events_file(all_events)


def _write_events_file(all_events: dict[str, dict]) -> None:
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = EVENTS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(all_events, indent=2), encoding="utf-8")
    tmp.replace(EVENTS_FILE)  # atomic: a crash never leaves a half-written file


# ── Face index ──────────────────────────────────────────────────────────────

def face_count(event_id: str) -> int:
    if _mongo is not None:
        return _mongo.faces.count_documents({"e": event_id})
    with _sqlite() as conn:
        return conn.execute("SELECT COUNT(*) FROM faces WHERE event_id = ?", (event_id,)).fetchone()[0]


def face_vectors(event_id: str) -> tuple[list[str], list[bytes]]:
    if _mongo is not None:
        rows = list(_mongo.faces.find({"e": event_id}, {"_id": 0, "f": 1, "v": 1}).sort([("f", 1), ("n", 1)]))
        return [r["f"] for r in rows], [bytes(r["v"]) for r in rows]
    with _sqlite() as conn:
        rows = conn.execute("SELECT file_id, vector FROM faces WHERE event_id = ? ORDER BY file_id, face_no",
                            (event_id,)).fetchall()
    return [r[0] for r in rows], [r[1] for r in rows]


def face_rows(event_id: str) -> list[FaceRow]:
    if _mongo is not None:
        return [FaceRow(r["f"], r["n"], r.get("s", 0.0), r.get("b", []), bytes(r["v"]),
                        bytes(r["t"]) if r.get("t") else None)
                for r in _mongo.faces.find({"e": event_id}, {"_id": 0}).sort([("f", 1), ("n", 1)])]
    with _sqlite() as conn:
        rows = conn.execute("SELECT file_id, face_no, det_score, box, vector, thumb FROM faces "
                            "WHERE event_id = ? ORDER BY file_id, face_no", (event_id,)).fetchall()
    return [FaceRow(r[0], r[1], r[2], json.loads(r[3]), r[4], r[5]) for r in rows]


def progress(event_id: str) -> dict:
    """Photos processed (indexed or given up), failed, and faces found."""
    if _mongo is not None:
        processed = failed = faces = 0
        for r in _mongo.indexed.find({"e": event_id}, {"_id": 0, "faces": 1, "attempts": 1}):
            if r["faces"] == FAILED:
                if r.get("attempts", 1) >= MAX_ATTEMPTS:
                    processed += 1
                    failed += 1
            else:
                processed += 1
                faces += r["faces"]
        return {"processed": processed, "failed": failed, "faces": faces}
    with _sqlite() as conn:
        processed, failed, faces = conn.execute(
            "SELECT "
            " COALESCE(SUM(CASE WHEN faces >= 0 OR attempts >= ? THEN 1 ELSE 0 END), 0),"
            " COALESCE(SUM(CASE WHEN faces < 0 AND attempts >= ? THEN 1 ELSE 0 END), 0),"
            " COALESCE(SUM(CASE WHEN faces > 0 THEN faces ELSE 0 END), 0) "
            "FROM indexed_files WHERE event_id = ?", (MAX_ATTEMPTS, MAX_ATTEMPTS, event_id)).fetchone()
    return {"processed": processed, "failed": failed, "faces": faces}


def done_ids(event_id: str) -> set[str]:
    """Photos that need no more work: indexed, or failed too often."""
    if _mongo is not None:
        return {r["f"] for r in _mongo.indexed.find(
            {"e": event_id, "$or": [{"faces": {"$gte": 0}}, {"attempts": {"$gte": MAX_ATTEMPTS}}]}, {"f": 1})}
    with _sqlite() as conn:
        return {r[0] for r in conn.execute(
            "SELECT file_id FROM indexed_files WHERE event_id = ? AND (faces >= 0 OR attempts >= ?)",
            (event_id, MAX_ATTEMPTS))}


def save_results(event_id: str, results: list[tuple[str, list | None]]) -> None:
    """results: (file_id, faces) where faces is a list of face_engine.Face, or None if unreadable."""
    now = time.time()
    if _mongo is not None:
        from bson.binary import Binary
        from pymongo import DeleteMany, InsertOne, UpdateOne

        face_ops, file_ops = [], []
        for file_id, faces in results:
            if faces is None:
                file_ops.append(UpdateOne({"e": event_id, "f": file_id},
                                          {"$set": {"faces": FAILED, "at": now}, "$inc": {"attempts": 1}}, upsert=True))
                continue
            face_ops.append(DeleteMany({"e": event_id, "f": file_id}))
            face_ops += [InsertOne({"e": event_id, "f": file_id, "n": n, "s": f.score, "b": list(f.box),
                                    "v": Binary(f.vector.tobytes()), "t": Binary(f.thumb) if f.thumb else None})
                         for n, f in enumerate(faces)]
            file_ops.append(UpdateOne({"e": event_id, "f": file_id},
                                      {"$set": {"faces": len(faces), "at": now, "attempts": 1}}, upsert=True))
        if face_ops:
            _mongo.faces.bulk_write(face_ops, ordered=True)
        if file_ops:
            _mongo.indexed.bulk_write(file_ops, ordered=False)
        return
    with _sqlite() as conn:
        for file_id, faces in results:
            if faces is None:
                conn.execute(
                    "INSERT INTO indexed_files (event_id, file_id, faces, indexed_at, attempts) VALUES (?, ?, ?, ?, 1) "
                    "ON CONFLICT (event_id, file_id) DO UPDATE SET attempts = attempts + 1, indexed_at = excluded.indexed_at "
                    "WHERE faces < 0", (event_id, file_id, FAILED, now))
                continue
            conn.execute("DELETE FROM faces WHERE event_id = ? AND file_id = ?", (event_id, file_id))
            conn.executemany(
                "INSERT INTO faces (event_id, file_id, face_no, det_score, box, vector, thumb) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(event_id, file_id, n, f.score, json.dumps(list(f.box)), f.vector.tobytes(), f.thumb)
                 for n, f in enumerate(faces)])
            conn.execute("INSERT OR REPLACE INTO indexed_files (event_id, file_id, faces, indexed_at, attempts) "
                         "VALUES (?, ?, ?, ?, 1)", (event_id, file_id, len(faces), now))


def prune(event_id: str, keep: set[str]) -> bool:
    """Drop photos no longer in the Drive folder. True if anything was removed."""
    if _mongo is not None:
        stale = [r["f"] for r in _mongo.indexed.find({"e": event_id}, {"f": 1}) if r["f"] not in keep]
        if stale:
            _mongo.faces.delete_many({"e": event_id, "f": {"$in": stale}})
            _mongo.indexed.delete_many({"e": event_id, "f": {"$in": stale}})
        return bool(stale)
    with _sqlite() as conn:
        stale = [r[0] for r in conn.execute("SELECT file_id FROM indexed_files WHERE event_id = ?", (event_id,))
                 if r[0] not in keep]
        for file_id in stale:
            conn.execute("DELETE FROM faces WHERE event_id = ? AND file_id = ?", (event_id, file_id))
            conn.execute("DELETE FROM indexed_files WHERE event_id = ? AND file_id = ?", (event_id, file_id))
    return bool(stale)


def forget(event_id: str) -> None:
    if _mongo is not None:
        _mongo.faces.delete_many({"e": event_id})
        _mongo.indexed.delete_many({"e": event_id})
        _mongo.leases.delete_one({"_id": event_id})
        return
    with _sqlite() as conn:
        for table in ("faces", "indexed_files", "leases"):
            conn.execute(f"DELETE FROM {table} WHERE event_id = ?", (event_id,))


def has_thumbs(event_id: str) -> bool:
    """False when the event was indexed before face thumbnails were stored."""
    if _mongo is not None:
        return _mongo.faces.find_one({"e": event_id, "t": {"$ne": None}}, {"_id": 1}) is not None \
            or _mongo.faces.find_one({"e": event_id}, {"_id": 1}) is None
    with _sqlite() as conn:
        total, with_thumb = conn.execute(
            "SELECT COUNT(*), COUNT(thumb) FROM faces WHERE event_id = ?", (event_id,)).fetchone()
    return total == 0 or with_thumb > 0


# ── Leases: one indexing step per event at a time, across serverless instances ──

def acquire_lease(event_id: str, seconds: float) -> bool:
    now = time.time()
    if _mongo is not None:
        from pymongo.errors import DuplicateKeyError

        # Matches only a missing or expired lease; an unexpired one makes the upsert
        # collide on _id, which means another instance is indexing this event.
        try:
            _mongo.leases.update_one({"_id": event_id, "until": {"$lt": now}},
                                     {"$set": {"until": now + seconds}}, upsert=True)
            return True
        except DuplicateKeyError:
            return False
    with _sqlite() as conn:
        cur = conn.execute(
            "INSERT INTO leases (event_id, until) VALUES (?, ?) "
            "ON CONFLICT (event_id) DO UPDATE SET until = excluded.until WHERE leases.until < ?",
            (event_id, now + seconds, now))
        return cur.rowcount > 0


def release_lease(event_id: str) -> None:
    if _mongo is not None:
        _mongo.leases.delete_one({"_id": event_id})
        return
    with _sqlite() as conn:
        conn.execute("DELETE FROM leases WHERE event_id = ?", (event_id,))


def lease_active(event_id: str) -> bool:
    now = time.time()
    if _mongo is not None:
        return _mongo.leases.find_one({"_id": event_id, "until": {"$gte": now}}, {"_id": 1}) is not None
    with _sqlite() as conn:
        return conn.execute("SELECT 1 FROM leases WHERE event_id = ? AND until >= ?", (event_id, now)).fetchone() is not None


# ── Analytics ───────────────────────────────────────────────────────────────

def bump(event_id: str, day: str, kind: str) -> None:
    if _mongo is not None:
        _mongo.analytics.update_one({"e": event_id, "d": day, "k": kind}, {"$inc": {"c": 1}}, upsert=True)
        return
    with _sqlite() as conn:
        conn.execute(
            "INSERT INTO analytics (event_id, day, kind, count) VALUES (?, ?, ?, 1) "
            "ON CONFLICT (event_id, day, kind) DO UPDATE SET count = count + 1", (event_id, day, kind))


def analytics_rows(since: str, event_id: str | None) -> list[tuple[str, str, int]]:
    """(day, kind, count) summed over events, for days >= since."""
    if _mongo is not None:
        match = {"d": {"$gte": since}}
        if event_id:
            match["e"] = event_id
        return [(r["_id"]["d"], r["_id"]["k"], r["c"]) for r in _mongo.analytics.aggregate(
            [{"$match": match}, {"$group": {"_id": {"d": "$d", "k": "$k"}, "c": {"$sum": "$c"}}}])]
    where, params = "day >= ?", [since]
    if event_id:
        where, params = where + " AND event_id = ?", params + [event_id]
    with _sqlite() as conn:
        return conn.execute(f"SELECT day, kind, SUM(count) FROM analytics WHERE {where} GROUP BY day, kind",
                            params).fetchall()
