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


def _assert_public_host(url: str) -> None:
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


def fetch_html(url: str) -> str:
    _assert_public_host(url)
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": UA}) as client:
        resp = client.get(url)
        # Redirects can land somewhere new — re-check the final host too
        _assert_public_host(str(resp.url))
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
    _assert_public_host(url)
    headers = {"User-Agent": UA, "Accept": "image/*,*/*"}
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers=headers) as client:
        with client.stream("GET", url) as resp:
            _assert_public_host(str(resp.url))
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
        from .ai import infer_tags

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


def _extract_social(url: str, source_type: str) -> dict:
    """Caption + Haiku. Falls back to a link card rather than failing."""
    from . import ai, social

    post = social.fetch_post(url, source_type)
    caption = social.strip_urls(post.get("caption") or "")

    if caption and ai.ai_available():
        try:
            structured = ai.structure_recipe(
                caption, context=f"This is the caption of a {source_type} post."
            )
            if structured.get("has_recipe") and structured.get("ingredients"):
                return social.to_recipe(structured, url, source_type, post)
        except ai.AIError as exc:
            log.info("caption structuring failed for %s: %s", url, exc)

    return social.link_card(url, source_type, post)


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
