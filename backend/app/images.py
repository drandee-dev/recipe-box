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
import os
import uuid

import httpx
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, UnidentifiedImageError

from .extract import ExtractError, fetch_bytes

log = logging.getLogger("recipe.images")

BUCKET = "recipe-images"
TIMEOUT = 15.0

# Bumped whenever this pipeline starts producing different bytes for the same
# source. It rides in the public URL as `?v=N`, which does three jobs at once:
# it busts the year-long immutable cache on an object we overwrite in place, it
# lets the client tell a photo mirrored by an older pipeline from a current one
# without a new column, and it keeps the "read it off the URL, never a flag"
# rule the rest of phase 7 follows. v2 is the play-glyph strip below.
MIRROR_VERSION = 2

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


def storage_configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


def _storage() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise ImageError("storage is not configured on this deployment")
    return url, key


def _open(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
    except (UnidentifiedImageError, OSError) as exc:
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


# --- the Instagram play glyph -------------------------------------------------
#
# A reel's og:image is not the cover frame. Instagram composites a white play
# triangle and a soft dark disc into the JPEG before serving it — the URL says so
# out loud, `stp=cmp1_dst-jpg_…`, where cmp1 is the composite. There is no clean
# frame to ask for instead: the URL is signed (`oh`/`oe`), so every rewrite of
# `stp` comes back 403, and the logged-out page carries no second image URL, no
# JSON-LD and no og:video. Checked, all of it. So the choice is to repair the
# pixels or to live with a play button in the middle of every reel recipe.
#
# The repair fills the glyph in two parts, and it needs both. Colour comes from
# diffusion: blur the hole repeatedly, pasting the untouched pixels back each
# time, so the fill grows inward from the boundary and matches the photo on every
# side. That alone leaves a smooth disc that reads as a lens smudge. Texture is
# then borrowed from a clean patch of the same photo — its high frequencies only,
# lifted by subtracting its own blur — which is what makes the result read as
# more chicken rather than as a hole.
#
# Copying a whole donor patch straight in was the first version and is worth
# writing down as the thing not to go back to: the area just above the glyph on a
# reel cover sits in Instagram's own dark disc, so the patch arrived visibly
# darker than what surrounded it and traded a white triangle for a grey square.
# Diffusion gets the level right; the donor is only ever asked for grain.
#
# Everything below is a fraction of the image's short edge or of the patch, never
# a pixel count — Instagram scales the glyph with the output size, and we mirror
# at whatever size the origin served.
PLAY_WHITE = 235  # per channel; the glyph is a solid 255 with antialiased edges
PLAY_PROBE = 0.06  # a box this wide at the centre sits inside the triangle
PLAY_PROBE_WHITE = 0.85
PLAY_SURROUND = 0.34  # …and this one is mostly photo, even at a generous size
PLAY_SURROUND_WHITE = 0.20
PLAY_PATCH = 0.20  # hole diameter: covers the triangle with room to spare
PLAY_MARGIN = 0.6  # working region around the hole, in patch widths
PLAY_ITERATIONS = 20  # diffusion passes; each one carries the edge further in
PLAY_RADIUS = 0.22  # blur radius per pass, in patch widths
PLAY_FEATHER = 0.10  # softens the seam where the fill meets the photo
PLAY_DONOR_SHIFT = 1.35  # patch widths above the hole: clear of the glyph and its disc
PLAY_MIN_EDGE = 120  # below this the probe is a handful of pixels and proves nothing


def _white_fraction(img: Image.Image, frac: float) -> float:
    """How much of a centred box this wide is near-white.

    Done in bands rather than by walking pixels: the darkest channel of each
    pixel is what decides whether it is white, `darker` gives that in C, and the
    histogram counts the survivors. A per-pixel loop over a 34%-wide box of a
    960px photo is ~100k iterations of Python for one boolean.
    """
    width, height = img.size
    size = max(2, int(min(width, height) * frac))
    left = width // 2 - size // 2
    top = height // 2 - size // 2
    crop = img.crop((left, top, left + size, top + size)).convert("RGB")
    red, green, blue = crop.split()
    darkest = ImageChops.darker(ImageChops.darker(red, green), blue)
    white = darkest.point(lambda v: 255 if v >= PLAY_WHITE else 0).histogram()[255]
    return white / (size * size)


def has_play_glyph(img: Image.Image) -> bool:
    """Does this look like a reel cover with a play triangle burned into it?

    Two readings, and the second one is what makes this safe to run on every
    photo rather than only on Instagram imports. A solid white centre alone
    describes a white plate shot from above just as well as it describes the
    glyph; what separates them is that the plate keeps being white on the way
    out and the glyph stops abruptly. Measured on the real reel: 0.96 white at
    the centre against 0.05 at a third of the frame. Eight ordinary food photos
    read 0.000 at both.
    """
    if min(img.size) < PLAY_MIN_EDGE:
        return False
    if _white_fraction(img, PLAY_PROBE) < PLAY_PROBE_WHITE:
        return False
    return _white_fraction(img, PLAY_SURROUND) <= PLAY_SURROUND_WHITE


def _borrowed_texture(img: Image.Image, region_box: tuple, radius: float, shift: int):
    """The grain of a clean patch of the same photo, with its colour removed.

    Returns a region-sized image of high frequencies centred on mid-grey, or
    None when there is nowhere clean to take it from. Above the hole first,
    below it if the frame runs out — Instagram also serves square crops, where
    the centre sits close enough to the top edge that a patch this size doesn't
    fit above it.
    """
    left, top, right, bottom = region_box
    height = img.size[1]
    span = bottom - top
    donor_top = top - shift
    if donor_top < 0:
        donor_top = top + shift
    if donor_top < 0 or donor_top + span > height:
        return None
    donor = img.crop((left, donor_top, right, donor_top + span))
    return ImageChops.subtract(donor, donor.filter(ImageFilter.GaussianBlur(radius)), 1, 128)


def strip_play_glyph(img: Image.Image) -> tuple[Image.Image, bool]:
    """Patch the play triangle out, if there is one. Returns (image, changed)."""
    if not has_play_glyph(img):
        return img, False

    width, height = img.size
    size = int(min(width, height) * PLAY_PATCH)
    radius = size * PLAY_RADIUS
    margin = int(size * PLAY_MARGIN)
    cx, cy = width // 2, height // 2

    # A working region rather than the whole photo: every pass below is a blur,
    # and blurring a 960px image twenty times to fix 20% of it is wasteful.
    region_box = (
        max(0, cx - size // 2 - margin),
        max(0, cy - size // 2 - margin),
        min(width, cx + size // 2 + margin),
        min(height, cy + size // 2 + margin),
    )
    region = img.crop(region_box)
    hole = Image.new("L", region.size, 0)
    hx, hy, r = cx - region_box[0], cy - region_box[1], size // 2
    ImageDraw.Draw(hole).ellipse((hx - r, hy - r, hx + r, hy + r), fill=255)

    # Diffusion. Composite pastes the untouched photo back over everything
    # outside the hole after each blur, so the only thing that survives from one
    # pass to the next inside the hole is colour that came from its edge.
    fill = region
    for _ in range(PLAY_ITERATIONS):
        fill = Image.composite(fill.filter(ImageFilter.GaussianBlur(radius)), region, hole)

    texture = _borrowed_texture(img, region_box, radius, int(size * PLAY_DONOR_SHIFT))
    if texture is not None:
        fill = ImageChops.add(fill, texture, 1, -128)

    patched = img.copy()
    patched.paste(Image.composite(fill, region, hole.filter(ImageFilter.GaussianBlur(size * PLAY_FEATHER))), region_box[:2])
    return patched, True


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
    from .ai import VISION_MAX_PIXELS, VISION_MAX_PX, VISION_QUALITY

    img = _open(data)
    img.thumbnail((VISION_MAX_PX, VISION_MAX_PX), Image.LANCZOS)
    width, height = img.size
    if width * height > VISION_MAX_PIXELS:
        scale = (VISION_MAX_PIXELS / (width * height)) ** 0.5
        img = img.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=VISION_QUALITY, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"


def _upload(path: str, data: bytes) -> str:
    """Put one object in the bucket and return its public URL."""
    url, key = _storage()
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(
                f"{url}/storage/v1/object/{BUCKET}/{path}",
                content=data,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
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
    return f"{url}/storage/v1/object/public/{BUCKET}/{path}?v={MIRROR_VERSION}"


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
                headers={"apikey": key, "Authorization": f"Bearer {key}"},
            )
    except httpx.HTTPError:
        log.exception("ownership lookup failed for %s", recipe_id)
        return False

    if resp.status_code >= 400:
        log.warning("ownership lookup rejected: %s %s", resp.status_code, resp.text[:200])
        return False

    rows = resp.json()
    return isinstance(rows, list) and len(rows) > 0


def mirror_image(user_id: str, recipe_id: str, source_url: str) -> dict:
    """Fetch, resize and store one recipe photo. Returns the columns to save."""
    # Both go straight into an object path. They are already validated upstream,
    # but a traversal here would write outside the caller's own folder.
    user_id = str(uuid.UUID(user_id))
    recipe_id = str(uuid.UUID(recipe_id))

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

    blur = _blur_data_uri(img)
    lg = _upload(f"{user_id}/{recipe_id}-lg.jpg", _encode(img, WIDTHS["lg"], 82))
    sm = _upload(f"{user_id}/{recipe_id}-sm.jpg", _encode(img, WIDTHS["sm"], 80))

    return {"image_url": lg, "image_thumb_url": sm, "image_blur": blur}
