import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { knowledgeApi, type KnowledgeStatsItem } from "@/lib/api";

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

export function StatsPage() {
  const [sortBy, setSortBy] = useState("total_count");
  const [itemType, setItemType] = useState("");
  const [titleQuery, setTitleQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery({
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

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setTitleQuery(searchInput);
    setPage(0);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">Knowledge Stats</h1>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          {/* Title search */}
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

          {/* Type filter */}
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

          {/* Sort */}
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
              {isLoading && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-muted-foreground">
                    Loading...
                  </td>
                </tr>
              )}
              {!isLoading && items.length === 0 && (
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

        {/* Pagination */}
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
