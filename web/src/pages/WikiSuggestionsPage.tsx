import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot, CheckCircle2, Clock, Copy, FileSearch, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { wikiApi, type WikiArticleDraft, type WikiInsightCandidate, type WikiRecompileSuggestion } from "@/lib/api";
import { type ReferenceItem } from "@/components/ReferenceChips";
import { ReferenceList } from "@/components/ReferenceList";
import { getReviewConflictMessage, getReviewStatusLabel } from "@/lib/reviewStatus";
import { SUMMARY_LAYER_DESCRIPTION } from "@/lib/summaryLayer";
import { SectionNav, reviewNavItems } from "@/components/SectionNav";

export function WikiSuggestionsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-suggestions", "all"],
    queryFn: () => wikiApi.suggestions({ status: undefined, limit: 100 }),
  });
  const { data: miningRuns, isLoading: miningLoading } = useQuery({
    queryKey: ["wiki-mining-runs", "review"],
    queryFn: () => wikiApi.miningRuns({ limit: 20 }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "accepted" | "rejected" | "applied" }) =>
      wikiApi.updateSuggestion(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
    },
  });

  const cloneDraftMutation = useMutation({
    mutationFn: ({ wikiId }: { wikiId: string }) => wikiApi.cloneDraft(wikiId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  const updateInsightMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "accepted" | "rejected" | "converted_to_draft" }) =>
      wikiApi.updateMiningInsight(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
      queryClient.invalidateQueries({ queryKey: ["review-wiki-mining-runs"] });
    },
  });

  const updateArticleMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { status: "candidate" | "draft" | "in_review" | "accepted" | "rejected" | "merged"; reviewer_note?: string | null; wiki_title?: string | null; page_type?: string | null } }) =>
      wikiApi.updateMiningArticle(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      queryClient.invalidateQueries({ queryKey: ["review-wiki-mining-runs"] });
    },
  });

  const mergeArticleMutation = useMutation({
    mutationFn: ({ id }: { id: number }) => wikiApi.mergeMiningArticle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const convertArticleMutation = useMutation({
    mutationFn: ({ id }: { id: number }) => wikiApi.convertMiningArticleToNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const suggestions = data?.items ?? [];
  const miningArticles = (miningRuns?.items ?? []).slice(0, 5);

	return (
		<div className="h-full overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl space-y-5">
				<SectionNav items={reviewNavItems} active="Wiki Refresh" />
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<div className="flex items-center gap-2 text-primary">
							<Bot className="h-5 w-5" />
						<span className="text-sm font-medium">Review · Wiki Refresh</span>
						</div>
						<h1 className="mt-2 text-2xl font-semibold tracking-tight">Wiki Refresh Review Queue</h1>
						<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
							These review reminders appear when new source, note, or memory material may affect stable wiki pages. Review the evidence, update the page if needed, then mark it updated.
						</p>
						<p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
							{SUMMARY_LAYER_DESCRIPTION}
						</p>
          </div>
          <Badge variant="secondary" className="w-fit">
            {suggestions.filter((item) => item.status === "pending").length} pending
          </Badge>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileSearch className="h-4 w-4 text-primary" /> Pending Refreshes
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Clone Draft is the safer draft-first path for stable pages. Mark Needs Update keeps the page in review, Dismiss closes the reminder, and Mark Updated clears it after review.</p>
            </div>
            {isLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-3">
            {error instanceof Error && <p className="text-sm text-destructive">Failed to load suggestions: {error.message}</p>}
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                {getReviewConflictMessage(updateMutation.error, "Failed to update wiki review item.")}
              </p>
            )}
            {!isLoading && suggestions.length === 0 && (
              <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                No refresh reminders yet. New source, note, or memory updates that may affect a wiki will appear here.
              </div>
            )}
            {suggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                isUpdating={updateMutation.isPending}
                isCloningDraft={cloneDraftMutation.isPending}
                onAccept={() => updateMutation.mutate({ id: suggestion.id, status: "accepted" })}
                onReject={() => updateMutation.mutate({ id: suggestion.id, status: "rejected" })}
                onApply={() => updateMutation.mutate({ id: suggestion.id, status: "applied" })}
                onCloneDraft={() => cloneDraftMutation.mutate({ wikiId: suggestion.wiki_id })}
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" /> Wiki Mining Candidates
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Recent mining runs that produced candidate insights and article drafts. Use these as draft-first inputs for canonical wiki pages.</p>
            </div>
            {miningLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-3">
            {!miningLoading && miningArticles.length === 0 && (
              <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                No wiki mining candidates yet. Run wiki mining to surface candidate articles and insights here.
              </div>
            )}
            {miningArticles.map((run) => (
              <MiningRunCard
                key={run.id}
                runId={run.id}
                isUpdatingInsight={updateInsightMutation.isPending}
                isUpdatingArticle={updateArticleMutation.isPending || mergeArticleMutation.isPending || convertArticleMutation.isPending}
                onAcceptInsight={(id) => updateInsightMutation.mutate({ id, status: "accepted" })}
                onRejectInsight={(id) => updateInsightMutation.mutate({ id, status: "rejected" })}
                onAcceptArticle={(id) => updateArticleMutation.mutate({ id, body: { status: "accepted" } })}
                onRejectArticle={(id) => updateArticleMutation.mutate({ id, body: { status: "rejected" } })}
                onMarkInReview={(id) => updateArticleMutation.mutate({ id, body: { status: "in_review" } })}
                onMergeArticle={(id) => mergeArticleMutation.mutate({ id })}
                onConvertArticle={(id) => convertArticleMutation.mutate({ id })}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MiningRunCard({
  runId,
  isUpdatingInsight,
  isUpdatingArticle,
  onAcceptInsight,
  onRejectInsight,
  onAcceptArticle,
  onRejectArticle,
  onMarkInReview,
  onMergeArticle,
  onConvertArticle,
}: {
  runId: number;
  isUpdatingInsight: boolean;
  isUpdatingArticle: boolean;
  onAcceptInsight: (id: number) => void;
  onRejectInsight: (id: number) => void;
  onAcceptArticle: (id: number) => void;
  onRejectArticle: (id: number) => void;
  onMarkInReview: (id: number) => void;
  onMergeArticle: (id: number) => void;
  onConvertArticle: (id: number) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["wiki-mining-run", runId],
    queryFn: () => wikiApi.miningRun(runId),
  });

  const articles = (data?.articles ?? []).filter((item) => ["candidate", "draft", "in_review"].includes(item.status)).slice(0, 2);
  const insights = (data?.insights ?? []).filter((item) => item.status === "pending").slice(0, 3);
  const insightsCount = insights.length;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Run #{runId}</Badge>
            <Badge>{insightsCount} pending insights</Badge>
          </div>
          {isLoading && <p className="mt-2 text-sm text-muted-foreground">Loading candidate article summary…</p>}
          {!isLoading && articles.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No pending candidate articles in this run.</p>}
          <div className="mt-3 space-y-2">
            {insights.map((insight) => (
              <MiningInsightPreview
                key={insight.id}
                insight={insight}
                disabled={isUpdatingInsight}
                onAccept={() => onAcceptInsight(insight.id)}
                onReject={() => onRejectInsight(insight.id)}
              />
            ))}
            {articles.map((article) => (
              <MiningArticlePreview
                key={article.id}
                article={article}
                disabled={isUpdatingArticle}
                onAccept={() => onAcceptArticle(article.id)}
                onReject={() => onRejectArticle(article.id)}
                onMarkInReview={() => onMarkInReview(article.id)}
                onMerge={() => onMergeArticle(article.id)}
                onConvert={() => onConvertArticle(article.id)}
                onCreateAssetHref={`/assets?handoff_title=${encodeURIComponent(article.title)}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiningInsightPreview({
  insight,
  disabled,
  onAccept,
  onReject,
}: {
  insight: WikiInsightCandidate;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { data: resolvedRefs } = useQuery({
    queryKey: ["wiki-reference-resolve", "insight", insight.id],
    queryFn: () => wikiApi.resolveReferences(insight.evidence_refs),
  });
  const claims = Array.isArray(insight.metadata_?.claims) ? insight.metadata_.claims : [];
  const weakClaimCount = claims.filter((claim) => String(claim.status || "") !== "supported").length;

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{insight.insight_type}</Badge>
        <Badge variant="secondary">{insight.evidence_refs.length} refs</Badge>
        {weakClaimCount > 0 && <Badge variant="outline">{weakClaimCount} weak claim{weakClaimCount > 1 ? "s" : ""}</Badge>}
      </div>
      <p className="mt-2 font-medium">{insight.title}</p>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{insight.summary}</p>
      {claims.length > 0 && (
        <div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Claim</p>
          {claims.map((claim, index) => (
            <div key={index} className="mt-2 text-sm leading-6">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{String(claim.status || "weak")}</Badge>
              </div>
              <p className="mt-1 text-foreground">{String(claim.text || "")}</p>
            </div>
          ))}
          {weakClaimCount > 0 && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              This insight still has weakly supported claims. Review evidence before accepting it into a draft.
            </p>
          )}
        </div>
      )}
      <ReferenceList items={(resolvedRefs?.items ?? []) as ReferenceItem[]} title="Evidence" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onReject} disabled={disabled}>
          <XCircle className="mr-1 h-4 w-4" /> Reject
        </Button>
        <Button size="sm" onClick={onAccept} disabled={disabled}>
          <CheckCircle2 className="mr-1 h-4 w-4" /> Accept
        </Button>
      </div>
    </div>
  );
}

function MiningArticlePreview({
  article,
  disabled,
  onAccept,
  onReject,
  onMarkInReview,
  onMerge,
  onConvert,
  onCreateAssetHref,
}: {
  article: WikiArticleDraft;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
  onMarkInReview: () => void;
  onMerge: () => void;
  onConvert: () => void;
  onCreateAssetHref: string;
}) {
  const { data: resolvedRefs } = useQuery({
    queryKey: ["wiki-reference-resolve", "article", article.id],
    queryFn: () => wikiApi.resolveReferences(article.evidence_refs),
  });
  const claims = Array.isArray(article.metadata_?.claims) ? article.metadata_.claims : [];
  const weakClaimCount = claims.filter((claim) => String(claim.status || "") !== "supported").length;
  const shouldGateAccept = weakClaimCount >= 2;

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{article.status}</Badge>
        <Badge variant="secondary">{article.evidence_refs.length} refs</Badge>
        {weakClaimCount > 0 && <Badge variant="outline">{weakClaimCount} weak claim{weakClaimCount > 1 ? "s" : ""}</Badge>}
      </div>
      <p className="mt-2 font-medium">{article.title}</p>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{article.summary || article.content}</p>
      {claims.length > 0 && (
        <div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Candidate Claims</p>
          <div className="mt-2 space-y-2">
            {claims.slice(0, 4).map((claim, index) => (
              <div key={index} className="rounded-md border border-border/60 p-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{String(claim.status || "weak")}</Badge>
                </div>
                <p className="mt-1 text-sm leading-6 text-foreground">{String(claim.text || "")}</p>
              </div>
            ))}
          </div>
          {weakClaimCount > 0 && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              This candidate article still contains weakly supported claims. It may be better to keep it in review until evidence is stronger.
            </p>
          )}
        </div>
      )}
      <ReferenceList items={(resolvedRefs?.items ?? []) as ReferenceItem[]} title="Evidence" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onReject} disabled={disabled}>
          <XCircle className="mr-1 h-4 w-4" /> Reject
        </Button>
        <Button size="sm" variant="outline" onClick={onMarkInReview} disabled={disabled}>
          <Clock className="mr-1 h-4 w-4" /> In Review
        </Button>
        <Button size="sm" variant="outline" onClick={onMerge} disabled={disabled}>
          <Copy className="mr-1 h-4 w-4" /> Merge Placeholder
        </Button>
        <Button size="sm" variant="outline" onClick={onConvert} disabled={disabled}>
          <FileSearch className="mr-1 h-4 w-4" /> To Note
        </Button>
        <Button size="sm" variant="outline" asChild disabled={disabled}>
          <Link
            to={onCreateAssetHref}
            state={{
              assetHandoff: {
                title: article.title,
                brief: `Create a blog asset from wiki candidate article: ${article.title}`,
              },
            }}
          >
            <Sparkles className="mr-1 h-4 w-4" /> Create Asset
          </Link>
        </Button>
        <Button size="sm" onClick={onAccept} disabled={disabled || shouldGateAccept} title={shouldGateAccept ? "Reduce weak claims or keep this article in review before accepting it as a draft." : undefined}>
          <CheckCircle2 className="mr-1 h-4 w-4" /> {shouldGateAccept ? "Weak Claims Block Accept" : "Accept as Draft"}
        </Button>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  isUpdating,
  isCloningDraft,
  onAccept,
  onReject,
  onApply,
  onCloneDraft,
}: {
  suggestion: WikiRecompileSuggestion;
  isUpdating: boolean;
  isCloningDraft: boolean;
  onAccept: () => void;
  onReject: () => void;
  onApply: () => void;
  onCloneDraft: () => void;
}) {
  const score = typeof suggestion.metadata_?.score === "number" ? suggestion.metadata_.score : null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{suggestion.trigger_type}</Badge>
            <Badge variant="outline">{getReviewStatusLabel(suggestion.status)}</Badge>
            {score !== null && <span className="text-xs text-muted-foreground">score {score}</span>}
          </div>
          <h2 className="mt-2 font-medium">
            <Link className="hover:text-primary" to={`/wiki/${encodeURIComponent(suggestion.wiki_id)}`}>
              {suggestion.wiki_title || suggestion.wiki_id}
            </Link>
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{suggestion.reason}</p>
          {suggestion.evidence_preview && (
            <p className="mt-3 line-clamp-3 rounded-md bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
              {suggestion.evidence_preview}
            </p>
          )}
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Trigger: {suggestion.trigger_id}
          </p>
          {suggestion.status === "accepted" && (
            <p className="mt-2 text-xs text-muted-foreground">
              This page has been marked for update. Prefer cloning a draft, updating that draft, then marking the reminder updated.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {suggestion.status === "pending" && (
            <>
              <Button size="sm" variant="outline" onClick={onReject} disabled={isUpdating}>
                <XCircle className="mr-1 h-4 w-4" /> Dismiss
              </Button>
              <Button size="sm" variant="outline" onClick={onCloneDraft} disabled={isCloningDraft}>
                <Copy className="mr-1 h-4 w-4" /> {isCloningDraft ? "Cloning…" : "Clone Draft"}
              </Button>
              <Button size="sm" onClick={onAccept} disabled={isUpdating}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Needs Update
              </Button>
            </>
          )}
          {suggestion.status === "accepted" && (
            <>
              <Button size="sm" variant="outline" onClick={onCloneDraft} disabled={isCloningDraft}>
                <Copy className="mr-1 h-4 w-4" /> {isCloningDraft ? "Cloning…" : "Clone Draft"}
              </Button>
              <Button size="sm" onClick={onApply} disabled={isUpdating}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Updated
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
