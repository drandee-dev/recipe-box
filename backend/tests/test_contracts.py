"""Two contracts that nothing else enforces, both of the "works today, unguarded" kind.

**The error copy.** The three AI routes share one `ai_failures` context manager
now. Collapsing three hand-written `except` ladders into one is exactly the edit
that quietly rewords a live error message — and the first attempt at it did, on
the URL route, which says it could not *find* a recipe and could not *fetch* the
page rather than the "read/process" wording the other two use. These assertions
are what caught it, so they stay.

**The recipe shape.** Four functions build the recipe dict that every import path
returns — `parse_jsonld_recipe`, `link_card`, `to_recipe`, `from_caption_link` —
and nothing makes them agree. They do agree; the point is that a field added to
one and forgotten in another is a silently truncated recipe rather than an error,
which is the same failure `toRow` in the frontend's store.js already carries a
warning about. A test is the cheap half of that guarantee; unifying the four
constructors is the expensive half and is not obviously worth it.
"""

import base64
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import extract, social  # noqa: E402
from app.ai import AIBudgetError, AIError  # noqa: E402
from app.extract import ExtractError  # noqa: E402


def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


TEXT = {"text": "x" * 40}
URL = {"url": "https://example.com/recipe"}
PHOTO = {"image": base64.b64encode(b"x" * 200).decode()}


class ErrorCopy(unittest.TestCase):
    """Status code and wording, per failure, per route."""

    def check(self, path, body, expected_status, expected_detail):
        resp = client().post(path, json=body)
        self.assertEqual(resp.status_code, expected_status)
        self.assertEqual(resp.json().get("detail"), expected_detail)

    def test_paste_text(self):
        cases = [
            ({"return_value": {"has_recipe": False}}, 422, "That text doesn't look like a recipe"),
            ({"side_effect": AIError("x")}, 422, "Could not read a recipe from that text"),
            ({"side_effect": AIBudgetError("x")}, 429, "AI budget for this month is used up"),
            ({"side_effect": RuntimeError("x")}, 502, "Could not process that text"),
        ]
        for kwargs, status, detail in cases:
            with self.subTest(detail=detail):
                with patch("app.main.structure_recipe", **kwargs):
                    self.check("/api/recipes/structure", TEXT, status, detail)

    def test_url_import_keeps_its_own_wording(self):
        """Not "read/process" like the other two — this route says find/fetch."""
        cases = [
            ({"side_effect": ExtractError("x")}, 422, "Could not find a recipe at that URL"),
            ({"side_effect": AIBudgetError("x")}, 429, "AI budget for this month is used up"),
            ({"side_effect": RuntimeError("x")}, 502, "Could not fetch that page"),
        ]
        for kwargs, status, detail in cases:
            with self.subTest(detail=detail):
                with patch("app.main.extract_recipe", **kwargs):
                    self.check("/api/recipes/extract", URL, status, detail)

    def test_photo(self):
        cases = [
            ({"return_value": {"has_recipe": False}}, 422, "That photo doesn't look like a recipe"),
            ({"side_effect": AIError("x")}, 422, "Could not read a recipe from that photo"),
            ({"side_effect": AIBudgetError("x")}, 429, "AI budget for this month is used up"),
            ({"side_effect": RuntimeError("x")}, 502, "Could not process that photo"),
        ]
        for kwargs, status, detail in cases:
            with self.subTest(detail=detail):
                with patch("app.ai.structure_recipe_image", **kwargs), patch(
                    "app.images.image_for_vision", return_value=("AAA", "image/jpeg")
                ):
                    self.check("/api/recipes/structure-image", PHOTO, status, detail)

    def test_a_traceback_never_reaches_the_client(self):
        """The `except Exception` at the end of the ladder is the load-bearing
        one: without it an unforeseen error is returned as its own message."""
        with patch("app.main.structure_recipe", side_effect=RuntimeError("secret internal detail")):
            resp = client().post("/api/recipes/structure", json=TEXT)
        self.assertNotIn("secret internal detail", resp.text)


RECIPE_HTML = (
    '<html><head><script type="application/ld+json">'
    '{"@type":"Recipe","name":"X","recipeIngredient":["a"],"recipeInstructions":["b"]}'
    "</script></head></html>"
)


class RecipeShape(unittest.TestCase):
    def all_four(self):
        jsonld = extract.parse_jsonld_recipe(RECIPE_HTML, "https://example.com/x")
        post = {"caption": "hi", "image_url": "https://cdn/x.jpg", "title": "T"}
        return {
            "parse_jsonld_recipe": jsonld,
            "link_card": social.link_card("https://t.com/1", "tiktok", post),
            "to_recipe": social.to_recipe(
                {"title": "X", "ingredients": [{"raw": "a"}], "instructions": ["b"]},
                "https://t.com/1",
                "tiktok",
                post,
            ),
            "from_caption_link": social.from_caption_link(
                jsonld, "https://t.com/1", "tiktok", post
            ),
        }

    def test_every_constructor_returns_the_same_keys(self):
        built = self.all_four()
        reference = set(built["to_recipe"])
        for name, recipe in built.items():
            with self.subTest(constructor=name):
                self.assertEqual(set(recipe), reference)

    def test_the_shape_is_the_one_the_client_stores(self):
        """Pinned against the column list in frontend/src/lib/store.js. A field
        added here and not there is a field the client drops on the floor."""
        expected = {
            "title", "source_url", "source_type", "image_url", "description",
            "ingredients", "instructions", "prep_min", "cook_min", "total_min",
            "servings", "tags", "favorite",
        }
        for name, recipe in self.all_four().items():
            with self.subTest(constructor=name):
                self.assertEqual(set(recipe), expected)


if __name__ == "__main__":
    unittest.main()
