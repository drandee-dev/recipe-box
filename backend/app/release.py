"""The release announcement: one push per release, to people who opted in.

A Supabase cron job calls `POST /api/push/announce` every ten minutes. Almost
every call does nothing. It sends exactly once, when the version in this file is
the one the live frontend is serving, and never again for that version.

* **Claim before send.** The version is inserted into `release_announcements`
  (primary key) before anything is sent. A conflict means someone already sent,
  so two overlapping calls cannot both announce. The cost is that a crash after
  the claim loses that release's announcement rather than repeating it.
* **Only once the tap would open the new build.** The API and the frontend deploy
  separately, so the live frontend's `version.json` (emitted at build) is compared
  with `RELEASE_VERSION` first. Not equal yet means wait for the next call.
* **Opt-in, per origin.** Only subscriptions with `announce = true` and the
  production `origin` are sent to. Staging shares the database and must not get
  production's announcement.

`RELEASE_VERSION` and the text are the only things a release changes here;
`tests/test_release.py` fails if `RELEASE_VERSION` differs from `APP_VERSION` in
`frontend/src/lib/news.js`. Everything else goes through push.py.
"""

import json
import logging
import os

import httpx

from . import push

log = logging.getLogger("recipe.release")

RELEASE_VERSION = "1.1.0"
TITLE = "Recipe Box 1.1.0 is ready"
BODY = "Open Recipe Box to update. Timers that ring on a locked phone, notes, dark mode and more."

TIMEOUT = 5.0
# ponytail: one page of subscribers. A few phones each is the scale; past this
# many opted-in subscriptions the rest silently miss it, so page the query.
MAX_SUBSCRIBERS = 1000


def app_origin() -> str:
    """The production frontend's origin, from RELEASE_APP_ORIGIN (a plain config
    value, not a secret). Empty when unset or not https, which turns the whole
    announcement off rather than guessing a URL to send people to."""
    origin = (os.environ.get("RELEASE_APP_ORIGIN") or "").strip().rstrip("/")
    return origin if origin.startswith("https://") else ""


def live_version(origin: str) -> str | None:
    """What the live frontend says it is, or None for any failure (a deploy in
    progress, a 404 before the first build that emits it, a timeout)."""
    try:
        resp = httpx.get(f"{origin}/version.json", timeout=TIMEOUT, follow_redirects=False)
        resp.raise_for_status()
        version = resp.json().get("version")
        return version if isinstance(version, str) else None
    except Exception:  # noqa: BLE001
        return None


def _already_claimed(version: str) -> bool:
    target = push._rest("release_announcements")
    if target is None:
        return True  # cannot tell, so do not send
    resp = httpx.get(
        target[0],
        headers=target[1],
        params={"version": f"eq.{version}", "select": "version"},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return bool(resp.json())


def _claim(version: str) -> bool:
    """True only for the caller whose insert created the row (409 means taken)."""
    target = push._rest("release_announcements")
    if target is None:
        return False
    resp = httpx.post(
        target[0],
        headers={**target[1], "Prefer": "return=minimal"},
        json={"version": version},
        timeout=TIMEOUT,
    )
    if resp.status_code == 409:
        return False
    resp.raise_for_status()
    return True


def _subscribers(origin: str) -> list[dict]:
    target = push._rest("push_subscriptions")
    if target is None:
        return []
    # params=, never spliced: the origin holds ":" and "/", and see push._due_params
    # for what a raw "+" did to a hand-built query.
    resp = httpx.get(
        target[0],
        headers=target[1],
        params={
            "announce": "eq.true",
            "origin": f"eq.{origin}",
            "select": "id,endpoint,p256dh,auth",
            "limit": str(MAX_SUBSCRIBERS),
        },
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows if isinstance(rows, list) else []


def _record_sent(version: str, sent: int) -> None:
    target = push._rest(f"release_announcements?version=eq.{version}")
    if target is not None:
        httpx.patch(target[0], headers=target[1], json={"sent": sent}, timeout=TIMEOUT)


def payload_for(origin: str) -> str:
    """A Declarative Web Push (the shape push.payload_for sends): the payload is
    the notification, and `navigate` opens the app."""
    return json.dumps(
        {
            "web_push": 8030,
            "notification": {
                "title": TITLE,
                "body": BODY,
                "silent": False,
                "navigate": f"{origin}/",
            },
        }
    )


def announce() -> dict:
    origin = app_origin()
    # Checked before the claim: claiming and then being unable to send would burn
    # the release's one announcement.
    if not origin or not push.configured():
        return {"status": "not_configured"}
    if _already_claimed(RELEASE_VERSION):
        return {"status": "already_sent"}
    live = live_version(origin)
    if live != RELEASE_VERSION:
        return {"status": "waiting", "live": live}
    if not _claim(RELEASE_VERSION):
        return {"status": "already_sent"}

    payload = payload_for(origin)
    out = {"status": "sent", "sent": 0, "dropped": 0, "failed": 0}
    for sub in _subscribers(origin):
        try:
            push._send(sub, payload)
            out["sent"] += 1
        except push.Gone:
            out["dropped"] += 1
            try:
                push._drop_subscription(sub["id"])
            except Exception:  # noqa: BLE001
                log.exception("could not remove a dead subscription")
        except Exception:  # noqa: BLE001 - one bad endpoint must not stop the rest
            out["failed"] += 1
            log.exception("announcement send failed")
    try:
        _record_sent(RELEASE_VERSION, out["sent"])
    except Exception:  # noqa: BLE001
        log.exception("could not record the announcement count")
    return out
