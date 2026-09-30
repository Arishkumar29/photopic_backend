"""Public Google Drive folders: list photos (including subfolders) and fetch them."""
import html
import logging
import re

from .http import client, fetch_image

log = logging.getLogger("drive")

IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
MAX_DEPTH = 3
MAX_FOLDERS = 50

_FILE_RE = re.compile(
    r'href="https://drive\.google\.com/file/d/([a-zA-Z0-9_-]+)/view[^>]*>[\s\S]*?'
    r'<div class="flip-entry-title">([^<]+)</div>'
)
_FOLDER_RE = re.compile(r'href="https://drive\.google\.com/drive/folders/([a-zA-Z0-9_-]+)')


def extract_folder_id(value: str) -> str:
    """Accept a folder id or any Drive folder link (…/folders/<id>, ?id=<id>)."""
    value = (value or "").strip()
    if m := re.search(r"folders/([a-zA-Z0-9_-]+)", value):
        return m.group(1)
    if m := re.search(r"[?&]id=([a-zA-Z0-9_-]+)", value):
        return m.group(1)
    return value


def is_folder_id(value: str) -> bool:
    return bool(re.fullmatch(r"[a-zA-Z0-9_-]{10,}", value))


def thumb_url(file_id: str, width: int = 800) -> str:
    """Stable public image URL (the scraped drive-storage links are signed and expire)."""
    return f"https://lh3.googleusercontent.com/d/{file_id}=w{width}"


def photo_urls(file_id: str, width: int) -> list[str]:
    return [thumb_url(file_id, width), f"https://drive.google.com/thumbnail?id={file_id}&sz=w{width}"]


async def _list(folder_id: str) -> tuple[list[dict], list[str]]:
    res = await client().get(f"https://drive.google.com/embeddedfolderview?id={folder_id}")
    if res.status_code != 200:
        raise RuntimeError(f"Google Drive returned HTTP {res.status_code} for folder {folder_id}")
    files = [
        {"id": file_id, "name": html.unescape(name).strip()}
        for file_id, name in _FILE_RE.findall(res.text)
        if name.rsplit(".", 1)[-1].lower() in IMAGE_EXTENSIONS
    ]
    subfolders = [f for f in dict.fromkeys(_FOLDER_RE.findall(res.text)) if f != folder_id]
    return files, subfolders


async def scrape_folder(folder_id: str) -> list[dict]:
    """All photos in a public ("anyone with the link") folder and its subfolders."""
    photos: dict[str, dict] = {}
    queue, seen = [(folder_id, 0)], {folder_id}
    while queue and len(seen) <= MAX_FOLDERS:
        current, depth = queue.pop(0)
        try:
            files, subfolders = await _list(current)
        except Exception:
            if current == folder_id:
                raise
            log.warning("Skipping unreadable subfolder %s", current)
            continue
        for f in files:
            photos.setdefault(f["id"], {**f, "thumbUrl": thumb_url(f["id"])})
        if depth < MAX_DEPTH:
            for sub in subfolders:
                if sub not in seen:
                    seen.add(sub)
                    queue.append((sub, depth + 1))
    return list(photos.values())


async def fetch_file(file_id: str, width: int = 1600) -> tuple[bytes, str]:
    for url in photo_urls(file_id, width):
        if got := await fetch_image(url, referer="https://drive.google.com/"):
            return got
    raise RuntimeError(f"Could not download Google Drive file {file_id}")
