import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { assetsApi, type AssetFeatureCounts, type AssetFeatureIssue, type AssetType } from "@/lib/api/assets";
import { assetTypeLabel } from "@/lib/asset-generation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const FEATURE_TABS: Record<string, string> = {
  intent: "intent", evidence: "evidence", claims: "claims", draft: "edit", blocks: "edit",
  optimization: "edit", quality: "edit", outline: "map", visuals: "production", export: "production",
  wechat: "production", knowledge: "knowledge",
};
const ASSET_TYPES: AssetType[] = ["blog_post", "research_brief", "knowledge_pack", "newsletter_issue", "topic_report"];
const STATUSES = ["draft", "in_review", "ready_to_export", "exported", "published", "archived"];
const ISSUE_PAGE_SIZE = 30;

function issueUrl(issue: AssetFeatureIssue) {
  const query = new URLSearchParams({ tab: FEATURE_TABS[issue.feature] ?? "read" });
  if (issue.block_ids[0]) query.set("block", issue.block_ids[0]);
  return `/assets/${encodeURIComponent(issue.asset_id)}?${query}`;
}

export function AssetFunctionalOverview() {
  const [assetType, setAssetType] = useState("");
  const [status, setStatus] = useState("");
  const [feature, setFeature] = useState("");
  const [page, setPage] = useState(0);
  const analyticsQuery = useQuery({
    queryKey: ["asset-functional-analytics", assetType, status, feature, page],
    queryFn: () => assetsApi.analytics({ asset_type: assetType, status, feature, offset: page * ISSUE_PAGE_SIZE, limit: ISSUE_PAGE_SIZE }),
  });
  const data = analyticsQuery.data;
  const selectedFeature = data?.features.find(item => item.feature === feature);
  const reasons = (feature ? selectedFeature ? [selectedFeature] : [] : data?.features ?? [])
    .flatMap(item => Object.entries(item.reasons).map(([reason, count]) => ({ feature: item.feature, label: item.label, reason, count })))
    .sort((left, right) => right.count - left.count);

  return <section className="space-y-6" aria-label="All Asset functional overview">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
      <label className="text-sm">Global Asset type<select className="mt-1 block h-10 rounded-md border bg-background px-3" value={assetType} onChange={event => { setAssetType(event.target.value); setPage(0); }}><option value="">All Asset types</option>{ASSET_TYPES.map(value => <option key={value} value={value}>{assetTypeLabel(value)}</option>)}</select></label>
      <label className="text-sm">Global Asset status<select className="mt-1 block h-10 rounded-md border bg-background px-3" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">All statuses (including archived)</option>{STATUSES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <Button className="ml-auto" variant="outline" disabled={analyticsQuery.isFetching} onClick={() => void analyticsQuery.refetch()}><RefreshCw className="h-4 w-4" />{analyticsQuery.isFetching ? "Refreshing…" : "Refresh all Assets"}</Button>
    </div>

    {analyticsQuery.isLoading && <p role="status" className="rounded-xl border p-8 text-center">Loading all Asset feature states…</p>}
    {analyticsQuery.isError && <div role="alert" className="rounded-xl border border-destructive/30 p-6 text-destructive"><p>Could not load global Asset statistics. Counts are unavailable, not zero. If the API was updated, restart PKG and retry.</p><Button className="mt-3" variant="outline" onClick={() => void analyticsQuery.refetch()}>Retry global statistics</Button></div>}
    {data && !analyticsQuery.isError && <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <OverviewNumber title="All matching Assets" value={data.total_assets} detail="Every owned Asset, with or without a review note" testId="global-asset-total" />
        <OverviewNumber title="Assets with attention signals" value={data.assets_with_attention} detail="Unique Assets with prerequisites, review findings, or recorded failures" testId="global-asset-attention" />
        <OverviewNumber title="Tracked functional areas" value={data.features.length} detail="Intent, Evidence, Claims, draft, blocks, optimization, quality, maps, images, delivery and knowledge" testId="global-feature-count" />
        <OverviewNumber title="Without a saved workspace" value={data.assets_without_workspace} detail="Legacy / automatic Assets: missing workflow data stays unknown" testId="global-workspace-unknown" />
      </div>
      <div className="flex flex-wrap gap-2 text-sm">{Object.entries(data.by_status).map(([key, count]) => <Badge key={key} variant="outline">{key}: {count}</Badge>)}</div>
      <p className="text-sm text-muted-foreground">This is a complete persisted-state overview of the filtered Assets, not just retrospective samples. Blocked means a prerequisite or validation issue, not a confirmed user stop. Optional features that were not used are shown as not started, never automatically as failures.</p>

      <Card><CardHeader><CardTitle>Global feature bottlenecks</CardTitle><CardDescription>Each row covers all {data.total_assets} matching Assets. Saved, blocked, awaiting review, running, not started, failed and unknown are separate states. Select a feature to inspect its causes and affected Assets.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2 pr-4">Feature</th><th className="pr-3">Saved</th><th className="pr-3">Blocked</th><th className="pr-3">Review</th><th className="pr-3">Running</th><th className="pr-3">Not started</th><th className="pr-3">Failed</th><th className="pr-3">Unknown</th><th>Assets with failure records</th></tr></thead><tbody>{data.features.map(item => <FeatureRow key={item.feature} item={item} selected={feature === item.feature} onSelect={() => { setFeature(feature === item.feature ? "" : item.feature); setPage(0); }} />)}</tbody></table></div></CardContent></Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Measured image task signals</CardTitle><CardDescription>All retained image tasks belonging to matching Assets, not only the selected feature. Failed candidates can coexist with an accepted image.</CardDescription></CardHeader><CardContent className="grid grid-cols-2 gap-4 text-sm"><MetricValue label="Total image tasks" value={data.visual_metrics.total_tasks} /><MetricValue label="Failed tasks" value={data.visual_metrics.failed_tasks} /><MetricValue label="Active tasks" value={data.visual_metrics.active_tasks} /><MetricValue label="Recorded retry attempts" value={data.visual_metrics.retry_attempts} /><MetricValue label="Mean elapsed (seconds)" value={data.visual_metrics.mean_elapsed_seconds === null ? "Unknown" : data.visual_metrics.mean_elapsed_seconds.toFixed(1)} /><MetricValue label="Timed task samples" value={data.visual_metrics.timed_tasks} /><p className="col-span-2 text-xs text-muted-foreground">Elapsed includes queueing and retry delays. Image attempts are not document optimization retries or Harness retries. Other stage waits and model Token usage remain unrecorded.</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Most common persisted causes</CardTitle><CardDescription>Top 10 causes {selectedFeature ? `for ${selectedFeature.label}` : "across functional areas"}. Counts are affected Assets per feature and reason, not inferred user complaints.</CardDescription></CardHeader><CardContent>{reasons.length ? <ul className="space-y-3">{reasons.slice(0, 10).map(item => <li key={`${item.feature}:${item.reason}`} className="flex items-start justify-between gap-3 text-sm"><div className="min-w-0 break-words"><p>{item.reason}</p><p className="text-xs text-muted-foreground">{item.label}</p></div><Badge variant="secondary">{item.count}</Badge></li>)}</ul> : <p className="text-sm text-muted-foreground">No persisted attention causes in this selection.</p>}</CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle>Affected Assets and content blocks</CardTitle><CardDescription>All matching issue records are paginated below. Open the exact functional area or affected content Block; the counters above are never limited to this page.</CardDescription></CardHeader><CardContent><label className="text-sm">Inspect functional area<select className="mb-4 mt-1 block h-10 rounded-md border bg-background px-3" value={feature} onChange={event => { setFeature(event.target.value); setPage(0); }}><option value="">All functional areas</option>{data.features.map(item => <option key={item.feature} value={item.feature}>{item.label}</option>)}</select></label><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2 pr-4">Asset</th><th className="pr-4">Feature</th><th className="pr-4">State</th><th>Cause / Block</th></tr></thead><tbody>{data.issues.map((issue, index) => <tr key={`${issue.asset_id}:${issue.feature}:${index}`} className="border-b align-top"><td className="py-3 pr-4"><Link className="text-primary hover:underline" to={issueUrl(issue)}>{issue.title}</Link><p className="text-xs text-muted-foreground">{assetTypeLabel(issue.asset_type)} · {issue.asset_status}</p></td><td className="py-3 pr-4">{data.features.find(item => item.feature === issue.feature)?.label ?? issue.feature}</td><td className="py-3 pr-4">{issue.state}</td><td className="py-3">{issue.reason}{issue.block_ids.length > 0 && <p className="text-xs text-muted-foreground">Blocks: {issue.block_ids.join(", ")}</p>}</td></tr>)}</tbody></table>{data.issue_total === 0 && <p className="py-5 text-muted-foreground">No persisted attention signals for this selection. This does not establish that unrecorded requests never failed.</p>}</div><div className="mt-4 flex items-center justify-between gap-3"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous affected Assets</Button><span className="text-sm text-muted-foreground">{data.issue_total} issue records · page {page + 1} of {Math.max(1, Math.ceil(data.issue_total / ISSUE_PAGE_SIZE))}</span><Button variant="outline" disabled={(page + 1) * ISSUE_PAGE_SIZE >= data.issue_total} onClick={() => setPage(page + 1)}>Next affected Assets</Button></div></CardContent></Card>
      <details className="rounded-xl border p-4 text-sm text-muted-foreground"><summary className="cursor-pointer font-medium">Coverage and measurement limits</summary><ul className="mt-3 list-disc space-y-2 pl-5">{data.measurement_limits.map(item => <li key={item}>{item}</li>)}</ul></details>
    </>}
  </section>;
}

function FeatureRow({ item, selected, onSelect }: { item: AssetFeatureCounts; selected: boolean; onSelect: () => void }) {
  return <tr className={`border-b ${selected ? "bg-primary/5" : ""}`} data-testid={`global-feature-${item.feature}`}><td className="py-3 pr-4"><button type="button" className="text-left text-primary hover:underline" aria-pressed={selected} onClick={onSelect}>{item.label}</button>{item.optional && <span className="ml-2 text-xs text-muted-foreground">optional</span>}</td><td className="pr-3">{item.completed}</td><td className="pr-3">{item.blocked}</td><td className="pr-3">{item.needs_review}</td><td className="pr-3">{item.in_progress}</td><td className="pr-3">{item.not_started}</td><td className="pr-3">{item.recorded_failure_assets === null ? "—" : item.failed}</td><td className="pr-3">{item.unknown}</td><td>{item.recorded_failure_assets ?? "—"}</td></tr>;
}

function OverviewNumber({ title, value, detail, testId }: { title: string; value: number; detail: string; testId: string }) {
  return <Card><CardHeader><CardTitle className="text-sm font-medium">{title}</CardTitle></CardHeader><CardContent><p data-testid={testId} className="text-3xl font-semibold">{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}

function MetricValue({ label, value }: { label: string; value: number | string }) {
  return <div><p className="text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>;
}
