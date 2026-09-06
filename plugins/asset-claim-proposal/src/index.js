export const name = "asset-claim-proposal";

const CLAIM_KINDS = new Set(["inference", "hypothesis", "recommendation", "synthesis"]);
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);

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

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeClaim(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`proposals[${index}] must be an object`);
  if (!CLAIM_KINDS.has(value.kind)) throw new TypeError(`proposals[${index}].kind is invalid`);
  if (!CONFIDENCE_LEVELS.has(value.agentConfidence)) throw new TypeError(`proposals[${index}].agentConfidence is invalid`);
  return {
    content: requiredText(value.content, `proposals[${index}].content`),
    kind: value.kind,
    supportingEvidence: stringList(value.supportingEvidence, `proposals[${index}].supportingEvidence`),
    contradictingEvidence: stringList(value.contradictingEvidence, `proposals[${index}].contradictingEvidence`),
    agentConfidence: value.agentConfidence,
  };
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_asset_claims",
    description: "提交 Candidate Claim。此工具只返回待用户审核的 Agent 推断，不会接受 Claim、声明用户署名或写入长期知识。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        baseWorkspaceRevision: { type: "number" },
        intentRevision: { type: "number" },
        proposals: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "可审核的单一结论，不得把推断写成事实" },
              kind: { type: "string", enum: ["inference", "hypothesis", "recommendation", "synthesis"] },
              supportingEvidence: { type: "array", items: { type: "string" } },
              contradictingEvidence: { type: "array", items: { type: "string" } },
              agentConfidence: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["content", "kind", "supportingEvidence", "contradictingEvidence", "agentConfidence"],
          },
        },
      },
      required: ["assetId", "baseWorkspaceRevision", "intentRevision", "proposals"],
    },
    output: textOutput("Candidate Claims awaiting the Claim Gate"),
    execute: async (args) => {
      if (!Array.isArray(args.proposals) || args.proposals.length === 0 || args.proposals.length > 20) {
        throw new TypeError("proposals must contain between 1 and 20 items");
      }
      return JSON.stringify({
        assetId: requiredText(args.assetId, "assetId"),
        baseWorkspaceRevision: args.baseWorkspaceRevision,
        intentRevision: args.intentRevision,
        proposals: args.proposals.map(normalizeClaim),
        authorship: "agent",
        requiresClaimGate: true,
      });
    },
  });
}
