"""Lock-screen timer alerts (A2): what must hold when the cron job calls in.

The send itself needs a phone, so it is stubbed; what these pin is the part that
fails quietly: who may call, that an alert is sent at most once, that a late one
is dropped, and that one dead subscription does not cost the others.
"""

import datetime as dt
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import push  # noqa: E402

NOW = dt.datetime(2026, 10, 16, 12, 0, 0, tzinfo=dt.timezone.utc)


def row(seconds_ago=3, **over):
    due = NOW - dt.timedelta(seconds=seconds_ago)
    base = {
        "id": "t1",
        "user_id": "u1",
        "client_id": "abc",
        "label": "15 minutes",
        "recipe_title": "Chop Suey",
        "open_url": "https://recipe-box-coral.vercel.app/?recipe=r1",
        "ends_at": due.isoformat(),
    }
    base.update(over)
    return base


SUB = {"id": "s1", "endpoint": "https://push.example/x", "p256dh": "k", "auth": "a"}


class Authorized(unittest.TestCase):
    def test_needs_the_shared_secret(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}):
            self.assertTrue(push.authorized("s3cret"))
            self.assertFalse(push.authorized("wrong"))
            self.assertFalse(push.authorized(None))
            self.assertFalse(push.authorized(""))

    def test_an_unconfigured_secret_authorizes_nobody(self):
        # An empty expected value must never match an empty or missing header.
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": ""}):
            self.assertFalse(push.authorized(""))
            self.assertFalse(push.authorized(None))

    def test_a_non_ascii_header_is_refused_not_an_error(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}):
            self.assertFalse(push.authorized("sécret"))


class Payload(unittest.TestCase):
    def test_is_a_declarative_web_push(self):
        body = json.loads(push.payload_for(row()))
        self.assertEqual(body["web_push"], 8030)
        n = body["notification"]
        self.assertEqual(n["title"], "Time's up")
        self.assertEqual(n["body"], "15 minutes · Chop Suey")
        self.assertEqual(n["navigate"], "https://recipe-box-coral.vercel.app/?recipe=r1")

    def test_a_timer_with_no_recipe_still_reads(self):
        n = json.loads(push.payload_for(row(recipe_title=None, open_url=None)))["notification"]
        self.assertEqual(n["body"], "15 minutes")
        self.assertNotIn("navigate", n)

    def test_only_an_https_link_becomes_a_navigate_target(self):
        for bad in ("javascript:alert(1)", "http://x.test/", "data:text/html,hi", "//x.test"):
            n = json.loads(push.payload_for(row(open_url=bad)))["notification"]
            self.assertNotIn("navigate", n, bad)


class FireDue(unittest.TestCase):
    def run_fire(self, rows, *, claim=True, subs=(SUB,), send=None):
        sent, dropped, released = [], [], []

        def fake_send(sub, payload):
            if send:
                send(sub)
            sent.append(sub["id"])

        with patch.object(push, "_due_rows", return_value=rows), patch.object(
            push, "_claim", return_value=claim
        ), patch.object(push, "_subscriptions", return_value=list(subs)), patch.object(
            push, "_send", side_effect=fake_send
        ), patch.object(push, "_drop_subscription", side_effect=dropped.append), patch.object(
            push, "_release", side_effect=released.append
        ):
            out = push.fire_due(NOW)
        return out, sent, dropped, released

    def test_a_due_timer_is_sent_once(self):
        out, sent, _, released = self.run_fire([row()])
        self.assertEqual(out["sent"], 1)
        self.assertEqual(sent, ["s1"])
        self.assertEqual(released, [])

    def test_a_row_another_run_claimed_is_not_sent(self):
        out, sent, _, _ = self.run_fire([row()], claim=False)
        self.assertEqual(sent, [])
        self.assertEqual(out["sent"], 0)

    def test_a_late_alert_is_claimed_and_dropped(self):
        out, sent, _, _ = self.run_fire([row(seconds_ago=push.STALE_SECONDS + 5)])
        self.assertEqual(sent, [])
        self.assertEqual(out["stale"], 1)

    def test_no_subscription_is_reported_not_sent(self):
        out, sent, _, _ = self.run_fire([row()], subs=())
        self.assertEqual(out["no_subscription"], 1)
        self.assertEqual(sent, [])

    def test_a_gone_subscription_is_removed_and_the_rest_still_send(self):
        good = {**SUB, "id": "s2"}

        def send(sub):
            if sub["id"] == "s1":
                raise push.Gone

        out, sent, dropped, released = self.run_fire([row()], subs=(SUB, good), send=send)
        self.assertEqual(dropped, ["s1"])
        self.assertEqual(sent, ["s2"])
        self.assertEqual(out["sent"], 1)
        self.assertEqual(released, [])

    def test_when_every_send_fails_the_row_is_given_back_for_a_retry(self):
        def send(sub):
            raise RuntimeError("push service down")

        out, sent, _, released = self.run_fire([row()], send=send)
        self.assertEqual(out["failed"], 1)
        self.assertEqual(released, ["t1"])

    def test_one_failing_endpoint_does_not_stop_the_others(self):
        good = {**SUB, "id": "s2"}

        def send(sub):
            if sub["id"] == "s1":
                raise RuntimeError("boom")

        out, sent, _, released = self.run_fire([row()], subs=(SUB, good), send=send)
        self.assertEqual(sent, ["s2"])
        self.assertEqual(released, [])


class Endpoint(unittest.TestCase):
    def client(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app)

    def test_refuses_without_the_secret(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(
            push, "fire_due"
        ) as fire:
            for headers in ({}, {"x-push-secret": "nope"}):
                resp = self.client().post("/api/push/fire", headers=headers)
                self.assertEqual(resp.status_code, 401)
                self.assertEqual(resp.json(), {"detail": "Unauthorized"})
            fire.assert_not_called()

    def test_runs_with_the_secret(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(
            push, "fire_due", return_value={"due": 0}
        ):
            resp = self.client().post("/api/push/fire", headers={"x-push-secret": "s3cret"})
            self.assertEqual(resp.status_code, 200)

    def test_an_internal_failure_is_opaque(self):
        with patch.dict(os.environ, {"PUSH_FIRE_SECRET": "s3cret"}), patch.object(
            push, "fire_due", side_effect=RuntimeError("secret detail")
        ):
            resp = self.client().post("/api/push/fire", headers={"x-push-secret": "s3cret"})
            self.assertEqual(resp.status_code, 502)
            self.assertNotIn("secret detail", resp.text)

    def test_health_reports_whether_push_can_send(self):
        with patch.object(push, "configured", return_value=False):
            self.assertIs(self.client().get("/api/health").json()["push"], False)


if __name__ == "__main__":
    unittest.main()
