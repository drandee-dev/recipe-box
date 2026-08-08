"""Taking Instagram's play triangle back out of a reel cover.

A reel's og:image is not the cover frame — Instagram composites a white play
triangle into the JPEG before serving it, and says so in the URL (`stp=cmp1_…`).
The URL is signed, so no rewrite of that parameter fetches a clean version, and
the logged-out page carries no other image. The pixels are the only thing left
to fix.

What matters here is the detector, not the patch. The patch runs on every photo
that reaches the mirror, so a false positive smears a blurred hole into the
middle of somebody's dinner. These tests are mostly about what must be left
alone.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, ImageDraw  # noqa: E402


def photo(size=(361, 640), shade=(120, 90, 60)):
    """A plausible food photo: mid-tone, textured, nothing near white."""
    img = Image.new("RGB", size, shade)
    draw = ImageDraw.Draw(img)
    # Texture, so the donor patch has something to copy and the surround
    # reading isn't a flat fill that would pass any test by accident.
    for y in range(0, size[1], 7):
        draw.line([(0, y), (size[0], y)], fill=(shade[0] + 40, shade[1] + 30, shade[2] + 20))
    return img


def with_play_glyph(img):
    """The composite, near enough: a solid white triangle at the exact centre.

    Sized against the real thing rather than guessed. The cover for the reel
    this was built from reads 0.96 white in the inner probe and 0.05 in the
    outer one; a plain thin triangle only reaches 0.78, because the glyph
    Instagram draws is rounded and much fatter than its outline. Hence the
    stroke width — without it this fixture tests a shape that never occurs.
    """
    width, height = img.size
    half = int(min(width, height) * 0.07)
    cx, cy = width // 2, height // 2
    ImageDraw.Draw(img).polygon(
        [(cx - half, cy - half), (cx - half, cy + half), (cx + half, cy)],
        fill=(255, 255, 255),
        outline=(255, 255, 255),
        width=max(1, half // 2),
    )
    return img


class Detection(unittest.TestCase):
    def test_a_reel_cover_is_recognised(self):
        from app.images import has_play_glyph

        self.assertTrue(has_play_glyph(with_play_glyph(photo())))

    def test_an_ordinary_photo_is_left_alone(self):
        from app.images import has_play_glyph

        self.assertFalse(has_play_glyph(photo()))

    def test_a_white_plate_is_not_a_play_button(self):
        """The reading that makes this safe to run on everything.

        A solid white centre on its own describes a plate shot from above just
        as well as it describes the glyph. What separates them is that the plate
        keeps being white on the way out and the glyph stops abruptly, which is
        what the second, wider reading is for.
        """
        from app.images import has_play_glyph

        img = photo()
        width, height = img.size
        radius = int(min(width, height) * 0.4)
        ImageDraw.Draw(img).ellipse(
            (width // 2 - radius, height // 2 - radius, width // 2 + radius, height // 2 + radius),
            fill=(252, 252, 250),
        )
        self.assertFalse(has_play_glyph(img))

    def test_a_thumbnail_too_small_to_judge_is_left_alone(self):
        from app.images import has_play_glyph

        self.assertFalse(has_play_glyph(with_play_glyph(photo(size=(80, 80)))))


class Stripping(unittest.TestCase):
    def _centre_white(self, img):
        from app.images import PLAY_PROBE, _white_fraction

        return _white_fraction(img, PLAY_PROBE)

    def test_the_triangle_is_gone_afterwards(self):
        from app.images import strip_play_glyph

        original = with_play_glyph(photo())
        self.assertGreater(self._centre_white(original), 0.85)

        patched, changed = strip_play_glyph(original)
        self.assertTrue(changed)
        self.assertLess(self._centre_white(patched), 0.05)

    def test_running_it_twice_changes_nothing_the_second_time(self):
        # The backfill re-mirrors every Instagram recipe once, and a device that
        # syncs late runs it again. Idempotence is what makes that harmless.
        from app.images import strip_play_glyph

        once, _ = strip_play_glyph(with_play_glyph(photo()))
        twice, changed = strip_play_glyph(once)
        self.assertFalse(changed)
        self.assertEqual(once.tobytes(), twice.tobytes())

    def test_an_ordinary_photo_comes_back_untouched(self):
        from app.images import strip_play_glyph

        original = photo()
        result, changed = strip_play_glyph(original)
        self.assertFalse(changed)
        self.assertIs(result, original)

    def test_the_patch_only_covers_the_middle(self):
        """The corners of the frame are the food; they must not move."""
        from app.images import strip_play_glyph

        original = with_play_glyph(photo())
        patched, _ = strip_play_glyph(original)
        width, height = original.size
        for x, y in ((4, 4), (width - 5, 4), (4, height - 5), (width - 5, height - 5)):
            self.assertEqual(original.getpixel((x, y)), patched.getpixel((x, y)))


class MirrorVersion(unittest.TestCase):
    """The `?v=N` that rides in the public URL.

    It is doing three jobs, and losing it breaks all three quietly: the object
    is overwritten in place under a year-long immutable cache, the client tells
    an old mirror from a current one by reading the URL rather than a flag, and
    the repair pass needs to know when to stop.
    """

    def test_the_public_url_carries_the_pipeline_version(self):
        from unittest.mock import MagicMock, patch

        from app.images import MIRROR_VERSION, _upload

        resp = MagicMock()
        resp.status_code = 200
        with patch.dict(
            os.environ,
            {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"},
        ):
            with patch("httpx.Client") as ctor:
                ctor.return_value.__enter__.return_value.post.return_value = resp
                url = _upload("user/recipe-lg.jpg", b"bytes")

        self.assertTrue(url.endswith(f"?v={MIRROR_VERSION}"))
        self.assertIn("/storage/v1/object/public/recipe-images/user/recipe-lg.jpg", url)


if __name__ == "__main__":
    unittest.main()
