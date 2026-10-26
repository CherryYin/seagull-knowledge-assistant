import { expect, test, type Page } from "@playwright/test";

const api = "http://127.0.0.1:4000/api";
const identifier = "a".repeat(32);
const createdAt = "2026-10-20T08:00:00Z";

function experiment(status = "prepared") {
  const completed = status === "awaiting_review";
  return {
    id: identifier, name: "Newsletter 深度解读 A/B", status, created_at: createdAt,
    method: "manual_prompt_ab_not_full_harness2", synthetic: true, phase: completed ? "train" : null,
    message: null, prompts: { baseline: "正式提示词快照", candidate: "人工候选提示词" },
    attempts: completed ? 6 : 0, spent_estimate_cny: completed ? "0.018" : "0",
    spent_or_reserved_cny: completed ? "0.018" : "0", outcome_unknown: false, budget_cny: completed ? "2" : null,
    cases: ["limited-announcement", "bounded-comparison", "untrusted-instructions", "negative-result"].map((id, index) => ({
      id, split: index === 3 ? "holdout" : "train", material: index === 3 ? null : "明确标记的虚构素材，未公布价格。", review: null,
      outputs: Object.fromEntries(["baseline", "candidate"].map(variant => [variant, {
        status: completed && index < 3 ? "completed" : "not_started", estimated_cny: completed && index < 3 ? "0.003" : null,
        response: completed && index < 3 ? { text: `${variant} 模拟结果，不是真实模型输出。`, model: "deepseek-v4-flash", input_tokens: 500, output_tokens: 250, elapsed_ms: 100, retry_count: 0 } : null,
      }])),
    })),
  };
}

async function setup(page: Page, options: { status?: string; blocked?: boolean; unknown?: boolean; failList?: boolean } = {}) {
  await page.addInitScript(() => localStorage.setItem("auth_token", "harness2-ui-test"));
  const data = experiment(options.status);
  const requests: string[] = [];
  const reviews: Record<string, unknown>[] = [];
  if (options.unknown) Object.assign(data, { status: "outcome_unknown", attempts: 1, spent_estimate_cny: null, spent_or_reserved_cny: "0.140672", outcome_unknown: true, message: "调用结果未知，请核查账单" });
  await page.route(`${api}/**`, async route => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const method = route.request().method();
    if (path === "/auth/me") return route.fulfill({ json: { id: "owner", username: "owner", role: "admin", approval_status: "approved", is_active: true } });
    if (path === "/auth/me/settings") return route.fulfill({ json: { settings: { modules: { preset: "basic", enabled: ["lab", "agent-chat"], onboarding_completed: true } }, updated_at: createdAt } });
    if (path.startsWith("/lab/harness2")) requests.push(`${method} ${path}`);
    if (path === "/lab/harness2" && method === "GET") {
      if (options.failList) return route.fulfill({ status: 503, json: { error: "实验记录不可用" } });
      return route.fulfill({ json: { items: [data] } });
    }
    if (path === "/lab/harness2" && method === "POST") return route.fulfill({ status: 201, json: data });
    if (path === `/lab/harness2/${identifier}`) return route.fulfill({ json: data });
    if (path.endsWith("/preflight")) return route.fulfill({ json: {
      ready: !options.blocked, blockers: options.blocked ? ["服务端未开启实验执行", "价格策略已过期，请重新核价"] : [],
      preflight_id: options.blocked ? null : "confirmation-token", network_requests_sent: 0,
      phase: "train", budget_cny: "2", requests: 6, model: "deepseek-v4-flash", phase_reservation_cny: "0.844032", pricing_expires_at: "2026-10-21T00:00:00+08:00",
    } });
    if (path.endsWith("/start")) {
      expect(route.request().postDataJSON()).toEqual({ preflight_id: "confirmation-token", confirm_send_synthetic: true });
      data.status = "train_running";
      return route.fulfill({ status: 202, json: { id: identifier, status: data.status } });
    }
    if (path.endsWith("/review")) {
      const body = route.request().postDataJSON();
      reviews.push(body);
      Object.assign(data.cases.find(item => item.id === body.case_id)!, { review: { winner: body.winner, reason: body.reason, reviewed_at: createdAt } });
      return route.fulfill({ json: data });
    }
    if (path.endsWith("/note")) return route.fulfill({ status: 201, json: { note_id: "note-harness2-test" } });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto("/lab");
  await expect(page.getByRole("heading", { name: "Harness² 隔离试验", exact: true })).toBeVisible();
  await page.getByLabel("选择实验", { exact: true }).selectOption(identifier);
  await expect(page.getByText(`实验 ${identifier}`, { exact: true })).toBeVisible();
  return { requests, reviews };
}

test("creation and preflight do not start paid work; explicit confirmation starts once", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "新建 Newsletter 对比实验" }).click();
  await expect.poll(() => state.requests.includes("POST /lab/harness2")).toBe(true);
  expect(state.requests.some(path => path.endsWith("/start"))).toBe(false);
  await page.getByRole("button", { name: "预算与配置预检（不调用模型）" }).click();
  await expect(page.getByText("预检发送请求：0 次")).toBeVisible();
  const start = page.getByRole("button", { name: "确认并运行训练对比" });
  await expect(start).toBeDisabled();
  await page.getByRole("checkbox").check();
  await start.click();
  await expect(page.getByText("训练样例执行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并运行训练对比" })).toHaveCount(0);
  expect(state.requests.filter(path => path.endsWith("/start"))).toHaveLength(1);
  await page.getByRole("tab", { name: "Skill / Workflow", exact: true }).click();
  await expect(page.getByRole("button", { name: "New Experiment", exact: true })).toBeVisible();
});

test("disabled or expired preflight displays blockers without offering paid execution", async ({ page }) => {
  const state = await setup(page, { blocked: true });
  await page.getByRole("button", { name: "预算与配置预检（不调用模型）" }).click();
  await expect(page.getByText("服务端未开启实验执行", { exact: true })).toBeVisible();
  await expect(page.getByText("价格策略已过期，请重新核价", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并运行训练对比" })).toHaveCount(0);
  expect(state.requests.some(path => path.endsWith("/start"))).toBe(false);
});

test("paired outputs require reasons, holdout waits for all reviews, report can be saved as Note", async ({ page }) => {
  const state = await setup(page, { status: "awaiting_review" });
  await expect(page.getByText("请先完成下面三组人工评审，才能预检留出复验。")).toBeVisible();
  const saveButtons = page.getByRole("button", { name: "保存本组评审" });
  await expect(saveButtons.first()).toBeDisabled();
  for (const caseId of ["limited-announcement", "bounded-comparison", "untrusted-instructions"]) {
    await page.getByLabel(`人工取舍 ${caseId}`).selectOption("candidate");
    await page.getByLabel(`取舍原因 ${caseId}`).fill("保留了限定条件；仍需调整结尾。");
    await saveButtons.first().click();
    await expect(page.getByLabel(`取舍原因 ${caseId}`)).toHaveCount(0);
  }
  expect(state.reviews).toHaveLength(3);
  await expect(page.getByText("三组人工评审已完成，可单独确认新素材复验")).toBeVisible();
  await page.getByRole("button", { name: "将当前实验报告保存为 Note" }).click();
  await expect(page.getByRole("link", { name: "打开实验 Note" })).toHaveAttribute("href", "/notes/note-harness2-test");
  expect(state.requests.some(path => path.endsWith("/start"))).toBe(false);
});

test("unknown outcomes are not zero, cannot be retried and retain report export", async ({ page }) => {
  const state = await setup(page, { unknown: true });
  await expect(page.getByText(/估算费用 未知 元/)).toBeVisible();
  await expect(page.getByRole("button", { name: "预算与配置预检（不调用模型）" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "将当前实验报告保存为 Note" })).toBeEnabled();
  expect(state.requests.some(path => path.endsWith("/start"))).toBe(false);
});

test("record loading errors are not displayed as an empty successful history", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("auth_token", "harness2-ui-test"));
  await page.route(`${api}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: "owner", username: "owner", role: "admin", is_active: true } });
    if (path === "/api/auth/me/settings") return route.fulfill({ json: { settings: { modules: { preset: "basic", onboarding_completed: true } } } });
    if (path === "/api/lab/harness2") return route.fulfill({ status: 503, json: { error: "实验记录不可用" } });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto("/lab");
  await expect(page.getByRole("alert")).toContainText("实验记录不可用");
  await expect(page.getByText(/暂无页面实验记录/)).toHaveCount(0);
});
