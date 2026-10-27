import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const name = "seagull-connection";
export const inject = ["connection", "webServer", "sessionQuery"];

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/seagull/session-cursor",
    methods: ["GET"],
    requestBody: "buffered",
    async fetch(request) {
      const query = new URL(request.url).searchParams;
      const sessionId = query.get("sessionId");
      if (!sessionId || sessionId.length > 256 || [...query.keys()].join() !== "sessionId") {
        return Response.json({ error: "A single bounded sessionId is required" }, { status: 400 });
      }
      let observation;
      try {
        observation = await ctx.sessionQuery.observeSession(sessionId, { signal: request.signal, projectionMode: "none" });
        return Response.json({ cursor: observation.cursor }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const status = error.code === "SESSION_QUERY_SESSION_NOT_FOUND" ? 404 : 503;
        return Response.json({ error: "Read-only session history unavailable" }, { status });
      } finally {
        observation?.[Symbol.dispose]();
      }
    },
  }));
  const path = resolve(process.env.HARNESS_AUTH_FILE || resolve(process.env.DSH_HOME || ".dsh", "run/seagull-harness.json"));
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const content = JSON.stringify({ url: ctx.connection.authenticatedUrl(origin), owner: randomUUID() });
  ctx.effect(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    return async () => {
      try { if (await readFile(path, "utf8") === content) await unlink(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  });
}
