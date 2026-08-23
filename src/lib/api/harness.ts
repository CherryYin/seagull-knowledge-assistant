import { API_BASE, TOKEN_KEY } from "./client";
import { notifyAuthExpired } from "@/lib/authEvents";

function notifyIfAuthExpired(response: Response): void {
  if (response.status === 401) notifyAuthExpired();
}

export interface HarnessChatEvent {
  type: "session" | "text" | "tool_call" | "tool_result" | "done" | "error";
  content?: string;
  tool?: string;
  args?: unknown;
  result?: string;
  session_id?: string;
  preset?: string;
  call_id?: string;
}

export interface HarnessChatOptions {
  preset?: string;
  sessionId?: string;
  createSession?: boolean;
  clientTimeZone?: string;
  signal?: AbortSignal;
}

export async function* harnessChat(prompt: string, options: HarnessChatOptions = {}): AsyncGenerator<HarnessChatEvent> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      preset: options.preset,
      session_id: options.sessionId,
      create_session: options.createSession,
      client_time_zone: options.clientTimeZone,
    }),
    credentials: "include",
    signal: options.signal,
  });

  if (!res.ok) {
    notifyIfAuthExpired(res);
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Harness chat failed: ${res.status} ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) { yield { type: "error", content: "No response body" }; return; }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") { yield { type: "done" }; return; }
        try { yield JSON.parse(data) as HarnessChatEvent; } catch { /* skip */ }
      }
    }
  }
}

export interface HarnessSession { id: string; title: string; created_at: string; preset?: string; }

export async function listSessions(): Promise<HarnessSession[]> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}/api/sessions`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) {
    notifyIfAuthExpired(res);
    throw new Error(`Failed to list sessions: ${res.status}`);
  }
  return res.json();
}

export interface HarnessPreset { id: string; name: string; description: string; group?: string; }

export async function listPresets(): Promise<HarnessPreset[]> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}/api/presets`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) {
    notifyIfAuthExpired(res);
    throw new Error(`Failed to list presets: ${res.status}`);
  }
  return res.json();
}

export async function submitExperiment(body: Record<string, unknown>): Promise<unknown> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}/api/experiments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) {
    notifyIfAuthExpired(res);
    throw new Error(`Failed to submit experiment: ${res.status}`);
  }
  return res.json();
}
