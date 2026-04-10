const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// --- Sources ---
export interface Source {
  id: string;
  title: string;
  source_type: string;
  url?: string | null;
  content_hash?: string | null;
  raw_content?: string | null;
  file_path?: string | null;
  ingested_at: string;
  metadata_?: Record<string, unknown> | null;
}

export interface SourceList {
  items: Source[];
  total: number;
}

export interface SourceCreate {
  title: string;
  source_type: string;
  url?: string;
  raw_content?: string;
  metadata?: Record<string, unknown>;
}

export const sourcesApi = {
  list: (params?: { source_type?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.source_type) q.set("source_type", params.source_type);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<SourceList>(`/sources?${q}`);
  },
  get: (id: string) => request<Source>(`/sources/${encodeURIComponent(id)}`),
  create: (body: SourceCreate) =>
    request<Source>("/sources", { method: "POST", body: JSON.stringify(body) }),
  upload: (body: FormData) =>
    request<Source>("/sources/upload", { method: "POST", body }),
};

// --- Notes ---
export interface Note {
  id: string;
  title: string;
  note_type: string;
  domains: string[];
  tags: string[];
  abstract?: string | null;
  content?: string | null;
  project?: string | null;
  status: string;
  confidence: string;
  source_ids: string[];
  file_path?: string | null;
  word_count?: number | null;
  created_at: string;
  updated_at: string;
}

export interface NoteList {
  items: Note[];
  total: number;
}

export interface NoteCreate {
  title: string;
  note_type?: string;
  domains?: string[];
  tags?: string[];
  abstract?: string;
  content?: string;
  project?: string;
  status?: string;
  confidence?: string;
  source_ids?: string[];
}

/** Partial update (PATCH). Only include fields to change. */
export interface NoteUpdate {
  title?: string;
  note_type?: string;
  domains?: string[];
  tags?: string[];
  abstract?: string | null;
  content?: string | null;
  project?: string | null;
  status?: string;
  confidence?: string;
  source_ids?: string[];
}

export const notesApi = {
  list: (params?: {
    note_type?: string;
    domain?: string;
    tag?: string;
    project?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.note_type) q.set("note_type", params.note_type);
    if (params?.domain) q.set("domain", params.domain);
    if (params?.tag) q.set("tag", params.tag);
    if (params?.project) q.set("project", params.project);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<NoteList>(`/notes?${q}`);
  },
  get: (id: string) => request<Note>(`/notes/${encodeURIComponent(id)}`),
  create: (body: NoteCreate) =>
    request<Note>("/notes", { method: "POST", body: JSON.stringify(body) }),
  upload: (body: FormData) =>
    request<Note>("/notes/upload", { method: "POST", body }),
  update: (id: string, body: NoteUpdate) =>
    request<Note>(`/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

// --- Search ---
export interface SearchResult {
  id: string;
  title: string;
  type: string;
  score: number;
  abstract?: string | null;
  content_preview?: string | null;
}

export interface SearchRequest {
  query: string;
  mode?: string;
  top_k?: number;
  filters?: Record<string, unknown>;
}

export const searchApi = {
  search: (body: SearchRequest) =>
    request<SearchResult[]>("/search", { method: "POST", body: JSON.stringify(body) }),
};

// --- Action Agent ---
export interface ActionRequest {
  task: string;
  session_id?: string;
  conversation_history?: { role: string; content: string }[];
}

export async function* streamAction(body: ActionRequest): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/action/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

// --- Sync ---
export const syncApi = {
  sync: () => request<{ notes: Record<string, number>; sources: Record<string, number> }>("/sync", { method: "POST" }),
};

// --- Skills ---
export interface SkillArg {
  name: string;
  description: string;
  required: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  args: SkillArg[];
  template: string;
  tools_file: string | null;
  file_path: string | null;
  source: string; // "local" | "db"
  created_at?: string | null;
  updated_at?: string | null;
}

export const skillsApi = {
  list: () => request<Skill[]>("/skills"),
  get: (name: string) => request<Skill>(`/skills/${encodeURIComponent(name)}`),
  delete: (name: string) =>
    request<void>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
};

// --- Chat Sessions (backend-persisted) ---
export interface ChatSessionMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  messages: ChatSessionMessage[];
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
};
