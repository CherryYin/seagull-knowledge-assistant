import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Asset Block proposal tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    blockId: "block-1",
    baseRevision: 3,
    replacementMarkdown: "Revised paragraph.",
    explanation: "Make it clearer.",
    addedReferences: { sourceRefs: ["source-1", 2], webUrls: ["https://example.com"] },
  }));

  assert.equal(definition.name, "propose_asset_block_patch");
  assert.deepEqual(result, {
    assetId: "asset-1",
    blockId: "block-1",
    baseRevision: 3,
    replacementMarkdown: "Revised paragraph.",
    explanation: "Make it clearer.",
    addedReferences: {
      sourceRefs: ["source-1"],
      noteRefs: [],
      wikiRefs: [],
      webUrls: ["https://example.com"],
    },
    requiresUserConfirmation: true,
  });
});
