import type { Source } from "@/lib/api";

export type WebSourceRole = "page" | "collection_feed" | "collection_directory" | "article";

function isTrue(value: unknown) {
  return value === true || String(value).toLowerCase() === "true";
}

export function webSourceRole(source: Source): WebSourceRole | null {
  if (source.source_type !== "web" && source.source_type !== "article") return null;
  const explicitRole = source.metadata_?.web_role;
  if (explicitRole === "page" || explicitRole === "collection_feed" || explicitRole === "collection_directory" || explicitRole === "article") {
    return explicitRole;
  }
  if (source.metadata_?.collection_source_id || source.metadata_?.feed_source_id) return "article";
  if (isTrue(source.metadata_?.rss_enabled)) return "collection_feed";
  if (isTrue(source.metadata_?.web_directory_enabled) || isTrue(source.metadata_?.web_directory)) return "collection_directory";
  if (source.source_type === "web") return "page";
  return null;
}

export function isRssFeedSource(source: Source) {
  return webSourceRole(source) === "collection_feed";
}

export function sourcePresentationLabel(source: Source) {
  const role = webSourceRole(source);
  if (role === "article" && (source.metadata_?.origin === "web_directory" || source.metadata_?.content_source === "web_directory")) {
    return "Web Directory Article";
  }
  if (role === "article") return "RSS Article";
  if (role === "collection_feed") return "RSS Feed";
  if (role === "collection_directory") return "Web Directory";
  if (role === "page") return "Web Page";
  return source.source_type;
}
