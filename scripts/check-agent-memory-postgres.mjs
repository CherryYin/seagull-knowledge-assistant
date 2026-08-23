import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { AgentMemoryStore, PostgresAgentMemoryBackend } from '../plugins/agent-memory/src/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.dsh', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)
const connectionString = process.env.AGENT_MEMORY_DATABASE_URL || process.env.PKG_DATABASE_URL || process.env.DATABASE_URL
if (!connectionString) throw new Error('AGENT_MEMORY_DATABASE_URL or PKG_DATABASE_URL is required')
const schema = process.env.AGENT_MEMORY_DATABASE_SCHEMA || 'public'
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('schema is invalid')
const quotedSchema = `"${schema}"`
const userId = `agent-memory-smoke-${randomUUID()}`
const pool = new Pool({ connectionString, application_name: 'agent-memory-smoke-setup' })
const backend = new PostgresAgentMemoryBackend({ connectionString, schema })
const store = new AgentMemoryStore({ backend })

try {
  await pool.query(
    `INSERT INTO ${quotedSchema}.users (id, username, display_name, hashed_password, role, approval_status, is_active)
     VALUES ($1, $2, 'Agent Memory Smoke', 'not-a-login-hash', 'user', 'approved', false)`,
    [userId, userId],
  )
  const candidate = await store.propose(userId, {
    proposedScopeType: 'global',
    proposedKind: 'preference',
    title: 'PostgreSQL smoke',
    content: 'Prefer transaction-safe Agent Memory.',
    reason: 'Verify PostgreSQL backend',
    provenance: { sessionId: 'smoke-session', eventIds: ['event-1'], toolCallIds: [] },
  })
  const accepted = await store.accept(userId, candidate.id)
  const recalled = await store.recall(userId, { query: 'transaction safe', sessionId: 'smoke-recall' })
  await store.archive(userId, accepted.memory.id)
  await store.delete(userId, accepted.memory.id)
  const finalState = await store.list(userId)
  if (recalled.memories.length !== 1 || finalState.memories.length !== 0) {
    throw new Error('PostgreSQL Agent Memory lifecycle verification failed')
  }
  console.log(JSON.stringify({ ok: true, candidateStatus: accepted.candidate.status, recalled: recalled.memories.length, cleanup: true }))
} finally {
  await pool.query(`DELETE FROM ${quotedSchema}.users WHERE id = $1`, [userId]).catch(() => undefined)
  await backend.close()
  await pool.end()
}
