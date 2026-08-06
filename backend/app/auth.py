"""Who is calling.

Extraction is anonymous — it fetches a public URL and hands the result back, and
nothing it does costs anything that lasts. Image mirroring is different: it
writes bytes into our Storage bucket and keeps them. An endpoint that fetches an
arbitrary URL and stores the result is free hosting for anyone who finds it, so
this one asks for the caller's Supabase session first.

Verification is a round trip to GoTrue rather than local signature checking. The
JWT secret would have to be a fourth environment variable, Supabase rotated the
signing scheme to asymmetric keys for new projects, and a validated token that
belongs to a deleted user still validates. Asking the auth server costs ~100ms
on a request that is about to spend a second downloading a photo anyway.
"""

import logging
import os
import uuid

import httpx

log = logging.getLogger("recipe.auth")

TIMEOUT = 5.0


class AuthError(Exception):
    """No usable session on the request."""


def _config() -> tuple[str, str] | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    # The anon key is the right apikey for a user-scoped call. Service role is
    # accepted as a fallback so a deploy that only ever set that one still works,
    # but the user's own bearer token is what identifies them either way.
    key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    return (url, key) if url and key else None


def bearer_token(header: str | None) -> str:
    """Pull the token out of an Authorization header, or raise."""
    value = (header or "").strip()
    if not value.lower().startswith("bearer "):
        raise AuthError("missing bearer token")
    token = value[7:].strip()
    if not token:
        raise AuthError("empty bearer token")
    return token


def verify_token(token: str) -> str:
    """Return the caller's user id, or raise AuthError."""
    conf = _config()
    if not conf:
        raise AuthError("auth is not configured on this deployment")
    url, key = conf
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{url}/auth/v1/user",
                headers={"apikey": key, "Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        raise AuthError("could not reach the auth server") from exc

    if resp.status_code != 200:
        raise AuthError("session is not valid")

    user_id = (resp.json() or {}).get("id") or ""
    # A service-role key presented as a bearer token authenticates but has no
    # user behind it, and the id goes straight into a storage path, so insist on
    # the shape rather than trusting what came back.
    try:
        return str(uuid.UUID(user_id))
    except (ValueError, AttributeError, TypeError) as exc:
        raise AuthError("session has no user") from exc
