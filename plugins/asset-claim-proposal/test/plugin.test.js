import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Candidate Claim tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute({
    assetId: "asset-1",
    baseWorkspaceRevision: 4,
    intentRevision: 1,
    proposals: [{
      content: "Capability-scoped tools are safer than arbitrary SQL access.",
      kind: "recommendation",
      supportingEvidence: ["evidence-1"],
      contradictingEvidence: ["evidence-2"],
      agentConfidence: "medium",
    }],
  }));

  assert.equal(definition.name, "propose_asset_claims");
  assert.deepEqual(result, {
    assetId: "asset-1",
    baseWorkspaceRevision: 4,
    intentRevision: 1,
    proposals: [{
      content: "Capability-scoped tools are safer than arbitrary SQL access.",
      kind: "recommendation",
      supportingEvidence: ["evidence-1"],
      contradictingEvidence: ["evidence-2"],
      agentConfidence: "medium",
    }],
    authorship: "agent",
    requiresClaimGate: true,
  });
});
