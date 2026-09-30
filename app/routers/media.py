import logging

from fastapi import APIRouter, HTTPException, Query, Response

from ..services import drive

log = logging.getLogger("media")
router = APIRouter(tags=["media"])


@router.get("/drive-proxy/{file_id}")
async def drive_proxy(file_id: str, w: int = Query(1600, ge=100, le=4000)):
    """Serve a Drive photo from our origin so browsers can zip / edit it (CORS)."""
    if not drive.is_folder_id(file_id):
        raise HTTPException(400, "Invalid file id")
    try:
        data, content_type = await drive.fetch_file(file_id, w)
    except RuntimeError as err:
        log.warning("%s", err)
        raise HTTPException(404, "Photo not found")
    return Response(data, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})
