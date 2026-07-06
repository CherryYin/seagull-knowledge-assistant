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
  return MODULE_GROUP_ORDER.map((group) => {
    const items = enabled
      .filter((module) => module.group === group)
      .sort((left, right) => (left.nav?.order ?? 0) - (right.nav?.order ?? 0));
    return { label: MODULE_GROUP_LABELS[group], items };
  }).filter((section) => section.items.length > 0);
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
