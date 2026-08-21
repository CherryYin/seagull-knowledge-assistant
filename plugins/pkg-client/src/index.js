// PKG (Personal Knowledge Graph) API client plugin for DeepSeek Harness.
// Authentication is relayed by the Seagull BFF and scoped to the current Harness session.

export const name = "pkg-client";

class PkgClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "http://127.0.0.1:4000/internal/pkg").replace(/\/+$/, "");
    this.serviceToken = config.serviceToken;
  }

  async request(sessionId, method, path, body) {
    if (!sessionId) throw new Error("PKG tool requires an active Harness session");
    if (!this.serviceToken) throw new Error("HARNESS_SERVICE_TOKEN is not configured");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Session-Id": sessionId,
        "X-Harness-Service-Token": this.serviceToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PKG ${method} ${path} failed (${response.status}): ${text}`);
    }
    return response.json();
  }

  search(sessionId, query, mode, topK) {
    return this.request(sessionId, "POST", "/search", { query, mode: mode || "hybrid", top_k: topK || 5 });
  }
  listNotes(sessionId, params) {
    const query = new URLSearchParams();
    if (params?.note_type) query.set("note_type", params.note_type);
    if (params?.limit) query.set("limit", String(params.limit));
    return this.request(sessionId, "GET", `/notes?${query.toString()}`);
  }
  readNote(sessionId, noteId) { return this.request(sessionId, "GET", `/notes/${noteId}`); }
  createNote(sessionId, body) { return this.request(sessionId, "POST", "/notes", body); }
  listSources(sessionId, params) {
    const query = new URLSearchParams();
    if (params?.source_type) query.set("source_type", params.source_type);
    if (params?.limit) query.set("limit", String(params.limit));
    return this.request(sessionId, "GET", `/sources?${query.toString()}`);
  }
  readSource(sessionId, sourceId) { return this.request(sessionId, "GET", `/sources/${sourceId}`); }
  saveDocument(sessionId, body) { return this.request(sessionId, "POST", "/knowledge/save-document", body); }
  remember(sessionId, content, title) {
    return this.request(sessionId, "POST", "/knowledge/remember", { content, title });
  }
  searchMemory(sessionId, query, topK) {
    return this.request(sessionId, "POST", "/memory/search", {
      query,
      node_type: "",
      level: "",
      top_k: topK || 5,
    });
  }
  dashboard(sessionId) { return this.request(sessionId, "GET", "/knowledge/dashboard"); }
}

function sessionId(exec) {
  const id = exec?.agent?.session?.id;
  if (!id) throw new Error("PKG tool call is missing its Harness session context");
  return String(id);
}

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

export function apply(ctx) {
  const baseUrl = process.env.PKG_GATEWAY_URL || "http://127.0.0.1:4000/internal/pkg";
  const serviceToken = process.env.HARNESS_SERVICE_TOKEN || "seagull-loopback-harness";
  const client = new PkgClient({ baseUrl, serviceToken });
  ctx.provide("pkg", client);

  if (!ctx.tools) return;

  ctx.tools.register({
    name: "pkg_search",
    description: "搜索当前用户的 PKG 知识库。认证由 Gateway 自动注入。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        mode: { type: "string", enum: ["sql", "vector", "hybrid"], default: "hybrid" },
        top_k: { type: "number", default: 5 },
      },
      required: ["query"],
    },
    output: textOutput("JSON 搜索结果"),
    execute: async (args, exec) => JSON.stringify(
      await client.search(sessionId(exec), args.query, args.mode || "hybrid", args.top_k || 5),
    ),
  });

  ctx.tools.register({
    name: "pkg_list_notes",
    description: "列出当前用户的 PKG 笔记。",
    parameters: { type: "object", properties: { note_type: { type: "string" }, limit: { type: "number", default: 20 } }, required: [] },
    output: textOutput("JSON 笔记列表"),
    execute: async (args, exec) => JSON.stringify(await client.listNotes(sessionId(exec), {
      note_type: args.note_type,
      limit: args.limit || 20,
    })),
  });

  ctx.tools.register({
    name: "pkg_list_sources",
    description: "列出当前用户的 PKG 知识源。",
    parameters: { type: "object", properties: { source_type: { type: "string" }, limit: { type: "number", default: 20 } }, required: [] },
    output: textOutput("JSON 知识源列表"),
    execute: async (args, exec) => JSON.stringify(await client.listSources(sessionId(exec), {
      source_type: args.source_type,
      limit: args.limit || 20,
    })),
  });

  ctx.tools.register({
    name: "pkg_knowledge_stats",
    description: "获取当前用户的 PKG 知识库统计。",
    parameters: { type: "object", properties: {}, required: [] },
    output: textOutput("JSON 统计信息"),
    execute: async (_args, exec) => JSON.stringify(await client.dashboard(sessionId(exec))),
  });

  ctx.tools.register({
    name: "pkg_read_note",
    description: "读取当前用户 PKG 中指定 ID 的笔记全文。",
    parameters: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"] },
    output: textOutput("JSON 笔记内容"),
    execute: async (args, exec) => JSON.stringify(await client.readNote(sessionId(exec), args.note_id)),
  });

  ctx.tools.register({
    name: "pkg_read_source",
    description: "读取当前用户 PKG 中指定 ID 的知识源全文。",
    parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
    output: textOutput("JSON 知识源内容"),
    execute: async (args, exec) => JSON.stringify(await client.readSource(sessionId(exec), args.source_id)),
  });

  ctx.tools.register({
    name: "pkg_save_note",
    description: "保存 Agent 产出为当前用户的 PKG 笔记。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        note_type: { type: "string", default: "concept" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content"],
    },
    output: textOutput("JSON 已保存笔记"),
    execute: async (args, exec) => JSON.stringify(await client.createNote(sessionId(exec), {
      title: args.title,
      content: args.content,
      note_type: args.note_type || "concept",
      tags: args.tags || ["from-agent"],
      status: "seed",
    })),
  });

  ctx.tools.register({
    name: "pkg_save_document",
    description: "保存 Agent 产出为当前用户的 PKG writing artifact。",
    parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] },
    output: textOutput("JSON 保存结果"),
    execute: async (args, exec) => JSON.stringify(await client.saveDocument(sessionId(exec), {
      message_content: args.content,
      title: args.title,
    })),
  });

  ctx.tools.register({
    name: "pkg_remember",
    description: "保存知识为当前用户的 PKG 临时记忆。",
    parameters: { type: "object", properties: { content: { type: "string" }, title: { type: "string" } }, required: ["content"] },
    output: textOutput("JSON 已保存记忆"),
    execute: async (args, exec) => JSON.stringify(
      await client.remember(sessionId(exec), args.content, args.title),
    ),
  });

  ctx.tools.register({
    name: "pkg_search_memory",
    description: "搜索当前用户的 PKG 记忆图谱。",
    parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "number", default: 5 } }, required: ["query"] },
    output: textOutput("JSON 记忆搜索结果"),
    execute: async (args, exec) => JSON.stringify(
      await client.searchMemory(sessionId(exec), args.query, args.top_k || 5),
    ),
  });

  ctx.tools.register({
    name: "pkg_submit_experiment",
    description: "将 Harness 中验证成功的实验流程提交到当前用户的 PKG 实验台。",
    parameters: {
      type: "object",
      properties: {
        experiment_name: { type: "string", description: "实验名称，如 research-topic-validated" },
        description: { type: "string", description: "实验/Skill 描述" },
        steps: { type: "array", items: { type: "string" }, description: "执行步骤列表" },
        output_sections: { type: "array", items: { type: "string" }, description: "输出格式 sections" },
        constraints: { type: "array", items: { type: "string" }, description: "约束条件" },
        tools_used: { type: "array", items: { type: "string" }, description: "实验中使用的工具名列表" },
        save_as_note: { type: "boolean", description: "是否同时保存为 PKG Note", default: true },
      },
      required: ["experiment_name", "description", "steps"],
    },
    output: textOutput("JSON 提交结果，含 skill_id 和双输出内容"),
    execute: async (args, exec) => {
      const result = await client.request(sessionId(exec), "POST", "/lab/experiment-to-skill", {
        experiment_name: args.experiment_name,
        description: args.description,
        steps: args.steps || [],
        output_sections: args.output_sections || [],
        constraints: args.constraints || [],
        tools_used: args.tools_used || [],
        model_provider: "qwen",
        model_name: "qwen-plus",
        temperature: 0.3,
        save_as_note: args.save_as_note !== false,
      });
      return JSON.stringify(result, null, 2);
    },
  });

  ctx.logger?.info(`[pkg-client] connected through ${baseUrl} (11 tools, session-scoped Gateway auth)`);
}
