import type { WikiPage } from "@/lib/api";

export function getWikiRole(page: WikiPage): "draft" | "stable" {
  return (page.tags ?? []).includes("wiki-draft") ? "draft" : "stable";
}

export function getWikiOrigin(page: WikiPage): string | null {
  const tags = new Set(page.tags ?? []);
  if (tags.has("from-memory")) return "from-memory";
  if (tags.has("wiki-compiled")) return "compiled";
  return null;
}
