import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Compass,
  FileText,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  calendarRemindersApi,
  chatSessionsApi,
  discoveryApi,
  knowledgeApi,
  notesApi,
  reviewApi,
  sourcesApi,
  systemJobsApi,
  wikiApi,
  type Source,
  type Note,
  type DiscoveryItem,
  type ChatSessionRecord,
  type SystemJob,
  type MemoryNode,
  type WikiPage,
} from "@/lib/api";
import { getSourceProcessingState } from "@/lib/sourceProcessingStatus";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function shortTime(value?: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Priority = "high" | "medium" | "low";

interface TodayCardData {
  id: string;
  title: string;
  description: string;
  reason: string;
  href: string;
  cta: string;
  priority: Priority;
  icon: LucideIcon;
  count?: number;
  timestamp?: string | null;
}

export function HomePage() {
  const { data: dashboard } = useQuery({ queryKey: ["home-dashboard"], queryFn: () => knowledgeApi.dashboard() });
  const { data: reminders } = useQuery({
    queryKey: ["home-reminders"],
    queryFn: () => calendarRemindersApi.list({ end: todayIso(), include_done: false }),
  });
  const { data: wikiSuggestions } = useQuery({
    queryKey: ["home-wiki-refresh"],
    queryFn: () => wikiApi.suggestions({ status: "pending", limit: 5 }),
  });
  const { data: reviewSuggestions } = useQuery({
    queryKey: ["home-review-suggestions"],
    queryFn: () => reviewApi.suggestions({ status: "pending", limit: 5 }),
  });
  const { data: sourceData } = useQuery({
    queryKey: ["home-sources"],
    queryFn: () => sourcesApi.list({ limit: 20, feed_view: "parents" }),
  });
  const { data: noteData } = useQuery({
    queryKey: ["home-notes"],
    queryFn: () => notesApi.list({ limit: 20 }),
  });
  const { data: pendingNoteData } = useQuery({
    queryKey: ["home-pending-notes"],
    queryFn: () => notesApi.list({ status: "pending_review", limit: 10 }),
  });
  const { data: keptDiscoveries } = useQuery({
    queryKey: ["home-discovery-kept"],
    queryFn: () => discoveryApi.list({ status: "kept", limit: 5 }),
  });
  const { data: recommendedDiscoveries } = useQuery({
    queryKey: ["home-discovery-recommended"],
    queryFn: () => discoveryApi.list({ status: "recommended", limit: 5 }),
  });
  const { data: chatSessions } = useQuery({
    queryKey: ["home-chat-sessions"],
    queryFn: () => chatSessionsApi.list({ limit: 5 }),
  });
  const { data: failedJobs } = useQuery({
    queryKey: ["home-system-jobs-failed"],
    queryFn: () => systemJobsApi.list({ status: "failed", limit: 5 }),
  });
  const { data: pendingJobs } = useQuery({
    queryKey: ["home-system-jobs-pending"],
    queryFn: () => systemJobsApi.list({ status: "pending", limit: 5 }),
  });
  const { data: staleWikis } = useQuery({
    queryKey: ["home-wiki-stale"],
    queryFn: () => wikiApi.list({ needs_recompile: true, limit: 5 }),
  });

  const counts = dashboard?.counts;
  const openTodos = reminders?.items.filter((item) => !item.is_done).slice(0, 5) ?? [];
  const overdue = reminders?.overdue_count ?? 0;
  const sources = sourceData?.items ?? [];
  const notes = noteData?.items ?? [];
  const pendingWikiCount = wikiSuggestions?.total ?? 0;
  const reviewSuggestionCount = reviewSuggestions?.total ?? 0;
  const reviewableSources = sources.filter((source) => source.metadata_?.review_status === "imported_reviewable");
  const failedSourceItems = sources.filter((source) => isFailedSource(source));
  const unprocessedSources = sources.filter((source) => {
    const state = getSourceProcessingState(source);
    return state.stage === "raw" || state.status === "waiting";
  });
  const digestPending = counts?.digest_pending ?? 0;
  const pendingNotesCount = pendingNoteData?.total ?? 0;
  const keptDiscoveryCount = keptDiscoveries?.total ?? 0;
  const recommendedDiscoveryCount = recommendedDiscoveries?.total ?? 0;
  const failedJobItems = failedJobs?.items ?? [];
  const pendingJobItems = pendingJobs?.items ?? [];
  const recentSessions = chatSessions?.items ?? [];
  const needsRecompileWikis = staleWikis?.items ?? [];

  const focusCards = buildFocusCards({
    failedJobs: failedJobItems,
    failedSources: failedSourceItems,
    pendingWikiCount,
    digestPending,
    reviewSuggestionCount,
    reviewableSources,
    keptDiscoveryCount,
    sources,
    sessions: recentSessions,
  }).slice(0, 5);

  const needsReviewCards = [
    digestPending > 0 && card("digest", "Digest Review", "Generated summaries are waiting for keep, merge, or dismiss.", "Generated but not confirmed", "/review/digest", "Open Digest Review", "high", Bell, digestPending),
    pendingWikiCount > 0 && card("wiki-refresh", "Wiki Refresh Queue", "New material may affect stable wiki pages.", "Pending wiki refresh reminders", "/review/wiki-suggestions", "Open Wiki Refresh Queue", "high", RefreshCw, pendingWikiCount),
    reviewSuggestionCount > 0 && card("review-suggestions", "Review Suggestions", "Profile or knowledge suggestions need confirmation.", "Pending review suggestions", "/review/suggestions", "Open Suggestions", "medium", Bell, reviewSuggestionCount),
    reviewableSources.length > 0 && card("review-sources", "Imported Sources", "Connector imports are saved but still need review.", "Imported reviewable sources", "/sources?review=imported", "Review Sources", "medium", BookOpen, reviewableSources.length),
    pendingNotesCount > 0 && card("pending-notes", "Pending Notes", "Generated notes need confirmation before becoming stable knowledge.", "Notes with pending_review status", "/notes?status=pending_review", "Review Notes", "medium", FileText, pendingNotesCount),
    unprocessedSources.length > 0 && card("unprocessed-sources", "Unprocessed Sources", "Some sources are still raw and need extraction, chunking, or summarization before they become easy to use.", "Source processing still incomplete", "/sources", "Open Sources", "medium", BookOpen, unprocessedSources.length),
  ].filter(Boolean) as TodayCardData[];

  const recentSources = sources.slice(0, 5);
  const recentNotes = notes.slice(0, 5);
  const recentCards = [
    ...recentSources.map((source) => sourceCard(source)),
    ...recentNotes.map((note) => noteCard(note)),
  ].sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")).slice(0, 8);

  const continueCards = [
    ...((keptDiscoveries?.items ?? []).map((item) => discoveryCard(item, "Kept Discovery", "Kept for later; import it when ready."))),
    ...((recommendedDiscoveries?.items ?? []).slice(0, 3).map((item) => discoveryCard(item, "Recommended Discovery", "Candidate material found by Discover."))),
    ...recentSessions.map((session) => sessionCard(session)),
    ...needsRecompileWikis.map((wiki) => wikiCard(wiki)),
  ].slice(0, 8);

  const systemCards = [
    ...failedJobItems.map((job) => systemJobCard(job, "high")),
    ...failedSourceItems.map((source) => failedSourceCard(source)),
    ...pendingJobItems.map((job) => systemJobCard(job, "medium")),
  ].slice(0, 6);

  const allClear = focusCards.length === 0 && needsReviewCards.length === 0 && systemCards.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Personal Knowledge Steward
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight">Today&apos;s Steward Desk</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Start with what needs review, what recently changed, and what failed.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild><Link to="/chat"><MessageSquare className="h-4 w-4" /> Ask</Link></Button>
              <Button asChild variant="outline"><Link to="/review"><Bell className="h-4 w-4" /> Review</Link></Button>
              <Button asChild variant="outline"><Link to="/discover"><Compass className="h-4 w-4" /> Discover</Link></Button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Notes" value={counts?.notes ?? 0} icon={FileText} to="/notes" />
          <MetricCard label="Sources" value={counts?.sources ?? 0} icon={BookOpen} to="/sources" />
          <MetricCard label="Needs Review" value={needsReviewCards.reduce((sum, item) => sum + (item.count ?? 1), 0)} icon={Bell} to="/review" />
          <MetricCard label="Open Todos" value={openTodos.length + overdue} icon={CalendarDays} to="/calendar" />
        </section>

        {allClear && (
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                <div>
                  <p className="font-medium">All clear.</p>
                  <p className="text-sm text-muted-foreground">Import something new, review kept discoveries, or ask the agent to continue a knowledge task.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline"><Link to="/discover">Open Discover</Link></Button>
                <Button asChild size="sm"><Link to="/chat">Ask Agent</Link></Button>
              </div>
            </CardContent>
          </Card>
        )}

        <TodaySection title="Today Focus" description="Top actions selected by simple status and recency rules." cards={focusCards} empty="No urgent focus items right now." />

        <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <TodaySection title="Needs Review" description="Confirm items before they change durable knowledge." cards={needsReviewCards} empty="No pending review items." />
          <TodaySection title="System Attention" description="Failures or blocked background work that may need attention." cards={systemCards} empty="No failed or blocked jobs found." compact />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <TodaySection title="New & Recent" description="Recently added sources and notes ready for Phase 2 actions." cards={recentCards} empty="No recent sources or notes." compact />
          <TodaySection title="Continue Working" description="Kept discoveries, recent chats, and stale wiki pages." cards={continueCards} empty="Nothing queued to continue." compact />
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4" /> Recent Todos</CardTitle>
          </CardHeader>
          <CardContent>
            {!openTodos.length ? (
              <p className="text-sm text-muted-foreground">No recent open todos. Use Calendar to plan the day.</p>
            ) : (
              <div className="space-y-2">
                {openTodos.map((item) => (
                  <Link key={item.id} to="/calendar" className="flex items-center justify-between rounded-lg border p-3 text-sm hover:border-primary/40">
                    <span className="line-clamp-1">{item.text}</span>
                    <Badge variant="outline">{item.date}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function card(id: string, title: string, description: string, reason: string, href: string, cta: string, priority: Priority, icon: LucideIcon, count?: number, timestamp?: string | null): TodayCardData {
  return { id, title, description, reason, href, cta, priority, icon, count, timestamp };
}

function buildFocusCards({
  failedJobs,
  failedSources,
  pendingWikiCount,
  digestPending,
  reviewSuggestionCount,
  reviewableSources,
  keptDiscoveryCount,
  sources,
  sessions,
}: {
  failedJobs: SystemJob[];
  failedSources: Source[];
  pendingWikiCount: number;
  digestPending: number;
  reviewSuggestionCount: number;
  reviewableSources: Source[];
  keptDiscoveryCount: number;
  sources: Source[];
  sessions: ChatSessionRecord[];
}) {
  const cards: TodayCardData[] = [];
  if (failedJobs.length || failedSources.length) {
    cards.push(card("focus-failures", "System attention needed", "Some jobs or source processing steps failed.", "Processing failed", "/settings/jobs", "Open System Jobs", "high", AlertTriangle, failedJobs.length + failedSources.length));
  }
  if (pendingWikiCount) {
    cards.push(card("focus-wiki-refresh", "Wiki pages may need refresh", "New materials may affect stable wiki pages.", "Pending Wiki Refresh Queue", "/review/wiki-suggestions", "Open Wiki Refresh Queue", "high", RefreshCw, pendingWikiCount));
  }
  if (digestPending || reviewSuggestionCount || reviewableSources.length) {
    cards.push(card("focus-review", "Review queue has work", "Generated or imported knowledge needs confirmation.", "Pending review", "/review", "Open Review", "high", Bell, digestPending + reviewSuggestionCount + reviewableSources.length));
  }
  if (keptDiscoveryCount) {
    cards.push(card("focus-kept-discoveries", "Kept discoveries are waiting", "Candidate materials were kept but not imported.", "Kept for later", "/discover", "Open Discover", "medium", Compass, keptDiscoveryCount));
  }
  const recentSource = sources[0];
  if (recentSource) {
    cards.push(card(`focus-source-${recentSource.id}`, "Turn a recent source into your own note", recentSource.title, "Recently imported external evidence", `/sources/${encodeURIComponent(recentSource.id)}`, "Open Source", "medium", BookOpen, undefined, recentSource.ingested_at));
  }
  const recentSession = sessions[0];
  if (recentSession) {
    cards.push(card(`focus-session-${recentSession.id}`, "Continue recent agent work", recentSession.title || "Untitled session", "Recently updated agent session", "/chat", "Open Agent", "low", MessageSquare, undefined, recentSession.updated_at));
  }
  return cards;
}

function sourceCard(source: Source): TodayCardData {
  return card(`source-${source.id}`, source.title, source.source_type, "Recent external evidence", `/sources/${encodeURIComponent(source.id)}`, "Open Source", "medium", BookOpen, undefined, source.ingested_at);
}

function noteCard(note: Note): TodayCardData {
  return card(`note-${note.id}`, note.title, note.abstract || note.note_type, "Recent personal note", `/notes/${encodeURIComponent(note.id)}`, "Open Note", "medium", FileText, undefined, note.updated_at || note.created_at);
}

function discoveryCard(item: DiscoveryItem, title: string, reason: string): TodayCardData {
  return card(`discover-${item.id}`, item.title, item.summary || item.provider, reason, "/discover", "Open Discover", "medium", Compass, undefined, item.updated_at);
}

function sessionCard(session: ChatSessionRecord): TodayCardData {
  return card(`session-${session.id}`, session.title || "Untitled session", `${session.messages.length} messages`, "Recent Agent session", "/chat", "Continue Chat", "low", MessageSquare, undefined, session.updated_at);
}

function wikiCard(wiki: WikiPage): TodayCardData {
  return card(`wiki-${wiki.id}`, wiki.title, wiki.stale_reason || wiki.summary || "Needs refresh", "Wiki needs refresh", `/wiki/${encodeURIComponent(wiki.id)}`, "Open Wiki", "medium", RefreshCw, undefined, wiki.stale_triggered_at || wiki.updated_at);
}

function systemJobCard(job: SystemJob, priority: Priority): TodayCardData {
  return card(`job-${job.id}`, job.title || job.job_type, job.error_message || job.detail || job.status, `System job ${job.status}`, "/settings/jobs", "Open System Jobs", priority, AlertTriangle, undefined, job.updated_at);
}

function failedSourceCard(source: Source): TodayCardData {
  return card(`failed-source-${source.id}`, source.title, String(source.metadata_?.error || source.metadata_?.failure_reason || "Source processing needs attention"), "Source processing failed", `/sources/${encodeURIComponent(source.id)}`, "Open Source", "high", AlertTriangle, undefined, source.ingested_at);
}

function isFailedSource(source: Source) {
  const metadata = source.metadata_ || {};
  const status = String(metadata.processing_status || metadata.status || metadata.review_status || "").toLowerCase();
  return status.includes("fail") || status.includes("error") || Boolean(metadata.error || metadata.failure_reason);
}

function TodaySection({ title, description, cards, empty, compact = false }: { title: string; description: string; cards: TodayCardData[]; empty: string; compact?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span>{title}</span>
          <Badge variant={cards.length ? "secondary" : "outline"}>{cards.length}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{empty}</p>
        ) : (
          cards.map((item) => <TodayCard key={item.id} item={item} compact={compact} />)
        )}
      </CardContent>
    </Card>
  );
}

function TodayCard({ item, compact }: { item: TodayCardData; compact?: boolean }) {
  const Icon = item.icon;
  const priorityClass = item.priority === "high" ? "border-destructive/40 bg-destructive/5" : item.priority === "medium" ? "border-primary/30 bg-primary/5" : "";
  return (
    <Link to={item.href} className={`block rounded-lg border p-4 transition-colors hover:border-primary/50 ${priorityClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="line-clamp-1 font-medium">{item.title}</p>
              {typeof item.count === "number" && <Badge variant="secondary">{item.count}</Badge>}
            </div>
            <p className={compact ? "mt-1 line-clamp-1 text-xs text-muted-foreground" : "mt-1 line-clamp-2 text-sm text-muted-foreground"}>{item.description}</p>
            <p className="mt-2 text-xs text-muted-foreground">{item.reason}{item.timestamp ? ` · ${shortTime(item.timestamp)}` : ""}</p>
          </div>
        </div>
        <span className="shrink-0 text-xs font-medium text-primary">{item.cta}</span>
      </div>
    </Link>
  );
}

function MetricCard({ label, value, icon: Icon, to }: { label: string; value: number; icon: LucideIcon; to: string }) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:border-primary/40">
        <CardContent className="flex items-center justify-between p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
          </div>
          <Icon className="h-5 w-5 text-primary" />
        </CardContent>
      </Card>
    </Link>
  );
}
