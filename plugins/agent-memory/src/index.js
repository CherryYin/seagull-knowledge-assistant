import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const CANDIDATE_STATUSES = new Set(['pending', 'accepted', 'rejected', 'expired'])
const MEMORY_STATUSES = new Set(['active', 'archived'])
const SCOPE_TYPES = new Set(['global', 'workspace', 'project', 'agent'])
const MEMORY_KINDS = new Set(['preference', 'constraint', 'profile', 'project_context'])
const EDITABLE_FIELDS = ['scopeType', 'scopeId', 'kind', 'title', 'content', 'expiresAt']

function iso(clock) {
  return clock().toISOString()
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`)
  return value.trim()
}

function optionalText(value, field) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`)
  return value.trim() || null
}

function enumValue(value, values, field) {
  if (!values.has(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function stringList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`)
  }
  return [...new Set(value.map(item => item.trim()))]
}

function provenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provenance is required')
  }
  return {
    sessionId: requiredText(value.sessionId, 'provenance.sessionId'),
    eventIds: stringList(value.eventIds, 'provenance.eventIds'),
    toolCallIds: stringList(value.toolCallIds, 'provenance.toolCallIds'),
  }
}

function expiresAt(value) {
  const normalized = optionalText(value, 'expiresAt')
  if (normalized === null) return null
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new TypeError('expiresAt must be an ISO date')
  return parsed.toISOString()
}

function normalizeFields(input, prefix = '') {
  return {
    scopeType: enumValue(input[`${prefix}ScopeType`] ?? input.scopeType ?? 'global', SCOPE_TYPES, 'scopeType'),
    scopeId: optionalText(input[`${prefix}ScopeId`] ?? input.scopeId, 'scopeId'),
    kind: enumValue(input[`${prefix}Kind`] ?? input.kind, MEMORY_KINDS, 'kind'),
    title: requiredText(input.title, 'title'),
    content: requiredText(input.content, 'content'),
    expiresAt: expiresAt(input.expiresAt),
  }
}

function cleanPatch(input) {
  const patch = {}
  for (const field of EDITABLE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue
    if (field === 'scopeType') patch.scopeType = enumValue(input.scopeType, SCOPE_TYPES, field)
    else if (field === 'kind') patch.kind = enumValue(input.kind, MEMORY_KINDS, field)
    else if (field === 'scopeId') patch.scopeId = optionalText(input.scopeId, field)
    else if (field === 'expiresAt') patch.expiresAt = expiresAt(input.expiresAt)
    else patch[field] = requiredText(input[field], field)
  }
  return patch
}

function freshState() {
  return { version: 1, candidates: [], memories: [], recallAudits: [] }
}

function quotedSchema(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError('schema is invalid')
  return `"${value}"`
}

export class PostgresAgentMemoryBackend {
  #pool
  #table

  constructor({ connectionString, schema = 'public', maxConnections = 5, pool } = {}) {
    this.#table = `${quotedSchema(schema)}.harness_agent_memory_state`
    this.#pool = pool ?? new Pool({
      connectionString: requiredText(connectionString, 'connectionString'),
      max: maxConnections,
      application_name: 'deepseek-knowledge-lab-agent-memory',
    })
  }

  async read(userId) {
    const result = await this.#pool.query(`SELECT state FROM ${this.#table} WHERE user_id = $1`, [userId])
    return result.rows[0] ? assertState(result.rows[0].state) : freshState()
  }

  async mutate(userId, operation) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ${this.#table} (user_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING`,
        [userId, JSON.stringify(freshState())],
      )
      const selected = await client.query(`SELECT state FROM ${this.#table} WHERE user_id = $1 FOR UPDATE`, [userId])
      const state = assertState(selected.rows[0].state)
      const result = await operation(state)
      await client.query(
        `UPDATE ${this.#table} SET state = $2::jsonb, revision = revision + 1, updated_at = now() WHERE user_id = $1`,
        [userId, JSON.stringify(state)],
      )
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async close() {
    await this.#pool.end()
  }
}

function clone(value) {
  return structuredClone(value)
}

function candidateView(candidate) {
  return clone(candidate)
}

function memoryView(memory) {
  return clone(memory)
}

function assertState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.candidates)
    || !Array.isArray(state.memories) || !Array.isArray(state.recallAudits)) {
    throw new Error('Agent Memory store has an unsupported format')
  }
  for (const candidate of state.candidates) enumValue(candidate.status, CANDIDATE_STATUSES, 'candidate.status')
  for (const memory of state.memories) enumValue(memory.status, MEMORY_STATUSES, 'memory.status')
  return state
}

function words(value) {
  return new Set(String(value).toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
}

function relevance(memory, query) {
  const queryWords = words(query)
  if (queryWords.size === 0) return 0
  const memoryWords = words(`${memory.title} ${memory.content}`)
  let hits = 0
  for (const word of queryWords) if (memoryWords.has(word)) hits += 1
  return hits / queryWords.size
}

export class AgentMemoryStore {
  #path
  #backend
  #clock
  #id
  #queue = Promise.resolve()

  constructor({ path, backend, clock = () => new Date(), id = randomUUID }) {
    if (!backend && !path) throw new TypeError('path or backend is required')
    this.#path = path ? requiredText(path, 'path') : null
    this.#backend = backend
    this.#clock = clock
    this.#id = id
  }

  async #read(userId) {
    if (this.#backend) return this.#backend.read(userId)
    try {
      return assertState(JSON.parse(await readFile(this.#path, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return freshState()
      throw error
    }
  }

  async #write(state) {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid}.${this.#id()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.#path)
  }

  #mutate(userId, operation) {
    if (this.#backend) return this.#backend.mutate(userId, operation)
    const current = this.#queue.then(async () => {
      const state = await this.#read(userId)
      const result = await operation(state)
      await this.#write(state)
      return result
    })
    this.#queue = current.catch(() => undefined)
    return current
  }

  async list(userId, { candidateStatus, memoryStatus } = {}) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      this.#expireCandidates(state)
      const candidates = state.candidates
        .filter(item => item.userId === owner && (!candidateStatus || item.status === candidateStatus))
        .map(candidateView)
      const memories = state.memories
        .filter(item => item.userId === owner && (!memoryStatus || item.status === memoryStatus))
        .map(memoryView)
      return { candidates, memories }
    })
  }

  propose(userId, input) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const now = iso(this.#clock)
      const fields = normalizeFields(input, 'proposed')
      const candidate = {
        id: this.#id(),
        userId: owner,
        proposedScopeType: fields.scopeType,
        proposedScopeId: fields.scopeId,
        proposedKind: fields.kind,
        title: fields.title,
        content: fields.content,
        reason: requiredText(input.reason, 'reason'),
        provenance: provenance(input.provenance),
        status: 'pending',
        memoryId: null,
        expiresAt: input.candidateExpiresAt
          ? expiresAt(input.candidateExpiresAt)
          : new Date(this.#clock().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
      }
      state.candidates.push(candidate)
      return candidateView(candidate)
    })
  }

  updateCandidate(userId, candidateId, input) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const candidate = this.#candidate(state, owner, candidateId)
      if (candidate.status !== 'pending') throw new Error('only pending candidates can be edited')
      const patch = cleanPatch(input)
      if (Object.hasOwn(patch, 'scopeType')) candidate.proposedScopeType = patch.scopeType
      if (Object.hasOwn(patch, 'scopeId')) candidate.proposedScopeId = patch.scopeId
      if (Object.hasOwn(patch, 'kind')) candidate.proposedKind = patch.kind
      if (Object.hasOwn(patch, 'title')) candidate.title = patch.title
      if (Object.hasOwn(patch, 'content')) candidate.content = patch.content
      candidate.updatedAt = iso(this.#clock)
      return candidateView(candidate)
    })
  }

  accept(userId, candidateId, input = {}) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const candidate = this.#candidate(state, owner, candidateId)
      this.#expireCandidate(candidate)
      if (candidate.status !== 'pending') throw new Error('only pending candidates can be accepted')
      const now = iso(this.#clock)
      const patch = cleanPatch(input)
      const memory = {
        id: this.#id(),
        userId: owner,
        scopeType: patch.scopeType ?? candidate.proposedScopeType,
        scopeId: Object.hasOwn(patch, 'scopeId') ? patch.scopeId : candidate.proposedScopeId,
        kind: patch.kind ?? candidate.proposedKind,
        title: patch.title ?? candidate.title,
        content: patch.content ?? candidate.content,
        status: 'active',
        confidence: typeof input.confidence === 'number' ? input.confidence : null,
        provenance: clone(candidate.provenance),
        confirmedBy: owner,
        confirmedAt: now,
        lastUsedAt: null,
        expiresAt: Object.hasOwn(patch, 'expiresAt') ? patch.expiresAt : null,
        createdAt: now,
        updatedAt: now,
      }
      state.memories.push(memory)
      candidate.status = 'accepted'
      candidate.memoryId = memory.id
      candidate.decidedAt = now
      candidate.updatedAt = now
      return { candidate: candidateView(candidate), memory: memoryView(memory) }
    })
  }

  reject(userId, candidateId) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const candidate = this.#candidate(state, owner, candidateId)
      this.#expireCandidate(candidate)
      if (candidate.status !== 'pending') throw new Error('only pending candidates can be rejected')
      const now = iso(this.#clock)
      candidate.status = 'rejected'
      candidate.decidedAt = now
      candidate.updatedAt = now
      return candidateView(candidate)
    })
  }

  updateMemory(userId, memoryId, input) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const memory = this.#memory(state, owner, memoryId)
      Object.assign(memory, cleanPatch(input), { updatedAt: iso(this.#clock) })
      return memoryView(memory)
    })
  }

  archive(userId, memoryId) {
    return this.#setMemoryStatus(userId, memoryId, 'active', 'archived')
  }

  restore(userId, memoryId) {
    return this.#setMemoryStatus(userId, memoryId, 'archived', 'active')
  }

  #setMemoryStatus(userId, memoryId, expected, status) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const memory = this.#memory(state, owner, memoryId)
      if (memory.status !== expected) throw new Error(`only ${expected} memories can become ${status}`)
      memory.status = status
      memory.updatedAt = iso(this.#clock)
      return memoryView(memory)
    })
  }

  delete(userId, memoryId) {
    const owner = requiredText(userId, 'userId')
    return this.#mutate(owner, async (state) => {
      const memory = this.#memory(state, owner, memoryId)
      state.memories.splice(state.memories.indexOf(memory), 1)
      return { deleted: true, id: memory.id }
    })
  }

  recall(userId, { query = '', scopeType = 'global', scopeId = null, limit = 5, sessionId }) {
    const owner = requiredText(userId, 'userId')
    const requestedScope = enumValue(scopeType, SCOPE_TYPES, 'scopeType')
    const requestedScopeId = optionalText(scopeId, 'scopeId')
    const recallSessionId = requiredText(sessionId, 'sessionId')
    const safeLimit = Math.max(1, Math.min(5, Number(limit) || 5))
    return this.#mutate(owner, async (state) => {
      const now = this.#clock()
      const eligible = state.memories.filter(memory => {
        if (memory.userId !== owner || memory.status !== 'active') return false
        if (memory.expiresAt && new Date(memory.expiresAt) <= now) return false
        const global = memory.scopeType === 'global'
        const exact = memory.scopeType === requestedScope && memory.scopeId === requestedScopeId
        return global || exact
      })
      const ranked = eligible
        .map(memory => ({ memory, score: relevance(memory, query) + (memory.scopeType === 'global' ? 0 : 1) }))
        .sort((left, right) => right.score - left.score
          || String(right.memory.lastUsedAt ?? '').localeCompare(String(left.memory.lastUsedAt ?? '')))
        .slice(0, safeLimit)
      const usedAt = now.toISOString()
      for (const { memory } of ranked) memory.lastUsedAt = usedAt
      const audit = {
        id: this.#id(),
        userId: owner,
        sessionId: recallSessionId,
        query: String(query),
        scopeType: requestedScope,
        scopeId: requestedScopeId,
        matches: ranked.map(({ memory, score }) => ({
          memoryId: memory.id,
          scopeType: memory.scopeType,
          scopeId: memory.scopeId,
          reason: score >= 1 ? 'exact scope or keyword match' : 'active global memory',
        })),
        createdAt: usedAt,
      }
      state.recallAudits.push(audit)
      return { memories: ranked.map(({ memory }) => memoryView(memory)), audit: clone(audit) }
    })
  }

  async listRecallAudits(userId, { sessionId } = {}) {
    const owner = requiredText(userId, 'userId')
    const state = await this.#read(owner)
    return state.recallAudits
      .filter(item => item.userId === owner && (!sessionId || item.sessionId === sessionId))
      .map(clone)
  }

  #candidate(state, userId, id) {
    const owner = requiredText(userId, 'userId')
    const candidate = state.candidates.find(item => item.id === id && item.userId === owner)
    if (!candidate) throw new Error('Agent Memory Candidate not found')
    return candidate
  }

  #expireCandidate(candidate) {
    if (candidate.status !== 'pending' || !candidate.expiresAt) return false
    if (new Date(candidate.expiresAt) > this.#clock()) return false
    const now = iso(this.#clock)
    candidate.status = 'expired'
    candidate.decidedAt = now
    candidate.updatedAt = now
    return true
  }

  #expireCandidates(state) {
    return state.candidates.reduce((changed, candidate) => this.#expireCandidate(candidate) || changed, false)
  }

  #memory(state, userId, id) {
    const owner = requiredText(userId, 'userId')
    const memory = state.memories.find(item => item.id === id && item.userId === owner)
    if (!memory) throw new Error('Agent Memory not found')
    return memory
  }
}

export function defaultAgentMemoryStorePath() {
  return fileURLToPath(new URL('../../../.dsh/agent-memory.json', import.meta.url))
}

export function formatAgentMemoryContext(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return ''
  const header = [
    '<confirmed-agent-memory>',
    'The following context was explicitly confirmed by the user. Treat it as preferences or working constraints, not as PKG factual evidence.',
  ]
  const lines = []
  let length = header.join('\n').length + '</confirmed-agent-memory>'.length + 2
  for (const memory of memories.slice(0, 5)) {
    const line = `- [${memory.kind}] ${memory.title}: ${memory.content}`
    const remaining = 6_000 - length
    if (remaining <= 0) break
    const bounded = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line
    lines.push(bounded)
    length += bounded.length + 1
  }
  return [...header, ...lines, '</confirmed-agent-memory>'].join('\n')
}
