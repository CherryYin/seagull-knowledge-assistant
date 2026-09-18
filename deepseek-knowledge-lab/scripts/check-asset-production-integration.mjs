import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(labRoot, '..')

async function source(path) {
  return readFile(resolve(workspaceRoot, path), 'utf8')
}

function includesAll(value, path, markers) {
  for (const marker of markers) {
    assert.ok(value.includes(marker), `${path} is missing Asset production marker: ${marker}`)
  }
}

const files = {
  preset: 'deepseek-knowledge-lab/.dsh/.agent-presets/draft-asset/agent.cordis.yml',
  skill: 'deepseek-knowledge-lab/.dsh/.agent-presets/draft-asset/skills/asset-production-intake.md',
  pkgClient: 'deepseek-knowledge-lab/plugins/pkg-client/src/index.js',
  pkgWebSearch: 'deepseek-knowledge-lab/plugins/pkg-web-search/src/index.js',
  blockPatch: 'deepseek-knowledge-lab/plugins/asset-block-patch/src/index.js',
  blockPreset: 'deepseek-knowledge-lab/.dsh/.agent-presets/revise-asset-block/agent.cordis.yml',
  blockSkill: 'deepseek-knowledge-lab/.dsh/.agent-presets/revise-asset-block/skills/revise-asset-block.md',
  documentPreset: 'deepseek-knowledge-lab/.dsh/.agent-presets/revise-asset-document/agent.cordis.yml',
  documentSkill: 'deepseek-knowledge-lab/.dsh/.agent-presets/revise-asset-document/skills/revise-asset-document.md',
  knowledgeProposal: 'deepseek-knowledge-lab/plugins/asset-knowledge-proposal/src/index.js',
  intentProposal: 'deepseek-knowledge-lab/plugins/asset-intent-proposal/src/index.js',
  knowledgePreset: 'deepseek-knowledge-lab/.dsh/.agent-presets/distill-asset-knowledge/agent.cordis.yml',
  clarifyIntentPreset: 'deepseek-knowledge-lab/.dsh/.agent-presets/clarify-asset-intent/agent.cordis.yml',
  webProfile: 'deepseek-knowledge-lab/.dsh/profiles/web/cordis.patch.yml',
  pkgDiscoveryApi: 'personal_knowledge_graph/src/pkg/api/discovery.py',
  assetService: 'personal_knowledge_graph/src/pkg/services/application/assets.py',
  assetWorkspaceService: 'personal_knowledge_graph/src/pkg/services/application/asset_workspace.py',
  bff: 'bff/src/index.js',
  harnessApi: 'seagull-ui/src/lib/api/harness.ts',
  assetApi: 'seagull-ui/src/lib/api/assets.ts',
  chat: 'seagull-ui/src/pages/ChatPage.tsx',
  wizard: 'seagull-ui/src/pages/AssetGenerationPage.tsx',
  contract: 'seagull-ui/src/lib/asset-generation.ts',
  save: 'seagull-ui/src/lib/workflow-result-save.ts',
  presentation: 'seagull-ui/src/lib/asset-content.ts',
  blocks: 'seagull-ui/src/lib/asset-blocks.ts',
  detail: 'seagull-ui/src/pages/AssetDetailPage.tsx',
}

export async function checkAssetProductionIntegration() {
  const values = Object.fromEntries(await Promise.all(
    Object.entries(files).map(async ([key, path]) => [key, await source(path)]),
  ))

  includesAll(values.preset, files.preset, [
    '@deepseek-ai/dsh-tool-ask-user',
    'asset-production-intake',
    'web_search',
    '不要向用户输出进度说明、思考过程或完成说明',
    '直接从 H1 标题开始',
  ])
  includesAll(values.skill, files.skill, [
    'Search PKG first',
    'ask_user_question',
    'call `web_search` at least once',
    'Search for facts; ask for intent.',
    'Keep analysis, planning, search narration, and tool-use commentary internal.',
    'Do not add a preface, epilogue, explanation, completion message, or Markdown code fence.',
  ])
  includesAll(values.pkgClient, files.pkgClient, [
    'webSearch(sessionId, query, maxResults)',
    '/discovery/web-search/preview',
  ])
  includesAll(values.pkgWebSearch, files.pkgWebSearch, [
    'name: "web_search"',
    'ctx.pkg.webSearch',
    '不会把搜索结果写入 Discovery',
  ])
  includesAll(values.blockPatch, files.blockPatch, [
    'name: "propose_asset_block_patch"',
    'name: "propose_asset_document_patch"',
    'claimRefs',
    'requiresUserConfirmation: true',
    '不会写入 Asset 或 PKG',
  ])
  includesAll(values.blockPreset, files.blockPreset, [
    'revise-asset-block',
    '@deepseek-ai/dsh-tool-ask-user',
    'propose_asset_block_patch',
  ])
  includesAll(values.blockSkill, files.blockSkill, [
    'ask_user_question',
    'Search PKG first',
    'Call `propose_asset_block_patch` exactly once',
  ])
  includesAll(values.documentPreset, files.documentPreset, [
    'revise-asset-document',
    '@deepseek-ai/dsh-tool-ask-user',
    'propose_asset_document_patch',
  ])
  includesAll(values.documentSkill, files.documentSkill, [
    'accepted Claims',
    '`baseDocumentSignature`',
    '`replacementBlocks`',
    'merge, split, remove, or reorder',
    '`optimizationRound` is greater than 1',
    '`qualityAudit.findings`',
    '`previousOptimization`',
    'Call `propose_asset_document_patch` exactly once',
    'Do not silently apply or save changes',
  ])
  includesAll(values.knowledgeProposal, files.knowledgeProposal, [
    'name: "propose_asset_knowledge"',
    'requiresContributionGate: true',
    'requiresKnowledgePromotionGate: true',
    'writesLongTermKnowledge: false',
  ])
  includesAll(values.intentProposal, files.intentProposal, [
    'name: "propose_asset_intent"',
    'requiresUserConfirmation: true',
    'writesAsset: false',
    '不确认 Intent',
  ])
  includesAll(values.knowledgePreset, files.knowledgePreset, [
    'Accepted Claims',
    'propose_asset_knowledge',
    '不能自行标记',
    '不能创建或更新正式 Note/Wiki',
  ])
  includesAll(values.clarifyIntentPreset, files.clarifyIntentPreset, [
    '即使用户没有填写问题、目标或 Decision',
    '不能把推荐内容冒充为用户已确认',
    'ask_user_question',
    '不要搜索证据、生成正式 Asset',
  ])
  includesAll(values.webProfile, files.webProfile, [
    'id: tool-web',
    'disabled: true',
    'plugins/pkg-web-search/src/index.js',
    'inject: [pkg, tools]',
    'plugins/asset-block-patch/src/index.js',
    'plugins/asset-knowledge-proposal/src/index.js',
    'plugins/asset-intent-proposal/src/index.js',
  ])
  includesAll(values.pkgDiscoveryApi, files.pkgDiscoveryApi, [
    '@router.post("/web-search/preview"',
    'search_external_web_results',
    'response_model=list[DiscoveryWebResult]',
  ])
  includesAll(values.assetService, files.assetService, [
    '_validate_asset_document_claim_refs',
    'asset_workspace_v1',
    'accepted',
    'hypothesis',
  ])
  includesAll(values.assetWorkspaceService, files.assetWorkspaceService, [
    'propose_asset_knowledge',
    'decide_asset_contribution',
    'decide_asset_knowledge_candidate',
    'promote_asset_knowledge_candidate',
    'confirm_overwrite',
    '_add_promotion_embeddings',
    'promoted_at',
  ])
  includesAll(values.bff, files.bff, [
    'frame.type === "question/requested"',
    'rpc_id: envelope.rpcId',
    '/api/harness/questions/respond',
    'type: "client-response"',
  ])
  includesAll(values.harnessApi, files.harnessApi, [
    'type: "session" | "text" | "tool_call" | "tool_result" | "question"',
    'answerHarnessQuestion',
    'rpc_id: rpcId',
  ])
  includesAll(values.assetApi, files.assetApi, [
    'export const reviseAssetIntent',
    'reviseIntent: reviseAssetIntent',
    '/workspace/intent',
  ])
  includesAll(values.chat, files.chat, [
    'case "question"',
    'questions={pendingQuestion.questions}',
    'answerHarnessQuestion(pendingQuestion.rpcId',
    'seagull.chat.input-height',
    'role="separator"',
    'Drag upward to enlarge the Chat input',
    'resize-none overflow-auto',
    'propose_asset_intent',
    'Apply to Asset Form',
    'existing form values will not be overwritten',
  ])
  includesAll(values.wizard, files.wizard, [
    'generation_mode: "agent_assisted"',
    'research_mode: allowWebResearch ? "local_then_web" : "local_only"',
    'Add optional seed evidence',
    'reviseAssetIntent(asset.id',
    'assetsApi.proposeEvidence(asset.id',
    'initialTab: "evidence"',
    'Discuss Intent with Agent',
    'workflowId: "clarify-asset-intent"',
    'Agent proposal applied to previously blank fields',
    'fillBlank',
    'Confirm Intent & Review Evidence',
  ])
  includesAll(values.contract, files.contract, [
    'call ask_user_question',
    'Search PKG before drafting',
    'call web_search at least once',
    'Structured drafting basis',
    'Do not run a new PKG or Web search during drafting',
    'Keep all reasoning, planning, search narration, and tool commentary internal',
    'The response starts directly with the document H1',
  ])
  includesAll(values.save, files.save, [
    'collectInlineKnowledgeReferences',
    'resolvePersistableReferences',
    'generation_mode: assetDraft?.intakeMode === "agent_assisted"',
    'research_mode: assetDraft?.researchMode || null',
  ])
  includesAll(values.presentation, files.presentation, [
    'EDITORIAL_SECTION_HEADINGS',
    'KNOWLEDGE_MARKER_PATTERN',
    'readerMarkdown',
    'editorialMarkdown',
  ])
  includesAll(values.blocks, files.blocks, [
    'AssetBlock',
    'parseAssetBlocks',
    'serializeAssetBlocks',
    'loadAssetBlocks',
    'createAssetDocument',
    'claimRefs',
    'claim_refs',
  ])
  includesAll(values.detail, files.detail, [
    'splitAssetContent',
    'Editorial Evidence Notes',
    'contentPresentation.readerMarkdown',
    'data-asset-block-id',
    'asset_document: createAssetDocument(editBlocks)',
    '让 Agent 修改',
    'answerHarnessQuestion',
    'data-agent-diff-preview',
    '该段在 Agent 工作期间已经发生变化',
    'available_claims',
    'instruction_source',
    'agent_default',
    'Linked Claims',
    'Used by Blocks',
    'Contribution Gate',
    'Knowledge Candidates',
    'No long-term knowledge is written here.',
    'Promote to Note',
    'Create Draft Wiki',
    'Apply Wiki Update',
    'Promotion writes a formal Knowledge Record',
    'propose_asset_document_patch',
    'Optimize Complete Asset',
    'getQualityAudit',
    'optimizationRound',
    'previousOptimization',
    'Run Second-Round Polish',
    'Continue to Claims',
    'Generate Initial Draft',
    'draftBasis',
    'asset_optimization_v1',
    'data-document-agent-diff-preview',
    'You must still use Save Changes below.',
  ])

  return { checked: Object.keys(files).length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkAssetProductionIntegration()
  console.log(JSON.stringify({ ok: true, ...result }))
}
