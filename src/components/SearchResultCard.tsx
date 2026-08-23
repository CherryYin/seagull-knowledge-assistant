import { useLocation, useNavigate } from "react-router-dom";
import { Bot, ExternalLink, FileText, SearchCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SearchResult } from "@/lib/api";
import { buildAssetHandoffState } from "@/lib/asset-handoff";

interface Props {
  result: SearchResult;
}

export function SearchResultCard({ result }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const backState = {
    backTo: `${location.pathname}${location.search}`,
    backLabel: "Back to Search",
  };

  const handleClick = () => {
    if (result.type === "note") {
      navigate(`/notes/${encodeURIComponent(result.id)}`, { state: backState });
    } else if (result.type === "wiki") {
      navigate(`/wiki/${encodeURIComponent(result.id)}`, { state: backState });
    } else if (result.type === "memory") {
      return;
    } else {
      navigate(`/sources/${encodeURIComponent(result.id)}`, { state: backState });
    }
  };

  const resultType = result.type.replace("_", " ");
  const preview = result.abstract || result.content_preview;
  const matchReason = result.match_reason || buildMatchReason(result);
  const confidence = result.score >= 0.75 ? "Strong match" : result.score >= 0.45 ? "Likely match" : "Possible match";
  const layer = getResultLayer(result.layer, result.type);

  const askAgent = (event: React.MouseEvent) => {
    event.stopPropagation();
    const workflowId =
      result.type === "source" || result.type === "source_chunk"
        ? "summarize-source"
        : result.type === "wiki" || result.type === "memory"
          ? "draft-wiki-refresh"
          : result.type === "note"
            ? "organize-recent-imports"
            : "research-topic";
    navigate("/chat", {
      state: {
        objectRef: { object_type: result.type, object_id: result.id, title: result.title },
        workflowId,
        promptSeed: `Use this ${resultType} search result to answer my question or connect it to my knowledge base.\n\nTitle: ${result.title}\nID: ${result.id}\nMatch reason: ${matchReason}`,
      },
    });
  };

  const createAsset = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigate("/assets/new", {
      state: {
        assetHandoff: buildAssetHandoffState({
          title: result.title,
          brief: `Create a blog asset from search result: ${result.title}`,
          source_refs: result.type === "source" || result.type === "source_chunk" ? [result.id] : [],
          note_refs: result.type === "note" ? [result.id] : [],
          wiki_refs: result.type === "wiki" ? [result.id] : [],
        }),
      },
    });
  };

  const attachToWiki = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigate("/wiki", {
      state: {
        wikiPrefill: {
          title: result.title,
          summary: `Seeded from search result: ${result.title}`,
          page_type: "topic",
          derived_from_sources: result.type === "source" || result.type === "source_chunk" ? [result.id] : [],
          derived_from_notes: result.type === "note" ? [result.id] : [],
        },
      },
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleClick();
        }
      }}
      className="w-full cursor-pointer rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={result.type === "note" || result.type === "wiki" ? "note" : result.type === "memory" ? "default" : "source"}>
              {resultType}
            </Badge>
            <Badge variant="outline">{layer}</Badge>
            <span className="text-xs text-muted-foreground">
              {confidence}
            </span>
          </div>
          <h3 className="font-medium text-sm truncate">{result.title}</h3>
          {preview && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{preview}</p>
          )}
          <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1 font-medium text-foreground">
              <SearchCheck className="h-3.5 w-3.5" /> Why this matched
            </div>
            <p>{matchReason}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {result.type !== "memory" && (
              <Button type="button" size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); handleClick(); }}>
                <ExternalLink className="h-3.5 w-3.5" /> Open
              </Button>
            )}
            {result.type !== "memory" && (
              <Button type="button" size="sm" variant="outline" onClick={createAsset}>
                <FileText className="h-3.5 w-3.5" /> Create Asset
              </Button>
            )}
            {(result.type === "source" || result.type === "source_chunk" || result.type === "note") && (
              <Button type="button" size="sm" variant="ghost" onClick={attachToWiki}>
                <SearchCheck className="h-3.5 w-3.5" /> Attach to Wiki
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={askAgent}>
              <Bot className="h-3.5 w-3.5" /> Ask Agent
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getResultLayer(layer: string | null | undefined, type: string) {
  if (layer === "raw_evidence") return "Raw Evidence";
  if (layer === "user_note") return "User Note";
  if (layer === "knowledge_tree") return "Legacy Memory";
  if (layer === "stable_wiki") return "Stable Wiki";
  if (layer === "asset") return "Asset";
  if (type === "source" || type === "source_chunk") return "Raw Evidence";
  if (type === "note") return "User Note";
  if (type === "memory") return "Legacy Memory";
  if (type === "wiki") return "Stable Wiki";
  if (type === "asset") return "Asset";
  return "Knowledge";
}

function buildMatchReason(result: SearchResult) {
  if (result.highlights && result.highlights.length > 0) {
    return `Matched highlighted text: ${result.highlights[0]}`;
  }
  if (result.abstract) {
    return "Matched this item summary and metadata for your query.";
  }
  if (result.content_preview) {
    return "Matched content from this item's preview text.";
  }
  if (result.score >= 0.75) {
    return "Strong semantic similarity to your query.";
  }
  if (result.score >= 0.45) {
    return "Likely semantic or keyword match for your query.";
  }
  return "Possible match from the knowledge index; open it to inspect the evidence.";
}
