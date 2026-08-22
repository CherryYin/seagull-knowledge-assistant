import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Lightbulb, Plus, Settings2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StateMessage } from "@/components/StateMessage";
import { wikiApi, type WikiPage, type WikiPageCreate } from "@/lib/api";
import { getWikiOrigin, getWikiRole } from "@/lib/wikiLifecycle";
import { buildWikiTemplate, wikiTemplates } from "@/lib/wikiTemplates";
import { ModuleSectionNav } from "@/components/SectionNav";

const PAGE_TYPES = ["topic", "entity", "concept", "project", "comparison"];

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function roleTone(role: "draft" | "stable") {
  return role === "stable" ? "source" : "note";
}

function summarizePage(page: WikiPage) {
  return page.stale_reason || page.summary || page.content || "No summary yet.";
}

function WikiPageCard({ page }: { page: WikiPage }) {
  const role = getWikiRole(page);
  const origin = getWikiOrigin(page);
  const tagPreview = (page.tags ?? []).filter((tag) => !tag.startsWith("wiki-")).slice(0, 3);

  return (
    <Link key={page.id} to={`/wiki/${encodeURIComponent(page.id)}`}>
      <div className="group h-full rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{page.page_type}</Badge>
              <Badge variant={roleTone(role)}>{role}</Badge>
              {page.stale_triggered_at && <Badge variant="outline">stale</Badge>}
              {page.needs_recompile && <Badge>needs recompile</Badge>}
            </div>
            <h2 className="text-base font-semibold tracking-tight text-foreground group-hover:text-primary">{page.title}</h2>
          </div>
          <div className="rounded-xl bg-muted/70 px-3 py-1 text-right">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Updated</p>
            <p className="text-xs font-medium text-foreground">{new Date(page.updated_at).toLocaleDateString()}</p>
          </div>
        </div>

        <p className="mt-4 line-clamp-4 text-sm leading-6 text-muted-foreground">{summarizePage(page)}</p>

        <div className="mt-4 flex flex-wrap gap-2">
              {origin && <Badge variant="secondary">{origin}</Badge>}
              {(page.domains ?? []).slice(0, 2).map((domain) => (
                <Badge key={domain} variant="outline">{domain}</Badge>
              ))}
              {Array.isArray(page.metadata_?.claims) && page.metadata_.claims.some((claim) => String((claim as { status?: string }).status || "") !== "supported") && (
                <Badge variant="outline">weak claims</Badge>
              )}
              {tagPreview.map((tag) => (
                <Badge key={tag} variant="secondary">{tag}</Badge>
              ))}
        </div>
      </div>
    </Link>
  );
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
  const stablePages = useMemo(() => pages.filter((page) => getWikiRole(page) === "stable"), [pages]);
  const draftPages = useMemo(() => pages.filter((page) => getWikiRole(page) === "draft"), [pages]);
  const stalePages = useMemo(() => pages.filter((page) => Boolean(page.stale_triggered_at)), [pages]);

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-b from-background via-background to-muted/20 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <ModuleSectionNav parent="knowledge" active="Wiki" />

        <div className="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm">
          <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-6 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-primary/10 p-3 text-primary ring-1 ring-primary/10">
                  <BookOpen className="h-6 w-6" />
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5" /> Canonical Knowledge Layer
                  </div>
                  <h1 className="text-3xl font-semibold tracking-tight">Wiki Pages</h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Turn notes, source evidence, and knowledge-tree context into reviewable long-term pages. Drafts stay editable; stable pages become durable references for search, agents, and assets.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link to="/review/wiki-suggestions"><Lightbulb className="h-4 w-4" /> Wiki Review</Link>
                </Button>
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
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Title</label>
                          <Input value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} className="mt-1" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Page Type</label>
                          <select
                            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={form.page_type}
                            onChange={(event) => setForm((prev) => ({ ...prev, page_type: event.target.value }))}
                          >
                            {PAGE_TYPES.map((pageType) => (
                              <option key={pageType} value={pageType}>{pageType}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Domains</label>
                          <Input value={domainsCsv} onChange={(event) => setDomainsCsv(event.target.value)} placeholder="ai, product, systems" className="mt-1" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Tags</label>
                          <Input value={tagsCsv} onChange={(event) => setTagsCsv(event.target.value)} placeholder="stable, canonical" className="mt-1" />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Summary</label>
                        <Textarea value={form.summary ?? ""} onChange={(event) => setForm((prev) => ({ ...prev, summary: event.target.value }))} rows={2} className="mt-1" />
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
                        <p className="mt-2 text-xs text-muted-foreground">{wikiTemplates[form.page_type || "topic"]?.description}</p>
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

          <div className="grid gap-3 border-t border-border/60 bg-muted/20 p-6 md:grid-cols-3">
            <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Stable</p>
              <p className="mt-2 text-2xl font-semibold">{stablePages.length}</p>
              <p className="mt-1 text-sm text-muted-foreground">Durable reference pages used by agents and assets.</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Draft</p>
              <p className="mt-2 text-2xl font-semibold">{draftPages.length}</p>
              <p className="mt-1 text-sm text-muted-foreground">Editable pages still being reviewed and shaped.</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Needs attention</p>
              <p className="mt-2 text-2xl font-semibold">{stalePages.length}</p>
              <p className="mt-1 text-sm text-muted-foreground">Pages marked stale or waiting for recompilation.</p>
            </div>
          </div>
        </div>

        <Card className="border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-primary" /> Canonical Pages
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-8 text-sm text-muted-foreground">Loading wiki pages…</div>
            ) : error ? (
              <StateMessage tone="error" title="Failed to load wiki pages" description={error.message} />
            ) : pages.length === 0 ? (
              <StateMessage
                tone="empty"
                title="No wiki pages yet"
                description="Create your first canonical page, then attach source evidence from the detail view."
                actionLabel="Create page"
                onAction={() => setOpen(true)}
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {pages.map((page) => <WikiPageCard key={page.id} page={page} />)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-5 w-5 text-primary" /> Current Scope
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
            <div className="rounded-2xl border border-border/60 bg-muted/40 p-4">
              <p className="font-medium text-foreground">Canonical pages</p>
              <p className="mt-2 leading-6">Wiki pages are the durable layer above raw sources, notes, and temporary summary outputs.</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-muted/40 p-4">
              <p className="font-medium text-foreground">Draft-first workflow</p>
              <p className="mt-2 leading-6">Use mining candidates and review actions to turn evidence into pages before promoting them to stable knowledge.</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-muted/40 p-4">
              <p className="font-medium text-foreground">Asset context</p>
              <p className="mt-2 leading-6">Stable pages should become reusable context for search, agent workflows, blog assets, and future research briefs.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
