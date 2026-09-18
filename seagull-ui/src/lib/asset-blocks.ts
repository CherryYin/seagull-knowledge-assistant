export type AssetBlockType = "heading" | "paragraph" | "list" | "quote" | "code" | "table" | "divider";

export interface AssetBlock {
  id: string;
  type: AssetBlockType;
  markdown: string;
  revision: number;
  claimRefs: string[];
}

export interface AssetDocument {
  schemaVersion: 1;
  blocks: Array<Omit<AssetBlock, "claimRefs"> & { claim_refs: string[] }>;
  updatedAt: string;
}

function blockType(markdown: string): AssetBlockType {
  const firstLine = markdown.trimStart().split("\n", 1)[0] ?? "";
  if (/^#{1,6}\s+/.test(firstLine)) return "heading";
  if (/^(```|~~~)/.test(firstLine)) return "code";
  if (/^>\s?/.test(firstLine)) return "quote";
  if (/^(?:[-+*]|\d+[.)])\s+/.test(firstLine)) return "list";
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(firstLine)) return "divider";
  const lines = markdown.split("\n");
  if (lines.length > 1 && lines[0].includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[1])) return "table";
  return "paragraph";
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function newBlockId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `block-${crypto.randomUUID()}`
    : `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function parseAssetBlocks(content?: string | null): AssetBlock[] {
  if (!content?.trim()) return [];
  const rawBlocks: string[] = [];
  let lines: string[] = [];
  let fence: "```" | "~~~" | null = null;

  const flush = () => {
    const markdown = lines.join("\n").trim();
    if (markdown) rawBlocks.push(markdown);
    lines = [];
  };

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const fenceMatch = line.match(/^\s*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
    if (fence) {
      lines.push(line);
      if (fenceMatch === fence) {
        flush();
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch;
      lines.push(line);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      rawBlocks.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    lines.push(line);
  }
  flush();

  const occurrences = new Map<string, number>();
  return rawBlocks.map((markdown) => {
    const hash = stableHash(markdown);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    return {
      id: `block-${hash}-${occurrence}`,
      type: blockType(markdown),
      markdown,
      revision: 1,
      claimRefs: [],
    };
  });
}

export function serializeAssetBlocks(blocks: AssetBlock[]) {
  return blocks.map((block) => block.markdown.trim()).filter(Boolean).join("\n\n").trim();
}

export function reconcileAssetBlocks(previousBlocks: AssetBlock[], content: string) {
  const parsedBlocks = parseAssetBlocks(content);
  const availableByMarkdown = new Map<string, AssetBlock[]>();
  for (const block of previousBlocks) {
    const key = block.markdown.trim();
    availableByMarkdown.set(key, [...(availableByMarkdown.get(key) ?? []), block]);
  }
  const usedIds = new Set<string>();
  return parsedBlocks.map((parsedBlock, index) => {
    const exact = (availableByMarkdown.get(parsedBlock.markdown.trim()) ?? [])
      .find((block) => !usedIds.has(block.id));
    if (exact) {
      usedIds.add(exact.id);
      return exact;
    }
    const positional = previousBlocks[index];
    if (positional && !usedIds.has(positional.id)) {
      usedIds.add(positional.id);
      return updateAssetBlock(positional, parsedBlock.markdown);
    }
    return createAssetBlock(parsedBlock.markdown);
  });
}

export function locateAssetBlockSelection(blocks: AssetBlock[], start: number, end: number) {
  let offset = 0;
  for (const block of blocks) {
    const markdown = block.markdown.trim();
    const blockStart = offset;
    const blockEnd = blockStart + markdown.length;
    if (start >= blockStart && end <= blockEnd) {
      return {
        block,
        selectedText: markdown.slice(start - blockStart, end - blockStart),
      };
    }
    offset = blockEnd + 2;
  }
  return null;
}

export function locateAssetBlockRange(blocks: AssetBlock[], blockId: string) {
  let offset = 0;
  for (const block of blocks) {
    const markdown = block.markdown.trim();
    const start = offset;
    const end = start + markdown.length;
    if (block.id === blockId) return { block, start, end };
    offset = end + 2;
  }
  return null;
}

function isAssetBlock(value: unknown): value is AssetBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return typeof block.id === "string"
    && typeof block.type === "string"
    && typeof block.markdown === "string"
    && typeof block.revision === "number"
    && (block.claim_refs === undefined || Array.isArray(block.claim_refs))
    && (block.claimRefs === undefined || Array.isArray(block.claimRefs));
}

export function hasStableAssetDocument(metadata: Record<string, unknown> | null | undefined) {
  const document = metadata?.asset_document;
  if (!document || typeof document !== "object") return false;
  const candidate = document as Record<string, unknown>;
  return candidate.schemaVersion === 1
    && Array.isArray(candidate.blocks)
    && candidate.blocks.length > 0
    && candidate.blocks.every(isAssetBlock);
}

export function loadAssetBlocks(metadata: Record<string, unknown> | null | undefined, draftContent?: string | null) {
  const document = metadata?.asset_document;
  if (document && typeof document === "object") {
    const candidate = document as Record<string, unknown>;
    if (candidate.schemaVersion === 1 && Array.isArray(candidate.blocks) && candidate.blocks.every(isAssetBlock)) {
      const blocks = (candidate.blocks as Array<AssetBlock & { claim_refs?: unknown }>).map((block) => ({
        id: block.id,
        type: block.type,
        markdown: block.markdown,
        revision: block.revision,
        claimRefs: Array.isArray(block.claim_refs)
          ? block.claim_refs.filter((claimId): claimId is string => typeof claimId === "string")
          : Array.isArray(block.claimRefs) ? block.claimRefs.filter((claimId): claimId is string => typeof claimId === "string") : [],
      }));
      if (serializeAssetBlocks(blocks) === (draftContent ?? "").trim()) return blocks;
    }
  }
  return parseAssetBlocks(draftContent);
}

export function createAssetDocument(blocks: AssetBlock[]): AssetDocument {
  return {
    schemaVersion: 1,
    blocks: blocks.map(({ claimRefs, ...block }) => ({ ...block, claim_refs: claimRefs })),
    updatedAt: new Date().toISOString(),
  };
}

export function createAssetBlock(markdown = ""): AssetBlock {
  return { id: newBlockId(), type: blockType(markdown), markdown, revision: 1, claimRefs: [] };
}

export function updateAssetBlock(block: AssetBlock, markdown: string): AssetBlock {
  return {
    ...block,
    type: blockType(markdown),
    markdown,
    revision: block.revision + 1,
  };
}

export function updateAssetBlockClaimRefs(block: AssetBlock, claimRefs: string[]): AssetBlock {
  return {
    ...block,
    claimRefs: [...new Set(claimRefs)],
    revision: block.revision + 1,
  };
}
