"""The tag vocabulary and everything that decides which tags a recipe gets.

Split out of ai.py, which was two things wearing one name: the model call, and a
keyword tagger that never touches a model. The dependency runs one way — this
module imports nothing from ai.py, and ai.py takes `ALLOWED_TAGS` from here to
build the response schema's enum.

Two things elsewhere are pinned to this file and will break loudly rather than
quietly if it moves again: `frontend/src/lib/tags.js` hand-mirrors ALLOWED_TAGS,
and `frontend/src/lib/tags.test.js` parses this file to prove the two agree.
"""

import logging
import re

log = logging.getLogger("recipe.tags")

# Hashtags are stripped from anything the model reads and kept only for the
# keyword tagger. This is not tidiness, it is reliability: measured on one real
# caption, the same text parsed 5/5 times with the hashtag block removed and
# 3/5 with it. A wall of #food #yummy #easyrecipes reads as social-post furniture
# and pushes the model toward "this is a post, not a recipe", which lands the
# import in the link-card fallback as a blob of text. They also produced worse
# tags when they did parse — #friedchicken once came back as `air-fryer`.
_HASHTAGS = re.compile(r"(?:(?<=\s)|^)#[\w][\w'’-]*", re.UNICODE)


def hashtags_in(text: str) -> str:
    """Just the hashtags, for the tagger."""
    return " ".join(_HASHTAGS.findall(text or ""))


def strip_hashtags(text: str) -> str:
    """Everything but the hashtags, for the model and for anything a person reads."""
    return " ".join(_HASHTAGS.sub(" ", text or "").split())


# A closed vocabulary, because the tag list is a filter UI: forty one-off tags
# invented per recipe would be a worse list than a dozen that repeat. Mirrored in
# frontend/src/lib/tags.js — keep the two in step. The frontend also allows
# free-text tags typed by hand; this constraint is only on what the AI may add.
ALLOWED_TAGS = (
    # meal
    "breakfast", "lunch", "dinner", "snack", "dessert", "side",
    # kind of dish
    "soup", "salad", "pasta", "pizza", "sandwich", "bread", "drink", "sauce",
    # main protein
    "chicken", "beef", "pork", "seafood", "eggs", "tofu", "beans",
    # cuisine
    # "latin" is deliberately one tag covering Peru, Colombia, Brazil, Argentina
    # and the Spanish-speaking Caribbean, rather than a tag per country: a vault
    # of a few hundred recipes gets one Peruvian dish and one Colombian one, and
    # two tags with one recipe each are two tags nobody filters by. Mexican keeps
    # its own, because it is large enough globally to be worth finding alone.
    "italian", "mexican", "latin", "asian", "indian", "mediterranean", "american",
    # diet
    "vegetarian", "vegan", "gluten-free", "dairy-free", "low-carb",
    # how it's made
    "quick", "one-pot", "slow-cooker", "air-fryer", "grilled", "baked",
    "no-cook", "meal-prep",
)

MAX_TAGS = 5


def normalize_tags(tags) -> list:
    """Drop anything outside the vocabulary, lowercase, dedupe, cap the count.

    The schema already constrains this, so in practice nothing is dropped. It
    stays because the tag list is what the filter chips are built from: one
    hallucinated tag would be a permanent chip on a recipe nobody chose it for.
    """
    if not isinstance(tags, list):
        return []
    seen = []
    for tag in tags:
        if not isinstance(tag, str):
            continue
        slug = tag.strip().lower()
        if slug in ALLOWED_TAGS and slug not in seen:
            seen.append(slug)
    return seen[:MAX_TAGS]

# Keyword → tag, for the paths no model runs on and as a floor under the ones it
# does. Matched against the title, the ingredient lines, any hashtags and the
# description, longest phrase first so "black bean" beats "bean" and "ice cream"
# never reads as "cream".
#
# Only positive evidence counts. There is deliberately no rule inferring
# vegetarian or vegan from the *absence* of meat, because a caption that never
# mentions the stock it was simmered in would earn a badge the recipe fails, and
# a wrong diet tag is worse than no tag to anyone filtering by one.
TAG_KEYWORDS = {
    "chicken": ("chicken", "poultry", "drumstick", "chicken thigh", "chicken breast"),
    "beef": ("beef", "steak", "ground beef", "minced beef", "brisket", "sirloin"),
    "pork": ("pork", "bacon", "ham", "sausage", "chorizo", "pancetta", "prosciutto"),
    "seafood": (
        "seafood", "fish", "salmon", "tuna", "shrimp", "prawn", "cod", "crab",
        "scallop", "anchovy", "mussel", "tilapia", "halibut",
    ),
    "eggs": ("egg", "eggs", "omelette", "omelet", "frittata"),
    "tofu": ("tofu", "tempeh"),
    "beans": ("bean", "beans", "chickpea", "chickpeas", "lentil", "lentils", "black bean"),
    "pasta": (
        "pasta", "spaghetti", "penne", "lasagna", "lasagne", "macaroni",
        "fettuccine", "rigatoni", "orzo", "gnocchi", "carbonara",
    ),
    "pizza": ("pizza", "calzone"),
    "soup": ("soup", "stew", "broth", "chowder", "bisque", "ramen"),
    "salad": ("salad", "slaw"),
    "sandwich": ("sandwich", "burger", "wrap", "sub", "panini", "toastie"),
    "bread": ("bread", "focaccia", "sourdough", "baguette", "bun", "roll dough", "brioche"),
    "drink": ("smoothie", "cocktail", "mocktail", "juice", "latte", "lemonade", "iced coffee"),
    "sauce": ("sauce", "dressing", "salsa", "marinade", "dip", "chutney", "pesto"),
    "dessert": (
        "dessert", "cake", "cookie", "brownie", "pie", "ice cream", "pudding",
        "cheesecake", "muffin", "tart", "mousse", "doughnut", "donut",
    ),
    "breakfast": ("breakfast", "pancake", "waffle", "oatmeal", "porridge", "granola", "french toast"),
    "lunch": ("lunch", "lunchbox"),
    "dinner": ("dinner", "supper", "weeknight dinner"),
    "snack": ("snack", "snacks"),
    "side": ("side dish", "side salad"),
    "italian": ("italian", "risotto", "bruschetta", "parmigiana", "bolognese"),
    "mexican": ("mexican", "taco", "burrito", "enchilada", "quesadilla", "fajita"),
    "asian": (
        "asian", "soy sauce", "teriyaki", "stir fry", "stir-fry", "kimchi",
        "miso", "oyster sauce", "sesame oil", "hoisin", "gochujang", "sriracha",
        "thai", "japanese", "korean", "chinese", "vietnamese",
    ),
    # Latin America minus Mexico, which has its own tag above. Nationalities
    # first, then dish names specific enough to stand alone.
    #
    # Two words are missing on purpose. "chilean" is left out because "chilean
    # sea bass" is an ingredient in plenty of recipes that are not Chilean, and
    # INCIDENTAL only cleans the ingredient lines, not a title. "mole" is left
    # out because "guacamole" contains it.
    "latin": (
        "latin", "latino", "latin american", "south american", "peruvian",
        "colombian", "brazilian", "argentinian", "argentine", "venezuelan",
        "cuban", "puerto rican", "dominican", "ecuadorian", "bolivian",
        "salvadoran", "guatemalan", "honduran", "nicaraguan", "uruguayan",
        "aji verde", "aji amarillo", "aji panca", "lomo saltado", "ceviche",
        "pollo a la brasa", "arepa", "empanada", "chimichurri", "sofrito",
        "plantain", "tostones", "yuca", "feijoada", "churrasco", "picanha",
        "pupusa", "milanesa", "mofongo", "ropa vieja", "pernil", "alfajor",
        "dulce de leche", "tres leches",
    ),
    # "curry" alone is not evidence of anything: Thai, Japanese and Caribbean
    # curries are all curries. The dish names below are specific to the cuisine.
    "indian": ("indian", "masala", "tikka", "paneer", "dal", "naan", "biryani", "curry powder"),
    "mediterranean": (
        "mediterranean", "hummus", "feta", "tzatziki", "falafel", "greek", "tahini",
    ),
    "american": ("bbq", "barbecue", "mac and cheese", "cornbread", "meatloaf"),
    # Diets are claimed, never deduced. These fire on the words themselves.
    "vegetarian": ("vegetarian", "veggie recipe"),
    "vegan": ("vegan", "plant based", "plant-based"),
    "gluten-free": ("gluten free", "gluten-free", "glutenfree"),
    "dairy-free": ("dairy free", "dairy-free", "dairyfree"),
    "low-carb": ("low carb", "low-carb", "keto"),
    "one-pot": ("one pot", "one-pot", "one pan", "one-pan", "sheet pan", "traybake", "tray bake"),
    "slow-cooker": ("slow cooker", "slow-cooker", "crockpot", "crock pot"),
    "air-fryer": ("air fryer", "air-fryer", "airfryer"),
    "grilled": ("grilled", "grill", "barbecued", "chargrilled"),
    "baked": ("baked", "bake", "oven-baked", "roasted"),
    "no-cook": ("no cook", "no-cook", "no bake", "no-bake"),
    "meal-prep": ("meal prep", "meal-prep", "batch cook"),
    "quick": ("quick", "15 minute", "20 minute", "30 minute", "weeknight", "under 30"),
}

# Longest first, so a phrase wins over a word contained inside it.
_KEYWORD_ORDER = sorted(
    ((kw, tag) for tag, kws in TAG_KEYWORDS.items() for kw in kws),
    key=lambda pair: -len(pair[0]),
)

# What a dish *is* can only be read from its name, never from its shopping list.
# Soy sauce does not make a sauce, chicken broth does not make a soup, an egg in
# a cake is not an egg dish, and orange juice is not a drink. These tags are
# matched against the title, hashtags and description only.
# A dish belongs to one cuisine far more often than to two, and these are the
# tags where a single stray ingredient does the most damage — see the rule at the
# end of infer_tags.
CUISINE_TAGS = frozenset({
    "italian", "mexican", "latin", "asian", "indian", "mediterranean", "american",
})

NAME_ONLY_TAGS = frozenset({
    "soup", "salad", "pasta", "pizza", "sandwich", "bread", "drink", "sauce",
    "dessert", "eggs", "breakfast", "lunch", "dinner", "snack", "side",
})

# Ingredients that name something the dish is not about. Removed from the
# ingredient text before matching, so a vegetable soup simmered in chicken stock
# does not come back tagged chicken.
#
# The second group is the same mistake made about a cuisine rather than an
# animal: Greek yogurt is the base of a Peruvian green sauce and of an Indian
# raita, and italian seasoning is in half the chicken traybakes in the world.
# Naming a country is not the same as being from it.
INCIDENTAL = (
    "chicken broth", "chicken stock", "chicken bouillon",
    "beef broth", "beef stock", "beef bouillon",
    "fish sauce", "fish stock", "oyster sauce", "worcestershire",
    "bacon fat", "lard",
    "greek yogurt", "greek yoghurt",
    "italian seasoning", "italian herbs", "italian dressing",
)

# A recipe that takes half an hour is quick, whatever anyone called it. Only
# applied when the time is actually known.
QUICK_MINUTES = 30


def infer_tags(
    *,
    title: str = "",
    description: str = "",
    ingredients=(),
    labels: str = "",
    total_min=None,
) -> list:
    """Tags derivable without a model, from what the text plainly says.

    Used three ways: to fill in the JSON-LD path, which never calls a model at
    all; to tag a link card, which is all we have when a caption held no recipe;
    and to top up a model answer that came back thin.

    `labels` is explicit categorisation by whoever published the recipe — a
    caption's hashtags, or schema.org's recipeCategory and recipeCuisine. It
    counts as naming the dish, because that is what it is: a creator writing
    #chicken #airfryer has filed the post themselves. `description` does not,
    since on a link card the description *is* the whole caption, ingredient
    lines and all, and that is how "2 tbsp soy sauce" once tagged a chicken
    recipe as a sauce.
    """
    def flatten(*parts):
        # Hashes and hyphens go, so "#air-fryer" and "airfryer" both land.
        text = " ".join(p or "" for p in parts).lower().replace("#", " ").replace("-", " ")
        return " ".join(text.split())

    lines = []
    for item in ingredients or ():
        if isinstance(item, dict):
            lines.append(str(item.get("raw") or ""))
        elif isinstance(item, str):
            lines.append(item)

    # What the dish is called, and everything including what goes in it.
    name_blob = flatten(title, labels)
    ingredient_blob = flatten(*lines)
    for phrase in INCIDENTAL:
        ingredient_blob = ingredient_blob.replace(phrase, " ")
    ingredient_blob = " ".join(ingredient_blob.split())
    full_blob = f"{name_blob} {flatten(description)} {ingredient_blob}"

    found = []
    # Tags whose evidence was the dish's own name or the creator's own labels,
    # as opposed to something that merely turned up in the ingredients.
    named = set()
    for keyword, tag in _KEYWORD_ORDER:
        if tag in found:
            continue
        needle = keyword.replace("-", " ")
        haystack = name_blob if tag in NAME_ONLY_TAGS else full_blob
        if needle in haystack:
            found.append(tag)
            if needle in name_blob:
                named.add(tag)

    # When a recipe says what cuisine it is, that settles it, and any other
    # cuisine that matched only on an ingredient is dropped. Peruvian chicken
    # marinated in soy sauce is Latin and not Asian — soy sauce is genuinely
    # Peruvian, by way of chifa, and the ingredient list cannot tell you which
    # of the two kitchens it came from. The dish's name can.
    #
    # Only cuisines, and only when a cuisine was actually named: nothing here
    # touches a recipe whose cuisine is a guess in the first place, and the
    # protein and method tags have no such conflict to resolve.
    if CUISINE_TAGS & named:
        found = [t for t in found if t not in CUISINE_TAGS or t in named]

    if isinstance(total_min, int) and 0 < total_min <= QUICK_MINUTES and "quick" not in found:
        found.append("quick")
    return [t for t in found if t in ALLOWED_TAGS]


# Tags the model may not assert without the text backing it up.
#
# The model's tags otherwise lead outright, and that is still right: it read the
# recipe and a keyword list did not. But a *protein* is the one claim that is
# both flatly checkable and harmful when wrong — a pumpkin cookie came back
# tagged `pork`, which puts a cookie in front of someone filtering for pork and
# in front of someone avoiding it. Nothing in the title, the ingredients, the
# description or the hashtags said pork; the model simply picked a word out of
# the enum.
#
# So this is the mirror of the rule diets already follow. Diets are never
# inferred from *absence*; proteins are never asserted without *presence*. The
# check is deliberately permissive — any mention anywhere counts, `INCIDENTAL`
# is not applied — because the job is to catch a claim with no support at all,
# not to second-guess a model that saw something the keyword list would discount.
CHECKED_TAGS = frozenset({"chicken", "beef", "pork", "seafood", "eggs", "tofu", "beans"})


def drop_unsupported(tags, *, title="", description="", ingredients=(), labels="") -> list:
    """Model tags, minus any protein the text never mentions."""
    kept = normalize_tags(tags)
    if not any(t in CHECKED_TAGS for t in kept):
        return kept

    lines = []
    for item in ingredients or ():
        if isinstance(item, dict):
            lines.append(str(item.get("raw") or ""))
        elif isinstance(item, str):
            lines.append(item)
    blob = " ".join([title or "", description or "", labels or "", *lines])
    blob = " ".join(blob.lower().replace("#", " ").replace("-", " ").split())

    out = []
    for tag in kept:
        if tag in CHECKED_TAGS:
            needles = TAG_KEYWORDS.get(tag, (tag,))
            if not any(n.replace("-", " ") in blob for n in needles):
                log.info("dropping unsupported %s tag", tag)
                continue
        out.append(tag)
    return out


def merge_tags(primary, *extra) -> list:
    """Model tags first, inferred ones filling the remaining slots."""
    out = normalize_tags(primary)
    for group in extra:
        for tag in group or ():
            if len(out) >= MAX_TAGS:
                break
            if tag in ALLOWED_TAGS and tag not in out:
                out.append(tag)
    return out[:MAX_TAGS]
