import type { Context } from "@deepseek-ai/cordis";
export declare const name = "pkg-client";
interface PkgConfig {
    baseUrl: string;
    token?: string;
}
declare class PkgClient {
    private baseUrl;
    private token;
    constructor(config: PkgConfig);
    setToken(token: string): void;
    private get headers();
    private request;
    login(email: string, password: string): Promise<{
        access_token: string;
    }>;
    search(query: string, mode?: string, topK?: number): Promise<SearchResult[]>;
    listNotes(params?: {
        note_type?: string;
        limit?: number;
        offset?: number;
    }): Promise<NoteList>;
    readNote(noteId: string): Promise<NoteRead>;
    createNote(body: NoteCreate): Promise<NoteRead>;
    listSources(params?: {
        source_type?: string;
        limit?: number;
    }): Promise<SourceList>;
    readSource(sourceId: string): Promise<SourceRead>;
    saveDocument(body: SaveDocumentRequest): Promise<SaveDocumentResponse>;
    remember(content: string, title?: string): Promise<NoteRead>;
    searchMemory(query: string, nodeType?: string, level?: string, topK?: number): Promise<MemorySearchResult[]>;
    listWikis(): Promise<WikiList>;
    readWiki(wikiId: string): Promise<WikiRead>;
    dashboard(): Promise<DashboardResponse>;
    knowledgeStats(): Promise<KnowledgeStatsList>;
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
interface NoteCreate {
    title: string;
    content?: string;
    note_type?: string;
    tags?: string[];
    domains?: string[];
    status?: string;
    category_id?: number;
    source_ids?: string[];
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
interface SaveDocumentRequest {
    message_content: string;
    title?: string;
    category_id?: number;
}
interface SaveDocumentResponse {
    source_id: string;
    note_id: string;
}
interface MemorySearchResult {
    id: string;
    title: string;
    node_type: string;
    level: string;
    snippet: string;
    score: number;
}
interface WikiList {
    items: WikiRead[];
    total: number;
}
interface WikiRead {
    id: string;
    title: string;
    content?: string;
}
interface DashboardResponse {
    counts: {
        notes: number;
        sources: number;
        chats: number;
        digest_pending: number;
    };
}
interface KnowledgeStatsList {
    items: unknown[];
    total: number;
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        pkg: PkgClient;
    }
}
export declare function apply(ctx: Context): void;
export {};
