import {
  APP_MODULES,
  MODULE_GROUP_LABELS,
  MODULE_GROUP_ORDER,
  type AppModuleConfig,
} from "@/config/modules";
import type { SectionNavItem } from "@/components/SectionNav";
import { resolveEnabledModules, type UserModuleSettings } from "@/lib/modules/module-settings";

export interface ModuleNavSection {
  label: string;
  items: AppModuleConfig[];
}

export function getEnabledModules({ isAdmin = false, settings = {} }: { isAdmin?: boolean; settings?: UserModuleSettings } = {}) {
  return resolveEnabledModules(settings, { isAdmin });
}

export function getPrimaryNavSections({ isAdmin = false, settings = {} }: { isAdmin?: boolean; settings?: UserModuleSettings } = {}): ModuleNavSection[] {
  const enabled = getEnabledModules({ isAdmin, settings }).filter((module) => module.nav?.primary);
  const enabledById = new Map(enabled.map((module) => [module.id, module]));
  const pinnedItems = (settings.pinned ?? [])
    .map((moduleId) => enabledById.get(moduleId))
    .filter((module): module is AppModuleConfig => !!module && !!module.nav?.primary);
  const pinnedIds = new Set(pinnedItems.map((module) => module.id));
  const sections: ModuleNavSection[] = pinnedItems.length ? [{ label: "Pinned", items: pinnedItems }] : [];
  const groupedSections = MODULE_GROUP_ORDER.map((group) => {
    const items = enabled
      .filter((module) => !pinnedIds.has(module.id))
      .filter((module) => module.group === group)
      .sort((left, right) => (left.nav?.order ?? 0) - (right.nav?.order ?? 0));
    return { label: MODULE_GROUP_LABELS[group], items };
  }).filter((section) => section.items.length > 0);
  return [...sections, ...groupedSections];
}

export function getSectionNavItems(parent: NonNullable<AppModuleConfig["nav"]>["parent"], { isAdmin = false, settings = {} }: { isAdmin?: boolean; settings?: UserModuleSettings } = {}): SectionNavItem[] {
  return getEnabledModules({ isAdmin, settings })
    .filter((module) => module.nav?.section && module.nav.parent === parent)
    .sort((left, right) => (left.nav?.order ?? 0) - (right.nav?.order ?? 0))
    .map((module) => ({ label: module.label, to: module.route }));
}

function isRouteMatch(pathname: string, route: string) {
  if (route === "/") return pathname === "/";
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function getModuleForPathname(pathname: string) {
  return [...APP_MODULES]
    .sort((left, right) => right.route.length - left.route.length)
    .find((module) => isRouteMatch(pathname, module.route));
}
