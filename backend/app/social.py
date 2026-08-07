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

from .ai import infer_tags, merge_tags
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


# Instagram does not serve the caption plainly. It serves the caption wrapped in
# page chrome, and both fields we read carry a different wrapper:
#
#   og:title        Franz Angelie Valencerina on Instagram: "the caption"
#   og:description  25K likes, 59 comments - franziee_v on November 2, 2025: "the caption"
#
# Both were being used raw. The engagement counts went to the model as part of
# the recipe text, which is enough for it to decide the post is a social blurb
# rather than a recipe, and when that happened the link-card fallback saved the
# og:title blob as the recipe's *name* — which is how a chicken recipe ended up
# called "Franz Angelie Valencerina on Instagram".
#
# One pattern covers both: chrome runs to the first `: "` on the opening line and
# the caption is everything inside the quotes that follow. Anchoring on that
# quote rather than on the words is what keeps a caption containing " on " from
# being eaten. A caption with no wrapper falls through untouched, which is the
# TikTok case and the normal web case.
_SOCIAL_WRAPPER = re.compile(r'^[^\n"]*\bon\b[^\n"]*:\s*"(.*)"\.?\s*$', re.DOTALL)


def unwrap_caption(text: str) -> str:
    """Strip social page chrome from a caption, leaving what was written."""
    body = (text or "").strip()
    if not body:
        return ""
    match = _SOCIAL_WRAPPER.match(body)
    return match.group(1).strip() if match else body


# Hashtags are excellent evidence for tagging and terrible prose, so they are
# kept for the tagger and taken out of anything a person reads.
_HASHTAGS = re.compile(r"(?:(?<=\s)|^)#[\w][\w'’-]*", re.UNICODE)


def hashtags_in(text: str) -> str:
    return " ".join(_HASHTAGS.findall(text or ""))


def strip_hashtags(text: str) -> str:
    return " ".join(_HASHTAGS.sub(" ", text or "").split())


def caption_title(caption: str) -> str:
    """The first real line of a caption, for when there is no better name.

    Creators lead with the dish — "Green onion crispy mayo chicken under 25 mins
    series" — so the opening line is a far better name than the account that
    posted it. Trailing colons come off because that line is usually a heading.
    """
    for line in (caption or "").splitlines():
        cleaned = strip_hashtags(line).strip(" -–—:")
        if len(cleaned) >= 3:
            return cleaned
    return ""


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
    raw_caption = tags.get("og:description") or tags.get("twitter:description") or ""
    raw_title = tags.get("og:title") or tags.get("twitter:title") or ""
    caption = unwrap_caption(raw_caption)
    title_body = unwrap_caption(raw_title)

    # Only social posts get the second half of this. On an ordinary web page
    # og:title is a real page title and og:description a real summary, and
    # treating one as a version of the other would throw the title away.
    if caption != raw_caption.strip() or title_body != raw_title.strip():
        # Both fields carry the same caption behind different chrome, so keep
        # whichever survived intact — og:description is the one Instagram
        # truncates. The name then comes from the caption's opening line, which
        # is the dish, rather than from the account that posted it.
        caption = caption if len(caption) >= len(title_body) else title_body
        title_body = caption_title(caption)

    return {
        "caption": caption,
        "image_url": tags.get("og:image") or tags.get("twitter:image") or "",
        "title": title_body,
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
    caption = (post.get("caption") or "").strip()
    title = (post.get("title") or "").strip() or caption_title(caption)
    if not title:
        host = (urlparse(url).hostname or "link").replace("www.", "")
        title = f"Saved from {host}"
    # Even a card nothing could be parsed out of is worth tagging: it is still
    # a chicken recipe you will look for under chicken later, and this is the
    # path that used to guarantee an untagged recipe.
    tags = infer_tags(
        title=title,
        description=caption,
        hashtags=hashtags_in(caption),
    )
    return {
        "title": title[:200],
        "source_url": url,
        "source_type": source_type,
        "image_url": post.get("image_url") or None,
        # Hashtags are stripped from what a person reads but kept above for the
        # tagger, which is the only thing they were ever good for.
        "description": strip_hashtags(caption)[:2000] or None,
        "ingredients": [],
        "instructions": [],
        "prep_min": None,
        "cook_min": None,
        "total_min": None,
        "servings": None,
        "tags": tags,
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
    caption = post.get("caption") or ""
    total_min = structured.get("total_min")
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
        # The model's own tags lead; inference only fills slots it left empty.
        # It sees the recipe and the keyword list doesn't, so where they
        # disagree the model is the one to trust — this is a floor, not a vote.
        "tags": merge_tags(
            structured.get("tags"),
            infer_tags(
                title=structured.get("title") or "",
                description=structured.get("description") or "",
                ingredients=ingredients,
                hashtags=hashtags_in(caption),
                total_min=total_min,
            ),
        ),
        "favorite": False,
    }


def strip_urls(text: str) -> str:
    return re.sub(r"https?://\S+", "", text).strip()
