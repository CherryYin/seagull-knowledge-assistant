const STORAGE_KEY = "pkg.ui.background";

export type BackgroundPresetId = "zinc" | "blue" | "green" | "purple" | "warm" | "slate";

export type BackgroundPreset = {
  id: BackgroundPresetId;
  label: string;
  color: string;
};

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: "zinc", label: "Zinc", color: "#09090b" },
  { id: "slate", label: "Slate", color: "#0f172a" },
  { id: "blue", label: "Blue", color: "#0a1628" },
  { id: "green", label: "Green", color: "#0a1810" },
  { id: "purple", label: "Purple", color: "#120a18" },
  { id: "warm", label: "Warm", color: "#141008" },
];

export function loadBackgroundPresetId(): BackgroundPresetId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && BACKGROUND_PRESETS.some((p) => p.id === raw)) {
      return raw as BackgroundPresetId;
    }
  } catch {
    /* ignore */
  }
  return "zinc";
}

export function saveBackgroundPresetId(id: BackgroundPresetId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function getPresetById(id: BackgroundPresetId): BackgroundPreset {
  return BACKGROUND_PRESETS.find((p) => p.id === id) ?? BACKGROUND_PRESETS[0];
}
