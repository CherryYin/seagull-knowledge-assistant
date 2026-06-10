import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { FileText, Sparkles, Download, CheckCircle2, Plus, ScrollText } from "lucide-react";
import { assetsApi, notesApi, sourcesApi, type Asset, type AssetStatus, type AssetType } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function readinessTone(ready: boolean) {
  return ready
    ? "border-emerald-200 bg-emerald-50/80"
    : "border-amber-200 bg-amber-50/70";
}

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
};

function assetTypeLabel(assetType: AssetType) {
  if (assetType === "research_brief") return "Research Brief";
  if (assetType === "knowledge_pack") return "Knowledge Pack";
  if (assetType === "newsletter_issue") return "Newsletter Issue";
  return "Blog Post";
}

function assetTypeDescription(assetType: AssetType) {
  if (assetType === "research_brief") {
    return "Structured synthesis with findings, risks, recommendations, and evidence-backed references.";
  }
  if (assetType === "knowledge_pack") {
    return "A reusable bundle of related knowledge artifacts with themes, reading order, and references.";
  }
  if (assetType === "newsletter_issue") {
    return "A curated issue draft with editorial framing, featured items, and suggested next reads.";
  }
  return "Readable, publish-oriented writing for a clear audience and angle.";
}

const RESEARCH_BRIEF_CHECKLIST = [
  "Define the decision question or research objective",
  "Scope the material and intended audience",
  "Summarize key findings, not just source summaries",
  "Call out risks, uncertainty, or conflicting evidence",
  "End with recommendations backed by references",
];

const KNOWLEDGE_PACK_CHECKLIST = [
  "Define the audience and use case for this pack",
  "Include enough linked material to justify a bundle",
  "Explain what is included, not just why it matters",
  "Suggest a reading path or onboarding order",
  "Keep the pack reusable with clear references",
];

const NEWSLETTER_ISSUE_CHECKLIST = [
  "Clarify the theme or angle of this issue",
  "Select a small set of featured items worth sending",
  "Write a short editor's note that frames the issue",
  "Explain why the items matter right now",
  "End with clear next reads and readable references",
];

function ReadinessList({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: string[];
  tone: string;
  empty: string;
}) {
  return (
    <div className="space-y-2 rounded-md border bg-background/70 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {items.length > 0 ? (
        <ul className={`list-disc space-y-1 pl-5 text-sm ${tone}`}>
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

export function AssetsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("blog_post");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [opinionNotes, setOpinionNotes] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportedMarkdown, setExportedMarkdown] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [editOutline, setEditOutline] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editFeedback, setEditFeedback] = useState("");
  const [editOpinion, setEditOpinion] = useState("");
  const [editStyle, setEditStyle] = useState("");
  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] = useState("");
  const [publishFeedback, setPublishFeedback] = useState("");

  const assetsQuery = useQuery({
    queryKey: ["assets"],
    queryFn: () => assetsApi.list({ limit: 100 }),
  });

  const sourcesQuery = useQuery({
    queryKey: ["asset-source-options"],
    queryFn: () => sourcesApi.list({ limit: 50 }),
  });

  const notesQuery = useQuery({
    queryKey: ["asset-note-options"],
    queryFn: () => notesApi.list({ limit: 50 }),
  });

  const sourceMap = new Map((sourcesQuery.data?.items ?? []).map((item) => [item.id, item]));
  const noteMap = new Map((notesQuery.data?.items ?? []).map((item) => [item.id, item]));

  const selectedAsset = useMemo(
    () => assetsQuery.data?.items.find((item) => item.id === selectedId) ?? assetsQuery.data?.items[0] ?? null,
    [assetsQuery.data, selectedId],
  );

  const selectedAssetId = selectedAsset?.id ?? null;

  const createMutation = useMutation({
    mutationFn: () => assetsApi.create({ asset_type: assetType, title, brief, source_refs: selectedSourceIds, note_refs: selectedNoteIds, opinion_notes: opinionNotes, style_notes: styleNotes }),
    onSuccess: async (asset) => {
      setTitle("");
      setBrief("");
      setAssetType("blog_post");
      setSelectedSourceIds([]);
      setSelectedNoteIds([]);
      setOpinionNotes("");
      setStyleNotes("");
      setSelectedId(asset.id);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const toggleSelected = (current: string[], id: string, checked: boolean) => (
    checked ? [...current, id] : current.filter((item) => item !== id)
  );

  const refreshAsset = async (assetId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    setSelectedId(assetId);
  };

  const saveMutation = useMutation({
    mutationFn: (payload: { assetId: string; body: { title?: string; brief?: string; outline?: string; draft_content?: string; editor_feedback?: string; opinion_notes?: string; style_notes?: string } }) =>
      assetsApi.update(payload.assetId, payload.body),
    onSuccess: async (asset) => {
      await refreshAsset(asset.id);
      setSelectedId(asset.id);
    },
  });

  const loadEditorState = (asset: Asset | null) => {
    setEditTitle(asset?.title ?? "");
    setEditBrief(asset?.brief ?? "");
    setEditOutline(asset?.outline ?? "");
    setEditDraft(asset?.draft_content ?? "");
    setEditFeedback(asset?.editor_feedback ?? "");
    setEditOpinion(asset?.opinion_notes ?? "");
    setEditStyle(asset?.style_notes ?? "");
  };

  useEffect(() => {
    loadEditorState(selectedAsset);
  }, [selectedAssetId]);

  useEffect(() => {
    const state = location.state as { assetHandoff?: { title?: string; brief?: string; asset_type?: AssetType; source_refs?: string[]; note_refs?: string[]; memory_refs?: string[]; wiki_refs?: string[] } } | null;
    const handoff = state?.assetHandoff;
    if (!handoff) return;
    setTitle(handoff.title ?? "");
    setBrief(handoff.brief ?? "");
    setAssetType(handoff.asset_type ?? "blog_post");
    setSelectedSourceIds(handoff.source_refs ?? []);
    setSelectedNoteIds(handoff.note_refs ?? []);
  }, [location.state]);

  const generateOutlineMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.generateOutline(assetId, true),
    onSuccess: async (asset) => refreshAsset(asset.id),
  });

  const generateDraftMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.generateDraft(assetId, true),
    onSuccess: async (asset) => refreshAsset(asset.id),
  });

  const attachReferencesMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.attachReferences(assetId, true),
    onSuccess: async (asset) => refreshAsset(asset.id),
  });

  const readinessMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.checkReadiness(assetId),
  });

  const exportMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.exportMarkdown(assetId),
    onSuccess: async (result) => {
      setExportedMarkdown(result.content);
      await refreshAsset(result.asset_id);
    },
  });

  const publishFeedbackMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.updatePublishFeedback(assetId, {
      publish_url: publishUrl || null,
      channel: publishChannel || null,
      published_at: new Date().toISOString(),
      feedback: publishFeedback || null,
    }),
    onSuccess: async (asset) => refreshAsset(asset.id),
  });

  const feedbackToNoteMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.feedbackToNote(assetId),
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Assets</h1>
          <p className="text-sm text-muted-foreground">
            Source-driven blog posts and research briefs for the knowledge asset loop.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create Asset</CardTitle>
            <CardDescription>
              Start from a title and brief, then iterate into outline, draft, references, and export.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <button
                type="button"
                onClick={() => setAssetType("blog_post")}
                className={`rounded-lg border p-3 text-left transition-colors ${assetType === "blog_post" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
              >
                <div className="flex items-center gap-2 font-medium"><FileText className="h-4 w-4" /> Blog Post</div>
                <p className="mt-1 text-xs text-muted-foreground">Readable, publish-oriented writing for a clear audience.</p>
              </button>
              <button
                type="button"
                onClick={() => setAssetType("research_brief")}
                className={`rounded-lg border p-3 text-left transition-colors ${assetType === "research_brief" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
              >
                <div className="flex items-center gap-2 font-medium"><ScrollText className="h-4 w-4" /> Research Brief</div>
                <p className="mt-1 text-xs text-muted-foreground">Structured synthesis with findings, risks, recommendations, and evidence.</p>
              </button>
              <button
                type="button"
                onClick={() => setAssetType("knowledge_pack")}
                className={`rounded-lg border p-3 text-left transition-colors ${assetType === "knowledge_pack" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
              >
                <div className="flex items-center gap-2 font-medium"><ScrollText className="h-4 w-4" /> Knowledge Pack</div>
                <p className="mt-1 text-xs text-muted-foreground">Reusable bundle of related sources, notes, wiki pages, and guided reading order.</p>
              </button>
              <button
                type="button"
                onClick={() => setAssetType("newsletter_issue")}
                className={`rounded-lg border p-3 text-left transition-colors ${assetType === "newsletter_issue" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
              >
                <div className="flex items-center gap-2 font-medium"><ScrollText className="h-4 w-4" /> Newsletter Issue</div>
                <p className="mt-1 text-xs text-muted-foreground">Curated issue draft with editorial framing, featured items, and next reads.</p>
              </button>
            </div>
            <Input placeholder={assetType === "research_brief" ? "Research brief title" : assetType === "knowledge_pack" ? "Knowledge pack title" : assetType === "newsletter_issue" ? "Newsletter issue title" : "Asset title"} value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder={assetType === "research_brief" ? "Decision question, scope, intended audience, and why this brief matters" : assetType === "knowledge_pack" ? "Who this pack is for, what it includes, and why it should exist" : assetType === "newsletter_issue" ? "Theme of this issue, target reader, and what featured items it should include" : "Editorial brief"} value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} />
            <Textarea placeholder="Opinion / thesis" value={opinionNotes} onChange={(e) => setOpinionNotes(e.target.value)} rows={3} />
            <Textarea placeholder="Style notes / tone instructions" value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)} rows={3} />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Source refs</p>
                <div className="max-h-40 space-y-2 overflow-auto pr-1 text-sm">
                  {(sourcesQuery.data?.items ?? []).map((source) => (
                    <label key={source.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selectedSourceIds.includes(source.id)}
                        onChange={(e) => setSelectedSourceIds((current) => toggleSelected(current, source.id, e.target.checked))}
                      />
                      <span>
                        <span className="font-medium">{source.title}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{source.source_type}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Note refs</p>
                <div className="max-h-40 space-y-2 overflow-auto pr-1 text-sm">
                  {(notesQuery.data?.items ?? []).map((note) => (
                    <label key={note.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selectedNoteIds.includes(note.id)}
                        onChange={(e) => setSelectedNoteIds((current) => toggleSelected(current, note.id, e.target.checked))}
                      />
                      <span>
                        <span className="font-medium">{note.title}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{note.note_type}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <Button onClick={() => createMutation.mutate()} disabled={!title.trim() || createMutation.isPending}>
              <Plus className="mr-2 h-4 w-4" />
              Create Asset
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Asset List</CardTitle>
              <CardDescription>{assetsQuery.data?.total ?? 0} assets</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(assetsQuery.data?.items ?? []).map((asset) => (
                <button
                  key={asset.id}
                  className={`w-full rounded-lg border p-3 text-left transition ${selectedAsset?.id === asset.id ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}
                  onClick={() => setSelectedId(asset.id)}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{STATUS_LABELS[asset.status]}</Badge>
                      <Badge variant="secondary">{assetTypeLabel(asset.asset_type)}</Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{new Date(asset.updated_at).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{asset.title}</p>
                    <Link
                      to={`/assets/${encodeURIComponent(asset.id)}`}
                      className="text-[11px] text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open
                    </Link>
                  </div>
                  {asset.brief && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{asset.brief}</p>}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Asset Workspace</CardTitle>
              <CardDescription>
                {selectedAsset
                  ? selectedAsset.asset_type === "research_brief"
                    ? `Working on research brief: ${selectedAsset.title}`
                    : selectedAsset.asset_type === "knowledge_pack"
                      ? `Working on knowledge pack: ${selectedAsset.title}`
                      : selectedAsset.asset_type === "newsletter_issue"
                        ? `Working on newsletter issue: ${selectedAsset.title}`
                    : `Working on ${selectedAsset.title}`
                  : "Select or create an asset"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!selectedAsset && <p className="text-sm text-muted-foreground">No asset selected.</p>}
              {selectedAsset && (
                <>
                  <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{assetTypeLabel(selectedAsset.asset_type)}:</span> {assetTypeDescription(selectedAsset.asset_type)}
                  </div>
                  {selectedAsset.asset_type === "research_brief" && (
                    <div className="rounded-lg border border-border/70 bg-background p-4">
                      <p className="text-sm font-semibold text-foreground">Research Brief Checklist</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {RESEARCH_BRIEF_CHECKLIST.map((item) => (
                          <div key={item} className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedAsset.asset_type === "knowledge_pack" && (
                    <div className="rounded-lg border border-border/70 bg-background p-4">
                      <p className="text-sm font-semibold text-foreground">Knowledge Pack Checklist</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {KNOWLEDGE_PACK_CHECKLIST.map((item) => (
                          <div key={item} className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedAsset.asset_type === "newsletter_issue" && (
                    <div className="rounded-lg border border-border/70 bg-background p-4">
                      <p className="text-sm font-semibold text-foreground">Newsletter Issue Checklist</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {NEWSLETTER_ISSUE_CHECKLIST.map((item) => (
                          <div key={item} className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => generateOutlineMutation.mutate(selectedAsset.id)}>
                      <Sparkles className="mr-2 h-4 w-4" />
                      {selectedAsset.asset_type === "research_brief" ? "Generate Brief Outline" : selectedAsset.asset_type === "knowledge_pack" ? "Generate Pack Outline" : selectedAsset.asset_type === "newsletter_issue" ? "Generate Issue Outline" : "Generate Outline"}
                    </Button>
                    <Button variant="outline" onClick={() => generateDraftMutation.mutate(selectedAsset.id)}>
                      <FileText className="mr-2 h-4 w-4" />
                      {selectedAsset.asset_type === "research_brief" ? "Generate Brief Draft" : selectedAsset.asset_type === "knowledge_pack" ? "Generate Pack Draft" : selectedAsset.asset_type === "newsletter_issue" ? "Generate Issue Draft" : "Generate Draft"}
                    </Button>
                    <Button variant="outline" onClick={() => attachReferencesMutation.mutate(selectedAsset.id)}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Attach References
                    </Button>
                    <Button variant="outline" onClick={() => readinessMutation.mutate(selectedAsset.id)}>
                      Check Readiness
                    </Button>
                    <Button variant="outline" onClick={() => exportMutation.mutate(selectedAsset.id)}>
                      <Download className="mr-2 h-4 w-4" />
                      Export Markdown
                    </Button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Title</h3>
                      <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Brief</h3>
                      <Textarea value={editBrief} onChange={(e) => setEditBrief(e.target.value)} rows={6} />
                      {selectedAsset.asset_type === "research_brief" && (
                        <p className="text-xs text-muted-foreground">
                          Good research briefs usually define the decision question, scope, intended reader, and why the brief matters now.
                        </p>
                      )}
                      {selectedAsset.asset_type === "knowledge_pack" && (
                        <p className="text-xs text-muted-foreground">
                          Good knowledge packs explain who the pack is for, what is included, and how to work through the material.
                        </p>
                      )}
                      {selectedAsset.asset_type === "newsletter_issue" && (
                        <p className="text-xs text-muted-foreground">
                          Good newsletter issues define the theme, frame the issue with a short editorial note, and highlight why these items are worth reading now.
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">References</h3>
                      <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{selectedAsset.reference_notes || "(empty)"}</pre>
                      {selectedAsset.asset_type === "research_brief" && (
                        <p className="text-xs text-muted-foreground">
                          Research briefs should attach readable references before export so findings and recommendations stay auditable.
                        </p>
                      )}
                      {selectedAsset.asset_type === "knowledge_pack" && (
                        <p className="text-xs text-muted-foreground">
                          Knowledge packs should attach readable references before export so the bundle stays reusable and navigable.
                        </p>
                      )}
                      {selectedAsset.asset_type === "newsletter_issue" && (
                        <p className="text-xs text-muted-foreground">
                          Newsletter issues should attach readable references before export so every featured item can be traced back to source material.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>Sources: {selectedAsset.source_refs.length}</span>
                    <span>Notes: {selectedAsset.note_refs.length}</span>
                    <span>Memories: {selectedAsset.memory_refs.length}</span>
                    <span>Wiki: {selectedAsset.wiki_refs.length}</span>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Opinion / Thesis</h3>
                      <Textarea value={editOpinion} onChange={(e) => setEditOpinion(e.target.value)} rows={5} />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Style Notes</h3>
                      <Textarea value={editStyle} onChange={(e) => setEditStyle(e.target.value)} rows={5} />
                    </div>
                  </div>

                  {(selectedAsset.source_refs.length > 0 || selectedAsset.note_refs.length > 0) && (
                    <div className="grid gap-4 md:grid-cols-2">
                      {selectedAsset.source_refs.length > 0 && (
                        <div className="space-y-2 rounded-md border p-3">
                          <h3 className="text-sm font-semibold">Source refs</h3>
                          <ul className="space-y-1 text-xs">
                            {selectedAsset.source_refs.map((sourceId) => {
                              const source = sourceMap.get(sourceId);
                              return (
                                <li key={sourceId}>
                                  <Link className="text-primary hover:underline" to={`/sources/${encodeURIComponent(sourceId)}`}>
                                    {source?.title ?? sourceId}
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}

                      {selectedAsset.note_refs.length > 0 && (
                        <div className="space-y-2 rounded-md border p-3">
                          <h3 className="text-sm font-semibold">Note refs</h3>
                          <ul className="space-y-1 text-xs">
                            {selectedAsset.note_refs.map((noteId) => {
                              const note = noteMap.get(noteId);
                              return (
                                <li key={noteId}>
                                  <Link className="text-primary hover:underline" to={`/notes/${encodeURIComponent(noteId)}`}>
                                    {note?.title ?? noteId}
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Outline</h3>
                    <Textarea value={editOutline} onChange={(e) => setEditOutline(e.target.value)} rows={10} />
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Draft</h3>
                    <Textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={16} />
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Editor Feedback</h3>
                    <Textarea value={editFeedback} onChange={(e) => setEditFeedback(e.target.value)} rows={6} />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Publish URL</h3>
                      <Input value={publishUrl} onChange={(e) => setPublishUrl(e.target.value)} placeholder="https://..." />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Channel</h3>
                      <Input value={publishChannel} onChange={(e) => setPublishChannel(e.target.value)} placeholder="blog, x, newsletter" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Publish Feedback</h3>
                    <Textarea value={publishFeedback} onChange={(e) => setPublishFeedback(e.target.value)} rows={4} />
                  </div>

                  <div>
                    {saveMutation.isError && (
                      <p className="mb-3 text-sm text-destructive">Failed to save asset edits. Please retry.</p>
                    )}
                    {saveMutation.isSuccess && !saveMutation.isPending && (
                      <p className="mb-3 text-sm text-emerald-600">Saved.</p>
                    )}
                    <Button
                      onClick={() => selectedAsset && saveMutation.mutate({
                        assetId: selectedAsset.id,
                        body: {
                          title: editTitle,
                          brief: editBrief,
                          outline: editOutline,
                          draft_content: editDraft,
                          editor_feedback: editFeedback,
                          opinion_notes: editOpinion,
                          style_notes: editStyle,
                        },
                      })}
                      disabled={!selectedAsset || !editTitle.trim() || saveMutation.isPending}
                    >
                      {saveMutation.isPending ? "Saving…" : "Save Edits"}
                    </Button>
                    <Button
                      variant="outline"
                      className="ml-2"
                      onClick={() => selectedAsset && feedbackToNoteMutation.mutate(selectedAsset.id)}
                      disabled={!selectedAsset || feedbackToNoteMutation.isPending || (!editFeedback.trim() && !publishFeedback.trim())}
                    >
                      {feedbackToNoteMutation.isPending ? "Converting…" : "Feedback to Note"}
                    </Button>
                    <Button
                      variant="outline"
                      className="ml-2"
                      onClick={() => selectedAsset && publishFeedbackMutation.mutate(selectedAsset.id)}
                      disabled={!selectedAsset || publishFeedbackMutation.isPending || (!publishUrl.trim() && !publishChannel.trim() && !publishFeedback.trim())}
                    >
                      {publishFeedbackMutation.isPending ? "Saving Publish Feedback…" : "Save Publish Feedback"}
                    </Button>
                  </div>

                  {readinessMutation.data && (
                    selectedAsset.asset_type === "research_brief" ? (
                      <div className={`space-y-4 rounded-lg border p-4 ${readinessTone(readinessMutation.data.ready)}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">Research Brief Readiness</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              Check whether this brief is evidence-backed, decision-ready, and complete enough to export.
                            </p>
                          </div>
                          <Badge variant={readinessMutation.data.ready ? "default" : "secondary"}>
                            {readinessMutation.data.ready ? "Ready to export" : "Needs work"}
                          </Badge>
                        </div>

                        <div className="grid gap-3 md:grid-cols-3">
                          <ReadinessList
                            title="Blocking"
                            items={readinessMutation.data.blocking_reasons}
                            tone="text-destructive"
                            empty="No blocking issues."
                          />
                          <ReadinessList
                            title="Warnings"
                            items={readinessMutation.data.warning_reasons}
                            tone="text-amber-700"
                            empty="No warning signals."
                          />
                          <ReadinessList
                            title="Suggested next steps"
                            items={readinessMutation.data.suggestion_reasons}
                            tone="text-sky-700"
                            empty="No extra suggestions right now."
                          />
                        </div>

                        <div className="rounded-md border bg-background/80 p-3 text-sm text-muted-foreground">
                          {selectedAsset.asset_type === "research_brief"
                            ? "A strong brief usually has at least one grounded wiki angle, attached source evidence, and clear sections for executive summary, findings, risks, and recommendations."
                            : "A strong knowledge pack usually has enough linked material to justify the bundle, a clear 'what’s included' section, a guided reading path, and readable references for later reuse."}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 rounded-md border p-3 text-sm">
                        <p className="font-medium">Readiness: {readinessMutation.data.ready ? "Ready" : "Not ready"}</p>
                        {readinessMutation.data.blocking_reasons.length > 0 && (
                          <ul className="list-disc pl-5 text-muted-foreground">
                            {readinessMutation.data.blocking_reasons.map((reason) => <li key={reason}>{reason}</li>)}
                          </ul>
                        )}
                        {readinessMutation.data.warning_reasons.length > 0 && (
                          <ul className="list-disc pl-5 text-amber-600">
                            {readinessMutation.data.warning_reasons.map((reason) => <li key={reason}>{reason}</li>)}
                          </ul>
                        )}
                        {readinessMutation.data.suggestion_reasons.length > 0 && (
                          <ul className="list-disc pl-5 text-sky-700">
                            {readinessMutation.data.suggestion_reasons.map((reason) => <li key={reason}>{reason}</li>)}
                          </ul>
                        )}
                      </div>
                    )
                  )}

                  {exportedMarkdown && selectedAsset.id === exportMutation.variables && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Exported Markdown</h3>
                      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{exportedMarkdown}</pre>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
