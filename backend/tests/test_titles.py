"""What a link card gets called.

A TikTok saved as a link card came back named with its entire 269-character
caption, emoji and hashtags and "Find the full recipe on inbloombakery.com" and
all. Two separate causes, and fixing either alone would have changed nothing:

  * `fetch_post` put oEmbed's `title` — which for TikTok *is* the caption — into
    both the `caption` and `title` slots, and `link_card` prefers `post["title"]`,
    so it never reached the fallback at all.
  * That fallback, `caption_title`, took "the first real line". TikTok's oEmbed
    returns captions with every newline stripped, so the first line was the whole
    caption. Measured across a sample: zero newlines, every time.

The real fix is that the model already named the post. `title` is a required
field in RECIPE_SCHEMA, so a caption that came back `has_recipe: false` still
came back with a name, on a call that had already been paid for — and the
link-card path was throwing it away.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import social  # noqa: E402

# The real caption from the post that prompted this, verbatim.
PUMPKIN = (
    "Pumpkin Cheesecake Cookies \U0001F9E1\U0001F342\U0001F383 The chewiest pumpkin spice "
    "cookies filled with creamy cheesecake and rolled in spiced sugar.  The best cookies to "
    "bake this autumn \U0001F970\U0001F9E1 Find the full recipe on inbloombakery.com "
    "\U0001F342\U0001F383 #pumpkincookies #pumpkincheesecake #cheesecake #fallbaking "
)

# A real one with no emoji at all, where only the length trim can help.
KOREAN = (
    "The recipes every home cook should know. Ep 20: Korean Popcorn Chicken Check my bio "
    "for the full written recipe!  #koreanpopcornchicken #homecook #cooking"
)


class ShortenTitle(unittest.TestCase):
    def test_it_cuts_where_the_creator_stopped_naming_the_dish(self):
        self.assertEqual(social.shorten_title(PUMPKIN), "Pumpkin Cheesecake Cookies")

    def test_a_short_title_is_returned_untouched(self):
        self.assertEqual(social.shorten_title("Banana bread"), "Banana bread")

    def test_with_no_emoji_it_trims_on_a_word_boundary(self):
        out = social.shorten_title(KOREAN)
        self.assertLessEqual(len(out), social.TITLE_CHARS + 1)  # +1 for the ellipsis
        self.assertTrue(out.endswith("…"))
        # A word-boundary trim, never mid-word — which is what title[:200] did.
        self.assertNotIn("Korea…", out)
        self.assertIn("Korean", out)

    def test_a_caption_opening_with_an_emoji_is_not_cut_to_nothing(self):
        """The guard: cutting at the first emoji run would leave an empty name."""
        self.assertEqual(social.shorten_title("\U0001F383 Pumpkin Cookies"), "Pumpkin Cookies")

    def test_a_flag_counts_as_an_emoji(self):
        out = social.shorten_title("Peruvian Chicken \U0001F1F5\U0001F1EA the best one")
        self.assertEqual(out, "Peruvian Chicken")


class CaptionTitle(unittest.TestCase):
    def test_a_caption_with_no_newlines_still_yields_a_name(self):
        """The bug: `splitlines()` on a caption TikTok flattened returns one item."""
        self.assertEqual(social.caption_title(PUMPKIN), "Pumpkin Cheesecake Cookies")

    def test_hashtags_never_reach_the_title(self):
        self.assertNotIn("#", social.caption_title(PUMPKIN))
        self.assertNotIn("#", social.caption_title(KOREAN))

    def test_an_empty_caption_gives_an_empty_title(self):
        self.assertEqual(social.caption_title(""), "")
        self.assertEqual(social.caption_title(None), "")


class FetchPost(unittest.TestCase):
    def test_the_caption_is_kept_whole_but_the_title_is_not_the_caption(self):
        oembed = {"title": PUMPKIN, "thumbnail_url": "https://cdn/x.jpg", "author_name": "A"}
        with patch.object(social, "_fetch_json", return_value=oembed):
            post = social.fetch_post("https://www.tiktok.com/@a/video/1", "tiktok")
        self.assertEqual(post["caption"], PUMPKIN, "the model and the description need it all")
        self.assertEqual(post["title"], "Pumpkin Cheesecake Cookies")


class LinkCardTitle(unittest.TestCase):
    def post(self):
        return {"caption": PUMPKIN, "image_url": "", "title": social.caption_title(PUMPKIN)}

    def test_the_models_own_title_wins_when_there_is_one(self):
        """It read the whole caption and knows which part is the dish. It is also
        free — the call happened, and the schema made it return a title even
        though it said has_recipe: false."""
        card = social.link_card(
            "https://t.com/1", "tiktok", self.post(), {"title": "Pumpkin Cheesecake Cookies"}
        )
        self.assertEqual(card["title"], "Pumpkin Cheesecake Cookies")

    def test_it_falls_back_to_the_caption_when_the_model_did_not_run(self):
        card = social.link_card("https://t.com/1", "tiktok", self.post(), None)
        self.assertEqual(card["title"], "Pumpkin Cheesecake Cookies")

    def test_a_blank_model_title_does_not_win(self):
        card = social.link_card("https://t.com/1", "tiktok", self.post(), {"title": "   "})
        self.assertEqual(card["title"], "Pumpkin Cheesecake Cookies")

    def test_the_caption_is_still_kept_in_full_as_the_description(self):
        """Shortening the name must not cost the creator's own words."""
        card = social.link_card("https://t.com/1", "tiktok", self.post(), None)
        self.assertIn("chewiest pumpkin spice cookies", card["description"])
        self.assertNotIn("#", card["description"])

    def test_no_title_anywhere_still_names_the_host(self):
        card = social.link_card("https://www.tiktok.com/@a/1", "tiktok", {}, None)
        self.assertEqual(card["title"], "Saved from tiktok.com")

    def test_no_link_card_title_is_ever_caption_length(self):
        for structured in (None, {"title": ""}):
            with self.subTest(structured=structured):
                card = social.link_card("https://t.com/1", "tiktok", self.post(), structured)
                self.assertLessEqual(len(card["title"]), social.TITLE_CHARS + 1)


if __name__ == "__main__":
    unittest.main()
