import type { Context } from "@deepseek-ai/cordis";
export declare const name = "pkg-client";
interface PkgConfig {
    baseUrl: string;
    serviceToken: string;
}
declare class PkgClient {
    private baseUrl;
    private serviceToken;
    constructor(config: PkgConfig);
    private request;
    search(sessionId: string, query: string, mode?: string, topK?: number): Promise<SearchResult[]>;
    listNotes(sessionId: string, params?: {
        note_type?: string;
        limit?: number;
    }): Promise<NoteList>;
    readNote(sessionId: string, noteId: string): Promise<NoteRead>;
    listSources(sessionId: string, params?: {
        source_type?: string;
        limit?: number;
    }): Promise<SourceList>;
    readSource(sessionId: string, sourceId: string): Promise<SourceRead>;
    dashboard(sessionId: string): Promise<DashboardResponse>;
    webSearch(sessionId: string, query: string, maxResults?: number): Promise<unknown>;
    listAssetVisuals(sessionId: string, assetId: string): Promise<AssetVisualList>;
    readPodcast(sessionId: string, assetId: string): Promise<PodcastState>;
    listPodcastVoices(sessionId: string): Promise<PodcastVoiceCatalog>;
    planAssetVisual(sessionId: string, assetId: string, body: Record<string, unknown>): Promise<AssetVisualPlan>;
    generateAssetVisualCandidates(sessionId: string, assetId: string, body: Record<string, unknown>): Promise<AssetVisualList>;
}
interface SearchResult {
    id: string;
    type: string;
    title: string;
    snippet: string;
    score: number;
    layer: string;
}
interface PodcastConfiguration {
    asset_id: string;
    revision: number;
    provider: "qwen";
    region: "cn-beijing";
    model: "qwen3-tts-flash";
    voice_id: string;
    target_duration_minutes: number;
    information_cutoff_at: string | null;
    created_at: string;
    updated_at: string;
}
interface PodcastState {
    asset_id: string;
    configuration: PodcastConfiguration;
    script_approval_available: true;
  audio_generation_available: boolean;
}
interface PodcastVoiceCatalog {
    provider: "qwen";
    region: "cn-beijing";
    model: "qwen3-tts-flash";
    source: string;
    checked_on: string;
    items: Array<{ id: string; name: string; gender: "男声" | "女声"; languages: string[] }>;
}
interface NoteList {
    items: NoteRead[];
    total: number;
}
interface NoteRead {
    id: string;
    title: string;
    note_type: string;
    content?: string;
    tags: string[];
    domains: string[];
    status: string;
    created_at: string;
    updated_at: string;
}
interface SourceList {
    items: SourceRead[];
    total: number;
}
interface SourceRead {
    id: string;
    title: string;
    source_type: string;
    raw_content?: string;
    created_at: string;
}
interface DashboardResponse {
    counts: {
        notes: number;
        sources: number;
        chats: number;
        digest_pending: number;
    };
}
interface AssetVisualList {
    items: Array<Record<string, unknown>>;
}
interface AssetVisualPlan extends Record<string, unknown> {
    role: string;
    size: string;
    style_preset: string;
    brief: Record<string, unknown>;
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        pkg: PkgClient;
    }
}
export declare function apply(ctx: Context): void;
export {};
