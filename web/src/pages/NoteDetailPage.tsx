import { useLocation, useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useMemo, useRef } from "react";
import { ArrowLeft, Download, Pencil, Save, X, Trash2, List, FileText, FileDown, Bot, RefreshCw, LinkIcon, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NoteContentRenderer, inferNoteRenderModeFromTags, type NoteRenderMode } from "@/components/NoteContentRenderer";
import { notesApi, categoriesApi, wikiApi, downloadFile, type NoteUpdate } from "@/lib/api";
import { CategorySelect } from "@/components/CategorySelect";
import { buildAssetHandoffState } from "@/lib/asset-handoff";

const NOTE_TYPES = ["inbox", "architecture", "case-study", "concept", "how-to", "remember"] as const;

type ViewMode = "full" | "slices";

/** Split note content into sections by markdown headings or --- separators. */
function splitSections(content: string): { title: string; content: string }[] {
  if (!content.trim()) return [];
  // Split on --- page separators (VLM output) or ## headings
  const parts = content.split(/\n---\n|\n(?=#{1,3}\s)/);
  return parts
    .map((part, idx) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      // Extract heading as title if present
      const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
      const title = headingMatch ? headingMatch[2] : `Section ${idx + 1}`;
      return { title, content: trimmed };
    })
    .filter(Boolean) as { title: string; content: string }[];
}

function noteToDraft(note: {
  title: string;
  category_id: number;
  abstract?: string | null;
  content?: string | null;
  note_type: string;
  status: string;
  confidence: string;
  project?: string | null;
  domains: string[];
  tags: string[];
}) {
  return {
    title: note.title,
    category_id: note.category_id,
    abstract: note.abstract ?? "",
    content: note.content ?? "",
    note_type: note.note_type,
    status: note.status,
    confidence: note.confidence,
    project: note.project ?? "",
    domainsCsv: note.domains.join(", "),
    tagsCsv: note.tags.join(", "),
  };
}

export function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/notes";
  const backLabel = locationState?.backLabel || "Back to Notes";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof noteToDraft> | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [renderMode, setRenderMode] = useState<NoteRenderMode>("markdown");
  const [selectedSection, setSelectedSection] = useState(0);
  const [sourceIdInput, setSourceIdInput] = useState("");
  const [queuedRefreshCount, setQueuedRefreshCount] = useState<number | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const { data: note, isLoading, error } = useQuery({
    queryKey: ["note", id],
    queryFn: () => notesApi.get(id!),
    enabled: !!id,
  });

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const categories = categoriesData?.items ?? [];

  const sections = useMemo(() => {
    if (!note?.content) return [];
    return splitSections(note.content);
  }, [note?.content]);

  useEffect(() => {
    setRenderMode(inferNoteRenderModeFromTags(note?.tags, note?.content || ""));
  }, [note?.content, note?.tags]);

  // Highlight range for the selected section in the preview panel
  const highlightRange = useMemo(() => {
    if (!note?.content || !sections[selectedSection]) return null;
    const sectionContent = sections[selectedSection].content;
    const idx = note.content.indexOf(sectionContent);
    if (idx === -1) return null;
    return { start: idx, end: idx + sectionContent.length };
  }, [sections, selectedSection, note?.content]);

  useEffect(() => {
    if (!previewRef.current) return;
    const mark = previewRef.current.querySelector("[data-highlight]");
    if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRange]);

  useEffect(() => {
    if (note && editing) {
      setDraft(noteToDraft(note));
    }
  }, [note, editing]);

  const saveMutation = useMutation({
    mutationFn: (payload: NoteUpdate) => notesApi.update(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setEditing(false);
      setDraft(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => notesApi.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      navigate(backTo);
    },
  });

  const attachSourceMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      if (!note) throw new Error("Note is not loaded");
      const source_ids = Array.from(new Set([...(note.source_ids || []), sourceId.trim()])).filter(Boolean);
      return notesApi.update(note.id, { source_ids });
    },
    onSuccess: () => {
      setSourceIdInput("");
      queryClient.invalidateQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });

  const queueWikiRefreshMutation = useMutation({
    mutationFn: async () => {
      if (!note) throw new Error("Note is not loaded");
      return wikiApi.suggest({ trigger_type: "note", trigger_id: note.id, limit: 5 });
    },
    onSuccess: (suggestions) => {
      setQueuedRefreshCount(suggestions.length);
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  const createWikiDraftMutation = useMutation({
    mutationFn: async () => {
      if (!note) throw new Error("Note is not loaded");
      return wikiApi.compile({
        title: note.title,
        page_type: "topic",
        note_ids: [note.id],
        instructions: `Create a draft canonical wiki page from note ${note.id}. Keep it reviewable and evidence-backed.`,
      });
    },
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      navigate(`/wiki/${encodeURIComponent(page.id)}`, {
        state: { backTo: `/notes/${encodeURIComponent(note?.id || id!)}`, backLabel: "Back to Note" },
      });
    },
  });

  function askAgentAboutNote() {
    if (!note) return;
    navigate("/chat", {
      state: {
        objectRef: {
          object_type: "note",
          object_id: note.id,
          title: note.title,
        },
        workflowId: "summarize-source",
        promptSeed: `Use note "${note.title}" (${note.id}) to help me understand its core claims, extract reusable knowledge, and judge whether it should stay as a note, become a knowledge candidate, or support a wiki draft.`,
      },
    });
  }

  function buildUpdatePayload(): NoteUpdate | null {
    if (!draft || !note) return null;
    const domains = draft.domainsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = draft.tagsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload: NoteUpdate = {};
    if (draft.title !== note.title) payload.title = draft.title;
    if (draft.category_id !== note.category_id) payload.category_id = draft.category_id;
    if (draft.abstract !== (note.abstract ?? "")) payload.abstract = draft.abstract || null;
    if (draft.content !== (note.content ?? "")) payload.content = draft.content;
    if (draft.note_type !== note.note_type) payload.note_type = draft.note_type;
    if (draft.status !== note.status) payload.status = draft.status;
    if (draft.confidence !== note.confidence) payload.confidence = draft.confidence;
    if (draft.project !== (note.project ?? "")) payload.project = draft.project || null;
    const sameDomains =
      domains.length === note.domains.length && domains.every((d, i) => d === note.domains[i]);
    const sameTags =
      tags.length === note.tags.length && tags.every((t, i) => t === note.tags[i]);
    if (!sameDomains) payload.domains = domains;
    if (!sameTags) payload.tags = tags;
    return Object.keys(payload).length > 0 ? payload : null;
  }

  function handleSave() {
    const payload = buildUpdatePayload();
    if (!payload) {
      setEditing(false);
      setDraft(null);
      return;
    }
    saveMutation.mutate(payload);
  }

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (error || !note) return <div className="p-8 text-destructive">Note not found.</div>;

  const startEdit = () => {
    setViewMode("full");
    setDraft(noteToDraft(note));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };

  const hasSections = sections.length > 1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          {!editing ? (
            <>
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => notesApi.exportPdf(note.id, note.title)}
              >
                <FileDown className="h-4 w-4" /> Export PDF
              </Button>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saveMutation.isPending || !draft?.title.trim()}
              >
                <Save className="h-4 w-4" /> {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saveMutation.isPending}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </>
          )}
          {!editing && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                <button
                  onClick={() => setViewMode("full")}
                  className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${viewMode === "full" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >
                  <FileText className="h-3.5 w-3.5 inline-block mr-1" />Full
                </button>
                <button
                  onClick={() => setViewMode("slices")}
                  className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${viewMode === "slices" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >
                  <List className="h-3.5 w-3.5 inline-block mr-1" />Slices
                </button>
              </div>
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                {(["markdown", "html", "raw"] as NoteRenderMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setRenderMode(mode)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${renderMode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                  >
                    {mode.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1 min-w-0">
            {!editing && (
              <div className="mb-6 rounded-lg border border-border bg-card p-4">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-sm font-medium">Actions</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Notes are your own writing and synthesis. Attach sources when this note refers to external evidence, or queue a wiki refresh if it may affect stable knowledge.
                    </p>
                    {queuedRefreshCount !== null && (
                      <button
                        type="button"
                        onClick={() => navigate("/review/wiki-suggestions")}
                        className="mt-2 text-xs text-primary hover:underline"
                      >
                        {queuedRefreshCount > 0
                          ? `Wiki refresh queued for ${queuedRefreshCount} page${queuedRefreshCount === 1 ? "" : "s"}. View queue.`
                          : "No matching wiki pages found yet."}
                      </button>
                    )}
                    {queueWikiRefreshMutation.isError && (
                      <p className="mt-2 text-xs text-destructive">
                        {queueWikiRefreshMutation.error instanceof Error ? queueWikiRefreshMutation.error.message : "Failed to queue wiki refresh"}
                      </p>
                    )}
                    {attachSourceMutation.isError && (
                      <p className="mt-2 text-xs text-destructive">
                        {attachSourceMutation.error instanceof Error ? attachSourceMutation.error.message : "Failed to attach source"}
                      </p>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                    <div className="flex min-w-64 gap-2">
                      <Input
                        value={sourceIdInput}
                        onChange={(event) => setSourceIdInput(event.target.value)}
                        placeholder="src-..."
                        className="h-9"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => attachSourceMutation.mutate(sourceIdInput)}
                        disabled={!sourceIdInput.trim() || attachSourceMutation.isPending}
                      >
                        <LinkIcon className="h-4 w-4" /> Attach Source
                      </Button>
                    </div>
                    <Button size="sm" onClick={() => queueWikiRefreshMutation.mutate()} disabled={queueWikiRefreshMutation.isPending}>
                      <RefreshCw className={`h-4 w-4 ${queueWikiRefreshMutation.isPending ? "animate-spin" : ""}`} /> Queue Wiki Refresh
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => createWikiDraftMutation.mutate()} disabled={createWikiDraftMutation.isPending}>
                      <BookOpen className="h-4 w-4" /> {createWikiDraftMutation.isPending ? "Creating…" : "Create Wiki Draft"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => note && navigate("/assets", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: note.title,
                            brief: `Create a blog asset from note: ${note.title}`,
                            note_refs: [note.id],
                            source_refs: note.source_ids ?? [],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" /> Create Asset
                    </Button>
                    <Button size="sm" variant="outline" onClick={askAgentAboutNote}>
                      <Bot className="h-4 w-4" /> Ask Agent
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {editing && draft ? (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Title</label>
                  <Input
                    value={draft.title}
                    onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                    className="mt-1 text-lg font-semibold"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Abstract</label>
                  <Textarea
                    value={draft.abstract}
                    onChange={(e) => setDraft((d) => (d ? { ...d, abstract: e.target.value } : d))}
                    rows={3}
                    className="mt-1"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Type</label>
                    <select
                      value={draft.note_type}
                      onChange={(e) => setDraft((d) => (d ? { ...d, note_type: e.target.value } : d))}
                      className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {NOTE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Category</label>
                    <div className="mt-1">
                      <CategorySelect
                        categories={categories}
                        value={draft.category_id}
                        onChange={(id) => setDraft((d) => (d ? { ...d, category_id: id } : d))}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Project</label>
                    <Input
                      value={draft.project}
                      onChange={(e) => setDraft((d) => (d ? { ...d, project: e.target.value } : d))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Status</label>
                    <Input
                      value={draft.status}
                      onChange={(e) => setDraft((d) => (d ? { ...d, status: e.target.value } : d))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Confidence</label>
                    <Input
                      value={draft.confidence}
                      onChange={(e) => setDraft((d) => (d ? { ...d, confidence: e.target.value } : d))}
                      className="mt-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Domains (comma-separated)</label>
                  <Input
                    value={draft.domainsCsv}
                    onChange={(e) => setDraft((d) => (d ? { ...d, domainsCsv: e.target.value } : d))}
                    className="mt-1 font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    value={draft.tagsCsv}
                    onChange={(e) => setDraft((d) => (d ? { ...d, tagsCsv: e.target.value } : d))}
                    className="mt-1 font-mono text-sm"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Add <code>render:html</code> to explicitly render this note as HTML.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Content (Markdown)</label>
                  <Textarea
                    value={draft.content}
                    onChange={(e) => setDraft((d) => (d ? { ...d, content: e.target.value } : d))}
                    rows={24}
                    className="mt-1 font-mono text-sm"
                  />
                </div>
                {saveMutation.isError && (
                  <p className="text-sm text-destructive">
                    {saveMutation.error instanceof Error ? saveMutation.error.message : "Save failed"}
                  </p>
                )}
              </div>
            ) : viewMode === "full" ? (
              <>
                <h1 className="text-2xl font-bold mb-2">{note.title}</h1>
                <p className="mb-3 text-sm text-muted-foreground">
                  Your own note: writing, synthesis, or confirmed takeaways that may reference sources.
                </p>
                {note.abstract && (
                  <p className="text-muted-foreground text-sm mb-6 border-l-2 border-primary pl-3">
                    {note.abstract}
                  </p>
                )}
                {note.file_path && (
                  <div className="mb-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadFile(`/notes/${encodeURIComponent(note.id)}/file`, note.title)}
                    >
                      <Download className="h-4 w-4" /> Download Source File
                    </Button>
                  </div>
                )}
                <div className="prose max-h-[70vh] overflow-y-auto">
                  <NoteContentRenderer content={note.content || ""} mode={renderMode} />
                </div>
              </>
            ) : (
              /* Slices view */
              <>
                <h1 className="text-2xl font-bold mb-2">{note.title}</h1>
                <p className="mb-3 text-sm text-muted-foreground">
                  Your own note: writing, synthesis, or confirmed takeaways that may reference sources.
                </p>
                {note.abstract && (
                  <p className="text-muted-foreground text-sm mb-4 border-l-2 border-primary pl-3">
                    {note.abstract}
                  </p>
                )}
                <div className="flex gap-4" style={{ height: "calc(100vh - 360px)" }}>
                  {/* Left: Section list */}
                  <div className="w-56 shrink-0 rounded-lg border border-border overflow-y-auto">
                    <div className="p-2 border-b border-border bg-muted/30">
                      <span className="text-xs font-medium text-muted-foreground">
                        {hasSections ? `${sections.length} sections` : "No sections"}
                      </span>
                    </div>
                    {hasSections && sections.map((sec, idx) => (
                      <button
                        key={idx}
                        onClick={() => setSelectedSection(idx)}
                        className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors cursor-pointer ${
                          selectedSection === idx
                            ? "bg-primary/10 border-l-2 border-l-primary"
                            : "hover:bg-accent/50"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-medium ${selectedSection === idx ? "text-primary" : "text-foreground"}`}>
                            #{idx + 1}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {sec.content.length} chars
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                          {sec.title}
                        </p>
                      </button>
                    ))}
                    {!hasSections && (
                      <div className="p-4 text-xs text-muted-foreground text-center">
                        Content has only one section.
                      </div>
                    )}
                  </div>

                  {/* Center: Section detail */}
                  <div className="flex-1 min-w-0 rounded-lg border border-border overflow-y-auto">
                    <div className="p-2 border-b border-border bg-muted/30 flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">Section Details</span>
                      {hasSections && (
                        <span className="text-[10px] text-muted-foreground">
                          #{selectedSection + 1} / {sections.length}
                        </span>
                      )}
                    </div>
                    <div className="p-4">
                      {hasSections && sections[selectedSection] ? (
                        <div className="prose text-sm">
                          <NoteContentRenderer content={sections[selectedSection].content} mode={renderMode} />
                        </div>
                      ) : (
                        <div className="prose text-sm">
                          <NoteContentRenderer content={note.content || ""} mode={renderMode} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right: Preview with highlight */}
                  <div className="w-80 shrink-0 rounded-lg border border-border overflow-y-auto" ref={previewRef}>
                    <div className="p-2 border-b border-border bg-muted/30">
                      <span className="text-xs font-medium text-muted-foreground">Preview Source</span>
                    </div>
                    <div className="p-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground">
                      {note.content ? (
                        highlightRange ? (
                          <>
                            {note.content.slice(0, highlightRange.start)}
                            <mark data-highlight className="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded px-0.5">
                              {note.content.slice(highlightRange.start, highlightRange.end)}
                            </mark>
                            {note.content.slice(highlightRange.end)}
                          </>
                        ) : (
                          note.content
                        )
                      ) : (
                        "*No content*"
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {!editing && viewMode === "full" && (
            <aside className="lg:w-64 shrink-0 space-y-4">
              <div className="rounded-lg border border-border p-4 space-y-3 text-sm">
                {note.category_name && (
                  <div>
                    <span className="text-muted-foreground text-xs">Category</span>
                    <div className="mt-1">
                      <Badge variant="secondary">{note.category_name}</Badge>
                    </div>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground text-xs">Type</span>
                  <div className="mt-1">
                    <Badge variant="note">{note.note_type}</Badge>
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Status / Confidence</span>
                  <div className="mt-1 flex gap-1">
                    <Badge variant="outline">{note.status}</Badge>
                    <Badge variant="outline">{note.confidence}</Badge>
                  </div>
                </div>
                {note.project && (
                  <div>
                    <span className="text-muted-foreground text-xs">Project</span>
                    <p className="mt-1">{note.project}</p>
                  </div>
                )}
                {note.domains.length > 0 && (
                  <div>
                    <span className="text-muted-foreground text-xs">Domains</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {note.domains.map((d) => (
                        <Badge key={d} variant="secondary">
                          {d}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {note.tags.length > 0 && (
                  <div>
                    <span className="text-muted-foreground text-xs">Tags</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {note.tags.map((t) => (
                        <Badge key={t} variant="secondary">
                          #{t}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {note.source_ids.length > 0 && (
                  <div>
                    <span className="text-muted-foreground text-xs">Source References</span>
                    <div className="mt-1 space-y-1">
                      {note.source_ids.map((sid) => (
                        <button
                          key={sid}
                          type="button"
                          onClick={() => navigate(`/sources/${encodeURIComponent(sid)}`, { state: { backTo: `/notes/${encodeURIComponent(note.id)}`, backLabel: "Back to Note" } })}
                          className="block text-xs text-primary hover:underline cursor-pointer"
                        >
                          {sid}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="border-t border-border pt-3 text-xs text-muted-foreground space-y-1">
                  <p>Created: {new Date(note.created_at).toLocaleString()}</p>
                  <p>Updated: {new Date(note.updated_at).toLocaleString()}</p>
                  <p>Words: {note.word_count ?? 0}</p>
                  <p className="font-mono text-[10px] break-all">{note.id}</p>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Note</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">"{note.title}"</span>? This action cannot be undone.
          </p>
          {deleteMutation.isError && (
            <p className="text-sm text-destructive">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Delete failed"}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
