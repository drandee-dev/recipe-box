"""Spend accounting, and the health field that makes its failure visible.

Both exist because of the same incident: the spend query was changed to a
PostgREST `cents.sum()` aggregate, Supabase disables aggregates on the data API
by default and answered PGRST123, and since this path fails open by design the
only effect was that the monthly ceiling silently stopped being enforced. It took
reading function logs inside their one-hour retention window to find.

A unit test would not have caught that — only the real deployment could. What
these cover is the arithmetic, and the contract that a failed lookup is
reported rather than reported as zero.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.usage import sum_cents  # noqa: E402


class SumCents(unittest.TestCase):
    def test_adds_the_rows(self):
        self.assertAlmostEqual(sum_cents([{"cents": 1.5}, {"cents": 2.25}]), 3.75)

    def test_a_quiet_month_is_zero_not_untracked(self):
        # Zero spent and "we could not find out" must stay different answers:
        # one lets a call through against a real ceiling, the other means there
        # is no ceiling being applied at all.
        self.assertEqual(sum_cents([]), 0.0)

    def test_null_and_missing_values_count_as_nothing(self):
        self.assertAlmostEqual(sum_cents([{"cents": None}, {}, {"cents": 2}]), 2.0)

    def test_strings_still_add_up(self):
        # PostgREST returns numeric as a JSON number, but the column is numeric
        # and a driver change returning strings should not zero out the ceiling.
        self.assertAlmostEqual(sum_cents([{"cents": "1.25"}, {"cents": 2}]), 3.25)

    def test_an_unexpected_shape_is_untracked_rather_than_zero(self):
        self.assertIsNone(sum_cents({"cents": 5}))
        self.assertIsNone(sum_cents([{"cents": "not a number"}]))
        self.assertIsNone(sum_cents(None))


class HealthReportsBudgetState(unittest.TestCase):
    """The endpoint has to distinguish 'nothing spent' from 'not enforcing'."""

    def _health(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app).get("/api/health").json()

    def test_a_working_lookup_is_tracked(self):
        with patch("app.usage.month_spend_cents", return_value=4.2):
            body = self._health()
        self.assertTrue(body["budget"]["tracked"])
        self.assertEqual(body["budget"]["spent_cents"], 4.2)
        self.assertIn("limit_cents", body["budget"])

    def test_a_failed_lookup_says_so(self):
        # The whole point: None must not render as 0, which would read as a
        # healthy ceiling with nothing spent against it.
        with patch("app.usage.month_spend_cents", return_value=None):
            body = self._health()
        self.assertFalse(body["budget"]["tracked"])
        self.assertIsNone(body["budget"]["spent_cents"])

    def test_zero_spent_is_still_tracked(self):
        with patch("app.usage.month_spend_cents", return_value=0.0):
            body = self._health()
        self.assertTrue(body["budget"]["tracked"])
        self.assertEqual(body["budget"]["spent_cents"], 0)


if __name__ == "__main__":
    unittest.main()
