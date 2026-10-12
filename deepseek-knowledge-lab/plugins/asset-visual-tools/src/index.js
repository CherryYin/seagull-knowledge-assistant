export const name = "asset-visual-tools";

const ROLES = ["cover", "social_square", "social_portrait", "inline_illustration"];
const STYLE_PRESETS = ["editorial_technology", "minimal_abstract", "research_brief"];

function sessionId(exec) {
  const id = exec?.agent?.session?.id;
  if (!id) throw new Error("Asset visual tool requires an active Harness session");
  return String(id);
}

function requiredText(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function roleSize(role) {
  if (role === "social_square") return "1024*1024";
  if (role === "social_portrait") return "720*1280";
  return "1280*720";
}

function visualContext(args) {
  const role = ROLES.includes(args.role) ? args.role : "cover";
  const sourceBlockIds = Array.isArray(args.source_block_ids)
    ? [...new Set(args.source_block_ids.map((item) => requiredText(item, "source_block_ids item")))]
    : [];
  if (role === "inline_illustration" && sourceBlockIds.length === 0) {
    throw new Error("inline_illustration requires at least one source_block_id");
  }
  return {
    role,
    size: roleSize(role),
    parent_visual_id: typeof args.parent_visual_id === "string" && args.parent_visual_id.trim()
      ? args.parent_visual_id.trim()
      : null,
    source_block_ids: sourceBlockIds,
  };
}

function textOutput(description) {
  return {
    schema: { type: "string", description },
    render: (_args, value) => [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

const contextProperties = {
  role: { type: "string", enum: ROLES, default: "cover" },
  parent_visual_id: {
    type: "string",
    description: "Optional accepted Asset Visual ID used as a same-series redraw reference. This does not crop the parent image.",
  },
  source_block_ids: {
    type: "array",
    items: { type: "string" },
    maxItems: 8,
    description: "Required for inline_illustration. Asset Block IDs that the illustration explains.",
  },
};

const briefSchema = {
  type: "object",
  properties: {
    concept: { type: "string" },
    composition: { type: "string" },
    style: { type: "string" },
    palette: { type: "array", items: { type: "string" }, maxItems: 8 },
    must_include: { type: "array", items: { type: "string" }, maxItems: 8 },
    must_avoid: { type: "array", items: { type: "string" }, maxItems: 12 },
    title_safe_area: { type: "string", enum: ["left", "right", "top", "bottom", "center", "none"] },
    prompt: { type: "string" },
    alt_text: { type: "string" },
  },
  required: ["concept", "composition", "style", "palette", "must_include", "must_avoid", "title_safe_area", "prompt", "alt_text"],
};

export function apply(ctx) {
  if (!ctx.pkg) throw new Error("asset-visual-tools requires the pkg-client service");
  if (!ctx.tools) return;

  ctx.tools.register({
    name: "pkg_plan_asset_visual",
    description: "Plan a reviewable Asset visual with the configured Visual Planner. This returns an editable brief and does not create an image task.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        ...contextProperties,
        style_preset: { type: "string", enum: STYLE_PRESETS, default: "editorial_technology" },
        instructions: { type: "string", description: "Optional art direction, brand colors, mood, or forbidden elements." },
      },
      required: ["asset_id"],
    },
    output: textOutput("Asset Visual Plan JSON. Review or edit the brief before queueing candidates."),
    execute: async (args, exec) => {
      const context = visualContext(args);
      return JSON.stringify(await ctx.pkg.planAssetVisual(
        sessionId(exec),
        requiredText(args.asset_id, "asset_id"),
        {
          ...context,
          style_preset: STYLE_PRESETS.includes(args.style_preset) ? args.style_preset : "editorial_technology",
          instructions: typeof args.instructions === "string" && args.instructions.trim() ? args.instructions.trim() : null,
        },
      ));
    },
  });

  ctx.tools.register({
    name: "pkg_generate_asset_visual_candidates",
    description: "Queue 1-4 reviewable Qwen Image candidates from an approved Visual Brief. This spends image-generation quota but cannot accept, publish, cancel, or delete a visual.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        ...contextProperties,
        style_preset: { type: "string", enum: STYLE_PRESETS },
        candidate_count: { type: "integer", minimum: 1, maximum: 4 },
        style_memory: { type: ["object", "null"] },
        brief: briefSchema,
      },
      required: ["asset_id", "style_preset", "candidate_count", "brief"],
    },
    output: textOutput("Queued Asset Visual candidates. User review in Seagull Production is still required."),
    execute: async (args, exec) => {
      const context = visualContext(args);
      const candidateCount = Number(args.candidate_count);
      if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 4) {
        throw new Error("candidate_count must be an integer from 1 to 4");
      }
      if (!args.brief || typeof args.brief !== "object") throw new Error("brief is required");
      return JSON.stringify(await ctx.pkg.generateAssetVisualCandidates(
        sessionId(exec),
        requiredText(args.asset_id, "asset_id"),
        {
          ...context,
          style_preset: requiredText(args.style_preset, "style_preset"),
          candidate_count: candidateCount,
          style_memory: args.style_memory ?? null,
          brief: args.brief,
        },
      ));
    },
  });

  ctx.tools.register({
    name: "pkg_list_asset_visuals",
    description: "List Asset visual tasks and review states. This is read-only and does not change review decisions.",
    parameters: {
      type: "object",
      properties: { asset_id: { type: "string" } },
      required: ["asset_id"],
    },
    output: textOutput("Asset Visual task list JSON"),
    execute: async (args, exec) => JSON.stringify(await ctx.pkg.listAssetVisuals(
      sessionId(exec),
      requiredText(args.asset_id, "asset_id"),
    )),
  });
}
