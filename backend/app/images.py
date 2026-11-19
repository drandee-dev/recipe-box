"""Keep the thumbnail (phase 7).

A saved recipe's image_url points at whatever origin served it, and those go
away. Instagram and TikTok sign their CDN URLs with an expiry measured in days.
Plenty of origins turn on Cross-Origin-Resource-Policy, which no amount of
client-side work gets around. An HTML error page served as 200 fires the same
error event as a 404. RecipeThumb makes all of that degrade to a coloured tile
instead of a broken-image icon, which is why this was never urgent, but the
photo is still gone.

So: fetch the bytes once, while the URL still works, resize them and put them in
our own bucket. Signed in only — signed out there is no bucket to write to and
no account to scope the objects under.

Owning the bytes is also what pays for the rest of it. Two widths mean a 128px
card stops downloading a 3000px hero, and a 20px JPEG inlined into the row gives
the image box something to hold while the real photo arrives.
"""

import base64
import io
import logging
import time
import uuid

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from . import supabase
from .extract import ExtractError, fetch_bytes
from .glyph import strip_play_glyph

log = logging.getLogger("recipe.images")

BUCKET = "recipe-images"
TIMEOUT = 15.0

# Bumped whenever this pipeline starts producing different bytes for the same
# source. It rides in the public URL as `?v=N`, which does three jobs at once:
# it busts the year-long immutable cache on an object we overwrite in place, it
# lets the client tell a photo mirrored by an older pipeline from a current one
# without a new column, and it keeps the "read it off the URL, never a flag"
# rule the rest of phase 7 follows. v2 was the first play-glyph strip; v3 is the
# one that divides the dark disc out instead of filling over it; v4 divides it
# out at the overlay's fixed strength and fills the smeared edge (H3); v5 is the
# retro pass, which re-picks the food out of every saved TikTok and Instagram
# photo (`repair` in `mirror_image`).
MIRROR_VERSION = 5

# 960 is the copy of record: big enough that we are not the reason a photo looks
# bad later, small enough to be a couple of hundred KB. 320 covers the 128px card
# on a 2x screen and the planner's 56px row on anything.
WIDTHS = {"lg": 960, "sm": 320}
# A very tall image constrained on width alone stays enormous, so cap the other
# side too. thumbnail() only ever shrinks, so a small original passes through.
HEIGHT_FACTOR = 2

BLUR_WIDTH = 20
BLUR_QUALITY = 35

# Guard against a decompression bomb: a few hundred KB of JPEG can describe a
# bitmap that does not fit in a serverless function's memory. Checked against the
# header, before any pixels are decoded.
MAX_PIXELS = 50_000_000


class ImageError(Exception):
    """The photo could not be fetched, decoded, or stored."""


storage_configured = supabase.configured


def _storage() -> tuple[str, str]:
    conf = supabase.service_config()
    if conf is None:
        raise ImageError("storage is not configured on this deployment")
    return conf


def _open(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
    # DecompressionBombError: Pillow's own refusal of an absurdly large image,
    # which is neither of the other two and used to escape as a 502.
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        # Also the path a hotlink-block page takes: it arrives as HTML with a
        # 200, and Pillow is the thing that actually notices it isn't a photo.
        raise ImageError("that URL did not return an image") from exc

    width, height = img.size
    if width * height > MAX_PIXELS:
        raise ImageError("image is too large to process")

    try:
        img.load()
        # Phone photos carry their rotation in EXIF rather than in the pixels,
        # so without this a portrait shot is mirrored into the bucket sideways
        # and stays that way forever.
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P", "PA"):
            # Flatten onto white rather than dropping the alpha channel, which
            # would leave a transparent PNG's edges black in a JPEG.
            img = img.convert("RGBA")
            flat = Image.new("RGB", img.size, (255, 255, 255))
            flat.paste(img, mask=img.split()[-1])
            img = flat
        elif img.mode != "RGB":
            img = img.convert("RGB")
    except (OSError, ValueError) as exc:
        raise ImageError("image could not be decoded") from exc
    return img




def _encode(img: Image.Image, width: int, quality: int) -> bytes:
    copy = img.copy()
    copy.thumbnail((width, width * HEIGHT_FACTOR), Image.LANCZOS)
    buf = io.BytesIO()
    copy.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def _blur_data_uri(img: Image.Image) -> str:
    data = _encode(img, BLUR_WIDTH, BLUR_QUALITY)
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def image_for_vision(data: bytes) -> tuple[str, str]:
    """A recipe photo, decoded and shrunk to what the model will actually read.

    Returns (base64 JPEG, media type). Unlike the mirror this never touches
    storage — nothing is kept, so it works signed out and needs no bucket.

    The long edge is capped rather than the width: a recipe written down the
    side of a portrait screenshot is the exact case this exists for, and
    constraining width alone would leave that image enormous. Re-encoding as
    JPEG also normalises whatever the origin served (PNG screenshots, WEBP,
    a rotation living in EXIF) into the one format the API definitely accepts.
    """
    return _vision_jpeg(_open(data))


def _vision_jpeg(img: Image.Image, overlay=None) -> tuple[str, str]:
    """image_for_vision for a picture already decoded (the mirror's, after repair).

    `overlay` draws on the shrunk copy, so its lines and labels reach the model
    at the size they were drawn, not resampled."""
    from .ai import VISION_MAX_PIXELS, VISION_MAX_PX, VISION_QUALITY

    img = img.copy()
    img.thumbnail((VISION_MAX_PX, VISION_MAX_PX), Image.LANCZOS)
    width, height = img.size
    if width * height > VISION_MAX_PIXELS:
        scale = (VISION_MAX_PIXELS / (width * height)) ** 0.5
        img = img.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)
    if overlay:
        img = overlay(img)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=VISION_QUALITY, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"


def _upload(path: str, data: bytes, bust: int | None = None) -> str:
    """Put one object in the bucket and return its public URL.

    `bust` is for a photo replaced by the person (see `upload_image`): the path
    is the same, so without a changing value in the URL every device that has seen
    the old picture keeps it for the year the cache header promises.
    """
    url, key = _storage()
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(
                f"{url}/storage/v1/object/{BUCKET}/{path}",
                content=data,
                headers={
                    # json=False: the object's own Content-Type goes below.
                    **supabase.headers(key, json=False),
                    "Content-Type": "image/jpeg",
                    # The path carries the recipe id, so these bytes are
                    # immutable for as long as the recipe exists.
                    "Cache-Control": "public, max-age=31536000, immutable",
                    # A retried mirror should overwrite rather than 409.
                    "x-upsert": "true",
                },
            )
    except httpx.HTTPError as exc:
        raise ImageError("could not reach storage") from exc

    if resp.status_code >= 400:
        log.warning("storage upload failed for %s: %s %s", path, resp.status_code, resp.text[:200])
        raise ImageError("storage rejected the upload")

    # The version is what makes overwriting an object in place work at all. The
    # header above tells every cache in the way to keep these bytes for a year,
    # and the path is derived from the recipe id, so a re-mirror that improves
    # the picture would otherwise never be seen.
    # `v=` stays first: the client reads `?v=N` off the URL to tell a current
    # photo from an old one, and an upload is a current photo.
    suffix = f"&u={bust}" if bust is not None else ""
    return f"{url}/storage/v1/object/public/{BUCKET}/{path}?v={MIRROR_VERSION}{suffix}"


def recipe_is_owned(user_id: str, recipe_id: str) -> bool:
    """Does this recipe exist, and belong to this caller?

    The endpoint above already derives `user_id` from the verified token rather
    than the body, so there is no cross-user write to prevent: the storage path
    is `{verified_user_id}/{recipe_id}` and a caller can only ever write into
    their own folder. What was missing is the second gate. `recipe_id` arrives in
    the body and nothing tied it to a row, so an authenticated caller could post
    invented UUIDs with arbitrary image URLs and have us fetch and keep each one,
    indefinitely, on the free tier's storage. Sign-up is open, so the price of an
    account is an email address.

    Worse, those objects would be unreachable afterwards: `store.remove` deletes
    `{user_id}/{recipe_id}` for recipes the app knows about, and a recipe that
    never existed is never in that list.

    Fails closed. This runs on a best-effort path whose failure is already
    handled — the client keeps the origin URL and tries again on a later load —
    so a lookup we couldn't complete is a mirror worth skipping, not one worth
    guessing at.
    """
    # Parsed rather than interpolated raw: both halves go into a PostgREST filter
    # and then into an object path. ValueError here is the endpoint's 422.
    user_id = str(uuid.UUID(user_id))
    recipe_id = str(uuid.UUID(recipe_id))

    url, key = _storage()
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{url}/rest/v1/recipes",
                params={
                    "select": "id",
                    "id": f"eq.{recipe_id}",
                    "user_id": f"eq.{user_id}",
                    "limit": 1,
                },
                headers=supabase.headers(key, json=False),
            )
    except httpx.HTTPError:
        log.exception("ownership lookup failed for %s", recipe_id)
        return False

    if resp.status_code >= 400:
        log.warning("ownership lookup rejected: %s %s", resp.status_code, resp.text[:200])
        return False

    rows = resp.json()
    return isinstance(rows, list) and len(rows) > 0


def _resolve_source(url: str) -> str:
    """A social *post* URL becomes the cover it currently serves. Anything else
    passes straight through.

    The normal path never reaches the second half of this: the client hands over
    an image URL, and a CDN host (`scontent-….cdninstagram.com`,
    `p16-….tiktokcdn-us.com`) is not a post host, so `detect_source` says "web".
    What this is for is re-acquiring a cover we can no longer get from our own
    copy — a photo whose CDN link expired before it was ever mirrored, and the
    reel covers repaired by pipeline v2, whose stored bytes have that repair
    baked into them and cannot be un-repaired from themselves.
    """
    from .social import detect_source, fetch_post

    kind = detect_source(url)
    if kind == "web":
        return url
    image = (fetch_post(url, kind) or {}).get("image_url")
    if not image:
        raise ImageError("that post no longer serves a cover image")
    return image


# The smallest food crop worth keeping, as a fraction of the cover. The model is
# told a quarter of the width; height gets less because covers are 9:16.
MIN_CROP_WIDTH = 0.25
MIN_CROP_HEIGHT = 0.15

NO_PHOTO = {"image_url": None, "image_thumb_url": None, "image_blur": None}


# The grid cell's shape. A clean piece is scored by how much of it a 4:3 cell
# would show under `object-fit: cover`, so a thin strip loses to a squarer piece.
CELL_ASPECT = 4 / 3
# Pieces kept between obstacles; each obstacle can split a piece four ways.
MAX_PIECES = 64
# Percent added on every side of a text or person box: the model's edges sit on
# the letters, so their outer pixels stayed in the crop (job 11 run 4).
OBSTACLE_PAD = 2
# Widest piece kept (width / height). A wider strip fills a 4:3 cell from too
# few rows and upscales blurry. Good crops reach 2.16 once padded (run 5 #7; at
# 2.0 it lost to a 151x576 sliver), a 100x16% strip is 3.5. Tall pieces need no
# limit: a cover-fit cell shows them at full width.
MAX_CROP_ASPECT = 2.5


def _pct_box(raw, *, swap=False) -> tuple[int, int, int, int] | None:
    """A model box as (left, top, right, bottom) in percent, clamped; None if malformed or empty.

    `swap` puts reversed edges in order: right for an obstacle, since dropping a
    caption box leaves the caption in the crop. A reversed food box stays None."""
    try:
        left, top, right, bottom = (int(raw[k]) for k in ("left", "top", "right", "bottom"))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if swap:
        left, right = sorted((left, right))
        top, bottom = sorted((top, bottom))
    left, top, right, bottom = max(0, left), max(0, top), min(100, right), min(100, bottom)
    return (left, top, right, bottom) if right > left and bottom > top else None


def _clean_pieces(food, obstacles):
    """The food box with every obstacle box cut out, as the axis-aligned pieces left over."""
    pieces = [food]
    for ol, ot, orr, ob in obstacles:
        nxt = []
        for l, t, r, b in pieces:
            if orr <= l or ol >= r or ob <= t or ot >= b:
                nxt.append((l, t, r, b))
                continue
            if ot > t:
                nxt.append((l, t, r, ot))
            if ob < b:
                nxt.append((l, ob, r, b))
            if ol > l:
                nxt.append((l, t, ol, b))
            if orr < r:
                nxt.append((orr, t, r, b))
        pieces = sorted(nxt, key=lambda p: (p[2] - p[0]) * (p[3] - p[1]), reverse=True)[:MAX_PIECES]
    return pieces


def food_crop(img: Image.Image, pick: dict):
    """Cut the thumbnail out of the cover from the model's boxes.

    Returns the cropped picture; NO_FOOD when the food box exists but no clean
    piece of it is big enough (text over all of it); None when the answer is
    malformed, which the caller treats as "keep the cover".

    The piece is kept exactly, never widened to the grid's 4:3: everything inside
    it is clean food, and widening it is how a face or a caption comes back.
    """
    food = _pct_box(pick.get("food"))
    if food is None:
        return None
    raw = [*(pick.get("text") or []), *(pick.get("people") or [])]
    obstacles = [
        (max(0, l - OBSTACLE_PAD), max(0, t - OBSTACLE_PAD), min(100, r + OBSTACLE_PAD), min(100, b + OBSTACLE_PAD))
        for l, t, r, b in filter(None, (_pct_box(o, swap=True) for o in raw))
    ]
    w, h = img.size

    def shown(p):  # pixels a 4:3 cover-fit cell keeps of this piece
        pw, ph = (p[2] - p[0]) * w / 100, (p[3] - p[1]) * h / 100
        return min(pw, ph * CELL_ASPECT) * min(ph, pw / CELL_ASPECT)

    usable = [
        p for p in _clean_pieces(food, obstacles)
        if (p[2] - p[0]) / 100 >= MIN_CROP_WIDTH and (p[3] - p[1]) / 100 >= MIN_CROP_HEIGHT
        and (p[2] - p[0]) * w <= MAX_CROP_ASPECT * (p[3] - p[1]) * h
    ]
    if not usable:
        return NO_FOOD
    l, t, r, b = max(usable, key=shown)
    return img.crop((round(w * l / 100), round(h * t / 100), round(w * r / 100), round(h * b / 100)))


NO_FOOD = object()


def _grid(img: Image.Image) -> Image.Image:
    """The model's copy only: thin lines every 10% so it measures rather than guesses.

    Each line carries its number: unlabelled, the model counted lines and put
    caption boxes 10-25% below the real text (job 11 run 3)."""
    from PIL import ImageDraw, ImageFont

    out = img.copy()
    draw = ImageDraw.Draw(out)
    w, h = out.size
    font = ImageFont.load_default(size=max(10, min(w, h) // 25))
    label = {"font": font, "fill": (255, 255, 255), "stroke_width": 2, "stroke_fill": (0, 0, 0)}
    for i in range(1, 10):
        x, y = w * i / 10, h * i / 10
        draw.line([(x, 0), (x, h)], fill=(128, 128, 128), width=1)
        draw.line([(0, y), (w, y)], fill=(128, 128, 128), width=1)
        draw.text((2, y), str(i * 10), anchor="ld", **label)  # left edge, sitting on its line
        draw.text((w - 2, y), str(i * 10), anchor="rd", **label)  # right edge too: captions often cover one side
        draw.text((x + 2, 2), str(i * 10), anchor="lt", **label)  # top edge, beside its line
    return out


class PickUnavailable(ImageError):
    """A repair could not ask the model (budget spent, over its cap). Nothing is
    written, so the URL stays stale and a later load tries again."""


def _pick(img: Image.Image, picker, recipe_id: str, checker=None, strict=False) -> Image.Image | None:
    """H1/H4. Returns the food crop, the picture unchanged, or None for "no clean
    food in it". Any failure is the picture unchanged: the picker can only make a
    cover better or remove it, never lose a mirror that would have worked.

    `checker` (ai.crop_shows_food) looks at the finished crop: a "no" is None too,
    since the picker calls some covers food that have none (#14, a hand over an
    empty pan). The check failing keeps the crop, as before it existed.

    `strict` (a repair) raises PickUnavailable when the model could not be asked
    (budget spent, key bad, API down) instead: storing the whole cover there would
    stamp the version and end the pass unpicked. An answer it cannot use still
    keeps the cover, since that call was paid for and would be paid again."""
    from .ai import AIBudgetError, AIUnavailable

    try:
        pick = picker(*_vision_jpeg(img, overlay=_grid))
    except (AIBudgetError, AIUnavailable) as exc:
        if strict:
            raise PickUnavailable(str(exc)) from exc
        log.info("food pick failed for %s, keeping the cover: %s", recipe_id, exc)
        return img
    except Exception as exc:
        log.info("food pick failed for %s, keeping the cover: %s", recipe_id, exc)
        return img
    try:
        if pick.get("verdict") == "none":
            log.info("no food in the cover for %s", recipe_id)
            return None
        cropped = food_crop(img, pick)
    except Exception as exc:  # junk past the schema (e.g. "text": 5) must not lose the mirror either
        log.info("food pick failed for %s, keeping the cover: %s", recipe_id, exc)
        return img
    if cropped is NO_FOOD:
        log.info("no clean food in the cover for %s", recipe_id)
        return None
    if cropped is None:
        log.info("unusable food boxes for %s: %s", recipe_id, pick)
        return img
    if checker is not None:
        try:
            shows_food = checker(*_vision_jpeg(cropped))
        except Exception as exc:
            log.info("crop check failed for %s, keeping the crop: %s", recipe_id, exc)
            return cropped
        if not shows_food:
            log.info("the crop for %s does not show food", recipe_id)
            return None
    return cropped


def _video_pick(video, picker, recipe_id: str, checker=None, strict=False) -> Image.Image | None:
    """H2: the cover had no clean food, so pick the food out of the video still
    that best shows the dish. None (the tile) when there is no video, no still
    with food, or any failure on the way. `strict` lets PickUnavailable through."""
    try:
        frame = video()
    except PickUnavailable:
        if strict:
            raise
        return None
    except Exception as exc:
        log.info("no video frame for %s: %s", recipe_id, exc)
        return None
    if frame is None:
        log.info("no video still shows food for %s", recipe_id)
        return None
    cropped = _pick(frame, picker, recipe_id, checker, strict)
    # _pick hands back the picture itself when it fails. Right for a cover, but a
    # still has been judged only "shows food", faces and captions included: tile.
    return None if cropped is frame else cropped


def _stored_url(user_id: str, recipe_id: str) -> str:
    """Our own copy of record for a recipe, as `_store` wrote it. A fresh query
    string, since the object is cached a year as immutable and v1 URLs had none,
    so a cache could still hold older bytes at the bare address."""
    url, _key = _storage()
    return f"{url}/storage/v1/object/public/{BUCKET}/{user_id}/{recipe_id}-lg.jpg?r={int(time.time())}"


def mirror_image(
    user_id: str, recipe_id: str, source_url: str, picker=None, video=None, checker=None, repair=False
) -> dict:
    """Fetch, resize and store one recipe photo. Returns the columns to save.

    `picker` (ai.pick_food_crop) is passed for the first mirror of a social
    import; with it, the stored photo is the food alone, or NO_PHOTO. `video`, a
    no-argument callable returning a still or None (TikTok only), is tried when
    the cover has no clean food. `checker` (ai.crop_shows_food) is the second look
    at each finished crop, the cover's and the still's.

    `repair` is the retro pass over a photo already saved (his calls, 2026-11-19):
    no clean food keeps a photo, the whole glyph-stripped cover, never the tile; a
    post that no longer serves a cover keeps the copy we hold, re-stored so its URL
    carries the current version and the pass ends; a spent budget raises
    PickUnavailable and writes nothing.
    """
    # Both go straight into an object path. They are already validated upstream,
    # but a traversal here would write outside the caller's own folder.
    user_id = str(uuid.UUID(user_id))
    recipe_id = str(uuid.UUID(recipe_id))
    try:
        source_url = _resolve_source(source_url)
    except ImageError:
        if not repair:
            raise
        # shortcut: a post that failed to load once for a passing reason is treated as gone too
        log.info("the post for %s serves no cover; keeping the photo we hold", recipe_id)
        source_url, picker = _stored_url(user_id, recipe_id), None

    try:
        data, _content_type = fetch_bytes(source_url)
    except ExtractError as exc:
        raise ImageError(str(exc)) from exc
    except httpx.HTTPError as exc:
        raise ImageError("could not fetch that image") from exc

    img = _open(data)
    # Before anything is measured or encoded, so the blur and both widths are
    # all made from the repaired picture. A source with no glyph passes straight
    # through, which is every photo that isn't a reel cover.
    img, stripped = strip_play_glyph(img)
    if stripped:
        log.info("stripped a play glyph from the cover for %s", recipe_id)

    if picker is not None:
        picked = _pick(img, picker, recipe_id, checker, strict=repair)
        if picked is None and video is not None:
            picked = _video_pick(video, picker, recipe_id, checker, strict=repair)
        if picked is not None:
            img = picked
        elif not repair:
            return dict(NO_PHOTO)

    return _store(user_id, recipe_id, img)


def upload_image(user_id: str, recipe_id: str, data: bytes) -> dict:
    """Resize and store a photo the person sent as bytes. Returns the columns.

    The same pipeline as `mirror_image` minus the fetch and the play-glyph strip
    (that is Instagram's overlay; a photo from a camera has none). Differs in one
    way that matters: the person may be *replacing* a photo, and the object path
    is the recipe's, so the URL carries a timestamp the mirror's does not.
    """
    user_id = str(uuid.UUID(user_id))
    recipe_id = str(uuid.UUID(recipe_id))
    return _store(user_id, recipe_id, _open(data), bust=int(time.time()))


def _store(user_id: str, recipe_id: str, img: Image.Image, bust: int | None = None) -> dict:
    blur = _blur_data_uri(img)
    lg = _upload(f"{user_id}/{recipe_id}-lg.jpg", _encode(img, WIDTHS["lg"], 82), bust)
    sm = _upload(f"{user_id}/{recipe_id}-sm.jpg", _encode(img, WIDTHS["sm"], 80), bust)

    return {"image_url": lg, "image_thumb_url": sm, "image_blur": blur}
