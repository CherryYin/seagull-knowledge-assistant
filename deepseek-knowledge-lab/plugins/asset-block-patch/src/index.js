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
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item) => {
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

function normalizeReplacementBlocks(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const markdown = item.markdown ?? item.replacementMarkdown ?? item.replacement_markdown;
    if (typeof markdown !== "string" || !markdown.trim()) return [];
    return [{ markdown: markdown.trim(), claimRefs: normalizeStrings(item.claimRefs ?? item.claim_refs) }];
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
        rewriteMode: { type: "string", enum: ["patch_blocks", "replace_document"], description: "局部 Block patch 或完整文档替换" },
        baseDocumentSignature: { type: "string", description: "完整重写开始时的文档签名，必须原样返回" },
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
        replacementBlocks: {
          type: "array",
          description: "replace_document 模式下完整的新文档 Block 列表，可重新组织、合并或减少原 Block",
          items: {
            type: "object",
            properties: {
              markdown: { type: "string", description: "新 Block 的完整 Markdown" },
              claimRefs: { type: "array", items: { type: "string" }, description: "该新 Block 表达的 Accepted Claim 或保留 Hypothesis ID" },
            },
            required: ["markdown", "claimRefs"],
          },
        },
      },
      required: ["assetId", "baseWorkspaceRevision", "replacementTitle", "replacementBrief", "blocks"],
    },
    output: textOutput("Structured full Asset optimization proposal awaiting explicit user confirmation"),
    execute: async (args) => {
      const replacementBlocks = args.rewriteMode === "replace_document"
        ? normalizeReplacementBlocks(args.replacementBlocks)
        : undefined;
      if (args.rewriteMode === "replace_document" && replacementBlocks.length === 0) {
        throw new Error("replace_document requires at least one valid replacement Block");
      }
      return JSON.stringify({
        assetId: args.assetId,
        baseWorkspaceRevision: args.baseWorkspaceRevision,
        replacementTitle: typeof args.replacementTitle === "string" ? args.replacementTitle.trim() : "",
        replacementBrief: typeof args.replacementBrief === "string" ? args.replacementBrief.trim() : "",
        ...(typeof args.rewriteMode === "string" ? { rewriteMode: args.rewriteMode === "replace_document" ? "replace_document" : "patch_blocks" } : {}),
        ...(typeof args.baseDocumentSignature === "string" && args.baseDocumentSignature.trim() ? { baseDocumentSignature: args.baseDocumentSignature.trim() } : {}),
        ...(typeof args.explanation === "string" && args.explanation.trim() ? { explanation: args.explanation.trim() } : {}),
        blocks: normalizeDocumentBlocks(args.blocks),
        ...(replacementBlocks ? { replacementBlocks } : {}),
        requiresUserConfirmation: true,
        writesAsset: false,
      });
    },
  });
}
