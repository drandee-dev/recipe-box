"""H2: a still from a TikTok post's own video, for when its cover has no clean food.

The cover a creator picks is often their face with a caption across it; the
finished dish is in the video. Used only after the cover pick found no food
(`images._video_pick`). This module only fetches and decodes; it keeps nothing.
"""

import time

from .extract import MAX_BYTES, ExtractError, assert_public_host, guarded_client

# A minute of TikTok video is about 12 MB. Anything past this is not a recipe
# short, and the function should not hold it in memory.
MAX_VIDEO_BYTES = 24 * 1024 * 1024
# Page plus video, whole. The per-read timeout alone lets a drip-fed body run
# past the function's own limit; the live check took 2.5-6 s.
VIDEO_DEADLINE_SECONDS = 20
FRAMES = 12
SHEET_COLUMNS = 4
TILE_WIDTH = 270  # 9:16 tiles, so the sheet is 1080 wide before the vision shrink


def tiktok_video(url: str) -> bytes:
    """The video behind a TikTok post, or ExtractError saying which step failed.

    One client for both requests on purpose: the video address is only honoured
    alongside the cookies the post's page set a moment earlier.
    """
    from . import social

    assert_public_host(url)
    deadline = time.monotonic() + VIDEO_DEADLINE_SECONDS
    with guarded_client() as (client, check):
        page = client.get(url)
        check(str(page.url))
        if page.status_code != 200:
            raise ExtractError(f"page answered {page.status_code}")
        if len(page.content) > MAX_BYTES:
            raise ExtractError("page too large")
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
                if time.monotonic() > deadline:
                    raise ExtractError("video too slow")
                chunks.append(chunk)
    return b"".join(chunks)


def video_frames(data: bytes, count: int = FRAMES) -> list:
    """`count` stills spread evenly through a video, as RGB PIL images.

    Each one is the keyframe at or before its mark: a seek lands on a keyframe
    and decoding on to the exact instant would cost a whole group of pictures per
    still, for a thumbnail that does not care which half second it is from.
    """
    # Inside the function, like Pillow in the mirror: a deployment without the
    # decoder loses this feature, not the API.
    import io

    import av

    stills = []
    with av.open(io.BytesIO(data)) as container:
        stream = container.streams.video[0]
        seconds = float(container.duration or 0) / av.time_base
        if seconds <= 0:
            return stills
        for n in range(count):
            container.seek(int(seconds * (n + 0.5) / count * av.time_base))
            frame = next(container.decode(stream), None)
            if frame is not None:
                stills.append(frame.to_image().convert("RGB"))
    return stills


def frame_sheet(frames: list):
    """The stills tiled in order, each numbered from 1 in its top-left corner."""
    from PIL import Image, ImageDraw, ImageFont

    tile_h = TILE_WIDTH * 16 // 9
    rows = (len(frames) + SHEET_COLUMNS - 1) // SHEET_COLUMNS
    sheet = Image.new("RGB", (TILE_WIDTH * SHEET_COLUMNS, tile_h * rows), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=40)
    for i, frame in enumerate(frames):
        x, y = (i % SHEET_COLUMNS) * TILE_WIDTH, (i // SHEET_COLUMNS) * tile_h
        tile = frame.copy()
        tile.thumbnail((TILE_WIDTH, tile_h))
        sheet.paste(tile, (x + (TILE_WIDTH - tile.width) // 2, y + (tile_h - tile.height) // 2))
        draw.text((x + 8, y + 6), str(i + 1), font=font, fill=(255, 255, 255), stroke_width=4, stroke_fill=(0, 0, 0))
    return sheet


def best_frame(url: str, chooser):
    """The still `chooser` (ai.pick_frame) says best shows the dish, or None.

    Raises whatever the fetch, decode or model raised; the caller treats any
    failure as "no frame", which leaves the recipe its tile.
    """
    from .images import _vision_jpeg

    frames = video_frames(tiktok_video(url))
    if not frames:
        return None
    n = chooser(*_vision_jpeg(frame_sheet(frames))).get("frame")
    return frames[n - 1] if isinstance(n, int) and 1 <= n <= len(frames) else None
