"""The per-caller cap on the two anonymous AI endpoints.

`/extract` and `/structure` take no session on purpose — extraction fetches a
public URL and keeps nothing, and paste has to work signed out because the iOS
capture path lands in Safari. The monthly budget is the only other ceiling and it
is shared, so without this a single caller in a loop empties it for everyone.

What these pin is the part a unit test can actually hold: that not knowing lets a
caller through rather than blocking them, that a forged `x-forwarded-for` doesn't
win over the address the platform reports, and that the 429 happens before any
work is done.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.usage import (  # noqa: E402
    RATE_LIMIT_CALLS,
    caller_hash,
    client_ip,
    over_rate_limit,
)


class ClientIP(unittest.TestCase):
    def test_prefers_the_header_the_platform_writes(self):
        # x-real-ip comes from Vercel's edge and the connection it actually saw.
        # x-forwarded-for is client-settable, so trusting it first is a way for a
        # caller to hand themselves a fresh empty bucket on every request.
        headers = {"x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9"}
        self.assertEqual(client_ip(headers), "9.9.9.9")

    def test_falls_back_to_forwarded_for(self):
        self.assertEqual(client_ip({"x-forwarded-for": "1.2.3.4"}), "1.2.3.4")

    def test_takes_the_first_entry_of_a_chain(self):
        self.assertEqual(client_ip({"x-forwarded-for": "1.2.3.4, 5.6.7.8"}), "1.2.3.4")

    def test_no_address_is_empty_not_an_error(self):
        self.assertEqual(client_ip({}), "")


class CallerHash(unittest.TestCase):
    def test_is_stable_for_one_address(self):
        self.assertEqual(caller_hash("1.2.3.4"), caller_hash("1.2.3.4"))

    def test_separates_addresses(self):
        self.assertNotEqual(caller_hash("1.2.3.4"), caller_hash("1.2.3.5"))

    def test_never_contains_the_address(self):
        self.assertNotIn("1.2.3.4", caller_hash("1.2.3.4"))

    def test_the_salt_changes_the_answer(self):
        with patch.dict(os.environ, {"RATE_LIMIT_SALT": "a"}):
            first = caller_hash("1.2.3.4")
        with patch.dict(os.environ, {"RATE_LIMIT_SALT": "b"}):
            second = caller_hash("1.2.3.4")
        self.assertNotEqual(first, second)

    def test_no_address_gets_no_hash(self):
        # An empty hash means "no caller to charge this to", which recent_calls
        # reads as untracked rather than as one shared bucket everyone lands in.
        self.assertEqual(caller_hash(""), "")
        self.assertEqual(caller_hash("   "), "")


class OverRateLimit(unittest.TestCase):
    def test_under_the_ceiling_passes(self):
        with patch("app.usage.recent_calls", return_value=RATE_LIMIT_CALLS - 1):
            self.assertFalse(over_rate_limit("abc"))

    def test_at_the_ceiling_blocks(self):
        with patch("app.usage.recent_calls", return_value=RATE_LIMIT_CALLS):
            self.assertTrue(over_rate_limit("abc"))

    def test_an_unreachable_lookup_lets_the_call_through(self):
        # Fails open, like every other call in usage.py, and for the same reason:
        # a Supabase blip must not stop the owner importing a recipe. The monthly
        # budget is what bounds the damage while that is true.
        with patch("app.usage.recent_calls", return_value=None):
            self.assertFalse(over_rate_limit("abc"))


class HealthReportsWhetherTheCapIsApplied(unittest.TestCase):
    """The cap fails open, so its absence has to be visible from outside."""

    def _health(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app).get("/api/health").json()

    def test_a_working_query_is_tracked(self):
        with patch("app.usage.recent_calls", return_value=0):
            body = self._health()
        self.assertTrue(body["rate"]["tracked"])
        self.assertEqual(body["rate"]["limit"], RATE_LIMIT_CALLS)

    def test_a_rejected_query_says_so(self):
        # The case this is really for: `ip_hash` missing because the schema
        # re-run never happened. Every caller is waved through and nothing else
        # about the deployment looks wrong.
        with patch("app.usage.recent_calls", return_value=None):
            body = self._health()
        self.assertFalse(body["rate"]["tracked"])


class EndpointsAreMetered(unittest.TestCase):
    """The gate has to run before the expensive part, on both endpoints."""

    def _client(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app)

    def test_extract_refuses_a_caller_over_the_cap(self):
        with patch("app.usage.over_rate_limit", return_value=True):
            with patch("app.main.extract_recipe") as extract:
                resp = self._client().post(
                    "/api/recipes/extract",
                    json={"url": "https://example.com/a-recipe"},
                    headers={"x-real-ip": "1.2.3.4"},
                )
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.headers.get("retry-after"), "900")
        # The point of the cap: no fetch, no model call, no Vercel time spent.
        extract.assert_not_called()

    def test_structure_refuses_a_caller_over_the_cap(self):
        with patch("app.usage.over_rate_limit", return_value=True):
            with patch("app.main.structure_recipe") as structure:
                resp = self._client().post(
                    "/api/recipes/structure",
                    json={"text": "two eggs, a cup of flour, and some milk"},
                    headers={"x-real-ip": "1.2.3.4"},
                )
        self.assertEqual(resp.status_code, 429)
        structure.assert_not_called()

    def test_a_caller_under_the_cap_reaches_the_handler(self):
        with patch("app.usage.over_rate_limit", return_value=False):
            with patch("app.main.extract_recipe", return_value={"title": "Soup"}) as extract:
                resp = self._client().post(
                    "/api/recipes/extract",
                    json={"url": "https://example.com/a-recipe"},
                    headers={"x-real-ip": "1.2.3.4"},
                )
        self.assertEqual(resp.status_code, 200)
        extract.assert_called_once()

    def test_the_spend_row_is_tagged_with_the_caller(self):
        # record_usage sits four calls below the endpoint and reads the caller off
        # the context set here. If that ever stops arriving the cap still returns
        # 200s forever, because every row would be filed under no caller.
        seen = {}

        def fake_extract(url):
            from app.usage import _caller

            seen["hash"] = _caller.get()
            return {"title": "Soup"}

        with patch("app.usage.over_rate_limit", return_value=False):
            with patch("app.main.extract_recipe", side_effect=fake_extract):
                self._client().post(
                    "/api/recipes/extract",
                    json={"url": "https://example.com/a-recipe"},
                    headers={"x-real-ip": "1.2.3.4"},
                )
        self.assertEqual(seen["hash"], caller_hash("1.2.3.4"))


if __name__ == "__main__":
    unittest.main()
