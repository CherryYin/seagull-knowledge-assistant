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
      return json(route, { access_token: "mind-map-e2e-token", token_type: "bearer" });
    }
    if (path === "/api/auth/me") {
      return loggedIn
        ? json(route, {
            id: "mind-map-e2e-user",
            username: "mind-map-e2e-user",
            display_name: "Mind Map E2E User",
            role: "user",
            approval_status: "approved",
            is_active: true,
          })
        : json(route, { detail: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/me/settings") {
      return json(route, {
        settings: { modules: { onboarding_completed: true, enabled: ["lab"] } },
        updated_at: "2026-09-08T08:00:00.000Z",
      });
    }
    if (path === "/api/knowledge/dashboard") {
      return json(route, {
        counts: { notes: 0, sources: 0, chats: 0, digest_pending: 0 },
        trends: [],
        category_distribution: [],
        note_type_distribution: [],
      });
    }
    return json(route, {});
  });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("mind-map-e2e-user");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("Mind Map Technical Spike validates layout, collapse, focus, and reset", async ({ page }) => {
  await installMockBff(page);
  await signIn(page);

  await page.goto("/lab/mind-map-spike");
  await expect(page.getByTestId("mind-map-spike")).toBeVisible();
  await expect(page.getByTestId("mind-map-visible-count")).toHaveText("100");
  const layoutDurations: Record<number, number> = {
    100: Number.parseFloat(await page.getByTestId("mind-map-layout-duration").innerText()),
  };

  await page.getByRole("button", { name: "20 nodes" }).click();
  await expect(page.getByTestId("mind-map-visible-count")).toHaveText("20");
  layoutDurations[20] = Number.parseFloat(await page.getByTestId("mind-map-layout-duration").innerText());
  await page.getByRole("button", { name: "300 nodes" }).click();
  await expect(page.getByTestId("mind-map-visible-count")).toHaveText("300");
  layoutDurations[300] = Number.parseFloat(await page.getByTestId("mind-map-layout-duration").innerText());
  for (const duration of Object.values(layoutDurations)) expect(duration).toBeGreaterThanOrEqual(0);
  console.log(`Mind Map balanced layout benchmark: ${JSON.stringify(layoutDurations)} ms`);

  await page.getByRole("button", { name: "Right", exact: true }).click();
  await page.getByRole("button", { name: "Balanced", exact: true }).click();
  await page.getByText("Knowledge node 2", { exact: true }).click();
  await page.getByRole("button", { name: "Collapse selected" }).click();
  const collapsedCount = Number(await page.getByTestId("mind-map-visible-count").textContent());
  expect(collapsedCount).toBeGreaterThan(1);
  expect(collapsedCount).toBeLessThan(300);

  await page.getByRole("button", { name: "Focus selected" }).click();
  await expect(page.getByTestId("mind-map-visible-count")).toHaveText("1");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.getByTestId("mind-map-visible-count")).toHaveText("300");
});
