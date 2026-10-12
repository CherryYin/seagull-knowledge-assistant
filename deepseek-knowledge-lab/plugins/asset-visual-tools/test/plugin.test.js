import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

function setup() {
  const definitions = [];
  const calls = [];
  const pkg = {
    planAssetVisual: async (...args) => { calls.push(["plan", ...args]); return { planner_mode: "fallback" }; },
    generateAssetVisualCandidates: async (...args) => { calls.push(["generate", ...args]); return { items: [{ id: "visual-1" }] }; },
    listAssetVisuals: async (...args) => { calls.push(["list", ...args]); return { items: [] }; },
  };
  apply({ pkg, tools: { register: (definition) => definitions.push(definition) } });
  return { definitions, calls };
}

const exec = { agent: { session: { id: "session-1" } } };

test("registers only plan, generate, and list visual tools", () => {
  const { definitions } = setup();
  assert.deepEqual(definitions.map((item) => item.name), [
    "pkg_plan_asset_visual",
    "pkg_generate_asset_visual_candidates",
    "pkg_list_asset_visuals",
  ]);
  assert.equal(definitions.some((item) => /accept|delete|cancel/.test(item.name)), false);
});

test("plans an inline illustration with fixed role size and Block context", async () => {
  const { definitions, calls } = setup();
  const tool = definitions.find((item) => item.name === "pkg_plan_asset_visual");
  await tool.execute({
    asset_id: "asset-1",
    role: "inline_illustration",
    source_block_ids: ["block-1", "block-1"],
    parent_visual_id: "visual-cover",
    style_preset: "research_brief",
  }, exec);

  assert.deepEqual(calls[0], ["plan", "session-1", "asset-1", {
    role: "inline_illustration",
    size: "1280*720",
    parent_visual_id: "visual-cover",
    source_block_ids: ["block-1"],
    style_preset: "research_brief",
    instructions: null,
  }]);
});

test("queues bounded candidates without review mutation tools", async () => {
  const { definitions, calls } = setup();
  const tool = definitions.find((item) => item.name === "pkg_generate_asset_visual_candidates");
  const brief = {
    concept: "Layered agents",
    composition: "Editorial landscape",
    style: "Research brief",
    palette: ["#112233"],
    must_include: ["clear focal point"],
    must_avoid: ["text"],
    title_safe_area: "none",
    prompt: "Create an abstract editorial illustration without text.",
    alt_text: "Abstract agent infrastructure illustration.",
  };
  const result = JSON.parse(await tool.execute({
    asset_id: "asset-1",
    role: "social_square",
    parent_visual_id: "visual-cover",
    style_preset: "research_brief",
    candidate_count: 2,
    brief,
  }, exec));

  assert.equal(result.items[0].id, "visual-1");
  assert.deepEqual(calls[0][3], {
    role: "social_square",
    size: "1024*1024",
    parent_visual_id: "visual-cover",
    source_block_ids: [],
    style_preset: "research_brief",
    candidate_count: 2,
    style_memory: null,
    brief,
  });
});

test("rejects inline generation without a Block and missing session context", async () => {
  const { definitions } = setup();
  const plan = definitions.find((item) => item.name === "pkg_plan_asset_visual");
  await assert.rejects(
    () => plan.execute({ asset_id: "asset-1", role: "inline_illustration" }, exec),
    /source_block_id/,
  );
  await assert.rejects(
    () => plan.execute({ asset_id: "asset-1" }, {}),
    /active Harness session/,
  );
});
