import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateReadiness,
  normalizeReport,
  parseCliOptions,
} from './check-stage-e-readiness.mjs'

const root = '/lab/.dsh/sessions'
const options = {
  jsonlRoot: root,
  schema: 'public',
  minChecks: 3,
  minHours: 24,
  maxAgeHours: 1,
}

function report(hours, mismatched = 0) {
  const postgresSessions = 6
  return normalizeReport({
    version: 1,
    generatedAt: new Date(Date.UTC(2026, 7, 21, 12) + hours * 60 * 60 * 1000).toISOString(),
    jsonlRoot: root,
    schema: 'public',
    summary: {
      postgresSessions,
      matched: postgresSessions - mismatched,
      mismatched,
      jsonlOnly: 13,
    },
  })
}

test('parseCliOptions validates readiness thresholds', () => {
  const parsed = parseCliOptions(['--min-checks', '4', '--min-hours', '48', '--max-age-hours', '2'])
  assert.equal(parsed.minChecks, 4)
  assert.equal(parsed.minHours, 48)
  assert.equal(parsed.maxAgeHours, 2)
})

test('readiness requires a fresh successful streak spanning the observation window', () => {
  const reports = [report(0), report(12), report(24)]
  const result = evaluateReadiness(reports, options, Date.UTC(2026, 7, 22, 12, 30))
  assert.equal(result.ready, true)
  assert.equal(result.successfulChecks, 3)
  assert.equal(result.observationHours, 24)
})

test('a mismatch resets the successful observation streak', () => {
  const reports = [report(0), report(12, 1), report(24)]
  const result = evaluateReadiness(reports, options, Date.UTC(2026, 7, 22, 12, 30))
  assert.equal(result.ready, false)
  assert.equal(result.successfulChecks, 1)
  assert.match(result.reasons.join('\n'), /need 3 successful checks/)
})

test('stale and future reports cannot authorize Stage E', () => {
  const stale = evaluateReadiness([report(0), report(12), report(24)], options, Date.UTC(2026, 7, 22, 15))
  assert.equal(stale.ready, false)
  assert.match(stale.reasons.join('\n'), /older than 1 hour/)

  const future = evaluateReadiness([report(0), report(12), report(24)], options, Date.UTC(2026, 7, 22, 11))
  assert.equal(future.ready, false)
  assert.match(future.reasons.join('\n'), /dated in the future/)
})
