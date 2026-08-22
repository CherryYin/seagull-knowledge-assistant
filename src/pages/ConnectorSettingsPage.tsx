import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Settings2 } from "lucide-react";

import { ModuleSectionNav } from "@/components/SectionNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authApi } from "@/lib/api/auth";

const DEFAULT_GITHUB_QUERY = "agent framework OR retrieval augmented generation OR knowledge graph";
const DEFAULT_NEWS_QUERY = "AI, LLM, Agent, workflow";

export function ConnectorSettingsPage() {
  const [githubQuery, setGithubQuery] = useState("");
  const [newsQuery, setNewsQuery] = useState("");
  const [initialGithubQuery, setInitialGithubQuery] = useState("");
  const [initialNewsQuery, setInitialNewsQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const response = await authApi.getMySettings();
        if (!active) return;
        const settings = response.settings ?? {};
        const github = String(settings.github_trend_query ?? DEFAULT_GITHUB_QUERY);
        const news = String(settings.news_auto_search_query ?? DEFAULT_NEWS_QUERY);
        setGithubQuery(github);
        setNewsQuery(news);
        setInitialGithubQuery(github);
        setInitialNewsQuery(news);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load connector settings");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const dirty = useMemo(() => githubQuery !== initialGithubQuery || newsQuery !== initialNewsQuery, [githubQuery, initialGithubQuery, newsQuery, initialNewsQuery]);

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const payload = {
        github_trend_query: githubQuery.trim() || DEFAULT_GITHUB_QUERY,
        news_auto_search_query: newsQuery.trim() || DEFAULT_NEWS_QUERY,
      };
      await authApi.updateMySettings(payload);
      setInitialGithubQuery(payload.github_trend_query);
      setInitialNewsQuery(payload.news_auto_search_query);
      setGithubQuery(payload.github_trend_query);
      setNewsQuery(payload.news_auto_search_query);
      setSuccess("Saved. Scheduled GitHub/news jobs will use these queries.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <ModuleSectionNav parent="settings" active="Connectors" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Settings2 className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Connector Queries</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Configure the default GitHub trend query and scheduled news search query from your personal settings.
              </p>
            </div>
          </div>
        </section>

        {error ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        ) : null}
        {success ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            {success}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>GitHub Trend Query</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label htmlFor="github-trend-query" className="text-sm font-medium">Query</label>
            <Input id="github-trend-query" value={githubQuery} onChange={(e) => setGithubQuery(e.target.value)} placeholder={DEFAULT_GITHUB_QUERY} disabled={loading || saving} />
            <p className="text-sm text-muted-foreground">Used by the scheduled GitHub trend discovery job. Leave blank to fall back to the default query.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>News Auto Search Query</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label htmlFor="news-auto-search-query" className="text-sm font-medium">Query</label>
            <Input id="news-auto-search-query" value={newsQuery} onChange={(e) => setNewsQuery(e.target.value)} placeholder={DEFAULT_NEWS_QUERY} disabled={loading || saving} />
            <p className="text-sm text-muted-foreground">Used by the daily scheduled news search job for the past 24 hours in English and Chinese.</p>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={loading || saving || !dirty}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConnectorSettingsPage;
