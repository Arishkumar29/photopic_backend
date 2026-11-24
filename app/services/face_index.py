"""Per-event face index: every identifiable face in every Drive photo, keyed by file id.

Indexing is incremental: photos already indexed are skipped, photos removed from
the folder are dropped, and an interrupted run resumes where it stopped. A photo
that can't be downloaded is retried on later runs, then given up after
store.MAX_ATTEMPTS so one broken file never keeps an event "indexing" forever.

On a server, `start` runs indexing as a background task. Serverless platforms
freeze the process after each response, so there `step` does a time-boxed chunk
per request instead, guarded by a lease so concurrent callers don't duplicate work.
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field

import numpy as np

from ..config import INDEX_STEP_SECONDS, IS_SERVERLESS
from . import drive, face_engine, store
from .http import fetch_image

log = logging.getLogger("face_index")

DIM = 512
BATCH = 8        # photos per write; guests see results as soon as a batch lands
DOWNLOADS = 6    # concurrent Drive downloads


@dataclass
class Job:
    total: int
    done: int = 0
    failed: int = 0
    task: asyncio.Task | None = field(default=None, repr=False)


_jobs: dict[str, Job] = {}
_cache: dict[str, tuple[int, list[str], np.ndarray]] = {}  # event -> (face count, file id per face, vectors)


# ── Reading ─────────────────────────────────────────────────────────────────

def event_faces(event_id: str) -> tuple[list[str], np.ndarray]:
    """All face vectors of an event. Re-read when another instance added faces."""
    count = store.face_count(event_id)
    cached = _cache.get(event_id)
    if cached and cached[0] == count:
        return cached[1], cached[2]
    ids, blobs = store.face_vectors(event_id)
    vectors = np.frombuffer(b"".join(blobs), dtype=np.float32).reshape(-1, DIM)
    _cache[event_id] = (len(ids), ids, vectors)
    return ids, vectors


def _photo_ids(event: dict) -> list[str]:
    return list(dict.fromkeys(f["id"] for f in event.get("driveFiles") or []))


def status(event: dict) -> dict:
    """Progress for the admin card and the guest 'still indexing' screen (blocking: run in a thread)."""
    event_id = event["eventId"]
    total = len(_photo_ids(event))
    if job := _jobs.get(event_id):
        p = store.progress(event_id)
        return {"state": "indexing", "done": job.done, "total": job.total, "failed": job.failed, "faces": p["faces"]}
    p = store.progress(event_id)
    done = min(p["processed"], total)
    if total and done >= total:
        state = "ready"
    elif IS_SERVERLESS and store.lease_active(event_id):
        state = "indexing"
    else:
        state = "partial" if done else "pending"
    return {"state": state, "done": done, "total": total, "failed": p["failed"], "faces": p["faces"]}


async def status_async(event: dict) -> dict:
    return await asyncio.to_thread(status, event)


# ── Work ────────────────────────────────────────────────────────────────────

async def _download(file_id: str) -> bytes | None:
    for url in drive.photo_urls(file_id, 2048):
        if got := await fetch_image(url, referer="https://drive.google.com/"):
            return got[0]
    return None


def _todo(event: dict) -> list[str]:
    ids = _photo_ids(event)
    if store.prune(event["eventId"], set(ids)):
        _cache.pop(event["eventId"], None)
    done = store.done_ids(event["eventId"])
    return [i for i in ids if i not in done]


async def _process(event_id: str, todo: list[str], job: Job | None, deadline: float | None) -> int:
    """Download and index photos until done or past the deadline. Returns photos processed."""
    sem = asyncio.Semaphore(DOWNLOADS)
    processed = 0

    async def fetch(file_id: str) -> tuple[str, bytes | None]:
        async with sem:
            return file_id, await _download(file_id)

    # Bounded look-ahead: with a deadline we must not start hundreds of downloads.
    window = DOWNLOADS * 2
    queue = list(todo)
    pending: set[asyncio.Task] = set()
    batch: list[tuple[str, list | None]] = []
    try:
        while queue or pending:
            while queue and len(pending) < window and (deadline is None or time.monotonic() < deadline):
                pending.add(asyncio.create_task(fetch(queue.pop(0))))
            if not pending:
                break
            finished, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in finished:
                file_id, data = task.result()
                faces = await face_engine.run_index(face_engine.photo_faces, data) if data else None
                batch.append((file_id, faces))
                processed += 1
                if job:
                    job.done += 1
                    job.failed += faces is None
            if len(batch) >= BATCH:
                await asyncio.to_thread(store.save_results, event_id, batch)
                batch = []
            if deadline is not None and time.monotonic() >= deadline:
                # Out of time: drop unfinished downloads; those photos stay in the to-do list.
                for task in pending:
                    task.cancel()
                pending = set()
                queue.clear()
    finally:
        if batch:
            await asyncio.to_thread(store.save_results, event_id, batch)
        _cache.pop(event_id, None)
    return processed


def start(event: dict) -> Job | None:
    """Server mode: index the event's new photos in the background (joins a running job).

    Serverless mode: does nothing; callers drive indexing with `step`.
    """
    if IS_SERVERLESS:
        return None
    event_id = event["eventId"]
    if job := _jobs.get(event_id):
        return job
    total = len(_photo_ids(event))
    job = Job(total=total, done=min(store.progress(event_id)["processed"], total))
    _jobs[event_id] = job

    async def run() -> None:
        started = time.monotonic()
        todo = await asyncio.to_thread(_todo, event)
        job.done = total - len(todo)
        if todo:
            await _process(event_id, todo, job, None)
            log.info("Indexed %s: %d photos (%d unreadable) in %.0fs", event_id, len(todo), job.failed,
                     time.monotonic() - started)

    job.task = asyncio.create_task(run())

    def finished(task: asyncio.Task) -> None:
        if _jobs.get(event_id) is job:
            del _jobs[event_id]
        if not task.cancelled() and task.exception():
            log.error("Indexing failed for %s: %s", event_id, task.exception())

    job.task.add_done_callback(finished)
    return job


async def step(event: dict, seconds: float = INDEX_STEP_SECONDS) -> dict:
    """Advance indexing by up to `seconds` and return the status. Safe to call from anyone, any time."""
    if not IS_SERVERLESS:
        status = await status_async(event)
        if status["state"] in ("pending", "partial"):
            start(event)
            status = await status_async(event)
        return status
    event_id = event["eventId"]
    if not await asyncio.to_thread(store.acquire_lease, event_id, seconds + 30):
        return await status_async(event)  # another instance is on it
    try:
        todo = await asyncio.to_thread(_todo, event)
        if todo:
            await asyncio.to_thread(face_engine.load)
            n = await _process(event_id, todo, None, time.monotonic() + seconds)
            log.info("Index step %s: %d photos, %d left", event_id, n, len(todo) - n)
    finally:
        await asyncio.to_thread(store.release_lease, event_id)
    return await status_async(event)


def forget(event_id: str) -> None:
    if job := _jobs.pop(event_id, None):
        job.task.cancel()
    store.forget(event_id)
    _cache.pop(event_id, None)
