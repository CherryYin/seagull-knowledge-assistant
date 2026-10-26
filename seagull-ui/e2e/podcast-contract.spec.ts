import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { assetTypeLabel, MANUAL_ASSET_TYPES } from "../src/lib/asset-generation";

test("podcast identity is supported without offering unfinished generation", () => {
  expect(assetTypeLabel("podcast")).toBe("Podcast");
  expect(MANUAL_ASSET_TYPES.some(item => String(item.value) === "podcast")).toBe(false);
});

test("podcast SDK uses the Gateway, preserves voice IDs and exposes revision conflicts", async ({ page }) => {
  const catalog = JSON.parse(readFileSync(new URL("../../personal_knowledge_graph/src/pkg/services/application/podcast_voices.json", import.meta.url), "utf8"));
  const requests: Array<{ path: string; method: string; authorization: string | undefined; body: Record<string, unknown> | null }> = [];
  await page.route("**/podcast-sdk-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Podcast SDK test</title>" }));
  await page.route("**/api/assets/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    requests.push({ path, method: request.method(), authorization: request.headers().authorization, body });
    if (path === "/api/assets/podcast/voices") {
      return route.fulfill({ json: { provider: "qwen", region: "cn-beijing", model: catalog.model, source: catalog.source, checked_on: catalog.checked_on, items: catalog.voices } });
    }
    if (body?.base_revision === 99) return route.fulfill({ status: 409, json: { detail: "Podcast configuration changed; reload before saving" } });
    return route.fulfill({ json: {
      asset_id: "episode/one",
      configuration: { provider: "qwen", region: "cn-beijing", model: "qwen3-tts-flash", voice_id: body?.voice_id ?? "Cherry", target_duration_minutes: 6, information_cutoff_at: null, asset_id: "episode/one", revision: body ? 2 : 1, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" },
      script_approval_available: true,
      audio_generation_available: false,
    } });
  });
  await page.goto("/podcast-sdk-test");
  const result = await page.evaluate(async () => {
    localStorage.setItem("auth_token", "podcast-sdk-token");
    const modulePath = "/src/lib/api/podcasts.ts";
    const { podcastsApi } = await import(modulePath);
    const voices = await podcastsApi.voices();
    const state = await podcastsApi.get("episode/one");
    const { asset_id, revision, created_at, updated_at, ...configuration } = state.configuration;
    const body = { ...configuration, voice_id: "Eldric Sage", base_revision: revision };
    const saved = await podcastsApi.update(asset_id, body);
    let conflict = "";
    try {
      await podcastsApi.update(asset_id, { ...body, base_revision: 99 });
    } catch (error) {
      conflict = String(error);
    }
    return { voices: voices.items.map((voice: { id: string }) => voice.id), saved, conflict, created_at, updated_at };
  });
  expect(result.voices).toHaveLength(48);
  expect(result.voices).toContain("Ono Anna");
  expect(result.saved.configuration.voice_id).toBe("Eldric Sage");
  expect(result.saved.configuration.revision).toBe(2);
  expect(result.saved.audio_generation_available).toBe(false);
  expect(result.conflict).toContain("409");
  expect(result.conflict).toContain("configuration changed");
  expect(requests).toHaveLength(4);
  expect(requests.every(request => request.authorization === "Bearer podcast-sdk-token")).toBe(true);
  expect(requests[1].path).toBe("/api/assets/episode%2Fone/podcast");
  expect(requests[2].method).toBe("PUT");
  expect(requests[2].body?.voice_id).toBe("Eldric Sage");
});
