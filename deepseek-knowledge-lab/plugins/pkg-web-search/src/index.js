export const name = "pkg-web-search";

function sessionId(exec) {
  const id = exec?.agent?.session?.id;
  if (!id) throw new Error("web_search requires an active Harness session");
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
  ctx.tools.register({
    name: "web_search",
    description: "通过 PKG 配置的联网搜索服务检索公开网络。此工具只返回结果，不会把搜索结果写入 Discovery、Source、Note、Wiki 或 Asset。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "针对具体事实、时效性或证据缺口的搜索查询" },
        max_results: { type: "number", minimum: 1, maximum: 20, default: 8 },
      },
      required: ["query"],
    },
    output: textOutput("PKG Web Search JSON results with title, URL, summary, source name, and publication time"),
    execute: async (args, exec) => JSON.stringify(
      await ctx.pkg.webSearch(sessionId(exec), args.query, args.max_results || 8),
    ),
  });
}
