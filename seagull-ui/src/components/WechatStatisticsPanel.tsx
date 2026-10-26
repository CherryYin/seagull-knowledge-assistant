import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi, wechatStatisticsApi, type WechatArticleMetrics } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const metrics: Array<{ key: keyof Omit<WechatArticleMetrics, "stat_date">; label: string; format?: "rate" | "minutes" }> = [
  { key: "read_user", label: "阅读人数" }, { key: "share_user", label: "分享人数" },
  { key: "like_user", label: "拇指赞人数" }, { key: "zaikan_user", label: "爱心赞人数" },
  { key: "collection_user", label: "收藏人数" }, { key: "comment_count", label: "留言条数" },
  { key: "read_subscribe_user", label: "阅读后关注人数" },
  { key: "read_finish_rate", label: "阅读完成率", format: "rate" },
  { key: "read_delivery_rate", label: "阅读送达率", format: "rate" },
  { key: "read_avg_activetime", label: "平均阅读时长", format: "minutes" },
];

function yesterdayInChina() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() - 86400000));
}

function display(value: number | null | undefined, format?: "rate" | "minutes") {
  if (value === null || value === undefined) return "未知";
  if (format === "rate") return `${(value * 100).toFixed(2)}%`;
  if (format === "minutes") return `${value.toFixed(2)} 分钟`;
  return value.toLocaleString();
}

export function WechatStatisticsPanel() {
  const [params, setParams] = useSearchParams();
  const [credentialId, setCredentialId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const publicationDate = params.get("published_on") || yesterdayInChina();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(publicationDate) && Number.isFinite(Date.parse(publicationDate))
    && new Date(publicationDate).toISOString().slice(0, 10) === publicationDate
    && publicationDate >= "2025-11-01" && publicationDate <= yesterdayInChina();
  const credentials = useQuery({ queryKey: ["user-api-credentials"], queryFn: authApi.listMyApiCredentials, retry: false });
  const accounts = credentials.data?.items.filter(item => item.provider === "wechat_official_account" && item.is_enabled) ?? [];
  const selected = accounts.find(item => String(item.id) === credentialId);
  const queryKey = ["wechat-statistics", selected?.id, selected?.config?.app_id, publicationDate];
  const saved = useQuery({ queryKey, queryFn: () => wechatStatisticsApi.saved(selected!.id, publicationDate), enabled: Boolean(selected) && validDate, retry: false });
  const snapshot = saved.data?.snapshot;
  const synchronize = async () => {
    if (!selected || !validDate) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await wechatStatisticsApi.sync(selected.id, publicationDate);
      queryClient.setQueryData(queryKey, { snapshot: result });
      setMessage("已保存微信统计快照，未发布或修改公众号内容。");
    } catch (reason) { setError(`${String(reason)}。未自动重试；已有快照保留。`); }
    finally { setBusy(false); }
  };
  return <section aria-label="公众号数据" className="space-y-5">
    <div><h2 className="text-xl font-semibold">公众号数据</h2><p className="mt-2 text-sm text-muted-foreground">查看所选账号在某个发表日期发布的全部文章，不限于播客或 Seagull 创建的内容。只有点击同步才访问微信；打开页面只读取已保存快照。</p></div>
    <div className="rounded border p-4 text-sm leading-6">使用微信新版内容详细统计。日期是<strong>文章发表日期</strong>，不是单日流量日期；每个统计日期的指标是发表日至该日的累计值，不能逐日相加。接口只提供 2025-11-01 起发表内容的数据，每篇覆盖发表日起最多 30 天，最晚查询到昨日（北京时间）。</div>
    <p className="text-sm text-muted-foreground">这里只展示接口实际返回的阅读、分享等指标；缺失项显示“未知”，不补零。不提供文章展现／点击率或音频播放量，阅读完成率也不是播客收听完播率。</p>
    <div className="space-y-2 rounded border p-4">
      <h3 className="font-medium">个人订阅号：先完成发布效果复盘</h3>
      <p className="text-sm">无需官方统计接口权限。进入已发布播客的“发布记录与使用复盘”，编辑对应记录，手动填写后台指标，或读取本地浏览器报告后人工核对。效果快照绑定文章与音频版本，不混入下方官方接口快照。</p>
      <Link className="text-sm text-primary underline" to="/assets?type=podcast">打开播客，补录发布效果</Link>
    </div>
    <details className="space-y-3 rounded border p-4">
      <summary className="cursor-pointer font-medium">个人订阅号：本地浏览器单篇验证（实验）</summary>
      <p className="text-sm">官方接口提示没有权限时，可先在自己的电脑运行单篇验证工具，无需 AppSecret。它不是上方同步按钮的自动替代，不会写入正式统计快照。</p>
      <p className="text-sm">在仓库根目录的本地终端运行：</p>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">npm --prefix seagull-ui run wechat:check</pre>
      <ol className="list-inside list-decimal space-y-1 text-sm">
        <li>输入自己的文章链接和账号备注，在新打开的临时浏览器扫码登录公众号后台。</li>
        <li>手动打开目标文章的已发表列表或数据页；工具只监听自然响应，不自动点击或发布。</li>
        <li>在终端输入“查看”，核对字段、人数或次数、统计区间；全为未知时输入“诊断”，仅查看字段名和类型，不是统计获取成功。输入“保存”并确认，仅生成本地待核对报告。</li>
      </ol>
      <p className="text-xs text-muted-foreground">需要可用的图形桌面和 Playwright Chromium。远程服务器运行不会在你的电脑弹窗，请在有图形桌面的本机运行。登录态仍有账号权限，请勿在该窗口发布、删除或修改；工具不导出登录态、Cookie 或完整响应。字段缺失不补零；文章指标不是播客播放量。页面结构变化或短链与长链不同可能无法匹配。</p>
    </details>
    {credentials.isPending && <p role="status">正在加载公众号账号…</p>}
    {credentials.isError && <p role="alert">账号列表加载失败。<Button variant="outline" onClick={() => void credentials.refetch()}>重试账号列表</Button></p>}
    {credentials.data && accounts.length === 0 && <p>使用官方 API 同步前，请先到 <Link className="text-primary underline" to="/api-keys">Settings → API Keys</Link> 添加微信公众号 AppID 和 AppSecret，并在公众号后台配置服务器公网出口 IP 白名单。本地浏览器单篇验证无需这些凭据。</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1">公众号账号<select aria-label="公众号账号" className="block rounded border bg-background p-2" value={credentialId} disabled={busy || credentials.isPending || credentials.isError} onChange={event => { setCredentialId(event.target.value); setError(""); setMessage(""); }}><option value="">请选择自己的公众号</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="space-y-1">文章发表日期<Input type="date" min="2025-11-01" max={yesterdayInChina()} value={publicationDate} disabled={busy} onChange={event => { const next = new URLSearchParams(params); next.set("published_on", event.target.value); setParams(next, { replace: true }); setError(""); setMessage(""); }} /></label>
      <Button disabled={!selected || !validDate || busy} onClick={() => void synchronize()}>{busy ? "正在从微信同步…" : "从微信同步并保存快照"}</Button>
    </div>
    {!validDate && <p role="alert">请选择 2025-11-01 至昨日之间的真实发表日期。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {selected && validDate && saved.isPending && <p role="status">正在读取已保存快照…</p>}
    {selected && validDate && saved.isError && <p role="alert">历史统计加载失败，不代表阅读量为零：{saved.error.message}<Button variant="outline" onClick={() => void saved.refetch()}>重试历史快照</Button></p>}
    {selected && validDate && saved.data && !snapshot && <p>该账号、该发表日期尚无保存快照，不能据此判断没有文章或阅读量为零。请点击同步。</p>}
    {snapshot && <div className="space-y-4">
      <p className="text-sm text-muted-foreground">快照采集于 {new Date(snapshot.fetched_at).toLocaleString()} · 发表日期 {snapshot.publication_date} · {snapshot.data.list.length} 篇文章。展示最近保存快照，不是实时数据。</p>
      <p className="text-sm">微信数据延迟状态：{snapshot.data.is_delay === true ? "存在延迟，数据可能不完整" : snapshot.data.is_delay === false ? "微信报告无延迟，仍以标示的统计日期为准" : "未知，接口未报告"}</p>
      {snapshot.data.list.length === 0 && <p>微信本次未返回该发表日期的文章。请核对账号、日期和数据延迟情况；这不是“阅读量为零”。</p>}
      {snapshot.data.list.map(article => {
        const latest = article.detail_list[article.detail_list.length - 1];
        return <article key={article.msgid} className="space-y-3 rounded border p-4">
          <h3 className="font-semibold">{article.title || "微信未返回文章标题"}</h3>
          <p className="text-xs text-muted-foreground">文章标识 {article.msgid} · 发表日期 {article.ref_date} · 统计截止 {latest?.stat_date ?? "未知"}</p>
          {article.content_url && <a href={article.content_url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">打开公众号文章</a>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{metrics.map(metric => <div key={metric.key} className="rounded bg-muted p-3"><p className="text-xs text-muted-foreground">{metric.label}</p><p className="mt-1 font-semibold">{display(latest?.[metric.key], metric.format)}</p></div>)}</div>
          {article.detail_list.length > 0 && <details><summary className="cursor-pointer text-sm">查看按统计日期的累计数据（不可相加）</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">统计截止</th><th className="p-2 text-left">累计阅读人数</th><th className="p-2 text-left">累计分享人数</th><th className="p-2 text-left">阅读完成率</th></tr></thead><tbody>{article.detail_list.map(detail => <tr key={detail.stat_date}><td className="p-2">{detail.stat_date}</td><td className="p-2">{display(detail.read_user)}</td><td className="p-2">{display(detail.share_user)}</td><td className="p-2">{display(detail.read_finish_rate, "rate")}</td></tr>)}</tbody></table></div></details>}
        </article>;
      })}
    </div>}
  </section>;
}
