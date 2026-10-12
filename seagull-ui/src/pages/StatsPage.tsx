import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, RefreshCw, ArrowUpDown, StickyNote, FileText, MessageSquare, Newspaper } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { knowledgeApi, type KnowledgeStatsItem, type DashboardData } from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetStatisticsPanel } from "@/pages/AssetJourneyStatsPage";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const SORT_OPTIONS = [
  { value: "total_count", label: "Total" },
  { value: "search_count", label: "Search" },
  { value: "retrieval_count", label: "Retrieval" },
  { value: "reference_count", label: "Reference" },
] as const;

const TYPE_OPTIONS = [
  { value: "", label: "All" },
  { value: "note", label: "Notes" },
  { value: "source", label: "Sources" },
] as const;

const PAGE_SIZE = 30;

const CHART_COLORS = {
  notes: "#10b981",
  sources: "#6366f1",
  chats: "#f59e0b",
};

export function StatsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = requestedTab === "knowledge" || requestedTab === "assets" ? requestedTab : "overview";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <ModuleSectionNav parent="settings" active="Dashboard" />
        <header className="rounded-2xl border bg-card p-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">System Dashboard</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Knowledge growth, recorded usage, and functional blockers across all your Assets. Each view states what is measured and what remains unknown.</p>
        </header>
        <Tabs value={activeTab} activationMode="manual" onValueChange={value => {
          const next = new URLSearchParams(searchParams);
          if (value === "overview") next.delete("tab");
          else next.set("tab", value);
          setSearchParams(next);
        }}>
          <TabsList aria-label="Dashboard sections" className="h-auto w-full justify-start gap-1 overflow-x-auto p-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="knowledge">Knowledge Usage</TabsTrigger>
            <TabsTrigger value="assets">Asset Diagnostics</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="h-auto"><KnowledgeOverviewPanel /></TabsContent>
          <TabsContent value="knowledge" className="h-auto"><KnowledgeUsagePanel /></TabsContent>
          <TabsContent value="assets" className="h-auto"><AssetStatisticsPanel /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function KnowledgeOverviewPanel() {
  const dashboardQuery = useQuery({ queryKey: ["dashboard"], queryFn: () => knowledgeApi.dashboard() });
  const dashboard = dashboardQuery.data;

  return <section aria-label="Knowledge overview" className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Knowledge Overview</h2><p className="mt-1 text-sm text-muted-foreground">Saved knowledge, recent creation activity, and category distributions. Counts are not measures of quality or adoption.</p></div>
      <Button variant="outline" disabled={dashboardQuery.isFetching} onClick={() => void dashboardQuery.refetch()}><RefreshCw className="h-4 w-4" />Refresh overview</Button>
    </div>
    {dashboardQuery.isLoading && <p role="status" className="rounded-xl border p-8 text-center text-muted-foreground">Loading knowledge overview…</p>}
    {dashboardQuery.isError && <div role="alert" className="rounded-xl border border-destructive/30 p-6"><p className="text-destructive">Could not load the knowledge overview. Counts are unavailable, not zero.</p><Button className="mt-3" variant="outline" onClick={() => void dashboardQuery.refetch()}>Retry overview</Button></div>}
    {dashboard && !dashboardQuery.isError && <>
      <OverviewCards counts={dashboard.counts} />
      <div className="grid gap-6 lg:grid-cols-2">
        {dashboard.trends.length ? <TrendChart trends={dashboard.trends} /> : <DashboardEmpty title="7-Day Activity" detail="No recorded creation activity in this period." />}
        {dashboard.category_distribution.length ? <CategoryChart distribution={dashboard.category_distribution} /> : <DashboardEmpty title="Category Distribution" detail="No categorized knowledge to display yet." />}
      </div>
      {dashboard.note_type_distribution.length ? <NoteTypeChart distribution={dashboard.note_type_distribution} /> : <DashboardEmpty title="Note Types" detail="No saved notes to group by type yet." />}
    </>}
  </section>;
}

function DashboardEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-xl border bg-card p-6"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm text-muted-foreground">{detail}</p></div>;
}

function KnowledgeUsagePanel() {
  const [sortBy, setSortBy] = useState("total_count");
  const [itemType, setItemType] = useState("");
  const [titleQuery, setTitleQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(0);

  const statsQuery = useQuery({
    queryKey: ["knowledge-stats", sortBy, itemType, titleQuery, page],
    queryFn: () =>
      knowledgeApi.stats({
        sort_by: sortBy,
        item_type: itemType || undefined,
        title: titleQuery || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });
  const { data: statsData, isLoading: statsLoading } = statsQuery;

  const items = statsData?.items ?? [];
  const total = statsData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setTitleQuery(searchInput);
    setPage(0);
  }

  return (
        <section aria-label="Knowledge usage" className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-xl font-semibold">Knowledge Rankings</h2><p className="mt-1 text-sm text-muted-foreground">Recorded search, retrieval, and reference counts for Sources and Notes. Usage does not establish that an Asset was adopted.</p></div>
            <Button variant="outline" disabled={statsQuery.isFetching} onClick={() => void statsQuery.refetch()}><RefreshCw className="h-4 w-4" />Refresh usage</Button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <form onSubmit={handleSearch} className="flex gap-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search title..."
                  aria-label="Search knowledge titles"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-9 h-9 w-52"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" className="h-9">
                Search
              </Button>
              {titleQuery && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9"
                  onClick={() => {
                    setSearchInput("");
                    setTitleQuery("");
                    setPage(0);
                  }}
                >
                  Clear
                </Button>
              )}
            </form>

            <div className="flex gap-1 rounded-md border border-border p-0.5">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  aria-pressed={itemType === opt.value}
                  onClick={() => {
                    setItemType(opt.value);
                    setPage(0);
                  }}
                  className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
                    itemType === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 ml-auto">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                aria-label="Knowledge ranking sort order"
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  setPage(0);
                }}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    Sort by {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {statsQuery.isError && <div role="alert" className="rounded-xl border border-destructive/30 p-6"><p className="text-destructive">Could not load knowledge usage. Rankings are unavailable, not empty.</p><Button className="mt-3" variant="outline" onClick={() => void statsQuery.refetch()}>Retry usage</Button></div>}
          {!statsQuery.isError && <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-10">#</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Title</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-20">Type</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground w-20">Search</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground w-24">Retrieval</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground w-24">Reference</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground w-20">Total</th>
                </tr>
              </thead>
              <tbody>
                {statsLoading && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-muted-foreground">
                      Loading...
                    </td>
                  </tr>
                )}
                {!statsLoading && items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-muted-foreground">
                      No stats yet. Use search or chat to start tracking.
                    </td>
                  </tr>
                )}
                {items.map((item, idx) => (
                  <StatsRow key={`${item.item_id}-${item.item_type}`} item={item} rank={page * PAGE_SIZE + idx + 1} />
                ))}
              </tbody>
            </table>
          </div>}

          {!statsQuery.isError && totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-muted-foreground">
                {total} items total
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span className="flex items-center px-3 text-sm text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </section>
  );
}

function OverviewCards({ counts }: { counts: DashboardData["counts"] }) {
  const cards = [
    { label: "Notes", value: counts.notes, icon: StickyNote, color: "text-emerald-500" },
    { label: "Sources", value: counts.sources, icon: FileText, color: "text-indigo-500" },
    { label: "Chats", value: counts.chats, icon: MessageSquare, color: "text-amber-500" },
    { label: "Digest Pending", value: counts.digest_pending, icon: Newspaper, color: "text-orange-500" },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-border bg-card p-4 flex items-center gap-4"
        >
          <div className={`rounded-md bg-muted p-2.5 ${c.color}`}>
            <c.icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-bold">{c.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ trends }: { trends: DashboardData["trends"] }) {
  const data = trends.map((t) => ({
    ...t,
    date: t.date.slice(5),
  }));

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">7-Day Activity</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} className="text-muted-foreground" />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} className="text-muted-foreground" />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              borderColor: "hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="notes" stackId="a" fill={CHART_COLORS.notes} name="Notes" radius={[0, 0, 0, 0]} />
          <Bar dataKey="sources" stackId="a" fill={CHART_COLORS.sources} name="Sources" />
          <Bar dataKey="chats" stackId="a" fill={CHART_COLORS.chats} name="Chats" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CategoryChart({ distribution }: { distribution: DashboardData["category_distribution"] }) {
  const data = distribution
    .map((d) => ({
      name: d.display_name,
      total: d.notes + d.sources,
      notes: d.notes,
      sources: d.sources,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">Category Distribution</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              borderColor: "hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="notes" stackId="a" fill={CHART_COLORS.notes} name="Notes" />
          <Bar dataKey="sources" stackId="a" fill={CHART_COLORS.sources} name="Sources" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function NoteTypeChart({ distribution }: { distribution: DashboardData["note_type_distribution"] }) {
  const data = distribution
    .map((d) => ({ name: d.type, count: d.count }))
    .sort((a, b) => b.count - a.count);

  const colors = ["#10b981", "#6366f1", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

  return (
    <div className="rounded-lg border border-border bg-card p-4 mb-8">
      <h3 className="text-sm font-semibold mb-3">Note Types</h3>
      <div className="flex flex-wrap gap-3">
        {data.map((d, i) => (
          <div
            key={d.name}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
          >
            <span
              className="h-3 w-3 rounded-full shrink-0"
              style={{ backgroundColor: colors[i % colors.length] }}
            />
            <span className="text-sm">{d.name}</span>
            <span className="text-sm font-bold">{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsRow({ item, rank }: { item: KnowledgeStatsItem; rank: number }) {
  const href =
    item.item_type === "note"
      ? `/notes/${encodeURIComponent(item.item_id)}`
      : `/sources/${encodeURIComponent(item.item_id)}`;

  return (
    <tr className="border-b border-border/50 hover:bg-accent/30 transition-colors">
      <td className="px-4 py-2.5 text-muted-foreground font-mono text-xs">{rank}</td>
      <td className="px-4 py-2.5">
        <Link to={href} className="hover:underline font-medium text-foreground">
          {item.title}
        </Link>
        {item.category_name && item.category_name !== "general" && (
          <Badge variant="secondary" className="ml-2 text-[10px]">
            {item.category_name}
          </Badge>
        )}
      </td>
      <td className="px-4 py-2.5">
        <Badge variant={item.item_type === "note" ? "default" : "source"} className="text-[10px]">
          {item.item_type}
        </Badge>
      </td>
      <td className="px-4 py-2.5 text-right font-mono">{item.search_count}</td>
      <td className="px-4 py-2.5 text-right font-mono">{item.retrieval_count}</td>
      <td className="px-4 py-2.5 text-right font-mono">{item.reference_count}</td>
      <td className="px-4 py-2.5 text-right font-mono font-bold">{item.total_count}</td>
    </tr>
  );
}
