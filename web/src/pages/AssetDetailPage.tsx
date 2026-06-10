import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { assetsApi, authApi, notesApi, sourcesApi, wikiApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReferenceChips, type ReferenceItem } from "@/components/ReferenceChips";

type ProductionEvent = {
  event_type?: string;
  asset_id?: string;
  asset_type?: string;
  title?: string;
  status?: string;
  timestamp?: string;
  detail?: Record<string, unknown>;
};

const STATUS_LABELS = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
} as const;

function assetTypeLabel(assetType?: string) {
  if (assetType === "research_brief") return "Research Brief";
  if (assetType === "knowledge_pack") return "Knowledge Pack";
  if (assetType === "newsletter_issue") return "Newsletter Issue";
  return "Blog Post";
}

function assetTypeDescription(assetType?: string) {
  if (assetType === "research_brief") {
    return "A structured research deliverable focused on findings, risks, recommendations, and evidence-backed references.";
  }
  if (assetType === "knowledge_pack") {
    return "A reusable knowledge bundle focused on curation, reading order, and traceable references.";
  }
  if (assetType === "newsletter_issue") {
    return "A curated issue draft focused on editorial framing, featured items, and sendable structure.";
  }
  return "An editable blog draft focused on angle, audience, and readable publish-ready structure.";
}

const RESEARCH_BRIEF_CHECKLIST = [
  "State the decision question or research objective",
  "Scope the material and intended reader",
  "Synthesize findings instead of repeating raw notes",
  "Call out risks, uncertainty, and conflicting evidence",
  "End with recommendations supported by references",
];

const KNOWLEDGE_PACK_CHECKLIST = [
  "Clarify who this pack serves",
  "Curate enough material to justify the bundle",
  "Explain what is included and why",
  "Provide a suggested reading path",
  "Keep references readable and reusable",
];

const NEWSLETTER_ISSUE_CHECKLIST = [
  "Clarify the issue theme and target reader",
  "Pick a small set of featured items worth sending",
  "Frame the issue with a short editor's note",
  "Explain why the selected items matter now",
  "Close with next reads and readable references",
];

function formatProductionEventType(eventType?: string) {
  return String(eventType || "unknown")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatProductionEventSummary(event: ProductionEvent) {
  const title = event.title || event.asset_type || "asset";
  switch (event.event_type) {
    case "asset_generated":
      return `Generated ${title}`;
    case "asset_ready_to_export":
      return `${title} is ready to export`;
    case "asset_exported": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Exported ${title} to ${channel}` : `Exported ${title}`;
    }
    case "asset_published": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Published ${title} via ${channel}` : `Published ${title}`;
    }
    case "asset_feedback_recorded":
      return `Recorded feedback for ${title}`;
    default:
      return formatProductionEventType(event.event_type);
  }
}

function productionEventMeta(event: ProductionEvent): string[] {
  const parts: string[] = [];
  const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
  const exportFormat = typeof event.detail?.export_format === "string" ? event.detail.export_format : undefined;
  const publishUrl = typeof event.detail?.publish_url === "string" ? event.detail.publish_url : undefined;
  const feedback = typeof event.detail?.feedback === "string" ? event.detail.feedback : undefined;

  if (channel) parts.push(`Channel: ${channel}`);
  if (exportFormat && exportFormat !== channel) parts.push(`Format: ${exportFormat}`);
  if (publishUrl) parts.push(`URL: ${publishUrl}`);
  if (feedback) parts.push(`Feedback: ${feedback}`);

  return parts;
}

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
  const productionMemoryQuery = useQuery({
    queryKey: ["asset-production-memory", id],
    queryFn: () => authApi.listMyMemories("production_memory"),
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
  const productionEvents: ProductionEvent[] = ((productionMemoryQuery.data?.[0]?.value as { events?: ProductionEvent[] } | undefined)?.events ?? [])
    .filter((event) => String(event.asset_id || "") === id)
    .slice(0, 12);

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
            {asset && (
              <p className="mt-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{assetTypeLabel(asset.asset_type)}:</span> {assetTypeDescription(asset.asset_type)}
              </p>
            )}
          </div>
          <Button variant="outline" onClick={() => exportMutation.mutate()} disabled={!asset || exportMutation.isPending}>
            Export Markdown
          </Button>
        </div>

        {!asset && <p className="text-sm text-muted-foreground">Loading...</p>}

        {asset && (
          <>
            {asset.asset_type === "research_brief" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Research Brief Checklist</CardTitle>
                  <CardDescription>Use this as a quick review frame before export or publication.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-2">
                  {RESEARCH_BRIEF_CHECKLIST.map((item) => (
                    <div key={item} className="rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                      {item}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            {asset.asset_type === "knowledge_pack" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Knowledge Pack Checklist</CardTitle>
                  <CardDescription>Use this as a quick review frame before export or reuse.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-2">
                  {KNOWLEDGE_PACK_CHECKLIST.map((item) => (
                    <div key={item} className="rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                      {item}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            {asset.asset_type === "newsletter_issue" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Newsletter Issue Checklist</CardTitle>
                  <CardDescription>Use this as a quick review frame before export or sending.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-2">
                  {NEWSLETTER_ISSUE_CHECKLIST.map((item) => (
                    <div key={item} className="rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                      {item}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Brief</CardTitle>
                <CardDescription>
                  {asset.asset_type === "research_brief"
                    ? "Decision question, scope, audience, and framing for this brief."
                    : asset.asset_type === "knowledge_pack"
                      ? "Audience, contents, and why this pack should exist."
                      : asset.asset_type === "newsletter_issue"
                        ? "Issue theme, intended reader, and the kind of updates this issue should feature."
                    : "Editorial direction for this asset."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.brief || "(empty)"}</pre>
              </CardContent>
            </Card>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
              <CardHeader>
                <CardTitle className="text-base">References</CardTitle>
                <CardDescription>
                  {asset.asset_type === "research_brief"
                    ? "Attached evidence and reference notes. Research briefs should keep this section readable and auditable before export."
                    : asset.asset_type === "knowledge_pack"
                      ? "Attached references and reference notes. Knowledge packs should keep this section reusable and easy to navigate."
                      : asset.asset_type === "newsletter_issue"
                        ? "Attached references and reference notes. Newsletter issues should keep each featured item traceable before export."
                    : "Attached references and reference notes."}
                </CardDescription>
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
                {asset.asset_type === "research_brief" && (
                  <CardDescription>Research briefs should usually cover executive summary, findings, risks, recommendations, and references.</CardDescription>
                )}
                {asset.asset_type === "knowledge_pack" && (
                  <CardDescription>Knowledge packs should usually cover overview, included materials, core themes, reading path, and references.</CardDescription>
                )}
                {asset.asset_type === "newsletter_issue" && (
                  <CardDescription>Newsletter issues should usually cover issue overview, editor's note, featured items, why it matters, and next reads.</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.outline || "(empty)"}</pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Draft</CardTitle>
                {asset.asset_type === "research_brief" && (
                  <CardDescription>Keep the brief evidence-backed and decision-oriented rather than purely narrative.</CardDescription>
                )}
                {asset.asset_type === "knowledge_pack" && (
                  <CardDescription>Keep the pack curated, reusable, and explicit about what to read first and why.</CardDescription>
                )}
                {asset.asset_type === "newsletter_issue" && (
                  <CardDescription>Keep the issue light, curated, and readable enough to send to an audience without turning it into a report.</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{asset.draft_content || "(empty)"}</pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Production Timeline</CardTitle>
                <CardDescription>Asset generation, export, publish, and feedback events recorded in production memory.</CardDescription>
              </CardHeader>
              <CardContent>
                {productionEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No production events recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {productionEvents.map((event, index) => (
                      <div key={`${String(event.timestamp || index)}-${String(event.event_type || index)}`} className="rounded-md border bg-muted/20 p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{formatProductionEventType(event.event_type)}</Badge>
                              {event.asset_type && <Badge variant="secondary">{event.asset_type}</Badge>}
                              {event.status && <Badge variant="secondary">{event.status}</Badge>}
                            </div>
                            <div className="text-sm font-medium">{formatProductionEventSummary(event)}</div>
                            {(event.title || event.asset_id) && (
                              <p className="text-xs text-muted-foreground">
                                {event.title || "Untitled asset"}
                                {event.asset_id ? ` · ${event.asset_id}` : ""}
                              </p>
                            )}
                            {productionEventMeta(event).length > 0 && (
                              <div className="flex flex-wrap gap-2 pt-1">
                                {productionEventMeta(event).map((item) => (
                                  <span key={item} className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                                    {item}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {event.timestamp ? new Date(event.timestamp).toLocaleString() : "Unknown time"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
