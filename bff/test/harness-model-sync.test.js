import assert from "node:assert/strict";
import test from "node:test";

import {
  isSupportedMiniMaxModel,
  isSupportedQwenModel,
  mergeDiscoveredModels,
  syncHarnessModels,
} from "../src/harness-model-sync.js";

test("provider filters keep chat models and reject incompatible modalities", () => {
  assert.equal(isSupportedQwenModel("qwen3.8-max"), true);
  assert.equal(isSupportedQwenModel("qwen3-coder-plus"), true);
  assert.equal(isSupportedQwenModel("qwen3.8-max-0902"), false);
  assert.equal(isSupportedQwenModel("qwen3.7-text-embedding"), false);
  assert.equal(isSupportedQwenModel("qwen3-vl-plus"), false);
  assert.equal(isSupportedQwenModel("qwen2.5-7b-instruct"), false);
  assert.equal(isSupportedMiniMaxModel("MiniMax-M3"), true);
  assert.equal(isSupportedMiniMaxModel("MiniMax-M2.7-highspeed"), true);
  assert.equal(isSupportedMiniMaxModel("speech-02-hd"), false);
});

test("model merge preserves configured metadata and only appends new IDs", () => {
  assert.deepEqual(
    mergeDiscoveredModels(
      [{ id: "qwen-plus", name: "Qwen Plus", reasoning: true }],
      ["qwen-plus", "qwen3.8-max"],
    ),
    [
      { id: "qwen-plus", name: "Qwen Plus", reasoning: true },
      { id: "qwen3.8-max", name: "qwen3.8-max" },
    ],
  );
});

test("sync appends discovered models through Harness settings mutate", async () => {
  const calls = [];
  const harnessRpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "settings.describe") {
      return {
        namespaces: [{
          ns: "llm-pi-ai",
          revision: 7,
          value: {
            providers: {
              qwen: { baseURL: "https://qwen.test/v1", models: [{ id: "qwen-plus", name: "Qwen Plus" }] },
              minimax: { baseURL: "https://minimax.test/v1", models: [{ id: "MiniMax-M3", name: "MiniMax M3" }] },
            },
          },
        }],
      };
    }
    if (method === "settings.mutate") return {};
    throw new Error(`unexpected method ${method}`);
  };
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return url.includes("qwen")
        ? { data: [{ id: "qwen-plus" }, { id: "qwen3.8-max" }, { id: "qwen-image-3.0" }] }
        : { data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M2.7" }, { id: "speech-02-hd" }] };
    },
  });

  const result = await syncHarnessModels({
    harnessRpc,
    fetchImpl,
    providers: [
      { id: "qwen", apiKey: "qwen-key", accepts: isSupportedQwenModel },
      { id: "minimax", apiKey: "minimax-key", accepts: isSupportedMiniMaxModel },
    ],
  });

  assert.equal(result.updated, true);
  assert.deepEqual(result.providers.map((item) => [item.provider, item.added]), [["qwen", 1], ["minimax", 1]]);
  assert.deepEqual(calls.at(-1), {
    method: "settings.mutate",
    payload: {
      ns: "llm-pi-ai",
      expectedRevision: 7,
      ops: [
        {
          op: "set",
          path: ["providers", "qwen", "models"],
          value: [
            { id: "qwen-plus", name: "Qwen Plus" },
            { id: "qwen3.8-max", name: "qwen3.8-max" },
          ],
        },
        {
          op: "set",
          path: ["providers", "minimax", "models"],
          value: [
            { id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
            { id: "MiniMax-M3", name: "MiniMax M3" },
          ],
        },
      ],
    },
  });
});

test("sync keeps updating a healthy provider when another provider fails", async () => {
  const calls = [];
  const harnessRpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "settings.describe") {
      return {
        namespaces: [{
          ns: "llm-pi-ai",
          revision: 2,
          value: {
            providers: {
              qwen: { baseURL: "https://qwen.test/v1", models: [{ id: "qwen-plus", name: "Qwen Plus" }] },
              minimax: { baseURL: "https://minimax.test/v1", models: [{ id: "MiniMax-M3", name: "MiniMax M3" }] },
            },
          },
        }],
      };
    }
    return {};
  };
  const fetchImpl = async (url) => {
    if (url.includes("qwen")) throw new Error("Qwen unavailable");
    return { ok: true, async json() { return { data: [{ id: "MiniMax-M2.7" }] }; } };
  };

  const result = await syncHarnessModels({
    harnessRpc,
    fetchImpl,
    providers: [
      { id: "qwen", apiKey: "qwen-key", accepts: isSupportedQwenModel },
      { id: "minimax", apiKey: "minimax-key", accepts: isSupportedMiniMaxModel },
    ],
  });

  assert.deepEqual(result.providers.map((item) => item.status), ["failed", "completed"]);
  assert.deepEqual(calls.at(-1).payload.ops.map((operation) => operation.path[1]), ["minimax"]);
});
