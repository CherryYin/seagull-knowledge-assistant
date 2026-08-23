import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BookOpen, FileText, NotebookPen, Sparkles } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { notesApi, sourcesApi, wikiApi } from "@/lib/api";
import { buildAssetGenerationSeed, type AssetHandoffState } from "@/lib/asset-handoff";
import { MANUAL_ASSET_TYPES, type AssetGenerationRequest } from "@/lib/asset-generation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function toggle(values: string[], id: string) {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

export function AssetGenerationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialSeed = useMemo(() => buildAssetGenerationSeed(
    (location.state as { assetHandoff?: AssetHandoffState } | null)?.assetHandoff,
  ), [location.state]);
  const [assetType, setAssetType] = useState(initialSeed.assetType);
  const [title, setTitle] = useState(initialSeed.title);
  const [audience, setAudience] = useState(initialSeed.audience);
  const [brief, setBrief] = useState(initialSeed.brief);
  const [styleNotes, setStyleNotes] = useState(initialSeed.styleNotes);
  const [sourceRefs, setSourceRefs] = useState<string[]>(initialSeed.sourceRefs);
  const [noteRefs, setNoteRefs] = useState<string[]>(initialSeed.noteRefs);
  const [wikiRefs, setWikiRefs] = useState<string[]>(initialSeed.wikiRefs);

  const sources = useQuery({ queryKey: ["asset-wizard-sources"], queryFn: () => sourcesApi.list({ limit: 50 }) });
  const notes = useQuery({ queryKey: ["asset-wizard-notes"], queryFn: () => notesApi.list({ status: "kept", limit: 50 }) });
  const wiki = useQuery({ queryKey: ["asset-wizard-wiki"], queryFn: () => wikiApi.list({ limit: 50 }) });
  const evidenceCount = sourceRefs.length + noteRefs.length + wikiRefs.length;
  const selectedType = useMemo(() => MANUAL_ASSET_TYPES.find((item) => item.value === assetType), [assetType]);
  const canContinue = title.trim() && audience.trim() && brief.trim() && evidenceCount > 0;

  function startGeneration() {
    if (!canContinue) return;
    const request: AssetGenerationRequest = {
      assetType,
      title: title.trim(),
      audience: audience.trim(),
      brief: brief.trim(),
      styleNotes: styleNotes.trim(),
      sourceRefs,
      noteRefs,
      wikiRefs,
    };
    navigate("/chat", {
      state: {
        workflowId: "draft-asset",
        assetDraft: request,
        promptSeed: `Create a ${selectedType?.label ?? "knowledge asset"} titled "${request.title}" for ${request.audience}.`,
      },
    });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => navigate("/assets")}>
            <ArrowLeft className="mr-2 h-4 w-4" />Back to Assets
          </Button>
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary"><Sparkles className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Create an Asset</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Define the delivery need and knowledge evidence first. Generation happens in a Harness Session; PKG receives an Asset only after you confirm the draft.
              </p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>1. Choose the deliverable</CardTitle><CardDescription>Newsletter automation is intentionally deferred.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {MANUAL_ASSET_TYPES.map((item) => (
              <button key={item.value} type="button" onClick={() => setAssetType(item.value)} className={`rounded-xl border p-4 text-left transition-colors ${assetType === item.value ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}>
                <p className="font-medium">{item.label}</p><p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>2. Define the need</CardTitle><CardDescription>The Agent should know what success means before it starts writing.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Input aria-label="Asset title" placeholder="Working title" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Input aria-label="Target audience" placeholder="Target audience" value={audience} onChange={(event) => setAudience(event.target.value)} />
            <Textarea aria-label="Asset brief" placeholder="What question should this asset answer, and what should the reader be able to do afterward?" rows={5} value={brief} onChange={(event) => setBrief(event.target.value)} />
            <Textarea aria-label="Style guidance" placeholder="Optional style, tone, structure, or constraints" rows={3} value={styleNotes} onChange={(event) => setStyleNotes(event.target.value)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>3. Select knowledge evidence</CardTitle><CardDescription>Choose at least one Source, Note, or Wiki page. The Agent may retrieve additional related knowledge during generation.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-3">
            <EvidenceColumn icon={<FileText className="h-4 w-4" />} title="Sources" items={(sources.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.source_type }))} selected={sourceRefs} onToggle={(id) => setSourceRefs((values) => toggle(values, id))} />
            <EvidenceColumn icon={<NotebookPen className="h-4 w-4" />} title="Notes" items={(notes.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.note_type }))} selected={noteRefs} onToggle={(id) => setNoteRefs((values) => toggle(values, id))} />
            <EvidenceColumn icon={<BookOpen className="h-4 w-4" />} title="Wiki" items={(wiki.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.page_type }))} selected={wikiRefs} onToggle={(id) => setWikiRefs((values) => toggle(values, id))} />
          </CardContent>
        </Card>

        <div className="flex items-center justify-between rounded-2xl border bg-card p-5">
          <div><p className="font-medium">{selectedType?.label}</p><p className="text-sm text-muted-foreground">{evidenceCount} knowledge records selected · no Asset has been created yet</p></div>
          <Button onClick={startGeneration} disabled={!canContinue}>Start Generation Session<ArrowRight className="ml-2 h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  );
}

function EvidenceColumn({ icon, title, items, selected, onToggle }: { icon: React.ReactNode; title: string; items: Array<{ id: string; title: string; detail: string }>; selected: string[]; onToggle: (id: string) => void }) {
  return <div className="rounded-xl border p-3"><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon}{title}</h3><div className="max-h-72 space-y-2 overflow-auto">{items.length === 0 && <p className="text-xs text-muted-foreground">No records available.</p>}{items.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm hover:bg-muted/50"><input type="checkbox" className="mt-1" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} /><span className="min-w-0"><span className="block truncate font-medium">{item.title}</span><span className="text-xs text-muted-foreground">{item.detail}</span></span></label>)}</div></div>;
}
