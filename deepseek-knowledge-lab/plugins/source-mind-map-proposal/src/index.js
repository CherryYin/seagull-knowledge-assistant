export const name = "source-mind-map-proposal";

export const SOURCE_MIND_MAP_INPUT_LIMITS = Object.freeze({
  maxNodes: 32,
  maxSectionSummaries: 40,
  maxChunkSummaries: 80,
  maxSummaryCharacters: 60_000,
});

const NODE_KINDS = new Set(["topic", "section", "concept", "claim", "evidence", "knowledge", "question"]);
const FACTUAL_NODE_KINDS = new Set(["claim", "evidence", "knowledge"]);
const RELATIONS = new Set(["derived_from", "represents", "supports", "contradicts", "elaborates", "navigates_to"]);
const TEMP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_INPUT_FIELDS = new Set(["raw_content", "pdf_base64", "file_bytes", "full_text"]);

const sectionSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 300 },
    summary: { type: "string", maxLength: 2000 },
    chunk_ids: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "integer", minimum: 1 },
    },
  },
  required: ["title", "summary", "chunk_ids"],
};

const chunkSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    chunk_id: { type: "integer", minimum: 1 },
    chunk_index: { type: "integer", minimum: 0 },
    summary: { type: "string", maxLength: 1200 },
    page: { type: ["integer", "null"], minimum: 1 },
  },
  required: ["chunk_id", "chunk_index", "summary"],
};

const proposalNodeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    temp_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 100 },
    parent_temp_id: {
      type: ["string", "null"],
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      maxLength: 100,
    },
    position: { type: "integer", minimum: 0 },
    content: { type: "string", maxLength: 2000 },
    note: { type: ["string", "null"], maxLength: 10000 },
    node_kind: {
      type: "string",
      enum: ["topic", "section", "concept", "claim", "evidence", "knowledge", "question"],
    },
  },
  required: ["temp_id", "parent_temp_id", "position", "content", "node_kind"],
};

const proposalReferenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    node_temp_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 100 },
    chunk_id: { type: "integer", minimum: 1 },
    relation: {
      type: "string",
      enum: ["derived_from", "represents", "supports", "contradicts", "elaborates", "navigates_to"],
    },
    fragment_selector: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        page: { type: ["integer", "null"], minimum: 1 },
        quote: { type: ["string", "null"], maxLength: 500 },
      },
    },
  },
  required: ["node_temp_id", "chunk_id", "relation"],
};

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function rejectUnknownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${field} contains unsupported fields: ${unknown.join(", ")}`);
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maxLength);
}

function integer(value, field, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${field} must be an integer >= ${minimum}`);
  return value;
}

function normalizeBasis(value) {
  const basis = objectValue(value, "basis_revision");
  rejectUnknownKeys(basis, new Set(["source_content_hash", "chunk_count", "chunk_revision"]), "basis_revision");
  return {
    source_content_hash: optionalText(basis.source_content_hash, "basis_revision.source_content_hash", 128),
    chunk_count: integer(basis.chunk_count, "basis_revision.chunk_count", 1),
    chunk_revision: basis.chunk_revision === undefined || basis.chunk_revision === null
      ? null
      : integer(basis.chunk_revision, "basis_revision.chunk_revision"),
  };
}

function normalizeInputSummary(value) {
  const input = objectValue(value, "input_summary");
  const forbidden = Object.keys(input).filter((key) => FORBIDDEN_INPUT_FIELDS.has(key));
  if (forbidden.length) throw new TypeError(`input_summary cannot contain raw PDF fields: ${forbidden.join(", ")}`);
  rejectUnknownKeys(input, new Set(["section_summaries", "chunk_summaries"]), "input_summary");
  const sections = input.section_summaries ?? [];
  const chunks = input.chunk_summaries;
  if (!Array.isArray(sections) || sections.length > SOURCE_MIND_MAP_INPUT_LIMITS.maxSectionSummaries) {
    throw new TypeError(`section_summaries must contain at most ${SOURCE_MIND_MAP_INPUT_LIMITS.maxSectionSummaries} items`);
  }
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > SOURCE_MIND_MAP_INPUT_LIMITS.maxChunkSummaries) {
    throw new TypeError(`chunk_summaries must contain between 1 and ${SOURCE_MIND_MAP_INPUT_LIMITS.maxChunkSummaries} items`);
  }
  let summaryCharacters = 0;
  const normalizedSections = sections.map((item, index) => {
    const section = objectValue(item, `section_summaries[${index}]`);
    rejectUnknownKeys(section, new Set(["title", "summary", "chunk_ids"]), `section_summaries[${index}]`);
    if (!Array.isArray(section.chunk_ids) || section.chunk_ids.length < 1 || section.chunk_ids.length > 50) {
      throw new TypeError(`section_summaries[${index}].chunk_ids must contain between 1 and 50 items`);
    }
    const title = requiredText(section.title, `section_summaries[${index}].title`, 300);
    const summary = requiredText(section.summary, `section_summaries[${index}].summary`, 2000);
    summaryCharacters += title.length + summary.length;
    return {
      title,
      summary,
      chunk_ids: section.chunk_ids.map((chunkId, chunkIndex) => integer(
        chunkId,
        `section_summaries[${index}].chunk_ids[${chunkIndex}]`,
        1,
      )),
    };
  });
  const seenChunkIds = new Set();
  const normalizedChunks = chunks.map((item, index) => {
    const chunk = objectValue(item, `chunk_summaries[${index}]`);
    rejectUnknownKeys(chunk, new Set(["chunk_id", "chunk_index", "summary", "page"]), `chunk_summaries[${index}]`);
    const chunkId = integer(chunk.chunk_id, `chunk_summaries[${index}].chunk_id`, 1);
    if (seenChunkIds.has(chunkId)) throw new TypeError(`chunk_summaries contains duplicate chunk_id ${chunkId}`);
    seenChunkIds.add(chunkId);
    const summary = requiredText(chunk.summary, `chunk_summaries[${index}].summary`, 1200);
    summaryCharacters += summary.length;
    return {
      chunk_id: chunkId,
      chunk_index: integer(chunk.chunk_index, `chunk_summaries[${index}].chunk_index`),
      summary,
      ...(chunk.page === undefined || chunk.page === null
        ? {}
        : { page: integer(chunk.page, `chunk_summaries[${index}].page`, 1) }),
    };
  });
  if (summaryCharacters > SOURCE_MIND_MAP_INPUT_LIMITS.maxSummaryCharacters) {
    throw new TypeError(`input summaries exceed ${SOURCE_MIND_MAP_INPUT_LIMITS.maxSummaryCharacters} characters`);
  }
  for (const [index, section] of normalizedSections.entries()) {
    const missing = section.chunk_ids.filter((chunkId) => !seenChunkIds.has(chunkId));
    if (missing.length) throw new TypeError(`section_summaries[${index}] references unavailable chunks: ${missing.join(", ")}`);
  }
  return {
    section_summaries: normalizedSections,
    chunk_summaries: normalizedChunks,
    availableChunks: new Map(normalizedChunks.map((chunk) => [chunk.chunk_id, chunk])),
  };
}

function normalizeNode(value, index) {
  const node = objectValue(value, `proposal.nodes[${index}]`);
  rejectUnknownKeys(node, new Set(["temp_id", "parent_temp_id", "position", "content", "note", "node_kind"]), `proposal.nodes[${index}]`);
  const tempId = requiredText(node.temp_id, `proposal.nodes[${index}].temp_id`, 100);
  if (!TEMP_ID.test(tempId)) throw new TypeError(`proposal.nodes[${index}].temp_id is invalid`);
  const parentTempId = optionalText(node.parent_temp_id, `proposal.nodes[${index}].parent_temp_id`, 100);
  if (parentTempId !== null && !TEMP_ID.test(parentTempId)) throw new TypeError(`proposal.nodes[${index}].parent_temp_id is invalid`);
  if (!NODE_KINDS.has(node.node_kind)) throw new TypeError(`proposal.nodes[${index}].node_kind is invalid`);
  return {
    temp_id: tempId,
    parent_temp_id: parentTempId,
    position: integer(node.position, `proposal.nodes[${index}].position`),
    content: requiredText(node.content, `proposal.nodes[${index}].content`, 2000),
    note: optionalText(node.note, `proposal.nodes[${index}].note`, 10000),
    node_kind: node.node_kind,
  };
}

function normalizeReference(value, index, availableChunks) {
  const reference = objectValue(value, `proposal.references[${index}]`);
  rejectUnknownKeys(reference, new Set(["node_temp_id", "chunk_id", "relation", "fragment_selector"]), `proposal.references[${index}]`);
  const chunkId = integer(reference.chunk_id, `proposal.references[${index}].chunk_id`, 1);
  const availableChunk = availableChunks?.get(chunkId);
  if (availableChunks && !availableChunk) throw new TypeError(`proposal.references[${index}].chunk_id is not present in input_summary`);
  if (!RELATIONS.has(reference.relation)) throw new TypeError(`proposal.references[${index}].relation is invalid`);
  let fragmentSelector;
  if (reference.fragment_selector !== undefined && reference.fragment_selector !== null) {
    const selector = objectValue(reference.fragment_selector, `proposal.references[${index}].fragment_selector`);
    rejectUnknownKeys(selector, new Set(["page", "quote"]), `proposal.references[${index}].fragment_selector`);
    const page = selector.page === undefined || selector.page === null
      ? null
      : integer(selector.page, `proposal.references[${index}].fragment_selector.page`, 1);
    const quote = optionalText(selector.quote, `proposal.references[${index}].fragment_selector.quote`, 500);
    if (page === null && quote === null) throw new TypeError(`proposal.references[${index}].fragment_selector requires page or quote`);
    if (page !== null && availableChunk?.page !== undefined && page !== availableChunk.page) {
      throw new TypeError(`proposal.references[${index}].fragment_selector.page does not match the supplied Chunk summary`);
    }
    if (quote !== null && availableChunk && !availableChunk.summary.includes(quote)) {
      throw new TypeError(`proposal.references[${index}].fragment_selector.quote is not present in the supplied Chunk summary`);
    }
    fragmentSelector = { ...(page === null ? {} : { page }), ...(quote === null ? {} : { quote }) };
  }
  const nodeTempId = requiredText(reference.node_temp_id, `proposal.references[${index}].node_temp_id`, 100);
  if (!TEMP_ID.test(nodeTempId)) throw new TypeError(`proposal.references[${index}].node_temp_id is invalid`);
  return {
    node_temp_id: nodeTempId,
    chunk_id: chunkId,
    relation: reference.relation,
    ...(fragmentSelector ? { fragment_selector: fragmentSelector } : {}),
  };
}

function normalizeProposal(value, availableChunks) {
  const proposal = objectValue(value, "proposal");
  rejectUnknownKeys(proposal, new Set(["title", "layout_mode", "nodes", "references"]), "proposal");
  if (!Array.isArray(proposal.nodes) || proposal.nodes.length < 1 || proposal.nodes.length > SOURCE_MIND_MAP_INPUT_LIMITS.maxNodes) {
    throw new TypeError(`proposal.nodes must contain between 1 and ${SOURCE_MIND_MAP_INPUT_LIMITS.maxNodes} items`);
  }
  const nodes = proposal.nodes.map(normalizeNode);
  const references = proposal.references ?? [];
  if (!Array.isArray(references)) throw new TypeError("proposal.references must be an array");
  const normalizedReferences = references.map((reference, index) => normalizeReference(reference, index, availableChunks));
  const nodeById = new Map();
  const siblingPositions = new Set();
  for (const node of nodes) {
    if (nodeById.has(node.temp_id)) throw new TypeError(`proposal contains duplicate node temp_id ${node.temp_id}`);
    nodeById.set(node.temp_id, node);
    const siblingKey = `${node.parent_temp_id ?? "<root>"}:${node.position}`;
    if (siblingPositions.has(siblingKey)) throw new TypeError("proposal sibling positions must be unique");
    siblingPositions.add(siblingKey);
  }
  const roots = nodes.filter((node) => node.parent_temp_id === null);
  if (roots.length !== 1) throw new TypeError("proposal must contain exactly one root node");
  if (roots[0].node_kind !== "topic") throw new TypeError("proposal root node must use node_kind topic");
  for (const node of nodes) {
    if (node.parent_temp_id !== null && !nodeById.has(node.parent_temp_id)) {
      throw new TypeError(`proposal node ${node.temp_id} references a missing parent`);
    }
    const visited = new Set();
    let current = node;
    while (current.parent_temp_id !== null) {
      if (visited.has(current.temp_id)) throw new TypeError("proposal contains a cycle");
      visited.add(current.temp_id);
      current = nodeById.get(current.parent_temp_id);
    }
  }
  const referenceKeys = new Set();
  const referencedNodeIds = new Set();
  for (const reference of normalizedReferences) {
    if (!nodeById.has(reference.node_temp_id)) throw new TypeError("proposal reference targets a missing node");
    const key = `${reference.node_temp_id}:${reference.chunk_id}:${reference.relation}`;
    if (referenceKeys.has(key)) throw new TypeError("proposal contains a duplicate reference");
    referenceKeys.add(key);
    referencedNodeIds.add(reference.node_temp_id);
  }
  const unreferencedFacts = nodes
    .filter((node) => FACTUAL_NODE_KINDS.has(node.node_kind) && !referencedNodeIds.has(node.temp_id))
    .map((node) => node.temp_id);
  if (unreferencedFacts.length) throw new TypeError(`factual proposal nodes require chunk references: ${unreferencedFacts.join(", ")}`);
  const layoutMode = proposal.layout_mode === undefined ? "balanced" : proposal.layout_mode;
  if (!new Set(["balanced", "right"]).has(layoutMode)) throw new TypeError("proposal.layout_mode is invalid");
  return {
    title: requiredText(proposal.title, "proposal.title", 300),
    layout_mode: layoutMode,
    nodes,
    references: normalizedReferences,
  };
}

export function normalizeSourceMindMapProposal(args) {
  const value = objectValue(args, "arguments");
  rejectUnknownKeys(value, new Set(["source_id", "basis_revision", "input_summary", "proposal", "map_id", "base_version", "target_node_id"]), "arguments");
  const inputSummary = value.input_summary === undefined
    ? null
    : normalizeInputSummary(value.input_summary);
  const mapId = optionalText(value.map_id, "map_id", 200);
  const baseVersion = value.base_version === undefined || value.base_version === null
    ? null
    : integer(value.base_version, "base_version", 1);
  const targetNodeId = optionalText(value.target_node_id, "target_node_id", 200);
  if (targetNodeId !== null && (mapId === null || baseVersion === null)) {
    throw new TypeError("branch proposals require map_id, base_version, and target_node_id");
  }
  return {
    source_id: requiredText(value.source_id, "source_id", 200),
    basis_revision: normalizeBasis(value.basis_revision),
    proposal: normalizeProposal(value.proposal, inputSummary?.availableChunks),
    ...(mapId === null ? {} : { map_id: mapId }),
    ...(baseVersion === null ? {} : { base_version: baseVersion }),
    ...(targetNodeId === null ? {} : { target_node_id: targetNodeId }),
  };
}

export function apply(ctx) {
  ctx.tools.register({
    name: "propose_source_mind_map",
    description: "提交 PDF Source Mind Map 候选。无需回显生成上下文；工具只返回待 PKG 验证、待用户确认的 Proposal，不写入 PKG。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_id: { type: "string", description: "当前 PDF Source ID" },
        map_id: { type: "string", description: "分支扩展时的正式 Mind Map ID" },
        base_version: { type: "integer", minimum: 1, description: "分支扩展时的正式 Mind Map 版本" },
        target_node_id: { type: "string", description: "分支扩展锚点节点 ID" },
        basis_revision: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_content_hash: { type: ["string", "null"] },
            chunk_count: { type: "integer", minimum: 1 },
            chunk_revision: { type: ["integer", "null"], minimum: 0 },
          },
          required: ["source_content_hash", "chunk_count", "chunk_revision"],
        },
        input_summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            section_summaries: { type: "array", maxItems: 40, items: sectionSummarySchema },
            chunk_summaries: { type: "array", minItems: 1, maxItems: 80, items: chunkSummarySchema },
          },
          required: ["section_summaries", "chunk_summaries"],
        },
        proposal: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            layout_mode: { type: "string", enum: ["balanced", "right"] },
            nodes: { type: "array", minItems: 1, maxItems: 32, items: proposalNodeSchema },
            references: { type: "array", items: proposalReferenceSchema },
          },
          required: ["title", "layout_mode", "nodes", "references"],
        },
      },
      required: ["source_id", "basis_revision", "proposal"],
    },
    output: textOutput("Structured PDF Source Mind Map proposal awaiting PKG validation and explicit user confirmation"),
    execute: async (args) => JSON.stringify({
      ...normalizeSourceMindMapProposal(args),
      authorship: "agent",
      requiresUserConfirmation: true,
    }),
  });
}
