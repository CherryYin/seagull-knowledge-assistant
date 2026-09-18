export type CandidateAction = "keep" | "dismiss" | "publish" | "archive";

const labels: Record<CandidateAction, string> = {
  keep: "Keep",
  dismiss: "Dismiss",
  publish: "Publish",
  archive: "Archive",
};

export function candidateActionLabel(action: CandidateAction, detail?: string): string {
  return detail ? `${labels[action]} ${detail}` : labels[action];
}
