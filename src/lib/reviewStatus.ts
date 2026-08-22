export function getReviewStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "pending_review":
      return "Pending Review";
    case "accepted":
      return "Accepted";
    case "applied":
      return "Applied";
    case "dismissed":
      return "Dismissed";
    case "rejected":
      return "Rejected";
    default:
      return status.replace(/_/g, " ");
  }
}

export function getReviewConflictMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("409:")) {
    return "This review item is out of date or conflicts with another item. The queue has been refreshed.";
  }
  return fallback;
}
