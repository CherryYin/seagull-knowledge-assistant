import type { ReactNode } from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface StateMessageProps {
  tone?: "empty" | "error" | "info";
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
  className?: string;
}

export function StateMessage({
  tone = "info",
  title,
  description,
  actionLabel,
  onAction,
  children,
  className,
}: StateMessageProps) {
  const Icon = tone === "error" ? AlertTriangle : Inbox;
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed p-6 text-center",
        tone === "error" ? "border-red-500/30 bg-red-500/5" : "border-border bg-card",
        className
      )}
    >
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon className={cn("h-5 w-5", tone === "error" ? "text-red-600" : "text-muted-foreground")} />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{description}</p>}
      {children && <div className="mt-3 text-sm text-muted-foreground">{children}</div>}
      {actionLabel && onAction && (
        <Button size="sm" variant="outline" className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
