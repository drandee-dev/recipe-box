"""Section headings on a recipe page ("For the crust", "Topping") that schema.org
drops.

Recipe sites list the same ingredient under several headings (butter for the
crust, the topping, the filling) and write their steps under the same headings.
`recipeIngredient` is one flat list, so the headings are gone by the time a
JSON-LD parser has read it; they survive in the page's own markup and, for steps,
in `HowToSection`. Nothing here guesses: a heading is kept only when the markup
names it AND the card lines up with the list it labels, both in count and in
content, and any disagreement returns None, which is the same recipe as before.

Evidence this is the shape in the wild (checked on real pages, 2026-10-17): WP
Recipe Maker puts each group in a `.wprm-recipe-ingredient-group` with an
`h4.wprm-recipe-group-name`, and its item counts matched the page's JSON-LD
exactly on every page that carried groups. No other plugin was seen with groups,
so none is parsed.
"""

import html
import re

MAX_NAME = 60

# A heading that only labels the list itself says nothing about a section.
GENERIC_NAMES = {"ingredients", "ingredient", "directions", "instructions", "method", "steps"}


def clean_name(text) -> str | None:
    # A section name that is not text (a list, a number) is not a name.
    if not isinstance(text, str):
        return None
    name = re.sub(r"\s+", " ", html.unescape(text)).strip().strip(":").strip()
    if not name or name.lower() in GENERIC_NAMES:
        return None
    name = name[:MAX_NAME]
    # "SAUCE:" is how a plugin's stylesheet shouts it; the text is not. "A & B"
    # has no shouting word in it and is left alone.
    return name.capitalize() if name.isupper() and re.search(r"[A-Z]{3,}", name) else name


def informative(groups: list[str | None]) -> list[str | None] | None:
    """Groups worth keeping: at least one name, and more than one distinct value.
    A recipe whose every step sits in a single section labelled "Method" has no
    sections to tell apart."""
    if not any(groups) or len(set(groups)) < 2:
        return None
    return groups


# Words every recipe line shares, so sharing one proves nothing: "1 cup oats" and
# "1 cup flour" are not the same line. Without this a wrong card whose units and
# descriptors happen to line up passes the content check.
COMMON_WORDS = {
    "cup", "cups", "tbsp", "tsp", "tablespoon", "tablespoons", "teaspoon", "teaspoons",
    "ounce", "ounces", "oz", "pound", "pounds", "lbs", "lb", "gram", "grams", "kilogram",
    "milliliter", "milliliters", "liter", "liters", "pinch", "dash", "can", "cans", "package",
    "large", "small", "medium", "fresh", "chopped", "diced", "minced", "sliced", "ground",
    "whole", "plus", "more", "about", "divided", "optional", "taste", "the", "and", "for",
    "with", "into", "finely", "roughly", "cut", "peeled", "cold", "warm", "room", "temperature",
    "melted", "softened", "packed", "cubed", "grated", "shredded",
}


def _words(text) -> set[str]:
    found = re.findall(r"[a-z]{3,}", html.unescape(str(text or "")).lower())
    return {w for w in found if w not in COMMON_WORDS}


def _same_content(card: list[str], listed: list) -> bool:
    """Line n of the card is line n of the list: the two share a word of three
    letters or more at every position (or are both empty). Equal counts alone
    would let a roundup page's other card, or a card in a different order, hand
    its headings to the wrong lines."""
    if len(card) != len(listed):
        return False
    for on_card, in_list in zip(card, listed):
        a, b = _words(on_card), _words(in_list)
        if (a or b) and not (a & b):
            return False
    return True


def _groups(soup, container_sel: str, group_sel: str, item_sel: str, listed: list) -> list[str | None] | None:
    """One name (or None) per line, from the first WP Recipe Maker card whose
    lines are the page's own."""
    for container in soup.select(container_sel):
        groups: list[str | None] = []
        texts: list[str] = []
        for group in container.select(group_sel):
            label = group.select_one(".wprm-recipe-group-name")
            name = clean_name(label.get_text(" ")) if label else None
            items = group.select(item_sel)
            groups.extend([name] * len(items))
            texts.extend(item.get_text(" ", strip=True) for item in items)
        if _same_content(texts, listed):
            return informative(groups)
    return None


def wprm_ingredient_groups(soup, listed: list) -> list[str | None] | None:
    """One name (or None) per entry of `recipeIngredient`, in its order. `listed`
    is that list exactly as the page gave it, blanks and all."""
    return _groups(
        soup,
        ".wprm-recipe-ingredients-container",
        ".wprm-recipe-ingredient-group",
        "li.wprm-recipe-ingredient",
        listed,
    )


def wprm_instruction_groups(soup, listed: list) -> list[str | None] | None:
    """The same for steps, used when the JSON-LD steps are flat but the card has
    sections."""
    return _groups(
        soup,
        ".wprm-recipe-instructions-container",
        ".wprm-recipe-instruction-group",
        "li.wprm-recipe-instruction",
        listed,
    )
