import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

test("WeChat statistics remain owner-authenticated Gateway requests without secret transport", async context => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ url: request.url, method: request.method, auth: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/auth/login") return response.end(JSON.stringify({ access_token: "owner-token" }));
    if (request.headers.authorization !== "Bearer owner-token") {
      response.writeHead(401);
      return response.end(JSON.stringify({ detail: "Unauthorized" }));
    }
    if (request.method === "POST") {
      response.writeHead(409);
      return response.end(JSON.stringify({ detail: "No statistics permission" }));
    }
    return response.end(JSON.stringify({ snapshot: null }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => upstream.close(resolve)));
  const previous = process.env.PKG_API_URL;
  process.env.PKG_API_URL = `http://127.0.0.1:${upstream.address().port}`;
  context.after(() => { if (previous === undefined) delete process.env.PKG_API_URL; else process.env.PKG_API_URL = previous; });
  const { createBffServer } = await import(`../src/index.js?wechat-statistics=${Date.now()}`);
  const gateway = createBffServer();
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const path = "/api/knowledge/wechat-statistics?credential_id=7&publication_date=2026-01-01";
  assert.equal((await fetch(`${base}${path}`)).status, 401);
  assert.equal((await fetch(`${base}/api/knowledge/wechat-statistics/sync`, { method: "POST" })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "test" }) });
  const headers = { Cookie: login.headers.get("set-cookie"), "Content-Type": "application/json" };
  assert.deepEqual(await (await fetch(`${base}${path}`, { headers })).json(), { snapshot: null });
  assert.equal(requests.at(-1).auth, "Bearer owner-token");
  const payload = { credential_id: 7, publication_date: "2026-01-01" };
  const sync = await fetch(`${base}/api/knowledge/wechat-statistics/sync`, { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(sync.status, 409);
  assert.deepEqual(requests.at(-1).body, payload);
  assert.deepEqual(await sync.json(), { detail: "No statistics permission" });
});
