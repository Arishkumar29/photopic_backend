"""Admin login: one organizer account, stateless signed tokens.

ADMIN_EMAIL / ADMIN_PASSWORD   the organizer's credentials (override the built-in account)
AUTH_SECRET                    signs tokens; if unset, one is derived from the credentials

Without env vars the built-in GWC account is used. The repo is public, so only
one-way hashes of its password are stored here: a PBKDF2 hash to check the
password, and a hash of a second password-derived key that signs its tokens
(the key travels inside the token, so nobody can mint a token without the password).
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

DEFAULT_EMAIL = "admin@gwcdata.ai"
DEFAULT_NAME = "GWC Admin"
DEFAULT_SALT = "5605616cc9d6fe8f45b20c23ad4e7d6a"
DEFAULT_PASSWORD_HASH = "af385bdc2c81f0cea338e5a96c7f4305e276fba9e16fbd0701f716c2fa95cab1"
DEFAULT_KEY_CHECK = "383805cc10c022b19b2a3a6ba4c29b6dc92a34cf924afc513f960e1f084ed429"
PBKDF2_ROUNDS = 300_000

USE_ENV = bool(ADMIN_EMAIL and ADMIN_PASSWORD)
if not USE_ENV:
    ADMIN_EMAIL, ADMIN_NAME = DEFAULT_EMAIL, ADMIN_NAME or DEFAULT_NAME

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
    return True


def _pbkdf2(password: str, salt: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ROUNDS)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: str, key: bytes = _SECRET) -> str:
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest())


def user() -> dict:
    return {"email": ADMIN_EMAIL, "name": ADMIN_NAME or ADMIN_EMAIL.split("@")[0].replace(".", " ").title()}


def issue_token(password: str = "") -> tuple[str, int]:
    expires = int(time.time()) + TOKEN_TTL
    payload = _b64(json.dumps({"sub": ADMIN_EMAIL, "exp": expires}).encode())
    if USE_ENV:
        return f"{payload}.{_sign(payload)}", expires
    key = _pbkdf2(password, DEFAULT_SALT + "|token")
    return f"{payload}.{_sign(payload, key)}.{_b64(key)}", expires


def verify_token(token: str) -> bool:
    try:
        if USE_ENV:
            payload, signature = token.split(".", 1)
            key = _SECRET
        else:
            payload, signature, key_b64 = token.split(".", 2)
            key = _unb64(key_b64)
            if not hmac.compare_digest(hashlib.sha256(key).hexdigest(), DEFAULT_KEY_CHECK):
                return False
        if not hmac.compare_digest(signature, _sign(payload, key)):
            return False
        claims = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    # Tokens are tied to the current admin email: changing it signs everyone out.
    return claims.get("sub") == ADMIN_EMAIL and claims.get("exp", 0) > time.time()


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_login(request: Request, email: str, password: str) -> None:
    ip, now = _client(request), time.time()
    recent = [t for t in _failures.get(ip, []) if t > now - LOGIN_WINDOW]
    if len(recent) >= LOGIN_LIMIT:
        raise HTTPException(429, "Too many attempts. Please wait a few minutes and try again.")
    email_ok = hmac.compare_digest((email or "").strip().lower().encode(), ADMIN_EMAIL.encode())
    if USE_ENV:
        password_ok = hmac.compare_digest((password or "").encode(), ADMIN_PASSWORD.encode())
    else:
        password_ok = hmac.compare_digest(_pbkdf2(password or "", DEFAULT_SALT).hex(), DEFAULT_PASSWORD_HASH)
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
