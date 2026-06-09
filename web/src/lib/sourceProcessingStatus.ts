import type { Source } from "@/lib/api";

export type SourceProcessingStage =
  | "raw"
  | "extracted"
  | "chunked"
  | "summarized"
  | "reviewed"
  | "promoted";

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

export function getSourceProcessingState(source: Source, options?: { chunkCount?: number | null }): SourceProcessingState {
  const metadata = source.metadata_ ?? {};
  const reviewStatus = String(metadata.review_status ?? "").toLowerCase();
  const webFetchStatus = String(metadata.web_fetch_status ?? metadata.last_fetch_status ?? "").toLowerCase();
  const extractionStatus = String(metadata.extraction_status ?? "").toLowerCase();
  const summaryStatus = String(metadata.summary_status ?? "").toLowerCase();
  const chunkCount = options?.chunkCount ?? null;

  if ([webFetchStatus, extractionStatus, summaryStatus].some((value) => ["failed", "error", "errored"].includes(value))) {
    return { stage: "extracted", status: "failed", label: "Processing failed", detail: "Fetching, extraction, or summary generation failed." };
  }

  if (String(metadata.stale ?? "").toLowerCase() === "true") {
    return { stage: "extracted", status: "stale", label: "Stale", detail: "This source may be outdated and worth reprocessing." };
  }

  if (reviewStatus === "reviewed_kept") {
    return { stage: "reviewed", status: "ready", label: "Reviewed", detail: "This source has been reviewed and kept." };
  }

  if (reviewStatus === "imported_reviewable") {
    return { stage: "reviewed", status: "needs_review", label: "Needs review", detail: "Imported source is waiting for review." };
  }

  if (summaryStatus === "completed") {
    return { stage: "summarized", status: "ready", label: "Summarized", detail: "Source text has been summarized and is ready to use." };
  }

  if ((chunkCount ?? 0) > 0) {
    return { stage: "chunked", status: "ready", label: "Chunked", detail: `Source has been split into ${chunkCount} chunks.` };
  }

  if (source.raw_content || webFetchStatus === "fetched" || extractionStatus === "completed") {
    return { stage: "extracted", status: "ready", label: "Extracted", detail: "Readable content is available." };
  }

  return { stage: "raw", status: "waiting", label: "Raw", detail: "Source exists, but readable processing is still limited." };
}

export function getSourceProcessingSteps(source: Source, options?: { chunkCount?: number | null }): SourceProcessingStep[] {
  const metadata = source.metadata_ ?? {};
  const reviewStatus = String(metadata.review_status ?? "").toLowerCase();
  const webFetchStatus = String(metadata.web_fetch_status ?? metadata.last_fetch_status ?? "").toLowerCase();
  const extractionStatus = String(metadata.extraction_status ?? "").toLowerCase();
  const summaryStatus = String(metadata.summary_status ?? "").toLowerCase();
  const chunkCount = options?.chunkCount ?? null;
  const failed = [webFetchStatus, extractionStatus, summaryStatus].some((value) => ["failed", "error", "errored"].includes(value));
  const hasReadable = !!source.raw_content || webFetchStatus === "fetched" || extractionStatus === "completed";
  const hasChunks = (chunkCount ?? 0) > 0;
  const hasSummary = summaryStatus === "completed";
  const reviewed = reviewStatus === "reviewed_kept";

  return [
    {
      key: "raw",
      label: "Raw",
      state: "done",
      detail: "Source has been saved with provenance.",
    },
    {
      key: "extracted",
      label: "Extracted",
      state: failed ? "failed" : hasReadable ? "done" : "current",
      detail: hasReadable ? "Readable content is available." : "Waiting for fetch or text extraction.",
    },
    {
      key: "chunked",
      label: "Chunked",
      state: failed ? "failed" : hasChunks ? "done" : hasReadable ? "current" : "pending",
      detail: hasChunks ? `Generated ${chunkCount} chunks.` : "Chunks are not available yet.",
    },
    {
      key: "summarized",
      label: "Summarized",
      state: failed ? "failed" : hasSummary ? "done" : hasChunks ? "current" : "pending",
      detail: hasSummary ? "Summary is available." : "Summary has not been generated yet.",
    },
    {
      key: "review",
      label: "Reviewed",
      state: reviewed ? "done" : reviewStatus === "imported_reviewable" ? "current" : "pending",
      detail: reviewed ? "Reviewed and kept." : reviewStatus === "imported_reviewable" ? "Waiting for review." : "No explicit review recorded yet.",
    },
  ];
}
