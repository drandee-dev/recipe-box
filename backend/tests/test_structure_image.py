"""What `POST /api/recipes/structure-image` accepts and what it refuses.

The photograph route. It shares every moving part with the paste box — the same
metering, the same budget, the same `to_recipe` shaping — and its own job is
only to turn bytes into something the model will read. So these tests are about
the seams: that a caller is metered before anything expensive happens, that a
picture of a plate is refused rather than saved as an empty recipe, and that
nothing here quietly requires a session, since the iOS capture path lands in
Safari where the app may well be signed out.
"""

import base64
import io
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

RECIPE = {
    "has_recipe": True,
    "title": "Shortbread",
    "ingredients": [{"raw": "225 g butter", "item": "butter", "qty": 225, "unit": "g"}],
    "instructions": ["Cream the butter and sugar."],
    "description": "",
    "prep_min": 10,
    "cook_min": 40,
    "total_min": 50,
    "servings": "Makes 12",
    "tags": ["dessert"],
}


def a_photo(size=(900, 1200)):
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 180, 140)).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def post(image, **overrides):
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app).post("/api/recipes/structure-image", json={"image": image, **overrides})


class StructureImage(unittest.TestCase):
    def test_a_photo_of_a_recipe_comes_back_as_one(self):
        with patch("app.ai.structure_recipe_image", return_value=dict(RECIPE)) as model:
            resp = post(a_photo())
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["title"], "Shortbread")
        self.assertEqual(body["source_type"], "manual")
        self.assertEqual(len(body["ingredients"]), 1)

        # Shrunk before it is sent, not after. The model downscales anything
        # past its own limits itself, so sending the original would only cost
        # the upload.
        sent = model.call_args.args[0]
        self.assertEqual(model.call_args.args[1], "image/jpeg")
        self.assertLess(len(base64.b64decode(sent)), 1_500_000)

    def test_no_session_is_needed(self):
        # Deliberate, and the same rule the other two AI endpoints follow: the
        # iOS capture path lands in Safari, which has its own storage and may
        # not be signed in. Nothing here is kept, so there is no folder to scope.
        with patch("app.ai.structure_recipe_image", return_value=dict(RECIPE)):
            resp = post(a_photo())
        self.assertEqual(resp.status_code, 200)

    def test_a_photo_with_no_recipe_in_it_is_refused(self):
        # A plated dish is a photo of dinner, not a recipe, and saving it as one
        # would put an empty recipe in the box under a plausible name.
        with patch("app.ai.structure_recipe_image", return_value={"has_recipe": False}):
            resp = post(a_photo())
        self.assertEqual(resp.status_code, 422)

    def test_a_recipe_with_no_ingredients_is_refused_too(self):
        with patch("app.ai.structure_recipe_image", return_value={**RECIPE, "ingredients": []}):
            resp = post(a_photo())
        self.assertEqual(resp.status_code, 422)

    def test_something_that_is_not_base64_never_reaches_the_model(self):
        with patch("app.ai.structure_recipe_image") as model:
            resp = post("!" * 200)
        self.assertEqual(resp.status_code, 422)
        model.assert_not_called()

    def test_base64_that_is_not_an_image_never_reaches_the_model(self):
        with patch("app.ai.structure_recipe_image") as model:
            resp = post(base64.b64encode(b"<html>not a photo</html>" * 10).decode())
        self.assertEqual(resp.status_code, 422)
        model.assert_not_called()

    def test_a_body_over_the_ceiling_is_rejected_by_the_schema(self):
        # Before any decoding, which is the point: 4 MB of base64 is a
        # full-resolution phone photo that skipped the client-side shrink, and
        # decoding it to find that out is the cost being avoided.
        with patch("app.ai.structure_recipe_image") as model:
            resp = post("A" * 4_000_004)
        self.assertEqual(resp.status_code, 422)
        model.assert_not_called()

    def test_the_caller_is_metered_before_the_model_is_touched(self):
        # A new endpoint that can reach the model has to call meter_caller, or
        # its spend is filed under nobody and counts toward no cap.
        with patch("app.usage.over_rate_limit", return_value=True):
            with patch("app.ai.structure_recipe_image") as model:
                resp = post(a_photo())
        self.assertEqual(resp.status_code, 429)
        model.assert_not_called()

    def test_the_monthly_budget_still_stops_it(self):
        from app.ai import AIBudgetError

        with patch("app.ai.structure_recipe_image", side_effect=AIBudgetError("spent")):
            resp = post(a_photo())
        self.assertEqual(resp.status_code, 429)


if __name__ == "__main__":
    unittest.main()
