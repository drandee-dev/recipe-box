"""Recipe extraction from user-supplied URLs.

Pipeline (phase 1): fetch HTML server-side, parse schema.org Recipe JSON-LD.
Every fetch of a user-supplied URL MUST go through fetch_html() — it carries
the SSRF guard, timeout, and size cap.
"""

import ipaddress
import json
import logging
import re
import socket
from contextlib import contextmanager
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

log = logging.getLogger("recipe.extract")

MAX_BYTES = 3 * 1024 * 1024
# Photos are allowed to be bigger than a page of HTML — a magazine site's hero
# is routinely 3000px wide, which is the whole reason we resize before storing.
MAX_IMAGE_BYTES = 8 * 1024 * 1024
TIMEOUT = 10.0
UA = "Mozilla/5.0 (compatible; RecipeBox/0.1; personal recipe saver)"


class ExtractError(Exception):
    """Raised when a URL can't be fetched or no recipe is found."""


def assert_public_host(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ExtractError("only http/https URLs are supported")
    host = parsed.hostname
    if not host:
        raise ExtractError("URL has no host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ExtractError("host does not resolve") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ExtractError("host resolves to a non-public address")


@contextmanager
def guarded_client(**headers: str):
    """An httpx client that has already checked where it is being pointed.

    Every outbound fetch of a user-supplied URL has to do the same two things,
    and the second is the one that is easy to leave out: check the host before
    connecting, and check it *again* on the final URL, because a redirect can
    land somewhere the first check would have refused. Three call sites did this
    by hand and a fourth would eventually have done it by hand incorrectly,
    which is not a bug but an SSRF hole.

    Yields `(client, check)`. Call `check(resp.url)` once the response is in
    hand; it is the post-redirect half and there is no path that may skip it.
    """
    with httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": UA, **headers},
    ) as client:
        yield client, assert_public_host


def fetch_html(url: str) -> str:
    assert_public_host(url)
    with guarded_client() as (client, check):
        resp = client.get(url)
        check(str(resp.url))
        resp.raise_for_status()
        if len(resp.content) > MAX_BYTES:
            raise ExtractError("page too large")
        return resp.text


def fetch_bytes(url: str, max_bytes: int = MAX_IMAGE_BYTES) -> tuple[bytes, str]:
    """Binary fetch behind the same SSRF guard, for image mirroring.

    Streamed and cut off mid-download once the cap is passed, which fetch_html
    does not do — it reads the whole body and checks the length afterwards. That
    is fine against a 3 MB HTML cap and not fine here, where a hostile or merely
    broken origin can keep sending bytes for as long as we keep reading them.
    """
    assert_public_host(url)
    with guarded_client(Accept="image/*,*/*") as (client, check):
        with client.stream("GET", url) as resp:
            check(str(resp.url))
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            chunks: list[bytes] = []
            total = 0
            for chunk in resp.iter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ExtractError("file too large")
                chunks.append(chunk)
    return b"".join(chunks), content_type


def _iso_duration_to_min(value) -> int | None:
    if not isinstance(value, str):
        return None
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?", value.strip())
    if not m:
        return None
    days, hours, mins = (int(g) if g else 0 for g in m.groups())
    total = days * 1440 + hours * 60 + mins
    return total or None


def _first_str(value) -> str | None:
    """schema.org fields are wildly inconsistent: str, list, or nested object."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        for item in value:
            got = _first_str(item)
            if got:
                return got
        return None
    if isinstance(value, dict):
        return _first_str(value.get("url") or value.get("name") or value.get("@id"))
    return None


def _joined_str(value) -> str:
    """Every string in a field, not just the first.

    `keywords` is routinely a list of a dozen terms and `_first_str` would keep
    one of them, which for tagging is the difference between reading the site's
    own categorisation and reading a single word of it.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_joined_str(v) for v in value)
    if isinstance(value, dict):
        return _joined_str(value.get("name") or value.get("url") or "")
    return ""


def _flatten_instructions(value) -> list[str]:
    steps: list[str] = []
    if isinstance(value, str):
        steps.extend(s.strip() for s in re.split(r"\n+", value) if s.strip())
    elif isinstance(value, list):
        for item in value:
            steps.extend(_flatten_instructions(item))
    elif isinstance(value, dict):
        if value.get("@type") == "HowToSection":
            steps.extend(_flatten_instructions(value.get("itemListElement", [])))
        else:
            text = value.get("text") or value.get("name")
            if isinstance(text, str) and text.strip():
                steps.append(text.strip())
    return steps


def _find_recipe_node(data) -> dict | None:
    if isinstance(data, dict):
        node_type = data.get("@type", "")
        types = node_type if isinstance(node_type, list) else [node_type]
        if "Recipe" in types:
            return data
        for value in (data.get("@graph"), data.get("mainEntity")):
            found = _find_recipe_node(value)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = _find_recipe_node(item)
            if found:
                return found
    return None


def parse_jsonld_recipe(html: str, source_url: str) -> dict | None:
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        node = _find_recipe_node(data)
        if not node:
            continue
        ingredients = node.get("recipeIngredient") or node.get("ingredients") or []
        if isinstance(ingredients, str):
            ingredients = [ingredients]

        parsed = [
            {"raw": i.strip(), "item": None, "qty": None, "unit": None}
            for i in ingredients
            if isinstance(i, str) and i.strip()
        ]
        total_min = _iso_duration_to_min(node.get("totalTime"))

        # This path never calls a model, so it used to hand back an untagged
        # recipe every time — a recipe site with good markup ended up worse
        # organised than a TikTok caption. schema.org has fields for exactly
        # this, and where they are missing the keyword pass reads the text.
        from .tags import infer_tags

        marked_up = " ".join(
            _joined_str(node.get(field))
            for field in ("recipeCategory", "recipeCuisine", "keywords", "suitableForDiet")
        )
        tags = infer_tags(
            title=_first_str(node.get("name")) or "",
            description=_first_str(node.get("description")) or "",
            labels=marked_up,
            ingredients=parsed,
            total_min=total_min,
        )
        return {
            "title": _first_str(node.get("name")) or "Untitled recipe",
            "source_url": source_url,
            "source_type": "web",
            "image_url": _first_str(node.get("image")),
            "description": _first_str(node.get("description")),
            "ingredients": parsed,
            "instructions": _flatten_instructions(node.get("recipeInstructions")),
            "prep_min": _iso_duration_to_min(node.get("prepTime")),
            "cook_min": _iso_duration_to_min(node.get("cookTime")),
            "total_min": total_min,
            "servings": _first_str(node.get("recipeYield")),
            "tags": tags,
            "favorite": False,
        }
    return None


def readable_text(html: str, limit: int = 12000) -> str:
    """Page text with the furniture stripped, for the AI fallback."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "form", "noscript"]):
        tag.decompose()
    lines = (line.strip() for line in soup.get_text("\n").splitlines())
    return "\n".join(line for line in lines if line)[:limit]


# Creators who write the method somewhere other than the caption either say
# "check my bio" or drop the link straight in. The second case is the one worth
# following: it names the page rather than a profile holding a hundred of them.
CAPTION_LINKS = re.compile(r"https?://[^\s<>\"')\]]+")

# Two is enough for "recipe link plus one other thing" and bounds what a caption
# stuffed with affiliate links can cost us in fetches.
MAX_CAPTION_LINKS = 2


def _caption_link_recipe(caption: str, post_url: str) -> dict | None:
    """A schema.org recipe from a link the caption itself carried, or None.

    `strip_urls` deletes these before the caption reaches the model, so until now
    a creator who linked their own blog post was no better off than one who
    linked nothing. This costs one fetch and no model call, since it only accepts
    a page with real JSON-LD — the readable-text fallback is deliberately not
    reused here, because at that point we would be paying Haiku to read a page we
    only guessed was the recipe.

    Every failure returns None and the caller carries on exactly as before, so
    this can never turn a working import into a worse one.
    """
    from . import social

    tried = 0
    for match in CAPTION_LINKS.finditer(caption or ""):
        link = match.group(0).rstrip(".,;:!?")
        # A link back to TikTok or Instagram is a profile, another post, or a
        # "follow me" — never the written recipe, and following it would mean
        # re-entering the social path from inside itself.
        if social.detect_source(link) != "web" or link == post_url:
            continue
        tried += 1
        if tried > MAX_CAPTION_LINKS:
            break
        try:
            recipe = parse_jsonld_recipe(fetch_html(link), link)
        except (ExtractError, httpx.HTTPError) as exc:
            log.info("caption link %s could not be read: %s", link, exc)
            continue
        if recipe and recipe.get("ingredients"):
            return recipe
    return None


def _read_post_image(url: str, source_type: str, post: dict) -> dict | None:
    """Last resort: read the recipe off the post's own picture.

    Plenty of creators put the whole recipe on the image — a card, a screenshot,
    a text overlay — and write nothing but a sentence in the caption. This is
    the only path that reaches for it, and only after the caption has produced
    nothing, so an ordinary import never pays for a second model call.

    Returns None for every failure. The caller's answer to "no recipe" is
    already a link card, and that is the right answer whether the picture was
    unreachable, unreadable, or simply a photo of a finished plate.
    """
    from . import ai, social

    image_url = post.get("image_url")
    if not image_url or not ai.ai_available():
        return None

    try:
        from .images import ImageError, image_for_vision
    except ImportError:
        # Same shape as the mirror: one missing dependency costs this feature,
        # not the import. /api/health reports `images` for exactly this.
        log.exception("vision fallback unavailable: the image pipeline is missing")
        return None

    try:
        data, _content_type = fetch_bytes(image_url)
        image_b64, media_type = image_for_vision(data)
    except (ExtractError, ImageError) as exc:
        log.info("vision fallback could not read %s: %s", image_url, exc)
        return None
    except httpx.HTTPError as exc:
        log.info("vision fallback could not fetch %s: %s", image_url, exc)
        return None

    try:
        structured = ai.structure_recipe_image(
            image_b64,
            media_type,
            text=social.strip_urls(post.get("caption") or ""),
            context=(
                f"This is the image from a {source_type} post, with its caption. "
                "The caption alone did not contain a recipe."
            ),
        )
    except ai.AIError as exc:
        log.info("image structuring failed for %s: %s", url, exc)
        return None

    if structured.get("has_recipe") and structured.get("ingredients"):
        return social.to_recipe(structured, url, source_type, post)
    return None


def _extract_social(url: str, source_type: str) -> dict:
    """Caption, then the picture, then a link card. Never an error."""
    from . import ai, social

    post = social.fetch_post(url, source_type)
    raw_caption = post.get("caption") or ""
    caption = social.strip_urls(raw_caption)

    # Kept past the block below so the link card can borrow the model's title.
    # The model ran, read the caption and named the post; the only thing it said
    # no to was there being a recipe in it.
    structured = None
    if caption and ai.ai_available():
        try:
            structured = ai.structure_recipe(
                caption, context=f"This is the caption of a {source_type} post."
            )
            if structured.get("has_recipe") and structured.get("ingredients"):
                recipe = social.to_recipe(structured, url, source_type, post)
                # The common partial import: ingredients in the caption, method
                # left to the video. If the caption also carried a link, the
                # written recipe is very likely on the other end of it.
                if not recipe["instructions"]:
                    social.graft_written_recipe(recipe, _caption_link_recipe(raw_caption, url))
                return recipe
        except ai.AIError as exc:
            log.info("caption structuring failed for %s: %s", url, exc)

    # Before the picture, not after: this path costs no model call, and a caption
    # that named its own recipe page is a better source than a video thumbnail.
    linked = _caption_link_recipe(raw_caption, url)
    if linked is not None:
        return social.from_caption_link(linked, url, source_type, post)

    from_image = _read_post_image(url, source_type, post)
    if from_image is not None:
        return from_image

    return social.link_card(url, source_type, post, structured)


def extract_recipe(url: str) -> dict:
    from . import ai, social

    source_type = social.detect_source(url)
    if source_type != "web":
        return _extract_social(url, source_type)

    html = fetch_html(url)
    recipe = parse_jsonld_recipe(html, url)
    if recipe is not None:
        return recipe

    # No schema.org markup: hand the readable text to Haiku.
    if ai.ai_available():
        try:
            structured = ai.structure_recipe(
                readable_text(html), context="This is the text of a web page."
            )
            if structured.get("has_recipe") and structured.get("ingredients"):
                page = social.fetch_post(url, "web")
                return social.to_recipe(structured, url, "web", page)
        except ai.AIError as exc:
            log.info("page structuring failed for %s: %s", url, exc)

    raise ExtractError("no recipe found on that page")
