import assert from "node:assert/strict";
import test from "node:test";

import { apply, resolveHarnessServiceToken } from "../plugins/pkg-client/src/index.js";

test("pkg-client rejects the loopback token for a remote Gateway", () => {
  assert.equal(resolveHarnessServiceToken("http://127.0.0.1:4000/internal/pkg"), "seagull-loopback-harness");
  assert.throws(
    () => resolveHarnessServiceToken("https://gateway.example.test/internal/pkg"),
    /explicit random value of at least 32 characters/,
  );
  assert.throws(
    () => resolveHarnessServiceToken("https://gateway.example.test/internal/pkg", "seagull-loopback-harness"),
    /explicit random value of at least 32 characters/,
  );
  assert.equal(
    resolveHarnessServiceToken("https://gateway.example.test/internal/pkg", "0123456789abcdef0123456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
});

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
  ]);
  assert.equal(providedClient.createNote, undefined);
  assert.equal(providedClient.saveDocument, undefined);
  assert.equal(providedClient.remember, undefined);
});
