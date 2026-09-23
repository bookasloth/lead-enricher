"""Model-free checks that run without torch installed (question schema + compose).
The one live model call is skipped unless LAYA_LIVE=1 (needs the ~1.5GB download).

Run:  python -m pytest services/laya/tests           (or: python -m unittest)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from decisions.crm import compose_business, lead_questions  # noqa: E402

VALID_TYPES = {"choice", "score", "noul"}


class TestQuestionSchema(unittest.TestCase):
    def test_schema_matches_laya_preset_shape(self):
        qs = lead_questions()
        self.assertTrue(qs)
        for qid, q in qs.items():
            self.assertIn(q["type"], VALID_TYPES, f"{qid} bad type")
            self.assertIn("instructions", q)
            self.assertIn("`business`", q["instructions"], f"{qid} must reference state field")
            if q["type"] == "choice":
                self.assertIsInstance(q["criteria"], dict)
                self.assertGreaterEqual(len(q["criteria"]), 2)

    def test_compose_drops_empty_and_unknown(self):
        text = compose_business({
            "name": "Sunrise Dental", "category": "Dentist", "description": "",
            "review_count": 120, "has_website": "UNKNOWN", "has_booking": "YES",
        })
        self.assertIn("name: Sunrise Dental", text)
        self.assertIn("review_count: 120", text)
        self.assertNotIn("has_website", text)   # UNKNOWN dropped
        self.assertNotIn("description", text)   # empty dropped
        self.assertIn("has_booking: YES", text)

    def test_compose_falls_back_to_name(self):
        self.assertEqual(compose_business({"name": "X"}), "name: X")
        self.assertEqual(compose_business({}), "")


@unittest.skipUnless(os.environ.get("LAYA_LIVE") == "1", "needs torch + model download")
class TestLive(unittest.TestCase):
    def test_decide_returns_typed_fields(self):
        import laya_engine
        out = laya_engine.decide({"name": "City Hospital", "category": "Hospital",
                                  "review_count": 800, "rating": 4.6})
        self.assertIn(out["outreach_priority"], {"hot", "warm", "cold"})
        self.assertIsInstance(out["digital_gap"], float)


if __name__ == "__main__":
    unittest.main()
