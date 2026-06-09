import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BriefcaseBusiness, Clock, DatabaseZap, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionNav, settingsNavItems } from "@/components/SectionNav";
import { StateMessage } from "@/components/StateMessage";
import { StatusBadge } from "@/components/StatusBadge";
import { systemJobsApi, type SystemJob } from "@/lib/api/system-jobs";
import { formatDateTime, formatDuration } from "@/lib/status";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["failed", "running", "queued", "completed"] as const;

function jobTarget(job: SystemJob) {
  const metadata = job.metadata ?? {};
  const targetType = metadata.target_type || metadata.object_type || metadata.source_type;
  const targetId = metadata.target_id || metadata.object_id || metadata.source_id;
  if (targetType && targetId) return `${String(targetType)} ${String(targetId)}`;
  if (targetId) return String(targetId);
  return job.detail || "No target recorded";
}

function nextStep(job: SystemJob) {
  if (job.status === "failed") {
    return "Inspect the related object or rerun the action from its detail page. Raw job details stay here for troubleshooting.";
  }
  if (["running", "queued", "pending"].includes(job.status)) {
    return "Wait for completion. If it stays here too long, inspect the related object or background worker.";
  }
  return "No action needed. This job is available for audit history.";
}

function JobCard({ job }: { job: SystemJob }) {
  const [expanded, setExpanded] = useState(false);
  const hasRawDetails = Boolean(job.error_message || job.detail || job.metadata);

  return (
    <Card className={cn(job.status === "failed" && "border-red-500/30 bg-red-500/5")}>
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <BriefcaseBusiness className="h-4 w-4" />
              <span className="truncate">{job.title}</span>
              <StatusBadge status={job.status} />
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {job.job_type} · Target: {jobTarget(job)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {formatDateTime(job.started_at)}</span>
            <span>Duration {formatDuration(job.duration_ms)}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {job.error_message && (
          <div className="rounded-lg border border-red-500/20 bg-background px-3 py-2 text-sm text-red-700">
            <div className="mb-1 flex items-center gap-1 font-medium"><AlertTriangle className="h-4 w-4" /> What happened</div>
            <p className="line-clamp-3">{job.error_message}</p>
          </div>
        )}
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Next step: </span>{nextStep(job)}
        </div>
        {hasRawDetails && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Hide raw details" : "Inspect raw details"}
            </Button>
            {expanded && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                {JSON.stringify({ detail: job.detail, error_message: job.error_message, metadata: job.metadata }, null, 2)}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SystemJobsPage() {
  const [status, setStatus] = useState<string>("failed");
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["system-jobs", status],
    queryFn: () => systemJobsApi.list({ status: status || undefined, scope: "all", limit: 100 }),
  });
  const jobs = data?.items ?? [];
  const failedCount = useMemo(() => jobs.filter((job) => job.status === "failed").length, [jobs]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <SectionNav items={settingsNavItems} active="Jobs" />

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="mb-3 inline-flex rounded-xl bg-primary/10 p-3 text-primary"><DatabaseZap className="h-6 w-6" /></div>
              <h1 className="text-3xl font-semibold tracking-tight">System Jobs</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Inspect background work, failures, and stuck processing without exposing this noise in the daily workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RotateCw className={cn("h-4 w-4", isFetching && "animate-spin")} /> Refresh
            </Button>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={status === "" ? "default" : "outline"} onClick={() => setStatus("")}>All</Button>
          {STATUS_FILTERS.map((item) => (
            <Button key={item} size="sm" variant={status === item ? "default" : "outline"} onClick={() => setStatus(item)}>
              {item.replace("_", " ")}
            </Button>
          ))}
          {status === "failed" && failedCount > 0 && (
            <span className="text-xs text-red-600">{failedCount} failed job{failedCount === 1 ? "" : "s"} need attention.</span>
          )}
        </div>

        {isLoading ? (
          <StateMessage title="Loading jobs" description="Checking the latest background job status." />
        ) : isError ? (
          <StateMessage tone="error" title="Could not load system jobs" description="Open Settings again or check the API logs if this keeps failing." actionLabel="Retry" onAction={() => refetch()} />
        ) : jobs.length === 0 ? (
          <StateMessage title="No jobs in this filter" description="Try another status filter, or come back after imports, discovery, RSS, wiki refresh, or agent runs have executed." />
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => <JobCard key={job.id} job={job} />)}
          </div>
        )}
      </div>
    </div>
  );
}
