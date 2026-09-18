import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ActionError({
  title = "Action failed",
  impact,
  recovery,
  details,
  onRetry,
  retryLabel = "Retry",
}: {
  title?: string;
  impact: ReactNode;
  recovery?: ReactNode;
  details?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900" data-action-error>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <div className="mt-1">{impact}</div>
          {recovery && <div className="mt-1 text-xs opacity-85">Recovery: {recovery}</div>}
          {details && <details className="mt-2 text-xs opacity-80"><summary className="cursor-pointer font-medium">Details</summary><div className="mt-2 whitespace-pre-wrap font-mono">{details}</div></details>}
          {onRetry && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}><RefreshCw className="mr-2 h-4 w-4" />{retryLabel}</Button>}
        </div>
      </div>
    </div>
  );
}
