import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Lightbulb, Plus, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { wikiApi, type WikiPageCreate } from "@/lib/api";
import { getWikiOrigin, getWikiRole } from "@/lib/wikiLifecycle";
import { buildWikiTemplate, wikiTemplates } from "@/lib/wikiTemplates";
import { SectionNav, knowledgeNavItems } from "@/components/SectionNav";

const PAGE_TYPES = ["topic", "entity", "concept", "project", "comparison"];

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function WikiPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<WikiPageCreate>({
    title: "",
    page_type: "topic",
    summary: "",
    content: "",
    domains: [],
    tags: [],
  });
  const [domainsCsv, setDomainsCsv] = useState("");
  const [tagsCsv, setTagsCsv] = useState("");

  useEffect(() => {
    const state = location.state as { wikiPrefill?: Partial<WikiPageCreate> } | null;
    if (!state?.wikiPrefill) return;
    const prefill = state.wikiPrefill;
    setForm((prev) => ({
      ...prev,
      ...prefill,
      title: prefill.title ?? prev.title,
      summary: prefill.summary ?? prev.summary,
      content: prefill.content ?? prev.content,
      page_type: prefill.page_type ?? prev.page_type,
      derived_from_sources: prefill.derived_from_sources ?? prev.derived_from_sources,
      derived_from_notes: prefill.derived_from_notes ?? prev.derived_from_notes,
    }));
    setOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-pages"],
    queryFn: () => wikiApi.list({ limit: 100 }),
  });

  const createMutation = useMutation({
    mutationFn: wikiApi.create,
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      setOpen(false);
      setForm({ title: "", page_type: "topic", summary: "", content: "", domains: [], tags: [] });
      setDomainsCsv("");
      setTagsCsv("");
      navigate(`/wiki/${encodeURIComponent(page.id)}`);
    },
  });

  function submitWikiPage() {
    createMutation.mutate({
      ...form,
      content: form.content || buildWikiTemplate(form.title, form.page_type || "topic"),
      domains: splitCsv(domainsCsv),
      tags: splitCsv(tagsCsv),
    });
  }

  const pages = data?.items ?? [];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <SectionNav items={knowledgeNavItems} active="Wiki" />

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-primary/10 p-3 text-primary">
                <BookOpen className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Canonical Knowledge Pages</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Canonical wiki pages turn notes and sources into stable, source-backed long-term knowledge.
                </p>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
                  Wiki pages are above summary drafts and memory compiles. They should stay reviewable and stable rather than acting like another temporary summary layer.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to="/wiki/rules"><Settings2 className="h-4 w-4" /> Rules</Link>
              </Button>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4" /> New Wiki Page
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Create Canonical Wiki Page</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Title</label>
                      <Input
                        value={form.title}
                        onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                        placeholder="Personal Knowledge Graph"
                        className="mt-1"
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Type</label>
                        <select
                          value={form.page_type}
                          onChange={(event) => setForm((prev) => ({
                            ...prev,
                            page_type: event.target.value,
                            content: prev.content || (prev.title ? buildWikiTemplate(prev.title, event.target.value) : ""),
                          }))}
                          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          {PAGE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Domains</label>
                        <Input value={domainsCsv} onChange={(event) => setDomainsCsv(event.target.value)} placeholder="ai, pkb" className="mt-1" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Tags</label>
                        <Input value={tagsCsv} onChange={(event) => setTagsCsv(event.target.value)} placeholder="memory, wiki" className="mt-1" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Summary</label>
                      <Textarea
                        value={form.summary ?? ""}
                        onChange={(event) => setForm((prev) => ({ ...prev, summary: event.target.value }))}
                        rows={2}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Content</label>
                      <Textarea
                        value={form.content ?? ""}
                        onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
                        rows={8}
                        placeholder="Leave empty to create a default wiki template."
                        className="mt-1 font-mono text-sm"
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        {wikiTemplates[form.page_type || "topic"]?.description}
                      </p>
                    </div>
                    {createMutation.error && <p className="text-sm text-destructive">{createMutation.error.message}</p>}
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                      <Button onClick={submitWikiPage} disabled={!form.title.trim() || createMutation.isPending}>
                        {createMutation.isPending ? "Creating…" : "Create"}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-primary" /> Wiki Pages
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-8 text-sm text-muted-foreground">Loading wiki pages…</div>
            ) : error ? (
              <div className="py-8 text-sm text-destructive">Failed to load wiki pages: {error.message}</div>
            ) : pages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="font-medium">No wiki pages yet</p>
                <p className="mt-2 text-sm text-muted-foreground">Create your first L3 page, then attach source evidence from the detail view.</p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {pages.map((page) => (
                  <Link key={page.id} to={`/wiki/${encodeURIComponent(page.id)}`}>
                    <div className="h-full rounded-lg border border-border p-4 transition-colors hover:border-primary/50 hover:bg-accent/30">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="font-medium text-foreground">{page.title}</h2>
                          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                            {page.stale_reason || page.summary || page.content || "No summary yet."}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <Badge variant="outline">{page.page_type}</Badge>
                          <Badge variant="outline">{getWikiRole(page)}</Badge>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {getWikiOrigin(page) && <Badge variant="outline">{getWikiOrigin(page)}</Badge>}
                        {page.tags.slice(0, 4).map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                        {page.needs_recompile && <Badge>Needs recompile</Badge>}
                        {page.stale_triggered_at && <Badge variant="outline">Stale</Badge>}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-5 w-5 text-primary" /> Current Scope
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="font-medium text-foreground">L3 pages</p>
              <p className="mt-1">Wiki pages are stable knowledge pages above notes and sources. Draft-style wiki pages should be reviewed before being treated as stable.</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="font-medium text-foreground">Source evidence</p>
              <p className="mt-1">Attach topic-relative source summaries from each wiki detail page.</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="font-medium text-foreground">Agent-ready</p>
              <p className="mt-1">Manual pages now; compiler and Knowledge Tree automation can feed this layer later.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
