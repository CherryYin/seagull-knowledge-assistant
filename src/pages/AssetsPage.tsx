import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, CalendarClock, FileText, Filter, Newspaper, Search, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { assetsApi, type Asset, type AssetStatus, type AssetType } from "@/lib/api";
import { assetTypeLabel, MANUAL_ASSET_TYPES } from "@/lib/asset-generation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
};

const STATUS_OPTIONS: Array<AssetStatus | "all"> = ["all", "draft", "in_review", "ready_to_export", "exported", "published", "archived"];

export function AssetsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [assetType, setAssetType] = useState<AssetType | "all">("all");
  const [status, setStatus] = useState<AssetStatus | "all">("all");
  const assetsQuery = useQuery({ queryKey: ["assets"], queryFn: () => assetsApi.list({ limit: 100 }) });

  const assets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (assetsQuery.data?.items ?? [])
      .filter((asset) => assetType === "all" || asset.asset_type === assetType)
      .filter((asset) => status === "all" || asset.status === status)
      .filter((asset) => !normalized || [asset.title, asset.brief, asset.draft_content].some((value) => value?.toLowerCase().includes(normalized)))
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }, [assetType, assetsQuery.data, query, status]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Knowledge Deliverables</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Asset Library</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Read, refine, and deliver knowledge Assets created from explicit user needs and traceable Sources, Notes, and Wiki pages.</p>
          </div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="lg" onClick={() => navigate("/assets/newsletter-automation")}><Newspaper className="mr-2 h-4 w-4" />Newsletter Automation</Button><Button size="lg" onClick={() => navigate("/assets/new")}><Sparkles className="mr-2 h-4 w-4" />Create Asset</Button></div>
        </header>

        <Card className="border-primary/20 bg-gradient-to-r from-primary/10 via-primary/5 to-background">
          <CardContent className="grid gap-5 py-6 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <h2 className="text-xl font-semibold">Start with the delivery need, not an empty record</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Choose the audience, objective, format, and evidence. A Harness Session produces the draft; PKG stores it only after you explicitly confirm.</p>
            </div>
            <Button variant="outline" onClick={() => navigate("/assets/new")}>Open generation guide<ArrowRight className="ml-2 h-4 w-4" /></Button>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-sky-500/20">
          <CardContent className="grid gap-5 py-6 md:grid-cols-[auto_1fr_auto] md:items-center">
            <div className="rounded-2xl bg-sky-500/10 p-3 text-sky-700"><CalendarClock className="h-6 w-6" /></div>
            <div><h2 className="text-lg font-semibold">Scheduled technology Newsletter</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">Use recently collected news, RSS articles, and paper discoveries to create a reviewable Newsletter Asset on a daily or weekly schedule.</p></div>
            <Button variant="outline" onClick={() => navigate("/assets/newsletter-automation")}>Configure automation<ArrowRight className="ml-2 h-4 w-4" /></Button>
          </CardContent>
        </Card>

        <section className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div><h2 className="text-xl font-semibold">Your Assets</h2><p className="text-sm text-muted-foreground">{assetsQuery.data?.total ?? 0} total · {assets.length} shown</p></div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-[260px]"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search Assets" className="pl-9" placeholder="Search title, brief, or content" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
              <label className="flex items-center gap-2 rounded-md border bg-background px-3 text-sm"><Filter className="h-4 w-4 text-muted-foreground" /><select aria-label="Asset type filter" className="h-9 bg-transparent outline-none" value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType | "all")}><option value="all">All types</option>{MANUAL_ASSET_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}<option value="newsletter_issue">Newsletter Issue</option></select></label>
              <label className="rounded-md border bg-background px-3 text-sm"><select aria-label="Asset status filter" className="h-9 bg-transparent outline-none" value={status} onChange={(event) => setStatus(event.target.value as AssetStatus | "all")}>{STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item === "all" ? "All statuses" : STATUS_LABELS[item]}</option>)}</select></label>
            </div>
          </div>

          {assetsQuery.isLoading && <div className="rounded-2xl border p-10 text-center text-sm text-muted-foreground">Loading Asset Library…</div>}
          {assetsQuery.isError && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">Could not load Assets.</div>}
          {!assetsQuery.isLoading && !assetsQuery.isError && assets.length === 0 && <EmptyLibrary hasAssets={Boolean(assetsQuery.data?.total)} onCreate={() => navigate("/assets/new")} />}

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const evidenceCount = asset.source_refs.length + asset.note_refs.length + asset.wiki_refs.length;
  const preview = asset.brief?.trim() || asset.draft_content?.replace(/^#+\s+/gm, "").trim().slice(0, 220) || "This Asset does not have a preview yet.";
  return (
    <Link to={`/assets/${encodeURIComponent(asset.id)}`} className="group block h-full">
      <Card className="h-full overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
        <div className="h-1.5 bg-gradient-to-r from-primary via-sky-400 to-transparent" />
        <CardContent className="flex h-full flex-col p-5">
          <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{assetTypeLabel(asset.asset_type)}</Badge><Badge variant="outline">{STATUS_LABELS[asset.status]}</Badge></div>
          <h3 className="mt-4 line-clamp-2 text-xl font-semibold leading-7 group-hover:text-primary">{asset.title}</h3>
          <p className="mt-3 line-clamp-4 text-sm leading-6 text-muted-foreground">{preview}</p>
          <div className="mt-6 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><BookOpen className="h-3.5 w-3.5" />{evidenceCount} evidence records</span>
            <span>{new Date(asset.updated_at).toLocaleDateString()}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EmptyLibrary({ hasAssets, onCreate }: { hasAssets: boolean; onCreate: () => void }) {
  return <div className="rounded-3xl border border-dashed bg-muted/20 px-6 py-16 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><FileText className="h-6 w-6" /></div><h3 className="mt-4 text-lg font-semibold">{hasAssets ? "No Assets match these filters" : "Create your first knowledge Asset"}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{hasAssets ? "Change the search, type, or status filters." : "Start from a real delivery need and selected knowledge evidence. No empty Asset will be created."}</p>{!hasAssets && <Button className="mt-5" onClick={onCreate}>Create Asset</Button>}</div>;
}
