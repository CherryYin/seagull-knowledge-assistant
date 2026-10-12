export const name = "weread-client";

export const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
export const WEREAD_SKILL_VERSION = "1.0.4";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const ALLOWED_API_NAMES = new Set([
  "/_list",
  "/book/bestbookmarks",
  "/book/bookmarklist",
  "/book/chapterinfo",
  "/book/detailinfo",
  "/book/getprogress",
  "/book/info",
  "/book/readreviews",
  "/book/recommend",
  "/book/similar",
  "/book/underlines",
  "/readdata/detail",
  "/review/list",
  "/review/list/mine",
  "/review/single",
  "/shelf/sync",
  "/store/search",
  "/user/notebooks",
]);

const RESERVED_PARAMETER_NAMES = new Set([
  "api_name",
  "authorization",
  "headers",
  "method",
  "skill_version",
  "token",
  "url",
  "weread_api_key",
]);

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function configuredApiKey() {
  const apiKey = process.env.WEREAD_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("WeRead is not configured: set WEREAD_API_KEY in deepseek-knowledge-lab/.dsh/.env and restart Harness");
  }
  if (!apiKey.startsWith("wrk-")) {
    throw new Error("WeRead configuration is invalid: WEREAD_API_KEY must start with wrk-");
  }
  return apiKey;
}

function normalizeParameters(parameters) {
  if (parameters === undefined || parameters === null) return {};
  if (typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("WeRead parameters must be a JSON object");
  }
  for (const key of Object.keys(parameters)) {
    if (RESERVED_PARAMETER_NAMES.has(key.toLowerCase())) {
      throw new Error(`WeRead parameter is reserved: ${key}`);
    }
  }
  return parameters;
}

function safeErrorBody(body) {
  return body.replace(/wrk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 500);
}

export async function requestWeread({
  apiName,
  parameters,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!ALLOWED_API_NAMES.has(apiName)) {
    throw new Error(`WeRead API is not allowed: ${apiName}`);
  }

  const body = JSON.stringify({
    api_name: apiName,
    ...normalizeParameters(parameters),
    skill_version: WEREAD_SKILL_VERSION,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("WeRead request is too large");
  }

  const response = await fetchImpl(WEREAD_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("WeRead response is too large");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("WeRead authentication failed: check WEREAD_API_KEY");
    }
    throw new Error(`WeRead request failed (${response.status}): ${safeErrorBody(responseText)}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error("WeRead returned an invalid JSON response");
  }
}

export function apply(ctx) {
  if (!ctx.tools) {
    ctx.logger?.warn("[weread-client] tools service not available");
    return;
  }

  ctx.tools.register({
    name: "weread_api",
    description: "调用微信读书官方 Agent API Gateway 的只读接口。仅用于已加载 weread-skills 后查询书籍、书架、阅读进度、笔记划线、书评、推荐和阅读统计；域名、鉴权和 skill_version 由服务端固定注入。",
    parameters: {
      type: "object",
      properties: {
        api_name: {
          type: "string",
          enum: [...ALLOWED_API_NAMES],
          description: "weread-skills 文档指定的微信读书只读 API 名称",
        },
        parameters: {
          type: "object",
          description: "对应接口的业务参数，直接平铺；不要包含 api_name、skill_version、鉴权、Header、URL 或 Method",
          additionalProperties: true,
        },
      },
      required: ["api_name"],
    },
    output: textOutput("微信读书官方 Agent API Gateway 返回的原始 JSON；回答前按 weread-skills 文档解释字段和检查 upgrade_info"),
    execute: async (args) => JSON.stringify(await requestWeread({
      apiName: args.api_name,
      parameters: args.parameters,
      apiKey: configuredApiKey(),
    })),
  });

  ctx.logger?.info(`[weread-client] registered read-only WeRead gateway tool (${ALLOWED_API_NAMES.size} endpoints)`);
}
