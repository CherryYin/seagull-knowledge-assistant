import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import paid_trial as paid


trial = paid.trial
ACTIVE = ("train_running", "holdout_running")


class LabError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def database():
    root = Path(os.environ["HARNESS2_LAB_DATA_DIR"]).absolute()
    if root.is_symlink() or root.resolve() != root or root == trial.WORKSPACE:
        raise LabError(503, "实验存储路径不安全")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise LabError(503, "实验目录必须仅服务用户可访问（0700）")
    path = root / "lab.sqlite3"
    if path.is_symlink():
        raise LabError(503, "实验数据库不能使用符号链接")
    tempfile.tempdir = str(root)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("""CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, run TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, message TEXT,
        phase TEXT, pid INTEGER, claimed_at REAL
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS preflights (
        id TEXT PRIMARY KEY, experiment TEXT NOT NULL, owner TEXT NOT NULL,
        phase TEXT NOT NULL, budget TEXT NOT NULL, fingerprint TEXT NOT NULL,
        expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS phases (
        experiment TEXT NOT NULL, phase TEXT NOT NULL, budget TEXT NOT NULL,
        fingerprint TEXT NOT NULL, consent_at TEXT NOT NULL,
        PRIMARY KEY (experiment, phase)
    )""")
    connection.commit()
    return connection


def owned(connection, owner, identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise LabError(404, "实验不存在")
    row = connection.execute("SELECT * FROM experiments WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if row is None:
        raise LabError(404, "实验不存在")
    return row


def optional(path):
    if not path.exists() and not path.is_symlink():
        return None
    try:
        return trial.read_json(path)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def reconcile(connection, row):
    if row["status"] not in ACTIVE:
        return row
    alive = False
    if row["pid"]:
        try:
            os.kill(row["pid"], 0)
            alive = True
        except ProcessLookupError:
            pass
    elif time.time() - row["claimed_at"] < 60:
        alive = True
    if not alive:
        connection.execute(
            "UPDATE experiments SET status='interrupted', message=? WHERE id=? AND status=? AND pid IS ? AND claimed_at=?",
            ("实验进程已中断；禁止自动重试，请检查已保存结果和服务商账单", row["id"], row["status"], row["pid"], row["claimed_at"]),
        )
        connection.commit()
        return owned(connection, row["owner"], row["id"])
    return row


def detail(connection, row):
    row = reconcile(connection, row)
    run, manifest = trial.load_run(row["run"])
    cases = []
    for case in manifest["cases"]:
        outputs = {}
        for variant in trial.VARIANTS:
            record = optional(run / "records" / f"{case['id']}.{variant}.json")
            result = optional(run / "paid" / f"{case['id']}.{variant}.result.json")
            pending = (run / "paid" / f"{case['id']}.{variant}.pending.json").exists()
            outputs[variant] = {
                "status": result["status"] if result else ("pending" if pending else "not_started"),
                "response": record["response"] if record else None,
                "estimated_cny": result.get("estimated_cny") if result else None,
            }
        packet = trial.read_json(run / f"{case['split']}/{case['id']}.baseline.json")
        material = packet["messages"][1]["content"] if case["split"] == "train" or row["phase"] == "holdout" else None
        cases.append({**case, "material": material, "outputs": outputs,
                      "review": optional(run / "reviews" / f"{case['id']}.json")})
    used, uncertain = paid.spent_or_reserved(run)
    attempts = len(list((run / "paid").glob("*.pending.json")))
    return {
        "id": row["id"], "name": "Newsletter 深度解读 A/B", "status": row["status"],
        "created_at": row["created_at"], "message": row["message"], "phase": row["phase"],
        "method": "manual_prompt_ab_not_full_harness2", "synthetic": True,
        "prompts": {variant: trial.read_text(run / f"{variant}.md") for variant in trial.VARIANTS},
        "cases": cases, "attempts": attempts,
        "spent_estimate_cny": str(used) if not uncertain else None,
        "spent_or_reserved_cny": str(used), "outcome_unknown": uncertain,
        "budget_cny": next((item["budget"] for item in connection.execute(
            "SELECT budget FROM phases WHERE experiment=? ORDER BY consent_at LIMIT 1", (row["id"],)
        )), None),
    }


def readiness(connection, row, phase, budget):
    if phase not in ("train", "holdout"):
        raise LabError(400, "未知实验阶段")
    if row["status"] != ("prepared" if phase == "train" else "awaiting_review"):
        raise LabError(409, "当前状态不能启动此阶段；不允许重跑或解除未知调用锁")
    if connection.execute("SELECT 1 FROM phases WHERE experiment=? AND phase=?", (row["id"], phase)).fetchone():
        raise LabError(409, "此阶段已经确认启动，不能再次执行")
    context = paid.plan(row["run"], budget, phase)
    run, manifest, policy, packets, reserved, used, budget = context
    if phase == "holdout":
        for case in manifest["cases"]:
            if case["split"] == "train":
                if not (run / "reviews" / f"{case['id']}.json").exists():
                    raise LabError(409, "请先完成三组人工评审，才能开始留出复验")
                trial.read_json(run / "reviews" / f"{case['id']}.json")
                for variant in trial.VARIANTS:
                    result = trial.read_json(run / "paid" / f"{case['id']}.{variant}.result.json")
                    if result.get("status") != "completed":
                        raise LabError(409, "请先完成训练输出及三组人工评审")
    prior = connection.execute("SELECT budget FROM phases WHERE experiment=? LIMIT 1", (row["id"],)).fetchone()
    if prior and prior["budget"] != str(budget.normalize()):
        raise LabError(409, "同一实验不能改变已确认预算")
    fingerprint = trial.digest(json.dumps({
        "artifacts": manifest["artifacts"], "pricing": trial.read_text(trial.ROOT / "pricing.json"),
        "phase": phase, "budget": str(budget.normalize()),
    }, sort_keys=True))
    return context, fingerprint


def preflight(connection, owner, row, body):
    phase = body.get("phase", "train")
    budget = str(body.get("budget_cny", "2"))
    blockers = []
    if os.environ.get("HARNESS2_LAB_EXECUTION_ENABLED") != "true":
        blockers.append("服务端未开启实验执行；请配置 BFF 专用开关")
    try:
        paid.private_key(os.environ.get("HARNESS2_LAB_KEY_FILE") or None)
    except (ValueError, OSError):
        blockers.append("未配置有效的专用试验凭据；不会使用生产 Key")
    context = None
    try:
        context, fingerprint = readiness(connection, row, phase, budget)
    except (ValueError, OSError, KeyError, ArithmeticError, LabError) as error:
        blockers.append(str(error) if isinstance(error, (ValueError, LabError)) else "输入、价格或前置评审不可用，请检查实验文件")
    result = {"ready": not blockers, "blockers": blockers, "preflight_id": None,
              "network_requests_sent": 0, "phase": phase, "budget_cny": budget}
    if context:
        _, _, policy, packets, reserved, used, budget = context
        result.update({"model": policy["model"], "requests": len(packets),
                       "phase_reservation_cny": str(reserved * len(packets)),
                       "spent_or_reserved_cny": str(used), "pricing_expires_at": policy["expires_at"]})
        if not blockers:
            identifier = uuid.uuid4().hex
            connection.execute("INSERT INTO preflights VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                               (identifier, row["id"], owner, phase, str(budget.normalize()), fingerprint, time.time() + 600))
            connection.commit()
            result["preflight_id"] = identifier
    return result


def claim(connection, owner, row, body):
    if body.get("confirm_send_synthetic") is not True:
        raise LabError(400, "必须明确确认发送虚构素材和本阶段计费")
    if os.environ.get("HARNESS2_LAB_EXECUTION_ENABLED") != "true":
        raise LabError(409, "服务端未开启实验执行")
    paid.private_key(os.environ.get("HARNESS2_LAB_KEY_FILE") or None)
    connection.execute("BEGIN IMMEDIATE")
    row = owned(connection, owner, row["id"])
    token = connection.execute("SELECT * FROM preflights WHERE id=? AND experiment=? AND owner=?",
                               (body.get("preflight_id"), row["id"], owner)).fetchone()
    if not token or token["used"] or token["expires"] <= time.time():
        raise LabError(409, "预检已过期或已使用，请重新预检；未发起调用")
    _, fingerprint = readiness(connection, row, token["phase"], token["budget"])
    if fingerprint != token["fingerprint"]:
        raise LabError(409, "实验输入或价格发生变化，请重新预检")
    connection.execute("INSERT INTO phases VALUES (?, ?, ?, ?, ?)",
                       (row["id"], token["phase"], token["budget"], fingerprint, now()))
    connection.execute("UPDATE preflights SET used=1 WHERE id=?", (token["id"],))
    connection.execute("UPDATE experiments SET status=?, phase=?, claimed_at=?, pid=NULL, message=NULL WHERE id=?",
                       (f"{token['phase']}_running", token["phase"], time.time(), row["id"]))
    connection.commit()
    return {"id": row["id"], "phase": token["phase"], "status": f"{token['phase']}_running"}


def work(connection, owner, row, transport=None):
    connection.execute("BEGIN IMMEDIATE")
    row = owned(connection, owner, row["id"])
    if row["status"] not in ACTIVE or row["pid"] is not None:
        raise LabError(409, "任务不再等待执行；不会重试")
    connection.execute("UPDATE experiments SET pid=? WHERE id=?", (os.getpid(), row["id"]))
    consent = connection.execute("SELECT * FROM phases WHERE experiment=? AND phase=?", (row["id"], row["phase"])).fetchone()
    connection.commit()
    try:
        if os.environ.get("HARNESS2_LAB_EXECUTION_ENABLED") != "true":
            raise LabError(409, "执行开关已关闭")
        _, manifest = trial.load_run(row["run"])
        fingerprint = trial.digest(json.dumps({"artifacts": manifest["artifacts"],
            "pricing": trial.read_text(trial.ROOT / "pricing.json"), "phase": row["phase"],
            "budget": consent["budget"]}, sort_keys=True))
        if fingerprint != consent["fingerprint"]:
            raise LabError(409, "已确认输入或价格变化，实验停止")
        paid.execute(row["run"], consent["budget"], row["phase"], consent=True,
                     key_file=os.environ.get("HARNESS2_LAB_KEY_FILE") or None, transport=transport)
        status = "awaiting_review" if row["phase"] == "train" else "completed"
        message = None
    except Exception:
        _, uncertain = paid.spent_or_reserved(Path(row["run"]))
        status = "outcome_unknown" if uncertain else "stopped"
        message = "实验已停止，未自动重试；请检查价格有效期、实验文件和服务商调用账单。未知费用不是零。"
    connection.execute("UPDATE experiments SET status=?, message=?, pid=NULL WHERE id=?", (status, message, row["id"]))
    connection.commit()
    return {"id": row["id"], "status": status}


def dispatch(connection, action, owner, body):
    if action == "list":
        rows = connection.execute("SELECT * FROM experiments WHERE owner=? ORDER BY created_at DESC LIMIT 100", (owner,)).fetchall()
        return {"items": [{"id": row["id"], "name": "Newsletter 深度解读 A/B", "status": row["status"],
                           "created_at": row["created_at"]} for row in (reconcile(connection, item) for item in rows)]}
    if action == "create":
        run = trial.prepare()
        identifier = uuid.uuid4().hex
        connection.execute("INSERT INTO experiments (id, owner, run, status, created_at) VALUES (?, ?, ?, 'prepared', ?)",
                           (identifier, owner, str(run), now()))
        connection.commit()
        return detail(connection, owned(connection, owner, identifier))
    row = owned(connection, owner, body.get("id"))
    if action == "get":
        return detail(connection, row)
    if action == "preflight":
        return preflight(connection, owner, reconcile(connection, row), body)
    if action == "claim":
        return claim(connection, owner, row, body)
    if action == "work":
        return work(connection, owner, row)
    if action == "review":
        if row["status"] not in ("awaiting_review", "completed"):
            raise LabError(409, "请等待阶段执行结束后评审")
        reason = body.get("reason")
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 4000:
            raise LabError(400, "请填写 1–4000 字的取舍原因")
        run, manifest = trial.load_run(row["run"])
        trial.review(run, manifest, body.get("case_id"), body.get("winner"), reason.strip())
        return detail(connection, row)
    if action == "report":
        snapshot = detail(connection, row)
        run, manifest = trial.load_run(row["run"])
        content = (f"# Harness² 隔离试验：Newsletter 提示词 A/B\n\n实验 ID：{row['id']}\n\n"
                   f"状态：{snapshot['status']}\n\n方法：人工候选提示词对比，并非完整 Harness² 自动优化。\n\n"
                   f"总预算：{snapshot['budget_cny'] or '尚未授权'} 元；已用及保守预留：{snapshot['spent_or_reserved_cny']} 元。\n\n"
                   f"调用数：{snapshot['attempts']}；估算费用：{snapshot['spent_estimate_cny'] or '未知'} 元（非账单核验）。\n\n"
                   f"A 提示词指纹：{manifest['artifacts']['baseline.md']}\n\nB 提示词指纹：{manifest['artifacts']['candidate.md']}\n\n"
                   "不自动修改生产配置，不代表真实文章或阅读量提升。\n\n" + trial.report(run, manifest))
        return {"id": f"note-harness2-{row['id']}-{hashlib.sha256(content.encode()).hexdigest()[:12]}",
                "title": "Harness² 隔离试验：Newsletter 对比结论", "content": content}
    raise LabError(404, "未知实验操作")


def main():
    os.umask(0o077)
    try:
        request = json.loads(sys.stdin.read(65537))
        owner = request.get("owner")
        if not isinstance(owner, str) or not 1 <= len(owner) <= 200:
            raise LabError(400, "缺少可信用户身份")
        with closing(database()) as connection:
            with connection:
                result = dispatch(connection, request["action"], owner, request.get("body") or {})
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except LabError as error:
        print(json.dumps({"ok": False, "status": error.status, "error": str(error)}, ensure_ascii=False))
    except (ValueError, FileExistsError):
        print(json.dumps({"ok": False, "status": 409, "error": "实验输入、价格或状态校验失败；评审不可覆盖，请刷新检查。未自动重试。"}, ensure_ascii=False))
    except Exception:
        print(json.dumps({"ok": False, "status": 503, "error": "隔离实验暂不可用，请检查 Python、私有存储和实验文件；未自动重试。"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
