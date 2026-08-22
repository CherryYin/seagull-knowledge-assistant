import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { APP_MODULES, type AppModuleConfig } from "@/config/modules";
import { DEFAULT_MODULE_PRESET_ID, getModulePreset, type ModulePresetId } from "@/config/module-presets";
import { authApi } from "@/lib/api/auth";
import { useAuth } from "@/lib/auth";

export interface UserModuleSettings {
  preset?: ModulePresetId;
  enabled?: string[];
  disabled?: string[];
  pinned?: string[];
  onboarding_completed?: boolean;
}

export interface ResolvedModulesResult {
  modules: AppModuleConfig[];
  settings: UserModuleSettings;
  rawSettings: Record<string, unknown>;
  loading: boolean;
  isAdmin: boolean;
  onboardingRequired: boolean;
  saveModuleSettings: (settings: UserModuleSettings) => Promise<void>;
  saving: boolean;
}

export const USER_SETTINGS_QUERY_KEY = ["my-settings"] as const;

function asModuleSettings(value: unknown): UserModuleSettings {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  return {
    preset: typeof obj.preset === "string" ? obj.preset as ModulePresetId : undefined,
    enabled: Array.isArray(obj.enabled) ? obj.enabled.filter((item): item is string => typeof item === "string") : undefined,
    disabled: Array.isArray(obj.disabled) ? obj.disabled.filter((item): item is string => typeof item === "string") : undefined,
    pinned: Array.isArray(obj.pinned) ? obj.pinned.filter((item): item is string => typeof item === "string") : undefined,
    onboarding_completed: typeof obj.onboarding_completed === "boolean" ? obj.onboarding_completed : undefined,
  };
}

export function resolveEnabledModules(settings: UserModuleSettings, { isAdmin = false }: { isAdmin?: boolean } = {}) {
  if (isAdmin) return APP_MODULES;

  const preset = getModulePreset(settings.preset ?? DEFAULT_MODULE_PRESET_ID);
  const enabled = new Set(preset.enabledModuleIds);
  for (const moduleId of settings.enabled ?? []) enabled.add(moduleId);
  for (const moduleId of settings.disabled ?? []) enabled.delete(moduleId);

  for (const module of APP_MODULES) {
    if (module.visibility.adminOnly) enabled.delete(module.id);
    if (!module.visibility.configurable && module.visibility.defaultEnabled) enabled.add(module.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const module of APP_MODULES) {
      if (!enabled.has(module.id)) continue;
      for (const dependency of module.dependencies ?? []) {
        if (!enabled.has(dependency)) {
          enabled.add(dependency);
          changed = true;
        }
      }
    }
  }

  return APP_MODULES.filter((module) => enabled.has(module.id));
}

export function useResolvedModules(): ResolvedModulesResult {
  const { isAdmin, user } = useAuth();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: USER_SETTINGS_QUERY_KEY,
    queryFn: () => authApi.getMySettings(),
    enabled: !!user,
  });
  const rawSettings = settingsQuery.data?.settings ?? {};
  const moduleSettings = asModuleSettings(rawSettings.modules);

  const mutation = useMutation({
    mutationFn: async (nextModules: UserModuleSettings) => {
      const mergedSettings = {
        ...rawSettings,
        modules: nextModules,
      };
      await authApi.updateMySettings(mergedSettings);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USER_SETTINGS_QUERY_KEY }),
  });

  return {
    modules: resolveEnabledModules(moduleSettings, { isAdmin }),
    settings: moduleSettings,
    rawSettings,
    loading: settingsQuery.isLoading,
    isAdmin,
    onboardingRequired: !!user && !isAdmin && moduleSettings.onboarding_completed !== true,
    saveModuleSettings: (settings: UserModuleSettings) => mutation.mutateAsync(settings),
    saving: mutation.isPending,
  };
}
