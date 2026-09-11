import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-09-09T08:00:00.000Z";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMockBff(page: Page, options?: {
  sourceType?: "pdf" | "article";
  chunkCount?: number;
  rawContent?: string | null;
  existingMap?: boolean;
  staleReasons?: Array<"source_content_hash" | "chunk_count" | "chunk_revision">;
  agentProposal?: "valid" | "invalid-once" | "basis-conflict";
  agentDelayMs?: number;
  largeProposal?: boolean;
  applyVersionConflict?: boolean;
  contextFailure?: boolean;
}) {
  let loggedIn = false;
  let hasMap = options?.existingMap ?? false;
  let createdBody: Record<string, unknown> | null = null;
  let validatedBody: Record<string, unknown> | null = null;
  let chatBody: Record<string, unknown> | null = null;
  let appliedBody: Record<string, unknown> | null = null;
  let noteBody: Record<string, unknown> | null = null;
  let chatAttempts = 0;
  const sourceType = options?.sourceType ?? "pdf";
  const chunkCount = options?.chunkCount ?? 3;
  const rawContent = options?.rawContent === undefined ? "# Distributed Systems\n\nExtracted PDF content." : options.rawContent;
  const source = {
    id: "source-pdf",
    title: "Distributed Systems Paper",
    category_id: 1,
    category_name: "Research",
    source_type: sourceType,
    url: null,
    content_hash: rawContent ? "content-hash-1" : null,
    raw_content: rawContent,
    file_path: sourceType === "pdf" ? "sources/source-pdf.pdf" : null,
    ingested_at: now,
    metadata_: { chunk_revision: 2, extraction_status: rawContent ? "completed" : "pending" },
  };
  const chunks = [
    { id: 11, source_id: source.id, chunk_index: 0, content: "Coordination requires explicit failure handling.", token_count: 6, embedding_status: "completed", created_at: now },
    { id: 12, source_id: source.id, chunk_index: 1, content: "Consensus establishes a shared decision.", token_count: 5, embedding_status: "completed", created_at: now },
  ];
  const map = {
    id: "map-source-pdf",
    user_id: "source-map-user",
    owner_type: "source",
    owner_id: "source-pdf",
    purpose: "document_overview",
    title: "Distributed Systems Paper · Mind Map",
    root_node_id: "root",
    layout_mode: "balanced",
    version: 2,
    basis_revision: { source_content_hash: "content-hash-1", chunk_count: 3, chunk_revision: 2 },
    generation_status: "ready",
    created_at: now,
    updated_at: now,
  };
  const nodes = [
    { id: "root", map_id: map.id, display_id: 1, parent_id: null, content: "Distributed Systems Paper", note: null, position: 0, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now },
    { id: "branch", map_id: map.id, display_id: 2, parent_id: "root", content: "Coordination", note: null, position: 0, collapsed: false, node_kind: "concept", updated_by: "agent", created_at: now, updated_at: now },
  ];
  const references = [{ id: "ref-branch-11", map_id: map.id, node_id: "branch", ref_type: "source_chunk", ref_id: "11", relation: "supports", fragment_selector: { page: 8 }, created_at: now }];
  const tree = () => ({ map, root_id: "root", nodes: hasMap ? nodes : nodes.slice(0, 1), references: hasMap ? references : [] });
  const generationContext = {
    source_id: source.id,
    source_metadata: { title: source.title, source_type: "pdf", ingested_at: now },
    basis_revision: { source_content_hash: source.content_hash, chunk_count: chunkCount, chunk_revision: 2 },
    sampling: {
      strategy: chunkCount > 80 ? "evenly_spaced" : "all_chunks",
      total_chunk_count: chunkCount,
      sampled_chunk_count: Math.min(chunkCount, 80),
      omitted_chunk_count: Math.max(0, chunkCount - 80),
      coverage_percent: Math.round(Math.min(chunkCount, 80) / chunkCount * 100),
      max_sampled_chunks: 80,
      section_count: Math.ceil(Math.min(chunkCount, 80) / 12),
    },
    input_summary: {
      section_summaries: [{ title: "Coordination", summary: "Coordination patterns", chunk_ids: [11, 12] }],
      chunk_summaries: [
        { chunk_id: 11, chunk_index: 0, summary: "Coordination requires explicit failure handling." },
        { chunk_id: 12, chunk_index: 1, summary: "Consensus establishes a shared decision." },
      ],
    },
  };
  const proposalNodes = options?.largeProposal
    ? [
        { temp_id: "root", parent_temp_id: null, position: 0, content: "Distributed Systems", note: null, node_kind: "topic" },
        ...Array.from({ length: 4 }, (_, sectionIndex) => {
          const sectionId = `section-${sectionIndex}`;
          return [
            { temp_id: sectionId, parent_temp_id: "root", position: sectionIndex, content: `Section ${sectionIndex}`, note: null, node_kind: "section" },
            ...Array.from({ length: 3 }, (_, topicIndex) => {
              const topicId = `${sectionId}-topic-${topicIndex}`;
              return [
                { temp_id: topicId, parent_temp_id: sectionId, position: topicIndex, content: `Topic ${sectionIndex}.${topicIndex}`, note: null, node_kind: "concept" },
                ...Array.from({ length: 3 }, (_, detailIndex) => ({
                  temp_id: `${topicId}-detail-${detailIndex}`,
                  parent_temp_id: topicId,
                  position: detailIndex,
                  content: `Detail ${sectionIndex}.${topicIndex}.${detailIndex}`,
                  note: null,
                  node_kind: "concept",
                })),
              ];
            }).flat(),
          ];
        }).flat(),
      ]
    : [
        { temp_id: "root", parent_temp_id: null, position: 0, content: "Distributed Systems", note: null, node_kind: "topic" },
        { temp_id: "coordination", parent_temp_id: "root", position: 0, content: "Coordination", note: null, node_kind: "claim" },
      ];
  const proposalReferences = options?.largeProposal
    ? []
    : [{ node_temp_id: "coordination", chunk_id: 11, relation: "supports", fragment_selector: null }];
  const proposal = {
    source_id: source.id,
    basis_revision: generationContext.basis_revision,
    proposal: {
      title: "Distributed Systems Overview",
      layout_mode: "balanced",
      nodes: proposalNodes,
      references: proposalReferences,
    },
    authorship: "agent",
    requiresUserConfirmation: true,
  };

  await page.route(`${apiBase}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/login" && request.method() === "POST") {
      loggedIn = true;
      return json(route, { access_token: "source-map-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return loggedIn
        ? json(route, { id: "source-map-user", username: "source-map-user", display_name: "Source Map User", role: "user", approval_status: "approved", is_active: true })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/me/settings") return json(route, { settings: { modules: { onboarding_completed: true, enabled: [] } }, updated_at: now });
    if (path === "/api/harness/models") return json(route, { models: [], failures: [] });
    if (path === "/api/sources/source-pdf") return json(route, source);
    if (path === "/api/sources/source-pdf/chunk-count") return json(route, { count: chunkCount });
    if (path === "/api/sources/source-pdf/chunks") return json(route, chunks);
    if (path === "/api/categories") return json(route, { items: [{ id: 1, name: "Research" }], total: 1 });
    if (path === "/api/chat-sessions" && request.method() === "GET") {
      return json(route, { items: [], total: 0 });
    }
    if (path === "/api/chat-sessions" && request.method() === "POST") {
      const body = request.postDataJSON() as { id?: string };
      return json(route, {
        id: body.id ?? "session-source-map",
        title: "New Session",
        messages: [],
        created_at: now,
        updated_at: now,
      }, 201);
    }
    if (path === "/api/notes" && request.method() === "POST") {
      noteBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { id: "note-from-map", ...noteBody, domains: [], created_at: now, updated_at: now }, 201);
    }
    if (path === "/api/mind-maps" && request.method() === "GET") return json(route, { items: hasMap ? [map] : [], total: hasMap ? 1 : 0 });
    if (path === "/api/mind-maps" && request.method() === "POST") {
      createdBody = request.postDataJSON() as Record<string, unknown>;
      hasMap = true;
      return json(route, tree(), 201);
    }
    if (path === "/api/mind-maps/proposals/source/context") {
      if (options?.contextFailure) return json(route, { detail: "Mind Map generation context is temporarily unavailable" }, 503);
      return json(route, generationContext);
    }
    if (path === "/api/chat" && request.method() === "POST") {
      chatAttempts += 1;
      chatBody = request.postDataJSON() as Record<string, unknown>;
      const invalid = options?.agentProposal === "invalid-once" && chatAttempts === 1;
      const isBranchExpansion = String(chatBody.prompt ?? "").includes("Expand only the selected Source Mind Map branch");
      const agentResult = isBranchExpansion ? {
        source_id: source.id,
        basis_revision: generationContext.basis_revision,
        map_id: map.id,
        base_version: map.version,
        target_node_id: "branch",
        proposal: {
          title: "Coordination branch expansion",
          layout_mode: "balanced",
          nodes: [
            { temp_id: "anchor", parent_temp_id: null, position: 0, content: "Coordination", note: null, node_kind: "topic" },
            { temp_id: "failure-modes", parent_temp_id: "anchor", position: 0, content: "Failure modes", note: null, node_kind: "concept" },
          ],
          references: [],
        },
        authorship: "agent",
        requiresUserConfirmation: true,
      } : proposal;
      const events = [
        { type: "session", session_id: `session-mind-map-${chatAttempts}`, preset: "generate-source-mind-map" },
        { type: "tool_call", tool: "propose_source_mind_map", args: {} },
        {
          type: "tool_result",
          tool: "propose_source_mind_map",
          result: invalid ? "Error: proposal.nodes[0] contains unsupported fields: text, category, branches" : JSON.stringify(agentResult),
        },
        { type: "done", session_id: `session-mind-map-${chatAttempts}` },
      ];
      if (options?.agentDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.agentDelayMs));
      }
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      });
    }
    if (path === "/api/mind-maps/proposals/source/validate" && request.method() === "POST") {
      validatedBody = request.postDataJSON() as Record<string, unknown>;
      if (options?.agentProposal === "basis-conflict") {
        return json(route, {
          detail: {
            code: "source_mind_map_basis_conflict",
            message: "Source content changed after the Mind Map proposal was generated",
          },
        }, 409);
      }
      const validatedProposal = validatedBody.proposal as { nodes?: unknown[]; references?: unknown[] };
      return json(route, {
        ...validatedBody,
        node_count: validatedProposal.nodes?.length ?? 0,
        reference_count: validatedProposal.references?.length ?? 0,
      });
    }
    if (path === "/api/mind-maps/proposals/source/apply" && request.method() === "POST") {
      appliedBody = request.postDataJSON() as Record<string, unknown>;
      if (options?.applyVersionConflict) {
        return json(route, {
          detail: {
            code: "mind_map_version_conflict",
            message: "Mind Map version changed: expected 2, current 3",
            map_id: map.id,
            expected_version: 2,
            current_version: 3,
          },
        }, 409);
      }
      map.title = proposal.proposal.title;
      map.version = hasMap ? map.version + 1 : 1;
      map.generation_status = "ready";
      hasMap = true;
      return json(route, { map, root_id: "root", nodes, references: [] });
    }
    if (path === "/api/mind-maps/map-source-pdf/tree") return json(route, tree());
    if (path === "/api/mind-maps/map-source-pdf/check-staleness" && request.method() === "POST") {
      const reasons = options?.staleReasons ?? [];
      if (reasons.length > 0) map.generation_status = "stale";
      return json(route, {
        map,
        stale: reasons.length > 0,
        reasons,
        current_basis: {
          source_content_hash: reasons.includes("source_content_hash") ? "content-hash-2" : "content-hash-1",
          chunk_count: reasons.includes("chunk_count") ? 4 : 3,
          chunk_revision: reasons.includes("chunk_revision") ? 3 : 2,
        },
      });
    }
    if (path === "/api/mind-maps/map-source-pdf/revisions") return json(route, { items: [], total: 0 });
    return json(route, {});
  });
  return {
    getCreatedBody: () => createdBody,
    getValidatedBody: () => validatedBody,
    getChatBody: () => chatBody,
    getAppliedBody: () => appliedBody,
    getNoteBody: () => noteBody,
  };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("source-map-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("PDF Source creates a revision-based starter Mind Map", async ({ page }) => {
  const mock = await installMockBff(page);
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await expect(page.getByTestId("source-mind-map-empty")).toContainText("Not Generated");
  await expect(page.getByText("3 chunks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create Starter Map" }).click();

  await expect(page).toHaveURL(/\/mind-maps\/map-source-pdf$/);
  await expect(page.getByRole("heading", { name: "Distributed Systems Paper · Mind Map" })).toBeVisible();
  expect(mock.getCreatedBody()).toMatchObject({
    owner_type: "source",
    owner_id: "source-pdf",
    purpose: "document_overview",
    root_content: "Distributed Systems Paper",
    basis_revision: {
      source_content_hash: "content-hash-1",
      chunk_count: 3,
      chunk_revision: 2,
    },
  });
});

test("PDF Source previews an existing Mind Map and opens the full editor", async ({ page }) => {
  await installMockBff(page, { existingMap: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await expect(page.getByTestId("source-mind-map-ready")).toContainText("Ready");
  await expect(page.getByTestId("source-mind-map-preview")).toBeVisible();
  await expect(page.getByText("Coordination", { exact: true }).first()).toBeVisible();
  await page.getByTestId("source-mind-map-preview").getByText("Coordination", { exact: true }).click();
  await expect(page).toHaveURL(/\/sources\/source-pdf\?view=mind-map&map_node=branch$/);
  const savedMapEdge = page.getByTestId("source-mind-map-preview").locator(".react-flow__edge-path").first();
  await expect(savedMapEdge).toHaveAttribute("d", /.+/);
  await expect.poll(() => savedMapEdge.evaluate((element) => getComputedStyle(element).stroke)).not.toBe("none");
  await page.getByRole("button", { name: "Open Full Map" }).click();
  await expect(page).toHaveURL(/\/mind-maps\/map-source-pdf\?selected=branch$/);
  await expect(page.getByTestId("mind-map-page")).toBeVisible();
  await page.getByRole("button", { name: "Back to Source", exact: true }).click();
  await expect(page).toHaveURL(/\/sources\/source-pdf\?view=mind-map&map_node=branch$/);
  await expect(page.getByTestId("source-mind-map-node-handoff")).toContainText("Coordination");
});

test("PDF Source confirms an Agent Proposal and persists it in the full Map", async ({ page }) => {
  const mock = await installMockBff(page, { existingMap: true, agentProposal: "valid" });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();

  await expect(page.getByTestId("source-mind-map-proposal-preview")).toBeVisible();
  await expect(page.getByText(/proposal passed validation/)).toBeVisible();
  await expect(page.locator('[data-agent-run-status="completed"]')).toBeVisible();
  await expect(page.locator("[data-proposal-actions]")).toBeVisible();
  await expect(page.getByText("2 nodes", { exact: true })).toBeVisible();
  const proposalEdge = page.getByTestId("source-mind-map-proposal-preview").locator(".react-flow__edge-path").first();
  await expect(proposalEdge).toHaveAttribute("d", /.+/);
  await expect.poll(() => proposalEdge.evaluate((element) => getComputedStyle(element).stroke)).not.toBe("none");
  expect(mock.getChatBody()).toMatchObject({
    preset: "generate-source-mind-map",
    ephemeral_session: true,
  });
  expect(mock.getValidatedBody()).toMatchObject({
    source_id: "source-pdf",
    proposal: { title: "Distributed Systems Overview" },
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Apply Proposal to Mind Map" }).click();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toHaveCount(0);
  await expect(page.getByText(/Saved 2 nodes to Mind Map v3/)).toBeVisible();
  expect(mock.getAppliedBody()).toMatchObject({
    source_id: "source-pdf",
    map_id: "map-source-pdf",
    base_version: 2,
    confirm: true,
  });

  await page.getByRole("button", { name: "Open Full Map" }).click();
  await expect(page).toHaveURL(/\/mind-maps\/map-source-pdf$/);
  await page.goBack();
  await page.getByRole("button", { name: "Mind Map" }).click();
  await expect(page.getByTestId("source-mind-map-preview")).toBeVisible();
  await expect(page.getByText("Coordination", { exact: true }).first()).toBeVisible();
});

test("validated Proposal can be discarded without changing the formal Map", async ({ page }) => {
  await installMockBff(page, { agentProposal: "valid" });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toBeVisible();
  await page.getByRole("button", { name: "Discard proposal" }).click();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate Agent Proposal" })).toBeVisible();
});

test("large PDF generation shows bounded coverage and can be cancelled safely", async ({ page }) => {
  await installMockBff(page, { chunkCount: 145, agentDelayMs: 5_000 });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  const metrics = page.getByTestId("source-mind-map-generation-metrics");
  await expect(metrics).toContainText("145 source chunks");
  await expect(metrics).toContainText("80 Agent input chunks");
  await expect(metrics).toContainText("55% coverage");
  await expect(page.getByText(/Large PDF protection is active/)).toContainText("65 are omitted");

  await page.getByRole("button", { name: "Cancel Generation" }).click();
  await expect(page.getByText("Mind Map proposal failed")).toBeVisible();
  await expect(page.getByText("No proposal was applied to the saved Mind Map.")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText("Generation cancelled. No Proposal was saved or applied.")).toBeVisible();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("large Agent Proposal starts folded at depth two", async ({ page }) => {
  await installMockBff(page, { chunkCount: 145, largeProposal: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  await expect(page.getByTestId("source-mind-map-auto-collapse-notice")).toContainText("folded at depth 2");
  const visibleNodes = page.getByTestId("source-mind-map-proposal-preview").locator(".react-flow__node");
  await expect.poll(() => visibleNodes.count()).toBe(17);
});

test("Map version conflict keeps the validated Proposal for retry", async ({ page }) => {
  await installMockBff(page, { existingMap: true, agentProposal: "valid", applyVersionConflict: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Apply Proposal to Mind Map" }).click();

  await expect(page.getByText("Mind Map proposal could not be applied")).toBeVisible();
  await expect(page.getByText("The saved Mind Map was not changed.")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText(/mind_map_version_conflict/)).toBeVisible();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toBeVisible();
  await expect(page.getByTestId("source-mind-map-preview")).toBeVisible();
});

test("invalid Agent Proposal can retry without changing the saved Map", async ({ page }) => {
  await installMockBff(page, { existingMap: true, agentProposal: "invalid-once" });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  await expect(page.getByText("Mind Map proposal failed")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText("proposal.nodes[0] contains unsupported fields: text, category, branches")).toBeVisible();
  await expect(page.getByText("Coordination", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toBeVisible();
  await expect(page.getByTestId("source-mind-map-preview")).toBeVisible();
});

test("basis conflict blocks Proposal preview and asks for retry", async ({ page }) => {
  await installMockBff(page, { agentProposal: "basis-conflict" });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();

  await expect(page.getByText("Mind Map proposal failed")).toBeVisible();
  await expect(page.getByText("No proposal was applied to the saved Mind Map.")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText(/source_mind_map_basis_conflict/)).toBeVisible();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("Mind Map generation failure does not block Full or Slices reading", async ({ page }) => {
  await installMockBff(page, { contextFailure: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByRole("button", { name: "Generate Agent Proposal" }).click();
  await expect(page.getByText("Mind Map proposal failed")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText(/Mind Map generation context is temporarily unavailable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Full" }).click();
  await expect(page.locator("[data-source-content]")).toContainText("Extracted PDF content");

  await page.getByRole("button", { name: "Slices" }).click();
  await expect(page.getByText("2 slices", { exact: true })).toBeVisible();
  await expect(page.getByTestId("selected-source-chunk-content")).toContainText("Coordination requires explicit failure handling");
});

test("selected Source branch expands through a version-safe confirmed Proposal", async ({ page }) => {
  const mock = await installMockBff(page, { existingMap: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  await page.getByTestId("source-mind-map-preview").getByText("Coordination", { exact: true }).click();
  await page.getByRole("button", { name: "Expand Selected Branch" }).click();

  await expect(page.getByRole("heading", { name: "Branch Expansion Proposal" })).toBeVisible();
  await expect(page.getByTestId("source-mind-map-proposal-preview")).toContainText("Failure modes");
  expect(mock.getChatBody()).toMatchObject({ preset: "generate-source-mind-map", ephemeral_session: true });
  expect(String(mock.getChatBody()?.prompt)).toContain("target_node_id");
  expect(mock.getValidatedBody()).toMatchObject({ map_id: "map-source-pdf", base_version: 2, target_node_id: "branch" });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Apply Proposal to Mind Map" }).click();
  expect(mock.getAppliedBody()).toMatchObject({
    map_id: "map-source-pdf",
    base_version: 2,
    target_node_id: "branch",
    confirm: true,
  });
});

test("selected Source node hands off provenance to Asset, Note, and Wiki workflows", async ({ page }) => {
  const mock = await installMockBff(page, { existingMap: true });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  const selectCoordination = async () => {
    await page.getByRole("button", { name: "Mind Map" }).click();
    await page.getByTestId("source-mind-map-preview").getByText("Coordination", { exact: true }).click();
    await expect(page.getByTestId("source-mind-map-node-handoff")).toContainText("1 Source Chunk reference");
  };

  await selectCoordination();
  await page.getByTestId("source-mind-map-node-handoff").getByRole("button", { name: "Create Asset from This Branch" }).click();
  await expect(page).toHaveURL(/\/assets\/new$/);
  const assetHandoff = await page.evaluate(() => window.history.state.usr.assetHandoff);
  expect(assetHandoff).toMatchObject({ title: "Coordination", source_refs: ["source-pdf"] });
  expect(String(assetHandoff.brief)).toContain("Referenced Source Chunks: 11");

  await page.goBack();
  await selectCoordination();
  await page.getByTestId("source-mind-map-node-handoff").getByRole("button", { name: "Draft Wiki", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent Chat" })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/chat\?session=/, { timeout: 10_000 });
  const wikiHandoff = await page.evaluate(() => window.history.state.usr);
  expect(wikiHandoff.backLabel).toBe("Back to Source Mind Map");
  await expect(page.getByPlaceholder("Ask anything about your knowledge base...")).toHaveValue(/Referenced Source Chunks: 11/);
  await expect(page.getByRole("button", { name: "Back to Source Mind Map" })).toBeVisible();

  await page.goBack();
  await selectCoordination();
  await page.getByTestId("source-mind-map-node-handoff").getByRole("button", { name: "Create Note", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/note-from-map$/);
  expect(mock.getNoteBody()).toMatchObject({
    title: "Distributed Systems Paper · Coordination",
    tags: ["from-source", "from-mind-map"],
    source_ids: ["source-pdf"],
  });
  expect(String(mock.getNoteBody()?.content)).toContain("Source Chunks: 11");
});

test("PDF Source marks a changed basis stale without replacing Map nodes", async ({ page }) => {
  await installMockBff(page, {
    existingMap: true,
    staleReasons: ["source_content_hash", "chunk_count"],
  });
  await signIn(page);
  await page.goto("/sources/source-pdf");

  await page.getByRole("button", { name: "Mind Map" }).click();
  const warning = page.getByTestId("source-mind-map-stale-warning");
  await expect(warning).toContainText("current Map and edits were preserved");
  await expect(warning).toContainText("PDF content changed");
  await expect(warning).toContainText("Extracted chunk count changed");
  await expect(page.getByTestId("source-mind-map-ready")).toContainText("Stale");
  await expect(page.getByText("Coordination", { exact: true }).first()).toBeVisible();
});

test("Mind Map creation waits for PDF extraction and stays hidden for articles", async ({ page }) => {
  await installMockBff(page, { chunkCount: 0, rawContent: null });
  await signIn(page);
  await page.goto("/sources/source-pdf");
  await page.getByRole("button", { name: "Mind Map" }).click();
  await expect(page.getByRole("button", { name: "Create Starter Map" })).toBeDisabled();
  await expect(page.getByText(/Text extraction must finish/)).toBeVisible();

  const articlePage = await page.context().newPage();
  await installMockBff(articlePage, { sourceType: "article" });
  await signIn(articlePage);
  await articlePage.goto("/sources/source-pdf");
  await expect(articlePage.getByRole("button", { name: "Mind Map" })).toHaveCount(0);
});
