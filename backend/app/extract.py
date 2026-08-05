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
        return {
            "title": _first_str(node.get("name")) or "Untitled recipe",
            "source_url": source_url,
            "source_type": "web",
            "image_url": _first_str(node.get("image")),
            "description": _first_str(node.get("description")),
            "ingredients": [
                {"raw": i.strip(), "item": None, "qty": None, "unit": None}
                for i in ingredients
                if isinstance(i, str) and i.strip()
            ],
            "instructions": _flatten_instructions(node.get("recipeInstructions")),
            "prep_min": _iso_duration_to_min(node.get("prepTime")),
            "cook_min": _iso_duration_to_min(node.get("cookTime")),
            "total_min": _iso_duration_to_min(node.get("totalTime")),
            "servings": _first_str(node.get("recipeYield")),
            "tags": [],
            "favorite": False,
        }
    return None


def extract_recipe(url: str) -> dict:
    html = fetch_html(url)
    recipe = parse_jsonld_recipe(html, url)
    if recipe is None:
        # Phase 3 adds microdata + AI-structuring fallbacks here
        raise ExtractError("no schema.org recipe found on that page")
    return recipe
