export interface AssetHandoffState {
  title?: string;
  brief?: string;
  source_refs?: string[];
  note_refs?: string[];
  memory_refs?: string[];
  wiki_refs?: string[];
}

export function buildAssetHandoffState(input: AssetHandoffState): AssetHandoffState {
  return {
    title: input.title,
    brief: input.brief,
    source_refs: input.source_refs ?? [],
    note_refs: input.note_refs ?? [],
    memory_refs: input.memory_refs ?? [],
    wiki_refs: input.wiki_refs ?? [],
  };
}
