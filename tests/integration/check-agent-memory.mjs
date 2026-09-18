import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function source(path) {
  return readFile(resolve(workspaceRoot, path), 'utf8')
}

function includesAll(value, path, markers) {
  for (const marker of markers) {
    assert.ok(value.includes(marker), `${path} is missing Agent Memory integration marker: ${marker}`)
  }
}

export async function checkAgentMemoryIntegration() {
  const files = {
    bff: await source('bff/src/index.js'),
    bffTest: await source('bff/test/index.test.js'),
    app: await source('seagull-ui/src/App.tsx'),
    modules: await source('seagull-ui/src/config/modules.ts'),
    chat: await source('seagull-ui/src/pages/ChatPage.tsx'),
    message: await source('seagull-ui/src/components/ChatMessage.tsx'),
    api: await source('seagull-ui/src/lib/api/agent-memory.ts'),
    page: await source('seagull-ui/src/pages/AgentMemoryPage.tsx'),
  }

  includesAll(files.bff, 'bff/src/index.js', [
    'AgentMemoryStore',
    'agentMemoryStore.recall(user.id',
    'formatAgentMemoryContext(recalled.memories)',
    '/api/harness/memory-candidates',
    '/api/harness/memory-recalls',
    '/api/harness/memories',
  ])
  includesAll(files.bffTest, 'bff/test/index.test.js', [
    'candidate.status, "pending"',
    'agentMemory.status, "active"',
    'explicitly confirmed by the user',
    '/archive',
    '/restore',
  ])
  includesAll(files.app, 'seagull-ui/src/App.tsx', ['AgentMemoryPage', 'path="/agent-memory"'])
  includesAll(files.modules, 'seagull-ui/src/config/modules.ts', ['id: "agent-memory"', 'route: "/agent-memory"'])
  includesAll(files.chat, 'seagull-ui/src/pages/ChatPage.tsx', [
    'onRemember=',
    'agentMemoryApi.propose',
    'agentMemoryApi.accept',
  ])
  includesAll(files.message, 'seagull-ui/src/components/ChatMessage.tsx', ['onRemember?:', '/>Remember'])
  includesAll(files.api, 'seagull-ui/src/lib/api/agent-memory.ts', [
    'memory-candidates',
    'memory-recalls',
    '/archive',
    '/restore',
  ])
  includesAll(files.page, 'seagull-ui/src/pages/AgentMemoryPage.tsx', [
    'Pending candidates',
    'Recent recall audit',
    'Why used:',
    'agentMemoryApi.delete',
  ])

  return { checked: Object.keys(files).length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkAgentMemoryIntegration()
  console.log(JSON.stringify({ ok: true, ...result }))
}
