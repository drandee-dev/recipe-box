"""Release announcement: what must hold when the cron job calls in.

The send itself needs a phone and is stubbed. What these pin is the part that
fails quietly: that a version goes out at most once, that nothing is claimed
before it can be sent, that only opted-in subscriptions on the production origin
are sent to, and that RELEASE_VERSION cannot drift from the frontend's APP_VERSION.
"""

import json
import os
import re
import sys
import unittest
from unittest.mock import patch

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import push, release  # noqa: E402

ORIGIN = "https://recipe-box-coral.vercel.app"
SUB = {"id": "s1", "endpoint": "https://push.example/x", "p256dh": "k", "auth": "a"}
ENV = {"RELEASE_APP_ORIGIN": ORIGIN}
UNSET = object()
HIGHLIGHTS = ["A bar tells you when an update is ready", "Optional heads-up when a version is out", "third"]


class Drift(unittest.TestCase):
    def test_release_version_matches_the_frontends_app_version(self):
        # A release that bumps one and forgets the other would announce a version
        # the live app is not serving, or never announce at all.
        path = os.path.join(ROOT, "..", "frontend", "src", "lib", "news.js")
        with open(path, encoding="utf-8") as f:
            match = re.search(r"export const APP_VERSION = '([^']+)'", f.read())
        self.assertIsNotNone(match)
        self.assertEqual(release.RELEASE_VERSION, match.group(1))

    def test_the_title_and_body_name_the_release(self):
        self.assertIn(release.RELEASE_VERSION, release.TITLE)
        self.assertTrue(release.BODY)


class Summary(unittest.TestCase):
    def test_only_the_first_two_highlights_are_used_and_each_is_capped(self):
        self.assertEqual(release.summary_for(["a", "b", "c"]), "a; b")
        self.assertEqual(len(release.summary_for(["x" * 200])), 80)

    def test_anything_unusable_falls_back_to_the_fixed_text(self):
        for bad in (None, [], "text", [1, None, "  "], {"a": 1}):
            self.assertEqual(release.summary_for(bad), release.BODY)


class Origin(unittest.TestCase):
    def test_only_an_https_origin_counts_and_a_trailing_slash_is_dropped(self):
        with patch.dict(os.environ, {"RELEASE_APP_ORIGIN": ORIGIN + "/"}):
            self.assertEqual(release.app_origin(), ORIGIN)
        for bad in ("", "http://x.test", "recipe-box-coral.vercel.app"):
            with patch.dict(os.environ, {"RELEASE_APP_ORIGIN": bad}):
                self.assertEqual(release.app_origin(), "")

    def test_the_payload_is_declarative_and_opens_the_app(self):
        body = json.loads(release.payload_for(ORIGIN))
        self.assertEqual(body["web_push"], 8030)
        self.assertEqual(body["notification"]["navigate"], ORIGIN + "/")
        self.assertEqual(body["notification"]["title"], release.TITLE)


class Query(unittest.TestCase):
    def test_subscribers_are_filtered_to_opted_in_and_this_origin_on_the_wire(self):
        seen = {}

        class Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return [SUB]

        def fake_get(url, headers=None, params=None, timeout=None):
            seen["request"] = httpx.Request("GET", url, params=params)
            return Resp()

        with patch.object(push, "_rest", return_value=("https://x.test/rest/v1/push_subscriptions", {})), patch.object(
            release.httpx, "get", side_effect=fake_get
        ):
            self.assertEqual(release._subscribers(ORIGIN), [SUB])
        url = str(seen["request"].url)
        self.assertIn("announce=eq.true", url)
        # The origin is compared exactly, and is percent-encoded rather than spliced.
        self.assertIn("origin=eq.https%3A%2F%2Frecipe-box-coral.vercel.app", url)

    def test_two_accounts_on_one_phone_are_one_send(self):
        # Unique per (user, endpoint), so both opting in on a shared phone gives two
        # rows with the same endpoint; the phone must get one notification.
        class Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return [
                    {**SUB, "id": "a"},
                    {**SUB, "id": "b"},
                    {**SUB, "id": "c", "endpoint": "https://push.example/other"},
                ]

        with patch.object(push, "_rest", return_value=("https://x.test/r", {})), patch.object(
            release.httpx, "get", return_value=Resp()
        ):
            got = release._subscribers(ORIGIN)
        self.assertEqual([r["id"] for r in got], ["a", "c"])

    def test_the_claim_treats_a_conflict_as_already_sent(self):
        class Resp:
            def __init__(self, status):
                self.status_code = status

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise httpx.HTTPStatusError("x", request=None, response=None)

        with patch.object(push, "_rest", return_value=("https://x.test/r", {})):
            with patch.object(release.httpx, "post", return_value=Resp(201)):
                self.assertTrue(release._claim(release.RELEASE_VERSION))
            with patch.object(release.httpx, "post", return_value=Resp(409)):
                self.assertFalse(release._claim(release.RELEASE_VERSION))


class Announce(unittest.TestCase):
    def run_announce(self, *, claimed=False, live=UNSET, claim=True, subs=(SUB,), send=None, configured=True):
        # Default: the live frontend already serves the release being announced.
        # Derived, not written out, so a version bump cannot break these tests.
        live = release.RELEASE_VERSION if live is UNSET else live
        info = None if live is None else {"version": live, "highlights": HIGHLIGHTS}
        sent = []
        self.payloads = []

        def fake_send(sub, payload):
            if send:
                send(sub)
            sent.append(sub["id"])
            self.payloads.append(payload)

        with patch.dict(os.environ, ENV), patch.object(push, "configured", return_value=configured), patch.object(
            release, "_already_claimed", return_value=claimed
        ), patch.object(release, "live_info", return_value=info), patch.object(
            release, "_claim", return_value=claim
        ) as claim_mock, patch.object(release, "_subscribers", return_value=list(subs)), patch.object(
            push, "_send", side_effect=fake_send
        ), patch.object(release, "_record_sent") as record:
            out = release.announce()
        return out, sent, claim_mock, record

    def test_an_opted_in_subscription_is_sent_once(self):
        out, sent, _, record = self.run_announce()
        self.assertEqual(out["status"], "sent")
        self.assertEqual(sent, ["s1"])
        record.assert_called_once_with(release.RELEASE_VERSION, 1)

    def test_the_notification_carries_the_live_releases_highlights(self):
        self.run_announce()
        body = json.loads(self.payloads[0])["notification"]["body"]
        self.assertEqual(body, "A bar tells you when an update is ready; Optional heads-up when a version is out")

    def test_a_version_already_claimed_sends_nothing(self):
        out, sent, claim, _ = self.run_announce(claimed=True)
        self.assertEqual(out["status"], "already_sent")
        self.assertEqual(sent, [])
        claim.assert_not_called()

    def test_losing_the_claim_race_sends_nothing(self):
        out, sent, _, _ = self.run_announce(claim=False)
        self.assertEqual(out["status"], "already_sent")
        self.assertEqual(sent, [])

    def test_nothing_is_claimed_or_sent_until_the_live_frontend_serves_this_version(self):
        # Not serving it yet: older, newer, empty, or the version file missing.
        for live in (None, "0.0.1", release.RELEASE_VERSION + ".1", ""):
            out, sent, claim, _ = self.run_announce(live=live)
            self.assertEqual(out["status"], "waiting")
            self.assertEqual(sent, [])
            claim.assert_not_called()

    def test_the_subscriber_query_gets_the_production_origin(self):
        with patch.dict(os.environ, ENV), patch.object(push, "configured", return_value=True), patch.object(
            release, "_already_claimed", return_value=False
        ), patch.object(
            release, "live_info", return_value={"version": release.RELEASE_VERSION}
        ), patch.object(release, "_claim", return_value=True), patch.object(
            release, "_subscribers", return_value=[]
        ) as subs, patch.object(release, "_record_sent"):
            release.announce()
        subs.assert_called_once_with(ORIGIN)

    def test_a_failing_subscriber_query_claims_nothing_so_the_next_call_retries(self):
        with patch.dict(os.environ, ENV), patch.object(push, "configured", return_value=True), patch.object(
            release, "_already_claimed", return_value=False
        ), patch.object(
            release, "live_info", return_value={"version": release.RELEASE_VERSION}
        ), patch.object(release, "_subscribers", side_effect=httpx.ConnectError("down")), patch.object(
            release, "_claim"
        ) as claim:
            with self.assertRaises(httpx.ConnectError):
                release.announce()
        claim.assert_not_called()

    def test_an_unconfigured_deployment_claims_nothing(self):
        # Claiming and then being unable to send would burn the one announcement.
        out, sent, claim, _ = self.run_announce(configured=False)
        self.assertEqual(out["status"], "not_configured")
        claim.assert_not_called()
        with patch.dict(os.environ, {"RELEASE_APP_ORIGIN": ""}), patch.object(push, "configured", return_value=True):
            self.assertEqual(release.announce(), {"status": "not_configured"})

    def test_a_dead_subscription_is_removed_and_the_rest_still_send(self):
        def send(sub):
            if sub["id"] == "dead":
                raise push.Gone

        subs = [{**SUB, "id": "dead"}, {**SUB, "id": "ok"}]
        with patch.object(push, "_drop_subscription") as drop:
            out, sent, _, _ = self.run_announce(subs=subs, send=send)
        self.assertEqual(sent, ["ok"])
        drop.assert_called_once_with("dead")
        self.assertEqual((out["sent"], out["dropped"], out["failed"]), (1, 1, 0))

    def test_one_failing_endpoint_does_not_stop_the_others(self):
        def send(sub):
            if sub["id"] == "bad":
                raise RuntimeError("boom")

        subs = [{**SUB, "id": "bad"}, {**SUB, "id": "ok"}]
        out, sent, _, _ = self.run_announce(subs=subs, send=send)
        self.assertEqual(sent, ["ok"])
        self.assertEqual(out["failed"], 1)


class Endpoint(unittest.TestCase):
    def client(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app)

    def test_refuses_without_the_secret(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(release, "announce") as run:
            for headers in ({}, {"x-push-secret": "nope"}):
                resp = self.client().post("/api/push/announce", headers=headers)
                self.assertEqual(resp.status_code, 401)
                self.assertEqual(resp.json(), {"detail": "Unauthorized"})
            run.assert_not_called()

    def test_runs_with_the_secret(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(
            release, "announce", return_value={"status": "waiting"}
        ):
            resp = self.client().post("/api/push/announce", headers={"x-push-secret": "s3cret"})
            self.assertEqual(resp.status_code, 200)

    def test_an_internal_failure_is_opaque(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(
            release, "announce", side_effect=RuntimeError("secret detail")
        ):
            resp = self.client().post("/api/push/announce", headers={"x-push-secret": "s3cret"})
            self.assertEqual(resp.status_code, 502)
            self.assertNotIn("secret detail", resp.text)


if __name__ == "__main__":
    unittest.main()
