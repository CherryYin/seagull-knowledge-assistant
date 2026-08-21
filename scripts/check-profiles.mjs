import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "dsh-harness/apps/cli/lib/bin.js");
const dshHome = resolve(root, ".dsh");
const shadowPackage = "@deepseek-ai/dsh-session-persistence-postgres-shadow";

for (const profile of ["headless", "web"]) {
  const profileDir = resolve(dshHome, "profiles", profile);
  const require = createRequire(resolve(profileDir, "package.json"));
  require.resolve(shadowPackage);

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
  if (!result.stdout.includes("session-persistence-postgres-shadow")) {
    throw new Error(`${profile} profile does not compose ${shadowPackage}`);
  }
}

console.log("headless and web profiles compose the PostgreSQL shadow backend");
