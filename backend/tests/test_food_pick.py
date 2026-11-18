"""H1 + H4: a social import's cover is cut down to the food, or dropped.

The picker may only ever make a first mirror better or remove a cover with no
clean food in it. Any failure of its own (model, budget, cap, a nonsense box)
must leave the mirror exactly as it was before this existed.
"""

import io
import os
import sys
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import images  # noqa: E402
from app.ai import PICK_SCHEMA, AIError  # noqa: E402

USER = "11111111-1111-4111-8111-111111111111"
RECIPE = "22222222-2222-4222-8222-222222222222"


def cover(w=360, h=640):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, format="JPEG")
    return buf.getvalue()


class FoodCrop(unittest.TestCase):
    def test_the_box_is_cut_exactly(self):
        img = Image.new("RGB", (400, 800))
        out = images.food_crop(img, {"left": 10, "top": 50, "right": 90, "bottom": 80})
        self.assertEqual(out.size, (320, 240))

    def test_edges_past_the_frame_are_clamped(self):
        img = Image.new("RGB", (400, 800))
        out = images.food_crop(img, {"left": -20, "top": 40, "right": 140, "bottom": 70})
        self.assertEqual(out.size, (400, 240))

    def test_a_sliver_or_an_inverted_box_is_refused(self):
        img = Image.new("RGB", (400, 800))
        self.assertIsNone(images.food_crop(img, {"left": 40, "top": 40, "right": 50, "bottom": 90}))
        self.assertIsNone(images.food_crop(img, {"left": 90, "top": 90, "right": 10, "bottom": 10}))
        self.assertIsNone(images.food_crop(img, {"verdict": "crop"}))


class MirrorWithPicker(unittest.TestCase):
    def _mirror(self, picker):
        stored = {}

        def fake_store(user_id, recipe_id, img, bust=None):
            stored["size"] = img.size
            return {"image_url": "lg", "image_thumb_url": "sm", "image_blur": "b"}

        with patch("app.images.fetch_bytes", return_value=(cover(), "image/jpeg")), patch(
            "app.images._store", side_effect=fake_store
        ) as store:
            result = images.mirror_image(USER, RECIPE, "https://cdn.example.com/c.jpg", picker=picker)
        return result, store, stored

    def test_a_crop_stores_only_the_food(self):
        result, _, stored = self._mirror(lambda *_: {"verdict": "crop", "left": 0, "top": 50, "right": 100, "bottom": 80})
        self.assertEqual(stored["size"], (360, 192))
        self.assertEqual(result["image_url"], "lg")

    def test_no_clean_food_stores_nothing_and_returns_nulls(self):
        result, store, _ = self._mirror(lambda *_: {"verdict": "none", "left": 0, "top": 0, "right": 0, "bottom": 0})
        store.assert_not_called()
        self.assertEqual(result, {"image_url": None, "image_thumb_url": None, "image_blur": None})

    def test_a_failed_pick_keeps_the_whole_cover(self):
        def broken(*_):
            raise AIError("down")

        _, _, stored = self._mirror(broken)
        self.assertEqual(stored["size"], (360, 640))

    def test_a_nonsense_box_keeps_the_whole_cover(self):
        _, _, stored = self._mirror(lambda *_: {"verdict": "crop", "left": 0, "top": 0, "right": 5, "bottom": 5})
        self.assertEqual(stored["size"], (360, 640))

    def test_without_a_picker_nothing_changes(self):
        _, _, stored = self._mirror(None)
        self.assertEqual(stored["size"], (360, 640))


class WhenThePickerRuns(unittest.TestCase):
    def _picker(self, post_url, *, ai=True, over_cap=False):
        from app import main

        def meter(_request):
            if over_cap:
                raise HTTPException(status_code=429)

        with patch("app.main.ai_available", return_value=ai), patch("app.main.meter_caller", side_effect=meter) as m:
            return main._food_picker(post_url, object()), m

    def test_a_tiktok_or_instagram_post_is_picked_and_metered(self):
        from app.ai import pick_food_crop

        for url in ("https://www.tiktok.com/@a/video/1", "https://www.instagram.com/reel/abc/"):
            picker, meter = self._picker(url)
            self.assertIs(picker, pick_food_crop)
            meter.assert_called_once()

    def test_no_post_a_web_page_or_no_model_is_never_picked_or_metered(self):
        for url, ai in ((None, True), ("https://example.com/recipe", True), ("https://www.tiktok.com/@a/video/1", False)):
            picker, meter = self._picker(url, ai=ai)
            self.assertIsNone(picker)
            meter.assert_not_called()

    def test_over_the_cap_the_mirror_still_goes_ahead(self):
        picker, _ = self._picker("https://www.tiktok.com/@a/video/1", over_cap=True)
        self.assertIsNone(picker)


class PickSchema(unittest.TestCase):
    def test_it_follows_the_structured_output_rules(self):
        self.assertIs(PICK_SCHEMA["additionalProperties"], False)
        self.assertEqual(sorted(PICK_SCHEMA["required"]), sorted(PICK_SCHEMA["properties"]))


if __name__ == "__main__":
    unittest.main()
