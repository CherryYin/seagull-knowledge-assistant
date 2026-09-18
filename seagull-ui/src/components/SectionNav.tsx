import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { getSectionNavItems } from "@/lib/modules/resolve-modules";
import { useAuth } from "@/lib/auth";
import { useResolvedModules } from "@/lib/modules/module-settings";

export interface SectionNavItem {
  label: string;
  to: string;
}

export function SectionNav({ items, active }: { items: SectionNavItem[]; active: string }) {
	if (items.length < 2) return null;

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

export function ModuleSectionNav({ parent, active }: { parent: "knowledge" | "review" | "discover" | "settings"; active: string }) {
  const { isAdmin } = useAuth();
  const moduleState = useResolvedModules();
  return <SectionNav items={getSectionNavItems(parent, { isAdmin, settings: moduleState.settings })} active={active} />;
}
