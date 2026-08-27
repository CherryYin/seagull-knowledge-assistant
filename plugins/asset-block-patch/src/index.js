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
      addedReferences: normalizeReferences(args.addedReferences),
      requiresUserConfirmation: true,
    }),
  });
}
