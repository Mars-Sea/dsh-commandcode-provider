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
  USAGE_AUTO_REFRESH_COALESCE_MS,
  USAGE_AUTO_RETRY_MS,
  compactCountTitle,
  formatCompactCount,
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

/** A remote whose report behaviour each test scripts. `models()` is part of the `UsageRemote` contract but unscripted here. */
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
  // 进位：先除以档位再四舍五入会算出 1000.0K 这种既超长、又落在不存在的档位上的文本。
  assert.equal(formatTokensCompact(999_999), '1.0M')
  assert.equal(formatTokensCompact(999_999_999), '1.0B')
})

test('formatCompactCount drops a redundant .0 and carries into the next unit', () => {
  assert.equal(formatCompactCount(0), '0')
  assert.equal(formatCompactCount(999), '999')
  assert.equal(formatCompactCount(1_000), '1K')
  assert.equal(formatCompactCount(1_234), '1.2K')
  assert.equal(formatCompactCount(12_000), '12K')
  assert.equal(formatCompactCount(99_999), '100K')
  assert.equal(formatCompactCount(999_999), '1M')
  assert.equal(formatCompactCount(1_500_000), '1.5M')
  assert.equal(formatCompactCount(999_999_999), '1B')
})

test('compactCountTitle speaks up only when the compact form lost information', () => {
  // 没有换算时不挂 title：悬停弹出的内容与卡片上写的一模一样，没有意义。
  assert.equal(compactCountTitle([['成功', 123], ['失败', 7]]), undefined)
  assert.equal(compactCountTitle([['成功', 1_234], ['失败', 7]]), '成功 1234 · 失败 7')
  // 只要有一项被换算，整行都给出精确值，避免同一张卡上精确与近似混着看。
  assert.equal(compactCountTitle([['成功', 123], ['失败', 1_024]]), '成功 123 · 失败 1024')
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

test('自动刷新会合并刚刚读到的结果，显式刷新永远重新去读', async (t) => {
  // 面板与账户卡片会各自在首屏自动发起一次读取（重挂载、重渲染也会再触发），
  // 而一份报告是四次上游调用。同一账号的同一份答案没有必要付两次钱 —— 但这条
  // 合并只属于「没人点过任何东西」的路径：用户按下刷新、保存配置、换凭据之后，
  // 读到的必须是新的。
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let calls = 0
  const controller = new CommandCodeUsageController(makeRemote(async () => {
    calls++
    return { ok: true, value: makeReport() }
  }))
  await controller.refresh({ auto: true })
  assert.equal(calls, 1)
  const firstFetchedAt = controller.state().fetchedAt
  assert.equal(typeof firstFetchedAt, 'number')

  // 同一毫秒窗口内的第二次自动读取：合并，不再发起请求，时间戳也不动。
  await controller.refresh({ auto: true })
  assert.equal(calls, 1, '自动路径应合并刚刚读到的结果')
  assert.equal(controller.state().fetchedAt, firstFetchedAt, '合并不能伪造新的读取时间')

  // 显式刷新不受窗口限制：用户要求的就是新数字。
  await controller.refresh()
  assert.equal(calls, 2, '显式刷新必须真的去读')

  // 窗口过去之后，自动路径也会重新读取。
  now += USAGE_AUTO_REFRESH_COALESCE_MS + 1
  await controller.refresh({ auto: true })
  assert.equal(calls, 3)
  controller.dispose()
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
  assert.equal(failed.shouldRefresh, true,
    '失败之后卡片要能自愈；限速由 controller 的 30 秒冷却窗负责，不是靠永不重试')
  assert.equal(failed.loading, false)
  controller.dispose()
})

test('失败后的自动刷新按 30 秒冷却重试，显式刷新不受限制', async (t) => {
  // 设置卡片靠一条订阅 While 循环复检；如果失败后 auto 还能随时发请求，
  // 每帧渲染都会打一次上游。冷却窗是这条自愈路径的硬约束。
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let calls = 0
  const controller = new CommandCodeUsageController(makeRemote(async () => {
    calls++
    return { ok: false as const, error: { message: 'boom' } }
  }))
  await controller.refresh({ auto: true })
  assert.equal(calls, 1)
  assert.equal(controller.state().status, 'error')
  assert.equal(usageCardState(controller.state()).shouldRefresh, true)

  // 冷却窗内：自动路径被挡住，状态保持不变。
  await controller.refresh({ auto: true })
  assert.equal(calls, 1, '冷却窗内的自动刷新不能打到上游')

  now += USAGE_AUTO_RETRY_MS - 1
  await controller.refresh({ auto: true })
  assert.equal(calls, 1, '窗口差 1 毫秒仍然挡住')

  now += 1
  await controller.refresh({ auto: true })
  assert.equal(calls, 2, '冷却结束后自动路径会真的重试一次')

  // 用户点刷新属于显式路径：冷却不生效，必须立刻去读。
  await controller.refresh()
  assert.equal(calls, 3, '显式刷新不受冷却窗限制')
  controller.dispose()
})

test('部分端点失败的报告仍算待复检，重试窗口按 30 秒计', async (t) => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let calls = 0
  const partial = makeReport()
  partial.accounts[0]!.report.failures = ['/alpha/usage/summary: HTTP 503']
  const controller = new CommandCodeUsageController(makeRemote(async () => {
    calls++
    return { ok: true, value: partial }
  }))
  await controller.refresh({ auto: true })
  assert.equal(calls, 1)
  assert.equal(controller.state().status, 'ready', '报告本身是可用状态，只是不完整')
  assert.equal(usageCardState(controller.state()).shouldRefresh, true, '不完整的报告值得再要一次')

  await controller.refresh({ auto: true })
  assert.equal(calls, 1, '失败窗口内不重复请求')
  now += USAGE_AUTO_RETRY_MS
  await controller.refresh({ auto: true })
  assert.equal(calls, 2, '窗口过后重试一次')
  controller.dispose()
})

