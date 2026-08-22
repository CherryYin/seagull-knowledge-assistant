import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("login cookie authenticates direct API requests and preserves query params", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  class MockWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static sockets = [];
    static urls = [];

    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = MockWebSocket.CONNECTING;
      MockWebSocket.sockets.push(this);
      MockWebSocket.urls.push(this.url);
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    push(payload) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = MockWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const pkgReceived = [];
  const ownedChatSessions = new Set(["session-1", "local-session"]);
  const pkg = http.createServer((req, res) => {
    pkgReceived.push({ url: req.url, authorization: req.headers.authorization, requestId: req.headers["x-request-id"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/login") {
      res.end(JSON.stringify({ access_token: "test-token" }));
      return;
    }
    if (req.url === "/auth/me" && req.headers.authorization === "Bearer test-token") {
      res.end(JSON.stringify({ id: "user-1", username: "admin" }));
      return;
    }
    if (req.url === "/chat-sessions?limit=200&offset=0") {
      res.end(JSON.stringify({
        items: [...ownedChatSessions].map((id) => ({ id, user_id: "user-1", title: id, messages: [] })),
        total: ownedChatSessions.size,
      }));
      return;
    }
    if (req.url === "/chat-sessions" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        ownedChatSessions.add(body.id);
        res.writeHead(201);
        res.end(JSON.stringify({ id: body.id, user_id: "user-1", title: "New Session", messages: [] }));
      });
      return;
    }
    if (req.url?.startsWith("/chat-sessions/") && req.method === "DELETE") {
      const id = req.url.slice("/chat-sessions/".length);
      if (!ownedChatSessions.delete(id)) {
        res.writeHead(404);
        res.end(JSON.stringify({ detail: "Session not found" }));
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (req.url?.startsWith("/chat-sessions/") && req.method === "GET" && ownedChatSessions.has(req.url.slice("/chat-sessions/".length))) {
      const id = req.url.slice("/chat-sessions/".length);
      res.end(JSON.stringify({ id, user_id: "user-1", title: id, messages: [] }));
      return;
    }
    if (req.url?.startsWith("/chat-sessions/")) {
      res.writeHead(404);
      res.end(JSON.stringify({ detail: "Session not found" }));
      return;
    }
    if (req.url === "/memory?status=pending_review&limit=5") {
      res.end(JSON.stringify({ items: [], total: 0 }));
      return;
    }
    if (req.url === "/action/stream" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end("event: content\ndata: {\"text\":\"hello\"}\n\n");
      return;
    }
    if (req.url === "/knowledge/dashboard") {
      res.end(JSON.stringify({ counts: { notes: 1 } }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await listen(pkg);
  t.after(() => close(pkg));

  const harnessReceived = [];
  const harnessRpcCalls = [];
  const harnessSessions = new Set();
  let chatSessionId = "session-chat";
  const harness = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    harnessReceived.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      requestId: req.headers["x-request-id"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (req.url === "/api/experiments" && req.method === "POST") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "experiment-1" }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/api/")) {
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      harnessRpcCalls.push(envelope);
      const reply = (value) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          type: "server-response",
          rpcId: envelope.rpcId,
          result: { ok: true, value },
        }));
      };
      const reject = (error) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          type: "server-response",
          rpcId: envelope.rpcId,
          result: { ok: false, error },
        }));
      };
      if (envelope.method === "session.list") {
        reply({ items: [
          {
            sessionId: "session-1",
            updatedAt: 1_787_000_000_000,
            running: false,
            blank: false,
            agentPreset: "research-topic",
            projections: { values: { title: { title: "Research session" } } },
          },
          {
            sessionId: "foreign-session",
            updatedAt: 1_787_000_001_000,
            running: false,
            blank: false,
            agentPreset: "knowledge-lab",
            projections: { values: { title: { title: "Foreign session" } } },
          },
        ] });
        return;
      }
      if (envelope.method === "session.history") {
        reply({ events: [], hasMore: false });
        return;
      }
      if (envelope.method === "agentPreset.list") {
        reply({
          presets: [{
            id: "research-topic",
            trust: "user",
            isDefault: false,
            name: "研究一个主题",
            description: "Research with existing knowledge first.",
          }],
          authorable: true,
          hasDocument: true,
        });
        return;
      }
      if (envelope.method === "session.create") {
        chatSessionId = envelope.payload.sessionId || chatSessionId;
        harnessSessions.add(chatSessionId);
        reply({ sessionId: chatSessionId, agentPreset: envelope.payload.agentPreset });
        return;
      }
      if (envelope.method === "session.prompt") {
        if (!harnessSessions.has(envelope.payload.sessionId)) {
          reject({
            code: "session-not-found",
            message: `session "${envelope.payload.sessionId}" not found`,
            details: { sessionId: envelope.payload.sessionId },
          });
          return;
        }
        reply({ accepted: true });
        const stream = MockWebSocket.sockets.shift();
        setTimeout(() => {
          const push = (payload) => stream.push({
            type: "server-request",
            rpcId: `push-${payload.event?.seq ?? payload.type}`,
            method: payload.type,
            payload,
          });
          push({
            type: "session/event",
            sessionId: chatSessionId,
            event: {
              type: "assistant/chunk",
              seq: 1,
              time: Date.now(),
              data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hello" } },
            },
          });
          push({
            type: "session/event",
            sessionId: chatSessionId,
            event: {
              type: "tool/call",
              seq: 2,
              time: Date.now(),
              data: { turn: 1, step: 1, callId: "call-1", name: "pkg_search", arguments: "{\"query\":\"test\"}" },
            },
          });
          push({
            type: "session/event",
            sessionId: chatSessionId,
            event: {
              type: "turn/end",
              seq: 3,
              time: Date.now(),
              data: { turn: 1, reason: { kind: "completed" } },
            },
          });
          stream.close();
        }, 10);
        return;
      }
      if (envelope.method === "session.cancel") {
        reply({ accepted: true });
        return;
      }
    }
    res.writeHead(404).end();
  });
  await listen(harness);
  t.after(() => close(harness));

  process.env.PKG_API_URL = `http://127.0.0.1:${pkg.address().port}`;
  process.env.HARNESS_API_URL = `http://127.0.0.1:${harness.address().port}`;
  const memoryDirectory = await mkdtemp(join(tmpdir(), "bff-agent-memory-"));
  process.env.AGENT_MEMORY_STORE_PATH = join(memoryDirectory, "store.json");
  t.after(() => rm(memoryDirectory, { recursive: true, force: true }));
  const { createBffServer } = await import(`../src/index.js?test=${Date.now()}`);
  const bff = createBffServer();
  await listen(bff);
  t.after(() => close(bff));
  const base = `http://127.0.0.1:${bff.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": "login-request" },
    body: JSON.stringify({ username: "admin", password: "secret" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /^seagull_access_token=test-token;/);

  const memory = await fetch(`${base}/api/memory?status=pending_review&limit=5`, {
    headers: { Cookie: cookie, "X-Request-Id": "memory-request" },
  });
  assert.equal(memory.status, 200);
  assert.deepEqual(await memory.json(), { items: [], total: 0 });
  assert.deepEqual(pkgReceived[1], {
    url: "/memory?status=pending_review&limit=5",
    authorization: "Bearer test-token",
    requestId: "memory-request",
  });

  const action = await fetch(`${base}/api/action/stream`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-Request-Id": "action-request" },
    body: JSON.stringify({ task: "hello" }),
  });
  assert.equal(action.status, 200);
  assert.equal(action.headers.get("content-type"), "text/event-stream");
  assert.equal(await action.text(), "event: content\ndata: {\"text\":\"hello\"}\n\n");
  assert.deepEqual(pkgReceived[2], {
    url: "/action/stream",
    authorization: "Bearer test-token",
    requestId: "action-request",
  });

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const sessions = await fetch(`${base}/api/sessions?limit=5`, {
    headers: { Cookie: cookie, "X-Request-Id": "sessions-request" },
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), [{
    id: "session-1",
    title: "Research session",
    created_at: "2026-08-17T20:53:20.000Z",
    updated_at: "2026-08-17T20:53:20.000Z",
    preset: "research-topic",
    running: false,
    blank: false,
  }]);

  const foreignSession = await fetch(`${base}/api/sessions/foreign-session`, { headers: { Cookie: cookie } });
  assert.equal(foreignSession.status, 404);

  const session = await fetch(`${base}/api/sessions/session-1`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { id: "session-1", events: [], hasMore: false });

  const presets = await fetch(`${base}/api/presets`, { headers: { Cookie: cookie } });
  assert.equal(presets.status, 200);
  assert.deepEqual(await presets.json(), [{
    id: "research-topic",
    name: "研究一个主题",
    description: "Research with existing knowledge first.",
    group: "user",
    is_default: false,
  }]);

  const experiments = await fetch(`${base}/api/experiments`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test experiment" }),
  });
  assert.equal(experiments.status, 201);
  assert.deepEqual(await experiments.json(), { id: "experiment-1" });

  const proposed = await fetch(`${base}/api/harness/memory-candidates`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      proposedScopeType: "global",
      proposedKind: "preference",
      title: "Concise answers",
      content: "Prefer concise answers.",
      reason: "The user asked for concise collaboration.",
      provenance: { sessionId: "local-session", eventIds: ["event-1"], toolCallIds: [] },
    }),
  });
  assert.equal(proposed.status, 201);
  const candidate = await proposed.json();
  assert.equal(candidate.status, "pending");
  const beforeAccept = await fetch(`${base}/api/harness/memories`, { headers: { Cookie: cookie } });
  assert.deepEqual((await beforeAccept.json()).memories, []);

  const accepted = await fetch(`${base}/api/harness/memory-candidates/${candidate.id}/accept`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Keep answers concise and direct." }),
  });
  assert.equal(accepted.status, 200);
  const { memory: agentMemory } = await accepted.json();
  assert.equal(agentMemory.status, "active");
  assert.equal(agentMemory.provenance.sessionId, "local-session");

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "hello",
      preset: "research-topic",
      session_id: "local-session",
      create_session: false,
    }),
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get("content-type"), "text/event-stream");
  const chatEvents = (await chat.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
  assert.deepEqual(chatEvents.map((event) => event.type), ["session", "text", "tool_call", "done"]);
  assert.equal(chatEvents[0].session_id, "local-session");
  assert.equal(chatEvents[1].content, "hello");
  assert.deepEqual(chatEvents[2].args, { query: "test" });
  assert.match(MockWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:\d+\/api\/events\.mux$/);

  const followup = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "follow up",
      preset: "research-topic",
      session_id: "local-session",
      create_session: false,
    }),
  });
  assert.equal(followup.status, 200);
  const followupEvents = (await followup.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
  assert.deepEqual(followupEvents.map((event) => event.type), ["session", "text", "tool_call", "done"]);

  const createCalls = harnessRpcCalls.filter((call) => call.method === "session.create");
  assert.equal(createCalls.length, 1);
  const createCall = createCalls[0];
  assert.deepEqual(createCall.payload, { sessionId: "local-session", agentPreset: "research-topic" });
  const promptCalls = harnessRpcCalls.filter((call) => call.method === "session.prompt");
  assert.equal(promptCalls.length, 3);
  assert.equal(promptCalls[0].payload.sessionId, "local-session");
  assert.equal(promptCalls[0].payload.mode, "queue");
  assert.match(promptCalls[0].payload.content[0].text, /explicitly confirmed by the user/);
  assert.match(promptCalls[0].payload.content[0].text, /Keep answers concise and direct\./);
  assert.match(promptCalls[0].payload.content[0].text, /\n\nhello$/);
  assert.deepEqual(promptCalls[1].payload, promptCalls[0].payload);
  assert.match(promptCalls[2].payload.content[0].text, /\n\nfollow up$/);
  const recallAudits = await fetch(`${base}/api/harness/memory-recalls?session_id=local-session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recallAudits.status, 200);
  assert.equal((await recallAudits.json()).items.length, 2);

  const archived = await fetch(`${base}/api/harness/memories/${agentMemory.id}/archive`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).status, "archived");
  const restored = await fetch(`${base}/api/harness/memories/${agentMemory.id}/restore`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(restored.status, 200);
  const deleted = await fetch(`${base}/api/harness/memories/${agentMemory.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true, id: agentMemory.id });
  const experimentCall = harnessReceived.find((call) => call.url === "/api/experiments");
  assert.deepEqual(JSON.parse(experimentCall.body), { name: "test experiment" });

  const proxied = await fetch(`${base}/internal/pkg/knowledge/dashboard`, {
    headers: {
      "X-Harness-Session-Id": "local-session",
      "X-Harness-Service-Token": "seagull-loopback-harness",
    },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { counts: { notes: 1 } });
  const proxiedCall = pkgReceived.find((call) => call.url === "/knowledge/dashboard");
  assert.equal(proxiedCall.authorization, "Bearer test-token");

  const forbiddenProxy = await fetch(`${base}/internal/pkg/knowledge/dashboard`, {
    headers: {
      "X-Harness-Session-Id": "local-session",
      "X-Harness-Service-Token": "wrong-token",
    },
  });
  assert.equal(forbiddenProxy.status, 403);

  const cancelSession = await fetch(`${base}/api/sessions/local-session/cancel`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(cancelSession.status, 200);
  assert.deepEqual(await cancelSession.json(), { accepted: true });

  const deleteOwnedSession = await fetch(`${base}/api/sessions/local-session`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deleteOwnedSession.status, 204);
  assert.equal(ownedChatSessions.has("local-session"), false);

  const afterDelete = await fetch(`${base}/internal/pkg/knowledge/dashboard`, {
    headers: {
      "X-Harness-Session-Id": "local-session",
      "X-Harness-Service-Token": "seagull-loopback-harness",
    },
  });
  assert.equal(afterDelete.status, 401);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);

  const afterLogout = await fetch(`${base}/internal/pkg/knowledge/dashboard`, {
    headers: {
      "X-Harness-Session-Id": "local-session",
      "X-Harness-Service-Token": "seagull-loopback-harness",
    },
  });
  assert.equal(afterLogout.status, 401);
});
