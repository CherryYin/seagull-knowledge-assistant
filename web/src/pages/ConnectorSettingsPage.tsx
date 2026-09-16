import { useEffect, useMemo, useState } from "react";
import { Github, Loader2, Play, Plus, Save, Settings2, Trash2 } from "lucide-react";

import { ModuleSectionNav } from "@/components/SectionNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authApi } from "@/lib/api/auth";
import {
  connectorsApi,
  type GitHubTrendProfile,
  type GitHubTrendProfileInput,
  type GitHubTrendSchedule,
} from "@/lib/api/connectors";

const DEFAULT_GITHUB_QUERY = "agent framework OR retrieval augmented generation OR knowledge graph";
const DEFAULT_NEWS_QUERY = "AI, LLM, Agent, workflow";

type GitHubTrendProfileDraft = GitHubTrendProfileInput & {
  id: number | null;
  last_run_at?: string | null;
};

function toDraft(profile: GitHubTrendProfile): GitHubTrendProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    query: profile.query,
    language: profile.language,
    schedule: profile.schedule,
    is_enabled: profile.is_enabled,
    candidate_count: profile.candidate_count,
    top_k: profile.top_k,
    last_run_at: profile.last_run_at,
  };
}

function newDraft(query: string, sequence: number): GitHubTrendProfileDraft {
  return {
    id: null,
    name: sequence === 1 ? "Default GitHub Trends" : `GitHub Trends ${sequence}`,
    query,
    language: null,
    schedule: "weekly",
    is_enabled: true,
    candidate_count: 25,
    top_k: 5,
    last_run_at: null,
  };
}

export function ConnectorSettingsPage() {
  const [githubProfiles, setGithubProfiles] = useState<GitHubTrendProfileDraft[]>([]);
  const [defaultGithubQuery, setDefaultGithubQuery] = useState(DEFAULT_GITHUB_QUERY);
  const [newsQuery, setNewsQuery] = useState("");
  const [initialNewsQuery, setInitialNewsQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingNews, setSavingNews] = useState(false);
  const [profileAction, setProfileAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [settingsResponse, profilesResponse] = await Promise.all([
          authApi.getMySettings(),
          connectorsApi.listGitHubTrendProfiles(),
        ]);
        if (!active) return;
        const settings = settingsResponse.settings ?? {};
        const githubQuery = String(settings.github_trend_query ?? DEFAULT_GITHUB_QUERY);
        const nextNewsQuery = String(settings.news_auto_search_query ?? DEFAULT_NEWS_QUERY);
        setDefaultGithubQuery(githubQuery);
        setGithubProfiles(profilesResponse.items.map(toDraft));
        setNewsQuery(nextNewsQuery);
        setInitialNewsQuery(nextNewsQuery);
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

  const newsDirty = useMemo(() => newsQuery !== initialNewsQuery, [newsQuery, initialNewsQuery]);

  function addProfile() {
    setGithubProfiles((current) => [...current, newDraft(defaultGithubQuery, current.length + 1)]);
    setError(null);
    setSuccess(null);
  }

  function updateProfileDraft<K extends keyof GitHubTrendProfileDraft>(index: number, key: K, value: GitHubTrendProfileDraft[K]) {
    setGithubProfiles((current) => current.map((profile, profileIndex) => (
      profileIndex === index ? { ...profile, [key]: value } : profile
    )));
  }

  async function saveProfile(index: number) {
    const draft = githubProfiles[index];
    if (!draft?.name.trim() || !draft.query.trim()) {
      setError("Profile name and query are required.");
      return;
    }
    const actionKey = `save:${draft.id ?? index}`;
    try {
      setProfileAction(actionKey);
      setError(null);
      setSuccess(null);
      const payload: GitHubTrendProfileInput = {
        name: draft.name.trim(),
        query: draft.query.trim(),
        language: draft.language?.trim() || null,
        schedule: draft.schedule,
        is_enabled: draft.is_enabled,
        candidate_count: draft.candidate_count,
        top_k: draft.top_k,
      };
      const saved = draft.id === null
        ? await connectorsApi.createGitHubTrendProfile(payload)
        : await connectorsApi.updateGitHubTrendProfile(draft.id, payload);
      setGithubProfiles((current) => current.map((profile, profileIndex) => (
        profileIndex === index ? toDraft(saved) : profile
      )));
      setSuccess(`Saved GitHub profile “${saved.name}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save GitHub trend profile");
    } finally {
      setProfileAction(null);
    }
  }

  async function deleteProfile(index: number) {
    const draft = githubProfiles[index];
    if (!draft) return;
    if (draft.id === null) {
      setGithubProfiles((current) => current.filter((_, profileIndex) => profileIndex !== index));
      return;
    }
    if (!window.confirm(`Delete GitHub trend profile “${draft.name}”?`)) return;
    try {
      setProfileAction(`delete:${draft.id}`);
      setError(null);
      setSuccess(null);
      await connectorsApi.deleteGitHubTrendProfile(draft.id);
      setGithubProfiles((current) => current.filter((profile) => profile.id !== draft.id));
      setSuccess(`Deleted GitHub profile “${draft.name}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete GitHub trend profile");
    } finally {
      setProfileAction(null);
    }
  }

  async function runProfile(index: number) {
    const draft = githubProfiles[index];
    if (!draft || draft.id === null) {
      setError("Save the profile before running it.");
      return;
    }
    try {
      setProfileAction(`run:${draft.id}`);
      setError(null);
      setSuccess(null);
      const result = await connectorsApi.runGitHubTrendProfile(draft.id);
      setGithubProfiles((current) => current.map((profile) => (
        profile.id === draft.id ? toDraft(result.profile) : profile
      )));
      setSuccess(`GitHub profile “${draft.name}” collected ${result.collected} repositories.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run GitHub trend profile");
    } finally {
      setProfileAction(null);
    }
  }

  async function saveNewsSettings() {
    try {
      setSavingNews(true);
      setError(null);
      setSuccess(null);
      const value = newsQuery.trim() || DEFAULT_NEWS_QUERY;
      await authApi.updateMySettings({ news_auto_search_query: value });
      setInitialNewsQuery(value);
      setNewsQuery(value);
      setSuccess("Saved the scheduled news search query.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save news settings");
    } finally {
      setSavingNews(false);
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
              <h1 className="text-3xl font-semibold tracking-tight">Connector Automation</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Schedule explicit GitHub profiles instead of applying one global query to every user. Paper providers remain managed by Paper Discovery.
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
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2"><Github className="h-5 w-5" /> GitHub Trend Profiles</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">Only enabled daily or weekly profiles are picked up by the scheduler.</p>
            </div>
            <Button type="button" variant="outline" onClick={addProfile} disabled={loading || profileAction !== null}>
              <Plus className="mr-2 h-4 w-4" /> Add Profile
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading profiles…</div>
            ) : githubProfiles.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center">
                <p className="text-sm font-medium">No GitHub automation profile yet.</p>
                <p className="mt-1 text-sm text-muted-foreground">The scheduler will not scan your account until you create and enable one.</p>
                <Button type="button" className="mt-4" variant="outline" onClick={addProfile}><Plus className="mr-2 h-4 w-4" /> Create Profile</Button>
              </div>
            ) : githubProfiles.map((profile, index) => {
              const identity = profile.id ?? index;
              const saving = profileAction === `save:${identity}`;
              const running = profile.id !== null && profileAction === `run:${profile.id}`;
              const deleting = profile.id !== null && profileAction === `delete:${profile.id}`;
              return (
                <div key={profile.id ?? `new-${index}`} className="space-y-4 rounded-xl border p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-2 text-sm font-medium">
                      <span>Profile name</span>
                      <Input value={profile.name} onChange={(event) => updateProfileDraft(index, "name", event.target.value)} disabled={profileAction !== null} />
                    </label>
                    <label className="space-y-2 text-sm font-medium">
                      <span>Language</span>
                      <Input value={profile.language ?? ""} onChange={(event) => updateProfileDraft(index, "language", event.target.value)} placeholder="Any language" disabled={profileAction !== null} />
                    </label>
                  </div>
                  <label className="block space-y-2 text-sm font-medium">
                    <span>GitHub search query</span>
                    <Input value={profile.query} onChange={(event) => updateProfileDraft(index, "query", event.target.value)} placeholder={DEFAULT_GITHUB_QUERY} disabled={profileAction !== null} />
                  </label>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="space-y-2 text-sm font-medium">
                      <span>Schedule</span>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={profile.schedule}
                        onChange={(event) => updateProfileDraft(index, "schedule", event.target.value as GitHubTrendSchedule)}
                        disabled={profileAction !== null}
                      >
                        <option value="manual">Manual only</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                      </select>
                    </label>
                    <label className="space-y-2 text-sm font-medium">
                      <span>Search candidates</span>
                      <Input type="number" min={1} max={100} value={profile.candidate_count} onChange={(event) => updateProfileDraft(index, "candidate_count", Number(event.target.value))} disabled={profileAction !== null} />
                    </label>
                    <label className="space-y-2 text-sm font-medium">
                      <span>Keep top results</span>
                      <Input type="number" min={1} max={20} value={profile.top_k} onChange={(event) => updateProfileDraft(index, "top_k", Number(event.target.value))} disabled={profileAction !== null} />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={profile.is_enabled} onChange={(event) => updateProfileDraft(index, "is_enabled", event.target.checked)} disabled={profileAction !== null} />
                      Enabled
                    </label>
                    <div className="text-xs text-muted-foreground">
                      {profile.last_run_at ? `Last run ${new Date(profile.last_run_at).toLocaleString()}` : "Never run"}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => deleteProfile(index)} disabled={profileAction !== null}>
                        {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />} Delete
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => runProfile(index)} disabled={profile.id === null || profileAction !== null}>
                        {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} Run Now
                      </Button>
                      <Button type="button" size="sm" onClick={() => saveProfile(index)} disabled={profileAction !== null}>
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save Profile
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>News Auto Search Query</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label htmlFor="news-auto-search-query" className="text-sm font-medium">Query</label>
            <Input id="news-auto-search-query" value={newsQuery} onChange={(event) => setNewsQuery(event.target.value)} placeholder={DEFAULT_NEWS_QUERY} disabled={loading || savingNews} />
            <p className="text-sm text-muted-foreground">Used by the transitional scheduled news search job for the past 24 hours in English and Chinese.</p>
            <div className="flex justify-end">
              <Button onClick={saveNewsSettings} disabled={loading || savingNews || !newsDirty}>
                {savingNews ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save News Query
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default ConnectorSettingsPage;
