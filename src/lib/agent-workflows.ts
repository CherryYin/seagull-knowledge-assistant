export type WorkflowResultSaveTarget =
  | "note"
  | "asset"
  | "wiki_draft"
  | "review_note";

export interface AgentWorkflowTemplate {
  id: string;
  group: "find" | "understand" | "decide" | "produce";
  title: string;
  description: string;
  promptTemplate: string;
  outputSections: string[];
  saveTargets: WorkflowResultSaveTarget[];
  requiredInput?: string;
  inputPlaceholder?: string;
}

export const AGENT_WORKFLOW_GROUP_LABELS: Record<AgentWorkflowTemplate["group"], string> = {
  find: "查找型",
  understand: "理解型",
  decide: "决策型",
  produce: "生产型",
};

export const AGENT_WORKFLOW_GROUP_DESCRIPTIONS: Record<AgentWorkflowTemplate["group"], string> = {
  find: "先找资料、聚合上下文、识别缺口。",
  understand: "先把单份材料或局部上下文讲清楚。",
  decide: "先判断哪些内容值得进入更稳定的知识层。",
  produce: "先起草面向输出的内容，但保持可 review。",
};

export interface AgentWorkflowContext {
  objectRef?: {
    title?: string;
    object_type?: string;
    object_id?: string;
    url?: string | null;
  };
  promptSeed?: string;
  userInput?: string;
}

export const AGENT_WORKFLOW_SAVE_TARGET_LABELS: Record<WorkflowResultSaveTarget, string> = {
  note: "Save as Personal Note",
  asset: "Save as Asset Draft",
  wiki_draft: "Save as Wiki Draft",
  review_note: "Save as Review Note",
};

export const AGENT_WORKFLOW_TEMPLATES: AgentWorkflowTemplate[] = [
  {
    id: "review-candidate-article",
    group: "decide",
    title: "审核 Candidate Article",
    description: "围绕 wiki mining 生成的 candidate article，检查证据、弱 claim、是否该继续 in review / accept as draft / merge。",
    requiredInput: "一篇 candidate article 或一组待审核 claims",
    inputPlaceholder: "例如：检查这篇 candidate article 的证据强度，判断是否能接受为 draft...",
    saveTargets: ["review_note", "wiki_draft"],
    outputSections: [
      "Article Summary",
      "Evidence Strength",
      "Weak Claims",
      "Decision Recommendation",
      "Next Review Action",
    ],
    promptTemplate: `Review this wiki candidate article as a draft-first knowledge artifact.
Check whether its claims are sufficiently supported by evidence.
Separate strong evidence from weak claims.
Recommend whether to keep it in review, accept it as a draft, or merge it into an existing wiki later.
Do not apply any changes automatically.

Output exactly these sections:

## Article Summary
## Evidence Strength
## Weak Claims
## Decision Recommendation
## Next Review Action`,
  },
  {
    id: "mine-wiki-candidates",
    group: "decide",
    title: "挖掘 Wiki 候选",
    description: "从 source、note 或近期导入里筛出更值得沉淀为 stable wiki 的候选，并给出可 review 的理由。",
    requiredInput: "一批材料、一个主题，或一个时间范围",
    inputPlaceholder: "例如：从最近导入里找出值得升级成 wiki 的主题...",
    saveTargets: ["review_note", "wiki_draft"],
    outputSections: [
      "Candidate Topics",
      "Why These Matter",
      "Supporting Evidence",
      "Open Gaps",
      "Review Queue Recommendation",
    ],
    promptTemplate: `Identify wiki candidates from the available knowledge context.
Prioritize topics that are recurring, reusable, and supported by multiple pieces of evidence.
Prefer stable wiki references when they already exist, and explain whether each candidate should refresh an existing wiki or start as a new draft.
Keep all outputs reviewable. Do not save anything automatically.

Output exactly these sections:

## Candidate Topics
## Why These Matter
## Supporting Evidence
## Open Gaps
## Review Queue Recommendation`,
  },
  {
    id: "review-discovery-batch",
    group: "find",
    title: "梳理 Discovery 候选",
    description: "把 discovery / paper discovery / web discovery 候选按主题聚类，判断哪些值得保存、研究或进入 wiki。",
    requiredInput: "一批 discovery items、一个主题或一个时间窗口",
    inputPlaceholder: "例如：整理这批 discovery 候选，找出最值得保存和继续研究的主题...",
    saveTargets: ["note", "review_note"],
    outputSections: [
      "Top Discoveries",
      "Topic Clusters",
      "What To Save",
      "What To Research Next",
      "Wiki Potential",
    ],
    promptTemplate: `Review discovery candidates as a triage workflow.
Cluster items into topics, identify which ones are worth saving, and flag which topics are promising inputs for wiki or deeper research.
Prefer reusable knowledge over one-off noisy links.
Do not save anything automatically.

Output exactly these sections:

## Top Discoveries
## Topic Clusters
## What To Save
## What To Research Next
## Wiki Potential`,
  },
  {
    id: "summarize-source",
    group: "understand",
    title: "理解这份材料",
    description: "把一份 Source 解释清楚，提炼重点，并指出它下一步更适合成为 Note 还是 Wiki Draft。",
    requiredInput: "一份 source、一个角度，或一个具体问题",
    inputPlaceholder: "例如：重点看这篇材料的核心论点 / 它和我已有知识有什么关系...",
    saveTargets: ["note"],
    outputSections: [
      "Summary",
      "Key Ideas",
      "Related Knowledge",
      "Questions",
      "Recommended Actions",
      "Save Recommendation",
    ],
    promptTemplate: `You are summarizing a saved source into a reusable summary draft.
Use the provided source context and search/read tools if needed.
Do not invent facts. Cite referenced Source/Note/Memory/Wiki IDs when available.
Do not save anything automatically; recommend what the user should save.

Output exactly these sections:

## Summary
## Key Ideas
## Related Knowledge
## Questions
## Recommended Actions
## Save Recommendation`,
  },
  {
    id: "organize-recent-imports",
    group: "find",
    title: "梳理最近导入",
    description: "从最近导入的 source 和 note 里找主题、重复项、缺口和下一步动作。",
    requiredInput: "可选主题、范围或时间窗口",
    inputPlaceholder: "例如：过去 7 天里和 agent / memory / wiki 相关的内容...",
    saveTargets: ["note"],
    outputSections: [
      "Clustered Topics",
      "Duplicates",
      "Suggested Links",
      "Suggested Updates",
      "Changes To Apply",
    ],
    promptTemplate: `Organize recently imported knowledge items.
Default to sources and notes imported in the last 7 days unless I provide a narrower filter.
Group related sources/notes into topics.
Identify duplicates, missing notes, and wiki refresh candidates.
Cite referenced Source/Note/Memory/Wiki IDs when available.
Do not write anything automatically.

Output exactly these sections:

## Clustered Topics
## Duplicates
## Suggested Links
## Suggested Updates
## Changes To Apply`,
  },
  {
    id: "research-topic",
    group: "find",
    title: "研究一个主题",
    description: "先查你已有知识，再识别缺口，形成一版可继续深入的研究结果。",
    requiredInput: "一个研究问题",
    inputPlaceholder: "例如：LangGraph 和 Strands 在 agent orchestration 上的差异是什么？",
    saveTargets: ["note"],
    outputSections: [
      "Question",
      "Existing Knowledge",
      "New Findings",
      "Evidence",
      "Open Questions",
      "Suggested Next Steps",
    ],
    promptTemplate: `Research this topic using my existing knowledge first.
If web search is available and requested, use it for gaps.
Separate existing knowledge from new findings.
Cite Source/Note/Wiki references when available.
Do not save automatically.

Output exactly these sections:

## Question
## Existing Knowledge
## New Findings
## Evidence
## Open Questions
## Suggested Next Steps`,
  },
  {
    id: "production-retrospective",
    group: "decide",
    title: "复盘生产输出",
    description: "基于 Production History 回顾最近生成、导出、发布与反馈，提炼有效渠道、内容类型和下一步策略。",
    requiredInput: "一个时间窗口、一个资产类型，或最近生产记录",
    inputPlaceholder: "例如：复盘最近 2 周 blog / brief 的输出和反馈，找出有效策略...",
    saveTargets: ["note", "review_note"],
    outputSections: [
      "Production Summary",
      "What Worked",
      "What Underperformed",
      "Channel Signals",
      "Next Production Moves",
    ],
    promptTemplate: `Review recent Production History to understand what has been generated, exported, published, and revised.
Look for repeated asset types, active channels, and feedback patterns.
Turn the production history into practical next-step recommendations.
Do not save anything automatically.

Output exactly these sections:

## Production Summary
## What Worked
## What Underperformed
## Channel Signals
## Next Production Moves`,
  },
  {
    id: "draft-wiki-refresh",
    group: "decide",
    title: "判断并起草下一步",
    description: "围绕一个 Wiki Page、Knowledge Record 或新证据，判断下一步该更新什么，并产出可审核草案。",
    requiredInput: "一个 Wiki Page、Knowledge Record，或一条新证据",
    inputPlaceholder: "例如：这份材料应该形成 Wiki Draft 吗？这页 Wiki 现在需要刷新吗？",
    saveTargets: ["note", "wiki_draft"],
    outputSections: [
      "Current Wiki Summary",
      "New Evidence",
      "Proposed Updates",
      "Open Questions",
      "Suggested Diff",
      "Apply Recommendation",
    ],
    promptTemplate: `Draft a wiki refresh proposal.
The existing wiki is stable knowledge; do not overwrite it.
Use new source/note evidence to propose changes.
Separate proposed changes from the current wiki content.
Cite referenced Source/Note/Wiki IDs when available.
Do not save or apply anything automatically.

Output exactly these sections:

## Current Wiki Summary
## New Evidence
## Proposed Updates
## Open Questions
## Suggested Diff
## Apply Recommendation`,
  },
  {
    id: "draft-blog-asset",
    group: "produce",
    title: "起草 Blog Asset",
    description: "把已有 Source、Note、Wiki Page 或其他 Knowledge Record 组织成可继续编辑的 Asset 草稿。",
    requiredInput: "一个主题、一个受众，或一批上下文材料",
    inputPlaceholder: "例如：把这个 wiki 主题整理成一篇面向工程师的博客草稿...",
    saveTargets: ["asset", "review_note"],
    outputSections: [
      "Audience",
      "Angle",
      "Outline",
      "Draft",
      "Evidence To Keep",
      "Publish Risks",
    ],
    promptTemplate: `Create an editable blog asset draft from the current knowledge context.
Treat wiki content as stable background context, and treat sources/notes as evidence.
Make the draft useful for later editing instead of pretending it is publication-ready.
Flag weak evidence, missing references, and claims that still need review.
Do not publish or save anything automatically.

Output exactly these sections:

## Audience
## Angle
## Outline
## Draft
## Evidence To Keep
## Publish Risks`,
  },
];

export function findAgentWorkflowTemplate(id?: string | null) {
  if (!id) return undefined;
  return AGENT_WORKFLOW_TEMPLATES.find((workflow) => workflow.id === id);
}

export function inferAgentWorkflowId(objectType?: string | null, promptSeed?: string) {
  if (objectType === "source") return "summarize-source";
  if (objectType === "discover") return "research-topic";
  if (objectType === "memory") return "draft-wiki-refresh";
  if (objectType === "wiki") return "draft-wiki-refresh";
  if (objectType === "asset") return "draft-blog-asset";
  if (objectType === "wiki_candidate_article") return "review-candidate-article";
  if (objectType === "production_history" || objectType === "production_memory") return "production-retrospective";
  if (promptSeed?.toLowerCase().includes("wiki")) return "draft-wiki-refresh";
  if (objectType === "note") return "organize-recent-imports";
  return undefined;
}

export function groupAgentWorkflowTemplates() {
  const orderedGroups: AgentWorkflowTemplate["group"][] = ["find", "understand", "decide", "produce"];
  return orderedGroups.map((group) => ({
    group,
    label: AGENT_WORKFLOW_GROUP_LABELS[group],
    description: AGENT_WORKFLOW_GROUP_DESCRIPTIONS[group],
    items: AGENT_WORKFLOW_TEMPLATES.filter((workflow) => workflow.group === group),
  })).filter((section) => section.items.length > 0);
}

export function renderAgentWorkflowPrompt(
  workflow: AgentWorkflowTemplate,
  context: AgentWorkflowContext = {}
) {
  const parts = [workflow.promptTemplate.trim()];
  const objectRef = context.objectRef;

  if (objectRef?.title || objectRef?.object_id || objectRef?.object_type || objectRef?.url) {
    parts.push(
      [
        "Context object:",
        objectRef.object_type ? `- Type: ${objectRef.object_type}` : null,
        objectRef.object_id ? `- ID: ${objectRef.object_id}` : null,
        objectRef.title ? `- Title: ${objectRef.title}` : null,
        objectRef.url ? `- URL: ${objectRef.url}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (context.promptSeed?.trim()) {
    parts.push(`Existing prompt/context from the current page:\n${context.promptSeed.trim()}`);
  }

  if (context.userInput?.trim()) {
    parts.push(`User input or focus:\n${context.userInput.trim()}`);
  }

  parts.push("Before answering, use available knowledge context when helpful. Do not expose internal tool names unless necessary for traceability.");

  return parts.join("\n\n");
}
