import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Asset Evidence proposal tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 3,
    intentRevision: 2,
    proposals: [{
      targetType: "source",
      targetId: "source-1",
      relation: "supports",
      summary: "Supports the capability boundary.",
      fragmentSelector: { type: "text_quote", exact: "Database access is separate." },
    }],
  }));

  assert.equal(definition.name, "propose_asset_evidence");
  assert.deepEqual(result, {
    assetId: "asset-1",
    baseWorkspaceRevision: 3,
    intentRevision: 2,
    proposals: [{
      targetType: "source",
      targetId: "source-1",
      relation: "supports",
      summary: "Supports the capability boundary.",
      fragmentSelector: { type: "text_quote", exact: "Database access is separate." },
    }],
    authorship: "agent",
    requiresUserConfirmation: true,
  });
});
