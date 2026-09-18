import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, Clock, Copy, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModuleSectionNav } from "@/components/SectionNav";
import { wikiApi, type WikiRecompileSuggestion } from "@/lib/api";
import { getReviewStatusLabel } from "@/lib/reviewStatus";

export function WikiSuggestionsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-suggestions", "all"],
    queryFn: () => wikiApi.suggestions({ status: undefined, limit: 100 }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "accepted" | "rejected" | "applied" }) =>
      wikiApi.updateSuggestion(id, status),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] }),
  });
  const cloneMutation = useMutation({
    mutationFn: (wikiId: string) => wikiApi.cloneDraft(wikiId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wiki-pages"] }),
  });

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <ModuleSectionNav parent="review" active="Wiki Review" />
        <Card>
          <CardHeader>
            <CardTitle>Wiki Refresh Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading && <p className="text-sm text-muted-foreground">Loading suggestions…</p>}
            {error && <p className="text-sm text-destructive">Failed to load suggestions.</p>}
            {!isLoading && (data?.items.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">No wiki refresh suggestions.</p>
            )}
            {(data?.items ?? []).map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                disabled={updateMutation.isPending || cloneMutation.isPending}
                onStatus={(status) => updateMutation.mutate({ id: suggestion.id, status })}
                onClone={() => cloneMutation.mutate(suggestion.wiki_id)}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  disabled,
  onStatus,
  onClone,
}: {
  suggestion: WikiRecompileSuggestion;
  disabled: boolean;
  onStatus: (status: "accepted" | "rejected" | "applied") => void;
  onClone: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:justify-between">
        <div>
          <div className="flex gap-2">
            <Badge>{suggestion.trigger_type}</Badge>
            <Badge variant="outline">{getReviewStatusLabel(suggestion.status)}</Badge>
          </div>
          <Link className="mt-2 block font-medium hover:text-primary" to={`/wiki/${encodeURIComponent(suggestion.wiki_id)}`}>
            {suggestion.wiki_title || suggestion.wiki_id}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">{suggestion.reason}</p>
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Trigger: {suggestion.trigger_id}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestion.status === "pending" && (
            <>
              <Button size="sm" variant="outline" onClick={() => onStatus("rejected")} disabled={disabled}>
                <XCircle className="mr-1 h-4 w-4" /> Dismiss
              </Button>
              <Button size="sm" onClick={() => onStatus("accepted")} disabled={disabled}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Needs Update
              </Button>
            </>
          )}
          {suggestion.status === "accepted" && (
            <>
              <Button size="sm" variant="outline" onClick={onClone} disabled={disabled}>
                <Copy className="mr-1 h-4 w-4" /> Clone Draft
              </Button>
              <Button size="sm" onClick={() => onStatus("applied")} disabled={disabled}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Updated
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
