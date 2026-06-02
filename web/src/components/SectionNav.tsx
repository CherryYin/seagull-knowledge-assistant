import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  label: string;
  to: string;
}

export function SectionNav({ items, active }: { items: SectionNavItem[]; active: string }) {
	return (
		<div className="grid gap-2 rounded-xl border bg-card p-3 text-xs text-muted-foreground sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(
            "rounded-lg px-3 py-2 transition-colors hover:bg-accent",
            item.label === active && "bg-primary/10 font-medium text-primary"
          )}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export const knowledgeNavItems: SectionNavItem[] = [
	{ label: "Search", to: "/search" },
	{ label: "Sources", to: "/sources" },
	{ label: "Notes", to: "/notes" },
	{ label: "Documents", to: "/documents" },
	{ label: "Memory", to: "/memory" },
	{ label: "Wiki", to: "/wiki" },
];

export const reviewNavItems: SectionNavItem[] = [
	{ label: "Review", to: "/review" },
	{ label: "Digest", to: "/review/digest" },
	{ label: "Wiki Refresh", to: "/review/wiki-suggestions" },
	{ label: "Suggestions", to: "/review/suggestions" },
];

export const discoverNavItems: SectionNavItem[] = [
	{ label: "Recommended", to: "/discover" },
];

export const settingsNavItems: SectionNavItem[] = [
	{ label: "Settings", to: "/settings" },
	{ label: "Profile", to: "/settings/profile" },
	{ label: "Agents", to: "/settings/agents" },
	{ label: "Skills", to: "/settings/skills" },
	{ label: "Workspace", to: "/settings/workspace" },
	{ label: "Dashboard", to: "/stats" },
];
