import { useLocation, useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ArrowLeft, Download, Pencil, Save, X, Trash2, List, FileText, FileDown, Bot, RefreshCw, LinkIcon, BookOpen, Bold, Italic, Heading1, Heading2, Heading3, ListChecks, ListOrdered, Quote, Code, SquareCode, Table, Check, Loader2, Sparkles, Wand2, PanelRight, Square, Cpu, Pin, History, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NoteContentRenderer, inferNoteRenderModeFromTags, type NoteRenderMode } from "@/components/NoteContentRenderer";
import { notesApi, categoriesApi, wikiApi, knowledgeApi, downloadFile, type NoteUpdate, type Note } from "@/lib/api";
import { CategorySelect } from "@/components/CategorySelect";
import { buildAssetHandoffState } from "@/lib/asset-handoff";
import { NoteAIPanel } from "@/components/NoteAIPanel";
import { VersionsDialog } from "@/components/VersionsDialog";
import { buildTitleMessages, buildEnhanceMessages, parseTitleResponse, parseModelSelector, runComplete } from "@/lib/note-ai";

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

function parseTagsCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildNoteUpdatePayload(
  draft: ReturnType<typeof noteToDraft>,
  note: Note
): NoteUpdate | null {
  const domains = parseTagsCsv(draft.domainsCsv);
  const tags = parseTagsCsv(draft.tagsCsv);
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

function ToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px self-center bg-border" />;
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
  const [editorPane, setEditorPane] = useState<"write" | "split" | "preview">("split");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [activeModel, setActiveModel] = useState<string | null>(() => localStorage.getItem("noteActiveModel") || null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [titleGenerating, setTitleGenerating] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceDraft, setEnhanceDraft] = useState<string | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const titleAbortRef = useRef<AbortController | null>(null);
  const enhanceAbortRef = useRef<AbortController | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const contentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const wasEditingRef = useRef(false);

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

  const { data: modelsData } = useQuery({
    queryKey: ["knowledge-models"],
    queryFn: () => knowledgeApi.models(),
  });
  const models = modelsData ?? [];

  useEffect(() => {
    if (activeModel) localStorage.setItem("noteActiveModel", activeModel);
    else localStorage.removeItem("noteActiveModel");
  }, [activeModel]);

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
    // Initialize the draft only when entering edit mode, so background
    // refetches (e.g. after autosave) never clobber in-progress edits.
    if (editing && !wasEditingRef.current && note) {
      setDraft(noteToDraft(note));
      setEditorPane("split");
      setAutoSaveStatus("idle");
    }
    wasEditingRef.current = editing;
  }, [note, editing]);

  // Debounced autosave: persist edits ~1.5s after the user stops changing the draft.
  useEffect(() => {
    if (!editing || !draft || !note) return;
    const payload = buildNoteUpdatePayload(draft, note);
    if (!payload) {
      setAutoSaveStatus((prev) => (prev === "saving" ? "idle" : prev));
      return;
    }
    setAutoSaveStatus("saving");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await notesApi.update(note.id, payload);
        if (cancelled) return;
        queryClient.invalidateQueries({ queryKey: ["note", id] });
        queryClient.invalidateQueries({ queryKey: ["notes"] });
        setAutoSaveStatus("saved");
      } catch {
        if (cancelled) return;
        setAutoSaveStatus("error");
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, note, editing, id, queryClient]);

  // Restore the textarea selection after a toolbar insert re-renders the content.
  useEffect(() => {
    if (pendingSelection.current && contentTextareaRef.current) {
      const [start, end] = pendingSelection.current;
      contentTextareaRef.current.focus();
      contentTextareaRef.current.setSelectionRange(start, end);
      pendingSelection.current = null;
    }
  }, [draft?.content]);

  // Resizable split-pane drag handling (no extra dependency).
  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!draggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    }
    function onUp() {
      draggingRef.current = false;
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const previewRenderMode = useMemo<NoteRenderMode>(() => {
    if (!draft) return "markdown";
    return inferNoteRenderModeFromTags(parseTagsCsv(draft.tagsCsv), draft.content || "");
  }, [draft?.tagsCsv, draft?.content]);

  const contentCounts = useMemo(() => {
    const text = draft?.content ?? "";
    const trimmed = text.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return { words, chars: text.length };
  }, [draft?.content]);

  function startSplitDrag(event: ReactMouseEvent) {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = "none";
  }

  function applyContent(nextValue: string, selection?: [number, number]) {
    setDraft((d) => (d ? { ...d, content: nextValue } : d));
    if (selection) pendingSelection.current = selection;
  }

  function insertMarkdown(kind: string) {
    const ta = contentTextareaRef.current;
    if (!ta || !draft) return;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const selected = value.slice(start, end);

    const wrap = (token: string, placeholder: string) => {
      const text = `${token}${placeholder}${token}`;
      applyContent(value.slice(0, start) + text + value.slice(end), [
        start + token.length,
        start + token.length + placeholder.length,
      ]);
    };

    switch (kind) {
      case "bold":
        return wrap("**", selected || "bold");
      case "italic":
        return wrap("*", selected || "italic");
      case "code":
        return wrap("`", selected || "code");
      case "link": {
        const placeholder = selected || "text";
        const text = `[${placeholder}](url)`;
        const urlStart = start + placeholder.length + 3;
        applyContent(value.slice(0, start) + text + value.slice(end), [urlStart, urlStart + 3]);
        return;
      }
      case "codeblock": {
        const placeholder = selected || "code";
        const text = `\n\`\`\`\n${placeholder}\n\`\`\`\n`;
        applyContent(value.slice(0, start) + text + value.slice(end), [
          start + 5,
          start + 5 + placeholder.length,
        ]);
        return;
      }
      case "table": {
        const text = `\n| Column A | Column B |\n| --- | --- |\n| cell | cell |\n`;
        applyContent(value.slice(0, start) + text + value.slice(end), [
          start + text.length,
          start + text.length,
        ]);
        return;
      }
      case "h1":
      case "h2":
      case "h3": {
        const prefix = kind === "h1" ? "# " : kind === "h2" ? "## " : "### ";
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = value.indexOf("\n", start);
        const endIdx = lineEnd === -1 ? value.length : lineEnd;
        const line = value.slice(lineStart, endIdx).replace(/^#{1,6}\s+/, "");
        const newLine = prefix + line;
        applyContent(value.slice(0, lineStart) + newLine + value.slice(endIdx), [
          lineStart + newLine.length,
          lineStart + newLine.length,
        ]);
        return;
      }
      case "quote":
      case "bullet":
      case "task":
      case "ordered": {
        const prefixes: Record<string, string> = {
          quote: "> ",
          bullet: "- ",
          task: "- [ ] ",
          ordered: "1. ",
        };
        const prefix = prefixes[kind];
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = value.indexOf("\n", start);
        const endIdx = lineEnd === -1 ? value.length : lineEnd;
        const line = value.slice(lineStart, endIdx).replace(/^(\s*)(> |- \[ \] \s*|- |\d+\. )/, "$1");
        const newLine = prefix + line;
        applyContent(value.slice(0, lineStart) + newLine + value.slice(endIdx), [
          lineStart + newLine.length,
          lineStart + newLine.length,
        ]);
        return;
      }
    }
  }

  function handleTogglePin() {
    if (!note) return;
    notesApi.togglePin(note.id).then(() => {
      queryClient.invalidateQueries({ queryKey: ["note", id] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
  }

  async function handleUploadImage(file: File) {
    if (!note || !draft) return;
    if (!file.type.startsWith("image/")) return;
    setImageUploading(true);
    try {
      const res = await notesApi.uploadImage(note.id, file);
      const alt = file.name.replace(/\.[^.]+$/, "");
      const markdown = `![${alt}](api/notes/${encodeURIComponent(note.id)}/images/${encodeURIComponent(res.id)})`;
      // Insert at cursor; if no cursor info, append.
      const ta = contentTextareaRef.current;
      if (ta) {
        const { selectionStart: start, value } = ta;
        const insert = (value && !value.endsWith("\n") ? "\n" : "") + markdown + "\n";
        applyContent(value.slice(0, start) + insert + value.slice(start), [start + insert.length, start + insert.length]);
      } else {
        applyContent((draft.content || "") + "\n" + markdown + "\n");
      }
    } catch {
      /* surfaced via toast if available; keep silent fallback */
    } finally {
      setImageUploading(false);
    }
  }

  function handleImageDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    const image = files.find((f) => f.type.startsWith("image/"));
    if (image) handleUploadImage(image);
  }

  function getSelectionText(): string {
    const ta = contentTextareaRef.current;
    if (!ta) return "";
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  }

  function insertAtCursor(text: string) {
    const ta = contentTextareaRef.current;
    if (!ta || !draft) return;
    const { selectionStart: start, value } = ta;
    const insert = text.endsWith("\n") ? text : text + "\n";
    applyContent(value.slice(0, start) + insert + value.slice(start), [
      start + insert.length,
      start + insert.length,
    ]);
  }

  function appendToContent(text: string) {
    if (!draft) return;
    const prefix = draft.content && !draft.content.endsWith("\n") ? "\n\n" : "";
    const next = draft.content + prefix + text;
    applyContent(next);
  }

  async function generateTitle() {
    if (!draft || titleGenerating) return;
    setTitleGenerating(true);
    const controller = new AbortController();
    titleAbortRef.current = controller;
    try {
      const { provider_id, model_id } = parseModelSelector(activeModel);
      const raw = await runComplete(
        { messages: buildTitleMessages(draft.content), provider_id, model_id },
        controller.signal,
      );
      const title = parseTitleResponse(raw);
      if (title) setDraft((d) => (d ? { ...d, title } : d));
    } catch {
      /* ignored: keep current title */
    } finally {
      setTitleGenerating(false);
      titleAbortRef.current = null;
    }
  }

  async function startEnhance() {
    if (!draft || enhancing) return;
    setEnhancing(true);
    setEnhanceDraft("");
    setEnhanceError(null);
    const controller = new AbortController();
    enhanceAbortRef.current = controller;
    try {
      const { provider_id, model_id } = parseModelSelector(activeModel);
      await runComplete(
        { messages: buildEnhanceMessages(draft.content), provider_id, model_id },
        controller.signal,
        (_delta, full) => setEnhanceDraft(full),
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setEnhanceError(err instanceof Error ? err.message : "Enhance failed");
      }
    } finally {
      setEnhancing(false);
      enhanceAbortRef.current = null;
    }
  }

  function stopEnhance() {
    enhanceAbortRef.current?.abort();
  }

  function applyEnhance() {
    if (enhanceDraft == null || !draft) return;
    applyContent(enhanceDraft);
    setEnhanceDraft(null);
    setEnhanceError(null);
  }

  function discardEnhance() {
    stopEnhance();
    setEnhanceDraft(null);
    setEnhanceError(null);
  }

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

  function createWikiDraftInAgent() {
    if (!note) return;
    navigate("/chat", {
      state: {
        objectRef: {
          object_type: "note",
          object_id: note.id,
          title: note.title,
        },
        workflowId: "draft-wiki-refresh",
        promptSeed: `Create a reviewable canonical wiki draft from note "${note.title}" (${note.id}). Use only explicit evidence and preserve note provenance.`,
      },
    });
  }

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

  function handleSave() {
    if (!draft || !note) return;
    const payload = buildNoteUpdatePayload(draft, note);
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
    setAiPanelOpen(false);
    discardEnhance();
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
              <Button variant="outline" size="sm" onClick={() => setVersionsOpen(true)} title="Version history">
                <History className="h-4 w-4" /> History
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTogglePin}
                title={note.is_pinned ? "Unpin" : "Pin"}
                className={note.is_pinned ? "border-primary/40 text-primary" : ""}
              >
                <Pin className={`h-4 w-4 ${note.is_pinned ? "fill-primary" : ""}`} /> {note.is_pinned ? "Pinned" : "Pin"}
              </Button>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                <select
                  value={activeModel ?? ""}
                  onChange={(e) => setActiveModel(e.target.value || null)}
                  className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer py-0.5 max-w-[180px]"
                >
                  <option value="">System Default</option>
                  {(() => {
                    const groups = new Map<string, typeof models>();
                    for (const m of models) {
                      if (!groups.has(m.provider_id)) groups.set(m.provider_id, []);
                      groups.get(m.provider_id)!.push(m);
                    }
                    return [...groups.entries()].map(([providerId, items]) => (
                      <optgroup key={providerId} label={items[0].provider_name}>
                        {items.map((m) => (
                          <option key={`${providerId}:${m.id}`} value={`${providerId}:${m.id}`}>
                            {m.display_name}
                          </option>
                        ))}
                      </optgroup>
                    ));
                  })()}
                </select>
              </div>
              <Button variant="outline" size="sm" onClick={() => setAiPanelOpen((v) => !v)} title="AI assistant">
                <PanelRight className="h-4 w-4" /> AI
              </Button>
              <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                {autoSaveStatus === "saving" && (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                  </>
                )}
                {autoSaveStatus === "saved" && (
                  <>
                    <Check className="h-3 w-3 text-emerald-500" /> Saved
                  </>
                )}
                {autoSaveStatus === "error" && <span className="text-destructive">Save failed</span>}
              </span>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saveMutation.isPending || !draft?.title.trim()}
              >
                <Save className="h-4 w-4" /> {saveMutation.isPending ? "Saving…" : "Done"}
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
                    <Button size="sm" variant="outline" onClick={createWikiDraftInAgent}>
                      <BookOpen className="h-4 w-4" /> Draft Wiki in Agent Chat
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
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => note && navigate("/assets", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: `${note.title} Brief`,
                            brief: `Create a research brief from note: ${note.title}`,
                            asset_type: "research_brief",
                            note_refs: [note.id],
                            source_refs: note.source_ids ?? [],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" /> Create Brief
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => note && navigate("/assets", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: `${note.title} Pack`,
                            brief: `Create a knowledge pack from note: ${note.title}`,
                            asset_type: "knowledge_pack",
                            note_refs: [note.id],
                            source_refs: note.source_ids ?? [],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" /> Create Pack
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => note && navigate("/assets", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: `${note.title} Issue`,
                            brief: `Create a newsletter issue from note: ${note.title}`,
                            asset_type: "newsletter_issue",
                            note_refs: [note.id],
                            source_refs: note.source_ids ?? [],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" /> Create Newsletter
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => note && navigate("/assets", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: `${note.title} Report`,
                            brief: `Create a topic report from note: ${note.title}`,
                            asset_type: "topic_report",
                            note_refs: [note.id],
                            source_refs: note.source_ids ?? [],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" /> Create Report
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
                  <div className="mt-1 flex gap-2">
                    <Input
                      value={draft.title}
                      onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                      placeholder={titleGenerating ? "Generating…" : undefined}
                      className="text-lg font-semibold"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="Generate title with AI"
                      onClick={generateTitle}
                      disabled={titleGenerating}
                      className="shrink-0"
                    >
                      {titleGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    </Button>
                  </div>
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
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">Content (Markdown)</label>
                    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                      {(["write", "split", "preview"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setEditorPane(mode)}
                          className={`cursor-pointer rounded px-2 py-0.5 text-[11px] capitalize transition-colors ${
                            editorPane === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(editorPane === "write" || editorPane === "split") && (
                    <div className="mt-1 flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-muted/30 p-1">
                      <ToolbarButton title="Bold" onClick={() => insertMarkdown("bold")}><Bold className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Italic" onClick={() => insertMarkdown("italic")}><Italic className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Inline code" onClick={() => insertMarkdown("code")}><Code className="h-4 w-4" /></ToolbarButton>
                      <ToolbarDivider />
                      <ToolbarButton title="Heading 1" onClick={() => insertMarkdown("h1")}><Heading1 className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Heading 2" onClick={() => insertMarkdown("h2")}><Heading2 className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Heading 3" onClick={() => insertMarkdown("h3")}><Heading3 className="h-4 w-4" /></ToolbarButton>
                      <ToolbarDivider />
                      <ToolbarButton title="Bulleted list" onClick={() => insertMarkdown("bullet")}><List className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Task list" onClick={() => insertMarkdown("task")}><ListChecks className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Numbered list" onClick={() => insertMarkdown("ordered")}><ListOrdered className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Quote" onClick={() => insertMarkdown("quote")}><Quote className="h-4 w-4" /></ToolbarButton>
                      <ToolbarDivider />
                      <ToolbarButton title="Link" onClick={() => insertMarkdown("link")}><LinkIcon className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Code block" onClick={() => insertMarkdown("codeblock")}><SquareCode className="h-4 w-4" /></ToolbarButton>
                      <ToolbarButton title="Table" onClick={() => insertMarkdown("table")}><Table className="h-4 w-4" /></ToolbarButton>
                      <ToolbarDivider />
                      <ToolbarButton title="Enhance with AI" onClick={startEnhance}><Wand2 className="h-4 w-4" /></ToolbarButton>
                    </div>
                  )}

                  <div
                    ref={splitContainerRef}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleImageDrop}
                    className={`mt-1 relative flex h-[60vh] overflow-hidden rounded-md border border-border ${dragOver ? "border-primary ring-2 ring-primary/30" : ""}`}
                  >
                    {dragOver && (
                      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 text-sm font-medium text-primary">
                        <ImagePlus className="mr-2 h-5 w-5" /> Drop image to insert
                      </div>
                    )}
                    {(editorPane === "write" || editorPane === "split") && (
                      <div
                        style={{ width: editorPane === "split" ? `${splitRatio * 100}%` : "100%" }}
                        className="flex min-w-0 flex-col"
                      >
                        <Textarea
                          ref={contentTextareaRef}
                          value={draft.content}
                          onChange={(e) => setDraft((d) => (d ? { ...d, content: e.target.value } : d))}
                          placeholder="Write your note in markdown…"
                          className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0"
                        />
                      </div>
                    )}
                    {editorPane === "split" && (
                      <div
                        onMouseDown={startSplitDrag}
                        className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
                      />
                    )}
                    {(editorPane === "preview" || editorPane === "split") && (
                      <div
                        style={{ width: editorPane === "split" ? `${(1 - splitRatio) * 100}%` : "100%" }}
                        className="min-w-0 overflow-y-auto bg-background"
                      >
                        <div className="prose prose-sm max-w-none p-4">
                          <NoteContentRenderer content={draft.content || ""} mode={previewRenderMode} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{contentCounts.words} words · {contentCounts.chars} chars</span>
                    {autoSaveStatus === "error" && <span className="text-destructive">Last autosave failed</span>}
                  </div>
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
                  <NoteContentRenderer content={note.content || ""} mode={renderMode} noteId={note.id} />
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

      <VersionsDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        noteId={note.id}
        onRestored={() => {
          queryClient.invalidateQueries({ queryKey: ["note", id] });
          setEditing(false);
          setDraft(null);
        }}
      />

      <Dialog open={enhanceDraft !== null} onOpenChange={(o) => { if (!o) discardEnhance(); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4" /> AI Enhance
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto rounded-md border border-border p-4">
            {enhanceDraft ? (
              <div className="prose prose-sm max-w-none">
                <NoteContentRenderer content={enhanceDraft} mode="markdown" />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Generating…</p>
            )}
            {enhanceError && <p className="mt-2 text-sm text-destructive">{enhanceError}</p>}
          </div>
          <div className="flex items-center justify-between pt-3">
            <span className="text-xs text-muted-foreground">
              {enhancing ? "Streaming rewrite…" : "Review the enhanced note before applying."}
            </span>
            <div className="flex gap-2">
              {enhancing ? (
                <Button variant="destructive" size="sm" onClick={stopEnhance}>
                  <Square className="h-3.5 w-3.5 fill-current" /> Stop
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={discardEnhance}>Discard</Button>
                  <Button size="sm" onClick={applyEnhance} disabled={!enhanceDraft}>
                    <Check className="h-3.5 w-3.5" /> Apply
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <NoteAIPanel
        open={aiPanelOpen}
        onClose={() => setAiPanelOpen(false)}
        activeModel={activeModel}
        noteTitle={draft?.title ?? note?.title ?? ""}
        getSelection={getSelectionText}
        onInsert={insertAtCursor}
        onAppend={appendToContent}
      />

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
