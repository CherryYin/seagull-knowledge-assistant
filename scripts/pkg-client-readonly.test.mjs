import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../plugins/pkg-client/src/index.js";

test("pkg-client exposes only read-only Agent tools", () => {
  const registrations = [];
  let providedClient;
  const context = {
    provide(name, value) {
      assert.equal(name, "pkg");
      providedClient = value;
    },
    tools: {
      register(tool) {
        registrations.push(tool.name);
      },
    },
  };

  apply(context);

  assert.deepEqual(registrations, [
    "pkg_search",
    "pkg_list_notes",
    "pkg_list_sources",
    "pkg_knowledge_stats",
    "pkg_read_note",
    "pkg_read_source",
    "pkg_search_memory",
  ]);
  assert.equal(providedClient.createNote, undefined);
  assert.equal(providedClient.saveDocument, undefined);
  assert.equal(providedClient.remember, undefined);
});
