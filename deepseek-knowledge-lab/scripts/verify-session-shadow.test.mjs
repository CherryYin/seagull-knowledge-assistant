import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareSession,
  parseCliOptions,
  verifyReaders,
  verifyWithRetries,
} from './verify-session-shadow.mjs'

const meta = {
  version: 0,
  id: 'session-1',
  createdAt: 1,
  cwd: '/workspace',
  delegationDepth: 0,
}

function session(values, sessionMeta = meta) {
  return {
    meta: sessionMeta,
    events: values.map((value, seq) => ({ type: 'assistant/chunk', seq, time: seq + 1, data: { value } })),
  }
}

function reader(sessions) {
  return {
    async list() {
      return [...sessions.values()].map(value => value.meta)
    },
    async inspect(id) {
      const value = sessions.get(id)
      if (!value) throw new Error(`missing ${id}`)
      return structuredClone(value)
    },
  }
}

test('parseCliOptions uses PKG_DATABASE_URL and stable defaults', () => {
  const options = parseCliOptions([], { PKG_DATABASE_URL: 'postgres://example' }, 123)
  assert.equal(options.databaseUrl, 'postgres://example')
  assert.equal(options.attempts, 3)
  assert.equal(options.retryDelayMs, 250)
  assert.match(options.reportPath, /shadow-verify-123\.json$/)
})

test('compareSession distinguishes header, count, and content mismatches', () => {
  assert.equal(compareSession(meta.id, session(['a']), session(['a'])).status, 'matched')
  assert.equal(compareSession(meta.id, session(['a']), session(['a'], { ...meta, delegationDepth: undefined })).status, 'header-mismatch')
  assert.equal(compareSession(meta.id, session(['a', 'b']), session(['a'])).status, 'event-count-mismatch')
  assert.equal(compareSession(meta.id, session(['a']), session(['b'])).status, 'event-hash-mismatch')
})

test('verifyReaders requires every PostgreSQL session while reporting JSONL-only archives', async () => {
  const postgres = new Map([
    ['session-1', session(['a'])],
    ['session-2', session(['b'], { ...meta, id: 'session-2' })],
  ])
  const jsonl = new Map([
    ['session-1', session(['a'])],
    ['archive', session(['old'], { ...meta, id: 'archive' })],
  ])
  const result = await verifyReaders(reader(postgres), reader(jsonl))
  assert.deepEqual(result.summary, { postgresSessions: 2, matched: 1, mismatched: 1, jsonlOnly: 1 })
  assert.deepEqual(result.entries.map(entry => [entry.id, entry.status]), [
    ['session-1', 'matched'],
    ['session-2', 'missing-jsonl'],
  ])
  assert.deepEqual(result.jsonlOnly, ['archive'])
})

test('verifyWithRetries allows an asynchronous shadow to catch up', async () => {
  const postgresSessions = new Map([['session-1', session(['a', 'b'])]])
  const jsonlSessions = new Map([['session-1', session(['a'])]])
  let sleeps = 0
  const result = await verifyWithRetries(
    { postgres: reader(postgresSessions), jsonl: reader(jsonlSessions) },
    { attempts: 3, retryDelayMs: 0 },
    async () => {
      sleeps++
      jsonlSessions.set('session-1', session(['a', 'b']))
    },
  )
  assert.equal(sleeps, 1)
  assert.equal(result.attemptsUsed, 2)
  assert.equal(result.summary.mismatched, 0)
})
