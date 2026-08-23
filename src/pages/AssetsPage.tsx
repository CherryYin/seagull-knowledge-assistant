import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Sparkles, Download, CheckCircle2, Trash2 } from "lucide-react";
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
  if (assetType === "topic_report") return "Topic Report";
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
  if (assetType === "topic_report") {
    return "A systematic topic-level report with themes, findings, risks, and next-step recommendations.";
  }
  return "Readable, publish-oriented writing for a clear audience and angle.";
}

function assetTypeBriefPlaceholder(assetType: AssetType) {
  if (assetType === "research_brief") {
    return "Decision question, scope, intended audience, and why this brief matters";
  }
  if (assetType === "knowledge_pack") {
    return "Who this pack is for, what it includes, and why it should exist";
  }
  if (assetType === "newsletter_issue") {
    return "Theme of this issue, target reader, and what featured items it should include";
  }
  if (assetType === "topic_report") {
    return "Topic scope, key question, why it matters now, and what the report should clarify";
  }
  return "Audience, angle, thesis, and why this post should exist";
}

function assetTypeBriefGuidance(assetType: AssetType) {
  if (assetType === "research_brief") {
    return "Include the decision question, scope, intended reader, and the recommendation pressure behind the brief.";
  }
  if (assetType === "knowledge_pack") {
    return "Include who the pack serves, what materials belong in the bundle, and how readers should work through it.";
  }
  if (assetType === "newsletter_issue") {
    return "Include the issue theme, target reader, the kind of featured items to include, and the editorial tone of the send.";
  }
  if (assetType === "topic_report") {
    return "Include the topic boundary, central question, why the topic matters now, and what the report should resolve or recommend.";
  }
  return "Include the audience, angle, core thesis, and what should make this post worth reading.";
}

function assetTypeReadinessGuidance(assetType: AssetType) {
  if (assetType === "research_brief") {
    return "A strong brief usually has at least one grounded wiki angle, attached source evidence, and clear sections for executive summary, findings, risks, and recommendations.";
  }
  if (assetType === "knowledge_pack") {
    return "A strong knowledge pack usually has enough linked material to justify the bundle, a clear 'what’s included' section, a guided reading path, and readable references for later reuse.";
  }
  if (assetType === "newsletter_issue") {
    return "A strong newsletter issue usually has a clear theme, a short editor's note, a focused set of featured items, and readable references behind each highlighted item.";
  }
  if (assetType === "topic_report") {
    return "A strong topic report usually has stable wiki grounding, enough material to support themes and findings, explicit risks or gaps, and recommendations that remain traceable to references.";
  }
  return "A strong blog post usually has a clear angle, enough evidence to support the thesis, and readable references before export.";
}

function assetTypeReadinessTitle(assetType: AssetType) {
  if (assetType === "research_brief") return "Research Brief Readiness";
  if (assetType === "knowledge_pack") return "Knowledge Pack Readiness";
  if (assetType === "newsletter_issue") return "Newsletter Issue Readiness";
  if (assetType === "topic_report") return "Topic Report Readiness";
  return "Blog Post Readiness";
}

function assetTypeReadinessIntro(assetType: AssetType) {
  if (assetType === "research_brief") {
    return "Check whether this brief is evidence-backed, decision-ready, and complete enough to export.";
  }
  if (assetType === "knowledge_pack") {
    return "Check whether this pack has enough material, a clear reading path, and reusable references before export.";
  }
  if (assetType === "newsletter_issue") {
    return "Check whether this issue has a clear theme, curated featured items, and enough source grounding to send.";
  }
  if (assetType === "topic_report") {
    return "Check whether this report has enough topic grounding, clear structure, and traceable findings before export.";
  }
  return "Check whether this post has a clear angle, enough support, and readable references before export.";
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

const TOPIC_REPORT_CHECKLIST = [
  "Define the topic scope and why it matters now",
  "Anchor the report in at least one stable wiki page",
  "Surface key themes across the material",
  "Separate findings from risks and gaps",
  "End with clear recommendations and references",
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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

  const refreshAsset = async (assetId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    setSelectedId(assetId);
  };

  const refreshGeneratedAsset = async (asset: Asset) => {
    loadEditorState(asset);
    await refreshAsset(asset.id);
  };

  const saveMutation = useMutation({
    mutationFn: (payload: { assetId: string; body: { title?: string; brief?: string; outline?: string; draft_content?: string; editor_feedback?: string; opinion_notes?: string; style_notes?: string } }) =>
      assetsApi.update(payload.assetId, payload.body),
    onSuccess: async (asset) => {
      await refreshAsset(asset.id);
      setSelectedId(asset.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.delete(assetId),
    onSuccess: async (_result, assetId) => {
      if (selectedId === assetId) {
        setSelectedId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
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

  const developInAgentChat = (asset: Asset) => {
    const existingContent = (asset.draft_content || asset.outline || "").slice(0, 4000);
    navigate("/chat", {
      state: {
        workflowId: "draft-blog-asset",
        objectRef: {
          object_type: "asset",
          object_id: asset.id,
          title: asset.title,
        },
        promptSeed: [
          `Develop this ${assetTypeLabel(asset.asset_type)} as a reviewable writing asset.`,
          asset.brief ? `Brief: ${asset.brief}` : null,
          asset.source_refs.length ? `Source refs: ${asset.source_refs.join(", ")}` : null,
          asset.note_refs.length ? `Note refs: ${asset.note_refs.join(", ")}` : null,
          existingContent ? `Existing working content:\n${existingContent}` : null,
          "Return the complete proposed draft. Do not save it automatically; the user will explicitly save it back to this asset.",
        ].filter(Boolean).join("\n\n"),
      },
    });
  };

  const attachReferencesMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.attachReferences(assetId, true),
    onSuccess: async (asset) => refreshGeneratedAsset(asset),
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

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">Create an Asset from a delivery need</CardTitle>
              <CardDescription className="mt-1">Choose the audience, objective, format, and knowledge evidence before starting a Harness generation session.</CardDescription>
            </div>
            <Button onClick={() => navigate("/assets/new")}><Sparkles className="mr-2 h-4 w-4" />Create Asset</Button>
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
                      state={{ backTo: "/assets", backLabel: "Back to Assets" }}
                      className="text-[11px] text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open
                    </Link>
                    <button
                      type="button"
                      className="text-[11px] text-destructive hover:underline"
                      disabled={deleteMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete asset \"${asset.title}\"? This cannot be undone.`)) {
                          deleteMutation.mutate(asset.id);
                        }
                      }}
                    >
                      Delete
                    </button>
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
                        : selectedAsset.asset_type === "topic_report"
                          ? `Working on topic report: ${selectedAsset.title}`
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
                  {selectedAsset.asset_type === "topic_report" && (
                    <div className="rounded-lg border border-border/70 bg-background p-4">
                      <p className="text-sm font-semibold text-foreground">Topic Report Checklist</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {TOPIC_REPORT_CHECKLIST.map((item) => (
                          <div key={item} className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => developInAgentChat(selectedAsset)}>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Develop in Agent Chat
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
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (window.confirm(`Delete asset \"${selectedAsset.title}\"? This cannot be undone.`)) {
                          deleteMutation.mutate(selectedAsset.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {deleteMutation.isPending ? "Deleting…" : "Delete"}
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
                      <p className="text-xs text-muted-foreground">{assetTypeBriefGuidance(selectedAsset.asset_type)}</p>
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
                      {selectedAsset.asset_type === "topic_report" && (
                        <p className="text-xs text-muted-foreground">
                          Topic reports should attach readable references before export so themes and findings remain traceable to source material and wiki context.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>Sources: {selectedAsset.source_refs.length}</span>
                    <span>Notes: {selectedAsset.note_refs.length}</span>
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
                    <div className={`space-y-4 rounded-lg border p-4 ${readinessTone(readinessMutation.data.ready)}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{assetTypeReadinessTitle(selectedAsset.asset_type)}</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {assetTypeReadinessIntro(selectedAsset.asset_type)}
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
                        {assetTypeReadinessGuidance(selectedAsset.asset_type)}
                      </div>
                    </div>
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
