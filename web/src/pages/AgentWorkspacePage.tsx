import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Clock, ExternalLink, MessageSquare, RefreshCw, ServerCog, Timer } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
	agentRunsApi,
	type AgentRunEvent,
	type AgentRunStatus,
	type AgentRunStatusItem,
} from "@/lib/api/agent-runs";
import { systemJobsApi, type SystemJob } from "@/lib/api/system-jobs";
import { ModuleSectionNav } from "@/components/SectionNav";

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  idle: "bg-muted text-muted-foreground border-border",
  queued: "bg-slate-100 text-slate-700 border-slate-200",
  running: "bg-blue-100 text-blue-700 border-blue-200",
  thinking: "bg-violet-100 text-violet-700 border-violet-200",
  searching: "bg-amber-100 text-amber-700 border-amber-200",
  reading: "bg-cyan-100 text-cyan-700 border-cyan-200",
  writing: "bg-emerald-100 text-emerald-700 border-emerald-200",
  tool_calling: "bg-orange-100 text-orange-700 border-orange-200",
  completed: "bg-green-100 text-green-700 border-green-200",
  failed: "bg-red-100 text-red-700 border-red-200",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "thinking",
  "searching",
  "reading",
  "writing",
  "tool_calling",
]);

function formatTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AgentWorkspacePage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["agent-run-status"],
    queryFn: agentRunsApi.status,
    refetchInterval: 10000,
  });
  const { data: jobData, isLoading: jobsLoading, refetch: refetchJobs, isFetching: jobsFetching } = useQuery({
    queryKey: ["system-jobs"],
    queryFn: () => systemJobsApi.list({ limit: 20 }),
    refetchInterval: 15000,
  });

  const statuses = data ?? [];
  const jobs = jobData?.items ?? [];
  const activeCount = statuses.filter((item) => ACTIVE_STATUSES.has(item.status)).length;
  const failedCount = statuses.filter((item) => item.status === "failed").length;
  const failedJobCount = jobs.filter((item) => item.status === "failed").length;

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
				<ModuleSectionNav parent="settings" active="Workspace" />
				<div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
						<h1 className="text-2xl font-bold">Agent Workspace</h1>
						<p className="text-sm text-muted-foreground mt-1">
							Advanced agent run status, system jobs, and execution timelines live here outside the daily Agent Chat workflow.
						</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Timer className="h-3 w-3" /> {activeCount} active
            </Badge>
            <Badge
              variant="secondary"
              className={failedCount + failedJobCount > 0 ? "bg-red-100 text-red-700" : undefined}
            >
              {failedCount + failedJobCount} failed
            </Badge>
            <Button size="sm" variant="outline" onClick={() => { refetch(); refetchJobs(); }} disabled={isFetching || jobsFetching}>
              <RefreshCw className={cn("h-4 w-4 mr-1", (isFetching || jobsFetching) && "animate-spin")} /> Refresh
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading workspace...</p>}

        {!isLoading && statuses.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-muted-foreground">
            <Bot className="h-12 w-12 mb-3 opacity-30" />
            <p>No agent profiles yet. Create an Agent profile to start tracking runs.</p>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {statuses.map((item) => (
            <AgentStatusCard
              key={item.profile_id}
              item={item}
              onTimeline={() => item.run_id && setSelectedRunId(item.run_id)}
              onOpenChat={() => navigate(`/?profile_id=${encodeURIComponent(item.profile_id)}`)}
            />
          ))}
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ServerCog className="h-4 w-4" /> System Jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobsLoading && <p className="text-sm text-muted-foreground">Loading system jobs...</p>}
            {!jobsLoading && jobs.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No system jobs recorded yet.</p>}
            {jobs.map((job) => <SystemJobRow key={job.id} job={job} />)}
          </CardContent>
        </Card>
      </div>

      <TimelineDialog runId={selectedRunId} onOpenChange={(open) => !open && setSelectedRunId(null)} />
    </div>
  );
}

function SystemJobRow({ job }: { job: SystemJob }) {
  const failed = job.status === "failed";
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{job.job_type}</Badge>
          <Badge variant="secondary" className={failed ? "bg-red-100 text-red-700" : undefined}>{job.status}</Badge>
          {typeof job.duration_ms === "number" && <span className="text-xs text-muted-foreground">{Math.round(job.duration_ms)} ms</span>}
        </div>
        <span className="text-xs text-muted-foreground">{formatTime(job.started_at)}</span>
      </div>
      <p className="mt-2 text-sm font-medium">{job.title}</p>
      {job.error_message && <p className="mt-1 text-sm text-destructive">{job.error_message}</p>}
      {job.metadata && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{JSON.stringify(job.metadata)}</p>}
    </div>
  );
}

function AgentStatusCard({
  item,
  onTimeline,
  onOpenChat,
}: {
  item: AgentRunStatusItem;
  onTimeline: () => void;
  onOpenChat: () => void;
}) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">{item.profile_name}</span>
            </CardTitle>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px] uppercase">
                {item.agent_type}
              </Badge>
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", STATUS_STYLES[item.status])}>
                {item.status.replace("_", " ")}
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Task</p>
            <p className="mt-1 line-clamp-2">{item.current_task || "No recent task"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Latest Output</p>
            <p className="mt-1 line-clamp-3 text-muted-foreground">
              {item.last_result_preview || "No output yet"}
            </p>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Last active: {formatTime(item.last_active_at)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onTimeline} disabled={!item.run_id} className="flex-1">
            <ExternalLink className="h-4 w-4 mr-1" /> Timeline
          </Button>
          <Button size="sm" onClick={onOpenChat} className="flex-1">
            <MessageSquare className="h-4 w-4 mr-1" /> Chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TimelineDialog({ runId, onOpenChange }: { runId: string | null; onOpenChange: (open: boolean) => void }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ["agent-run-events", runId],
    queryFn: () => agentRunsApi.events(runId as string),
    enabled: Boolean(runId),
    refetchInterval: runId ? 5000 : false,
  });

  return (
    <Dialog open={Boolean(runId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run Timeline</DialogTitle>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Loading timeline...</p>}
        {!isLoading && (!events || events.length === 0) && (
          <p className="text-sm text-muted-foreground">No timeline events recorded yet.</p>
        )}
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {(events ?? []).map((event) => (
            <TimelineEventRow key={event.id} event={event} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TimelineEventRow({ event }: { event: AgentRunEvent }) {
  return (
    <div className="flex gap-3 rounded-md border border-border p-3">
      <div className="w-20 shrink-0 text-xs text-muted-foreground">{formatEventTime(event.created_at)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {event.event_type}
          </Badge>
          <p className="text-sm font-medium">{event.title}</p>
        </div>
        {event.detail && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{event.detail}</p>}
      </div>
    </div>
  );
}
