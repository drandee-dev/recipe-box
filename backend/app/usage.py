"""AI spend tracking against Supabase, and the per-caller cap built on top of it.

Serverless functions don't share memory, so both the running total and the
per-caller counter have to live in the database. Every call here fails open: if
Supabase isn't configured the budget simply isn't enforced, a logging failure
never blocks an extraction, and an unreachable rate-limit lookup lets the request
through. That is a deliberate choice rather than an oversight — the alternative
is that a Supabase blip stops the owner importing recipes — and it is survivable
because the two ceilings back each other up: with the per-IP cap in place, an
outage that removes the monthly ceiling still leaves a public endpoint that no
single caller can loop on, and `/api/health` reports `budget.tracked: false` so
the untracked state is one curl away rather than invisible.
"""

import contextvars
import datetime as dt
import hashlib
import logging
import os

import httpx

log = logging.getLogger("recipe.usage")

TABLE = "ai_usage_events"
TIMEOUT = 5.0

# The per-caller ceiling on model calls. Twenty an hour is far above anything a
# person does by hand — a heavy session is a handful of imports — and far below
# what it takes to spend the month's budget in a loop.
RATE_LIMIT_CALLS = 20
RATE_WINDOW_MINUTES = 60


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


# Set once at the endpoint boundary and read by record_usage, which sits four
# calls deeper (main -> extract -> ai._structure -> record_usage). Threading an
# argument through all four would mean every future model-call path has to
# remember to pass it, and the comment in ai.py already warns that a second
# model-call path is a second place to forget the budget. One request is one
# synchronous call stack in one thread here, so an ambient value is exact.
_caller = contextvars.ContextVar("recipe_caller_hash", default="")


def set_caller(ip_hash: str) -> None:
    _caller.set(ip_hash or "")


def client_ip(headers) -> str:
    """The connecting address, preferring the headers the platform sets itself.

    `x-forwarded-for` is the familiar one and the wrong one to trust first: a
    client can send its own, and a proxy that appends rather than replaces leaves
    the attacker's value on the left. `x-real-ip` is written by Vercel's edge from
    the actual connection, so it is the one a caller cannot choose.

    Getting this wrong is an evasion risk, not an attack on anyone else — a
    forged address only ever opens a fresh empty bucket for the forger, it can't
    fill someone else's — but evasion is exactly what the cap is for.
    """
    for name in ("x-real-ip", "x-vercel-forwarded-for"):
        value = (headers.get(name) or "").strip()
        if value:
            return value.split(",")[0].strip()
    forwarded = (headers.get("x-forwarded-for") or "").strip()
    return forwarded.split(",")[0].strip()


def caller_hash(ip: str) -> str:
    """A stable, non-reversible id for one caller. Empty when there is no address.

    Hashed rather than stored raw so the table never becomes a log of who visited.
    `RATE_LIMIT_SALT` is optional and worth setting: unsalted, the whole IPv4
    space is four billion hashes, which is minutes of work. Without it the column
    is still no worse than storing the address itself.
    """
    ip = (ip or "").strip()
    if not ip:
        return ""
    salt = os.environ.get("RATE_LIMIT_SALT", "")
    return hashlib.sha256(f"{salt}|{ip}".encode()).hexdigest()[:32]


def recent_calls(ip_hash: str) -> int | None:
    """Model calls charged to this caller inside the window. None when untracked.

    Counted by reading ids rather than asking PostgREST for a count, for the same
    reason `month_spend_cents` adds rows up by hand: Supabase disables aggregate
    functions on the data API by default. The read is capped one past the limit,
    since the only question is whether the ceiling has been reached.
    """
    conf = _config()
    if not conf or not ip_hash:
        return None
    url, key = conf
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=RATE_WINDOW_MINUTES)
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{url}/rest/v1/{TABLE}",
                params={
                    "select": "id",
                    "ip_hash": f"eq.{ip_hash}",
                    "created_at": f"gte.{since.isoformat()}",
                    "limit": RATE_LIMIT_CALLS + 1,
                },
                headers=_headers(key),
            )
            if resp.status_code >= 400:
                # Logged with the body because this fails open too, and a
                # rejected query looks exactly like a quiet caller otherwise.
                log.warning(
                    "rate lookup rejected (%s): %s. Per-caller cap not enforced.",
                    resp.status_code,
                    resp.text[:200],
                )
                return None
            rows = resp.json()
    except Exception:
        log.exception("rate lookup failed; not enforcing the per-caller cap")
        return None

    return len(rows) if isinstance(rows, list) else None


def over_rate_limit(ip_hash: str) -> bool:
    """True only when we know the caller is over. Not knowing lets them through."""
    count = recent_calls(ip_hash)
    return count is not None and count >= RATE_LIMIT_CALLS


# A hash no real address produces, used to ask the question "would this query
# work" without needing a caller.
_PROBE = "0" * 32


def rate_tracked() -> bool:
    """Is the per-caller cap actually being applied? For /api/health.

    This exists because the lookup fails open and would otherwise be invisible:
    if `ai_usage_events.ip_hash` is missing — the schema re-run that ships with
    this feature not having happened, most likely — PostgREST answers 42703,
    `recent_calls` returns None, and every caller is waved through forever while
    the API looks entirely healthy. The budget had exactly this shape and it took
    reading function logs inside their one-hour retention to find.

    The probe runs the real query, so it fails for every reason the real one does.
    """
    return recent_calls(_PROBE) is not None


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
    """One row per model call. It is both the spend ledger and the rate counter.

    `ip_hash` comes off the context set at the endpoint, so it is present for
    calls that arrived over HTTP and null for anything else. A null is what makes
    a row count toward the month but not toward any caller's hourly cap, which is
    the right answer for a call with no caller.
    """
    conf = _config()
    if not conf:
        return
    url, key = conf
    row = {"cents": round(cents, 4), "model": model}
    ip_hash = _caller.get()
    if ip_hash:
        row["ip_hash"] = ip_hash
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            client.post(
                f"{url}/rest/v1/{TABLE}",
                json=row,
                headers=_headers(key),
            )
    except Exception:
        log.exception("usage write failed")
