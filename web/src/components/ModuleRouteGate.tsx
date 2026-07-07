import { Navigate, useLocation } from "react-router-dom";

import { getModuleForPathname } from "@/lib/modules/resolve-modules";
import { useResolvedModules } from "@/lib/modules/module-settings";

export function ModuleRouteGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const moduleState = useResolvedModules();
  const routeModule = getModuleForPathname(location.pathname);

  if (moduleState.loading || moduleState.isAdmin) return <>{children}</>;
  if (!moduleState.onboardingRequired && location.pathname === "/onboarding") return <Navigate to="/" replace />;
  if (moduleState.onboardingRequired && location.pathname !== "/onboarding" && !routeModule) {
    return <Navigate to="/onboarding" replace state={{ from: location.pathname }} />;
  }
  if (!routeModule) return <>{children}</>;
  if (routeModule.visibility.adminOnly) return <>{children}</>;
  if (!moduleState.onboardingRequired) {
    return <>{children}</>;
  }
  if (location.pathname === "/onboarding") return <>{children}</>;
  if (moduleState.modules.some((module) => module.id === routeModule.id)) return <>{children}</>;
  if (location.pathname === "/settings") return <Navigate to="/onboarding" replace state={location.state} />;

  return <Navigate to="/onboarding" replace state={{ from: location.pathname, gatedModuleId: routeModule.id }} />;
}
