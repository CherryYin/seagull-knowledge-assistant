import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("non-loopback BFF deployments require a strong explicit Harness service token", async () => {
  const { resolveHarnessServiceToken } = await import(`../src/index.js?token-test=${Date.now()}`);
  assert.equal(resolveHarnessServiceToken("http://127.0.0.1:4000"), "seagull-loopback-harness");
  assert.throws(
    () => resolveHarnessServiceToken("http://0.0.0.0:4000"),
    /explicit random value of at least 32 characters/,
  );
  assert.throws(
    () => resolveHarnessServiceToken("https://bff.example.test", "replace-with-a-random-service-token"),
    /explicit random value of at least 32 characters/,
  );
  assert.equal(
    resolveHarnessServiceToken("https://bff.example.test", "0123456789abcdef0123456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
});

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
  let sourceUpload;
  const ownedChatSessions = new Set(["session-1", "local-session"]);
  const ephemeralChatSessions = new Set();
  const pkg = http.createServer(async (req, res) => {
    pkgReceived.push({ url: req.url, authorization: req.headers.authorization, requestId: req.headers["x-request-id"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/login") {
      res.end(JSON.stringify({ access_token: "test-token" }));
      return;
    }
    if (req.url === "/auth/me" && ["Bearer test-token", "Bearer refreshed-token"].includes(req.headers.authorization)) {
      res.end(JSON.stringify({ id: "user-1", username: "admin", role: "admin" }));
      return;
    }
    if (req.url === "/auth/me" && req.headers.authorization === "Bearer expired-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ detail: "Could not validate credentials" }));
      return;
    }
    if (req.url === "/chat-sessions?limit=200&offset=0") {
      res.end(JSON.stringify({
        items: [...ownedChatSessions]
          .filter((id) => !ephemeralChatSessions.has(id))
          .map((id) => ({ id, user_id: "user-1", title: id, messages: [], is_ephemeral: false })),
        total: ownedChatSessions.size - ephemeralChatSessions.size,
      }));
      return;
    }
    if (req.url === "/chat-sessions" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        ownedChatSessions.add(body.id);
        if (body.is_ephemeral === true) ephemeralChatSessions.add(body.id);
        res.writeHead(201);
        res.end(JSON.stringify({
          id: body.id,
          user_id: "user-1",
          title: "New Session",
          messages: [],
          is_ephemeral: body.is_ephemeral === true,
        }));
      });
      return;
    }
    if (req.url?.startsWith("/chat-sessions/") && req.method === "DELETE") {
      const id = req.url.slice("/chat-sessions/".length);
      ephemeralChatSessions.delete(id);
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
      res.end(JSON.stringify({
        id,
        user_id: "user-1",
        title: id,
        messages: [],
        is_ephemeral: ephemeralChatSessions.has(id),
      }));
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
    if (req.url === "/notes/note-1/export/pdf") {
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0xfe, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment; filename=\"note.pdf\"",
        "Content-Length": String(pdf.length),
      });
      res.end(pdf);
      return;
    }
    if (req.url === "/notes/smoke-note" && req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/knowledge/dashboard") {
      res.end(JSON.stringify({ counts: { notes: 1 } }));
      return;
    }
    if (req.url === "/sources/upload" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      sourceUpload = {
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks),
      };
      res.writeHead(201);
      res.end(JSON.stringify({ id: "source-uploaded", title: "Uploaded PDF", source_type: "pdf" }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await listen(pkg);
  t.after(() => close(pkg));

  const harnessReceived = [];
  const harnessRpcCalls = [];
  const sessionCreateOwnershipChecks = [];
  const harnessSessions = new Set();
  let chatSessionId = "session-chat";
  let generatedSessionCount = 0;
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
    if (req.url === "/api/respond" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
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
      if (envelope.method === "llm.models") {
        reply({
          groups: [{ id: "qwen", name: "Qwen", models: [{ id: "qwen-plus", name: "Qwen Plus" }] }],
          failures: [],
        });
        return;
      }
      if (envelope.method === "settings.describe") {
        reply({
          writable: true,
          hasDocument: true,
          namespaces: [{
            ns: "agent-default-model",
            schema: {},
            value: { provider: "qwen", model: "qwen-plus" },
            applies: "live",
            secrets: [],
            revision: 3,
          }],
        });
        return;
      }
      if (envelope.method === "settings.update") {
        reply({
          ns: "agent-default-model",
          schema: {},
          value: envelope.payload.patch,
          applies: "live",
          secrets: [],
          revision: 4,
        });
        return;
      }
      if (envelope.method === "session.create") {
        sessionCreateOwnershipChecks.push(ownedChatSessions.has(envelope.payload.sessionId));
        chatSessionId = envelope.payload.sessionId || `ephemeral-session-${++generatedSessionCount}`;
        harnessSessions.add(chatSessionId);
        reply({ sessionId: chatSessionId, agentPreset: envelope.payload.agentPreset });
        return;
      }
      if (envelope.method === "session.selectModel") {
        if (!harnessSessions.has(envelope.payload.sessionId)) {
          reject({
            code: "session-not-found",
            message: `session "${envelope.payload.sessionId}" not found`,
            details: { sessionId: envelope.payload.sessionId },
          });
          return;
        }
        reply({ selected: {
          provider: envelope.payload.provider,
          model: envelope.payload.model,
        } });
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
        const promptText = envelope.payload.content?.[0]?.text || "";
        if (promptText.endsWith("delayed receipt")) {
          setTimeout(() => reply({ accepted: true }), 250);
        } else {
          reply({ accepted: true });
        }
        const stream = MockWebSocket.sockets.shift();
        setTimeout(() => {
          const push = (payload) => stream.push({
            type: "server-request",
            rpcId: `push-${payload.event?.seq ?? payload.type}`,
            method: payload.type,
            payload,
          });
          if (promptText.endsWith("clarify")) {
            push({
              type: "question/requested",
              sessionId: chatSessionId,
              questions: [{
                id: "audience",
                question: "Who should this Asset help?",
                header: "Audience",
                options: [{ label: "Architecture reviewers", description: "Decision-focused readers." }],
                multiSelect: false,
              }],
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
            return;
          }
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
              type: "tool/result",
              seq: 3,
              time: Date.now(),
              data: {
                turn: 1,
                step: 1,
                message: {
                  source: { kind: "tool", callId: "call-1" },
                  content: [{ type: "tool-result", content: [{ type: "text", text: "search complete" }] }],
                },
              },
            },
          });
          push({
            type: "session/event",
            sessionId: chatSessionId,
            event: {
              type: "turn/end",
              seq: 4,
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
  process.env.SESSION_CONTEXT_STORE_PATH = join(memoryDirectory, "session-contexts.json");
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

  const uploadForm = new FormData();
  uploadForm.append("file", new Blob(["%PDF-1.7\nmock-pdf"], { type: "application/pdf" }), "upload.pdf");
  uploadForm.append("title", "Uploaded PDF");
  uploadForm.append("source_type", "pdf");
  uploadForm.append("category_id", "1");
  uploadForm.append("pdf_type", "text");
  const uploadedSource = await fetch(`${base}/api/sources/upload`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: uploadForm,
  });
  assert.equal(uploadedSource.status, 201);
  assert.equal((await uploadedSource.json()).id, "source-uploaded");
  assert.match(sourceUpload.contentType, /^multipart\/form-data; boundary=/);
  assert.equal(sourceUpload.authorization, "Bearer test-token");
  const uploadBody = sourceUpload.body.toString("utf8");
  assert.match(uploadBody, /filename="upload.pdf"/);
  assert.match(uploadBody, /%PDF-1\.7/);
  assert.match(uploadBody, /name="pdf_type"/);
  assert.match(uploadBody, /\r\ntext\r\n/);

  const exportedPdf = await fetch(`${base}/api/notes/note-1/export/pdf`, { headers: { Cookie: cookie } });
  assert.equal(exportedPdf.status, 200);
  assert.equal(exportedPdf.headers.get("content-type"), "application/pdf");
  assert.equal(exportedPdf.headers.get("content-disposition"), "attachment; filename=\"note.pdf\"");
  assert.deepEqual(
    Buffer.from(await exportedPdf.arrayBuffer()),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0xfe, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]),
  );

  const deletedNote = await fetch(`${base}/api/notes/smoke-note`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deletedNote.status, 204);
  assert.equal(await deletedNote.text(), "");

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const expired = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: "Bearer expired-token" },
  });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.deepEqual(await expired.json(), {
    error: "PKG authentication expired",
    code: "PKG_AUTH_EXPIRED",
    reauth_required: true,
  });

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

  const generationContext = {
    kind: "asset_generation",
    assetDraft: {
      assetType: "research_brief",
      title: "Durable BFF brief",
      brief: "Keep the manual generation request with the Harness Session.",
      audience: "Architecture reviewers",
      styleNotes: "Concise.",
      sourceRefs: ["source-1"],
      noteRefs: [],
      wikiRefs: [],
    },
  };
  const savedContext = await fetch(`${base}/api/harness/session-contexts/session-1`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(generationContext),
  });
  assert.equal(savedContext.status, 200);
  assert.equal((await savedContext.json()).context.assetDraft.title, "Durable BFF brief");

  const restoredContext = await fetch(`${base}/api/harness/session-contexts/session-1`, { headers: { Cookie: cookie } });
  assert.equal(restoredContext.status, 200);
  assert.deepEqual((await restoredContext.json()).context.assetDraft.sourceRefs, ["source-1"]);

  const questionAnswer = await fetch(`${base}/api/harness/questions/respond`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      rpc_id: "question-rpc-1",
      session_id: "session-1",
      answers: [{ id: "audience", selected: ["Architecture reviewers"] }],
    }),
  });
  assert.equal(questionAnswer.status, 200);
  assert.deepEqual(await questionAnswer.json(), { accepted: true });
  const respondRequest = harnessReceived.find((request) => request.url === "/api/respond");
  assert.deepEqual(JSON.parse(respondRequest.body), {
    type: "client-response",
    rpcId: "question-rpc-1",
    result: {
      ok: true,
      value: {
        sessionId: "session-1",
        answer: { answers: [{ id: "audience", selected: ["Architecture reviewers"] }] },
      },
    },
  });

  const foreignContext = await fetch(`${base}/api/harness/session-contexts/foreign-session`, { headers: { Cookie: cookie } });
  assert.equal(foreignContext.status, 404);

  const presets = await fetch(`${base}/api/presets`, { headers: { Cookie: cookie } });
  assert.equal(presets.status, 200);
  assert.deepEqual(await presets.json(), [{
    id: "research-topic",
    name: "研究一个主题",
    description: "Research with existing knowledge first.",
    group: "user",
    is_default: false,
  }]);

  const harnessModels = await fetch(`${base}/api/harness/models`, { headers: { Cookie: cookie } });
  assert.equal(harnessModels.status, 200);
  assert.deepEqual(await harnessModels.json(), {
    models: [{
      id: "qwen-plus",
      name: "Qwen Plus",
      provider: "qwen",
      provider_name: "Qwen",
      reasoning: null,
    }],
    failures: [],
  });

  const modelSettings = await fetch(`${base}/api/harness/model-settings`, { headers: { Cookie: cookie } });
  assert.equal(modelSettings.status, 200);
  assert.deepEqual(await modelSettings.json(), {
    writable: true,
    provider: "qwen",
    model: "qwen-plus",
    reasoning_effort: null,
    revision: 3,
  });

  const updatedModelSettings = await fetch(`${base}/api/harness/model-settings`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "qwen", model: "qwen-plus", revision: 3 }),
  });
  assert.equal(updatedModelSettings.status, 200);
  assert.equal((await updatedModelSettings.json()).revision, 4);

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
      model: "qwen:qwen-plus",
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
  assert.deepEqual(chatEvents.map((event) => event.type), ["session", "text", "tool_call", "tool_result", "done"]);
  assert.equal(chatEvents[0].session_id, "local-session");
  assert.equal(chatEvents[1].content, "hello");
  assert.deepEqual(chatEvents[2].args, { query: "test" });
  assert.equal(chatEvents[3].tool, "pkg_search");
  assert.equal(chatEvents[3].result, "search complete");
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
  assert.deepEqual(followupEvents.map((event) => event.type), ["session", "text", "tool_call", "tool_result", "done"]);

  const clarification = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "clarify",
      preset: "draft-asset",
      session_id: "local-session",
      create_session: false,
    }),
  });
  assert.equal(clarification.status, 200);
  const clarificationEvents = (await clarification.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
  assert.deepEqual(clarificationEvents.map((event) => event.type), ["session", "question", "done"]);
  assert.equal(clarificationEvents[1].rpc_id, "push-question/requested");
  assert.equal(clarificationEvents[1].questions[0].id, "audience");

  const createCalls = harnessRpcCalls.filter((call) => call.method === "session.create");
  assert.equal(createCalls.length, 1);
  const createCall = createCalls[0];
  assert.deepEqual(createCall.payload, { sessionId: "local-session", agentPreset: "research-topic" });
  const modelCalls = harnessRpcCalls.filter((call) => call.method === "session.selectModel");
  assert.equal(modelCalls.length, 2);
  assert.deepEqual(modelCalls[1].payload, { sessionId: "local-session", provider: "qwen", model: "qwen-plus" });
  const promptCalls = harnessRpcCalls.filter((call) => call.method === "session.prompt");
  assert.equal(promptCalls.length, 3);
  assert.equal(promptCalls[0].payload.sessionId, "local-session");
  assert.equal(promptCalls[0].payload.mode, "queue");
  assert.match(promptCalls[0].payload.content[0].text, /explicitly confirmed by the user/);
  assert.match(promptCalls[0].payload.content[0].text, /Keep answers concise and direct\./);
  assert.match(promptCalls[0].payload.content[0].text, /\n\nhello$/);
  assert.match(promptCalls[1].payload.content[0].text, /\n\nfollow up$/);
  assert.match(promptCalls[2].payload.content[0].text, /\n\nclarify$/);
  const recallAudits = await fetch(`${base}/api/harness/memory-recalls?session_id=local-session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recallAudits.status, 200);
  assert.equal((await recallAudits.json()).items.length, 3);

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

  const reboundChat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Authorization: "Bearer refreshed-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "continue after login",
      preset: "research-topic",
      session_id: "local-session",
      create_session: false,
    }),
  });
  assert.equal(reboundChat.status, 200);
  await reboundChat.text();

  const proxied = await fetch(`${base}/internal/pkg/knowledge/dashboard`, {
    headers: {
      "X-Harness-Session-Id": "local-session",
      "X-Harness-Service-Token": "seagull-loopback-harness",
    },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { counts: { notes: 1 } });
  const proxiedCalls = pkgReceived.filter((call) => call.url === "/knowledge/dashboard");
  assert.equal(proxiedCalls.at(-1).authorization, "Bearer refreshed-token");

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

  const delayedReceiptChat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "delayed receipt",
      preset: "generate-source-mind-map",
      ephemeral_session: true,
    }),
  });
  assert.equal(delayedReceiptChat.status, 200);
  const delayedReader = delayedReceiptChat.body.getReader();
  const firstFrame = await Promise.race([
    delayedReader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("session event waited for prompt receipt")), 100)),
  ]);
  assert.match(new TextDecoder().decode(firstFrame.value), /"type":"session"/);
  await delayedReader.cancel();

  const ephemeralChat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "clarify",
      preset: "distill-asset-knowledge",
      create_session: true,
      ephemeral_session: true,
    }),
  });
  assert.equal(ephemeralChat.status, 200);
  const ephemeralEvents = (await ephemeralChat.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
  assert.deepEqual(ephemeralEvents.map((event) => event.type), ["session", "question", "done"]);
  const ephemeralSessionId = ephemeralEvents[0].session_id;
  assert.match(ephemeralSessionId, /^session-[0-9a-f-]{36}$/);
  assert.equal(ownedChatSessions.has(ephemeralSessionId), true);
  assert.equal(ephemeralChatSessions.has(ephemeralSessionId), true);
  assert.equal(sessionCreateOwnershipChecks.at(-1), true);

  const visibleSessions = await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } });
  assert.equal(visibleSessions.status, 200);
  assert.equal((await visibleSessions.json()).some((item) => item.id === ephemeralSessionId), false);

  const ephemeralAnswer = await fetch(`${base}/api/harness/questions/respond`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      rpc_id: ephemeralEvents[1].rpc_id,
      session_id: ephemeralSessionId,
      answers: [{ question_id: "audience", option_labels: ["Architecture reviewers"] }],
    }),
  });
  assert.equal(ephemeralAnswer.status, 200);

  const invalidEphemeralReuse = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "do not reuse",
      preset: "knowledge-lab",
      session_id: ephemeralSessionId,
      create_session: true,
      ephemeral_session: true,
    }),
  });
  assert.equal(invalidEphemeralReuse.status, 400);

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
