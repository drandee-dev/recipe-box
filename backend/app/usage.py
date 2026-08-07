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
    """Cents spent since the first of the month, or None when untracked.

    Asks PostgREST for the sum rather than downloading the rows and adding them
    up here. The old shape did the latter, which grew with usage on a check that
    runs before every single model call, and — worse — silently under-reported
    the moment a row cap applied: past the cap the total plateaus, the budget
    never trips, and the failure looks exactly like nothing being wrong.
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
                params={"select": "cents.sum()", "created_at": f"gte.{start.isoformat()}"},
                headers=_headers(key),
            )
            if resp.status_code >= 400:
                # Most likely cause if this ever fires: aggregate functions are
                # disabled on the project, which PostgREST reports as a 400 on
                # the select rather than as anything about aggregates. Logged
                # with the body because the alternative is a generic traceback
                # for a call that fails open and is therefore invisible.
                log.warning(
                    "usage lookup rejected (%s): %s — budget not enforced",
                    resp.status_code,
                    resp.text[:200],
                )
                return None
            rows = resp.json()
    except Exception:
        log.exception("usage lookup failed; not enforcing budget")
        return None

    # One row back, `{"sum": n}` — or `{"sum": null}` for a month with no events,
    # which is 0 spent and not the same answer as "untracked".
    if not isinstance(rows, list) or not rows:
        return 0.0
    try:
        return float(rows[0].get("sum") or 0)
    except (AttributeError, TypeError, ValueError):
        log.warning("usage sum came back in an unexpected shape: %r", rows[0])
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
