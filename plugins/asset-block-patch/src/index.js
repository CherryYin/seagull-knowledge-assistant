export const name = "asset-block-patch";

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function normalizeReferences(value) {
  const references = value && typeof value === "object" ? value : {};
  const strings = (items) => Array.isArray(items) ? items.filter((item) => typeof item === "string") : [];
  return {
    sourceRefs: strings(references.sourceRefs),
    noteRefs: strings(references.noteRefs),
    wikiRefs: strings(references.wikiRefs),
    webUrls: strings(references.webUrls),
  };
}

function normalizeStrings(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))] : [];
}

function normalizeDocumentBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (typeof item.blockId !== "string" || typeof item.baseRevision !== "number" || typeof item.replacementMarkdown !== "string") return [];
    return [{
      blockId: item.blockId,
      baseRevision: item.baseRevision,
      replacementMarkdown: item.replacementMarkdown,
      claimRefs: normalizeStrings(item.claimRefs),
    }];
  });
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_asset_block_patch",
    description: "提交单个 Asset Block 的候选修改。此工具只生成待用户确认的结构化提案，不会写入 Asset 或 PKG。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "当前 Asset ID" },
        blockId: { type: "string", description: "当前 Block ID" },
        baseRevision: { type: "number", description: "发起修改时的 Block revision" },
        replacementMarkdown: { type: "string", description: "只包含该 Block 的完整替换 Markdown" },
        explanation: { type: "string", description: "简短说明修改意图与关键变化" },
        claimRefs: { type: "array", items: { type: "string" }, description: "该 Block 表达的 Accepted Claim 或保留 Hypothesis ID" },
        addedReferences: {
          type: "object",
          properties: {
            sourceRefs: { type: "array", items: { type: "string" } },
            noteRefs: { type: "array", items: { type: "string" } },
            wikiRefs: { type: "array", items: { type: "string" } },
            webUrls: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["assetId", "blockId", "baseRevision", "replacementMarkdown"],
    },
    output: textOutput("Structured Asset Block patch proposal awaiting explicit user confirmation"),
    execute: async (args) => JSON.stringify({
      assetId: args.assetId,
      blockId: args.blockId,
      baseRevision: args.baseRevision,
      replacementMarkdown: args.replacementMarkdown,
      ...(typeof args.explanation === "string" && args.explanation.trim() ? { explanation: args.explanation.trim() } : {}),
      ...(Array.isArray(args.claimRefs) ? { claimRefs: normalizeStrings(args.claimRefs) } : {}),
      addedReferences: normalizeReferences(args.addedReferences),
      requiresUserConfirmation: true,
    }),
  });

  ctx.tools.register({
    name: "propose_asset_document_patch",
    description: "提交完整 Asset 的候选优化补丁。此工具只返回待用户确认的标题、摘要和 Block 修改，不会写入 Asset 或 PKG。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "当前 Asset ID" },
        baseWorkspaceRevision: { type: "number", description: "发起优化时的 Workspace revision" },
        replacementTitle: { type: "string", description: "优化后的 Asset 标题" },
        replacementBrief: { type: "string", description: "优化后的 Asset 摘要" },
        explanation: { type: "string", description: "简短说明整篇优化策略与关键变化" },
        blocks: {
          type: "array",
          description: "发生变化的 Block 补丁；未包含的 Block 保持不变，可为空",
          items: {
            type: "object",
            properties: {
              blockId: { type: "string", description: "原 Block ID" },
              baseRevision: { type: "number", description: "原 Block revision" },
              replacementMarkdown: { type: "string", description: "该 Block 的完整替换 Markdown" },
              claimRefs: { type: "array", items: { type: "string" }, description: "该 Block 表达的 Accepted Claim 或保留 Hypothesis ID" },
            },
            required: ["blockId", "baseRevision", "replacementMarkdown", "claimRefs"],
          },
        },
      },
      required: ["assetId", "baseWorkspaceRevision", "replacementTitle", "replacementBrief", "blocks"],
    },
    output: textOutput("Structured full Asset optimization proposal awaiting explicit user confirmation"),
    execute: async (args) => JSON.stringify({
      assetId: args.assetId,
      baseWorkspaceRevision: args.baseWorkspaceRevision,
      replacementTitle: typeof args.replacementTitle === "string" ? args.replacementTitle.trim() : "",
      replacementBrief: typeof args.replacementBrief === "string" ? args.replacementBrief.trim() : "",
      ...(typeof args.explanation === "string" && args.explanation.trim() ? { explanation: args.explanation.trim() } : {}),
      blocks: normalizeDocumentBlocks(args.blocks),
      requiresUserConfirmation: true,
      writesAsset: false,
    }),
  });
}
