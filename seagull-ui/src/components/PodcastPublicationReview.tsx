import { useState } from "react";
import type { BrowserMetricField, PublicationMetricName, PublicationStatisticsSnapshot } from "@/lib/api";
import { browserMetricFields, chinaDate, parseBrowserReviewReport, type BrowserReviewObservation } from "@/lib/wechat-publication-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const metricLabels: Record<PublicationMetricName, string> = { read: "阅读", like: "点赞", look: "在看", share: "分享", comment: "评论", collect: "收藏" };
const metricNames = Object.keys(metricLabels) as PublicationMetricName[];
type MetricInput = { value: string; unit: "" | "people" | "times"; sourceField: "" | BrowserMetricField };

function blankMetrics() {
  return Object.fromEntries(metricNames.map(name => [name, { value: "", unit: "", sourceField: "" }])) as Record<PublicationMetricName, MetricInput>;
}

function localTime(value = new Date().toISOString()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function PodcastPublicationReview({ publicationUrl, publishedAt, snapshots, disabled, onAppend }: {
  publicationUrl: string; publishedAt: string; snapshots: PublicationStatisticsSnapshot[]; disabled: boolean;
  onAppend: (snapshot: PublicationStatisticsSnapshot) => Promise<boolean>;
}) {
  const [snapshotId, setSnapshotId] = useState(() => crypto.randomUUID());
  const [source, setSource] = useState<PublicationStatisticsSnapshot["source"]>("manual_backend");
  const [accountLabel, setAccountLabel] = useState("");
  const [kind, setKind] = useState<PublicationStatisticsSnapshot["period_kind"]>("cumulative");
  const [periodStart, setPeriodStart] = useState(chinaDate(publishedAt));
  const [periodEnd, setPeriodEnd] = useState("");
  const [capturedAt, setCapturedAt] = useState(() => localTime());
  const [metrics, setMetrics] = useState(blankMetrics);
  const [observations, setObservations] = useState<BrowserReviewObservation[]>([]);
  const [selectedObservation, setSelectedObservation] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [loadingReport, setLoadingReport] = useState(false);
  const observation = selectedObservation === "" ? undefined : observations[Number(selectedObservation)];
  const start = kind === "cumulative" ? chinaDate(publishedAt) : periodStart;
  const atLimit = snapshots.length >= 30;
  const updateMetric = (name: PublicationMetricName, update: Partial<MetricInput>) => {
    setMetrics(previous => ({ ...previous, [name]: { ...previous[name], ...update } }));
    setConfirmed(false);
  };
  const readReport = async (file?: File) => {
    setError(""); setConfirmed(false); setSelectedObservation(""); setObservations([]); setMetrics(blankMetrics());
    if (!file) return;
    setLoadingReport(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("报告不能超过 2 MB");
      const report = parseBrowserReviewReport(await file.text(), publicationUrl);
      setObservations(report.observations); setAccountLabel(report.accountLabel);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "报告解析失败"); }
    finally { setLoadingReport(false); }
  };
  const append = async () => {
    setError("");
    try {
      if (!confirmed) throw new Error("请先核对账号、文章、统计区间和指标单位");
      if (!accountLabel.trim()) throw new Error("请填写公众号备注");
      const timestamp = source === "browser_report" ? observation?.capturedAt : capturedAt ? new Date(capturedAt).toISOString() : null;
      if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new Error("请选择有效采集时间；报告模式需先选择一条观察记录");
      if (Date.parse(timestamp) > Date.now()) throw new Error("采集时间不能在未来");
      if (!periodEnd || start > periodEnd || periodEnd > chinaDate(timestamp) || start < chinaDate(publishedAt)) throw new Error("请核对统计起止日期，不能早于发布日或晚于采集日");
      const values: PublicationStatisticsSnapshot["metrics"] = {};
      const usedFields = new Set<string>();
      for (const name of metricNames) {
        const field = metrics[name];
        const value = source === "browser_report" ? field.sourceField ? observation?.metrics[field.sourceField] : undefined : field.value === "" ? undefined : Number(field.value);
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0 || !field.unit || (source === "manual_backend" && !/^\d+$/.test(field.value))) throw new Error(`${metricLabels[name]}需填写非负整数，并明确选择人数或次数`);
        if (source === "browser_report" && usedFields.has(field.sourceField)) throw new Error("同一个报告字段不能重复映射到不同指标");
        if (field.sourceField) usedFields.add(field.sourceField);
        values[name] = { value, unit: field.unit, source_field: source === "browser_report" ? field.sourceField as BrowserMetricField : null };
      }
      if (!Object.keys(values).length) throw new Error("至少填写或映射一项已知指标，空白保持未知，不补零");
      const saved = await onAppend({ id: snapshotId, source, account_label: accountLabel.trim(), period_kind: kind, period_start: start, period_end: periodEnd, captured_at: timestamp, metrics: values, notes, user_confirmed: true });
      if (saved) { setSnapshotId(crypto.randomUUID()); setMetrics(blankMetrics()); setConfirmed(false); setNotes(""); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "效果快照未保存"); }
  };
  return <section className="space-y-4 rounded border p-4" aria-label="公众号发布效果" data-testid="podcast-publication-review">
    <h3 className="font-semibold">公众号发布效果</h3>
    <p className="text-sm text-muted-foreground">个人号可从后台手工补录，或在本机读取 JSON 报告并逐项核对。报告不会整体上传，登录态和诊断原文不上传；保存的是选定指标。文章阅读不是音频播放量，空白保持未知。</p>
    {snapshots.length === 0 && <p className="text-sm">尚未记录发布效果，不代表阅读量为零。</p>}
    <PublicationSnapshotHistory snapshots={snapshots} />
    {snapshots.length > 1 && <p className="text-xs text-muted-foreground">不同快照不相加；累计与区间数据、人数与次数也不能混算。更正请追加快照并写明原因。</p>}
    {loadingReport && <p role="status" className="text-sm">正在本地核对报告格式，尚未上传或保存…</p>}
    <fieldset disabled={disabled || atLimit || loadingReport} className="space-y-3">
      <legend className="mb-2 font-medium">追加效果快照</legend>
      <label className="block space-y-1">数据来源<select aria-label="效果数据来源" className="block rounded border bg-background p-2" value={source} onChange={event => { setSource(event.target.value as typeof source); setMetrics(blankMetrics()); setConfirmed(false); setError(""); }}><option value="manual_backend">后台手工录入</option><option value="browser_report">本地浏览器报告（先核对再保存）</option></select></label>
      {source === "browser_report" && <div className="space-y-2">
        <label className="block">选择本地 JSON 报告<Input aria-label="选择本地 JSON 报告" type="file" accept=".json,application/json" onChange={event => void readReport(event.target.files?.[0])} /></label>
        <p className="text-xs text-muted-foreground">只接受当前文章的单篇验证报告；请明确选择一条观察记录，再手动映射指标及单位，不自动猜“赞／在看”。</p>
        {observations.length > 0 && <label className="block">选择观察记录<select aria-label="选择观察记录" className="block max-w-full rounded border bg-background p-2" value={selectedObservation} onChange={event => { setSelectedObservation(event.target.value); setMetrics(blankMetrics()); setConfirmed(false); }}><option value="">请选择，不能合并或相加</option>{observations.map((item, index) => <option key={index} value={index}>{index + 1} · {new Date(item.capturedAt).toLocaleString()} · {item.title}</option>)}</select></label>}
      </div>}
      <div className="grid gap-3 md:grid-cols-2">
        <label>公众号备注<Input aria-label="效果公众号备注" value={accountLabel} maxLength={80} onChange={event => { setAccountLabel(event.target.value); setConfirmed(false); }} /></label>
        <label>统计口径<select aria-label="效果统计口径" className="block rounded border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setConfirmed(false); }}><option value="cumulative">自发布日起累计</option><option value="range">指定区间</option></select></label>
        <label>统计起日<Input aria-label="效果统计起日" type="date" value={start} disabled={kind === "cumulative"} onChange={event => { setPeriodStart(event.target.value); setConfirmed(false); }} /></label>
        <label>统计截止日<Input aria-label="效果统计截止日" type="date" value={periodEnd} onChange={event => { setPeriodEnd(event.target.value); setConfirmed(false); }} /></label>
        <label>采集时间<Input aria-label="效果采集时间" type="datetime-local" value={source === "browser_report" ? observation ? localTime(observation.capturedAt) : "" : capturedAt} disabled={source === "browser_report"} onChange={event => { setCapturedAt(event.target.value); setConfirmed(false); }} /></label>
      </div>
      <div className="space-y-2">{metricNames.map(name => <div key={name} className="flex flex-wrap items-center gap-2">
        <span className="w-12 text-sm">{metricLabels[name]}</span>
        {source === "manual_backend" ? <Input className="w-36" aria-label={`效果${metricLabels[name]}数值`} type="text" inputMode="numeric" placeholder="未知请留空" value={metrics[name].value} onChange={event => updateMetric(name, { value: event.target.value })} /> : <select aria-label={`效果${metricLabels[name]}原始字段`} className="max-w-full rounded border bg-background p-2 text-sm" value={metrics[name].sourceField} onChange={event => updateMetric(name, { sourceField: event.target.value as BrowserMetricField | "" })}><option value="">未映射／未知</option>{browserMetricFields.filter(field => observation?.metrics[field] !== undefined).map(field => <option key={field} value={field}>{field}：{observation?.metrics[field]}</option>)}</select>}
        <select aria-label={`效果${metricLabels[name]}单位`} className="rounded border bg-background p-2 text-sm" value={metrics[name].unit} onChange={event => updateMetric(name, { unit: event.target.value as MetricInput["unit"] })}><option value="">请选择单位</option><option value="people">人数（人）</option><option value="times">次数（次）</option></select>
      </div>)}</div>
      <label className="block">复盘／更正说明<Textarea aria-label="效果复盘说明" maxLength={2000} value={notes} placeholder="例如：阅读不错但互动少，下期缩短开头；更正前次统计口径" onChange={event => { setNotes(event.target.value); setConfirmed(false); }} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对账号、文章、统计区间和指标单位；这不是音频播放量。</label>
      <Button disabled={!confirmed} onClick={() => void append()}>保存效果快照</Button>
    </fieldset>
    {atLimit && <p className="text-sm">每条发布记录最多保存 30 份效果快照。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

export function PublicationSnapshotHistory({ snapshots }: { snapshots: PublicationStatisticsSnapshot[] }) {
  return <div className="space-y-2">{snapshots.map(snapshot => <article key={snapshot.id} className="space-y-2 rounded bg-muted p-3 text-sm">
    <p className="font-medium">{snapshot.account_label} · {snapshot.source === "manual_backend" ? "后台手工录入" : "浏览器报告（人工核对，非官方接口验证）"}</p>
    <p>{snapshot.period_kind === "cumulative" ? "累计" : "区间"}统计：{snapshot.period_start} 至 {snapshot.period_end}（北京时间） · 采集于 {new Date(snapshot.captured_at).toLocaleString()}</p>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{metricNames.map(name => {
      const metric = snapshot.metrics[name];
      return <p key={name}>{metricLabels[name]}：{metric ? `${metric.value} ${metric.unit === "people" ? "人" : "次"}` : "未知"}{metric?.source_field && <span className="text-xs text-muted-foreground"> · {metric.source_field}</span>}</p>;
    })}</div>
    {snapshot.notes && <p className="whitespace-pre-wrap">复盘／更正说明：{snapshot.notes}</p>}
  </article>)}</div>;
}
