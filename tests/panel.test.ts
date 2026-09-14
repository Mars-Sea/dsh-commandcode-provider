/**
 * Plans & quota panel projection tests (node:test, zero deps). Run with `npm test`.
 *
 * The panel is the sidebar footer card + the center dashboard, and its whole
 * user-visible truth is one projection (`buildPanelView`). This file drives
 * that projection — plus the shared auto-refresh loop — from hand-built usage
 * snapshots, so what is pinned here is what the two surfaces render.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PANEL_AUTO_REFRESH_MS,
  buildPanelView,
  resetPanelAutoRefresh,
  startPanelAutoRefresh,
  type AutoRefreshTimer,
} from '../src/client/panel.ts'
import type { UsagePageState } from '../src/client/usage.ts'
import type { CommandCodeAccountUsage } from '../src/usage-wire.ts'
import type { CommandCodeUsageReport } from '../src/adapter.ts'

/** One account entry with only the fields a test cares about spelled out. */
function entry(overrides: {
  id?: string
  label?: string
  active?: boolean
  configured?: boolean
  mark?: string
  cooldownUntil?: number
  report?: Partial<CommandCodeUsageReport>
} = {}): CommandCodeAccountUsage {
  return {
    id: overrides.id ?? 'default',
    label: overrides.label ?? 'Default',
    configured: overrides.configured ?? true,
    active: overrides.active ?? true,
    mark: overrides.mark ?? '',
    cooldownUntil: overrides.cooldownUntil ?? 0,
    report: {
      failures: [],
      ...overrides.report,
    } as CommandCodeUsageReport,
  }
}

function usage(overrides: Partial<UsagePageState> = {}): UsagePageState {
  return {
    status: 'ready',
    report: { accounts: [] },
    error: undefined,
    fetchedAt: undefined,
    ...overrides,
  }
}

const CREDITS = {
  monthlyCredits: 60,
  purchasedCredits: 5,
  freeCredits: 2,
  fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: 0 },
  weekly: { used: 1.32, cap: 6, exceeded: false, resetAt: 0 },
}

test('no credential renders the key prompt, not an empty dashboard', () => {
  const view = buildPanelView({ usage: usage(), apiKeyConfigured: false })
  assert.equal(view.noKey, true)
  assert.equal(view.accounts.length, 0)
})

test('a first fetch with no data renders the loading state', () => {
  const view = buildPanelView({
    usage: usage({ status: 'loading', report: undefined }),
    apiKeyConfigured: true,
  })
  assert.equal(view.loading, true)
  assert.equal(view.noKey, false)
})

test('accounts are deduplicated by id and staged removals are hidden', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [
          entry({ id: 'default', label: 'A' }),
          entry({ id: 'default', label: 'A again' }),
          entry({ id: 'COMMANDCODE_API_KEY_2', label: 'B' }),
        ],
      },
    }),
    apiKeyConfigured: true,
    removingIds: ['COMMANDCODE_API_KEY_2'],
  })
  assert.deepEqual(view.accounts.map((account) => account.id), ['default'])
})

test('the panel opens on the serving account, not the first one', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [
          entry({ id: 'default', active: false }),
          entry({ id: 'COMMANDCODE_API_KEY_2', active: true, label: 'Second' }),
        ],
      },
    }),
    apiKeyConfigured: true,
  })
  assert.equal(view.selectedId, 'COMMANDCODE_API_KEY_2')
  assert.equal(view.selected?.label, 'Second')
})

test('an over-cap window keeps its true percentage and clamps only the bar', () => {
  const view = buildPanelView({
    usage: usage({
      report: { accounts: [entry({ report: { credits: { ...CREDITS, fiveHour: { used: 4.5, cap: 3, exceeded: true, resetAt: 0 } } } })] },
    }),
    apiKeyConfigured: true,
  })
  const fiveHour = view.selected?.windows.find((window) => window.label === 'fiveHour')
  assert.ok(fiveHour)
  assert.equal(fiveHour.percent, 150)
  assert.equal(fiveHour.barPercent, 100)
  assert.equal(fiveHour.exceeded, true)
})

test('the footer card stacks 5-hour then weekly, and leaves uncapped windows out', () => {
  const view = buildPanelView({
    usage: usage({ report: { accounts: [entry({ report: { credits: CREDITS } })] } }),
    apiKeyConfigured: true,
  })
  assert.deepEqual(view.footerBars.map((bar) => bar.label), ['fiveHourShort', 'weeklyShort'])
  assert.equal(view.footerBars[0]?.percent, '100%')
  assert.equal(view.footerBars[0]?.warn, true)
  assert.equal(view.footerBars[0]?.detail, '$3.00 / $3.00')
  assert.equal(view.footerBars[1]?.percent, '22%')
  assert.equal(view.footerBars[1]?.warn, false)

  const uncapped = buildPanelView({
    usage: usage({
      report: {
        accounts: [entry({ report: { credits: { ...CREDITS, weekly: { used: 1, cap: 0, exceeded: false, resetAt: 0 } } } })],
      },
    }),
    apiKeyConfigured: true,
  })
  assert.deepEqual(uncapped.footerBars.map((bar) => bar.label), ['fiveHourShort'])
})

test('the accessible footer title carries the visible figures', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [entry({
          report: {
            credits: CREDITS,
            plan: { planId: 'individual-pro', name: 'Pro', status: 'active', monthlyCredits: 60, currentPeriodEnd: 0 },
            usage: {
              totalCount: 12,
              totalCost: 1.32,
              successRate: 99.9,
              completedCount: 11,
              failedCount: 1,
              totalCredits: 1.4,
              totalTokensIn: 1000,
              totalTokensOut: 200,
              periodBasis: 'billing-period',
            },
          },
        })],
      },
    }),
    apiKeyConfigured: true,
  })
  assert.match(view.footTitle, /^Command Code · Pro/)
  assert.match(view.footTitle, /5-hour \$3\.00 \/ \$3\.00 \(100%\)/)
  assert.match(view.footTitle, /Weekly \$1\.32 \/ \$6\.00 \(22%\)/)
  assert.match(view.footTitle, /\$1\.32/)
  assert.equal(view.planName, 'Pro')
})

test('monthly consumption is the CLI\'s limit-minus-remaining derivation', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [entry({
          report: {
            credits: CREDITS,
            plan: { planId: 'individual-pro', name: 'Pro', status: 'active', monthlyCredits: 60, currentPeriodEnd: 0 },
          },
        })],
      },
    }),
    apiKeyConfigured: true,
  })
  const monthly = view.selected?.monthly
  assert.ok(monthly)
  assert.equal(monthly.known, true)
  assert.equal(monthly.limit, '$60.00')
  // 60 credit limit minus the 60 remaining the billing endpoint reported.
  assert.equal(monthly.used, '$0.00')
  assert.equal(monthly.percent, 0)
  assert.equal(monthly.purchased, '$5.00')
  assert.equal(monthly.free, '$2.00')
})

test('an unknown limit draws no percentage rather than inventing a denominator', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [entry({
          report: {
            credits: CREDITS,
            plan: { planId: 'individual-unknown', name: 'Unknown', status: 'active', monthlyCredits: null, currentPeriodEnd: 0 },
          },
        })],
      },
    }),
    apiKeyConfigured: true,
  })
  const monthly = view.selected?.monthly
  assert.ok(monthly)
  // No denominator means no ratio: the view reports `known: false` and a zero
  // percentage, so the dashboard draws no bar instead of a fabricated 100%.
  assert.equal(monthly.known, false)
  assert.equal(monthly.percent, 0)
  assert.equal(monthly.barPercent, 0)
  assert.equal(monthly.exhausted, false)
  // The balances the billing endpoint did report still render.
  assert.equal(monthly.purchased, '$5.00')
  assert.equal(monthly.free, '$2.00')
})

test('an exhausted plan and a cooling-down account both read as states', () => {
  const view = buildPanelView({
    usage: usage({
      report: {
        accounts: [entry({
          active: false,
          mark: 'rate-limit',
          cooldownUntil: 1_700_000_000_000,
          report: {
            credits: { ...CREDITS, monthlyCredits: 0 },
            plan: { planId: 'individual-pro', name: 'Pro', status: 'active', monthlyCredits: 60, currentPeriodEnd: 0 },
          },
        })],
      },
    }),
    apiKeyConfigured: true,
  })
  assert.equal(view.selected?.mark, 'coolingDown')
  assert.notEqual(view.selected?.cooldownUntil, '')
  assert.equal(view.selected?.monthly?.exhausted, true)
})

test('a 401 across every endpoint surfaces the invalid-key box, not a generic error', () => {
  const view = buildPanelView({
    usage: usage({
      status: 'error',
      report: { accounts: [entry({ report: { failures: ['credits: 401'], blocked: 'invalid-key' } })] },
    }),
    apiKeyConfigured: true,
  })
  assert.equal(view.failure?.title, 'errorInvalidKey')
  assert.equal(view.failure?.hint, 'errorInvalidKeyHint')
})

test('a transport failure with no report renders the generic box with its reason', () => {
  const view = buildPanelView({
    usage: usage({ status: 'error', report: undefined, error: 'commandcode/report remote is not mounted' }),
    apiKeyConfigured: true,
  })
  assert.equal(view.failure?.title, 'errorGeneric')
  assert.equal(view.failure?.detail, 'commandcode/report remote is not mounted')
})

test('a failed refetch keeps the last good data on screen as stale', () => {
  const view = buildPanelView({
    usage: usage({
      status: 'error',
      error: 'network down',
      report: { accounts: [entry({ report: { credits: CREDITS } })] },
    }),
    apiKeyConfigured: true,
  })
  assert.equal(view.staleError, 'network down')
  assert.equal(view.accounts.length, 1)
  assert.equal(view.failure, undefined)
})

test('every string the view references exists in the copy table', () => {
  const view = buildPanelView({
    usage: usage({ report: { accounts: [entry({ report: { credits: CREDITS } })] } }),
    apiKeyConfigured: true,
  })
  const referenced = [
    ...view.footerBars.map((bar) => bar.label),
    ...(view.selected?.windows.map((window) => window.label) ?? []),
    ...(view.selected?.stats.map((stat) => stat.label) ?? []),
  ]
  for (const key of referenced) {
    assert.equal(typeof view.text[key], 'string', `${key} must render text, not a raw key`)
    assert.notEqual(view.text[key], '')
  }
})

// ---------------------------------------------------------------------------
// startPanelAutoRefresh
// ---------------------------------------------------------------------------

/** A timer seam that records schedules and lets a test fire them by hand. */
function fakeTimer(): AutoRefreshTimer & { fire(): void; pending(): number } {
  let callback: (() => void) | undefined
  let handle: unknown
  return {
    set(next: () => void): unknown {
      callback = next
      handle = {}
      return handle
    },
    clear(target: unknown): void {
      if (target === handle) {
        callback = undefined
        handle = undefined
      }
    },
    fire(): void {
      const next = callback
      callback = undefined
      next?.()
    },
    pending(): number {
      return callback === undefined ? 0 : 1
    },
  }
}

test('the auto-refresh loop fetches on mount, ticks, and stops on the last unmount', () => {
  resetPanelAutoRefresh()
  const timer = fakeTimer()
  let refreshes = 0
  const source = {
    state: () => usage(),
    refresh: async () => {
      refreshes += 1
    },
  }

  const stop = startPanelAutoRefresh(source, () => true, timer)
  assert.equal(refreshes, 1, 'the row must be current on arrival, not after a tick')
  assert.equal(timer.pending(), 1)

  timer.fire()
  assert.equal(refreshes, 2)
  assert.equal(timer.pending(), 1, 'the loop reschedules itself')

  stop()
  assert.equal(timer.pending(), 0)
  resetPanelAutoRefresh()
})

test('an unconfigured account is never polled, and a later key starts it', () => {
  resetPanelAutoRefresh()
  const timer = fakeTimer()
  let refreshes = 0
  let configured = false
  const source = {
    state: () => usage(),
    refresh: async () => {
      refreshes += 1
    },
  }

  const stop = startPanelAutoRefresh(source, () => configured, timer)
  assert.equal(refreshes, 0, 'no key means nothing to fetch')

  // The configuration fact is re-read per tick, so a key pasted mid-session
  // starts fresh data without re-registering the surface.
  configured = true
  timer.fire()
  assert.equal(refreshes, 1)

  stop()
  resetPanelAutoRefresh()
})

test('two mounted surfaces share one loop and one fetch', () => {
  resetPanelAutoRefresh()
  const timer = fakeTimer()
  let refreshes = 0
  const source = {
    state: () => usage(),
    refresh: async () => {
      refreshes += 1
    },
  }

  const stopSidebar = startPanelAutoRefresh(source, () => true, timer)
  const stopDashboard = startPanelAutoRefresh(source, () => true, timer)
  assert.equal(refreshes, 1, 'the second mount joins the running loop')

  // The surface that started the loop unmounting first must not stop it while
  // the other is still mounted.
  stopSidebar()
  timer.fire()
  assert.equal(refreshes, 2)

  stopDashboard()
  assert.equal(timer.pending(), 0)
  assert.equal(PANEL_AUTO_REFRESH_MS, 120_000)
  resetPanelAutoRefresh()
})
