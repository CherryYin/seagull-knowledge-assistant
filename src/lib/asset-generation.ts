import type { AssetType } from "@/lib/api";

export interface AssetGenerationRequest {
  assetType: AssetType;
  title: string;
  brief: string;
  audience: string;
  styleNotes: string;
  sourceRefs: string[];
  noteRefs: string[];
  wikiRefs: string[];
}

export const MANUAL_ASSET_TYPES: Array<{
  value: Exclude<AssetType, "newsletter_issue">;
  label: string;
  description: string;
}> = [
  {
    value: "blog_post",
    label: "Blog Post",
    description: "A readable article with a clear audience, angle, and evidence-backed thesis.",
  },
  {
    value: "research_brief",
    label: "Research Brief",
    description: "A decision-oriented synthesis of findings, risks, evidence, and recommendations.",
  },
  {
    value: "knowledge_pack",
    label: "Knowledge Pack",
    description: "A guided bundle of reusable knowledge with themes, reading order, and references.",
  },
  {
    value: "topic_report",
    label: "Topic Report",
    description: "A systematic report that explains a topic, its gaps, risks, and next steps.",
  },
];

export function assetTypeLabel(assetType: AssetType) {
  return MANUAL_ASSET_TYPES.find((item) => item.value === assetType)?.label
    ?? (assetType === "newsletter_issue" ? "Newsletter Issue" : "Asset");
}
