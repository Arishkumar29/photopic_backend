"""Events live in memory, backed by MongoDB when MONGODB_URI is set, else a JSON file."""
import json
import logging
from datetime import datetime, timezone

from ..config import EVENTS_FILE, MONGODB_URI
from . import drive

log = logging.getLogger("event_store")

FIELDS = ("eventId", "folderId", "orgName", "eventName", "driveFiles", "coverImage",
          "description", "eventLocation", "eventType", "createdAt")

events: dict[str, dict] = {}
_client = None
_collection = None


def db_connected() -> bool:
    return _collection is not None


async def connect() -> None:
    global _client, _collection
    if not MONGODB_URI:
        log.info("MONGODB_URI not set: events are stored in %s", EVENTS_FILE)
        return
    try:
        from pymongo import AsyncMongoClient

        _client = AsyncMongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, socketTimeoutMS=10000)
        await _client.admin.command("ping")
        _collection = _client.get_default_database("test")["events"]
        log.info("Connected to MongoDB.")
    except Exception as err:  # keep serving from disk
        log.error("MongoDB connection failed, using %s instead: %s", EVENTS_FILE, err)
        _client = _collection = None


async def close() -> None:
    if _client is not None:
        await _client.close()


def public(event: dict) -> dict:
    """API shape: the stored event plus a gallery URL per photo."""
    return {**event, "photos": [f["thumbUrl"] for f in event.get("driveFiles") or []]}


def _remember(doc: dict) -> dict:
    event = {k: doc[k] for k in FIELDS if doc.get(k) is not None}
    # Always derive thumbnails from the file id: scraped drive-storage links expire.
    event["driveFiles"] = [
        {"id": f["id"], "name": f.get("name") or f["id"], "thumbUrl": drive.thumb_url(f["id"])}
        for f in doc.get("driveFiles") or [] if f.get("id") and drive.is_folder_id(f["id"])
    ]
    events[event["eventId"]] = event
    return event


def _load_disk() -> None:
    try:
        loaded = json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    for doc in loaded.values():
        if doc.get("eventId") and drive.is_folder_id(str(doc.get("folderId", ""))):
            _remember(doc)
    log.info("Loaded %d events from %s", len(events), EVENTS_FILE)


def _save_disk() -> None:
    try:
        EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = EVENTS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(events, indent=2), encoding="utf-8")
        tmp.replace(EVENTS_FILE)  # atomic: a crash never leaves a half-written file
    except OSError as err:
        log.warning("Could not write %s: %s", EVENTS_FILE, err)


async def load_all() -> None:
    if not db_connected():
        _load_disk()
        return
    try:
        async for doc in _collection.find({}, {"_id": 0}):
            _remember(doc)
        log.info("Loaded %d events from MongoDB.", len(events))
    except Exception as err:
        log.warning("Could not load events from MongoDB: %s", err)
        _load_disk()


def get(event_id: str) -> dict | None:
    return events.get(event_id)


def all_events() -> list[dict]:
    return sorted(events.values(), key=lambda e: e.get("createdAt") or "", reverse=True)


async def save(event: dict) -> None:
    event.setdefault("createdAt", datetime.now(timezone.utc).isoformat())
    events[event["eventId"]] = event
    if not db_connected():
        _save_disk()
        return
    try:
        await _collection.update_one({"eventId": event["eventId"]}, {"$set": event}, upsert=True)
    except Exception as err:
        log.error("Failed to save event %s to MongoDB: %s", event["eventId"], err)
        raise


async def delete(event_id: str) -> None:
    events.pop(event_id, None)
    if not db_connected():
        _save_disk()
        return
    await _collection.delete_one({"eventId": event_id})
