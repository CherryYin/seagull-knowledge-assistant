import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-09-09T08:00:00.000Z";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function initialNodes() {
  return [
    { id: "root", map_id: "map-1", display_id: 1, parent_id: null, content: "Distributed systems", note: null, position: 0, collapsed: false, node_kind: "topic", updated_by: "human", created_at: now, updated_at: now },
    { id: "branch", map_id: "map-1", display_id: 2, parent_id: "root", content: "Coordination", note: "How agents share state.", position: 0, collapsed: false, node_kind: "concept", updated_by: "agent", created_at: now, updated_at: now },
    { id: "leaf", map_id: "map-1", display_id: 3, parent_id: "branch", content: "Shared state", note: null, position: 0, collapsed: false, node_kind: "evidence", updated_by: "human", created_at: now, updated_at: now },
  ];
}

async function installMockBff(page: Page, options?: { conflictOnFirstEdit?: boolean }) {
  let loggedIn = false;
  let version = 4;
  let nextNode = 4;
  let editRequests = 0;
  let nodes = initialNodes();
  let references = [
    { id: "reference-1", map_id: "map-1", node_id: "branch", ref_type: "source_chunk", ref_id: "42", relation: "derived_from", fragment_selector: { page: 3 }, created_at: now },
  ];
  const tree = () => ({
    map: {
      id: "map-1",
      user_id: "mind-map-mutation-user",
      owner_type: "source",
      owner_id: "source-1",
      purpose: "document_overview",
      title: "Distributed systems map",
      root_node_id: "root",
      layout_mode: "balanced",
      version,
      basis_revision: { chunk_revision: 2 },
      generation_status: "ready",
      created_at: now,
      updated_at: now,
    },
    root_id: "root",
    nodes,
    references,
  });
  const mutation = (previousVersion: number, node?: (typeof nodes)[number], deletedNodeIds: string[] = []) => ({
    map_id: "map-1",
    previous_version: previousVersion,
    current_version: version,
    revision: { id: `revision-${version}`, map_id: "map-1", version, action: "node_updated", summary: "Mind Map mutation", created_at: now },
    node: node ?? null,
    reference: null,
    deleted_node_ids: deletedNodeIds,
  });

  await page.route(`${apiBase}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/auth/login" && request.method() === "POST") {
      loggedIn = true;
      return json(route, { access_token: "mind-map-mutation-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return loggedIn
        ? json(route, { id: "mind-map-mutation-user", username: "mind-map-mutation-user", display_name: "Mind Map Mutation User", role: "user", approval_status: "approved", is_active: true })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/me/settings") {
      return json(route, { settings: { modules: { onboarding_completed: true, enabled: [] } }, updated_at: now });
    }
    if (path === "/api/mind-maps/map-1/tree" && request.method() === "GET") return json(route, tree());

    if (path === "/api/mind-maps/map-1/nodes" && request.method() === "POST") {
      const body = request.postDataJSON();
      const previousVersion = version;
      const node = {
        id: `node-${nextNode}`,
        map_id: "map-1",
        display_id: nextNode++,
        parent_id: body.parent_id,
        content: body.content,
        note: body.note,
        position: nodes.filter((item) => item.parent_id === body.parent_id).length,
        collapsed: false,
        node_kind: body.node_kind,
        updated_by: "human",
        created_at: now,
        updated_at: now,
      };
      nodes = [...nodes, node];
      version += 1;
      return json(route, mutation(previousVersion, node));
    }

    const moveMatch = path.match(/^\/api\/mind-maps\/map-1\/nodes\/([^/]+)\/move$/);
    if (moveMatch && request.method() === "POST") {
      const nodeId = decodeURIComponent(moveMatch[1]);
      const body = request.postDataJSON();
      const previousVersion = version;
      nodes = nodes.map((node) => node.id === nodeId ? { ...node, parent_id: body.parent_id, position: body.position, updated_by: "human" } : node);
      version += 1;
      return json(route, mutation(previousVersion, nodes.find((node) => node.id === nodeId)));
    }

    const nodeMatch = path.match(/^\/api\/mind-maps\/map-1\/nodes\/([^/]+)$/);
    if (nodeMatch && request.method() === "PATCH") {
      editRequests += 1;
      const nodeId = decodeURIComponent(nodeMatch[1]);
      const body = request.postDataJSON();
      if (options?.conflictOnFirstEdit && editRequests === 1) {
        version = 5;
        nodes = nodes.map((node) => node.id === nodeId ? { ...node, content: "Coordination from another editor" } : node);
        return json(route, {
          detail: {
            code: "mind_map_version_conflict",
            message: "Mind Map version changed: expected 4, current 5",
            map_id: "map-1",
            expected_version: 4,
            current_version: 5,
          },
        }, 409);
      }
      const previousVersion = version;
      nodes = nodes.map((node) => node.id === nodeId ? { ...node, content: body.content, note: body.note, node_kind: body.node_kind, updated_by: "human" } : node);
      version += 1;
      return json(route, mutation(previousVersion, nodes.find((node) => node.id === nodeId)));
    }
    if (nodeMatch && request.method() === "DELETE") {
      const nodeId = decodeURIComponent(nodeMatch[1]);
      const deletedIds = new Set<string>();
      const pending = [nodeId];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (deletedIds.has(current)) continue;
        deletedIds.add(current);
        pending.push(...nodes.filter((node) => node.parent_id === current).map((node) => node.id));
      }
      const previousVersion = version;
      nodes = nodes.filter((node) => !deletedIds.has(node.id));
      references = references.filter((reference) => !deletedIds.has(reference.node_id));
      version += 1;
      return json(route, mutation(previousVersion, undefined, [...deletedIds].sort()));
    }
    return json(route, {});
  });
  return { getEditRequests: () => editRequests };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("mind-map-mutation-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("Mind Map node add, edit, move, and delete use current versions", async ({ page }) => {
  await installMockBff(page);
  await signIn(page);
  await page.goto("/mind-maps/map-1");

  await page.getByTestId("mind-map-node-branch").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Node content").fill("Coordination updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Coordination updated", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("v5", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add child" }).click();
  await page.getByLabel("Node content").fill("New protocol");
  await page.getByRole("button", { name: "Add node" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("4 visible / 4 total");

  await page.getByTestId("mind-map-node-leaf").click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByLabel("New parent").selectOption("root");
  await page.getByRole("button", { name: "Move node" }).click();
  await expect(page.getByText("v7", { exact: true })).toBeVisible();

  await page.getByTestId("mind-map-node-branch").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(/This removes 2 nodes and 1 formal reference/)).toBeVisible();
  await page.getByRole("button", { name: "Delete subtree" }).click();
  await expect(page.getByTestId("mind-map-visible-summary")).toHaveText("2 visible / 2 total");
  await expect(page.getByTestId("mind-map-node-branch")).toHaveCount(0);
});

test("Mind Map version conflict refreshes without replaying the mutation", async ({ page }) => {
  const mock = await installMockBff(page, { conflictOnFirstEdit: true });
  await signIn(page);
  await page.goto("/mind-maps/map-1");

  await page.getByTestId("mind-map-node-branch").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Node content").fill("My stale edit");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByTestId("mind-map-version-conflict")).toContainText("changed from version 4 to 5");
  await expect(page.getByText("Coordination from another editor", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mock.getEditRequests()).toBe(1);
});
