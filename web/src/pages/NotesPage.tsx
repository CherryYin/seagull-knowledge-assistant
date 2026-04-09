import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, StickyNote, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notesApi, type NoteCreate } from "@/lib/api";

const NOTE_TYPES = ["inbox", "architecture", "case-study", "concept", "how-to"];

export function NotesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NoteCreate>({ title: "", note_type: "inbox", content: "", domains: [], tags: [] });
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["notes", typeFilter],
    queryFn: () => notesApi.list({ note_type: typeFilter || undefined, limit: 50 }),
  });

  const createMutation = useMutation({
    mutationFn: notesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setOpen(false);
      setForm({ title: "", note_type: "inbox", content: "", domains: [], tags: [] });
      setUploadFile(null);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: notesApi.upload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setOpen(false);
      setForm({ title: "", note_type: "inbox", content: "", domains: [], tags: [] });
      setUploadFile(null);
    },
  });

  function buildUploadPayload() {
    if (!uploadFile) return null;
    const payload = new FormData();
    payload.append("file", uploadFile);
    payload.append("title", form.title || uploadFile.name.replace(/\.[^.]+$/, ""));
    payload.append("note_type", form.note_type || "inbox");
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Notes</h1>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4" /> New Note</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Note</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
                <div className="flex gap-2">
                  <select
                    className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
                    value={form.note_type}
                    onChange={(e) => setForm({ ...form, note_type: e.target.value })}
                  >
                    {NOTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <Input
                    placeholder="Domains (comma separated)"
                    onChange={(e) => setForm({ ...form, domains: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                  />
                </div>
                <Input
                  placeholder="Tags (comma separated)"
                  onChange={(e) => setForm({ ...form, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                />
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

        {/* Type filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setTypeFilter("")}
            className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
              !typeFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {NOTE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
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
            <p>No notes yet. Create one to get started.</p>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {data?.items.map((note) => (
            <Card
              key={note.id}
              className="cursor-pointer hover:border-primary/40 transition-colors"
              onClick={() => navigate(`/notes/${encodeURIComponent(note.id)}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="note">{note.note_type}</Badge>
                  <Badge variant="outline">{note.status}</Badge>
                </div>
                <CardTitle className="text-sm">{note.title}</CardTitle>
                {note.abstract && (
                  <CardDescription className="line-clamp-2">{note.abstract}</CardDescription>
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
          ))}
        </div>
      </div>
    </div>
  );
}
