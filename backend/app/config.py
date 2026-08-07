import logging
import os

log = logging.getLogger("recipe.config")

# The local dev servers, and only on a laptop. These used to be unconditional,
# so every deployment shipped an allow-list that trusted localhost — harmless in
# practice, since nothing here reads a cookie, but an allow-list that contains
# entries nobody meant to allow is one that has stopped saying anything.
# VERCEL_ENV is set on every Vercel deployment and unset under a local uvicorn.
LOCAL_ORIGINS = ["http://localhost:5173", "http://localhost:4173"]

# Vercel gives every branch and every deployment its own hostname, so a preview
# origin cannot be named ahead of time and has to be matched by shape. Without
# this, no preview deployment can call the API at all: the browser's preflight is
# rejected and every import, paste and photo mirror fails as "Failed to fetch",
# which is what made the audit branch untestable in the first place.
#
# Scope-qualified on purpose. The trailing slug is the Vercel account, so a
# project with the same name deployed under someone else's account does not
# match. Worth being clear about what this is and isn't: CORS is a rule browsers
# apply to pages, never a server-side access control — curl has always ignored
# it — so widening it to our own previews costs approximately nothing. The real
# exposure on these endpoints is that two of them need no session at all, which
# is a separate problem and not one CORS was ever solving.
DEFAULT_PREVIEW_ORIGIN_REGEX = r"https://recipe-box(-api)?-[a-z0-9-]+-drandee\.vercel\.app"


def is_deployed() -> bool:
    """True on Vercel, false under a local uvicorn."""
    return bool(os.environ.get("VERCEL_ENV"))


def cors_origins() -> list[str]:
    raw = os.environ.get("RECIPE_CORS_ORIGINS", "")
    origins = [o.strip() for o in raw.split(",") if o.strip()]

    if not is_deployed():
        return LOCAL_ORIGINS + origins

    if not origins:
        # The production frontend reaches this API by being named in that
        # variable and nothing else, so an empty list on a deployment means the
        # app is live and refusing its own site. Say so once, loudly, rather
        # than leaving it to be diagnosed from a browser console.
        log.warning(
            "RECIPE_CORS_ORIGINS is empty on a deployment. No named origin is "
            "allowed, so only preview hosts matching the regex can call this API."
        )
    return origins


def cors_origin_regex() -> str:
    return os.environ.get("RECIPE_CORS_ORIGIN_REGEX") or DEFAULT_PREVIEW_ORIGIN_REGEX
