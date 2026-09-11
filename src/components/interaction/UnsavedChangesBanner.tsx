import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";

export function UnsavedChangesBanner({
  message = "Unsaved changes are only stored locally.",
  onSave,
  saveLabel = "Save changes",
  saving = false,
  saveDisabled = false,
}: {
  message?: string;
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
  saveDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-unsaved-changes>
      <p className="font-medium">{message}</p>
      {onSave && <Button type="button" size="sm" onClick={onSave} disabled={saving || saveDisabled}><Save className="mr-2 h-4 w-4" />{saving ? "Saving…" : saveLabel}</Button>}
    </div>
  );
}
