import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, StickyNote, Upload, ChevronDown, ChevronRight, FolderOpen, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CategorySelect } from "@/components/CategorySelect";
import { notesApi, categoriesApi, type NoteCreate, type Note } from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { useRouteFocusRestoration } from "@/hooks/useRouteFocusRestoration";
import { useSessionStringSet } from "@/hooks/useSessionStringSet";

const NOTE_TYPES = ["inbox", "architecture", "case-study", "concept", "how-to", "remember"];

export function NotesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const requestedType = searchParams.get("type") ?? "";
  const typeFilter = NOTE_TYPES.includes(requestedType) ? requestedType : "";
  const requestedCategory = Number(searchParams.get("category"));
  const categoryFilter = Number.isInteger(requestedCategory) && requestedCategory > 0
    ? requestedCategory
    : null;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NoteCreate>({ title: "", category_id: 1, note_type: "inbox", content: "", domains: [], tags: [] });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useSessionStringSet("notes-collapsed-categories");

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const categories = categoriesData?.items ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["notes", typeFilter, categoryFilter],
    queryFn: () => notesApi.list({ note_type: typeFilter || undefined, category_id: categoryFilter ?? undefined, limit: 100 }),
  });
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>("notes-list", Boolean(data));
  const { rememberFocus } = useRouteFocusRestoration("notes-list", Boolean(data));

  // Group notes by category
  const groupedNotes = useMemo(() => {
    if (!data?.items) return [];
    const groups = new Map<string, { categoryId: number; categoryName: string; displayName: string; notes: Note[] }>();

    for (const note of data.items) {
      const key = note.category_name || "general";
      if (!groups.has(key)) {
        const cat = categories.find((c) => c.name === key);
        groups.set(key, {
          categoryId: note.category_id,
          categoryName: key,
          displayName: cat?.display_name || key,
          notes: [],
        });
      }
      groups.get(key)!.notes.push(note);
    }

    // Sort: "general" last, others alphabetically
    return [...groups.values()].sort((a, b) => {
      if (a.categoryName === "general") return 1;
      if (b.categoryName === "general") return -1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [data?.items, categories]);

  const pinnedNotes = useMemo(() => {
    return (data?.items ?? []).filter((n) => n.is_pinned);
  }, [data?.items]);

  const pinMutation = useMutation({
    mutationFn: (noteId: string) => notesApi.togglePin(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });

  function handlePinToggle(noteId: string, e: React.MouseEvent) {
    e.stopPropagation();
    pinMutation.mutate(noteId);
  }

  const toggleCategory = (name: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const noteDetailState = useMemo(() => ({
    backTo: `/notes${searchParams.toString() ? `?${searchParams.toString()}` : ""}`,
    backLabel: "Back to Notes",
  }), [searchParams]);

  const updateTypeFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("type", value);
    else next.delete("type");
    setSearchParams(next, { replace: true });
  };

  const updateCategoryFilter = (value: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value !== null) next.set("category", String(value));
    else next.delete("category");
    setSearchParams(next, { replace: true });
  };

  const createMutation = useMutation({
    mutationFn: notesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setOpen(false);
      setForm({ title: "", category_id: 1, note_type: "inbox", content: "", domains: [], tags: [] });
      setUploadFile(null);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: notesApi.upload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setOpen(false);
      setForm({ title: "", category_id: 1, note_type: "inbox", content: "", domains: [], tags: [] });
      setUploadFile(null);
    },
  });

  function buildUploadPayload() {
    if (!uploadFile) return null;
    const payload = new FormData();
    payload.append("file", uploadFile);
    payload.append("title", form.title || uploadFile.name.replace(/\.[^.]+$/, ""));
    payload.append("note_type", form.note_type || "inbox");
    payload.append("category_id", String(form.category_id));
    payload.append("domains", (form.domains || []).join(","));
    payload.append("tags", (form.tags || []).join(","));
    payload.append("abstract", form.abstract || "");
    payload.append("project", form.project || "");
    payload.append("status", form.status || "seed");
    payload.append("confidence", form.confidence || "medium");
    payload.append("source_ids", (form.source_ids || []).join(","));
    return payload;
  }

  function submitNote() {
    const payload = buildUploadPayload();
    if (payload) {
      uploadMutation.mutate(payload);
      return;
    }
    createMutation.mutate(form);
  }

  // Should we show grouped view? Only when not filtering by a specific category
  const showGrouped = categoryFilter === null && groupedNotes.length > 1;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto"
      data-route-scroll="notes-list"
    >
      <div className="max-w-5xl mx-auto px-6 py-8">
        <ModuleSectionNav parent="knowledge" active="Notes" />

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Notes</h1>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4" /> New Note</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Note</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  Notes are your own writing: observations, summaries, drafts, and confirmed personal knowledge. Attach sources when a note refers to external evidence.
                </p>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
                <div className="flex gap-2 flex-wrap">
                  <select
                    className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
                    value={form.note_type}
                    onChange={(e) => setForm({ ...form, note_type: e.target.value })}
                  >
                    {NOTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <CategorySelect
                    categories={categories}
                    value={form.category_id}
                    onChange={(id) => setForm({ ...form, category_id: id })}
                  />
                </div>
                <Input
                  placeholder="Domains (comma separated)"
                  onChange={(e) => setForm({ ...form, domains: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                />
                <Input
                  placeholder="Tags (comma separated)"
                  onChange={(e) => setForm({ ...form, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                />
                <label className="flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.tags?.includes("render:html") || false}
                    onChange={(e) => {
                      const current = new Set(form.tags || []);
                      if (e.target.checked) current.add("render:html");
                      else current.delete("render:html");
                      setForm({ ...form, tags: Array.from(current) });
                    }}
                  />
                  Render this note as HTML
                </label>
                <Input
                  placeholder="Abstract"
                  value={form.abstract || ""}
                  onChange={(e) => setForm({ ...form, abstract: e.target.value })}
                />
                <Textarea
                  placeholder="Content (Markdown)"
                  rows={8}
                  value={form.content || ""}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
                <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Upload className="h-4 w-4" />
                    Upload a Markdown or text file to store it in MinIO.
                  </div>
                  <Input
                    type="file"
                    accept=".md,.markdown,.txt,.json"
                    onChange={(e) => {
                      const nextFile = e.target.files?.[0] || null;
                      setUploadFile(nextFile);
                      if (nextFile && !form.title) {
                        setForm({ ...form, title: nextFile.name.replace(/\.[^.]+$/, "") });
                      }
                    }}
                  />
                  {uploadFile && (
                    <p className="text-xs text-muted-foreground">Selected file: {uploadFile.name}</p>
                  )}
                </div>
                <Button
                  className="w-full"
                  onClick={submitNote}
                  disabled={!form.title || createMutation.isPending || uploadMutation.isPending}
                >
                  {uploadMutation.isPending
                    ? "Uploading..."
                    : createMutation.isPending
                      ? "Creating..."
                      : uploadFile
                        ? "Upload & Create"
                        : "Create"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Category filter */}
        <div className="flex gap-2 mb-2 flex-wrap">
          <button
              onClick={() => updateCategoryFilter(null)}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              categoryFilter === null ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All Categories
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => updateCategoryFilter(c.id)}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                categoryFilter === c.id ? "bg-emerald-500/20 text-emerald-600 font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {c.display_name}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
              onClick={() => updateTypeFilter("")}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              !typeFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {NOTE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => updateTypeFilter(t)}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                typeFilter === t ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {data && data.total === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <StickyNote className="h-12 w-12 mb-3 opacity-30" />
            <p>No notes yet. Create one when you want to save your own writing, synthesis, or confirmed takeaways.</p>
          </div>
        )}

        {pinnedNotes.length > 0 && showGrouped && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Pin className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Pinned</span>
              <span className="text-xs text-muted-foreground">({pinnedNotes.length})</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {pinnedNotes.map((note) => (
                <NoteCard key={note.id} note={note} onClick={() => { rememberFocus(note.id); navigate(`/notes/${encodeURIComponent(note.id)}`, { state: noteDetailState }); }} onPinToggle={(e) => handlePinToggle(note.id, e)} />
              ))}
            </div>
          </div>
        )}

        {showGrouped ? (
          /* Grouped by category */
          <div className="space-y-6">
            {groupedNotes.map((group) => {
              const isCollapsed = collapsedCategories.has(group.categoryName);
              return (
                <div key={group.categoryName}>
                  <button
                    onClick={() => toggleCategory(group.categoryName)}
                    className="flex items-center gap-2 mb-3 cursor-pointer group"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                    <FolderOpen className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm font-semibold">{group.displayName}</span>
                    <span className="text-xs text-muted-foreground">({group.notes.length})</span>
                  </button>
                  {!isCollapsed && (
                    <div className="grid gap-3 md:grid-cols-2">
                      {group.notes.filter((note) => !note.is_pinned).map((note) => (
                        <NoteCard key={note.id} note={note} onClick={() => { rememberFocus(note.id); navigate(`/notes/${encodeURIComponent(note.id)}`, { state: noteDetailState }); }} onPinToggle={(e) => handlePinToggle(note.id, e)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Flat list (filtered by category or only one category) */
          <div className="grid gap-3 md:grid-cols-2">
            {data?.items.filter((note) => !note.is_pinned).map((note) => (
              <NoteCard key={note.id} note={note} onClick={() => { rememberFocus(note.id); navigate(`/notes/${encodeURIComponent(note.id)}`, { state: noteDetailState }); }} onPinToggle={(e) => handlePinToggle(note.id, e)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({ note, onClick, onPinToggle }: { note: Note; onClick: () => void; onPinToggle?: (e: React.MouseEvent) => void }) {
  const preview = buildNotePreview(note);

  return (
    <Card
      role="link"
      tabIndex={0}
      data-route-focus-id={note.id}
      className={`cursor-pointer hover:border-primary/40 transition-colors ${note.is_pinned ? "border-primary/50" : ""}`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="note">{note.note_type}</Badge>
          <Badge variant="outline">{note.status}</Badge>
          {note.is_pinned && (
            <Badge variant="outline" className="text-primary border-primary/40"><Pin className="h-2.5 w-2.5 inline-block mr-0.5" />Pinned</Badge>
          )}
          {onPinToggle && (
            <button
              type="button"
              title={note.is_pinned ? "Unpin" : "Pin"}
              onClick={onPinToggle}
              className={`ml-auto cursor-pointer rounded p-1 transition-colors hover:bg-accent ${note.is_pinned ? "text-primary" : "text-muted-foreground/50 hover:text-foreground"}`}
            >
              <Pin className={`h-3.5 w-3.5 ${note.is_pinned ? "fill-primary" : ""}`} />
            </button>
          )}
        </div>
        <CardTitle className="text-sm">{note.title}</CardTitle>
        {preview && (
          <CardDescription className="line-clamp-3 whitespace-pre-line">{preview}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1">
          {note.domains.map((d) => (
            <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{d}</span>
          ))}
          {note.tags.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">#{t}</span>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          {new Date(note.updated_at).toLocaleDateString()} · {note.word_count ?? 0} words
        </p>
      </CardContent>
    </Card>
  );
}

function buildNotePreview(note: Note) {
  const source = note.abstract?.trim() || note.content?.trim() || "";
  if (!source) return "";

  return source
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
