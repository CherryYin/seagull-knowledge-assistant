import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMockBff(page: Page) {
  let loggedIn = false;
  await page.route(`${apiBase}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/auth/login" && request.method() === "POST") {
      loggedIn = true;
      return json(route, { access_token: "mind-map-page-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return loggedIn
        ? json(route, {
            id: "mind-map-page-user",
            username: "mind-map-page-user",
            display_name: "Mind Map Page User",
            role: "user",
            approval_status: "approved",
            is_active: true,
          })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/me/settings") {
      return json(route, {
        settings: { modules: { onboarding_completed: true, enabled: [] } },
        updated_at: "2026-09-09T08:00:00.000Z",
      });
    }
    if (path === "/api/mind-maps/map-1/tree") {
      return json(route, {
        map: {
          id: "map-1",
          user_id: "mind-map-page-user",
          owner_type: "source",
          owner_id: "source-1",
          purpose: "document_overview",
          title: "Distributed systems map",
          root_node_id: "root",
          layout_mode: "balanced",
          version: 4,
          basis_revision: { chunk_revision: 2 },
          generation_status: "ready",
          created_at: "2026-09-09T08:00:00.000Z",
          updated_at: "2026-09-09T08:00:00.000Z",
        },
        root_id: "root",
        nodes: [
          { id: "root", map_id: "map-1", display_id: 1, parent_id: null, content: "Distributed systems", note: null, position: 0, collapsed: false, node_kind: "topic", updated_by: "human", created_at: "2026-09-09T08:00:00.000Z", updated_at: "2026-09-09T08:00:00.000Z" },
          { id: "branch", map_id: "map-1", display_id: 2, parent_id: "root", content: "Coordination", note: "How agents share state.", position: 0, collapsed: false, node_kind: "concept", updated_by: "agent", created_at: "2026-09-09T08:00:00.000Z", updated_at: "2026-09-09T08:00:00.000Z" },
          { id: "leaf", map_id: "map-1", display_id: 3, parent_id: "branch", content: "Shared state", note: null, position: 0, collapsed: false, node_kind: "evidence", updated_by: "human", created_at: "2026-09-09T08:00:00.000Z", updated_at: "2026-09-09T08:00:00.000Z" },
        ],
        references: [
          { id: "reference-1", map_id: "map-1", node_id: "branch", ref_type: "source_chunk", ref_id: "42", relation: "derived_from", fragment_selector: { page: 3, quote: "Consensus establishes a shared decision." }, created_at: "2026-09-09T08:00:00.000Z" },
        ],
      });
    }
    if (path === "/api/sources/source-1") {
      return json(route, {
        id: "source-1",
        title: "Distributed systems source",
        category_id: 1,
        category_name: "Research",
        source_type: "pdf",
        raw_content: "Coordination requires explicit failure handling.\n\nConsensus establishes a shared decision.",
        metadata_: {},
        ingested_at: "2026-09-09T08:00:00.000Z",
      });
    }
    if (path === "/api/sources/source-1/chunks") {
      return json(route, [
        { id: 41, source_id: "source-1", chunk_index: 0, content: "Coordination requires explicit failure handling." },
        { id: 42, source_id: "source-1", chunk_index: 1, content: "Consensus establishes a shared decision." },
      ]);
    }
    if (path === "/api/sources/source-1/chunk-count") return json(route, { count: 2 });
    if (path === "/api/categories") return json(route, { items: [{ id: 1, name: "Research" }], total: 1 });
    return json(route, {});
  });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("mind-map-page-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("production Mind Map page loads references and supports view controls", async ({ page }) => {
  await installMockBff(page);
  await signIn(page);

  await page.goto("/mind-maps/map-1");
  await expect(page.getByTestId("mind-map-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Distributed systems map" })).toBeVisible();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("3 visible / 3 total");

  await page.getByTestId("mind-map-node-branch").click();
  await expect(page.getByText("How agents share state.")).toBeVisible();
  await expect(page.getByText("Chunk #42", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Consensus establishes a shared decision.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Collapse Coordination" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("2 visible / 3 total");
  await page.getByRole("button", { name: "Expand Coordination" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("3 visible / 3 total");

  await page.getByRole("button", { name: "Focus selected" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("2 visible / 3 total");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("3 visible / 3 total");
});

test("Source Chunk reference opens the exact slice and preserves the selected node on return", async ({ page }) => {
  await installMockBff(page);
  await signIn(page);

  await page.goto("/mind-maps/map-1");
  await page.getByTestId("mind-map-node-branch").click();
  await page.getByRole("button", { name: "Open Source Chunk" }).click();

  await expect(page).toHaveURL(/\/sources\/source-1\?view=slices&chunk_id=42&page=3&quote=/);
  await expect(page.getByTestId("source-chunk-navigation-context")).toContainText("Chunk #42");
  await expect(page.getByTestId("source-chunk-navigation-context")).toContainText("Page 3");
  await expect(page.getByTestId("source-chunk-42")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("selected-source-chunk-content")).toContainText("Consensus establishes a shared decision.");

  await page.getByRole("button", { name: "Back to Mind Map" }).click();
  await expect(page).toHaveURL(/\/mind-maps\/map-1\?selected=branch/);
  await expect(page.getByRole("heading", { name: "Coordination", exact: true })).toBeVisible();
  await expect(page.getByText("Chunk #42", { exact: true })).toBeVisible();
});
