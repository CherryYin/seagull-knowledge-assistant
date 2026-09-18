import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function source(path) {
  return readFile(resolve(workspaceRoot, path), 'utf8')
}

function includesAll(value, path, markers) {
  for (const marker of markers) assert.ok(value.includes(marker), `${path} is missing shared Settings marker: ${marker}`)
}

const files = {
  bff: 'bff/src/index.js',
  harnessApi: 'seagull-ui/src/lib/api/harness.ts',
  authApi: 'seagull-ui/src/lib/api/auth.ts',
  pkgAuth: 'personal_knowledge_graph/src/pkg/api/auth.py',
  pkgSchema: 'personal_knowledge_graph/src/pkg/schemas/user.py',
  settings: 'seagull-ui/src/pages/SettingsPage.tsx',
  chat: 'seagull-ui/src/pages/ChatPage.tsx',
  asset: 'seagull-ui/src/pages/AssetDetailPage.tsx',
}

const values = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await source(path)])))

includesAll(values.bff, files.bff, [
  'harnessRpc("llm.models"',
  'harnessRpc("settings.update"',
  'harnessRpc("session.selectModel"',
  '/api/harness/model-settings',
])
includesAll(values.harnessApi, files.harnessApi, ['harnessSettingsApi', '/api/harness/models', '/api/harness/model-settings'])
includesAll(values.authApi, files.authApi, ['PublishingSettings', 'primary_site_url', 'default_channel'])
includesAll(values.pkgAuth, files.pkgAuth, ['/me/settings/publishing', 'update_publishing_settings'])
includesAll(values.pkgSchema, files.pkgSchema, ['PublishingSettingsRead', 'PublishingSettingsUpdate', 'primary_site_url must be a complete HTTP or HTTPS URL'])
includesAll(values.settings, files.settings, ['Save Publishing Defaults', 'Save Harness Default', 'isAdmin'])
includesAll(values.chat, files.chat, ['harnessSettingsApi.listModels()', 'model: activeModel'])
assert.ok(!values.chat.includes('knowledgeApi.models()'), 'Chat must not read its model catalog from PKG')
includesAll(values.asset, files.asset, ['getMyPublishingSettings()', 'Defaulted from Settings'])

console.log(JSON.stringify({ ok: true, checked: Object.keys(files).length }))
