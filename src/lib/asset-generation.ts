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

const ASSET_REQUIRED_SECTIONS: Record<AssetType, string[]> = {
  blog_post: [
    "Introduction",
    "Main Argument",
    "Practical Implications",
    "Conclusion",
    "Evidence Notes",
    "Review Notes",
  ],
  research_brief: [
    "Executive Summary",
    "Key Findings",
    "Evidence and Confidence",
    "Risks and Gaps",
    "Recommendations",
    "Review Notes",
  ],
  knowledge_pack: [
    "How to Use This Pack",
    "What’s Included",
    "Guided Reading Path",
    "Knowledge Entries",
    "Reuse Notes",
    "Evidence Index",
    "Review Notes",
  ],
  newsletter_issue: [
    "Editor’s Note",
    "Featured Items",
    "Why It Matters",
    "Further Reading",
    "Evidence Notes",
    "Review Notes",
  ],
  topic_report: [
    "Executive Overview",
    "Topic Landscape",
    "Key Themes and Findings",
    "Evidence and Confidence",
    "Risks, Gaps, and Open Questions",
    "Recommendations and Next Steps",
    "Review Notes",
  ],
};

const ASSET_QUALITY_CRITERIA: Record<AssetType, string[]> = {
  blog_post: [
    "Open with a concrete reader problem and state one clear thesis.",
    "Prefer readable narrative and examples over a catalogue of notes.",
    "End with a conclusion that answers the brief rather than merely summarizing sections.",
  ],
  research_brief: [
    "Make the Executive Summary decision-ready and concise.",
    "Separate findings from recommendations and label uncertainty explicitly.",
    "Tie every material risk or recommendation to evidence or mark it as a judgment.",
  ],
  knowledge_pack: [
    "Explain who should use the pack and in what order.",
    "Group knowledge into reusable entries rather than writing one continuous essay.",
    "Make each entry useful independently while preserving a guided reading path.",
  ],
  newsletter_issue: [
    "Maintain one editorial theme and a concise sendable rhythm.",
    "Explain why each featured item matters to the audience.",
    "Keep source grounding visible without turning the issue into a research report.",
  ],
  topic_report: [
    "Explain the topic landscape before presenting conclusions.",
    "Distinguish established knowledge, emerging signals, and unresolved questions.",
    "Make recommendations traceable to findings and explicit gaps.",
  ],
};

export function renderAssetGenerationContract(request: AssetGenerationRequest) {
  const requiredSections = ASSET_REQUIRED_SECTIONS[request.assetType];
  const qualityCriteria = ASSET_QUALITY_CRITERIA[request.assetType];
  const selectedReferences = [
    ...request.sourceRefs.map((id) => `[Source: ${id}]`),
    ...request.noteRefs.map((id) => `[Note: ${id}]`),
    ...request.wikiRefs.map((id) => `[Wiki: ${id}]`),
  ];

  return [
    `${assetTypeLabel(request.assetType)} delivery contract:`,
    "Return the final response as the editable Markdown deliverable itself, not as a description of how you would write it.",
    `Start with exactly one H1 using the working title: # ${request.title}`,
    "Use these required H2 sections in this order:",
    ...requiredSections.map((section) => `- ## ${section}`),
    "",
    "Evidence rules:",
    "- Read the explicitly selected knowledge records before relying on them.",
    "- Mark grounded claims inline with [Source: id], [Note: id], or [Wiki: id].",
    "- Never invent a citation. If a selected record is unavailable or does not support the claim, say so in Review Notes.",
    `- Selected reference markers: ${selectedReferences.join(", ") || "none"}`,
    "- Evidence Notes or Evidence Index must map the important claims to their reference markers.",
    "",
    "Type-specific quality criteria:",
    ...qualityCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Completion checklist:",
    "- The document directly answers the user’s objective and fits the named audience.",
    "- The requested style is applied without sacrificing clarity or evidence traceability.",
    "- Every selected reference was inspected or explicitly reported unavailable.",
    "- Unsupported claims, uncertainty, and remaining editorial work appear only in Review Notes.",
    "- Do not include tool logs, planning narration, or save/publish instructions in the deliverable.",
  ].join("\n");
}
