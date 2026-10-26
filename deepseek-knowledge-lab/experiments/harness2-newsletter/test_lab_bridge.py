import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import lab_bridge as lab


class LabBridgeTests(unittest.TestCase):
    def setUp(self):
        self.original_temp = tempfile.tempdir
        self.directory = Path(tempfile.mkdtemp(prefix="seagull-lab-bridge-test-"))
        self.addCleanup(shutil.rmtree, self.directory)
        self.addCleanup(setattr, tempfile, "tempdir", self.original_temp)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HARNESS2_LAB_DATA_DIR": str(self.directory),
                               "HARNESS2_LAB_EXECUTION_ENABLED": "true",
                               "HARNESS2_LAB_KEY_FILE": "", lab.paid.KEY_VARIABLE: "mock-only-dedicated-key"}).start()
        policy = lab.trial.read_json(lab.trial.ROOT / "pricing.json")
        patch.object(lab.paid, "policy_at", return_value=policy).start()
        self.network = patch.object(lab.paid, "send", side_effect=AssertionError("真实网络不得调用")).start()
        self.connection = lab.database()
        self.addCleanup(self.connection.close)

    def call(self, action, body=None, owner="owner"):
        with self.connection:
            return lab.dispatch(self.connection, action, owner, body or {})

    def create(self):
        return self.call("create")

    def plan(self, experiment, phase="train", budget="2"):
        return self.call("preflight", {"id": experiment["id"], "phase": phase, "budget_cny": budget})

    def claim(self, experiment, preflight):
        return self.call("claim", {"id": experiment["id"], "preflight_id": preflight["preflight_id"],
                                   "confirm_send_synthetic": True})

    def transport(self, payload, key):
        self.assertEqual(key, "mock-only-dedicated-key")
        self.assertNotIn("tools", payload)
        return {"model": "deepseek-v4-flash", "usage": {"prompt_tokens": 500, "completion_tokens": 250},
                "choices": [{"message": {"content": "模拟输出，不是真实效果验证。"}, "finish_reason": "stop"}]}

    def run_phase(self, experiment, phase="train", transport=None):
        preflight = self.plan(experiment, phase)
        self.assertTrue(preflight["ready"], preflight)
        self.claim(experiment, preflight)
        with self.connection:
            return lab.work(self.connection, "owner", lab.owned(self.connection, "owner", experiment["id"]), transport or self.transport)

    def train_and_review(self, experiment):
        self.run_phase(experiment)
        for case in experiment["cases"]:
            if case["split"] == "train":
                self.call("review", {"id": experiment["id"], "case_id": case["id"], "winner": "tie", "reason": "模拟人工评审依据"})

    def test_creation_is_offline_private_persistent_and_hides_holdout(self):
        experiment = self.create()
        self.assertEqual(experiment["status"], "prepared")
        self.assertEqual(experiment["attempts"], 0)
        self.assertEqual(experiment["spent_estimate_cny"], "0")
        self.assertIsNone(next(case for case in experiment["cases"] if case["split"] == "holdout")["material"])
        self.assertEqual(len(self.call("list")["items"]), 1)
        restarted = lab.database()
        try:
            self.assertEqual(lab.owned(restarted, "owner", experiment["id"])["status"], "prepared")
        finally:
            restarted.close()
        self.network.assert_not_called()

    def test_cross_owner_ids_and_path_traversal_are_not_found(self):
        experiment = self.create()
        self.assertEqual(self.call("list", owner="other")["items"], [])
        for identifier in (experiment["id"], "../private", "/tmp/anything"):
            with self.subTest(identifier=identifier), self.assertRaises(lab.LabError) as caught:
                self.call("get", {"id": identifier}, owner="other")
            self.assertEqual(caught.exception.status, 404)

    def test_disabled_missing_key_and_expired_price_block_without_network(self):
        experiment = self.create()
        with patch.dict(os.environ, {"HARNESS2_LAB_EXECUTION_ENABLED": "false", lab.paid.KEY_VARIABLE: "", "DEEPSEEK_API_KEY": "production-ignored"}), patch.object(lab.paid, "policy_at", side_effect=ValueError("价格策略已过期")):
            result = self.plan(experiment)
        self.assertFalse(result["ready"])
        self.assertEqual(len(result["blockers"]), 3)
        self.assertIsNone(result["preflight_id"])
        self.network.assert_not_called()

    def test_confirmation_token_owner_expiry_and_single_use(self):
        experiment = self.create()
        preflight = self.plan(experiment)
        with self.assertRaises(lab.LabError):
            self.call("claim", {"id": experiment["id"], "preflight_id": preflight["preflight_id"]})
        with self.connection:
            self.connection.execute("UPDATE preflights SET expires=0")
        with self.assertRaises(lab.LabError):
            self.claim(experiment, preflight)
        preflight = self.plan(experiment)
        self.claim(experiment, preflight)
        with self.assertRaises(lab.LabError):
            self.claim(experiment, preflight)
        self.network.assert_not_called()

    def test_price_change_after_preflight_requires_new_confirmation(self):
        experiment = self.create()
        preflight = self.plan(experiment)
        original = lab.trial.read_text
        with patch.object(lab.trial, "read_text", side_effect=lambda path: original(path) + ("\n" if Path(path).name == "pricing.json" else "")):
            with self.assertRaises(lab.LabError):
                self.claim(experiment, preflight)
        self.network.assert_not_called()

    def test_full_mock_flow_telemetry_review_holdout_and_note_report(self):
        experiment = self.create()
        self.assertEqual(self.run_phase(experiment)["status"], "awaiting_review")
        detail = self.call("get", {"id": experiment["id"]})
        self.assertEqual(detail["attempts"], 6)
        self.assertEqual(detail["spent_estimate_cny"], "0.018")
        self.assertFalse(self.plan(experiment, "holdout")["ready"])
        for case in experiment["cases"]:
            if case["split"] == "train":
                self.call("review", {"id": experiment["id"], "case_id": case["id"], "winner": "candidate", "reason": "模拟：保留限定条件"})
        self.assertEqual(self.run_phase(experiment, "holdout")["status"], "completed")
        detail = self.call("get", {"id": experiment["id"]})
        self.assertEqual(detail["attempts"], 8)
        self.assertIsNotNone(detail["cases"][-1]["material"])
        report = self.call("report", {"id": experiment["id"]})
        self.assertIn("并非完整 Harness²", report["content"])
        self.assertNotIn("mock-only-dedicated-key", report["content"])
        self.assertEqual(report, self.call("report", {"id": experiment["id"]}))
        self.network.assert_not_called()

    def test_unknown_call_stops_is_not_zero_and_cannot_restart(self):
        experiment = self.create()
        calls = []

        def timeout(payload, key):
            calls.append(payload)
            raise TimeoutError("secret provider response must not be persisted")

        self.assertEqual(self.run_phase(experiment, transport=timeout)["status"], "outcome_unknown")
        detail = self.call("get", {"id": experiment["id"]})
        self.assertEqual(len(calls), 1)
        self.assertIsNone(detail["spent_estimate_cny"])
        self.assertTrue(detail["outcome_unknown"])
        self.assertFalse(self.plan(experiment)["ready"])
        self.assertNotIn("secret provider", str(detail))

    def test_interrupted_worker_is_never_requeued(self):
        experiment = self.create()
        self.claim(experiment, self.plan(experiment))
        with self.connection:
            self.connection.execute("UPDATE experiments SET claimed_at=0")
        self.assertEqual(self.call("get", {"id": experiment["id"]})["status"], "interrupted")
        self.assertFalse(self.plan(experiment)["ready"])
        self.network.assert_not_called()

    def test_reviews_are_append_only_and_cannot_precede_outputs(self):
        experiment = self.create()
        body = {"id": experiment["id"], "case_id": "limited-announcement", "winner": "baseline", "reason": "模拟理由"}
        with self.assertRaises(lab.LabError):
            self.call("review", body)
        self.run_phase(experiment)
        self.call("review", body)
        with self.assertRaises(FileExistsError):
            self.call("review", body)

    def test_durable_budget_is_unchanged_for_holdout(self):
        experiment = self.create()
        self.train_and_review(experiment)
        self.assertFalse(self.plan(experiment, "holdout", "1.5")["ready"])
        self.assertTrue(self.plan(experiment, "holdout", "2")["ready"])

    def test_worker_can_claim_a_stage_only_once(self):
        experiment = self.create()
        self.run_phase(experiment)
        with self.assertRaises(lab.LabError):
            with self.connection:
                lab.work(self.connection, "owner", lab.owned(self.connection, "owner", experiment["id"]), self.transport)
        self.assertEqual(self.call("get", {"id": experiment["id"]})["attempts"], 6)

    def test_prompt_tampering_after_preflight_stops_before_any_request(self):
        experiment = self.create()
        preflight = self.plan(experiment)
        row = lab.owned(self.connection, "owner", experiment["id"])
        with (Path(row["run"]) / "candidate.md").open("a", encoding="utf-8") as source:
            source.write("\n模拟篡改")
        with self.assertRaises(ValueError):
            self.claim(experiment, preflight)
        self.network.assert_not_called()

    def test_stale_status_read_cannot_mark_a_newly_started_worker_interrupted(self):
        experiment = self.create()
        self.claim(experiment, self.plan(experiment))
        with self.connection:
            self.connection.execute("UPDATE experiments SET claimed_at=0")
        stale = lab.owned(self.connection, "owner", experiment["id"])
        with self.connection:
            self.connection.execute("UPDATE experiments SET pid=?", (os.getpid(),))
        row = lab.reconcile(self.connection, stale)
        self.assertEqual(row["status"], "train_running")
        self.assertEqual(row["pid"], os.getpid())


if __name__ == "__main__":
    unittest.main()
