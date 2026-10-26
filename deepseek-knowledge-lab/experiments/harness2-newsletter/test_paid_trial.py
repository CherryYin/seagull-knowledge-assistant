import importlib.util
import fcntl
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("paid_trial", ROOT / "paid_trial.py")
paid = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(paid)


class PaidTrialTests(unittest.TestCase):
    def setUp(self):
        self.run = paid.trial.prepare()
        self.addCleanup(shutil.rmtree, self.run)
        self.policy = paid.trial.read_json(ROOT / "pricing.json")
        self.actual_policy = paid.policy_at
        self.addCleanup(patch.stopall)
        patch.object(paid, "policy_at", return_value=self.policy).start()
        patch.dict(os.environ, {paid.KEY_VARIABLE: "unit-test-only-key"}).start()
        self.calls = []

    def response(self):
        return {
            "model": "deepseek-v4-flash",
            "usage": {"prompt_tokens": 500, "completion_tokens": 250},
            "choices": [{"message": {"role": "assistant", "content": "这是模拟结果，不是实际模型质量测试。"}, "finish_reason": "stop"}],
        }

    def transport(self, payload, key):
        self.calls.append(payload)
        self.assertEqual(key, "unit-test-only-key")
        self.assertEqual(payload["model"], "deepseek-v4-flash")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertEqual(payload["max_tokens"], 1200)
        self.assertNotIn("tools", payload)
        self.assertNotIn("tool_choice", payload)
        return self.response()

    def execute(self, phase="train", **options):
        return paid.execute(self.run, "2", phase, consent=True, transport=self.transport, **options)

    def test_plan_is_local_and_whole_fixture_reservation_is_within_two_yuan(self):
        with patch.object(paid, "send", side_effect=AssertionError("不应联网")):
            context = paid.plan(self.run, "2", "train")
        self.assertEqual(len(context[3]), 6)
        self.assertEqual(context[4] * 8, Decimal("1.125376"))
        self.assertFalse((self.run / "paid").exists())

    def test_budget_limits_fail_before_any_request(self):
        for budget in ("0.01", "2.01", "0", "-1", "NaN", "Infinity"):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                paid.execute(self.run, budget, "train", consent=True, transport=self.transport)
        self.assertEqual(self.calls, [])

    def test_consent_and_dedicated_key_are_required_without_production_fallback(self):
        with self.assertRaises(ValueError):
            paid.execute(self.run, "2", "train", transport=self.transport)
        with patch.dict(os.environ, {paid.KEY_VARIABLE: "", "DEEPSEEK_API_KEY": "production-key"}):
            with self.assertRaises(ValueError):
                self.execute()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.run / "paid").exists())

    def test_training_saves_only_selected_telemetry_and_never_the_key(self):
        self.execute()
        self.assertEqual(len(self.calls), 6)
        used, uncertain = paid.spent_or_reserved(self.run)
        self.assertEqual(used, Decimal("0.018"))
        self.assertFalse(uncertain)
        record = paid.trial.read_json(self.run / "records/limited-announcement.baseline.json")
        self.assertEqual(record["response"]["retry_count"], 0)
        self.assertEqual(record["provenance"], "provider_reported_usage_not_invoice_verified")
        for path in self.run.rglob("*.json"):
            self.assertNotIn("unit-test-only-key", path.read_text(encoding="utf-8"))

    def test_completed_phase_cannot_be_repeated(self):
        self.execute()
        with self.assertRaises((ValueError, OSError)):
            self.execute()
        self.assertEqual(len(self.calls), 6)

    def test_timeout_preserves_reservation_and_blocks_all_further_calls(self):
        attempts = []

        def timeout(payload, key):
            attempts.append(True)
            raise TimeoutError("sensitive-response-with-unit-test-only-key")

        with self.assertRaises(ValueError):
            paid.execute(self.run, "2", "train", consent=True, transport=timeout)
        used, uncertain = paid.spent_or_reserved(self.run)
        self.assertTrue(uncertain)
        self.assertEqual(used, Decimal("0.140672"))
        for phase in ("train", "holdout"):
            with self.assertRaises(ValueError):
                paid.execute(self.run, "2", phase, consent=True, transport=timeout)
        self.assertEqual(len(attempts), 1)
        result = (self.run / "paid/limited-announcement.baseline.result.json").read_text()
        self.assertNotIn("sensitive-response", result)
        self.assertNotIn("unit-test-only-key", result)

    def test_invalid_provider_outputs_stop_instead_of_guessing_or_retrying(self):
        variants = []
        unknown = self.response()
        unknown.pop("usage")
        variants.append(unknown)
        tools = self.response()
        tools["choices"][0]["message"]["tool_calls"] = [{"name": "publish"}]
        variants.append(tools)
        truncated = self.response()
        truncated["choices"][0]["finish_reason"] = "length"
        variants.append(truncated)
        wrong_model = self.response()
        wrong_model["model"] = "other-model"
        variants.append(wrong_model)
        for counts in ((True, 250), (500, -1), (65537, 250), (500, 1201)):
            response = self.response()
            response["usage"] = dict(zip(("prompt_tokens", "completion_tokens"), counts))
            variants.append(response)
        for response in variants:
            run = paid.trial.prepare()
            self.addCleanup(shutil.rmtree, run)
            with self.subTest(response=response), self.assertRaises(ValueError):
                paid.execute(run, "2", "train", consent=True, transport=lambda payload, key: response)
            self.assertTrue(paid.spent_or_reserved(run)[1])
            self.assertEqual(len(list((run / "paid").glob("*.pending.json"))), 1)

    def test_pending_without_result_and_keyboard_interrupt_cannot_be_retried(self):
        with self.assertRaises(KeyboardInterrupt):
            paid.execute(self.run, "2", "train", consent=True, transport=lambda payload, key: (_ for _ in ()).throw(KeyboardInterrupt()))
        with self.assertRaises(ValueError):
            self.execute()
        self.assertTrue(paid.spent_or_reserved(self.run)[1])
        (self.run / "paid/limited-announcement.baseline.result.json").unlink()
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_holdout_requires_completed_training_and_manual_reviews(self):
        with self.assertRaises((ValueError, OSError)):
            self.execute("holdout")
        self.assertEqual(self.calls, [])
        self.execute()
        with self.assertRaises(ValueError):
            self.execute("holdout")
        run, manifest = paid.trial.load_run(self.run)
        for case in manifest["cases"]:
            if case["split"] == "train":
                paid.trial.review(run, manifest, case["id"], "tie", "仅为模拟流程验证，不代表真实效果")
        self.execute("holdout")
        self.assertEqual(len(self.calls), 8)
        self.assertEqual(paid.spent_or_reserved(self.run), (Decimal("0.024"), False))

    def test_price_expiry_and_unverified_future_policy_are_rejected(self):
        for timestamp in ("2026-10-20T11:19:59+08:00", "2026-10-21T00:00:00+08:00"):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                self.actual_policy(datetime.fromisoformat(timestamp))
        self.assertEqual(self.actual_policy(datetime.fromisoformat("2026-10-20T12:00:00+08:00"))["currency"], "CNY")

    def test_tampered_messages_are_rejected_even_with_an_updated_manifest_hash(self):
        path = self.run / "train/limited-announcement.baseline.json"
        packet = paid.trial.read_json(path)
        packet["messages"][1]["content"] = "private-content-must-not-be-sent"
        path.write_text(json.dumps(packet), encoding="utf-8")
        manifest_path = self.run / "manifest.json"
        manifest = paid.trial.read_json(manifest_path)
        manifest["artifacts"]["train/limited-announcement.baseline.json"] = paid.trial.digest(paid.trial.read_text(path))
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_credential_file_requires_private_permissions_and_rejects_symlinks(self):
        descriptor, name = tempfile.mkstemp(prefix="seagull-harness2-key-", dir="/tmp")
        os.close(descriptor)
        path = Path(name)
        self.addCleanup(path.unlink, missing_ok=True)
        path.write_text("unit-test-only-key", encoding="utf-8")
        self.assertEqual(paid.private_key(path), "unit-test-only-key")
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            paid.private_key(path)
        linked = Path(str(path) + "-link")
        linked.symlink_to(path)
        self.addCleanup(linked.unlink, missing_ok=True)
        with self.assertRaises(OSError):
            paid.private_key(linked)
        with self.assertRaises(ValueError):
            paid.private_key(ROOT / ".env")

    def test_redirects_are_not_followed(self):
        with self.assertRaises(ValueError):
            paid.NoRedirect().redirect_request(None, None, 307, "redirect", {}, "https://example.com")

    def test_existing_incompatible_manual_output_is_detected_before_sending(self):
        run, manifest = paid.trial.load_run(self.run)
        paid.trial.record(run, manifest, "negative-result", "baseline", {
            "text": "模拟输出", "model": "another-model", "temperature": 0.25, "max_output_tokens": 1200,
        })
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_symlinked_ledger_is_rejected_before_sending(self):
        (self.run / "paid").symlink_to(self.run / "records", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_journal_failure_stops_before_network(self):
        with patch.object(paid, "durable_json", side_effect=OSError("test-disk-error")), self.assertRaises(OSError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_result_journal_failure_keeps_pending_reservation_and_stops(self):
        original = paid.durable_json

        def fail_result(path, value):
            if path.name.endswith(".result.json"):
                raise OSError("test-result-disk-error")
            return original(path, value)

        with patch.object(paid, "durable_json", side_effect=fail_result), self.assertRaises(OSError):
            self.execute()
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(paid.spent_or_reserved(self.run)[1])
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(len(self.calls), 1)

    def test_concurrent_executor_cannot_send(self):
        directory = self.run / "paid"
        directory.mkdir(mode=0o700)
        with (directory / "run.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.execute()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
