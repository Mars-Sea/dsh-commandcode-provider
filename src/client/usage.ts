/**
 * Browser controller for the settings page's account-usage card.
 *
 * The card renders the same account/usage/credit facts the `/commandcode`
 * command prints, fetched Host-side through the `commandcode/report` Remote
 * (the browser never holds the API key). This controller owns the fetch
 * lifecycle — idle/loading/ready/error, one in-flight request at a time,
 * stale-response dropping — and the display formatting, so the React
 * component stays a thin renderer and node tests can drive everything.
 *
 * @module dsh-commandcode-provider/client/usage
 */

import type { CommandCodeAccountsReport, CommandCodeCatalog, CommandCodePriceTable } from '../usage-wire.ts'
import type { CommandCodeLoginStatus } from '../login-wire.ts'
import type { EnrollmentRemote } from './enrollment.ts'
import type { AnalyticsRemote } from './analytics.ts'
import type { AnalyticsQuery, AnalyticsReport } from '../analytics-wire.ts'
import type { CommandCodeProbeResult } from '../service-probe-wire.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { readableErrorText } from '../readable-error.ts'
export { compactCountTitle, formatCompactCount, formatMoney, formatMoneyExact, formatTokensCompact, formatSuccessRate, windowRatio, formatResetAt } from '../display-format.ts'

/**
 * Merge the plugin's Remote endpoints into the harness's typed client Remote
 * surface, so `ctx.remote.commandcode.*()` is typed once each contribution is
 * mounted. The `commandcode` namespace member is declared exactly once here
 * (interface merging forbids duplicate members) and therefore carries the usage
 * report, the model catalog, the price table AND the login endpoints.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'commandcode/report': () => Promise<RemoteResult<CommandCodeAccountsReport>>
    'commandcode/models': () => Promise<RemoteResult<CommandCodeCatalog>>
    'commandcode/prices': () => Promise<RemoteResult<CommandCodePriceTable>>
    'commandcode/analytics': (query: AnalyticsQuery) => Promise<RemoteResult<AnalyticsReport>>
    'commandcode/probe': () => Promise<RemoteResult<CommandCodeProbeResult>>
  }
  interface TypertRemoteNamespaceMap {
    commandcode: Partial<EnrollmentRemote> & AnalyticsRemote & {
      report: () => Promise<RemoteResult<CommandCodeAccountsReport>>
      models: () => Promise<RemoteResult<CommandCodeCatalog>>
      /**
       * Optional because the Host half and this browser bundle can be a
       * cross-version pair: a Host older than the price table mounts no
       * `commandcode/prices` descriptor, so the member is genuinely absent at
       * runtime. The price controller reads a missing method as "no table"
       * (see `./prices.ts`) instead of throwing.
       */
      prices?: () => Promise<RemoteResult<CommandCodePriceTable>>
      /**
       * Optional for the same cross-version reason: a Host older than the
       * connectivity probe mounts no `commandcode/probe` descriptor, so the
       * status row reads a missing member as "probe unavailable" instead of
       * throwing. See `./service-status.ts`.
       */
      probe?: () => Promise<RemoteResult<CommandCodeProbeResult>>
      loginBegin: () => Promise<RemoteResult<CommandCodeLoginStatus>>
      loginStatus: () => Promise<RemoteResult<CommandCodeLoginStatus>>
      loginCancel: () => Promise<RemoteResult<CommandCodeLoginStatus>>
    }
  }
}

/** The narrow slice of the mounted Remote this controller calls. */
export interface UsageRemote {
  report(): Promise<
    | { ok: true; value: CommandCodeAccountsReport }
    | { ok: false; error: { message: string } }
  >
  models(): Promise<
    | { ok: true; value: CommandCodeCatalog }
    | { ok: false; error: { message: string } }
  >
  /**
   * Optional for the same cross-version reason as the namespace member above;
   * `CommandCodePricesController` reads the absence as a permanent "no prices"
   * state.
   */
  prices?(): Promise<
    | { ok: true; value: CommandCodePriceTable }
    | { ok: false; error: { message: string } }
  >
}

/** The card's fetch lifecycle. */
export type UsageStatus =
  /** Never fetched (no API key configured yet, or not requested). */
  | 'idle'
  /** A fetch is in flight; `report` retains the last good data if any. */
  | 'loading'
  /** The last fetch succeeded. */
  | 'ready'
  /** The last fetch failed (no key, unreachable host, old plugin). */
  | 'error'

/** The card's full state face. */
export interface UsagePageState {
  status: UsageStatus
  /** The last successfully fetched report (retained across refetches). */
  report: CommandCodeAccountsReport | undefined
  /** The last failure's message (error status). */
  error: string | undefined
  /** Millis timestamp of the last successful fetch. */
  fetchedAt: number | undefined
}

const IDLE: UsagePageState = { status: 'idle', report: undefined, error: undefined, fetchedAt: undefined }

/**
 * How long an AUTO refresh may reuse the result of one already in flight or
 * just finished.
 *
 * One report costs four upstream calls, and several surfaces ask for it without
 * the user asking for anything: the settings page's account card and the panel
 * both fetch on first paint, and a remount or a re-render can run those effects
 * again seconds apart. That is the same report about the same account — paying
 * for it twice buys nothing.
 *
 * The window is deliberately tiny. It exists to collapse a duplicate, not to
 * serve stale data: anything older than this is fetched again, and `fetchedAt`
 * therefore still names the moment these numbers were actually read. An
 * EXPLICIT refresh (the refresh button, a save, a credential change) never
 * consults it at all — the user asked, so the answer must be new.
 */
export const USAGE_AUTO_REFRESH_COALESCE_MS = 5_000

/**
 * How soon an AUTO refresh may try again after a FAILED or PARTIAL report.
 *
 * The settings card used to ask the Host exactly once per mount (`idle` only),
 * so one blip — a dropped connection, a 5xx — stayed on the card until the user
 * pressed refresh, which read as "it errors all the time". The card now keeps a
 * re-check loop while it still has something to fix (`usageCardState()
 * .shouldRefresh`), and this window is what keeps that loop from becoming a
 * request storm: a report costs four upstream calls, and the failure it retries
 * is usually a moment-old transient. Success keeps the much smaller
 * {@link USAGE_AUTO_REFRESH_COALESCE_MS} window, because there is nothing to
 * retry there — only a duplicate to collapse.
 */
export const USAGE_AUTO_RETRY_MS = 30_000

/**
 * How many AUTO attempts the CARD's re-check loop may spend before it gives up.
 *
 * The loop exists to clear a blip, not to hammer a permanent refusal: an
 * expired key or a rejected request answers the same way every 30 seconds, and
 * each attempt is four upstream calls. After this many attempts the card keeps
 * its error and waits for the user (the refresh button, a save, or a fresh
 * mount — a remount starts a new loop). The limit lives at the SURFACE rather
 * than in the controller on purpose: the sidebar panel's two-minute tick shares
 * `refresh({ auto: true })` and must keep running; only the card's fast loop is
 * what a permanent failure could turn into a storm.
 */
export const USAGE_AUTO_RETRY_LIMIT = 5

/**
 * Controller bridging the `commandcode/report` Remote onto the card. Public
 * API mirrors {@link CommandCodeSettingsController}: `state()` projections,
 * `subscribe`, and one `refresh()` action.
 */
export class CommandCodeUsageController {
  private readonly remote: UsageRemote
  private readonly listeners = new Set<() => void>()
  private current: UsagePageState = IDLE
  private generation = 0
  private inFlight = false
  private disposed = false
  /**
   * Earliest instant the next AUTO refresh may reach the Host. Set after every
   * settle: `USAGE_AUTO_REFRESH_COALESCE_MS` after a clean report (only a
   * duplicate to collapse), {@link USAGE_AUTO_RETRY_MS} after a failure or a
   * partial one (a real retry, deliberately slower). Explicit refreshes never
   * consult it — the user asked, so the answer must be new.
   */
  private autoCooldownUntil = 0

  constructor(remote: UsageRemote) {
    this.remote = remote
  }

  /** Release every subscription. Idempotent; in-flight results are dropped. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.listeners.clear()
  }

  /** Subscribe to state projections. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The current card state face. */
  state(): UsagePageState {
    return this.current
  }

  /**
   * Fetch (or refetch) the report. Concurrent refreshes collapse onto one
   * request; a superseded fetch's late result is dropped, never published.
   *
   * `auto` marks a refresh nobody asked for — a surface appearing, the card's
   * own re-check loop, or the panel's background tick. Those are held back by
   * {@link CommandCodeUsageController.autoCooldownUntil}: a duplicate of a
   * report fetched a moment ago is skipped (nothing new to learn), and a retry
   * after a failure is spaced by {@link USAGE_AUTO_RETRY_MS} so one broken
   * endpoint cannot turn the card's re-check into a request loop. Every other
   * caller is a user action and always goes to the wire.
   */
  async refresh(options?: { auto?: boolean }): Promise<void> {
    if (this.disposed || this.inFlight) return
    if (options?.auto === true && Date.now() < this.autoCooldownUntil) return
    const generation = ++this.generation
    this.inFlight = true
    this.current = { ...this.current, status: 'loading', error: undefined }
    this.publish()
    try {
      const response = await this.remote.report()
      if (this.disposed || generation !== this.generation) return
      if (response.ok) {
        const fetchedAt = Date.now()
        this.current = { status: 'ready', report: response.value, error: undefined, fetchedAt }
        this.autoCooldownUntil = fetchedAt + (reportIncomplete(response.value)
          ? USAGE_AUTO_RETRY_MS
          : USAGE_AUTO_REFRESH_COALESCE_MS)
      } else {
        this.current = { ...this.current, status: 'error', error: response.error.message }
        this.autoCooldownUntil = Date.now() + USAGE_AUTO_RETRY_MS
      }
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return
      this.current = {
        ...this.current,
        status: 'error',
        error: readableErrorText(error),
      }
      this.autoCooldownUntil = Date.now() + USAGE_AUTO_RETRY_MS
    } finally {
      if (generation === this.generation) this.inFlight = false
    }
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}

/** Whether a report arrived but some endpoint did not (a retry is worth spending). */
function reportIncomplete(report: CommandCodeAccountsReport): boolean {
  return report.accounts.some(account => account.report.failures.length > 0)
}

/** Host facts drive the usage card, including keys invisible to browser credentials. */
export function usageCardState(usage: UsagePageState) {
  const accounts = usage.report?.accounts ?? []
  return {
    loading: usage.status === 'loading',
    // Three states still owe the card a read: never fetched (idle), the last
    // whole call failed (error), and the report arrived with failed endpoints
    // (ready + failures). All three feed the card's re-check loop; the
    // controller's cooldown is what keeps the failed ones from looping.
    shouldRefresh: usage.status === 'idle'
      || usage.status === 'error'
      || (usage.status === 'ready' && reportIncomplete(usage.report ?? { accounts: [] })),
    noKey: accounts.length > 0 && !accounts.some(account => account.configured),
  }
}
