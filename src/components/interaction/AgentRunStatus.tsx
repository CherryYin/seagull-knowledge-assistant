import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, CircleStop, LoaderCircle, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentRunStatusValue = "idle" | "preparing" | "running" | "awaiting_input" | "validating" | "completed" | "stopping" | "stopped" | "failed";

const PRESENTATION: Record<AgentRunStatusValue, { label: string; className: string; icon: typeof Circle }> = {
  idle: { label: "Not started", className: "border-border text-muted-foreground", icon: Circle },
  preparing: { label: "Preparing", className: "border-blue-300 bg-blue-50 text-blue-700", icon: LoaderCircle },
  running: { label: "Running", className: "border-blue-300 bg-blue-50 text-blue-700", icon: LoaderCircle },
  awaiting_input: { label: "Awaiting input", className: "border-amber-300 bg-amber-50 text-amber-800", icon: MessageCircleQuestion },
  validating: { label: "Validating", className: "border-violet-300 bg-violet-50 text-violet-700", icon: ShieldCheck },
  completed: { label: "Completed", className: "border-emerald-300 bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  stopping: { label: "Stopping", className: "border-amber-300 bg-amber-50 text-amber-800", icon: LoaderCircle },
  stopped: { label: "Stopped", className: "border-amber-300 bg-amber-50 text-amber-800", icon: CircleStop },
  failed: { label: "Failed", className: "border-red-300 bg-red-50 text-red-700", icon: AlertTriangle },
};

export function AgentRunStatus({
  status,
  message,
  details,
  compact = false,
  className,
}: {
  status: AgentRunStatusValue;
  message?: ReactNode;
  details?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const presentation = PRESENTATION[status];
  const Icon = presentation.icon;
  const animated = status === "preparing" || status === "running" || status === "stopping";

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", presentation.className, className)} data-agent-run-status={status}>
        <Icon className={cn("h-3 w-3", animated && "animate-spin")} />
        {presentation.label}
      </span>
    );
  }

  return (
    <div className={cn("rounded-xl border px-4 py-3", presentation.className, className)} data-agent-run-status={status}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", animated && "animate-spin")} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{presentation.label}</p>
          {message && <div className="mt-1 text-sm opacity-90">{message}</div>}
          {details && <details className="mt-2 text-xs opacity-80"><summary className="cursor-pointer font-medium">Diagnostic details</summary><div className="mt-2 whitespace-pre-wrap font-mono">{details}</div></details>}
        </div>
      </div>
    </div>
  );
}
