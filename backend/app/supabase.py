"""Where the Supabase project is and how to authenticate to it.

Three modules were each reading the same two environment variables and building
the same header dict by hand: `usage.py` for the budget and rate-limit rows,
`images.py` for storage uploads, and `auth.py` for verifying a caller's token.
Nothing was wrong with any of the copies — the cost was that the shape of a
Supabase call lived in three places, so a fourth caller had a coin flip's chance
of getting the headers right.

**The two keys are not interchangeable and this module keeps them apart.**
`service_config()` is the service role: it bypasses RLS and is what writes usage
rows and uploads objects on the user's behalf. `anon_config()` is the anon key,
which is the correct `apikey` for a call that is *scoped to a user* — there the
caller's own bearer token is what identifies them, and the apikey only says which
project is being addressed. Sending the service role where the anon key belongs
would work and would quietly hand a user-scoped endpoint far more authority than
it needs, which is exactly the mistake a shared helper should make hard.
"""

import os


def _read(key_var: str, *fallback_vars: str) -> tuple[str, str] | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get(key_var, "")
    for var in fallback_vars:
        if key:
            break
        key = os.environ.get(var, "")
    return (url, key) if url and key else None


def service_config() -> tuple[str, str] | None:
    """`(url, service_role_key)`, or None when the deployment has no Supabase."""
    return _read("SUPABASE_SERVICE_ROLE_KEY")


def anon_config() -> tuple[str, str] | None:
    """`(url, anon_key)` for user-scoped calls.

    Falls back to the service role so a deployment that only ever set that one
    keeps working; the user's bearer token is what identifies them either way.
    """
    return _read("SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")


def configured() -> bool:
    """Whether service-role calls (usage rows, storage) can be made at all."""
    return service_config() is not None


def headers(key: str, *, json: bool = True) -> dict:
    """The apikey/Authorization pair every PostgREST and Storage call needs.

    `json=False` for a storage upload, which sets its own Content-Type from the
    object being written.
    """
    out = {"apikey": key, "Authorization": f"Bearer {key}"}
    if json:
        out["Content-Type"] = "application/json"
    return out


def user_headers(key: str, token: str) -> dict:
    """Project apikey, but the *caller's* token as the bearer.

    This is the shape that makes a request run as the user rather than as the
    service, which is what `auth.py` needs to ask Supabase who someone is.
    """
    return {"apikey": key, "Authorization": f"Bearer {token}"}
