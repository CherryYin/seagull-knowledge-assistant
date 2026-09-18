import assert from "node:assert/strict";
import test from "node:test";

import { apply, normalizeSourceMindMapProposal, SOURCE_MIND_MAP_INPUT_LIMITS } from "../src/index.js";

function validArguments() {
  return {
    source_id: "source-1",
    basis_revision: {
      source_content_hash: "hash-1",
      chunk_count: 97,
      chunk_revision: 3,
    },
    proposal: {
      title: "Distributed systems overview",
      layout_mode: "balanced",
      nodes: [
        { temp_id: "root", parent_temp_id: null, position: 0, content: "Distributed systems", note: null, node_kind: "topic" },
        { temp_id: "claim-1", parent_temp_id: "root", position: 0, content: "Coordination requires failure handling", note: null, node_kind: "claim" },
      ],
      references: [{ node_temp_id: "claim-1", chunk_id: 11, relation: "supports", fragment_selector: { page: 8, quote: "explicit failure handling" } }],
    },
  };
}

test("registers a non-writing bounded Source Mind Map proposal tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute(validArguments()));

  assert.equal(definition.name, "propose_source_mind_map");
  assert.equal(definition.parameters.properties.proposal.properties.nodes.maxItems, 32);
  assert.deepEqual(
    definition.parameters.properties.proposal.properties.nodes.items.required,
    ["temp_id", "parent_temp_id", "position", "content", "node_kind"],
  );
  assert.equal(
    definition.parameters.properties.proposal.properties.nodes.items.properties.node_kind.enum.includes("claim"),
    true,
  );
  assert.equal(definition.parameters.required.includes("input_summary"), false);
  assert.equal(result.source_id, "source-1");
  assert.equal(result.proposal.nodes.length, 2);
  assert.equal(result.proposal.references[0].chunk_id, 11);
  assert.equal(result.authorship, "agent");
  assert.equal(result.requiresUserConfirmation, true);
});

test("accepts proposals without echoing the bounded input summary", () => {
  const result = normalizeSourceMindMapProposal(validArguments());

  assert.equal(result.proposal.references[0].chunk_id, 11);
  assert.equal(result.proposal.references[0].fragment_selector.quote, "explicit failure handling");
});

test("preserves a complete selected-branch expansion target", () => {
  const args = validArguments();
  args.map_id = "map-1";
  args.base_version = 3;
  args.target_node_id = "node-2";

  const result = normalizeSourceMindMapProposal(args);

  assert.equal(result.map_id, "map-1");
  assert.equal(result.base_version, 3);
  assert.equal(result.target_node_id, "node-2");
});

test("validates an optional bounded input summary when supplied", () => {
  const rawContent = validArguments();
  rawContent.input_summary = {
    section_summaries: [{ title: "Coordination", summary: "Coordination and failure handling.", chunk_ids: [11] }],
    chunk_summaries: [{ chunk_id: 11, chunk_index: 10, page: 8, summary: "The paper requires explicit failure handling." }],
  };
  rawContent.input_summary.raw_content = "entire PDF";
  assert.throws(() => normalizeSourceMindMapProposal(rawContent), /cannot contain raw PDF fields: raw_content/);

  const foreignReference = validArguments();
  foreignReference.input_summary = {
    section_summaries: [{ title: "Coordination", summary: "Coordination and failure handling.", chunk_ids: [11] }],
    chunk_summaries: [{ chunk_id: 11, chunk_index: 10, page: 8, summary: "The paper requires explicit failure handling." }],
  };
  foreignReference.proposal.references[0].chunk_id = 12;
  assert.throws(() => normalizeSourceMindMapProposal(foreignReference), /not present in input_summary/);

  const inventedQuote = validArguments();
  inventedQuote.input_summary = {
    section_summaries: [{ title: "Coordination", summary: "Coordination and failure handling.", chunk_ids: [11] }],
    chunk_summaries: [{ chunk_id: 11, chunk_index: 10, page: 8, summary: "The paper requires explicit failure handling." }],
  };
  inventedQuote.proposal.references[0].fragment_selector.quote = "invented sentence";
  assert.throws(() => normalizeSourceMindMapProposal(inventedQuote), /not present in the supplied Chunk summary/);
});

test("rejects unreferenced factual nodes and oversized proposals", () => {
  const unreferenced = validArguments();
  unreferenced.proposal.references = [];
  assert.throws(() => normalizeSourceMindMapProposal(unreferenced), /factual proposal nodes require chunk references/);

  const oversized = validArguments();
  oversized.proposal.nodes = Array.from({ length: SOURCE_MIND_MAP_INPUT_LIMITS.maxNodes + 1 }, (_, index) => ({
    temp_id: index === 0 ? "root" : `node-${index}`,
    parent_temp_id: index === 0 ? null : "root",
    position: index === 0 ? 0 : index - 1,
    content: `Node ${index}`,
    note: null,
    node_kind: index === 0 ? "topic" : "concept",
  }));
  oversized.proposal.references = [];
  assert.throws(() => normalizeSourceMindMapProposal(oversized), /between 1 and 32 items/);
});
