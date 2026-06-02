import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot, CheckCircle2, Clock, FileSearch, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { wikiApi, type WikiRecompileSuggestion } from "@/lib/api";
import { SectionNav, reviewNavItems } from "@/components/SectionNav";

export function WikiSuggestionsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-suggestions", "all"],
    queryFn: () => wikiApi.suggestions({ status: undefined, limit: 100 }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "accepted" | "rejected" | "applied" }) =>
      wikiApi.updateSuggestion(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  const suggestions = data?.items ?? [];

	return (
		<div className="h-full overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl space-y-5">
				<SectionNav items={reviewNavItems} active="Wiki Refresh" />
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<div className="flex items-center gap-2 text-primary">
							<Bot className="h-5 w-5" />
							<span className="text-sm font-medium">Review · Wiki</span>
						</div>
						<h1 className="mt-2 text-2xl font-semibold tracking-tight">Wiki Refresh Queue</h1>
						<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
							New material may affect these wiki pages. Review the evidence, update the page if needed, then mark it updated.
						</p>
          </div>
          <Badge variant="secondary" className="w-fit">
            {suggestions.filter((item) => item.status === "pending").length} pending
          </Badge>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileSearch className="h-4 w-4 text-primary" /> Pending Refreshes
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Mark Needs Update keeps the wiki stale, Dismiss closes the reminder, and Mark Updated clears it after review.</p>
            </div>
            {isLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-3">
            {error instanceof Error && <p className="text-sm text-destructive">Failed to load suggestions: {error.message}</p>}
            {!isLoading && suggestions.length === 0 && (
              <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                No refresh reminders yet. New source, note, or memory updates that may affect a wiki will appear here.
              </div>
            )}
            {suggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                isUpdating={updateMutation.isPending}
                onAccept={() => updateMutation.mutate({ id: suggestion.id, status: "accepted" })}
                onReject={() => updateMutation.mutate({ id: suggestion.id, status: "rejected" })}
                onApply={() => updateMutation.mutate({ id: suggestion.id, status: "applied" })}
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
  isUpdating,
  onAccept,
  onReject,
  onApply,
}: {
  suggestion: WikiRecompileSuggestion;
  isUpdating: boolean;
  onAccept: () => void;
  onReject: () => void;
  onApply: () => void;
}) {
  const score = typeof suggestion.metadata_?.score === "number" ? suggestion.metadata_.score : null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{suggestion.trigger_type}</Badge>
            <Badge variant="outline">{suggestion.status}</Badge>
            {score !== null && <span className="text-xs text-muted-foreground">score {score}</span>}
          </div>
          <h2 className="mt-2 font-medium">
            <Link className="hover:text-primary" to={`/wiki/${encodeURIComponent(suggestion.wiki_id)}`}>
              {suggestion.wiki_title || suggestion.wiki_id}
            </Link>
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{suggestion.reason}</p>
          {suggestion.evidence_preview && (
            <p className="mt-3 line-clamp-3 rounded-md bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
              {suggestion.evidence_preview}
            </p>
          )}
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Trigger: {suggestion.trigger_id}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {suggestion.status === "pending" && (
            <>
              <Button size="sm" variant="outline" onClick={onReject} disabled={isUpdating}>
                <XCircle className="mr-1 h-4 w-4" /> Dismiss
              </Button>
              <Button size="sm" onClick={onAccept} disabled={isUpdating}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Needs Update
              </Button>
            </>
          )}
          {suggestion.status === "accepted" && (
            <Button size="sm" onClick={onApply} disabled={isUpdating}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> Mark Updated
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
