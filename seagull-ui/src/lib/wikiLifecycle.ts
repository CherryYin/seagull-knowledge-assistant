import type { WikiPage } from "@/lib/api";

export function getWikiRole(page: WikiPage): "draft" | "stable" | "archived" {
  if (["draft", "stable", "archived"].includes(page.lifecycle_status)) {
    return page.lifecycle_status as "draft" | "stable" | "archived";
  }
  return (page.tags ?? []).includes("wiki-draft") ? "draft" : "stable";
}

export function getWikiOrigin(page: WikiPage): string | null {
  const tags = new Set(page.tags ?? []);
  if (tags.has("from-memory")) return "from-memory";
  if (tags.has("wiki-compiled")) return "compiled";
  return null;
}
