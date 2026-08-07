import logging

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .ai import AIBudgetError, AIError, ai_available, structure_recipe
from .config import cors_origin_regex, cors_origins
from .extract import ExtractError, extract_recipe

# auth.py and images.py are imported inside the handlers that use them, not here.
# images.py pulls in Pillow, and a dependency that is missing in production takes
# down every route in this file when it is imported at module scope — extraction
# and paste both died over a photo resizer once. The rest of the app already
# works this way: ai.py imports anthropic inside the call and extract.py imports
# ai and social inside theirs.

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("recipe.api")

app = FastAPI(title="Recipe Box API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    # Named origins for production and local dev; the regex is what lets a Vercel
    # preview, whose hostname changes with every branch, reach this API at all.
    allow_origins=cors_origins(),
    allow_origin_regex=cors_origin_regex(),
    # Nothing here reads a cookie. Auth is a bearer token on one endpoint, which
    # is an ordinary header and not a credential in the CORS sense, so switching
    # this off removes a permission the app never used.
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


class ExtractRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2000)


class StructureRequest(BaseModel):
    text: str = Field(min_length=20, max_length=12000)


class ImageRequest(BaseModel):
    # Canonical UUID text, which is what both the DB and the storage path want.
    recipe_id: str = Field(min_length=36, max_length=36)
    url: str = Field(min_length=10, max_length=2000)


@app.get("/api/health")
def health():
    """Also the deploy check.

    `images` reports whether the mirroring code can be imported at all, which is
    otherwise invisible from outside: mirroring fails silently by design, so a
    dependency missing from the bundle looks exactly like a photo that wouldn't
    download. `storage` is the two env vars the uploads need.

    `budget` is here for exactly the same reason, and it was added the hard way.
    The spend lookup also fails open, so when a query change made Supabase reject
    it the only symptom was that the monthly ceiling stopped being enforced —
    invisible from outside, and found only by reading function logs within the
    hour they are retained. `tracked: false` now says it out loud.
    """
    try:
        from .images import storage_configured

        images, storage = True, storage_configured()
    except ImportError:
        log.exception("image pipeline is not importable")
        images, storage = False, False

    from .ai import MONTHLY_BUDGET_CENTS
    from .usage import RATE_LIMIT_CALLS, RATE_WINDOW_MINUTES, month_spend_cents, rate_tracked

    spent = month_spend_cents()
    return {
        "status": "ok",
        "ai": ai_available(),
        "storage": storage,
        "images": images,
        "budget": {
            # False means the ceiling is not being applied, whatever the reason:
            # Supabase unconfigured, unreachable, or refusing the query.
            "tracked": spent is not None,
            "spent_cents": None if spent is None else round(spent, 2),
            "limit_cents": MONTHLY_BUDGET_CENTS,
        },
        "rate": {
            # Same contract, same reason. The likeliest cause of false here is a
            # missing `ip_hash` column, i.e. the schema re-run hasn't happened,
            # and without this line that looks exactly like a healthy deployment.
            "tracked": rate_tracked(),
            "limit": RATE_LIMIT_CALLS,
            "window_minutes": RATE_WINDOW_MINUTES,
        },
    }


def meter_caller(request: Request) -> None:
    """Gate on the per-caller cap, and tag whatever this request spends.

    Both AI endpoints are anonymous on purpose: extraction fetches a public URL
    and keeps nothing, and paste has to work before anyone signs in because the
    iOS capture path lands in Safari, where the app may well be signed out. What
    anonymity does not cover is spend, and the monthly ceiling is shared — one
    caller in a loop empties it for everyone, and books a Vercel invocation each
    time. So the cap is per caller instead of per account.

    A shared secret is not an option here and it is worth writing down why: the
    only caller is a public SPA, so any secret it presented would ship in the
    bundle every visitor downloads.
    """
    from .usage import caller_hash, client_ip, over_rate_limit, set_caller

    ip_hash = caller_hash(client_ip(request.headers))
    set_caller(ip_hash)
    if over_rate_limit(ip_hash):
        log.info("rate limit reached for %s", ip_hash[:8])
        raise HTTPException(
            status_code=429,
            detail="Too many imports from this connection. Try again in a little while.",
            headers={"Retry-After": "900"},
        )


@app.post("/api/recipes/extract")
def extract(body: ExtractRequest, request: Request):
    meter_caller(request)
    try:
        return extract_recipe(body.url)
    except AIBudgetError:
        raise HTTPException(status_code=429, detail="AI budget for this month is used up")
    except ExtractError as exc:
        log.info("extract failed for %s: %s", body.url, exc)
        raise HTTPException(status_code=422, detail="Could not find a recipe at that URL")
    except Exception:
        log.exception("unexpected extract failure for %s", body.url)
        raise HTTPException(status_code=502, detail="Could not fetch that page")


@app.post("/api/recipes/structure")
def structure(body: StructureRequest, request: Request):
    """Paste-anything box: raw text in, recipe out."""
    meter_caller(request)
    try:
        result = structure_recipe(body.text, context="This text was pasted by the user.")
    except AIBudgetError:
        raise HTTPException(status_code=429, detail="AI budget for this month is used up")
    except AIError as exc:
        log.info("structure failed: %s", exc)
        raise HTTPException(status_code=422, detail="Could not read a recipe from that text")
    except Exception:
        log.exception("unexpected structure failure")
        raise HTTPException(status_code=502, detail="Could not process that text")

    if not result.get("has_recipe") or not result.get("ingredients"):
        raise HTTPException(status_code=422, detail="That text doesn't look like a recipe")

    from .social import to_recipe

    return to_recipe(result, "", "manual", {})


@app.post("/api/recipes/image")
def recipe_image(body: ImageRequest, authorization: str | None = Header(default=None)):
    """Mirror a recipe photo into our own bucket. Signed in only.

    Unlike the two endpoints above this one keeps what it fetches, so it asks who
    is calling: the objects land under the caller's own user id, which is what
    makes deleting a recipe's images a single client-side call, and what stops
    the endpoint being free storage for anyone who finds the API.

    Best effort by contract. The client keeps the origin URL when this fails and
    tries again on a later load, so the failure modes here — an expired URL, a
    hotlink block, something that isn't an image — are all a 422 and nothing more.
    """
    try:
        from .auth import AuthError, bearer_token, verify_token
        from .images import ImageError, mirror_image, recipe_is_owned
    except ImportError:
        # Only this endpoint is lost, and /api/health says so.
        log.exception("image mirroring is unavailable: a dependency is missing")
        raise HTTPException(status_code=503, detail="Photo storage is unavailable")

    try:
        user_id = verify_token(bearer_token(authorization))
    except AuthError as exc:
        log.info("image mirror rejected: %s", exc)
        raise HTTPException(status_code=401, detail="Sign in to save recipe photos")

    # Who is calling was never the gap; what they are touching was. Kept outside
    # the block below because that one ends in `except Exception`, which would
    # turn the 422 this raises into a 502.
    try:
        owned = recipe_is_owned(user_id, body.recipe_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a valid recipe id")
    except ImageError:
        log.exception("could not check recipe ownership")
        raise HTTPException(status_code=503, detail="Photo storage is unavailable")
    if not owned:
        log.info("image mirror rejected: %s is not a recipe of the caller's", body.recipe_id)
        raise HTTPException(status_code=422, detail="No recipe to attach that photo to")

    try:
        return mirror_image(user_id, body.recipe_id, body.url)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a valid recipe id")
    except ImageError as exc:
        log.info("image mirror failed for %s: %s", body.url, exc)
        raise HTTPException(status_code=422, detail="Could not save that image")
    except Exception:
        log.exception("unexpected image mirror failure for %s", body.url)
        raise HTTPException(status_code=502, detail="Could not save that image")
