"""A photo link that only means something on the page it came from.

The bakery page that prompted job 3 writes its og:image as
`/images/uploads/x.jpg`. Saved as it came, the photo never loaded, the mirror
could not fetch it, and the editor refused to save ANY edit to the recipe
because the photo link was not a full one. The importer now resolves every image
link against the page, and drops anything that is not a web link.
"""

import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import extract, social  # noqa: E402

PAGE = "https://www.example.com/recipes/apple-bars/"


class AbsoluteUrl(unittest.TestCase):
    def test_a_path_is_resolved_against_the_page(self):
        self.assertEqual(
            extract.absolute_url(PAGE, "/images/uploads/x.jpg"), "https://www.example.com/images/uploads/x.jpg"
        )
        self.assertEqual(extract.absolute_url(PAGE, "x.jpg"), "https://www.example.com/recipes/apple-bars/x.jpg")

    def test_a_protocol_relative_link_takes_the_pages_scheme(self):
        self.assertEqual(extract.absolute_url(PAGE, "//cdn.example.com/x.jpg"), "https://cdn.example.com/x.jpg")

    def test_a_full_link_is_left_alone(self):
        self.assertEqual(extract.absolute_url(PAGE, "https://img.other.com/a.jpg?w=1"), "https://img.other.com/a.jpg?w=1")

    def test_anything_that_is_not_a_web_link_is_no_link(self):
        for value in ("data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://x/y.jpg", "", "   ", None, 5, ["a"]):
            with self.subTest(value=value):
                self.assertEqual(extract.absolute_url(PAGE, value), "")


class OddInputCostsThePhotoNotTheImport(unittest.TestCase):
    def test_a_malformed_link_is_no_link(self):
        # urljoin raises ValueError("Invalid IPv6 URL") on these.
        for value in ("https://[bad/x.jpg", "http://[::1/x.jpg", "//[oops/x.jpg"):
            with self.subTest(value=value):
                self.assertEqual(extract.absolute_url(PAGE, value), "")

    def test_a_good_recipe_with_a_malformed_image_still_imports(self):
        ld = {"@type": "Recipe", "name": "X", "image": "https://[bad/x.jpg", "recipeIngredient": ["a"], "recipeInstructions": ["b"]}
        html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
        recipe = extract.parse_jsonld_recipe(html, PAGE)
        self.assertEqual(recipe["title"], "X")
        self.assertIsNone(recipe["image_url"])

    def test_a_malformed_og_image_does_not_fail_the_post(self):
        html = '<html><head><meta property="og:title" content="T"><meta property="og:image" content="https://[bad/x.jpg"></head></html>'
        with patch("app.social.fetch_html", return_value=html):
            self.assertEqual(social.fetch_post(PAGE, "web")["image_url"], "")


class WhereItIsApplied(unittest.TestCase):
    def test_the_json_ld_image_is_resolved(self):
        ld = {"@type": "Recipe", "name": "X", "image": "/img/a.jpg", "recipeIngredient": ["a"], "recipeInstructions": ["b"]}
        html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
        self.assertEqual(
            extract.parse_jsonld_recipe(html, PAGE)["image_url"], "https://www.example.com/img/a.jpg"
        )

    def test_a_json_ld_image_that_is_not_a_link_becomes_none(self):
        ld = {"@type": "Recipe", "name": "X", "image": "data:image/gif;base64,AAA", "recipeIngredient": ["a"], "recipeInstructions": ["b"]}
        html = f'<script type="application/ld+json">{json.dumps(ld)}</script>'
        self.assertIsNone(extract.parse_jsonld_recipe(html, PAGE)["image_url"])

    def test_the_og_image_of_a_page_is_resolved(self):
        html = (
            '<html><head><meta property="og:title" content="Apple Bars">'
            '<meta property="og:image" content="/images/uploads/bars.jpg"></head></html>'
        )
        with patch("app.social.fetch_html", return_value=html):
            post = social.fetch_post(PAGE, "web")
        self.assertEqual(post["image_url"], "https://www.example.com/images/uploads/bars.jpg")

    def test_a_page_with_no_image_still_has_an_empty_one(self):
        with patch("app.social.fetch_html", return_value="<html><head></head></html>"):
            self.assertEqual(social.fetch_post(PAGE, "web")["image_url"], "")


if __name__ == "__main__":
    unittest.main()
