const STORAGE_KEY = "pkg.ui.background";

export type BackgroundPresetId = "zinc" | "blue" | "green" | "purple" | "warm" | "slate";

export type BackgroundPreset = {
  id: BackgroundPresetId;
  label: string;
  color: string;
};

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: "zinc", label: "Zinc", color: "#fafafa" },
  { id: "slate", label: "Slate", color: "#f8fafc" },
  { id: "blue", label: "Blue", color: "#eff6ff" },
  { id: "green", label: "Green", color: "#f0fdf4" },
  { id: "purple", label: "Purple", color: "#faf5ff" },
  { id: "warm", label: "Warm", color: "#fffbeb" },
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
