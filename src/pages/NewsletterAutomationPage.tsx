import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, ExternalLink, LoaderCircle, Newspaper, Play } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { assetsApi, type NewsletterAutomationConfig, type NewsletterAutomationRunResult, type NewsletterAutomationUpdate } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useReturnNavigation } from "@/hooks/useReturnNavigation";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ActionError } from "@/components/interaction/ActionError";
import { UnsavedChangesBanner } from "@/components/interaction/UnsavedChangesBanner";

const DEFAULT_FORM: NewsletterAutomationUpdate = {
  enabled: false,
  name: "Technology Newsletter",
  topics: [],
  frequency: "weekly",
  hour_utc: 1,
  weekday_utc: 4,
  lookback_days: 7,
  max_news_items: 8,
  max_paper_items: 5,
  delivery_format: "html",
  audience: "Technology readers",
  style_notes: "Concise, evidence-led, and easy to scan.",
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown error";
  const detail = error.message.match(/"detail"\s*:\s*"([^"]+)"/)?.[1];
  return detail || error.message;
}

function editableConfig(config: NewsletterAutomationConfig): NewsletterAutomationUpdate {
  return {
    enabled: config.enabled,
    name: config.name,
    topics: config.topics,
    frequency: config.frequency,
    hour_utc: config.hour_utc,
    weekday_utc: config.weekday_utc,
    lookback_days: config.lookback_days,
    max_news_items: config.max_news_items,
    max_paper_items: config.max_paper_items,
    delivery_format: config.delivery_format,
    audience: config.audience,
    style_notes: config.style_notes,
  };
}

function normalizedPayload(form: NewsletterAutomationUpdate, topicsText: string): NewsletterAutomationUpdate {
  return {
    ...form,
    name: form.name.trim(),
    audience: form.audience.trim(),
    style_notes: form.style_notes.trim(),
    topics: [...new Set(topicsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))],
  };
}

function configSignature(config: NewsletterAutomationUpdate) {
  return JSON.stringify(config);
}

function utcToLocalSchedule(hourUtc: number, weekdayUtc: number) {
  const offsetHours = Math.round(-new Date().getTimezoneOffset() / 60);
  const totalHours = weekdayUtc * 24 + hourUtc + offsetHours;
  const wrapped = ((totalHours % 168) + 168) % 168;
  return { hour: wrapped % 24, weekday: Math.floor(wrapped / 24) };
}

function localToUtcSchedule(hourLocal: number, weekdayLocal: number) {
  const offsetHours = Math.round(-new Date().getTimezoneOffset() / 60);
  const totalHours = weekdayLocal * 24 + hourLocal - offsetHours;
  const wrapped = ((totalHours % 168) + 168) % 168;
  return { hour: wrapped % 24, weekday: Math.floor(wrapped / 24) };
}

function runReason(reason?: string | null) {
  if (reason === "no_matching_items") return "No matching recent news or papers were found.";
  if (reason === "not_due") return "The saved schedule is not due yet.";
  return reason || "No Newsletter draft was created.";
}

export function NewsletterAutomationPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/assets";
  const backLabel = locationState?.backLabel || "Back to Assets";
  const returnToPrevious = useReturnNavigation(backTo, Boolean(locationState?.backTo));
  const configQuery = useQuery({ queryKey: ["newsletter-automation"], queryFn: assetsApi.getNewsletterAutomation });
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>("newsletter-automation", Boolean(configQuery.data));
  const [form, setForm] = useState<NewsletterAutomationUpdate>(DEFAULT_FORM);
  const [topicsText, setTopicsText] = useState("");
  const [savedSignature, setSavedSignature] = useState("");
  const savedSignatureRef = useRef("");
  const [runActionPending, setRunActionPending] = useState(false);
  const [runActionError, setRunActionError] = useState<string | null>(null);

  const payload = useMemo(() => normalizedPayload(form, topicsText), [form, topicsText]);
  const currentSignature = useMemo(() => configSignature(payload), [payload]);
  const isDirty = Boolean(savedSignature && currentSignature !== savedSignature);
  const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localSchedule = useMemo(() => utcToLocalSchedule(form.hour_utc, form.weekday_utc), [form.hour_utc, form.weekday_utc]);

  savedSignatureRef.current = savedSignature;

  useEffect(() => {
    if (!configQuery.data) return;
    const editable = editableConfig(configQuery.data);
    const serverSignature = configSignature(editable);
    if (savedSignatureRef.current && currentSignature !== savedSignatureRef.current) return;
    setForm(editable);
    setTopicsText(editable.topics.join("\n"));
    savedSignatureRef.current = serverSignature;
    setSavedSignature(serverSignature);
  }, [configQuery.data, currentSignature]);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const updateMutation = useMutation({
    mutationFn: assetsApi.updateNewsletterAutomation,
    onSuccess: (data) => {
      const editable = editableConfig(data);
      const serverSignature = configSignature(editable);
      setForm(editable);
      setTopicsText(editable.topics.join("\n"));
      savedSignatureRef.current = serverSignature;
      setSavedSignature(serverSignature);
      queryClient.setQueryData(["newsletter-automation"], data);
    },
  });

  const runMutation = useMutation({
    mutationFn: assetsApi.runNewsletterAutomation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["newsletter-automation"] });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const scheduleSummary = useMemo(() => {
    if (form.frequency === "manual") return "Only generates when you click Run now.";
    if (form.frequency === "daily") return `Runs daily after ${String(localSchedule.hour).padStart(2, "0")}:00 in ${timezoneName}.`;
    return `Runs every ${WEEKDAYS[localSchedule.weekday]} after ${String(localSchedule.hour).padStart(2, "0")}:00 in ${timezoneName}.`;
  }, [form.frequency, localSchedule.hour, localSchedule.weekday, timezoneName]);

  const save = () => updateMutation.mutate(payload);

  const saveAndRun = async () => {
    if (!payload.name) return;
    setRunActionPending(true);
    setRunActionError(null);
    runMutation.reset();
    try {
      if (isDirty) await updateMutation.mutateAsync(payload);
      await runMutation.mutateAsync();
    } catch (error) {
      setRunActionError(errorMessage(error));
    } finally {
      setRunActionPending(false);
    }
  };

  const setLocalHour = (hour: number) => {
    const utc = localToUtcSchedule(hour, localSchedule.weekday);
    setForm((current) => ({ ...current, hour_utc: utc.hour, weekday_utc: utc.weekday }));
  };

  const setLocalWeekday = (weekday: number) => {
    const utc = localToUtcSchedule(localSchedule.hour, weekday);
    setForm((current) => ({ ...current, hour_utc: utc.hour, weekday_utc: utc.weekday }));
  };

  const activeRun: NewsletterAutomationRunResult | null = runMutation.data ?? null;
  const generatedAssetId = activeRun?.asset?.id ?? configQuery.data?.last_asset_id ?? null;
  const displayedStatus = runActionPending
    ? "running"
    : runActionError
      ? "failed"
      : activeRun?.status ?? configQuery.data?.last_run_status ?? "idle";
  const displayedNewsCount = activeRun?.news_count ?? configQuery.data?.last_news_count ?? 0;
  const displayedPaperCount = activeRun?.paper_count ?? configQuery.data?.last_paper_count ?? 0;
  const displayedReason = activeRun?.reason ?? configQuery.data?.last_run_reason;
  const displayedRevision = activeRun?.config_revision ?? configQuery.data?.config_revision ?? 0;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" data-route-scroll="newsletter-automation">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={returnToPrevious}><ArrowLeft className="mr-2 h-4 w-4" />{backLabel}</Button>

        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary"><Newspaper className="h-6 w-6" /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">Newsletter Automation</h1>
                <Badge variant={form.enabled ? "default" : "outline"}>{form.enabled ? "Enabled" : "Paused"}</Badge>
                {isDirty && <Badge variant="outline" className="border-amber-300 text-amber-700">Unsaved changes</Badge>}
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Collect technology news and paper discoveries around your topics, then turn recent material into reviewable Newsletter Assets. Automation creates drafts only; export and publishing remain explicit user actions.</p>
            </div>
          </div>
          <Button variant={isDirty ? "default" : "outline"} onClick={() => void saveAndRun()} disabled={runActionPending || updateMutation.isPending || configQuery.isLoading || !payload.name}>
            {runActionPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {runActionPending ? (isDirty ? "Saving & generating…" : "Generating…") : isDirty ? "Save & Run now" : "Run now"}
          </Button>
        </header>

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="grid gap-4 py-5 md:grid-cols-[1fr_auto] md:items-center">
            <div><p className="font-medium">Collection and generation are intentionally separate</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Save synchronizes the news query and managed Paper Discovery profile. Run always uses the saved configuration revision shown in Last Run.</p></div>
            <div className="text-sm text-muted-foreground"><CalendarClock className="mr-2 inline h-4 w-4" />{scheduleSummary}</div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Newsletter identity</CardTitle><CardDescription>Define what the recurring Asset is for.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <label className="space-y-2 text-sm"><span className="font-medium">Newsletter name</span><Input aria-label="Newsletter name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="space-y-2 text-sm"><span className="font-medium">Topics and keywords</span><Textarea aria-label="Newsletter topics" rows={6} placeholder="AI agents\nsemiconductors\nrobotics" value={topicsText} onChange={(event) => setTopicsText(event.target.value)} /><span className="block text-xs text-muted-foreground">One topic per line, or separate topics with commas. Leave empty to use all recently collected technology material.</span></label>
              <label className="space-y-2 text-sm"><span className="font-medium">Audience</span><Input aria-label="Newsletter audience" value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} /></label>
              <label className="space-y-2 text-sm"><span className="font-medium">Editorial style</span><Textarea aria-label="Newsletter style" rows={4} value={form.style_notes} onChange={(event) => setForm({ ...form, style_notes: event.target.value })} /></label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Schedule and limits</CardTitle><CardDescription>Times are entered in {timezoneName}; PKG stores the corresponding UTC schedule.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center justify-between rounded-xl border p-4 text-sm"><span><span className="block font-medium">Enable scheduled generation</span><span className="mt-1 block text-xs text-muted-foreground">Paused automation can still be run manually.</span></span><input aria-label="Enable Newsletter automation" type="checkbox" className="h-4 w-4" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm"><span className="font-medium">Frequency</span><select aria-label="Newsletter frequency" className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value as NewsletterAutomationUpdate["frequency"] })}><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
                <label className="space-y-2 text-sm"><span className="font-medium">Local hour</span><Input aria-label="Newsletter local hour" type="number" min={0} max={23} value={localSchedule.hour} onChange={(event) => setLocalHour(Number(event.target.value))} /></label>
              </div>
              {form.frequency === "weekly" && <label className="space-y-2 text-sm"><span className="font-medium">Local weekday</span><select aria-label="Newsletter local weekday" className="h-10 w-full rounded-md border border-input bg-background px-3" value={localSchedule.weekday} onChange={(event) => setLocalWeekday(Number(event.target.value))}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-2 text-sm"><span className="font-medium">Lookback days</span><Input aria-label="Newsletter lookback days" type="number" min={1} max={30} value={form.lookback_days} onChange={(event) => setForm({ ...form, lookback_days: Number(event.target.value) })} /></label>
                <label className="space-y-2 text-sm"><span className="font-medium">News items</span><Input aria-label="Newsletter news limit" type="number" min={0} max={50} value={form.max_news_items} onChange={(event) => setForm({ ...form, max_news_items: Number(event.target.value) })} /></label>
                <label className="space-y-2 text-sm"><span className="font-medium">Paper items</span><Input aria-label="Newsletter paper limit" type="number" min={0} max={50} value={form.max_paper_items} onChange={(event) => setForm({ ...form, max_paper_items: Number(event.target.value) })} /></label>
              </div>
              <label className="space-y-2 text-sm"><span className="font-medium">Preferred delivery format</span><select aria-label="Newsletter delivery format" className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.delivery_format} onChange={(event) => setForm({ ...form, delivery_format: event.target.value as NewsletterAutomationUpdate["delivery_format"] })}><option value="html">HTML</option><option value="markdown">Markdown</option></select></label>
            </CardContent>
          </Card>
        </div>

        {isDirty && (
          <UnsavedChangesBanner
            message="Unsaved Newsletter settings will not be used by automation."
            onSave={save}
            saveLabel="Save automation"
            saving={updateMutation.isPending}
            saveDisabled={!payload.name}
          />
        )}

        <Card data-newsletter-run-status>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><CardTitle>Last Run</CardTitle><CardDescription>The result and exact saved configuration revision used by generation.</CardDescription></div>
              <Badge variant="outline">Config revision {displayedRevision}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {displayedStatus === "idle" && <p className="text-sm text-muted-foreground">No Newsletter run has been recorded yet.</p>}
            {displayedStatus === "running" && <div className="flex items-center gap-3 text-sm"><LoaderCircle className="h-5 w-5 animate-spin text-primary" /><span>{isDirty ? "Saving the visible configuration, then collecting matching material…" : "Collecting matching news and papers with the saved configuration…"}</span></div>}
            {displayedStatus === "generated" && <div className="space-y-2 text-sm"><p className="flex items-center gap-2 font-medium text-emerald-700"><CheckCircle2 className="h-5 w-5" />Completed · Newsletter draft created</p><p className="text-muted-foreground">Collected {displayedNewsCount} news item(s) and {displayedPaperCount} paper item(s).</p></div>}
            {displayedStatus === "skipped" && <div className="space-y-2 text-sm"><p className="flex items-center gap-2 font-medium text-amber-700"><AlertTriangle className="h-5 w-5" />Skipped · no draft created</p><p className="text-muted-foreground">{runReason(displayedReason)}</p></div>}
            {displayedStatus === "failed" && <ActionError title="Newsletter run failed" impact="No Newsletter Asset was generated, and your visible configuration remains editable." recovery="Fix the reported issue, then use Save & Run now again." details={runActionError} onRetry={() => void saveAndRun()} retryLabel={isDirty ? "Save & Run again" : "Run again"} />}
            {activeRun?.config_snapshot && <div className="rounded-xl border bg-muted/20 p-3 text-xs text-muted-foreground">Used “{activeRun.config_snapshot.name}” · {activeRun.config_snapshot.topics.length ? activeRun.config_snapshot.topics.join(", ") : "all topics"} · {activeRun.config_snapshot.lookback_days} day lookback · up to {activeRun.config_snapshot.max_news_items} news / {activeRun.config_snapshot.max_paper_items} papers · {activeRun.config_snapshot.delivery_format.toUpperCase()}</div>}
            <div className="flex flex-wrap items-center gap-3">
              {generatedAssetId && <Button asChild><Link to={`/assets/${encodeURIComponent(generatedAssetId)}?tab=read`} state={{ backTo: `${location.pathname}${location.search}`, backLabel: "Back to Newsletter Automation" }}>Open generated Asset<ExternalLink className="ml-2 h-4 w-4" /></Link></Button>}
              {configQuery.data?.last_run_at && !activeRun && <span className="text-xs text-muted-foreground">Last run {new Date(configQuery.data.last_run_at).toLocaleString()}</span>}
            </div>
          </CardContent>
        </Card>

        {!isDirty && <Card><CardContent className="py-5 text-sm text-muted-foreground">Saved configuration revision {configQuery.data?.config_revision ?? 0} is ready to run.{updateMutation.isSuccess && <p className="mt-1 text-emerald-700">Automation settings saved.</p>}</CardContent></Card>}
        {configQuery.isError && <ActionError title="Newsletter automation could not be loaded" impact="The saved schedule and last run are unavailable." recovery="Retry loading this page before changing or running automation." details={errorMessage(configQuery.error)} onRetry={() => void configQuery.refetch()} />}
        {updateMutation.isError && !runActionPending && <ActionError title="Newsletter settings were not saved" impact="Automation still uses the previous saved configuration." recovery="Your visible edits remain in the form; retry Save automation." details={errorMessage(updateMutation.error)} onRetry={save} retryLabel="Retry Save" />}
      </div>
    </div>
  );
}
