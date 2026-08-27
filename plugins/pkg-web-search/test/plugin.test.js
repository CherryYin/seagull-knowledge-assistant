import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.js";

test("registers a session-scoped read-only web_search tool", async () => {
  let definition;
  let received;
  const ctx = {
    pkg: {
      webSearch: async (...args) => {
        received = args;
        return [{ title: "Result", url: "https://example.com", summary: "Evidence" }];
      },
    },
    tools: { register: (value) => { definition = value; } },
  };

  apply(ctx);
  const result = await definition.execute(
    { query: "fresh evidence", max_results: 5 },
    { agent: { session: { id: "session-1" } } },
  );

  assert.equal(definition.name, "web_search");
  assert.deepEqual(received, ["session-1", "fresh evidence", 5]);
  assert.deepEqual(JSON.parse(result), [{ title: "Result", url: "https://example.com", summary: "Evidence" }]);
});

test("requires a Harness session for PKG authentication", async () => {
  let definition;
  apply({
    pkg: { webSearch: async () => [] },
    tools: { register: (value) => { definition = value; } },
  });
  await assert.rejects(() => definition.execute({ query: "topic" }, {}), /active Harness session/);
});
