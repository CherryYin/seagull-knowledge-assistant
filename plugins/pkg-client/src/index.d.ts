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
    searchMemory(sessionId: string, query: string, topK?: number): Promise<MemorySearchResult[]>;
    dashboard(sessionId: string): Promise<DashboardResponse>;
}
interface SearchResult {
    id: string;
    type: string;
    title: string;
    snippet: string;
    score: number;
    layer: string;
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
interface MemorySearchResult {
    id: string;
    title: string;
    node_type: string;
    level: string;
    snippet: string;
    score: number;
}
interface DashboardResponse {
    counts: {
        notes: number;
        sources: number;
        chats: number;
        digest_pending: number;
    };
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        pkg: PkgClient;
    }
}
export declare function apply(ctx: Context): void;
export {};
