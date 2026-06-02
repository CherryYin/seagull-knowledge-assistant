export type AgentWorkflowSaveTarget =
  | "note"
  | "source_note"
  | "wiki_refresh"
  | "review"
  | "memory_candidate";

export interface AgentWorkflowTemplate {
  id: string;
  title: string;
  description: string;
  promptTemplate: string;
  outputSections: string[];
  saveTargets: AgentWorkflowSaveTarget[];
  requiredInput?: string;
  inputPlaceholder?: string;
}

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

export const AGENT_WORKFLOW_SAVE_TARGET_LABELS: Record<AgentWorkflowSaveTarget, string> = {
  note: "Save as Note",
  source_note: "Save as Source + Note",
  wiki_refresh: "Queue Wiki Refresh",
  review: "Send to Review",
  memory_candidate: "Create Memory Candidate",
};

export const AGENT_WORKFLOW_TEMPLATES: AgentWorkflowTemplate[] = [
  {
    id: "summarize-source",
    title: "Summarize Source",
    description: "Turn a saved source into a structured, durable summary.",
    requiredInput: "Source ID, source title, or focus area",
    inputPlaceholder: "Optional focus, source ID, or selected angle...",
    saveTargets: ["note", "source_note"],
    outputSections: [
      "Summary",
      "Key Ideas",
      "Related Knowledge",
      "Questions",
      "Recommended Actions",
      "Save Recommendation",
    ],
    promptTemplate: `You are summarizing a saved source for durable personal knowledge.
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
    title: "Organize Recent Imports",
    description: "Cluster recent imports and identify duplicates or next actions.",
    requiredInput: "Optional topic filter; defaults to recent 7 days",
    inputPlaceholder: "Optional topic filter, domain, or time window...",
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
    title: "Research Topic",
    description: "Research a question using existing knowledge first, then gaps.",
    requiredInput: "Research question",
    inputPlaceholder: "What should the agent research? Include scope/depth if useful...",
    saveTargets: ["note", "source_note"],
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
Cite Source/Note/Wiki/Memory references when available.
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
    id: "draft-wiki-refresh",
    title: "Draft Wiki Refresh",
    description: "Prepare a proposed wiki update without applying it.",
    requiredInput: "Wiki page, refresh suggestion, or evidence item",
    inputPlaceholder: "Wiki ID/title, trigger source/note, or update goal...",
    saveTargets: ["note", "wiki_refresh"],
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
Use new source/note/memory evidence to propose changes.
Separate proposed changes from the current wiki content.
Cite referenced Source/Note/Memory/Wiki IDs when available.
Do not save or apply anything automatically.

Output exactly these sections:

## Current Wiki Summary
## New Evidence
## Proposed Updates
## Open Questions
## Suggested Diff
## Apply Recommendation`,
  },
];

export function findAgentWorkflowTemplate(id?: string | null) {
  if (!id) return undefined;
  return AGENT_WORKFLOW_TEMPLATES.find((workflow) => workflow.id === id);
}

export function inferAgentWorkflowId(objectType?: string | null, promptSeed?: string) {
  if (objectType === "source") return "summarize-source";
  if (objectType === "discover") return "research-topic";
  if (promptSeed?.toLowerCase().includes("wiki")) return "draft-wiki-refresh";
  if (objectType === "note") return "organize-recent-imports";
  return undefined;
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
