import { request } from "./client";

export interface DocumentMetadata {
  storage_uri: string;
  format: string;
  filename: string;
}

export interface ReferenceInfo {
  id: string;
  type: "note" | "source" | "web";
  title: string;
}

export interface MessageMetadata {
  documents?: DocumentMetadata[];
  references?: ReferenceInfo[];
  has_generated_document?: boolean;
  document_content?: string;
  document_title?: string;
  writing_note_id?: string;
  asset_intent_proposal?: Record<string, unknown>;
  asset_intent_draft?: Record<string, unknown>;
}

export interface ChatSessionMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
  metadata?: MessageMetadata | null;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  messages: ChatSessionMessage[];
  profile_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionList {
  items: ChatSessionRecord[];
  total: number;
}

export interface ChatSessionCreate {
  id?: string;
  title?: string;
  messages?: ChatSessionMessage[];
}

export interface ChatSessionUpdate {
  title?: string;
  messages?: ChatSessionMessage[];
}

export const chatSessionsApi = {
  list: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<ChatSessionList>(`/chat-sessions?${q}`);
  },
  get: (id: string) =>
    request<ChatSessionRecord>(`/chat-sessions/${encodeURIComponent(id)}`),
  create: (body: ChatSessionCreate = {}) =>
    request<ChatSessionRecord>("/chat-sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: ChatSessionUpdate) =>
    request<ChatSessionRecord>(`/chat-sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    request<void>(`/chat-sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  deleteUnified: (id: string) =>
    request<void>(`/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
