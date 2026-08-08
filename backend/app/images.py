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
import math
import os
import statistics
import uuid

import httpx
from PIL import (
    Image,
    ImageChops,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageOps,
    UnidentifiedImageError,
)

from .extract import ExtractError, fetch_bytes

log = logging.getLogger("recipe.images")

BUCKET = "recipe-images"
TIMEOUT = 15.0

# Bumped whenever this pipeline starts producing different bytes for the same
# source. It rides in the public URL as `?v=N`, which does three jobs at once:
# it busts the year-long immutable cache on an object we overwrite in place, it
# lets the client tell a photo mirrored by an older pipeline from a current one
# without a new column, and it keeps the "read it off the URL, never a flag"
# rule the rest of phase 7 follows. v2 was the first play-glyph strip; v3 is the
# one that divides the dark disc out instead of filling over it.
MIRROR_VERSION = 3

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
# **The overlay is two separate things and only one of them needs inventing
# pixels.** That is the whole design, and getting it wrong is what made the first
# version ugly. Instagram composites (a) a flat black disc at ~40% opacity,
# radius 0.14 of the short edge, and (b) a small white play triangle inside it.
# A flat multiply is exactly invertible — the disc can be *divided back out*,
# recovering the real photo underneath, no guessing at all. Only the triangle is
# genuinely destroyed, and it is 0.3% of the frame.
#
# Measured on a real reel cover rather than assumed. Median luma is ~64 inside
# the disc against ~109 outside, the ratio holds flat from the centre to the rim
# (1.67–1.75 across every radius), and the edge is *hard*: full strength at
# r=0.136, nothing at r=0.143, so ~1px of antialiasing and no gradient to model.
# The gain that falls out is 1.66, i.e. alpha 0.397 — a designer's 40%.
#
# The first version treated the whole thing as one hole: a circle 20% of the
# short edge, filled by diffusion. It failed for a reason worth keeping. The
# diffusion pulls colour from the hole's rim, the rim sits *inside* the dark
# disc, so the fill came out dark — and the rest of the disc stayed. A dark
# smooth circle in the middle of the food, exactly the artifact it was meant to
# remove. Undoing the multiply first means the fill is surrounded by, and matches,
# the real photo.
#
# The triangle is then patched to *its own shape*, found by threshold, not to a
# circle drawn around it. A circle centred on the image also misses: the glyph is
# optically centred, so its bounding box sits right of centre and the tip escapes.
# Shape-fitting touches 0.8% of the frame where the circle touched 1.8%.
#
# Everything below is a fraction of the short edge, never a pixel count —
# Instagram scales the overlay with the output size and we mirror at whatever
# size the origin served.
PLAY_WHITE = 235  # per channel; the glyph is a solid 255 with antialiased edges
PLAY_PROBE = 0.06  # a box this wide at the centre sits inside the triangle
PLAY_PROBE_WHITE = 0.85
PLAY_SURROUND = 0.34  # …and this one is mostly photo, even at a generous size
PLAY_SURROUND_WHITE = 0.20
PLAY_MIN_EDGE = 120  # below this the probe is a handful of pixels and proves nothing

SCRIM_RADIUS = 0.1395
SCRIM_EDGE = 0.006  # the measured edge is ~1px; this is the blur that matches it
# Sampled as bands, not rings. A single ring lands wherever the photo happens to
# be bright and read the gain 14% high, which is a visible bright disc — pooling
# a dozen radii either side of the edge brought it to 1.66 against a theoretical
# 1.667.
SCRIM_INNER = (0.090, 0.132)
SCRIM_OUTER = (0.152, 0.210)
# Below this there is no disc to remove and the image is left alone, which is
# what stops a cover that was never scrimmed being lit up into a bright circle.
SCRIM_MIN_GAIN = 1.18
SCRIM_MAX_GAIN = 2.00

GLYPH_GROW = 0.012  # dilation, to swallow the antialiased rim
GLYPH_SOFT = 0.006
GLYPH_MAX = 0.20  # a "glyph" larger than this is not one; leave the photo alone
PLAY_ITERATIONS = 22  # diffusion passes; each one carries the edge further in
PLAY_RADIUS = 0.30  # blur radius per pass, as a fraction of the glyph's width
PLAY_DONOR_SHIFT = 1.15  # region heights away: clear of the glyph, still local


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


def _band_luma(img: Image.Image, lo: float, hi: float, step: float = 0.004) -> float | None:
    """Median luminance over an annulus, as a fraction of the short edge.

    The glyph's own white is excluded, or the inner band would be measuring the
    thing being removed.
    """
    width, height = img.size
    pixels = img.load()
    cx, cy = width / 2, height / 2
    short = min(width, height)
    values = []
    radius = lo
    while radius <= hi:
        count = max(180, int(2 * math.pi * radius * short))
        for i in range(count):
            angle = i * 2 * math.pi / count
            x = int(cx + math.cos(angle) * radius * short)
            y = int(cy + math.sin(angle) * radius * short)
            if 0 <= x < width and 0 <= y < height:
                r, g, b = pixels[x, y]
                if min(r, g, b) >= PLAY_WHITE:
                    continue
                values.append(0.299 * r + 0.587 * g + 0.114 * b)
        radius += step
    return statistics.median(values) if values else None


def _unscrim(img: Image.Image) -> tuple[Image.Image, float]:
    """Divide out the dark disc, recovering the photo underneath.

    Returns (image, gain). A gain of 1.0 means no disc was found and nothing was
    touched — that check is load-bearing, since brightening a cover that was
    never scrimmed would paint a bright circle where there was nothing wrong.
    """
    inner = _band_luma(img, *SCRIM_INNER)
    outer = _band_luma(img, *SCRIM_OUTER)
    if not inner or not outer or inner < 6:
        return img, 1.0
    gain = outer / inner
    if gain < SCRIM_MIN_GAIN:
        return img, 1.0
    gain = min(gain, SCRIM_MAX_GAIN)

    width, height = img.size
    radius = SCRIM_RADIUS * min(width, height)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).ellipse(
        (width / 2 - radius, height / 2 - radius, width / 2 + radius, height / 2 + radius),
        fill=255,
    )
    mask = mask.filter(ImageFilter.GaussianBlur(max(0.8, SCRIM_EDGE * min(width, height))))
    # Brightness is a per-channel multiply, which is exactly the inverse of
    # compositing black at an opacity. Nothing clips: the brightest a pixel can
    # be under a 40% scrim is 153, and 153 × 1.66 is 255.
    return Image.composite(ImageEnhance.Brightness(img).enhance(gain), img, mask), gain


def _glyph_mask(img: Image.Image) -> Image.Image | None:
    """The triangle's own shape, grown enough to swallow its antialiased rim.

    Thresholded at the same 235 the detector uses. Lower thresholds start
    catching bright food — at 200 the box grew from 33×36 to 64×114 and would
    have erased a piece of chicken.
    """
    width, height = img.size
    short = min(width, height)
    red, green, blue = img.split()
    darkest = ImageChops.darker(ImageChops.darker(red, green), blue)
    mask = darkest.point(lambda v: 255 if v >= PLAY_WHITE else 0)

    # Confined to the middle, so a white plate at the edge of the frame can
    # never join the mask even if the detector has already said yes.
    keep = Image.new("L", (width, height), 0)
    limit = GLYPH_MAX * short
    ImageDraw.Draw(keep).ellipse(
        (width / 2 - limit, height / 2 - limit, width / 2 + limit, height / 2 + limit), fill=255
    )
    mask = ImageChops.darker(mask, keep)

    box = mask.getbbox()
    if not box:
        return None
    if box[2] - box[0] > GLYPH_MAX * short or box[3] - box[1] > GLYPH_MAX * short:
        # Whatever that is, it is bigger than a play button. Better to leave a
        # glyph in place than to erase somebody's dinner.
        return None

    # Dilated inside the glyph's own neighbourhood, never across the frame.
    # MaxFilter is O(kernel²) per pixel, so growing an 11px rim over a whole
    # 960×1702 photo is 800 million comparisons and took 835 ms — the single
    # most expensive thing in the mirror. Cropped first it is under 30.
    grow = max(1, int(GLYPH_GROW * short))
    pad = grow + 2
    near = (
        max(0, box[0] - pad),
        max(0, box[1] - pad),
        min(width, box[2] + pad),
        min(height, box[3] + pad),
    )
    grown = Image.new("L", (width, height), 0)
    grown.paste(mask.crop(near).filter(ImageFilter.MaxFilter(grow * 2 + 1)), near[:2])
    return grown


def strip_play_glyph(img: Image.Image) -> tuple[Image.Image, bool]:
    """Undo Instagram's reel overlay. Returns (image, changed).

    Two steps, in this order and for the reason in the block comment above: the
    dark disc is divided back out, then what is left of the triangle is filled.
    Filling first means filling from a rim that is still darkened.
    """
    if not has_play_glyph(img):
        return img, False

    lit, gain = _unscrim(img)
    mask = _glyph_mask(lit)
    if mask is None:
        return lit, gain > 1.0

    box = mask.getbbox()
    short = min(img.size)
    pad = int(max(box[2] - box[0], box[3] - box[1]) * 0.9)
    region_box = (
        max(0, box[0] - pad),
        max(0, box[1] - pad),
        min(img.size[0], box[2] + pad),
        min(img.size[1], box[3] + pad),
    )
    region = lit.crop(region_box)
    hole = mask.crop(region_box)
    radius = max(2.0, (box[2] - box[0]) * PLAY_RADIUS)

    # Diffusion. Composite pastes the untouched photo back over everything
    # outside the hole after each blur, so the only thing that survives from one
    # pass to the next inside the hole is colour that came from its edge.
    fill = region
    for _ in range(PLAY_ITERATIONS):
        fill = Image.composite(fill.filter(ImageFilter.GaussianBlur(radius)), region, hole)

    # Colour is right by now but the fill is smooth, and smooth in the middle of
    # fried chicken reads as a smudge. The grain of a clean patch of the same
    # photo is added on top — its high frequencies only, so none of its own
    # colour comes with it.
    span = region_box[3] - region_box[1]
    donor_top = region_box[1] - int(span * PLAY_DONOR_SHIFT)
    if donor_top < 0:
        donor_top = region_box[1] + int(span * PLAY_DONOR_SHIFT)
    if 0 <= donor_top and donor_top + span <= img.size[1]:
        donor = lit.crop((region_box[0], donor_top, region_box[2], donor_top + span))
        grain = ImageChops.subtract(donor, donor.filter(ImageFilter.GaussianBlur(radius)), 1, 128)
        fill = ImageChops.add(fill, grain, 1, -128)

    soft = hole.filter(ImageFilter.GaussianBlur(max(1.0, GLYPH_SOFT * short)))
    patched = lit.copy()
    patched.paste(Image.composite(fill, region, soft), region_box[:2])
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


def mirror_image(user_id: str, recipe_id: str, source_url: str) -> dict:
    """Fetch, resize and store one recipe photo. Returns the columns to save."""
    # Both go straight into an object path. They are already validated upstream,
    # but a traversal here would write outside the caller's own folder.
    user_id = str(uuid.UUID(user_id))
    recipe_id = str(uuid.UUID(recipe_id))
    source_url = _resolve_source(source_url)

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
