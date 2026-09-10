const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help")) {
  console.log("Usage: npm run smoke:large-pdf-mind-map -- --source-id <source-id> [--context-only]");
  console.log("Requires ACCESS_TOKEN. Optional: PKG_URL, BFF_URL, MIND_MAP_TIMEOUT_MS.");
  process.exit(0);
}

const sourceId = valueAfter("--source-id") || process.env.SOURCE_ID;
const accessToken = process.env.ACCESS_TOKEN;
const pkgUrl = (process.env.PKG_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const bffUrl = (process.env.BFF_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const timeoutMs = Number(process.env.MIND_MAP_TIMEOUT_MS || 180_000);
const contextOnly = args.includes("--context-only");

if (!sourceId || !accessToken) {
  console.error("SOURCE_ID/--source-id and ACCESS_TOKEN are required.");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
};

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function readProposal(response) {
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("Harness response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let proposal = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return proposal;
      const event = JSON.parse(payload);
      if (event.type === "error") throw new Error(event.content || "Harness Agent failed");
      if (event.type === "question") throw new Error("Harness Agent requested unexpected input");
      if (event.type === "tool_result" && event.tool === "propose_source_mind_map") {
        if (event.error || event.result?.startsWith("Error:")) {
          throw new Error(event.result || "Source Mind Map proposal tool failed");
        }
        proposal = JSON.parse(event.result);
        await reader.cancel();
        return proposal;
      }
    }
  }
  return proposal;
}

const runStartedAt = performance.now();
const contextStartedAt = performance.now();
const context = await readJson(await fetch(
  `${pkgUrl}/mind-maps/proposals/source/context?source_id=${encodeURIComponent(sourceId)}`,
  { headers },
));
const contextDurationMs = Math.round(performance.now() - contextStartedAt);

if (context.sampling.total_chunk_count < 97) {
  throw new Error(`Source has ${context.sampling.total_chunk_count} Chunks; this smoke requires at least 97.`);
}
if (context.sampling.sampled_chunk_count > 80 || "raw_content" in context) {
  throw new Error("Bounded context contract failed");
}

if (contextOnly) {
  console.log(JSON.stringify({ ok: true, mode: "context-only", context_duration_ms: contextDurationMs, sampling: context.sampling }, null, 2));
  process.exit(0);
}

const prompt = [
  "Generate one PDF Source Mind Map proposal from the bounded context below.",
  "Preserve source_id and basis_revision exactly. Call propose_source_mind_map exactly once.",
  "Each proposal node must use exactly: temp_id, parent_temp_id, position, content, optional note, and node_kind.",
  "Target 18 to 28 nodes and never exceed 32. Keep only 2 to 3 high-value children per section.",
  "Do not emit analysis, Markdown, or a JSON draft before the tool call.",
  "Do not write or apply a Mind Map. Do not request the full PDF.",
  JSON.stringify(context),
].join("\n\n");

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
const agentStartedAt = performance.now();
let proposal;
try {
  proposal = await readProposal(await fetch(`${bffUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      preset: "generate-source-mind-map",
      ephemeral_session: true,
      client_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    signal: controller.signal,
  }));
} finally {
  clearTimeout(timeoutId);
}
const agentDurationMs = Math.round(performance.now() - agentStartedAt);
if (!proposal) throw new Error("Agent finished without a Source Mind Map proposal");

const validationStartedAt = performance.now();
const validation = await readJson(await fetch(`${pkgUrl}/mind-maps/proposals/source/validate`, {
  method: "POST",
  headers,
  body: JSON.stringify(proposal),
}));
const validationDurationMs = Math.round(performance.now() - validationStartedAt);

console.log(JSON.stringify({
  ok: true,
  mode: "proposal-validation-only",
  source_id: sourceId,
  sampling: context.sampling,
  proposal: {
    node_count: validation.node_count,
    reference_count: validation.reference_count,
  },
  timings_ms: {
    context: contextDurationMs,
    agent: agentDurationMs,
    validation: validationDurationMs,
    total: Math.round(performance.now() - runStartedAt),
  },
  applied: false,
}, null, 2));
