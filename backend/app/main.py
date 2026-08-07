import logging

from fastapi import FastAPI, Header, HTTPException
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
    from .usage import month_spend_cents

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
    }


@app.post("/api/recipes/extract")
def extract(body: ExtractRequest):
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
def structure(body: StructureRequest):
    """Paste-anything box: raw text in, recipe out."""
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
        from .images import ImageError, mirror_image
    except ImportError:
        # Only this endpoint is lost, and /api/health says so.
        log.exception("image mirroring is unavailable: a dependency is missing")
        raise HTTPException(status_code=503, detail="Photo storage is unavailable")

    try:
        user_id = verify_token(bearer_token(authorization))
    except AuthError as exc:
        log.info("image mirror rejected: %s", exc)
        raise HTTPException(status_code=401, detail="Sign in to save recipe photos")

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
