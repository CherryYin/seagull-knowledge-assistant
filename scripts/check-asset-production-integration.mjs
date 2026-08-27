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
  webProfile: 'deepseek-knowledge-lab/.dsh/profiles/web/cordis.patch.yml',
  pkgDiscoveryApi: 'personal_knowledge_graph/src/pkg/api/discovery.py',
  bff: 'bff/src/index.js',
  harnessApi: 'seagull-ui/src/lib/api/harness.ts',
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
  ])
  includesAll(values.skill, files.skill, [
    'Search PKG first',
    'ask_user_question',
    'call `web_search` at least once',
    'Search for facts; ask for intent.',
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
  includesAll(values.webProfile, files.webProfile, [
    'id: tool-web',
    'disabled: true',
    'plugins/pkg-web-search/src/index.js',
    'inject: [pkg, tools]',
    'plugins/asset-block-patch/src/index.js',
  ])
  includesAll(values.pkgDiscoveryApi, files.pkgDiscoveryApi, [
    '@router.post("/web-search/preview"',
    'search_external_web_results',
    'response_model=list[DiscoveryWebResult]',
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
  includesAll(values.chat, files.chat, [
    'case "question"',
    'questions={pendingQuestion.questions}',
    'answerHarnessQuestion(pendingQuestion.rpcId',
  ])
  includesAll(values.wizard, files.wizard, [
    'intakeMode: "agent_assisted"',
    'researchMode: allowWebResearch ? "local_then_web" : "local_only"',
    'Add optional seed evidence',
    'Start Agent-Assisted Session',
  ])
  includesAll(values.contract, files.contract, [
    'call ask_user_question',
    'Search PKG before drafting',
    'call web_search at least once',
  ])
  includesAll(values.save, files.save, [
    'collectInlineKnowledgeReferences',
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
  ])

  return { checked: Object.keys(files).length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkAssetProductionIntegration()
  console.log(JSON.stringify({ ok: true, ...result }))
}
