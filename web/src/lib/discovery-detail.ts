import type { DiscoveryItem } from "@/lib/api";
import type { DiscoveryDetailData } from "@/components/DiscoveryDetailDialog";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function toDiscoveryDetail(item: DiscoveryItem): DiscoveryDetailData {
  return {
    title: item.title,
    authors: asStringArray(item.payload?.authors),
    abstract: asString(item.payload?.abstract) ?? item.summary,
    summary: item.summary,
    url: asString(item.payload?.url) ?? item.url,
    pdf_url: asString(item.payload?.pdf_url),
    doi: asString(item.payload?.doi),
    arxiv_id: asString(item.payload?.arxiv_id),
    fields_of_study: asStringArray(item.payload?.fields_of_study),
    categories: asStringArray(item.payload?.categories),
    source_name: asString(item.payload?.source_name),
    domain: asString(item.payload?.domain),
    venue: asString(item.payload?.venue),
    year: asNumber(item.payload?.year),
    citation_count: asNumber(item.payload?.citation_count),
    provider: item.provider,
    why: item.why,
  };
}

export function toPaperResult(item: DiscoveryItem) {
  return {
    arxiv_id: String(item.payload?.arxiv_id || item.item_key),
    title: item.title,
    authors: asStringArray(item.payload?.authors),
    abstract: asString(item.payload?.abstract) ?? item.summary ?? "",
    categories: asStringArray(item.payload?.fields_of_study),
    published: null,
    updated: null,
    pdf_url: asString(item.payload?.pdf_url),
    entry_url: asString(item.payload?.url) ?? item.url ?? null,
    doi: asString(item.payload?.doi),
    source_id: item.source_id || null,
    cache_id: null,
    cache_status: item.status,
    cache_expires_at: null,
  };
}
