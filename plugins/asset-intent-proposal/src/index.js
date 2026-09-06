export const name = "asset-intent-proposal";

const CREATION_MODES = new Set(["understand", "synthesize", "make_decision", "produce"]);

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value.trim();
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_asset_intent",
    description: "提交可回填 Asset 创建表单的 Intent Proposal。只返回 Agent 建议，不创建 Asset、不确认 Intent、不覆盖用户输入。",
    parameters: {
      type: "object",
      properties: {
        workingTitle: { type: "string" },
        question: { type: "string" },
        goal: { type: "string" },
        audience: { type: "string" },
        creationMode: { type: "string", enum: [...CREATION_MODES] },
        scope: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["workingTitle", "question", "goal", "audience", "creationMode", "scope", "constraints", "rationale"],
    },
    output: textOutput("Asset Intent Proposal awaiting explicit user application and confirmation"),
    execute: async (args) => {
      if (!CREATION_MODES.has(args.creationMode)) throw new TypeError("creationMode is invalid");
      return JSON.stringify({
        workingTitle: optionalText(args.workingTitle, "workingTitle"),
        question: requiredText(args.question, "question"),
        goal: requiredText(args.goal, "goal"),
        audience: optionalText(args.audience, "audience"),
        creationMode: args.creationMode,
        scope: stringList(args.scope, "scope"),
        constraints: stringList(args.constraints, "constraints"),
        rationale: requiredText(args.rationale, "rationale"),
        authorship: "agent",
        requiresUserConfirmation: true,
        writesAsset: false,
      });
    },
  });
}
