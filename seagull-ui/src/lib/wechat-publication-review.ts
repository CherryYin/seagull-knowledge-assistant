import type { BrowserMetricField } from "./api/podcasts";

export const browserMetricFields: BrowserMetricField[] = ["read_num", "read_uv", "like_num", "old_like_num", "share_num", "share_uv", "comment_num", "collect_num", "favorite_num"];

export function wechatArticleIdentity(value: string): string {
  const url = new URL(value.replace(/&amp;/g, "&"));
  if (url.origin !== "https://mp.weixin.qq.com" || url.username || url.password) throw new Error("必须是 HTTPS 微信文章链接");
  if (/^\/s\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname)) return url.pathname;
  const account = url.searchParams.get("__biz");
  const message = url.searchParams.get("mid");
  const index = url.searchParams.get("idx");
  if (url.pathname === "/s" && /^[A-Za-z0-9+/=]{1,200}$/.test(account ?? "") && /^\d{1,30}$/.test(message ?? "") && /^[1-9]\d?$/.test(index ?? "")) return `${account}:${message}:${index}`;
  throw new Error("无法识别微信文章链接；短链和长链不会仅凭标题关联");
}

export function chinaDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export interface BrowserReviewObservation {
  title: string;
  capturedAt: string;
  metrics: Partial<Record<BrowserMetricField, number>>;
}

export function parseBrowserReviewReport(text: string, publicationUrl: string) {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error("报告不能超过 2 MB");
  const report = JSON.parse(text);
  if (report?.schema !== "seagull.wechat-browser-check.v1" || report.source !== "wechat_backend_browser" || report.verification !== "pending_manual_comparison") throw new Error("请选择本地单篇验证工具生成的待核对 JSON 报告");
  const target = wechatArticleIdentity(publicationUrl);
  if (typeof report.article_url !== "string" || wechatArticleIdentity(report.article_url) !== target) throw new Error("报告文章与当前发布记录不一致；不同形式的链接请先人工核实，不自动关联");
  if (typeof report.account_label !== "string" || !report.account_label.trim() || report.account_label.length > 80) throw new Error("报告缺少有效的账号备注");
  if (!Array.isArray(report.observations) || report.observations.length > 20) throw new Error("报告观察记录格式无效");
  const observations: BrowserReviewObservation[] = [];
  for (const observation of report.observations) {
    if (observation?.source !== "wechat_backend_browser" || !["/cgi-bin/appmsgpublish", "/misc/appmsganalysis"].includes(observation.source_endpoint)) throw new Error("报告含有不支持的观察来源");
    if (typeof observation.article_url !== "string" || wechatArticleIdentity(observation.article_url) !== target) throw new Error("报告含有其他文章的观察记录，未导入");
    if (typeof observation.observed_at !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observation.observed_at) || !Number.isFinite(Date.parse(observation.observed_at))) throw new Error("报告采集时间无效");
    const metrics: BrowserReviewObservation["metrics"] = {};
    for (const field of browserMetricFields) {
      const value: unknown = observation.metrics?.[field];
      if (value === null || value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("报告指标包含无效计数，未导入");
      metrics[field] = value;
    }
    if (Object.keys(metrics).length) observations.push({ title: typeof observation.title === "string" ? observation.title.slice(0, 200) : "未提供标题", capturedAt: observation.observed_at, metrics });
  }
  if (!observations.length) throw new Error("报告只有文章信息或未知指标，没有可用计数；请手动从后台录入，不能把未知当成零");
  return { accountLabel: report.account_label.trim(), observations };
}
