import { expect, test, type Page, type Route } from "@playwright/test";
import type { Project, ProjectResource, ProjectResourceOption } from "../src/lib/api/projects";

const now = "2026-10-12T08:00:00Z";
function project(id = "project-one", title = "Real goal"): Project {
  return { id, title, goal: "Make progress with existing knowledge", completion_criteria: "Deliver a reviewed draft",
    status: "active", revision: 1, resource_counts: {}, created_at: now, updated_at: now, completed_at: null, archived_at: null };
}
const source: ProjectResourceOption = { resource_type: "source", resource_id: "source-one", title: "Original paper", status: "ready", href: "/sources/source-one", updated_at: now };
function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}
async function mockProjects(page: Page, initial = [project()]) {
  await page.addInitScript(() => localStorage.setItem("auth_token", "project-test-token"));
  const state = { projects: initial, links: new Map<string, ProjectResource[]>(), conflictOnce: false, failList: false, patches: [] as Record<string, unknown>[] };
  const update = (saved: Project) => {
    saved.revision += 1;
    saved.resource_counts = {};
    for (const link of state.links.get(saved.id) ?? []) saved.resource_counts[link.resource_type] = (saved.resource_counts[link.resource_type] ?? 0) + 1;
  };
  await page.route("http://127.0.0.1:4000/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api", "");
    const method = request.method();
    if (path === "/auth/me") return json(route, { id: "owner", username: "owner", role: "user", approval_status: "approved", is_active: true });
    if (path === "/auth/me/settings") return json(route, { settings: { modules: { preset: "basic", enabled: [], disabled: [], pinned: [], onboarding_completed: true } }, updated_at: now });
    if (path === "/projects/resource-options") return json(route, { items: [], total: 0 });
    if (path === "/projects/for-resource") {
      const items = state.projects.filter(saved => (state.links.get(saved.id) ?? []).some(link => link.resource_id === url.searchParams.get("resource_id")));
      return json(route, { items, total: items.length });
    }
    if (path === "/library/search") return json(route, { items: [{ ...source, id: source.resource_id, entity_type: "source", lifecycle_status: "ready" }], total: 1 });
    if (path === "/projects") {
      if (method === "POST") {
        const saved = { ...project(`project-${state.projects.length + 1}`), ...request.postDataJSON() };
        state.projects.push(saved);
        return json(route, saved, 201);
      }
      if (state.failList) return json(route, { detail: "Offline" }, 503);
      const filtered = state.projects.filter(saved => Boolean(saved.archived_at) === (url.searchParams.get("archived") === "true")
        && (!url.searchParams.get("status") || saved.status === url.searchParams.get("status"))
        && saved.title.toLowerCase().includes((url.searchParams.get("query") ?? "").toLowerCase()));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(route, { items: filtered.slice(offset, offset + Number(url.searchParams.get("limit") ?? 20)), total: filtered.length });
    }
    const match = path.match(/^\/projects\/([^/]+)(.*)$/);
    if (match) {
      const saved = state.projects.find(item => item.id === match[1]);
      if (!saved) return json(route, { detail: "Project not found" }, 404);
      const suffix = match[2];
      const links = state.links.get(saved.id) ?? [];
      if (method === "GET") {
        if (!suffix) return json(route, saved);
        const filtered = links.filter(link => !url.searchParams.get("resource_type") || link.resource_type === url.searchParams.get("resource_type"));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json(route, { items: filtered.slice(offset, offset + Number(url.searchParams.get("limit") ?? 20)), total: filtered.length, revision: saved.revision });
      }
      const body = method === "DELETE" ? { base_revision: Number(url.searchParams.get("base_revision")) } : request.postDataJSON();
      if (state.conflictOnce) {
        state.conflictOnce = false;
        saved.goal = "Goal changed in another tab";
        update(saved);
      }
      if (body.base_revision !== saved.revision) return json(route, { detail: "Project changed. Refresh before retrying." }, 409);
      if (saved.archived_at && suffix !== "/restore") return json(route, { detail: "Project is archived" }, 409);
      if (method === "PATCH") {
        state.patches.push(body);
        Object.assign(saved, body);
        delete (saved as unknown as Record<string, unknown>).base_revision;
        saved.completed_at = saved.status === "completed" ? now : null;
      } else if (suffix === "/archive") saved.archived_at = now;
      else if (suffix === "/restore") saved.archived_at = null;
      else if (method === "DELETE") state.links.set(saved.id, links.filter(link => link.id !== suffix.split("/").at(-1)));
      else if (suffix === "/resources") {
        for (const ref of body.resources) if (!links.some(link => link.resource_id === ref.resource_id && link.resource_type === ref.resource_type)) links.push({ ...source, ...ref, id: `link-${links.length + 1}`, created_at: now });
        state.links.set(saved.id, links);
        update(saved);
        return json(route, { project: saved, added: body.resources.length });
      }
      update(saved);
      return json(route, saved);
    }
    if (path === "/sources/source-one") return json(route, { id: source.resource_id, user_id: "owner", title: source.title, source_type: "article", raw_content: "Original content remains intact", metadata: {}, ingested_at: now });
    return json(route, { items: [], total: 0 });
  });
  return state;
}

test("create, complete, archive, restore and reopen without changing content", async ({ page }) => {
  const state = await mockProjects(page, []);
  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByLabel("Project name").fill("My real project");
  await page.getByLabel("Goal", { exact: true }).fill("Write a reviewed article");
  await page.getByLabel("Completion criteria").fill("Publish after review");
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My real project" })).toBeVisible();
  for (const action of ["Mark Complete", "Archive Project", "Restore Project", "Reopen Project"]) {
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.getByRole("button", { name: "Confirm project change" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (action === "Archive Project") await expect(page.getByRole("button", { name: "Edit Project" })).toHaveCount(0);
  }
  expect(state.projects[0]).toMatchObject({ title: "My real project", status: "active", archived_at: null, revision: 5 });
});

test("409 keeps edits and does not overwrite untouched fields", async ({ page }) => {
  const state = await mockProjects(page);
  await page.goto("/projects/project-one");
  await page.getByRole("button", { name: "Edit Project" }).click();
  await page.getByLabel("Project name").fill("My edited title");
  state.conflictOnce = true;
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your edits are retained");
  await expect(page.getByLabel("Project name")).toHaveValue("My edited title");
  await page.getByRole("button", { name: "Load latest revision (keep edits)", exact: true }).click();
  await expect(page.getByText("Latest saved version (revision 2)")).toBeVisible();
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My edited title" })).toBeVisible();
  expect(state.projects[0].goal).toBe("Goal changed in another tab");
  expect(state.patches[0]).toEqual({ title: "My edited title", base_revision: 2 });
});

test("add conflict retains selection; reverse links and removal preserve shared source", async ({ page }) => {
  const state = await mockProjects(page, [project(), project("project-two", "Second goal")]);
  state.links.set("project-two", [{ ...source, id: "shared-link", reason: "", created_at: now }]);
  await page.goto("/projects/project-one?tab=knowledge");
  await page.getByRole("button", { name: "Add existing resources" }).click();
  await page.getByRole("checkbox", { name: /Original paper/ }).check();
  state.conflictOnce = true;
  await page.getByRole("button", { name: /Add .*selected/ }).click();
  await expect(page.getByRole("alert")).toContainText("retained");
  await expect(page.getByRole("checkbox", { name: /Original paper/ })).toBeChecked();
  await page.getByRole("button", { name: /Refresh project revision/ }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /Add .*selected/ }).click();
  await page.getByRole("link", { name: "Original paper", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to Project" })).toBeVisible();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Second goal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back to Project" }).click();
  await page.getByRole("button", { name: "Remove link", exact: true }).click();
  await page.getByRole("button", { name: "Confirm remove link" }).click();
  await expect(page.getByText("No linked sources yet.", { exact: false })).toBeVisible();
  expect(state.links.get("project-one")).toHaveLength(0);
  expect(state.links.get("project-two")).toHaveLength(1);
});

test("pagination and filtering expose projects beyond the first page", async ({ page }) => {
  await mockProjects(page, Array.from({ length: 23 }, (_, index) => project(`project-${index}`, `Goal ${index}`)));
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Goal 19", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Goal 22", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next projects" }).click();
  await expect(page.getByRole("heading", { name: "Goal 22", exact: true })).toBeVisible();
  await page.getByLabel("Search projects", { exact: true }).fill("Goal 1");
  await expect(page.getByRole("heading", { name: "Goal 1", exact: true })).toBeVisible();
});

test("unavailable projects are not shown as empty; retry recovers", async ({ page }) => {
  const state = await mockProjects(page);
  state.failList = true;
  await page.goto("/projects");
  await expect(page.getByRole("alert")).toContainText("unavailable, not empty", { timeout: 15000 });
  await expect(page.getByText("Start with one real goal")).toHaveCount(0);
  state.failList = false;
  await page.getByRole("button", { name: "Retry projects" }).click();
  await expect(page.getByRole("heading", { name: "Real goal", exact: true })).toBeVisible();
});

test("URL tabs survive reload and archive disables association writes", async ({ page }) => {
  const saved = project();
  saved.archived_at = now;
  await mockProjects(page, [saved]);
  await page.goto("/projects/project-one?tab=outputs");
  await expect(page.getByRole("tab", { name: "Outputs", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Add existing resources" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(page).toHaveURL(/tab=sessions/);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Linking a session does not change", { exact: false })).toBeVisible();
});
