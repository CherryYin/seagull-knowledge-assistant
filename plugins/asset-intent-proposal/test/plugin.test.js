import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a non-writing Asset Intent proposal tool", async () => {
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });

  const result = JSON.parse(await definition.execute({
    workingTitle: "Agent database access",
    question: "What database access should Agents receive?",
    goal: "Define a safe capability model.",
    audience: "System designers",
    creationMode: "make_decision",
    scope: ["PostgreSQL", "Harness"],
    constraints: ["Do not expose credentials"],
    rationale: "The decision requires an explicit capability boundary.",
  }));

  assert.equal(definition.name, "propose_asset_intent");
  assert.equal(result.authorship, "agent");
  assert.equal(result.requiresUserConfirmation, true);
  assert.equal(result.writesAsset, false);
  assert.equal(result.creationMode, "make_decision");
});
