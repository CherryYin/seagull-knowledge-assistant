import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const DEFAULT_AUTH_FILE = fileURLToPath(new URL("../../deepseek-knowledge-lab/.dsh/run/seagull-harness.json", import.meta.url));
const REQUEST_METHODS = new Set(["list", "search", "create", "selectModel", "rename", "fork", "prompt", "attachment", "updateQueue", "cancel", "page"]);

export class HarnessRpcError extends Error {
  constructor(method, error) {
    super(error?.message || `Harness RPC ${method} failed`);
    this.name = "HarnessRpcError";
    this.code = error?.code === "session/not-found" ? "session-not-found" : error?.code;
    this.details = error?.details;
    this.status = error?.code === "settings/conflict" ? 409 : 502;
  }
}

function remoteCall(method, payload) {
  if (method.startsWith("session.") && REQUEST_METHODS.has(method.slice(8))) {
    return { endpoint: method.replace(".", "/"), args: { request: payload } };
  }
  if (method === "llm.models") return { endpoint: "session/modelCatalog", args: {} };
  if (method === "agentPreset.list") return { endpoint: "agentPresets/list", args: {} };
  if (method === "settings.describe") return { endpoint: "settings/describe", args: {} };
  if (method === "settings.update" || method === "settings.mutate") {
    return { endpoint: method.replace(".", "/"), args: payload };
  }
  throw new Error("Unsupported Seagull Harness operation");
}

class StreamInbox {
  items = [];
  waiting;
  failure;
  closed = false;

  push(value) {
    if (this.closed) return;
    if (this.items.length >= 2048) return this.fail(new Error("Harness event consumer is too slow"));
    this.items.push(value);
    this.waiting?.();
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.waiting?.();
  }

  async next() {
    while (!this.items.length && !this.closed) await new Promise(resolve => { this.waiting = resolve; });
    if (this.items.length) return this.items.shift();
    if (this.failure) throw this.failure;
    return this.items.shift();
  }
}

export class HarnessClient {
  constructor({
    baseUrl = process.env.HARNESS_API_URL || "http://127.0.0.1:3080",
    authFile = process.env.HARNESS_AUTH_FILE || DEFAULT_AUTH_FILE,
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
  } = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid Harness API origin");
    this.origin = url.origin;
    this.authFile = authFile;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.pendingQuestions = new Map();
    this.activeSessions = new Set();
  }

  async authenticate() {
    if (this.authentication) return this.authentication;
    this.authentication = (async () => {
      let file;
      let launch;
      try {
        file = await open(this.authFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)
          || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        launch = JSON.parse(await file.readFile("utf8"));
      } catch {
        throw new Error("Harness connection unavailable; enable the Seagull connection plugin and protect HARNESS_AUTH_FILE with mode 0600");
      } finally {
        await file?.close();
      }
      const url = new URL(launch.url);
      if (url.origin !== this.origin || url.username || url.password || url.pathname !== "/"
        || url.hash || [...url.searchParams.keys()].join() !== "token" || !url.searchParams.get("token")) {
        throw new Error("Harness connection origin does not match HARNESS_API_URL");
      }
      const response = await this.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      if (![302, 303].includes(response.status) || response.headers.get("location") !== "/"
        || !cookie || /[\r\n]/.test(cookie)) throw new Error("Harness authentication failed; restart its Seagull connection plugin");
      this.cookie = cookie;
      return cookie;
    })();
    try { return await this.authentication; }
    finally { this.authentication = undefined; }
  }

  async authenticatedFetch(path, options = {}) {
    const cookie = this.cookie || await this.authenticate();
    const headers = { ...options.headers, Cookie: cookie };
    let response = await this.fetch(`${this.origin}${path}`, { ...options, headers, redirect: "error" });
    if (response.status === 401) {
      await response.body?.cancel();
      headers.Cookie = await this.authenticate();
      response = await this.fetch(`${this.origin}${path}`, { ...options, headers, redirect: "error" });
    }
    return response;
  }

  async request(endpoint, args, { signal, requestId } = {}) {
    signal?.throwIfAborted();
    const id = randomUUID();
    const options = {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", ...(requestId ? { "X-Request-Id": requestId } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId: id, method: endpoint, payload: { args } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    };
    const response = await this.authenticatedFetch(`/api/${endpoint}`, options);
    if (!response.ok) throw new Error(`Harness RPC ${endpoint} returned HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope?.type !== "server-response" || envelope.rpcId !== id || typeof envelope.result?.ok !== "boolean") {
      throw new Error("Harness RPC returned an invalid envelope");
    }
    if (!envelope.result.ok) throw new HarnessRpcError(endpoint, envelope.result.error);
    return envelope.result.value;
  }

  async rpc(method, payload = {}, options) {
    if (method === "session.history") return this.history(payload.sessionId, options);
    const { endpoint, args } = remoteCall(method, payload);
    return this.request(endpoint, args, options);
  }

  async connect(signal) {
    signal?.throwIfAborted();
    const cookie = await this.authenticate();
    signal?.throwIfAborted();
    const url = new URL("/api/remote.mux", this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new this.WebSocket(url, { headers: { Cookie: cookie }, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    const inbox = new StreamInbox();
    const abort = () => { inbox.fail(signal.reason || new Error("Harness stream aborted")); socket.close(); };
    socket.on("message", data => {
      try { inbox.push(JSON.parse(String(data))); }
      catch { inbox.fail(new Error("Harness stream returned invalid JSON")); socket.close(); }
    });
    socket.on("close", () => inbox.fail(new Error("Harness stream disconnected; execution outcome must be checked before retrying")));
    socket.on("error", () => inbox.fail(new Error("Harness stream connection failed")));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Harness stream connection timed out")), 6000);
        const finish = error => {
          clearTimeout(timer);
          socket.off("open", ready);
          socket.off("error", failed);
          socket.off("close", failed);
          signal?.removeEventListener("abort", cancelled);
          error ? reject(error) : resolve();
        };
        const ready = () => finish();
        const failed = () => finish(new Error("Harness stream connection failed"));
        const cancelled = () => finish(signal.reason || new Error("Harness stream aborted"));
        socket.once("open", ready);
        socket.once("error", failed);
        socket.once("close", failed);
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) cancelled();
      });
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      socket.close();
      throw error;
    }
    return {
      inbox,
      send: value => socket.send(JSON.stringify(value)),
      close: () => {
        signal?.removeEventListener("abort", abort);
        socket.close();
        inbox.fail(new Error("Harness stream closed"));
      },
    };
  }

  async history(sessionId, { signal } = {}) {
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await this.authenticatedFetch(`/api/seagull/session-cursor?sessionId=${encodeURIComponent(sessionId)}`, { signal: lifetime });
    if (!response.ok) throw new Error(`Harness read-only history returned HTTP ${response.status}`);
    const { cursor } = await response.json();
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw new Error("Harness history cursor invalid");
    const page = await this.rpc("session.page", { address: { kind: "session", sessionId }, throughSeq: cursor }, { signal: lifetime });
    return { events: page.records.filter(record => record.type === "event").map(record => record.event), hasMore: page.hasMore };
  }

  async events(sessionId, signal) {
    if (this.activeSessions.has(sessionId)) throw Object.assign(new Error("This session already has an active Seagull execution"), { status: 409 });
    this.activeSessions.add(sessionId);
    let connection;
    try { connection = await this.connect(signal); }
    catch (error) { this.activeSessions.delete(sessionId); throw error; }
    const eventsId = randomUUID();
    const sessionStreamId = randomUUID();
    let clientId;
    let attempt;
    let lastSeq;
    let snapshot;
    const readyTimer = setTimeout(() => connection.close(), 15000);
    const result = async frame => {
      if (![eventsId, sessionStreamId].includes(frame.streamId)) throw new Error("Harness returned an unknown stream");
      if (frame.type === "error") throw new HarnessRpcError("stream", frame.error);
      if (frame.type !== "item") throw new Error("Harness stream ended unexpectedly");
      const value = frame.value;
      if (frame.streamId === eventsId) {
        if (value?.type === "ready") {
          if (clientId || typeof value.clientId !== "string" || !value.clientId) throw new Error("Harness event stream ready frame invalid");
          clientId = value.clientId;
          return;
        }
        if (!clientId) throw new Error("Harness event stream ready frame missing");
        if (value?.type === "cancel") { this.pendingQuestions.delete(value.eventId); return; }
        if (value?.type !== "waterfall") return;
        if (typeof value.eventId !== "string" || !value.eventId || typeof value.agentId !== "string") throw new Error("Harness event identity invalid");
        if (value.agentId !== sessionId || value.event !== "user-questions/request") {
          const approvalRequired = value.agentId === sessionId && value.event === "approval/request";
          const outcome = approvalRequired
            ? { kind: "rejected", error: { name: "SeagullApprovalRequired", message: "Seagull does not yet support approving this operation" } }
            : { kind: "next" };
          await this.request("$events/result", { clientId, eventId: value.eventId, outcome }, { signal });
          if (approvalRequired) {
            return { payload: { type: "approval/requested", sessionId, toolName: "a restricted operation" } };
          }
          return;
        }
        if (!Array.isArray(value.request?.questions)) throw new Error("Harness question payload invalid");
        this.pendingQuestions.set(value.eventId, { sessionId, clientId });
        return { rpcId: value.eventId, payload: { type: "question/requested", sessionId, questions: value.request.questions } };
      }
      if (value?.type === "snapshot") {
        if (snapshot || value.header?.id !== sessionId || !Number.isSafeInteger(value.cursor)) throw new Error("Harness session snapshot invalid");
        snapshot = true;
        lastSeq = value.cursor;
        return;
      }
      if (!snapshot) throw new Error("Harness session snapshot missing");
      if (value?.type === "assistant-stream") {
        const live = value.frame;
        if (live.type === "start") { attempt = { ...live, nextIndex: 0 }; return; }
        if (live.type === "end") { attempt = undefined; return; }
        if (live.type !== "chunk" || !attempt || live.attemptId !== attempt.attemptId || live.index !== attempt.nextIndex++) {
          throw new Error("Harness assistant stream is not contiguous");
        }
        return { payload: { type: "session/event", sessionId, event: { type: "assistant/chunk", time: live.time, data: { turn: attempt.turn, step: attempt.step, chunk: live.chunk } } } };
      }
      if (value?.type !== "event" || !Number.isSafeInteger(value.event?.seq) || value.event.seq !== lastSeq + 1) {
        throw new Error("Harness session journal is not contiguous");
      }
      lastSeq = value.event.seq;
      return { payload: { type: "session/event", sessionId, event: value.event } };
    };
    const buffered = [];
    try {
      connection.send({ type: "open", streamId: eventsId, endpoint: "$events", payload: { args: {} } });
      connection.send({ type: "open", streamId: sessionStreamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId }, assistantStream: true } } } });
      while (!clientId || !snapshot) {
        const event = await result(await connection.inbox.next());
        if (event) buffered.push(event);
      }
    } catch (error) {
      connection.close();
      this.activeSessions.delete(sessionId);
      for (const [eventId, pending] of this.pendingQuestions) {
        if (pending.clientId === clientId) this.pendingQuestions.delete(eventId);
      }
      throw error;
    } finally { clearTimeout(readyTimer); }
    const client = this;
    const close = () => {
      for (const [eventId, pending] of client.pendingQuestions) {
        if (pending.clientId === clientId) client.pendingQuestions.delete(eventId);
      }
      client.activeSessions.delete(sessionId);
      connection.close();
    };
    const iterator = (async function* () {
      try {
        yield* buffered;
        while (true) {
          const event = await result(await connection.inbox.next());
          if (event) yield event;
        }
      } finally {
        close();
      }
    })();
    return {
      next: () => iterator.next(),
      return: () => { close(); return iterator.return(); },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  async respond(message, options) {
    const pending = this.pendingQuestions.get(message.rpcId);
    if (!pending || pending.answering || pending.sessionId !== message.result?.value?.sessionId) return { accepted: false, reason: "not-pending" };
    pending.answering = true;
    try {
      await this.request("$events/result", {
        clientId: pending.clientId,
        eventId: message.rpcId,
        outcome: { kind: "result", value: message.result.value.answer },
      }, options);
    } finally { this.pendingQuestions.delete(message.rpcId); }
    return { accepted: true };
  }
}
