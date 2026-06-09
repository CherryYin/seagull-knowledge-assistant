import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { assetsApi, notesApi, sourcesApi, wikiApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReferenceChips, type ReferenceItem } from "@/components/ReferenceChips";

const STATUS_LABELS = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
} as const;

export function AssetDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();

  const assetQuery = useQuery({
    queryKey: ["asset", id],
    queryFn: () => assetsApi.get(id),
    enabled: Boolean(id),
  });

  const sourceOptionsQuery = useQuery({
    queryKey: ["asset-detail-sources"],
    queryFn: () => sourcesApi.list({ limit: 100 }),
  });

  const noteOptionsQuery = useQuery({
    queryKey: ["asset-detail-notes"],
    queryFn: () => notesApi.list({ limit: 100 }),
  });

  const exportMutation = useMutation({
    mutationFn: () => assetsApi.exportMarkdown(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["asset", id] });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const asset = assetQuery.data;
  const sourceMap = new Map((sourceOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));
  const noteMap = new Map((noteOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));
  const wikiRefsQuery = useQuery({
    queryKey: ["asset-detail-wiki-refs", id, asset?.wiki_refs],
    queryFn: () => wikiApi.resolveReferences((asset?.wiki_refs ?? []).map((wikiId) => ({ ref_type: "wiki", ref_id: wikiId }))),
    enabled: Boolean(asset?.wiki_refs?.length),
  });

  const sourceRefItems: ReferenceItem[] = (asset?.source_refs ?? []).map((sourceId) => {
    const source = sourceMap.get(sourceId);
    return {
      ref_type: "source",
      ref_id: sourceId,
      title: source?.title ?? sourceId,
      subtitle: source?.source_type ?? null,
      href: `/sources/${encodeURIComponent(sourceId)}`,
    };
  });
  const noteRefItems: ReferenceItem[] = (asset?.note_refs ?? []).map((noteId) => {
    const note = noteMap.get(noteId);
    return {
      ref_type: "note",
      ref_id: noteId,
      title: note?.title ?? noteId,
      subtitle: note?.note_type ?? null,
      href: `/notes/${encodeURIComponent(noteId)}`,
    };
  });
  const stableWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status === "stable") as ReferenceItem[];
  const candidateWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status !== "stable") as ReferenceItem[];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              {asset && <Badge variant="outline">{STATUS_LABELS[asset.status]}</Badge>}
              <Link to="/assets" className="text-sm text-primary hover:underline">
                Back to Assets
              </Link>
            </div>
            <h1 className="text-2xl font-bold">{asset?.title ?? "Asset"}</h1>
            <p className="text-sm text-muted-foreground">
              {asset ? `Updated ${new Date(asset.updated_at).toLocaleString()}` : "Loading asset..."}
            </p>
          </div>
          <Button variant="outline" onClick={() => exportMutation.mutate()} disabled={!asset || exportMutation.isPending}>
            Export Markdown
          </Button>
        </div>

        {!asset && <p className="text-sm text-muted-foreground">Loading...</p>}

        {asset && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Brief</CardTitle>
                <CardDescription>Editorial direction for this asset.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.brief || "(empty)"}</pre>
              </CardContent>
            </Card>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">References</CardTitle>
                  <CardDescription>Attached references and reference notes.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="space-y-1 text-muted-foreground">
                    <p>Sources: {asset.source_refs.length}</p>
                    <p>Notes: {asset.note_refs.length}</p>
                    <p>Memories: {asset.memory_refs.length}</p>
                    <p>Wiki: {asset.wiki_refs.length}</p>
                  </div>
                  {(sourceRefItems.length > 0 || noteRefItems.length > 0 || asset.memory_refs.length > 0) && (
                    <div className="space-y-1">
                      <p className="font-medium">Raw Evidence</p>
                      <ReferenceChips items={sourceRefItems} />
                      <ReferenceChips items={noteRefItems} />
                      {asset.memory_refs.length > 0 && (
                        <div className="mt-2 text-xs text-muted-foreground">Knowledge Tree refs: {asset.memory_refs.join(", ")}</div>
                      )}
                    </div>
                  )}
                  {stableWikiItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="font-medium">Stable Wiki Context</p>
                      <ReferenceChips items={stableWikiItems} />
                    </div>
                  )}
                  {candidateWikiItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="font-medium">Candidate Wiki Context</p>
                      <ReferenceChips items={candidateWikiItems} />
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{asset.reference_notes || "(empty)"}</pre>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Editor Feedback</CardTitle>
                  <CardDescription>Manual review notes saved on the asset.</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.editor_feedback || "(empty)"}</pre>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Outline</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.outline || "(empty)"}</pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Draft</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.draft_content || "(empty)"}</pre>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
