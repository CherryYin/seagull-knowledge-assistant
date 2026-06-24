import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BriefcaseBusiness, Clock, DatabaseZap, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionNav, settingsNavItems } from "@/components/SectionNav";
import { StateMessage } from "@/components/StateMessage";
import { StatusBadge } from "@/components/StatusBadge";
import { systemJobsApi, type SchedulerTaskStatus, type SystemJob } from "@/lib/api/system-jobs";
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
  const metadata = job.metadata ?? {};
  const reason = typeof metadata.reason === "string" ? metadata.reason : null;
  if (job.status === "failed") {
    return "Inspect the related object or rerun the action from its detail page. Raw job details stay here for troubleshooting.";
  }
  if (["running", "queued", "pending"].includes(job.status)) {
    return "Wait for completion. If it stays here too long, inspect the related object or background worker.";
  }
  if (reason === "no_rss_enabled_feeds") return "No RSS-enabled feeds are configured yet.";
  if (reason === "no_new_rss_articles") return "Feeds were checked, but no new RSS articles were found.";
  if (reason === "no_recent_rss_articles") return "No recent RSS articles were available to summarize.";
  if (reason === "no_temporary_notes") return "No temporary notes were available for daily summarization.";
  if (reason === "no_active_users") return "No active users were eligible for this scheduled task.";
  if (reason === "no_recent_rss_articles_or_connector_candidates") return "No fresh discovery candidates were found from RSS or connectors.";
  if (reason === "no_enabled_profiles") return "No enabled paper discovery profiles are configured.";
  if (reason === "no_due_profiles") return "Paper discovery profiles exist, but none were due this round.";
  if (reason === "no_due_web_directories") return "No web directory sources were due for auto-discovery.";
  if (reason === "no_due_web_sources") return "No web sources were due for auto-refresh.";
  if (reason === "no_web_content_changes") return "Web sources were checked, but content did not change.";
  return "No action needed. This job is available for audit history.";
}

function renderJobStats(job: SystemJob) {
  const metadata = job.metadata ?? {};
  const rawEntries: Array<[string, unknown]> = [
    ["feeds", metadata.feeds_checked],
    ["new", metadata.new_articles],
    ["deleted", metadata.deleted],
    ["created", metadata.created],
    ["updated", metadata.updated],
    ["skipped", metadata.skipped],
    ["users", metadata.users ?? metadata.active_users],
    ["profiled", metadata.profiled],
    ["candidates", metadata.candidate_count],
    ["profiles", metadata.profiles],
    ["eligible", metadata.eligible],
    ["runs", metadata.runs],
    ["directories", metadata.sources_due],
    ["checked", metadata.sources_checked],
    ["refreshed", metadata.sources_refreshed],
    ["unchanged", metadata.sources_unchanged],
    ["errors", metadata.errors],
  ];
  const entries = rawEntries.filter(([, value]) => typeof value === "number");

  if (!entries.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, value]) => (
        <span key={label} className="inline-flex rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground">
          <span className="mr-1 font-medium text-foreground">{label}</span>
          {String(value)}
        </span>
      ))}
    </div>
  );
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
        {renderJobStats(job)}
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

function SchedulerTaskCard({ task }: { task: SchedulerTaskStatus }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Clock className="h-4 w-4" />
              <span className="truncate">{task.title}</span>
              <StatusBadge status={task.enabled ? (task.due_now ? "running" : "completed") : "archived"} label={task.enabled ? (task.due_now ? "Due now" : "Enabled") : "Disabled"} />
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {task.job_type} · {task.schedule_type}
            </p>
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground md:text-right">
            <span>Last run {formatDateTime(task.last_run_at)}</span>
            <span>Next run {formatDateTime(task.next_run_at)}</span>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

export function SystemJobsPage() {
  const [status, setStatus] = useState<string>("failed");
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["system-jobs", status],
    queryFn: () => systemJobsApi.list({ status: status || undefined, scope: "all", limit: 100 }),
  });
  const schedulerQuery = useQuery({
    queryKey: ["scheduler-status"],
    queryFn: () => systemJobsApi.scheduler(),
  });
  const jobs = data?.items ?? [];
  const schedulerTasks = schedulerQuery.data?.items ?? [];
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

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Scheduler</h2>
            <p className="text-sm text-muted-foreground">Current task enablement and next-run status.</p>
          </div>
          {schedulerQuery.isLoading ? (
            <StateMessage title="Loading scheduler" description="Checking task schedules and next-run times." />
          ) : schedulerQuery.isError ? (
            <StateMessage tone="error" title="Could not load scheduler status" description="Retry or check the API logs if this keeps failing." actionLabel="Retry" onAction={() => schedulerQuery.refetch()} />
          ) : schedulerTasks.length === 0 ? (
            <StateMessage title="No scheduler tasks visible" description="Scheduler task status is available to admins when background automation is configured." />
          ) : (
            <div className="space-y-3">
              {schedulerTasks.map((task) => <SchedulerTaskCard key={task.name} task={task} />)}
            </div>
          )}
        </section>

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
