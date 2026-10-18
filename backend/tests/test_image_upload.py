"""`POST /api/recipes/image/upload`: a photo sent as bytes, kept as the recipe's.

Two things are pinned. The gates are the URL route's gates (who is calling, whose
recipe it is) and must be checked before the bytes are decoded. And the pixels
that reach the bucket are the real pipeline's: a phone photo carries its rotation
in EXIF, and a stubbed resize cannot show a sideways page.
"""

import base64
import io
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

USER = "11111111-1111-4111-8111-111111111111"
RECIPE = "22222222-2222-4222-8222-222222222222"


def jpeg(size=(400, 300), exif_orientation=None) -> bytes:
    img = Image.new("RGB", size, (200, 120, 40))
    # A marker so a rotation is visible in the pixels: the left half is dark.
    for x in range(size[0] // 2):
        for y in range(size[1]):
            img.putpixel((x, y), (10, 10, 10))
    buf = io.BytesIO()
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        img.save(buf, format="JPEG", exif=exif)
    else:
        img.save(buf, format="JPEG")
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class UploadEndpoint(unittest.TestCase):
    def _post(self, image=None, recipe_id=RECIPE, token=True):
        from fastapi.testclient import TestClient

        from app.main import app

        headers = {"Authorization": "Bearer a-token"} if token else {}
        return TestClient(app).post(
            "/api/recipes/image/upload",
            json={"recipe_id": recipe_id, "image": image if image is not None else b64(jpeg())},
            headers=headers,
        )

    def test_no_session_is_a_401(self):
        self.assertEqual(self._post(token=False).status_code, 401)

    def test_a_recipe_that_is_not_the_callers_is_refused_before_decoding(self):
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=False):
                with patch("app.images.upload_image") as upload:
                    resp = self._post()
        self.assertEqual(resp.status_code, 422)
        upload.assert_not_called()

    def test_a_malformed_recipe_id_never_reaches_the_query(self):
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.upload_image") as upload:
                resp = self._post(recipe_id="x" * 36)
        self.assertEqual(resp.status_code, 422)
        upload.assert_not_called()

    def test_text_that_is_not_base64_is_a_422(self):
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=True):
                resp = self._post(image="not base64 !" * 20)
        self.assertEqual(resp.status_code, 422)

    def test_bytes_that_are_not_an_image_are_a_422(self):
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=True):
                resp = self._post(image=b64(b"<html>not a photo</html>" * 10))
        self.assertEqual(resp.status_code, 422)

    def test_a_body_over_the_ceiling_is_refused_by_the_model(self):
        with patch("app.auth.verify_token", return_value=USER):
            resp = self._post(image="A" * 4_000_001)
        self.assertEqual(resp.status_code, 422)

    def test_the_callers_own_recipe_returns_the_three_columns(self):
        stored = {"image_url": "lg", "image_thumb_url": "sm", "image_blur": "data:"}
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=True):
                with patch("app.images.upload_image", return_value=stored) as upload:
                    resp = self._post()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), stored)
        # The user id is the verified one, never anything from the body.
        self.assertEqual(upload.call_args.args[0], USER)

    def test_an_unexpected_failure_is_opaque(self):
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=True):
                with patch("app.images.upload_image", side_effect=RuntimeError("secret detail")):
                    resp = self._post()
        self.assertEqual(resp.status_code, 502)
        self.assertNotIn("secret", resp.text)


class UploadPipeline(unittest.TestCase):
    """Real Pillow, real EXIF; only the bucket write is replaced."""

    def _run(self, data):
        from app.images import upload_image

        sent = {}

        def fake_upload(path, body, bust=None):
            sent[path] = (body, bust)
            return f"https://x.supabase.co/{path}?v=3" + (f"&u={bust}" if bust is not None else "")

        with patch("app.images._upload", side_effect=fake_upload):
            columns = upload_image(USER, RECIPE, data)
        return columns, sent

    def test_both_widths_land_under_the_callers_own_folder(self):
        columns, sent = self._run(jpeg((2000, 1500)))
        self.assertEqual(set(sent), {f"{USER}/{RECIPE}-lg.jpg", f"{USER}/{RECIPE}-sm.jpg"})
        lg = Image.open(io.BytesIO(sent[f"{USER}/{RECIPE}-lg.jpg"][0]))
        sm = Image.open(io.BytesIO(sent[f"{USER}/{RECIPE}-sm.jpg"][0]))
        self.assertEqual(lg.width, 960)
        self.assertEqual(sm.width, 320)
        self.assertTrue(columns["image_blur"].startswith("data:image/jpeg;base64,"))

    def test_the_url_carries_the_version_and_a_changing_value(self):
        columns, _ = self._run(jpeg())
        # `?v=3` first: the client reads it to tell a current photo from an old one.
        self.assertIn("?v=3&u=", columns["image_url"])
        self.assertIn("?v=3&u=", columns["image_thumb_url"])

    def test_a_rotation_living_in_exif_is_applied_to_the_pixels(self):
        # Orientation 6 = the stored pixels must be turned 90 degrees clockwise to
        # display. A 400x300 file therefore displays 300x400, portrait.
        _, sent = self._run(jpeg((400, 300), exif_orientation=6))
        lg = Image.open(io.BytesIO(sent[f"{USER}/{RECIPE}-lg.jpg"][0]))
        self.assertLess(lg.width, lg.height)

    def _real_upload_url(self, bust):
        """The URL the real `_upload` returns; only the HTTP client is replaced."""
        from unittest.mock import MagicMock

        from app.images import _upload

        resp = MagicMock(status_code=200)
        client = MagicMock()
        client.post.return_value = resp
        with patch.dict(
            os.environ, {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}
        ):
            with patch("httpx.Client") as ctor:
                ctor.return_value.__enter__.return_value = client
                return _upload("u/r-lg.jpg", b"bytes", bust)

    def test_the_real_upload_url_gets_the_timestamp_only_when_asked(self):
        # The mirror route never passes `bust`, so its URLs are exactly as before.
        self.assertTrue(self._real_upload_url(None).endswith("/u/r-lg.jpg?v=3"))
        self.assertTrue(self._real_upload_url(1760000000).endswith("/u/r-lg.jpg?v=3&u=1760000000"))


if __name__ == "__main__":
    unittest.main()
