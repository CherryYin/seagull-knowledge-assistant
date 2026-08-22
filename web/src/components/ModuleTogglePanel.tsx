import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, Pin, PinOff, Sparkles } from "lucide-react";

import { APP_MODULES, MODULE_GROUP_LABELS, MODULE_GROUP_ORDER } from "@/config/modules";
import { getModulePreset, MODULE_PRESETS, type ModulePresetId } from "@/config/module-presets";
import { useResolvedModules, type UserModuleSettings } from "@/lib/modules/module-settings";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { knowledgeApi, type DashboardData } from "@/lib/api/knowledge";
import { systemApi, type ModuleCapability } from "@/lib/api/system";

function sanitizePinnedModules(pinned: string[] | undefined, enabledModuleIds: string[], { isAdmin = false }: { isAdmin?: boolean } = {}) {
  if (!pinned?.length) return [];
  if (isAdmin) return pinned;
  const enabled = new Set(enabledModuleIds);
  return pinned.filter((moduleId) => enabled.has(moduleId));
}

function mergePresetSettings(presetId: ModulePresetId, current: UserModuleSettings, completeOnboarding: boolean): UserModuleSettings {
  const preset = getModulePreset(presetId);
  return {
    ...current,
    preset: preset.id,
    enabled: preset.enabledModuleIds,
    disabled: [],
    pinned: sanitizePinnedModules(current.pinned, preset.enabledModuleIds),
    onboarding_completed: completeOnboarding ? true : current.onboarding_completed,
  };
}

function capabilityBadgeClass(capability?: ModuleCapability) {
  if (!capability) return "border-border text-muted-foreground";
  if (capability.status === "needs_setup") return "border-amber-500/30 bg-amber-500/10 text-amber-700";
  if (capability.status === "experimental") return "border-violet-500/30 bg-violet-500/10 text-violet-700";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
}

function ModuleCapabilityBadge({ capability }: { capability?: ModuleCapability }) {
  if (!capability) return null;
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", capabilityBadgeClass(capability))} title={capability.detail ?? undefined}>
      {capability.label}
    </span>
  );
}

interface ModuleRecommendation {
  moduleId: string;
  title: string;
  reason: string;
}

function buildRecommendations(dashboard: DashboardData | undefined, enabledIds: Set<string>): ModuleRecommendation[] {
  if (!dashboard) return [];
  const { notes, sources, chats, digest_pending: digestPending } = dashboard.counts;
  const recommendations: ModuleRecommendation[] = [];

  if (!enabledIds.has("wiki") && notes + sources >= 20) {
    recommendations.push({
      moduleId: "wiki",
      title: "Enable Wiki for stable synthesis",
      reason: `You already have ${notes} notes and ${sources} sources. Wiki can turn repeated knowledge into canonical pages.`,
    });
  }
  if (!enabledIds.has("digest-review") && digestPending > 0) {
    recommendations.push({
      moduleId: "digest-review",
      title: "Review pending digest notes",
      reason: `${digestPending} digest note${digestPending === 1 ? " is" : "s are"} waiting for review or merge.`,
    });
  }
  if (!enabledIds.has("assets") && (chats >= 10 || notes >= 15)) {
    recommendations.push({
      moduleId: "assets",
      title: "Enable Assets for output workflows",
      reason: "You have enough notes or agent activity to start producing briefs, newsletters, or topic reports.",
    });
  }
  if (!enabledIds.has("api-keys") && !enabledIds.has("connectors")) {
    recommendations.push({
      moduleId: "api-keys",
      title: "Set up personal provider keys",
      reason: "API Keys unlock per-user news, paper, and search provider credentials without changing global config.",
    });
  }

  return recommendations.slice(0, 4);
}

export function ModuleTogglePanel({ compact = false }: { compact?: boolean }) {
  const moduleState = useResolvedModules();
  const capabilitiesQuery = useQuery({
    queryKey: ["system-capabilities"],
    queryFn: () => systemApi.capabilities(),
    enabled: !moduleState.isAdmin,
  });
  const dashboardQuery = useQuery({
    queryKey: ["module-recommendation-dashboard"],
    queryFn: () => knowledgeApi.dashboard(),
    enabled: !moduleState.isAdmin && !compact,
  });
  const [selectedPreset, setSelectedPreset] = useState<ModulePresetId>(getModulePreset(moduleState.settings.preset).id);
  const enabledIds = useMemo(() => new Set(moduleState.modules.map((module) => module.id)), [moduleState.modules]);
  const pinnedIds = useMemo(() => new Set(moduleState.settings.pinned ?? []), [moduleState.settings.pinned]);
  const pinnedPrimaryModules = useMemo(() => {
    const primaryById = new Map(moduleState.modules.filter((module) => module.nav?.primary).map((module) => [module.id, module]));
    return (moduleState.settings.pinned ?? [])
      .map((moduleId) => primaryById.get(moduleId))
      .filter((module): module is NonNullable<ReturnType<typeof primaryById.get>> => !!module);
  }, [moduleState.modules, moduleState.settings.pinned]);
  const capabilities = capabilitiesQuery.data?.modules ?? {};
  const recommendations = useMemo(() => buildRecommendations(dashboardQuery.data, enabledIds), [dashboardQuery.data, enabledIds]);

  useEffect(() => {
    setSelectedPreset(getModulePreset(moduleState.settings.preset).id);
  }, [moduleState.settings.preset]);

  const togglePinned = (moduleId: string) => {
    const pinned = new Set(moduleState.settings.pinned ?? []);
    if (pinned.has(moduleId)) {
      pinned.delete(moduleId);
    } else {
      pinned.add(moduleId);
    }
    return moduleState.saveModuleSettings({
      ...moduleState.settings,
      pinned: [...pinned].filter((pinnedModuleId) => enabledIds.has(pinnedModuleId) || moduleState.isAdmin),
      onboarding_completed: moduleState.settings.onboarding_completed ?? true,
    });
  };

  const movePinned = (moduleId: string, direction: -1 | 1) => {
    const pinned = (moduleState.settings.pinned ?? []).filter((pinnedModuleId) => enabledIds.has(pinnedModuleId) || moduleState.isAdmin);
    const index = pinned.indexOf(moduleId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= pinned.length) return Promise.resolve();
    const nextPinned = [...pinned];
    [nextPinned[index], nextPinned[nextIndex]] = [nextPinned[nextIndex], nextPinned[index]];
    return moduleState.saveModuleSettings({
      ...moduleState.settings,
      pinned: nextPinned,
      onboarding_completed: moduleState.settings.onboarding_completed ?? true,
    });
  };

  if (moduleState.isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" /> Admin Modules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Admin users see all modules by default. Module presets only affect non-admin workspaces.</p>
          {!compact ? (
            <div className="space-y-4">
              {pinnedPrimaryModules.length ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Pinned order</p>
                  <div className="space-y-2">
                    {pinnedPrimaryModules.map((module, index) => (
                      <div key={module.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background/60 px-3 py-2">
                        <span className="text-sm">{module.label}</span>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => movePinned(module.id, -1)} disabled={moduleState.saving || index === 0}>
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => movePinned(module.id, 1)} disabled={moduleState.saving || index === pinnedPrimaryModules.length - 1}>
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="text-sm font-medium">Pin primary modules</p>
              <div className="flex flex-wrap gap-2">
                {moduleState.modules.filter((module) => module.nav?.primary).map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary",
                      pinnedIds.has(module.id) && "border-primary/40 bg-primary/10 text-primary"
                    )}
                    onClick={() => togglePinned(module.id)}
                    disabled={moduleState.saving}
                  >
                    {pinnedIds.has(module.id) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                    {module.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const applyPreset = (completeOnboarding: boolean) => {
    setSelectedPreset(selectedPreset);
    return moduleState.saveModuleSettings(mergePresetSettings(selectedPreset, moduleState.settings, completeOnboarding));
  };

  const toggleModule = (moduleId: string, checked: boolean) => {
    const enabled = new Set(moduleState.settings.enabled ?? []);
    const disabled = new Set(moduleState.settings.disabled ?? []);
    if (checked) {
      enabled.add(moduleId);
      disabled.delete(moduleId);
    } else {
      enabled.delete(moduleId);
      disabled.add(moduleId);
    }
    return moduleState.saveModuleSettings({
      ...moduleState.settings,
      enabled: [...enabled],
      disabled: [...disabled],
      pinned: sanitizePinnedModules(moduleState.settings.pinned, [...enabled]),
      onboarding_completed: moduleState.settings.onboarding_completed ?? true,
    });
  };

  const enableRecommendedModule = (moduleId: string) => toggleModule(moduleId, true);

  return (
    <Card className={cn(moduleState.onboardingRequired && "border-primary/50 bg-primary/5")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" /> Workspace Modules
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {moduleState.onboardingRequired ? (
          <div className="rounded-lg border border-primary/30 bg-background/70 p-4">
            <p className="text-sm font-medium">Choose your workspace mode</p>
            <p className="mt-1 text-sm text-muted-foreground">Start simple with Basic, or enable more advanced research and knowledge-graph modules now.</p>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          {MODULE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={cn(
                "rounded-lg border p-4 text-left transition-colors hover:border-primary/50",
                selectedPreset === preset.id && "border-primary bg-primary/10"
              )}
              onClick={() => setSelectedPreset(preset.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{preset.label}</span>
                {selectedPreset === preset.id ? <Badge>Selected</Badge> : null}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{preset.description}</p>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => applyPreset(true)} disabled={moduleState.saving}>
            {moduleState.saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {moduleState.onboardingRequired ? "Start with this mode" : "Apply preset"}
          </Button>
        </div>

        {!compact ? (
          <div className="space-y-5">
            {recommendations.length ? (
              <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div>
                  <p className="text-sm font-medium">Recommended next modules</p>
                  <p className="mt-1 text-xs text-muted-foreground">Suggestions are based on your current workspace counts. They never enable modules automatically.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {recommendations.map((recommendation) => {
                    const recommendedModule = APP_MODULES.find((module) => module.id === recommendation.moduleId);
                    if (!recommendedModule) return null;
                    return (
                      <div key={recommendation.moduleId} className="rounded-lg border bg-background/70 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium">{recommendation.title}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{recommendation.reason}</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => enableRecommendedModule(recommendation.moduleId)} disabled={moduleState.saving}>
                            Enable
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Custom module toggles</p>
                <p className="mt-1 text-xs text-muted-foreground">Basic modules stay on. Advanced modules can be enabled per user after onboarding.</p>
              </div>
              {MODULE_GROUP_ORDER.map((group) => {
                const modules = APP_MODULES.filter((module) => module.group === group && module.visibility.configurable && !module.visibility.adminOnly);
                if (!modules.length) return null;
                return (
                  <div key={group} className="rounded-lg border bg-background/60 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{MODULE_GROUP_LABELS[group]}</p>
                    <div className="space-y-2">
                      {modules.map((module) => (
                        <label key={module.id} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={enabledIds.has(module.id)}
                            disabled={moduleState.saving}
                            onChange={(event) => toggleModule(module.id, event.target.checked)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              {module.label}
                              {module.visibility.advanced ? <Badge variant="secondary">Advanced</Badge> : null}
                              {module.visibility.experimental ? <Badge variant="outline">Experimental</Badge> : null}
                              <ModuleCapabilityBadge capability={capabilities[module.id]} />
                            </span>
                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                              {capabilities[module.id]?.detail ?? module.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">Current visible modules</p>
              {pinnedPrimaryModules.length ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pinned order</p>
                  <div className="space-y-2">
                    {pinnedPrimaryModules.map((module, index) => (
                      <div key={module.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-2">
                        <span className="text-sm font-medium">{module.label}</span>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => movePinned(module.id, -1)} disabled={moduleState.saving || index === 0}>
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => movePinned(module.id, 1)} disabled={moduleState.saving || index === pinnedPrimaryModules.length - 1}>
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {MODULE_GROUP_ORDER.map((group) => {
                const modules = APP_MODULES.filter((module) => module.group === group && enabledIds.has(module.id));
                if (!modules.length) return null;
                return (
                  <div key={group} className="rounded-lg border bg-background/60 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{MODULE_GROUP_LABELS[group]}</p>
                    <div className="flex flex-wrap gap-2">
                      {modules.map((module) => (
                        <span key={module.id} className="inline-flex items-center gap-1">
                          <Badge variant={module.visibility.advanced ? "secondary" : "outline"}>{module.label}</Badge>
                          <ModuleCapabilityBadge capability={capabilities[module.id]} />
                          {module.nav?.primary ? (
                            <button
                              type="button"
                              className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
                              onClick={() => togglePinned(module.id)}
                              disabled={moduleState.saving}
                              title={pinnedIds.has(module.id) ? "Unpin from sidebar" : "Pin to sidebar"}
                            >
                              {pinnedIds.has(module.id) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                              {pinnedIds.has(module.id) ? "Unpin" : "Pin"}
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
