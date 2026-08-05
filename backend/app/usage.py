"""AI spend tracking against Supabase.

Serverless functions don't share memory, so the running total has to live in the
database. Both calls fail open: if Supabase isn't configured the budget simply
isn't enforced, and a logging failure never blocks an extraction.
"""

import datetime as dt
import logging
import os

import httpx

log = logging.getLogger("recipe.usage")

TABLE = "ai_usage_events"
TIMEOUT = 5.0


def _config() -> tuple[str, str] | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    return (url, key) if url and key else None


def _headers(key: str) -> dict:
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def month_spend_cents() -> float | None:
    """Cents spent since the first of the month, or None when untracked."""
    conf = _config()
    if not conf:
        return None
    url, key = conf
    start = dt.datetime.now(dt.timezone.utc).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{url}/rest/v1/{TABLE}",
                params={"select": "cents", "created_at": f"gte.{start.isoformat()}"},
                headers=_headers(key),
            )
            resp.raise_for_status()
            return sum(float(row.get("cents") or 0) for row in resp.json())
    except Exception:
        log.exception("usage lookup failed; not enforcing budget")
        return None


def record_usage(cents: float, model: str) -> None:
    conf = _config()
    if not conf:
        return
    url, key = conf
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            client.post(
                f"{url}/rest/v1/{TABLE}",
                json={"cents": round(cents, 4), "model": model},
                headers=_headers(key),
            )
    except Exception:
        log.exception("usage write failed")
