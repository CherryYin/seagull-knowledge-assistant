import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchResultCard } from "@/components/SearchResultCard";
import { searchApi, type SearchResult } from "@/lib/api";

const MODES = ["auto", "vector", "sql", "hybrid"] as const;

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<string>("auto");
  const [submitted, setSubmitted] = useState("");

  const { data: results, isLoading } = useQuery({
    queryKey: ["search", submitted, mode],
    queryFn: () => searchApi.search({ query: submitted, mode, top_k: 20 }),
    enabled: !!submitted,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) setSubmitted(query.trim());
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">Search Knowledge Base</h1>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes and sources..."
                className="pl-9"
              />
            </div>
            <Button type="submit" disabled={!query.trim()}>Search</Button>
          </div>

          {/* Mode selector */}
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Mode:</span>
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                  mode === m
                    ? "bg-primary/20 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </form>

        {/* Results */}
        <div className="mt-6 space-y-3">
          {isLoading && (
            <p className="text-sm text-muted-foreground">Searching...</p>
          )}

          {results && results.length === 0 && (
            <p className="text-sm text-muted-foreground">No results found.</p>
          )}

          {results?.map((r) => (
            <SearchResultCard key={r.id} result={r} />
          ))}
        </div>
      </div>
    </div>
  );
}
