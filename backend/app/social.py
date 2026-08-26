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

from .tags import drop_unsupported, hashtags_in, infer_tags, merge_tags, strip_hashtags
from .extract import ExtractError, assert_public_host, fetch_html, guarded_client

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
    try:
        assert_public_host(url)
        with guarded_client() as (client, check):
            resp = client.get(url)
            check(str(resp.url))
            if resp.status_code != 200:
                return None
            return resp.json()
    except (ExtractError, httpx.HTTPError, json.JSONDecodeError):
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


# Emoji, including the flag pairs and the variation selectors that trail them.
# Creators overwhelmingly write "Dish Name 🧡🍂🎃 then the sales pitch", so the
# first emoji run is the most reliable end-of-name marker available without a
# model — better than the first full stop, which on a series post ("The recipes
# every home cook should know. Ep 20: …") lands on the series and drops the dish.
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF"  # pictographs, food, symbols
    "\U00002600-\U000027BF"  # misc symbols and dingbats (✨, ❤, ➡)
    "\U0001F1E6-\U0001F1FF"  # regional indicators, i.e. flag pairs
    "️‍]+"  # variation selector and zero-width joiner
)

# The cell title clamps to two lines at roughly 34 characters each, so anything
# past this is invisible there anyway — and a title is also searched, where a
# caption-length one matches nearly every query.
TITLE_CHARS = 70


def shorten_title(text: str, limit: int = TITLE_CHARS) -> str:
    """A caption's opening words, cut down to something that reads as a name.

    Two passes. The emoji run first, since that is where the creator themselves
    stopped naming the dish and started selling it. Then a word-boundary trim, so
    the fallback is a clipped phrase rather than a word cut in half — which is
    what `title[:200]` was doing.
    """
    body = (text or "").strip()
    # A caption that opens with an emoji would otherwise cut to nothing, so the
    # leading run comes off first and the search starts at the real words.
    body = _EMOJI.sub("", body, count=1).strip() if _EMOJI.match(body) else body
    match = _EMOJI.search(body)
    if match and len(head := body[: match.start()].strip(" -–—:,.")) >= 3:
        body = head
    if len(body) <= limit:
        return body
    return body[:limit].rsplit(" ", 1)[0].rstrip(" -–—:,.") + "…"


def caption_title(caption: str) -> str:
    """The dish's name as best it can be read off a caption, with no model.

    This used to take "the first real line", which assumed the caption had lines.
    TikTok's oEmbed returns them with **every newline stripped** — all of a
    sample came back with zero — so the "first line" was the whole caption, and
    a 269-character post title was the result. Whatever survives that is now put
    through `shorten_title`, which is what actually does the work.
    """
    for line in (caption or "").splitlines():
        cleaned = strip_hashtags(line).strip(" -–—:")
        if len(cleaned) >= 3:
            return shorten_title(cleaned)
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
            caption = data.get("title") or ""
            return {
                # TikTok's oEmbed "title" is the post caption, not a title, and
                # putting it in both slots is how a 269-character caption became
                # a recipe's *name*. `title` gets a shortened read of it instead;
                # `caption` keeps every word for the model and the description.
                "caption": caption,
                "image_url": data.get("thumbnail_url") or "",
                "title": caption_title(caption),
                "author": data.get("author_name") or "",
            }

    tags = _og_tags(url)
    return {
        "caption": tags.get("caption", ""),
        "image_url": tags.get("image_url", ""),
        "title": tags.get("title", ""),
        "author": "",
    }


def link_card(url: str, source_type: str, post: dict, structured: dict | None = None) -> dict:
    """Saveable placeholder when no recipe could be read from the caption.

    `structured` is the model's answer when there was one. Reaching this function
    means it said `has_recipe: false`, but `title` is a *required* field in
    RECIPE_SCHEMA, so it named the post anyway — and that call has already been
    paid for. Using it is free and it is the best namer available: it reads the
    whole caption and knows which part is the dish, where the mechanical fallback
    can only guess from punctuation and emoji.
    """
    caption = (post.get("caption") or "").strip()
    title = (
        ((structured or {}).get("title") or "").strip()
        or (post.get("title") or "").strip()
        or caption_title(caption)
    )
    if not title:
        host = (urlparse(url).hostname or "link").replace("www.", "")
        title = f"Saved from {host}"
    # Even a card nothing could be parsed out of is worth tagging: it is still
    # a chicken recipe you will look for under chicken later, and this is the
    # path that used to guarantee an untagged recipe.
    tags = infer_tags(
        title=title,
        description=caption,
        labels=hashtags_in(caption),
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
            # The model leads, but not on a protein the text never mentions.
            drop_unsupported(
                structured.get("tags"),
                title=structured.get("title") or "",
                description=structured.get("description") or "",
                ingredients=ingredients,
                labels=hashtags_in(caption),
            ),
            infer_tags(
                title=structured.get("title") or "",
                description=structured.get("description") or "",
                ingredients=ingredients,
                labels=hashtags_in(caption),
                total_min=total_min,
            ),
        ),
        "favorite": False,
    }


def graft_written_recipe(recipe: dict, linked: dict | None) -> dict:
    """Fill a caption-derived recipe's gaps from the page the caption linked to.

    Deliberately additive. The caption is what the person actually saved and its
    ingredient lines are the ones they saw, so they stay; the linked page only
    supplies what the caption never had. Anything already present is left alone,
    which is what stops a loosely related link from rewriting a recipe that was
    fine.
    """
    if not linked:
        return recipe
    if not recipe.get("instructions") and linked.get("instructions"):
        recipe["instructions"] = linked["instructions"]
    for field in ("prep_min", "cook_min", "total_min", "servings"):
        if recipe.get(field) is None and linked.get(field) is not None:
            recipe[field] = linked[field]
    if not recipe.get("description") and linked.get("description"):
        recipe["description"] = (linked["description"] or "")[:2000] or None
    recipe["tags"] = merge_tags(recipe.get("tags"), linked.get("tags"))
    return recipe


def from_caption_link(linked: dict, url: str, source_type: str, post: dict) -> dict:
    """A recipe read off a caption's link, re-attributed to the post it came from.

    The post is what was saved and what the person will recognise in the list, so
    the source stays the post and the thumbnail stays the post's — a social cover
    frame is usually the better photo anyway, and it is the one the mirror knows
    how to repair. Everything else is the linked page's, since that is the half
    the caption did not have.
    """
    # parse_jsonld_recipe always fills a title, so the fallback is for the page
    # whose markup had no name and got the placeholder — there the post's own
    # first line is a real dish name and the placeholder is not.
    title = linked.get("title") or ""
    if title in ("", "Untitled recipe"):
        title = post.get("title") or caption_title(post.get("caption") or "") or title
    return {
        **linked,
        "title": (title or "Untitled recipe")[:200],
        "source_url": url,
        "source_type": source_type,
        "image_url": post.get("image_url") or linked.get("image_url") or None,
    }


def strip_urls(text: str) -> str:
    return re.sub(r"https?://\S+", "", text).strip()
