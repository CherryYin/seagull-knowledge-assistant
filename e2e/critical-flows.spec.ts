import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "http://127.0.0.1:4000";
const now = "2026-08-23T08:00:00.000Z";

type MockState = {
  loggedIn: boolean;
  savedNoteBody: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  memory: Record<string, unknown> | null;
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

    if (path === "/api/knowledge/models") return json(route, []);
    if (path === "/api/categories") {
      return json(route, { items: [{ id: 1, name: "Inbox", color: "#64748b", created_at: now }], total: 1 });
    }
    if (path === "/api/notes" && method === "POST") {
      state.savedNoteBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { id: "note-e2e", ...state.savedNoteBody, created_at: now, updated_at: now });
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
    if (path === "/api/notes" && method === "GET") return json(route, { items: [], total: 0 });
    if (path === "/api/wiki/suggestions") return json(route, { items: [], total: 0 });
    if (path === "/api/wiki/mining/runs") return json(route, { items: [], total: 0 });
    if (path === "/api/sources") return json(route, { items: [], total: 0 });
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
  const state: MockState = { loggedIn: false, savedNoteBody: null, candidate: null, memory: null };
  await installMockBff(page, state);
  await signIn(page);

  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask anything about your knowledge base...");
  await expect(input).toBeVisible();
  await input.fill("Give me one durable E2E result");
  await input.press("Enter");
  await expect(page.getByText("E2E answer with a durable result.")).toBeVisible();

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
