"""Events, cached in memory and persisted through services.store (MongoDB or events.json).

On a single server the cache is the truth. On serverless several instances run at
once, so the cache is re-read from MongoDB when it is older than REFRESH_SECONDS
and whenever an event id is not found.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone

from ..config import IS_SERVERLESS
from . import drive, store

log = logging.getLogger("event_store")

FIELDS = ("eventId", "folderId", "orgName", "eventName", "driveFiles", "coverImage",
          "description", "eventLocation", "eventType", "eventDate", "createdAt")
REFRESH_SECONDS = 15

events: dict[str, dict] = {}
_loaded_at = 0.0


def db_connected() -> bool:
    return store.mongo_connected()


def public(event: dict) -> dict:
    """API shape: the stored event plus a gallery URL per photo."""
    return {**event, "photos": [f["thumbUrl"] for f in event.get("driveFiles") or []]}


def _clean(doc: dict) -> dict | None:
    if not doc.get("eventId") or not drive.is_folder_id(str(doc.get("folderId", ""))):
        return None
    event = {k: doc[k] for k in FIELDS if doc.get(k) is not None}
    # Always derive thumbnails from the file id: scraped drive-storage links expire.
    event["driveFiles"] = [
        {"id": f["id"], "name": f.get("name") or f["id"], "thumbUrl": drive.thumb_url(f["id"])}
        for f in doc.get("driveFiles") or [] if f.get("id") and drive.is_folder_id(f["id"])
    ]
    return event


async def load_all() -> None:
    global _loaded_at
    try:
        docs = await asyncio.to_thread(store.load_events)
    except Exception as err:
        log.warning("Could not load events: %s", err)
        return
    fresh = {e["eventId"]: e for e in map(_clean, docs) if e}
    events.clear()
    events.update(fresh)
    _loaded_at = time.monotonic()


async def refresh(force: bool = False) -> None:
    """Re-read events written by other serverless instances (no-op on a single server)."""
    if IS_SERVERLESS and (force or time.monotonic() - _loaded_at > REFRESH_SECONDS):
        await load_all()


async def find(event_id: str) -> dict | None:
    if event_id not in events and IS_SERVERLESS:
        doc = await asyncio.to_thread(store.load_event, event_id)
        if doc and (event := _clean(doc)):
            events[event_id] = event
    return events.get(event_id)


def get(event_id: str) -> dict | None:
    return events.get(event_id)


def all_events() -> list[dict]:
    return sorted(events.values(), key=lambda e: e.get("createdAt") or "", reverse=True)


async def save(event: dict) -> None:
    event.setdefault("createdAt", datetime.now(timezone.utc).isoformat())
    events[event["eventId"]] = event
    try:
        await asyncio.to_thread(store.save_event, event, dict(events))
    except Exception as err:
        log.error("Failed to save event %s: %s", event["eventId"], err)
        raise


async def delete(event_id: str) -> None:
    events.pop(event_id, None)
    await asyncio.to_thread(store.delete_event, event_id, dict(events))
