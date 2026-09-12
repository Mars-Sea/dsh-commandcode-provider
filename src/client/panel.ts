/**
 * View layer for the Command Code plans & quota panel (the sidebar footer card
 * and the dashboard it opens in the center column).
 *
 * Deliberately JSX-free and React-free, mirroring `./settings.ts` and
 * `./usage.ts`: it turns the shared usage snapshot into one presentation
 * tree that both React components render, and it owns the one shared side
 * effect (the throttled background refresh that keeps the sidebar card
 * current). Node tests drive everything here without a DOM.
 *
 * Every displayed string is decided here, as a `PanelKey` plus a `text`
 * record resolved from `./panel-copy.ts` — so the components carry no
 * formatting, pluralization, or copy of their own, and the panel cannot
 * regress into the harness locale (see that module for why it is English-only).
 *
 * @module dsh-commandcode-provider/client/panel
 */

import type { CommandCodeUsageReport } from '../adapter.ts'
import type { CommandCodeAccountUsage } from '../usage-wire.ts'
import type { UsagePageState } from './usage.ts'
import {
  formatMoney,
  formatMoneyExact,
  formatSuccessRate,
  formatTokensCompact,
} from './usage.ts'
import { panelText, PANEL_COPY } from './panel-copy.ts'
import type { PanelKey } from './panel-copy.ts'

/** One quota window (5-hour or weekly) in display form. */
export interface PanelWindowView {
  /** Row-label key into the view's `text` record. */
  label: PanelKey
  /** `used / cap`, or just `used` when the window is uncapped. */
  value: string
  /** The window reports a cap, so `percent` is meaningful. */
  capped: boolean
  /** Percentage actually consumed (may exceed 100 when over the cap). */
  percent: number
  /** Fill width for the bar, clamped to [0, 100]. */
  barPercent: number
  /** Window is over its cap. */
  exceeded: boolean
  /** Local reset time, empty when the endpoint reported none. */
  resetsAt: string
}

/**
 * Monthly credit state, derived exactly the way the official CLI derives it
 * (`getCreditDepletionPct` in `command-code/dist/cli.mjs`): the plan's credit
 * total is the LIMIT, and the billing endpoint's `credits.monthlyCredits` is
 * the REMAINING balance, so consumption is `limit - remaining`. The CLI's own
 * wording for the same two numbers is `Plan: N% used, X credits left`.
 *
 * Purchased and free credits are separate balances that extend what an account
 * can spend, so they are reported as their own tiles rather than folded into
 * the limit.
 */
export interface PanelMonthlyView {
  /**
   * A limit is known (`plan.monthlyCredits` > 0), so `used` / `limit` and the
   * percentage are meaningful. When false the view still carries the balances
   * the billing endpoint reported, but draws no bar: a percentage needs a
   * denominator, and inventing one from a remaining balance would be wrong.
   */
  known: boolean
  /** Plan credit total for the period (the limit). */
  limit: string
  /** Consumed this period (`limit - remaining`). */
  used: string
  /** Credits still available. */
  remaining: string
  /** Purchased top-up balance. */
  purchased: string
  /** Promotional balance. */
  free: string
  /** Consumption as a percentage of the limit; 0 when there is no limit. */
  percent: number
  /** Fill width for the bar, clamped to [0, 100]. */
  barPercent: number
  /** The plan's credits are used up. */
  exhausted: boolean
  /** Billing period end, local date; empty when unreported. */
  periodEnds: string
}

/** One compact bar in the sidebar footer card. */
export interface PanelFooterBar {
  /** Row label key (short forms: `Monthly`, `5-hour`, `Weekly`). */
  label: PanelKey
  /** Printed right-hand percentage, e.g. `32%`; empty when there is no ratio. */
  percent: string
  /** Fill width, clamped to [0, 100]. */
  barPercent: number
  /** Render in the warning colour. */
  warn: boolean
  /**
   * This window's own spend against its limit, e.g. `$1.32 / $6.00`. RENDERED,
   * not just a tooltip: the card exists to show these figures, and the
   * magnitudes are small dollar amounts (the endpoint reports a Pro account's
   * five-hour cap as `3` and its weekly cap as `6`).
   */
  detail: string
}

/** One usage tile. */
export interface PanelStatView {
  label: PanelKey
  value: string
  /** Secondary line, empty when there is none. */
  sub: string
}

/** One pool account's report, ready to render. */
export interface PanelAccountView {
  id: string
  label: string
  /** The account's display name (user name, else account name); empty when unreported. */
  owner: string
  /** Subscription display name; empty when unreported. */
  planName: string
  /** Subscription status when it is not a plain `active`; empty otherwise. */
  planStatus: string
  /** Rotation/credential state ('invalidKey' / 'coolingDown'); undefined when plain. */
  mark: PanelKey | undefined
  /** Known cooldown end, appended to the cooling-down badge; empty otherwise. */
  cooldownUntil: string
  /** No credential resolved for this slot. */
  unconfigured: boolean
  /** Billing period end, empty when unreported. */
  periodEnds: string
  /** Whether the account currently serves requests. */
  active: boolean
  /** Monthly credit state; undefined when neither endpoint reported it. */
  monthly: PanelMonthlyView | undefined
  windows: PanelWindowView[]
  stats: PanelStatView[]
}

/** What actually went wrong, once — for the alert box. */
export interface PanelFailureView {
  title: PanelKey
  /** The actionable line under the title. */
  hint: PanelKey
  /** The underlying transport message, shown small; empty when there is none. */
  detail: string
}

/** The whole panel, in render order. */
export interface PanelView {
  /** Every English string this view references, by key. */
  text: Partial<Record<PanelKey, string>>
  /** Footer-card plan text (`Go`, `Pro`, …), or a state word. */
  planName: string
  /** Footer-card rotation/credential state line; empty when nothing to say. */
  status: string
  /**
   * The compact bars the sidebar footer card stacks: the two quota windows an
   * account actually runs into, 5-hour first then weekly. The monthly
   * limit/usage bar belongs to the DASHBOARD alone — it moves once a billing
   * period, whereas these two are what stop a session — so it is deliberately
   * absent here. A window with no cap is left out: there is no ratio to draw.
   */
  footerBars: PanelFooterBar[]
  /**
   * This period's spend in dollars, formatted; empty when the usage endpoint
   * reported nothing. NOT drawn as its own row — the card's visible figures are
   * the two windows' own spend (see {@link PanelFooterBar.detail}), and a
   * separate period total would sit next to the weekly window's near-identical
   * figure — so it rides the tooltip and the accessible name instead.
   */
  cost: string
  /**
   * The footer card's accessible name and tooltip: `Command Code · Pro ·
   * 5-hour $0.04 / $3.00 (1%) · Weekly $1.32 / $6.00 (22%) · Spend $1.32`.
   * Always starts with the visible title, so the accessible name contains the
   * visible label.
   */
  footTitle: string
  /** Every account, in rotation order (empty when there is nothing to show). */
  accounts: PanelAccountView[]
  /** Id of the account the panel opens on (the serving one), if any. */
  selectedId: string | undefined
  /** That account's view, for the footer card; undefined with no accounts. */
  selected: PanelAccountView | undefined
  /** A fetch is in flight and no data has landed for this paint. */
  loading: boolean
  /** No credential is configured at all. */
  noKey: boolean
  /** Report-level failure box; undefined when the report is usable. */
  failure: PanelFailureView | undefined
  /** A fetch failed while data is still on screen. */
  staleError: string | undefined
  /** Endpoint-level partial failure note; undefined when every endpoint answered. */
  partial: PanelKey | undefined
  /** Freshness line, empty when nothing has been fetched. */
  updatedAt: string
}

/** Inputs {@link buildPanelView} needs beyond the usage snapshot. */
export interface PanelViewInput {
  usage: UsagePageState
  /** Whether any account holds a credential (the settings controller's fact). */
  apiKeyConfigured: boolean
  /** Account ids staged for removal; hidden here immediately, like the settings card. */
  removingIds?: readonly string[]
}

/** A quota window's state as the wire carries it. */
interface WindowInput {
  used: number
  cap: number
  exceeded: boolean
  resetAt: number
}

/** `$1.23`, and `$0.0123` only when the amount is too small for cents to show it. */
function money(value: number): string {
  if (value === 0) return formatMoney(0)
  return Math.abs(value) < 0.01 ? formatMoneyExact(value) : formatMoney(value)
}

/** Local reset time; empty when the endpoint reported none. */
function resetText(ms: number): string {
  if (ms <= 0) return ''
  return new Date(ms).toLocaleString()
}

/** Local short date; empty when unset. */
function dateText(ms: number): string {
  if (ms <= 0) return ''
  return new Date(ms).toLocaleDateString()
}

/** Local time-of-day; empty when unset. */
function timeText(ms: number): string {
  if (ms <= 0) return ''
  return new Date(ms).toLocaleTimeString()
}

/**
 * Consumption as a percentage, NOT clamped at 100 — an over-quota window
 * reports its real overshoot (150%), which is what the printed figure should
 * say. Bar widths clamp separately via {@link barPercent}.
 */
function rawPercent(used: number, cap: number): number {
  if (cap <= 0) return 0
  return Math.round((used / cap) * 100)
}

/** A percentage usable as a CSS width, clamped into [0, 100]. */
function barPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent))
}

/** Build one quota-window view. */
function windowView(label: PanelKey, limit: WindowInput): PanelWindowView {
  const percent = rawPercent(limit.used, limit.cap)
  const capped = limit.cap > 0
  return {
    label,
    value: capped ? `${money(limit.used)} / ${money(limit.cap)}` : money(limit.used),
    capped,
    percent,
    barPercent: barPercent(percent),
    exceeded: limit.exceeded,
    resetsAt: resetText(limit.resetAt),
  }
}

/**
 * Build the monthly credit view from the two endpoints that carry it.
 *
 * The limit is the PLAN's credit total, not the billing endpoint's
 * `monthlyCredits` — that field is a remaining balance (see
 * {@link PanelMonthlyView}). Unknown plans (no `monthlyCredits` on the plan
 * record) therefore still show their balances, just without a ratio.
 *
 * Caveat inherited from the wire: `parseCreditLimits` defaults an absent
 * `credits.monthlyCredits` to 0, so an account whose billing endpoint answered
 * only window limits reads as fully consumed. The official CLI reads it the
 * same way (`Math.max(0, s?.monthlyCredits ?? 0)`), and the alternative —
 * treating 0 as "unknown" — would hide a genuinely exhausted account.
 */
function monthlyView(report: CommandCodeUsageReport): PanelMonthlyView | undefined {
  const credits = report.credits
  const plan = report.plan
  if (credits === undefined && plan === undefined) return undefined

  const remaining = Math.max(0, credits?.monthlyCredits ?? 0)
  const limitValue = plan?.monthlyCredits ?? null
  const known = limitValue !== null && limitValue > 0
  const used = known ? Math.max(0, limitValue - remaining) : 0
  const percent = known ? rawPercent(used, limitValue) : 0

  return {
    known,
    limit: money(limitValue ?? 0),
    used: money(used),
    remaining: money(remaining),
    purchased: money(Math.max(0, credits?.purchasedCredits ?? 0)),
    free: money(Math.max(0, credits?.freeCredits ?? 0)),
    percent,
    barPercent: barPercent(percent),
    exhausted: known && remaining <= 0,
    periodEnds: dateText(plan?.currentPeriodEnd ?? 0),
  }
}

/** Build one account's view. */
function accountView(entry: CommandCodeAccountUsage): PanelAccountView {
  const { report } = entry
  const account = report.account
  const plan = report.plan
  const credits = report.credits
  const usage = report.usage

  const stats: PanelStatView[] = []
  if (usage !== undefined) {
    stats.push({
      label: 'requests',
      value: String(usage.completedCount),
      sub: `${usage.failedCount} ${panelText('failed')}`,
    })
    stats.push({ label: 'successRate', value: `${formatSuccessRate(usage.successRate)}%`, sub: '' })
    stats.push({
      label: 'spend',
      value: formatMoneyExact(usage.totalCost),
      sub: `${formatMoney(usage.totalCredits)} credits`,
    })
    stats.push({
      label: 'tokens',
      value: formatTokensCompact(usage.totalTokensIn + usage.totalTokensOut),
      sub: `${formatTokensCompact(usage.totalTokensIn)} ${panelText('tokensIn')} / ${formatTokensCompact(usage.totalTokensOut)} ${panelText('tokensOut')}`,
    })
  }

  const windows: PanelWindowView[] = []
  if (credits !== undefined) {
    windows.push(windowView('fiveHour', credits.fiveHour))
    windows.push(windowView('weekly', credits.weekly))
  }

  // Rotation/credential state: the serving account first, then the two marks
  // the pool can carry, then a cooldown whose end time is known.
  let mark: PanelKey | undefined
  if (entry.active) mark = 'active'
  else if (entry.mark === 'invalid-credential') mark = 'invalidKey'
  else if (entry.cooldownUntil > 0 || entry.mark === 'rate-limit') mark = 'coolingDown'

  return {
    id: entry.id,
    label: entry.label,
    owner: account === undefined ? '' : account.userName || account.name,
    planName: plan?.name ?? '',
    planStatus: plan !== undefined && plan.status !== '' && plan.status !== 'active' ? plan.status : '',
    mark,
    cooldownUntil: entry.cooldownUntil > 0 ? resetText(entry.cooldownUntil) : '',
    unconfigured: !entry.configured,
    periodEnds: dateText(plan?.currentPeriodEnd ?? 0),
    active: entry.active,
    monthly: monthlyView(report),
    windows,
    stats,
  }
}

/** The report-level failure box, or undefined when the report is usable. */
function failureView(state: UsagePageState): PanelFailureView | undefined {
  const blocked = state.report?.accounts.find((entry) => entry.report.blocked !== undefined)?.report.blocked
  if (blocked === 'invalid-key') {
    return { title: 'errorInvalidKey', hint: 'errorInvalidKeyHint', detail: '' }
  }
  if (blocked === 'service-unavailable') {
    return { title: 'errorServiceUnavailable', hint: 'errorServiceUnavailableHint', detail: '' }
  }
  if (blocked === 'network') {
    return { title: 'errorNetwork', hint: 'errorNetworkHint', detail: '' }
  }
  // A transport-level failure (unmounted Remote, offline browser) arrives as
  // the controller's own error rather than as a blocked report.
  if (state.status === 'error' && state.report === undefined) {
    return { title: 'errorGeneric', hint: 'errorGeneric', detail: state.error ?? '' }
  }
  return undefined
}

/**
 * Every panel string, resolved once per projection. One object with all keys
 * (rather than per-field lookups in the components) keeps the copy table and
 * the render sites in lockstep: a key cannot be read from `text` unless
 * {@link PANEL_COPY} declares it.
 */
function panelStrings(): Record<PanelKey, string> {
  const keys = Object.keys(PANEL_COPY) as PanelKey[]
  const out = {} as Record<PanelKey, string>
  for (const key of keys) out[key] = panelText(key)
  return out
}

/**
 * Project the shared usage snapshot into the panel's render tree.
 *
 * Deduplication matches the settings card: hand-edited settings can name one
 * credential twice, and removal staging hides an account before the post-save
 * refresh lands.
 */
export function buildPanelView(input: PanelViewInput): PanelView {
  const { usage } = input
  const hidden = new Set(input.removingIds ?? [])
  const seen = new Set<string>()
  const entries = (usage.report?.accounts ?? []).filter((entry) => {
    if (hidden.has(entry.id)) return false
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
  const accounts = entries.map(accountView)
  const selectedEntry = entries.find((entry) => entry.active) ?? entries[0]
  const selectedView = accounts.find((view) => view.id === selectedEntry?.id)

  // The footer card stacks BOTH quota windows — the two limits an account
  // actually runs into — 5-hour first (the tighter and nearer one), then
  // weekly. `barPercent` clamps the fill; the printed percentage keeps the true
  // consumption, so an over-cap window still reads 150%.
  const footerBars: PanelFooterBar[] = []
  const windowBars: Array<[PanelKey, WindowInput | undefined]> = [
    ['fiveHourShort', selectedEntry?.report.credits?.fiveHour],
    ['weeklyShort', selectedEntry?.report.credits?.weekly],
  ]
  for (const [label, window] of windowBars) {
    if (window === undefined || window.cap <= 0) continue
    const percent = rawPercent(window.used, window.cap)
    footerBars.push({
      label,
      percent: `${percent}%`,
      barPercent: barPercent(percent),
      warn: window.exceeded,
      detail: `${money(window.used)} / ${money(window.cap)}`,
    })
  }

  // The card's one non-ratio figure: what this period has cost in dollars.
  const totalCost = selectedEntry?.report.usage?.totalCost
  const cost = totalCost === undefined ? '' : money(totalCost)

  let status = ''
  if (!input.apiKeyConfigured) status = panelText('unconfigured')
  else if (selectedView?.mark !== undefined && selectedView.mark !== 'active') status = panelText(selectedView.mark)
  else if (selectedEntry === undefined) status = panelText('unavailable')

  const planName = selectedView !== undefined && selectedView.planName !== '' ? selectedView.planName : panelText('nav')
  // `planName` falls back to the panel name, so it is only a second part when it
  // actually names a plan — otherwise the title would read `Command Code ·
  // Command Code`.
  const titleParts = planName === panelText('nav') ? [planName] : [panelText('nav'), planName]
  for (const bar of footerBars) {
    const figures = bar.detail === '' ? '' : ` ${bar.detail}`
    titleParts.push(`${panelText(bar.label)}${figures} (${bar.percent})`)
  }
  if (cost !== '') titleParts.push(`${panelText('spend')} ${cost}`)

  return {
    text: panelStrings(),
    planName,
    status,
    footerBars,
    cost,
    footTitle: titleParts.join(' · '),
    accounts,
    selectedId: selectedEntry?.id,
    selected: selectedView,
    loading: usage.status === 'loading' && usage.report === undefined,
    noKey: !input.apiKeyConfigured,
    failure: failureView(usage),
    staleError: usage.status === 'error' && usage.report !== undefined ? usage.error ?? '' : undefined,
    partial: (usage.report?.accounts.some((entry) => entry.report.failures.length > 0 && entry.report.blocked === undefined) ?? false)
      ? 'partial'
      : undefined,
    updatedAt: timeText(usage.fetchedAt ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Auto refresh (one shared loop, started by whichever surface mounts first)
// ---------------------------------------------------------------------------

/**
 * How often the panel re-reads the report while a surface is mounted. The
 * quota windows move slowly and one report costs four upstream calls, so this
 * is a background freshness tick, not a live meter.
 */
export const PANEL_AUTO_REFRESH_MS = 120_000

/** The narrow face of `CommandCodeUsageController` this module drives. */
export interface RefreshSource {
  state(): UsagePageState
  refresh(): Promise<void>
}

/** Timer seam: injectable so tests never wait on real time. */
export interface AutoRefreshTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The default timer (the client bundle runs in a browser; node tests inject one). */
const REAL_TIMER: AutoRefreshTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Live mount count of {@link startPanelAutoRefresh}. */
let references = 0
/** Owner ticket of the running loop, if any. */
let activeTicket: number | undefined
/** Ticket handed to the next starter. */
let ticketSeq = 0
/** Pending timer handle of the running loop. */
let handle: unknown

/**
 * Start the shared auto refresh. One fetch when the surface appears (the
 * sidebar row is the point of the panel — it must be current, not wait for a
 * click), then a tick every {@link PANEL_AUTO_REFRESH_MS} while a surface
 * stays mounted.
 *
 * Reference-counted: the sidebar entry and the dashboard can be mounted at
 * once, so only the first start fetches and only the last stop halts the loop.
 * Every tick goes through `usage.refresh()`, which already collapses a
 * concurrent fetch onto the in-flight one — a tick never double-fetches
 * against the settings page's own refresh.
 *
 * @param usage - the shared usage controller.
 * @param isConfigured - whether a credential exists right now (re-read per tick).
 * @param timer - timer seam for tests.
 * @returns the disposer that drops this surface's reference.
 */
export function startPanelAutoRefresh(
  usage: RefreshSource,
  isConfigured: () => boolean,
  timer: AutoRefreshTimer = REAL_TIMER,
): () => void {
  references += 1
  const ticket = ++ticketSeq
  const tick = (): void => {
    if (activeTicket !== ticket) return
    if (isConfigured()) void usage.refresh()
    handle = timer.set(tick, PANEL_AUTO_REFRESH_MS)
  }

  if (activeTicket === undefined) {
    activeTicket = ticket
    handle = timer.set(tick, PANEL_AUTO_REFRESH_MS)
    // First paint: refresh immediately so the row is never blank on arrival.
    if (isConfigured()) void usage.refresh()
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    references -= 1
    // Still mounted elsewhere: drop this reference only. Note the check is the
    // REFCOUNT, not this surface's ticket — the surface that started the loop
    // is not necessarily the last one to unmount, and a first-unmounted owner
    // must not be the reason a tick keeps firing.
    if (references > 0) return
    activeTicket = undefined
    if (handle !== undefined) {
      timer.clear(handle)
      handle = undefined
    }
  }
}

/**
 * Drop every live reference and halt the loop without a timer.
 *
 * Exported for tests only: the loop's state is module-level on purpose (two
 * surfaces, one upstream poll), so a test that mounts a surface must be able
 * to start from a clean slate. Production code releases through the disposer
 * {@link startPanelAutoRefresh} returns — the plugin's fiber unwinds it.
 */
export function resetPanelAutoRefresh(): void {
  references = 0
  activeTicket = undefined
  handle = undefined
}
