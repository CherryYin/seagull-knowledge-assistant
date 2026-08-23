import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-08-23T08:00:00.000Z";

type MockState = {
  loggedIn: boolean;
  savedNoteBody: Record<string, unknown> | null;
  savedAssetBody: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  memory: Record<string, unknown> | null;
  sessionContext: Record<string, unknown> | null;
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

    if (path === "/api/chat-sessions" && method === "GET") {
      return json(route, { items: [], total: 0 });
    }
    if (path === "/api/chat-sessions" && method === "POST") {
      const body = request.postDataJSON() as { id?: string; title?: string; messages?: unknown[] };
      return json(route, {
        id: body.id ?? "session-e2e",
        title: body.title ?? "New Chat",
        messages: body.messages ?? [],
        created_at: now,
        updated_at: now,
      });
    }
    if (path.startsWith("/api/chat-sessions/") && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      return json(route, {
        id: path.split("/").at(-1),
        title: body.title ?? "E2E Chat",
        messages: body.messages ?? [],
        created_at: now,
        updated_at: now,
      });
    }
    if (path === "/api/chat" && method === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'data: {"type":"session","session_id":"session-e2e"}',
          "",
          'data: {"type":"text","content":"E2E answer with a durable result."}',
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
    if (path === "/api/assets/asset-e2e" && method === "GET") {
      return json(route, { id: "asset-e2e", user_id: "user-e2e", ...state.savedAssetBody, source_refs: state.savedAssetBody?.source_refs ?? [], note_refs: state.savedAssetBody?.note_refs ?? [], wiki_refs: state.savedAssetBody?.wiki_refs ?? [], created_at: now, updated_at: now });
    }
    if (path === "/api/assets/asset-e2e" && method === "PATCH") {
      state.savedAssetBody = { ...state.savedAssetBody, ...(request.postDataJSON() as Record<string, unknown>) };
      return json(route, { id: "asset-e2e", user_id: "user-e2e", ...state.savedAssetBody, source_refs: state.savedAssetBody?.source_refs ?? [], note_refs: state.savedAssetBody?.note_refs ?? [], wiki_refs: state.savedAssetBody?.wiki_refs ?? [], created_at: now, updated_at: now });
    }
    if (path === "/api/assets/asset-e2e/check-readiness") {
      return json(route, { ready: false, blocking_reasons: ["Review the draft before export"], warning_reasons: [], suggestion_reasons: [] });
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
    if (path === "/api/wiki/suggestions") return json(route, { items: [], total: 0 });
    if (path === "/api/wiki/mining/runs") return json(route, { items: [], total: 0 });
    if (path === "/api/sources") return json(route, { items: [{ id: "source-input", title: "E2E Source Evidence", source_type: "document", category_id: 1, ingested_at: now, metadata_: {} }], total: 1 });
    if (path === "/api/sources/source-input") {
      return json(route, {
        id: "source-input",
        title: "E2E Source Evidence",
        source_type: "document",
        category_id: 1,
        category_name: "Inbox",
        raw_content: "Evidence collected for the Asset handoff regression.",
        metadata_: {},
        ingested_at: now,
      });
    }
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

test("critical knowledge journey: login, chat, explicit save, inbox, and Agent Memory", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

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
  await expect(page.getByRole("heading", { name: "Pending Candidates" })).toBeVisible();
  await expect(page.getByText("E2E Paper Candidate")).toBeVisible();
  await expect(page.getByText("Paper Candidate", { exact: true }).first()).toBeVisible();

  await page.goto("/agent-memory");
  await expect(page.getByRole("heading", { name: "Agent Memory", exact: true })).toBeVisible();
  await expect(page.getByText("E2E Memory")).toBeVisible();
  await expect(page.getByText("Remember this E2E preference")).toBeVisible();
});

test("manual Asset generation creates PKG state only after the user confirms the Agent draft", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
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
  await page.getByLabel("Asset brief").fill("Explain the evidence and recommend the next architecture decision.");
  await page.getByLabel("Style guidance").fill("Concise and evidence-led.");
  await page.getByText("E2E Source Evidence").click();
  await expect.poll(() => state.savedAssetBody).toBeNull();

  await page.getByRole("button", { name: "Start Generation Session" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  let input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("E2E Research Brief");
  await expect.poll(() => (state.sessionContext?.assetDraft as Record<string, unknown> | undefined)?.title).toBe("E2E Research Brief");

  await page.goto("/chat");
  input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toContainText("E2E Research Brief");
  await expect(input).toContainText("Architecture reviewers");
  await input.press("Enter");
  await expect(page.getByText("E2E answer with a durable result.")).toBeVisible();
  await expect.poll(() => state.savedAssetBody).toBeNull();

  await page.getByRole("button", { name: "Save as Asset Draft" }).click();
  await expect.poll(() => state.savedAssetBody?.title).toBe("E2E Research Brief");
  expect(state.savedAssetBody).toMatchObject({
    asset_type: "research_brief",
    brief: "Explain the evidence and recommend the next architecture decision.",
    style_notes: "Concise and evidence-led.",
    source_refs: ["source-input"],
    status: "draft",
  });
  expect(state.savedAssetBody?.metadata).toMatchObject({
    audience: "Architecture reviewers",
    generation_mode: "manual_request",
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
  await expect(page.getByText("Production Actions")).toHaveCount(0);
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.getByLabel("Draft Markdown").fill("## Revised finding\n\nA clearer evidence-backed recommendation.");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect.poll(() => state.savedAssetBody?.draft_content).toContain("Revised finding");
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

test("Source Asset handoff opens the generation guide with evidence preselected", async ({ page }) => {
  const state: MockState = { loggedIn: false, savedNoteBody: null, savedAssetBody: null, candidate: null, memory: null, sessionContext: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/sources/source-input");
  await expect(page.getByRole("heading", { name: "E2E Source Evidence" })).toBeVisible();
  await page.getByRole("button", { name: "Create Asset", exact: true }).click();

  await expect(page).toHaveURL(/\/assets\/new$/);
  await expect(page.getByLabel("Asset title")).toHaveValue("E2E Source Evidence");
  await expect(page.getByLabel("Asset brief")).toHaveValue("Create a blog asset from source: E2E Source Evidence");
  await expect(page.getByLabel("E2E Source Evidence")).toBeChecked();
  await expect(page.getByText("1 knowledge records selected")).toBeVisible();
  await expect.poll(() => state.savedAssetBody).toBeNull();
});
