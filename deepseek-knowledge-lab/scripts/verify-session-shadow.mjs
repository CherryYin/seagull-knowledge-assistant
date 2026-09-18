import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEADER_FIELDS = [
  'version',
  'id',
  'createdAt',
  'cwd',
  'parentSession',
  'seedLength',
  'origin',
  'delegationDepth',
  'agentPreset',
]

function requiredValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function positiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`)
  return parsed
}

function nonNegativeInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`)
  return parsed
}

export function parseCliOptions(args, env = process.env, now = Date.now()) {
  let attempts = 3
  let compression = 'zstd'
  let databaseUrl = env.PKG_DATABASE_URL || env.DATABASE_URL
  let jsonlRoot = env.DSH_SESSION_ROOT || join(LAB_ROOT, '.dsh', 'sessions')
  let reportPath
  let retryDelayMs = 250
  let schema = 'public'

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    switch (arg) {
      case '--attempts':
        attempts = positiveInteger(requiredValue(args, index, arg), arg)
        index++
        break
      case '--compression':
        compression = requiredValue(args, index, arg)
        if (compression !== 'zstd' && compression !== 'none') {
          throw new Error('--compression must be zstd or none')
        }
        index++
        break
      case '--database-url':
        databaseUrl = requiredValue(args, index, arg)
        index++
        break
      case '--jsonl-root':
        jsonlRoot = requiredValue(args, index, arg)
        index++
        break
      case '--report':
        reportPath = requiredValue(args, index, arg)
        index++
        break
      case '--retry-delay-ms':
        retryDelayMs = nonNegativeInteger(requiredValue(args, index, arg), arg)
        index++
        break
      case '--schema':
        schema = requiredValue(args, index, arg)
        index++
        break
      default:
        throw new Error(`unknown option ${JSON.stringify(arg)}`)
    }
  }

  if (!databaseUrl) throw new Error('provide --database-url, PKG_DATABASE_URL, or DATABASE_URL')
  return {
    attempts,
    compression,
    databaseUrl,
    jsonlRoot: resolve(jsonlRoot),
    reportPath: resolve(reportPath || join(LAB_ROOT, '.dsh', 'migration-reports', `shadow-verify-${now}.json`)),
    retryDelayMs,
    schema,
  }
}

function digestEvents(events) {
  return {
    eventCount: events.length,
    eventHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    firstSeq: events[0]?.seq ?? null,
    lastSeq: events.at(-1)?.seq ?? null,
  }
}

function headersEqual(left, right) {
  return HEADER_FIELDS.every(field => left[field] === right[field])
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function compareSession(id, postgres, jsonl) {
  const postgresDigest = digestEvents(postgres.events)
  const jsonlDigest = digestEvents(jsonl.events)
  const base = { id, postgres: postgresDigest, jsonl: jsonlDigest }
  if (!headersEqual(postgres.meta, jsonl.meta)) return { ...base, status: 'header-mismatch' }
  if (postgresDigest.eventCount !== jsonlDigest.eventCount) return { ...base, status: 'event-count-mismatch' }
  if (postgresDigest.eventHash !== jsonlDigest.eventHash) return { ...base, status: 'event-hash-mismatch' }
  return { ...base, status: 'matched' }
}

export async function verifyReaders(postgres, jsonl) {
  const postgresHeaders = await postgres.list()
  const jsonlHeaders = await jsonl.list()
  const jsonlIds = new Set(jsonlHeaders.map(header => header.id))
  const postgresIds = new Set(postgresHeaders.map(header => header.id))
  const entries = []

  for (const header of postgresHeaders) {
    const id = header.id
    if (!jsonlIds.has(id)) {
      entries.push({ id, status: 'missing-jsonl' })
      continue
    }
    try {
      const [postgresSession, jsonlSession] = await Promise.all([
        postgres.inspect(id),
        jsonl.inspect(id),
      ])
      entries.push(compareSession(id, postgresSession, jsonlSession))
    } catch (error) {
      entries.push({ id, status: 'read-error', detail: errorMessage(error) })
    }
  }

  entries.sort((left, right) => left.id.localeCompare(right.id))
  const jsonlOnly = [...jsonlIds].filter(id => !postgresIds.has(id)).sort()
  const matched = entries.filter(entry => entry.status === 'matched').length
  return {
    summary: {
      postgresSessions: postgresHeaders.length,
      matched,
      mismatched: entries.length - matched,
      jsonlOnly: jsonlOnly.length,
    },
    entries,
    jsonlOnly,
  }
}

export async function verifyWithRetries(readers, options, sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))) {
  let result
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    result = await verifyReaders(readers.postgres, readers.jsonl)
    if (result.summary.mismatched === 0 || attempt === options.attempts) {
      return { ...result, attemptsUsed: attempt }
    }
    await sleep(options.retryDelayMs)
  }
  throw new Error('unreachable verification retry state')
}

async function loadLocalEnv() {
  const envPath = join(LAB_ROOT, '.dsh', '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

async function createReaders(options) {
  const harnessRoot = join(LAB_ROOT, 'dsh-harness')
  const [{ Context }, { default: SessionStore }, { default: Jsonl }, { default: Postgres }] = await Promise.all([
    import(pathToFileURL(join(harnessRoot, 'vendor', 'cordis', 'lib', 'index.js')).href),
    import(pathToFileURL(join(harnessRoot, 'packages', 'core', 'session', 'lib', 'index.js')).href),
    import(pathToFileURL(join(harnessRoot, 'packages', 'session', 'session-persistence-jsonl', 'lib', 'index.js')).href),
    import(pathToFileURL(join(harnessRoot, 'packages', 'session', 'session-persistence-postgres', 'lib', 'index.js')).href),
  ])

  const postgresContext = new Context()
  await postgresContext.plugin(SessionStore)
  const postgresFiber = await postgresContext.plugin(Postgres, {
    connectionString: options.databaseUrl,
    schema: options.schema,
    applicationName: 'deepseek-knowledge-lab-shadow-verifier',
  })

  const jsonlContext = new Context()
  await jsonlContext.plugin(SessionStore)
  const jsonlFiber = await jsonlContext.plugin(Jsonl, {
    root: options.jsonlRoot,
    compression: options.compression,
  })

  return {
    postgres: postgresContext.sessionPersistence,
    jsonl: jsonlContext.sessionPersistence,
    async close() {
      await jsonlFiber.dispose()
      await jsonlContext.fiber.dispose()
      await postgresFiber.dispose()
      await postgresContext.fiber.dispose()
    },
  }
}

export async function main(args = process.argv.slice(2)) {
  await loadLocalEnv()
  const options = parseCliOptions(args)
  const readers = await createReaders(options)
  let result
  try {
    result = await verifyWithRetries(readers, options)
  } finally {
    await readers.close()
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    jsonlRoot: options.jsonlRoot,
    schema: options.schema,
    attemptsUsed: result.attemptsUsed,
    summary: result.summary,
    entries: result.entries,
    jsonlOnly: result.jsonlOnly,
  }
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ report: options.reportPath, attemptsUsed: result.attemptsUsed, ...result.summary }))
  if (result.summary.mismatched > 0) process.exitCode = 2
}

const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (entryUrl === import.meta.url) await main()
