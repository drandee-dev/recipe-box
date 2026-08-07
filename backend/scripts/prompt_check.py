"""Canonical inputs for the AI structurer, run against a deployed API.

The prompt in app/ai.py has now regressed twice in ways nothing would catch: a
hashtag block quietly halved the parse rate, and a tightening written for images
taught the model to reject any caption that lists ingredients without a method —
which is most of them, because the method is in the video. Both looked fine in
code review and both only showed up when a real post came back as a link card.

This is the cheap version of a test suite for that: a handful of captions whose
answers are not in doubt, run against the live endpoint. It costs a few model
calls, so run it after touching SYSTEM, not on every commit.

    python backend/scripts/prompt_check.py
    python backend/scripts/prompt_check.py --api http://localhost:8002 --runs 3
"""

import argparse
import json
import urllib.error
import urllib.request

DEFAULT_API = "https://recipe-box-api-sage.vercel.app"

# Each case: the text, and what has to be true of the answer. `recipe` False
# means the endpoint is expected to reject it as not a recipe.
CASES = [
    {
        "name": "ingredients only, no method",
        "why": "the common social caption — the method is in the video",
        "text": (
            "Green onion crispy mayo chicken under 25 mins series:\n\n"
            "Ingredients:\n3/4 kg chicken\nSalt\n1 tbsp garlic\n2 tbsp soy sauce\n"
            "1 tbsp oyster sauce\n2 tbsp mayo 3 tbsp cornstarch"
        ),
        "recipe": True,
        "min_ingredients": 5,
    },
    {
        "name": "ingredients and method",
        "why": "the easy case; a failure here means something is badly wrong",
        "text": (
            "Lemon garlic salmon\n\n2 salmon fillets\n1 lemon\n3 cloves garlic\n"
            "2 tbsp butter\n\nSear the salmon skin down for 4 minutes, flip, add the "
            "butter and garlic, and spoon it over for another 2."
        ),
        "recipe": True,
        "min_ingredients": 4,
        "min_steps": 1,
    },
    {
        "name": "hashtag block on the end",
        "why": "hashtags read as social-post furniture and once cost 2 parses in 5",
        "text": (
            "Best banana bread ever!!\n\n3 ripe bananas\n200 g flour\n100 g sugar\n"
            "2 eggs\n\nMash, mix, bake at 180C for 45 minutes.\n\n"
            "#bananabread #baking #easyrecipes #food #yummy #dessert #homemade"
        ),
        "recipe": True,
        "min_ingredients": 4,
        "min_steps": 1,
    },
    {
        "name": "not a recipe",
        "why": "the guard has to still hold, or every link becomes a fake recipe",
        "text": (
            "Went back to that little place near the harbour tonight and it was even "
            "better than last time. The room was packed by eight and the service never "
            "slipped once. Bring cash, they still don't take cards."
        ),
        "recipe": False,
    },
]


def structure(api: str, text: str) -> dict | None:
    """The recipe dict, or None when the endpoint says it isn't a recipe."""
    request = urllib.request.Request(
        f"{api.rstrip('/')}/api/recipes/structure",
        data=json.dumps({"text": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 422:
            return None
        raise SystemExit(f"HTTP {exc.code} from {api}: {exc.read().decode()[:200]}")


def check(case: dict, result: dict | None) -> tuple[bool, str]:
    if not case["recipe"]:
        return (result is None, "read as a recipe when it isn't one" if result else "rejected")
    if result is None:
        return False, "rejected as not a recipe"

    ingredients = len(result.get("ingredients") or [])
    steps = len(result.get("instructions") or [])
    if ingredients < case.get("min_ingredients", 1):
        return False, f"{ingredients} ingredients, wanted {case['min_ingredients']}+"
    if steps < case.get("min_steps", 0):
        return False, f"{steps} steps, wanted {case['min_steps']}+"
    return True, f"{ingredients} ingredients, {steps} steps"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=DEFAULT_API)
    # The model is not deterministic. One pass says the prompt is not obviously
    # broken; three says something about how reliably it holds.
    parser.add_argument("--runs", type=int, default=1)
    args = parser.parse_args()

    print(f"{args.api}  ({args.runs} run{'s' if args.runs > 1 else ''})\n")
    failures = 0
    for case in CASES:
        outcomes = []
        for _ in range(args.runs):
            ok, detail = check(case, structure(args.api, case["text"]))
            outcomes.append((ok, detail))
        passed = sum(1 for ok, _ in outcomes if ok)
        if passed < args.runs:
            failures += 1
        mark = "ok  " if passed == args.runs else "FAIL"
        print(f"{mark} {case['name']}: {passed}/{args.runs} — {outcomes[-1][1]}")
        print(f"     {case['why']}")

    print(f"\n{len(CASES) - failures}/{len(CASES)} cases clean")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
