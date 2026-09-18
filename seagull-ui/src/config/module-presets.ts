export type ModulePresetId = "basic" | "researcher" | "knowledge_graph" | "creator" | "operator";

export interface ModulePreset {
  id: ModulePresetId;
  label: string;
  description: string;
  enabledModuleIds: string[];
}

export const BASIC_MODULE_IDS = [
  "home",
  "search",
  "sources",
  "notes",
  "review",
  "discover",
  "agent-chat",
  "settings",
];

export const MODULE_PRESETS: ModulePreset[] = [
  {
    id: "basic",
    label: "Basic",
    description: "Lightweight workspace for sources, notes, search, review, discovery, and agent chat.",
    enabledModuleIds: BASIC_MODULE_IDS,
  },
  {
    id: "researcher",
    label: "Researcher",
    description: "Adds wiki synthesis, digest review, and assets on top of the core knowledge workflow.",
    enabledModuleIds: [
      ...BASIC_MODULE_IDS,
      "wiki",
      "wiki-review",
      "digest-review",
      "assets",
    ],
  },
  {
    id: "knowledge_graph",
    label: "Knowledge Graph",
    description: "Enables canonical wiki and advanced refinement queues.",
    enabledModuleIds: [
      ...BASIC_MODULE_IDS,
      "wiki",
      "digest-review",
      "wiki-review",
      "wiki-discovery",
      "wiki-rules",
      "review-suggestions",
    ],
  },
  {
    id: "creator",
    label: "Creator",
    description: "Adds asset production and digest review for publishing workflows.",
    enabledModuleIds: [
      ...BASIC_MODULE_IDS,
      "assets",
      "digest-review",
    ],
  },
  {
    id: "operator",
    label: "Operator",
    description: "Adds setup and operational tools for managing providers and background jobs.",
    enabledModuleIds: [
      ...BASIC_MODULE_IDS,
      "api-keys",
      "connectors",
      "system-jobs",
      "dashboard",
    ],
  },
];

export const DEFAULT_MODULE_PRESET_ID: ModulePresetId = "basic";

export function getModulePreset(id: string | null | undefined): ModulePreset {
  return MODULE_PRESETS.find((preset) => preset.id === id) ?? MODULE_PRESETS[0];
}
