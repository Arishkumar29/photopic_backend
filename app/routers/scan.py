import asyncio
import base64
import binascii
import logging
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..config import SCAN_RATE_LIMIT
from ..schemas import ScanFaces
from ..services import event_store, face_engine, face_index, matcher
from . import analytics

log = logging.getLogger("scan")
router = APIRouter(tags=["scan"])

_DATA_URL = re.compile(r"^data:image/[A-Za-z+.-]+;base64,(.+)$", re.DOTALL)
_hits: dict[str, tuple[int, float]] = {}


def _rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    count, reset = _hits.get(ip, (0, 0.0))
    if reset < now:
        count, reset = 0, now + 60
    if count >= SCAN_RATE_LIMIT:
        raise HTTPException(429, "Too many scans. Please wait a minute and try again.")
    _hits[ip] = (count + 1, reset)


def _decode(value: str | None) -> bytes | None:
    if not value or not (m := _DATA_URL.match(value)):
        return None
    try:
        return base64.b64decode(m.group(1), validate=False)
    except (binascii.Error, ValueError):
        return None


@router.post("/scan-faces")
async def scan_faces(body: ScanFaces, request: Request):
    _rate_limit(request)
    if not body.eventId:
        raise HTTPException(400, "Missing eventId")
    # Never fall back to another event: that would show a guest someone else's photos.
    if not (event := event_store.get(body.eventId)):
        raise HTTPException(404, "Event not found. Please check your event link or QR code.")
    if not (image := _decode(body.referenceImage)):
        raise HTTPException(400, "Missing or unreadable selfie image.")

    started = time.perf_counter()
    selfie = await face_engine.run_scan(face_engine.selfie_vectors, image)
    if selfie is None:
        return JSONResponse(status_code=422, content={
            "error": "no_face",
            "message": "We couldn't find a face in your selfie. Face the camera in good light and try again.",
        })
    await analytics.record(event["eventId"], "faceScans")

    status = face_index.status(event)
    if status["state"] == "pending":
        face_index.start(event)
        status = face_index.status(event)

    file_ids, faces = await asyncio.to_thread(face_index.event_faces, event["eventId"])
    matches = matcher.match(selfie, file_ids, faces)
    log.info("%s: %d photos matched against %d faces in %.0f ms", event["eventId"], len(matches),
             len(file_ids), (time.perf_counter() - started) * 1000)

    return {
        "matches": [f"/api/drive-proxy/{m.file_id}" for m in matches],
        "count": len(matches),
        "scores": [m.score for m in matches],
        # Present while photos are still being indexed: more matches may appear later.
        "indexing": status if status["state"] == "indexing" else None,
    }
