export type UserFacingStatus =
  | "ready"
  | "waiting"
  | "needs_review"
  | "failed"
  | "stale"
  | "archived";

export type StatusTone = "default" | "muted" | "success" | "warning" | "danger";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  description?: string;
}

const STATUS_PRESENTATIONS: Record<UserFacingStatus, StatusPresentation> = {
  ready: {
    label: "Ready",
    tone: "success",
    description: "Completed and ready to use.",
  },
  waiting: {
    label: "Waiting",
    tone: "warning",
    description: "Queued, running, or still processing.",
  },
  needs_review: {
    label: "Needs review",
    tone: "default",
    description: "Waiting for your confirmation.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "Needs attention before it can continue.",
  },
  stale: {
    label: "Stale",
    tone: "warning",
    description: "May be outdated and worth refreshing.",
  },
  archived: {
    label: "Archived",
    tone: "muted",
    description: "Dismissed or no longer active.",
  },
};

export function normalizeStatus(status?: string | null): UserFacingStatus {
  const value = (status || "").toLowerCase();
  if (["completed", "complete", "ready", "kept", "accepted", "applied", "success"].includes(value)) {
    return "ready";
  }
  if (["pending", "queued", "running", "processing", "in_progress", "started"].includes(value)) {
    return "waiting";
  }
  if (["pending_review", "suggested", "recommended", "review", "needs_review"].includes(value)) {
    return "needs_review";
  }
  if (["failed", "error", "errored", "timeout", "cancelled"].includes(value)) {
    return "failed";
  }
  if (["stale", "expired", "outdated"].includes(value)) {
    return "stale";
  }
  if (["dismissed", "rejected", "archived", "ignored"].includes(value)) {
    return "archived";
  }
  return "needs_review";
}

export function getStatusPresentation(status?: string | null): StatusPresentation {
  return STATUS_PRESENTATIONS[normalizeStatus(status)];
}

export function formatDuration(ms?: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
