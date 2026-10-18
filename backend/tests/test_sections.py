"""Section headings ("For the crust") kept from a recipe page.

The markup in WPRM below is the shape checked on real pages (recipetineats,
cookingclassy, loveandlemons): a `.wprm-recipe-ingredient-group` per group, an
`h4.wprm-recipe-group-name` that the first group may not have, `li` items whose
text starts with the plugin's checkbox glyph. The rule under test is that a
heading is only ever attached when the counts line up exactly: a wrong heading
on a line is worse than none, so every disagreement must return the recipe it
returned before.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import extract, sections  # noqa: E402


def page(ingredients, instructions, body=""):
    ld = {
        "@type": "Recipe",
        "name": "Test",
        "recipeIngredient": ingredients,
        "recipeInstructions": instructions,
    }
    return (
        '<html><head><script type="application/ld+json">'
        + json.dumps(ld)
        + "</script></head><body>"
        + body
        + "</body></html>"
    )


def wprm_ingredients(groups):
    out = ['<div class="wprm-recipe-ingredients-container">']
    for name, items in groups:
        out.append('<div class="wprm-recipe-ingredient-group">')
        if name:
            out.append(f'<h4 class="wprm-recipe-group-name">{name}</h4>')
        out.append('<ul class="wprm-recipe-ingredients">')
        out.extend(f'<li class="wprm-recipe-ingredient">▢ {i}</li>' for i in items)
        out.append("</ul></div>")
    out.append("</div>")
    return "".join(out)


FLAT = ["2 cups flour", "1 cup sugar", "3 tbsp butter", "1 tsp salt"]
URL = "https://example.com/x"


class IngredientGroups(unittest.TestCase):
    def parse(self, ingredients, body, instructions=("Mix.",)):
        return extract.parse_jsonld_recipe(page(ingredients, list(instructions), body), URL)

    def test_names_travel_with_their_lines(self):
        body = wprm_ingredients([(None, FLAT[:2]), ("For the crumble:", FLAT[2:])])
        recipe = self.parse(FLAT, body)
        self.assertEqual(
            [(i["raw"], i.get("group")) for i in recipe["ingredients"]],
            [(FLAT[0], None), (FLAT[1], None), (FLAT[2], "For the crumble"), (FLAT[3], "For the crumble")],
        )

    def test_a_line_without_a_group_has_no_group_key_at_all(self):
        body = wprm_ingredients([(None, FLAT[:2]), ("Topping", FLAT[2:])])
        first = self.parse(FLAT, body)["ingredients"][0]
        self.assertNotIn("group", first)

    def test_all_caps_is_normalised_and_the_colon_dropped(self):
        body = wprm_ingredients([(None, FLAT[:3]), ("SAUCE:", FLAT[3:])])
        self.assertEqual(self.parse(FLAT, body)["ingredients"][3]["group"], "Sauce")

    def test_count_mismatch_means_no_groups(self):
        # The card lists 3 lines, the JSON-LD 4: which is which is unknowable.
        body = wprm_ingredients([(None, FLAT[:1]), ("Topping", FLAT[1:3])])
        recipe = self.parse(FLAT, body)
        self.assertTrue(all("group" not in i for i in recipe["ingredients"]))

    def test_no_markup_means_no_groups(self):
        recipe = self.parse(FLAT, "")
        self.assertTrue(all("group" not in i for i in recipe["ingredients"]))
        self.assertIsNone(recipe["instruction_groups"])

    def test_one_unnamed_group_or_one_named_group_is_not_a_section(self):
        for body in (
            wprm_ingredients([(None, FLAT)]),
            wprm_ingredients([("Ingredients", FLAT)]),
            wprm_ingredients([("For everything", FLAT)]),
        ):
            with self.subTest(body=body[:80]):
                recipe = self.parse(FLAT, body)
                self.assertTrue(all("group" not in i for i in recipe["ingredients"]))

    def test_a_blank_json_line_keeps_the_alignment(self):
        # Blank lines are dropped from the recipe but still counted on the card.
        lines = ["2 cups flour", "  ", "1 cup sugar", "3 tbsp butter"]
        body = wprm_ingredients([(None, ["2 cups flour", "", "1 cup sugar"]), ("Topping", ["3 tbsp butter"])])
        got = [(i["raw"], i.get("group")) for i in self.parse(lines, body)["ingredients"]]
        self.assertEqual(got, [("2 cups flour", None), ("1 cup sugar", None), ("3 tbsp butter", "Topping")])

    def test_the_card_that_is_the_pages_own_is_the_one_used(self):
        # A roundup page: the first card is another recipe with the same number of
        # lines, and the JSON-LD belongs to the second. Equal counts are not
        # enough; the first card's headings must not land on these lines.
        roundup = wprm_ingredients(
            [("Roundup A", ["1 cup rice", "2 eggs"]), ("Roundup B", ["1 onion", "3 cloves garlic"])]
        )
        own = wprm_ingredients([(None, FLAT[:2]), ("Topping", FLAT[2:])])
        recipe = self.parse(FLAT, roundup + own)
        self.assertEqual(
            [i.get("group") for i in recipe["ingredients"]], [None, None, "Topping", "Topping"]
        )

    def test_a_card_in_a_different_order_gets_no_groups(self):
        # Same count, same lines, different order: the headings would land on the
        # wrong lines, so none are kept.
        body = wprm_ingredients([("Crust", [FLAT[3], FLAT[2]]), ("Topping", [FLAT[1], FLAT[0]])])
        recipe = self.parse(FLAT, body)
        self.assertTrue(all("group" not in i for i in recipe["ingredients"]))

    def test_a_nested_list_that_shifts_the_count_cannot_shift_the_groups(self):
        # An <li> inside an <li> inflates the item count by one; the content check
        # refuses it rather than moving every later heading up a line.
        nested = (
            '<div class="wprm-recipe-ingredients-container"><div class="wprm-recipe-ingredient-group">'
            '<ul><li class="wprm-recipe-ingredient">2 cups flour<ul>'
            '<li class="wprm-recipe-ingredient">sifted twice</li></ul></li>'
            '<li class="wprm-recipe-ingredient">1 cup sugar</li></div>'
            '<div class="wprm-recipe-ingredient-group"><h4 class="wprm-recipe-group-name">Topping</h4>'
            '<ul><li class="wprm-recipe-ingredient">3 tbsp butter</li>'
            '<li class="wprm-recipe-ingredient">1 tsp salt</li></ul></div></div>'
        )
        recipe = self.parse(FLAT, nested)
        self.assertTrue(all("group" not in i for i in recipe["ingredients"]))


class StepSections(unittest.TestCase):
    def test_howtosection_names_its_steps_and_loose_steps_have_none(self):
        steps = [
            {"@type": "HowToStep", "text": "Preheat the oven."},
            {
                "@type": "HowToSection",
                "name": "To prepare crumble",
                "itemListElement": [
                    {"@type": "HowToStep", "text": "Mix flour and butter."},
                    {"@type": "HowToStep", "text": "Chill it."},
                ],
            },
            {
                "@type": "HowToSection",
                "name": "To prepare filling",
                "itemListElement": [{"@type": "HowToStep", "text": "Cook the apples."}],
            },
        ]
        recipe = extract.parse_jsonld_recipe(page(FLAT, steps), URL)
        self.assertEqual(
            recipe["instructions"],
            ["Preheat the oven.", "Mix flour and butter.", "Chill it.", "Cook the apples."],
        )
        self.assertEqual(
            recipe["instruction_groups"],
            [None, "To prepare crumble", "To prepare crumble", "To prepare filling"],
        )

    def test_flat_steps_are_unchanged_and_have_no_groups(self):
        recipe = extract.parse_jsonld_recipe(page(FLAT, ["One.", "Two."]), URL)
        self.assertEqual(recipe["instructions"], ["One.", "Two."])
        self.assertIsNone(recipe["instruction_groups"])

    def test_a_single_section_called_method_is_not_a_section(self):
        steps = [{"@type": "HowToSection", "name": "Method", "itemListElement": [{"text": "One."}, {"text": "Two."}]}]
        recipe = extract.parse_jsonld_recipe(page(FLAT, steps), URL)
        self.assertEqual(recipe["instructions"], ["One.", "Two."])
        self.assertIsNone(recipe["instruction_groups"])

    def test_wprm_card_sections_are_used_when_the_json_steps_are_flat(self):
        body = (
            '<div class="wprm-recipe-instructions-container">'
            '<div class="wprm-recipe-instruction-group"><ul><li class="wprm-recipe-instruction">a</li></ul></div>'
            '<div class="wprm-recipe-instruction-group"><h4 class="wprm-recipe-group-name">Filling</h4>'
            '<ul><li class="wprm-recipe-instruction">b</li><li class="wprm-recipe-instruction">c</li></ul></div>'
            "</div>"
        )
        recipe = extract.parse_jsonld_recipe(page(FLAT, ["a", "b", "c"], body), URL)
        self.assertEqual(recipe["instruction_groups"], [None, "Filling", "Filling"])

    def test_wprm_card_with_the_wrong_step_count_gives_none(self):
        body = (
            '<div class="wprm-recipe-instructions-container"><div class="wprm-recipe-instruction-group">'
            '<h4 class="wprm-recipe-group-name">Filling</h4>'
            '<ul><li class="wprm-recipe-instruction">a</li></ul></div></div>'
        )
        recipe = extract.parse_jsonld_recipe(page(FLAT, ["a", "b", "c"], body), URL)
        self.assertIsNone(recipe["instruction_groups"])


class CleanName(unittest.TestCase):
    def test_entities_and_non_text(self):
        self.assertEqual(sections.clean_name("Assembly &amp; Baking"), "Assembly & Baking")
        self.assertIsNone(sections.clean_name(["x"]))
        self.assertIsNone(sections.clean_name(5))

    def test_a_howtosection_with_a_list_for_a_name_is_unnamed(self):
        steps = [
            {"@type": "HowToSection", "name": ["x"], "itemListElement": [{"text": "One."}]},
            {"@type": "HowToSection", "name": "Filling", "itemListElement": [{"text": "Two."}]},
        ]
        recipe = extract.parse_jsonld_recipe(page(FLAT, steps), URL)
        self.assertEqual(recipe["instruction_groups"], [None, "Filling"])

    def test_names(self):
        self.assertEqual(sections.clean_name("  For the Crust: "), "For the Crust")
        self.assertEqual(sections.clean_name("SAUCE"), "Sauce")
        self.assertIsNone(sections.clean_name("Ingredients"))
        self.assertIsNone(sections.clean_name("   "))
        self.assertIsNone(sections.clean_name(None))
        self.assertEqual(len(sections.clean_name("x" * 200)), sections.MAX_NAME)


if __name__ == "__main__":
    unittest.main()
