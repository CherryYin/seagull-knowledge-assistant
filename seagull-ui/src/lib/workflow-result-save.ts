import { assetsApi, notesApi, wikiApi, type ReferenceInfo } from "@/lib/api";
import type { AgentWorkflowContext, WorkflowResultSaveTarget } from "@/lib/agent-workflows";
import { assessAssetDraft, type AssetGenerationRequest } from "@/lib/asset-generation";

interface SaveWorkflowResultInput {
  target: WorkflowResultSaveTarget;
  sessionId: string;
  workflowId?: string | null;
  content: string;
  title?: string | null;
  categoryId?: number;
  objectRef?: AgentWorkflowContext["objectRef"];
  references?: ReferenceInfo[];
  assetDraft?: AssetGenerationRequest;
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function deriveTitle(content: string, explicitTitle?: string | null) {
  return explicitTitle?.trim()
    || content.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 80)
    || "Agent output";
}

function deriveOutline(content: string) {
  return content
    .split("\n")
    .filter((line) => /^#{1,3}\s+\S/.test(line.trim()))
    .join("\n");
}

function collectReferences(
  references: ReferenceInfo[] = [],
  objectRef?: AgentWorkflowContext["objectRef"]
) {
  const sourceRefs = references.filter((reference) => reference.type === "source").map((reference) => reference.id);
  const noteRefs = references.filter((reference) => reference.type === "note").map((reference) => reference.id);
  const wikiRefs: string[] = [];

  if (objectRef?.object_id) {
    if (objectRef.object_type === "source") sourceRefs.push(objectRef.object_id);
    if (objectRef.object_type === "note") noteRefs.push(objectRef.object_id);
    if (objectRef.object_type === "wiki") wikiRefs.push(objectRef.object_id);
  }

  return {
    sourceRefs: unique(sourceRefs),
    noteRefs: unique(noteRefs),
    wikiRefs: unique(wikiRefs),
  };
}

function collectInlineKnowledgeReferences(content: string) {
  const sourceRefs: string[] = [];
  const noteRefs: string[] = [];
  const wikiRefs: string[] = [];
  for (const match of content.matchAll(/\[(Source|Note|Wiki):\s*([^\]\s]+)\]/g)) {
    const [, type, id] = match;
    if (type === "Source") sourceRefs.push(id);
    if (type === "Note") noteRefs.push(id);
    if (type === "Wiki") wikiRefs.push(id);
  }
  return {
    sourceRefs: unique(sourceRefs),
    noteRefs: unique(noteRefs),
    wikiRefs: unique(wikiRefs),
  };
}

async function resolvePersistableReferences({
  sourceRefs,
  noteRefs,
  wikiRefs,
}: {
  sourceRefs: string[];
  noteRefs: string[];
  wikiRefs: string[];
}) {
  const requested = [
    ...unique(sourceRefs).map((id) => ({ ref_type: "source", ref_id: id })),
    ...unique(noteRefs).map((id) => ({ ref_type: "note", ref_id: id })),
    ...unique(wikiRefs).map((id) => ({ ref_type: "wiki", ref_id: id })),
  ];
  if (requested.length === 0) return { sourceRefs: [], noteRefs: [], wikiRefs: [] };

  const resolved = await wikiApi.resolveReferences(requested);
  return {
    sourceRefs: unique(resolved.items.filter((item) => item.ref_type === "source").map((item) => item.ref_id)),
    noteRefs: unique(resolved.items.filter((item) => item.ref_type === "note").map((item) => item.ref_id)),
    wikiRefs: unique(resolved.items.filter((item) => item.ref_type === "wiki").map((item) => item.ref_id)),
  };
}

export async function saveWorkflowResult({
  target,
  sessionId,
  workflowId,
  content,
  title: explicitTitle,
  categoryId,
  objectRef,
  references,
  assetDraft,
}: SaveWorkflowResultInput) {
  const title = deriveTitle(content, assetDraft?.title || explicitTitle);
  const { sourceRefs, noteRefs, wikiRefs } = collectReferences(references, objectRef);
  const inlineReferences = collectInlineKnowledgeReferences(content);
  sourceRefs.push(...inlineReferences.sourceRefs);
  noteRefs.push(...inlineReferences.noteRefs);
  wikiRefs.push(...inlineReferences.wikiRefs);
  sourceRefs.push(...(assetDraft?.sourceRefs ?? []));
  noteRefs.push(...(assetDraft?.noteRefs ?? []));
  wikiRefs.push(...(assetDraft?.wikiRefs ?? []));
  const persistableReferences = await resolvePersistableReferences({ sourceRefs, noteRefs, wikiRefs });
  const workflowTag = workflowId ? `workflow:${workflowId}` : "workflow:general-chat";

  if (target === "asset") {
    if (assetDraft) {
      const quality = assessAssetDraft(content, assetDraft);
      if (!quality.ready) {
        throw new Error(`Asset draft quality check failed: ${quality.blockingIssues.join(" ")}`);
      }
    }
    const existingAssetId = objectRef?.object_type === "asset" ? objectRef.object_id : assetDraft?.assetId;
    if (existingAssetId) {
      const existing = await assetsApi.get(existingAssetId);
      return assetsApi.update(existingAssetId, {
        draft_content: content,
        outline: existing.outline?.trim() || deriveOutline(content),
        source_refs: unique([...(existing.source_refs ?? []), ...persistableReferences.sourceRefs]),
        note_refs: unique([...(existing.note_refs ?? []), ...persistableReferences.noteRefs]),
        wiki_refs: unique([...(existing.wiki_refs ?? []), ...persistableReferences.wikiRefs]),
      });
    }
    return assetsApi.create({
      title,
      brief: assetDraft?.brief,
      asset_type: assetDraft?.assetType ?? (workflowId === "draft-blog-asset" ? "blog_post" : "topic_report"),
      status: "draft",
      draft_content: content,
      outline: deriveOutline(content),
      source_refs: persistableReferences.sourceRefs,
      note_refs: persistableReferences.noteRefs,
      wiki_refs: persistableReferences.wikiRefs,
      style_notes: assetDraft?.styleNotes,
      metadata: {
        workflow_id: workflowId || null,
        audience: assetDraft?.audience || null,
        generation_mode: assetDraft?.intakeMode === "agent_assisted" ? "agent_assisted" : assetDraft ? "manual_request" : "workflow",
        research_mode: assetDraft?.researchMode || null,
      },
      provenance: {
        origin_type: "harness_session",
        origin_ref: sessionId,
        action: "save",
      },
    });
  }

  if (target === "wiki_draft") {
    return wikiApi.create({
      title,
      page_type: "topic",
      content,
      tags: ["wiki-draft", "from-agent", "explicit-save", workflowTag, `harness-session:${sessionId}`],
      derived_from_notes: persistableReferences.noteRefs,
      derived_from_sources: persistableReferences.sourceRefs,
    });
  }

  if (!categoryId) {
    throw new Error("No category is available for the saved note.");
  }

  return notesApi.create({
    title,
    category_id: categoryId,
    note_type: "inbox",
    status: "kept",
    confidence: "medium",
    tags: [
      target === "review_note" ? "review-candidate" : "personal-note",
      "from-agent",
      "explicit-save",
      workflowTag,
      `harness-session:${sessionId}`,
    ],
    domains: [target === "review_note" ? "review" : "agent-output"],
    source_ids: persistableReferences.sourceRefs,
    content,
  });
}
