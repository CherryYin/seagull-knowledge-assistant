import { expect, test } from "@playwright/test";
import { ASSET_JOURNEY_REPORT_TEMPLATE, loadAssetJourneyReviewNotes, parseAssetJourneyReport, parseJourneyReviewNote, selectJourneyReviews, summarizeJourneyReviews, type AssetJourneyReport } from "../src/lib/asset-journey-stats";
import type { Note } from "../src/lib/api/notes";

function content(report: unknown) {
  return `## Review Context\n\nA review.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function reviewNote(id: string, report: AssetJourneyReport | null, createdAt = "2026-10-12T00:00:00Z"): Note {
  return {
    id, title: id, category_id: 1, note_type: "inbox", domains: ["review"],
    tags: ["asset-journey-review", ...(report?.asset_id ? [`asset:${report.asset_id}`] : [])],
    status: "kept", confidence: "medium", source_ids: [],
    content: report ? content(report) : "An old narrative review: adopted, with 50 tokens.",
    created_at: createdAt, updated_at: createdAt,
  };
}

function report(overrides: Partial<AssetJourneyReport> = {}): AssetJourneyReport {
  return { ...ASSET_JOURNEY_REPORT_TEMPLATE, asset_id: "asset-a", ...overrides };
}

test("journey statistics accept versioned summaries, preserve true zero, and never infer legacy prose", () => {
  const summary = report({ metrics: [
    { scope: "journey", metric: "wait_seconds", value: 0, unit: "seconds", source: "system_record" },
    { scope: "journey", metric: "retry_count", value: null, unit: "count", source: "unknown" },
  ] });
  expect(parseAssetJourneyReport(content(summary)).report).toEqual(summary);
  expect(parseAssetJourneyReport(content(summary).replaceAll("\n", "\r\n")).report).toEqual(summary);
  const result = summarizeJourneyReviews([parseJourneyReviewNote(reviewNote("new", summary)), parseJourneyReviewNote(reviewNote("old", null))]);
  expect(result.reviews).toBe(1);
  expect(result.excluded).toBe(1);
  expect(result.metrics[0].average).toBe(0);
  expect(result.unknownMetrics).toBe(1);
  expect(result.adoptionRate).toBeNull();
});

test("journey statistics reject malformed sources, identities, numbers, units and duplicate measurements", () => {
  const metric = { scope: "journey", metric: "retry_count", value: 1, unit: "count", source: "system_record" };
  const invalid = [
    { ...report(), schema_version: 2 },
    { ...report(), stops: { status: "none", source: "unknown", items: [] } },
    { ...report(), stops: { status: { toString: null }, source: "user_report", items: [] } },
    { ...report(), adoption: { status: "yes", source: "system_record", reason: null } },
    { ...report(), metrics: [{ ...metric, value: -1 }] },
    { ...report(), metrics: [{ ...metric, value: 1.5 }] },
    { ...report(), metrics: [{ ...metric, value: null }] },
    { ...report(), metrics: [{ ...metric, source: "unknown" }] },
    { ...report(), metrics: [{ ...metric, unit: "seconds" }] },
    { ...report(), metrics: [{ ...metric, metric: { toString: null } }] },
    { ...report(), metrics: [metric, metric] },
  ];
  for (const value of invalid) expect(parseAssetJourneyReport(content(value)).report).toBeNull();
  expect(parseAssetJourneyReport(content(report()), "asset-other").report).toBeNull();
  expect(parseAssetJourneyReport(`${content(report())}\n${content(report())}`).report).toBeNull();
  expect(parseAssetJourneyReport('```json\n{"kind":"asset_journey_review","schema_version":1,\n```').report).toBeNull();
});

test("journey statistics use latest valid reviews within filters without allowing invalid notes to hide them", () => {
  const records = [
    reviewNote("old", report({ adoption: { status: "no", reason: "Too long", source: "user_report" } }), "2026-10-09T00:00:00Z"),
    reviewNote("new", report({ adoption: { status: "yes", reason: "Published", source: "user_report" } })),
    { ...reviewNote("invalid", null, "2026-10-13T00:00:00Z"), tags: ["asset-journey-review", "asset:asset-a"] },
    reviewNote("unlinked-a", report({ asset_id: null })),
    reviewNote("unlinked-b", report({ asset_id: null })),
  ].map(parseJourneyReviewNote);
  const latest = selectJourneyReviews(records);
  expect(latest.map(record => record.note.id)).not.toContain("old");
  expect(latest).toHaveLength(4);
  expect(summarizeJourneyReviews(latest).adoptionRate).toBe(1);
  expect(selectJourneyReviews(records, { mode: "all" })).toHaveLength(5);
  expect(selectJourneyReviews(records, { to: "2026-10-09" }).map(record => record.note.id)).toEqual(["old"]);
  expect(selectJourneyReviews(records, { search: "Too long" }).map(record => record.note.id)).toEqual(["old"]);
});

test("journey statistics count per-step reviews once and keep estimates and scopes separate", () => {
  const records = [reviewNote("first", report({
    stops: { status: "reported", source: "user_report", items: [
      { step: "visuals", reason: "Timeout" }, { step: "visuals", reason: "Timeout" },
    ] },
    adoption: { status: "yes", reason: null, source: "user_report" },
    metrics: [{ scope: "journey", metric: "wait_seconds", value: 10, unit: "seconds", source: "system_record" }],
  })), reviewNote("second", report({
    asset_id: "asset-b", adoption: { status: "partial", reason: "Edited extensively", source: "user_report" },
    metrics: [
      { scope: "journey", metric: "wait_seconds", value: 100, unit: "seconds", source: "user_estimate" },
      { scope: "visual:image-1", metric: "visual_elapsed_seconds", value: 90, unit: "seconds", source: "system_record" },
    ],
  })), reviewNote("unknown", report({ asset_id: "asset-c" }))].map(parseJourneyReviewNote);
  const result = summarizeJourneyReviews(records);
  expect(result.stops.visuals).toBe(1);
  expect(result.reasons).toEqual([["Timeout", 1]]);
  expect(result.stopKnown).toBe(1);
  expect(result.adoptionRate).toBe(0.5);
  expect(result.decided).toBe(2);
  expect(result.adoptionReasons).toEqual([["Edited extensively", 1]]);
  expect(result.metrics.map(metric => metric.average)).toEqual([10, 100, 90]);
});

test("journey metric averages remain finite for large valid measurements", () => {
  const records = ["first", "second"].map(id => parseJourneyReviewNote(reviewNote(id, report({
    metrics: [{ scope: "journey", metric: "wait_seconds", value: 1e308, unit: "seconds", source: "system_record" }],
  }))));
  expect(summarizeJourneyReviews(records).metrics[0].average).toBe(1e308);
});

test("journey review loading paginates, bounds the sample, and detects incomplete or repeated pages", async () => {
  const notes = Array.from({ length: 201 }, (_, index) => reviewNote(`note-${index}`, report()));
  const requests: number[] = [];
  const loaded = await loadAssetJourneyReviewNotes(async params => {
    expect(params.tag).toBe("asset-journey-review");
    requests.push(params.offset);
    return { items: notes.slice(params.offset, params.offset + params.limit), total: notes.length };
  });
  expect(requests).toEqual([0, 200]);
  expect(loaded.notes).toHaveLength(201);
  expect(loaded.truncated).toBe(false);
  const bounded = await loadAssetJourneyReviewNotes(async params => ({ items: notes.slice(params.offset, params.offset + params.limit), total: 201 }), 20);
  expect(bounded.notes).toHaveLength(20);
  expect(bounded.truncated).toBe(true);
  const repeated = await loadAssetJourneyReviewNotes(async () => ({ items: notes.slice(0, 1), total: 2 }));
  expect(repeated.notes).toHaveLength(1);
  expect(repeated.truncated).toBe(true);
  const empty = await loadAssetJourneyReviewNotes(async () => ({ items: [], total: 0 }));
  expect(empty.truncated).toBe(false);
});
