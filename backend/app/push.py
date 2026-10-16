"""Lock-screen timer alerts: the server half of A2.

A web page cannot ring a locked phone, because nothing in a browser can hold a
timer once the page is suspended. So when a timer starts in the installed app
the client writes a `cook_timers` row, and a Supabase cron job asks this module
every few seconds whether anything is due (`POST /api/push/fire`). Anything due
is sent to the user's push subscriptions as a Declarative Web Push, which iOS
18.4+ shows itself without waking the page.

Three properties matter more than the rest:

* **Claim before send.** A due row is claimed with one conditional update
  (`sent_at is null`), and only the caller that got the row back sends. Two
  overlapping cron runs cannot both send the same alert.
* **Late is dropped, not replayed.** A row more than `STALE_SECONDS` past due is
  claimed and not sent: a timer alert ten minutes late is noise, and it bounds
  how long a broken send can keep retrying.
* **The endpoint is the only thing that can send.** It answers 401 to anything
  without the shared secret, and the secret never reaches the browser.

Everything reaches Supabase over httpx with the service role, like usage.py.
`pywebpush` is imported inside `_send` so a deployment missing it loses this one
endpoint rather than the whole API (the Phase 7 lesson in CLAUDE.md).
"""

import datetime as dt
import hmac
import json
import logging
import os

import httpx

from . import supabase

log = logging.getLogger("recipe.push")

TIMEOUT = 5.0
BATCH = 50
STALE_SECONDS = 600
# How long the push service may hold the message if the phone is unreachable. A
# timer alert after this is worthless, so it is short.
TTL_SECONDS = 300


def secret_configured() -> bool:
    return bool(os.environ.get("PUSH_FIRE_SECRET"))


def vapid_configured() -> bool:
    return bool(os.environ.get("VAPID_PRIVATE_KEY") and os.environ.get("VAPID_SUBJECT"))


def configured() -> bool:
    """Whether a due timer could actually be sent. `/api/health` reports this: a
    missing key otherwise looks exactly like a healthy deployment, because the
    only symptom is an alert that never arrives."""
    return supabase.configured() and secret_configured() and vapid_configured()


def authorized(presented: str | None) -> bool:
    expected = os.environ.get("PUSH_FIRE_SECRET", "")
    # Both sides encoded: compare_digest raises on non-ASCII str.
    return bool(expected and presented) and hmac.compare_digest(
        presented.encode(), expected.encode()
    )


def _iso(when: dt.datetime) -> str:
    return when.astimezone(dt.timezone.utc).isoformat()


def _rest(path: str) -> tuple[str, dict] | None:
    cfg = supabase.service_config()
    if cfg is None:
        return None
    url, key = cfg
    return f"{url}/rest/v1/{path}", supabase.headers(key)


def _due_rows(now: dt.datetime) -> list[dict]:
    target = _rest(
        "cook_timers?sent_at=is.null"
        f"&ends_at=lte.{_iso(now)}"
        "&select=id,user_id,client_id,label,recipe_title,open_url,ends_at"
        f"&order=ends_at.asc&limit={BATCH}"
    )
    if target is None:
        return []
    resp = httpx.get(target[0], headers=target[1], timeout=TIMEOUT)
    resp.raise_for_status()
    rows = resp.json()
    return rows if isinstance(rows, list) else []


def _claim(row_id: str, now: dt.datetime) -> bool:
    """True only for the caller that flipped `sent_at` from null."""
    target = _rest(f"cook_timers?id=eq.{row_id}&sent_at=is.null")
    if target is None:
        return False
    headers = {**target[1], "Prefer": "return=representation"}
    resp = httpx.patch(target[0], headers=headers, json={"sent_at": _iso(now)}, timeout=TIMEOUT)
    resp.raise_for_status()
    body = resp.json()
    return isinstance(body, list) and len(body) == 1


def _release(row_id: str) -> None:
    """Give a row back so the next run retries it (every send failed)."""
    target = _rest(f"cook_timers?id=eq.{row_id}")
    if target is not None:
        httpx.patch(target[0], headers=target[1], json={"sent_at": None}, timeout=TIMEOUT)


def _subscriptions(user_id: str) -> list[dict]:
    target = _rest(f"push_subscriptions?user_id=eq.{user_id}&select=id,endpoint,p256dh,auth")
    if target is None:
        return []
    resp = httpx.get(target[0], headers=target[1], timeout=TIMEOUT)
    resp.raise_for_status()
    rows = resp.json()
    return rows if isinstance(rows, list) else []


def _drop_subscription(sub_id: str) -> None:
    target = _rest(f"push_subscriptions?id=eq.{sub_id}")
    if target is not None:
        httpx.delete(target[0], headers=target[1], timeout=TIMEOUT)


class Gone(Exception):
    """The push service says this subscription no longer exists (404/410)."""


def _send(sub: dict, payload: str) -> None:
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            },
            data=payload,
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": os.environ["VAPID_SUBJECT"]},
            ttl=TTL_SECONDS,
            headers={"Urgency": "high"},
        )
    except WebPushException as exc:
        status = getattr(exc.response, "status_code", None)
        if status in (404, 410):
            raise Gone from exc
        raise


def payload_for(row: dict) -> str:
    """A Declarative Web Push message (iOS 18.4+): the payload *is* the
    notification, so WebKit shows it without running any page or worker code and
    cannot revoke the subscription for a missed display."""
    label = (row.get("label") or "Timer").strip()
    recipe = (row.get("recipe_title") or "").strip()
    notification = {
        "title": "Time's up",
        "body": f"{label} · {recipe}" if recipe else label,
        "silent": False,
    }
    url = row.get("open_url") or ""
    # Only a plain https link back into the app. The column is user-written, and
    # while it can only ever reach that user's own phone, a payload should not be
    # a place to put javascript: or data: URLs either.
    if url.startswith("https://") and len(url) <= 500:
        notification["navigate"] = url
    if row.get("client_id"):
        notification["tag"] = str(row["client_id"])[:80]
    return json.dumps({"web_push": 8030, "notification": notification})


def fire_due(now: dt.datetime | None = None) -> dict:
    """Send every due alert once. Returns counts, which is also the log line."""
    now = now or dt.datetime.now(dt.timezone.utc)
    out = {"due": 0, "sent": 0, "stale": 0, "no_subscription": 0, "failed": 0}
    for row in _due_rows(now):
        out["due"] += 1
        if not _claim(row["id"], now):
            continue  # another run has it
        due_at = dt.datetime.fromisoformat(row["ends_at"].replace("Z", "+00:00"))
        if (now - due_at).total_seconds() > STALE_SECONDS:
            out["stale"] += 1
            continue
        subs = _subscriptions(row["user_id"])
        if not subs:
            out["no_subscription"] += 1
            continue
        payload = payload_for(row)
        delivered = 0
        for sub in subs:
            try:
                _send(sub, payload)
                delivered += 1
            except Gone:
                _drop_subscription(sub["id"])
            except Exception:  # noqa: BLE001 - one bad endpoint must not stop the rest
                log.exception("push send failed")
        if delivered:
            out["sent"] += 1
        else:
            out["failed"] += 1
            _release(row["id"])
    return out
