import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOUR_MS = 60 * 60 * 1000

function requiredValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function positiveNumber(value, option) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be greater than zero`)
  return parsed
}

function positiveInteger(value, option) {
  const parsed = positiveNumber(value, option)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`)
  return parsed
}

export function parseCliOptions(args) {
  let jsonlRoot = join(LAB_ROOT, '.dsh', 'sessions')
  let maxAgeHours = 1
  let minChecks = 3
  let minHours = 24
  let reportsDir = join(LAB_ROOT, '.dsh', 'migration-reports')
  let schema = 'public'

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    switch (arg) {
      case '--jsonl-root':
        jsonlRoot = requiredValue(args, index, arg)
        index++
        break
      case '--max-age-hours':
        maxAgeHours = positiveNumber(requiredValue(args, index, arg), arg)
        index++
        break
      case '--min-checks':
        minChecks = positiveInteger(requiredValue(args, index, arg), arg)
        index++
        break
      case '--min-hours':
        minHours = positiveNumber(requiredValue(args, index, arg), arg)
        index++
        break
      case '--reports-dir':
        reportsDir = requiredValue(args, index, arg)
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

  return {
    jsonlRoot: resolve(jsonlRoot),
    maxAgeHours,
    minChecks,
    minHours,
    reportsDir: resolve(reportsDir),
    schema,
  }
}

function validSummary(summary) {
  if (summary === null || typeof summary !== 'object') return false
  const fields = ['postgresSessions', 'matched', 'mismatched', 'jsonlOnly']
  if (!fields.every(field => Number.isSafeInteger(summary[field]) && summary[field] >= 0)) return false
  return summary.matched + summary.mismatched === summary.postgresSessions
}

export function normalizeReport(value, file = '<memory>') {
  if (value === null || typeof value !== 'object' || value.version !== 1) {
    throw new Error(`${file}: unsupported report format`)
  }
  const generatedAtMs = Date.parse(value.generatedAt)
  if (!Number.isFinite(generatedAtMs)) throw new Error(`${file}: invalid generatedAt`)
  if (typeof value.jsonlRoot !== 'string' || typeof value.schema !== 'string' || !validSummary(value.summary)) {
    throw new Error(`${file}: invalid verification report`)
  }
  return {
    file,
    generatedAt: value.generatedAt,
    generatedAtMs,
    jsonlRoot: resolve(value.jsonlRoot),
    schema: value.schema,
    summary: value.summary,
  }
}

export function evaluateReadiness(reports, options, now = Date.now()) {
  const matching = reports
    .filter(report => report.jsonlRoot === options.jsonlRoot && report.schema === options.schema)
    .sort((left, right) => left.generatedAtMs - right.generatedAtMs)
  const latest = matching.at(-1)
  const futureToleranceMs = 5 * 60 * 1000
  const reasons = []

  if (latest === undefined) {
    reasons.push('no verification reports match the configured JSONL root and PostgreSQL schema')
    return {
      ready: false,
      reasons,
      matchingReports: 0,
      successfulChecks: 0,
      observationHours: 0,
      latestGeneratedAt: null,
    }
  }

  if (latest.generatedAtMs > now + futureToleranceMs) reasons.push('latest verification report is dated in the future')
  const latestAgeHours = Math.max(0, (now - latest.generatedAtMs) / HOUR_MS)
  if (latestAgeHours > options.maxAgeHours) {
    reasons.push(`latest successful verification is older than ${options.maxAgeHours} hour(s)`)
  }
  if (latest.summary.mismatched > 0) reasons.push('latest verification contains mismatched Sessions')

  const lastFailureIndex = matching.findLastIndex(report => report.summary.mismatched > 0)
  const successfulStreak = matching.slice(lastFailureIndex + 1).filter(report => report.summary.mismatched === 0)
  const firstSuccess = successfulStreak[0]
  const observationHours = firstSuccess === undefined
    ? 0
    : Math.max(0, (latest.generatedAtMs - firstSuccess.generatedAtMs) / HOUR_MS)

  if (successfulStreak.length < options.minChecks) {
    reasons.push(`need ${options.minChecks} successful checks; found ${successfulStreak.length}`)
  }
  if (observationHours < options.minHours) {
    reasons.push(`need ${options.minHours} observation hour(s); found ${observationHours.toFixed(2)}`)
  }

  return {
    ready: reasons.length === 0,
    reasons,
    matchingReports: matching.length,
    successfulChecks: successfulStreak.length,
    observationHours,
    latestGeneratedAt: latest.generatedAt,
  }
}

async function loadReports(reportsDir) {
  let names
  try {
    names = await readdir(reportsDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { reports: [], invalidReports: [] }
    throw error
  }

  const reports = []
  const invalidReports = []
  for (const name of names.filter(name => /^shadow-verify-.*\.json$/.test(name)).sort()) {
    const path = join(reportsDir, name)
    try {
      reports.push(normalizeReport(JSON.parse(await readFile(path, 'utf8')), path))
    } catch (error) {
      invalidReports.push({ file: path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { reports, invalidReports }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseCliOptions(args)
  const { reports, invalidReports } = await loadReports(options.reportsDir)
  const result = evaluateReadiness(reports, options)
  if (invalidReports.length > 0) {
    result.ready = false
    result.reasons.push(`${invalidReports.length} invalid verification report(s) require review`)
  }
  console.log(JSON.stringify({
    ...result,
    invalidReports,
    requirements: {
      minChecks: options.minChecks,
      minHours: options.minHours,
      maxAgeHours: options.maxAgeHours,
    },
  }))
  if (!result.ready) process.exitCode = 2
}

const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (entryUrl === import.meta.url) await main()
