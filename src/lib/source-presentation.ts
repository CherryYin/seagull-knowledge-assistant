import type { Source } from "@/lib/api";

export function isRssFeedSource(source: Source) {
  return (source.source_type === "web" || source.source_type === "article")
    && source.metadata_?.rss_enabled === "true";
}

export function sourcePresentationLabel(source: Source) {
  if (source.metadata_?.content_source === "web_directory" || source.metadata_?.web_directory === true) {
    return "Web Directory Article";
  }
  if (source.metadata_?.feed_source_id) return "RSS Article";
  if (isRssFeedSource(source)) return "RSS Feed";
  if (source.source_type === "web") return "Web Directory";
  return source.source_type;
}
