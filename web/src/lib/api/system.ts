import { request } from "./client";

export type ModuleCapabilityStatus = "ready" | "needs_setup" | "experimental";

export interface ModuleCapability {
  available: boolean;
  status: ModuleCapabilityStatus;
  label: string;
  detail: string | null;
  setup_route: string | null;
  experimental: boolean;
}

export interface SystemCapabilities {
  modules: Record<string, ModuleCapability>;
}

export const systemApi = {
  capabilities: () => request<SystemCapabilities>("/system/capabilities"),
};
