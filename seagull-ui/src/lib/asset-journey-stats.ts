import type { Note, NoteList } from "@/lib/api/notes";

export const JOURNEY_STEPS = ["intent", "evidence", "claims", "draft", "optimization", "visuals", "delivery", "knowledge_promotion"] as const;
export const ADOPTION_STATUSES = ["yes", "partial", "no", "in_progress", "undecided", "unknown"] as const;
export const METRIC_UNITS = {
  wait_seconds: "seconds",
  visual_elapsed_seconds: "seconds",
  retry_count: "count",
  processing_attempts: "count",
  input_tokens: "tokens",
  output_tokens: "tokens",
  total_tokens: "tokens",
} as const;

type JourneyStep = typeof JOURNEY_STEPS[number];
type ObservationSource = "system_record" | "user_report" | "user_estimate" | "unknown";
type AdoptionStatus = typeof ADOPTION_STATUSES[number];

export interface JourneyMetric {
  scope: string;
  metric: keyof typeof METRIC_UNITS;
  value: number | null;
  unit: "seconds" | "count" | "tokens";
  source: ObservationSource;
}

export interface AssetJourneyReport {
  kind: "asset_journey_review";
  schema_version: 1;
  asset_id: string | null;
  stops: {
    status: "none" | "reported" | "unknown";
    source: "user_report" | "unknown";
    items: { step: JourneyStep; reason: string }[];
  };
  manual_recovery: {
    status: "none" | "reported" | "unknown";
    source: "system_record" | "user_report" | "unknown";
    items: { step: JourneyStep; problem: string; action: string; result: string }[];
  };
  adoption: { status: AdoptionStatus; reason: string | null; source: "user_report" | "unknown" };
  metrics: JourneyMetric[];
}

export const ASSET_JOURNEY_REPORT_TEMPLATE: AssetJourneyReport = {
  kind: "asset_journey_review",
  schema_version: 1,
  asset_id: null,
  stops: { status: "unknown", source: "unknown", items: [] },
  manual_recovery: { status: "unknown", source: "unknown", items: [] },
  adoption: { status: "unknown", reason: null, source: "unknown" },
  metrics: [
    { scope: "journey", metric: "wait_seconds", value: null, unit: "seconds", source: "unknown" },
    { scope: "journey", metric: "retry_count", value: null, unit: "count", source: "unknown" },
    { scope: "journey", metric: "total_tokens", value: null, unit: "tokens", source: "unknown" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
}

function isStep(value: unknown): value is JourneyStep {
  return JOURNEY_STEPS.includes(value as JourneyStep);
}

function validObservation(value: unknown, sources: string[]) {
  if (!isRecord(value) || typeof value.status !== "string" || !["none", "reported", "unknown"].includes(value.status)
    || typeof value.source !== "string" || !sources.includes(value.source) || !Array.isArray(value.items) || value.items.length > 50) return false;
  if (value.status === "unknown") return value.source === "unknown" && value.items.length === 0;
  return value.source !== "unknown" && (value.status === "none" ? value.items.length === 0 : value.items.length > 0);
}

export function parseAssetJourneyReport(content?: string | null, expectedAssetId?: string) {
  const failed = (error: string): { report: AssetJourneyReport | null; error: string | null } => ({ report: null, error });
  const candidates: Record<string, unknown>[] = [];
  for (const match of (content ?? "").matchAll(/^```json[\t ]*\r?\n([\s\S]*?)^```[\t ]*\r?$/gm)) {
    try {
      const value: unknown = JSON.parse(match[1]);
      if (isRecord(value) && value.kind === "asset_journey_review") candidates.push(value);
    } catch {
      continue;
    }
  }
  if (candidates.length !== 1) return failed(candidates.length ? "Multiple structured summaries" : "No valid structured summary");
  const value = candidates[0];
  if (value.schema_version !== 1) return failed("Unsupported summary version");
  if (value.asset_id !== null && !isText(value.asset_id)) return failed("Invalid Asset ID");
  if (expectedAssetId && value.asset_id !== expectedAssetId) return failed("Summary Asset ID does not match the saved note");
  if (!validObservation(value.stops, ["user_report", "unknown"]) || !isRecord(value.stops)
    || !(value.stops.items as unknown[]).every(item => isRecord(item) && isStep(item.step) && isText(item.reason))) {
    return failed("Invalid stop observations");
  }
  if (!validObservation(value.manual_recovery, ["system_record", "user_report", "unknown"]) || !isRecord(value.manual_recovery)
    || !(value.manual_recovery.items as unknown[]).every(item => isRecord(item) && isStep(item.step)
      && isText(item.problem) && isText(item.action) && isText(item.result))) return failed("Invalid recovery observations");
  if (!isRecord(value.adoption) || !ADOPTION_STATUSES.includes(value.adoption.status as AdoptionStatus)
    || typeof value.adoption.source !== "string" || !["user_report", "unknown"].includes(value.adoption.source)
    || (value.adoption.reason !== null && !isText(value.adoption.reason))
    || (value.adoption.status === "unknown" ? value.adoption.source !== "unknown" : value.adoption.source !== "user_report")) {
    return failed("Invalid adoption observation");
  }
  if (!Array.isArray(value.metrics) || value.metrics.length > 100) return failed("Invalid metric list");
  const metricKeys = new Set<string>();
  for (const metric of value.metrics) {
    if (!isRecord(metric) || !isText(metric.scope) || typeof metric.metric !== "string" || !Object.prototype.hasOwnProperty.call(METRIC_UNITS, metric.metric)
      || metric.unit !== METRIC_UNITS[metric.metric as keyof typeof METRIC_UNITS]
      || typeof metric.source !== "string" || !["system_record", "user_report", "user_estimate", "unknown"].includes(metric.source)) return failed("Invalid metric or unit");
    if (metric.value === null) {
      if (metric.source !== "unknown") return failed("Missing metric must be unknown");
    } else if (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0
      || metric.source === "unknown" || (metric.unit !== "seconds" && !Number.isSafeInteger(metric.value))) {
      return failed("Invalid metric value or source");
    }
    const key = JSON.stringify([metric.scope, metric.metric, metric.source]);
    if (metricKeys.has(key)) return failed("Duplicate metric within a scope and source");
    metricKeys.add(key);
  }
  const report = value as unknown as AssetJourneyReport;
  return { report, error: null };
}

export interface JourneyReviewRecord {
  note: Note;
  report: AssetJourneyReport | null;
  error: string | null;
}

export function parseJourneyReviewNote(note: Note): JourneyReviewRecord {
  const assetTags = note.tags.filter(tag => tag.startsWith("asset:"));
  if (assetTags.length > 1) return { note, report: null, error: "Conflicting Asset tags" };
  return { note, ...parseAssetJourneyReport(note.content, assetTags[0]?.slice(6)) };
}

export interface JourneyReviewFilters {
  search?: string;
  from?: string;
  to?: string;
  mode?: "latest" | "all";
}

export function selectJourneyReviews(records: JourneyReviewRecord[], filters: JourneyReviewFilters = {}) {
  const search = filters.search?.trim().toLowerCase();
  const filtered = records.filter(record => {
    const savedAt = Date.parse(record.note.created_at);
    const savedDate = Number.isFinite(savedAt) ? new Date(savedAt).toISOString().slice(0, 10) : "";
    if (filters.from && (!savedDate || savedDate < filters.from)) return false;
    if (filters.to && (!savedDate || savedDate > filters.to)) return false;
    return !search || [record.note.title, record.report?.asset_id, record.note.tags.join(" "),
      ...(record.report?.stops.items.map(item => item.reason) ?? []),
      ...(record.report?.manual_recovery.items.map(item => `${item.problem} ${item.action}`) ?? []),
      record.report?.adoption.reason].some(text => text?.toLowerCase().includes(search));
  }).sort((left, right) => (Date.parse(right.note.created_at) || 0) - (Date.parse(left.note.created_at) || 0)
    || right.note.id.localeCompare(left.note.id));
  const seenAssets = new Set<string>();
  return filtered.filter(record => {
    if (!record.report || filters.mode === "all" || !record.report.asset_id) return true;
    if (seenAssets.has(record.report.asset_id)) return false;
    seenAssets.add(record.report.asset_id);
    return true;
  });
}

export function summarizeJourneyReviews(records: JourneyReviewRecord[]) {
  const reports = records.flatMap(record => record.report ? [record.report] : []);
  const adoption = Object.fromEntries(ADOPTION_STATUSES.map(status => [status, 0])) as Record<AdoptionStatus, number>;
  const stops = Object.fromEntries(JOURNEY_STEPS.map(step => [step, 0])) as Record<JourneyStep, number>;
  const recoveries = Object.fromEntries(JOURNEY_STEPS.map(step => [step, 0])) as Record<JourneyStep, number>;
  const reasons = new Map<string, number>();
  const adoptionReasons = new Map<string, number>();
  const metrics = new Map<string, { scope: string; metric: JourneyMetric["metric"]; source: ObservationSource; unit: string; samples: number; average: number }>();
  let unknownMetrics = 0;
  for (const report of reports) {
    adoption[report.adoption.status] += 1;
    for (const step of new Set(report.stops.items.map(item => item.step))) stops[step] += 1;
    for (const step of new Set(report.manual_recovery.items.map(item => item.step))) recoveries[step] += 1;
    for (const reason of new Set(report.stops.items.map(item => item.reason.trim()))) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if ((report.adoption.status === "partial" || report.adoption.status === "no") && report.adoption.reason) {
      const reason = report.adoption.reason.trim();
      adoptionReasons.set(reason, (adoptionReasons.get(reason) ?? 0) + 1);
    }
    for (const metric of report.metrics) {
      if (metric.value === null) {
        unknownMetrics += 1;
        continue;
      }
      const key = JSON.stringify([metric.scope, metric.metric, metric.source, metric.unit]);
      const aggregate = metrics.get(key) ?? { scope: metric.scope, metric: metric.metric, source: metric.source, unit: metric.unit, samples: 0, average: 0 };
      aggregate.samples += 1;
      aggregate.average += (metric.value - aggregate.average) / aggregate.samples;
      metrics.set(key, aggregate);
    }
  }
  const decided = adoption.yes + adoption.partial + adoption.no;
  return {
    reviews: reports.length,
    assets: new Set(reports.map(report => report.asset_id).filter(Boolean)).size,
    excluded: records.length - reports.length,
    blocked: reports.filter(report => report.stops.status === "reported").length,
    stopKnown: reports.filter(report => report.stops.status !== "unknown").length,
    recovered: reports.filter(report => report.manual_recovery.status === "reported").length,
    recoveryKnown: reports.filter(report => report.manual_recovery.status !== "unknown").length,
    adoption,
    decided,
    adoptionRate: decided ? adoption.yes / decided : null,
    stops,
    recoveries,
    reasons: [...reasons.entries()].sort((left, right) => right[1] - left[1]),
    adoptionReasons: [...adoptionReasons.entries()].sort((left, right) => right[1] - left[1]),
    unknownMetrics,
    metrics: [...metrics.values()],
  };
}

type FetchReviewNotes = (params: { tag: string; limit: number; offset: number }) => Promise<NoteList>;

export async function loadAssetJourneyReviewNotes(fetchPage: FetchReviewNotes, maxRecords = 2000) {
  const notes = new Map<string, Note>();
  let offset = 0;
  let total = 0;
  do {
    const page = await fetchPage({ tag: "asset-journey-review", limit: Math.min(200, maxRecords - offset), offset });
    total = Math.max(total, page.total);
    const before = notes.size;
    for (const note of page.items) notes.set(note.id, note);
    offset += page.items.length;
    if (notes.size === before || page.items.length === 0) break;
  } while (offset < total && offset < maxRecords);
  return { notes: [...notes.values()], total, truncated: notes.size < total };
}
