import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Download, Pencil, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { notesApi, type NoteUpdate } from "@/lib/api";

const NOTE_TYPES = ["inbox", "architecture", "case-study", "concept", "how-to"] as const;

function noteToDraft(note: {
  title: string;
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
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof noteToDraft> | null>(null);

  const { data: note, isLoading, error } = useQuery({
    queryKey: ["note", id],
    queryFn: () => notesApi.get(id!),
    enabled: !!id,
  });

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
    setDraft(noteToDraft(note));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/notes")}>
            <ArrowLeft className="h-4 w-4" /> Back to Notes
          </Button>
          {!editing ? (
            <Button variant="outline" size="sm" onClick={startEdit}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
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
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1 min-w-0">
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
            ) : (
              <>
                <h1 className="text-2xl font-bold mb-2">{note.title}</h1>
                {note.abstract && (
                  <p className="text-muted-foreground text-sm mb-6 border-l-2 border-primary pl-3">
                    {note.abstract}
                  </p>
                )}
                {note.file_path && (
                  <div className="mb-4">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`/api/notes/${encodeURIComponent(note.id)}/file`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Download className="h-4 w-4" /> Open Stored File
                      </a>
                    </Button>
                  </div>
                )}
                <div className="prose">
                  <ReactMarkdown>{note.content || "*No content*"}</ReactMarkdown>
                </div>
              </>
            )}
          </div>

          {!editing && (
            <aside className="lg:w-64 shrink-0 space-y-4">
              <div className="rounded-lg border border-border p-4 space-y-3 text-sm">
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
                          onClick={() => navigate(`/sources/${encodeURIComponent(sid)}`)}
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
    </div>
  );
}
