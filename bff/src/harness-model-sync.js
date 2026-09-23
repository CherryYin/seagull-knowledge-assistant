const DEFAULT_TIMEOUT_MS = 15_000;

function normalizedModelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isDatedSnapshot(modelId) {
  return /-(?:20\d{2}(?:-\d{2}){0,2}|\d{4})$/i.test(modelId);
}

export function isSupportedQwenModel(modelId) {
  const id = normalizedModelId(modelId);
  if (!/^(?:qwen|qwq)/i.test(id)) return false;
  if (/^qwen(?:1(?:\.|-|$)|2(?:\.|-|$))/i.test(id)) return false;
  if (/(?:audio|asr|image|tts|(?:^|-)vl(?:-|$)|omni|realtime|livetranslate|s2s|ocr|embedding|rerank|(?:^|-)mt-|deep-research|deep-search|gui)/i.test(id)) return false;
  return !isDatedSnapshot(id);
}

export function isSupportedMiniMaxModel(modelId) {
  return /^MiniMax-M\d+(?:\.\d+)?(?:-highspeed)?$/i.test(normalizedModelId(modelId));
}

export function mergeDiscoveredModels(currentModels, discoveredIds) {
  const byId = new Map();
  for (const model of currentModels || []) {
    const id = normalizedModelId(model?.id);
    if (id) byId.set(id, { ...model, id, name: model.name || id });
  }
  for (const value of discoveredIds || []) {
    const id = normalizedModelId(value);
    if (id && !byId.has(id)) byId.set(id, { id, name: id });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverOpenAiModels({
  baseUrl,
  apiKey,
  accepts,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const payload = await response.json();
    const ids = (Array.isArray(payload?.data) ? payload.data : [])
      .map((item) => normalizedModelId(item?.id))
      .filter((id) => id && accepts(id));
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  } finally {
    clearTimeout(timeout);
  }
}

function sameModels(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function syncHarnessModels({ harnessRpc, providers, fetchImpl = fetch }) {
  const description = await harnessRpc("settings.describe", {});
  const section = (description.namespaces || []).find((item) => item.ns === "llm-pi-ai");
  if (!section) throw new Error("Harness llm-pi-ai settings are unavailable");

  const configuredProviders = section.value?.providers || {};
  const operations = [];
  const results = [];
  for (const provider of providers) {
    if (!provider.apiKey) {
      results.push({ provider: provider.id, status: "skipped", reason: "missing_api_key", added: 0 });
      continue;
    }
    const configured = configuredProviders[provider.id];
    if (!configured) {
      results.push({ provider: provider.id, status: "skipped", reason: "provider_not_configured", added: 0 });
      continue;
    }
    try {
      const discovered = await discoverOpenAiModels({
        baseUrl: provider.baseUrl || configured.baseURL,
        apiKey: provider.apiKey,
        accepts: provider.accepts,
        fetchImpl,
      });
      const current = Array.isArray(configured.models) ? configured.models : [];
      const merged = mergeDiscoveredModels(current, discovered);
      const added = merged.length - current.length;
      if (!sameModels(current, merged)) {
        operations.push({
          op: "set",
          path: ["providers", provider.id, "models"],
          value: merged,
        });
      }
      results.push({ provider: provider.id, status: "completed", discovered: discovered.length, added });
    } catch (error) {
      results.push({ provider: provider.id, status: "failed", error: error.message, added: 0 });
    }
  }

  if (operations.length > 0) {
    await harnessRpc("settings.mutate", {
      ns: "llm-pi-ai",
      ops: operations,
      expectedRevision: section.revision,
    });
  }
  return { updated: operations.length > 0, providers: results };
}

export function startHarnessModelSyncLoop({ run, initialDelayMs, intervalMs, retryDelayMs, logger = console }) {
  let stopped = false;
  let timer;
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      try {
        const result = await run();
        logger.log(`[BFF] Harness model sync completed: ${JSON.stringify(result)}`);
        if (!stopped) schedule(intervalMs);
      } catch (error) {
        logger.error(`[BFF] Harness model sync failed: ${error.message}`);
        if (!stopped) schedule(retryDelayMs);
      }
    }, delay);
    timer.unref?.();
  };
  schedule(initialDelayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
