import { expect, test, type Page } from "@playwright/test";

const api = "http://127.0.0.1:4000/api";
const fetchedAt = "2026-01-04T01:00:00Z";

function snapshot() {
  return { id: "snapshot", credential_id: 7, publication_date: "2026-01-01", fetched_at: fetchedAt,
    data: { is_delay: true, list: [{ ref_date: "2026-01-01", msgid: "12345_1", title: "我的播客文章", content_url: "https://mp.weixin.qq.com/s/article",
      detail_list: [{ stat_date: "2026-01-02", read_user: 30, share_user: null },
        { stat_date: "2026-01-03", read_user: 42, share_user: 0, read_finish_rate: 0.6, read_avg_activetime: null }] }] } };
}

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("auth_token", "statistics-test"));
  const state = { synced: [] as Record<string, unknown>[], saved: false, failRead: false, failSync: false, noCredentials: false };
  await page.route(`${api}/**`, route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api", "");
    if (path === "/auth/me") return route.fulfill({ json: { id: "owner", username: "owner", role: "admin", approval_status: "approved", is_active: true } });
    if (path === "/auth/me/settings") return route.fulfill({ json: { settings: { modules: { preset: "basic", onboarding_completed: true } }, updated_at: fetchedAt } });
    if (path === "/auth/me/api-credentials") return route.fulfill({ json: { items: state.noCredentials ? [] : [
      { id: 7, provider: "wechat_official_account", label: "自己的公众号", is_enabled: true, config: { app_id: "wx-own" } },
      { id: 8, provider: "wechat_official_account", label: "已停用公众号", is_enabled: false },
      { id: 9, provider: "qwen", label: "不相关凭据", is_enabled: true },
    ] } });
    if (path === "/knowledge/wechat-statistics/sync") {
      state.synced.push(route.request().postDataJSON());
      if (state.failSync) return route.fulfill({ status: 502, json: { detail: "该公众号没有此统计接口权限" } });
      state.saved = true;
      return route.fulfill({ json: snapshot() });
    }
    if (path === "/knowledge/wechat-statistics") {
      if (state.failRead) return route.fulfill({ status: 503, json: { detail: "migration needed" } });
      return route.fulfill({ json: { snapshot: state.saved && url.searchParams.get("publication_date") === "2026-01-01" ? snapshot() : null } });
    }
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  return state;
}

test("WeChat local browser check instructions work without an API credential and never trigger sync", async ({ page }) => {
  const state = await setup(page);
  state.noCredentials = true;
  await page.goto("/stats?tab=wechat");
  await page.getByText("个人订阅号：本地浏览器单篇验证（实验）", { exact: true }).click();
  await expect(page.getByText("npm --prefix seagull-ui run wechat:check", { exact: true })).toBeVisible();
  await expect(page.getByText(/不会写入正式统计快照/)).toBeVisible();
  await expect(page.getByText(/全为未知时输入“诊断”/)).toBeVisible();
  await expect(page.getByText(/远程服务器运行不会在你的电脑弹窗/)).toBeVisible();
  expect(state.synced).toHaveLength(0);
});

test("WeChat Dashboard sync is explicit, account scoped and shows cumulative counts without inventing audio metrics", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/stats?tab=wechat&published_on=2026-01-01");
  await expect(page.getByRole("tab", { name: "公众号数据", exact: true })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("region", { name: "公众号数据", exact: true });
  await expect(panel.getByLabel("公众号账号").locator("option")).toHaveCount(2);
  expect(state.synced).toHaveLength(0);
  await panel.getByLabel("公众号账号").selectOption("7");
  await expect(panel).toContainText("尚无保存快照");
  await panel.getByRole("button", { name: "从微信同步并保存快照" }).click();
  await expect(panel.getByRole("status")).toContainText("已保存微信统计快照");
  expect(state.synced).toEqual([{ credential_id: 7, publication_date: "2026-01-01" }]);
  const article = panel.getByRole("article");
  await expect(article).toContainText("我的播客文章");
  await expect(article.getByText("阅读人数", { exact: true }).locator("..")).toContainText("42");
  await expect(article).not.toContainText("72");
  await expect(article.getByText("阅读完成率", { exact: true }).first().locator("..")).toContainText("60.00%");
  await expect(article.getByText("未知", { exact: true }).first()).toBeVisible();
  await expect(article.getByText("分享人数", { exact: true }).locator("..")).toContainText("0");
  await expect(panel).toContainText("存在延迟");
  await expect(panel).toContainText("阅读完成率也不是播客收听完播率");
  await page.reload();
  await page.getByLabel("公众号账号").selectOption("7");
  await expect(page.getByRole("article")).toContainText("我的播客文章");
  expect(state.synced).toHaveLength(1);
});

test("WeChat failures preserve historical data and never automatically retry", async ({ page }) => {
  const state = await setup(page);
  state.saved = true;
  state.failSync = true;
  await page.goto("/stats?tab=wechat&published_on=2026-01-01");
  await page.getByLabel("公众号账号").selectOption("7");
  await expect(page.getByRole("article")).toBeVisible();
  await page.getByRole("button", { name: "从微信同步并保存快照" }).click();
  await expect(page.getByRole("alert")).toContainText("接口权限");
  await expect(page.getByRole("alert")).toContainText("未自动重试");
  await expect(page.getByRole("article")).toContainText("我的播客文章");
  expect(state.synced).toHaveLength(1);
});

test("WeChat saved-data errors are not empty results and changing date clears old statistics", async ({ page }) => {
  const state = await setup(page);
  state.failRead = true;
  await page.goto("/stats?tab=wechat&published_on=2026-01-01");
  await page.getByLabel("公众号账号").selectOption("7");
  await expect(page.getByRole("alert")).toContainText("不代表阅读量为零");
  state.failRead = false;
  state.saved = true;
  await page.getByRole("button", { name: "重试历史快照" }).click();
  await expect(page.getByRole("article")).toBeVisible();
  await page.getByLabel("文章发表日期").fill("2026-01-02");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "公众号数据", exact: true })).toContainText("尚无保存快照");
  expect(state.synced).toHaveLength(0);
});

test("WeChat Dashboard explains missing setup and rejects future dates without a remote request", async ({ page }) => {
  const state = await setup(page);
  state.noCredentials = true;
  await page.goto("/stats?tab=wechat&published_on=2099-01-01");
  await expect(page.getByRole("link", { name: "Settings → API Keys" })).toHaveAttribute("href", "/api-keys");
  await expect(page.getByRole("alert")).toContainText("真实发表日期");
  await expect(page.getByRole("button", { name: "从微信同步并保存快照" })).toBeDisabled();
  expect(state.synced).toHaveLength(0);
});
