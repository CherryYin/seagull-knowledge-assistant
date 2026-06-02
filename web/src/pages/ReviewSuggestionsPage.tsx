import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { reviewApi, ReviewSuggestion, ReviewSuggestionType } from "@/lib/api";
import { SectionNav, reviewNavItems } from "@/components/SectionNav";

const titles: Record<ReviewSuggestionType, string> = {
  low_confidence_fact: "Low-Confidence Facts",
  profile_update: "Profile Suggestions",
};

export function ReviewSuggestionsPage() {
  const [params] = useSearchParams();
  const type = (params.get("type") || "low_confidence_fact") as ReviewSuggestionType;
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["review-suggestions", type],
    queryFn: () => reviewApi.suggestions({ suggestion_type: type, status: "pending", limit: 100 }),
  });
  const generateMutation = useMutation({
    mutationFn: () => reviewApi.generateSuggestions({
      include_low_confidence_facts: type === "low_confidence_fact",
      include_profile_suggestions: type === "profile_update",
      limit: 100,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review-suggestions", type] }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "rejected" | "applied" }) => reviewApi.updateSuggestion(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review-suggestions", type] }),
  });

  const suggestions = data?.items ?? [];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
		<SectionNav items={reviewNavItems} active="Suggestions" />
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-5 w-5" />
              <span className="text-sm font-medium">Phase B Review</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{titles[type] ?? "Review Suggestions"}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Review uncertain memory facts and profile-quality suggestions before they become trusted long-term context.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant={type === "low_confidence_fact" ? "default" : "outline"} size="sm">
              <Link to="/review/suggestions?type=low_confidence_fact">Facts</Link>
            </Button>
            <Button asChild variant={type === "profile_update" ? "default" : "outline"} size="sm">
              <Link to="/review/suggestions?type=profile_update">Profile</Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
              {generateMutation.isPending && <RefreshCw className="mr-1 h-4 w-4 animate-spin" />} Scan
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> Pending Suggestions
            </CardTitle>
            <Badge variant="secondary">{data?.total ?? 0} pending</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {error instanceof Error && <p className="text-sm text-destructive">Failed to load suggestions: {error.message}</p>}
            {generateMutation.data && (
              <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                Scan complete: created {generateMutation.data.created}, skipped {generateMutation.data.skipped}.
              </p>
            )}
            {!isLoading && suggestions.length === 0 && (
              <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                No pending suggestions. Run Scan to refresh this queue.
              </div>
            )}
            {suggestions.map((suggestion) => (
              <ReviewSuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                isUpdating={updateMutation.isPending}
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

function ReviewSuggestionCard({
  suggestion,
  isUpdating,
  onReject,
  onApply,
}: {
  suggestion: ReviewSuggestion;
  isUpdating: boolean;
  onReject: () => void;
  onApply: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{suggestion.suggestion_type.replace(/_/g, " ")}</Badge>
            <Badge variant="outline">{suggestion.status}</Badge>
            {typeof suggestion.evidence?.confidence_score === "number" && (
              <span className="text-xs text-muted-foreground">confidence {suggestion.evidence.confidence_score}</span>
            )}
          </div>
          <h2 className="mt-2 font-medium">{suggestion.title}</h2>
          {suggestion.summary && <p className="mt-1 text-sm leading-6 text-muted-foreground">{suggestion.summary}</p>}
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Target: {suggestion.target_type}/{suggestion.target_id}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onReject} disabled={isUpdating}>
            <XCircle className="mr-1 h-4 w-4" /> Reject
          </Button>
          <Button size="sm" onClick={onApply} disabled={isUpdating}>
            <CheckCircle2 className="mr-1 h-4 w-4" /> Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
