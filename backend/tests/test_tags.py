"""What `infer_tags` decides about cuisine.

The case that prompted this: a Peruvian chicken recipe imported from TikTok came
back tagged `asian`, because its marinade has soy sauce in it. Soy sauce really
is Peruvian — chifa is Peruvian-Chinese and a century old — so the ingredient
list genuinely cannot settle which kitchen the dish came from. The dish's own
name can, and that is the rule these tests pin.

The second half is the same mistake made in the other direction: an ingredient
that names a country without the dish being from there.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.tags import ALLOWED_TAGS, CUISINE_TAGS, drop_unsupported, infer_tags  # noqa: E402

PERUVIAN = [
    {"raw": "2 lbs boneless, skinless chicken thighs"},
    {"raw": "3 tbsp soy sauce"},
    {"raw": "2 tbsp fresh lime juice"},
    {"raw": "1 cup plain Greek yogurt"},
    {"raw": "1/2 cup fresh cilantro"},
]


class NamedCuisineWins(unittest.TestCase):
    def test_a_peruvian_dish_with_soy_sauce_in_it_is_latin_not_asian(self):
        tags = infer_tags(title="Peruvian-Inspired Chicken with Green Sauce", ingredients=PERUVIAN)
        self.assertIn("latin", tags)
        self.assertNotIn("asian", tags)

    def test_a_korean_dish_with_gochujang_is_still_asian(self):
        """The rule must not cost the case it was built around."""
        tags = infer_tags(
            title="Korean Popcorn Chicken",
            ingredients=[{"raw": "1/4 cup gochujang"}, {"raw": "4 tbsp soy sauce"}],
        )
        self.assertIn("asian", tags)
        self.assertNotIn("latin", tags)

    def test_soy_sauce_still_means_asian_when_nothing_else_is_claimed(self):
        """Only a *named* cuisine displaces one. A recipe that names none keeps
        the ingredient's evidence, which is all there is."""
        tags = infer_tags(title="Sticky Chicken", ingredients=[{"raw": "4 tbsp soy sauce"}])
        self.assertIn("asian", tags)

    def test_a_hashtag_counts_as_naming_the_dish(self):
        """`labels` is the creator filing the post themselves, same as a title."""
        tags = infer_tags(title="Green Sauce Chicken", labels="#peruvian #dinner",
                          ingredients=PERUVIAN)
        self.assertIn("latin", tags)
        self.assertNotIn("asian", tags)

    def test_nothing_but_cuisines_is_touched(self):
        """The protein and the dish kind have no conflict to resolve, so the
        rule must leave them exactly where they were."""
        tags = infer_tags(title="Peruvian Chicken Soup", ingredients=PERUVIAN)
        self.assertIn("chicken", tags)
        self.assertIn("soup", tags)


class IncidentalCuisineIngredients(unittest.TestCase):
    def test_greek_yogurt_does_not_make_a_dish_mediterranean(self):
        tags = infer_tags(title="Cucumber Raita", ingredients=[{"raw": "1 cup Greek yogurt"}])
        self.assertNotIn("mediterranean", tags)

    def test_a_dish_that_is_actually_greek_still_is(self):
        tags = infer_tags(title="Greek Salad", ingredients=[{"raw": "200 g feta"}])
        self.assertIn("mediterranean", tags)

    def test_italian_seasoning_does_not_make_a_traybake_italian(self):
        tags = infer_tags(
            title="Sheet Pan Chicken",
            ingredients=[{"raw": "1 tbsp italian seasoning"}, {"raw": "4 chicken thighs"}],
        )
        self.assertNotIn("italian", tags)


class LatinVocabulary(unittest.TestCase):
    def test_latin_is_in_the_allowed_set(self):
        self.assertIn("latin", ALLOWED_TAGS)

    def test_mexico_keeps_its_own_tag(self):
        """Deliberate: Mexican is large enough globally to be worth finding on
        its own, and its dish words live under `mexican`, never under `latin`."""
        tags = infer_tags(title="Chicken Tacos", ingredients=[{"raw": "corn tortillas"}])
        self.assertIn("mexican", tags)
        self.assertNotIn("latin", tags)

    def test_dish_names_land_without_the_nationality_being_written(self):
        for title, in [("Beef Empanadas",), ("Steak with Chimichurri",), ("Shrimp Ceviche",)]:
            with self.subTest(title=title):
                self.assertIn("latin", infer_tags(title=title))

    def test_guacamole_is_not_read_as_mole(self):
        """"mole" is a substring of "guacamole", which is why it is not a keyword."""
        self.assertNotIn("latin", infer_tags(title="Guacamole", ingredients=[{"raw": "2 avocados"}]))

    def test_every_cuisine_tag_is_a_real_tag(self):
        self.assertTrue(CUISINE_TAGS <= set(ALLOWED_TAGS))


if __name__ == "__main__":
    unittest.main()


class UnsupportedProteinTags(unittest.TestCase):
    """A protein the text never mentions is dropped from the model's answer.

    The model's tags otherwise lead outright and should: it read the recipe and
    a keyword list did not. But a pumpkin cookie came back tagged `pork` — twice,
    on a caption that says nothing of the kind — which puts a cookie in front of
    someone filtering for pork and, worse, in front of someone avoiding it. This
    is the mirror of the rule diets already follow: diets are never inferred from
    absence, proteins are never asserted without presence.
    """

    CAPTION = (
        "Pumpkin Cheesecake Cookies. The chewiest pumpkin spice cookies filled "
        "with creamy cheesecake and rolled in spiced sugar."
    )

    def test_the_pumpkin_cookie_loses_its_pork(self):
        kept = drop_unsupported(
            ["dessert", "pork", "baked"],
            title="Pumpkin Cheesecake Cookies",
            description=self.CAPTION,
            ingredients=[{"raw": "Cheesecake filling"}, {"raw": "Spiced sugar coating"}],
        )
        self.assertNotIn("pork", kept)
        self.assertEqual(kept, ["dessert", "baked"])

    def test_a_protein_named_in_the_title_survives(self):
        self.assertIn("pork", drop_unsupported(["pork"], title="Slow Roast Pork Shoulder"))

    def test_a_protein_named_only_by_a_synonym_survives(self):
        """`pancetta` is in pork's keyword list; the tag itself never appears."""
        self.assertIn(
            "pork",
            drop_unsupported(["pork"], title="Carbonara", ingredients=[{"raw": "200 g pancetta"}]),
        )

    def test_a_hashtag_is_enough_support(self):
        self.assertIn("beef", drop_unsupported(["beef"], title="Weeknight dinner", labels="#beefstew"))

    def test_the_check_is_permissive_about_incidental_mentions(self):
        """INCIDENTAL is deliberately *not* applied here. The job is to catch a
        claim with no support at all, not to second-guess a model that saw
        something the keyword pass would discount."""
        self.assertIn(
            "chicken",
            drop_unsupported(["chicken"], title="Soup", ingredients=[{"raw": "1 l chicken stock"}]),
        )

    def test_nothing_but_proteins_is_checked(self):
        """Cuisine and method are not falsifiable this way, so they pass through."""
        kept = drop_unsupported(["italian", "quick", "dessert", "baked"], title="Nothing")
        self.assertEqual(kept, ["italian", "quick", "dessert", "baked"])

    def test_an_answer_with_no_protein_in_it_is_returned_untouched(self):
        self.assertEqual(drop_unsupported(["dessert"], title="X"), ["dessert"])
