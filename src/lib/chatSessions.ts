/**
 * Chat session management — backed by the /chat-sessions REST API.
 *
 * All operations are async and persist to PostgreSQL via the backend.
 * The module re-exports types from api.ts for convenience.
 */
import {
  chatSessionsApi,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type MessageMetadata,
} from "./api";

export type { ChatSessionMessage, ChatSessionRecord };

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMessage(
  role: ChatSessionMessage["role"],
  content: string,
  metadata?: MessageMetadata | null,
): ChatSessionMessage {
  return {
    id: createId("msg"),
    role,
    content,
    created_at: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

export function deriveSessionTitle(messages: ChatSessionMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage?.content.trim()) return "New Session";
  const singleLine = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return singleLine.length > 40 ? `${singleLine.slice(0, 40)}...` : singleLine;
}

/** Create a new session on the backend and return it. */
export async function createEmptySession(): Promise<ChatSessionRecord> {
  return chatSessionsApi.create({ id: createId("session") });
}

/** Load all sessions from the backend. */
export async function loadSessions(): Promise<ChatSessionRecord[]> {
  const result = await chatSessionsApi.list({ limit: 100 });
  return result.items;
}

/** Save (update) a single session on the backend. */
export async function saveSession(session: ChatSessionRecord): Promise<ChatSessionRecord> {
  return chatSessionsApi.update(session.id, {
    title: session.title,
    messages: session.messages,
  });
}

/** Delete a session from the backend. */
export async function deleteSession(sessionId: string): Promise<void> {
  await chatSessionsApi.deleteUnified(sessionId);
}
