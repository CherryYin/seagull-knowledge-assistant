import { isDeepStrictEqual } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function quotedSchema(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('schema is invalid')
  return `"${value}"`
}

export function parseOptions(args, env = process.env) {
  const options = {
    apply: false,
    replace: false,
    databaseUrl: env.AGENT_MEMORY_DATABASE_URL || env.PKG_DATABASE_URL || env.DATABASE_URL,
    schema: env.AGENT_MEMORY_DATABASE_SCHEMA || 'public',
    source: join(LAB_ROOT, '.dsh', 'agent-memory.json'),
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--replace') options.replace = true
    else if (arg === '--database-url') options.databaseUrl = args[++index]
    else if (arg === '--schema') options.schema = args[++index]
    else if (arg === '--source') options.source = resolve(args[++index])
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!options.databaseUrl) throw new Error('AGENT_MEMORY_DATABASE_URL or PKG_DATABASE_URL is required')
  quotedSchema(options.schema)
  return options
}

function freshState() {
  return { version: 1, candidates: [], memories: [], recallAudits: [] }
}

export function statesByUser(state) {
  if (!state || state.version !== 1) throw new Error('unsupported Agent Memory file format')
  const users = new Set([
    ...(state.candidates || []).map(item => item.userId),
    ...(state.memories || []).map(item => item.userId),
    ...(state.recallAudits || []).map(item => item.userId),
  ].filter(Boolean))
  return new Map([...users].sort().map(userId => [userId, {
    version: 1,
    candidates: (state.candidates || []).filter(item => item.userId === userId),
    memories: (state.memories || []).filter(item => item.userId === userId),
    recallAudits: (state.recallAudits || []).filter(item => item.userId === userId),
  }]))
}

async function loadLocalEnv() {
  const envPath = join(LAB_ROOT, '.dsh', '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

export async function migrate(options) {
  const sourceState = existsSync(options.source)
    ? JSON.parse(await readFile(options.source, 'utf8'))
    : freshState()
  const userStates = statesByUser(sourceState)
  const schema = quotedSchema(options.schema)
  const table = `${schema}.harness_agent_memory_state`
  const pool = new Pool({ connectionString: options.databaseUrl, application_name: 'agent-memory-migration' })
  try {
    const exists = await pool.query('SELECT to_regclass($1) AS name', [`${options.schema}.harness_agent_memory_state`])
    const existing = new Map()
    if (exists.rows[0].name) {
      const rows = await pool.query(`SELECT user_id, state FROM ${table}`)
      for (const row of rows.rows) existing.set(row.user_id, row.state)
    }
    const summary = { users: userStates.size, inserts: 0, unchanged: 0, conflicts: 0, replaced: 0 }
    for (const [userId, state] of userStates) {
      if (!existing.has(userId)) summary.inserts += 1
      else if (isDeepStrictEqual(existing.get(userId), state)) summary.unchanged += 1
      else if (options.replace) summary.replaced += 1
      else summary.conflicts += 1
    }
    if (!options.apply) return { mode: 'dry-run', source: options.source, table: `${options.schema}.harness_agent_memory_state`, ...summary }
    if (summary.conflicts) throw new Error(`${summary.conflicts} existing user state conflict(s); rerun with --replace after review`)
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      user_id varchar PRIMARY KEY REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      state jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    for (const [userId, state] of userStates) {
      await pool.query(
        `INSERT INTO ${table} AS target (user_id, state) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, revision = target.revision + 1, updated_at = now()`,
        [userId, JSON.stringify(state)],
      )
    }
    return { mode: 'apply', source: options.source, table: `${options.schema}.harness_agent_memory_state`, ...summary }
  } finally {
    await pool.end()
  }
}

export async function main(args = process.argv.slice(2)) {
  await loadLocalEnv()
  const result = await migrate(parseOptions(args))
  console.log(JSON.stringify(result))
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (entry === import.meta.url) await main()
