"""Taking Instagram's reel overlay back out of a cover photo.

A reel's og:image is not the cover frame — Instagram composites a flat black
disc at 40% and a white play triangle inside it, and says so in the URL
(`stp=cmp1_…`). The URL is signed, so no rewrite of that parameter fetches a
clean version and the logged-out page carries no other image. The pixels are the
only thing left to fix.

Two halves, tested separately because only one of them is guesswork. The disc is
a flat multiply and is *divided back out* exactly; the triangle is genuinely
destroyed and has to be filled. Getting that split wrong is what the first
version did — it filled the whole overlay as one hole, from a rim that was
itself darkened, and put a dark smooth circle where the play button had been.

The rest is about what must be left alone. This runs on every photo that reaches
the mirror, so a false positive erases part of somebody's dinner.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, ImageDraw, ImageEnhance  # noqa: E402


def photo(size=(361, 640), shade=(120, 90, 60)):
    """A plausible food photo: mid-tone, textured, nothing near white."""
    img = Image.new("RGB", size, shade)
    draw = ImageDraw.Draw(img)
    # Texture, so the donor patch has something to copy and the surround
    # reading isn't a flat fill that would pass any test by accident.
    for y in range(0, size[1], 7):
        draw.line([(0, y), (size[0], y)], fill=(shade[0] + 40, shade[1] + 30, shade[2] + 20))
    return img


SCRIM_ALPHA = 0.40


def with_scrim(img, alpha=SCRIM_ALPHA):
    """The dark disc, composited the way Instagram composites it.

    Flat black at 40% over a circle of radius 0.1395 of the short edge, hard
    edged. Measured off a real reel cover: median luma 64 inside against 109
    outside, the ratio flat at every radius from the centre to the rim, and full
    strength at r=0.136 with nothing left by r=0.143.
    """
    from app.glyph import SCRIM_RADIUS

    width, height = img.size
    r = SCRIM_RADIUS * min(width, height)
    dark = ImageEnhance.Brightness(img).enhance(1 - alpha)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).ellipse(
        (width / 2 - r, height / 2 - r, width / 2 + r, height / 2 + r), fill=255
    )
    return Image.composite(dark, img, mask)


def with_triangle(img):
    """The white play triangle, at the exact centre.

    Sized against the real thing rather than guessed. The cover this was built
    from reads 0.96 white in the inner probe and 0.05 in the outer one; a plain
    thin triangle only reaches 0.78, because the glyph Instagram draws is
    rounded and much fatter than its outline. Hence the stroke width — without
    it this fixture tests a shape that never occurs.
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


def with_play_glyph(img, scrim=True):
    """A reel cover: the disc, then the triangle inside it. Order matters."""
    return with_triangle(with_scrim(img) if scrim else img)


class Detection(unittest.TestCase):
    def test_a_reel_cover_is_recognised(self):
        from app.glyph import has_play_glyph

        self.assertTrue(has_play_glyph(with_play_glyph(photo())))

    def test_an_ordinary_photo_is_left_alone(self):
        from app.glyph import has_play_glyph

        self.assertFalse(has_play_glyph(photo()))

    def test_a_white_plate_is_not_a_play_button(self):
        """The reading that makes this safe to run on everything.

        A solid white centre on its own describes a plate shot from above just
        as well as it describes the glyph. What separates them is that the plate
        keeps being white on the way out and the glyph stops abruptly, which is
        what the second, wider reading is for.
        """
        from app.glyph import has_play_glyph

        img = photo()
        width, height = img.size
        radius = int(min(width, height) * 0.4)
        ImageDraw.Draw(img).ellipse(
            (width // 2 - radius, height // 2 - radius, width // 2 + radius, height // 2 + radius),
            fill=(252, 252, 250),
        )
        self.assertFalse(has_play_glyph(img))

    def test_a_thumbnail_too_small_to_judge_is_left_alone(self):
        from app.glyph import has_play_glyph

        self.assertFalse(has_play_glyph(with_play_glyph(photo(size=(80, 80)))))


class Scrim(unittest.TestCase):
    """Dividing the dark disc back out.

    This is the half that made the difference and it invents nothing: a flat
    multiply is exactly invertible, so the real photo comes back. The first
    version of this file's subject filled the whole disc by diffusion instead,
    which pulled its colour from a rim that was itself darkened — a dark smooth
    circle in the middle of the food, which is the artifact it was removing.
    """

    def _luma(self, img, lo, hi):
        from app.glyph import _band_luma

        return _band_luma(img, lo, hi)

    def test_the_disc_is_measured_at_its_real_strength(self):
        from app.glyph import _unscrim

        _, gain = _unscrim(with_scrim(photo()))
        self.assertAlmostEqual(gain, 1 / (1 - SCRIM_ALPHA), delta=0.06)

    def test_the_photo_underneath_comes_back(self):
        from app.glyph import _unscrim

        clean = photo()
        lit, _ = _unscrim(with_scrim(clean))
        # Inside the disc, within a couple of levels of the original.
        before = self._luma(clean, 0.05, 0.12)
        after = self._luma(lit, 0.05, 0.12)
        self.assertAlmostEqual(before, after, delta=4)

    def test_no_step_is_left_at_the_edge(self):
        # A ring is what a wrong gain looks like, and it is more obvious than
        # the disc it replaced.
        from app.glyph import _unscrim

        lit, _ = _unscrim(with_scrim(photo()))
        self.assertAlmostEqual(self._luma(lit, 0.11, 0.13), self._luma(lit, 0.15, 0.17), delta=6)

    def test_a_cover_with_no_disc_is_not_brightened(self):
        # Load-bearing. Applying the gain where there is nothing to undo paints
        # a bright circle — a worse artifact than the one being removed, and on
        # photos that were never broken.
        from app.glyph import _unscrim

        clean = photo()
        lit, gain = _unscrim(clean)
        self.assertEqual(gain, 1.0)
        self.assertIs(lit, clean)


class Stripping(unittest.TestCase):
    def _centre_white(self, img):
        from app.glyph import PLAY_PROBE, _white_fraction

        return _white_fraction(img, PLAY_PROBE)

    def test_the_triangle_is_gone_afterwards(self):
        from app.glyph import strip_play_glyph

        original = with_play_glyph(photo())
        self.assertGreater(self._centre_white(original), 0.85)

        patched, changed = strip_play_glyph(original)
        self.assertTrue(changed)
        self.assertLess(self._centre_white(patched), 0.05)

    def test_running_it_twice_changes_nothing_the_second_time(self):
        # The backfill re-mirrors every Instagram recipe once, and a device that
        # syncs late runs it again. Idempotence is what makes that harmless.
        from app.glyph import strip_play_glyph

        once, _ = strip_play_glyph(with_play_glyph(photo()))
        twice, changed = strip_play_glyph(once)
        self.assertFalse(changed)
        self.assertEqual(once.tobytes(), twice.tobytes())

    def test_an_ordinary_photo_comes_back_untouched(self):
        from app.glyph import strip_play_glyph

        original = photo()
        result, changed = strip_play_glyph(original)
        self.assertFalse(changed)
        self.assertIs(result, original)

    def test_the_patch_only_covers_the_middle(self):
        """The corners of the frame are the food; they must not move."""
        from app.glyph import strip_play_glyph

        original = with_play_glyph(photo())
        patched, _ = strip_play_glyph(original)
        width, height = original.size
        for x, y in ((4, 4), (width - 5, 4), (4, height - 5), (width - 5, height - 5)):
            self.assertEqual(original.getpixel((x, y)), patched.getpixel((x, y)))

    def test_the_fill_is_fitted_to_the_glyph_and_not_much_bigger(self):
        """The whole point of the second version: touch as little as possible.

        A circle 20% of the short edge — the first version's hole — covers 1.8%
        of the frame. The glyph's own dilated shape covers well under half that,
        and unlike the circle it cannot miss the triangle's tip, which sits
        right of centre because the glyph is optically centred rather than
        bounding-box centred.
        """
        import math

        from app.glyph import _glyph_mask, _unscrim

        lit, _ = _unscrim(with_play_glyph(photo()))
        width, height = lit.size
        covered = _glyph_mask(lit).histogram()[255] / (width * height)
        # What the old hole cost, computed rather than quoted so the comparison
        # stays honest if the fixture's glyph is resized.
        circle = math.pi * (0.10 * min(width, height)) ** 2 / (width * height)
        self.assertLess(covered, circle * 0.6, f"{covered:.4f} against a circle's {circle:.4f}")

    def test_a_white_shape_too_big_to_be_a_glyph_is_left_alone(self):
        # The mask is a threshold, so something genuinely white and central
        # would otherwise be erased wholesale. Better a play button than a hole
        # where the dinner was.
        from app.glyph import _glyph_mask

        img = photo()
        width, height = img.size
        r = int(min(width, height) * 0.19)
        ImageDraw.Draw(img).ellipse(
            (width // 2 - r, height // 2 - r, width // 2 + r, height // 2 + r), fill=(255, 255, 255)
        )
        self.assertIsNone(_glyph_mask(img))


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
