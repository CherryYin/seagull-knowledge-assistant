// Kobo Knowledge API client plugin for DeepSeek Harness
// Ubisoft Kobo Knowledge Platform — retrieval + upload + lifecycle operations.
//
// Token is read from KOBO_TOKEN env var or passed via pkg_kobo_login tool.

export const name = "kobo-client";

const KOBO_BASE = process.env.KOBO_BASE || "https://knowledge-dev.foundry.ubisoft.org/api";

class KoboClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token || null;
  }

  setToken(token) { this.token = token; }

  get _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const opts = { method, headers: this._headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) throw new Error("KOBO 401: token 无效或已过期，请重新获取 token");
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KOBO ${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ── Read-only operations ─────

  healthz() { return this._request("GET", "/healthz"); }
  readyz() { return this._request("GET", "/readyz"); }

  listKnowledgeSets(params = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.space_id) qs.set("space_id", params.space_id);
    if (params.is_published !== undefined) qs.set("is_published", String(params.is_published));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return this._request("GET", `/v1/knowledge-set?${qs.toString()}`);
  }

  getKnowledgeSet(id) { return this._request("GET", `/v1/knowledge-set/${id}`); }

  listSpaces() { return this._request("GET", "/v1/shared-space"); }
  getSpace(id) { return this._request("GET", `/v1/space/${id}`); }
  listSpaceKnowledgeSets(spaceId) { return this._request("GET", `/v1/space/${spaceId}/knowledge-set`); }

  retrieve(knowledgeSetIds, query, top = 5) {
    return this._request("POST", "/v1/retrieve", {
      knowledge_set_ids: knowledgeSetIds,
      query,
      top,
    });
  }

  listSourceItems(knowledgeSetId) {
    return this._request("GET", `/v1/knowledge-set/${knowledgeSetId}/source-item`);
  }

  getSourceItem(knowledgeSetId, sourceItemId) {
    return this._request("GET", `/v1/knowledge-set/${knowledgeSetId}/source-item/${sourceItemId}`);
  }

  listVersions(sourceItemId) {
    return this._request("GET", `/v1/source-item/${sourceItemId}/version`);
  }

  getVersion(versionId) {
    return this._request("GET", `/v1/source-item-version/${versionId}`);
  }

  listConnections(knowledgeSetId) {
    return this._request("GET", `/v1/knowledge-set/${knowledgeSetId}/connection`);
  }

  // ── Mutation operations ─────

  publishKnowledgeSet(id) { return this._request("POST", `/v1/knowledge-set/${id}/publish`); }
  unpublishKnowledgeSet(id) { return this._request("POST", `/v1/knowledge-set/${id}/unpublish`); }
  unpublishSourceItem(id) { return this._request("POST", `/v1/source-item/${id}/unpublish`); }
  deleteSourceItem(id) { return this._request("DELETE", `/v1/source-item/${id}`); }
  retryVersion(versionId) { return this._request("POST", `/v1/source-item-version/${versionId}/retry`); }
  reuploadSourceItem(id) { return this._request("POST", `/v1/source-item/${id}/reupload`); }
}

// ── Tool output helper ─────

function textOutput(desc) {
  return {
    schema: { type: "string", description: desc },
    render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// ── Cordis plugin entry ─────

export function apply(ctx) {
  const token = process.env.KOBO_TOKEN || undefined;
  const client = new KoboClient(KOBO_BASE, token);
  ctx.provide("kobo", client);

  if (!ctx.tools) { ctx.logger?.warn("[kobo-client] tools service not available"); return; }

  // ── Auth ──
  ctx.tools.register({
    name: "kobo_login",
    description: "设置 Kobo Knowledge 的临时 Bearer token。token 通过 https://knowledge-dev.foundry.ubisoft.org/ 登录获取。",
    parameters: {
      type: "object",
      properties: { token: { type: "string", description: "临时访问 token" } },
      required: ["token"],
    },
    output: textOutput("登录结果"),
    execute: async (args) => {
      client.setToken(args.token);
      ctx.kobo = client;
      return "KOBO token 已设置";
    },
  });

  // ── Read-only tools ──

  ctx.tools.register({
    name: "kobo_list_spaces",
    description: "列出 Kobo Knowledge 中可访问的 shared spaces。",
    parameters: { type: "object", properties: {}, required: [] },
    output: textOutput("JSON spaces 列表"),
    execute: async () => JSON.stringify(await client.listSpaces()),
  });

  ctx.tools.register({
    name: "kobo_list_knowledge_sets",
    description: "列出 Kobo Knowledge 中的 knowledge sets，可按关键词、space_id 和发布状态过滤。",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "搜索关键词" },
        space_id: { type: "string", description: "Space ID 过滤" },
        is_published: { type: "boolean", description: "是否已发布" },
        limit: { type: "number", default: 50 },
      },
      required: [],
    },
    output: textOutput("JSON knowledge sets 列表"),
    execute: async (args) => JSON.stringify(await client.listKnowledgeSets({
      q: args.q, space_id: args.space_id, is_published: args.is_published, limit: args.limit || 50,
    })),
  });

  ctx.tools.register({
    name: "kobo_retrieve",
    description: "从 Kobo Knowledge 的一个或多个 knowledge set 中检索知识。传入 knowledge set ID 列表和自然语言查询。",
    parameters: {
      type: "object",
      properties: {
        knowledge_set_ids: { type: "array", items: { type: "string" }, description: "Knowledge set UUID 列表" },
        query: { type: "string", description: "自然语言查询" },
        top: { type: "number", default: 5, description: "返回结果数量 (1-50)" },
      },
      required: ["knowledge_set_ids", "query"],
    },
    output: textOutput("JSON 检索结果"),
    execute: async (args) => JSON.stringify(await client.retrieve(args.knowledge_set_ids, args.query, args.top || 5)),
  });

  ctx.tools.register({
    name: "kobo_get_knowledge_set",
    description: "获取指定 knowledge set 的详细信息。",
    parameters: {
      type: "object",
      properties: { knowledge_set_id: { type: "string" } },
      required: ["knowledge_set_id"],
    },
    output: textOutput("JSON knowledge set 详情"),
    execute: async (args) => JSON.stringify(await client.getKnowledgeSet(args.knowledge_set_id)),
  });

  ctx.tools.register({
    name: "kobo_list_source_items",
    description: "列出指定 knowledge set 中的所有 source items（已上传文档）。",
    parameters: {
      type: "object",
      properties: { knowledge_set_id: { type: "string" } },
      required: ["knowledge_set_id"],
    },
    output: textOutput("JSON source items 列表"),
    execute: async (args) => JSON.stringify(await client.listSourceItems(args.knowledge_set_id)),
  });

  ctx.tools.register({
    name: "kobo_get_source_item",
    description: "获取指定 source item 的详细信息。",
    parameters: {
      type: "object",
      properties: { knowledge_set_id: { type: "string" }, source_item_id: { type: "string" } },
      required: ["knowledge_set_id", "source_item_id"],
    },
    output: textOutput("JSON source item 详情"),
    execute: async (args) => JSON.stringify(await client.getSourceItem(args.knowledge_set_id, args.source_item_id)),
  });

  ctx.tools.register({
    name: "kobo_list_versions",
    description: "列出指定 source item 的所有版本。",
    parameters: {
      type: "object",
      properties: { source_item_id: { type: "string" } },
      required: ["source_item_id"],
    },
    output: textOutput("JSON 版本列表"),
    execute: async (args) => JSON.stringify(await client.listVersions(args.source_item_id)),
  });

  ctx.tools.register({
    name: "kobo_health",
    description: "检查 Kobo Knowledge 服务健康状态。",
    parameters: { type: "object", properties: {}, required: [] },
    output: textOutput("健康检查结果"),
    execute: async () => JSON.stringify(await client.healthz()),
  });

  // ── Mutation tools (confirmed by user) ──

  ctx.tools.register({
    name: "kobo_publish",
    description: "发布指定 knowledge set。仅在用户明确请求时使用。",
    parameters: {
      type: "object",
      properties: { knowledge_set_id: { type: "string" } },
      required: ["knowledge_set_id"],
    },
    output: textOutput("发布结果"),
    execute: async (args) => JSON.stringify(await client.publishKnowledgeSet(args.knowledge_set_id)),
  });

  ctx.tools.register({
    name: "kobo_unpublish",
    description: "取消发布指定 knowledge set。仅在用户明确请求时使用。",
    parameters: {
      type: "object",
      properties: { knowledge_set_id: { type: "string" } },
      required: ["knowledge_set_id"],
    },
    output: textOutput("取消发布结果"),
    execute: async (args) => JSON.stringify(await client.unpublishKnowledgeSet(args.knowledge_set_id)),
  });

  ctx.logger?.info(`[kobo-client] connected to ${KOBO_BASE} (11 tools registered)`);
}
