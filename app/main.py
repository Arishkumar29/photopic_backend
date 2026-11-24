"""GWC PhotoPic backend: Google Drive event galleries with selfie face search.

Run locally (from backend/):  uvicorn app.main:app --reload --port 3000
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .routers import analytics, auth, events, media, scan
from .config import IS_SERVERLESS
from .services import event_store, face_engine, face_index, http, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATUS_PAGE = (Path(__file__).parent / "status.html").read_text(encoding="utf-8")


_ready = False
_ready_lock = asyncio.Lock()


async def ready() -> None:
    """Connect storage and load events once per process (lifespan isn't guaranteed on serverless)."""
    global _ready
    if _ready:
        return
    async with _ready_lock:
        if _ready:
            return
        await asyncio.to_thread(store.connect)
        await event_store.load_all()
        _ready = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ready()
    if not IS_SERVERLESS:
        # A long-running server loads the model up front and resumes interrupted indexing.
        await asyncio.to_thread(face_engine.load)
        for event in event_store.all_events():
            face_index.start(event)
    yield
    await http.close()
    face_engine.shutdown()


app = FastAPI(title="GWC PhotoPic API", version="3.0.0", lifespan=lifespan)

# Any frontend origin may call the API (the Origin is reflected, so credentials work).
app.add_middleware(CORSMiddleware, allow_origin_regex=".*", allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


# The frontends read `error` from failed responses (FastAPI's default key is `detail`).
@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:])
    return JSONResponse({"error": f"Invalid request: {field} {first.get('msg', '')}".strip()}, status_code=400)


@app.get("/", include_in_schema=False)
async def root(request: Request):
    if "text/html" in request.headers.get("accept", ""):
        return HTMLResponse(STATUS_PAGE)
    return {"status": "ok", "service": "GWC PhotoPic API", "docs": "/docs"}


@app.get("/api/health", tags=["health"], dependencies=[Depends(ready)])
async def health():
    return {
        "status": "healthy",
        "engine": "YuNet + AuraFace",
        "database": "mongodb" if event_store.db_connected() else "file",
        "mode": "serverless" if IS_SERVERLESS else "server",
        "modelLoaded": face_engine.loaded(),
        "events": len(event_store.events),
        **({"warning": "MONGODB_URI is not set: on serverless, events and the face index are lost "
                       "whenever an instance stops. Add a MongoDB Atlas connection string."}
           if IS_SERVERLESS and not event_store.db_connected() else {}),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


for router in (auth.router, events.router, scan.router, analytics.router, media.router):
    app.include_router(router, prefix="/api", dependencies=[Depends(ready)])
