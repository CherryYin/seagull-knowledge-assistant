import { expect, test } from "@playwright/test";
import { createAssetJourneyReviewSnapshot, renderAssetJourneyReviewContext } from "../src/lib/asset-journey-review";
import { findAgentWorkflowTemplate, renderAgentWorkflowPrompt } from "../src/lib/agent-workflows";
import type { Asset, AssetVisual, AssetWorkspace } from "../src/lib/api/assets";

const asset: Asset = {
  id: "asset-review",
  user_id: "user-review",
  asset_type: "blog_post",
  status: "exported",
  title: "Journey under review",
  style_profile_id: "editorial_story",
  source_refs: [],
  note_refs: [],
  wiki_refs: [],
  draft_content: "Private document content must not be copied into the snapshot.",
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T02:00:00Z",
};

const visual: AssetVisual = {
  id: "visual-review",
  asset_id: asset.id,
  role: "cover",
  status: "accepted",
  prompt: "Private image prompt",
  model: "test-image-model",
  source_block_ids: [],
  processing_attempts: 2,
  created_at: "2026-10-12T00:00:00Z",
  started_at: "2026-10-12T00:00:30Z",
  completed_at: "2026-10-12T00:01:30Z",
  updated_at: "2026-10-12T00:01:30Z",
};

const input = {
  asset,
  currentTab: "production",
  hasUnsavedChanges: true,
  completedOptimizationRounds: 2,
  capturedAt: "2026-10-12T03:00:00Z",
};

test("journey snapshot preserves unknowns instead of inventing waits, retries, usage or adoption", () => {
  const snapshot = createAssetJourneyReviewSnapshot(input);
  expect(snapshot.observed_state.current_tab).toBe("production");
  expect(snapshot.observed_state.has_unsaved_changes).toBe(true);
  expect(snapshot.observed_state.current_evidence_count).toBeNull();
  expect(snapshot.observed_state.intent_confirmed).toBeNull();
  expect(snapshot.visual_tasks).toBeNull();
  expect(snapshot.measurement_limits.model_token_usage).toBe("not_recorded");
  expect(snapshot.measurement_limits.actual_adoption).toBe("requires_user_confirmation");
  expect(snapshot.measurement_limits.journey_retry_count).toBe("not_recorded");
  expect(snapshot.captured_at).toBe(input.capturedAt);
});

test("journey snapshot scopes evidence and claims to the current intent", () => {
  const workspace = {
    workspace_revision: 4,
    intent: { revision: 2 },
    evidence: [
      { intent_revision: 1, status: "accepted" },
      { intent_revision: 2, status: "proposed" },
      { intent_revision: 2, status: "accepted" },
    ],
    claims: [
      { intent_revision: 1, status: "accepted" },
      { intent_revision: 2, status: "hypothesis" },
    ],
  } as AssetWorkspace;
  const snapshot = createAssetJourneyReviewSnapshot({ ...input, workspace });
  expect(snapshot.observed_state.current_evidence_count).toBe(2);
  expect(snapshot.observed_state.accepted_evidence_count).toBe(1);
  expect(snapshot.observed_state.pending_evidence_count).toBe(1);
  expect(snapshot.observed_state.current_claim_count).toBe(1);
  expect(snapshot.observed_state.accepted_claim_count).toBe(1);
});

test("visual elapsed includes queueing and retries and never replaces missing or invalid timestamps with zero", () => {
  const snapshot = createAssetJourneyReviewSnapshot({ ...input, visuals: [
    visual,
    { ...visual, id: "unfinished", completed_at: null },
    { ...visual, id: "invalid", created_at: "invalid" },
    { ...visual, id: "reversed", completed_at: "2026-10-11T00:00:00Z" },
  ] });
  expect(snapshot.visual_tasks?.tasks.map(task => task.elapsed_including_queue_and_retries_seconds)).toEqual([90, null, null, null]);
  expect(snapshot.visual_tasks?.tasks[0].processing_attempts).toBe(2);
  expect(snapshot.measurement_limits.stage_wait_times).toBe("not_recorded");
});

test("snapshot bounds visual records and excludes documents, prompts and arbitrary metadata", () => {
  const snapshot = createAssetJourneyReviewSnapshot({
    ...input,
    asset: { ...asset, metadata_: { secret: "must-not-leak", publish_feedback: { feedback: "Not adopted: needs clearer recommendations." } } },
    visuals: Array.from({ length: 40 }, (_, index) => ({ ...visual, id: `visual-${index}` })),
  });
  expect(snapshot.visual_tasks?.total_count).toBe(40);
  expect(snapshot.visual_tasks?.included_count).toBe(30);
  expect(snapshot.recorded_user_feedback.publish_feedback).toContain("Not adopted");
  expect(JSON.stringify(snapshot)).not.toContain("Private document");
  expect(JSON.stringify(snapshot)).not.toContain("Private image prompt");
  expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
});

test("review workflow interviews users and only offers explicit Review Note saving", () => {
  const workflow = findAgentWorkflowTemplate("review-asset-journey");
  expect(workflow).toBeDefined();
  expect(workflow?.saveTargets).toEqual(["review_note"]);
  const prompt = renderAgentWorkflowPrompt(workflow!, { promptSeed: renderAssetJourneyReviewContext(input) });
  expect(prompt).toContain("short interview");
  expect(prompt).toContain("not automatic session analytics");
  expect(prompt).toContain("user_estimate");
  expect(prompt).toContain("Do not edit the Asset");
  expect(prompt).toContain('"id": "asset-review"');
});
