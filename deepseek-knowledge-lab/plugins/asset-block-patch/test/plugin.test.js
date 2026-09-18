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

test("normalizes document blocks supplied as a JSON string", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_document_patch");
  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    replacementTitle: "Better title",
    replacementBrief: "Clearer brief.",
    blocks: JSON.stringify([{
      blockId: "block-1",
      baseRevision: 3,
      replacementMarkdown: "Revised paragraph.",
      claimRefs: ["claim-1"],
    }]),
  }));

  assert.deepEqual(result.blocks, [{
    blockId: "block-1",
    baseRevision: 3,
    replacementMarkdown: "Revised paragraph.",
    claimRefs: ["claim-1"],
  }]);
});

test("returns a complete replacement document without preserving old Block IDs", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_document_patch");
  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    rewriteMode: "replace_document",
    baseDocumentSignature: "document-abc",
    replacementTitle: "Rewritten title",
    replacementBrief: "Rewritten brief.",
    blocks: [],
    replacementBlocks: JSON.stringify([
      { markdown: "# Rewritten title", claimRefs: [] },
      { markdown: "A coherent replacement paragraph.", claimRefs: ["claim-1"] },
    ]),
  }));

  assert.deepEqual(result.replacementBlocks, [
    { markdown: "# Rewritten title", claimRefs: [] },
    { markdown: "A coherent replacement paragraph.", claimRefs: ["claim-1"] },
  ]);
  assert.equal(result.rewriteMode, "replace_document");
  assert.equal(result.baseDocumentSignature, "document-abc");
});

test("rejects an empty complete replacement document", async () => {
  const definitions = [];
  apply({ tools: { register: (value) => { definitions.push(value); } } });
  const definition = definitions.find((item) => item.name === "propose_asset_document_patch");

  await assert.rejects(() => definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 8,
    rewriteMode: "replace_document",
    baseDocumentSignature: "document-abc",
    replacementTitle: "Rewritten title",
    replacementBrief: "Rewritten brief.",
    blocks: [],
    replacementBlocks: [],
  }), /requires at least one valid replacement Block/);
});
