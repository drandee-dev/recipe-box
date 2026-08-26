"""Following a bare domain written into a caption.

Creators write the address, not the link: "Find the full recipe on
inbloombakery.com". `CAPTION_LINKS` only sees `https://`, so that whole class of
post was importing as a link card while the complete recipe sat one hop away.

The hop is not just "fetch the domain". The address names the *site*, and the
site's front page is a CollectionPage with no recipe on it — so the question is
how to get from a site to the right page without guessing. The answer used here
is that the site says: a WordPress food blog publishes a schema.org
`SearchAction` in its own JSON-LD, giving the exact URL template to search it
with. Read that, search it for the dish, and rank the results by how much of the
dish's name is in each URL.

Ranking matters and is not paranoia. A real search of a real bakery blog for
"Pumpkin Cheesecake Cookies" returned, in order: /cookbook/, the right post,
/pumpkin-spice-latte-cookies/ and /pumpkin-streusel-cheesecake/. Three plausible
near misses, and "first link wins" would have taken the cookbook.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import extract, social  # noqa: E402

POST = "https://www.tiktok.com/@inbloombakery/video/1"

HOME = """<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"CollectionPage","name":"Home"},
 {"@type":"WebSite","url":"https://blog.example.com/","potentialAction":[
   {"@type":"SearchAction",
    "target":{"@type":"EntryPoint","urlTemplate":"https://blog.example.com/?s={search_term_string}"},
    "query-input":{"@type":"PropertyValueSpecification","valueRequired":true}}]}
]}</script></head><body>a blog</body></html>"""

NO_SEARCH = '<html><head></head><body>no structured data at all</body></html>'

# The near-miss order the real site actually returned.
RESULTS = """<html><body>
 <a href="https://blog.example.com/cookbook/">My cookbook</a>
 <a href="https://blog.example.com/pumpkin-cheesecake-cookies/">Pumpkin Cheesecake Cookies</a>
 <a href="https://blog.example.com/pumpkin-spice-latte-cookies/">Pumpkin Spice Latte Cookies</a>
 <a href="https://blog.example.com/pumpkin-streusel-cheesecake/">Pumpkin Streusel Cheesecake</a>
 <a href="https://someoneelse.example/pumpkin-cheesecake-cookies/">an off-site copy</a>
</body></html>"""

RECIPE = """<html><head><script type="application/ld+json">
{"@type":"Recipe","@context":"https://schema.org","name":"Pumpkin Cheesecake Cookies",
 "recipeIngredient":["6 oz cream cheese","1 cup pumpkin puree"],
 "recipeInstructions":["Line a sheet.","Bake."],"recipeYield":"16"}
</script></head></html>"""


def pages(*routes):
    """A fetch_html stand-in that serves fixtures and refuses anything else.

    Routes are (substring, html) and are matched in order, so the more specific
    URLs go first and the bare site root last.
    """

    def fake(url):
        for key, html in routes:
            if key in url:
                return html
        raise AssertionError(f"unexpected fetch: {url}")

    return fake


class DomainDetection(unittest.TestCase):
    def test_it_finds_an_address_written_without_a_scheme(self):
        found = [m.group(1) for m in extract.BARE_DOMAIN.finditer("full recipe on myblog.com now")]
        self.assertEqual(found, ["myblog.com"])

    def test_prose_and_filenames_are_not_addresses(self):
        for text in ("e.g. add salt", "see recipe.pdf", "mix 1.5 cups flour", "1.5 lbs chicken"):
            with self.subTest(text=text):
                self.assertEqual(list(extract.BARE_DOMAIN.finditer(text)), [])

    def test_a_country_domain_is_kept_whole(self):
        found = [m.group(1) for m in extract.BARE_DOMAIN.finditer("go to bbcgoodfood.co.uk")]
        self.assertEqual(found, ["bbcgoodfood.co.uk"])

    def test_a_social_host_is_never_followed(self):
        with patch.object(extract, "fetch_html", side_effect=AssertionError("must not fetch")):
            self.assertIsNone(extract._caption_link_recipe("follow me on tiktok.com", POST, "X"))


class SiteSearch(unittest.TestCase):
    def test_the_search_url_comes_from_the_sites_own_declaration(self):
        url = extract._site_search_url(HOME, "Pumpkin Cheesecake Cookies")
        self.assertEqual(url, "https://blog.example.com/?s=Pumpkin+Cheesecake+Cookies")

    def test_a_site_that_declares_no_search_is_not_guessed_at(self):
        """No `?s=` fallback. A site that doesn't say how to search it is one we
        don't know how to search."""
        self.assertIsNone(extract._site_search_url(NO_SEARCH, "anything"))

    def test_the_best_slug_match_wins_not_the_first_link(self):
        best = extract._best_result(RESULTS, "https://blog.example.com/", "Pumpkin Cheesecake Cookies")
        self.assertEqual(best, "https://blog.example.com/pumpkin-cheesecake-cookies/")

    def test_a_near_miss_alone_is_refused(self):
        """Only the latte cookies on offer: 2 of 3 words, under the threshold."""
        html = '<a href="https://blog.example.com/pumpkin-spice-latte-cookies/">x</a>'
        self.assertIsNone(
            extract._best_result(html, "https://blog.example.com/", "Pumpkin Cheesecake Cookies")
        )

    def test_results_on_another_host_are_ignored(self):
        html = '<a href="https://someoneelse.example/pumpkin-cheesecake-cookies/">x</a>'
        self.assertIsNone(
            extract._best_result(html, "https://blog.example.com/", "Pumpkin Cheesecake Cookies")
        )


class EndToEnd(unittest.TestCase):
    def test_a_bare_domain_becomes_a_full_recipe(self):
        caption = "Pumpkin Cheesecake Cookies. Find the full recipe on blog.example.com"
        with patch.object(
            extract,
            "fetch_html",
            side_effect=pages(
                ("?s=", RESULTS),
                ("pumpkin-cheesecake-cookies", RECIPE),
                ("blog.example.com", HOME),
            ),
        ):
            found = extract._caption_link_recipe(caption, POST, "Pumpkin Cheesecake Cookies")
        self.assertIsNotNone(found)
        self.assertEqual(len(found["ingredients"]), 2)
        self.assertEqual(len(found["instructions"]), 2)

    def test_the_site_itself_is_used_when_it_carries_the_recipe(self):
        """Some creators write the post's own address, not the site root. Then
        there is no search hop at all."""
        with patch.object(extract, "fetch_html", side_effect=pages(("blog.example.com", RECIPE))):
            found = extract._caption_link_recipe("see blog.example.com", POST, "Anything")
        self.assertEqual(len(found["ingredients"]), 2)

    def test_no_title_means_no_search(self):
        """Without a dish name there is nothing to rank results against, so the
        hop stops rather than picking a page at random."""
        with patch.object(extract, "fetch_html", side_effect=pages(("blog.example.com", HOME))):
            self.assertIsNone(extract._caption_link_recipe("see blog.example.com", POST, ""))

    def test_a_host_already_tried_as_a_link_is_not_tried_again(self):
        """`https://blog.example.com/x` also matches as a bare domain. Following
        both is one wasted fetch of the same site."""
        caption = "https://blog.example.com/x and also blog.example.com"
        with patch.object(extract, "fetch_html", return_value=NO_SEARCH) as fetched:
            extract._caption_link_recipe(caption, POST, "Pumpkin Cheesecake Cookies")
        self.assertEqual(fetched.call_count, 1)

    def test_every_failure_returns_none_rather_than_raising(self):
        for effect in (extract.ExtractError("blocked"), OSError("boom")):
            with self.subTest(effect=type(effect).__name__):
                with patch.object(extract, "fetch_html", side_effect=extract.ExtractError("x")):
                    self.assertIsNone(
                        extract._caption_link_recipe("see blog.example.com", POST, "X")
                    )

    def test_the_link_card_path_still_works_when_nothing_is_found(self):
        with patch.object(social, "fetch_post", return_value={"caption": "just a nice dinner"}), \
             patch("app.ai.ai_available", return_value=False), \
             patch.object(extract, "_read_post_image", return_value=None):
            card = extract._extract_social(POST, "tiktok")
        self.assertEqual(card["ingredients"], [])


if __name__ == "__main__":
    unittest.main()
