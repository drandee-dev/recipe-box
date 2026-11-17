"""A TikTok post's own video, for picking a thumbnail frame that shows the food.

The cover a creator picks is usually their face with a caption across it. The
finished dish is in the video. This module only fetches; it keeps nothing.
"""

import time

import httpx

from .extract import ExtractError, assert_public_host, guarded_client

# A minute of TikTok video is about 12 MB. Anything past this is not a recipe
# short, and the function should not hold it in memory.
MAX_VIDEO_BYTES = 24 * 1024 * 1024


def tiktok_video(url: str) -> bytes:
    """The video behind a TikTok post, or ExtractError saying which step failed.

    One client for both requests on purpose: the video address is only honoured
    alongside the cookies the post's page set a moment earlier.
    """
    from . import social

    assert_public_host(url)
    with guarded_client() as (client, check):
        page = client.get(url)
        check(str(page.url))
        if page.status_code != 200:
            raise ExtractError(f"page answered {page.status_code}")
        video = social._tiktok_item(page.text).get("video")
        play = video.get("playAddr") if isinstance(video, dict) else None
        if not isinstance(play, str) or not play.startswith("http"):
            raise ExtractError("the page carries no video address")
        assert_public_host(play)
        with client.stream("GET", play, headers={"Referer": "https://www.tiktok.com/"}) as resp:
            check(str(resp.url))
            content_type = resp.headers.get("content-type", "")
            if resp.status_code != 200 or "video" not in content_type:
                raise ExtractError(f"video answered {resp.status_code} {content_type[:40]}")
            chunks, total = [], 0
            for chunk in resp.iter_bytes():
                total += len(chunk)
                if total > MAX_VIDEO_BYTES:
                    raise ExtractError("video too large")
                chunks.append(chunk)
    return b"".join(chunks)


def probe(url: str) -> dict:
    """Throwaway readout for the feasibility check. Numbers and reasons only."""
    started = time.time()
    try:
        data = tiktok_video(url)
    except (ExtractError, httpx.HTTPError) as exc:
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"[:200], "seconds": round(time.time() - started, 2)}
    return {
        "ok": True,
        "bytes": len(data),
        "looks_like_mp4": data[4:8] == b"ftyp",
        "seconds": round(time.time() - started, 2),
    }
