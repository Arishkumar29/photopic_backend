import asyncio
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from ..services import auth, event_store, store

router = APIRouter(tags=["analytics"])

KINDS = ("visits", "views", "downloads", "faceScans")


def _bump(event_id: str, kind: str) -> None:
    store.bump(event_id, date.today().isoformat(), kind)


async def record(event_id: str, kind: str) -> None:
    await asyncio.to_thread(_bump, event_id, kind)


async def _track(event_id: str, kind: str) -> dict:
    if not await event_store.find(event_id):
        raise HTTPException(404, "Event not found")
    await record(event_id, kind)
    return {"success": True}


@router.post("/events/{event_id}/track-visit")
async def track_visit(event_id: str):
    return await _track(event_id, "visits")


@router.post("/events/{event_id}/track-view")
async def track_view(event_id: str):
    return await _track(event_id, "views")


@router.post("/events/{event_id}/track-download")
async def track_download(event_id: str):
    return await _track(event_id, "downloads")


def _summary(days: int, event_id: str | None) -> dict:
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = store.analytics_rows(since, event_id)

    totals = dict.fromkeys(KINDS, 0)
    visits_by_day: dict[str, int] = {}
    for day, kind, count in rows:
        if kind in totals:
            totals[kind] += count
        if kind == "visits":
            visits_by_day[day] = visits_by_day.get(day, 0) + count

    labels, data = [], []
    for back in range(days - 1, -1, -1):
        d = date.today() - timedelta(days=back)
        labels.append(d.strftime("%b %d"))
        data.append(visits_by_day.get(d.isoformat(), 0))
    return {**totals, "timeline": {"labels": labels, "data": data}}


@router.get("/analytics", dependencies=[Depends(auth.require_admin)])
async def get_analytics(period: int = Query(30, ge=1, le=365), eventId: str | None = None):
    return await asyncio.to_thread(_summary, period, eventId)
