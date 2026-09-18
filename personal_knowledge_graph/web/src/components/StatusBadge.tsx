import { cn } from "@/lib/utils";
import { getStatusPresentation } from "@/lib/status";

interface StatusBadgeProps {
  status?: string | null;
  label?: string;
  className?: string;
}

const toneClasses = {
  default: "border-primary/20 bg-primary/10 text-primary",
  muted: "border-border bg-muted text-muted-foreground",
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-700",
  danger: "border-red-500/20 bg-red-500/10 text-red-700",
};

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const presentation = getStatusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        toneClasses[presentation.tone],
        className
      )}
      title={presentation.description}
    >
      {label ?? presentation.label}
    </span>
  );
}
