import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, ExternalLink, Newspaper, Play, Save } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { assetsApi, type NewsletterAutomationUpdate } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

export function NewsletterAutomationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ["newsletter-automation"], queryFn: assetsApi.getNewsletterAutomation });
  const [form, setForm] = useState<NewsletterAutomationUpdate>(DEFAULT_FORM);
  const [topicsText, setTopicsText] = useState("");

  useEffect(() => {
    if (!configQuery.data) return;
    const { last_generated_at: _lastGeneratedAt, last_asset_id: _lastAssetId, ...editable } = configQuery.data;
    setForm(editable);
    setTopicsText(editable.topics.join("\n"));
  }, [configQuery.data]);

  const updateMutation = useMutation({
    mutationFn: assetsApi.updateNewsletterAutomation,
    onSuccess: (data) => {
      queryClient.setQueryData(["newsletter-automation"], data);
    },
  });
  const runMutation = useMutation({
    mutationFn: assetsApi.runNewsletterAutomation,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["newsletter-automation"] });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      if (result.asset) navigate(`/assets/${encodeURIComponent(result.asset.id)}`);
    },
  });

  const scheduleSummary = useMemo(() => {
    if (form.frequency === "manual") return "Only generates when you click Run now.";
    if (form.frequency === "daily") return `Runs daily after ${String(form.hour_utc).padStart(2, "0")}:00 UTC.`;
    return `Runs every ${WEEKDAYS[form.weekday_utc]} after ${String(form.hour_utc).padStart(2, "0")}:00 UTC.`;
  }, [form.frequency, form.hour_utc, form.weekday_utc]);

  function save() {
    updateMutation.mutate({
      ...form,
      name: form.name.trim(),
      audience: form.audience.trim(),
      style_notes: form.style_notes.trim(),
      topics: topicsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
    });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate("/assets")}><ArrowLeft className="mr-2 h-4 w-4" />Back to Assets</Button>

        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary"><Newspaper className="h-6 w-6" /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2"><h1 className="text-3xl font-semibold tracking-tight">Newsletter Automation</h1><Badge variant={form.enabled ? "default" : "outline"}>{form.enabled ? "Enabled" : "Paused"}</Badge></div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Collect technology news and paper discoveries around your topics, then turn recent material into reviewable Newsletter Assets. Automation creates drafts only; export and publishing remain explicit user actions.</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}><Play className="mr-2 h-4 w-4" />{runMutation.isPending ? "Generating…" : "Run now"}</Button>
        </header>

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="grid gap-4 py-5 md:grid-cols-[1fr_auto] md:items-center">
            <div><p className="font-medium">Collection and generation are intentionally separate</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Saving this configuration synchronizes the daily news query and a managed Paper Discovery profile. Newsletter generation then selects recent matching items and creates a traceable <code>newsletter_issue</code> Asset draft.</p></div>
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
            <CardHeader><CardTitle>Schedule and limits</CardTitle><CardDescription>Choose when a draft is created and how much material it includes.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center justify-between rounded-xl border p-4 text-sm"><span><span className="block font-medium">Enable scheduled generation</span><span className="mt-1 block text-xs text-muted-foreground">Paused automation can still be run manually.</span></span><input aria-label="Enable Newsletter automation" type="checkbox" className="h-4 w-4" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm"><span className="font-medium">Frequency</span><select aria-label="Newsletter frequency" className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value as NewsletterAutomationUpdate["frequency"] })}><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
                <label className="space-y-2 text-sm"><span className="font-medium">Hour (UTC)</span><Input aria-label="Newsletter hour UTC" type="number" min={0} max={23} value={form.hour_utc} onChange={(event) => setForm({ ...form, hour_utc: Number(event.target.value) })} /></label>
              </div>
              {form.frequency === "weekly" && <label className="space-y-2 text-sm"><span className="font-medium">Weekday</span><select aria-label="Newsletter weekday" className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.weekday_utc} onChange={(event) => setForm({ ...form, weekday_utc: Number(event.target.value) })}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-2 text-sm"><span className="font-medium">Lookback days</span><Input aria-label="Newsletter lookback days" type="number" min={1} max={30} value={form.lookback_days} onChange={(event) => setForm({ ...form, lookback_days: Number(event.target.value) })} /></label>
                <label className="space-y-2 text-sm"><span className="font-medium">News items</span><Input aria-label="Newsletter news limit" type="number" min={0} max={50} value={form.max_news_items} onChange={(event) => setForm({ ...form, max_news_items: Number(event.target.value) })} /></label>
                <label className="space-y-2 text-sm"><span className="font-medium">Paper items</span><Input aria-label="Newsletter paper limit" type="number" min={0} max={50} value={form.max_paper_items} onChange={(event) => setForm({ ...form, max_paper_items: Number(event.target.value) })} /></label>
              </div>
              <label className="space-y-2 text-sm"><span className="font-medium">Preferred delivery format</span><select aria-label="Newsletter delivery format" className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.delivery_format} onChange={(event) => setForm({ ...form, delivery_format: event.target.value as NewsletterAutomationUpdate["delivery_format"] })}><option value="html">HTML</option><option value="markdown">Markdown</option></select></label>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-muted-foreground">
              {configQuery.data?.last_generated_at ? <span>Last generated {new Date(configQuery.data.last_generated_at).toLocaleString()}</span> : <span>No Newsletter draft has been generated yet.</span>}
              {configQuery.data?.last_asset_id && <Link className="ml-3 inline-flex items-center text-primary hover:underline" to={`/assets/${encodeURIComponent(configQuery.data.last_asset_id)}`}>Open latest Asset<ExternalLink className="ml-1 h-3.5 w-3.5" /></Link>}
              {runMutation.data?.status === "skipped" && <p className="mt-1 text-amber-700">No draft was created: {runMutation.data.reason === "no_matching_items" ? "no matching recent items" : runMutation.data.reason}.</p>}
              {configQuery.isError && <p className="mt-1 text-destructive">Could not load Newsletter automation: {errorMessage(configQuery.error)}</p>}
              {updateMutation.isError && <p className="mt-1 text-destructive">Could not save Newsletter automation: {errorMessage(updateMutation.error)}</p>}
              {runMutation.isError && <p className="mt-1 text-destructive">Could not generate Newsletter draft: {errorMessage(runMutation.error)}</p>}
              {updateMutation.isSuccess && <p className="mt-1 text-emerald-700">Automation settings saved.</p>}
            </div>
            <Button onClick={save} disabled={configQuery.isLoading || updateMutation.isPending || !form.name.trim()}><Save className="mr-2 h-4 w-4" />{updateMutation.isPending ? "Saving…" : "Save automation"}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
