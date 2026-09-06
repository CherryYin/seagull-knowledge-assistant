import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const ASSET_TYPES = new Set(['blog_post', 'research_brief', 'knowledge_pack', 'topic_report'])
const INTAKE_MODES = new Set(['manual', 'agent_assisted'])
const RESEARCH_MODES = new Set(['local_only', 'local_then_web'])
const CREATION_MODES = new Set(['understand', 'synthesize', 'make_decision', 'produce'])

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`)
  return value.trim()
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  return value.trim()
}

function stringList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`)
  }
  return [...new Set(value.map(item => item.trim()))]
}

function normalizeAssetDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('assetDraft is required')
  }
  if (!ASSET_TYPES.has(value.assetType)) throw new TypeError('assetDraft.assetType is invalid')
  const intakeMode = value.intakeMode === undefined ? 'manual' : value.intakeMode
  const researchMode = value.researchMode === undefined ? 'local_only' : value.researchMode
  const creationMode = value.creationMode === undefined ? 'synthesize' : value.creationMode
  if (!INTAKE_MODES.has(intakeMode)) throw new TypeError('assetDraft.intakeMode is invalid')
  if (!RESEARCH_MODES.has(researchMode)) throw new TypeError('assetDraft.researchMode is invalid')
  if (!CREATION_MODES.has(creationMode)) throw new TypeError('assetDraft.creationMode is invalid')
  const brief = requiredText(value.brief, 'assetDraft.brief')
  return {
    assetId: optionalText(value.assetId, 'assetDraft.assetId') || undefined,
    assetType: value.assetType,
    title: intakeMode === 'agent_assisted'
      ? optionalText(value.title, 'assetDraft.title')
      : requiredText(value.title, 'assetDraft.title'),
    brief,
    question: optionalText(value.question, 'assetDraft.question') || brief,
    goal: optionalText(value.goal, 'assetDraft.goal') || brief,
    audience: intakeMode === 'agent_assisted'
      ? optionalText(value.audience, 'assetDraft.audience')
      : requiredText(value.audience, 'assetDraft.audience'),
    styleNotes: optionalText(value.styleNotes, 'assetDraft.styleNotes'),
    sourceRefs: stringList(value.sourceRefs, 'assetDraft.sourceRefs'),
    noteRefs: stringList(value.noteRefs, 'assetDraft.noteRefs'),
    wikiRefs: stringList(value.wikiRefs, 'assetDraft.wikiRefs'),
    creationMode,
    scope: stringList(value.scope, 'assetDraft.scope'),
    constraints: stringList(value.constraints, 'assetDraft.constraints'),
    intakeMode,
    researchMode,
  }
}

function normalizeContext(userId, sessionId, input, clock) {
  const owner = requiredText(userId, 'userId')
  const session = requiredText(sessionId, 'sessionId')
  if (!input || input.kind !== 'asset_generation') throw new TypeError('kind must be asset_generation')
  return {
    userId: owner,
    sessionId: session,
    kind: 'asset_generation',
    workflowId: 'draft-asset',
    assetDraft: normalizeAssetDraft(input.assetDraft),
    updatedAt: clock().toISOString(),
  }
}

function assertState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.contexts)) {
    throw new Error('Session Context store has an unsupported format')
  }
  return value
}

function freshState() {
  return { version: 1, contexts: [] }
}

function clone(value) {
  return value === null ? null : structuredClone(value)
}

export class PostgresSessionContextBackend {
  #pool
  #table
  #ready

  constructor({ connectionString, schema = 'public', pool } = {}) {
    if (!pool && !connectionString) throw new TypeError('connectionString or pool is required')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new TypeError('schema is invalid')
    this.#pool = pool ?? new Pool({ connectionString })
    this.#table = `"${schema}"."harness_session_contexts"`
    this.#ready = this.#initialize(schema)
  }

  async #initialize(schema) {
    await this.#pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#table} (
        user_id text NOT NULL,
        session_id text NOT NULL,
        context jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, session_id)
      )
    `)
  }

  async get(userId, sessionId) {
    await this.#ready
    const result = await this.#pool.query(
      `SELECT context FROM ${this.#table} WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    return result.rows[0]?.context ?? null
  }

  async put(context) {
    await this.#ready
    await this.#pool.query(
      `INSERT INTO ${this.#table} (user_id, session_id, context, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, session_id)
       DO UPDATE SET context = EXCLUDED.context, updated_at = now()`,
      [context.userId, context.sessionId, JSON.stringify(context)],
    )
    return context
  }

  async delete(userId, sessionId) {
    await this.#ready
    const result = await this.#pool.query(
      `DELETE FROM ${this.#table} WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    return result.rowCount > 0
  }

  async close() {
    await this.#pool.end()
  }
}

export class SessionContextStore {
  #path
  #backend
  #clock
  #queue = Promise.resolve()

  constructor({ path, backend, clock = () => new Date() } = {}) {
    if (!backend && !path) throw new TypeError('path or backend is required')
    this.#path = path ?? null
    this.#backend = backend
    this.#clock = clock
  }

  async #read() {
    try {
      return assertState(JSON.parse(await readFile(this.#path, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return freshState()
      throw error
    }
  }

  async #write(state) {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.#path)
  }

  #mutate(operation) {
    const current = this.#queue.then(async () => {
      const state = await this.#read()
      const result = await operation(state)
      await this.#write(state)
      return result
    })
    this.#queue = current.catch(() => undefined)
    return current
  }

  async get(userId, sessionId) {
    const owner = requiredText(userId, 'userId')
    const session = requiredText(sessionId, 'sessionId')
    if (this.#backend) return clone(await this.#backend.get(owner, session))
    return this.#mutate(async state => clone(
      state.contexts.find(item => item.userId === owner && item.sessionId === session) ?? null,
    ))
  }

  async put(userId, sessionId, input) {
    const context = normalizeContext(userId, sessionId, input, this.#clock)
    if (this.#backend) return clone(await this.#backend.put(context))
    return this.#mutate(async state => {
      const index = state.contexts.findIndex(item => item.userId === context.userId && item.sessionId === context.sessionId)
      if (index === -1) state.contexts.push(context)
      else state.contexts[index] = context
      return clone(context)
    })
  }

  async delete(userId, sessionId) {
    const owner = requiredText(userId, 'userId')
    const session = requiredText(sessionId, 'sessionId')
    if (this.#backend) return this.#backend.delete(owner, session)
    return this.#mutate(async state => {
      const before = state.contexts.length
      state.contexts = state.contexts.filter(item => item.userId !== owner || item.sessionId !== session)
      return state.contexts.length !== before
    })
  }
}

export function defaultSessionContextStorePath() {
  return fileURLToPath(new URL('../../../.dsh/session-contexts.json', import.meta.url))
}
