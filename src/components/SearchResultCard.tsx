import { useLocation, useNavigate } from "react-router-dom";
import { Bot, ExternalLink, FileText, SearchCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildAssetHandoffState } from "@/lib/asset-handoff";
import type { LibrarySearchResult } from "@/lib/api";

export function SearchResultCard({ result }: { result: LibrarySearchResult }) {
  const navigate = useNavigate();
  const location = useLocation();
  const backState = { backTo: `${location.pathname}${location.search}`, backLabel: "Back to Library" };

  const openResult = () => navigate(result.href, {
    state: { ...backState, startMs: result.start_ms ?? undefined },
  });

  const askAgent = (event: React.MouseEvent) => {
    event.stopPropagation();
    const workflowId = result.entity_type === "source"
      ? "summarize-source"
      : result.entity_type === "wiki"
        ? "draft-wiki-refresh"
        : "organize-recent-imports";
    navigate("/chat", {
      state: {
        objectRef: { object_type: result.entity_type, object_id: result.id, title: result.title },
        workflowId,
        promptSeed: `Use this ${result.entity_type} result to answer my question or connect it to my knowledge base.\n\nTitle: ${result.title}\nID: ${result.id}\nMatch reason: ${result.hit.reason}`,
        ...backState,
      },
    });
  };

  const createAsset = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigate("/assets/new", {
      state: {
        assetHandoff: buildAssetHandoffState({
          title: result.title,
          brief: `Create a blog asset from Library result: ${result.title}`,
          source_refs: result.entity_type === "source" ? [result.id] : [],
          note_refs: result.entity_type === "note" ? [result.id] : [],
          wiki_refs: result.entity_type === "wiki" ? [result.id] : [],
        }),
        ...backState,
      },
    });
  };

  const attachToWiki = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigate("/wiki", {
      state: {
        wikiPrefill: {
          title: result.title,
          summary: `Seeded from Library result: ${result.title}`,
          page_type: "topic",
          derived_from_sources: result.entity_type === "source" ? [result.id] : [],
          derived_from_notes: result.entity_type === "note" ? [result.id] : [],
        },
      },
    });
  };

  return (
    <div role="button" tabIndex={0} onClick={openResult} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openResult(); }} className="w-full cursor-pointer rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40">
      <div className="flex items-start gap-4">
        {result.thumbnail_url && <img src={result.thumbnail_url} alt="" className="h-24 w-24 shrink-0 rounded-lg border border-border object-cover" />}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant={result.entity_type === "source" ? "source" : "note"}>{result.entity_type}</Badge>
            {result.media_type && <Badge variant="outline">{result.media_type}</Badge>}
            {result.lifecycle_status && <Badge variant="outline">{result.lifecycle_status}</Badge>}
            {result.updated_at && <span className="text-xs text-muted-foreground">{new Date(result.updated_at).toLocaleDateString()}</span>}
          </div>
          <h3 className="truncate text-sm font-medium">{result.title}</h3>
          {result.start_ms != null && <p className="mt-1 text-xs font-medium text-primary">Play from {formatTimestamp(result.start_ms)}</p>}
          {result.excerpt && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{result.excerpt}</p>}
          {result.tags.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{result.tags.map((tag) => `#${tag}`).join(" ")}</p>}
          <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1 font-medium text-foreground"><SearchCheck className="h-3.5 w-3.5" /> Why this matched · {result.hit.field}</div>
            <p>{result.hit.reason}</p>
            {result.hit.text && result.hit.text !== result.excerpt && <p className="mt-1 line-clamp-2">{result.hit.text}</p>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openResult(); }}><ExternalLink className="h-3.5 w-3.5" /> Open</Button>
            <Button type="button" size="sm" variant="outline" onClick={createAsset}><FileText className="h-3.5 w-3.5" /> Create Asset</Button>
            {result.entity_type !== "wiki" && <Button type="button" size="sm" variant="ghost" onClick={attachToWiki}><SearchCheck className="h-3.5 w-3.5" /> Attach to Wiki</Button>}
            <Button type="button" size="sm" variant="ghost" onClick={askAgent}><Bot className="h-3.5 w-3.5" /> Ask Agent</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
