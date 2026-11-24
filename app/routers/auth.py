import asyncio

from fastapi import APIRouter, Depends, Request

from ..schemas import Login
from ..services import auth

router = APIRouter(tags=["auth"])


@router.post("/auth/login")
async def login(body: Login, request: Request):
    # PBKDF2 takes ~0.3 s: keep it off the event loop.
    await asyncio.to_thread(auth.check_login, request, body.email or "", body.password or "")
    token, expires = await asyncio.to_thread(auth.issue_token, body.password or "")
    return {"token": token, "expiresAt": expires, "user": auth.user()}


@router.get("/auth/me", dependencies=[Depends(auth.require_admin)])
async def me():
    return {"user": auth.user()}


@router.get("/auth/status")
async def status():
    """Lets the login screen explain a missing server setup instead of a generic error."""
    return {"configured": auth.configured()}
