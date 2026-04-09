export interface ChatSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatSessionMessage[];
}

const SESSIONS_STORAGE_KEY = "pkg.chat.sessions";
const ACTIVE_SESSION_STORAGE_KEY = "pkg.chat.active-session";

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptySession(): ChatSessionRecord {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    title: "New Session",
    created_at: now,
    updated_at: now,
    messages: [],
  };
}

export function createMessage(
  role: ChatSessionMessage["role"],
  content: string
): ChatSessionMessage {
  return {
    id: createId("msg"),
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

export function deriveSessionTitle(messages: ChatSessionMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage?.content.trim()) return "New Session";
  const singleLine = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return singleLine.length > 40 ? `${singleLine.slice(0, 40)}...` : singleLine;
}

export function loadSessions(): ChatSessionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: ChatSessionRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

export function loadActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
}

export function saveActiveSessionId(sessionId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
}
