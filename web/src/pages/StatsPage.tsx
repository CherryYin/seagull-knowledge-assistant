import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowUpDown, StickyNote, FileText, MessageSquare, Newspaper } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { knowledgeApi, type KnowledgeStatsItem, type DashboardData } from "@/lib/api";
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

// --- Rankings table config (preserved from original) ---

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

// --- Colors ---

const CHART_COLORS = {
  notes: "#10b981",
  sources: "#6366f1",
  chats: "#f59e0b",
};

export function StatsPage() {
  // Rankings table state
  const [sortBy, setSortBy] = useState("total_count");
  const [itemType, setItemType] = useState("");
  const [titleQuery, setTitleQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(0);

  const { data: dashboard } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => knowledgeApi.dashboard(),
  });

  const { data: statsData, isLoading: statsLoading } = useQuery({
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

  const items = statsData?.items ?? [];
  const total = statsData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setTitleQuery(searchInput);
    setPage(0);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

        {/* Overview cards */}
        {dashboard && <OverviewCards counts={dashboard.counts} />}

        {/* Charts row */}
        {dashboard && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <TrendChart trends={dashboard.trends} />
            <CategoryChart distribution={dashboard.category_distribution} />
          </div>
        )}

        {/* Note type distribution */}
        {dashboard && dashboard.note_type_distribution.length > 0 && (
          <NoteTypeChart distribution={dashboard.note_type_distribution} />
        )}

        {/* Rankings table */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-4">Knowledge Rankings</h2>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <form onSubmit={handleSearch} className="flex gap-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search title..."
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

          {/* Table */}
          <div className="rounded-lg border border-border overflow-hidden">
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
          </div>

          {totalPages > 1 && (
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
        </div>
      </div>
    </div>
  );
}

// --- Subcomponents ---

function OverviewCards({ counts }: { counts: DashboardData["counts"] }) {
  const cards = [
    { label: "Notes", value: counts.notes, icon: StickyNote, color: "text-emerald-500" },
    { label: "Sources", value: counts.sources, icon: FileText, color: "text-indigo-500" },
    { label: "Chats", value: counts.chats, icon: MessageSquare, color: "text-amber-500" },
    { label: "Digest Pending", value: counts.digest_pending, icon: Newspaper, color: "text-orange-500" },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
        <a href={href} className="hover:underline font-medium text-foreground">
          {item.title}
        </a>
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
