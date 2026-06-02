import { useLocation, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import type { SearchResult } from "@/lib/api";

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
      navigate(`/memory?node=${encodeURIComponent(result.id)}`);
    } else {
      navigate(`/sources/${encodeURIComponent(result.id)}`, { state: backState });
    }
  };

  return (
    <button
      onClick={handleClick}
      className="w-full text-left rounded-lg border border-border bg-card p-4 hover:border-primary/40 transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={result.type === "note" || result.type === "wiki" ? "note" : result.type === "memory" ? "default" : "source"}>
              {result.type.replace("_", " ")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Score: {result.score.toFixed(2)}
            </span>
          </div>
          <h3 className="font-medium text-sm truncate">{result.title}</h3>
          {result.abstract && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.abstract}</p>
          )}
          {!result.abstract && result.content_preview && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.content_preview}</p>
          )}
        </div>
      </div>
    </button>
  );
}
