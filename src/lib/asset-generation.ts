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
  intakeMode?: "manual" | "agent_assisted";
  researchMode?: "local_only" | "local_then_web";
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

export interface AssetDraftQualityAssessment {
  ready: boolean;
  blockingIssues: string[];
  warnings: string[];
}

function normalizedHeading(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function markdownH2Sections(content: string) {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of content.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = normalizedHeading(heading[1]);
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  return new Map([...sections].map(([heading, lines]) => [heading, lines.join("\n").trim()]));
}

export function assessAssetDraft(content: string, request: AssetGenerationRequest): AssetDraftQualityAssessment {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const trimmed = content.trim();
  const sections = markdownH2Sections(trimmed);
  const title = trimmed.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();

  for (const required of ASSET_REQUIRED_SECTIONS[request.assetType]) {
    const sectionContent = sections.get(normalizedHeading(required));
    if (sectionContent === undefined) blockingIssues.push(`Missing required section: ${required}.`);
    else if (sectionContent.length < 10) blockingIssues.push(`Required section is empty or too thin: ${required}.`);
  }

  const expectedMarkers = [
    ...request.sourceRefs.map((id) => `[Source: ${id}]`),
    ...request.noteRefs.map((id) => `[Note: ${id}]`),
    ...request.wikiRefs.map((id) => `[Wiki: ${id}]`),
  ];
  const missingMarkers = expectedMarkers.filter((marker) => !trimmed.includes(marker));
  if (missingMarkers.length > 0) {
    blockingIssues.push(`Selected evidence is not cited: ${missingMarkers.join(", ")}.`);
  }

  if (/\b(?:TODO|TBD|FIXME|PLACEHOLDER|INSERT\s+HERE)\b|\[citation needed\]/i.test(trimmed)) {
    blockingIssues.push("Draft still contains unfinished placeholders or citation-needed markers.");
  }

  const reviewNotes = sections.get(normalizedHeading("Review Notes"));
  if (reviewNotes !== undefined && /^(?:none|n\/a|no review notes\.?|nothing)$/i.test(reviewNotes)) {
    blockingIssues.push("Review Notes is too shallow; record evidence gaps, uncertainty, or the explicit absence of remaining issues.");
  }

  if (!title) warnings.push("Draft does not start with an H1 title.");
  else if (request.title.trim() && normalizedHeading(title) !== normalizedHeading(request.title)) {
    warnings.push(`H1 title differs from the requested working title: ${request.title}.`);
  }
  if (trimmed.length < 500) warnings.push("Draft is unusually short for a finished deliverable.");

  return { ready: blockingIssues.length === 0, blockingIssues, warnings };
}

export function renderAssetDraftRepairRequest(
  request: AssetGenerationRequest,
  assessment: AssetDraftQualityAssessment,
) {
  const warningSection = assessment.warnings.length > 0
    ? ["", "Quality warnings to address when accurate:", ...assessment.warnings.map((warning) => `- ${warning}`)]
    : [];

  return [
    "Revise the immediately preceding Asset draft into a complete replacement document.",
    "The current draft failed the save quality gate. Fix every blocking issue below:",
    ...assessment.blockingIssues.map((issue) => `- ${issue}`),
    ...warningSection,
    "",
    "Return the full corrected Markdown document, not a patch, critique, plan, or explanation.",
    "Preserve useful grounded material, re-check the selected knowledge records, and do not invent evidence.",
    "The replacement must satisfy the original delivery contract in full:",
    renderAssetGenerationContract(request),
  ].join("\n");
}

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
    `Intake mode: ${request.intakeMode === "agent_assisted" ? "agent-assisted clarification" : "user-specified brief"}.`,
    `Research mode: ${request.researchMode === "local_then_web" ? "search PKG first, then run focused web research for at least one concrete freshness or evidence gap" : "PKG knowledge only"}.`,
    ...(request.intakeMode === "agent_assisted" ? [
      "Before drafting, assess whether the objective, audience, scope, decision to support, or constraints are materially ambiguous.",
      "If important ambiguity remains, call ask_user_question with no more than three concise questions and wait for the answers.",
      "Do not ask the user to manually locate knowledge records; discover relevant PKG evidence yourself.",
    ] : []),
    "Return the final response as the editable Markdown deliverable itself, not as a description of how you would write it.",
    request.title.trim()
      ? `Start with exactly one H1 using the working title: # ${request.title}`
      : "Start with exactly one H1 using a concise title inferred from the confirmed brief.",
    "Use these required H2 sections in this order:",
    ...requiredSections.map((section) => `- ## ${section}`),
    "",
    "Evidence rules:",
    "- Search PKG before drafting. Read the full relevant Source or Note when a read tool is available.",
    "- Read the explicitly selected knowledge records before relying on them.",
    ...(request.researchMode === "local_then_web" ? [
      "- After the PKG pass, identify a concrete freshness or evidence gap and call web_search at least once for that gap.",
      "- Keep web evidence visibly separate from PKG evidence and include its URL in the evidence section.",
      "- If web_search fails or returns no citeable URL, state that failure in Review Notes instead of claiming network research completed.",
    ] : ["- Do not use external web evidence for this request."]),
    "- Mark grounded claims inline with [Source: id], [Note: id], or [Wiki: id].",
    "- Never invent a citation. If a selected record is unavailable or does not support the claim, say so in Review Notes.",
    `- Selected reference markers: ${selectedReferences.join(", ") || "none"}`,
    "- Evidence Notes or Evidence Index must map the important claims to their reference markers.",
    "",
    "Type-specific quality criteria:",
    ...qualityCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Completion checklist:",
    `- The document directly answers the user’s objective and fits ${request.audience.trim() ? `the named audience (${request.audience})` : "the audience confirmed during intake"}.`,
    "- The requested style is applied without sacrificing clarity or evidence traceability.",
    "- Every selected reference was inspected or explicitly reported unavailable.",
    "- Unsupported claims, uncertainty, and remaining editorial work appear only in Review Notes.",
    "- Do not include tool logs, planning narration, or save/publish instructions in the deliverable.",
  ].join("\n");
}
