import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, Lightbulb, Network, ScrollText, Sparkles, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReferenceList } from "@/components/ReferenceList";
import { type ReferenceItem } from "@/components/ReferenceChips";
import { ModuleSectionNav } from "@/components/SectionNav";
import { wikiApi, type WikiArticleDraft, type WikiInsightCandidate, type WikiMiningRunDetail } from "@/lib/api";

export function WikiDiscoveryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedInsightIds, setSelectedInsightIds] = useState<number[]>([]);
  const [selectedArticleIds, setSelectedArticleIds] = useState<number[]>([]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-mining-runs", "discovery"],
    queryFn: () => wikiApi.miningRuns({ limit: 12 }),
  });

  const runs = data?.items ?? [];
  const detailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ["wiki-mining-run", run.id, "discovery"],
      queryFn: () => wikiApi.miningRun(run.id),
      enabled: !!run.id,
    })),
  });

  const loadingDetails = detailQueries.some((query) => query.isLoading);
  const detailError = detailQueries.find((query) => query.error)?.error;

  const updateInsightMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "accepted" | "rejected" }) => wikiApi.updateMiningInsight(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const acceptArticleMutation = useMutation({
    mutationFn: (article: WikiArticleDraft) =>
      wikiApi.updateMiningArticle(article.id, {
        status: "accepted",
        wiki_title: article.title,
        page_type: article.page_type,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  const rejectArticleMutation = useMutation({
    mutationFn: (articleId: number) => wikiApi.updateMiningArticle(articleId, { status: "rejected" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const deleteInsightMutation = useMutation({
    mutationFn: (insightId: number) => wikiApi.deleteMiningInsight(insightId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const deleteArticleMutation = useMutation({
    mutationFn: (articleId: number) => wikiApi.deleteMiningArticle(articleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
    },
  });

  const discoveryData = useMemo(() => {
    const details = detailQueries.map((query) => query.data).filter(Boolean) as WikiMiningRunDetail[];
    const insights = details.flatMap((detail) => detail.insights)
      .filter((item) => (item.metadata_?.candidate_kind === "knowledge_entity"))
      .sort((left, right) => right.id - left.id);
    const articles = details.flatMap((detail) => detail.articles)
      .filter((item) => item.metadata_?.origin === "wiki_concept_discovery")
      .sort((left, right) => right.id - left.id);
    return { details, insights, articles };
  }, [detailQueries]);

  async function bulkRejectInsights() {
    await Promise.all(selectedInsightIds.map((id) => wikiApi.updateMiningInsight(id, "rejected")));
    setSelectedInsightIds([]);
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
  }

  async function bulkDeleteInsights() {
    await Promise.all(selectedInsightIds.map((id) => wikiApi.deleteMiningInsight(id)));
    setSelectedInsightIds([]);
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
  }

  async function bulkRejectArticles() {
    await Promise.all(selectedArticleIds.map((id) => wikiApi.updateMiningArticle(id, { status: "rejected" })));
    setSelectedArticleIds([]);
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
  }

  async function bulkDeleteArticles() {
    await Promise.all(selectedArticleIds.map((id) => wikiApi.deleteMiningArticle(id)));
    setSelectedArticleIds([]);
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-runs"] });
    queryClient.invalidateQueries({ queryKey: ["wiki-mining-run"] });
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <ModuleSectionNav parent="review" active="Wiki Discovery" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Wiki Discovery</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Topic & Entity Discovery</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Review automatically discovered concepts and entity-like wiki candidates from mining runs. By default, mining looks at materials ingested in the last 2 days so discovery stays focused on recent inputs.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate("/review/wiki-suggestions")}>
                <Lightbulb className="h-4 w-4" /> Wiki Refresh
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate("/chat", {
                  state: {
                    objectRef: { object_type: "discover", object_id: "wiki-discovery", title: "Wiki Discovery" },
                    workflowId: "mine-wiki-candidates",
                    promptSeed: "Review recent wiki discovery candidates. Cluster the strongest topic/entity candidates, identify reusable wiki-worthy concepts, and separate weak noisy findings.",
                  },
                })}
              >
                <Bot className="h-4 w-4" /> Open Agent Workflow
              </Button>
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-3">
          <StatCard title="Mining Runs" value={String(runs.length)} description="Recent mining runs scanned for discovery outputs." />
          <StatCard title="Entity Insights" value={String(discoveryData.insights.length)} description="Insights with candidate kind = knowledge entity." />
          <StatCard title="Concept Articles" value={String(discoveryData.articles.length)} description="Candidate wiki articles produced by concept discovery." />
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Network className="h-5 w-5 text-primary" /> Entity & Topic Candidates
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={bulkRejectInsights} disabled={selectedInsightIds.length === 0}>
                  <XCircle className="h-4 w-4" /> Reject Selected
                </Button>
                <Button size="sm" variant="outline" onClick={bulkDeleteInsights} disabled={selectedInsightIds.length === 0}>
                  Delete Selected
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading || loadingDetails ? <p className="text-sm text-muted-foreground">Loading discovery candidates…</p> : null}
            {error ? <p className="text-sm text-destructive">Failed to load mining runs.</p> : null}
            {detailError ? <p className="text-sm text-destructive">Failed to load some mining run details.</p> : null}
            {!isLoading && !loadingDetails && discoveryData.insights.length === 0 ? (
              <p className="text-sm text-muted-foreground">No topic/entity discovery insights yet.</p>
            ) : null}
            {discoveryData.insights.map((item) => (
              <DiscoveryInsightCard
                key={item.id}
                item={item}
                selected={selectedInsightIds.includes(item.id)}
                onToggleSelected={() => setSelectedInsightIds((prev) => prev.includes(item.id) ? prev.filter((value) => value !== item.id) : [...prev, item.id])}
                onAccept={() => updateInsightMutation.mutate({ id: item.id, status: "accepted" })}
                onReject={() => updateInsightMutation.mutate({ id: item.id, status: "rejected" })}
                onDelete={() => deleteInsightMutation.mutate(item.id)}
                disabled={updateInsightMutation.isPending || deleteInsightMutation.isPending}
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-5 w-5 text-primary" /> Concept Discovery Articles
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={bulkRejectArticles} disabled={selectedArticleIds.length === 0}>
                  <XCircle className="h-4 w-4" /> Reject Selected
                </Button>
                <Button size="sm" variant="outline" onClick={bulkDeleteArticles} disabled={selectedArticleIds.length === 0}>
                  Delete Selected
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!isLoading && !loadingDetails && discoveryData.articles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No concept-discovery candidate articles yet.</p>
            ) : null}
            {discoveryData.articles.map((article) => (
              <DiscoveryArticleCard
                key={article.id}
                article={article}
                selected={selectedArticleIds.includes(article.id)}
                onToggleSelected={() => setSelectedArticleIds((prev) => prev.includes(article.id) ? prev.filter((value) => value !== article.id) : [...prev, article.id])}
                onAccept={() => acceptArticleMutation.mutate(article)}
                onReject={() => rejectArticleMutation.mutate(article.id)}
                onDelete={() => deleteArticleMutation.mutate(article.id)}
                disabled={acceptArticleMutation.isPending || rejectArticleMutation.isPending || deleteArticleMutation.isPending}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DiscoveryInsightCard({ item, selected, onToggleSelected, onAccept, onReject, onDelete, disabled }: { item: WikiInsightCandidate; selected: boolean; onToggleSelected: () => void; onAccept: () => void; onReject: () => void; onDelete: () => void; disabled?: boolean }) {
  const entityType = typeof item.metadata_?.entity_type === "string" ? item.metadata_?.entity_type : null;
  const recommendation = typeof item.metadata_?.recommendation === "string" ? item.metadata_?.recommendation : null;
  const score = item.metadata_?.signals && typeof item.metadata_.signals === "object" ? (item.metadata_.signals as Record<string, unknown>).score : null;
  return (
    <div className="rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={selected} onChange={onToggleSelected} className="h-4 w-4" />
            <p className="font-medium">{item.title}</p>
            {entityType ? <Badge variant="secondary">{entityType}</Badge> : null}
            {recommendation ? <Badge variant="outline">{recommendation.replace(/_/g, " ")}</Badge> : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{item.summary}</p>
        </div>
        {typeof score === "number" ? <Badge variant="outline">score {score.toFixed(2)}</Badge> : null}
      </div>
      <ReferenceList items={(item.evidence_refs ?? []) as ReferenceItem[]} title="Evidence" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onAccept} disabled={disabled || item.status === "accepted"}>
          <CheckCircle2 className="h-4 w-4" /> Accept Insight
        </Button>
        <Button size="sm" variant="outline" onClick={onReject} disabled={disabled || item.status === "rejected"}>
          <XCircle className="h-4 w-4" /> Reject
        </Button>
        <Button size="sm" variant="outline" onClick={onDelete} disabled={disabled}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function DiscoveryArticleCard({ article, selected, onToggleSelected, onAccept, onReject, onDelete, disabled }: { article: WikiArticleDraft; selected: boolean; onToggleSelected: () => void; onAccept: () => void; onReject: () => void; onDelete: () => void; disabled?: boolean }) {
  const entityType = typeof article.metadata_?.entity_type === "string" ? article.metadata_?.entity_type : null;
  const recommendation = typeof article.metadata_?.recommendation === "string" ? article.metadata_?.recommendation : null;
  return (
    <div className="rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={selected} onChange={onToggleSelected} className="h-4 w-4" />
            <p className="font-medium">{article.title}</p>
            <Badge variant="secondary">{article.page_type}</Badge>
            {entityType ? <Badge variant="outline">{entityType}</Badge> : null}
            {recommendation ? <Badge variant="outline">{recommendation.replace(/_/g, " ")}</Badge> : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{article.summary || article.content}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link
            to="/assets/new"
            state={{
              assetHandoff: {
                title: `${article.title} Issue`,
                brief: `Create a newsletter issue from wiki concept discovery article: ${article.title}`,
                asset_type: "newsletter_issue",
              },
            }}
          >
            <ScrollText className="h-4 w-4" /> Create Asset
          </Link>
        </Button>
      </div>
      <ReferenceList items={(article.evidence_refs ?? []) as ReferenceItem[]} title="Evidence" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onAccept} disabled={disabled || article.status === "accepted"}>
          <CheckCircle2 className="h-4 w-4" /> Accept as Draft
        </Button>
        <Button size="sm" variant="outline" onClick={onReject} disabled={disabled || article.status === "rejected"}>
          <XCircle className="h-4 w-4" /> Reject
        </Button>
        <Button size="sm" variant="outline" onClick={onDelete} disabled={disabled}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function StatCard({ title, value, description }: { title: string; value: string; description: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
