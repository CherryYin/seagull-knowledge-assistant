export interface AssetHandoffState {
  title?: string;
  brief?: string;
  asset_type?: "blog_post" | "research_brief" | "knowledge_pack" | "newsletter_issue" | "topic_report";
  source_refs?: string[];
  note_refs?: string[];
  wiki_refs?: string[];
}

export function buildAssetHandoffState(input: AssetHandoffState): AssetHandoffState {
  return {
    title: input.title,
    brief: input.brief,
    asset_type: input.asset_type,
    source_refs: input.source_refs ?? [],
    note_refs: input.note_refs ?? [],
    wiki_refs: input.wiki_refs ?? [],
  };
}
