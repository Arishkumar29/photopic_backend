"""GWC PhotoPic backend: Google Drive event galleries with selfie face search.

Run locally (from backend/):  uvicorn app.main:app --reload --port 3000
"""
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .routers import analytics, events, media, scan
from .services import event_store, face_engine, face_index, http

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATUS_PAGE = (Path(__file__).parent / "status.html").read_text(encoding="utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI):
    face_engine.load()
    await event_store.connect()
    await event_store.load_all()
    for event in event_store.all_events():  # finish indexing interrupted by a restart
        face_index.start(event)
    yield
    await http.close()
    await event_store.close()
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


@app.get("/api/health", tags=["health"])
async def health():
    return {
        "status": "healthy",
        "engine": "YuNet + AuraFace",
        "database": "mongodb" if event_store.db_connected() else "file",
        "events": len(event_store.events),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


for router in (events.router, scan.router, analytics.router, media.router):
    app.include_router(router, prefix="/api")
