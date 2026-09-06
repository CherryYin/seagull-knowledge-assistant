import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Asset Block proposal tool", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_block_patch");

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    blockId: "block-1",
    baseRevision: 3,
    replacementMarkdown: "Revised paragraph.",
    explanation: "Make it clearer.",
    claimRefs: ["claim-1", "claim-1", 2],
    addedReferences: { sourceRefs: ["source-1", 2], webUrls: ["https://example.com"] },
  }));

  assert.equal(definition.name, "propose_asset_block_patch");
  assert.deepEqual(result, {
    assetId: "asset-1",
    blockId: "block-1",
    baseRevision: 3,
    replacementMarkdown: "Revised paragraph.",
    explanation: "Make it clearer.",
    claimRefs: ["claim-1"],
    addedReferences: {
      sourceRefs: ["source-1"],
      noteRefs: [],
      wikiRefs: [],
      webUrls: ["https://example.com"],
    },
    requiresUserConfirmation: true,
  });
});

test("registers a non-writing full Asset proposal tool", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_document_patch");

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    replacementTitle: "  Better title  ",
    replacementBrief: "  Clearer brief.  ",
    explanation: "Improve the whole narrative.",
    blocks: [{
      blockId: "block-1",
      baseRevision: 3,
      replacementMarkdown: "Revised paragraph.",
      claimRefs: ["claim-1", "claim-1", 2],
    }],
  }));

  assert.deepEqual(result, {
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    replacementTitle: "Better title",
    replacementBrief: "Clearer brief.",
    explanation: "Improve the whole narrative.",
    blocks: [{
      blockId: "block-1",
      baseRevision: 3,
      replacementMarkdown: "Revised paragraph.",
      claimRefs: ["claim-1"],
    }],
    requiresUserConfirmation: true,
    writesAsset: false,
  });
});

test("allows a title-only full Asset proposal", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_document_patch");
  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    replacementTitle: "Better title",
    replacementBrief: "Clearer brief.",
    blocks: [],
  }));
  assert.deepEqual(result.blocks, []);
});
