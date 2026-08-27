import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionContextStore } from '../src/index.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'session-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionContextStore({
    path: join(directory, 'store.json'),
    clock: () => new Date('2026-08-23T08:00:00.000Z'),
  })
  return store
}

const context = {
  kind: 'asset_generation',
  assetDraft: {
    assetType: 'research_brief',
    title: 'Session-bound brief',
    brief: 'Synthesize the selected evidence.',
    audience: 'Architecture reviewers',
    styleNotes: 'Concise.',
    sourceRefs: ['source-1'],
    noteRefs: ['note-1'],
    wikiRefs: [],
  },
}

test('stores and restores one Asset generation context by owner and session', async t => {
  const store = await fixture(t)
  const saved = await store.put('user-1', 'session-1', context)
  assert.equal(saved.workflowId, 'draft-asset')
  assert.equal(saved.updatedAt, '2026-08-23T08:00:00.000Z')
  assert.deepEqual((await store.get('user-1', 'session-1')).assetDraft.sourceRefs, ['source-1'])
  assert.equal(await store.get('user-2', 'session-1'), null)
})

test('replaces a session context without creating a WorkItem lifecycle', async t => {
  const store = await fixture(t)
  await store.put('user-1', 'session-1', context)
  await store.put('user-1', 'session-1', {
    ...context,
    assetDraft: { ...context.assetDraft, title: 'Updated brief' },
  })
  assert.equal((await store.get('user-1', 'session-1')).assetDraft.title, 'Updated brief')
  assert.equal(await store.delete('user-1', 'session-1'), true)
  assert.equal(await store.get('user-1', 'session-1'), null)
})

test('rejects Newsletter and incomplete generation requests', async t => {
  const store = await fixture(t)
  await assert.rejects(() => store.put('user-1', 'session-1', {
    ...context,
    assetDraft: { ...context.assetDraft, assetType: 'newsletter_issue' },
  }), /assetType is invalid/)
  await assert.rejects(() => store.put('user-1', 'session-1', {
    ...context,
    assetDraft: { ...context.assetDraft, audience: '' },
  }), /audience is required/)
})

test('accepts an agent-assisted request with unresolved title, audience, and evidence', async t => {
  const store = await fixture(t)
  const saved = await store.put('user-1', 'session-assisted', {
    kind: 'asset_generation',
    assetDraft: {
      assetType: 'topic_report',
      title: '',
      brief: 'Help me explain why parser quality varies across document types.',
      audience: '',
      styleNotes: '',
      sourceRefs: [],
      noteRefs: [],
      wikiRefs: [],
      intakeMode: 'agent_assisted',
      researchMode: 'local_then_web',
    },
  })
  assert.equal(saved.assetDraft.title, '')
  assert.equal(saved.assetDraft.audience, '')
  assert.equal(saved.assetDraft.intakeMode, 'agent_assisted')
  assert.equal(saved.assetDraft.researchMode, 'local_then_web')
})
