"""Lock-screen timer alerts: the server half of A2.

A web page cannot ring a locked phone, because nothing in a browser can hold a
timer once the page is suspended. So when a timer starts in the installed app
the client writes a `cook_timers` row, and a Supabase cron job asks this module
every few seconds whether anything is due (`POST /api/push/fire`). Anything due
is sent to the user's push subscriptions as a Declarative Web Push, which iOS
18.4+ shows itself without waking the page.

Three properties matter more than the rest:

* **Claim before send.** A due row is claimed with one conditional update (its
  `notify_count` must still be what the caller read), and only the caller that got
  the row back sends. Two overlapping cron runs cannot both send the same alert.
* **Repeats until answered.** A banner is easy to miss and a push cannot ring on
  its own, so a finished timer is sent again every thirty seconds, up to six
  times, until the app deletes the row (opening it or dismissing the timer).
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
from urllib.parse import urlsplit

import httpx

from . import supabase

log = logging.getLogger("recipe.push")

TIMEOUT = 5.0
BATCH = 50
STALE_SECONDS = 600
# A banner is easy to miss, and a web push cannot ring until it is answered, so a
# finished timer is sent again every REPEAT_SECONDS until the app acknowledges it
# (opening the app or dismissing the timer deletes the row) or it has been sent
# MAX_NOTIFICATIONS times in all. Six at thirty seconds is about two and a half
# minutes of nagging, not an alarm that runs all night on an empty kitchen.
# supabase/push-cron.sql repeats both numbers.
REPEAT_SECONDS = 30
MAX_NOTIFICATIONS = 6
# A row whose sends all failed is given back for the next tick only while it is
# this fresh. A failing row would otherwise be retried every ten seconds for the
# whole stale window and hold a place in every batch behind it.
RETRY_WINDOW_SECONDS = 60
# Nobody has more than a few phones, and anything beyond this is a table someone
# filled to make the loop slow. Rows left over wait for the next tick.
MAX_ROWS_PER_USER = 5
MAX_SUBS_PER_ROW = 5
# How long the push service may hold the message if the phone is unreachable. A
# timer alert after this is worthless, so it is short.
TTL_SECONDS = 300

# Where a push may be sent. The endpoint is a URL the *client* wrote, and sign-in
# is open to anyone, so without this the API would POST a signed request to any
# address a user chose, internal ones included. These are the push services the
# browsers actually use; Apple's is the one this app is for.
_PUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
_PUSH_SUFFIXES = (".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com")


def allowed_endpoint(endpoint: str) -> bool:
    try:
        u = urlsplit(endpoint)
        host = (u.hostname or "").lower()
        port = u.port
    except ValueError:
        return False
    return (
        u.scheme == "https"
        and u.username is None
        and port in (None, 443)
        and (host in _PUSH_HOSTS or host.endswith(_PUSH_SUFFIXES))
    )


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


def _due_params(now: dt.datetime) -> dict:
    # Passed as `params=`, never spliced into the URL: an ISO timestamp ends in
    # "+00:00", and a raw "+" in a query string is read as a space by PostgREST,
    # which then rejects the timestamp. The query failed on every tick and no
    # alert could ever fire. usage.py gets this right the same way.
    #
    # Due means finished and either never sent, or sent at least REPEAT_SECONDS ago
    # and not yet sent MAX_NOTIFICATIONS times. supabase/push-cron.sql asks the same
    # question to decide whether to call at all, so the two must be kept in step.
    again = _iso(now - dt.timedelta(seconds=REPEAT_SECONDS))
    return {
        "ends_at": f"lte.{_iso(now)}",
        "notify_count": f"lt.{MAX_NOTIFICATIONS}",
        "or": f"(sent_at.is.null,sent_at.lte.{again})",
        "select": "id,user_id,client_id,label,recipe_title,open_url,ends_at,sent_at,notify_count",
        "order": "ends_at.asc",
        "limit": str(BATCH),
    }


def _due_rows(now: dt.datetime) -> list[dict]:
    target = _rest("cook_timers")
    if target is None:
        return []
    resp = httpx.get(target[0], headers=target[1], params=_due_params(now), timeout=TIMEOUT)
    resp.raise_for_status()
    rows = resp.json()
    return rows if isinstance(rows, list) else []


def _claim(row: dict, now: dt.datetime) -> bool:
    """True only for the caller that moves `notify_count` on from the value it read.

    One conditional update, so two overlapping runs cannot both send the same
    alert: the loser's filter no longer matches and it gets no row back.
    """
    count = int(row.get("notify_count") or 0)
    target = _rest(f"cook_timers?id=eq.{row['id']}&notify_count=eq.{count}")
    if target is None:
        return False
    headers = {**target[1], "Prefer": "return=representation"}
    resp = httpx.patch(
        target[0],
        headers=headers,
        json={"sent_at": _iso(now), "notify_count": count + 1},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    return isinstance(body, list) and len(body) == 1


def _release(row: dict) -> None:
    """Give a row back, as it was before the claim, so the next run retries it."""
    target = _rest(f"cook_timers?id=eq.{row['id']}")
    if target is not None:
        httpx.patch(
            target[0],
            headers=target[1],
            json={"sent_at": row.get("sent_at"), "notify_count": int(row.get("notify_count") or 0)},
            timeout=TIMEOUT,
        )


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
    # Checked here, at the one place a request leaves, as well as being the natural
    # thing for a table constraint to say: an address that is not a push service is
    # treated as a dead subscription and removed, and nothing is sent to it.
    if not allowed_endpoint(sub["endpoint"]):
        raise Gone

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
    count = int(row.get("notify_count") or 0)
    body = f"{label} · {recipe}" if recipe else label
    notification = {
        "title": "Time's up",
        # A repeat says so, so a stack of banners reads as one alarm still going
        # and not as several different timers.
        "body": f"Still ringing: {body}" if count else body,
        "silent": False,
    }
    if row.get("client_id"):
        # The first send keeps the bare id (the worker and the declarative path
        # then agree and a browser that does both shows one). Each repeat gets its
        # own tag so it is a new banner that makes the sound again, rather than a
        # silent replacement of the last one.
        tag = str(row["client_id"])
        notification["tag"] = (f"{tag}:{count}" if count else tag)[:80]
    url = row.get("open_url") or ""
    # Only a plain https link back into the app. The column is user-written, and
    # while it can only ever reach that user's own phone, a payload should not be
    # a place to put javascript: or data: URLs either.
    if url.startswith("https://") and len(url) <= 500:
        # `navigate` is what makes a payload declarative at all, so it is only
        # claimed with one.
        notification["navigate"] = url
        return json.dumps({"web_push": 8030, "notification": notification})
    # No usable link: send it as a plain notification for the worker to show
    # (public/push-sw.js) rather than as a declarative one iOS may discard.
    return json.dumps({"notification": notification})


def fire_due(now: dt.datetime | None = None) -> dict:
    """Send every due alert once. Returns counts, which is also the log line."""
    now = now or dt.datetime.now(dt.timezone.utc)
    out = {"due": 0, "sent": 0, "stale": 0, "no_subscription": 0, "failed": 0, "deferred": 0}
    per_user: dict[str, int] = {}
    for row in _due_rows(now):
        out["due"] += 1
        # One user cannot fill a batch: the rest of their rows wait for the next
        # tick, unclaimed, and everyone else's go first.
        per_user[row["user_id"]] = per_user.get(row["user_id"], 0) + 1
        if per_user[row["user_id"]] > MAX_ROWS_PER_USER:
            out["deferred"] += 1
            continue
        if not _claim(row, now):
            continue  # another run has it
        first = int(row.get("notify_count") or 0) == 0
        due_at = dt.datetime.fromisoformat(row["ends_at"].replace("Z", "+00:00"))
        age = (now - due_at).total_seconds()
        # Only a first send can be too late to be worth sending: a repeat is, by
        # construction, minutes after the due time and is exactly what is wanted.
        if first and age > STALE_SECONDS:
            out["stale"] += 1
            continue
        # Anything that goes wrong after the claim must hand the row back, or it
        # is claimed, unsent and forgotten, and the rest of the batch with it.
        try:
            delivered = _deliver(row, out)
        except Exception:  # noqa: BLE001
            log.exception("push fire failed for a row")
            delivered = None
        if delivered is False or delivered is None:
            if delivered is False:
                out["failed"] += 1
            # Only a first send is handed back. A repeat that failed simply
            # waits for its next turn, since the count moves on either way.
            if first and age <= RETRY_WINDOW_SECONDS:
                _release(row)
    return out


def _deliver(row: dict, out: dict) -> bool | None:
    """True when at least one send landed, False when every send failed, None when
    there was nothing to send to (no retry will change that)."""
    subs = _subscriptions(row["user_id"])[:MAX_SUBS_PER_ROW]
    if not subs:
        out["no_subscription"] += 1
        return True
    payload = payload_for(row)
    delivered = 0
    for sub in subs:
        try:
            _send(sub, payload)
            delivered += 1
        except Gone:
            # Housekeeping only. If the cleanup itself fails it must not turn a
            # row that another subscription already delivered into a retry.
            try:
                _drop_subscription(sub["id"])
            except Exception:  # noqa: BLE001
                log.exception("could not remove a dead subscription")
        except Exception:  # noqa: BLE001 - one bad endpoint must not stop the rest
            log.exception("push send failed")
    if delivered:
        out["sent"] += 1
    return delivered > 0
