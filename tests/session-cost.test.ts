/**
 * Session-cost calculation tests (node:test, zero deps). Run with `npm test`.
 *
 * `buildSessionCostView()` owns every number and every string the composer's
 * cost readout shows, so this file is where the three load-bearing rules are
 * pinned: only Command Code usage is priced, a missing rate is never invented,
 * and an unpriceable session renders nothing at all rather than `$0.00`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_COST_COPY,
  buildSessionCostView,
  isPeakHour,
  sessionCostAmount,
  sessionCostPillRun,
  sessionCostRowDecorations,
  type SessionCostInput,
} from '../src/client/session-cost.ts'
import type { CommandCodePriceTable } from '../src/usage-wire.ts'

const PEAK_HOURS: Array<[number, number]> = [[1, 4], [6, 10]]

/** The vendored row for a flat-priced model, simplified for arithmetic. */
const FLAT: CommandCodePriceTable = {
  models: [
    {
      id: 'commandcode/test-flat',
      slug: 'test-flat',
      inputCost: 1,
      outputCost: 2,
      cacheReadCost: 0.1,
      cacheWriteCost: 1.25,
    },
  ],
  peakHours: PEAK_HOURS,
}

/** A time-of-day model: off-peak is half the peak rates. */
const HOURLY: CommandCodePriceTable = {
  models: [
    {
      id: 'deepseek/deepseek-v4-pro',
      slug: 'deepseek-v4-pro',
      inputCost: 0.66,
      outputCost: 1.98,
      cacheReadCost: 0.022,
      peak: { inputCost: 1.32, outputCost: 3.96, cacheReadCost: 0.044 },
    },
  ],
  peakHours: PEAK_HOURS,
}

/** Wednesday 2026-09-16, 02:00 UTC — inside the 01–04 window. */
const PEAK_AT = Date.UTC(2026, 8, 16, 2, 0, 0)
/** Wednesday 2026-09-16, 05:00 UTC — between the two windows. */
const OFF_PEAK_AT = Date.UTC(2026, 8, 16, 5, 0, 0)
/** Saturday 2026-09-19, 02:00 UTC — inside the hours, but a weekend. */
const WEEKEND_AT = Date.UTC(2026, 8, 19, 2, 0, 0)

const SELECTION = {
  lastUsed: { provider: 'commandcode', model: 'commandcode/test-flat' },
  next: { provider: 'commandcode', model: 'commandcode/test-flat' },
}

function input(overrides: Partial<SessionCostInput> = {}): SessionCostInput {
  return {
    usage: { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    selection: SELECTION,
    table: FLAT,
    now: OFF_PEAK_AT,
    ...overrides,
  }
}

test('a priced session totals each bucket at its own published rate', () => {
  const view = buildSessionCostView(input({
    usage: {
      uncachedInputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 0,
    },
  }))
  assert.ok(view)
  // 1M × $1 + 0.5M × $2 + 2M × $0.10 = $1 + $1 + $0.20
  assert.equal(view.total, 2.2)
  assert.equal(view.value, '$2.20')
  assert.equal(view.free, false)
})

test('nothing to show renders nothing, never a confident $0.00', () => {
  const cases: Array<[string, SessionCostInput]> = [
    ['no usage yet', input({ usage: undefined })],
    ['all buckets zero', input({ usage: { uncachedInputTokens: 0, outputTokens: 0 } })],
    ['no price table', input({ table: undefined })],
    ['an empty price table', input({ table: { models: [], peakHours: PEAK_HOURS } })],
    ['no selection', input({ selection: undefined })],
    ['an unknown model', input({ selection: { lastUsed: { provider: 'commandcode', model: 'nope' }, next: null } })],
    ['another provider', input({ selection: { lastUsed: { provider: 'deepseek', model: 'commandcode/test-flat' }, next: null } })],
    ['no model recorded', input({ selection: { lastUsed: null, next: null } })],
  ]
  for (const [label, value] of cases) {
    assert.equal(buildSessionCostView(value), undefined, label)
  }
})

test('peak rates apply inside a weekday window and off-peak rates outside it', () => {
  // One bucket at a time, so each assertion names a single rate: 1M uncached
  // input tokens cost the input rate of whichever half is in force.
  const at = (now: number) => buildSessionCostView(input({
    table: HOURLY,
    now,
    usage: { uncachedInputTokens: 1_000_000 },
    selection: { lastUsed: { provider: 'commandcode', model: 'deepseek/deepseek-v4-pro' }, next: null },
  }))

  const peak = at(PEAK_AT)
  assert.ok(peak)
  assert.equal(peak.peak, true)
  assert.equal(peak.total, 1.32)
  assert.ok(peak.notes.includes(SESSION_COST_COPY.peakRates))

  const offPeak = at(OFF_PEAK_AT)
  assert.ok(offPeak)
  assert.equal(offPeak.peak, false)
  assert.equal(offPeak.total, 0.66)
  assert.ok(offPeak.notes.includes(SESSION_COST_COPY.offPeakRates))

  // Weekends are fully off-peak even inside the hour ranges.
  const weekend = at(WEEKEND_AT)
  assert.ok(weekend)
  assert.equal(weekend.peak, false)
  assert.equal(weekend.total, 0.66)
})

test('isPeakHour() is end-exclusive and weekday-only', () => {
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 0, 59), PEAK_HOURS), false)
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 1, 0), PEAK_HOURS), true)
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 3, 59), PEAK_HOURS), true)
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 4, 0), PEAK_HOURS), false)
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 6, 0), PEAK_HOURS), true)
  assert.equal(isPeakHour(Date.UTC(2026, 8, 16, 10, 0), PEAK_HOURS), false)
  assert.equal(isPeakHour(WEEKEND_AT, PEAK_HOURS), false)
})

test('an unpublished cache-write rate is surfaced, not guessed, and the total stays a floor', () => {
  const table: CommandCodePriceTable = {
    models: [{ id: 'commandcode/test-flat', slug: 'test-flat', inputCost: 1, outputCost: 2, cacheReadCost: 0.1 }],
    peakHours: PEAK_HOURS,
  }
  const view = buildSessionCostView(input({ table, usage: { uncachedInputTokens: 1_000_000, cacheWriteTokens: 500_000 } }))
  assert.ok(view)
  assert.equal(view.unpricedCacheWriteTokens, 500_000)
  assert.ok(view.notes.includes(SESSION_COST_COPY.unpricedCacheWrite))
  // The unpriced bucket contributes nothing rather than being charged at the
  // input rate, so the total is a FLOOR.
  assert.equal(view.total, 1)
  const write = view.rows.find((row) => row.key === 'cacheWrite')
  assert.ok(write)
  assert.equal(write.tokens, 500_000)
  assert.equal(write.costText, undefined)
})

test('a free model reads as Free with zero rows priced', () => {
  const table: CommandCodePriceTable = {
    models: [{ id: 'commandcode/test-flat', slug: 'test-flat', inputCost: 0, outputCost: 0, cacheReadCost: 0, free: true }],
    peakHours: PEAK_HOURS,
  }
  const view = buildSessionCostView(input({ table }))
  assert.ok(view)
  assert.equal(view.free, true)
  assert.equal(view.value, SESSION_COST_COPY.free)
  assert.equal(view.total, 0)
  // A free session carries no rate-half note: there is no rate in force.
  assert.equal(view.notes.length, 0)
  for (const decoration of sessionCostRowDecorations(view)) {
    assert.equal(decoration.amount, undefined)
  }
})

test('a session served by more than one model marks its total approximate', () => {
  const view = buildSessionCostView(input({
    selection: {
      lastUsed: { provider: 'commandcode', model: 'commandcode/test-flat' },
      next: { provider: 'commandcode', model: 'commandcode/other' },
    },
  }))
  assert.ok(view)
  assert.equal(view.approximate, true)
  assert.equal(view.value, `${SESSION_COST_COPY.approximate}$2.00`)
  assert.ok(view.notes.includes(SESSION_COST_COPY.approximateNote))
})

test('a pending selection on the same model is not approximate', () => {
  const view = buildSessionCostView(input({
    selection: {
      lastUsed: { provider: 'commandcode', model: 'commandcode/test-flat' },
      next: { provider: 'commandcode', model: 'commandcode/test-flat' },
    },
  }))
  assert.ok(view)
  assert.equal(view.approximate, false)
})

test('the lookup index answers the page slug as a second key', () => {
  // A row no catalog model claims is served under the page's slug, so a session
  // reporting that slug still prices.
  const view = buildSessionCostView(input({
    selection: { lastUsed: { provider: 'commandcode', model: 'test-flat' }, next: null },
  }))
  assert.ok(view)
  assert.equal(view.total, 2)
})

test('sessionCostAmount() states a bound instead of a flat $0.0000', () => {
  assert.equal(sessionCostAmount(0), '$0.00')
  assert.equal(sessionCostAmount(-1), '$0.00')
  assert.equal(sessionCostAmount(0.000_05), '<$0.0001')
  assert.equal(sessionCostAmount(0.0001), '$0.0001')
  // From a tenth of a cent up, the amount reads as cents — the same convention
  // the account panel uses for billing windows.
  assert.equal(sessionCostAmount(0.009), '$0.0090')
  assert.equal(sessionCostAmount(0.0123), '$0.01')
  assert.equal(sessionCostAmount(1.234), '$1.23')
})

test('the pill run keeps the separator node the shipped pill styles', () => {
  const view = buildSessionCostView(input())
  assert.ok(view)
  assert.deepEqual(sessionCostPillRun(view), { separator: SESSION_COST_COPY.separator, value: '$2.00' })
})

test('dialog rows are decorated positionally, and unpriced rows stay untouched', () => {
  const view = buildSessionCostView(input({
    usage: { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 7 },
  }))
  assert.ok(view)
  const rows = sessionCostRowDecorations(view)
  assert.deepEqual(rows.map((row) => row.row), ['cacheHit', 'uncachedInput', 'cacheRead', 'cacheWrite', 'output'])
  // Every row carries the token count the shipped cell must be showing, which
  // is how the display layer proves the position is right before decorating.
  assert.equal(rows[1]?.tokens, 1_000_000)
  assert.equal(rows[2]?.tokens, 2_000_000)
  assert.equal(rows[3]?.tokens, 7)
  assert.equal(rows[4]?.tokens, 500_000)
  // The cache-hit row is a percentage, so it is never priced.
  assert.equal(rows[0]?.tokens, undefined)
  assert.equal(rows[0]?.amount, undefined)
  // Cache-write tokens exist but have no published rate: the row is hidden
  // rather than shown as `$0.00`.
  assert.equal(rows[3]?.hidden, true)
  assert.equal(rows[3]?.amount, undefined)
  // A priced row carries its own amount, formatted for its magnitude.
  assert.equal(rows[1]?.amount, '$1.00')
})

test('the cache-hit row is absent when no prompt token was billed', () => {
  const view = buildSessionCostView(input({ usage: { outputTokens: 500_000 } }))
  assert.ok(view)
  assert.deepEqual(sessionCostRowDecorations(view).map((row) => row.row), ['uncachedInput', 'cacheRead', 'output'])
})
