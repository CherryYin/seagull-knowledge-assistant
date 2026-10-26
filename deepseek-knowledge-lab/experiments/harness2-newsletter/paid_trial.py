import argparse
import fcntl
import importlib.util
import json
import os
import ssl
import stat
import time
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("newsletter_trial", ROOT / "trial.py")
trial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trial)
ENDPOINT = "https://api.deepseek.com/chat/completions"
KEY_VARIABLE = "HARNESS2_DEEPSEEK_API_KEY"


def policy_at(now):
    policy = trial.read_json(ROOT / "pricing.json")
    if policy.get("schema") != "seagull.harness2-pricing.v1" or policy.get("model") != "deepseek-v4-flash" or policy.get("currency") != "CNY":
        raise ValueError("价格策略模型或币种不匹配")
    for name in ("input_miss_per_million", "output_per_million"):
        rate = Decimal(policy[name])
        if not rate.is_finite() or rate <= 0:
            raise ValueError("价格必须是已核实的正数")
    if (policy["reservation_input_tokens"], policy["max_request_bytes"], policy["max_output_tokens"]) != (65536, 16000, 1200):
        raise ValueError("本轮固定的预留和请求上限不匹配")
    if not datetime.fromisoformat(policy["verified_at"]) <= now < datetime.fromisoformat(policy["expires_at"]):
        raise ValueError("价格策略尚未生效或已过期，请重新核对官方价格；不发请求")
    return policy


def request_cost(policy, input_tokens, output_tokens):
    return (
        Decimal(input_tokens) * Decimal(policy["input_miss_per_million"])
        + Decimal(output_tokens) * Decimal(policy["output_per_million"])
    ) / Decimal(1_000_000)


def durable_json(path, value):
    trial.write_json(path, value)
    for target in (path, path.parent):
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def budget_value(value):
    budget = Decimal(value)
    if not budget.is_finite() or not Decimal(0) < budget <= Decimal("2"):
        raise ValueError("此次授权预算必须大于 0 且不超过 2 元")
    return budget


def packets_for(run, manifest, phase):
    fixtures = trial.read_json(ROOT / "cases.json")
    if not fixtures.get("synthetic") or not manifest.get("synthetic"):
        raise ValueError("此次授权只允许内置虚构素材")
    expected_cases = [{"id": case["id"], "split": case["split"]} for case in fixtures["cases"]]
    if manifest["cases"] != expected_cases:
        raise ValueError("不是内置样例集合，拒绝发送")
    prompts = {"baseline": trial.baseline_prompt(), "candidate": trial.read_text(ROOT / "candidate.md")}
    packets = []
    for case in fixtures["cases"]:
        if case["split"] != phase:
            continue
        for variant in trial.VARIANTS:
            packet = trial.read_json(run / f"{phase}/{case['id']}.{variant}.json")
            expected_messages = [
                {"role": "system", "content": prompts[variant]},
                {"role": "user", "content": trial.case_content(case)},
            ]
            if packet["messages"] != expected_messages or packet.get("tools") != []:
                raise ValueError("输入不再匹配已审查的独立提示词与虚构素材，拒绝发送")
            if packet.get("temperature") != 0.25 or packet.get("max_output_tokens") != 1200:
                raise ValueError("参数不匹配，不发送")
            packets.append(packet)
    return packets


def payload_for(packet, policy):
    payload = {
        "model": policy["model"], "messages": packet["messages"],
        "thinking": {"type": "disabled"}, "temperature": 0.25,
        "max_tokens": policy["max_output_tokens"], "stream": False,
    }
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > policy["max_request_bytes"]:
        raise ValueError("输入超过预留预算采用的文本上限，不发送")
    return payload


def spent_or_reserved(run):
    paid = run / "paid"
    if paid.is_symlink():
        raise ValueError("账本目录不能是符号链接")
    total = Decimal(0)
    uncertain = False
    for path in sorted(paid.glob("*.pending.json")):
        pending = trial.read_json(path)
        result_path = path.with_name(path.name.replace(".pending.json", ".result.json"))
        result = trial.read_json(result_path) if result_path.exists() else {}
        if result.get("status") != "completed":
            uncertain = True
            total += Decimal(pending["reserved_cny"])
        else:
            total += Decimal(result["estimated_cny"])
    return total, uncertain


def plan(value, budget, phase, now=None):
    run, manifest = trial.load_run(value)
    policy = policy_at(now or datetime.now(timezone.utc))
    budget = budget_value(budget)
    packets = packets_for(run, manifest, phase)
    for packet in packets:
        payload_for(packet, policy)
    reserved = request_cost(policy, policy["reservation_input_tokens"], policy["max_output_tokens"])
    used, uncertain = spent_or_reserved(run)
    if uncertain:
        raise ValueError("已有未完成、失败或结果未知的调用，禁止继续或重试；请核查服务商账单")
    if used + reserved * len(packets) > budget:
        raise ValueError("保守预留超过剩余预算，不发送")
    return run, manifest, policy, packets, reserved, used, budget


def private_key(key_file=None):
    if key_file is None:
        key = os.environ.get(KEY_VARIABLE, "")
    else:
        path = Path(key_file)
        if path.parent.resolve() != Path("/tmp") or not path.name.startswith("seagull-harness2-key-"):
            raise ValueError("凭据文件必须为 /tmp/seagull-harness2-key-*，不能指定生产 .env")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
                raise ValueError("凭据必须是本人所有、仅本人可读写的普通文件")
            key = source.read(512)
    key = key.strip()
    if not key or len(key) > 256 or any(character.isspace() for character in key):
        raise ValueError("未设置有效的独立试验 Key；不会回退读取生产环境变量或 .env")
    return key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("拒绝重定向，独立凭据不会发送到其他地址")


def send(payload, key):
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST",
    )
    with opener.open(request, timeout=90) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("响应超出上限")
        return json.loads(raw)


def validate_response(response, policy):
    usage = response.get("usage") or {}
    counts = [usage.get("prompt_tokens"), usage.get("completion_tokens")]
    if any(type(value) is not int or value < 0 for value in counts):
        raise ValueError("服务商用量未知，不能当作零或继续请求")
    message = response["choices"][0]["message"]
    if message.get("tool_calls") or not isinstance(message.get("content"), str) or not message["content"].strip():
        raise ValueError("非纯文本结果，不执行工具，不继续请求")
    if response["choices"][0].get("finish_reason") != "stop" or response.get("model") != policy["model"]:
        raise ValueError("模型不符或结果被截断，不继续请求")
    if counts[0] > policy["reservation_input_tokens"] or counts[1] > policy["max_output_tokens"]:
        raise ValueError("服务商用量超过预留上界，不继续请求")
    return message["content"], counts[0], counts[1]


def execute(value, budget, phase, *, consent=False, key_file=None, transport=None):
    if not consent:
        raise ValueError("必须明确确认发送虚构素材及计费；没有发出请求")
    context = plan(value, budget, phase)
    run, manifest, policy, packets, reserved, used, budget = context
    key = private_key(key_file)
    if phase == "holdout":
        for case in manifest["cases"]:
            if case["split"] == "train":
                trial.read_json(run / "reviews" / f"{case['id']}.json")
                for variant in trial.VARIANTS:
                    result = trial.read_json(run / "paid" / f"{case['id']}.{variant}.result.json")
                    if result.get("status") != "completed":
                        raise ValueError("训练试跑尚未完整结束，不能开始留出测试")
    paid = run / "paid"
    paid.mkdir(mode=0o700, exist_ok=True)
    with os.fdopen(os.open(paid / "run.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run, manifest, policy, packets, reserved, used, budget = plan(value, str(budget), phase)
        authorization = {"budget_cny": str(budget.normalize()), "pricing_sha256": trial.digest(trial.read_text(ROOT / "pricing.json"))}
        authorization_path = paid / "authorization.json"
        if authorization_path.exists():
            if trial.read_json(authorization_path) != authorization:
                raise ValueError("本轮预算或价格策略发生变化，不自动追加授权")
        else:
            durable_json(authorization_path, authorization)
        for path in (run / "records").glob("*.json"):
            response = trial.read_json(path)["response"]
            if response.get("model") != policy["model"] or response.get("temperature") != 0.25 or response.get("max_output_tokens") != 1200:
                raise ValueError("已有输出的模型或参数不符，不发请求")
        for packet in packets:
            if (run / "records" / f"{packet['case_id']}.{packet['variant']}.json").exists():
                raise ValueError("已有输出，不覆盖或重跑；本阶段尚未发出请求")
        durable_json(paid / f"{phase}.started.json", {"at": datetime.now(timezone.utc).isoformat()})
        for packet in packets:
            policy_at(datetime.now(timezone.utc))
            name = f"{packet['case_id']}.{packet['variant']}"
            durable_json(paid / f"{name}.pending.json", {"reserved_cny": str(reserved)})
            started = time.monotonic()
            try:
                response = (transport or send)(payload_for(packet, policy), key)
                text, input_tokens, output_tokens = validate_response(response, policy)
                estimated = request_cost(policy, input_tokens, output_tokens)
                trial.record(run, manifest, packet["case_id"], packet["variant"], {
                    "text": text, "model": policy["model"], "temperature": 0.25, "max_output_tokens": 1200,
                    "elapsed_ms": round((time.monotonic() - started) * 1000), "retry_count": 0,
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                }, provenance="provider_reported_usage_not_invoice_verified")
                durable_json(paid / f"{name}.result.json", {
                    "status": "completed", "estimated_cny": str(estimated),
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                })
            except BaseException as error:
                result_path = paid / f"{name}.result.json"
                if not result_path.exists():
                    durable_json(result_path, {"status": "outcome_unknown", "error_type": type(error).__name__})
                if not isinstance(error, Exception):
                    raise
                raise ValueError("调用结果或用量无法确认，已停止；不打印服务商原始错误、不重试，请核查账单") from None
    return run


def main():
    parser = argparse.ArgumentParser(description="独立的 DeepSeek 纯文本试跑；本轮最多 2 元，无工具、无重试")
    parser.add_argument("command", choices=("plan", "execute"))
    parser.add_argument("--run", required=True)
    parser.add_argument("--budget-cny", required=True)
    parser.add_argument("--phase", choices=("train", "holdout"), default="train")
    parser.add_argument("--confirm-send-synthetic", action="store_true")
    parser.add_argument("--key-file", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "plan":
            run, manifest, policy, packets, reserved, used, budget = plan(args.run, args.budget_cny, args.phase)
            print(json.dumps({
                "model": policy["model"], "phase": args.phase, "requests": len(packets),
                "budget_cny": str(budget), "spent_estimate_cny": str(used),
                "phase_reservation_cny": str(reserved * len(packets)),
                "pricing_expires_at": policy["expires_at"], "network_requests_sent": 0,
                "credential_configured": bool(os.environ.get(KEY_VARIABLE)) or args.key_file is not None,
                "note": "保守预留非服务商账单硬限额；未开始真实模型测试",
            }, ensure_ascii=False, indent=2))
        else:
            run = execute(args.run, args.budget_cny, args.phase, consent=args.confirm_send_synthetic, key_file=args.key_file)
            used, uncertain = spent_or_reserved(run)
            print(f"已完成 {args.phase}；按用量保守估算 {used} 元（非服务商账单）。留出测试不会自动执行。")
    except (ValueError, ArithmeticError, OSError, KeyError, IndexError, TypeError):
        parser.exit(1, "试跑停止：请检查授权、专用凭据、价格有效期、输入与预算或调用账本；未自动重试。\n")


if __name__ == "__main__":
    main()
