import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentMemoryStore, formatAgentMemoryContext } from '../src/index.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let tick = 0
  let id = 0
  const store = new AgentMemoryStore({
    path: join(directory, 'store.json'),
    clock: () => new Date(Date.UTC(2026, 7, 22, 8, tick++)),
    id: () => `id-${++id}`,
  })
  return { directory, store }
}

const proposal = {
  proposedScopeType: 'project',
  proposedScopeId: 'pkg-simplification',
  proposedKind: 'constraint',
  title: 'Keep PKG writes explicit',
  content: 'Never let the agent autonomously write PKG records.',
  reason: 'The user established this as a durable architecture boundary.',
  provenance: { sessionId: 'session-1', eventIds: ['event-7'], toolCallIds: [] },
}

test('a candidate stays pending until the user explicitly accepts it', async (t) => {
  const { store } = await fixture(t)
  const candidate = await store.propose('user-1', proposal)
  assert.equal(candidate.status, 'pending')
  assert.deepEqual((await store.list('user-1')).memories, [])

  const accepted = await store.accept('user-1', candidate.id, { content: 'PKG writes require a user click.' })
  assert.equal(accepted.candidate.status, 'accepted')
  assert.equal(accepted.memory.status, 'active')
  assert.equal(accepted.memory.content, 'PKG writes require a user click.')
  assert.deepEqual(accepted.memory.provenance, proposal.provenance)
  assert.equal(accepted.memory.confirmedBy, 'user-1')
})

test('pending candidates are editable and reject is terminal', async (t) => {
  const { store } = await fixture(t)
  const candidate = await store.propose('user-1', proposal)
  const edited = await store.updateCandidate('user-1', candidate.id, { title: 'Explicit PKG saves' })
  assert.equal(edited.title, 'Explicit PKG saves')
  assert.equal((await store.reject('user-1', candidate.id)).status, 'rejected')
  await assert.rejects(() => store.accept('user-1', candidate.id), /only pending candidates/)
})

test('archive excludes recall, restore enables it, and delete physically removes it', async (t) => {
  const { store } = await fixture(t)
  const candidate = await store.propose('user-1', proposal)
  const { memory } = await store.accept('user-1', candidate.id)

  assert.equal((await store.recall('user-1', {
    query: 'PKG writes', scopeType: 'project', scopeId: 'pkg-simplification', sessionId: 'session-2',
  })).memories.length, 1)
  await store.archive('user-1', memory.id)
  assert.equal((await store.recall('user-1', {
    query: 'PKG writes', scopeType: 'project', scopeId: 'pkg-simplification', sessionId: 'session-3',
  })).memories.length, 0)
  await store.restore('user-1', memory.id)
  assert.equal((await store.recall('user-1', {
    query: 'PKG writes', scopeType: 'project', scopeId: 'pkg-simplification', sessionId: 'session-4',
  })).memories.length, 1)

  await store.delete('user-1', memory.id)
  assert.deepEqual((await store.list('user-1')).memories, [])
  assert.equal((await store.recall('user-1', {
    query: 'PKG writes', scopeType: 'project', scopeId: 'pkg-simplification', sessionId: 'session-5',
  })).memories.length, 0)
})

test('ownership, provenance, recall audit, and context labeling remain explicit', async (t) => {
  const { store } = await fixture(t)
  const candidate = await store.propose('user-1', proposal)
  const { memory } = await store.accept('user-1', candidate.id)
  await assert.rejects(() => store.archive('user-2', memory.id), /not found/)

  const recalled = await store.recall('user-1', {
    query: 'explicit PKG', scopeType: 'project', scopeId: 'pkg-simplification', sessionId: 'session-9',
  })
  assert.equal(recalled.audit.matches[0].memoryId, memory.id)
  assert.equal((await store.listRecallAudits('user-1', { sessionId: 'session-9' })).length, 1)
  assert.match(formatAgentMemoryContext(recalled.memories), /explicitly confirmed by the user/)
  assert.match(formatAgentMemoryContext(recalled.memories), /not as PKG factual evidence/)
})

test('expired candidates cannot be accepted and injected context is bounded', async (t) => {
  const { store } = await fixture(t)
  const candidate = await store.propose('user-1', {
    ...proposal,
    candidateExpiresAt: '2026-08-22T07:00:00.000Z',
  })
  await assert.rejects(() => store.accept('user-1', candidate.id), /only pending candidates/)
  assert.equal((await store.list('user-1')).candidates[0].status, 'expired')
  const context = formatAgentMemoryContext(Array.from({ length: 5 }, (_, index) => ({
    kind: 'preference', title: `Memory ${index}`, content: 'x'.repeat(3_000),
  })))
  assert.ok(context.length <= 6_050)
})
