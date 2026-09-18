import { Link, useLocation } from "react-router-dom";
import { Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { ModuleSectionNav } from "@/components/SectionNav";
import { ModuleTogglePanel } from "@/components/ModuleTogglePanel";
import { useResolvedModules } from "@/lib/modules/module-settings";
import { APP_MODULES } from "@/config/modules";

export function SettingsPage() {
  const { isAdmin } = useAuth();
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
                Configuration and admin tools live here so the main steward workflow stays focused.
              </p>
            </div>
          </div>
        </section>

        <ModuleTogglePanel />

				{gatedPath ? (
					<section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900">
						<p className="font-medium">That module is hidden until you finish choosing a workspace mode.</p>
						<p className="mt-1 text-amber-800/90">You were redirected here from <code>{gatedPath}</code>. Choose a preset below to keep the workspace simple, then enable advanced modules whenever you need them.</p>
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
