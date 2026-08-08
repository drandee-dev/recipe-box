"""Regenerate the icon set in frontend/public.

Run from the frontend directory: python scripts/icons.py
Needs Pillow, plus fontTools and brotli to read the app's own .woff2 face.

The mark is wordmark 2 reduced to fit a square: a hairline over, a slab under,
and "RB" resting on the slab. The asymmetry is the whole idea — it reads as
something sitting inside a container, so the two rules are the box and the word
is the card filed in it. The wordmark itself is set in Clash Display Semibold,
and so is this: the face is decompressed out of `public/fonts` rather than
approximated in Arial, which is what the previous version of this script did.

Every proportion is lifted from `.rb-wordmark` in `index.css` and expressed
against the font size, so the two cannot drift. The one addition is a floor on
the thin rule as a fraction of the *tile* rather than of the font size — the
stylesheet has the same floor for the same reason (0.055em of 24px is 1.32px,
which a phone renders as a grey smear), and a launcher shrinking a 192px icon
into a 48px slot is that problem again.

Three shapes, because the platforms want different things and one file cannot be
all of them:

  pwa-192 / pwa-512      purpose "any" — used as-is (install dialogs, task
                         switcher, desktop), so the corners are rounded here and
                         transparent outside them.
  pwa-maskable-*         purpose "maskable" — Android crops this to whatever
                         shape the launcher uses, so the background is full bleed
                         and the mark sits inside the 80% safe circle. The
                         binding constraint is the lockup's *diagonal*, not its
                         height, because the safe zone is a circle.
  apple-touch-icon       iOS applies its own squircle and paints transparency
                         black, so this one is an opaque square.

Declaring one file as "any maskable" is the usual mistake: it is either clipped
when masked or floating in padding when it isn't.

favicon.svg is written from the same measurements, with the letterforms as a
path rather than as text — a tab has no Clash Display, and `font-family` there
would silently fall back to Arial and undo the point of the exercise.
"""

import math
import tempfile
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import decompress
from PIL import Image, ImageDraw, ImageFont

GREEN = (28, 124, 84)  # --accent
WHITE = (255, 255, 255)
WOFF2 = "public/fonts/ClashDisplay-Semibold.woff2"
WORD = "RB"
OUT = "public"

# Supersampling factor. Pillow has no anti-aliased shape drawing, so shapes are
# drawn large and the result is downscaled.
SS = 8

# --- .rb-wordmark, as ratios of the font size -------------------------------
RULE_TOP = 0.055  # border-top
PAD_TOP = 0.40  # padding-top
PAD_BOTTOM = 0.17  # padding-bottom
RULE_BOTTOM = 0.20  # border-bottom
TRACKING = -0.018  # letter-spacing

# The em box itself is 1.0 tall at line-height: 1, so the whole lockup is:
LOCKUP = RULE_TOP + PAD_TOP + 1.0 + PAD_BOTTOM + RULE_BOTTOM

# A thin rule may never fall below this fraction of the finished tile, whatever
# the maths says. Same floor the stylesheet keeps, one scale down.
MIN_RULE = 0.016


def _ttf_path():
    """Clash Display as something Pillow and fontTools can both open."""
    out = Path(tempfile.gettempdir()) / "recipebox-clash-semibold.ttf"
    if not out.exists():
        decompress(WOFF2, str(out))
    return str(out)


def _advances(font, draw):
    """Per-glyph advance widths, so tracking can be applied between them."""
    return [draw.textlength(ch, font=font) for ch in WORD]


def lockup(size, height_frac, radius_pct, opaque):
    """Green tile carrying the wordmark lockup.

    height_frac is the lockup's height as a fraction of the tile, which is how
    the maskable safe zone is honoured. radius_pct is the corner radius as a
    fraction of the side; 0 is a plain square.
    """
    px = size * SS
    img = Image.new("RGBA", (px, px), GREEN + (255,) if opaque else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if not opaque:
        radius = int(px * radius_pct)
        draw.rounded_rectangle([0, 0, px - 1, px - 1], radius=radius, fill=GREEN + (255,))

    s = px * height_frac / LOCKUP  # the font size the ratios above hang off
    font = ImageFont.truetype(_ttf_path(), int(round(s)))

    advances = _advances(font, draw)
    tracking = s * TRACKING
    # CSS adds letter-spacing after every character including the last, which is
    # what sets the width the rules are drawn to.
    width = sum(advances) + tracking * len(WORD)

    rule_top = max(s * RULE_TOP, px * MIN_RULE)
    rule_bottom = s * RULE_BOTTOM
    total = rule_top + s * PAD_TOP + s + s * PAD_BOTTOM + rule_bottom

    x0 = (px - width) / 2
    y = (px - total) / 2

    draw.rectangle([x0, y, x0 + width, y + rule_top], fill=WHITE)
    y += rule_top + s * PAD_TOP

    # Baseline exactly where CSS puts it at line-height: 1 — the font's own
    # ascent+descent box centred on a content box one font-size tall, with the
    # baseline an ascent below the top of that box.
    ascent, descent = font.getmetrics()
    baseline = y + (s - (ascent + descent)) / 2 + ascent
    x = x0
    for ch, advance in zip(WORD, advances):
        draw.text((x, baseline), ch, font=font, fill=WHITE, anchor="ls")
        x += advance + tracking

    y += s + s * PAD_BOTTOM
    draw.rectangle([x0, y, x0 + width, y + rule_bottom], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def safe_height_frac():
    """The tallest lockup whose corners still sit inside the maskable safe zone.

    The safe zone is a circle of diameter 0.8×side, and this lockup is portrait,
    so it is the DIAGONAL that has to fit — sizing by height alone puts the ends
    of the two rules outside the circle on any launcher that crops to one.
    """
    reference = 1000.0
    s = reference / LOCKUP
    font = ImageFont.truetype(_ttf_path(), int(round(s)))
    draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    width = sum(draw.textlength(ch, font=font) for ch in WORD) + s * TRACKING * len(WORD)
    ratio = width / reference  # mark width per unit of lockup height
    # 0.74 rather than the safe zone's own 0.8: sizing to the circle exactly puts
    # the ends of both rules flush against it, which survives the crop and still
    # looks like it barely fitted.
    return 0.74 / math.sqrt(1 + ratio * ratio)


def favicon_svg(side=64, height_frac=0.62, radius=14):
    """The same lockup, with the letterforms as a path.

    A browser tab has no Clash Display, so `font-family` here would fall back to
    Arial and quietly undo the whole point. The outlines travel with the file.
    """
    ttf = _ttf_path()
    face = TTFont(ttf)
    upem = face["head"].unitsPerEm
    glyphs = face.getGlyphSet()
    cmap = face.getBestCmap()
    hmtx = face["hmtx"]
    names = [cmap[ord(ch)] for ch in WORD]

    s = side * height_frac / LOCKUP
    scale = s / upem
    advances = [hmtx[n][0] * scale for n in names]
    tracking = s * TRACKING
    width = sum(advances) + tracking * len(WORD)

    rule_top = max(s * RULE_TOP, side * MIN_RULE)
    rule_bottom = s * RULE_BOTTOM
    total = rule_top + s * PAD_TOP + s + s * PAD_BOTTOM + rule_bottom

    x0 = (side - width) / 2
    y = (side - total) / 2
    top_y = y
    y += rule_top + s * PAD_TOP

    ascender = face["hhea"].ascent * scale
    descender = -face["hhea"].descent * scale
    baseline = y + (s - (ascender + descender)) / 2 + ascender

    paths = []
    x = x0
    for name, advance in zip(names, advances):
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        d = pen.getCommands()
        if d:
            # The font's y axis points up from the baseline; SVG's points down.
            paths.append(
                f'<path d="{d}" transform="translate({x:.3f} {baseline:.3f}) '
                f'scale({scale:.6f} {-scale:.6f})"/>'
            )
        x += advance + tracking

    bottom_y = y + s + s * PAD_BOTTOM
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" '
        f'role="img" aria-label="Recipe Box">\n'
        f'  <rect width="{side}" height="{side}" rx="{radius}" fill="#1c7c54"/>\n'
        f'  <g fill="#fff">\n'
        f'    <rect x="{x0:.3f}" y="{top_y:.3f}" width="{width:.3f}" height="{rule_top:.3f}"/>\n'
        f'    {"".join(paths)}\n'
        f'    <rect x="{x0:.3f}" y="{bottom_y:.3f}" width="{width:.3f}" '
        f'height="{rule_bottom:.3f}"/>\n'
        f'  </g>\n'
        f'</svg>\n'
    )


def save(img, name):
    img.save(f"{OUT}/{name}", optimize=True)
    print(f"{OUT}/{name}  {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    # "any": rounded, transparent corners, mark near the edges.
    for size in (192, 512):
        save(lockup(size, height_frac=0.62, radius_pct=0.22, opaque=False), f"pwa-{size}.png")

    # "maskable": full bleed. A round mask keeps a circle of diameter 0.8×side,
    # and the lockup is portrait, so it is the DIAGONAL that has to fit inside
    # it — sizing this by height alone puts the corners of the mark outside the
    # safe zone on a launcher that crops to a circle.
    safe = safe_height_frac()
    for size in (192, 512):
        save(lockup(size, height_frac=safe, radius_pct=0, opaque=True), f"pwa-maskable-{size}.png")

    # iOS masks this itself; the inset keeps the mark clear of the squircle.
    save(lockup(180, height_frac=0.56, radius_pct=0, opaque=True), "apple-touch-icon.png")

    # Browser-tab fallback for anything that won't take favicon.svg.
    save(lockup(96, height_frac=0.68, radius_pct=0.22, opaque=False), "favicon-96.png")

    Path(f"{OUT}/favicon.svg").write_text(favicon_svg(), encoding="utf-8")
    print(f"{OUT}/favicon.svg")
