import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, BookOpenCheck, FileSearch, GitPullRequestArrow, Sparkles, UserRoundCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { agentMemoryApi, discoveryApi, notesApi, reviewApi, sourcesApi, wikiApi } from "@/lib/api";
import { SUMMARY_LAYER_DESCRIPTION } from "@/lib/summaryLayer";
import { ModuleSectionNav } from "@/components/SectionNav";

export function ReviewPage() {
  const navigate = useNavigate();
  const [inboxFilter, setInboxFilter] = useState<InboxDomain | "all">("all");
  const { data: discoveryData, isLoading: discoveryLoading } = useQuery({
    queryKey: ["review-discovery-candidates"],
    queryFn: () => discoveryApi.list({ status: "recommended", limit: 20 }),
  });
  const { data: agentMemoryData, isLoading: agentMemoryLoading } = useQuery({
    queryKey: ["review-agent-memory-candidates"],
    queryFn: () => agentMemoryApi.list(),
  });
  const { data: digestData, isLoading: digestLoading } = useQuery({
    queryKey: ["review-digest-pending"],
    queryFn: () => notesApi.list({ note_type: "digest", status: "pending_review", limit: 5 }),
  });
  const { data: suggestionData, isLoading: suggestionsLoading } = useQuery({
    queryKey: ["review-wiki-suggestions"],
    queryFn: () => wikiApi.suggestions({ status: "pending", limit: 5 }),
  });
  const { data: miningRunsData, isLoading: miningRunsLoading } = useQuery({
    queryKey: ["review-wiki-mining-runs"],
    queryFn: () => wikiApi.miningRuns({ limit: 5 }),
  });
  const { data: sourceData, isLoading: sourcesLoading } = useQuery({
    queryKey: ["review-source-imported"],
    queryFn: () => sourcesApi.list({ limit: 100, feed_view: "parents" }),
  });
  const { data: profileSuggestionData, isLoading: profileSuggestionLoading } = useQuery({
    queryKey: ["review-profile-suggestions"],
    queryFn: () => reviewApi.suggestions({ suggestion_type: "profile_update", status: "pending", limit: 5 }),
  });

  const reviewableSources = (sourceData?.items ?? []).filter((source) => source.metadata_?.review_status === "imported_reviewable").slice(0, 5);
  const sourceReviewCount = (sourceData?.items ?? []).filter((source) => source.metadata_?.review_status === "imported_reviewable").length;
  const pendingMiningRuns = (miningRunsData?.items ?? []).filter((run) => {
    const summary = run.metadata_?.input_summary as Record<string, number> | undefined;
    return run.status === "completed" && !!summary;
  });
  const inboxItems = useMemo<InboxItem[]>(() => [
    ...(discoveryData?.items ?? []).map((item) => ({
      id: `discovery-${item.id}`,
      domain: discoveryDomain(item.payload, item.why),
      title: item.title,
      summary: item.summary || item.why?.[0] || item.provider,
      createdAt: item.created_at,
      to: "/discover",
    })),
    ...(digestData?.items ?? []).map((item) => ({
      id: `digest-${item.id}`,
      domain: "Digest" as const,
      title: item.title,
      summary: item.expires_at ? `Expires ${new Date(item.expires_at).toLocaleDateString()}` : "Pending digest review",
      createdAt: item.created_at,
      to: "/review/digest",
    })),
    ...(suggestionData?.items ?? []).map((item) => ({
      id: `wiki-${item.id}`,
      domain: "Wiki" as const,
      title: item.wiki_title || item.wiki_id,
      summary: item.reason,
      createdAt: item.created_at,
      to: "/review/wiki-suggestions",
    })),
    ...(profileSuggestionData?.items ?? []).map((item) => ({
      id: `profile-${item.id}`,
      domain: "Profile" as const,
      title: item.title,
      summary: item.summary || item.target_id,
      createdAt: item.created_at,
      to: "/review/suggestions",
    })),
    ...(agentMemoryData?.candidates ?? []).filter((item) => item.status === "pending").map((item) => ({
      id: `agent-memory-${item.id}`,
      domain: "Agent Memory" as const,
      title: item.title,
      summary: item.reason,
      createdAt: item.createdAt,
      to: "/agent-memory",
    })),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)), [agentMemoryData, digestData, discoveryData, profileSuggestionData, suggestionData]);
  const visibleInboxItems = inboxFilter === "all" ? inboxItems : inboxItems.filter((item) => item.domain === inboxFilter);
  const inboxLoading = discoveryLoading || digestLoading || suggestionsLoading || profileSuggestionLoading || agentMemoryLoading;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
		<ModuleSectionNav parent="review" active="Inbox" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Bell className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Inbox</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
					Inbox is the unified queue for candidates and changes that need confirmation before they affect a Knowledge Record or User Profile state.
				</p>
				<p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
					{SUMMARY_LAYER_DESCRIPTION}
				</p>
            </div>
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2"><Bell className="h-5 w-5" /> Pending Candidates</span>
              <Badge variant={inboxItems.length ? "secondary" : "outline"}>{inboxLoading ? "..." : inboxItems.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["all", "Discovery", "Paper Candidate", "Connector Trend", "Digest", "Wiki", "Profile", "Agent Memory"] as const).map((filter) => (
                <Button key={filter} type="button" size="sm" variant={inboxFilter === filter ? "default" : "outline"} onClick={() => setInboxFilter(filter)}>
                  {filter === "all" ? "All" : filter}
                </Button>
              ))}
            </div>
            <div className="divide-y rounded-xl border">
              {!visibleInboxItems.length && (
                <p className="p-4 text-sm text-muted-foreground">No pending candidates in this filter.</p>
              )}
              {visibleInboxItems.slice(0, 20).map((item) => (
                <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{item.domain}</Badge>
                      <Badge variant="secondary">pending</Badge>
                      <span className="truncate font-medium">{item.title}</span>
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>
                  </div>
                  <Button asChild variant="outline" size="sm"><Link to={item.to}>Review</Link></Button>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Keep, dismiss, publish, and archive remain domain actions. This Inbox aggregates decisions without creating a shared persistence model.
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ReviewQueueCard
            title="Digest Review"
            description="Generated RSS/topic summaries waiting for keep, merge, or delete. Pending digests expire after 7 days."
            to="/review/digest"
            icon={FileSearch}
            count={digestData?.total ?? 0}
            loading={digestLoading}
            items={(digestData?.items ?? []).map((item) => ({ title: item.title, meta: item.expires_at ? `expires ${new Date(item.expires_at).toLocaleDateString()}` : "pending" }))}
          />
          <ReviewQueueCard
            title="Wiki Refresh Review"
            description="Review reminders for stable wiki pages that may need updates after new source or note changes."
            to="/review/wiki-suggestions"
            icon={BookOpenCheck}
            count={suggestionData?.total ?? 0}
            loading={suggestionsLoading}
            items={(suggestionData?.items ?? []).map((item) => ({ title: item.wiki_title || item.wiki_id, meta: item.reason }))}
          />
          <ReviewQueueCard
            title="Wiki Mining Candidates"
            description="Recent wiki mining runs with candidate insights and draft articles waiting for review or conversion into draft wiki pages."
            to="/review/wiki-suggestions"
            icon={Sparkles}
            workflowLabel="Run Candidate Review"
            onWorkflow={() =>
              navigate("/chat", {
                state: {
                  objectRef: {
                    object_type: "wiki_candidate_article",
                    object_id: "review-queue",
                    title: "Wiki Mining Candidates",
                  },
                  workflowId: "review-candidate-article",
                  promptSeed: "Review the current wiki mining candidate queue. Identify which articles are closest to acceptable draft quality, which weak claims block acceptance, and what should remain in review.",
                },
              })
            }
            count={pendingMiningRuns.length}
            loading={miningRunsLoading}
            items={pendingMiningRuns.map((run) => {
              const summary = (run.metadata_?.input_summary as Record<string, number> | undefined) ?? {};
              const newCount = (summary.new_sources ?? 0) + (summary.new_notes ?? 0) + (summary.new_memory_nodes ?? 0);
              const relatedCount = (summary.related_sources ?? 0) + (summary.related_notes ?? 0) + (summary.related_memory_nodes ?? 0) + (summary.related_wiki_pages ?? 0);
              return {
                title: `Mining run #${run.id}`,
                meta: `${newCount} new inputs · ${relatedCount} related items`,
              };
            })}
          />
          <ReviewQueueCard
            title="Imported Source Review"
            description="Imported external evidence waiting for keep or discard before deeper note and wiki use."
            to="/sources?review=imported"
            icon={GitPullRequestArrow}
            count={sourceReviewCount}
            loading={sourcesLoading}
            items={reviewableSources.map((source) => ({ title: source.title, meta: source.source_type }))}
          />
          <ReviewQueueCard
            title="Profile Update Review"
            description="Generated profile updates and quality checks that may improve personalization."
            to="/review/suggestions"
            icon={UserRoundCheck}
            workflowLabel="Run Production Retrospective"
            onWorkflow={() =>
              navigate("/chat", {
                state: {
                  objectRef: {
                    object_type: "production_history",
                    object_id: "production_memory",
                    title: "Production History",
                  },
                  workflowId: "production-retrospective",
                  promptSeed: "Use my Production History and profile-related review context to understand what I have been producing, what channels are active, and what this suggests about the next best content moves.",
                },
              })
            }
            count={profileSuggestionData?.total ?? 0}
            loading={profileSuggestionLoading}
            items={(profileSuggestionData?.items ?? []).map((item) => ({ title: item.title, meta: item.summary || item.target_id }))}
          />
        </div>
      </div>
    </div>
  );
}

type InboxDomain = "Discovery" | "Paper Candidate" | "Connector Trend" | "Digest" | "Wiki" | "Profile" | "Agent Memory";

interface InboxItem {
  id: string;
  domain: InboxDomain;
  title: string;
  summary: string;
  createdAt: string;
  to: string;
}

function discoveryDomain(payload: Record<string, unknown>, why?: string[] | null): InboxDomain {
  if (payload.origin === "paper_discovery") return "Paper Candidate";
  return why?.some((reason) => reason.toLowerCase().includes("connector trend")) ? "Connector Trend" : "Discovery";
}

function ReviewQueueCard({
  title,
  description,
  to,
  icon: Icon,
  workflowLabel,
  onWorkflow,
  count,
  loading,
  items,
}: {
  title: string;
  description: string;
  to: string;
  icon: typeof Bell;
  workflowLabel?: string;
  onWorkflow?: () => void;
  count: number;
  loading: boolean;
  items: Array<{ title: string; meta: string }>;
}) {
  return (
    <Card className="flex flex-col transition-colors hover:border-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><Icon className="h-4 w-4" /> {title}</span>
          <Badge variant={count ? "secondary" : "outline"}>{loading ? "..." : count}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="min-h-28 space-y-2">
          {!items.length && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No pending items.</p>}
          {items.map((item, index) => (
            <div key={`${item.title}-${index}`} className="rounded-lg border p-2 text-xs">
              <p className="line-clamp-1 font-medium">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-muted-foreground">{item.meta}</p>
            </div>
          ))}
        </div>
        <div className="mt-auto flex flex-wrap gap-2">
          {onWorkflow && workflowLabel && (
            <Button variant="outline" size="sm" onClick={onWorkflow}>{workflowLabel}</Button>
          )}
          <Button asChild variant="outline" size="sm"><Link to={to}>Open</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}
