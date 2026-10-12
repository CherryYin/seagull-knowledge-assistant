import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { notesApi } from "@/lib/api/notes";
import { ADOPTION_STATUSES, JOURNEY_STEPS, loadAssetJourneyReviewNotes, parseJourneyReviewNote, selectJourneyReviews, summarizeJourneyReviews } from "@/lib/asset-journey-stats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AssetFunctionalOverview } from "@/components/AssetFunctionalOverview";

const STEP_LABELS = {
  intent: "Intent", evidence: "Evidence", claims: "Claims", draft: "Draft",
  optimization: "Optimization", visuals: "Visuals", delivery: "Delivery", knowledge_promotion: "Knowledge promotion",
};
const ADOPTION_LABELS = {
  yes: "Adopted", partial: "Partially adopted", no: "Not adopted",
  in_progress: "In progress", undecided: "Not decided", unknown: "Unknown",
};
const SOURCE_LABELS = {
  system_record: "System record", user_report: "User report", user_estimate: "User estimate", unknown: "Unknown",
};
const METRIC_LABELS = {
  wait_seconds: "Wait", visual_elapsed_seconds: "Visual elapsed (queue + retries)", retry_count: "Retries",
  processing_attempts: "Processing attempts", input_tokens: "Input tokens", output_tokens: "Output tokens", total_tokens: "Total tokens",
};
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const RECORDS_PER_PAGE = 20;

export function AssetStatisticsPanel() {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"latest" | "all">("latest");
  const [page, setPage] = useState(0);
  const [showReviews, setShowReviews] = useState(false);
  const reviewsQuery = useQuery({
    queryKey: ["asset-journey-reviews"],
    queryFn: () => loadAssetJourneyReviewNotes(params => notesApi.list(params)),
    enabled: showReviews,
  });
  const records = useMemo(() => (reviewsQuery.data?.notes ?? []).map(parseJourneyReviewNote), [reviewsQuery.data]);
  const selected = useMemo(() => selectJourneyReviews(records, { search, from, to, mode }), [records, search, from, to, mode]);
  const summary = useMemo(() => summarizeJourneyReviews(selected), [selected]);
  const invalidRange = Boolean(from && to && from > to);
  const pageCount = Math.ceil(selected.length / RECORDS_PER_PAGE);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = selected.slice(currentPage * RECORDS_PER_PAGE, (currentPage + 1) * RECORDS_PER_PAGE);

  return (
      <section className="space-y-6" aria-label="Asset diagnostics">
        <div>
          <h2 className="text-xl font-semibold">Asset Function Statistics</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Every owned Asset, across all functional areas. Diagnose saved-state blockers and pending decisions; user-reported journey reviews provide optional evidence about recovery and adoption.</p>
        </div>

        <AssetFunctionalOverview />

        <details className="rounded-xl border p-4" onToggle={event => setShowReviews(event.currentTarget.open)}>
          <summary className="cursor-pointer font-semibold">User-reported journey reviews (supplementary)</summary>
          <div className="mt-4 space-y-6">
          <Button variant="outline" onClick={() => void reviewsQuery.refetch()} disabled={reviewsQuery.isFetching}><RefreshCw className="h-4 w-4" />{reviewsQuery.isFetching ? "Refreshing…" : "Refresh reviews"}</Button>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
          <label className="min-w-60 flex-1 text-sm">Search reviews<div className="relative mt-1"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Title, Asset ID, reason, or recovery" /></div></label>
          <label className="text-sm">From (UTC)<Input className="mt-1" type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(0); }} /></label>
          <label className="text-sm">To (UTC)<Input className="mt-1" type="date" value={to} onChange={event => { setTo(event.target.value); setPage(0); }} /></label>
          <label className="text-sm">Sample mode<select className="mt-1 block h-10 rounded-md border bg-background px-3" value={mode} onChange={event => { setMode(event.target.value as "latest" | "all"); setPage(0); }}><option value="latest">Latest valid review per Asset</option><option value="all">All saved reviews</option></select></label>
        </div>

        {reviewsQuery.isLoading && <p role="status" className="rounded-xl border p-8 text-center text-muted-foreground">Loading saved reviews…</p>}
        {reviewsQuery.isError && <div role="alert" className="rounded-xl border border-destructive/30 p-6 text-destructive"><p>Could not load review records. Statistics are unavailable; no missing records are counted as zero.</p><Button className="mt-3" variant="outline" onClick={() => void reviewsQuery.refetch()}>Retry loading reviews</Button></div>}
        {invalidRange && <p role="alert" className="text-destructive">The start date must not be later than the end date.</p>}

        {!reviewsQuery.isLoading && !reviewsQuery.isError && !invalidRange && reviewsQuery.data && <>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{reviewsQuery.data.notes.length} of {reviewsQuery.data.total} saved review notes loaded · {selected.length} selected records · {summary.excluded} unstructured or invalid records excluded from statistics.</p>
            <p>Dates use note creation time in UTC. {mode === "latest" ? "Only the latest valid review per linked Asset within these filters contributes; unlinked reviews remain separate samples." : "Every valid saved review contributes; repeated reviews of an Asset count separately."} Unknown is never treated as no, zero, or adoption.</p>
            {reviewsQuery.data.truncated && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800">Only part of the saved notes was loaded (up to 2,000 per refresh). These statistics describe the loaded sample, not all reviews. Loading limits or changing records may leave gaps.</p>}
          </div>

          {records.length === 0 ? <Card><CardHeader><CardTitle>No saved journey reviews yet</CardTitle><CardDescription>Open an Asset, click Review Journey, complete the interview, and explicitly save the final report as a Review Note.</CardDescription></CardHeader><CardContent><Link to="/assets" className="text-primary hover:underline">Open Asset Library</Link></CardContent></Card> : <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard title="Structured reviews" value={String(summary.reviews)} detail={`${summary.assets} linked Assets in the selected sample`} testId="journey-reviewed" />
              <SummaryCard title="Reviews with stops" value={String(summary.blocked)} detail={`${summary.stopKnown} of ${summary.reviews} have known stop status`} testId="journey-blocked" />
              <SummaryCard title="Manual recovery" value={String(summary.recovered)} detail={`${summary.recoveryKnown} of ${summary.reviews} have known recovery status`} testId="journey-recovered" />
              <SummaryCard title="Full adoption rate" value={summary.adoptionRate === null ? "—" : `${numberFormat.format(summary.adoptionRate * 100)}%`} detail={`${summary.adoption.yes} fully adopted / ${summary.decided} decided (yes, partial, no)`} testId="journey-adoption-rate" />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card><CardHeader><CardTitle>Stops and recovery by step</CardTitle><CardDescription>Each review counts at most once per step. A confirmed absence and unknown feedback are different.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">Step</th><th>Stopped reviews</th><th>Recovery reviews</th></tr></thead><tbody>{JOURNEY_STEPS.map(step => <tr key={step} className="border-b"><td className="py-3">{STEP_LABELS[step]}</td><td>{summary.stops[step]}</td><td>{summary.recoveries[step]}</td></tr>)}</tbody></table></div></CardContent></Card>
              <Card><CardHeader><CardTitle>Adoption outcomes</CardTitle><CardDescription>Export or publication does not prove adoption. In-progress, undecided, and unknown reviews are excluded from the rate denominator.</CardDescription></CardHeader><CardContent className="space-y-3">{ADOPTION_STATUSES.map(status => <div key={status} className="space-y-1"><div className="flex justify-between text-sm"><span>{ADOPTION_LABELS[status]}</span><span>{summary.adoption[status]}</span></div><div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${summary.reviews ? summary.adoption[status] / summary.reviews * 100 : 0}%` }} /></div></div>)}</CardContent></Card>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card><CardHeader><CardTitle>Reported stop reasons</CardTitle><CardDescription>Exact recorded wording, counted once per review. No inferred root-cause classification.</CardDescription></CardHeader><CardContent><ReasonList reasons={summary.reasons} empty="No confirmed stop reasons in this sample." /></CardContent></Card>
              <Card><CardHeader><CardTitle>Partial and non-adoption reasons</CardTitle><CardDescription>User-reported reasons from partially adopted or unadopted outputs. Missing explanations are not inferred.</CardDescription></CardHeader><CardContent><ReasonList reasons={summary.adoptionReasons} empty="No recorded partial or non-adoption reasons in this sample." /></CardContent></Card>
            </div>

            <Card><CardHeader><CardTitle>Timing, retries and model usage</CardTitle><CardDescription>Averages are separated by exact scope, metric, unit, and source. Estimates are never mixed with measured records. {summary.unknownMetrics} explicitly unknown metric entries are excluded; omitted metrics also do not count as zero.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">Scope</th><th>Metric</th><th>Source</th><th>Samples</th><th>Average</th><th>Unit</th></tr></thead><tbody>{summary.metrics.map(metric => <tr key={JSON.stringify([metric.scope, metric.metric, metric.source])} className="border-b"><td className="py-3 pr-3 break-all">{metric.scope}</td><td className="pr-3">{METRIC_LABELS[metric.metric]}</td><td className="pr-3">{SOURCE_LABELS[metric.source]}</td><td>{metric.samples}</td><td>{numberFormat.format(metric.average)}</td><td>{metric.unit}</td></tr>)}</tbody></table>{summary.metrics.length === 0 && <p className="py-5 text-sm text-muted-foreground">No recorded numeric measurements in this sample.</p>}</div></CardContent></Card>
          </>}

          {records.length > 0 && <Card><CardHeader><CardTitle>Review records</CardTitle><CardDescription>Open the original note to inspect reasons, recovery actions, measurements, and the structured summary. Legacy or invalid reports remain readable but do not contribute to counts.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">Review</th><th>Saved (UTC)</th><th>Asset</th><th>Adoption</th><th>Data quality</th></tr></thead><tbody>{visible.map(record => <tr key={record.note.id} className="border-b align-top"><td className="py-3 pr-4"><Link className="text-primary hover:underline" to={`/notes/${encodeURIComponent(record.note.id)}`}>{record.note.title}</Link></td><td className="py-3 pr-4 whitespace-nowrap">{Number.isFinite(Date.parse(record.note.created_at)) ? new Date(record.note.created_at).toISOString().slice(0, 10) : "Unknown"}</td><td className="py-3 pr-4">{record.report?.asset_id ? <Link className="text-primary hover:underline" to={`/assets/${encodeURIComponent(record.report.asset_id)}`}>{record.report.asset_id}</Link> : "—"}</td><td className="py-3 pr-4">{record.report ? ADOPTION_LABELS[record.report.adoption.status] : "Unknown"}</td><td className="py-3">{record.error ? <span className="text-amber-800">Excluded: {record.error}</span> : <Badge variant="secondary">Structured</Badge>}</td></tr>)}</tbody></table>{selected.length === 0 && <p className="py-5 text-muted-foreground">No reviews match these filters.</p>}</div>{pageCount > 1 && <div className="mt-4 flex items-center justify-between"><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous records</Button><span className="text-sm text-muted-foreground">Page {currentPage + 1} of {pageCount}</span><Button variant="outline" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next records</Button></div>}</CardContent></Card>}
        </>}
          </div>
        </details>
      </section>
  );
}

function SummaryCard({ title, value, detail, testId }: { title: string; value: string; detail: string; testId: string }) {
  return <Card><CardHeader><CardTitle className="text-sm font-medium">{title}</CardTitle></CardHeader><CardContent><p data-testid={testId} className="text-3xl font-semibold">{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}

function ReasonList({ reasons, empty }: { reasons: [string, number][]; empty: string }) {
  return reasons.length ? <ul className="space-y-3">{reasons.slice(0, 10).map(([reason, count]) => <li key={reason} className="flex items-start justify-between gap-4 text-sm"><span className="min-w-0 break-words">{reason}</span><Badge variant="secondary">{count}</Badge></li>)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>;
}
