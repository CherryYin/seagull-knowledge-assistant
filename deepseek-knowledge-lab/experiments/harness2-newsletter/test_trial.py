import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent


def module_from(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trial = module_from("trial")
demo = module_from("upstream_demo")


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.run = trial.prepare()
        self.addCleanup(shutil.rmtree, self.run)
        self.run, self.manifest = trial.load_run(self.run)

    def response(self, **changes):
        return {"text": "这是测试输出，不是经过验证的模型产物。", "model": "test-model", "temperature": 0.25, "max_output_tokens": 1200, **changes}

    def test_prepare_keeps_cases_and_prompts_separate(self):
        self.assertEqual(self.run.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list((self.run / "train").glob("*.json"))), 6)
        self.assertEqual(len(list((self.run / "holdout").glob("*.json"))), 2)
        self.assertEqual(self.manifest["status"], "prepared_not_model_tested")
        self.assertTrue(self.manifest["synthetic"])
        self.assertIn("只根据用户提供的单条素材", trial.read_text(self.run / "baseline.md"))
        for prompt_name in ("baseline.md", "candidate.md"):
            prompt = trial.read_text(self.run / prompt_name)
            for field in ("JSON", "title", "summary", "detail"):
                self.assertIn(field, prompt)
        self.assertNotEqual(self.manifest["artifacts"]["baseline.md"], self.manifest["artifacts"]["candidate.md"])
        packet = trial.read_json(self.run / "train/limited-announcement.baseline.json")
        self.assertEqual(packet["tools"], [])
        self.assertEqual(packet["temperature"], 0.25)
        self.assertEqual(packet["max_output_tokens"], 1200)
        self.assertNotIn("negative-result", json.dumps(packet))

    def test_offline_flow_never_uses_process_or_network(self):
        with patch("subprocess.run", side_effect=AssertionError("不可启动进程")), patch(
            "socket.socket", side_effect=AssertionError("不可联网")
        ):
            trial.record(self.run, self.manifest, "limited-announcement", "baseline", self.response())
            text = trial.report(self.run, self.manifest)
        self.assertIn("input_tokens=未知", text)
        self.assertIn("尚未登记模型输出", text)
        self.assertIn("待复核，不自动选优", text)

    def test_snapshot_reads_only_explicit_public_source_files(self):
        visited = []
        original = trial.read_text

        def track(path):
            visited.append(Path(path))
            return original(path)

        with patch.object(trial, "read_text", side_effect=track):
            extra = trial.prepare()
            self.addCleanup(shutil.rmtree, extra)
        self.assertFalse(any(path.name.startswith(".env") or ".dsh" in path.parts for path in visited))
        self.assertFalse(any(path.name == "config.py" for path in visited))

    def test_records_preserve_zero_and_unknown(self):
        trial.record(self.run, self.manifest, "limited-announcement", "baseline", self.response(retry_count=0, elapsed_ms=None))
        text = trial.report(self.run, self.manifest)
        self.assertIn("retry_count=0", text)
        self.assertIn("elapsed_ms=未知", text)
        self.assertIn("output_tokens=未知", text)

    def test_review_requires_two_outputs_and_explicit_reason(self):
        with self.assertRaises(ValueError):
            trial.review(self.run, self.manifest, "limited-announcement", "candidate", "更简洁")
        for variant in trial.VARIANTS:
            trial.record(self.run, self.manifest, "limited-announcement", variant, self.response())
        with self.assertRaises(ValueError):
            trial.review(self.run, self.manifest, "limited-announcement", "candidate", "  ")
        trial.review(self.run, self.manifest, "limited-announcement", "neither", "两份都需要人工更正")
        self.assertIn("人工取舍：neither", trial.report(self.run, self.manifest))

    def test_records_and_reviews_cannot_be_overwritten(self):
        for variant in trial.VARIANTS:
            trial.record(self.run, self.manifest, "limited-announcement", variant, self.response())
        with self.assertRaises(FileExistsError):
            trial.record(self.run, self.manifest, "limited-announcement", "baseline", self.response(text="覆盖"))
        trial.review(self.run, self.manifest, "limited-announcement", "tie", "没有明显差异")
        with self.assertRaises(FileExistsError):
            trial.review(self.run, self.manifest, "limited-announcement", "candidate", "覆盖")

    def test_mixed_models_are_rejected(self):
        trial.record(self.run, self.manifest, "limited-announcement", "baseline", self.response())
        with self.assertRaises(ValueError):
            trial.record(self.run, self.manifest, "limited-announcement", "candidate", self.response(model="another-model"))
        self.assertFalse((self.run / "records/limited-announcement.candidate.json").exists())

    def test_bad_usage_parameters_and_extra_fields_are_rejected(self):
        for changes in (
            {"retry_count": True}, {"input_tokens": -1}, {"elapsed_ms": 0.2},
            {"output_tokens": "12"}, {"temperature": True}, {"temperature": float("nan")},
            {"temperature": 0.5}, {"max_output_tokens": 2400}, {"model": ""}, {"text": ""}, {"api_key": "must-not-be-saved"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                trial.record(self.run, self.manifest, "limited-announcement", "baseline", self.response(**changes))
        self.assertEqual(list((self.run / "records").iterdir()), [])

    def test_unknown_cases_or_variants_cannot_escape_output_directory(self):
        with self.assertRaises(ValueError):
            trial.record(self.run, self.manifest, "../escaped", "baseline", self.response())
        with self.assertRaises(ValueError):
            trial.record(self.run, self.manifest, "limited-announcement", "../../escaped", self.response())
        with self.assertRaises(ValueError):
            trial.review(self.run, self.manifest, "limited-announcement", "automatic", "不允许")

    def test_production_path_is_rejected(self):
        with self.assertRaises(ValueError):
            trial.load_run(trial.WORKSPACE)

    def test_env_file_is_rejected_even_when_explicitly_selected(self):
        path = self.run / ".env"
        path.write_text('{"text": "not-for-import"}', encoding="utf-8")
        with self.assertRaises(ValueError):
            trial.read_json(path)

    def test_cli_report_and_rejected_production_path(self):
        command = [sys.executable, "-I", "-B", str(ROOT / "trial.py"), "report", "--run"]
        result = subprocess.run([*command, str(self.run)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn("尚未登记模型输出", result.stdout)
        rejected = subprocess.run([*command, str(trial.WORKSPACE)], capture_output=True, text=True, timeout=10)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("实验停止", rejected.stderr)

    def test_changed_prompt_or_packet_requires_a_new_trial(self):
        for name in ("candidate.md", "train/limited-announcement.baseline.json"):
            with self.subTest(name=name):
                path = self.run / name
                original = trial.read_text(path)
                path.write_text("changed", encoding="utf-8")
                with self.assertRaises(ValueError):
                    trial.load_run(self.run)
                path.write_text(original, encoding="utf-8")

    def test_symlink_directories_and_inputs_are_rejected(self):
        records = self.run / "records"
        records.rmdir()
        records.symlink_to(self.run / "train", target_is_directory=True)
        with self.assertRaises(ValueError):
            trial.load_run(self.run)
        path = self.run / "linked.json"
        path.symlink_to(self.run / "manifest.json")
        with self.assertRaises(ValueError):
            trial.read_text(path)

    def test_manipulated_artifact_paths_are_rejected(self):
        path = self.run / "manifest.json"
        self.manifest["artifacts"]["../../production"] = "invalid"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaises(ValueError):
            trial.load_run(self.run)


class OfficialDemoTests(unittest.TestCase):
    def test_demo_does_not_inherit_credentials_or_runtime_environment(self):
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "secret", "DSH_HOME": "/production", "DATABASE_URL": "secret"}):
            environment = demo.demo_environment(Path("/isolated-home"))
        self.assertEqual(environment["HOME"], "/isolated-home")
        self.assertEqual(set(environment), {"HOME", "PATH", "LANG", "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE", "GIT_CONFIG_NOSYSTEM"})

    def test_demo_rejects_dotenv_before_executing_any_process(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / ".env").write_text("DO_NOT_READ=this-is-a-test", encoding="utf-8")
            with patch("subprocess.run", side_effect=AssertionError("不应执行")), self.assertRaises(ValueError):
                demo.validate_source(source)

    def test_demo_rejects_unreviewed_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout="different-sha\n")), self.assertRaises(ValueError):
                demo.validate_source(Path(directory))

    def test_demo_rejects_modified_source(self):
        results = [subprocess.CompletedProcess([], 0, stdout=demo.PINNED_REVISION), subprocess.CompletedProcess([], 0, stdout=" M harness2/demo.py\n")]
        with tempfile.TemporaryDirectory() as directory:
            with patch("subprocess.run", side_effect=results), self.assertRaises(ValueError):
                demo.validate_source(Path(directory))


if __name__ == "__main__":
    unittest.main()
