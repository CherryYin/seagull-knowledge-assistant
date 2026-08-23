import { notifyAuthExpired } from "@/lib/authEvents";

export const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
export const TOKEN_KEY = "auth_token";

export function authHeaders(headers: Headers): Headers {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = authHeaders(new Headers(init?.headers));
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const fullPath = path.startsWith("/api") ? path : `/api${path}`;
  const res = await fetch(`${API_BASE}${fullPath}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (res.status === 401) {
    notifyAuthExpired();
    throw new AuthError("PKG authentication expired");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function downloadFile(path: string, fallbackFilename = "download") {
  const headers = authHeaders(new Headers());
  const fullPath = path.startsWith("/api") ? path : `/api${path}`;
  const res = await fetch(`${API_BASE}${fullPath}`, { headers, credentials: "include" });
  if (res.status === 401) {
    notifyAuthExpired();
    throw new AuthError("PKG authentication expired");
  }
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
