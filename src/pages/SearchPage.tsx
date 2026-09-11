import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchResultCard } from "@/components/SearchResultCard";
import { StateMessage } from "@/components/StateMessage";
import { searchApi, type SearchResult } from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

const MODES = ["auto", "vector", "sql", "hybrid"] as const;

export function SearchPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const submitted = searchParams.get("q")?.trim() ?? "";
  const requestedMode = searchParams.get("mode");
  const mode = requestedMode && MODES.includes(requestedMode as typeof MODES[number]) ? requestedMode : "auto";
  const [query, setQuery] = useState(submitted);

  useEffect(() => {
    setQuery(submitted);
  }, [submitted]);

  const { data: results, isLoading, isError, refetch } = useQuery({
    queryKey: ["search", submitted, mode],
    queryFn: () => searchApi.search({ query: submitted, mode, top_k: 20 }),
    enabled: !!submitted,
  });
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>(
    "search-results",
    !submitted || results !== undefined || isError,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery) return;
    const next = new URLSearchParams(searchParams);
    next.set("q", nextQuery);
    setSearchParams(next, { replace: true });
  };

  const updateMode = (nextMode: typeof MODES[number]) => {
    const next = new URLSearchParams(searchParams);
    if (nextMode === "auto") next.delete("mode");
    else next.set("mode", nextMode);
    setSearchParams(next, { replace: true });
  };

	return (
			<div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto"
          data-route-scroll="search-results"
        >
			<div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
				<ModuleSectionNav parent="knowledge" active="Search" />
				<div>
					<h1 className="text-2xl font-bold">Search Knowledge</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Search across saved Sources, Notes, Wiki Pages, and Assets from one Knowledge workspace.
					</p>
				</div>

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
                onClick={() => updateMode(m)}
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
				<div className="space-y-3">
          {isLoading && (
            <StateMessage title="Searching knowledge" description="Checking Sources, Notes, Wiki Pages, and Assets." />
          )}

          {isError && (
            <StateMessage
              tone="error"
              title="Search failed"
              description="The knowledge index could not be queried. Try again, or inspect System Jobs if indexing may be stuck."
              actionLabel="Retry search"
              onAction={() => refetch()}
            />
          )}

          {results && results.length === 0 && (
            <StateMessage
              title="No results found"
              description="Try a broader query, switch to hybrid mode, or ask Agent to research the topic using your existing knowledge first."
              actionLabel="Open Research Agent"
              onAction={() => navigate("/chat", { state: { workflowId: "research-topic", promptSeed: `Research this topic: ${submitted}`, backTo: `${location.pathname}${location.search}`, backLabel: "Back to Search" } })}
            />
          )}

          {results && results.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>Results identify each Knowledge Record so you can distinguish raw Source evidence, user Notes, maintained Wiki Pages, and writing Assets.</p>
              <p>Use the quick actions to open, ask Agent, or turn a result into an asset draft without copying IDs around.</p>
            </div>
          )}

          {results?.map((r) => (
            <SearchResultCard key={`${r.type}-${r.id}`} result={r} />
          ))}
        </div>
      </div>
    </div>
  );
}
