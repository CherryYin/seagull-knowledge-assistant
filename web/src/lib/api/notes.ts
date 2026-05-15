import { downloadFile, request } from "./client";

export interface Note {
  id: string;
  title: string;
  category_id: number;
  category_name?: string | null;
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
  category_id: number;
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

export interface DigestMergeRequest {
  source_ids: string[];
}

export interface NoteUpdate {
  title?: string;
  category_id?: number;
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
    category_id?: number;
    domain?: string;
    tag?: string;
    project?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.note_type) q.set("note_type", params.note_type);
    if (params?.category_id) q.set("category_id", String(params.category_id));
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
  delete: (id: string) =>
    request<void>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mergeDigest: (targetId: string, body: DigestMergeRequest) =>
    request<Note>(`/notes/${encodeURIComponent(targetId)}/merge-digest`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportPdf: (id: string, title?: string) =>
    downloadFile(`/notes/${encodeURIComponent(id)}/export/pdf`, `${title || "note"}.pdf`),
};
