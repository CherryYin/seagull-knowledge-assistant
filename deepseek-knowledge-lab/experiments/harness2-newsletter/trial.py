import argparse
import ast
import hashlib
import json
import math
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[2]
SCHEMA = "seagull.newsletter-harness2-trial.v1"
PREFIX = "seagull-newsletter-h2-"
VARIANTS = ("baseline", "candidate")
IDENTIFIER = re.compile(r"[a-z][a-z0-9-]{0,63}")


def read_text(path):
    path = Path(path)
    if path.name.startswith(".env") or path.is_symlink() or not path.is_file() or path.stat().st_size > 2_000_000:
        raise ValueError("输入必须是不超过 2MB 的普通文件，不能使用符号链接")
    return path.read_text(encoding="utf-8")


def read_json(path):
    return json.loads(read_text(path))


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write("\n")


def baseline_prompt():
    source = WORKSPACE / "personal_knowledge_graph/src/pkg/services/application/newsletter_automation.py"
    for statement in ast.parse(read_text(source)).body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "_NEWSLETTER_DETAIL_SYSTEM_PROMPT"
            for target in statement.targets
        ):
            prompt = ast.literal_eval(statement.value)
            if isinstance(prompt, str) and prompt.strip():
                return prompt
    raise ValueError("未找到生产提示词常量；不导入或执行 PKG 来回退读取")


def case_content(case):
    return (
        "受众：技术读者\n编辑风格：清晰、客观、重视证据\n"
        f"素材标题：{case['title']}\n素材类型：离线虚构演示素材\n\n素材正文：\n{case['text']}"
    )


def prepare():
    fixtures = read_json(ROOT / "cases.json")
    cases = fixtures["cases"]
    identifiers = [case["id"] for case in cases]
    if len(set(identifiers)) != len(identifiers) or any(
        not IDENTIFIER.fullmatch(identifier) for identifier in identifiers
    ):
        raise ValueError("样例 ID 无效或重复")
    if {case["split"] for case in cases} != {"train", "holdout"}:
        raise ValueError("必须同时包含训练和留出样例")
    prompts = {"baseline": baseline_prompt(), "candidate": read_text(ROOT / "candidate.md")}
    run = Path(tempfile.mkdtemp(prefix=PREFIX))
    for directory in ("train", "holdout", "records", "reviews"):
        (run / directory).mkdir(mode=0o700)
    artifacts = {}
    for variant, prompt in prompts.items():
        name = f"{variant}.md"
        (run / name).write_text(prompt, encoding="utf-8")
        artifacts[name] = digest(prompt)
    for case in cases:
        content = case_content(case)
        for variant in VARIANTS:
            name = f"{case['split']}/{case['id']}.{variant}.json"
            packet = {
                "schema": SCHEMA,
                "case_id": case["id"],
                "split": case["split"],
                "variant": variant,
                "temperature": 0.25,
                "max_output_tokens": 1200,
                "tools": [],
                "messages": [
                    {"role": "system", "content": prompts[variant]},
                    {"role": "user", "content": content},
                ],
            }
            write_json(run / name, packet)
            artifacts[name] = digest(read_text(run / name))
    write_json(run / "manifest.json", {
        "schema": SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "prepared_not_model_tested",
        "synthetic": True,
        "candidate_origin": "manually_authored_not_harness2_generated",
        "baseline_scope": "newsletter_detail_prompt_only_not_full_pipeline",
        "cases": [{"id": case["id"], "split": case["split"]} for case in cases],
        "artifacts": artifacts,
    })
    return run


def load_run(value):
    run = Path(value).absolute()
    if run.is_symlink() or run.resolve().parent != Path(tempfile.gettempdir()).resolve() or not run.name.startswith(PREFIX):
        raise ValueError("只接受 prepare 创建的临时实验目录，不能指定生产或仓库目录")
    manifest = read_json(run / "manifest.json")
    if manifest.get("schema") != SCHEMA:
        raise ValueError("不是本工具的实验目录")
    cases = manifest.get("cases", [])
    if not cases or any(
        not IDENTIFIER.fullmatch(case["id"]) or case["split"] not in ("train", "holdout")
        for case in cases
    ):
        raise ValueError("实验样例清单无效")
    expected = {"baseline.md", "candidate.md"} | {
        f"{case['split']}/{case['id']}.{variant}.json" for case in cases for variant in VARIANTS
    }
    if set(manifest["artifacts"]) != expected:
        raise ValueError("实验文件清单发生变化，请重新准备实验")
    for directory in ("train", "holdout", "records", "reviews"):
        if (run / directory).is_symlink() or not (run / directory).is_dir():
            raise ValueError("实验子目录不能使用符号链接")
    for name, expected_hash in manifest["artifacts"].items():
        if digest(read_text(run / name)) != expected_hash:
            raise ValueError("输入或提示词已修改；必须新建实验，不能混用旧输出")
    return run, manifest


def case_in(manifest, identifier):
    if not any(case["id"] == identifier for case in manifest["cases"]):
        raise ValueError("未知样例")


def record(run, manifest, case_id, variant, response, *, provenance="manually_supplied_not_verified_provider_telemetry"):
    case_in(manifest, case_id)
    if variant not in VARIANTS:
        raise ValueError("未知提示词版本")
    allowed = {"text", "model", "temperature", "max_output_tokens", "elapsed_ms", "retry_count", "input_tokens", "output_tokens"}
    if not isinstance(response, dict) or set(response) - allowed:
        raise ValueError("响应只接受正文、模型、temperature 和可选用量元数据，不接受原始轨迹或凭据")
    for name in ("text", "model"):
        if not isinstance(response.get(name), str) or not response[name].strip():
            raise ValueError("正文和模型必填")
    temperature = response.get("temperature")
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or temperature != 0.25:
        raise ValueError("本轮对比的 temperature 必须明确为 0.25")
    if type(response.get("max_output_tokens")) is not int or response["max_output_tokens"] != 1200:
        raise ValueError("本轮对比的 max_output_tokens 必须明确为 1200")
    for name in allowed - {"text", "model", "temperature", "max_output_tokens"}:
        value = response.get(name)
        if value is not None and (type(value) is not int or value < 0):
            raise ValueError("用量、重试和耗时必须为非负整数；未知请省略或填 null")
    for previous_path in (run / "records").glob("*.json"):
        if read_json(previous_path)["response"]["model"] != response["model"]:
            raise ValueError("同一实验必须使用完全相同的模型 ID；换模型请新建实验")
    write_json(run / "records" / f"{case_id}.{variant}.json", {
        "case_id": case_id, "variant": variant, "response": response,
        "provenance": provenance,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    })


def review(run, manifest, case_id, winner, reason):
    case_in(manifest, case_id)
    if winner not in (*VARIANTS, "tie", "neither"):
        raise ValueError("未知取舍结果")
    if not reason.strip():
        raise ValueError("必须说明取舍依据，不能只填胜者")
    for variant in VARIANTS:
        path = run / "records" / f"{case_id}.{variant}.json"
        if not path.exists():
            raise ValueError("必须先登记同一样例的基线和候选输出，再进行人工取舍")
        read_json(path)
    write_json(run / "reviews" / f"{case_id}.json", {
        "winner": winner, "reason": reason,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    })


def report(run, manifest):
    lines = ["# Newsletter 离线对比", "", "虚构样例；只比较提示词，不代表完整 Harness、真实素材或发布效果。",
             "未登记不是失败；未知用量不是零。取舍来自人工复核，不是自动事实核验。", ""]
    for case in manifest["cases"]:
        lines.append(f"## {case['id']} · {case['split']}")
        for variant in VARIANTS:
            path = run / "records" / f"{case['id']}.{variant}.json"
            if not path.exists():
                lines.append(f"- {variant}：尚未登记模型输出")
                continue
            response = read_json(path)["response"]
            usage = " · ".join(f"{name}={response.get(name) if response.get(name) is not None else '未知'}" for name in (
                "elapsed_ms", "retry_count", "input_tokens", "output_tokens"))
            lines.extend([f"- {variant}：{response['model']} · 正文字符 {len(response['text'])} · {usage}",
                          "", response["text"], ""])
        decision = run / "reviews" / f"{case['id']}.json"
        if decision.exists():
            selected = read_json(decision)
            lines.append(f"人工取舍：{selected['winner']}；理由：{selected['reason']}")
        else:
            lines.append("人工取舍：待复核，不自动选优")
        lines.append("")
    lines.append("本工具不生成候选改写、不调用模型，也没有生产配置提升或自动发布功能。")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="仅本地文件的 newsletter 提示词对比；不联网、不读取 .env")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare")
    for name in ("record", "review", "report"):
        command = commands.add_parser(name)
        command.add_argument("--run", required=True)
        if name != "report":
            command.add_argument("--case", required=True)
        if name == "record":
            command.add_argument("--variant", choices=VARIANTS, required=True)
            command.add_argument("--response", type=Path, required=True)
        if name == "review":
            command.add_argument("--winner", choices=(*VARIANTS, "tie", "neither"), required=True)
            command.add_argument("--reason", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            print(prepare())
            return
        run, manifest = load_run(args.run)
        if args.command == "record":
            record(run, manifest, args.case, args.variant, read_json(args.response))
            print("已登记离线输出；未调用模型或修改生产配置")
        elif args.command == "review":
            review(run, manifest, args.case, args.winner, args.reason)
            print("已登记人工取舍；未自动应用候选")
        else:
            print(report(run, manifest))
    except (ValueError, OSError, KeyError, SyntaxError) as error:
        parser.exit(1, f"实验停止：{error}\n")


if __name__ == "__main__":
    main()
