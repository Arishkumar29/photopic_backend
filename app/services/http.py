import httpx

from ..config import BROWSER_UA

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    """One pooled client for all outbound Drive / OneDrive traffic."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=10.0),
            follow_redirects=True,
            headers={"User-Agent": BROWSER_UA},
            limits=httpx.Limits(max_connections=32),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def fetch_image(url: str, referer: str | None = None) -> tuple[bytes, str] | None:
    """GET an image; None on any failure or on a placeholder-sized body."""
    headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
    if referer:
        headers["Referer"] = referer
    try:
        res = await client().get(url, headers=headers)
    except httpx.HTTPError:
        return None
    if res.status_code != 200 or len(res.content) <= 100:
        return None
    return res.content, res.headers.get("content-type", "image/jpeg")
