import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PodcastScrollRegion({ label, children, className }: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return <div role="region" aria-label={label} tabIndex={0} className={cn(
    "max-h-[min(50vh,24rem)] overflow-y-auto break-words rounded-sm pr-2 [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    className,
  )}>{children}</div>;
}
