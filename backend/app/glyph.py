"""Removing Instagram's play-button overlay from a reel's cover image.

Lifted out of images.py, which was a fetch/resize/upload pipeline with 260 lines
of image forensics sitting in the middle of it. The seam is exact: nothing here
needs anything from images.py, and images.py needs one name back, `strip_play_glyph`.

The measurements and the reasoning behind every constant are in the comments
below, and `tests/test_play_glyph.py` pins them. The short version is that the
overlay is two things — an invertible flat multiply (the disc) and destroyed
pixels (the triangle) — and treating them as one hole is what the discarded v2
pipeline did wrong.
"""

import math
import statistics

from PIL import (
    Image,
    ImageChops,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
)


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
