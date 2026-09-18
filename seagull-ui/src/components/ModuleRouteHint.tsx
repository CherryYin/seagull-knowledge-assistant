import { Link, useLocation } from "react-router-dom";
import { EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getModuleForPathname } from "@/lib/modules/resolve-modules";
import { useResolvedModules } from "@/lib/modules/module-settings";

export function ModuleRouteHint() {
  const location = useLocation();
  const moduleState = useResolvedModules();
  const routeModule = getModuleForPathname(location.pathname);

  if (!routeModule || moduleState.loading || moduleState.isAdmin) return null;
  if (moduleState.modules.some((module) => module.id === routeModule.id)) return null;
  if (routeModule.visibility.adminOnly) return null;

  return (
    <div className="pointer-events-none absolute inset-x-4 top-4 z-10 mx-auto max-w-5xl">
      <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 text-sm shadow-sm backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-muted p-2 text-muted-foreground">
            <EyeOff className="h-4 w-4" />
          </div>
          <div>
            <p className="font-medium">{routeModule.label} is hidden from your workspace navigation.</p>
            <p className="mt-1 text-xs text-muted-foreground">Direct links still work. Enable this module in Settings if you want it shown in the sidebar and section tabs.</p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/settings">Open module settings</Link>
        </Button>
      </div>
    </div>
  );
}
