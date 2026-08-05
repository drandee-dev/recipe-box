"""TikTok and Instagram caption fetching.

Creators usually write the recipe into the post caption, so the caption plus
Haiku structuring gets most of the way there. When no caption is reachable the
caller falls back to a link card with whatever thumbnail we found.

Every outbound fetch goes through the SSRF guard in extract.py.
"""

import json
import logging
import re
from urllib.parse import quote, urlparse

import httpx
from bs4 import BeautifulSoup

from .ai import normalize_tags
from .extract import TIMEOUT, UA, ExtractError, _assert_public_host, fetch_html

log = logging.getLogger("recipe.social")

TIKTOK_OEMBED = "https://www.tiktok.com/oembed?url={url}"

TIKTOK_HOSTS = {"tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"}
INSTAGRAM_HOSTS = {"instagram.com", "instagr.am", "ig.me"}


def detect_source(url: str) -> str:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    if host in TIKTOK_HOSTS or host.endswith(".tiktok.com"):
        return "tiktok"
    if host in INSTAGRAM_HOSTS or host.endswith(".instagram.com"):
        return "instagram"
    return "web"


def _fetch_json(url: str) -> dict | None:
    _assert_public_host(url)
    try:
        with httpx.Client(
            timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": UA}
        ) as client:
            resp = client.get(url)
            _assert_public_host(str(resp.url))
            if resp.status_code != 200:
                return None
            return resp.json()
    except (httpx.HTTPError, json.JSONDecodeError):
        return None


def _og_tags(url: str) -> dict:
    """og:/twitter: metadata. Instagram often blocks this; callers tolerate {}."""
    try:
        html = fetch_html(url)
    except (ExtractError, httpx.HTTPError):
        return {}
    soup = BeautifulSoup(html, "html.parser")
    tags = {}
    for meta in soup.find_all("meta"):
        key = meta.get("property") or meta.get("name") or ""
        content = meta.get("content") or ""
        if key and content:
            tags[key.lower()] = content
    return {
        "caption": tags.get("og:description") or tags.get("twitter:description") or "",
        "image_url": tags.get("og:image") or tags.get("twitter:image") or "",
        "title": tags.get("og:title") or tags.get("twitter:title") or "",
    }


def fetch_post(url: str, source_type: str) -> dict:
    """Best-effort caption + thumbnail. Missing values come back empty, not raised."""
    if source_type == "tiktok":
        data = _fetch_json(TIKTOK_OEMBED.format(url=quote(url, safe=""))) or {}
        if data.get("title") or data.get("thumbnail_url"):
            return {
                # TikTok's oEmbed "title" is the post caption.
                "caption": data.get("title") or "",
                "image_url": data.get("thumbnail_url") or "",
                "title": data.get("title") or "",
                "author": data.get("author_name") or "",
            }

    tags = _og_tags(url)
    return {
        "caption": tags.get("caption", ""),
        "image_url": tags.get("image_url", ""),
        "title": tags.get("title", ""),
        "author": "",
    }


def link_card(url: str, source_type: str, post: dict) -> dict:
    """Saveable placeholder when no recipe could be read from the caption."""
    title = (post.get("title") or "").strip()
    if not title:
        host = (urlparse(url).hostname or "link").replace("www.", "")
        title = f"Saved from {host}"
    return {
        "title": title[:200],
        "source_url": url,
        "source_type": source_type,
        "image_url": post.get("image_url") or None,
        "description": (post.get("caption") or "").strip()[:2000] or None,
        "ingredients": [],
        "instructions": [],
        "prep_min": None,
        "cook_min": None,
        "total_min": None,
        "servings": None,
        "tags": [],
        "favorite": False,
    }


def to_recipe(structured: dict, url: str, source_type: str, post: dict) -> dict:
    """Merge Haiku's output with the metadata we fetched ourselves."""
    ingredients = [
        {
            "raw": (i.get("raw") or "").strip(),
            "item": i.get("item"),
            "qty": i.get("qty"),
            "unit": i.get("unit"),
        }
        for i in structured.get("ingredients", [])
        if isinstance(i, dict) and (i.get("raw") or "").strip()
    ]
    steps = [s.strip() for s in structured.get("instructions", []) if isinstance(s, str) and s.strip()]
    return {
        "title": (structured.get("title") or post.get("title") or "Untitled recipe")[:200],
        "source_url": url,
        "source_type": source_type,
        "image_url": post.get("image_url") or None,
        "description": (structured.get("description") or "").strip()[:2000] or None,
        "ingredients": ingredients,
        "instructions": steps,
        "prep_min": structured.get("prep_min"),
        "cook_min": structured.get("cook_min"),
        "total_min": structured.get("total_min"),
        "servings": structured.get("servings"),
        "tags": normalize_tags(structured.get("tags")),
        "favorite": False,
    }


def strip_urls(text: str) -> str:
    return re.sub(r"https?://\S+", "", text).strip()
