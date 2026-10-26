import type { DiscoveryWebResult } from "./api/discovery";

export function normalizeWebMaterials(value: unknown): { items: DiscoveryWebResult[]; ignored: number } {
  if (!Array.isArray(value)) throw new Error("搜索返回格式无效，请重试；未保存任何素材。");
  const items: DiscoveryWebResult[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const candidate of value.slice(0, 20)) {
    if (!candidate || typeof candidate.title !== "string" || !candidate.title.trim() || typeof candidate.url !== "string") { ignored += 1; continue; }
    try {
      const title = candidate.title.replace(/\u0000/g, "").trim().slice(0, 500);
      if (!title) throw new Error("Empty title");
      const url = new URL(candidate.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported URL");
      url.hash = "";
      if (url.href.length > 2048) throw new Error("URL too long");
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const bounded = (field: unknown, limit: number) => typeof field === "string" ? field.replace(/\u0000/g, "").slice(0, limit) : null;
      items.push({ title, url: url.href,
        summary: bounded(candidate.summary, 10000), source_name: bounded(candidate.source_name, 200), published_at: bounded(candidate.published_at, 100) });
    } catch { ignored += 1; }
  }
  return { items, ignored: ignored + Math.max(0, value.length - 20) };
}
