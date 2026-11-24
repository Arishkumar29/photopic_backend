"""Admin login: one organizer account from env vars, stateless signed tokens.

ADMIN_EMAIL / ADMIN_PASSWORD   the organizer's credentials (required to log in)
AUTH_SECRET                    signs tokens; if unset, one is derived from the credentials
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import time

from fastapi import HTTPException, Request

from .. import config  # noqa: F401  (loads backend/.env before the variables below are read)

log = logging.getLogger("auth")

TOKEN_TTL = 7 * 24 * 3600  # one week
LOGIN_LIMIT = 8  # failed attempts per IP per window
LOGIN_WINDOW = 300

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
ADMIN_NAME = os.getenv("ADMIN_NAME", "").strip()

_failures: dict[str, list[float]] = {}


def _load_secret() -> bytes:
    if env := os.getenv("AUTH_SECRET"):
        return env.encode()
    # No secret configured: derive one from the credentials. Every instance (and
    # every serverless cold start) agrees on it, and changing the password signs
    # everyone out.
    return hashlib.sha256(f"photopic|{ADMIN_EMAIL}|{ADMIN_PASSWORD}".encode()).hexdigest().encode()


_SECRET = _load_secret()


def configured() -> bool:
    return bool(ADMIN_EMAIL and ADMIN_PASSWORD)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: str) -> str:
    return _b64(hmac.new(_SECRET, payload.encode(), hashlib.sha256).digest())


def user() -> dict:
    return {"email": ADMIN_EMAIL, "name": ADMIN_NAME or ADMIN_EMAIL.split("@")[0].replace(".", " ").title()}


def issue_token() -> tuple[str, int]:
    expires = int(time.time()) + TOKEN_TTL
    payload = _b64(json.dumps({"sub": ADMIN_EMAIL, "exp": expires}).encode())
    return f"{payload}.{_sign(payload)}", expires


def verify_token(token: str) -> bool:
    try:
        payload, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(payload)):
            return False
        claims = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    # Tokens are tied to the current admin email: changing it signs everyone out.
    return claims.get("sub") == ADMIN_EMAIL and claims.get("exp", 0) > time.time()


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_login(request: Request, email: str, password: str) -> None:
    if not configured():
        raise HTTPException(503, "Admin login is not set up. Set ADMIN_EMAIL and ADMIN_PASSWORD on the server.")
    ip, now = _client(request), time.time()
    recent = [t for t in _failures.get(ip, []) if t > now - LOGIN_WINDOW]
    if len(recent) >= LOGIN_LIMIT:
        raise HTTPException(429, "Too many attempts. Please wait a few minutes and try again.")
    email_ok = hmac.compare_digest((email or "").strip().lower().encode(), ADMIN_EMAIL.encode())
    password_ok = hmac.compare_digest((password or "").encode(), ADMIN_PASSWORD.encode())
    if not (email_ok and password_ok):
        _failures[ip] = recent + [now]
        log.warning("Failed admin login from %s", ip)
        raise HTTPException(401, "Incorrect email or password.")
    _failures.pop(ip, None)


def _token_from(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # Plain links (e.g. the event ZIP download) can't send headers.
    return request.query_params.get("token", "")


async def require_admin(request: Request) -> None:
    """FastAPI dependency for organizer-only routes."""
    if not verify_token(_token_from(request)):
        raise HTTPException(401, "Please sign in to the admin portal.")
