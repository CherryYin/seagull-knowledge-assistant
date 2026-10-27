import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply, inject } from "../src/index.js";

test("connection bootstrap is private, uses the public authentication API and cleans up its own file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "seagull-connection-"));
  const previous = process.env.HARNESS_AUTH_FILE;
  const path = join(directory, "private", "connection.json");
  process.env.HARNESS_AUTH_FILE = path;
  t.after(async () => {
    if (previous === undefined) delete process.env.HARNESS_AUTH_FILE;
    else process.env.HARNESS_AUTH_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const effects = [];
  let route;
  let released = 0;
  assert.deepEqual(inject, ["connection", "webServer", "sessionQuery"]);
  apply({
    webServer: { port: 4321 },
    connection: {
      authenticatedUrl(origin) { assert.equal(origin, "http://127.0.0.1:4321"); return `${origin}/?token=fixture-private-token`; },
      fetch: { register(value) { route = value; return () => {}; } },
    },
    sessionQuery: { async observeSession(sessionId, options) {
      assert.equal(sessionId, "owned");
      assert.equal(options.projectionMode, "none");
      return { cursor: 4, [Symbol.dispose]() { released++; } };
    } },
    effect(callback) { effects.push(callback); },
  });
  effects[0]();
  assert.deepEqual(await (await route.fetch(new Request("http://localhost/api/seagull/session-cursor?sessionId=owned"))).json(), { cursor: 4 });
  assert.equal(released, 1);
  assert.equal((await route.fetch(new Request("http://localhost/api/seagull/session-cursor?sessionId=owned&sessionId=other"))).status, 400);
  const dispose = await effects[1]();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const connection = JSON.parse(await readFile(path, "utf8"));
  assert.equal(connection.url, "http://127.0.0.1:4321/?token=fixture-private-token");
  assert.equal(typeof connection.owner, "string");
  await dispose();
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const disposePrevious = await effects[1]();
  await writeFile(path, "new-owner");
  await disposePrevious();
  assert.equal(await readFile(path, "utf8"), "new-owner");
});
