export const name = "asset-evidence-proposal";

const TARGET_TYPES = new Set(["source", "note", "wiki", "web"]);
const RELATIONS = new Set(["supports", "contradicts", "context", "unverified"]);

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function normalizeProposal(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`proposals[${index}] must be an object`);
  }
  if (!TARGET_TYPES.has(value.targetType)) throw new TypeError(`proposals[${index}].targetType is invalid`);
  if (!RELATIONS.has(value.relation)) throw new TypeError(`proposals[${index}].relation is invalid`);
  return {
    targetType: value.targetType,
    targetId: requiredText(value.targetId, `proposals[${index}].targetId`),
    relation: value.relation,
    summary: requiredText(value.summary, `proposals[${index}].summary`),
    ...(value.fragmentSelector && typeof value.fragmentSelector === "object" && !Array.isArray(value.fragmentSelector)
      ? { fragmentSelector: value.fragmentSelector }
      : {}),
  };
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_asset_evidence",
    description: "提交 Asset Evidence 候选。此工具只返回待用户确认的结构化提案，不写入 Asset、PKG 或长期知识。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "当前 Asset ID" },
        baseWorkspaceRevision: { type: "number", description: "开始调查时的 Workspace revision" },
        intentRevision: { type: "number", description: "证据所服务的已确认 Intent revision" },
        proposals: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              targetType: { type: "string", enum: ["source", "note", "wiki", "web"] },
              targetId: { type: "string", description: "Source/Note/Wiki ID，或 Web URL" },
              relation: { type: "string", enum: ["supports", "contradicts", "context", "unverified"] },
              summary: { type: "string", description: "该证据新增了什么，以及为何与 Intent 有关" },
              fragmentSelector: { type: "object", description: "可选的具体片段定位信息" },
            },
            required: ["targetType", "targetId", "relation", "summary"],
          },
        },
      },
      required: ["assetId", "baseWorkspaceRevision", "intentRevision", "proposals"],
    },
    output: textOutput("Structured Asset Evidence proposals awaiting explicit user confirmation"),
    execute: async (args) => {
      if (!Array.isArray(args.proposals) || args.proposals.length === 0 || args.proposals.length > 20) {
        throw new TypeError("proposals must contain between 1 and 20 items");
      }
      return JSON.stringify({
        assetId: requiredText(args.assetId, "assetId"),
        baseWorkspaceRevision: args.baseWorkspaceRevision,
        intentRevision: args.intentRevision,
        proposals: args.proposals.map(normalizeProposal),
        authorship: "agent",
        requiresUserConfirmation: true,
      });
    },
  });
}
