import { Navigate, useLocation } from "react-router-dom";

import { getModuleForPathname } from "@/lib/modules/resolve-modules";
import { useResolvedModules } from "@/lib/modules/module-settings";

export function ModuleRouteGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const moduleState = useResolvedModules();
  const routeModule = getModuleForPathname(location.pathname);

  if (moduleState.loading) {
    return <div className="flex h-full min-h-screen items-center justify-center text-sm text-muted-foreground">Loading workspace…</div>;
  }
  if (moduleState.isAdmin) return <>{children}</>;
  if (location.pathname === "/onboarding") {
    return moduleState.onboardingRequired ? <>{children}</> : <Navigate to="/" replace />;
  }
  if (moduleState.onboardingRequired && !routeModule) {
    return <Navigate to="/onboarding" replace state={{ from: location.pathname }} />;
  }
  if (!routeModule) return <>{children}</>;
  if (routeModule.visibility.adminOnly) return <Navigate to="/" replace />;
  if (moduleState.modules.some((module) => module.id === routeModule.id)) return <>{children}</>;

  const redirectTo = moduleState.onboardingRequired ? "/onboarding" : "/settings";
  return <Navigate to={redirectTo} replace state={{ from: location.pathname, gatedModuleId: routeModule.id }} />;
}
