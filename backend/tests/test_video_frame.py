"""H2: when a TikTok cover has no clean food, a still from the video is tried.

Only after the cover failed, never instead of a clean cover; any failure on the
video path leaves the recipe its tile, exactly as without H2.
"""

import io
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import images, thumbs  # noqa: E402
from app.ai import FRAME_SCHEMA  # noqa: E402

USER = "11111111-1111-4111-8111-111111111111"
RECIPE = "22222222-2222-4222-8222-222222222222"
NONE = {"verdict": "none", "food": {"left": 0, "top": 0, "right": 0, "bottom": 0}, "text": [], "people": []}
ALL_FOOD = {"verdict": "food", "food": {"left": 0, "top": 0, "right": 100, "bottom": 100}, "text": [], "people": []}


def cover():
    buf = io.BytesIO()
    Image.new("RGB", (360, 640), (120, 90, 60)).save(buf, format="JPEG")
    return buf.getvalue()


def still(colour=(10, 200, 10)):
    return Image.new("RGB", (720, 1280), colour)


class FrameSheet(unittest.TestCase):
    def test_twelve_stills_tile_four_across_and_each_is_numbered(self):
        sheet = thumbs.frame_sheet([still((20, 20, 20))] * 12)
        self.assertEqual(sheet.size, (1080, 1440))
        # A white number sits in the top-left corner of every tile.
        for i in range(12):
            x, y = (i % 4) * 270, (i // 4) * 480
            corner = sheet.crop((x, y, x + 60, y + 55)).getdata()
            self.assertTrue(any(min(p) > 200 for p in corner), f"tile {i + 1} has no number")


class BestFrame(unittest.TestCase):
    def _best(self, answer, frames=None):
        frames = [still((i * 20, 0, 0)) for i in range(12)] if frames is None else frames
        chooser = MagicMock(return_value=answer)
        with patch("app.thumbs.tiktok_video", return_value=b"mp4"), patch("app.thumbs.video_frames", return_value=frames):
            return thumbs.best_frame("https://www.tiktok.com/@a/video/1", chooser), frames, chooser

    def test_the_chosen_number_is_that_still(self):
        got, frames, _ = self._best({"frame": 3})
        self.assertIs(got, frames[2])

    def test_zero_out_of_range_or_junk_is_no_still(self):
        for answer in ({"frame": 0}, {"frame": 13}, {"frame": -1}, {"frame": "3"}, {}):
            self.assertIsNone(self._best(answer)[0], answer)

    def test_a_video_with_no_stills_never_asks_the_model(self):
        got, _, chooser = self._best({"frame": 1}, frames=[])
        self.assertIsNone(got)
        chooser.assert_not_called()


class MirrorWithVideo(unittest.TestCase):
    def _mirror(self, picks, video):
        """`picks` answers the cover first, then the still."""
        stored = {}

        def fake_store(user_id, recipe_id, img, bust=None):
            stored["size"] = img.size
            return {"image_url": "lg", "image_thumb_url": "sm", "image_blur": "b"}

        picker = MagicMock(side_effect=picks)
        with patch("app.images.fetch_bytes", return_value=(cover(), "image/jpeg")), patch(
            "app.images._store", side_effect=fake_store
        ):
            result = images.mirror_image(USER, RECIPE, "https://cdn.example.com/c.jpg", picker=picker, video=video)
        return result, stored, picker

    def test_no_food_on_the_cover_uses_the_videos_still(self):
        result, stored, picker = self._mirror([NONE, ALL_FOOD], lambda: still())
        self.assertEqual(stored["size"], (720, 1280))
        self.assertEqual(result["image_url"], "lg")
        self.assertEqual(picker.call_count, 2)

    def test_a_clean_cover_never_touches_the_video(self):
        video = MagicMock()
        _, stored, _ = self._mirror([ALL_FOOD], video)
        video.assert_not_called()
        self.assertEqual(stored["size"], (360, 640))

    def test_no_still_or_a_failed_video_is_the_tile(self):
        def broken():
            raise RuntimeError("TikTok said no")

        for video in (lambda: None, broken):
            result, stored, _ = self._mirror([NONE], video)
            self.assertEqual(result, dict(images.NO_PHOTO))
            self.assertEqual(stored, {})

    def test_a_still_with_no_clean_food_is_the_tile(self):
        result, _, _ = self._mirror([NONE, NONE], lambda: still())
        self.assertEqual(result, dict(images.NO_PHOTO))

    def test_a_failed_or_malformed_pick_on_the_still_is_the_tile_not_the_whole_still(self):
        malformed = {**ALL_FOOD, "food": {"left": 90, "top": 90, "right": 10, "bottom": 10}}
        for second in (RuntimeError("budget"), malformed):
            result, stored, _ = self._mirror([NONE, second], lambda: still())
            self.assertEqual(result, dict(images.NO_PHOTO), second)
            self.assertEqual(stored, {})


class Resp:
    def __init__(self, status=200, content=b"<html>", ctype="text/html", url="https://www.tiktok.com/@a/video/1"):
        self.status_code, self.content, self.url = status, content, url
        self.text = content.decode("latin-1")
        self.headers = {"content-type": ctype}

    def iter_bytes(self):
        yield from (self.content[i : i + 4] for i in range(0, len(self.content), 4))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class TikTokVideo(unittest.TestCase):
    PLAY = "https://v16.tiktokcdn.com/video.mp4"

    def _fetch(self, page=None, video=None, item=None):
        from contextlib import contextmanager

        client = MagicMock()
        client.get.return_value = page or Resp()
        client.stream.return_value = video or Resp(content=b"mp4-bytes", ctype="video/mp4", url=self.PLAY)

        @contextmanager
        def guarded():
            yield client, lambda _url: None

        item = {"video": {"playAddr": self.PLAY}} if item is None else item
        with patch("app.thumbs.guarded_client", guarded), patch("app.thumbs.assert_public_host") as public, patch(
            "app.social._tiktok_item", return_value=item
        ):
            return thumbs.tiktok_video("https://www.tiktok.com/@a/video/1"), public

    def test_the_video_bytes_come_back_and_the_video_host_is_checked(self):
        data, public = self._fetch()
        self.assertEqual(data, b"mp4-bytes")
        public.assert_any_call(self.PLAY)

    def test_each_refusal_is_an_extract_error(self):
        from app.extract import ExtractError

        cases = {
            "page status": {"page": Resp(status=404)},
            "no video address": {"item": {"video": {}}},
            "not a video": {"video": Resp(content=b"x", ctype="text/html", url=self.PLAY)},
        }
        for name, kw in cases.items():
            with self.assertRaises(ExtractError, msg=name):
                self._fetch(**kw)

    def test_size_and_time_limits_stop_the_download(self):
        from app.extract import ExtractError

        with patch("app.thumbs.MAX_VIDEO_BYTES", 4), self.assertRaisesRegex(ExtractError, "too large"):
            self._fetch()
        with patch("app.thumbs.MAX_BYTES", 2), self.assertRaisesRegex(ExtractError, "page too large"):
            self._fetch()
        with patch("app.thumbs.VIDEO_DEADLINE_SECONDS", -1), self.assertRaisesRegex(ExtractError, "too slow"):
            self._fetch()


class WhenTheVideoIsTried(unittest.TestCase):
    def test_only_a_tiktok_post_gets_a_video(self):
        from app import main

        for url in (None, "https://www.instagram.com/reel/abc/", "https://example.com/r"):
            self.assertIsNone(main._video_fallback(url, object()))
        self.assertTrue(callable(main._video_fallback("https://www.tiktok.com/@a/video/1", object())))

    def test_it_meters_when_it_runs_and_over_the_cap_it_does_nothing(self):
        from app import main

        video = main._video_fallback("https://www.tiktok.com/@a/video/1", object())
        with patch("app.main.meter_caller", side_effect=HTTPException(status_code=429)) as meter, patch(
            "app.thumbs.best_frame"
        ) as best:
            self.assertIsNone(video())
        meter.assert_called_once()
        best.assert_not_called()


class FrameSchema(unittest.TestCase):
    def test_it_follows_the_structured_output_rules(self):
        self.assertIs(FRAME_SCHEMA["additionalProperties"], False)
        self.assertEqual(sorted(FRAME_SCHEMA["required"]), sorted(FRAME_SCHEMA["properties"]))


try:
    import av  # noqa: F401

    HAVE_AV = True
except ImportError:
    HAVE_AV = False


@unittest.skipUnless(HAVE_AV, "PyAV not installed here; Vercel installs it")
class RealDecode(unittest.TestCase):
    def test_stills_come_from_through_the_video(self):
        import av

        buf = io.BytesIO()
        with av.open(buf, "w", format="mp4") as out:
            stream = out.add_stream("libx264", rate=10)
            stream.width, stream.height, stream.pix_fmt = 64, 112, "yuv420p"
            for n in range(60):  # 6 s, getting brighter
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 112), (n * 4,) * 3))
                for packet in stream.encode(frame):
                    out.mux(packet)
            for packet in stream.encode():
                out.mux(packet)
        stills = thumbs.video_frames(buf.getvalue(), count=4)
        self.assertEqual(len(stills), 4)
        self.assertEqual(stills[0].mode, "RGB")


if __name__ == "__main__":
    unittest.main()
