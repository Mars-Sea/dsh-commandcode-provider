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
  formatMoney,
  formatMoneyExact,
  formatResetAt,
  formatTokensCompact,
  windowRatio,
  type UsageRemote,
} from '../src/client/usage.ts'
import type { CommandCodeUsageReport } from '../src/adapter.ts'

/** A minimal valid report fixture. */
function makeReport(): CommandCodeUsageReport {
  return {
    account: { id: 'u1', name: 'Mars', userName: 'mars-sea' },
    credits: {
      monthlyCredits: 50,
      purchasedCredits: 10,
      freeCredits: 2,
      fiveHour: { used: 1.5, cap: 5, exceeded: false, resetAt: 1_800_000_000_000 },
      weekly: { used: 12, cap: 100, exceeded: false, resetAt: 0 },
    },
    failures: [],
  }
}

/** A remote whose behaviour each test scripts. */
function makeRemote(impl: () => Promise<Awaited<ReturnType<UsageRemote['report']>>>): UsageRemote & { calls: number } {
  const remote = {
    calls: 0,
    report() {
      remote.calls += 1
      return impl()
    },
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
  assert.equal(controller.state().report?.account?.userName, 'mars-sea')
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
  assert.equal(controller.state().report?.account?.userName, 'mars-sea')
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
