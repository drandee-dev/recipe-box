"""Section headings on a recipe page ("For the crust", "Topping") that schema.org
drops.

Recipe sites list the same ingredient under several headings (butter for the
crust, the topping, the filling) and write their steps under the same headings.
`recipeIngredient` is one flat list, so the headings are gone by the time a
JSON-LD parser has read it; they survive in the page's own markup and, for steps,
in `HowToSection`. Nothing here guesses: a heading is kept only when the markup
names it AND the counts line up with the list it labels, and any disagreement
returns None, which is the same recipe as before.

Evidence this is the shape in the wild (checked on real pages, 2026-10-17): WP
Recipe Maker puts each group in a `.wprm-recipe-ingredient-group` with an
`h4.wprm-recipe-group-name`, and its item counts matched the page's JSON-LD
exactly on every page that carried groups. No other plugin was seen with groups,
so none is parsed.
"""

import re

MAX_NAME = 60

# A heading that only labels the list itself says nothing about a section.
GENERIC_NAMES = {"ingredients", "ingredient", "directions", "instructions", "method", "steps"}


def clean_name(text) -> str | None:
    name = re.sub(r"\s+", " ", str(text or "")).strip().strip(":").strip()
    if not name or name.lower() in GENERIC_NAMES:
        return None
    name = name[:MAX_NAME]
    # "SAUCE:" is how a plugin's stylesheet shouts it; the text is not.
    return name.capitalize() if name.isupper() else name


def informative(groups: list[str | None]) -> list[str | None] | None:
    """Groups worth keeping: at least one name, and more than one distinct value.
    A recipe whose every step sits in a single section labelled "Method" has no
    sections to tell apart."""
    if not any(groups) or len(set(groups)) < 2:
        return None
    return groups


def wprm_ingredient_groups(soup, count: int) -> list[str | None] | None:
    """One name (or None) per ingredient, in the order of `recipeIngredient`, read
    from a WP Recipe Maker block. None when there is no block, no named group, or
    the block does not hold exactly `count` lines (a second recipe card, or a page
    whose card and markup disagree: never guess which line is which)."""
    container = soup.select_one(".wprm-recipe-ingredients-container")
    if container is None:
        return None
    groups: list[str | None] = []
    for group in container.select(".wprm-recipe-ingredient-group"):
        label = group.select_one(".wprm-recipe-group-name")
        name = clean_name(label.get_text(" ")) if label else None
        groups.extend([name] * len(group.select("li.wprm-recipe-ingredient")))
    if len(groups) != count:
        return None
    return informative(groups)


def wprm_instruction_groups(soup, count: int) -> list[str | None] | None:
    """The same for steps, used when the JSON-LD steps are flat but the card has
    sections."""
    container = soup.select_one(".wprm-recipe-instructions-container")
    if container is None:
        return None
    groups: list[str | None] = []
    for group in container.select(".wprm-recipe-instruction-group"):
        label = group.select_one(".wprm-recipe-group-name")
        name = clean_name(label.get_text(" ")) if label else None
        groups.extend([name] * len(group.select("li.wprm-recipe-instruction")))
    if len(groups) != count:
        return None
    return informative(groups)
