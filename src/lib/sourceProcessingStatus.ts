import type { Source } from "@/lib/api";

export type SourceProcessingStage = "stored" | "extracted" | "indexed" | "ready" | "reviewed";

export interface SourceProcessingState {
  stage: SourceProcessingStage;
  status: "ready" | "waiting" | "needs_review" | "failed" | "stale";
  label: string;
  detail: string;
}

export interface SourceProcessingStep {
  key: SourceProcessingStage | "review";
  label: string;
  state: "done" | "current" | "pending" | "failed";
  detail: string;
}

function statusValue(value: unknown) {
  return String(value ?? "").toLowerCase();
}

function isFailed(value: string) {
  return ["failed", "error", "errored"].includes(value);
}

function reviewWorkflowStatus(source: Source) {
  const value = statusValue(source.metadata_?.review_status);
  return value === "imported_reviewable" || value === "reviewed_kept" ? value : "";
}

export function getSourceProcessingState(source: Source, options?: { chunkCount?: number | null }): SourceProcessingState {
  const metadata = source.metadata_ ?? {};
  const reviewStatus = reviewWorkflowStatus(source);
  const fetchStatus = statusValue(metadata.web_fetch_status ?? metadata.last_fetch_status);
  const extractionStatus = statusValue(metadata.extraction_status);
  const indexStatus = statusValue(metadata.index_status);
  const chunkCount = options?.chunkCount ?? null;
  const hasReadable = Boolean(source.raw_content) || fetchStatus === "fetched" || extractionStatus === "completed";
  const hasIndex = indexStatus === "completed" || (chunkCount ?? 0) > 0;

  if (isFailed(fetchStatus) || isFailed(extractionStatus)) {
    return { stage: "extracted", status: "failed", label: "Extraction failed", detail: "Readable content could not be fetched or extracted." };
  }
  if (isFailed(indexStatus)) {
    return { stage: "indexed", status: "failed", label: "Indexing failed", detail: "The source was saved, but its search index could not be generated." };
  }
  if (statusValue(metadata.stale) === "true") {
    return { stage: "extracted", status: "stale", label: "Stale", detail: "This source may be outdated and worth reprocessing." };
  }
  if (reviewStatus === "imported_reviewable") {
    return { stage: "reviewed", status: "needs_review", label: "Needs review", detail: "This automatically imported source is waiting for a keep or discard decision." };
  }
  if (reviewStatus === "reviewed_kept") {
    return { stage: "reviewed", status: "ready", label: "Kept", detail: "This imported source has been reviewed and kept." };
  }
  if (hasReadable && hasIndex) {
    return { stage: "ready", status: "ready", label: "Ready", detail: "Readable content and a search index are available." };
  }
  if (hasReadable) {
    return { stage: "extracted", status: "waiting", label: "Extracted", detail: "Readable content is available, but indexing is not confirmed." };
  }
  return { stage: "stored", status: "waiting", label: "Stored", detail: "The source record exists, but readable content is not available yet." };
}

export function getSourceProcessingSteps(source: Source, options?: { chunkCount?: number | null }): SourceProcessingStep[] {
  const metadata = source.metadata_ ?? {};
  const reviewStatus = reviewWorkflowStatus(source);
  const fetchStatus = statusValue(metadata.web_fetch_status ?? metadata.last_fetch_status);
  const extractionStatus = statusValue(metadata.extraction_status);
  const extractionMode = statusValue(metadata.extraction_mode ?? metadata.web_fetch_extractor);
  const indexStatus = statusValue(metadata.index_status);
  const chunkCount = options?.chunkCount ?? null;
  const extractionFailed = isFailed(fetchStatus) || isFailed(extractionStatus);
  const indexFailed = isFailed(indexStatus);
  const hasReadable = Boolean(source.raw_content) || fetchStatus === "fetched" || extractionStatus === "completed";
  const hasIndex = indexStatus === "completed" || (chunkCount ?? 0) > 0;
  const imported = Boolean(reviewStatus);

  const steps: SourceProcessingStep[] = [
    {
      key: "stored",
      label: imported ? "Imported" : "Stored",
      state: "done",
      detail: imported ? "The discovered source has been imported with provenance." : "The source has been saved with provenance.",
    },
    {
      key: "extracted",
      label: "Content Extracted",
      state: extractionFailed ? "failed" : hasReadable ? "done" : "current",
      detail: extractionFailed
        ? "Fetching or text extraction failed."
        : hasReadable
          ? `Readable content is available${extractionMode ? ` via ${extractionMode}` : ""}.`
          : "Waiting for readable content to be fetched or extracted.",
    },
    {
      key: "indexed",
      label: "Indexed",
      state: indexFailed ? "failed" : hasIndex ? "done" : hasReadable ? "current" : "pending",
      detail: indexFailed
        ? "Search embeddings or chunks could not be generated."
        : hasIndex
          ? (chunkCount === null ? "The source search index is available." : `The source search index contains ${chunkCount} chunks.`)
          : "The source search index is not available yet.",
    },
  ];

  if (imported) {
    steps.push({
      key: "review",
      label: "Review",
      state: reviewStatus === "reviewed_kept" ? "done" : "current",
      detail: reviewStatus === "reviewed_kept" ? "Reviewed and kept." : "Choose whether to keep or discard this automatically imported source.",
    });
  } else {
    steps.push({
      key: "ready",
      label: "Ready",
      state: hasReadable && hasIndex ? "done" : extractionFailed || indexFailed ? "failed" : "pending",
      detail: hasReadable && hasIndex ? "Ready for search, citation, and Agent use." : "Ready after readable content and indexing are both available.",
    });
  }

  return steps;
}
