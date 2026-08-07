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


# Belt and braces on the row read below. PostgREST returns everything unless the
# project sets a max-rows cap, and a personal box produces a few hundred events a
# month, so this is not expected to be reached. Asking for it explicitly is what
# makes reaching it detectable instead of silent.
ROW_LIMIT = 10000


def sum_cents(rows) -> float | None:
    """Add up a page of usage rows. None when the shape is not what we expect."""
    if not isinstance(rows, list):
        return None
    total = 0.0
    for row in rows:
        try:
            total += float(row.get("cents") or 0)
        except (AttributeError, TypeError, ValueError):
            log.warning("usage row in an unexpected shape: %r", row)
            return None
    return total


def month_spend_cents() -> float | None:
    """Cents spent since the first of the month, or None when untracked.

    Reads the rows and adds them up here. This was briefly a `cents.sum()`
    aggregate instead, which is the better query and does not work: Supabase
    disables aggregate functions on the data API by default, PostgREST answers
    PGRST123, and because this whole path fails open the only visible effect was
    that the monthly ceiling quietly stopped being enforced. A correct query that
    the deployment refuses is worse than a plain one that runs.

    If exactness at volume ever matters, the fix is a Postgres function called
    over `/rpc/`, not the aggregate API. At a few hundred rows a month it does
    not matter yet.
    """
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
                params={
                    "select": "cents",
                    "created_at": f"gte.{start.isoformat()}",
                    "limit": ROW_LIMIT,
                },
                headers=_headers(key),
            )
            if resp.status_code >= 400:
                # Logged with the body because this call fails open, so without
                # this line a rejection is indistinguishable from a quiet month.
                log.warning(
                    "usage lookup rejected (%s): %s. Budget not enforced.",
                    resp.status_code,
                    resp.text[:200],
                )
                return None
            rows = resp.json()
    except Exception:
        log.exception("usage lookup failed; not enforcing budget")
        return None

    if isinstance(rows, list) and len(rows) >= ROW_LIMIT:
        # Past this point the total is a floor rather than the answer, which
        # means the ceiling is being enforced against an undercount.
        log.warning(
            "usage lookup hit the %s row limit; spend is being under-counted", ROW_LIMIT
        )
    return sum_cents(rows)


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
