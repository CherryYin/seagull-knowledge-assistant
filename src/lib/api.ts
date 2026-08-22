export { TOKEN_KEY, authHeaders, request, downloadFile } from "./api/client";
export * from "./api/sources";
export * from "./api/notes";
export * from "./api/categories";
export * from "./api/search";
export * from "./api/action";
export * from "./api/sync";
export * from "./api/skills";
export * from "./api/chat-sessions";
export * from "./api/knowledge";
export * from "./api/auth";
export * from "./api/wiki";
export * from "./api/connectors";
export * from "./api/calendar-reminders";
export * from "./api/review";
export * from "./api/discovery";
export * from "./api/system-jobs";
export * from "./api/system";
export * from "./api/assets";
export * from "./api/agent-memory";

// ── Harness API ────────────────────────────────────────
export {
  harnessChat,
  listSessions,
  listPresets,
  submitExperiment,
} from "./api/harness";
export type { HarnessChatEvent, HarnessSession, HarnessPreset } from "./api/harness";
