import base64
import binascii
import logging
from contextlib import contextmanager

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


class StructureImageRequest(BaseModel):
    # Base64 JPEG/PNG/HEIC bytes, no data-URL prefix — the client strips it.
    # The ceiling is well under Vercel's 4.5 MB request body limit, and the
    # client already downscales before it gets here; anything approaching this
    # is a full-resolution phone photo that skipped that step.
    image: str = Field(min_length=100, max_length=4_000_000)


class ImageRequest(BaseModel):
    # Canonical UUID text, which is what both the DB and the storage path want.
    recipe_id: str = Field(min_length=36, max_length=36)
    url: str = Field(min_length=10, max_length=2000)


class UploadImageRequest(BaseModel):
    recipe_id: str = Field(min_length=36, max_length=36)
    # Bare base64 of a JPEG the client already shrank (lib/photo.js). Same ceiling
    # as StructureImageRequest, for the same reason: under Vercel's 4.5 MB body.
    image: str = Field(min_length=100, max_length=4_000_000)


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

    from . import push

    spent = month_spend_cents()
    return {
        "status": "ok",
        "ai": ai_available(),
        "storage": storage,
        "images": images,
        # Whether a due timer could be sent as a push. False means timer alerts
        # on a locked phone silently never arrive: the only symptom is silence.
        "push": push.configured(),
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


# The three routes below all call the model, and all three answered a failure the
# same way: 429 for the month's budget, 422 for "it ran but there was no recipe
# in that", 502 for anything unforeseen. Written out three times the wording was
# free to drift, and the `except Exception` at the end of each is the one that
# must never be forgotten — without it a stray error reaches the client as a
# traceback. `noun` is the only thing that actually differed.
@contextmanager
def ai_failures(
    noun: str,
    *,
    unreadable: type[Exception] = AIError,
    no_recipe: str,
    broke: str,
    subject: str = "",
):
    """Turn a model call's failures into the HTTP answers the client expects.

    `unreadable` is the exception meaning "we got there and there was no recipe":
    AIError for the two paste routes, ExtractError for the URL route, which can
    also fail because the page itself was unreachable.

    The two messages are passed in rather than built from `noun` because they are
    user-facing copy and the URL route's are not the same sentence with a word
    swapped — it says it could not *find* a recipe, and could not *fetch* the
    page. Deriving them would have quietly reworded a live error message.
    """
    where = f" for {subject}" if subject else ""
    try:
        yield
    except AIBudgetError:
        raise HTTPException(status_code=429, detail="AI budget for this month is used up")
    except unreadable as exc:
        log.info("%s failed%s: %s", noun, where, exc)
        raise HTTPException(status_code=422, detail=no_recipe)
    except Exception:
        log.exception("unexpected %s failure%s", noun, where)
        raise HTTPException(status_code=502, detail=broke)


def require_recipe(result: dict, noun: str) -> dict:
    """The model ran and answered; this is whether it found anything.

    Not an error in the model's sense, which is why it sits outside ai_failures:
    a photo of a plate is a perfectly successful call that read no recipe.
    """
    if not result.get("has_recipe") or not result.get("ingredients"):
        raise HTTPException(status_code=422, detail=f"That {noun} doesn't look like a recipe")
    from .social import to_recipe

    return to_recipe(result, "", "manual", {})


@app.post("/api/recipes/extract")
def extract(body: ExtractRequest, request: Request):
    meter_caller(request)
    with ai_failures(
        "extract",
        unreadable=ExtractError,
        no_recipe="Could not find a recipe at that URL",
        broke="Could not fetch that page",
        subject=body.url,
    ):
        return extract_recipe(body.url)


@app.post("/api/recipes/structure")
def structure(body: StructureRequest, request: Request):
    """Paste-anything box: raw text in, recipe out."""
    meter_caller(request)
    with ai_failures(
        "structure",
        no_recipe="Could not read a recipe from that text",
        broke="Could not process that text",
    ):
        result = structure_recipe(body.text, context="This text was pasted by the user.")
    return require_recipe(result, "text")


@app.post("/api/recipes/structure-image")
def structure_image(body: StructureImageRequest, request: Request):
    """Photograph-anything box: a picture of a recipe in, recipe out.

    Anonymous and metered like the two above, and for the same reason: it keeps
    nothing. The bytes are decoded, shrunk to what the model will read, sent, and
    dropped — this is not the endpoint that saves a photo, which is the one below
    and is the only one that asks who is calling.

    The vision plumbing itself already existed for phase 8, where a post's own
    picture is read when its caption yields nothing. This is the same call with a
    photo the user took instead of one we fetched.
    """
    meter_caller(request)

    try:
        from .images import ImageError, image_for_vision
    except ImportError:
        log.exception("the image pipeline is not importable")
        raise HTTPException(status_code=503, detail="Reading photos is unavailable")

    try:
        raw = base64.b64decode(body.image, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="That photo could not be read")

    try:
        image_b64, media_type = image_for_vision(raw)
    except ImageError as exc:
        log.info("photo could not be prepared: %s", exc)
        raise HTTPException(status_code=422, detail="That photo could not be read")

    with ai_failures(
        "structure-image",
        no_recipe="Could not read a recipe from that photo",
        broke="Could not process that photo",
    ):
        from .ai import structure_recipe_image

        result = structure_recipe_image(
            image_b64,
            media_type,
            context="This photograph was taken by the user. Read the recipe written in it.",
        )
    return require_recipe(result, "photo")


def _photo_caller(authorization: str | None, recipe_id: str) -> str:
    """The two gates in front of anything that keeps a photo: who is calling, and
    whether the recipe they name is theirs. Returns the verified user id.

    Shared by the URL route and the upload route, so they cannot drift apart.
    Raises HTTPException itself; it lives outside each handler's main try block
    because that block ends in `except Exception`, which would turn a 422 raised
    inside it into a 502.
    """
    try:
        from .auth import AuthError, bearer_token, verify_token
        from .images import ImageError, recipe_is_owned
    except ImportError:
        # Only the photo routes are lost, and /api/health says so.
        log.exception("image storage is unavailable: a dependency is missing")
        raise HTTPException(status_code=503, detail="Photo storage is unavailable")

    try:
        user_id = verify_token(bearer_token(authorization))
    except AuthError as exc:
        log.info("image request rejected: %s", exc)
        raise HTTPException(status_code=401, detail="Sign in to save recipe photos")

    # Who is calling was never the gap; what they are touching was.
    try:
        owned = recipe_is_owned(user_id, recipe_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a valid recipe id")
    except ImageError:
        log.exception("could not check recipe ownership")
        raise HTTPException(status_code=503, detail="Photo storage is unavailable")
    if not owned:
        log.info("image request rejected: %s is not a recipe of the caller's", recipe_id)
        raise HTTPException(status_code=422, detail="No recipe to attach that photo to")
    return user_id


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
    user_id = _photo_caller(authorization, body.recipe_id)
    from .images import ImageError, mirror_image

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


@app.post("/api/recipes/image/upload")
def recipe_image_upload(body: UploadImageRequest, authorization: str | None = Header(default=None)):
    """Keep a photo the person took or picked, as the recipe's picture. Signed in.

    The route above fetches a URL; this one is handed the bytes, for a recipe out
    of a family notebook that has no web address. Same gates, same bucket, same
    resize. No model call, so it is not metered by `meter_caller` and spends
    nothing: what bounds it is the sign-in and the recipe ownership check.
    """
    # Ownership is checked before the bytes are decoded, so an unowned id costs
    # one lookup rather than a decode and two uploads.
    user_id = _photo_caller(authorization, body.recipe_id)
    from .images import ImageError, upload_image

    try:
        raw = base64.b64decode(body.image, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="That photo could not be read")

    try:
        return upload_image(user_id, body.recipe_id, raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a valid recipe id")
    except ImageError as exc:
        log.info("photo upload failed for %s: %s", body.recipe_id, exc)
        raise HTTPException(status_code=422, detail="Could not save that photo")
    except Exception:
        log.exception("unexpected photo upload failure for %s", body.recipe_id)
        raise HTTPException(status_code=502, detail="Could not save that photo")


@app.post("/api/push/fire")
def push_fire(x_push_secret: str | None = Header(default=None)):
    """Send every timer alert that has come due. Called by a Supabase cron job.

    Not a user endpoint: the only caller is the database, and what it presents is
    a shared secret the browser never sees. Anything else gets the same opaque 401
    whether the secret is wrong, missing or not configured, so the response says
    nothing about which. It is not metered by `meter_caller` because it spends
    nothing: no model call, and the sending cost is the push service's, not ours.
    """
    from . import push

    if not push.authorized(x_push_secret):
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        return push.fire_due()
    except Exception:
        # The cron job retries on its next tick; what failed stays in the logs.
        log.exception("push fire failed")
        raise HTTPException(status_code=502, detail="Could not send")
