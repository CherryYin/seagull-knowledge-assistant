import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Save, Trash2 } from "lucide-react";

import { ModuleSectionNav } from "@/components/SectionNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authApi, type UserApiCredentialRecord } from "@/lib/api/auth";

interface ProviderConfigField {
  label: string;
  key: string;
  placeholder: string;
  required?: boolean;
}

interface ProviderMetadata {
  id: string;
  label: string;
  secretLabel?: string;
  secretPlaceholder?: string;
  configFields: ProviderConfigField[];
}

const PROVIDERS: ProviderMetadata[] = [
  { id: "newsapi", label: "NewsAPI", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://newsapi.org/v2" }] },
  { id: "tavily", label: "Tavily", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://api.tavily.com" }] },
  { id: "qwen", label: "Qwen", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1" }] },
  { id: "minimax", label: "MiniMax", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://api.minimax.io/v1" }] },
  { id: "azure_openai", label: "Azure OpenAI", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://your-resource.openai.azure.com" }] },
  { id: "github", label: "GitHub", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://api.github.com" }] },
  { id: "openalex", label: "OpenAlex", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://api.openalex.org" }] },
  { id: "semantic_scholar", label: "Semantic Scholar", configFields: [{ label: "Base URL", key: "base_url", placeholder: "https://api.semanticscholar.org/graph/v1" }] },
  { id: "arxiv", label: "arXiv", configFields: [{ label: "User-Agent / contact", key: "user_agent", placeholder: "personal-knowledge-graph/0.1 your-email@example.com" }] },
  {
    id: "wechat_official_account",
    label: "WeChat Official Account",
    secretLabel: "AppSecret",
    secretPlaceholder: "Enter the Official Account AppSecret",
    configFields: [
      { label: "AppID", key: "app_id", placeholder: "wx...", required: true },
      { label: "Default cover media ID", key: "default_thumb_media_id", placeholder: "Permanent image material media_id", required: true },
      { label: "Default author", key: "author", placeholder: "Optional author name" },
    ],
  },
];

const QUERY_KEY = ["user-api-credentials"] as const;

function providerLabel(provider: string) {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState("newsapi");
  const [label, setLabel] = useState("default");
  const [secret, setSecret] = useState("");
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const credentialsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => authApi.listMyApiCredentials(),
  });

  const items = credentialsQuery.data?.items ?? [];
  const providerMeta = useMemo(() => PROVIDERS.find((item) => item.id === provider), [provider]);

  const createMutation = useMutation({
    mutationFn: () => authApi.createMyApiCredential({
      provider,
      label,
      secret,
      config: Object.fromEntries(Object.entries(configValues).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)),
      is_enabled: true,
      is_default: true,
    }),
    onSuccess: async () => {
      setSecret("");
      setConfigValues({});
      setLabel("default");
      setError(null);
      setSuccess("API key saved.");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => {
      setSuccess(null);
      setError(err instanceof Error ? err.message : "Failed to save API key");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (credentialId: number) => authApi.deleteMyApiCredential(credentialId),
    onSuccess: async () => {
      setError(null);
      setSuccess("API key removed.");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => {
      setSuccess(null);
      setError(err instanceof Error ? err.message : "Failed to delete API key");
    },
  });

  function submitNewCredential() {
    setError(null);
    setSuccess(null);
    if (!secret.trim()) {
      setError(`${providerMeta?.secretLabel ?? "Secret"} is required.`);
      return;
    }
    const missingConfig = providerMeta?.configFields.find((field) => field.required && !configValues[field.key]?.trim());
    if (missingConfig) {
      setError(`${missingConfig.label} is required.`);
      return;
    }
    createMutation.mutate();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <ModuleSectionNav parent="settings" active="API Keys" />
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><KeyRound className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">API Keys</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Store provider credentials per user. Saved secrets are masked after write and can be used later to replace `.env`-only provider access.
              </p>
            </div>
          </div>
        </section>

        {error ? <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error}</div> : null}
        {success ? <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">{success}</div> : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Plus className="h-4 w-4" /> Add Credential</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={provider}
                onChange={(event) => { setProvider(event.target.value); setConfigValues({}); }}
                disabled={createMutation.isPending}
              >
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Label</label>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="default" disabled={createMutation.isPending} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">{providerMeta?.secretLabel ?? "Secret"}</label>
              <Input value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={providerMeta?.secretPlaceholder ?? "Enter API key or token"} disabled={createMutation.isPending} />
            </div>
            {providerMeta?.configFields.map((field) => (
              <div key={field.key} className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">{field.label}{field.required ? "" : " (optional)"}</label>
                <Input value={configValues[field.key] ?? ""} onChange={(event) => setConfigValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} disabled={createMutation.isPending} />
              </div>
            ))}
            <div className="md:col-span-2 flex justify-end">
              <Button onClick={submitNewCredential} disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save Credential
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saved Credentials</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {credentialsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading credentials...</div>
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">No API credentials saved yet.</div>
            ) : (
              items.map((item) => <CredentialCard key={item.id} item={item} onDelete={() => deleteMutation.mutate(item.id)} deleting={deleteMutation.isPending} />)
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CredentialCard({ item, onDelete, deleting }: { item: UserApiCredentialRecord; onDelete: () => void; deleting: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">{providerLabel(item.provider)}</span>
            <Badge variant="secondary">{item.label}</Badge>
            {item.is_default ? <Badge>Default</Badge> : null}
            {!item.is_enabled ? <Badge variant="secondary">Disabled</Badge> : null}
          </div>
          <div className="text-sm text-muted-foreground">Masked secret: <code>{item.secret_masked}</code></div>
          {item.config?.base_url ? <div className="text-sm text-muted-foreground">Base URL: <code>{String(item.config.base_url)}</code></div> : null}
          {item.config?.user_agent ? <div className="text-sm text-muted-foreground">User-Agent: <code>{String(item.config.user_agent)}</code></div> : null}
          {item.config?.app_id ? <div className="text-sm text-muted-foreground">AppID: <code>{String(item.config.app_id)}</code></div> : null}
          {item.config?.default_thumb_media_id ? <div className="text-sm text-muted-foreground">Default cover: <code>{String(item.config.default_thumb_media_id)}</code></div> : null}
        </div>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </Button>
      </div>
    </div>
  );
}

export default ApiKeysPage;
