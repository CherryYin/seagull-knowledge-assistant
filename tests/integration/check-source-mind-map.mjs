import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function source(path) {
  return readFile(resolve(workspaceRoot, path), "utf8");
}

function includesAll(value, path, markers) {
  for (const marker of markers) {
    assert.ok(value.includes(marker), `${path} is missing Source Mind Map marker: ${marker}`);
  }
}

const files = {
  plugin: "deepseek-knowledge-lab/plugins/source-mind-map-proposal/src/index.js",
  preset: "deepseek-knowledge-lab/.dsh/.agent-presets/generate-source-mind-map/agent.cordis.yml",
  skill: "deepseek-knowledge-lab/.dsh/.agent-presets/generate-source-mind-map/skills/generate-source-mind-map.md",
  webProfile: "deepseek-knowledge-lab/.dsh/profiles/web/cordis.patch.yml",
  headlessProfile: "deepseek-knowledge-lab/.dsh/profiles/headless/cordis.patch.yml",
  pkgSchema: "personal_knowledge_graph/src/pkg/schemas/application/mind_map.py",
  pkgApi: "personal_knowledge_graph/src/pkg/api/mind_maps.py",
  pkgService: "personal_knowledge_graph/src/pkg/services/application/mind_maps.py",
  sourcePanel: "seagull-ui/src/components/mind-map/SourceMindMapPanel.tsx",
};

const values = Object.fromEntries(await Promise.all(
  Object.entries(files).map(async ([key, path]) => [key, await source(path)]),
));

includesAll(values.plugin, files.plugin, [
  'name: "propose_source_mind_map"',
  "maxNodes: 32",
  "maxSectionSummaries: 40",
  "maxChunkSummaries: 80",
  "raw_content",
  'required: ["source_id", "basis_revision", "proposal"]',
  "requiresUserConfirmation: true",
]);
includesAll(values.preset, files.preset, [
  "generate-source-mind-map",
  "propose_source_mind_map",
  "不得要求或复述整篇 PDF 原文",
  "硬上限 32 个",
]);
includesAll(values.skill, files.skill, [
  "At most 40 `section_summaries`",
  "Between 1 and 80 `chunk_summaries`",
  "Reference only Chunk IDs present",
  "Do not echo `input_summary`",
  "call `propose_source_mind_map` exactly once",
  "No direct PKG write and no automatic Apply",
]);
for (const key of ["webProfile", "headlessProfile"]) {
  includesAll(values[key], files[key], [
    "id: source-mind-map-proposal",
    "plugins/source-mind-map-proposal/src/index.js",
  ]);
}
includesAll(values.pkgSchema, files.pkgSchema, [
  "class SourceMindMapProposal",
  "SOURCE_MIND_MAP_PROPOSAL_MAX_NODES = 80",
  "factual proposal nodes require source chunk references",
]);
includesAll(values.pkgApi, files.pkgApi, [
  '"/proposals/source/context"',
  '"/proposals/source/validate"',
  '"/proposals/source/apply"',
  "apply_source_mind_map_proposal",
  "build_source_mind_map_generation_context",
  "validate_source_mind_map_proposal",
]);
includesAll(values.pkgService, files.pkgService, [
  "SOURCE_CONTEXT_MAX_CHUNKS = 80",
  "build_source_mind_map_generation_context",
  "SourceMindMapGenerationContextRead",
]);
includesAll(values.sourcePanel, files.sourcePanel, [
  'preset: "generate-source-mind-map"',
  "ephemeralSession: true",
  'event.tool === "propose_source_mind_map"',
  "validateSourceProposal",
  "applySourceProposal",
  "Apply Proposal to Mind Map",
  "source-mind-map-proposal-preview",
]);

console.log(JSON.stringify({ ok: true, checked: Object.keys(files).length }));
