import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


PINNED_REVISION = "1cfe254e8d25b15f37048c3730134686abe60335"


def demo_environment(home):
    return {
        "HOME": str(home),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
    }


def validate_source(source):
    if not source.is_dir() or (source / ".env").exists() or (source / ".env").is_symlink():
        raise ValueError("官方源码目录必须存在，且不能包含 .env")
    for arguments in (("rev-parse", "HEAD"), ("status", "--porcelain", "--untracked-files=all")):
        result = subprocess.run(
            ["git", "-C", str(source), *arguments],
            capture_output=True, text=True, check=True, timeout=10,
        )
        if arguments[0] == "rev-parse" and result.stdout.strip() != PINNED_REVISION:
            raise ValueError("上游版本与已审查的固定版本不符，不执行")
        if arguments[0] == "status" and result.stdout.strip():
            raise ValueError("官方源码有修改或未跟踪文件，不执行")


def run_demo(source):
    source = source.resolve()
    validate_source(source)
    root = Path(tempfile.mkdtemp(prefix="seagull-harness2-demo-"))
    home = root / "home"
    home.mkdir(mode=0o700)
    driver = (
        "import sys\n"
        "def audit(event, arguments):\n"
        "    if event.startswith('socket.'):\n"
        "        raise RuntimeError('Demo network access is disabled')\n"
        "sys.addaudithook(audit)\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "from harness2.cli.demo import main\n"
        "raise SystemExit(main(['--output', sys.argv[2], '--k', '1', '--mode', 'both']))\n"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", driver, str(source), str(root / "output")],
        cwd=root, env=demo_environment(home), capture_output=True, text=True,
        timeout=90, check=True,
    )
    summary = json.loads((root / "output/demo.json").read_text(encoding="utf-8"))
    print(result.stdout.strip())
    print(json.dumps({
        "upstream_revision": PINNED_REVISION,
        "result_directory": str(root),
        "done": summary["done"], "failed": summary["failed"],
        "execution_count": summary["execution_count"],
        "editor_calls": summary["editor_calls"],
        "model_api_calls": 0,
        "scope": "official_deterministic_demo_not_newsletter_quality_validation",
    }, ensure_ascii=False, indent=2))
    return root


def main():
    parser = argparse.ArgumentParser(description="固定版本官方零 API Demo；不安装依赖或启动服务")
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    try:
        run_demo(args.source)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Demo 停止：{error}\n")


if __name__ == "__main__":
    main()
