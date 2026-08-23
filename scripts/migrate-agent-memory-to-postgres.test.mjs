import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOptions, statesByUser } from './migrate-agent-memory-to-postgres.mjs'

test('migration options default to dry-run and require a database URL', () => {
  assert.throws(() => parseOptions([], {}), /DATABASE_URL/)
  const options = parseOptions(['--apply', '--replace', '--schema', 'harness'], { PKG_DATABASE_URL: 'postgres://example' })
  assert.equal(options.apply, true)
  assert.equal(options.replace, true)
  assert.equal(options.schema, 'harness')
})

test('file state is partitioned by user without mixing candidates, memories, or audits', () => {
  const states = statesByUser({
    version: 1,
    candidates: [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u2' }],
    memories: [{ id: 'm1', userId: 'u1' }],
    recallAudits: [{ id: 'a1', userId: 'u2' }],
  })
  assert.deepEqual(states.get('u1'), {
    version: 1,
    candidates: [{ id: 'c1', userId: 'u1' }],
    memories: [{ id: 'm1', userId: 'u1' }],
    recallAudits: [],
  })
  assert.deepEqual(states.get('u2'), {
    version: 1,
    candidates: [{ id: 'c2', userId: 'u2' }],
    memories: [],
    recallAudits: [{ id: 'a1', userId: 'u2' }],
  })
})
