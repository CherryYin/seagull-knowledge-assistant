import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Newspaper, Check, X, ExternalLink, Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notesApi, type Note } from "@/lib/api";
import { getReviewStatusLabel } from "@/lib/reviewStatus";
import { SectionNav, reviewNavItems } from "@/components/SectionNav";

type DigestTab = "pending" | "kept";

export function DigestPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DigestTab>("pending");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["digest"],
    queryFn: () => notesApi.list({ note_type: "digest", limit: 200 }),
  });

  const allItems = data?.items ?? [];
  const pendingItems = useMemo(
    () => allItems.filter((note) => note.status === "pending_review"),
    [allItems]
  );
  const keptItems = useMemo(
    () => allItems.filter((note) => note.status !== "pending_review"),
    [allItems]
  );
  const visibleItems = activeTab === "pending" ? pendingItems : keptItems;

  const refreshDigest = () => {
    queryClient.invalidateQueries({ queryKey: ["digest"] });
    queryClient.invalidateQueries({ queryKey: ["notes"] });
    setSelectedIds(new Set());
  };

  const keepMutation = useMutation({
    mutationFn: (id: string) => notesApi.update(id, { status: "kept" }),
    onSuccess: refreshDigest,
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => notesApi.delete(id),
    onSuccess: refreshDigest,
  });

  const mergeMutation = useMutation({
    mutationFn: ({ targetId, sourceIds }: { targetId: string; sourceIds: string[] }) =>
      notesApi.mergeDigest(targetId, { source_ids: sourceIds }),
    onSuccess: refreshDigest,
  });

  const selectedVisibleIds = visibleItems
    .map((note) => note.id)
    .filter((id) => selectedIds.has(id));
  const canMerge = selectedVisibleIds.length >= 2;

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function mergeSelected() {
    if (!canMerge) return;
    const [targetId, ...sourceIds] = selectedVisibleIds;
    mergeMutation.mutate({ targetId, sourceIds });
  }

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-5xl mx-auto px-6 py-8">
				<SectionNav items={reviewNavItems} active="Digest" />
				<div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Digest</h1>
            <p className="text-sm text-muted-foreground">
              Review auto-generated RSS topic summary drafts, keep useful digests, and merge recurring topics. Pending digests expire after 7 days unless kept.
            </p>
            <p className="text-xs text-muted-foreground">
              Digest items are review-layer summaries. They are not stable knowledge until you keep, merge, or further compile them into notes, memory, or wiki work.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{pendingItems.length} pending</Badge>
            <Badge variant="outline">{keptItems.length} kept</Badge>
          </div>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as DigestTab);
            setSelectedIds(new Set());
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <TabsList>
              <TabsTrigger value="pending">Pending Review</TabsTrigger>
              <TabsTrigger value="kept">Kept</TabsTrigger>
            </TabsList>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={mergeSelected}
              disabled={!canMerge || mergeMutation.isPending}
            >
              <Merge className="h-4 w-4" />
              {mergeMutation.isPending ? "Merging..." : `Merge selected (${selectedVisibleIds.length})`}
            </Button>
          </div>

          <TabsContent value="pending">
            <DigestList
              items={pendingItems}
              emptyText="No pending digests. New summaries appear after RSS feeds are fetched."
              isLoading={isLoading}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onView={(id) => navigate(`/notes/${encodeURIComponent(id)}`)}
              onKeep={(id) => keepMutation.mutate(id)}
              onDismiss={(id) => dismissMutation.mutate(id)}
              keepingId={keepMutation.variables}
              dismissingId={dismissMutation.variables}
              showKeep
            />
          </TabsContent>

          <TabsContent value="kept">
            <DigestList
              items={keptItems}
              emptyText="No kept digests yet. Keep or merge pending digests to build this library."
              isLoading={isLoading}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onView={(id) => navigate(`/notes/${encodeURIComponent(id)}`)}
              onKeep={(id) => keepMutation.mutate(id)}
              onDismiss={(id) => dismissMutation.mutate(id)}
              keepingId={keepMutation.variables}
              dismissingId={dismissMutation.variables}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function DigestList({
  items,
  emptyText,
  isLoading,
  selectedIds,
  onToggleSelected,
  onView,
  onKeep,
  onDismiss,
  keepingId,
  dismissingId,
  showKeep = false,
}: {
  items: Note[];
  emptyText: string;
  isLoading: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onView: (id: string) => void;
  onKeep: (id: string) => void;
  onDismiss: (id: string) => void;
  keepingId?: string;
  dismissingId?: string;
  showKeep?: boolean;
}) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Newspaper className="h-12 w-12 mb-3 opacity-30" />
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((note) => (
        <DigestRow
          key={note.id}
          note={note}
          selected={selectedIds.has(note.id)}
          onToggleSelected={() => onToggleSelected(note.id)}
          onView={() => onView(note.id)}
          onKeep={() => onKeep(note.id)}
          onDismiss={() => onDismiss(note.id)}
          keeping={keepingId === note.id}
          dismissing={dismissingId === note.id}
          showKeep={showKeep}
        />
      ))}
    </div>
  );
}

function DigestRow({
  note,
  selected,
  onToggleSelected,
  onView,
  onKeep,
  onDismiss,
  keeping,
  dismissing,
  showKeep,
}: {
  note: Note;
  selected: boolean;
  onToggleSelected: () => void;
  onView: () => void;
  onKeep: () => void;
  onDismiss: () => void;
  keeping: boolean;
  dismissing: boolean;
  showKeep: boolean;
}) {
  const preview = (note.content || "")
    .replace(/^#+\s.*/gm, "")
    .replace(/\n{2,}/g, " ")
    .trim()
    .slice(0, 200);

  const sourceCount = note.source_ids?.length ?? 0;

  return (
    <div className="group rounded-lg border border-border p-4 hover:border-primary/30 transition-colors">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-border"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select ${note.title}`}
        />
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onView}>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium truncate">{note.title}</h3>
            <Badge variant={note.status === "pending_review" ? "secondary" : "outline"} className="text-[10px]">
              {getReviewStatusLabel(note.status === "pending_review" ? "pending_review" : note.status)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{preview}</p>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">
              {new Date(note.created_at).toLocaleDateString()}
            </span>
            {note.status === "pending_review" && note.expires_at && (
              <span className="text-[10px] text-amber-600">
                expires {new Date(note.expires_at).toLocaleDateString()}
              </span>
            )}
            {note.status !== "pending_review" && note.kept_at && (
              <span className="text-[10px] text-emerald-600">
                kept {new Date(note.kept_at).toLocaleDateString()}
              </span>
            )}
            {sourceCount > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {sourceCount} sources
              </span>
            )}
            {note.domains?.map((domain) => (
              <Badge key={domain} variant="outline" className="text-[10px] px-1.5 py-0">
                {domain}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
            onClick={onView}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          {showKeep && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950"
              onClick={onKeep}
              disabled={keeping || dismissing}
            >
              <Check className="h-3 w-3" />
              Keep
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={onDismiss}
            disabled={keeping || dismissing}
          >
            <X className="h-3 w-3" />
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
