import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { PodcastAudioPreflight, PodcastAudioRender, PodcastDraft, PodcastDraftFields, PodcastDeliveryRecord } from "../src/lib/api/podcasts";
import { buildPodcastAuthoringPrompt, parsePodcastScriptProposal, podcastParagraphs } from "../src/lib/podcast-authoring";
import { normalizeWebMaterials } from "../src/lib/podcast-web-materials";

const now = "2026-10-16T08:00:00Z";
const catalog = JSON.parse(readFileSync(new URL("../../personal_knowledge_graph/src/pkg/services/application/podcast_voices.json", import.meta.url), "utf8"));

function draft(): PodcastDraft {
  return { asset_id: "episode", status: "draft", title: "Hot topic", brief: "My perspective", outline: "Intro and analysis",
    draft_content: "A spoken script.", source_refs: ["story"], note_refs: [], wiki_refs: [], paragraph_sources: [],
    configuration: { provider: "qwen", region: "cn-beijing", model: "qwen3-tts-flash", voice_id: "Cherry",
      target_duration_minutes: 6, information_cutoff_at: now, asset_id: "episode", revision: 1, created_at: now, updated_at: now },
    input_hash: "a".repeat(64), spoken_text: "Hot topic\n\nA spoken script.", materials: [{ kind: "source", id: "story", title: "Original reporting", available: true, excerpt: "Evidence" }],
    approval_status: "unconfirmed", latest_approval: null, approval_issues: [], audio_generation_available: false };
}

async function mockPodcast(page: Page) {
  await page.addInitScript(() => localStorage.setItem("auth_token", "podcast-editor-test"));
  const state = { saved: draft(), conflict: false, calls: [] as Array<{ path: string; body: Record<string, unknown> }> };
  await page.route("http://127.0.0.1:4000/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const method = route.request().method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/auth/me") return json({ id: "owner", username: "owner", role: "admin", approval_status: "approved", is_active: true });
    if (path === "/auth/me/settings") return json({ settings: { modules: { preset: "basic", onboarding_completed: true } }, updated_at: now });
    if (path === "/assets/podcast/voices") return json({ ...catalog, items: catalog.voices });
    if (["/sources", "/notes", "/wiki"].includes(path)) return json({ items: [{ id: "story", title: "Original reporting" }], total: 1 });
    if (path === "/assets/episode") return json({ id: "episode", asset_type: "podcast" });
    if (method !== "GET") {
      const body = route.request().postDataJSON();
      state.calls.push({ path, body });
      if (state.conflict) return json({ detail: "Podcast inputs changed" }, 409);
      if (path.endsWith("script-approvals")) {
        state.saved.approval_status = "current";
        state.saved.latest_approval = { id: "approved", asset_id: "episode", input_hash: state.saved.input_hash,
          script_hash: "f".repeat(64), spoken_text: state.saved.spoken_text, source_snapshot: structuredClone(state.saved.materials),
          config_snapshot: { voice_id: state.saved.configuration.voice_id }, config_revision: state.saved.configuration.revision,
          approved_by: "owner", created_at: now };
      } else {
        const configuration = { ...state.saved.configuration, ...body.configuration };
        state.saved = { ...state.saved, ...body as PodcastDraftFields, configuration,
          input_hash: "b".repeat(64), approval_status: state.saved.latest_approval ? "stale" : "unconfirmed" };
        state.saved.spoken_text = `${state.saved.title}\n\n${state.saved.draft_content}`;
      }
      return json(state.saved);
    }
    if (path === "/assets/episode/podcast/draft") return json(state.saved);
    return json({ items: [], total: 0 });
  });
  return state;
}

async function mockDelivery(page: Page) {
  const podcast = await mockPodcast(page);
  const state = { records: [] as PodcastDeliveryRecord[], writes: [] as Record<string, unknown>[], failRead: false, conflict: false };
  await page.route("**/api/assets/episode/podcast/audio-renders", route => route.fulfill({ json: { items: [
    { id: "completed", status: "ready", script_approval_id: "approved", created_at: now, duration_seconds: "849.2", segment_count: 16, ready_segment_count: 16, attempt_count: 16, reported_characters: 8104, reported_cost: null },
    { id: "incomplete", status: "failed", created_at: now },
  ] } }));
  await page.route("**/api/assets/episode/podcast/delivery-records**", route => {
    if (route.request().method() === "GET") return route.fulfill({ status: state.failRead ? 503 : 200, json: state.failRead ? { detail: "unavailable" } : { items: state.records } });
    const body = route.request().postDataJSON();
    state.writes.push(body);
    if (state.conflict) return route.fulfill({ status: 409, json: { detail: "Publication record changed" } });
    const record: PodcastDeliveryRecord = { ...body, id: new URL(route.request().url()).pathname.split("/").at(-1), revision: body.base_revision + 1,
      script_approval_id: "approved", file_sha256: "f".repeat(64), created_at: now, updated_at: now, recorded_by: "owner" };
    state.records = [record, ...state.records.filter(item => item.id !== record.id)];
    return route.fulfill({ json: record });
  });
  return { podcast, state };
}

test("podcast publication records save optional review without publishing or synthesis and survive reload", async ({ page }) => {
  const { podcast, state } = await mockDelivery(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await page.getByRole("button", { name: "发布记录与复盘", exact: true }).click();
  await expect(section).toBeFocused();
  await expect(section.getByLabel("发布音频").locator("option")).toHaveCount(2);
  await section.getByLabel("发布音频").selectOption("completed");
  await section.getByLabel("这份音频怎么用的？").selectOption("not_used");
  await section.getByLabel("剪辑", { exact: true }).check();
  await section.getByLabel("最想改善什么").fill("语速太慢，下次调整");
  await section.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("未标记为已发布");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ confirm_published: false, render_id: "completed", adoption: "not_used", manual_steps: ["editing"] });
  expect(podcast.calls).toHaveLength(0);
  await page.reload();
  await expect(section).toContainText("语速太慢，下次调整");
  await expect(section).toContainText("仅保存信息，未确认发布");
});

test("podcast publication confirmation requires consent and preserves explicit adoption and historical time", async ({ page }) => {
  const { podcast, state } = await mockDelivery(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await section.getByLabel("发布音频").selectOption("completed");
  await section.getByLabel("文章链接").fill("https://mp.weixin.qq.com/s/published");
  await section.getByLabel("实际发布时间").fill("2026-01-02T12:30");
  page.once("dialog", dialog => dialog.dismiss());
  await section.getByRole("button", { name: "确认已发布", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "确认已发布", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("已记录发布结果");
  expect(state.writes[0]).toMatchObject({ confirm_published: true, adoption: "undecided", publish_url: "https://mp.weixin.qq.com/s/published", published_at: new Date("2026-01-02T12:30").toISOString() });
  await expect(section.getByLabel("发布音频")).toBeDisabled();
  await section.getByLabel("发布备注").fill("补录发布时间");
  await section.getByRole("button", { name: "保存记录修改" }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({ base_revision: 1, confirm_published: true });
  expect(state.records).toHaveLength(1);
  expect(podcast.calls).toHaveLength(0);
});

test("podcast records distinguish unavailable data and conflicts without automatic writes", async ({ page }) => {
  const { state } = await mockDelivery(page);
  state.failRead = true;
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await expect(section.getByRole("alert")).toContainText("不代表没有记录");
  await expect(section.getByRole("button", { name: "保存信息", exact: true })).toBeDisabled();
  state.failRead = false;
  await section.getByRole("button", { name: "重试发布记录" }).click();
  await section.getByLabel("发布音频").selectOption("completed");
  state.conflict = true;
  await section.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("不会自动重试");
  expect(state.writes).toHaveLength(1);
  await expect(section.getByLabel("发布音频")).toHaveValue("completed");
});

test("archived podcasts retain read-only publication records", async ({ page }) => {
  const { podcast } = await mockDelivery(page);
  podcast.saved.status = "archived";
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await expect(section).toContainText("归档播客仅可查看发布记录");
  await expect(section.getByLabel("发布音频")).toBeDisabled();
  await expect(section.getByRole("button", { name: "确认已发布", exact: true })).toBeDisabled();
});

function confirmedDelivery(): PodcastDeliveryRecord {
  return { id: "published-record", revision: 1, base_revision: 0, render_id: "completed", channel: "微信公众号", publish_url: "https://mp.weixin.qq.com/s/published", published_at: "2026-01-01T02:00:00Z", confirm_published: true, notes: "", adoption: "original", manual_steps: ["upload"], feedback: "", script_approval_id: "approved", file_sha256: "f".repeat(64), created_at: now, updated_at: now, recorded_by: "owner", statistics_snapshots: [] };
}

test("podcast publication statistics save explicit units, preserve unknowns and bind the published audio", async ({ page }) => {
  const { podcast, state } = await mockDelivery(page);
  state.records = [confirmedDelivery()];
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await section.getByRole("button", { name: "编辑记录", exact: true }).click();
  const review = page.getByTestId("podcast-publication-review");
  await expect(review).toContainText("不代表阅读量为零");
  await review.getByLabel("效果公众号备注").fill("海鸥ai应用");
  await review.getByLabel("效果统计截止日").fill("2026-01-04");
  await review.getByLabel("效果采集时间").fill("2026-01-05T12:00");
  await review.getByLabel("效果阅读数值").fill("42");
  await review.getByLabel("效果阅读单位").selectOption("people");
  await review.getByLabel("效果分享数值").fill("0");
  await review.getByLabel("效果分享单位").selectOption("times");
  await review.getByLabel("效果复盘说明").fill("下期缩短开头");
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "保存效果快照", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("已保存效果快照");
  const snapshots = state.writes[0].statistics_snapshots as Array<Record<string, unknown>>;
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ source: "manual_backend", period_start: "2026-01-01", period_end: "2026-01-04", metrics: { read: { value: 42, unit: "people" }, share: { value: 0, unit: "times" } } });
  expect(snapshots[0].metrics).not.toHaveProperty("like");
  expect(state.writes[0].render_id).toBe("completed");
  expect(podcast.calls).toHaveLength(0);
  await expect(section.getByLabel("文章链接")).toBeDisabled();
  await page.reload();
  await section.getByText("查看效果快照（1）", { exact: true }).click();
  await expect(section).toContainText("阅读：42 人");
  await expect(section).toContainText("分享：0 次");
  await expect(section).toContainText("点赞：未知");
});

test("podcast publication report import previews locally and requires explicit field and unit mapping", async ({ page }) => {
  const { podcast, state } = await mockDelivery(page);
  state.records = [confirmedDelivery()];
  await page.goto("/assets/episode/podcast");
  await page.getByTestId("podcast-delivery").getByRole("button", { name: "编辑记录", exact: true }).click();
  const review = page.getByTestId("podcast-publication-review");
  await review.getByLabel("效果数据来源").selectOption("browser_report");
  const report = { schema: "seagull.wechat-browser-check.v1", source: "wechat_backend_browser", verification: "pending_manual_comparison", account_label: "海鸥ai应用", article_url: "https://mp.weixin.qq.com/s/published", token: "do-not-upload", request_diagnostics: [{ cookie: "do-not-upload" }], observations: [
    { source: "wechat_backend_browser", source_endpoint: "/cgi-bin/appmsgpublish", observed_at: now, article_url: "https://mp.weixin.qq.com/s/published", title: "已发布文章", metrics: { read_num: 42, share_num: 0, like_num: null } },
  ] };
  await review.getByLabel("选择本地 JSON 报告").setInputFiles({ name: "report.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(report)) });
  expect(state.writes).toHaveLength(0);
  await review.getByLabel("选择观察记录").selectOption("0");
  await review.getByLabel("效果阅读原始字段").selectOption("read_num");
  await review.getByLabel("效果阅读单位").selectOption("times");
  await review.getByLabel("效果分享原始字段").selectOption("share_num");
  await review.getByLabel("效果分享单位").selectOption("people");
  await review.getByLabel("效果统计截止日").fill("2026-01-04");
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "保存效果快照", exact: true }).click();
  await expect(page.getByTestId("podcast-delivery").getByRole("status")).toContainText("已保存效果快照");
  expect(JSON.stringify(state.writes)).not.toMatch(/do-not-upload|token|cookie|request_diagnostics/);
  expect((state.writes[0].statistics_snapshots as Array<Record<string, unknown>>)[0]).toMatchObject({ source: "browser_report", captured_at: now, metrics: { read: { value: 42, source_field: "read_num", unit: "times" }, share: { value: 0, source_field: "share_num", unit: "people" } } });
  expect(podcast.calls).toHaveLength(0);
});

test("podcast publication statistics conflict preserves inputs without retry or optimistic history", async ({ page }) => {
  const { state } = await mockDelivery(page);
  state.records = [confirmedDelivery()]; state.conflict = true;
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-delivery");
  await section.getByRole("button", { name: "编辑记录", exact: true }).click();
  const review = page.getByTestId("podcast-publication-review");
  await review.getByLabel("效果公众号备注").fill("海鸥ai应用");
  await review.getByLabel("效果统计截止日").fill("2026-01-04");
  await review.getByLabel("效果阅读数值").fill("42");
  await review.getByLabel("效果阅读单位").selectOption("times");
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "保存效果快照", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("不会自动重试");
  expect(state.writes).toHaveLength(1);
  await expect(review.getByLabel("效果阅读数值")).toHaveValue("42");
  expect(state.records[0].statistics_snapshots).toHaveLength(0);
});

test("dedicated editor saves exact voice IDs and explicitly confirms server preview without TTS", async ({ page }) => {
  const state = await mockPodcast(page);
  await page.goto("/assets/episode/podcast");
  await expect(page.getByRole("heading", { name: "播客工作台" })).toBeVisible();
  await expect(page.getByLabel("音色", { exact: true }).locator("option")).toHaveCount(48);
  await page.getByLabel("音色", { exact: true }).selectOption("Eldric Sage");
  expect(state.calls).toHaveLength(0);
  await page.getByLabel("口播正文", { exact: false }).fill("My updated spoken text.");
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeEnabled();
  expect((state.calls[0].body.configuration as Record<string, unknown>).voice_id).toBe("Eldric Sage");
  expect(state.calls[0].body.base_input_hash).toBe("a".repeat(64));
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "确认已保存的口播稿" }).click();
  await expect(page.getByText("当前版本已确认", { exact: false })).toBeVisible();
  expect(state.calls[1].body).toEqual({ base_input_hash: "b".repeat(64) });
  await expect(page.getByTestId("podcast-spoken-preview")).toHaveText("Hot topic\n\nMy updated spoken text.");
  expect(state.calls.every(call => !/render|tts|preview/.test(call.path))).toBe(true);
  await page.getByLabel("本期标题", { exact: true }).fill("Changed title");
  await expect(page.getByText("旧确认已失效，需重新确认", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
});

test("409 preserves local edits and recovery survives refresh", async ({ page }) => {
  const state = await mockPodcast(page);
  state.conflict = true;
  await page.goto("/assets/episode/podcast");
  await page.getByLabel("口播正文", { exact: false }).fill("Do not lose this draft.");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("409");
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("Do not lose this draft.");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("podcast-draft:owner:episode"))).toContain("Do not lose");
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "恢复本地稿" }).click();
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("Do not lose this draft.");
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
});

test("dedicated creation is a single atomic request and old Asset links redirect", async ({ page }) => {
  const state = await mockPodcast(page);
  await page.goto("/assets/podcast/new");
  await page.getByLabel("本期标题", { exact: true }).fill("A new episode");
  await page.getByLabel("音色", { exact: true }).selectOption("Ono Anna");
  await page.getByRole("button", { name: "创建并保存播客" }).click();
  await expect(page).toHaveURL(/\/assets\/episode\/podcast$/);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].path).toBe("/assets/podcast");
  expect((state.calls[0].body.configuration as Record<string, unknown>).voice_id).toBe("Ono Anna");
  await page.goto("/assets/episode");
  await expect(page).toHaveURL(/\/assets\/episode\/podcast$/);
  await expect(page.getByRole("heading", { name: "播客工作台" })).toBeVisible();
});

test("archived episodes stay read-only and display unavailable materials", async ({ page }) => {
  const state = await mockPodcast(page);
  state.saved.status = "archived";
  state.saved.materials[0] = { kind: "source", id: "story", available: false };
  state.saved.approval_issues = ["部分素材已删除或无权访问，请移除或重新选择"];
  await page.goto("/assets/episode/podcast");
  await expect(page.getByLabel("本期标题", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
  await expect(page.getByText("素材不可用", { exact: false })).toBeVisible();
  expect(state.calls).toHaveLength(0);
});

test("malformed browser recovery never replaces the server draft", async ({ page }) => {
  await mockPodcast(page);
  await page.addInitScript(() => localStorage.setItem("podcast-draft:owner:episode", JSON.stringify({ fields: { title: "Broken", configuration: {} }, base: null })));
  await page.goto("/assets/episode/podcast");
  await expect(page.getByRole("alert")).toContainText("恢复稿格式无效");
  await expect(page.getByLabel("本期标题", { exact: true })).toHaveValue("Hot topic");
  await expect(page.getByRole("button", { name: "恢复本地稿" })).toHaveCount(0);
});

function proposal(saved: PodcastDraft) {
  return { kind: "podcast_script_proposal", asset_id: saved.asset_id, base_input_hash: saved.input_hash,
    outline: "New spoken outline", paragraphs: [
      { text: "A grounded candidate.", material_refs: [{ kind: "source", id: "story" }] },
      { text: "My personal opinion.", material_refs: [] },
    ], warnings: ["Verify dates before publication"] };
}

test("authoring contracts normalize paragraphs, bound inputs and reject ungrounded responses", () => {
  expect(podcastParagraphs(" First  \r\nSecond\r\n\r\nOpinion ")).toEqual(["First\nSecond", "Opinion"]);
  const saved = draft();
  expect(buildPodcastAuthoringPrompt(saved)).toContain(saved.input_hash);
  expect(parsePodcastScriptProposal(`\`\`\`json\n${JSON.stringify(proposal(saved))}\n\`\`\``, saved).paragraphs).toHaveLength(2);
  expect(() => buildPodcastAuthoringPrompt({ ...saved, draft_content: "x".repeat(12001) })).toThrow("12000");
  expect(() => buildPodcastAuthoringPrompt({ ...saved, materials: [] })).toThrow("可用素材");
  expect(() => buildPodcastAuthoringPrompt({ ...saved, materials: [{ ...saved.materials[0], available: false }] })).toThrow("可用素材");
  expect(() => parsePodcastScriptProposal("x".repeat(160001), saved)).toThrow("允许大小");
  const ungrounded = proposal(saved);
  ungrounded.paragraphs[0].material_refs = [];
  expect(() => parsePodcastScriptProposal(JSON.stringify(ungrounded), saved)).toThrow("素材关联");
  const repeated = proposal(saved);
  repeated.paragraphs[0].material_refs.push({ kind: "source", id: "story" });
  expect(() => parsePodcastScriptProposal(JSON.stringify(repeated), saved)).toThrow("重复来源");
});

async function mockAuthoring(page: Page, value: unknown) {
  const calls: Record<string, unknown>[] = [];
  await page.route("http://127.0.0.1:4000/api/chat", async route => {
    calls.push(route.request().postDataJSON());
    const events = [{ type: "session", session_id: "podcast-authoring-session" },
      { type: "text", content: typeof value === "string" ? value : JSON.stringify(value) }, { type: "done" }];
    await route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  return calls;
}

test("Podcast is discoverable in the library and unified creation guide without creating an Asset", async ({ page }) => {
  const state = await mockPodcast(page);
  await page.goto("/assets");
  await page.getByRole("button", { name: "创建播客 · Create Podcast" }).click();
  await expect(page).toHaveURL(/\/assets\/podcast\/new$/);
  expect(state.calls).toHaveLength(0);
  await page.goto("/assets/new");
  await page.getByLabel("Asset title", { exact: true }).fill("My next episode");
  await page.getByLabel("Research question", { exact: true }).fill("Why does this matter?");
  await page.getByRole("button", { name: /播客 · Podcast/ }).click();
  await expect(page).toHaveURL(/\/assets\/podcast\/new$/);
  await expect(page.getByLabel("本期标题", { exact: true })).toHaveValue("My next episode");
  await expect(page.getByRole("textbox", { name: "角度与个人观点", exact: true })).toHaveValue("Why does this matter?");
  expect(state.calls).toHaveLength(0);
});

test("Podcast editor supports ordinary scrolling to the bottom", async ({ page }) => {
  await mockPodcast(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/assets/episode/podcast");
  const editor = page.getByTestId("podcast-editor");
  await expect(editor).toBeVisible();
  const scrollable = await editor.evaluate(element => element.scrollHeight > element.clientHeight);
  expect(scrollable).toBe(true);
  const shortPreview = await page.getByRole("region", { name: "实际口播文本预览内容", exact: true }).evaluate(element => ({ height: element.clientHeight, overflow: element.scrollHeight > element.clientHeight }));
  expect(shortPreview.height).toBeLessThan(200);
  expect(shortPreview.overflow).toBe(false);
  await editor.hover({ position: { x: 100, y: 100 } });
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId("podcast-delivery").getByRole("button", { name: "确认已发布", exact: true })).toBeInViewport();
});

test("Agent candidates require consent, explicit apply and a separate save", async ({ page }) => {
  const state = await mockPodcast(page);
  const requests = await mockAuthoring(page, proposal(state.saved));
  await page.goto("/assets/episode/podcast");
  await expect(page.getByRole("button", { name: "生成口播稿候选" })).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.getByRole("checkbox", { name: /允许将上述内容/ }).check();
  await page.getByRole("button", { name: "生成口播稿候选" }).click();
  await expect(page.getByTestId("podcast-script-proposal")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].ephemeral_session).toBe(true);
  expect(String(requests[0].prompt)).toContain("Evidence");
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
  expect(state.calls).toHaveLength(0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "应用候选到编辑器" }).click();
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A grounded candidate.\n\nMy personal opinion.");
  expect(state.calls).toHaveLength(0);
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  expect(state.saved.paragraph_sources).toEqual([
    { paragraph_index: 0, text_hash: createHash("sha256").update("A grounded candidate.").digest("hex"), material_refs: [{ kind: "source", id: "story" }] },
    { paragraph_index: 1, text_hash: createHash("sha256").update("My personal opinion.").digest("hex"), material_refs: [] },
  ]);
  await page.getByLabel("口播正文", { exact: false }).fill("Manual edit.");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => state.saved.paragraph_sources).toEqual([]);
});

for (const failure of ["malformed", "unknown-source", "wrong-version"]) {
  test(`invalid Agent candidate preserves original script: ${failure}`, async ({ page }) => {
    const state = await mockPodcast(page);
    const candidate = proposal(state.saved);
    if (failure === "unknown-source") candidate.paragraphs[0].material_refs[0].id = "unselected";
    if (failure === "wrong-version") candidate.base_input_hash = "f".repeat(64);
    await mockAuthoring(page, failure === "malformed" ? "Not valid JSON" : candidate);
    await page.goto("/assets/episode/podcast");
    await page.getByRole("checkbox", { name: /允许将上述内容/ }).check();
    await page.getByRole("button", { name: "生成口播稿候选" }).click();
    await expect(page.getByRole("alert")).toContainText("原稿未被覆盖");
    await expect(page.getByTestId("podcast-script-proposal")).toHaveCount(0);
    await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
    expect(state.calls).toHaveLength(0);
  });
}

test("changed server version blocks applying a candidate", async ({ page }) => {
  const state = await mockPodcast(page);
  await mockAuthoring(page, proposal(state.saved));
  await page.goto("/assets/episode/podcast");
  await page.getByRole("checkbox", { name: /允许将上述内容/ }).check();
  await page.getByRole("button", { name: "生成口播稿候选" }).click();
  await expect(page.getByTestId("podcast-script-proposal")).toBeVisible();
  state.saved.input_hash = "f".repeat(64);
  await page.getByRole("button", { name: "应用候选到编辑器" }).click();
  await expect(page.getByRole("alert")).toContainText("候选已过期");
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
  expect(state.calls).toHaveLength(0);
});

test("model errors attempt remote cancellation and retain the manual draft", async ({ page }) => {
  const state = await mockPodcast(page);
  let canceled = false;
  await page.route("http://127.0.0.1:4000/api/sessions/podcast-authoring-session/cancel", route => {
    canceled = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("http://127.0.0.1:4000/api/chat", route => route.fulfill({ contentType: "text/event-stream",
    body: [{ type: "session", session_id: "podcast-authoring-session" }, { type: "error", content: "Model unavailable" }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join("") }));
  await page.goto("/assets/episode/podcast");
  await page.getByRole("checkbox", { name: /允许将上述内容/ }).check();
  await page.getByRole("button", { name: "生成口播稿候选" }).click();
  await expect(page.getByRole("alert")).toContainText("Model unavailable");
  await expect.poll(() => canceled).toBe(true);
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
  expect(state.calls).toHaveLength(0);
});

test("manual paragraph attribution saves text hashes and clears after changing materials", async ({ page }) => {
  const state = await mockPodcast(page);
  await page.goto("/assets/episode/podcast");
  await page.getByText(/^第 1 段 ·/).click();
  await page.getByRole("checkbox", { name: "第 1 段来源：Original reporting", exact: true }).check();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => state.saved.paragraph_sources?.length).toBe(1);
  expect(state.saved.paragraph_sources?.[0].text_hash).toBe(createHash("sha256").update("A spoken script.").digest("hex"));
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => state.saved.paragraph_sources).toEqual([]);
});

async function mockAudioPreflight(page: Page) {
  const state = await mockPodcast(page);
  state.saved.approval_status = "current";
  state.saved.latest_approval = { id: "approved", asset_id: "episode", config_revision: 1,
    input_hash: state.saved.input_hash, script_hash: createHash("sha256").update(state.saved.spoken_text).digest("hex"),
    spoken_text: state.saved.spoken_text, source_snapshot: state.saved.materials,
    config_snapshot: { voice_id: "Cherry" }, approved_by: "owner", created_at: now };
  const preflight = { calls: [] as Record<string, unknown>[], conflict: false, budgetExceeded: false, executionEnabled: false, segmentCount: 1, activeRenderId: null as string | null };
  await page.route("http://127.0.0.1:4000/api/auth/me/api-credentials", route => route.fulfill({ json: { items: [
    { id: 7, provider: "qwen", label: "Personal Qwen", secret_masked: "***1234", is_enabled: true },
    { id: 8, provider: "qwen", label: "Disabled Qwen", secret_masked: "***5678", is_enabled: false },
    { id: 9, provider: "tavily", label: "Not an audio key", secret_masked: "***9999", is_enabled: true },
  ], total: 3 } }));
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-preflight", route => {
    const body = route.request().postDataJSON();
    preflight.calls.push(body);
    if (preflight.conflict) return route.fulfill({ status: 409, json: { detail: "Podcast inputs changed; save and confirm again" } });
    const unknown = body.price_per_10k_characters === null;
    const segmentLength = Math.ceil(state.saved.spoken_text.length / preflight.segmentCount);
    const report: PodcastAudioPreflight = {
      asset_id: "episode", input_hash: state.saved.input_hash, script_approval_id: "approved", script_hash: state.saved.latest_approval!.script_hash,
      configuration: state.saved.configuration, credential_id: body.credential_id, credential_label: body.credential_id ? "Personal Qwen" : null,
      credential_checks_passed: body.credential_id === 7, budget_limit: body.budget_limit, currency: "CNY",
      price_per_10k_characters: body.price_per_10k_characters, pricing_source: unknown ? null : "user_entered", pricing_verified: false,
      character_count: state.saved.spoken_text.length, reserved_character_count: state.saved.spoken_text.length,
      segmentation_version: "utf16-300-double-reserve-v3", execution_fingerprint: "c".repeat(64), pricing_policy_id: "fixture-policy", pricing_policy_current: true, segments: Array.from({ length: preflight.segmentCount }, (_value, position) => {
        const text = state.saved.spoken_text.slice(position * segmentLength, (position + 1) * segmentLength);
        return { position, spoken_text: text, text_hash: createHash("sha256").update(text).digest("hex"), character_count: text.length, reserved_character_count: text.length,
          estimated_cost: unknown ? null : preflight.budgetExceeded ? "3.0000" : "0.0022" };
      }),
      estimated_cost: unknown ? null : preflight.budgetExceeded ? "3.0000" : "0.0022", budget_sufficient: unknown ? null : !preflight.budgetExceeded,
      active_render_id: preflight.activeRenderId, active_render_status: preflight.activeRenderId ? "outcome_unknown" : null, checks_passed: !unknown && body.credential_id === 7 && !preflight.budgetExceeded && !preflight.activeRenderId,
      issues: preflight.activeRenderId ? [{ code: "active_render", message: "已有活动音频任务或结果未知的调用。" }] : unknown ? [{ code: "price_unknown", message: "费用未知，不等于零。" }] : preflight.budgetExceeded ? [{ code: "budget_exceeded", message: "保守费用估算超过本次预算。" }] : [],
      warnings: ["预检不创建任务，不调用 TTS。"], checked_at: now, audio_generation_available: preflight.executionEnabled,
    };
    return route.fulfill({ json: report });
  });
  return { state, preflight };
}

for (const viewport of [{ width: 1100, height: 720 }, { width: 390, height: 844 }]) {
  test(`long Podcast panels scroll independently at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { state, preflight } = await mockAudioPreflight(page);
    state.saved.draft_content = Array.from({ length: 60 }, (_value, position) => `第 ${position + 1} 段。${"这是用于验证长稿件滚动的内容。".repeat(12)}`).join("\n\n");
    state.saved.spoken_text = `${state.saved.title}\n\n${state.saved.draft_content}`;
    state.saved.latest_approval!.spoken_text = state.saved.spoken_text;
    state.saved.latest_approval!.script_hash = createHash("sha256").update(state.saved.spoken_text).digest("hex");
    preflight.segmentCount = 40;
    const tasks = Array.from({ length: 20 }, (_value, position) => ({ id: `audio-${position}`, asset_id: "episode", script_approval_id: "approved", input_hash: "a".repeat(64),
      status: "ready", budget_limit: "2", currency: "CNY", estimated_cost: "0.0022", duration_seconds: "12.3", file_sha256: "f".repeat(64),
      segment_count: 40, ready_segment_count: 40, attempt_count: 40, reported_characters: null, reported_cost: null, error_message: null, created_at: now, completed_at: now }));
    await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders", route => route.fulfill({ json: { items: tasks } }));
    await page.goto("/assets/episode/podcast");
    if (viewport.width < 640) await page.getByRole("button", { name: "Collapse", exact: true }).click();
    const editor = page.getByTestId("podcast-editor");

    const verifyScroll = async (label: string) => {
      const region = page.getByRole("region", { name: label, exact: true });
      await region.scrollIntoViewIfNeeded();
      const metrics = await region.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth, overflowY: getComputedStyle(element).overflowY, focusable: element.tabIndex, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) }));
      expect(metrics.height).toBeLessThanOrEqual(Math.min(viewport.height / 2, metrics.rem * 24) + 1);
      expect(metrics.content).toBeGreaterThan(metrics.height);
      expect(metrics.overflowY).toBe("auto");
      expect(metrics.focusable).toBe(0);
      expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.width);
      const parentTop = await editor.evaluate(element => element.scrollTop);
      await region.hover();
      await page.mouse.wheel(0, 160);
      await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      expect(Math.abs((await editor.evaluate(element => element.scrollTop)) - parentTop)).toBeLessThanOrEqual(1);
      await region.focus();
      await page.keyboard.press("End");
      await expect.poll(() => region.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
    };

    await verifyScroll("段落来源列表");
    await verifyScroll("实际口播文本预览内容");
    await page.getByText("上次确认快照（历史记录，不随编辑覆盖）", { exact: true }).click();
    await verifyScroll("历史确认快照内容");
    await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
    await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
    await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
    await page.getByText("查看冻结口播稿的分段计划", { exact: true }).click();
    await verifyScroll("音频分段计划");
    await verifyScroll("本期音频任务列表");
    await expect(page.getByRole("button", { name: "下载本期 MP3" }).last()).toBeInViewport();
    await page.getByRole("button", { name: "确认已保存的口播稿" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeInViewport();
    expect(state.calls).toHaveLength(0);
  });
}

for (const creating of [true, false]) {
  test(`audio generation stays discoverable before ${creating ? "creation" : "script approval"}`, async ({ page }) => {
    const state = await mockPodcast(page);
    await page.goto(creating ? "/assets/podcast/new" : "/assets/episode/podcast");
    await page.getByRole("button", { name: "前往生成音频", exact: true }).click();
    const section = page.getByTestId("podcast-audio-preflight");
    await expect(section).toBeFocused();
    const generate = section.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true });
    await generate.scrollIntoViewIfNeeded();
    await expect(generate).toBeInViewport();
    await expect(generate).toBeDisabled();
    await expect(page.getByTestId("podcast-audio-generation-status")).toHaveText(creating
      ? "请先创建并保存播客，再确认口播稿。" : "请先确认已保存的口播稿。");
    expect(state.calls).toHaveLength(0);
  });
}

test("audio preflight is explicit, keeps unknown costs unknown and creates no render", async ({ page }) => {
  const { state, preflight } = await mockAudioPreflight(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-preflight");
  await expect(section.getByRole("button", { name: "检查分段与预算（不扣费）" })).toBeEnabled();
  expect(preflight.calls).toHaveLength(0);
  const credentials = page.getByLabel("音频 Qwen 凭据", { exact: true });
  await expect(credentials.locator("option")).toHaveCount(3);
  await expect(credentials.locator("option", { hasText: "Disabled Qwen" })).toHaveAttribute("disabled", "");
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  const report = page.getByTestId("podcast-audio-preflight-report");
  await expect(report).toContainText("未知（不是零）");
  await expect(report).toContainText("无法判断");
  expect(preflight.calls[0]).toEqual({ base_input_hash: "a".repeat(64), budget_limit: "2", credential_id: null, price_per_10k_characters: null });
  expect(state.calls).toHaveLength(0);
  await expect(section.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true })).toBeDisabled();
  await expect(section).toContainText("当前服务端未开放音频执行");
});

test("successful preflight keeps generation visible when server execution is unavailable", async ({ page }) => {
  const { state } = await mockAudioPreflight(page);
  await page.goto("/assets/episode/podcast");
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("本地预检通过");
  await expect(page.getByTestId("podcast-audio-generation-status")).toContainText("服务端尚未开放音频执行");
  await expect(page.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /授权将本期已确认/ })).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
});

test("audio preflight binds a personal credential and explicit rate, then invalidates edited inputs", async ({ page }) => {
  const { state, preflight } = await mockAudioPreflight(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-preflight");
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByLabel("音频预算上限", { exact: true }).fill("1.5");
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  const report = page.getByTestId("podcast-audio-preflight-report");
  await expect(report).toContainText("本地预检通过（不是执行授权）");
  await expect(report).toContainText("0.0022 元（用户输入单价，未核验）");
  expect(preflight.calls[0].credential_id).toBe(7);
  expect(preflight.calls[0].price_per_10k_characters).toBe("0.8");
  expect(preflight.calls[0].budget_limit).toBe("1.5");
  await report.getByText("查看冻结口播稿的分段计划", { exact: true }).click();
  await expect(report.locator("pre")).toHaveText(state.saved.spoken_text);
  await page.getByLabel("音频预算上限", { exact: true }).fill("1.6");
  await expect(report.getByRole("alert")).toContainText("旧预检结果已失效");
  await page.getByLabel("本期标题", { exact: true }).fill("Unsaved title");
  await expect(section.getByRole("button", { name: "检查分段与预算（不扣费）" })).toBeDisabled();
  expect(state.calls).toHaveLength(0);
});

test("preflight conflicts and over-budget estimates do not alter the script", async ({ page }) => {
  const { state, preflight } = await mockAudioPreflight(page);
  preflight.conflict = true;
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-preflight");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(section.getByRole("alert")).toContainText("409");
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
  preflight.conflict = false;
  preflight.budgetExceeded = true;
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("估算超出预算");
  preflight.conflict = true;
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(section.getByRole("alert")).toContainText("409");
  await expect(page.getByTestId("podcast-audio-preflight-report")).toHaveCount(0);
  await page.getByLabel("音频预算上限", { exact: true }).fill("2.01");
  await expect(section.getByRole("button", { name: "检查分段与预算（不扣费）" })).toBeDisabled();
  expect(preflight.calls).toHaveLength(3);
  expect(state.calls).toHaveLength(0);
});

test("unconfirmed and archived scripts cannot request audio preflight", async ({ page }) => {
  const state = await mockPodcast(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-preflight");
  await expect(section.getByRole("button", { name: "检查分段与预算（不扣费）" })).toBeDisabled();
  state.saved.status = "archived";
  await page.reload();
  await expect(section.getByRole("button", { name: "检查分段与预算（不扣费）" })).toBeDisabled();
  await expect(page.getByLabel("音频预算上限", { exact: true })).toBeDisabled();
  expect(state.calls).toHaveLength(0);
});

test("editing during preflight rejects the in-flight report without losing edits", async ({ page }) => {
  const { state } = await mockAudioPreflight(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-preflight", async route => {
    requested = true;
    await gate;
    await route.fallback();
  });
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-preflight");
  await section.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByLabel("本期标题", { exact: true }).fill("Keep this local edit");
  release();
  await expect(section.getByRole("alert")).toContainText("本次预检结果未采用");
  await expect(page.getByTestId("podcast-audio-preflight-report")).toHaveCount(0);
  await expect(page.getByLabel("本期标题", { exact: true })).toHaveValue("Keep this local edit");
  expect(state.calls).toHaveLength(0);
});

async function mockWebMaterials(page: Page) {
  const state = await mockPodcast(page);
  const web = { searches: [] as Record<string, unknown>[], saves: [] as Record<string, unknown>[], searchError: false, saveError: false, empty: false };
  const item = { title: "Selected web story", url: "https://example.com/News", summary: "A bounded search excerpt, not verified facts.", source_name: "tavily", published_at: "2026-10-15" };
  await page.route("http://127.0.0.1:4000/api/discovery/web-search/preview", route => {
    expect(route.request().headers().authorization).toBe("Bearer podcast-editor-test");
    web.searches.push(route.request().postDataJSON());
    if (web.searchError) return route.fulfill({ status: 422, json: { detail: "TAVILY_API_KEY is not configured" } });
    return route.fulfill({ json: web.empty ? [] : [item, { ...item, title: "Undated story", url: "https://example.org/undated", published_at: null }, { title: "Unsafe link", url: "javascript:alert(1)" }] });
  });
  await page.route("http://127.0.0.1:4000/api/discovery/web-results/save", route => {
    const body = route.request().postDataJSON();
    web.saves.push(body);
    if (web.saveError) return route.abort("failed");
    return route.fulfill({ json: { items: [{ id: "web-story", title: item.title, url: item.url, source_type: "web", category_id: 1, ingested_at: now, description: item.summary }], created: web.saves.length === 1 ? 1 : 0, reused: web.saves.length === 1 ? 0 : 1 } });
  });
  return { state, web, item };
}

test("web material normalization rejects unsafe links and preserves URL case and bounded summaries", () => {
  const result = normalizeWebMaterials([
    { title: "Upper", url: "https://EXAMPLE.com/News#first", summary: "x".repeat(12000) },
    { title: "Duplicate", url: "https://example.com/News#second" },
    { title: "Lower", url: "https://example.com/news" },
    { title: "Unsafe", url: "javascript:alert(1)" },
    { title: "Credentials", url: "https://user:password@example.com/private" },
    { title: "\u0000", url: "https://example.com/empty" },
  ]);
  expect(result.items.map(item => item.url)).toEqual(["https://example.com/News", "https://example.com/news"]);
  expect(result.items[0].summary).toHaveLength(10000);
  expect(result.ignored).toBe(3);
  expect(() => normalizeWebMaterials({ items: [] })).toThrow("格式无效");
});

test("web research previews only then explicitly saves selected Sources and requires a separate draft save", async ({ page }) => {
  const { state, web, item } = await mockWebMaterials(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-web-materials");
  expect(web.searches).toHaveLength(0);
  await page.getByLabel("口播正文", { exact: false }).fill("My pasted blog must remain unchanged.");
  await section.getByLabel("播客联网搜索词").fill("breaking topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await expect(section).toContainText("2026-10-15");
  await expect(section).toContainText("未知（不是搜索时间）");
  await expect(section).toContainText("已忽略 1 条");
  expect(web.searches).toEqual([{ query: "breaking topic", max_results: 8 }]);
  expect(web.saves).toHaveLength(0);
  expect(state.calls).toHaveLength(0);
  await section.getByRole("checkbox", { name: "采用网页：Selected web story" }).check();
  page.once("dialog", dialog => dialog.dismiss());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  expect(web.saves).toHaveLength(0);
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  await expect(section.getByRole("status")).toContainText("已保存 1 份");
  expect(web.saves).toEqual([{ query: "breaking topic", items: [item] }]);
  expect(state.calls).toHaveLength(0);
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("My pasted blog must remain unchanged.");
  await expect(page.getByText("source: Selected web story", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeDisabled();
  state.saved.materials.push({ kind: "source", id: "web-story", title: item.title, available: true, excerpt: item.summary });
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeEnabled();
  expect(state.calls[0].body.source_refs).toEqual(["story", "web-story"]);
  expect(state.calls[0].body.draft_content).toBe("My pasted blog must remain unchanged.");
});

test("adopting an already linked web Source preserves paragraph attribution and saved state", async ({ page }) => {
  const { state, item } = await mockWebMaterials(page);
  const mapping = [{ paragraph_index: 0, text_hash: createHash("sha256").update(state.saved.draft_content).digest("hex"), material_refs: [{ kind: "source" as const, id: "story" }] }];
  state.saved.paragraph_sources = mapping;
  await page.route("http://127.0.0.1:4000/api/discovery/web-results/save", route => route.fulfill({ json: {
    items: [{ id: "story", title: item.title, url: item.url, source_type: "web", category_id: 1, ingested_at: now }], created: 0, reused: 1,
  } }));
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-web-materials");
  await section.getByLabel("播客联网搜索词").fill("topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await section.getByRole("checkbox", { name: "采用网页：Selected web story" }).check();
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  await expect(section.getByRole("status")).toContainText("复用 1 份");
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeEnabled();
  expect(state.saved.paragraph_sources).toEqual(mapping);
  expect(state.calls).toHaveLength(0);
});

test("web search failures remain errors and changing the query clears old selections", async ({ page }) => {
  const { web } = await mockWebMaterials(page);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-web-materials");
  await section.getByLabel("播客联网搜索词").fill("first topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await section.getByRole("checkbox", { name: "采用网页：Selected web story" }).check();
  await section.getByLabel("播客联网搜索词").fill("different topic");
  await expect(section.getByRole("button", { name: /保存并关联/ })).toHaveCount(0);
  web.searchError = true;
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await expect(section.getByRole("alert")).toContainText("联网搜索失败");
  await expect(section).not.toContainText("没有可用结果");
  expect(web.searches).toHaveLength(2);
  web.searchError = false; web.empty = true;
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await expect(section).toContainText("没有可用结果");
  expect(web.saves).toHaveLength(0);
});

test("ambiguous web material saves preserve selection and retry the same request without editing the script", async ({ page }) => {
  const { state, web } = await mockWebMaterials(page);
  web.saveError = true;
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-web-materials");
  await section.getByLabel("播客联网搜索词").fill("topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await section.getByRole("checkbox", { name: "采用网页：Selected web story" }).check();
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  await expect(section.getByRole("alert")).toContainText("可能已有 Source 入库");
  expect(web.saves).toHaveLength(1);
  await expect(section.getByRole("checkbox", { name: "采用网页：Selected web story" })).toBeChecked();
  web.saveError = false;
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  await expect(section.getByRole("status")).toContainText("复用 1 份");
  expect(web.saves[0]).toEqual(web.saves[1]);
  expect(state.calls).toHaveLength(0);
  await expect(page.getByLabel("口播正文", { exact: false })).toHaveValue("A spoken script.");
});

test("web research respects the episode material limit and archived read-only state", async ({ page }) => {
  const { state, web } = await mockWebMaterials(page);
  state.saved.note_refs = Array.from({ length: 19 }, (_value, position) => `note-${position}`);
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-web-materials");
  await section.getByLabel("播客联网搜索词").fill("topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await expect(section).toContainText("还可关联 0 份素材");
  await expect(section.getByRole("checkbox", { name: "采用网页：Selected web story" })).toBeDisabled();
  state.saved.status = "archived";
  await page.reload();
  await expect(section.getByRole("button", { name: "搜索网络素材" })).toBeDisabled();
  expect(web.searches).toHaveLength(1);
  expect(web.saves).toHaveLength(0);
});

test("new episodes can adopt web materials without automatically creating a Podcast", async ({ page }) => {
  const { state, web } = await mockWebMaterials(page);
  await page.goto("/assets/podcast/new");
  const section = page.getByTestId("podcast-web-materials");
  await section.getByLabel("播客联网搜索词").fill("topic");
  await section.getByRole("button", { name: "搜索网络素材" }).click();
  await section.getByRole("checkbox", { name: "采用网页：Selected web story" }).check();
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "保存并关联选中素材（1）" }).click();
  await expect(section.getByRole("status")).toContainText("已保存 1 份");
  expect(state.calls).toHaveLength(0);
  expect(web.saves).toHaveLength(1);
  await page.getByLabel("本期标题", { exact: true }).fill("My new episode");
  await page.getByRole("button", { name: "创建并保存播客", exact: true }).click();
  await expect(page).toHaveURL(/\/assets\/episode\/podcast$/);
  expect(state.calls[0].path).toBe("/assets/podcast");
  expect(state.calls[0].body.source_refs).toEqual(["web-story"]);
});

test("pasted blog scripts can be saved confirmed and preflighted without materials", async ({ page }) => {
  const { state } = await mockAudioPreflight(page);
  state.saved.source_refs = [];
  state.saved.note_refs = [];
  state.saved.wiki_refs = [];
  state.saved.materials = [];
  state.saved.latest_approval = null;
  state.saved.approval_status = "unconfirmed";
  const content = "这是已经写好的博客正文。\n\n直接粘贴后制作本期播客。";
  await page.goto("/assets/episode/podcast");
  await expect(page.getByText("素材可选。", { exact: false })).toBeVisible();
  await page.getByLabel("口播正文", { exact: false }).fill(content);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认已保存的口播稿" })).toBeEnabled();
  expect(state.calls[0].body).toMatchObject({ draft_content: content, source_refs: [], note_refs: [], wiki_refs: [] });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "确认已保存的口播稿" }).click();
  await expect(page.getByText("当前版本已确认", { exact: false })).toBeVisible();
  expect(state.saved.latest_approval!.source_snapshot).toEqual([]);
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("本地预检通过");
});

test("audio authorization requires explicit consent and recovers the same request across refresh", async ({ page }) => {
  const { state, preflight } = await mockAudioPreflight(page);
  preflight.executionEnabled = true;
  const submissions: Record<string, unknown>[] = [];
  let task: Record<string, unknown> | null = null;
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: task ? [task] : [] } });
    const body = route.request().postDataJSON();
    submissions.push(body);
    if (!task) {
      task = { id: "audio-task", asset_id: "episode", script_approval_id: "approved", input_hash: state.saved.input_hash,
        status: "queued", budget_limit: "2", currency: "CNY", estimated_cost: "0.0022", duration_seconds: null,
        file_sha256: null, segment_count: 1, ready_segment_count: 0, attempt_count: 0, reported_characters: null,
        reported_cost: null, error_message: null, created_at: now, completed_at: null };
      return route.abort("failed");
    }
    return route.fulfill({ json: task });
  });
  await page.goto("/assets/episode/podcast");
  const generate = page.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true });
  await expect(generate).toBeDisabled();
  await expect(page.getByTestId("podcast-audio-generation-status")).toContainText("检查分段与预算");
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  const authorize = page.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true });
  await expect(authorize).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await page.getByRole("checkbox", { name: /授权将本期已确认/ }).check();
  await page.getByRole("checkbox", { name: /已核对账户单价/ }).check();
  page.once("dialog", dialog => dialog.accept());
  await authorize.click();
  await expect(page.getByTestId("podcast-audio-preflight").getByRole("alert")).toContainText("提交结果未确认");
  expect(submissions).toHaveLength(1);
  expect(submissions[0].authorize_text_to_provider).toBe(true);
  expect(submissions[0].acknowledge_billing_uncertainty).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "重试同一音频提交" })).toBeVisible();
  expect(submissions).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "重试同一音频提交" }).click();
  await expect(page.getByText("音频任务已登记：", { exact: false })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(await page.evaluate(() => localStorage.getItem("podcast-audio-submit:owner:episode"))).toBeNull();
  expect(state.calls).toHaveLength(0);
});

test("audio authorization resets on budget changes and storage failure prevents submission", async ({ page }) => {
  const { preflight } = await mockAudioPreflight(page);
  preflight.executionEnabled = true;
  let submissions = 0;
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders", route => {
    if (route.request().method() === "POST") submissions += 1;
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/assets/episode/podcast");
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await page.getByRole("checkbox", { name: /授权将本期已确认/ }).check();
  await page.getByRole("checkbox", { name: /已核对账户单价/ }).check();
  await page.getByLabel("音频预算上限", { exact: true }).fill("1");
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("旧预检结果已失效");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(page.getByRole("checkbox", { name: /授权将本期已确认/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /已核对账户单价/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /授权将本期已确认/ }).check();
  await page.getByRole("checkbox", { name: /已核对账户单价/ }).check();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("podcast-audio-submit:")) throw new Error("Storage unavailable");
      original.call(this, key, value);
    };
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true }).click();
  await expect(page.getByTestId("podcast-audio-preflight").getByRole("alert")).toContainText("未提交音频任务");
  expect(submissions).toBe(0);
});

test("audio history exposes authenticated downloads but no retry for unknown outcomes", async ({ page }) => {
  await mockPodcast(page);
  const tasks = ["ready", "outcome_unknown", "queued"].map((status, position) => ({ id: `audio-${position}`, asset_id: "episode", script_approval_id: "approved",
    input_hash: "a".repeat(64), status, budget_limit: "2", currency: "CNY", estimated_cost: "0.0022", duration_seconds: status === "ready" ? "12.3" : null,
    file_sha256: status === "ready" ? "f".repeat(64) : null, segment_count: 1, ready_segment_count: status === "ready" ? 1 : 0,
    attempt_count: status === "queued" ? 0 : 1, reported_characters: null, reported_cost: null, error_message: null, created_at: now, completed_at: null }));
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders", route => route.fulfill({ json: { items: tasks } }));
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders/audio-0/download", route => {
    expect(route.request().headers().authorization).toBe("Bearer podcast-editor-test");
    return route.fulfill({ contentType: "audio/mpeg", headers: { "Content-Disposition": "attachment; filename=seagull-podcast.mp3" }, body: "fixture-mp3" });
  });
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders/audio-2/cancel", route => {
    tasks[2].status = "canceled";
    return route.fulfill({ json: tasks[2] });
  });
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-tasks");
  await expect(section).toContainText("结果未知，已停止后续请求");
  await expect(section).toContainText("此任务未记录详细失败诊断");
  await expect(section.getByRole("button", { name: /重试/ })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await section.getByRole("button", { name: "下载本期 MP3" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("seagull-podcast.mp3");
  const path = await download.path();
  expect(readFileSync(path!, "utf8")).toBe("fixture-mp3");
  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", { name: "取消排队任务" }).click();
  await expect(section).toContainText("canceled · audio-2");
});

function playableAudioFixture() {
  const sampleRate = 8000;
  const payload = Buffer.alloc(44 + sampleRate * 2 * 4);
  payload.write("RIFF", 0);
  payload.writeUInt32LE(payload.length - 8, 4);
  payload.write("WAVEfmt ", 8);
  payload.writeUInt32LE(16, 16);
  payload.writeUInt16LE(1, 20);
  payload.writeUInt16LE(1, 22);
  payload.writeUInt32LE(sampleRate, 24);
  payload.writeUInt32LE(sampleRate * 2, 28);
  payload.writeUInt16LE(2, 32);
  payload.writeUInt16LE(16, 34);
  payload.write("data", 36);
  payload.writeUInt32LE(payload.length - 44, 40);
  return payload;
}

async function mockPlayableAudio(page: Page, count = 1) {
  const state = await mockPodcast(page);
  const tasks = Array.from({ length: count }, (_value, position): PodcastAudioRender => ({
    id: `playable-${position}`, asset_id: "episode", script_approval_id: "approved", input_hash: "a".repeat(64),
    status: "ready", budget_limit: "2", currency: "CNY", estimated_cost: "0.01", duration_seconds: "4",
    file_sha256: "f".repeat(64), segment_count: 1, ready_segment_count: 1, attempt_count: 1,
    reported_characters: 100, reported_cost: null, error_message: null, created_at: now, completed_at: now,
  }));
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders", route => route.fulfill({ json: { items: tasks } }));
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => {
      sessionStorage.setItem("podcast-revoked-url", url);
      revoke(url);
    };
  });
  return state;
}

test("audio playback loads only on demand, supports play pause seeking and releases files", async ({ page }) => {
  const state = await mockPlayableAudio(page);
  let requests = 0;
  await page.route("**/podcast/audio-renders/playable-0/download", route => {
    requests += 1;
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().authorization).toBe("Bearer podcast-editor-test");
    expect(route.request().url()).not.toContain("token=");
    return route.fulfill({ contentType: "audio/wav", body: playableAudioFixture() });
  });
  await page.goto("/assets/episode/podcast");
  const player = page.getByTestId("podcast-audio-player");
  const audio = player.locator("audio");
  await expect(player.getByRole("button", { name: "加载试听", exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await expect(audio).not.toHaveAttribute("src");
  await player.getByRole("button", { name: "加载试听", exact: true }).click();
  await expect(audio).toBeVisible();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
  const source = await audio.getAttribute("src");
  expect(source).toMatch(/^blob:/);
  expect(requests).toBe(1);
  await audio.evaluate(element => (element as HTMLAudioElement).play());
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0.1);
  await audio.evaluate(element => (element as HTMLAudioElement).pause());
  expect(await audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  await audio.evaluate(element => { (element as HTMLAudioElement).currentTime = 2; });
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThanOrEqual(2);
  expect(requests).toBe(1);
  await player.getByRole("button", { name: "关闭试听" }).click();
  await expect(audio).not.toHaveAttribute("src");
  expect(await page.evaluate(() => sessionStorage.getItem("podcast-revoked-url"))).toBe(source);
  await player.getByRole("button", { name: "加载试听", exact: true }).click();
  await expect(audio).toHaveAttribute("src", /^blob:/);
  const secondSource = await audio.getAttribute("src");
  await page.getByRole("button", { name: "返回 Assets", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(player).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("podcast-revoked-url"))).toBe(secondSource);
  expect(state.calls).toHaveLength(0);
});

for (const failure of ["http", "empty", "corrupt"]) {
  test(`audio playback ${failure} errors allow a read-only manual reload`, async ({ page }) => {
    const state = await mockPlayableAudio(page);
    let requests = 0;
    await page.route("**/podcast/audio-renders/playable-0/download", route => {
      requests += 1;
      if (requests > 1) return route.fulfill({ contentType: "audio/wav", body: playableAudioFixture() });
      if (failure === "http") return route.fulfill({ status: 404, json: { detail: "File unavailable" } });
      return route.fulfill({ contentType: "audio/mpeg", body: failure === "empty" ? "" : "not-an-audio-file" });
    });
    await page.goto("/assets/episode/podcast");
    const player = page.getByTestId("podcast-audio-player");
    await player.getByRole("button", { name: "加载试听", exact: true }).click();
    await expect(player.getByRole("alert")).toContainText(failure === "http" ? "404" : failure === "empty" ? "音频文件为空" : "音频无法播放");
    expect(requests).toBe(1);
    await player.getByRole("button", { name: "重新加载试听", exact: true }).click();
    await expect.poll(() => player.locator("audio").evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
    expect(requests).toBe(2);
    expect(state.calls).toHaveLength(0);
  });
}

test("audio playback can cancel loading without creating a stale player or audio task", async ({ page }) => {
  const state = await mockPlayableAudio(page);
  let completeFirst: () => void = () => {};
  const gate = new Promise<void>(resolve => { completeFirst = resolve; });
  let requests = 0;
  await page.route("**/podcast/audio-renders/playable-0/download", async route => {
    requests += 1;
    if (requests === 1) await gate;
    await route.fulfill({ contentType: "audio/wav", body: playableAudioFixture() }).catch(() => {});
  });
  await page.goto("/assets/episode/podcast");
  const player = page.getByTestId("podcast-audio-player");
  await player.getByRole("button", { name: "加载试听", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await player.getByRole("button", { name: "取消加载", exact: true }).click();
  completeFirst();
  await expect(player.getByRole("button", { name: "加载试听", exact: true })).toBeEnabled();
  await expect(player.locator("audio")).not.toHaveAttribute("src");
  await player.getByRole("button", { name: "加载试听", exact: true }).click();
  await expect.poll(() => player.locator("audio").evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect(player.getByRole("alert")).toHaveCount(0);
  expect(requests).toBe(2);
  expect(state.calls).toHaveLength(0);
});

test("audio playback expires authentication on 401 rather than exposing a media URL", async ({ page }) => {
  await mockPlayableAudio(page);
  await page.route("http://127.0.0.1:4000/api/auth/logout", route => route.fulfill({ status: 204 }));
  await page.route("**/podcast/audio-renders/playable-0/download", route => route.fulfill({ status: 401, json: { detail: "Unauthorized" } }));
  await page.goto("/assets/episode/podcast");
  await page.getByTestId("podcast-audio-player").getByRole("button", { name: "加载试听", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem("auth_token"))).toBeNull();
});

test("archived audio playback accepts Gateway cookies and pauses other episode players", async ({ page, context }) => {
  const state = await mockPlayableAudio(page, 2);
  state.saved.status = "archived";
  await context.addCookies([{ name: "seagull_access_token", value: "podcast-cookie-fixture", url: "http://127.0.0.1:4000", sameSite: "Lax" }]);
  await page.route("**/podcast/audio-renders/*/download", async route => {
    const headers = await route.request().allHeaders();
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toContain("seagull_access_token=podcast-cookie-fixture");
    return route.fulfill({ contentType: "audio/wav", body: playableAudioFixture() });
  });
  await page.goto("/assets/episode/podcast");
  await page.evaluate(() => localStorage.removeItem("auth_token"));
  const players = page.getByTestId("podcast-audio-player");
  await expect(players).toHaveCount(2);
  for (const player of await players.all()) {
    await player.getByRole("button", { name: "加载试听", exact: true }).click();
    await expect.poll(() => player.locator("audio").evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
  }
  const first = players.nth(0).locator("audio");
  const second = players.nth(1).locator("audio");
  await first.evaluate(element => (element as HTMLAudioElement).play());
  await expect.poll(() => first.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  await second.evaluate(element => (element as HTMLAudioElement).play());
  await expect.poll(() => first.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  expect(await second.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  expect(state.calls).toHaveLength(0);
});

test("audio diagnostics distinguish download timeouts from playback duration without unlocking retries", async ({ page }) => {
  await mockPodcast(page);
  const failure = { stage: "audio_download", code: "read_timeout", elapsed_ms: 120690, http_status: null, provider_request_id: "abc-456" };
  const task = { id: "audio-unknown", asset_id: "episode", script_approval_id: "approved", input_hash: "a".repeat(64),
    status: "outcome_unknown", budget_limit: "2", currency: "CNY", estimated_cost: "0.01", duration_seconds: null,
    file_sha256: null, segment_count: 8, ready_segment_count: 4, attempt_count: 5, reported_characters: null, reported_cost: null,
    error_message: "音频执行停止；有调用结果未知。", failure_details: failure, created_at: now, completed_at: now,
    attempts: [{ id: "attempt-5", segment_position: 4, status: "outcome_unknown", error_code: "read_timeout", provider_request_id: "abc-456",
      billable_characters: 1000, started_at: now, completed_at: now, failure_details: failure }] };
  const writes: string[] = [];
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    return route.fulfill({ json: { items: [task] } });
  });
  await page.goto("/assets/episode/podcast");
  const section = page.getByTestId("podcast-audio-tasks");
  await expect(section).toContainText("服务商音频下载");
  await expect(section).toContainText("读取超时（read_timeout）");
  await expect(section).toContainText("阶段耗时：120.69 秒");
  await expect(section).toContainText("HTTP 状态：未记录");
  await expect(section).toContainText("不是生成音频的播放时长");
  await section.getByText("分段调用诊断（1 次）", { exact: true }).click();
  await expect(section).toContainText("第 5 段 · outcome_unknown");
  await expect(section).toContainText("请求 ID：abc-456 · 服务商报告字符：1000");
  await expect(section.getByRole("button", { name: /重试|取消|下载/ })).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

for (const scenario of [
  { name: "rate limit", failure: { stage: "provider_response", code: "rate_limited", elapsed_ms: 1020, http_status: 429,
    provider_request_id: "abc-123", exception_type: "HTTPStatusError", provider_error_code: "Throttling.RateQuota", retry_after_seconds: 30 } },
  { name: "network disconnect", failure: { stage: "provider_request", code: "network_error", elapsed_ms: 120933, http_status: null,
    provider_request_id: null, exception_type: "ReadError", provider_error_code: null, retry_after_seconds: null } },
]) {
  test(`audio diagnostics expose ${scenario.name} without authorizing retry`, async ({ page }) => {
    await mockPodcast(page);
    const task: PodcastAudioRender = { id: "audio-unknown", asset_id: "episode", script_approval_id: "approved", input_hash: "a".repeat(64),
      status: "outcome_unknown", budget_limit: "2", currency: "CNY", estimated_cost: "0.01", duration_seconds: null,
      file_sha256: null, segment_count: 8, ready_segment_count: 3, attempt_count: 4, reported_characters: null, reported_cost: null,
      error_message: "音频执行停止；有调用结果未知。", failure_details: scenario.failure, created_at: now, completed_at: now };
    const writes: string[] = [];
    await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders**", route => {
      if (route.request().method() !== "GET") writes.push(route.request().method());
      return route.fulfill({ json: { items: [task] } });
    });
    await page.goto("/assets/episode/podcast");
    const section = page.getByTestId("podcast-audio-tasks");
    await expect(section).toContainText(`异常类型：${scenario.failure.exception_type}`);
    if (scenario.failure.code === "rate_limited") {
      await expect(section).toContainText("请求受限（限流或额度限制）");
      await expect(section).toContainText("服务商错误码：Throttling.RateQuota");
      await expect(section).toContainText("服务商响应时建议等待：30 秒");
      await expect(section).toContainText("不是重试倒计时");
      await expect(section).toContainText("结果未知锁保持不变");
    } else {
      await expect(section).toContainText("不能据此认定为限流或音频时长超限");
      await expect(section).toContainText("HTTP 状态：未记录");
      await expect(section).not.toContainText("服务商错误码：");
    }
    await expect(section.getByRole("button", { name: /重试|取消|下载/ })).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });
}

async function mockAbandonableAudioTask(page: Page) {
  const { state, preflight } = await mockAudioPreflight(page);
  preflight.executionEnabled = true;
  preflight.activeRenderId = "old-unknown";
  const task: PodcastAudioRender = { id: "old-unknown", asset_id: "episode", script_approval_id: "approved", input_hash: state.saved.input_hash,
    status: "outcome_unknown", budget_limit: "2", currency: "CNY", estimated_cost: "0.01", duration_seconds: null, file_sha256: null,
    segment_count: 8, ready_segment_count: 4, attempt_count: 5, reported_characters: null, reported_cost: null,
    error_message: "有调用结果未知。", can_abandon: true, abandonment: null, created_at: now, completed_at: now };
  const controls = { loseFirstResponse: false };
  const actions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const tasks = [task];
  await page.route("http://127.0.0.1:4000/api/assets/episode/podcast/audio-renders**", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: tasks } });
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    actions.push({ path, body });
    if (path.endsWith("/abandon")) {
      if (task.status !== "abandoned") {
        if (!task.can_abandon) return route.fulfill({ status: 409, json: { detail: "任务仍有有效执行租约" } });
        task.status = "abandoned"; task.can_abandon = false;
        task.abandonment = { abandoned_by: "owner", abandoned_at: now, previous_status: "outcome_unknown", acknowledge_billing_uncertainty: true, acknowledge_full_regeneration: true };
        preflight.activeRenderId = null;
      }
      if (controls.loseFirstResponse && actions.length === 1) return route.abort("failed");
      return route.fulfill({ json: task });
    }
    const created: PodcastAudioRender = { ...task, id: "new-authorized", status: "queued", abandonment: null, attempt_count: 0, ready_segment_count: 0 };
    tasks.unshift(created);
    return route.fulfill({ json: created });
  });
  return { state, task, actions, controls };
}

test("manual abandonment retains history and requires fresh preflight and authorization before regeneration", async ({ page }) => {
  const { actions } = await mockAbandonableAudioTask(page);
  await page.goto("/assets/episode/podcast");
  await page.getByLabel("音频 Qwen 凭据", { exact: true }).selectOption("7");
  await page.getByLabel("音频账户单价", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("已有活动音频任务");
  const history = page.getByTestId("podcast-audio-tasks");
  await history.getByRole("button", { name: "结束本次任务，允许重新生成" }).click();
  const confirm = history.getByRole("button", { name: "确认结束本次任务", exact: true });
  await expect(confirm).toBeDisabled();
  await history.getByRole("checkbox", { name: /我已核查可用的调用记录/ }).check();
  await expect(confirm).toBeDisabled();
  await history.getByRole("checkbox", { name: /我确认放弃本次不完整音频/ }).check();
  expect(actions).toHaveLength(0);
  await confirm.click();
  await expect(history).toContainText("abandoned · old-unknown");
  await expect(history).toContainText("分段 4/8 · 调用 5 次");
  await expect(history).toContainText("旧调用和片段已保留");
  await expect(page.getByTestId("podcast-audio-preflight-report")).toContainText("旧预检结果已失效");
  expect(actions).toHaveLength(1);
  expect(actions[0].body).toEqual({ acknowledge_billing_uncertainty: true, acknowledge_full_regeneration: true });
  const generate = page.getByRole("button", { name: "生成音频（授权并创建任务）", exact: true });
  await expect(generate).toBeDisabled();
  await page.getByRole("button", { name: "检查分段与预算（不扣费）" }).click();
  await expect(generate).toBeDisabled();
  await page.getByRole("checkbox", { name: /授权将本期已确认/ }).check();
  await page.getByRole("checkbox", { name: /已核对账户单价/ }).check();
  expect(actions).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await generate.click();
  await expect(history).toContainText("queued · new-authorized");
  expect(actions).toHaveLength(2);
  expect(actions[1].path.endsWith("/audio-renders")).toBe(true);
  expect(actions[1].body.authorize_text_to_provider).toBe(true);
});

test("abandonment waits for the server lease guard", async ({ page }) => {
  const { task, actions } = await mockAbandonableAudioTask(page);
  task.can_abandon = false;
  await page.goto("/assets/episode/podcast");
  const history = page.getByTestId("podcast-audio-tasks");
  await expect(history).toContainText("等待执行租约到期");
  await expect(history.getByRole("button", { name: "结束本次任务，允许重新生成" })).toHaveCount(0);
  task.can_abandon = true;
  await expect(history.getByRole("button", { name: "结束本次任务，允许重新生成" })).toBeVisible({ timeout: 10000 });
  expect(actions).toHaveLength(0);
});

test("lost abandonment responses can be confirmed again without creating an audio task", async ({ page }) => {
  const { actions, controls } = await mockAbandonableAudioTask(page);
  controls.loseFirstResponse = true;
  await page.goto("/assets/episode/podcast");
  const history = page.getByTestId("podcast-audio-tasks");
  await history.getByRole("button", { name: "结束本次任务，允许重新生成" }).click();
  await history.getByRole("checkbox", { name: /我已核查可用的调用记录/ }).check();
  await history.getByRole("checkbox", { name: /我确认放弃本次不完整音频/ }).check();
  await history.getByRole("button", { name: "确认结束本次任务", exact: true }).click();
  await expect(history.getByRole("alert")).toContainText("此操作不会创建新的音频任务");
  await history.getByRole("button", { name: "确认结束本次任务", exact: true }).click();
  await expect(history).toContainText("abandoned · old-unknown");
  expect(actions).toHaveLength(2);
  expect(actions[0]).toEqual(actions[1]);
});

test("archived Podcasts cannot abandon audio tasks", async ({ page }) => {
  const { state, actions } = await mockAbandonableAudioTask(page);
  state.saved.status = "archived";
  await page.goto("/assets/episode/podcast");
  await expect(page.getByRole("button", { name: "结束本次任务，允许重新生成" })).toBeDisabled();
  expect(actions).toHaveLength(0);
});
