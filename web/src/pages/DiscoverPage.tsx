import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, CheckCircle2, ChevronDown, ChevronRight, Compass, Github, Globe2, Newspaper, RefreshCw, Rss, Search, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { discoveryApi, DiscoveryItem, DiscoveryProvider } from "@/lib/api";
import { paperDiscoveryApi, type PaperDiscoveryProfile } from "@/lib/api/paper-discovery";
import { ModuleSectionNav } from "@/components/SectionNav";
import { StateMessage } from "@/components/StateMessage";
import { DiscoveryDetailDialog, type DiscoveryDetailData } from "@/components/DiscoveryDetailDialog";
import { toDiscoveryDetail } from "@/lib/discovery-detail";

const providerIcons: Record<string, typeof BookOpen> = {
  arxiv: BookOpen,
  github: Github,
  news: Newspaper,
  rss: Rss,
  web: Globe2,
};

export function DiscoverPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [webQuery, setWebQuery] = useState("");
  const [webResultsJson, setWebResultsJson] = useState("[]");
  const [webImportError, setWebImportError] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<DiscoveryProvider | null>(null);
  const [statusFilter, setStatusFilter] = useState<"recommended" | "kept">("recommended");
  const [activeItem, setActiveItem] = useState<DiscoveryDetailData | null>(null);
  const [paperDiscoveryOpen, setPaperDiscoveryOpen] = useState(true);
  const { data, isLoading, error } = useQuery({
    queryKey: ["discovery-items", statusFilter, providerFilter],
    queryFn: () => discoveryApi.list({ status: statusFilter, provider: providerFilter ?? undefined, limit: 100 }),
  });
  const { data: allData } = useQuery({
    queryKey: ["discovery-items", "recommended", "all-counts"],
    queryFn: () => discoveryApi.list({ status: "recommended", limit: 200 }),
  });
  const { data: paperProfiles, isLoading: paperProfilesLoading } = useQuery({
    queryKey: ["paper-discovery-profiles"],
    queryFn: () => paperDiscoveryApi.listProfiles(),
  });
  const activePaperProfile = paperProfiles?.items?.[0] ?? null;
  const { data: paperCandidates, isLoading: paperCandidatesLoading } = useQuery({
    queryKey: ["paper-discovery-candidates", activePaperProfile?.id],
    queryFn: () => paperDiscoveryApi.listCandidates(activePaperProfile!.id, 12),
    enabled: Boolean(activePaperProfile?.id),
  });
  const runPaperProfileMutation = useMutation({
    mutationFn: (profile: PaperDiscoveryProfile) => paperDiscoveryApi.runProfile(profile.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper-discovery-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["paper-discovery-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["discovery-items"] });
    },
  });
  const generateMutation = useMutation({
    mutationFn: () => discoveryApi.refreshRecommendations({ providers: ["arxiv", "github", "news"], limit: 100 }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["discovery-items", "recommended"] }),
  });
  const feedbackMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "keep" | "save" | "dismiss" }) => discoveryApi.feedback(id, action),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["discovery-items"] });
      if (variables.action === "save" && result.source?.id) {
        navigate(`/sources/${encodeURIComponent(result.source.id)}`, { state: { backTo: "/discover", backLabel: "Back to Discover" } });
      }
    },
  });
  const webIngestMutation = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(webResultsJson);
      if (!Array.isArray(parsed)) throw new Error("Paste a JSON array of web results");
      return discoveryApi.ingestWebResults({ query: webQuery || "manual web discovery", items: parsed });
    },
    onMutate: () => setWebImportError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["discovery-items", "recommended"] }),
    onError: (err) => setWebImportError(err instanceof Error ? err.message : "Failed to import web results"),
  });
  const webSearchMutation = useMutation({
    mutationFn: () => {
      const query = webQuery.trim();
      if (!query) throw new Error("Enter a search query first");
      return discoveryApi.searchWeb({ query, max_results: 10 });
    },
    onMutate: () => setWebImportError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["discovery-items", "recommended"] }),
    onError: (err) => setWebImportError(err instanceof Error ? err.message : "Failed to search web"),
  });

  const items = data?.items ?? [];
  const allItems = allData?.items ?? items;
  const providerCounts = allItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.provider] = (acc[item.provider] ?? 0) + 1;
    return acc;
  }, {});
  const activeProviderLabel = providerFilter ? providerFilter[0].toUpperCase() + providerFilter.slice(1) : "All";

  function askAgentAboutDiscovery(item: DiscoveryItem) {
    navigate("/chat", {
      state: {
        objectRef: {
          object_type: "discover",
          object_id: String(item.id),
          title: item.title,
          url: item.url ?? null,
        },
        workflowId: "mine-wiki-candidates",
        promptSeed: `Use this discovery item to evaluate whether it is worth importing into the knowledge base and whether it could eventually support a stable wiki topic.\n\nTitle: ${item.title}\nProvider: ${item.provider}\nURL: ${item.url || "n/a"}\nSummary: ${item.summary || "n/a"}`,
      },
    });
  }

  function openDiscoveryDetail(item: DiscoveryItem) {
    setActiveItem(toDiscoveryDetail(item));
  }

  return (
    <>
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
		<ModuleSectionNav parent="discover" active="Recommended" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-primary/10 p-3 text-primary"><Compass className="h-6 w-6" /></div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">Discover</h1>
				<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
					Unsaved external candidates from connector searches and trends. Imported Sources are reviewed in Sources instead of appearing here again.
				</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  navigate("/chat", {
                    state: {
                      objectRef: {
                        object_type: "discover",
                        object_id: "recommended-discoveries",
                        title: "Discovery Queue",
                      },
                      workflowId: "review-discovery-batch",
                      promptSeed: "Review my current discovery queue. Cluster the best candidates, identify what to save now, what to research next, and what could support future wiki pages.",
                    },
                  })
                }
              >
                <Bot className="mr-2 h-4 w-4" /> Discovery Workflow
              </Button>
              <Button onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
                {generateMutation.isPending && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />} Refresh Recommendations
              </Button>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <Button size="icon" variant="ghost" className="mt-0.5 h-8 w-8 shrink-0" onClick={() => setPaperDiscoveryOpen((open) => !open)} aria-label={paperDiscoveryOpen ? "Collapse Paper Discovery" : "Expand Paper Discovery"}>
                {paperDiscoveryOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </Button>
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold">Paper Discovery</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Runs your saved paper topic profile and reuses the same recommendation cards below.
                </p>
              </div>
            </div>
            {activePaperProfile && (
              <Button size="sm" onClick={() => { setPaperDiscoveryOpen(true); runPaperProfileMutation.mutate(activePaperProfile); }} disabled={runPaperProfileMutation.isPending}>
                <RefreshCw className="mr-1 h-4 w-4" /> Run {activePaperProfile.name}
              </Button>
            )}
          </div>

          {paperDiscoveryOpen && (
            <>
          {paperProfilesLoading ? (
            <div className="mt-4 text-sm text-muted-foreground">Loading paper discovery profiles…</div>
          ) : !activePaperProfile ? (
            <div className="mt-4">
              <StateMessage
                tone="empty"
                title="No paper discovery profile yet"
                description="Create a paper discovery profile first, then run it from this page or the API."
              />
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{activePaperProfile.name}</Badge>
                <Badge variant="outline">{activePaperProfile.schedule}</Badge>
                <Badge variant="outline">{activePaperProfile.mode}</Badge>
                <Badge variant="outline">{activePaperProfile.discovery_window_days}d window</Badge>
              </div>

              {paperCandidatesLoading ? (
                <div className="text-sm text-muted-foreground">Loading discovered papers…</div>
              ) : !paperCandidates?.items?.length ? (
                <StateMessage
                  tone="empty"
                  title="No paper candidates yet"
                  description="Run the active paper profile to populate new papers here."
                />
              ) : (
                <div className="space-y-3">
                  {paperCandidates.items.slice(0, 6).map((item) => (
                    <DiscoveryCard
                      key={`paper-${item.id}`}
                      item={item}
                      isUpdating={feedbackMutation.isPending}
                      onDismiss={() => feedbackMutation.mutate({ id: item.id, action: "dismiss" })}
                      onKeep={() => feedbackMutation.mutate({ id: item.id, action: "keep" })}
                      onSave={() => feedbackMutation.mutate({ id: item.id, action: "save" })}
                      onAskAgent={() => askAgentAboutDiscovery(item)}
                      onOpenDetail={() => openDiscoveryDetail(item)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
            </>
          )}
        </section>

        <div className="grid gap-4 md:grid-cols-5">
          <MetricCard label="Recommended" value={allData?.total ?? data?.total ?? 0} icon={Sparkles} active={!providerFilter} onClick={() => setProviderFilter(null)} />
          <MetricCard label="GitHub" value={providerCounts.github ?? 0} icon={Github} active={providerFilter === "github"} onClick={() => setProviderFilter("github")} />
          <MetricCard label="News" value={providerCounts.news ?? 0} icon={Newspaper} active={providerFilter === "news"} onClick={() => setProviderFilter("news")} />
          <MetricCard label="RSS" value={providerCounts.rss ?? 0} icon={Rss} active={providerFilter === "rss"} onClick={() => setProviderFilter("rss")} />
          <MetricCard label="Web" value={providerCounts.web ?? 0} icon={Globe2} active={providerFilter === "web"} onClick={() => setProviderFilter("web")} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={statusFilter === "recommended" ? "default" : "outline"} onClick={() => setStatusFilter("recommended")}>Recommended</Button>
          <Button size="sm" variant={statusFilter === "kept" ? "default" : "outline"} onClick={() => setStatusFilter("kept")}>Kept for later</Button>
        </div>


        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" /> External Web Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Search the web with Tavily, or paste external search results as JSON. Results enter Discovery as Web recommendations ranked by domain quality, memory/profile match, and keep/dismiss preferences.
            </p>
            <Input value={webQuery} onChange={(event) => setWebQuery(event.target.value)} placeholder="Search query, e.g. local-first knowledge graph" />
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={webResultsJson}
              onChange={(event) => setWebResultsJson(event.target.value)}
              placeholder='[{"title":"...","url":"https://...","summary":"...","source_name":"..."}]'
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => webSearchMutation.mutate()} disabled={webSearchMutation.isPending}>
                {webSearchMutation.isPending && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />} Search Web + Import
              </Button>
              <Button variant="outline" onClick={() => webIngestMutation.mutate()} disabled={webIngestMutation.isPending}>
                {webIngestMutation.isPending && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />} Import JSON Results
              </Button>
              {(webIngestMutation.data || webSearchMutation.data) && (
                <span className="text-xs text-muted-foreground">
                  Imported: created {(webSearchMutation.data ?? webIngestMutation.data)?.created}, updated {(webSearchMutation.data ?? webIngestMutation.data)?.updated}, skipped {(webSearchMutation.data ?? webIngestMutation.data)?.skipped}.
                </span>
              )}
              {webImportError && <span className="text-xs text-destructive">{webImportError}</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Recommendations · {activeProviderLabel}</CardTitle>
            {isLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-3">
            {error instanceof Error && <p className="text-sm text-destructive">Failed to load discovery items: {error.message}</p>}
            {generateMutation.data && (
              <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                Refresh complete: created {generateMutation.data.created}, updated {generateMutation.data.updated}, skipped {generateMutation.data.skipped}.
              </p>
            )}
            {!isLoading && items.length === 0 && (
              <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                {providerFilter ? `No ${activeProviderLabel} recommendations right now. Click Recommended to clear the filter.` : "No recommendations yet. Search papers or GitHub in Sources, or click Refresh Recommendations after imports/searches exist."}
              </div>
            )}
            {items.map((item) => (
              <DiscoveryCard
                key={item.id}
                item={item}
                isUpdating={feedbackMutation.isPending}
                onKeep={() => feedbackMutation.mutate({ id: item.id, action: "keep" })}
                onSave={() => feedbackMutation.mutate({ id: item.id, action: "save" })}
                onDismiss={() => feedbackMutation.mutate({ id: item.id, action: "dismiss" })}
                onAskAgent={() => askAgentAboutDiscovery(item)}
                onOpenDetail={() => openDiscoveryDetail(item)}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
    <DiscoveryDetailDialog open={Boolean(activeItem)} onOpenChange={(open) => { if (!open) setActiveItem(null); }} item={activeItem} />
    </>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  icon: typeof Sparkles;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="text-left" aria-pressed={active}>
      <Card className={active ? "border-primary bg-primary/5" : "transition-colors hover:border-primary/40 hover:bg-accent/40"}>
        <CardContent className="flex items-center justify-between p-5">
          <div>
            <p className={active ? "text-xs uppercase tracking-wide text-primary" : "text-xs uppercase tracking-wide text-muted-foreground"}>{label}</p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
          </div>
          <Icon className={active ? "h-5 w-5 text-primary" : "h-5 w-5 text-muted-foreground"} />
        </CardContent>
      </Card>
    </button>
  );
}

function DiscoveryCard({
  item,
  isUpdating,
  onKeep,
  onSave,
  onDismiss,
  onAskAgent,
  onOpenDetail,
}: {
  item: DiscoveryItem;
  isUpdating: boolean;
  onKeep: () => void;
  onSave: () => void;
  onDismiss: () => void;
  onAskAgent: () => void;
  onOpenDetail?: () => void;
}) {
  const Icon = providerIcons[item.provider] ?? Sparkles;
  const sourceName = typeof item.payload?.source_name === "string" ? item.payload.source_name : null;
  const publishedAt = typeof item.payload?.published_at === "string" ? item.payload.published_at : null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1"><Icon className="h-3 w-3" /> {item.provider}</Badge>
            <Badge variant="outline">score {Math.round(item.score ?? 0)}</Badge>
            {item.source_id && <Badge variant="secondary">source linked</Badge>}
            {sourceName && <Badge variant="outline">{sourceName}</Badge>}
            {publishedAt && <Badge variant="outline">{new Date(publishedAt).toLocaleDateString()}</Badge>}
          </div>
          <div className="mt-2 flex items-start justify-between gap-3">
            <button type="button" className="text-left font-medium hover:text-primary" onClick={onOpenDetail}>{item.title}</button>
            {onOpenDetail && <Button size="sm" variant="ghost" onClick={onOpenDetail}>Details</Button>}
          </div>
          {item.summary && <p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">{item.summary}</p>}
          {item.why && item.why.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {item.why.map((reason, index) => <Badge key={`${reason}-${index}`} variant="outline">{reason}</Badge>)}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onDismiss} disabled={isUpdating}>
            <XCircle className="mr-1 h-4 w-4" /> Ignore
          </Button>
          <Button size="sm" variant="outline" onClick={onKeep} disabled={isUpdating}>
            <CheckCircle2 className="mr-1 h-4 w-4" /> Keep for later
          </Button>
          <Button size="sm" variant="outline" onClick={onAskAgent} disabled={isUpdating}>
            <Bot className="mr-1 h-4 w-4" /> Ask Agent
          </Button>
          <Button size="sm" onClick={onSave} disabled={isUpdating}>
            <CheckCircle2 className="mr-1 h-4 w-4" /> Import as Source
          </Button>
        </div>
      </div>
    </div>
  );
}
