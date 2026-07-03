import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Save, Trash2 } from "lucide-react";

import { SectionNav, settingsNavItems } from "@/components/SectionNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authApi, type UserApiCredentialRecord } from "@/lib/api/auth";

const PROVIDERS = [
  { id: "newsapi", label: "NewsAPI", configLabel: "Base URL", configKey: "base_url", placeholder: "https://newsapi.org/v2" },
  { id: "tavily", label: "Tavily", configLabel: "Base URL", configKey: "base_url", placeholder: "https://api.tavily.com" },
  { id: "qwen", label: "Qwen", configLabel: "Base URL", configKey: "base_url", placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "minimax", label: "MiniMax", configLabel: "Base URL", configKey: "base_url", placeholder: "https://api.minimax.io/v1" },
  { id: "azure_openai", label: "Azure OpenAI", configLabel: "Base URL", configKey: "base_url", placeholder: "https://your-resource.openai.azure.com" },
  { id: "github", label: "GitHub", configLabel: "Base URL", configKey: "base_url", placeholder: "https://api.github.com" },
  { id: "openalex", label: "OpenAlex", configLabel: "Base URL", configKey: "base_url", placeholder: "https://api.openalex.org" },
  { id: "semantic_scholar", label: "Semantic Scholar", configLabel: "Base URL", configKey: "base_url", placeholder: "https://api.semanticscholar.org/graph/v1" },
  { id: "arxiv", label: "arXiv", configLabel: "User-Agent / contact", configKey: "user_agent", placeholder: "personal-knowledge-graph/0.1 your-email@example.com" },
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
  const [configValue, setConfigValue] = useState("");
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
      config: configValue.trim() && providerMeta?.configKey ? { [providerMeta.configKey]: configValue.trim() } : {},
      is_enabled: true,
      is_default: true,
    }),
    onSuccess: async () => {
      setSecret("");
      setConfigValue("");
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
      setError("Secret is required.");
      return;
    }
    createMutation.mutate();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <SectionNav items={settingsNavItems} active="API Keys" />
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
                onChange={(event) => setProvider(event.target.value)}
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
              <label className="text-sm font-medium">Secret</label>
              <Input value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Enter API key or token" disabled={createMutation.isPending} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">{providerMeta?.configLabel ?? "Provider config"} (optional)</label>
              <Input value={configValue} onChange={(event) => setConfigValue(event.target.value)} placeholder={providerMeta?.placeholder ?? "https://api.example.com"} disabled={createMutation.isPending} />
            </div>
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
        </div>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </Button>
      </div>
    </div>
  );
}

export default ApiKeysPage;
