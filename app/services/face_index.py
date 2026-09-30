"""Per-event face index: every identifiable face in every Drive photo, keyed by file id.

Indexing is incremental: photos already indexed are skipped, photos removed from
the folder are dropped, and an interrupted run resumes where it stopped.
"""
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field

import numpy as np

from . import db, drive, face_engine
from .http import fetch_image

log = logging.getLogger("face_index")

DIM = 512
BATCH = 8  # photos per commit; guests see results as soon as a batch lands


@dataclass
class Job:
    total: int
    done: int = 0
    failed: int = 0
    task: asyncio.Task | None = field(default=None, repr=False)


_jobs: dict[str, Job] = {}
_cache: dict[str, tuple[list[str], np.ndarray]] = {}  # event -> (file id per face, vectors)


# ── Reading ─────────────────────────────────────────────────────────────────

def event_faces(event_id: str) -> tuple[list[str], np.ndarray]:
    if event_id not in _cache:
        with db.connect() as conn:
            rows = conn.execute("SELECT file_id, vector FROM faces WHERE event_id = ?", (event_id,)).fetchall()
        ids = [r[0] for r in rows]
        vectors = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float32).reshape(-1, DIM)
        _cache[event_id] = (ids, vectors)
    return _cache[event_id]


def _indexed_ids(event_id: str) -> set[str]:
    with db.connect() as conn:
        return {r[0] for r in conn.execute("SELECT file_id FROM indexed_files WHERE event_id = ?", (event_id,))}


def status(event: dict) -> dict:
    """Progress for the admin card and the guest 'still indexing' screen."""
    event_id = event["eventId"]
    total = len({f["id"] for f in event.get("driveFiles") or []})
    if job := _jobs.get(event_id):
        return {"state": "indexing", "done": job.done, "total": job.total, "failed": job.failed,
                "faces": len(event_faces(event_id)[0])}
    with db.connect() as conn:
        indexed, faces = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(faces), 0) FROM indexed_files WHERE event_id = ?", (event_id,)
        ).fetchone()
    state = "ready" if total and indexed >= total else "partial" if indexed else "pending"
    return {"state": state, "done": indexed, "total": total, "failed": max(0, total - indexed), "faces": faces}


# ── Writing ─────────────────────────────────────────────────────────────────

def _save(event_id: str, results: list[tuple[str, list[face_engine.Face]]]) -> None:
    now = time.time()
    with db.connect() as conn:
        for file_id, faces in results:
            conn.execute("DELETE FROM faces WHERE event_id = ? AND file_id = ?", (event_id, file_id))
            conn.executemany(
                "INSERT INTO faces (event_id, file_id, face_no, det_score, box, vector) VALUES (?, ?, ?, ?, ?, ?)",
                [(event_id, file_id, n, f.score, json.dumps(f.box), f.vector.tobytes()) for n, f in enumerate(faces)],
            )
            conn.execute(
                "INSERT OR REPLACE INTO indexed_files (event_id, file_id, faces, indexed_at) VALUES (?, ?, ?, ?)",
                (event_id, file_id, len(faces), now),
            )
    _cache.pop(event_id, None)


def _prune(event_id: str, keep: set[str]) -> None:
    with db.connect() as conn:
        stale = [r[0] for r in conn.execute("SELECT file_id FROM indexed_files WHERE event_id = ?", (event_id,))
                 if r[0] not in keep]
        for file_id in stale:
            conn.execute("DELETE FROM faces WHERE event_id = ? AND file_id = ?", (event_id, file_id))
            conn.execute("DELETE FROM indexed_files WHERE event_id = ? AND file_id = ?", (event_id, file_id))
    if stale:
        _cache.pop(event_id, None)


def forget(event_id: str) -> None:
    if job := _jobs.pop(event_id, None):
        job.task.cancel()
    with db.connect() as conn:
        conn.execute("DELETE FROM faces WHERE event_id = ?", (event_id,))
        conn.execute("DELETE FROM indexed_files WHERE event_id = ?", (event_id,))
    _cache.pop(event_id, None)


# ── Indexing ────────────────────────────────────────────────────────────────

async def _download(f: dict) -> bytes | None:
    for url in drive.photo_urls(f["id"], 2048):
        if got := await fetch_image(url, referer="https://drive.google.com/"):
            return got[0]
    return None


async def _run(event_id: str, files: list[dict], job: Job) -> None:
    started = time.monotonic()
    sem = asyncio.Semaphore(6)

    async def fetch(f: dict) -> tuple[dict, bytes | None]:
        async with sem:
            return f, await _download(f)

    pending = [asyncio.create_task(fetch(f)) for f in files]
    batch: list[tuple[str, list[face_engine.Face]]] = []
    for next_done in asyncio.as_completed(pending):
        f, data = await next_done
        faces = await face_engine.run_index(face_engine.photo_faces, data) if data else None
        if faces is None:
            job.failed += 1  # left unindexed, so the next run retries it
        else:
            batch.append((f["id"], faces))
        job.done += 1
        if len(batch) >= BATCH:
            await asyncio.to_thread(_save, event_id, batch)
            batch = []
    if batch:
        await asyncio.to_thread(_save, event_id, batch)
    log.info("Indexed %s: %d photos (%d failed) in %.0fs", event_id, job.done, job.failed,
             time.monotonic() - started)


def start(event: dict) -> Job | None:
    """Index the event's new photos in the background. Joins a run already going."""
    event_id = event["eventId"]
    if job := _jobs.get(event_id):
        return job
    files = list({f["id"]: f for f in event.get("driveFiles") or []}.values())
    _prune(event_id, {f["id"] for f in files})
    done = _indexed_ids(event_id)
    todo = [f for f in files if f["id"] not in done]
    if not todo:
        return None

    # Progress covers the whole event, counting photos indexed by earlier runs.
    job = Job(total=len(files), done=len(files) - len(todo))
    job.task = asyncio.create_task(_run(event_id, todo, job))
    _jobs[event_id] = job

    def finished(task: asyncio.Task) -> None:
        if _jobs.get(event_id) is job:
            del _jobs[event_id]
        if not task.cancelled() and task.exception():
            log.error("Indexing failed for %s: %s", event_id, task.exception())

    job.task.add_done_callback(finished)
    return job
