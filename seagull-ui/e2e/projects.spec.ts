import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import type { Project, ProjectContextSnapshot, ProjectResource, ProjectResourceOption, TodoResource } from "../src/lib/api/projects";
import type { CalendarReminder } from "../src/lib/api/calendar-reminders";
import type { ChatSessionRecord } from "../src/lib/api/chat-sessions";

const now = "2026-10-12T08:00:00Z";
function project(id = "project-one", title = "Real goal"): Project {
  return { id, title, goal: "Make progress with existing knowledge", completion_criteria: "Deliver a reviewed draft",
    status: "active", revision: 1, resource_counts: {}, created_at: now, updated_at: now, completed_at: null, archived_at: null };
}
const source: ProjectResourceOption = { resource_type: "source", resource_id: "source-one", title: "Original paper", status: "ready", href: "/sources/source-one", updated_at: now };
const asset: ProjectResourceOption = { resource_type: "asset", resource_id: "asset-one", title: "Reviewed article", status: "draft", href: "/assets/asset-one", updated_at: now };
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
    links: new Map<string, ProjectResource[]>(), taskLinks: [] as TodoResource[], failResources: false, failResults: false,
    sessions: [] as ChatSessionRecord[], chatRequests: [] as Record<string, unknown>[], failPreview: false, summary: "Selected source summary",
    conflictOnce: false, failList: false, patches: [] as Record<string, unknown>[], outputSaves: 0,
    loseResultResponseOnce: false, failReceiptOnce: false, resultRequests: [] as Record<string, unknown>[] };
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
    if (path === "/categories") return json(route, { items: [{ id: 1, name: "General" }], total: 1 });
    if (["/notes", "/assets", "/wiki"].includes(path) && method === "POST") {
      state.outputSaves += 1;
      return json(route, { ...request.postDataJSON(), id: `saved-${path.slice(1)}-${state.outputSaves}` }, 201);
    }
    if (path === "/harness/models") return json(route, { models: [], default_model: null });
    if (path.startsWith("/harness/session-contexts/")) return json(route, { context: null });
    if (path.startsWith("/harness/memory-recalls")) return json(route, { items: [] });
    if (path === "/chat-sessions") {
      if (method === "GET") return json(route, { items: state.sessions, total: state.sessions.length });
      const body = request.postDataJSON();
      const session = { id: body.id, title: "New Session", messages: [], created_at: now, updated_at: now };
      state.sessions.push(session);
      return json(route, session, 201);
    }
    if (path.startsWith("/chat-sessions/")) {
      const session = state.sessions.find(item => item.id === path.split("/").at(-1));
      if (!session) return json(route, { detail: "Session not found" }, 404);
      if (method === "PATCH") {
        if (state.failReceiptOnce && request.postDataJSON().messages?.some((message: { metadata?: { save_receipts?: unknown } }) => message.metadata?.save_receipts)) {
          state.failReceiptOnce = false;
          return json(route, { detail: "Receipt storage unavailable" }, 503);
        }
        Object.assign(session, request.postDataJSON());
      }
      return json(route, session);
    }
    if (path === "/chat") {
      state.chatRequests.push(request.postDataJSON());
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "text", content: "Project grounded answer" })}\n\ndata: [DONE]\n\n` });
    }
    const contextRoute = path.match(/^\/projects\/([^/]+)\/(context-preview|context-session)(?:\/([^/]+))?$/);
    if (contextRoute) {
      const saved = state.projects.find(item => item.id === contextRoute[1]);
      if (!saved) return json(route, { detail: "Project not found" }, 404);
      if (state.failPreview) return json(route, { detail: "Project context unavailable" }, 503);
      const body = request.postDataJSON();
      const prepared = state.sessions.find(item => item.id === body.session_id);
      if (contextRoute[2] === "context-session" && !contextRoute[3] && prepared?.project_context?.launch_fingerprint === body.expected_fingerprint) return json(route, prepared, 201);
      if (body.base_revision !== saved.revision || saved.archived_at) return json(route, { detail: "Project changed. Review a fresh preview before sending; no model was called." }, 409);
      const makeSnapshot = (): ProjectContextSnapshot => {
        const action = state.tasks.find(item => item.id === body.reminder_id);
        const selectedResources = (body.resources ?? []).map((ref: { resource_type: string; resource_id: string }) => ({ ...(state.links.get(saved.id) ?? []).find(item => item.resource_type === ref.resource_type && item.resource_id === ref.resource_id), summary: state.summary, truncated: false }));
        const snapshot = { version: 1 as const, project_id: saved.id, project_revision: saved.revision, title: saved.title, goal: saved.goal,
          completion_criteria: saved.completion_criteria, status: saved.status, generated_at: now,
          task: action ? { id: action.id, text: action.text, is_done: action.is_done, recurrence: action.recurrence, date: action.date, updated_at: action.updated_at } : null,
          resources: selectedResources, context_text: `Project: ${saved.title}\nGoal: ${saved.goal}\nCompletion criteria: ${saved.completion_criteria}\n${action ? `Action: ${action.text}\n` : ""}${selectedResources.map((item: ProjectResourceOption & { summary: string }) => `${item.title}: ${item.summary}`).join("\n")}`, truncated: false, fingerprint: "" };
        snapshot.fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        return snapshot;
      };
      const snapshot = makeSnapshot();
      if (body.expected_fingerprint && body.expected_fingerprint !== snapshot.fingerprint) return json(route, { detail: "Project context changed. Review a fresh preview before sending; no model was called." }, 409);
      if (contextRoute[2] === "context-preview") return json(route, snapshot);
      if (contextRoute[3]) {
        const session = state.sessions.find(item => item.id === contextRoute[3]);
        if (!session?.project_context || session.project_context.project_id !== saved.id) return json(route, { detail: "Wrong execution project" }, 404);
        session.project_context = snapshot;
        return json(route, session);
      }
      const projectLinks = state.links.get(saved.id) ?? [];
      projectLinks.push({ id: `session-link-${body.session_id}`, resource_type: "chat_session", resource_id: body.session_id, title: saved.title,
        href: `/chat?session=${body.session_id}`, status: null, updated_at: now, reason: "Project working session", created_at: now });
      state.links.set(saved.id, projectLinks);
      update(saved);
      const session = { id: body.session_id, title: saved.title, messages: [], project_context: { ...makeSnapshot(), launch_fingerprint: body.expected_fingerprint }, created_at: now, updated_at: now };
      state.sessions.push(session);
      return json(route, session, 201);
    }
    if (path === "/calendar/reminders" && method === "GET") return json(route, listTasks(url));
    const savedResultRoute = path.match(/^\/projects\/([^/]+)\/saved-result$/);
    if (savedResultRoute) {
      const saved = state.projects.find(item => item.id === savedResultRoute[1]);
      const body = request.postDataJSON();
      state.resultRequests.push(body);
      if (!saved) return json(route, { detail: "Project not found" }, 404);
      if (saved.archived_at) return json(route, { detail: "Project is archived" }, 409);
      const action = state.tasks.find(item => item.id === body.reminder_id);
      if (body.reminder_id && action?.project_id !== saved.id) return json(route, { detail: "Task does not belong to this project" }, 404);
      const links = state.links.get(saved.id) ?? [];
      const projectLinked = links.some(item => item.resource_type === body.resource_type && item.resource_id === body.resource_id);
      const taskLinked = !body.reminder_id || state.taskLinks.some(item => item.reminder_id === body.reminder_id && item.role === "result" && item.resource_type === body.resource_type && item.resource_id === body.resource_id);
      if (!projectLinked || !taskLinked) {
        if (state.conflictOnce) { state.conflictOnce = false; update(saved); }
        if (body.base_revision !== saved.revision) return json(route, { detail: "Project changed. Refresh before retrying." }, 409);
        const resource = { id: `result-${body.resource_id}`, resource_type: body.resource_type, resource_id: body.resource_id,
          title: "Saved output", href: `/${body.resource_type === "wiki" ? "wiki" : `${body.resource_type}s`}/${body.resource_id}`,
          status: "draft", updated_at: now, created_at: now, reason: "Explicit saved result" };
        if (!projectLinked) links.push(resource);
        state.links.set(saved.id, links);
        if (!taskLinked) state.taskLinks.push({ ...resource, role: "result", reminder_id: action!.id, task_text: action!.text, task_done: action!.is_done });
        update(saved);
      }
      if (state.loseResultResponseOnce) { state.loseResultResponseOnce = false; return json(route, { detail: "Response lost after commit" }, 503); }
      return json(route, { project: saved, resource_type: body.resource_type, resource_id: body.resource_id, reminder_id: body.reminder_id });
    }
    const resourceRoute = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/resources(?:\/([^/]+))?$/);
    const standaloneResources = path.match(/^\/calendar\/reminders\/([^/]+)\/resources$/);
    const resultRoute = path.match(/^\/projects\/([^/]+)\/task-results$/);
    if (resourceRoute || standaloneResources || resultRoute) {
      const saved = state.projects.find(item => item.id === (resourceRoute?.[1] ?? resultRoute?.[1]));
      const taskId = resourceRoute?.[2] ?? standaloneResources?.[1];
      const existing = state.tasks.find(item => item.id === taskId);
      if (resourceRoute && (!existing || existing.project_id !== saved?.id)) return json(route, { detail: "Task not found" }, 404);
      if (method !== "GET") {
        const body = method === "DELETE" ? { base_revision: Number(url.searchParams.get("base_revision")) } : request.postDataJSON();
        if (state.conflictOnce) { state.conflictOnce = false; update(saved!); }
        if (body.base_revision !== saved!.revision || saved!.archived_at) return json(route, { detail: "Project changed. Refresh before retrying." }, 409);
        if (method === "DELETE") state.taskLinks = state.taskLinks.filter(item => item.id !== resourceRoute![3]);
        else for (const ref of body.resources) {
          const option = ref.resource_type === "asset" ? asset : source;
          if (!state.taskLinks.some(item => item.reminder_id === taskId && item.role === body.role && item.resource_id === ref.resource_id)) {
            state.taskLinks.push({ ...option, id: `task-link-${state.taskLinks.length + 1}`, role: body.role,
              reminder_id: taskId!, task_text: existing!.text, task_done: existing!.is_done, reason: ref.reason ?? "", created_at: now });
          }
          const projectLinks = state.links.get(saved!.id) ?? [];
          if (!projectLinks.some(item => item.resource_id === ref.resource_id)) projectLinks.push({ ...option, id: `link-${projectLinks.length}`, reason: "Task resource", created_at: now });
          state.links.set(saved!.id, projectLinks);
        }
        update(saved!);
      }
      if ((resultRoute && state.failResults) || (!resultRoute && state.failResources)) return json(route, { detail: "Resource service offline" }, 503);
      const filtered = state.taskLinks.filter(item => resultRoute ? item.role === "result" && state.tasks.find(current => current.id === item.reminder_id)?.project_id === saved?.id : item.reminder_id === taskId)
        .map(item => ({ ...item, task_done: state.tasks.find(current => current.id === item.reminder_id)?.is_done ?? false }));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(route, { items: filtered.slice(offset, offset + Number(url.searchParams.get("limit") ?? 30)), total: filtered.length, revision: saved?.revision ?? null });
    }
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
        if (body.project_id && body.project_id !== existing.project_id) {
          const destination = state.projects.find(item => item.id === body.project_id);
          if (!destination || destination.revision !== body.target_revision || destination.archived_at) return json(route, { detail: "Destination project changed. Refresh before retrying." }, 409);
          if (saved?.next_reminder_id === existing.id) saved.next_reminder_id = null;
          existing.project_id = destination.id;
          const destinationLinks = state.links.get(destination.id) ?? [];
          for (const resource of state.taskLinks.filter(item => item.reminder_id === existing.id)) if (!destinationLinks.some(item => item.resource_id === resource.resource_id)) destinationLinks.push(resource);
          state.links.set(destination.id, destinationLinks);
          update(saved!); update(destination);
        }
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
    if (path === "/projects/resource-options") return json(route, { items: url.searchParams.get("resource_type") === "asset" ? [asset] : [], total: url.searchParams.get("resource_type") === "asset" ? 1 : 0 });
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
  await expect(page.getByRole("dialog")).toContainText(/linked notes/i);
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

test("task context and explicit results connect actions to overview without implying completion", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await page.getByRole("button", { name: "Link context", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add selected (1)", exact: true }).click();
  await expect(page.getByRole("link", { name: "Original paper", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Link result", exact: true }).click();
  await expect(page.getByLabel("Resource type").locator("option")).toHaveCount(2);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add selected (1)", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
  expect(state.tasks[0].is_done).toBe(false);
  expect(state.projects[0].status).toBe("active");
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recent task results", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
  await expect(page.getByText("Review material · Task still pending", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await page.getByRole("button", { name: "Remove task link", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toContainText("project resource link remain");
  await page.getByRole("button", { name: "Confirm remove task resource", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toHaveCount(0);
  expect(state.links.get("project-one")?.some(item => item.resource_id === "asset-one")).toBe(true);
});

test("task resource conflict retains selection and reason for explicit retry", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await page.getByRole("button", { name: "Link result", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("Why these resources belong here (optional)").fill("Final reviewed output");
  state.conflictOnce = true;
  await page.getByRole("button", { name: "Add selected (1)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("selection is retained");
  await expect(page.getByRole("checkbox")).toBeChecked();
  await expect(page.getByLabel("Why these resources belong here (optional)")).toHaveValue("Final reviewed output");
  await page.getByRole("button", { name: "Refresh project revision", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Add selected (1)", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
  expect(state.taskLinks).toHaveLength(1);
});

test("move confirmation retains destination on conflict and preserves Todo and resources", async ({ page }) => {
  const sourceProject = { ...project(), next_reminder_id: "task-one" };
  const state = await mockProjects(page, [sourceProject, project("project-two", "Destination goal")]);
  state.tasks.push(task());
  state.taskLinks.push({ ...asset, id: "result-one", reminder_id: "task-one", task_text: "Review material", task_done: false, role: "result", reason: "Output", created_at: now });
  state.links.set("project-one", [{ ...asset, id: "asset-link", reason: "Output", created_at: now }]);
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Move to another project", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Moving it clears the source project’s next step");
  await page.getByRole("radio", { name: "Destination goal · active", exact: true }).check();
  await expect(page.getByRole("button", { name: "Confirm move task", exact: true })).toBeEnabled();
  state.projects[1].revision += 1;
  await page.getByRole("button", { name: "Confirm move task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("destination choice is retained");
  await expect(page.getByRole("radio")).toBeChecked();
  await page.getByRole("button", { name: "Refresh both projects", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm move task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Review material", { exact: true })).toHaveCount(0);
  expect(state.tasks[0]).toMatchObject({ id: "task-one", project_id: "project-two", date: null, is_done: false });
  expect(state.projects[0].next_reminder_id).toBeNull();
  expect(state.taskLinks).toHaveLength(1);
  expect(state.links.get("project-one")).toHaveLength(1);
  expect(state.links.get("project-two")).toHaveLength(1);
  await page.goto("/projects/project-two");
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
});

test("detached Todo resources remain readable on Home", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  state.taskLinks.push({ ...asset, id: "result-one", reminder_id: "task-one", task_text: "Review material", task_done: false, role: "result", reason: "Output", created_at: now });
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Remove from project", exact: true }).click();
  await page.getByRole("button", { name: "Confirm remove task", exact: true }).click();
  await page.goto("/");
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link result", exact: true })).toHaveCount(0);
  expect(state.taskLinks).toHaveLength(1);
});

test("archived project resources stay readable and cannot be moved or edited", async ({ page }) => {
  const state = await mockProjects(page, [{ ...project(), archived_at: now }]);
  state.tasks.push(task());
  state.taskLinks.push({ ...asset, id: "result-one", reminder_id: "task-one", task_text: "Review material", task_done: false, role: "result", reason: "Output", created_at: now });
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed article", exact: true })).toBeVisible();
  for (const name of ["Link context", "Link result", "Remove task link", "Move to another project"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
});

test("unavailable task resources and results are unknown rather than empty", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  state.failResources = true;
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Task context and results", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Task resources are unavailable, not empty", { timeout: 15000 });
  await expect(page.getByText("No explicit context or results linked yet.", { exact: true })).toHaveCount(0);
  state.failResources = false;
  await page.getByRole("button", { name: "Retry task resources", exact: true }).click();
  await expect(page.getByText("No explicit context or results linked yet.", { exact: true })).toBeVisible();
  state.failResults = true;
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Task results are unavailable, not empty", { timeout: 15000 });
  state.failResults = false;
  await page.getByRole("button", { name: "Retry task results", exact: true }).click();
  await expect(page.getByText("No task results yet.", { exact: false })).toBeVisible();
});

test("confirmed Project context opens one linked conversation and persists per-message snapshots", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  state.links.set("project-one", [{ ...source, id: "source-link", reason: "Material", created_at: now }]);
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Work on this task", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Selected source summary");
  await expect(page.getByRole("dialog")).toContainText("Action: Review material");
  expect(state.sessions).toHaveLength(0);
  expect(state.chatRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm context and open new Chat", exact: true }).click();
  await expect(page.getByText("Working in Project: Real goal", { exact: true })).toBeVisible();
  expect(state.sessions).toHaveLength(1);
  expect(state.links.get("project-one")?.filter(item => item.resource_type === "chat_session")).toHaveLength(1);
  expect(state.chatRequests).toHaveLength(0);
  await page.getByPlaceholder("Ask anything about your knowledge base...").fill("Compare these approaches");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Project grounded answer", { exact: true })).toBeVisible();
  await expect.poll(() => state.sessions[0].messages.length).toBe(2);
  const snapshot = state.sessions[0].project_context!;
  expect(state.chatRequests[0].project_context).toEqual({ project_id: "project-one", expected_fingerprint: snapshot.fingerprint });
  expect(state.chatRequests[0].memory_ids).toEqual([]);
  expect(state.sessions[0].messages[0].metadata?.project_context).toEqual(snapshot);
  expect(state.sessions[0].messages[1].metadata?.project_context).toEqual(snapshot);
  expect(state.tasks[0].is_done).toBe(false);
  expect(state.projects[0].status).toBe("active");
  await page.reload();
  await expect(page.getByText("Working in Project: Real goal", { exact: true })).toBeVisible();
  await expect(page.getByText("Project grounded answer", { exact: true })).toBeVisible();
  expect(state.sessions).toHaveLength(1);
  await page.getByText(`Recorded Project context · Real goal · revision ${snapshot.project_revision}`, { exact: true }).click();
  await expect(page.locator("details").filter({ hasText: "Snapshot retained for this message" }).locator("pre")).toHaveText(snapshot.context_text);
});

test("Project launch conflict preserves selections and creates no orphan conversation", async ({ page }) => {
  const state = await mockProjects(page);
  state.links.set("project-one", [{ ...source, id: "source-link", reason: "Material", created_at: now }]);
  await page.goto("/projects/project-one");
  await page.getByRole("button", { name: "Continue project work", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm context and open new Chat", exact: true })).toBeVisible();
  state.projects[0].revision += 1;
  state.projects[0].goal = "Changed project goal";
  await page.getByRole("button", { name: "Confirm context and open new Chat", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("selection are retained");
  await expect(page.getByRole("dialog").getByRole("checkbox")).toBeChecked();
  expect(state.sessions).toHaveLength(0);
  await page.getByRole("button", { name: "Refresh project context inputs", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Changed project goal");
  await page.getByRole("button", { name: "Confirm context and open new Chat", exact: true }).click();
  await expect(page.getByText("Working in Project: Real goal", { exact: true })).toBeVisible();
  expect(state.sessions).toHaveLength(1);
});

test("changed project material blocks model execution until a fresh preview is confirmed", async ({ page }) => {
  const state = await mockProjects(page);
  state.links.set("project-one", [{ ...source, id: "source-link", reason: "Material", created_at: now }]);
  await page.goto("/projects/project-one");
  await page.getByRole("button", { name: "Continue project work", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await page.getByRole("button", { name: "Confirm context and open new Chat", exact: true }).click();
  await expect(page.getByText("Working in Project: Real goal", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Ask anything about your knowledge base...").fill("Initial question");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => state.sessions[0].messages.length).toBe(2);
  const originalSnapshot = state.sessions[0].messages[1].metadata?.project_context;
  state.summary = "Updated selected evidence";
  await page.getByPlaceholder("Ask anything about your knowledge base...").fill("Keep this follow-up draft");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Review a fresh preview before sending");
  await expect(page.getByPlaceholder("Ask anything about your knowledge base...")).toHaveValue("Keep this follow-up draft");
  expect(state.chatRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Review latest project context", exact: true }).click();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Updated selected evidence");
  await page.getByRole("button", { name: "Confirm refreshed project context", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => state.sessions[0].messages.length).toBe(4);
  expect(state.chatRequests).toHaveLength(2);
  expect(state.sessions[0].messages[1].metadata?.project_context).toEqual(originalSnapshot);
  expect(state.sessions[0].messages[3].metadata?.project_context?.context_text).toContain("Updated selected evidence");
  await page.reload();
  const recordedContexts = page.locator("details").filter({ hasText: "Snapshot retained for this message" });
  await expect(recordedContexts).toHaveCount(2);
  await recordedContexts.first().locator("summary").click();
  await expect(recordedContexts.first().locator("pre")).toHaveText(originalSnapshot!.context_text);
  await recordedContexts.last().locator("summary").click();
  await expect(recordedContexts.last().locator("pre")).toContainText("Updated selected evidence");
});

test("linking an ordinary session to a Project does not change its execution context", async ({ page }) => {
  const state = await mockProjects(page);
  state.sessions.push({ id: "ordinary-session", title: "Ordinary conversation", created_at: now, updated_at: now,
    messages: [{ id: "previous", role: "user", content: "Earlier question", created_at: now }] });
  state.links.set("project-one", [{ id: "session-link", resource_type: "chat_session", resource_id: "ordinary-session", title: "Ordinary conversation",
    href: "/chat?session=ordinary-session", status: null, updated_at: now, created_at: now, reason: "History link" }]);
  await page.goto("/chat?session=ordinary-session");
  await expect(page.getByText("Earlier question", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Project execution context" })).toHaveCount(0);
  await page.getByPlaceholder("Ask anything about your knowledge base...").fill("Ordinary follow-up");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Project grounded answer", { exact: true })).toBeVisible();
  expect(state.chatRequests[0].project_context).toBeUndefined();
});

function seedSavedResult(state: Awaited<ReturnType<typeof mockProjects>>, kind: "note" | "asset" | "wiki" = "note", destination = state.projects[0], action?: CalendarReminder) {
  const context: ProjectContextSnapshot = { version: 1, project_id: destination.id, project_revision: destination.revision,
    title: destination.title, goal: destination.goal, completion_criteria: destination.completion_criteria, status: destination.status,
    generated_at: now, fingerprint: "a".repeat(64), resources: [], context_text: `Recorded context for ${destination.title}`, truncated: false,
    task: action ? { id: action.id, text: action.text, date: action.date, recurrence: action.recurrence, is_done: action.is_done, updated_at: now } : null };
  const target = kind === "wiki" ? "wiki_draft" : kind;
  state.sessions.push({ id: "saved-session", title: "Saved Chat", messages: [{ id: "saved-message", role: "assistant", content: "A reviewed saved output", created_at: now,
    metadata: { project_context: context, save_receipts: { [target]: { target, object_type: kind, object_id: "saved-output", title: "Reviewed output", saved_at: now } } } }], created_at: now, updated_at: now });
  return context;
}

test("saving a Project reply requires separate confirmation to link its existing result and Todo", async ({ page }) => {
  const state = await mockProjects(page);
  state.tasks.push(task());
  await page.goto("/projects/project-one?tab=tasks");
  await page.getByRole("button", { name: "Work on this task", exact: true }).click();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await page.getByRole("button", { name: "Confirm context and open new Chat", exact: true }).click();
  await page.getByPlaceholder("Ask anything about your knowledge base...").fill("Produce something useful");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => state.sessions[0].messages.length).toBe(2);
  await page.getByRole("button", { name: "Save as Personal Note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Link saved Note to Project", exact: true })).toBeVisible();
  expect(state.outputSaves).toBe(1);
  expect(state.taskLinks).toHaveLength(0);
  await page.getByRole("button", { name: "Link saved Note to Project", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Destination: Real goal");
  state.conflictOnce = true;
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("destination is retained");
  expect(state.taskLinks).toHaveLength(0);
  expect(state.outputSaves).toBe(1);
  await page.getByRole("button", { name: "Refresh result destination", exact: true }).click();
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("and the selected Todo");
  expect(state.taskLinks).toHaveLength(1);
  expect(state.taskLinks[0].resource_id).toBe(state.sessions[0].messages[1].metadata?.save_receipts?.note?.object_id);
  expect(state.tasks[0].is_done).toBe(false);
  expect(state.projects[0].status).toBe("active");
  expect(state.outputSaves).toBe(1);
  await page.goto("/projects/project-one");
  await expect(page.getByText("Recent task results", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved output", { exact: true })).toBeVisible();
});

test("lost result-link response can be retried after reload without duplicating content or links", async ({ page }) => {
  const state = await mockProjects(page);
  const action = task();
  state.tasks.push(action);
  seedSavedResult(state, "asset", state.projects[0], action);
  await page.goto("/chat?session=saved-session");
  await page.getByRole("button", { name: "Link saved Asset to Project", exact: true }).click();
  state.loseResultResponseOnce = true;
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("already saved");
  expect(state.taskLinks).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "Link saved Asset to Project", exact: true }).click();
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Saved result linked");
  expect(state.taskLinks).toHaveLength(1);
  expect(state.links.get("project-one")).toHaveLength(1);
  expect(state.resultRequests[0].resource_id).toBe(state.resultRequests[1].resource_id);
  expect(state.outputSaves).toBe(0);
  expect(state.projects[0].revision).toBe(2);
});

test("Wiki saved results link from History to a chosen Project without changing Chat execution scope", async ({ page }) => {
  const state = await mockProjects(page, [project(), project("project-two", "Different destination")]);
  const recorded = seedSavedResult(state, "wiki");
  await page.goto("/chat?session=saved-session&tab=history");
  await page.getByRole("button", { name: "Link saved Wiki draft to Project", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Destination: Real goal");
  await expect(page.getByRole("dialog")).toContainText("Wiki drafts link to the Project only");
  await page.getByRole("dialog").getByLabel("Different destination", { exact: true }).check();
  await expect(page.getByRole("dialog")).toContainText("Destination: Different destination");
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Different destination");
  expect(state.taskLinks).toHaveLength(0);
  expect(state.sessions[0].project_context).toBeUndefined();
  expect(state.sessions[0].messages[0].metadata?.project_context).toEqual(recorded);
  expect(state.links.get("project-two")?.[0].resource_type).toBe("wiki");
  expect(state.chatRequests).toHaveLength(0);
});

test("moved Todo and archived destination retain saved result and recover by choosing Project only", async ({ page }) => {
  const state = await mockProjects(page);
  const action = task();
  state.tasks.push(action);
  seedSavedResult(state, "note", state.projects[0], action);
  await page.goto("/chat?session=saved-session");
  await page.getByRole("button", { name: "Link saved Note to Project", exact: true }).click();
  state.tasks[0].project_id = null;
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Task does not belong");
  expect(state.links.get("project-one")).toBeUndefined();
  state.projects[0].archived_at = now;
  await page.getByRole("button", { name: "Refresh result destination", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("archived, read-only");
  await expect(page.getByRole("button", { name: "Confirm saved result links", exact: true })).toBeDisabled();
  state.projects[0].archived_at = null;
  await page.getByRole("button", { name: "Refresh result destination", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Project only — no Todo result", { exact: true }).check();
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Saved result linked");
  expect(state.taskLinks).toHaveLength(0);
  expect(state.outputSaves).toBe(0);
});

test("save receipt failure retries persistence without creating another Note", async ({ page }) => {
  const state = await mockProjects(page);
  state.sessions.push({ id: "receipt-session", title: "A completed result", messages: [{ id: "result-message", role: "assistant", content: "A useful final answer", created_at: now }], created_at: now, updated_at: now });
  await page.goto("/chat?session=receipt-session");
  state.failReceiptOnce = true;
  await page.getByRole("button", { name: "Save as Personal Note", exact: true }).click();
  await expect(page.locator("[data-action-error]")).toContainText("content is saved");
  await page.getByRole("button", { name: "Retry save receipt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  expect(state.outputSaves).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Link saved Note to Project", exact: true })).toBeVisible();
  expect(state.sessions[0].messages[0].metadata?.save_receipts?.note?.object_id).toBe("saved-notes-1");
  expect(state.outputSaves).toBe(1);
});

test("saved result choices support project and Todo pagination with recoverable unavailable data", async ({ page }) => {
  const destinations = Array.from({ length: 12 }, (_, index) => project(`destination-${index + 1}`, `Destination ${index + 1}`));
  const state = await mockProjects(page, destinations);
  state.tasks.push(...Array.from({ length: 12 }, (_, index) => task(`result-task-${index + 1}`, `Deliverable ${index + 1}`, "destination-12")));
  seedSavedResult(state);
  state.failList = true;
  await page.goto("/chat?session=saved-session");
  await page.getByRole("button", { name: "Link saved Note to Project", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unavailable, not empty");
  state.failList = false;
  await page.getByRole("button", { name: "Retry result project choices", exact: true }).click();
  await page.getByRole("button", { name: "Next result projects", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Destination 12", { exact: true }).check();
  await expect(page.getByRole("dialog")).toContainText("Destination: Destination 12");
  await page.getByRole("button", { name: "Next result Todos", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Deliverable 12 · pending", { exact: true }).check();
  await page.getByRole("button", { name: "Confirm saved result links", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Destination 12 and the selected Todo");
  expect(state.resultRequests[0].reminder_id).toBe("result-task-12");
  expect(state.taskLinks).toHaveLength(1);
  expect(state.outputSaves).toBe(0);
});

test("project context preview failure is recoverable without starting a model or session", async ({ page }) => {
  const state = await mockProjects(page);
  state.failPreview = true;
  await page.goto("/projects/project-one");
  await page.getByRole("button", { name: "Continue project work", exact: true }).click();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Project context unavailable");
  expect(state.chatRequests).toHaveLength(0);
  expect(state.sessions).toHaveLength(0);
  state.failPreview = false;
  await page.getByRole("button", { name: "Refresh project context inputs", exact: true }).click();
  await page.getByRole("button", { name: "Preview exact project context", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm context and open new Chat", exact: true })).toBeVisible();
});
