import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-09-09T08:00:00.000Z";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function initialNodes() {
  return [
    { id: "root", map_id: "map-1", display_id: 1, parent_id: null, content: "Distributed systems", note: null, position: 0, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now },
    { id: "branch", map_id: "map-1", display_id: 2, parent_id: "root", content: "Coordination", note: null, position: 0, collapsed: false, node_kind: "concept", updated_by: "agent", created_at: now, updated_at: now },
    { id: "leaf", map_id: "map-1", display_id: 3, parent_id: "branch", content: "Shared state", note: null, position: 0, collapsed: false, node_kind: "evidence", updated_by: "human", created_at: now, updated_at: now },
  ];
}

async function installMockBff(page: Page, options?: { restoreConflict?: boolean; outlineConflict?: boolean }) {
  let loggedIn = false;
  let version = 4;
  let nodes = initialNodes();
  let restoreRequests = 0;
  let outlineRequests = 0;
  const references = [
    { id: "reference-1", map_id: "map-1", node_id: "branch", ref_type: "source_chunk", ref_id: "42", relation: "derived_from", fragment_selector: { page: 3 }, created_at: now },
  ];
  const map = (mapVersion = version) => ({
    id: "map-1",
    user_id: "mind-map-history-user",
    owner_type: "source",
    owner_id: "source-1",
    purpose: "document_overview",
    title: "Distributed systems map",
    root_node_id: "root",
    layout_mode: "balanced",
    version: mapVersion,
    basis_revision: { chunk_revision: 2 },
    generation_status: "ready",
    created_at: now,
    updated_at: now,
  });
  const snapshot = (snapshotVersion: number, snapshotNodes = nodes) => ({
    map: map(snapshotVersion),
    nodes: snapshotNodes,
    references: snapshotNodes.some((node) => node.id === "branch") ? references : [],
  });
  const revision = (revisionVersion: number, action: string, summary: string, snapshotNodes = nodes) => ({
    id: `revision-${revisionVersion}`,
    map_id: "map-1",
    version: revisionVersion,
    actor_type: "human",
    actor_ref: null,
    action,
    summary,
    snapshot: snapshot(revisionVersion, snapshotNodes),
    created_at: now,
  });
  const historicalNodes = initialNodes().slice(0, 2);
  let revisions = [
    revision(4, "node_updated", "Updated shared state"),
    revision(3, "outline_applied", "Earlier two-node outline", historicalNodes),
  ];
  const mutation = (previousVersion: number, currentRevision: ReturnType<typeof revision>) => ({
    map_id: "map-1",
    previous_version: previousVersion,
    current_version: version,
    revision: currentRevision,
    node: null,
    reference: null,
    deleted_node_ids: [],
  });

  await page.route(`${apiBase}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/auth/login" && request.method() === "POST") {
      loggedIn = true;
      return json(route, { access_token: "mind-map-history-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return loggedIn
        ? json(route, { id: "mind-map-history-user", username: "mind-map-history-user", display_name: "Mind Map History User", role: "user", approval_status: "approved", is_active: true })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/me/settings") {
      return json(route, { settings: { modules: { onboarding_completed: true, enabled: [] } }, updated_at: now });
    }
    if (path === "/api/mind-maps/map-1/tree" && request.method() === "GET") {
      return json(route, { map: map(), root_id: "root", nodes, references });
    }
    if (path === "/api/mind-maps/map-1/revisions" && request.method() === "GET") {
      return json(route, { items: revisions, total: revisions.length });
    }
    const revisionMatch = path.match(/^\/api\/mind-maps\/map-1\/revisions\/(\d+)$/);
    if (revisionMatch && request.method() === "GET") {
      return json(route, revisions.find((item) => item.version === Number(revisionMatch[1])));
    }
    const restoreMatch = path.match(/^\/api\/mind-maps\/map-1\/revisions\/(\d+)\/restore$/);
    if (restoreMatch && request.method() === "POST") {
      restoreRequests += 1;
      const body = request.postDataJSON();
      expect(body).toEqual({ base_version: 4, confirm: true });
      if (options?.restoreConflict) {
        version = 5;
        nodes = [...initialNodes(), { id: "external", map_id: "map-1", display_id: 4, parent_id: "root", content: "External edit", note: null, position: 1, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now }];
        return json(route, { detail: { code: "mind_map_version_conflict", message: "Mind Map version changed: expected 4, current 5", map_id: "map-1", expected_version: 4, current_version: 5 } }, 409);
      }
      const previousVersion = version;
      nodes = historicalNodes;
      version += 1;
      const restoredRevision = revision(version, "revision_restored", "Restored revision 3", nodes);
      revisions = [restoredRevision, ...revisions];
      return json(route, mutation(previousVersion, restoredRevision));
    }
    if (path === "/api/mind-maps/map-1/outline/apply" && request.method() === "POST") {
      outlineRequests += 1;
      const body = request.postDataJSON();
      if (options?.outlineConflict) {
        version = 5;
        nodes = [...initialNodes(), { id: "external", map_id: "map-1", display_id: 4, parent_id: "root", content: "External outline", note: null, position: 1, collapsed: false, node_kind: "topic", updated_by: "agent", created_at: now, updated_at: now }];
        return json(route, { detail: { code: "mind_map_version_conflict", message: "Mind Map version changed: expected 4, current 5", map_id: "map-1", expected_version: 4, current_version: 5 } }, 409);
      }
      const previousVersion = version;
      if (body.mode === "merge") {
        nodes = [...nodes, { id: "new-branch", map_id: "map-1", display_id: 4, parent_id: "root", content: "New branch", note: null, position: 1, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now }];
      } else {
        expect(body.confirm_replace).toBe(true);
        nodes = [nodes[0], { id: "replacement", map_id: "map-1", display_id: 5, parent_id: "root", content: "Replacement branch", note: null, position: 0, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now }];
      }
      version += 1;
      const outlineRevision = revision(version, "outline_applied", `${body.mode} outline`, nodes);
      revisions = [outlineRevision, ...revisions];
      return json(route, {
        ...mutation(previousVersion, outlineRevision),
        mode: body.mode,
        created_count: 1,
        updated_count: body.mode === "merge" ? 3 : 1,
        moved_count: 0,
        deleted_count: body.mode === "replace" ? 3 : 0,
      });
    }
    return json(route, {});
  });
  return {
    getRestoreRequests: () => restoreRequests,
    getOutlineRequests: () => outlineRequests,
  };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("mind-map-history-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("revision restore and outline merge/replace create new versions", async ({ page }) => {
  await installMockBff(page);
  await signIn(page);
  await page.goto("/mind-maps/map-1");

  await expect(page.getByTestId("mind-map-revision-panel")).toContainText("Earlier two-node outline");
  await page.getByTestId("mind-map-revision-3").getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("dialog")).toContainText("2");
  await page.keyboard.press("Escape");

  await page.getByTestId("mind-map-revision-3").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("dialog")).toContainText("Current version: v4");
  await page.getByRole("button", { name: "Restore as new version" }).click();
  await expect(page.getByTestId("mind-map-current-version")).toHaveText("v5");
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("2 visible / 2 total");

  const outline = page.getByLabel("Mind Map outline");
  await expect(outline).toContainText("[id:1] Distributed systems");
  await outline.fill(`${await outline.inputValue()}\n  - New branch`);
  await page.getByRole("button", { name: "Apply merge" }).click();
  await expect(page.getByTestId("mind-map-outline-result")).toContainText("1 created");
  await expect(page.getByTestId("mind-map-current-version")).toHaveText("v6");

  await page.getByRole("button", { name: "Replace", exact: true }).click();
  const replaceButton = page.getByRole("button", { name: "Replace tree" });
  await expect(replaceButton).toBeDisabled();
  await outline.fill("- [id:1] Distributed systems\n  - Replacement branch");
  await page.getByLabel("Confirm replace outline").check();
  await replaceButton.click();
  await expect(page.getByTestId("mind-map-outline-result")).toContainText("3 deleted");
  await expect(page.getByTestId("mind-map-current-version")).toHaveText("v7");
  await expect(page.getByText("Replacement branch", { exact: true }).first()).toBeVisible();
});

test("restore conflict refreshes once and never replays", async ({ page }) => {
  const mock = await installMockBff(page, { restoreConflict: true });
  await signIn(page);
  await page.goto("/mind-maps/map-1");

  await page.getByTestId("mind-map-revision-3").getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore as new version" }).click();
  await expect(page.getByTestId("mind-map-version-conflict")).toContainText("changed from version 4 to 5");
  await expect(page.getByText("External edit", { exact: true }).first()).toBeVisible();
  expect(mock.getRestoreRequests()).toBe(1);
});

test("outline conflict refreshes once and never replays", async ({ page }) => {
  const mock = await installMockBff(page, { outlineConflict: true });
  await signIn(page);
  await page.goto("/mind-maps/map-1");

  const outline = page.getByLabel("Mind Map outline");
  await outline.fill(`${await outline.inputValue()}\n  - My stale branch`);
  await page.getByRole("button", { name: "Apply merge" }).click();
  await expect(page.getByTestId("mind-map-version-conflict")).toContainText("changed from version 4 to 5");
  await expect(page.getByText("External outline", { exact: true }).first()).toBeVisible();
  expect(mock.getOutlineRequests()).toBe(1);
});
