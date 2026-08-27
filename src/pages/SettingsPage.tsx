import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bot, Globe2, Settings } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { authApi, harnessSettingsApi } from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";
import { ModuleTogglePanel } from "@/components/ModuleTogglePanel";
import { useResolvedModules } from "@/lib/modules/module-settings";
import { APP_MODULES } from "@/config/modules";

export function SettingsPage() {
  const { isAdmin } = useAuth();
	const queryClient = useQueryClient();
	const [primarySiteUrl, setPrimarySiteUrl] = useState("");
	const [defaultChannel, setDefaultChannel] = useState("");
	const [defaultModel, setDefaultModel] = useState("");
	const location = useLocation();
	const moduleState = useResolvedModules();
	const visibleRoutes = new Set(moduleState.modules.map((module) => module.route));
	const gatedPath = typeof location.state === "object" && location.state && "from" in location.state ? String((location.state as { from?: unknown }).from ?? "") : "";
	const items = APP_MODULES
		.filter((module) => module.settingsCard)
		.filter((module) => isAdmin || visibleRoutes.has(module.route))
		.sort((left, right) => (left.settingsCard?.order ?? 0) - (right.settingsCard?.order ?? 0))
		.map((module) => ({
			title: module.settingsCard?.title ?? module.label,
			description: module.settingsCard?.description ?? module.description,
			to: module.route,
			icon: module.icon,
		}));
	const publishingQuery = useQuery({ queryKey: ["publishing-settings"], queryFn: () => authApi.getMyPublishingSettings() });
	const harnessModelsQuery = useQuery({ queryKey: ["harness-models"], queryFn: () => harnessSettingsApi.listModels(), enabled: isAdmin });
	const harnessDefaultQuery = useQuery({ queryKey: ["harness-default-model"], queryFn: () => harnessSettingsApi.getDefaultModel(), enabled: isAdmin });

	useEffect(() => {
		setPrimarySiteUrl(publishingQuery.data?.primary_site_url ?? "");
		setDefaultChannel(publishingQuery.data?.default_channel ?? "");
	}, [publishingQuery.data]);

	useEffect(() => {
		if (harnessDefaultQuery.data?.provider && harnessDefaultQuery.data.model) {
			setDefaultModel(`${harnessDefaultQuery.data.provider}:${harnessDefaultQuery.data.model}`);
		}
	}, [harnessDefaultQuery.data]);

	const publishingMutation = useMutation({
		mutationFn: () => authApi.updateMyPublishingSettings({
			primary_site_url: primarySiteUrl.trim().replace(/\/+$/, ""),
			default_channel: defaultChannel.trim(),
		}),
		onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["publishing-settings"] }); },
	});

	const modelMutation = useMutation({
		mutationFn: () => {
			const separator = defaultModel.indexOf(":");
			if (separator < 1) throw new Error("Choose a model first");
			return harnessSettingsApi.updateDefaultModel({
				provider: defaultModel.slice(0, separator),
				model: defaultModel.slice(separator + 1),
				revision: harnessDefaultQuery.data?.revision,
			});
		},
		onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["harness-default-model"] }); },
	});

	const publishingUrlValid = !primarySiteUrl.trim() || /^https?:\/\/[^\s]+$/i.test(primarySiteUrl.trim());

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
				<ModuleSectionNav parent="settings" active="Settings" />
				<section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Settings className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Settings & Advanced</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Configuration, advanced agent controls, skills, and admin tools live here so the main steward workflow stays focused.
              </p>
            </div>
          </div>
        </section>

				<section className="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle className="flex items-center gap-2 text-base"><Globe2 className="h-4 w-4" /> Publishing</CardTitle>
							<CardDescription>User-level PKG defaults for Asset publication. Individual Assets keep their own final publish URL.</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2"><label className="text-sm font-medium" htmlFor="primary-site-url">Primary site URL</label><Input id="primary-site-url" value={primarySiteUrl} onChange={(event) => setPrimarySiteUrl(event.target.value)} placeholder="https://example.com" />{!publishingUrlValid && <p className="text-xs text-destructive">Use a complete HTTP or HTTPS URL.</p>}</div>
							<div className="space-y-2"><label className="text-sm font-medium" htmlFor="default-publish-channel">Default channel</label><Input id="default-publish-channel" value={defaultChannel} onChange={(event) => setDefaultChannel(event.target.value)} placeholder="Blog" /></div>
							<div className="flex items-center gap-3"><Button onClick={() => publishingMutation.mutate()} disabled={!publishingUrlValid || publishingMutation.isPending}>{publishingMutation.isPending ? "Saving…" : "Save Publishing Defaults"}</Button>{publishingMutation.isSuccess && <span className="text-sm text-emerald-700">Saved.</span>}</div>
						</CardContent>
					</Card>

					{isAdmin && (
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base"><Bot className="h-4 w-4" /> Agent Default Model</CardTitle>
								<CardDescription>Platform-level Harness default for newly created Agent sessions. Session-specific choices can still override it.</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="space-y-2"><label className="text-sm font-medium" htmlFor="agent-default-model">Harness model</label><select id="agent-default-model" value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option value="">Choose a model</option>{harnessModelsQuery.data?.models.map((model) => <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>{model.provider_name} · {model.name}</option>)}</select></div>
								<div className="flex items-center gap-3"><Button onClick={() => modelMutation.mutate()} disabled={!defaultModel || modelMutation.isPending || !harnessDefaultQuery.data?.writable}>{modelMutation.isPending ? "Saving…" : "Save Harness Default"}</Button>{modelMutation.isSuccess && <span className="text-sm text-emerald-700">Saved.</span>}</div>
								{harnessModelsQuery.data?.failures.length ? <p className="text-xs text-amber-700">Some Harness model providers could not be listed.</p> : null}
							</CardContent>
						</Card>
					)}
				</section>

        <ModuleTogglePanel />

				{gatedPath ? (
					<section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900">
						<p className="font-medium">That module is not enabled in your workspace.</p>
						<p className="mt-1 text-amber-800/90">You were redirected here from <code>{gatedPath}</code>. Enable the module below, or choose a preset that includes it.</p>
					</section>
				) : null}

        <div className="grid gap-4 md:grid-cols-2">
          {items.map(({ title, description, to, icon: Icon }) => (
            <Card key={title} className="transition-colors hover:border-primary/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4" /> {title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{description}</p>
                <Button asChild variant="outline" size="sm"><Link to={to}>Open</Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
