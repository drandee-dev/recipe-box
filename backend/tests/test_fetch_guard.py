"""The SSRF guard, including the half that is easy to leave out.

`assert_public_host` refusing a private address was already covered implicitly
by everything that calls it. What was not covered is `guarded_client` actually
handing back a usable client and a working `check` — and that gap is not
hypothetical: consolidating the three hand-rolled fetch sites into one helper
left a stale name in the `yield`, every real fetch raised `NameError`, and the
whole suite still passed because nothing here exercised it. These tests are the
ones that would have failed.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.extract import ExtractError, assert_public_host, guarded_client  # noqa: E402

PRIVATE = [
    "http://127.0.0.1/x",
    "http://localhost/x",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    # The cloud metadata endpoint, which is the one that actually matters on
    # Vercel: reachable from the function, and full of credentials.
    "http://169.254.169.254/latest/meta-data/",
]

NOT_HTTP = ["file:///etc/passwd", "gopher://x/", "ftp://example.com/x"]


class Guard(unittest.TestCase):
    def test_private_and_link_local_addresses_are_refused(self):
        for url in PRIVATE:
            with self.subTest(url=url):
                with self.assertRaises(ExtractError):
                    assert_public_host(url)

    def test_only_http_and_https_are_accepted(self):
        for url in NOT_HTTP:
            with self.subTest(url=url):
                with self.assertRaises(ExtractError):
                    assert_public_host(url)

    def test_a_host_that_does_not_resolve_is_refused(self):
        with self.assertRaises(ExtractError):
            assert_public_host("http://this-host-does-not-exist.invalid/x")


class GuardedClient(unittest.TestCase):
    def test_it_yields_a_client_and_a_working_check(self):
        """The regression. `check` must be callable and must be the guard —
        a stale name here raises NameError on every real fetch."""
        with guarded_client() as (client, check):
            self.assertTrue(hasattr(client, "get"))
            self.assertTrue(callable(check))
            # It is the guard itself, not something that merely looks like one.
            with self.assertRaises(ExtractError):
                check("http://127.0.0.1/redirected-here")
            # And it passes a public host.
            check("https://example.com/ok")

    def test_it_carries_the_user_agent_and_follows_redirects(self):
        with guarded_client() as (client, _check):
            self.assertIn("RecipeBox", client.headers.get("user-agent", ""))
            self.assertTrue(client.follow_redirects)

    def test_extra_headers_are_added_without_losing_the_user_agent(self):
        with guarded_client(Accept="image/*,*/*") as (client, _check):
            self.assertEqual(client.headers.get("accept"), "image/*,*/*")
            self.assertIn("RecipeBox", client.headers.get("user-agent", ""))


if __name__ == "__main__":
    unittest.main()
