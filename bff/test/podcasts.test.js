import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

test("podcast contracts flow through cookie-authenticated Gateway without changing payloads or conflicts", async (context) => {
  const requests = [];
  const pkg = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/auth/login") return response.end(JSON.stringify({ access_token: "podcast-test-token" }));
    if (request.headers.authorization !== "Bearer podcast-test-token") {
      response.writeHead(401);
      return response.end(JSON.stringify({ detail: "Unauthorized" }));
    }
    if (request.url === "/assets/podcast/voices") return response.end(JSON.stringify({ items: [{ id: "Eldric Sage" }] }));
    if (request.method === "GET" && request.url === "/assets/episode/podcast/audio-renders") {
      return response.end(JSON.stringify({ items: [{ id: "render", status: "outcome_unknown", failure_details: {
        stage: "audio_download", code: "read_timeout", elapsed_ms: 120000, http_status: 200, provider_request_id: "abc-123",
        exception_type: "ReadTimeout", provider_error_code: null, retry_after_seconds: 30,
      }, attempts: [{ segment_position: 4, provider_request_id: "abc-123", billable_characters: 1000 }] }] }));
    }
    if (request.url === "/assets/foreign/podcast") {
      response.writeHead(404);
      return response.end(JSON.stringify({ detail: "Asset not found" }));
    }
    if (request.url === "/assets/episode/podcast/audio-renders/render/download") {
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Content-Disposition", "attachment; filename=seagull-podcast.mp3");
      return response.end(Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff]));
    }
    if (request.url.includes("/podcast/audio-renders")) return response.end(JSON.stringify({ forwarded: body }));
    if (request.url.includes("/podcast/delivery-records")) return response.end(JSON.stringify(request.method === "GET" ? { items: [] } : { forwarded: body }));
    if (request.url === "/discovery/web-search/preview" || request.url === "/discovery/web-results/save") return response.end(JSON.stringify({ forwarded: body }));
    if (request.url.endsWith("/podcast/draft") || request.url.endsWith("/podcast/script-approvals") || request.url.endsWith("/podcast/audio-preflight") || request.url === "/assets/podcast") {
      if (body?.base_input_hash === "stale") {
        response.writeHead(409);
        return response.end(JSON.stringify({ detail: "Podcast inputs changed" }));
      }
      return response.end(JSON.stringify({ asset_id: "episode", approval_status: "unconfirmed", forwarded: body }));
    }
    if (request.method === "PUT" && body.base_revision !== 1) {
      response.writeHead(409);
      return response.end(JSON.stringify({ detail: "Podcast configuration changed; reload before saving" }));
    }
    return response.end(JSON.stringify({ asset_id: "episode", configuration: body ?? { voice_id: "Cherry", revision: 1 }, audio_generation_available: false }));
  });
  await new Promise(resolve => pkg.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => pkg.close(resolve)));
  const previousPkg = process.env.PKG_API_URL;
  const previousToken = process.env.HARNESS_SERVICE_TOKEN;
  process.env.PKG_API_URL = `http://127.0.0.1:${pkg.address().port}`;
  process.env.HARNESS_SERVICE_TOKEN = "podcast-contract-test-token-0123456789";
  context.after(() => {
    if (previousPkg === undefined) delete process.env.PKG_API_URL;
    else process.env.PKG_API_URL = previousPkg;
    if (previousToken === undefined) delete process.env.HARNESS_SERVICE_TOKEN;
    else process.env.HARNESS_SERVICE_TOKEN = previousToken;
  });
  const { createBffServer } = await import(`../src/index.js?podcast-contract=${Date.now()}`);
  const gateway = createBffServer();
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  assert.equal((await fetch(`${base}/api/assets/episode/podcast`)).status, 401);
  assert.equal((await fetch(`${base}/api/assets/episode/podcast/audio-renders/render/abandon`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/api/assets/episode/podcast/delivery-records`)).status, 401);
  assert.equal((await fetch(`${base}/api/assets/episode/podcast/delivery-records/record`, { method: "PUT" })).status, 401);
  assert.equal((await fetch(`${base}/api/discovery/web-results/save`, { method: "POST" })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test", password: "test" }) });
  const headers = { Cookie: login.headers.get("set-cookie"), "Content-Type": "application/json" };
  const catalog = await fetch(`${base}/api/assets/podcast/voices`, { headers });
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { items: [{ id: "Eldric Sage" }] });
  const read = await fetch(`${base}/api/assets/episode/podcast`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).audio_generation_available, false);
  const diagnostics = await fetch(`${base}/api/assets/episode/podcast/audio-renders`, { headers });
  const publications = await fetch(`${base}/api/assets/episode/podcast/delivery-records`, { headers });
  assert.equal(publications.status, 200);
  assert.deepEqual(await publications.json(), { items: [] });
  assert.equal(diagnostics.status, 200);
  const diagnosticTask = (await diagnostics.json()).items[0];
  assert.equal(diagnosticTask.failure_details.stage, "audio_download");
  assert.equal(diagnosticTask.failure_details.http_status, 200);
  assert.equal(diagnosticTask.failure_details.exception_type, "ReadTimeout");
  assert.equal(diagnosticTask.failure_details.retry_after_seconds, 30);
  assert.equal(diagnosticTask.attempts[0].provider_request_id, "abc-123");
  const body = { base_revision: 1, voice_id: "Eldric Sage", target_duration_minutes: 6 };
  const save = await fetch(`${base}/api/assets/episode/podcast`, { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal(save.status, 200);
  assert.deepEqual((await save.json()).configuration, body);
  const forwarded = requests.find(request => request.method === "PUT" && request.url === "/assets/episode/podcast");
  assert.deepEqual(forwarded.body, body);
  assert.equal(forwarded.authorization, "Bearer podcast-test-token");
  const stale = await fetch(`${base}/api/assets/episode/podcast`, { method: "PUT", headers, body: JSON.stringify({ ...body, base_revision: 2 }) });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).detail, /configuration changed/);
  assert.equal((await fetch(`${base}/api/assets/foreign/podcast`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/internal/pkg/assets/episode/podcast`, { headers })).status, 403);
  for (const [path, method, payload] of [
    ["/assets/episode/podcast/delivery-records/record", "PUT", { base_revision: 1, render_id: "render", confirm_published: true, published_at: "2026-01-01T02:00:00Z", publish_url: "https://mp.weixin.qq.com/s/published", statistics_snapshots: [{ id: "b3c2693b-043b-4987-aae4-3b4349bce890", source: "manual_backend", account_label: "海鸥ai应用", period_kind: "cumulative", period_start: "2026-01-01", period_end: "2026-01-04", captured_at: "2026-01-05T00:00:00Z", metrics: { read: { value: 42, unit: "people" }, share: { value: 0, unit: "times" } }, user_confirmed: true }] }],
    ["/assets/episode/podcast/delivery-records/record", "PUT", { base_revision: 1, render_id: "render", confirm_published: true, published_at: "2026-10-17T12:00:00+08:00", channel: "微信公众号", adoption: "modified", manual_steps: ["editing"] }],
    ["/discovery/web-search/preview", "POST", { query: "specific news topic", max_results: 8 }],
    ["/discovery/web-results/save", "POST", { query: "specific news topic", items: [{ title: "Selected result", url: "https://example.com/news", summary: "Unverified search excerpt" }] }],
    ["/assets/podcast", "POST", { title: "Episode", configuration: { voice_id: "Ono Anna" } }],
    ["/assets/episode/podcast/draft", "PUT", { title: "Saved", base_input_hash: "a".repeat(64), paragraph_sources: [
      { paragraph_index: 0, text_hash: "b".repeat(64), material_refs: [{ kind: "note", id: "selected-note" }] },
    ] }],
    ["/assets/episode/podcast/script-approvals", "POST", { base_input_hash: "a".repeat(64) }],
    ["/assets/episode/podcast/audio-preflight", "POST", { base_input_hash: "a".repeat(64), budget_limit: "2", credential_id: 7, price_per_10k_characters: "0.8" }],
    ["/assets/episode/podcast/audio-renders", "POST", { base_input_hash: "a".repeat(64), execution_fingerprint: "b".repeat(64), budget_limit: "2", credential_id: 7, price_per_10k_characters: "0.8", idempotency_key: "one-operation", authorize_text_to_provider: true, acknowledge_billing_uncertainty: true }],
    ["/assets/episode/podcast/audio-renders/render/abandon", "POST", { acknowledge_billing_uncertainty: true, acknowledge_full_regeneration: true }],
  ]) {
    const result = await fetch(`${base}/api${path}`, { method, headers, body: JSON.stringify(payload) });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).forwarded, payload);
    assert.equal(requests.at(-1).authorization, "Bearer podcast-test-token");
  }
  assert.equal((await fetch(`${base}/api/assets/episode/podcast/script-approvals`, {
    method: "POST", headers, body: JSON.stringify({ base_input_hash: "stale" }),
  })).status, 409);
  const audio = await fetch(`${base}/api/assets/episode/podcast/audio-renders/render/download`, { headers });
  assert.equal(audio.headers.get("Content-Type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff]));
  assert.equal((await fetch(`${base}/api/assets/episode/podcast/audio-renders/render/download`)).status, 401);
});
