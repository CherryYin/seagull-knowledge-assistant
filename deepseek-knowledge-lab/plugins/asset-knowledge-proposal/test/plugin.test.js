import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Asset Knowledge proposal tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 5,
    contribution: {
      kind: "decision",
      summary: "The Asset adds a capability boundary decision.",
      claimRefs: ["claim-1"],
    },
    candidates: [{
      candidateType: "wiki",
      action: "create",
      title: "Agent database boundaries",
      content: "Use capability-scoped tools for database access.",
      claimRefs: ["claim-1"],
    }],
  }));

  assert.equal(definition.name, "propose_asset_knowledge");
  assert.equal(result.authorship, "agent");
  assert.equal(result.requiresContributionGate, true);
  assert.equal(result.requiresKnowledgePromotionGate, true);
  assert.equal(result.writesLongTermKnowledge, false);
  assert.equal(result.contribution.kind, "decision");
  assert.equal(result.candidates[0].candidateType, "wiki");
});
