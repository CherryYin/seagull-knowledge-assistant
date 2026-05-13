import { BASE, TOKEN_KEY } from "./client";

export interface ActionRequest {
  task: string;
  session_id?: string;
  profile_id?: string;
  model_id?: string;
  provider_id?: string;
  conversation_history?: { role: string; content: string }[];
}

export type SSEvent =
  | { type: "step"; tool: string; status: "running" | "done" }
  | { type: "content"; text: string }
  | { type: "ask_human"; question: string; options?: string[] }
  | { type: "error"; message: string }
  | { type: "done"; session_id: string };

export async function* streamAction(body: ActionRequest, signal?: AbortSignal): AsyncGenerator<SSEvent> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/action/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventType = "content";
        let dataStr = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          yield { type: eventType, ...data } as SSEvent;
        } catch {
          yield { type: "content", text: dataStr } as SSEvent;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
