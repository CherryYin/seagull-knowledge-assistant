import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "dsh-harness/apps/cli/lib/bin.js");
const dshHome = resolve(root, ".dsh");
const primaryPackage = "@deepseek-ai/dsh-session-persistence-postgres";

for (const profile of ["headless", "web"]) {
  const profileDir = resolve(dshHome, "profiles", profile);
  const require = createRequire(resolve(profileDir, "package.json"));
  require.resolve(primaryPackage);

  const result = spawnSync(process.execPath, [cli, "--profile", profile, "--dump-config"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  if (!result.stdout.includes("session-persistence-postgres")) {
    throw new Error(`${profile} profile does not compose ${primaryPackage}`);
  }
  if (!result.stdout.includes("pkg-web-search")) {
    throw new Error(`${profile} profile does not compose the PKG-backed web_search plugin`);
  }
  if (!result.stdout.includes("source-mind-map-proposal")) {
    throw new Error(`${profile} profile does not compose the Source Mind Map proposal plugin`);
  }
  if (!result.stdout.includes("QWEN_API_KEY") || !result.stdout.includes("qwen3.7-plus")) {
    throw new Error(`${profile} profile does not expose the configured Qwen provider`);
  }
  if (!result.stdout.includes("MINIMAX_API_KEY") || !result.stdout.includes("MiniMax-M3")) {
    throw new Error(`${profile} profile does not expose the configured MiniMax provider`);
  }
  if (result.stdout.includes("session-persistence-jsonl-shadow")) {
    throw new Error(`${profile} profile still composes JSONL shadow after Stage E`);
  }
}

console.log("headless and web profiles compose Qwen/MiniMax, PostgreSQL persistence, PKG web_search, and Source Mind Map proposals without JSONL shadow");
