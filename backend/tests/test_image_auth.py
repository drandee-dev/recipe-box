"""What `POST /api/recipes/image` is allowed to touch.

The endpoint verified the caller properly from the start and derived `user_id`
from the token rather than the body, so there was never a cross-user write to
prevent. The gap was the second gate: `recipe_id` came off the body and was tied
to nothing, so an authenticated caller could post invented UUIDs with arbitrary
image URLs and have the backend fetch and keep each one. Sign-up is open, storage
is the free tier's, and `store.remove` can only clean up recipes the app knows
about, so those objects would never be collected.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

USER = "11111111-1111-4111-8111-111111111111"
RECIPE = "22222222-2222-4222-8222-222222222222"


class ImageEndpointOwnership(unittest.TestCase):
    def _post(self, recipe_id=RECIPE):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app).post(
            "/api/recipes/image",
            json={"recipe_id": recipe_id, "url": "https://example.com/photo.jpg"},
            headers={"Authorization": "Bearer a-token"},
        )

    def test_a_recipe_that_is_not_the_callers_is_refused(self):
        mirrored = {"image_url": "stored"}
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=False):
                with patch("app.images.mirror_image", return_value=mirrored) as mirror:
                    resp = self._post()
        self.assertEqual(resp.status_code, 422)
        # Nothing is fetched and nothing is stored. Reaching mirror_image at all
        # is the bug, since that is the call that spends bytes in the bucket.
        mirror.assert_not_called()

    def test_the_callers_own_recipe_is_mirrored(self):
        mirrored = {"image_url": "stored", "image_thumb_url": "small", "image_blur": "data:"}
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=True):
                with patch("app.images.mirror_image", return_value=mirrored):
                    resp = self._post()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["image_url"], "stored")

    def test_a_lookup_that_failed_refuses_rather_than_guesses(self):
        # recipe_is_owned returns False when it could not complete the query.
        # Mirroring is best effort by contract and the client retries on a later
        # load, so skipping one is cheap; storing an unowned object is forever.
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.recipe_is_owned", return_value=False):
                resp = self._post()
        self.assertEqual(resp.status_code, 422)

    def test_a_malformed_recipe_id_never_reaches_the_query(self):
        # 36 characters, so it passes the Field length check, and is still not a
        # UUID. Both halves land in a PostgREST filter and an object path.
        with patch("app.auth.verify_token", return_value=USER):
            with patch("app.images.mirror_image") as mirror:
                resp = self._post(recipe_id="x" * 36)
        self.assertEqual(resp.status_code, 422)
        mirror.assert_not_called()

    def test_no_session_is_still_a_401(self):
        from fastapi.testclient import TestClient

        from app.main import app

        resp = TestClient(app).post(
            "/api/recipes/image",
            json={"recipe_id": RECIPE, "url": "https://example.com/photo.jpg"},
        )
        self.assertEqual(resp.status_code, 401)


class RecipeIsOwned(unittest.TestCase):
    """The query itself: what it asks for, and what it does when it can't ask."""

    def _run(self, response=None, error=None):
        from unittest.mock import MagicMock

        from app.images import recipe_is_owned

        client = MagicMock()
        if error is not None:
            client.get.side_effect = error
        else:
            client.get.return_value = response
        with patch.dict(
            os.environ, {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}
        ):
            with patch("httpx.Client") as ctor:
                ctor.return_value.__enter__.return_value = client
                result = recipe_is_owned(USER, RECIPE)
        return result, client

    def _resp(self, status, payload):
        from unittest.mock import MagicMock

        resp = MagicMock()
        resp.status_code = status
        resp.json.return_value = payload
        resp.text = ""
        return resp

    def test_a_matching_row_is_owned(self):
        owned, client = self._run(self._resp(200, [{"id": RECIPE}]))
        self.assertTrue(owned)
        params = client.get.call_args.kwargs["params"]
        # Both filters, every time. Filtering on the id alone would confirm the
        # recipe exists and say nothing about whose it is.
        self.assertEqual(params["id"], f"eq.{RECIPE}")
        self.assertEqual(params["user_id"], f"eq.{USER}")

    def test_no_rows_is_not_owned(self):
        owned, _ = self._run(self._resp(200, []))
        self.assertFalse(owned)

    def test_a_rejected_query_fails_closed(self):
        owned, _ = self._run(self._resp(401, {"message": "nope"}))
        self.assertFalse(owned)

    def test_an_unreachable_supabase_fails_closed(self):
        import httpx

        owned, _ = self._run(error=httpx.ConnectError("down"))
        self.assertFalse(owned)

    def test_a_bad_uuid_raises_before_any_request(self):
        from app.images import recipe_is_owned

        with self.assertRaises(ValueError):
            recipe_is_owned(USER, "not-a-uuid")


if __name__ == "__main__":
    unittest.main()
