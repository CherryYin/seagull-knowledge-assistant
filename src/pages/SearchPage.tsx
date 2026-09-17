import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Filter, Search as SearchIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModuleSectionNav } from "@/components/SectionNav";
import { SearchResultCard } from "@/components/SearchResultCard";
import { StateMessage } from "@/components/StateMessage";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import {
  libraryApi,
  type LibraryEntityType,
  type LibraryMediaType,
} from "@/lib/api";

const ENTITY_OPTIONS: Array<{ value: LibraryEntityType; label: string }> = [
  { value: "source", label: "Sources" },
  { value: "note", label: "Notes" },
  { value: "wiki", label: "Wiki" },
];
const MEDIA_OPTIONS: Array<{ value: LibraryMediaType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
];
const MODES = ["auto", "vector", "sql", "hybrid"] as const;

function splitParam(value: string | null) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

export function SearchPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const submitted = searchParams.get("q")?.trim() ?? "";
  const [query, setQuery] = useState(submitted);
  const entityTypes = splitParam(searchParams.get("types")) as LibraryEntityType[];
  const mediaTypes = splitParam(searchParams.get("media")) as LibraryMediaType[];
  const lifecycle = searchParams.get("lifecycle")?.trim() ?? "";
  const tags = splitParam(searchParams.get("tags"));
  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";
  const requestedMode = searchParams.get("mode");
  const mode = requestedMode && MODES.includes(requestedMode as typeof MODES[number])
    ? requestedMode
    : "auto";

  useEffect(() => setQuery(submitted), [submitted]);

  const requestBody = useMemo(() => ({
    query: submitted,
    mode,
    entity_types: entityTypes.length ? entityTypes : undefined,
    media_types: mediaTypes.length ? mediaTypes : undefined,
    lifecycle_statuses: lifecycle ? [lifecycle] : undefined,
    tags: tags.length ? tags : undefined,
    date_from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
    limit: 50,
  }), [submitted, mode, entityTypes.join(","), mediaTypes.join(","), lifecycle, tags.join(","), dateFrom, dateTo]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["library", requestBody],
    queryFn: () => libraryApi.search(requestBody),
  });
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>(
    "library-results",
    data !== undefined || isError,
  );

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const toggleListParam = (key: string, current: string[], value: string) => {
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    updateParam(key, next.join(","));
  };

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (submitted) next.set("q", submitted);
    setSearchParams(next, { replace: true });
  };

  const hasFilters = entityTypes.length > 0 || mediaTypes.length > 0 || lifecycle || tags.length > 0 || dateFrom || dateTo;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" data-route-scroll="library-results">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <ModuleSectionNav parent="knowledge" active="Library" />
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Browse and search Sources, Notes, and Wiki Pages without merging their independent lifecycle states.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            updateParam("q", query.trim());
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library..." className="pl-9" />
          </div>
          <Button type="submit">Search</Button>
        </form>

        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Filter className="h-4 w-4" /> Filters</div>
            {hasFilters && <Button type="button" size="sm" variant="ghost" onClick={clearFilters}><X className="h-3.5 w-3.5" /> Clear</Button>}
          </div>
          <FilterButtons label="Type" options={ENTITY_OPTIONS} selected={entityTypes} onToggle={(value) => toggleListParam("types", entityTypes, value)} />
          <FilterButtons label="Source media" options={MEDIA_OPTIONS} selected={mediaTypes} onToggle={(value) => toggleListParam("media", mediaTypes, value)} />
          <div className="grid gap-3 md:grid-cols-4">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Lifecycle</span>
              <select value={lifecycle} onChange={(event) => updateParam("lifecycle", event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                <option value="">All states</option>
                <option value="active">Active Source</option>
                <option value="seed">Seed Note</option>
                <option value="growing">Growing Note</option>
                <option value="evergreen">Evergreen Note</option>
                <option value="draft">Draft Wiki</option>
                <option value="stable">Stable Wiki</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Tags (comma separated)</span>
              <Input value={tags.join(", ")} onChange={(event) => updateParam("tags", event.target.value)} placeholder="research, ai" />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>From</span>
              <Input type="date" value={dateFrom} onChange={(event) => updateParam("from", event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>To</span>
              <Input type="date" value={dateTo} onChange={(event) => updateParam("to", event.target.value)} />
            </label>
          </div>
          {submitted && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Search mode:</span>
              {MODES.map((value) => (
                <button key={value} type="button" onClick={() => updateParam("mode", value === "auto" ? "" : value)} className={`rounded-md px-2.5 py-1 transition-colors ${mode === value ? "bg-primary/15 font-medium text-primary" : "hover:bg-accent hover:text-foreground"}`}>
                  {value}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          {isLoading && <StateMessage title="Loading Library" description="Collecting matching Sources, Notes, and Wiki Pages." />}
          {isError && <StateMessage tone="error" title="Library query failed" description="The unified knowledge index could not be queried." actionLabel="Retry" onAction={() => refetch()} />}
          {data && <p className="text-xs text-muted-foreground">{data.total} matching records</p>}
          {data && data.items.length === 0 && (
            <StateMessage
              title="No matching records"
              description="Try a broader query or remove one of the filters."
              actionLabel="Clear filters"
              onAction={clearFilters}
            />
          )}
          {data?.items.map((result) => <SearchResultCard key={`${result.result_type}-${result.id}-${result.segment_id ?? "record"}`} result={result} />)}
        </div>
      </div>
    </div>
  );
}

function FilterButtons<T extends string>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 text-xs text-muted-foreground">{label}</span>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onToggle(option.value)} className={`rounded-full border px-3 py-1 text-xs transition-colors ${selected.includes(option.value) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
