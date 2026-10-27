import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HarnessClient } from "../../bff/src/harness-client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Seagull adapter composes with the real upstream web profile using isolated state and no model calls", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "seagull-remote-smoke-"));
  const authFile = join(directory, "connection.json");
  const overlay = join(directory, "smoke.patch.yml");
  const plugin = resolve(root, "deepseek-knowledge-lab/plugins/seagull-connection/src/index.js");
  await mkdir(join(directory, "workspace"));
  await writeFile(overlay, `- insert:\n    - id: seagull-connection\n      name: ${JSON.stringify(plugin)}\n      inject: [connection, webServer, sessionQuery]\n`);
  let output = "";
  const child = spawn(process.execPath, [
    resolve(root, "deepseek-knowledge-lab/dsh-harness/apps/cli/lib/bin.js"),
    "--profile", "web", "--patch", overlay, "--no-open", "--port", "0",
  ], {
    cwd: directory,
    env: { ...process.env, DSH_HOME: join(directory, "home"), HARNESS_AUTH_FILE: authFile, DO_NOT_TRACK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = bytes => { output = (output + String(bytes)).slice(-12000); };
  const diagnostic = () => output.replace(/([?&]token=)[^&\s]+/g, "$1[REDACTED]");
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = new Promise(resolveExit => child.once("exit", resolveExit));
      await Promise.race([exited, delay(8000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  let launch;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Isolated Harness failed to boot: ${diagnostic()}`);
    try { launch = JSON.parse(await readFile(authFile, "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(200);
  }
  assert.ok(launch, `Isolated Harness did not publish its connection: ${diagnostic()}`);
  const client = new HarnessClient({ baseUrl: new URL(launch.url).origin, authFile });
  const settings = await client.rpc("settings.describe");
  assert.ok(Array.isArray(settings.namespaces));
  const presets = await client.rpc("agentPreset.list");
  assert.ok(Array.isArray(presets.presets));
  const catalog = await client.rpc("llm.models");
  assert.ok(Array.isArray(catalog.groups));
  const defaultModel = settings.namespaces.find(section => section.ns === "agent-default-model");
  assert.ok(defaultModel);
  const updated = await client.rpc("settings.update", { ns: defaultModel.ns, patch: {}, expectedRevision: defaultModel.revision });
  assert.equal(updated.ns, defaultModel.ns);
  const { sessionId } = await client.rpc("session.create", { cwd: join(directory, "workspace") });
  assert.equal(typeof sessionId, "string");
  await assert.rejects(client.rpc("session.prompt", { requestId: "seagull-smoke-empty-prompt", sessionId, mode: "queue", content: [] }), error => error.code === "gateway/bad-request");
  const history = await client.rpc("session.history", { sessionId });
  assert.ok(Array.isArray(history.events));
  const events = await client.events(sessionId);
  await events.return();
  assert.equal(client.activeSessions.size, 0);
  assert.equal(child.exitCode, null);
});
