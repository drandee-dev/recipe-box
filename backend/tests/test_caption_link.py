"""Following a recipe link that the caption itself carried.

The case this exists for is the ordinary partial import: a creator lists the
ingredients in the caption and leaves the method to the video. `strip_urls`
deletes links before the caption reaches the model, so a creator who linked
their own written recipe used to be no better off than one who linked nothing.

Two rules are what keep this safe, and both are tested here rather than trusted:
it only ever *adds* to a caption-derived recipe, and every failure falls through
to exactly the behaviour that existed before it.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import extract, social  # noqa: E402

BLOG_HTML = """
<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Korean Popcorn Chicken",
 "recipeIngredient":["1.5 lbs chicken thighs","1/4 cup gochujang"],
 "recipeInstructions":["Cut the chicken.","Coat in starch.","Fry until crisp."],
 "prepTime":"PT15M","cookTime":"PT25M","recipeYield":"4 servings",
 "description":"Crispy and sticky."}
</script></head><body></body></html>
"""

NO_MARKUP = "<html><body><p>Some page with no recipe markup at all.</p></body></html>"

POST_URL = "https://www.tiktok.com/@foodiligence/video/7677241541231955214"

# What the caption path produces today for that post: ingredients, no method.
PARTIAL = {
    "title": "Korean Popcorn Chicken",
    "source_url": POST_URL,
    "source_type": "tiktok",
    "image_url": "https://p19.tiktokcdn.com/cover.jpg",
    "description": None,
    "ingredients": [{"raw": "1.5 lbs chicken thighs", "item": None, "qty": None, "unit": None}],
    "instructions": [],
    "prep_min": None,
    "cook_min": None,
    "total_min": None,
    "servings": None,
    "tags": ["chicken"],
    "favorite": False,
}


def partial():
    """A fresh copy — every test here mutates the recipe it is handed."""
    return {**PARTIAL, "ingredients": list(PARTIAL["ingredients"]), "tags": list(PARTIAL["tags"])}


class CaptionLinks(unittest.TestCase):
    def test_a_linked_recipe_page_is_read(self):
        caption = "Korean Popcorn Chicken. Full recipe: https://example.com/korean-popcorn-chicken"
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            found = extract._caption_link_recipe(caption, POST_URL)
        self.assertIsNotNone(found)
        self.assertEqual(len(found["instructions"]), 3)

    def test_a_link_back_to_the_social_host_is_never_followed(self):
        """A caption's own platform links are profiles and "follow me", not recipes.

        Following one would also mean re-entering the social path from inside it.
        """
        caption = "More at https://www.instagram.com/foodiligence and https://vm.tiktok.com/abc"
        with patch.object(extract, "fetch_html", side_effect=AssertionError("must not fetch")):
            self.assertIsNone(extract._caption_link_recipe(caption, POST_URL))

    def test_a_page_with_no_markup_is_not_guessed_at(self):
        """No JSON-LD means no recipe. The readable-text fallback is deliberately
        not reused here — that would pay the model to read a page we only guessed
        was the recipe."""
        with patch.object(extract, "fetch_html", return_value=NO_MARKUP):
            self.assertIsNone(extract._caption_link_recipe("see https://example.com/x", POST_URL))

    def test_an_unreachable_link_returns_none_rather_than_raising(self):
        with patch.object(extract, "fetch_html", side_effect=extract.ExtractError("blocked")):
            self.assertIsNone(extract._caption_link_recipe("see https://example.com/x", POST_URL))

    def test_only_the_first_two_links_are_tried(self):
        caption = " ".join(f"https://example.com/{n}" for n in range(6))
        with patch.object(extract, "fetch_html", return_value=NO_MARKUP) as fetched:
            extract._caption_link_recipe(caption, POST_URL)
        self.assertEqual(fetched.call_count, extract.MAX_CAPTION_LINKS)

    def test_trailing_punctuation_is_not_part_of_the_link(self):
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML) as fetched:
            extract._caption_link_recipe("Recipe at https://example.com/chicken.", POST_URL)
        self.assertEqual(fetched.call_args[0][0], "https://example.com/chicken")


class Grafting(unittest.TestCase):
    def test_the_method_fills_in_and_so_do_the_empty_timings(self):
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            linked = extract._caption_link_recipe("https://example.com/x", POST_URL)
        recipe = social.graft_written_recipe(partial(), linked)
        self.assertEqual(len(recipe["instructions"]), 3)
        self.assertEqual(recipe["prep_min"], 15)
        self.assertEqual(recipe["cook_min"], 25)
        self.assertEqual(recipe["servings"], "4 servings")

    def test_the_captions_own_values_are_never_overwritten(self):
        """The caption is what the person actually saved. The link only fills gaps."""
        recipe = partial()
        recipe["instructions"] = ["Do it the way the caption said."]
        recipe["servings"] = "Serves 2"
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            linked = extract._caption_link_recipe("https://example.com/x", POST_URL)
        grafted = social.graft_written_recipe(recipe, linked)
        self.assertEqual(grafted["instructions"], ["Do it the way the caption said."])
        self.assertEqual(grafted["servings"], "Serves 2")

    def test_the_ingredients_always_stay_the_captions(self):
        """The linked page lists two; the caption listed one. The caption wins,
        because those are the lines the person read before saving it."""
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            linked = extract._caption_link_recipe("https://example.com/x", POST_URL)
        recipe = social.graft_written_recipe(partial(), linked)
        self.assertEqual(len(recipe["ingredients"]), 1)

    def test_nothing_found_leaves_the_recipe_exactly_as_it_was(self):
        self.assertEqual(social.graft_written_recipe(partial(), None), PARTIAL)


class WholeLinkedRecipe(unittest.TestCase):
    """When the caption yielded nothing, the linked page is the whole recipe —
    but it is still attributed to the post, which is what was saved."""

    def test_the_post_keeps_the_source_and_the_photo(self):
        with patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            linked = extract._caption_link_recipe("https://example.com/x", POST_URL)
        post = {"caption": "", "image_url": "https://p19.tiktokcdn.com/cover.jpg", "title": ""}
        recipe = social.from_caption_link(linked, POST_URL, "tiktok", post)
        self.assertEqual(recipe["source_url"], POST_URL)
        self.assertEqual(recipe["source_type"], "tiktok")
        self.assertEqual(recipe["image_url"], "https://p19.tiktokcdn.com/cover.jpg")
        self.assertEqual(len(recipe["instructions"]), 3)


class SocialPipeline(unittest.TestCase):
    """The seam: that the caption path still wins, and that the link is only
    reached when it has something to add.

    Note every caption here carries prose as well as the link. A caption that is
    *only* a link is emptied by `strip_urls` before the `if caption` guard, so it
    skips the model entirely and goes straight to the link — correct, but it
    means a link-only fixture tests a different path than the one intended.
    """

    def test_a_complete_caption_never_costs_a_fetch(self):
        structured = {
            "has_recipe": True,
            "title": "Shortbread",
            "ingredients": [{"raw": "225 g butter"}],
            "instructions": ["Cream the butter."],
            "tags": [],
        }
        caption = "Shortbread, three ingredients. https://example.com/x"
        with patch.object(social, "fetch_post", return_value={"caption": caption}), \
             patch("app.ai.ai_available", return_value=True), \
             patch("app.ai.structure_recipe", return_value=structured), \
             patch.object(extract, "fetch_html", side_effect=AssertionError("must not fetch")):
            recipe = extract._extract_social(POST_URL, "tiktok")
        self.assertEqual(recipe["instructions"], ["Cream the butter."])

    def test_a_partial_caption_is_completed_from_the_link(self):
        structured = {
            "has_recipe": True,
            "title": "Korean Popcorn Chicken",
            "ingredients": [{"raw": "1.5 lbs chicken thighs"}],
            "instructions": [],
            "tags": [],
        }
        caption = "Korean Popcorn Chicken https://example.com/korean-popcorn-chicken"
        with patch.object(social, "fetch_post", return_value={"caption": caption}), \
             patch("app.ai.ai_available", return_value=True), \
             patch("app.ai.structure_recipe", return_value=structured), \
             patch.object(extract, "fetch_html", return_value=BLOG_HTML):
            recipe = extract._extract_social(POST_URL, "tiktok")
        self.assertEqual(len(recipe["instructions"]), 3)
        self.assertEqual(recipe["source_url"], POST_URL)

    def test_a_caption_with_no_recipe_reaches_the_link_before_the_picture(self):
        """The link costs no model call and the thumbnail costs one, so a caption
        that named its own recipe page should never reach the vision fallback."""
        caption = "Best thing I made all year https://example.com/korean-popcorn-chicken"
        with patch.object(social, "fetch_post", return_value={"caption": caption}), \
             patch("app.ai.ai_available", return_value=True), \
             patch("app.ai.structure_recipe", return_value={"has_recipe": False}), \
             patch.object(extract, "fetch_html", return_value=BLOG_HTML), \
             patch.object(extract, "_read_post_image", side_effect=AssertionError("too early")):
            recipe = extract._extract_social(POST_URL, "tiktok")
        self.assertEqual(len(recipe["instructions"]), 3)

    def test_no_link_in_the_caption_leaves_the_old_path_untouched(self):
        """A link card, exactly as before — this is the regression that would
        matter, since every caption that has no link takes this route."""
        with patch.object(social, "fetch_post", return_value={"caption": "just a nice dinner"}), \
             patch("app.ai.ai_available", return_value=True), \
             patch("app.ai.structure_recipe", return_value={"has_recipe": False}), \
             patch.object(extract, "_read_post_image", return_value=None):
            recipe = extract._extract_social(POST_URL, "tiktok")
        self.assertEqual(recipe["ingredients"], [])
        self.assertEqual(recipe["instructions"], [])


if __name__ == "__main__":
    unittest.main()
