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
  sourceRefs.push(...(assetDraft?.sourceRefs ?? []));
  noteRefs.push(...(assetDraft?.noteRefs ?? []));
  wikiRefs.push(...(assetDraft?.wikiRefs ?? []));
  const workflowTag = workflowId ? `workflow:${workflowId}` : "workflow:general-chat";

  if (target === "asset") {
    if (assetDraft) {
      const quality = assessAssetDraft(content, assetDraft);
      if (!quality.ready) {
        throw new Error(`Asset draft quality check failed: ${quality.blockingIssues.join(" ")}`);
      }
    }
    if (objectRef?.object_type === "asset" && objectRef.object_id) {
      return assetsApi.update(objectRef.object_id, { draft_content: content });
    }
    return assetsApi.create({
      title,
      brief: assetDraft?.brief,
      asset_type: assetDraft?.assetType ?? (workflowId === "draft-blog-asset" ? "blog_post" : "topic_report"),
      status: "draft",
      draft_content: content,
      source_refs: unique(sourceRefs),
      note_refs: unique(noteRefs),
      wiki_refs: unique(wikiRefs),
      style_notes: assetDraft?.styleNotes,
      metadata: {
        workflow_id: workflowId || null,
        audience: assetDraft?.audience || null,
        generation_mode: assetDraft ? "manual_request" : "workflow",
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
      derived_from_notes: noteRefs,
      derived_from_sources: sourceRefs,
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
    source_ids: sourceRefs,
    content,
  });
}
