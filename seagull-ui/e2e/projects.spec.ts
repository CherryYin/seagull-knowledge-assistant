import { expect, test, type Page, type Route } from "@playwright/test";
import type { Project, ProjectResource, ProjectResourceOption } from "../src/lib/api/projects";
import type { CalendarReminder } from "../src/lib/api/calendar-reminders";

const now = "2026-10-12T08:00:00Z";
function project(id = "project-one", title = "Real goal"): Project {
  return { id, title, goal: "Make progress with existing knowledge", completion_criteria: "Deliver a reviewed draft",
    status: "active", revision: 1, resource_counts: {}, created_at: now, updated_at: now, completed_at: null, archived_at: null };
}
const source: ProjectResourceOption = { resource_type: "source", resource_id: "source-one", title: "Original paper", status: "ready", href: "/sources/source-one", updated_at: now };
function task(id = "task-one", text = "Review material", projectId: string | null = "project-one"): CalendarReminder {
  return { id, text, project_id: projectId, user_id: "owner", date: null, recurrence: "once", is_done: false,
    completed_at: null, note_ids: [], linked_notes: [], created_at: now, updated_at: now };
}
function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}
async function mockProjects(page: Page, initial = [project()]) {
  await page.addInitScript(() => localStorage.setItem("auth_token", "project-test-token"));
  const state = { projects: initial, tasks: [] as CalendarReminder[], completions: new Map<string, Set<string>>(), failTasks: false,
    links: new Map<string, ProjectResource[]>(), conflictOnce: false, failList: false, patches: [] as Record<string, unknown>[] };
  const update = (saved: Project) => {
    saved.revision += 1;
    saved.resource_counts = {};
    for (const link of state.links.get(saved.id) ?? []) saved.resource_counts[link.resource_type] = (saved.resource_counts[link.resource_type] ?? 0) + 1;
  };
  const listTasks = (url: URL, projectId?: string) => {
    let items = state.tasks.filter(item => !projectId || item.project_id === projectId);
    const kind = url.searchParams.get("kind");
    if (kind) items = items.filter(item => kind === "once" ? item.recurrence === "once" : item.recurrence !== "once");
    if (!projectId) {
      if (url.searchParams.get("unscheduled_only") === "true") items = items.filter(item => item.date === null);
      else if (url.searchParams.get("include_unscheduled") !== "true") items = items.filter(item => item.date !== null);
      if (url.searchParams.get("unassigned_only") === "true") items = items.filter(item => !item.project_id);
    }
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (kind === "recurring" && start && end) items = items.flatMap(item => {
      const occurrences: CalendarReminder[] = [];
      const interval = { daily: 1, weekly: 7, biweekly: 14 }[item.recurrence as "daily" | "weekly" | "biweekly"];
      for (let cursor = new Date(`${start}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= end; cursor = new Date(cursor.getTime() + 86400000)) {
        const day = cursor.toISOString().slice(0, 10);
        const delta = (cursor.getTime() - new Date(`${item.date}T00:00:00Z`).getTime()) / 86400000;
        if (delta >= 0 && delta % interval === 0) occurrences.push({ ...item, date: day, is_done: state.completions.get(item.id)?.has(day) ?? false });
      }
      return occurrences;
    });
    else if (!projectId && (start || end)) items = items.filter(item => !item.date || ((!start || item.date >= start) && (!end || item.date <= end)));
    if (url.searchParams.get("include_done") === "false") items = items.filter(item => !item.is_done);
    if (url.searchParams.get("completed_only") === "true") items = items.filter(item => item.is_done);
    const completedStart = url.searchParams.get("completion_start");
    const completedEnd = url.searchParams.get("completion_end");
    if (completedStart || completedEnd) items = items.filter(item => !item.completed_at || ((!completedStart || item.completed_at.slice(0, 10) >= completedStart) && (!completedEnd || item.completed_at.slice(0, 10) <= completedEnd)));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return { items: items.slice(offset, offset + Number(url.searchParams.get("limit") ?? items.length)), total: items.length, overdue_count: 0 };
  };
  await page.route("http://127.0.0.1:4000/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api", "");
    const method = request.method();
    if (path === "/auth/me") return json(route, { id: "owner", username: "owner", role: "user", approval_status: "approved", is_active: true });
    if (path === "/auth/me/settings") return json(route, { settings: { modules: { preset: "basic", enabled: ["calendar", "completed"], disabled: [], pinned: [], onboarding_completed: true } }, updated_at: now });
    if (path === "/knowledge/dashboard") return json(route, { counts: { notes: 0, sources: 0, chats: 0, digest_pending: 0 }, trends: [], category_distribution: [], note_type_distribution: [] });
    if (path === "/calendar/reminders" && method === "GET") return json(route, listTasks(url));
    const taskRoute = path.match(/^\/projects\/([^/]+)\/(tasks(?:\/([^/]+)(\/attach)?)?|next-task)$/);
    const globalTask = path.match(/^\/calendar\/reminders\/([^/]+)$/);
    if (taskRoute || globalTask || (path === "/calendar/reminders" && method === "POST")) {
      const saved = taskRoute ? state.projects.find(item => item.id === taskRoute[1]) : undefined;
      if (taskRoute && !saved) return json(route, { detail: "Project not found" }, 404);
      if (method === "GET") {
        if (state.failTasks) return json(route, { detail: "Tasks offline" }, 503);
        const members = state.tasks.filter(item => item.project_id === saved!.id && item.recurrence === "once");
        return json(route, { ...listTasks(url, saved!.id), pending_count: members.filter(item => !item.is_done).length,
          completed_count: members.filter(item => item.is_done).length, next_task: members.find(item => item.id === saved!.next_reminder_id && !item.is_done) ?? null });
      }
      const body = method === "DELETE" ? { base_revision: Number(url.searchParams.get("base_revision")) } : request.postDataJSON();
      if (saved) {
        if (state.conflictOnce) { state.conflictOnce = false; update(saved); }
        if (body.base_revision !== saved.revision) return json(route, { detail: "Project changed. Refresh before retrying." }, 409);
        if (saved.archived_at) return json(route, { detail: "Project is archived" }, 409);
      }
      if (taskRoute?.[2] === "next-task") {
        saved!.next_reminder_id = body.reminder_id;
        update(saved!);
        return json(route, saved);
      }
      const taskId = taskRoute?.[3] ?? globalTask?.[1];
      if (!taskId && method === "POST") {
        const created = { ...task(`task-${state.tasks.length + 1}`, body.text, saved?.id ?? null), ...body };
        delete created.base_revision;
        state.tasks.push(created);
        if (saved) update(saved);
        return json(route, created, 201);
      }
      const existing = state.tasks.find(item => item.id === taskId);
      if (!existing) return json(route, { detail: "Task not found" }, 404);
      if (taskRoute?.[4]) { existing.project_id = saved!.id; update(saved!); }
      else if (method === "DELETE") {
        existing.project_id = null;
        if (saved?.next_reminder_id === existing.id) saved.next_reminder_id = null;
        update(saved!);
      } else {
        if (existing.recurrence !== "once" && body.is_done !== undefined) {
          const dates = state.completions.get(existing.id) ?? new Set<string>();
          if (body.is_done) dates.add(body.occurrence_date); else dates.delete(body.occurrence_date);
          state.completions.set(existing.id, dates);
        } else {
          if (body.is_done !== undefined) existing.completed_at = body.is_done ? new Date().toISOString() : null;
          for (const key of ["date", "text", "recurrence", "is_done"] as const) if (key in body) Object.assign(existing, { [key]: body[key] });
        }
        const parent = state.projects.find(item => item.id === existing.project_id);
        if (parent?.next_reminder_id === existing.id && (existing.is_done || existing.recurrence !== "once")) { parent.next_reminder_id = null; update(parent); }
      }
      return json(route, existing);
    }
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

test("project unscheduled action, next step, Home completion and reopen share one Todo", async ({ page }) => {
  const state = await mockProjects(page);
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "New Task", exact: true }).click();
  await page.getByLabel("Task description").fill("Read and compare approaches");
  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(page.getByText("Read and compare approaches", { exact: true })).toBeVisible();
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].date).toBeNull();
  await page.getByRole("button", { name: "Make next step" }).click();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByText("1 pending · 0 completed", { exact: false })).toBeVisible();
  await expect(page.getByText("Read and compare approaches", { exact: true })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unscheduled Todos", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(page.getByText("Read and compare approaches", { exact: true })).toHaveCount(0);
  await page.goto("/projects/project-one");
  await expect(page.getByText("0 pending · 1 completed", { exact: false })).toBeVisible();
  await expect(page.getByText("No next step selected.", { exact: false })).toBeVisible();
  expect(state.projects[0].status).toBe("active");
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Reopen task" }).click();
  await expect(page.getByRole("button", { name: "Make next step" })).toBeVisible();
  expect(state.tasks[0].completed_at).toBeNull();
});

test("schedule an unscheduled action then complete the same Todo in Calendar", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  const day = new Date().toISOString().slice(0, 10);
  await page.goto("/");
  await page.getByRole("button", { name: "Edit task" }).click();
  await page.getByLabel("Scheduled date", { exact: false }).fill(day);
  await page.getByRole("button", { name: "Save Task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`/calendar?date=${day}`);
  await expect(page.getByRole("paragraph").filter({ hasText: /^Review material$/ })).toBeVisible();
  await page.getByTitle("Mark as done", { exact: true }).click();
  await expect(page.getByTitle("Mark as open", { exact: true })).toBeVisible();
  await page.goto("/projects/project-one");
  await expect(page.getByText("0 pending · 1 completed", { exact: false })).toBeVisible();
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].date).toBe(day);
});

test("removing a project task keeps its Todo available on Home", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  state.projects[0].next_reminder_id = "task-one";
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Remove from project" }).click();
  await expect(page.getByRole("dialog")).toContainText("linked notes");
  await page.getByRole("button", { name: "Confirm remove task" }).click();
  await expect(page.getByText("No matching project actions.", { exact: false })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Review material", { exact: true })).toBeVisible();
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].project_id).toBeNull();
  expect(state.projects[0].next_reminder_id).toBeNull();
});

test("existing Todo attachment conflict retains selection without copying", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task("loose", "Existing action", null));
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Add existing Todo", exact: true }).click();
  await page.getByRole("radio", { name: /Existing action/ }).check();
  state.conflictOnce = true;
  await page.getByRole("button", { name: "Confirm add Todo" }).click();
  await expect(page.getByRole("alert")).toContainText("choice is retained");
  await expect(page.getByRole("radio", { name: /Existing action/ })).toBeChecked();
  await page.getByRole("button", { name: "Refresh project revision (keep Todo)", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm add Todo" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Existing action", { exact: true })).toBeVisible();
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].project_id).toBe("project-one");
});

test("archived Tasks are read-only while existing global Todos remain completable", async ({ page }) => {
  const saved = project();
  saved.archived_at = now;
  const state = await mockProjects(page, [saved]);
  state.tasks.push(task());
  await page.goto("/projects/project-one?tab=tasks");
  await expect(page.getByText("Review material", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Task", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Complete task", exact: true })).toHaveCount(0);
  await page.goto("/");
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(page.getByText("Review material", { exact: true })).toHaveCount(0);
  expect(state.tasks[0].is_done).toBe(true);
});

test("recurring task rows complete only the chosen occurrence and exclude one-time counts", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push({ ...task("weekly", "Weekly review"), date: "2026-10-13", recurrence: "weekly" });
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByLabel("Action type").selectOption("recurring");
  await page.getByLabel("From", { exact: true }).fill("2026-10-13");
  await page.getByLabel("To", { exact: true }).fill("2026-10-27");
  await expect(page.getByText("Weekly review", { exact: true })).toHaveCount(3);
  const occurrence = page.locator("div.rounded-xl").filter({ has: page.getByText("Weekly review", { exact: true }) }).filter({ hasText: "2026-10-20" });
  await occurrence.getByRole("button", { name: "Complete occurrence" }).click();
  await expect(occurrence.getByRole("button", { name: "Reopen task" })).toBeVisible();
  expect(state.completions.get("weekly")?.has("2026-10-20")).toBe(true);
  expect(state.completions.get("weekly")?.has("2026-10-13")).not.toBe(true);
  expect(state.tasks[0].is_done).toBe(false);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByText("0 pending · 0 completed", { exact: false })).toBeVisible();
});

test("completed unscheduled view separates unknown times from selected-range completions", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push({ ...task("known", "Known completion"), is_done: true, completed_at: new Date().toISOString() },
    { ...task("unknown", "Legacy completion"), is_done: true });
  await page.goto("/completed");
  await page.getByRole("button", { name: "Unscheduled Todos", exact: true }).click();
  await expect(page.getByText("Known completion", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Completion time unknown" })).toBeVisible();
  await expect(page.getByText("Legacy completion", { exact: true })).toBeVisible();
  await expect(page.getByText("not counted as completions", { exact: false })).toBeVisible();
});

test("task pagination and overview use all actions rather than the first page", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(...Array.from({ length: 23 }, (_, index) => task(`task-${index}`, `Action ${index}`)));
  await page.goto("/projects/project-one");
  await expect(page.getByText("23 pending · 0 completed", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(page.getByText("Action 22", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next tasks" }).click();
  await expect(page.getByText("Action 22", { exact: true })).toBeVisible();
});

test("project task creation conflict retains draft text and date", async ({ page }) => {
  const state = await mockProjects(page);
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "New Task", exact: true }).click();
  await page.getByLabel("Task description").fill("Keep my task draft");
  await page.getByLabel("Scheduled date", { exact: false }).fill("2026-10-20");
  state.conflictOnce = true;
  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("edits are retained");
  await expect(page.getByLabel("Task description")).toHaveValue("Keep my task draft");
  await page.getByRole("button", { name: "Load latest project revision (keep task edits)", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(page.getByText("Keep my task draft", { exact: true })).toBeVisible();
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0].date).toBe("2026-10-20");
});

test("unavailable task summary reports unknown counts and recovers", async ({ page }) => {
  const state = await mockProjects(page);
  state.failTasks = true;
  await page.goto("/projects/project-one");
  await expect(page.getByRole("alert")).toContainText("unavailable, not empty", { timeout: 15000 });
  await expect(page.getByText("0 pending · 0 completed", { exact: false })).toHaveCount(0);
  state.failTasks = false;
  await page.getByRole("button", { name: "Retry project actions" }).click();
  await expect(page.getByText("0 pending · 0 completed", { exact: false })).toBeVisible();
});

test("completing the last unscheduled task on page two returns to a valid page", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(...Array.from({ length: 21 }, (_, index) => task(`task-${index}`, `Unscheduled action ${index}`, null)));
  await page.goto("/");
  await page.getByRole("button", { name: "Next unscheduled Todos" }).click();
  await expect(page.getByText("Unscheduled action 20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(page.getByText("Unscheduled action 0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete task", exact: true })).toHaveCount(20);
});
