import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, BookOpenCheck, FileSearch, GitPullRequestArrow, Sparkles, UserRoundCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { notesApi, reviewApi, sourcesApi, wikiApi } from "@/lib/api";
import { SUMMARY_LAYER_DESCRIPTION } from "@/lib/summaryLayer";
import { ModuleSectionNav } from "@/components/SectionNav";

export function ReviewPage() {
  const navigate = useNavigate();
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
  const { data: lowConfidenceData, isLoading: lowConfidenceLoading } = useQuery({
    queryKey: ["review-low-confidence-facts"],
    queryFn: () => reviewApi.suggestions({ suggestion_type: "low_confidence_fact", status: "pending", limit: 5 }),
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
		<ModuleSectionNav parent="review" active="Review" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Bell className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Review Center</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
					Review is the unified queue for items that need your confirmation before they become durable knowledge or change source, note, wiki, or profile state.
				</p>
				<p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
					{SUMMARY_LAYER_DESCRIPTION}
				</p>
            </div>
          </div>
        </section>

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
            title="Low-Confidence Fact Review"
            description="Profile facts with weak confidence that need confirmation before they should be trusted."
            to="/review/suggestions?type=low_confidence_fact"
            icon={Sparkles}
            count={lowConfidenceData?.total ?? 0}
            loading={lowConfidenceLoading}
            items={(lowConfidenceData?.items ?? []).map((item) => ({ title: item.title, meta: item.summary || item.target_id }))}
          />
          <ReviewQueueCard
            title="Profile Update Review"
            description="Generated profile updates and quality checks that may improve personalization."
            to="/review/suggestions?type=profile_update"
            icon={UserRoundCheck}
            workflowLabel="Run Production Retrospective"
            onWorkflow={() =>
              navigate("/chat", {
                state: {
                  objectRef: {
                    object_type: "production_memory",
                    object_id: "production_memory",
                    title: "Production Memory",
                  },
                  workflowId: "production-retrospective",
                  promptSeed: "Use my production memory and profile-related review context to understand what I have been producing, what channels are active, and what this suggests about the next best content moves.",
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
