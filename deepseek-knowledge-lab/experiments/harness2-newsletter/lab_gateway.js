import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const bridge = fileURLToPath(new URL("./lab_bridge.py", import.meta.url));
const defaultDirectory = fileURLToPath(new URL("../../.dsh/run/harness2", import.meta.url));

export class Harness2Lab {
  constructor({ directory = process.env.HARNESS2_LAB_DATA_DIR || defaultDirectory,
    python = process.env.HARNESS2_LAB_PYTHON || "python3" } = {}) {
    this.directory = resolve(directory);
    this.python = python;
  }

  environment() {
    return {
      PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8",
      HOME: this.directory, HARNESS2_LAB_DATA_DIR: this.directory,
      HARNESS2_LAB_EXECUTION_ENABLED: process.env.HARNESS2_LAB_EXECUTION_ENABLED || "false",
      ...(process.env.HARNESS2_LAB_KEY_FILE ? { HARNESS2_LAB_KEY_FILE: process.env.HARNESS2_LAB_KEY_FILE } : {}),
      ...(process.env.HARNESS2_DEEPSEEK_API_KEY ? { HARNESS2_DEEPSEEK_API_KEY: process.env.HARNESS2_DEEPSEEK_API_KEY } : {}),
    };
  }

  child(detached = false) {
    return spawn(this.python, ["-B", "-E", "-s", bridge], {
      cwd: this.directory, env: this.environment(), detached,
      stdio: ["pipe", detached ? "ignore" : "pipe", "ignore"],
    });
  }

  async call(action, owner, body = {}) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const child = this.child();
    return new Promise((resolve, reject) => {
      let output = "";
      const failure = () => Object.assign(new Error("隔离实验执行器不可用；未自动重试，请检查 Python 和私有存储。"), { status: 503 });
      const timeout = setTimeout(() => { child.kill(); reject(failure()); }, 20000);
      child.stdout.on("data", chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > 2_000_000) child.kill();
      });
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timeout); reject(failure()); });
      child.on("close", code => {
        clearTimeout(timeout);
        try {
          if (code !== 0) throw failure();
          const result = JSON.parse(output);
          if (!result.ok) return reject(Object.assign(new Error(result.error), { status: result.status }));
          resolve(result.result);
        } catch { reject(failure()); }
      });
      child.stdin.end(JSON.stringify({ action, owner, body }));
    });
  }

  async start(owner, body) {
    const result = await this.call("claim", owner, body);
    try {
      const child = this.child(true);
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ action: "work", owner, body: { id: result.id } }));
      child.unref();
    } catch {
      throw Object.assign(new Error("阶段已锁定但执行器未能启动；不会自动重试，请刷新查看状态。"), { status: 503 });
    }
    return result;
  }
}
