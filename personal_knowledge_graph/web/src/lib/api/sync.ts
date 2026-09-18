import { request } from "./client";

export const syncApi = {
  sync: () => request<{ notes: Record<string, number>; sources: Record<string, number> }>("/sync", { method: "POST" }),
};
