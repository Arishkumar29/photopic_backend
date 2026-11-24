from fastapi import APIRouter, Depends, Request

from ..schemas import Login
from ..services import auth

router = APIRouter(tags=["auth"])


@router.post("/auth/login")
async def login(body: Login, request: Request):
    auth.check_login(request, body.email or "", body.password or "")
    token, expires = auth.issue_token()
    return {"token": token, "expiresAt": expires, "user": auth.user()}


@router.get("/auth/me", dependencies=[Depends(auth.require_admin)])
async def me():
    return {"user": auth.user()}


@router.get("/auth/status")
async def status():
    """Lets the login screen explain a missing server setup instead of a generic error."""
    return {"configured": auth.configured()}
