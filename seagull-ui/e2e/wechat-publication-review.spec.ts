import { expect, test } from "@playwright/test";
import { parseBrowserReviewReport, wechatArticleIdentity } from "../src/lib/wechat-publication-review";

const articleUrl = "https://mp.weixin.qq.com/s/published";

function report() {
  return { schema: "seagull.wechat-browser-check.v1", source: "wechat_backend_browser", verification: "pending_manual_comparison", account_label: "海鸥ai应用", article_url: articleUrl,
    observations: [{ source: "wechat_backend_browser", source_endpoint: "/cgi-bin/appmsgpublish", article_url: articleUrl, title: "已发布文章", observed_at: "2026-10-16T08:00:00Z", metrics: { read_num: 42, share_num: 0, like_num: null } }] };
}

test("publication review report preserves zero and unknown without guessing field meanings", () => {
  const parsed = parseBrowserReviewReport(JSON.stringify(report()), articleUrl);
  expect(parsed.observations).toHaveLength(1);
  expect(parsed.observations[0].metrics).toEqual({ read_num: 42, share_num: 0 });
  expect(parsed.accountLabel).toBe("海鸥ai应用");
});

test("publication review report cannot attach another article, an untrusted host or an unsupported source", () => {
  const original = report();
  expect(() => parseBrowserReviewReport(JSON.stringify(original), "https://mp.weixin.qq.com/s/other")).toThrow(/不一致/);
  expect(() => wechatArticleIdentity("https://user:private@mp.weixin.qq.com/s/published")).toThrow();
  expect(() => wechatArticleIdentity("https://mp.weixin.qq.com.evil.example/s/published")).toThrow();
  expect(() => parseBrowserReviewReport(JSON.stringify({ ...original, source: "official_api" }), articleUrl)).toThrow();
  const mixed = { ...original, observations: [...original.observations, { ...original.observations[0], article_url: "https://mp.weixin.qq.com/s/other" }] };
  expect(() => parseBrowserReviewReport(JSON.stringify(mixed), articleUrl)).toThrow(/其他文章/);
});

test("publication review report rejects metadata-only, approximate or unsafe counts", () => {
  for (const metrics of [{ read_num: null }, { read_num: "10万+" }, { read_num: -1 }, { read_num: true }, { read_num: Number.MAX_SAFE_INTEGER + 1 }]) {
    const original = report();
    expect(() => parseBrowserReviewReport(JSON.stringify({ ...original, observations: [{ ...original.observations[0], metrics }] }), articleUrl)).toThrow();
  }
  expect(() => parseBrowserReviewReport(" ".repeat(2 * 1024 * 1024 + 1), articleUrl)).toThrow(/2 MB/);
});

test("publication review report keeps observations separate and discards secrets and diagnostics", () => {
  const original = report();
  const parsed = parseBrowserReviewReport(JSON.stringify({ ...original, token: "private", request_diagnostics: [{ secret: "private" }], observations: [original.observations[0], { ...original.observations[0], metrics: { read_num: 50 }, cookie: "private" }] }), articleUrl);
  expect(parsed.observations.map(item => item.metrics.read_num)).toEqual([42, 50]);
  expect(JSON.stringify(parsed)).not.toMatch(/private|token|cookie|secret|diagnostics/);
});
