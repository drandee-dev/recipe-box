"""H1 + H4: a social import's cover is cut down to the food, or dropped.

The picker may only ever make a first mirror better or remove a cover with no
clean food in it. Any failure of its own (model, budget, cap, a nonsense box)
must leave the mirror exactly as it was before this existed.
"""

import io
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import images  # noqa: E402
from app.ai import CHECK_SCHEMA, PICK_SCHEMA, AIError  # noqa: E402

USER = "11111111-1111-4111-8111-111111111111"
RECIPE = "22222222-2222-4222-8222-222222222222"


def cover(w=360, h=640):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, format="JPEG")
    return buf.getvalue()


def box(left, top, right, bottom):
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def answer(food, text=(), people=(), verdict="food"):
    return {"verdict": verdict, "food": food, "text": list(text), "people": list(people)}


class FoodCrop(unittest.TestCase):
    img = Image.new("RGB", (400, 800))

    def test_a_clean_food_box_is_cut_exactly(self):
        out = images.food_crop(self.img, answer(box(10, 50, 90, 80)))
        self.assertEqual(out.size, (320, 240))

    def test_edges_past_the_frame_are_clamped(self):
        out = images.food_crop(self.img, answer(box(-20, 40, 140, 70)))
        self.assertEqual(out.size, (400, 240))

    def test_a_caption_across_the_food_is_cut_round(self):
        # Food 20-90% tall, caption band at 40-50% (38-52 padded): the part below it is bigger.
        out = images.food_crop(self.img, answer(box(0, 20, 100, 90), text=[box(10, 40, 90, 50)]))
        self.assertEqual(out.size, (400, 304))

    def test_a_face_beside_the_food_is_cut_out(self):
        out = images.food_crop(self.img, answer(box(0, 30, 100, 70), people=[box(70, 0, 100, 60)]))
        self.assertEqual(out.size, (272, 320))

    def test_obstacle_boxes_are_padded_so_letter_edges_stay_out(self):
        # Caption drawn exactly on its letters at 0-50%: the crop starts 2% below it (52-100%).
        out = images.food_crop(self.img, answer(box(0, 0, 100, 100), text=[box(0, 0, 100, 50)]))
        self.assertEqual(out.size, (400, 384))

    def test_a_strip_wider_than_the_limit_is_no_food(self):
        # 100x16% of a 400x800 cover is 400x128, 3.1 wide: it would fill a 4:3 cell from 128 rows.
        self.assertIs(images.food_crop(self.img, answer(box(0, 40, 100, 56))), images.NO_FOOD)
        # 400x224 is 1.79 wide, like run 4's #2, and passes.
        self.assertEqual(images.food_crop(self.img, answer(box(0, 0, 100, 28))).size, (400, 224))
        # 400x184 is 2.17 wide, like run 5's #7, and passes (at 2.0 a sliver beat it).
        self.assertEqual(images.food_crop(self.img, answer(box(0, 0, 100, 23))).size, (400, 184))

    def test_text_covering_all_the_food_means_no_food(self):
        out = images.food_crop(self.img, answer(box(10, 40, 90, 70), text=[box(0, 35, 100, 75)]))
        self.assertIs(out, images.NO_FOOD)

    def test_overlapping_captions_are_both_cut_out(self):
        # Two caption boxes overlap at 50-55%; the clean piece below both (62-90% padded) wins.
        out = images.food_crop(self.img, answer(box(0, 20, 100, 90), text=[box(0, 40, 100, 55), box(0, 50, 100, 60)]))
        self.assertEqual(out.size, (400, 224))

    def test_the_piece_a_4_3_cell_shows_most_of_beats_the_bigger_one(self):
        # Text over the lower right (padded to 48-100 x 28-100) leaves a full-width top
        # strip (400x224) and a tall left column (192x800, more area). The cell shows
        # 299x224 of the strip but only 192x144 of the column, so the strip is kept.
        out = images.food_crop(self.img, answer(box(0, 0, 100, 100), text=[box(50, 30, 100, 100)]))
        self.assertEqual(out.size, (400, 224))

    def test_many_small_boxes_stay_bounded(self):
        dots = [box(x, y, x + 1, y + 1) for x in range(5, 95, 9) for y in range(5, 95, 9)]  # 100 boxes
        self.assertLessEqual(len(images._clean_pieces((0, 0, 100, 100), [images._pct_box(d) for d in dots])), images.MAX_PIECES)
        self.assertIsNotNone(images.food_crop(self.img, answer(box(0, 0, 100, 100), text=dots)))

    def test_a_reversed_caption_box_is_still_cut_round(self):
        # Same as the caption test with the caption's edges given backwards.
        out = images.food_crop(self.img, answer(box(0, 20, 100, 90), text=[box(90, 50, 10, 40)]))
        self.assertEqual(out.size, (400, 304))

    def test_a_malformed_or_empty_food_box_is_refused(self):
        self.assertIsNone(images.food_crop(self.img, answer(box(90, 90, 10, 10))))
        self.assertIsNone(images.food_crop(self.img, {"verdict": "food"}))

    def test_a_sliver_of_food_is_no_food(self):
        self.assertIs(images.food_crop(self.img, answer(box(40, 40, 50, 90))), images.NO_FOOD)


class MirrorWithPicker(unittest.TestCase):
    def _mirror(self, picker, data=None, checker=None):
        stored = {}

        def fake_store(user_id, recipe_id, img, bust=None):
            stored["size"] = img.size
            return {"image_url": "lg", "image_thumb_url": "sm", "image_blur": "b"}

        with patch("app.images.fetch_bytes", return_value=(data or cover(), "image/jpeg")), patch(
            "app.images._store", side_effect=fake_store
        ) as store:
            result = images.mirror_image(USER, RECIPE, "https://cdn.example.com/c.jpg", picker=picker, checker=checker)
        return result, store, stored

    def test_a_crop_the_second_look_rejects_gets_the_tile(self):
        # Cover #14: called food, cropped to the back of a hand.
        result, store, _ = self._mirror(lambda *_: answer(box(0, 50, 100, 80)), checker=lambda *_: False)
        store.assert_not_called()
        self.assertEqual(result, dict(images.NO_PHOTO))

    def test_the_second_look_sees_the_crop_not_the_cover(self):
        seen = {}

        def checker(b64, _mt):
            import base64

            seen["size"] = Image.open(io.BytesIO(base64.b64decode(b64))).size
            return True

        _, _, stored = self._mirror(lambda *_: answer(box(0, 50, 100, 80)), checker=checker)
        self.assertEqual(seen["size"], (360, 192))
        self.assertEqual(stored["size"], (360, 192))

    def test_a_failed_second_look_keeps_the_crop(self):
        def broken(*_):
            raise AIError("down")

        _, _, stored = self._mirror(lambda *_: answer(box(0, 50, 100, 80)), checker=broken)
        self.assertEqual(stored["size"], (360, 192))

    def test_the_second_look_runs_only_on_a_finished_crop(self):
        def broken(*_):
            raise AIError("down")

        no_crop = (
            lambda *_: answer(box(0, 0, 0, 0), verdict="none"),
            lambda *_: answer(box(10, 40, 90, 70), text=[box(0, 0, 100, 100)]),
            lambda *_: answer(box(50, 50, 10, 10)),
            broken,
        )
        for picker in no_crop:
            checker = MagicMock(return_value=True)
            self._mirror(picker, checker=checker)
            checker.assert_not_called()

    def test_a_crop_stores_only_the_food(self):
        result, _, stored = self._mirror(lambda *_: answer(box(0, 50, 100, 80)))
        self.assertEqual(stored["size"], (360, 192))
        self.assertEqual(result["image_url"], "lg")

    def test_no_food_stores_nothing_and_returns_nulls(self):
        result, store, _ = self._mirror(lambda *_: answer(box(0, 0, 0, 0), verdict="none"))
        store.assert_not_called()
        self.assertEqual(result, {"image_url": None, "image_thumb_url": None, "image_blur": None})

    def test_food_with_text_all_over_it_also_gets_the_tile(self):
        result, store, _ = self._mirror(lambda *_: answer(box(10, 40, 90, 70), text=[box(0, 0, 100, 100)]))
        store.assert_not_called()
        self.assertIsNone(result["image_url"])

    def test_a_failed_pick_keeps_the_whole_cover(self):
        def broken(*_):
            raise AIError("down")

        _, _, stored = self._mirror(broken)
        self.assertEqual(stored["size"], (360, 640))

    def test_a_malformed_answer_keeps_the_whole_cover(self):
        _, _, stored = self._mirror(lambda *_: answer(box(50, 50, 10, 10)))
        self.assertEqual(stored["size"], (360, 640))

    def test_junk_past_the_schema_keeps_the_whole_cover(self):
        for junk in ({**answer(box(0, 0, 100, 100)), "text": 5}, {**answer(box(0, 0, 100, 100)), "people": [{"left": float("inf"), "top": 0, "right": 1, "bottom": 1}]}, "not a dict"):
            _, _, stored = self._mirror(lambda *_, j=junk: j)
            self.assertEqual(stored["size"], (360, 640), junk)

    def test_the_model_sees_the_grid_but_the_stored_photo_does_not(self):
        seen = {}

        def picker(b64, _mt):
            import base64

            seen["img"] = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
            return answer(box(0, 0, 100, 100))

        _, _, stored = self._mirror(picker)
        # The flat test cover is one colour; a grid line on the model's copy is grey.
        w, h = seen["img"].size
        self.assertNotEqual(seen["img"].getpixel((w // 10, h // 2)), seen["img"].getpixel((w // 20, h // 2)))
        # Each line is numbered: white label text sits at the left edge just above the 50% line.
        band = seen["img"].crop((0, h // 2 - h // 25, w // 10, h // 2)).getdata()
        self.assertTrue(any(min(p) > 200 for p in band), "no line label on the model's copy")
        self.assertEqual(stored["size"], (360, 640))

    def test_the_grid_is_drawn_on_the_shrunk_copy(self):
        # A cover past the vision limit is shrunk first; the grid drawn after keeps its
        # 1px lines and label size instead of being resampled away.
        from app.ai import VISION_MAX_PX

        sizes = []
        real = images._grid
        with patch("app.images._grid", side_effect=lambda im: (sizes.append(im.size), real(im))[1]):
            self._mirror(lambda *_: answer(box(0, 0, 100, 100)), data=cover(1000, 2000))
        self.assertEqual(len(sizes), 1)
        self.assertLessEqual(max(sizes[0]), VISION_MAX_PX)

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

    def test_the_second_look_goes_wherever_the_picker_goes_and_nowhere_else(self):
        from app import main
        from app.ai import crop_shows_food, pick_food_crop

        self.assertIs(main._crop_checker(pick_food_crop), crop_shows_food)
        self.assertIsNone(main._crop_checker(None))

    def test_the_image_route_hands_the_second_look_to_the_mirror(self):
        from app import main
        from app.ai import crop_shows_food, pick_food_crop

        body = main.ImageRequest(recipe_id=RECIPE, url="https://cdn.example.com/c.jpg", post_url="https://www.tiktok.com/@a/video/1")
        for picker, want in ((pick_food_crop, crop_shows_food), (None, None)):
            with patch("app.main._photo_caller", return_value=USER), patch(
                "app.main._food_picker", return_value=picker
            ), patch("app.images.mirror_image", return_value={}) as mirror:
                main.recipe_image(body, object(), None)
            self.assertIs(mirror.call_args.kwargs["checker"], want)


POST = "https://www.tiktok.com/@a/video/1"


class Repair(unittest.TestCase):
    """The retro pass (his calls, 2026-11-19): a saved photo is redone with the
    pick, keeps a photo when there is no clean food, keeps our copy when the post
    is gone, and writes nothing when the model cannot be asked."""

    def _repair(self, picker, video=None, resolve=lambda url: "https://cdn.example.com/c.jpg"):
        stored, fetched = {}, []

        def fake_store(user_id, recipe_id, img, bust=None):
            stored["size"] = img.size
            return {"image_url": "lg", "image_thumb_url": "sm", "image_blur": "b"}

        def fake_fetch(url):
            fetched.append(url)
            return cover(), "image/jpeg"

        with patch("app.images._resolve_source", side_effect=resolve), patch(
            "app.images.fetch_bytes", side_effect=fake_fetch
        ), patch("app.images._store", side_effect=fake_store) as store, patch(
            "app.images._storage", return_value=("https://ref.supabase.co", "k")
        ):
            result = images.mirror_image(USER, RECIPE, POST, picker=picker, video=video, repair=True)
        return result, store, stored, fetched

    def test_a_crop_is_stored(self):
        _, _, stored, _ = self._repair(lambda *_: answer(box(0, 50, 100, 80)))
        self.assertEqual(stored["size"], (360, 192))

    def test_no_clean_food_keeps_the_whole_cover_not_the_tile(self):
        for picker in (lambda *_: answer(box(0, 0, 0, 0), verdict="none"), lambda *_: answer(box(10, 40, 90, 70), text=[box(0, 0, 100, 100)])):
            result, _, stored, _ = self._repair(picker, video=lambda: None)
            self.assertEqual(stored["size"], (360, 640))
            self.assertEqual(result["image_url"], "lg")

    def test_a_spent_budget_writes_nothing(self):
        from app.ai import AIBudgetError

        def spent(*_):
            raise AIBudgetError("monthly AI budget reached")

        with self.assertRaises(images.PickUnavailable):
            self._repair(spent)

    def test_the_video_over_its_cap_writes_nothing(self):
        def over():
            raise images.PickUnavailable("over the repair cap")

        with self.assertRaises(images.PickUnavailable):
            self._repair(lambda *_: answer(box(0, 0, 0, 0), verdict="none"), video=over)

    def test_a_model_error_is_not_a_spent_budget_and_keeps_the_cover(self):
        # Retrying a post the model keeps failing on would spend calls on every load.
        def broken(*_):
            raise AIError("down")

        _, _, stored, _ = self._repair(broken)
        self.assertEqual(stored["size"], (360, 640))

    def test_a_gone_post_keeps_our_copy_and_never_asks_the_model(self):
        def gone(_url):
            raise images.ImageError("that post no longer serves a cover image")

        picker = MagicMock()
        result, _, stored, fetched = self._repair(picker, resolve=gone)
        picker.assert_not_called()
        self.assertEqual(fetched, [f"https://ref.supabase.co/storage/v1/object/public/recipe-images/{USER}/{RECIPE}-lg.jpg"])
        self.assertEqual(result["image_url"], "lg")

    def test_a_gone_post_on_a_first_mirror_is_still_a_failure(self):
        def gone(_url):
            raise images.ImageError("gone")

        with patch("app.images._resolve_source", side_effect=gone), self.assertRaises(images.ImageError):
            images.mirror_image(USER, RECIPE, POST, picker=MagicMock())

    def test_a_first_mirror_on_a_spent_budget_still_keeps_the_cover(self):
        from app.ai import AIBudgetError

        def spent(*_):
            raise AIBudgetError("monthly AI budget reached")

        with patch("app.images.fetch_bytes", return_value=(cover(), "image/jpeg")), patch(
            "app.images._store", return_value={}
        ) as store:
            images.mirror_image(USER, RECIPE, "https://cdn.example.com/c.jpg", picker=spent)
        self.assertEqual(store.call_args.args[2].size, (360, 640))


class RepairRoute(unittest.TestCase):
    def _call(self, post_url=POST, *, ai=True, over=False, mirror=None):
        from app import main

        body = main.ImageRequest(recipe_id=RECIPE, url=post_url or "https://cdn.example.com/c.jpg", post_url=post_url, repair=True)
        with patch("app.main._photo_caller", return_value=USER), patch("app.main.ai_available", return_value=ai), patch(
            "app.usage.over_rate_limit", return_value=over
        ) as cap, patch("app.main.meter_caller") as import_cap, patch(
            "app.images.mirror_image", side_effect=mirror, return_value={"image_url": "lg"}
        ) as m:
            try:
                return main.recipe_image(body, object(), None), m, cap, import_cap
            except HTTPException as exc:
                return exc, m, cap, import_cap

    def test_a_repair_is_picked_and_counted_in_its_own_bucket(self):
        from app.usage import REPAIR_LIMIT_CALLS, repair_caller

        result, mirror, cap, import_cap = self._call()
        self.assertEqual(result, {"image_url": "lg"})
        self.assertTrue(mirror.call_args.kwargs["repair"])
        self.assertIsNotNone(mirror.call_args.kwargs["picker"])
        self.assertIsNotNone(mirror.call_args.kwargs["checker"])
        self.assertTrue(callable(mirror.call_args.kwargs["video"]))
        cap.assert_called_once_with(repair_caller(USER), REPAIR_LIMIT_CALLS)
        import_cap.assert_not_called()

    def test_instagram_has_no_video(self):
        _, mirror, _, _ = self._call("https://www.instagram.com/reel/abc/")
        self.assertIsNone(mirror.call_args.kwargs["video"])

    def test_over_its_cap_or_without_a_model_nothing_is_written(self):
        for kw, status in (({"over": True}, 429), ({"ai": False}, 503)):
            exc, mirror, _, _ = self._call(**kw)
            self.assertEqual(exc.status_code, status, kw)
            mirror.assert_not_called()

    def test_a_spent_budget_is_an_error_not_a_save(self):
        exc, _, _, _ = self._call(mirror=images.PickUnavailable("budget"))
        self.assertEqual(exc.status_code, 503)

    def test_no_post_or_a_web_page_is_refused(self):
        for url in (None, "https://example.com/recipe"):
            exc, mirror, _, _ = self._call(url)
            self.assertEqual(exc.status_code, 422, url)
            mirror.assert_not_called()

    def test_the_repair_bucket_is_never_an_addresses_bucket(self):
        from app.usage import caller_hash, repair_caller

        self.assertNotEqual(repair_caller(USER), caller_hash(USER))
        self.assertNotEqual(repair_caller(USER), repair_caller(RECIPE))


class CropCheck(unittest.TestCase):
    def test_only_a_plain_no_rejects_the_crop(self):
        from app import ai

        for reply, want in (({"shows_food": False}, False), ({"shows_food": True}, True), ({}, True)):
            with patch("app.ai._call", return_value=reply):
                self.assertIs(ai.crop_shows_food("b64", "image/jpeg"), want, reply)


class PickSchema(unittest.TestCase):
    def test_it_follows_the_structured_output_rules(self):
        def objects(node):
            if isinstance(node, dict):
                if node.get("type") == "object":
                    yield node
                for v in node.values():
                    yield from objects(v)

        for obj in [*objects(PICK_SCHEMA), *objects(CHECK_SCHEMA)]:
            self.assertIs(obj["additionalProperties"], False)
            self.assertEqual(sorted(obj["required"]), sorted(obj["properties"]))


if __name__ == "__main__":
    unittest.main()
