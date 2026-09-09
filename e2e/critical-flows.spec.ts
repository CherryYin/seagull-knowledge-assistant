import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-08-23T08:00:00.000Z";
const validResearchBrief = `# E2E Research Brief

## Executive Summary
E2E answer with a durable result. It is intended for architecture reviewers.

## Key Findings
The selected source supports a focused architecture decision. [Source: source-input]

## Evidence and Confidence
Confidence is medium because this draft currently relies on one selected source. [Source: source-input]

## Risks and Gaps
The recommendation should be reviewed against implementation constraints before adoption.

## Recommendations
Review the evidence with the architecture group and record the final decision explicitly.

## Review Notes
The selected evidence is sufficient for this draft; final editorial review should confirm wording.`;

type MockState = {
  loggedIn: boolean;
  savedNoteBody: Record<string, unknown> | null;
  savedAssetBody: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  memory: Record<string, unknown> | null;
  sessionContext: Record<string, unknown> | null;
  chatResponse?: string;
  chatPrompts?: string[];
  chatRequests?: Array<Record<string, unknown>>;
  chatSessions?: Array<Record<string, unknown>>;
  harnessSessionIds?: string[];
  htmlPreviewRequests?: number;
  htmlExportRequests?: number;
  newsletterAutomation?: Record<string, unknown>;
  assetWorkspace?: Record<string, unknown>;
  qualityAudit?: Record<string, unknown>;
  documentOptimizationCalls?: number;
  intentResponseModes?: Array<"tool-call" | "tool-result" | "text-only">;
  evidenceProposalConflictOnce?: boolean;
};

const intentProposal = {
  workingTitle: "Agent proposed title",
  question: "What decision should this Asset support?",
  goal: "Produce a decision-ready synthesis.",
  audience: "Architecture reviewers",
  creationMode: "make_decision",
  scope: ["Current architecture"],
  constraints: ["Use accepted evidence"],
  rationale: "The proposal turns the initial topic into a concrete decision contract.",
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMockBff(page: Page, state: MockState) {
  await page.route(`${apiBase}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/login" && method === "POST") {
      state.loggedIn = true;
      return json(route, { access_token: "e2e-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return state.loggedIn
        ? json(route, {
            id: "user-e2e",
            username: "e2e-user",
            display_name: "E2E User",
            role: "user",
            approval_status: "approved",
            is_active: true,
          })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/logout") return json(route, { ok: true });
    if (path === "/api/auth/me/settings/publishing") return json(route, { primary_site_url: "https://publish.example.com", default_channel: "Blog", updated_at: now });

    if (path === "/api/chat-sessions" && method === "GET") {
      return json(route, { items: state.chatSessions ?? [], total: state.chatSessions?.length ?? 0 });
    }
    if (path === "/api/chat-sessions" && method === "POST") {
      const body = request.postDataJSON() as { id?: string; title?: string; messages?: unknown[] };
      const session = {
        id: body.id ?? "session-e2e",
        title: body.title ?? "New Chat",
        messages: body.messages ?? [],
        created_at: now,
        updated_at: now,
      };
      state.chatSessions = [session, ...(state.chatSessions ?? []).filter((item) => item.id !== session.id)];
      return json(route, session);
    }
    if (path.startsWith("/api/chat-sessions/") && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const session = {
        id: path.split("/").at(-1),
        title: body.title ?? "E2E Chat",
        messages: body.messages ?? [],
        created_at: now,
        updated_at: now,
      };
      state.chatSessions = [session, ...(state.chatSessions ?? []).filter((item) => item.id !== session.id)];
      return json(route, session);
    }
    if (path === "/api/chat" && method === "POST") {
      const body = request.postDataJSON() as { prompt?: string; preset?: string; session_id?: string };
      state.chatPrompts = [...(state.chatPrompts ?? []), body.prompt ?? ""];
      state.chatRequests = [...(state.chatRequests ?? []), body as Record<string, unknown>];
      state.harnessSessionIds = [...(state.harnessSessionIds ?? []), body.session_id ?? ""];
      if (body.preset === "clarify-asset-intent") {
        const responseMode = state.intentResponseModes?.shift() ?? "tool-call";
        const proposalEvent = responseMode === "tool-result"
          ? { type: "tool_result", tool: "propose_asset_intent", result: JSON.stringify(intentProposal) }
          : { type: "tool_call", tool: "propose_asset_intent", args: intentProposal };
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            `data: ${JSON.stringify({ type: "session", session_id: body.session_id })}`,
            "",
            `data: ${JSON.stringify({ type: "text", content: "I prepared a structured Intent proposal." })}`,
            "",
            ...(responseMode === "text-only" ? [] : [`data: ${JSON.stringify(proposalEvent)}`, ""]),
            `data: ${JSON.stringify({ type: "done", session_id: body.session_id })}`,
            "",
          ].join("\n"),
        });
      }
      if (body.preset === "revise-asset-block") {
        const blockId = body.prompt?.match(/"block_id":\s*"([^"]+)"/)?.[1] ?? "block-e2e";
        const baseRevision = Number(body.prompt?.match(/"base_revision":\s*(\d+)/)?.[1] ?? 1);
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'data: {"type":"session","session_id":"block-session-e2e"}',
            "",
            `data: ${JSON.stringify({ type: "tool_call", tool: "propose_asset_block_patch", args: {
              assetId: "asset-e2e",
              blockId,
              baseRevision,
              replacementMarkdown: "Agent revised paragraph with clearer evidence. [Source: source-input]",
              explanation: "Clarifies the claim while preserving its evidence marker.",
            } })}`,
            "",
            'data: {"type":"done","session_id":"block-session-e2e"}',
            "",
          ].join("\n"),
        });
      }
      if (body.preset === "analyze-asset-claims") {
        const contractText = body.prompt?.match(/\{[\s\S]*\}$/)?.[0] ?? "{}";
        const contract = JSON.parse(contractText) as { assetId?: string; baseWorkspaceRevision?: number; intentRevision?: number; evidence?: Array<{ id: string }> };
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'data: {"type":"session","session_id":"claim-session-e2e"}',
            "",
            `data: ${JSON.stringify({ type: "tool_call", tool: "propose_asset_claims", args: {
              assetId: contract.assetId,
              baseWorkspaceRevision: contract.baseWorkspaceRevision,
              intentRevision: contract.intentRevision,
              proposals: [{
                content: "The selected evidence supports a focused architecture decision.",
                kind: "recommendation",
                supportingEvidence: [contract.evidence?.[0]?.id],
                contradictingEvidence: [],
                agentConfidence: "medium",
              }],
            } })}`,
            "",
            'data: {"type":"done","session_id":"claim-session-e2e"}',
            "",
          ].join("\n"),
        });
      }
      if (body.preset === "collect-asset-evidence") {
        const contractText = body.prompt?.match(/\{[\s\S]*\}$/)?.[0] ?? "{}";
        const contract = JSON.parse(contractText) as { assetId?: string; baseWorkspaceRevision?: number; intentRevision?: number };
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'data: {"type":"session","session_id":"evidence-session-e2e"}',
            "",
            `data: ${JSON.stringify({ type: "tool_call", tool: "propose_asset_evidence", args: {
              assetId: contract.assetId,
              baseWorkspaceRevision: contract.baseWorkspaceRevision,
              intentRevision: contract.intentRevision,
              proposals: [{
                targetType: "note",
                targetId: "note-input",
                relation: "supports",
                summary: "A second collection adds a relevant supporting note.",
              }],
            } })}`,
            "",
            'data: {"type":"done","session_id":"evidence-session-e2e"}',
            "",
          ].join("\n"),
        });
      }
      if (body.preset === "revise-asset-document") {
        const contractText = body.prompt?.match(/\{[\s\S]*\}$/)?.[0] ?? "{}";
        const contract = JSON.parse(contractText) as {
          optimizationRound?: number;
          baseWorkspaceRevision?: number;
          baseDocumentSignature?: string;
          asset?: { title?: string; brief?: string; blocks?: Array<{ blockId: string; baseRevision: number; markdown: string; claimRefs?: string[] }> };
        };
        const round = contract.optimizationRound ?? 1;
        const replacementBlocks = [
          { markdown: `# E2E Optimized Asset Round ${round}`, claimRefs: [] },
          { markdown: `Round ${round} fully rewritten evidence-backed paragraph.`, claimRefs: ["claim-1"] },
        ];
        const normalizedPatch = {
          assetId: "asset-e2e",
          baseWorkspaceRevision: contract.baseWorkspaceRevision ?? 0,
          rewriteMode: "replace_document",
          baseDocumentSignature: contract.baseDocumentSignature,
          replacementTitle: `E2E Optimized Asset Round ${round}`,
          replacementBrief: `A reviewable Asset refined in optimization round ${round}.`,
          explanation: `Completed optimization round ${round}.`,
          blocks: [],
          replacementBlocks,
        };
        state.documentOptimizationCalls = (state.documentOptimizationCalls ?? 0) + 1;
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            `data: ${JSON.stringify({ type: "session", session_id: `document-session-round-${round}` })}`,
            "",
            `data: ${JSON.stringify({ type: "tool_call", tool: "propose_asset_document_patch", args: {
              ...normalizedPatch,
              replacementBlocks: JSON.stringify(replacementBlocks),
            } })}`,
            "",
            `data: ${JSON.stringify({ type: "tool_result", tool: "propose_asset_document_patch", result: JSON.stringify(normalizedPatch) })}`,
            "",
            `data: ${JSON.stringify({ type: "done", session_id: `document-session-round-${round}` })}`,
            "",
          ].join("\n"),
        });
      }
      const content = state.chatResponse ?? validResearchBrief;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'data: {"type":"session","session_id":"session-e2e"}',
          "",
          `data: ${JSON.stringify({ type: "text", content })}`,
          "",
          'data: {"type":"done","session_id":"session-e2e"}',
          "",
        ].join("\n"),
      });
    }
    if (path.startsWith("/api/harness/session-contexts/")) {
      if (method === "GET") return json(route, { context: state.sessionContext });
      if (method === "PUT") {
        state.sessionContext = {
          ...(request.postDataJSON() as Record<string, unknown>),
          workflowId: "draft-asset",
        };
        return json(route, { context: state.sessionContext });
      }
      if (method === "DELETE") {
        state.sessionContext = null;
        return json(route, {}, 204);
      }
    }

    if (path === "/api/harness/models") return json(route, { models: [], failures: [] });
    if (path === "/api/knowledge/models") return json(route, []);
    if (path === "/api/categories") {
      return json(route, { items: [{ id: 1, name: "Inbox", color: "#64748b", created_at: now }], total: 1 });
    }
    if (path === "/api/notes" && method === "POST") {
      state.savedNoteBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { id: "note-e2e", ...state.savedNoteBody, created_at: now, updated_at: now });
    }
    if (path === "/api/assets" && method === "POST") {
      state.savedAssetBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { id: "asset-e2e", ...state.savedAssetBody, created_at: now, updated_at: now });
    }
    if (path === "/api/assets/knowledge-lineage" && method === "GET") {
      const targetType = url.searchParams.get("target_type") as "note" | "wiki";
      const targetId = url.searchParams.get("target_id") ?? "";
      return json(route, {
        target_type: targetType,
        target_id: targetId,
        items: [{
          asset_id: "asset-e2e",
          asset_title: "E2E Distillation Asset",
          asset_type: "research_brief",
          asset_status: "draft",
          relation: "distilled",
          candidate_id: `candidate-${targetType}`,
          candidate_type: targetType,
          candidate_action: "create",
          claim_refs: ["claim-1"],
          contribution_summary: "Reusable knowledge distilled from reviewed claims.",
          promoted_at: now,
        }],
      });
    }
    if (path === "/api/assets/newsletter/automation" && method === "GET") {
      return json(route, state.newsletterAutomation ?? {
        enabled: false,
        name: "Technology Newsletter",
        topics: [],
        frequency: "weekly",
        hour_utc: 1,
        weekday_utc: 4,
        lookback_days: 7,
        max_news_items: 8,
        max_paper_items: 5,
        delivery_format: "html",
        audience: "Technology readers",
        style_notes: "Concise, evidence-led, and easy to scan.",
        last_generated_at: null,
        last_asset_id: null,
      });
    }
    if (path === "/api/assets/newsletter/automation" && method === "PUT") {
      state.newsletterAutomation = { ...(request.postDataJSON() as Record<string, unknown>), last_generated_at: null, last_asset_id: null };
      return json(route, state.newsletterAutomation);
    }
    if (path === "/api/assets/newsletter/automation/run" && method === "POST") {
      state.savedAssetBody = {
        title: "E2E Tech Weekly · 2026-09-03",
        brief: "Automated technology newsletter.",
        asset_type: "newsletter_issue",
        status: "draft",
        draft_content: "# E2E Tech Weekly\n\n## Featured Items\n\nA reviewable newsletter draft.",
        source_refs: ["source-input"],
        note_refs: [],
        wiki_refs: [],
        metadata_: { delivery_format: "html", generation_mode: "newsletter_automation" },
      };
      state.newsletterAutomation = { ...state.newsletterAutomation, last_generated_at: now, last_asset_id: "asset-e2e" };
      return json(route, {
        status: "generated",
        news_count: 1,
        paper_count: 1,
        asset: { id: "asset-e2e", user_id: "user-e2e", ...state.savedAssetBody, created_at: now, updated_at: now },
      });
    }
    if (path === "/api/assets/asset-e2e" && method === "GET") {
      return json(route, { id: "asset-e2e", user_id: "user-e2e", ...state.savedAssetBody, metadata_: state.savedAssetBody?.metadata ?? state.savedAssetBody?.metadata_ ?? null, source_refs: state.savedAssetBody?.source_refs ?? [], note_refs: state.savedAssetBody?.note_refs ?? [], wiki_refs: state.savedAssetBody?.wiki_refs ?? [], created_at: now, updated_at: now });
    }
    if (path === "/api/assets/asset-e2e" && method === "PATCH") {
      state.savedAssetBody = { ...state.savedAssetBody, ...(request.postDataJSON() as Record<string, unknown>) };
      return json(route, { id: "asset-e2e", user_id: "user-e2e", ...state.savedAssetBody, metadata_: state.savedAssetBody?.metadata ?? state.savedAssetBody?.metadata_ ?? null, source_refs: state.savedAssetBody?.source_refs ?? [], note_refs: state.savedAssetBody?.note_refs ?? [], wiki_refs: state.savedAssetBody?.wiki_refs ?? [], created_at: now, updated_at: now });
    }
    if (path === "/api/assets/asset-e2e/workspace/intent" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.assetWorkspace = {
        asset_id: "asset-e2e",
        workspace_revision: 1,
        intent: {
          revision: 1,
          question: body.question,
          goal: body.goal,
          audience: body.audience,
          creation_mode: body.creation_mode,
          scope: body.scope,
          constraints: body.constraints,
          status: "confirmed",
          confirmed_by: "user-e2e",
          confirmed_at: now,
        },
        intent_history: [],
        evidence: [],
        claims: [],
        contribution: null,
        knowledge_candidates: [],
        decision_items: [],
      };
      return json(route, state.assetWorkspace);
    }
    if (path === "/api/assets/asset-e2e/workspace/evidence/proposals" && method === "POST") {
      const body = request.postDataJSON() as { base_workspace_revision?: number; proposals?: Array<Record<string, unknown>> };
      const workspace = state.assetWorkspace as Record<string, unknown>;
      if (state.evidenceProposalConflictOnce) {
        state.evidenceProposalConflictOnce = false;
        state.assetWorkspace = { ...workspace, workspace_revision: Number(workspace.workspace_revision ?? 0) + 1 };
        return json(route, { detail: "Asset workspace revision changed" }, 409);
      }
      if (body.base_workspace_revision !== workspace.workspace_revision) {
        return json(route, { detail: `Asset workspace revision changed: expected ${body.base_workspace_revision}, current ${workspace.workspace_revision}` }, 409);
      }
      const evidence = (body.proposals ?? []).map((item, index) => ({
        id: `evidence-${(((workspace.evidence as unknown[]) ?? []).length) + index + 1}`,
        ...item,
        status: "proposed",
        authorship: "agent",
        intent_revision: 1,
        created_at: now,
      }));
      state.assetWorkspace = { ...workspace, workspace_revision: Number(workspace.workspace_revision ?? 0) + 1, evidence: [...((workspace.evidence as unknown[]) ?? []), ...evidence] };
      return json(route, state.assetWorkspace);
    }
    const evidenceDecisionMatch = path.match(/^\/api\/assets\/asset-e2e\/workspace\/evidence\/([^/]+)\/decision$/);
    if (evidenceDecisionMatch && method === "POST") {
      const body = request.postDataJSON() as { decision?: "accepted" | "rejected" };
      const workspace = state.assetWorkspace as Record<string, unknown>;
      const evidence = ((workspace.evidence as Array<Record<string, unknown>>) ?? []).map((item) => item.id === evidenceDecisionMatch[1]
        ? { ...item, status: body.decision, decided_by: "user-e2e", decided_at: now }
        : item);
      state.assetWorkspace = { ...workspace, workspace_revision: Number(workspace.workspace_revision ?? 0) + 1, evidence };
      return json(route, state.assetWorkspace);
    }
    if (path === "/api/assets/asset-e2e/workspace/claims/proposals" && method === "POST") {
      const body = request.postDataJSON() as { proposals?: Array<Record<string, unknown>> };
      const workspace = state.assetWorkspace as Record<string, unknown>;
      const claims = (body.proposals ?? []).map((item, index) => ({
        id: `claim-${index + 1}`,
        ...item,
        status: "proposed",
        authorship: "agent",
        intent_revision: 1,
        created_at: now,
        user_edited: false,
      }));
      state.assetWorkspace = { ...workspace, workspace_revision: Number(workspace.workspace_revision ?? 0) + 1, claims };
      return json(route, state.assetWorkspace);
    }
    const claimDecisionMatch = path.match(/^\/api\/assets\/asset-e2e\/workspace\/claims\/([^/]+)\/decision$/);
    if (claimDecisionMatch && method === "POST") {
      const body = request.postDataJSON() as { decision?: string };
      const workspace = state.assetWorkspace as Record<string, unknown>;
      const statuses: Record<string, string> = { accept: "accepted", edit_and_accept: "accepted", reject: "rejected", keep_as_hypothesis: "hypothesis", need_more_evidence: "needs_more_evidence" };
      const claims = ((workspace.claims as Array<Record<string, unknown>>) ?? []).map((item) => item.id === claimDecisionMatch[1]
        ? { ...item, status: statuses[body.decision ?? ""] ?? item.status, decided_by: "user-e2e", decided_at: now }
        : item);
      state.assetWorkspace = { ...workspace, workspace_revision: Number(workspace.workspace_revision ?? 0) + 1, claims };
      return json(route, state.assetWorkspace);
    }
    if (path === "/api/assets/asset-e2e/workspace" && method === "GET") {
      return json(route, state.assetWorkspace ?? {
        asset_id: "asset-e2e",
        workspace_revision: 0,
        intent: null,
        intent_history: [],
        evidence: [],
        claims: [],
        contribution: null,
        knowledge_candidates: [],
        decision_items: [],
      });
    }
    if (path === "/api/assets/asset-e2e/quality-audit" && method === "GET") {
      return json(route, state.qualityAudit ?? {
        asset_id: "asset-e2e",
        workspace_revision: 0,
        verdict: "warn",
        score: 4.5,
        blocking_findings: [],
        warnings: [{ id: "PKG-CANDIDATE-001", severity: "P1", title: "Draft is not linked to a Knowledge Candidate", detail: "Create a candidate so claims and evidence remain traceable." }],
        metrics: { intent: 0, candidate_count: 0, claim_count: 0, evidence_count: 0 },
      });
    }
    if (path === "/api/assets/asset-e2e/check-readiness") {
      return json(route, { ready: false, blocking_reasons: ["Review the draft before export"], warning_reasons: [], suggestion_reasons: [] });
    }
    if (path === "/api/assets/asset-e2e/preview/html" && method === "GET") {
      state.htmlPreviewRequests = (state.htmlPreviewRequests ?? 0) + 1;
      return json(route, { asset_id: "asset-e2e", export_format: "html", content: "<!doctype html><html><body><main><h1>HTML Preview Asset</h1><p>Rendered safely.</p></main></body></html>" });
    }
    if (path === "/api/assets/asset-e2e/export/html" && method === "POST") {
      state.htmlExportRequests = (state.htmlExportRequests ?? 0) + 1;
      state.savedAssetBody = { ...state.savedAssetBody, status: "exported", export_format: "html" };
      return json(route, { asset_id: "asset-e2e", export_format: "html", content: "<!doctype html><html><body><h1>HTML Export Asset</h1></body></html>" });
    }

    if (path === "/api/harness/memory-candidates" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.candidate = {
        id: "candidate-e2e",
        ...body,
        status: "pending",
        createdAt: now,
        decidedAt: null,
      };
      return json(route, state.candidate);
    }
    if (path === "/api/harness/memory-candidates/candidate-e2e/accept" && method === "POST") {
      state.candidate = { ...state.candidate, status: "accepted", decidedAt: now };
      state.memory = {
        id: "memory-e2e",
        scopeType: "global",
        scopeId: null,
        kind: "preference",
        title: state.candidate?.title,
        content: state.candidate?.content,
        status: "active",
        provenance: state.candidate?.provenance,
        confirmedAt: now,
        lastUsedAt: null,
        updatedAt: now,
      };
      return json(route, { candidate: state.candidate, memory: state.memory });
    }
    if (path === "/api/harness/memories") {
      return json(route, {
        candidates: state.candidate ? [state.candidate] : [],
        memories: state.memory ? [state.memory] : [],
      });
    }
    if (path === "/api/harness/memory-recalls") return json(route, { items: [] });

    if (path === "/api/discovery") {
      return json(route, {
        items: [{
          id: "discovery-e2e",
          provider: "paper",
          title: "E2E Paper Candidate",
          summary: "A paper waiting for explicit review.",
          payload: { item_type: "paper" },
          why: ["Matches the current research topic"],
          status: "recommended",
          created_at: now,
        }],
        total: 1,
      });
    }
    if (path === "/api/notes" && method === "GET") {
      if (url.searchParams.get("note_type") === "digest") return json(route, { items: [], total: 0 });
      return json(route, { items: [{ id: "note-input", title: "E2E Knowledge Note", note_type: "inbox", status: "kept", category_id: 1, domains: [], tags: [], confidence: "medium", source_ids: [], created_at: now, updated_at: now }], total: 1 });
    }
    if (path === "/api/notes/note-input" && method === "GET") {
      return json(route, { id: "note-input", title: "E2E Knowledge Note", note_type: "concept", status: "seed", category_id: 1, category_name: "Inbox", abstract: "A distilled note.", content: "# Distilled Note\n\nReusable knowledge.", project: null, domains: [], tags: ["asset-promotion"], confidence: "medium", source_ids: [], file_path: null, word_count: 4, is_pinned: false, created_at: now, updated_at: now });
    }
    if (path === "/api/wiki/suggestions") return json(route, { items: [], total: 0 });
    if (path === "/api/wiki/mining/runs") return json(route, { items: [], total: 0 });
    if (path === "/api/sources") return json(route, { items: [{ id: "source-input", title: "E2E Source Evidence", source_type: "web", category_id: 1, url: "https://example.com/articles", ingested_at: now, metadata_: { web_directory_enabled: true } }], total: 1 });
    if (path === "/api/sources/source-input") {
      return json(route, {
        id: "source-input",
        title: "E2E Source Evidence",
        source_type: "web",
        url: "https://example.com/articles",
        category_id: 1,
        category_name: "Inbox",
        raw_content: "Evidence collected for the Asset handoff regression.\nSecond visible line.",
        metadata_: { web_directory_enabled: true },
        ingested_at: now,
      });
    }
    if (path === "/api/sources/source-input/chunk-count") return json(route, { count: 1 });
    if (path === "/api/sources/source-input/articles") return json(route, { items: [], total: 0 });
    if (path === "/api/sources/source-rss") {
      return json(route, {
        id: "source-rss",
        title: "E2E RSS Feed",
        source_type: "web",
        category_id: 1,
        category_name: "Inbox",
        url: "https://example.com/feed.xml",
        raw_content: "Latest RSS entries",
        metadata_: { rss_enabled: "true", feed_title: "E2E RSS Feed" },
        ingested_at: now,
      });
    }
    if (path === "/api/sources/source-rss/chunk-count") return json(route, { count: 1 });
    if (path === "/api/sources/source-rss/articles") return json(route, { items: [], total: 0 });
    if (path === "/api/sources/source-web-article") {
      return json(route, {
        id: "source-web-article",
        title: "E2E Web Directory Article",
        source_type: "web",
        category_id: 1,
        category_name: "Inbox",
        url: "https://example.com/articles/web-directory-entry",
        raw_content: "# Directory article\n\nFirst paragraph.\n\nSecond paragraph.",
        metadata_: { feed_source_id: "source-input", content_source: "web_directory" },
        ingested_at: now,
      });
    }
    if (path === "/api/sources/source-web-article/chunk-count") return json(route, { count: 1 });
    if (path === "/api/sources/source-web-article/articles") return json(route, { items: [], total: 0 });
    if (path === "/api/wiki/references/resolve" && method === "POST") {
      const body = request.postDataJSON() as { refs?: Array<{ ref_type?: string; ref_id?: string }> };
      const known = new Set(["source:source-input", "note:note-input", "wiki:wiki-input"]);
      return json(route, {
        items: (body.refs ?? [])
          .filter((item) => known.has(`${item.ref_type}:${item.ref_id}`))
          .map((item) => ({
            ref_type: item.ref_type,
            ref_id: item.ref_id,
            title: item.ref_id,
          })),
      });
    }
    if (path === "/api/wiki/wiki-input" && method === "GET") {
      return json(route, { id: "wiki-input", title: "E2E Stable Wiki", page_type: "topic", summary: "A distilled wiki.", content: "# Stable Wiki\n\nCanonical knowledge.", domains: [], tags: ["asset-promotion"], derived_from_notes: [], derived_from_sources: [], open_questions: [], confidence_score: null, needs_recompile: false, stale_reason: null, stale_triggered_at: null, last_compiled_at: now, created_at: now, updated_at: now });
    }
    if (path === "/api/wiki/wiki-input/sources" && method === "GET") return json(route, []);
    if (path === "/api/wiki/update-drafts" && method === "GET") return json(route, []);
    if (path === "/api/wiki") return json(route, { items: [{ id: "wiki-input", title: "E2E Stable Wiki", page_type: "topic", content: "Stable knowledge", domains: [], tags: [], derived_from_notes: [], derived_from_sources: [], open_questions: [], needs_recompile: false, created_at: now, updated_at: now }], total: 1 });
    if (path === "/api/review/suggestions") return json(route, { items: [], total: 0 });

    return json(route, {});
  });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("e2e-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function advanceAssetToInitialDraftGeneration(page: Page) {
  await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAttribute("data-state", "active");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Claims" }).click();
  await page.getByRole("button", { name: "Ask Agent to Propose Claims" }).click();
  await expect(page.getByText("Candidate Claim Proposal")).toBeVisible();
  await page.getByRole("button", { name: "Save to Claim Board" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "Generate Initial Draft" }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test("critical knowledge journey: login, chat, explicit save, decisions, and Agent Memory", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Decisions", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agent Memory", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeVisible();

  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toBeVisible();
  await input.fill("Give me one durable E2E result");
  await input.press("Enter");
  await expect(page.getByText("E2E answer with a durable result.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as Asset Draft" })).toHaveCount(0);

  await page.getByRole("button", { name: "Save as Personal Note" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(state.savedNoteBody).not.toBeNull();
  expect(state.savedNoteBody?.tags).toEqual(expect.arrayContaining([
    "from-agent",
    "explicit-save",
    "workflow:general-chat",
    expect.stringMatching(/^harness-session:/),
  ]));

  const dialogValues = ["E2E Memory", "Remember this E2E preference"];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(dialogValues.shift() ?? "");
    else await dialog.accept();
  });
  await page.getByRole("button", { name: "Remember" }).click();
  await expect.poll(() => state.memory?.title).toBe("E2E Memory");

  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending Candidates" })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "Decisions", exact: true })).toHaveCount(0);
  await expect(page.getByText("E2E Paper Candidate")).toBeVisible();
  await expect(page.getByText("Paper Candidate", { exact: true }).first()).toBeVisible();

  await page.goto("/agent-memory");
  await expect(page.getByRole("heading", { name: "Agent Memory", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByText("E2E Memory")).toBeVisible();
  await expect(page.getByText("Remember this E2E preference")).toBeVisible();
});

test("Asset Intent Agent starts a fresh session and restores its apply action", async ({ page }) => {
  const oldSession = {
    id: "session-old",
    title: "Previous Chat",
    messages: [{ id: "old-user", role: "user", content: "Old conversation", created_at: now }],
    created_at: now,
    updated_at: now,
  };
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    chatSessions: [oldSession],
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByLabel("Asset title").fill("User working title");
  await page.getByLabel("Research question").fill("A rough question");
  await page.getByRole("button", { name: "Discuss Intent with Agent" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("data-state", "active");

  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("User working title");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
  expect(state.harnessSessionIds?.at(-1)).not.toBe("session-old");

  await page.reload();
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
  await page.getByRole("button", { name: "Apply to Asset Form" }).click();
  await expect(page).toHaveURL(/\/assets\/new$/);
  await expect(page.getByLabel("Asset title")).toHaveValue("User working title");
  await expect(page.getByLabel("Research question")).toHaveValue("A rough question");
  await expect(page.getByLabel("Goal")).toHaveValue("Produce a decision-ready synthesis.");
});

test("Asset Intent Agent restores Apply from a tool-result-only response", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    intentResponseModes: ["tool-result"],
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByLabel("Research question").fill("What should this Asset decide?");
  await page.getByRole("button", { name: "Discuss Intent with Agent" }).click();
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("What should this Asset decide?");
  await input.press("Enter");

  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
});

test("Asset Intent Agent offers a retry when prose has no proposal", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    intentResponseModes: ["text-only", "tool-result"],
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByLabel("Research question").fill("What should this Asset decide?");
  await page.getByRole("button", { name: "Discuss Intent with Agent" }).click();
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("What should this Asset decide?");
  await input.press("Enter");

  await expect(page.getByText("Intent Proposal was not generated")).toBeVisible();
  await page.getByRole("button", { name: "Generate Applyable Proposal" }).click();
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
  expect(state.chatPrompts?.at(-1)).toContain("call propose_asset_intent exactly once");
});

test("Asset Intent Proposal survives a later prose-only turn", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    intentResponseModes: ["tool-call", "text-only"],
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByLabel("Research question").fill("What should this Asset decide?");
  await page.getByRole("button", { name: "Discuss Intent with Agent" }).click();
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("What should this Asset decide?");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();

  await input.fill("Explain the rationale in one sentence.");
  await input.press("Enter");
  await expect(page.getByText("Intent Proposal was not generated")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Apply to Asset Form" })).toBeVisible();
  await expect(page.getByText("4 messages", { exact: true })).toBeVisible();
});

test("Chat input resizes upward and keeps its height after reload", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  const resizeHandle = page.getByRole("separator", { name: "Resize Chat input" });
  await expect(input).toBeVisible();
  await expect(resizeHandle).toBeVisible();
  const initialHeight = (await input.boundingBox())?.height ?? 0;
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await input.boundingBox())?.height ?? 0).toBeGreaterThan(initialHeight + 60);

  await page.reload();
  await expect(page.getByPlaceholder("Ask anything about your knowledge base...")).toBeVisible();
  await expect.poll(async () => (await page.getByPlaceholder("Ask anything about your knowledge base...").boundingBox())?.height ?? 0).toBeGreaterThan(initialHeight + 60);
});

test("Chat ignores legacy empty workflow sessions before starting a general conversation", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    chatSessions: [{
      id: "session-distill-legacy",
      title: "New Session",
      messages: [],
      created_at: now,
      updated_at: now,
    }],
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await input.fill("Start a clean general conversation");
  await input.press("Enter");

  await expect.poll(() => state.harnessSessionIds?.at(-1)).not.toBe("session-distill-legacy");
  expect(state.chatRequests?.at(-1)).toMatchObject({ preset: "knowledge-lab", create_session: true });
});

test("Asset creation stores HTML delivery preference while preserving Markdown authoring", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByLabel("Research question").fill("How should this HTML delivery work?");
  await page.getByLabel("Asset goal").fill("Produce a reusable web document.");
  await page.getByLabel("Delivery format").selectOption("html");
  await page.getByText("E2E Source Evidence").click();
  await page.getByRole("button", { name: "Confirm Intent & Review Evidence" }).click();
  await advanceAssetToInitialDraftGeneration(page);

  await expect.poll(() => (state.savedAssetBody?.metadata as Record<string, unknown> | undefined)?.delivery_format).toBe("html");
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("Delivery format: HTML export generated deterministically from the Markdown Asset");
  await expect(input).toContainText("Always author and return Markdown; never return raw HTML");
});

test("Asset Production previews and downloads the preferred HTML delivery", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: {
      title: "HTML Preview Asset",
      brief: "Preview and export this Asset.",
      asset_type: "blog_post",
      status: "ready_to_export",
      draft_content: "## Main Argument\n\nRendered safely.",
      reference_notes: "- Source: source-input",
      source_refs: ["source-input"],
      note_refs: [],
      wiki_refs: [],
      metadata_: { delivery_format: "html" },
      metadata: { delivery_format: "html" },
    },
    candidate: null,
    memory: null,
    sessionContext: null,
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/asset-e2e");
  await page.getByRole("tab", { name: "Production" }).click();
  await expect(page.getByLabel("Asset delivery format")).toHaveValue("html");
  await page.getByRole("button", { name: "Preview HTML" }).click();
  await expect(page.getByRole("heading", { name: "HTML Preview" })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Asset HTML Preview"]').getByRole("heading", { name: "HTML Preview Asset" })).toBeVisible();
  await page.keyboard.press("Escape");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export HTML" }).last().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("HTML-Preview-Asset.html");
  await expect.poll(() => state.htmlExportRequests).toBe(1);
});

test("Asset complete optimization records a saved first round before running the audit-guided second round", async ({ page }) => {
  const initialBlocks = [
    { id: "block-title", type: "heading", markdown: "# Original Asset", revision: 1, claim_refs: [] },
    { id: "block-body", type: "paragraph", markdown: "Original evidence-backed paragraph.", revision: 1, claim_refs: ["claim-1"] },
  ];
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: {
      title: "Original Asset",
      brief: "An Asset ready for iterative optimization.",
      asset_type: "research_brief",
      status: "draft",
      draft_content: "# Original Asset\n\nOriginal evidence-backed paragraph.",
      source_refs: ["source-input"],
      note_refs: [],
      wiki_refs: [],
      metadata_: { asset_document: { schemaVersion: 1, blocks: initialBlocks, updatedAt: now } },
      metadata: { asset_document: { schemaVersion: 1, blocks: initialBlocks, updatedAt: now } },
    },
    assetWorkspace: {
      asset_id: "asset-e2e",
      workspace_revision: 7,
      intent: { revision: 1, question: "What should this Asset recommend?", goal: "Produce an evidence-grounded recommendation.", audience: "Architecture reviewers", creation_mode: "make_decision", scope: ["Current architecture"], constraints: ["Use accepted evidence"], status: "confirmed", confirmed_by: "user-e2e", confirmed_at: now },
      intent_history: [],
      evidence: [{ id: "evidence-1", target_type: "source", target_id: "source-input", relation: "supports", summary: "Supports the recommendation.", status: "accepted", authorship: "agent", intent_revision: 1, created_at: now }],
      claims: [{ id: "claim-1", content: "The recommendation is supported.", kind: "finding", supporting_evidence: ["evidence-1"], contradicting_evidence: [], agent_confidence: "medium", status: "accepted", authorship: "agent", intent_revision: 1, created_at: now }],
      contribution: { id: "contribution-1", kind: "synthesis", summary: "A traceable synthesis.", claim_refs: ["claim-1"], status: "accepted", authorship: "agent", attribution: "agent_synthesis", created_at: now },
      knowledge_candidates: [{ id: "candidate-1", candidate_type: "note", action: "create", title: "Reusable recommendation", content: "A reusable evidence-grounded recommendation.", claim_refs: ["claim-1"], status: "kept", authorship: "agent", created_at: now }],
      decision_items: [],
    },
    qualityAudit: {
      asset_id: "asset-e2e",
      workspace_revision: 7,
      verdict: "warn",
      score: 4.5,
      blocking_findings: [],
      warnings: [{ id: "PKG-EVIDENCE-004", severity: "P1", title: "Clarify the remaining evidence tension", detail: "Make the limitation explicit in the conclusion." }],
      metrics: { intent: 1, candidate_count: 1, claim_count: 1, evidence_count: 1 },
    },
    candidate: null,
    memory: null,
    sessionContext: null,
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/asset-e2e");
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator("[data-asset-quality-audit]")).toContainText("PKG-EVIDENCE-004");
  await page.getByRole("button", { name: "Optimize Entire Draft" }).click();
  await expect(page.locator("[data-document-agent-diff-preview]")).toBeVisible();
  await page.getByRole("button", { name: "Apply to Editor" }).click();
  await page.getByRole("button", { name: "Save Round 1 Changes" }).click();

  await expect.poll(() => ((state.savedAssetBody?.metadata as Record<string, unknown>)?.asset_optimization_v1 as Record<string, unknown>)?.completed_rounds).toBe(1);
  expect(state.savedAssetBody?.draft_content).toContain("Round 1 fully rewritten evidence-backed paragraph.");
  expect(state.savedAssetBody?.draft_content).not.toContain("Original evidence-backed paragraph.");
  expect((((state.savedAssetBody?.metadata as Record<string, unknown>)?.asset_document as Record<string, unknown>)?.blocks as unknown[]) ?? []).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Run Second-Round Polish" })).toBeVisible();
  await page.getByRole("button", { name: "Run Second-Round Polish" }).click();
  await expect.poll(() => state.chatPrompts?.at(-1)).toContain('"optimizationRound": 2');
  expect(state.chatPrompts?.at(-1)).toContain("PKG-EVIDENCE-004");
  expect(state.chatPrompts?.at(-1)).toContain('"previousOptimization"');
  await expect(page.locator("[data-document-agent-diff-preview]")).toBeVisible();
  await page.getByRole("button", { name: "Apply to Editor" }).click();
  await page.getByRole("button", { name: "Save Round 2 Changes" }).click();

  await expect.poll(() => ((state.savedAssetBody?.metadata as Record<string, unknown>)?.asset_optimization_v1 as Record<string, unknown>)?.completed_rounds).toBe(2);
  const optimization = (state.savedAssetBody?.metadata as Record<string, unknown>)?.asset_optimization_v1 as { history?: Array<Record<string, unknown>> };
  expect(optimization.history).toHaveLength(2);
  expect(optimization.history?.[1]).toMatchObject({ round: 2, workspace_revision: 7, audit_verdict: "warn", finding_ids: ["PKG-EVIDENCE-004"] });
  expect(state.documentOptimizationCalls).toBe(2);
});

test("Newsletter Automation saves a schedule and creates a reviewable Asset draft", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets");
  await page.getByRole("button", { name: "Newsletter Automation" }).click();
  await expect(page.getByRole("heading", { name: "Newsletter Automation" })).toBeVisible();
  await page.getByLabel("Newsletter name").fill("E2E Tech Weekly");
  await page.getByLabel("Newsletter topics").fill("AI agents\nrobotics");
  await page.getByLabel("Enable Newsletter automation").check();
  await page.getByLabel("Newsletter frequency").selectOption("daily");
  await page.getByLabel("Newsletter hour UTC").fill("2");
  await page.getByRole("button", { name: "Save automation" }).click();

  await expect.poll(() => state.newsletterAutomation?.name).toBe("E2E Tech Weekly");
  expect(state.newsletterAutomation?.topics).toEqual(["AI agents", "robotics"]);
  expect(state.newsletterAutomation?.frequency).toBe("daily");

  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/assets\/asset-e2e$/);
  await expect(page.getByRole("heading", { name: "E2E Tech Weekly · 2026-09-03", exact: true }).last()).toBeVisible();
  expect(state.savedAssetBody).toMatchObject({ asset_type: "newsletter_issue", status: "draft" });
});

test("agent-assisted Asset generation creates a Workspace after Intent confirmation and saves the Agent draft explicitly", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    chatResponse: validResearchBrief.replace(
      "[Source: source-input]",
      "[Source: source-input] [Source: web-linuxfoundation-2026]",
    ),
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets");
  await expect(page.getByRole("heading", { name: "Asset Library" })).toBeVisible();
  await expect(page.getByText("Start with the delivery need, not an empty record")).toBeVisible();
  await page.getByRole("button", { name: "Create Asset", exact: true }).first().click();
  await expect(page).toHaveURL(/\/assets\/new$/);
  await page.getByRole("button", { name: "Research Brief" }).click();
  await page.getByLabel("Asset title").fill("E2E Research Brief");
  await page.getByLabel("Target audience").fill("Architecture reviewers");
  await page.getByLabel("Research question").fill("What architecture decision does the evidence support?");
  await page.getByLabel("Asset goal").fill("Explain the evidence and recommend the next architecture decision.");
  await page.getByLabel("Style guidance").fill("Concise and evidence-led.");
  await page.getByText("E2E Source Evidence").click();
  await expect.poll(() => state.savedAssetBody).toBeNull();

  await page.getByRole("button", { name: "Confirm Intent & Review Evidence" }).click();
  await expect.poll(() => state.savedAssetBody?.title).toBe("E2E Research Brief");
  expect(state.savedAssetBody?.draft_content).toBeUndefined();
  await expect(page).toHaveURL(/\/assets\/asset-e2e$/);
  await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAttribute("data-state", "active");
  await expect(page.getByText("The selected records are now Evidence candidates.")).toBeVisible();
  await expect(page.getByText("Evidence review required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Claims" })).toBeDisabled();
  await expect.poll(() => ((state.assetWorkspace?.evidence as unknown[]) ?? []).length).toBe(1);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Evidence ready")).toBeVisible();
  await page.getByRole("button", { name: "Continue to Claims" }).click();
  await expect(page.getByRole("tab", { name: "Claims" })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("button", { name: "Generate Initial Draft" })).toBeDisabled();
  await page.getByRole("button", { name: "Ask Agent to Propose Claims" }).click();
  await expect(page.getByText("Candidate Claim Proposal")).toBeVisible();
  await page.getByRole("button", { name: "Save to Claim Board" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Claims ready")).toBeVisible();
  await page.getByRole("button", { name: "Generate Initial Draft" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  let input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("The Intent, Evidence Gate, and Claim Gate are complete");
  await expect(input).toContainText("The selected evidence supports a focused architecture decision.");
  await expect(input).toContainText("## Executive Summary");
  await expect(input).toContainText("Completion checklist");
  await expect.poll(() => (state.sessionContext?.assetDraft as Record<string, unknown> | undefined)?.title).toBe("E2E Research Brief");

  await page.goto("/chat");
  input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("E2E Research Brief");
  await expect(input).toContainText("Architecture reviewers");
  await input.press("Enter");
  await expect(page.getByText("E2E answer with a durable result.")).toBeVisible();
  expect(state.savedAssetBody?.draft_content).toBeUndefined();

  await page.getByRole("button", { name: "Apply Draft to Asset" }).click();
  await expect(page.getByRole("button", { name: "Applied to Asset" })).toBeDisabled();
  await expect.poll(() => state.savedAssetBody?.title).toBe("E2E Research Brief");
  expect(state.savedAssetBody).toMatchObject({
    asset_type: "research_brief",
    brief: "Explain the evidence and recommend the next architecture decision.",
    style_notes: "Concise and evidence-led.",
    source_refs: ["source-input"],
    status: "draft",
  });
  expect(state.savedAssetBody?.draft_content).toContain("[Source: web-linuxfoundation-2026]");
  expect(state.savedAssetBody?.metadata).toMatchObject({
    audience: "Architecture reviewers",
    generation_mode: "agent_assisted",
    research_mode: "local_then_web",
  });

  await page.goto("/assets/asset-e2e");
  await expect(page.getByRole("tab", { name: "Read" })).toHaveAttribute("data-state", "active");
  await expect(page.locator('[data-reader-layout="research-brief"]')).toBeVisible();
  await expect(page.getByText("Decision document", { exact: true })).toBeVisible();
  await expect(page.getByText("Executive brief", { exact: true })).toBeVisible();
  await expect(page.getByText("Brief sections", { exact: true })).toBeVisible();
  await expect(page.getByText("Evidence base", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Research Brief", exact: true }).last()).toBeVisible();
  await expect(page.getByText("E2E answer with a durable result.")).toBeVisible();
  await expect(page.getByText("[Source: source-input]", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Evidence" }).click();
  const sourceEvidenceLink = page.getByRole("link", { name: "[Source: source-input]" }).first();
  await expect(sourceEvidenceLink).toHaveAttribute("href", "/sources/source-input");
  await sourceEvidenceLink.click();
  await expect(page).toHaveURL(/\/sources\/source-input$/);
  await expect(page.getByRole("heading", { name: "E2E Source Evidence" })).toBeVisible();
  await page.goto("/assets/asset-e2e");
  await expect(page.getByText("Production Actions")).toHaveCount(0);
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator("[data-asset-block-id]")).toHaveCount(13);
  await page.getByRole("button", { name: "Preview block 2" }).click();
  await expect(page.locator("[data-block-preview]")).toHaveCount(1);
  await expect(page.locator("[data-block-preview]").getByRole("heading", { name: "Executive Summary" })).toBeVisible();
  await page.getByRole("button", { name: "Hide preview for block 2" }).click();
  await expect(page.locator("[data-block-preview]")).toHaveCount(0);
  await page.getByRole("button", { name: "让 Agent 修改" }).nth(3).click();
  await page.getByLabel("Agent instruction for block 4").fill("Make this paragraph clearer without removing its evidence marker.");
  await page.getByRole("button", { name: "按要求修改" }).click();
  await expect(page.locator("[data-agent-diff-preview]")).toBeVisible();
  await expect(page.getByLabel("Draft block 4")).not.toHaveValue(/Agent revised paragraph/);
  await page.getByRole("button", { name: "确认应用" }).click();
  await expect(page.getByLabel("Draft block 4")).toHaveValue(/Agent revised paragraph/);
  expect(state.savedAssetBody?.draft_content).not.toContain("Agent revised paragraph");
  await page.getByLabel("Draft block 2").fill("## Revised finding");
  await page.getByLabel("Draft block 3").fill("A clearer evidence-backed recommendation.");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect.poll(() => state.savedAssetBody?.draft_content).toContain("Revised finding");
  expect(state.savedAssetBody?.metadata).toMatchObject({
    asset_document: {
      schemaVersion: 1,
      blocks: expect.arrayContaining([expect.objectContaining({ markdown: "## Revised finding", type: "heading" })]),
    },
  });
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.getByRole("heading", { name: "Revised finding" })).toBeVisible();
  await page.getByRole("tab", { name: "Production" }).click();
  await expect(page.getByText("Production Actions")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Publish Details" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Production Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "References", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Brief", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Outline", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Draft", exact: true })).toHaveCount(0);
});

test("saving a later Evidence collection retries a benign Workspace revision conflict", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: {
      title: "Evidence retry Asset",
      brief: "Collect evidence in multiple passes.",
      asset_type: "research_brief",
      status: "draft",
      source_refs: ["source-input"],
      note_refs: [],
      wiki_refs: [],
      metadata: { audience: "Architecture reviewers", research_mode: "local_then_web" },
    },
    assetWorkspace: {
      asset_id: "asset-e2e",
      workspace_revision: 5,
      intent: { revision: 1, question: "What does the evidence support?", goal: "Build a grounded recommendation.", audience: "Architecture reviewers", creation_mode: "make_decision", scope: [], constraints: [], status: "confirmed", confirmed_by: "user-e2e", confirmed_at: now },
      intent_history: [],
      evidence: [{ id: "evidence-1", target_type: "source", target_id: "source-input", relation: "supports", summary: "The first collection supports the Intent.", status: "accepted", authorship: "agent", intent_revision: 1, created_at: now }],
      claims: [],
      contribution: null,
      knowledge_candidates: [],
      decision_items: [],
    },
    candidate: null,
    memory: null,
    sessionContext: null,
    evidenceProposalConflictOnce: true,
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/asset-e2e");
  await page.getByRole("tab", { name: "Evidence" }).click();
  await page.getByRole("button", { name: "Ask Agent to Collect Evidence" }).click();
  expect(state.chatRequests?.at(-1)).toMatchObject({
    preset: "collect-asset-evidence",
    create_session: true,
    ephemeral_session: true,
  });
  await expect(page.getByText("Evidence Proposal")).toBeVisible();
  await page.getByRole("button", { name: "Save to Evidence Board" }).click();

  await expect(page.getByText("1 Evidence candidates saved for review.")).toBeVisible();
  await expect.poll(() => ((state.assetWorkspace?.evidence as unknown[]) ?? []).length).toBe(2);
  expect(state.assetWorkspace?.workspace_revision).toBe(7);
});

test("Source Asset handoff opens the generation guide with evidence preselected", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/sources/source-input");
  await expect(page.getByRole("heading", { name: "E2E Source Evidence" })).toBeVisible();
  await expect(page.getByText("Web Directory", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RSS Feed", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-source-content] .whitespace-pre-wrap")).toHaveCSS("white-space", "pre-wrap");
  await expect(page.locator("[data-source-content]")).toContainText("Second visible line.");
  const processingStatus = page.locator("[data-source-processing-status]");
  await expect(processingStatus.getByRole("heading", { name: "Processing Status" })).toBeVisible();
  await expect(processingStatus.getByText("Stored", { exact: true })).toBeVisible();
  await expect(processingStatus.getByText("Content Extracted", { exact: true })).toBeVisible();
  await expect(processingStatus.getByText("Indexed", { exact: true })).toBeVisible();
  await expect(processingStatus.getByRole("paragraph").filter({ hasText: /^Ready$/ })).toBeVisible();
  await expect(processingStatus.getByText("Review", { exact: true })).toHaveCount(0);
  await expect(processingStatus.getByText("Summarized", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Asset", exact: true }).click();

  await expect(page).toHaveURL(/\/assets\/new$/);
  await expect(page.getByLabel("Asset title")).toHaveValue("E2E Source Evidence");
  await expect(page.getByLabel("Research question")).toHaveValue("Create a blog asset from source: E2E Source Evidence");
  await expect(page.getByLabel("E2E Source Evidence")).toBeChecked();
  await expect(page.getByText("Intent not confirmed", { exact: false })).toBeVisible();
  await expect.poll(() => state.savedAssetBody).toBeNull();
});

test("distilled Notes and Wiki pages link back to their originating Asset", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/notes/note-input");
  await expect(page.getByText("Related Assets")).toBeVisible();
  await expect(page.getByText("Distilled from Asset")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Distillation Asset" })).toHaveAttribute("href", "/assets/asset-e2e");

  await page.goto("/wiki/wiki-input");
  await expect(page.getByText("Related Assets")).toBeVisible();
  await expect(page.getByText("Reusable knowledge distilled from reviewed claims.")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Distillation Asset" })).toHaveAttribute("href", "/assets/asset-e2e");
});

test("Web Source presentation distinguishes RSS Feed from Web Directory", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/sources/source-rss");
  await expect(page.getByRole("heading", { name: "E2E RSS Feed" })).toBeVisible();
  await expect(page.getByText("RSS Feed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RSS Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Web Directory", { exact: true })).toHaveCount(0);

  await page.goto("/sources/source-web-article");
  await expect(page.getByRole("heading", { name: "E2E Web Directory Article" })).toBeVisible();
  await expect(page.getByText("Web Directory Article", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RSS Article", { exact: true })).toHaveCount(0);
});

test("Asset types produce distinct agent-assisted deliverable contracts before generation", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  const cases = [
    { type: "Blog Post", section: "## Main Argument" },
    { type: "Research Brief", section: "## Executive Summary" },
    { type: "Knowledge Pack", section: "## Guided Reading Path" },
    { type: "Topic Report", section: "## Topic Landscape" },
  ];

  for (const item of cases) {
    await page.goto("/assets/new");
    await page.getByRole("button", { name: item.type }).click();
    await page.getByLabel("Asset title").fill(`${item.type} contract smoke`);
    await page.getByLabel("Target audience").fill("Knowledge workers");
    await page.getByLabel("Research question").fill("What does the selected evidence establish?");
    await page.getByLabel("Asset goal").fill("Produce a grounded, reusable deliverable.");
    await page.getByText("E2E Source Evidence").click();
    await page.getByRole("button", { name: "Confirm Intent & Review Evidence" }).click();
    await advanceAssetToInitialDraftGeneration(page);

    const input = page.getByPlaceholder("Ask anything about your knowledge base...");
    await expect(input).toContainText(item.section);
    await expect(input).toContainText("[Source: source-input]");
    await expect(input).toContainText("Return the final response as the editable Markdown deliverable itself");
  }

  expect(state.savedAssetBody).toMatchObject({ asset_type: "topic_report", status: "draft" });
  expect(state.savedAssetBody?.draft_content).toBeUndefined();
});

test("Asset quality issues can be regenerated before the corrected draft is saved", async ({ page }) => {
  const state: MockState = {
    loggedIn: false,
    savedNoteBody: null,
    savedAssetBody: null,
    candidate: null,
    memory: null,
    sessionContext: null,
    chatResponse: "# Incomplete brief\n\nTODO: add evidence and recommendations.",
  };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/assets/new");
  await page.getByRole("button", { name: "Research Brief" }).click();
  await page.getByLabel("Asset title").fill("Incomplete brief");
  await page.getByLabel("Target audience").fill("Architecture reviewers");
  await page.getByLabel("Research question").fill("Which architecture decision does the evidence support?");
  await page.getByLabel("Asset goal").fill("Recommend an architecture decision from the selected evidence.");
  await page.getByText("E2E Source Evidence").click();
  await page.getByRole("button", { name: "Confirm Intent & Review Evidence" }).click();
  await advanceAssetToInitialDraftGeneration(page);
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("Incomplete brief");
  await input.press("Enter");

  await expect(page.getByText("Asset draft save is blocked")).toBeVisible();
  await expect(page.getByText("Missing required section: Executive Summary.")).toBeVisible();
  await expect(page.getByText("Draft still contains unfinished placeholders or citation-needed markers.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply Draft to Asset" })).toBeDisabled();
  expect(state.savedAssetBody?.draft_content).toBeUndefined();

  state.chatResponse = validResearchBrief.replace("E2E Research Brief", "Incomplete brief");
  await page.getByRole("button", { name: "Regenerate to fix issues" }).click();
  await expect.poll(() => state.chatPrompts?.at(-1)).toContain("Fix every blocking issue below");
  expect(state.chatPrompts?.at(-1)).toContain("Missing required section: Executive Summary.");
  expect(state.chatPrompts?.at(-1)).toContain("Return the full corrected Markdown document");
  await expect(page.getByText("Asset draft quality check passed")).toBeVisible();
  const saveButton = page.getByRole("button", { name: "Apply Draft to Asset" }).last();
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect.poll(() => state.savedAssetBody?.title).toBe("Incomplete brief");
});
