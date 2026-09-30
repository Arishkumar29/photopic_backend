import asyncio
import logging
import re
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..schemas import CreateEvent, UpdateEvent
from ..services import drive, event_store, face_index

log = logging.getLogger("events")
router = APIRouter(tags=["events"])

NOT_SHARED = ("No photos found in this Google Drive folder. Share it as \"Anyone with the link\" "
              "and make sure it contains JPG, PNG or WEBP photos.")


def _require(event_id: str) -> dict:
    if not (event := event_store.get(event_id)):
        raise HTTPException(404, "Event not found")
    return event


def _out(event: dict) -> dict:
    return {**event_store.public(event), "indexStatus": face_index.status(event)}


async def _scrape(folder: str) -> tuple[str, list[dict]]:
    folder_id = drive.extract_folder_id(folder)
    if not drive.is_folder_id(folder_id):
        raise HTTPException(400, "Please paste a Google Drive folder link (drive.google.com/drive/folders/…).")
    try:
        files = await drive.scrape_folder(folder_id)
    except Exception as err:
        log.warning("Drive folder %s unreadable: %s", folder_id, err)
        raise HTTPException(502, "Could not open the Google Drive folder. Check the link and try again.")
    if not files:
        raise HTTPException(400, NOT_SHARED)
    return folder_id, files


@router.post("/create-event")
@router.post("/events")
async def create_event(body: CreateEvent):
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", body.eventId or ""):
        raise HTTPException(400, "Missing or invalid eventId")
    if event_store.get(body.eventId):
        raise HTTPException(409, "An event with this id already exists")
    folder_id, files = await _scrape(body.folderId or "")
    event = {
        "eventId": body.eventId,
        "folderId": folder_id,
        "orgName": body.orgName or "Photographer",
        "eventName": body.eventName or "New Event",
        "driveFiles": files,
        "coverImage": body.coverImage,
    }
    await event_store.save(event)
    face_index.start(event)
    return {"success": True, "event": _out(event)}


@router.get("/events")
async def list_events():
    return {"events": [_out(e) for e in event_store.all_events()]}


@router.get("/events/{event_id}")
async def get_event(event_id: str):
    return {"success": True, "event": _out(_require(event_id))}


@router.put("/events/{event_id}")
async def update_event(event_id: str, body: UpdateEvent):
    event = _require(event_id)
    for name in ("eventName", "orgName", "coverImage", "description", "eventLocation", "eventType"):
        if (value := getattr(body, name)) is not None:
            event[name] = value
    if body.folderId and drive.extract_folder_id(body.folderId) != event["folderId"]:
        event["folderId"], event["driveFiles"] = await _scrape(body.folderId)
    await event_store.save(event)
    face_index.start(event)
    return {"success": True, "event": _out(event)}


@router.delete("/events/{event_id}")
async def delete_event(event_id: str):
    _require(event_id)
    await asyncio.to_thread(face_index.forget, event_id)
    await event_store.delete(event_id)
    return {"success": True}


@router.post("/events/{event_id}/index-faces")
async def index_faces(event_id: str):
    """Re-read the Drive folder and index any photos that are new since last time."""
    event = _require(event_id)
    _, event["driveFiles"] = await _scrape(event["folderId"])
    await event_store.save(event)
    face_index.start(event)
    status = face_index.status(event)
    return {"success": True, "eventId": event_id, "indexStatus": status, "totalFiles": status["total"]}


@router.get("/events/{event_id}/index-status")
async def index_status(event_id: str):
    return face_index.status(_require(event_id))


class _Sink:
    """Write-only buffer: zipfile streams into it and we flush it chunk by chunk."""

    def __init__(self):
        self.buf = bytearray()

    def write(self, data) -> int:
        self.buf += data
        return len(data)

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


@router.get("/events/{event_id}/download-zip")
async def download_zip(event_id: str):
    event = _require(event_id)
    files = event.get("driveFiles") or []
    sem = asyncio.Semaphore(8)

    async def fetch(f: dict) -> tuple[dict, bytes | None]:
        async with sem:
            try:
                return f, (await drive.fetch_file(f["id"], 2048))[0]
            except RuntimeError:
                log.warning("Zip: could not fetch %s", f["name"])
                return f, None

    async def stream():
        sink = _Sink()
        used: set[str] = set()
        # Photos are already-compressed JPEGs: storing them is as small and much faster.
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as zf:
            for next_done in asyncio.as_completed([fetch(f) for f in files]):
                f, data = await next_done
                if not data:
                    continue
                name, n = f["name"], 1
                while name.lower() in used:  # Drive allows duplicate names in one folder
                    stem, _, ext = f["name"].rpartition(".")
                    n += 1
                    name = f"{stem} ({n}).{ext}" if stem else f"{f['name']} ({n})"
                used.add(name.lower())
                zf.writestr(f"photos/{name}", data)
                yield sink.take()
        yield sink.take()

    safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", event.get("eventName") or "event")
    return StreamingResponse(stream(), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{safe_name}_photos.zip"'})
