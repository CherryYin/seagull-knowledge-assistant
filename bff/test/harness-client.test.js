import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { HarnessClient, HarnessRpcError } from "../src/harness-client.js";

async function fixture(t, { rpc, stream } = {}) {
  const calls = [];
  let logins = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/?token=fixture-launch-token") {
      logins++;
      res.writeHead(303, { Location: "/", "Set-Cookie": "dsh_fixture=server-secret; HttpOnly; SameSite=Strict" });
      res.end();
      return;
    }
    if (req.headers.cookie !== "dsh_fixture=server-secret") { res.writeHead(401).end(); return; }
    if (req.url.startsWith("/api/seagull/session-cursor?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cursor: -1 }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks));
    calls.push({ url: req.url, envelope, headers: req.headers });
    const result = await rpc?.(envelope, res);
    if (res.writableEnded) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: result || { ok: true, value: { accepted: true } } }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/api/remote.mux");
    assert.equal(req.headers.cookie, "dsh_fixture=server-secret");
    sockets.handleUpgrade(req, socket, head, peer => {
      peer.on("message", bytes => {
        const frame = JSON.parse(bytes);
        if (frame.type !== "open") return;
        const send = value => peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value }));
        if (frame.endpoint === "$events") send({ type: "ready", clientId: "client-one", host: { home: "/test" } });
        if (frame.endpoint === "session/follow") send({ type: "snapshot", header: { id: frame.payload.args.request.address.sessionId }, cursor: -1, records: [], hasMore: false });
        stream?.({ frame, peer, send });
      });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "seagull-harness-client-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authFile = join(directory, "connection.json");
  await writeFile(authFile, JSON.stringify({ url: `${baseUrl}/?token=fixture-launch-token` }), { mode: 0o600 });
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client: new HarnessClient({ baseUrl, authFile }), calls, authFile, baseUrl, logins: () => logins };
}

test("Remote RPC uses slash endpoints, named args, server-only auth and request correlation", async t => {
  const { client, calls, logins } = await fixture(t);
  await client.rpc("session.create", { sessionId: "owned-session" }, { requestId: "browser-request" });
  await client.rpc("settings.update", { ns: "agent-default-model", patch: { model: "example" }, expectedRevision: 3 });
  await client.rpc("llm.models");
  await client.rpc("agentPreset.list");
  assert.deepEqual(calls.map(call => call.url), ["/api/session/create", "/api/settings/update", "/api/session/modelCatalog", "/api/agentPresets/list"]);
  assert.deepEqual(calls[0].envelope.payload, { args: { request: { sessionId: "owned-session" } } });
  assert.equal(calls[0].headers["x-request-id"], "browser-request");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[1].envelope.payload.args.expectedRevision, 3);
  assert.equal(logins(), 1);
  await assert.rejects(client.rpc("terminal.create", {}), /Unsupported/);
});

test("authentication is shared across concurrent calls and rejects unsafe runtime files", async t => {
  const { client, logins, authFile } = await fixture(t);
  await Promise.all([client.rpc("session.list"), client.rpc("settings.describe")]);
  assert.equal(logins(), 1);
  client.cookie = undefined;
  await chmod(authFile, 0o644);
  await assert.rejects(client.rpc("session.list"), /mode 0600/);
});

test("origin mismatch never sends a launch token to a different host", async t => {
  const { client, authFile, logins } = await fixture(t);
  await writeFile(authFile, JSON.stringify({ url: "http://127.0.0.1:1/?token=private" }));
  await assert.rejects(client.rpc("session.list"), /origin does not match/);
  assert.equal(logins(), 0);
});

test("401 refreshes authentication once; uncertain write failures are not retried", async t => {
  let rejected = false;
  const { client, logins, calls } = await fixture(t, { rpc(envelope, res) {
    if (!rejected) { rejected = true; res.writeHead(401).end(); return; }
    if (envelope.method === "session/prompt") res.writeHead(503).end();
  } });
  await client.rpc("session.create", { sessionId: "owned" });
  assert.equal(logins(), 2);
  await assert.rejects(client.rpc("session.prompt", { requestId: "stable-id" }), /HTTP 503/);
  assert.equal(calls.filter(call => call.envelope.method === "session/prompt").length, 1);
});

test("typed business failures preserve conflict status and do not retry", async t => {
  const { client, calls } = await fixture(t, { rpc() { return { ok: false, error: { code: "settings/conflict", message: "Configuration changed", details: { actual: 4 } } }; } });
  await assert.rejects(client.rpc("settings.update", {}), error => error instanceof HarnessRpcError && error.status === 409 && error.details.actual === 4);
  assert.equal(calls.length, 1);
});

test("session history uses a read-only cursor and page without activating a follow stream", async t => {
  const { client, calls } = await fixture(t, { rpc() { return { ok: true, value: { records: [], hasMore: false } }; } });
  assert.deepEqual(await client.rpc("session.history", { sessionId: "owned" }), { events: [], hasMore: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/session/page");
  assert.deepEqual(calls[0].envelope.payload.args.request, { address: { kind: "session", sessionId: "owned" }, throughSeq: -1 });
});

test("journal and live assistant frames retain the existing Seagull SSE contract", async t => {
  const { client } = await fixture(t, { stream({ frame, send }) {
    if (frame.endpoint !== "session/follow") return;
    send({ type: "assistant-stream", frame: { type: "start", attemptId: "attempt", turn: 2, step: 3 } });
    send({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt", index: 0, time: 1, chunk: { type: "text-delta", text: "hello" } } });
    send({ type: "event", event: { type: "turn/end", seq: 0, data: { reason: { kind: "completed" } } } });
  } });
  const events = await client.events("owned");
  const first = await events.next();
  assert.equal(first.value.payload.event.type, "assistant/chunk");
  assert.equal(first.value.payload.event.data.chunk.text, "hello");
  assert.equal(first.value.payload.event.data.turn, 2);
  const second = await events.next();
  assert.equal(second.value.payload.event.type, "turn/end");
  await events.return();
});

test("journal gaps fail closed instead of silently losing output", async t => {
  const { client } = await fixture(t, { stream({ frame, send }) {
    if (frame.endpoint === "session/follow") send({ type: "event", event: { type: "turn/end", seq: 7 } });
  } });
  const events = await client.events("owned");
  await assert.rejects(events.next(), /journal is not contiguous/);
});

test("question replies are tied to the active stream and exact session", async t => {
  const { client, calls } = await fixture(t, { stream({ frame, send }) {
    if (frame.endpoint === "$events") send({ type: "waterfall", event: "user-questions/request", agentId: "owned", eventId: "question-one", request: { questions: [{ id: "audience", question: "Who?" }] } });
  } });
  const events = await client.events("owned");
  const question = await events.next();
  assert.equal(question.value.rpcId, "question-one");
  const answer = { answers: [{ id: "audience", selected: ["Readers"] }] };
  assert.deepEqual(await client.respond({ rpcId: "question-one", result: { value: { sessionId: "foreign", answer } } }), { accepted: false, reason: "not-pending" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.respond({ rpcId: "question-one", result: { value: { sessionId: "owned", answer } } }), { accepted: true });
  assert.deepEqual(calls[0].envelope.payload.args.outcome, { kind: "result", value: answer });
  assert.deepEqual(await client.respond({ rpcId: "question-one", result: { value: { sessionId: "owned", answer } } }), { accepted: false, reason: "not-pending" });
  await events.return();
});

test("foreign waterfalls are delegated, not exposed to the current session", async t => {
  const { client, calls } = await fixture(t, { stream({ frame, send }) {
    if (frame.endpoint === "$events") send({ type: "waterfall", event: "user-questions/request", agentId: "foreign", eventId: "foreign-question", request: { questions: [] } });
    if (frame.endpoint === "session/follow") send({ type: "event", event: { type: "turn/end", seq: 0 } });
  } });
  const events = await client.events("owned");
  const event = await events.next();
  assert.equal(event.value.payload.event.type, "turn/end");
  assert.deepEqual(calls[0].envelope.payload.args.outcome, { kind: "next" });
  assert.equal(client.pendingQuestions.size, 0);
  await events.return();
});

test("closing an unread stream releases its execution reservation", async t => {
  const { client } = await fixture(t);
  const first = await client.events("owned");
  await assert.rejects(client.events("owned"), /already has an active/);
  await first.return();
  assert.equal(client.activeSessions.size, 0);
  const second = await client.events("owned");
  await second.return();
});

test("owned permission approvals are explicitly rejected, never silently approved", async t => {
  const { client, calls } = await fixture(t, { stream({ frame, send }) {
    if (frame.endpoint === "$events") send({ type: "waterfall", event: "approval/request", agentId: "owned", eventId: "approval-one", request: {} });
  } });
  const events = await client.events("owned");
  const event = await events.next();
  assert.equal(event.value.payload.type, "approval/requested");
  assert.equal(calls[0].envelope.payload.args.outcome.kind, "rejected");
  await events.return();
});

test("aborted stream setup does not retain session reservations", async t => {
  const { client } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("Cancelled by user"));
  await assert.rejects(client.events("owned", controller.signal), /Cancelled by user/);
  assert.equal(client.activeSessions.size, 0);
});
