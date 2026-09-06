export const name = "asset-knowledge-proposal";

const CONTRIBUTION_KINDS = new Set(["user_viewpoint", "synthesis", "decision", "framework", "hypothesis", "wiki_correction"]);
const CANDIDATE_TYPES = new Set(["note", "wiki"]);
const ACTIONS = new Set(["create", "update"]);

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
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${field} must be a non-empty array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeContribution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("contribution must be an object");
  if (!CONTRIBUTION_KINDS.has(value.kind)) throw new TypeError("contribution.kind is invalid");
  return {
    kind: value.kind,
    summary: requiredText(value.summary, "contribution.summary"),
    claimRefs: stringList(value.claimRefs, "contribution.claimRefs"),
  };
}

function normalizeCandidate(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`candidates[${index}] must be an object`);
  if (!CANDIDATE_TYPES.has(value.candidateType)) throw new TypeError(`candidates[${index}].candidateType is invalid`);
  if (!ACTIONS.has(value.action)) throw new TypeError(`candidates[${index}].action is invalid`);
  if (value.candidateType === "note" && value.action !== "create") throw new TypeError("Note Candidate only supports create");
  const targetWikiId = typeof value.targetWikiId === "string" && value.targetWikiId.trim() ? value.targetWikiId.trim() : null;
  if (value.candidateType === "wiki" && value.action === "update" && !targetWikiId) {
    throw new TypeError(`candidates[${index}].targetWikiId is required for Wiki update`);
  }
  return {
    candidateType: value.candidateType,
    action: value.action,
    targetWikiId,
    title: requiredText(value.title, `candidates[${index}].title`),
    content: requiredText(value.content, `candidates[${index}].content`),
    claimRefs: stringList(value.claimRefs, `candidates[${index}].claimRefs`),
  };
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_asset_knowledge",
    description: "提交 Asset Contribution 与 Note/Wiki Candidate。只生成待用户审核的候选，不声明 user_insight，不写入正式 Note/Wiki。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        baseWorkspaceRevision: { type: "number" },
        contribution: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...CONTRIBUTION_KINDS] },
            summary: { type: "string" },
            claimRefs: { type: "array", minItems: 1, items: { type: "string" } },
          },
          required: ["kind", "summary", "claimRefs"],
        },
        candidates: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              candidateType: { type: "string", enum: ["note", "wiki"] },
              action: { type: "string", enum: ["create", "update"] },
              targetWikiId: { type: ["string", "null"] },
              title: { type: "string" },
              content: { type: "string" },
              claimRefs: { type: "array", minItems: 1, items: { type: "string" } },
            },
            required: ["candidateType", "action", "title", "content", "claimRefs"],
          },
        },
      },
      required: ["assetId", "baseWorkspaceRevision", "contribution", "candidates"],
    },
    output: textOutput("Asset Contribution and Knowledge Candidates awaiting user decisions"),
    execute: async (args) => {
      if (!Array.isArray(args.candidates) || args.candidates.length > 10) {
        throw new TypeError("candidates must be an array with at most 10 items");
      }
      return JSON.stringify({
        assetId: requiredText(args.assetId, "assetId"),
        baseWorkspaceRevision: args.baseWorkspaceRevision,
        contribution: normalizeContribution(args.contribution),
        candidates: args.candidates.map(normalizeCandidate),
        authorship: "agent",
        requiresContributionGate: true,
        requiresKnowledgePromotionGate: true,
        writesLongTermKnowledge: false,
      });
    },
  });
}
