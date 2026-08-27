import { API_BASE, TOKEN_KEY } from "./client";
import { notifyAuthExpired } from "@/lib/authEvents";

function notifyIfAuthExpired(response: Response): void {
  if (response.status === 401) notifyAuthExpired();
}

export interface HarnessChatEvent {
  type: "session" | "text" | "tool_call" | "tool_result" | "question" | "done" | "error";
  content?: string;
  tool?: string;
  args?: unknown;
  result?: string;
  session_id?: string;
  preset?: string;
  call_id?: string;
  rpc_id?: string;
  questions?: HarnessQuestionItem[];
}

export interface HarnessQuestionOption {
  label: string;
  description?: string;
}

export interface HarnessQuestionItem {
  id: string;
  question: string;
  header?: string;
  options?: HarnessQuestionOption[];
  multiSelect?: boolean;
}

export interface HarnessQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface HarnessChatOptions {
  preset?: string;
  model?: string | null;
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
      model: options.model,
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

export interface HarnessModelInfo {
  id: string;
  name: string;
  provider: string;
  provider_name: string;
  reasoning?: { efforts?: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string } | null;
}

export interface HarnessModelsResponse {
  models: HarnessModelInfo[];
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface HarnessDefaultModelSettings {
  writable: boolean;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  revision: number | null;
}

async function harnessJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    credentials: "include",
  });
  if (!response.ok) {
    notifyIfAuthExpired(response);
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${response.status}: ${detail}`);
  }
  return response.json();
}

export const harnessSettingsApi = {
  listModels: () => harnessJson<HarnessModelsResponse>("/api/harness/models"),
  getDefaultModel: () => harnessJson<HarnessDefaultModelSettings>("/api/harness/model-settings"),
  updateDefaultModel: (body: { provider: string; model: string; reasoning_effort?: string | null; revision?: number | null }) =>
    harnessJson<HarnessDefaultModelSettings>("/api/harness/model-settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

export async function answerHarnessQuestion(rpcId: string, sessionId: string, answers: HarnessQuestionAnswer[]): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}/api/harness/questions/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ rpc_id: rpcId, session_id: sessionId, answers }),
    credentials: "include",
  });
  if (!res.ok) {
    notifyIfAuthExpired(res);
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Failed to answer Harness question: ${res.status}`);
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
