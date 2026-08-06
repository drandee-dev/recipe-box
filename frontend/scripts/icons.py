"""Regenerate the icon set in frontend/public.

Run from the frontend directory: python scripts/icons.py

Three shapes, because the platforms want different things and one file cannot be
all of them:

  pwa-192 / pwa-512      purpose "any" — used as-is (install dialogs, task
                         switcher, desktop), so the corners are rounded here and
                         transparent outside them.
  pwa-maskable-*         purpose "maskable" — Android crops this to whatever
                         shape the launcher uses, so the background is full bleed
                         and the wordmark sits inside the 80% safe circle.
  apple-touch-icon       iOS applies its own squircle and paints transparency
                         black, so this one is an opaque square.

Declaring one file as "any maskable" is the usual mistake: it is either clipped
when masked or floating in padding when it isn't.
"""

from PIL import Image, ImageDraw, ImageFont

GREEN = (28, 124, 84)
WHITE = (255, 255, 255)
FONT = "C:/Windows/Fonts/arialbd.ttf"
OUT = "public"

# Supersampling factor. Pillow has no anti-aliased shape drawing, so shapes are
# drawn large and the result is downscaled.
SS = 8


def wordmark(size, glyph_width, radius_pct, opaque):
    """Green tile with a centred white RB.

    glyph_width is the fraction of the tile the wordmark spans, which is how the
    maskable safe zone is honoured. radius_pct is the corner radius as a
    fraction of the side; 0 is a plain square.
    """
    px = size * SS
    img = Image.new("RGBA", (px, px), GREEN + (255,) if opaque else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if not opaque:
        radius = int(px * radius_pct)
        if radius > 0:
            draw.rounded_rectangle([0, 0, px - 1, px - 1], radius=radius, fill=GREEN + (255,))
        else:
            draw.rectangle([0, 0, px - 1, px - 1], fill=GREEN + (255,))

    # Size the font so the wordmark's ink box is exactly glyph_width of the tile.
    # Text width is linear in point size, so one measurement at a reference size
    # gives the scale factor; the second pass corrects for hinting rounding.
    target = px * glyph_width
    pt = 100
    for _ in range(2):
        font = ImageFont.truetype(FONT, pt)
        left, _, right, _ = draw.textbbox((0, 0), "RB", font=font)
        pt = max(1, round(pt * target / (right - left)))
    font = ImageFont.truetype(FONT, pt)

    # Centre on the ink box rather than the baseline — Arial's ascent leaves the
    # glyphs sitting visibly high otherwise.
    left, top, right, bottom = draw.textbbox((0, 0), "RB", font=font)
    x = (px - (right - left)) / 2 - left
    y = (px - (bottom - top)) / 2 - top
    draw.text((x, y), "RB", font=font, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    img.save(f"{OUT}/{name}", optimize=True)
    print(f"{OUT}/{name}  {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    # "any": rounded, transparent corners, wordmark near the edges.
    for size in (192, 512):
        save(wordmark(size, glyph_width=0.62, radius_pct=0.22, opaque=False), f"pwa-{size}.png")

    # "maskable": full bleed. A round mask keeps a circle of diameter 0.8×side,
    # so the wordmark is pulled in to fit inside it with room to spare.
    for size in (192, 512):
        save(wordmark(size, glyph_width=0.46, radius_pct=0, opaque=True), f"pwa-maskable-{size}.png")

    # iOS masks this itself; the inset keeps RB clear of the squircle's corners.
    save(wordmark(180, glyph_width=0.52, radius_pct=0, opaque=True), "apple-touch-icon.png")

    # Browser-tab fallback for anything that won't take favicon.svg.
    save(wordmark(96, glyph_width=0.74, radius_pct=0.22, opaque=False), "favicon-96.png")
