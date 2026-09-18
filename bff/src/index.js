// Seagull BFF (Backend For Frontend)
// v2 — clean rewrite with proper auth passthrough

import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  AgentMemoryStore,
  PostgresAgentMemoryBackend,
  defaultAgentMemoryStorePath,
  formatAgentMemoryContext,
} from "../../deepseek-knowledge-lab/plugins/agent-memory/src/index.js";
import {
  PostgresSessionContextBackend,
  SessionContextStore,
  defaultSessionContextStorePath,
} from "../../deepseek-knowledge-lab/plugins/session-context/src/index.js";

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "127.0.0.1";
const PKG_BASE = process.env.PKG_API_URL || "http://127.0.0.1:8000";
const HARNESS_BASE = process.env.HARNESS_API_URL || "http://127.0.0.1:3080";
const UI_ORIGINS = new Set(
  (process.env.UI_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const AUTH_COOKIE = "seagull_access_token";
const HARNESS_ROUTES = ["/api/experiments", "/api/lab"];
const LOOPBACK_SERVICE_TOKEN = "seagull-loopback-harness";
const INSECURE_SERVICE_TOKENS = new Set([LOOPBACK_SERVICE_TOKEN, "replace-with-a-random-service-token"]);

export function resolveHarnessServiceToken(endpoint, configuredToken = process.env.HARNESS_SERVICE_TOKEN) {
  const hostname = new URL(endpoint).hostname;
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  const token = configuredToken || (loopback ? LOOPBACK_SERVICE_TOKEN : "");
  if (!loopback && (!token || token.length < 32 || INSECURE_SERVICE_TOKENS.has(token))) {
    throw new Error("HARNESS_SERVICE_TOKEN must be an explicit random value of at least 32 characters for non-loopback deployment");
  }
  return token;
}

const HARNESS_SERVICE_TOKEN = resolveHarnessServiceToken(`http://${HOST}`);
const SESSION_AUTH_TTL_MS = Number(process.env.SESSION_AUTH_TTL_MS || 28_800_000);
const sessionAuthRegistry = new Map();
const agentMemoryDatabaseUrl = process.env.AGENT_MEMORY_DATABASE_URL || process.env.PKG_DATABASE_URL;
const defaultAgentMemoryStore = process.env.AGENT_MEMORY_STORE_PATH || !agentMemoryDatabaseUrl
  ? new AgentMemoryStore({ path: process.env.AGENT_MEMORY_STORE_PATH || defaultAgentMemoryStorePath() })
  : new AgentMemoryStore({
      backend: new PostgresAgentMemoryBackend({
        connectionString: agentMemoryDatabaseUrl,
        schema: process.env.AGENT_MEMORY_DATABASE_SCHEMA || "public",
      }),
    });
const sessionContextDatabaseUrl = process.env.SESSION_CONTEXT_DATABASE_URL
  || process.env.AGENT_MEMORY_DATABASE_URL
  || process.env.PKG_DATABASE_URL;
const defaultSessionContextStore = process.env.SESSION_CONTEXT_STORE_PATH || !sessionContextDatabaseUrl
  ? new SessionContextStore({ path: process.env.SESSION_CONTEXT_STORE_PATH || defaultSessionContextStorePath() })
  : new SessionContextStore({
      backend: new PostgresSessionContextBackend({
        connectionString: sessionContextDatabaseUrl,
        schema: process.env.SESSION_CONTEXT_DATABASE_SCHEMA || "public",
      }),
    });

let counter = 0;
function rid() { return `req-${Date.now()}-${++counter}`; }
function rpcId() { return `bff-rpc-${Date.now()}-${++counter}`; }

class HarnessRpcError extends Error {
  constructor(method, error) {
    super(error?.message || `Harness RPC ${method} failed`);
    this.name = "HarnessRpcError";
    this.code = error?.code;
    this.details = error?.details;
  }
}

function setCORS(req, res) {
  const origin = req.headers.origin;
  if (origin && UI_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
}

function json(req, res, status, body) {
  setCORS(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        const key = separator === -1 ? part : part.slice(0, separator);
        const value = separator === -1 ? "" : part.slice(separator + 1);
        return [key, decodeURIComponent(value)];
      }),
  );
}

function authHeader(req) {
  if (req.headers.authorization) return req.headers.authorization;
  const token = parseCookies(req)[AUTH_COOKIE];
  return token ? `Bearer ${token}` : undefined;
}

function setAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=28800`,
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0`,
  );
}

function sessionAuth(sessionId) {
  const binding = sessionAuthRegistry.get(sessionId);
  if (!binding) return undefined;
  if (binding.expiresAt <= Date.now()) {
    sessionAuthRegistry.delete(sessionId);
    return undefined;
  }
  return binding;
}

function bindSessionAuth(sessionId, userId, authorization) {
  const existing = sessionAuth(sessionId);
  if (existing && existing.userId !== userId) {
    const error = new Error(`session "${sessionId}" belongs to another user`);
    error.status = 403;
    throw error;
  }
  sessionAuthRegistry.set(sessionId, {
    userId,
    authorization,
    expiresAt: Date.now() + SESSION_AUTH_TTL_MS,
  });
}

function clearSessionAuth(authorization) {
  for (const [sessionId, binding] of sessionAuthRegistry) {
    if (binding.authorization === authorization) sessionAuthRegistry.delete(sessionId);
  }
}

function respondAuthExpired(req, res, authorization) {
  if (authorization) clearSessionAuth(authorization);
  clearAuthCookie(res);
  return json(req, res, 401, {
    error: "PKG authentication expired",
    code: "PKG_AUTH_EXPIRED",
    reauth_required: true,
  });
}

async function currentPkgUser(authorization, requestId) {
  const response = await fetch(`${PKG_BASE}/auth/me`, {
    headers: {
      Authorization: authorization,
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "PKG authentication expired" : "Unable to verify PKG user");
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  const user = await response.json();
  if (typeof user?.id !== "string" || !user.id) {
    const error = new Error("PKG /auth/me returned an invalid user");
    error.status = 502;
    throw error;
  }
  return user;
}

async function pkgUserRequest(path, authorization, { method = "GET", body, requestId } = {}) {
  return fetch(`${PKG_BASE}${path}`, {
    method,
    headers: {
      Authorization: authorization,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function ensurePkgChatSession(sessionId, authorization, {
  createIfMissing = false,
  isEphemeral = false,
  requestId,
} = {}) {
  const encodedId = encodeURIComponent(sessionId);
  const existing = await pkgUserRequest(`/chat-sessions/${encodedId}`, authorization, { requestId });
  if (existing.ok) return existing.json();
  if (existing.status === 401) throw statusError(401, "PKG authentication expired");
  if (existing.status !== 404) throw statusError(502, "Unable to verify PKG chat session ownership");
  if (!createIfMissing) throw statusError(404, `Session "${sessionId}" not found`);

  const created = await pkgUserRequest("/chat-sessions", authorization, {
    method: "POST",
    body: { id: sessionId, is_ephemeral: isEphemeral },
    requestId,
  });
  if (created.ok) return created.json();
  if (created.status === 401) throw statusError(401, "PKG authentication expired");
  throw statusError(403, `Session "${sessionId}" is not available to the current user`);
}

async function listPkgChatSessionIds(authorization, requestId) {
  const response = await pkgUserRequest("/chat-sessions?limit=200&offset=0", authorization, { requestId });
  if (!response.ok) {
    if (response.status === 401) throw statusError(401, "PKG authentication expired");
    throw statusError(502, "Unable to list PKG chat sessions");
  }
  const value = await response.json();
  return new Set((value.items || []).map((item) => item.id).filter((id) => typeof id === "string"));
}

async function deletePkgChatSession(sessionId, authorization, requestId) {
  const response = await pkgUserRequest(`/chat-sessions/${encodeURIComponent(sessionId)}`, authorization, {
    method: "DELETE",
    requestId,
  });
  if (response.status === 204) return;
  if (response.status === 401) throw statusError(401, "PKG authentication expired");
  if (response.status === 404) throw statusError(404, `Session "${sessionId}" not found`);
  throw statusError(502, "Unable to delete PKG chat session");
}

// ── Forward to PKG ─────────────────────────────────

async function pkgForward(req, res, pkgPath, { captureLogin = false, requestId } = {}) {
  const url = `${PKG_BASE}${pkgPath}`;
  const headers = {};
  const authorization = authHeader(req);
  if (authorization) headers.Authorization = authorization;
  if (requestId) headers["X-Request-Id"] = requestId;

  const method = req.method;
  let body;
  if (method !== "GET" && method !== "HEAD") {
    body = await readRawBody(req);
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  }

  console.log(`  → PKG ${method} ${pkgPath}${body?.length ? " (has body)" : ""}`);

  try {
    const pkgRes = await fetch(url, { method, headers, body: body?.length ? body : undefined });
    if (pkgRes.status === 401 && authorization && !captureLogin) {
      return respondAuthExpired(req, res, authorization);
    }
    if (pkgRes.status === 204 || pkgRes.status === 205) {
      setCORS(req, res);
      res.writeHead(pkgRes.status);
      return res.end();
    }
    const ct = pkgRes.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await pkgRes.json();
      if (captureLogin && pkgRes.ok && data?.access_token) setAuthCookie(res, data.access_token);
      return json(req, res, pkgRes.status, data);
    }
    const data = Buffer.from(await pkgRes.arrayBuffer());
    setCORS(req, res);
    for (const name of ["content-type", "cache-control", "content-disposition", "content-length"]) {
      const value = pkgRes.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.writeHead(pkgRes.status);
    res.end(data);
  } catch (err) {
    json(req, res, 502, { error: "PKG unreachable: " + err.message });
  }
}

async function pkgSessionForward(req, res, path, search, requestId) {
  if (!HARNESS_SERVICE_TOKEN) return json(req, res, 503, { error: "Harness service token is not configured" });
  if (req.headers["x-harness-service-token"] !== HARNESS_SERVICE_TOKEN) {
    return json(req, res, 403, { error: "Forbidden" });
  }
  const sessionId = req.headers["x-harness-session-id"];
  if (typeof sessionId !== "string" || !sessionId) {
    return json(req, res, 400, { error: "X-Harness-Session-Id is required" });
  }
  const binding = sessionAuth(sessionId);
  if (!binding) return json(req, res, 401, { error: "No active PKG authentication for this Harness session" });

  const pkgPath = path.slice("/internal/pkg".length) || "/";
  if (pkgPath === "/auth" || pkgPath.startsWith("/auth/")) {
    return json(req, res, 403, { error: "PKG auth routes are not available through the Harness proxy" });
  }
  const body = req.method !== "GET" && req.method !== "HEAD" ? await readRawBody(req) : undefined;
  console.log(`  → PKG ${req.method} ${pkgPath} (Harness session ${sessionId})`);
  try {
    const upstream = await fetch(`${PKG_BASE}${pkgPath}${search}`, {
      method: req.method,
      headers: {
        Authorization: binding.authorization,
        "Content-Type": req.headers["content-type"] || "application/json",
        ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: body?.length ? body : undefined,
    });
    if (upstream.status === 401) sessionAuthRegistry.delete(sessionId);
    const headers = {};
    for (const name of ["content-type", "cache-control", "content-disposition"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    json(req, res, 502, { error: `PKG unreachable: ${error.message}` });
  }
}

// ── Forward to Harness ────────────────────────────

async function streamForward(req, res, baseUrl, upstreamPath, requestId, label) {
  const url = `${baseUrl}${upstreamPath}`;
  const body = req.method !== "GET" && req.method !== "HEAD" ? await readRawBody(req) : undefined;
  const authorization = authHeader(req);
  console.log(`  → ${label} ${req.method} ${upstreamPath}`);

  try {
    const hRes = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: body || undefined,
    });

    setCORS(req, res);
    const responseHeaders = {};
    for (const name of ["content-type", "cache-control", "content-disposition"]) {
      const value = hRes.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(hRes.status, responseHeaders);

    const reader = hRes.body?.getReader();
    if (!reader) { res.end(); return; }
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    json(req, res, 502, { error: `${label} unreachable: ${err.message}` });
  }
}

async function harnessRpc(method, payload, { signal, requestId } = {}) {
  const id = rpcId();
  const response = await fetch(`${HARNESS_BASE}/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
    body: JSON.stringify({ type: "client-request", rpcId: id, method, payload }),
    signal,
  });
  if (!response.ok) throw new Error(`Harness RPC ${method} returned HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope?.type !== "server-response" || envelope.rpcId !== id) {
    throw new Error(`Harness RPC ${method} returned an invalid envelope`);
  }
  if (!envelope.result?.ok) {
    throw new HarnessRpcError(method, envelope.result?.error);
  }
  return envelope.result.value;
}

async function harnessRespond(message, { signal, requestId } = {}) {
  const response = await fetch(`${HARNESS_BASE}/api/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
    body: JSON.stringify(message),
    signal,
  });
  if (!response.ok) throw new Error(`Harness respond returned HTTP ${response.status}`);
  return response.json();
}

async function openHarnessEvents(signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("Harness event stream requires WebSocket support");
  }
  const url = new URL("/api/events.mux", HARNESS_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url);
  const inbox = [];
  let wake;
  let opened = false;
  const enqueue = (item) => {
    inbox.push(item);
    wake?.();
    wake = undefined;
  };
  const onMessage = (event) => {
    if (typeof event.data !== "string") {
      enqueue({ error: new Error("Harness event stream returned a binary frame") });
      return;
    }
    try {
      enqueue({ value: JSON.parse(event.data) });
    } catch {
      enqueue({ error: new Error("Harness event stream returned invalid JSON") });
    }
  };
  const onClose = () => enqueue({ done: true });
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose, { once: true });

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onEarlyClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      opened = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Harness event WebSocket connection failed"));
    };
    const onEarlyClose = () => {
      if (opened) return;
      cleanup();
      reject(new Error("Harness event WebSocket closed before opening"));
    };
    const onAbort = () => {
      cleanup();
      socket.close();
      reject(signal.reason || new Error("Harness event WebSocket aborted"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onEarlyClose, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

  return (async function* readHarnessEvents() {
    const onAbort = () => socket.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      while (true) {
        while (inbox.length) {
          const item = inbox.shift();
          if (item.error) throw item.error;
          if (item.done) return;
          yield item.value;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    }
  })();
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if ("content" in value) return contentText(value.content);
  return "";
}

function parseToolArguments(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function harnessChat(req, res, requestId, agentMemoryStore) {
  if (req.method !== "POST") return json(req, res, 405, { error: "Method not allowed" });
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });

  const body = await readBody(req);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json(req, res, 400, { error: "prompt is required" });
  const preset = typeof body?.preset === "string" && body.preset.trim() ? body.preset.trim() : undefined;
  const requestedModel = typeof body?.model === "string" && body.model.includes(":")
    ? body.model.trim()
    : undefined;
  const requestedSessionId = typeof body?.session_id === "string" && body.session_id.trim()
    ? body.session_id.trim()
    : undefined;
  const createRequestedSession = body?.create_session === true;
  const ephemeralSession = body?.ephemeral_session === true;
  if (ephemeralSession && requestedSessionId) {
    return json(req, res, 400, { error: "ephemeral_session cannot reuse a requested session_id" });
  }
  const allocatedSessionId = requestedSessionId || `session-${randomUUID()}`;
  let user;
  try {
    user = await currentPkgUser(authorization, requestId);
    if (requestedSessionId) {
      await ensurePkgChatSession(requestedSessionId, authorization, {
        createIfMissing: createRequestedSession,
        requestId,
      });
      bindSessionAuth(requestedSessionId, user.id, authorization);
    } else {
      await ensurePkgChatSession(allocatedSessionId, authorization, {
        createIfMissing: true,
        isEphemeral: ephemeralSession,
        requestId,
      });
    }
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, error.status || 502, { error: error.message });
  }
  const abort = new AbortController();
  let activeHarnessSessionId;
  let turnCompleted = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      abort.abort();
      if (activeHarnessSessionId && !turnCompleted) {
        void harnessRpc("session.cancel", { sessionId: activeHarnessSessionId }, { requestId })
          .catch(() => undefined);
      }
    }
  });

  setCORS(req, res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const events = await openHarnessEvents(abort.signal);
    let created;
    let sessionId = allocatedSessionId;
    const createSession = async () => harnessRpc("session.create", {
      sessionId,
      ...(preset ? { agentPreset: preset } : {}),
    }, { signal: abort.signal, requestId });
    if (!requestedSessionId || createRequestedSession) {
      created = await createSession();
      sessionId = created.sessionId;
    }
    bindSessionAuth(sessionId, user.id, authorization);
    activeHarnessSessionId = sessionId;
    if (requestedModel) {
      const separator = requestedModel.indexOf(":");
      const selection = {
        provider: requestedModel.slice(0, separator),
        model: requestedModel.slice(separator + 1),
      };
      try {
        await harnessRpc("session.selectModel", { sessionId, ...selection }, { signal: abort.signal, requestId });
      } catch (error) {
        if (!createRequestedSession && requestedSessionId && error instanceof HarnessRpcError && error.code === "session-not-found") {
          created = await createSession();
          sessionId = created.sessionId;
          bindSessionAuth(sessionId, user.id, authorization);
          activeHarnessSessionId = sessionId;
          await harnessRpc("session.selectModel", { sessionId, ...selection }, { signal: abort.signal, requestId });
        } else {
          throw error;
        }
      }
    }
    const recalled = await agentMemoryStore.recall(user.id, {
      query: prompt,
      scopeType: typeof body?.memory_scope_type === "string" ? body.memory_scope_type : "global",
      scopeId: typeof body?.memory_scope_id === "string" ? body.memory_scope_id : null,
      sessionId,
    });
    const memoryContext = formatAgentMemoryContext(recalled.memories);
    const promptPayload = {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: memoryContext ? `${memoryContext}\n\n${prompt}` : prompt }],
      ...(typeof body?.client_time_zone === "string" ? { clientTimeZone: body.client_time_zone } : {}),
    };
    if (!requestedSessionId || createRequestedSession) {
      void harnessRpc("session.prompt", promptPayload, { signal: abort.signal, requestId })
        .catch((error) => {
          if (!abort.signal.aborted) {
            sse(res, { type: "error", content: error.message, session_id: sessionId });
            abort.abort(error);
          }
        });
    } else {
      try {
        await harnessRpc("session.prompt", promptPayload, { signal: abort.signal, requestId });
      } catch (error) {
        if (error instanceof HarnessRpcError && error.code === "session-not-found") {
          created = await createSession();
          sessionId = created.sessionId;
          bindSessionAuth(sessionId, user.id, authorization);
          activeHarnessSessionId = sessionId;
          await harnessRpc("session.prompt", { ...promptPayload, sessionId }, { signal: abort.signal, requestId });
        } else {
          throw error;
        }
      }
    }
    sse(res, { type: "session", session_id: sessionId, preset: created?.agentPreset || preset });

    const streamedSteps = new Set();
    const toolNamesByCallId = new Map();
    for await (const envelope of events) {
      const frame = envelope?.payload;
      if (!frame) continue;
      if (frame.type === "stream/error") {
        sse(res, { type: "error", content: frame.error?.message || "Harness stream failed", session_id: sessionId });
        break;
      }
      if (frame.sessionId !== sessionId) continue;
      if (frame.type === "approval/requested") {
        sse(res, {
          type: "error",
          content: `Harness requires approval for ${frame.toolName}`,
          session_id: sessionId,
        });
        break;
      }
      if (frame.type === "question/requested") {
        sse(res, {
          type: "question",
          rpc_id: envelope.rpcId,
          session_id: sessionId,
          questions: frame.questions,
        });
        continue;
      }
      if (frame.type !== "session/event") continue;
      const event = frame.event;
      const stepKey = `${event.data?.turn ?? ""}:${event.data?.step ?? ""}`;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
        const text = event.data.chunk.text;
        if (text) {
          streamedSteps.add(stepKey);
          sse(res, { type: "text", content: text, session_id: sessionId });
        }
      } else if (event.type === "assistant/message" && !streamedSteps.has(stepKey)) {
        const text = contentText(event.data?.message?.content);
        if (text) sse(res, { type: "text", content: text, session_id: sessionId });
      } else if (event.type === "tool/call") {
        if (event.data?.callId && event.data?.name) toolNamesByCallId.set(event.data.callId, event.data.name);
        sse(res, {
          type: "tool_call",
          tool: event.data?.name,
          args: parseToolArguments(event.data?.arguments),
          call_id: event.data?.callId,
          session_id: sessionId,
        });
      } else if (event.type === "tool/result") {
        const callId = event.data?.message?.source?.callId;
        sse(res, {
          type: "tool_result",
          tool: event.data?.message?.source?.toolName || toolNamesByCallId.get(callId),
          result: contentText(event.data?.message?.content) || JSON.stringify(event.data?.message?.content ?? null),
          error: event.data?.error,
          session_id: sessionId,
        });
        if (callId) toolNamesByCallId.delete(callId);
      } else if (event.type === "turn/end") {
        turnCompleted = true;
        const reason = event.data?.reason;
        if (reason?.kind !== "completed") {
          sse(res, {
            type: "error",
            content: reason?.error?.message || `Harness turn ended: ${reason?.kind || "unknown"}`,
            session_id: sessionId,
          });
        }
        sse(res, { type: "done", session_id: sessionId, reason });
        break;
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) sse(res, { type: "error", content: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function harnessQuestionResponse(req, res, requestId) {
  if (req.method !== "POST") return json(req, res, 405, { error: "Method not allowed" });
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });

  try {
    const body = await readBody(req);
    const rpcIdValue = typeof body?.rpc_id === "string" ? body.rpc_id.trim() : "";
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
    const answers = body?.answers;
    if (!rpcIdValue) throw new TypeError("rpc_id is required");
    if (!sessionId) throw new TypeError("session_id is required");
    if (!Array.isArray(answers) || answers.length === 0) throw new TypeError("answers are required");

    const user = await currentPkgUser(authorization, requestId);
    const binding = sessionAuth(sessionId);
    if (binding) {
      if (binding.userId !== user.id) return json(req, res, 403, { error: "Forbidden" });
    } else {
      await ensurePkgChatSession(sessionId, authorization, { requestId });
    }

    const receipt = await harnessRespond({
      type: "client-response",
      rpcId: rpcIdValue,
      result: {
        ok: true,
        value: {
          sessionId,
          answer: { answers },
        },
      },
    }, { requestId });
    if (!receipt?.accepted) {
      return json(req, res, 409, { error: "Question is no longer pending", reason: receipt?.reason || "not-pending" });
    }
    return json(req, res, 200, receipt);
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, error instanceof TypeError ? 400 : error.status || 502, { error: error.message });
  }
}

function memoryErrorStatus(error) {
  if (error instanceof TypeError) return 400;
  if (/not found/i.test(error?.message || "")) return 404;
  if (/only .* can/i.test(error?.message || "")) return 409;
  return 500;
}

async function harnessMemories(req, res, path, url, requestId, agentMemoryStore) {
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });
  try {
    const user = await currentPkgUser(authorization, requestId);
    if (path === "/api/harness/memories") {
      if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
      return json(req, res, 200, await agentMemoryStore.list(user.id, {
        candidateStatus: url.searchParams.get("candidate_status") || undefined,
        memoryStatus: url.searchParams.get("status") || undefined,
      }));
    }
    if (path === "/api/harness/memory-recalls") {
      if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
      return json(req, res, 200, {
        items: await agentMemoryStore.listRecallAudits(user.id, {
          sessionId: url.searchParams.get("session_id") || undefined,
        }),
      });
    }
    if (path === "/api/harness/memory-candidates") {
      if (req.method !== "POST") return json(req, res, 405, { error: "Method not allowed" });
      return json(req, res, 201, await agentMemoryStore.propose(user.id, await readBody(req)));
    }

    const candidateMatch = path.match(/^\/api\/harness\/memory-candidates\/([^/]+)(?:\/(accept|reject))?$/);
    if (candidateMatch) {
      const candidateId = decodeURIComponent(candidateMatch[1]);
      const action = candidateMatch[2];
      if (!action && req.method === "PATCH") {
        return json(req, res, 200, await agentMemoryStore.updateCandidate(user.id, candidateId, await readBody(req)));
      }
      if (action === "accept" && req.method === "POST") {
        return json(req, res, 200, await agentMemoryStore.accept(user.id, candidateId, await readBody(req) || {}));
      }
      if (action === "reject" && req.method === "POST") {
        return json(req, res, 200, await agentMemoryStore.reject(user.id, candidateId));
      }
      return json(req, res, 405, { error: "Method not allowed" });
    }

    const memoryMatch = path.match(/^\/api\/harness\/memories\/([^/]+)(?:\/(archive|restore))?$/);
    if (memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1]);
      const action = memoryMatch[2];
      if (!action && req.method === "PATCH") {
        return json(req, res, 200, await agentMemoryStore.updateMemory(user.id, memoryId, await readBody(req)));
      }
      if (!action && req.method === "DELETE") {
        return json(req, res, 200, await agentMemoryStore.delete(user.id, memoryId));
      }
      if (action === "archive" && req.method === "POST") {
        return json(req, res, 200, await agentMemoryStore.archive(user.id, memoryId));
      }
      if (action === "restore" && req.method === "POST") {
        return json(req, res, 200, await agentMemoryStore.restore(user.id, memoryId));
      }
      return json(req, res, 405, { error: "Method not allowed" });
    }
    return json(req, res, 404, { error: "Not found" });
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, error.status || memoryErrorStatus(error), { error: error.message });
  }
}

function projectionTitle(summary) {
  const values = summary?.projections?.values;
  if (!values || typeof values !== "object") return undefined;
  for (const value of Object.values(values)) {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && typeof value.title === "string" && value.title.trim()) {
      return value.title;
    }
  }
  return undefined;
}

async function harnessSessions(req, res, path, requestId, sessionContextStore) {
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });
  try {
    if (path === "/api/sessions") {
      if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
      const allowedIds = await listPkgChatSessionIds(authorization, requestId);
      const value = await harnessRpc("session.list", {}, { requestId });
      return json(req, res, 200, value.items.filter((item) => allowedIds.has(item.sessionId)).map((item) => ({
        id: item.sessionId,
        title: projectionTitle(item) || item.sessionId,
        created_at: new Date(item.updatedAt).toISOString(),
        updated_at: new Date(item.updatedAt).toISOString(),
        preset: item.agentPreset,
        running: item.running,
        blank: item.blank,
      })));
    }
    const suffix = path.slice("/api/sessions/".length);
    const cancelRequested = suffix.endsWith("/cancel");
    const encodedSessionId = cancelRequested ? suffix.slice(0, -"/cancel".length) : suffix;
    const sessionId = decodeURIComponent(encodedSessionId);
    if (!sessionId || sessionId.includes("/")) return json(req, res, 404, { error: "Not found" });
    await ensurePkgChatSession(sessionId, authorization, { requestId });

    if (cancelRequested) {
      if (req.method !== "POST") return json(req, res, 405, { error: "Method not allowed" });
      const value = await harnessRpc("session.cancel", { sessionId }, { requestId });
      return json(req, res, 200, value);
    }
    if (req.method === "DELETE") {
      const user = await currentPkgUser(authorization, requestId);
      await harnessRpc("session.cancel", { sessionId }, { requestId }).catch((error) => {
        if (!(error instanceof HarnessRpcError) || error.code !== "session-not-found") throw error;
      });
      await deletePkgChatSession(sessionId, authorization, requestId);
      await sessionContextStore.delete(user.id, sessionId);
      sessionAuthRegistry.delete(sessionId);
      setCORS(req, res);
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
    const value = await harnessRpc("session.history", { sessionId }, { requestId });
    return json(req, res, 200, { id: sessionId, ...value });
  } catch (err) {
    if (err.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, err.status || 502, { error: err.message });
  }
}

async function harnessSessionContexts(req, res, path, requestId, sessionContextStore) {
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });
  const encodedSessionId = path.slice("/api/harness/session-contexts/".length);
  const sessionId = decodeURIComponent(encodedSessionId);
  if (!sessionId || sessionId.includes("/")) return json(req, res, 404, { error: "Not found" });
  try {
    await ensurePkgChatSession(sessionId, authorization, { requestId });
    const user = await currentPkgUser(authorization, requestId);
    if (req.method === "GET") {
      return json(req, res, 200, { context: await sessionContextStore.get(user.id, sessionId) });
    }
    if (req.method === "PUT") {
      const context = await sessionContextStore.put(user.id, sessionId, await readBody(req));
      return json(req, res, 200, { context });
    }
    if (req.method === "DELETE") {
      await sessionContextStore.delete(user.id, sessionId);
      setCORS(req, res);
      res.writeHead(204);
      return res.end();
    }
    return json(req, res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    const status = error instanceof TypeError ? 400 : error.status || 500;
    return json(req, res, status, { error: error.message });
  }
}

async function harnessPresets(req, res, requestId) {
  if (!authHeader(req)) return json(req, res, 401, { error: "Unauthorized" });
  if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
  try {
    const value = await harnessRpc("agentPreset.list", {}, { requestId });
    return json(req, res, 200, value.presets
      .filter((preset) => !preset.broken)
      .map((preset) => ({
        id: preset.id,
        name: preset.name || preset.id,
        description: preset.description || "",
        group: preset.trust,
        is_default: preset.isDefault,
      })));
  } catch (err) {
    return json(req, res, 502, { error: err.message });
  }
}

async function harnessModels(req, res, requestId) {
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });
  if (req.method !== "GET") return json(req, res, 405, { error: "Method not allowed" });
  try {
    await currentPkgUser(authorization, requestId);
    const value = await harnessRpc("llm.models", {}, { requestId });
    return json(req, res, 200, {
      models: (value.groups || []).flatMap((group) => (group.models || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        provider: group.id,
        provider_name: group.name || group.id,
        reasoning: model.reasoning || null,
      }))),
      failures: value.failures || [],
    });
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, 502, { error: error.message });
  }
}

async function harnessModelSettings(req, res, requestId) {
  const authorization = authHeader(req);
  if (!authorization) return json(req, res, 401, { error: "Unauthorized" });
  try {
    const user = await currentPkgUser(authorization, requestId);
    if (req.method === "GET") {
      const value = await harnessRpc("settings.describe", {}, { requestId });
      const section = (value.namespaces || []).find((item) => item.ns === "agent-default-model");
      return json(req, res, 200, {
        writable: Boolean(value.writable),
        provider: typeof section?.value?.provider === "string" ? section.value.provider : null,
        model: typeof section?.value?.model === "string" ? section.value.model : null,
        reasoning_effort: typeof section?.value?.reasoningEffort === "string" ? section.value.reasoningEffort : null,
        revision: section?.revision ?? null,
      });
    }
    if (req.method === "PATCH") {
      if (user.role !== "admin") return json(req, res, 403, { error: "Admin access required" });
      const body = await readBody(req);
      const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!provider || !model) return json(req, res, 400, { error: "provider and model are required" });
      const patch = { provider, model };
      if (typeof body?.reasoning_effort === "string" && body.reasoning_effort.trim()) {
        patch.reasoningEffort = body.reasoning_effort.trim();
      }
      const section = await harnessRpc("settings.update", {
        ns: "agent-default-model",
        patch,
        ...(Number.isInteger(body?.revision) ? { expectedRevision: body.revision } : {}),
      }, { requestId });
      return json(req, res, 200, {
        writable: true,
        provider: section.value?.provider || provider,
        model: section.value?.model || model,
        reasoning_effort: section.value?.reasoningEffort || null,
        revision: section.revision,
      });
    }
    return json(req, res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error.status === 401) return respondAuthExpired(req, res, authorization);
    return json(req, res, error instanceof TypeError ? 400 : error.status || 502, { error: error.message });
  }
}

// ── Helpers ─────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(data); }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function isHarnessRoute(path) {
  return HARNESS_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

// ── Server ──────────────────────────────────────

export function createBffServer({
  agentMemoryStore = defaultAgentMemoryStore,
  sessionContextStore = defaultSessionContextStore,
} = {}) {
  return http.createServer(async (req, res) => {
  const id = req.headers["x-request-id"] || rid();
  const method = req.method.toUpperCase();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  res.setHeader("X-Request-Id", id);

  console.log(`[${id}] ${method} ${path}`);

  // CORS preflight
  if (method === "OPTIONS") {
    setCORS(req, res);
    res.writeHead(204);
    return res.end();
  }

  // Health
  if (path === "/health" || path === "/api/health") return json(req, res, 200, { ok: true });

  if (path === "/internal/pkg" || path.startsWith("/internal/pkg/")) {
    return pkgSessionForward(req, res, path, url.search, id);
  }

  // Only handle /api/*
  if (!path.startsWith("/api")) return json(req, res, 404, { error: "Not found" });

  // ── Auth routes ──
  if (path === "/api/auth/login") {
    return pkgForward(req, res, `/auth/login${url.search}`, { captureLogin: true, requestId: id });
  }
  if (path === "/api/auth/logout") {
    const authorization = authHeader(req);
    if (authorization) clearSessionAuth(authorization);
    clearAuthCookie(res);
    setCORS(req, res);
    res.writeHead(204);
    return res.end();
  }
  if (path === "/api/auth/me") return pkgForward(req, res, `/auth/me${url.search}`, { requestId: id });

  // ── Harness REST adapter ──
  if (path === "/api/chat") return harnessChat(req, res, id, agentMemoryStore);
  if (path === "/api/harness/questions/respond") return harnessQuestionResponse(req, res, id);
  if (path === "/api/sessions" || path.startsWith("/api/sessions/")) {
    return harnessSessions(req, res, path, id, sessionContextStore);
  }
  if (path === "/api/presets") return harnessPresets(req, res, id);
  if (path === "/api/harness/models") return harnessModels(req, res, id);
  if (path === "/api/harness/model-settings") return harnessModelSettings(req, res, id);

  if (path === "/api/harness/memories" || path === "/api/harness/memory-recalls"
    || path.startsWith("/api/harness/memory-candidates") || path.startsWith("/api/harness/memories/")) {
    return harnessMemories(req, res, path, url, id, agentMemoryStore);
  }
  if (path.startsWith("/api/harness/session-contexts/")) {
    return harnessSessionContexts(req, res, path, id, sessionContextStore);
  }

  // ── PKG streaming APIs ──
  if (path === "/api/action/stream" || path === "/api/action/complete") {
    return streamForward(req, res, PKG_BASE, `${path.slice(4)}${url.search}`, id, "PKG");
  }

  // ── Harness-owned APIs ──
  if (isHarnessRoute(path)) return streamForward(req, res, HARNESS_BASE, `${path}${url.search}`, id, "Harness");

  // ── All other /api/* → strip /api prefix, forward to PKG ──
  return pkgForward(req, res, `${path.slice(4)}${url.search}`, { requestId: id });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBffServer();
  server.listen(PORT, HOST, () => {
    console.log(`[BFF] http://${HOST}:${PORT} → PKG ${PKG_BASE} | Harness ${HARNESS_BASE}`);
  });
}
