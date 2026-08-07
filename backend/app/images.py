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
from PIL import Image, ImageOps, UnidentifiedImageError

from .extract import ExtractError, fetch_bytes

log = logging.getLogger("recipe.images")

BUCKET = "recipe-images"
TIMEOUT = 15.0

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

    return f"{url}/storage/v1/object/public/{BUCKET}/{path}"


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
    blur = _blur_data_uri(img)
    lg = _upload(f"{user_id}/{recipe_id}-lg.jpg", _encode(img, WIDTHS["lg"], 82))
    sm = _upload(f"{user_id}/{recipe_id}-sm.jpg", _encode(img, WIDTHS["sm"], 80))

    return {"image_url": lg, "image_thumb_url": sm, "image_blur": blur}
