/**
 * Account-usage controller tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the settings page's account-card fetch lifecycle: idle → loading
 * → ready/error, one in-flight request at a time, stale-response dropping,
 * and the display formatting helpers the component renders.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CommandCodeUsageController,
  usageCardState,
  formatMoney,
  formatMoneyExact,
  formatResetAt,
  formatSuccessRate,
  formatTokensCompact,
  windowRatio,
  type UsageRemote,
} from '../src/client/usage.ts'
import type { CommandCodeAccountsReport } from '../src/usage-wire.ts'

/** A minimal valid multi-account report fixture. */
function makeReport(): CommandCodeAccountsReport {
  return {
    accounts: [{
      id: 'default',
      label: 'Default',
      configured: true,
      active: true,
      mark: '',
      cooldownUntil: 0,
      report: {
        account: { id: 'u1', name: 'Mars', userName: 'mars-sea' },
        credits: {
          monthlyCredits: 50,
          purchasedCredits: 10,
          freeCredits: 2,
          fiveHour: { used: 1.5, cap: 5, exceeded: false, resetAt: 1_800_000_000_000 },
          weekly: { used: 12, cap: 100, exceeded: false, resetAt: 0 },
        },
        failures: [],
      },
    }],
  }
}

/**
 * A remote whose behaviour each test scripts. `models()` is part of the
 * `UsageRemote` contract the card is handed (the settings page's catalog
 * editor uses it), but these tests only drive the report lifecycle, so it
 * answers with an explicit "not scripted" failure rather than inventing a
 * catalog no test asserts on.
 */
function makeRemote(impl: () => Promise<Awaited<ReturnType<UsageRemote['report']>>>): UsageRemote & { calls: number } {
  const remote = {
    calls: 0,
    report() {
      remote.calls += 1
      return impl()
    },
    models: async () => ({ ok: false as const, error: { message: 'models() is not scripted in this test' } }),
  }
  return remote
}

test('starts idle with no report', () => {
  const controller = new CommandCodeUsageController(makeRemote(async () => ({ ok: true, value: makeReport() })))
  const state = controller.state()
  assert.equal(state.status, 'idle')
  assert.equal(state.report, undefined)
})

test('a successful refresh publishes the report and a fetch timestamp', async () => {
  const remote = makeRemote(async () => ({ ok: true, value: makeReport() }))
  const controller = new CommandCodeUsageController(remote)
  const seen: string[] = []
  controller.subscribe(() => seen.push(controller.state().status))
  await controller.refresh()
  assert.deepEqual(seen, ['loading', 'ready'])
  assert.equal(controller.state().report?.accounts[0]?.report.account?.userName, 'mars-sea')
  assert.equal(typeof controller.state().fetchedAt, 'number')
  assert.equal(remote.calls, 1)
})

test('a failed remote call lands in the error branch', async () => {
  const controller = new CommandCodeUsageController(
    makeRemote(async () => ({ ok: false, error: { message: 'MISSING_CREDENTIAL: no key' } })),
  )
  await controller.refresh()
  assert.equal(controller.state().status, 'error')
  assert.match(controller.state().error ?? '', /no key/)
})

test('a throwing remote call lands in the error branch', async () => {
  const controller = new CommandCodeUsageController(
    makeRemote(async () => { throw new Error('carrier exploded') }),
  )
  await controller.refresh()
  assert.equal(controller.state().status, 'error')
  assert.match(controller.state().error ?? '', /carrier exploded/)
})

test('concurrent refreshes collapse onto one in-flight request', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const remote = makeRemote(async () => {
    await gate
    return { ok: true, value: makeReport() }
  })
  const controller = new CommandCodeUsageController(remote)
  const first = controller.refresh()
  const second = controller.refresh()
  release()
  await Promise.all([first, second])
  assert.equal(remote.calls, 1)
  assert.equal(controller.state().status, 'ready')
})

test('an error retains the last good report', async () => {
  let fail = false
  const controller = new CommandCodeUsageController(makeRemote(async () => (
    fail ? { ok: false, error: { message: 'boom' } } : { ok: true, value: makeReport() }
  )))
  await controller.refresh()
  fail = true
  await controller.refresh()
  assert.equal(controller.state().status, 'error')
  assert.equal(controller.state().report?.accounts[0]?.report.account?.userName, 'mars-sea')
})

test('dispose drops a late in-flight result', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const controller = new CommandCodeUsageController(makeRemote(async () => {
    await gate
    return { ok: true, value: makeReport() }
  }))
  const pending = controller.refresh()
  controller.dispose()
  release()
  await pending
  assert.equal(controller.state().status, 'loading')
})

test('formatMoney and formatMoneyExact render dollar amounts', () => {
  assert.equal(formatMoney(1.5), '$1.50')
  assert.equal(formatMoneyExact(1.23456), '$1.2346')
})

test('formatTokensCompact renders K/M/B suffixes', () => {
  assert.equal(formatTokensCompact(999), '999')
  assert.equal(formatTokensCompact(1_900_000), '1.9M')
  assert.equal(formatTokensCompact(2_500), '2.5K')
  assert.equal(formatTokensCompact(3_000_000_000), '3.0B')
})

test('formatSuccessRate caps the precision at two decimals and trims trailing zeros', () => {
  assert.equal(formatSuccessRate(99.965552876334), '99.97')
  assert.equal(formatSuccessRate(100), '100')
  assert.equal(formatSuccessRate(97.6), '97.6')
  assert.equal(formatSuccessRate(33.333333333333), '33.33')
  assert.equal(formatSuccessRate(0), '0')
})

test('windowRatio clamps into [0, 1] and treats cap 0 as empty', () => {
  assert.equal(windowRatio(1.5, 5), 0.3)
  assert.equal(windowRatio(10, 5), 1)
  assert.equal(windowRatio(-1, 5), 0)
  assert.equal(windowRatio(3, 0), 0)
})

test('formatResetAt renders a local time and empty for unset', () => {
  assert.equal(formatResetAt(0), '')
  assert.equal(formatResetAt(-5), '')
  assert.notEqual(formatResetAt(1_800_000_000_000), '')
})

test('usage card fetches Host facts without browser credentials and keeps manual retry available', async () => {
  let calls = 0
  const controller = new CommandCodeUsageController({ models: async () => ({ ok: true, value: { models: [] } }), report: async () => {
    calls++
    return { ok: true, value: makeReport() }
  } })
  const initial = usageCardState(controller.state())
  assert.equal(initial.shouldRefresh, true)
  assert.equal(initial.noKey, false, 'no report is not proof that no key exists')
  if (initial.shouldRefresh) await controller.refresh()
  assert.equal(calls, 1)
  assert.equal(usageCardState(controller.state()).noKey, false, 'literal/CLI key availability comes from Host')
  assert.equal(usageCardState(controller.state()).shouldRefresh, false)
  const report = makeReport()
  report.accounts[0]!.configured = false
  const absent = usageCardState({ ...controller.state(), report })
  assert.equal(absent.noKey, true)
  assert.equal(absent.loading, false, 'refresh stays enabled even after a no-key report')
  const failed = usageCardState({ ...controller.state(), report: undefined, status: 'error' })
  assert.equal(failed.noKey, false)
  assert.equal(failed.shouldRefresh, false, 'a failure must not cause an automatic request loop')
  assert.equal(failed.loading, false)
  controller.dispose()
})
