import assert from "node:assert/strict";
import test from "node:test";

import {
  WEREAD_GATEWAY_URL,
  WEREAD_SKILL_VERSION,
  apply,
  requestWeread,
} from "../src/index.js";

test("registers a constrained weread_api tool", () => {
  let definition;
  apply({
    tools: { register: (value) => { definition = value; } },
  });

  assert.equal(definition.name, "weread_api");
  assert.ok(definition.parameters.properties.api_name.enum.includes("/shelf/sync"));
  assert.ok(!definition.parameters.properties.api_name.enum.includes("/shelf/add"));
});

test("calls only the fixed gateway with server-injected credentials and version", async () => {
  let receivedUrl;
  let receivedOptions;
  const result = await requestWeread({
    apiName: "/shelf/sync",
    parameters: { synckey: 0 },
    apiKey: "wrk-secret-value",
    fetchImpl: async (url, options) => {
      receivedUrl = url;
      receivedOptions = options;
      return new Response(JSON.stringify({ books: [] }), { status: 200 });
    },
  });

  assert.equal(receivedUrl, WEREAD_GATEWAY_URL);
  assert.equal(receivedOptions.method, "POST");
  assert.equal(receivedOptions.headers.Authorization, "Bearer wrk-secret-value");
  assert.deepEqual(JSON.parse(receivedOptions.body), {
    api_name: "/shelf/sync",
    synckey: 0,
    skill_version: WEREAD_SKILL_VERSION,
  });
  assert.deepEqual(result, { books: [] });
});

test("rejects endpoints outside the read-only allowlist", async () => {
  await assert.rejects(() => requestWeread({
    apiName: "/shelf/add",
    parameters: {},
    apiKey: "wrk-secret-value",
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /not allowed/);
});

test("rejects attempts to override transport or authentication fields", async () => {
  await assert.rejects(() => requestWeread({
    apiName: "/store/search",
    parameters: { keyword: "三体", headers: { Authorization: "Bearer attacker" } },
    apiKey: "wrk-secret-value",
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /reserved: headers/);
});

test("redacts API keys from upstream errors", async () => {
  await assert.rejects(() => requestWeread({
    apiName: "/store/search",
    parameters: { keyword: "三体" },
    apiKey: "wrk-secret-value",
    fetchImpl: async () => new Response("failure wrk-leaked-value", { status: 500 }),
  }), (error) => {
    assert.match(error.message, /\[REDACTED\]/);
    assert.doesNotMatch(error.message, /wrk-leaked-value/);
    return true;
  });
});

test("reports missing configuration without exposing tool internals", async () => {
  const previous = process.env.WEREAD_API_KEY;
  delete process.env.WEREAD_API_KEY;
  let definition;
  apply({ tools: { register: (value) => { definition = value; } } });
  try {
    await assert.rejects(() => definition.execute({ api_name: "/shelf/sync" }), /set WEREAD_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.WEREAD_API_KEY;
    else process.env.WEREAD_API_KEY = previous;
  }
});
