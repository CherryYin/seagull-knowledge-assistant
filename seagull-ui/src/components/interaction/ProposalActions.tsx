import { CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ProposalActions({
  primaryLabel,
  pendingLabel = "Applying…",
  onPrimary,
  primaryPending = false,
  primaryDisabled = false,
  onRegenerate,
  regenerateLabel = "Regenerate",
  regenerateDisabled = false,
  onDiscard,
  discardLabel = "Discard",
  note,
}: {
  primaryLabel: string;
  pendingLabel?: string;
  onPrimary: () => void;
  primaryPending?: boolean;
  primaryDisabled?: boolean;
  onRegenerate?: () => void;
  regenerateLabel?: string;
  regenerateDisabled?: boolean;
  onDiscard?: () => void;
  discardLabel?: string;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-proposal-actions>
      <Button type="button" size="sm" onClick={onPrimary} disabled={primaryDisabled || primaryPending}>
        {primaryPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
        {primaryPending ? pendingLabel : primaryLabel}
      </Button>
      {onRegenerate && <Button type="button" variant="outline" size="sm" onClick={onRegenerate} disabled={regenerateDisabled || primaryPending}><RefreshCw className="mr-2 h-4 w-4" />{regenerateLabel}</Button>}
      {onDiscard && <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={primaryPending}><Trash2 className="mr-2 h-4 w-4" />{discardLabel}</Button>}
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}
