import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Harness2Lab } from "../../deepseek-knowledge-lab/experiments/harness2-newsletter/lab_gateway.js";

test("Harness2 adapter strips production credentials and persists offline records across instances", async context => {
  const directory = await mkdtemp(join(tmpdir(), "seagull-h2-gateway-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new Harness2Lab({ directory });
  const environment = lab.environment();
  for (const name of ["DEEPSEEK_API_KEY", "PKG_DATABASE_URL", "HARNESS_SERVICE_TOKEN", "NODE_OPTIONS", "PYTHONPATH", "HTTPS_PROXY"]) {
    assert.equal(environment[name], undefined);
  }
  const experiment = await lab.call("create", "first-owner");
  assert.equal(experiment.status, "prepared");
  assert.equal(experiment.attempts, 0);
  assert.equal(experiment.spent_estimate_cny, "0");
  assert.equal(experiment.cases.find(item => item.split === "holdout").material, null);
  const restarted = new Harness2Lab({ directory });
  assert.equal((await restarted.call("list", "first-owner")).items[0].id, experiment.id);
  assert.deepEqual((await restarted.call("list", "second-owner")).items, []);
  await assert.rejects(restarted.call("get", "second-owner", { id: experiment.id }), error => error.status === 404);
  const plan = await lab.call("preflight", "first-owner", { id: experiment.id, phase: "train", budget_cny: "2" });
  assert.equal(plan.ready, false);
  assert.equal(plan.network_requests_sent, 0);
  assert.equal(plan.preflight_id, null);
  assert.ok(plan.blockers.length);
  assert.ok((await readFile(join(directory, "lab.sqlite3"))).length > 0);
});

test("Harness2 Gateway verifies identity, prevents forged ownership, protects paid starts and saves notes idempotently", async context => {
  const notes = new Map();
  const upstream = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const token = request.headers.authorization;
    if (request.url === "/auth/me") {
      if (!token) { response.writeHead(401); return response.end("{}"); }
      return response.end(JSON.stringify({ id: token === "Bearer member" ? "member" : "owner", role: token === "Bearer member" ? "user" : "admin" }));
    }
    if (request.url.startsWith("/notes/")) {
      const note = notes.get(decodeURIComponent(request.url.slice(7)));
      response.writeHead(note ? 200 : 404);
      return response.end(JSON.stringify(note || {}));
    }
    if (request.url === "/notes" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const note = JSON.parse(body);
      notes.set(note.id, note);
      return response.end(JSON.stringify(note));
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => upstream.close(resolve)));
  const previous = process.env.PKG_API_URL;
  process.env.PKG_API_URL = `http://127.0.0.1:${upstream.address().port}`;
  context.after(() => { if (previous === undefined) delete process.env.PKG_API_URL; else process.env.PKG_API_URL = previous; });
  const calls = [];
  const identifier = "a".repeat(32);
  const harness2Lab = {
    async call(action, owner, body) {
      calls.push({ action, owner, body });
      if (owner !== "owner") throw Object.assign(new Error("实验不存在"), { status: 404 });
      if (action === "report") return { id: "note-h2-test", title: "实验报告", content: "未运行的独立实验" };
      return action === "list" ? { items: [] } : { id: identifier, status: "prepared" };
    },
    async start(owner, body) { calls.push({ action: "start", owner, body }); return { id: identifier, status: "train_running" }; },
  };
  const { createBffServer } = await import(`../src/index.js?harness2=${Date.now()}`);
  const gateway = createBffServer({ harness2Lab });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}/api/lab/harness2`;
  const headers = { Authorization: "Bearer owner", "Content-Type": "application/json" };
  assert.equal((await fetch(base)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await fetch(base, { method: "POST", headers, body: "{}" })).status, 201);
  const preflight = await fetch(`${base}/${identifier}/preflight`, { method: "POST", headers, body: JSON.stringify({ id: "b".repeat(32), owner: "forged-owner", phase: "train", budget_cny: "2" }) });
  assert.equal(preflight.status, 200);
  assert.equal(calls.at(-1).owner, "owner");
  assert.equal(calls.at(-1).body.id, identifier);
  assert.equal((await fetch(`${base}/${identifier}`, { headers: { Authorization: "Bearer member" } })).status, 404);
  assert.equal((await fetch(`${base}/${identifier}/start`, { method: "POST", headers: { ...headers, Authorization: "Bearer member" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/${identifier}/start`, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(base, { method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "text/plain" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/${identifier}/start`, { method: "POST", headers, body: JSON.stringify({ preflight_id: "token", confirm_send_synthetic: true }) })).status, 202);
  assert.equal(calls.at(-1).action, "start");
  assert.equal((await fetch(`${base}/${identifier}/preflight`, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(`${base}/${identifier}/preflight`, { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(17000) }) })).status, 413);
  for (let iteration = 0; iteration < 2; iteration++) {
    const saved = await fetch(`${base}/${identifier}/note`, { method: "POST", headers, body: "{}" });
    assert.equal(saved.status, iteration === 0 ? 201 : 200);
    assert.deepEqual(await saved.json(), { note_id: "note-h2-test" });
  }
  assert.equal(notes.size, 1);
  assert.equal(notes.get("note-h2-test").content, "未运行的独立实验");
  notes.get("note-h2-test").content = "用户自行编辑";
  assert.equal((await fetch(`${base}/${identifier}/note`, { method: "POST", headers, body: "{}" })).status, 409);
});
