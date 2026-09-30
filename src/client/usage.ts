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
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { readableErrorText } from './error-text.ts'
export { formatMoney, formatMoneyExact, formatTokensCompact, formatSuccessRate, windowRatio, formatResetAt } from '../display-format.ts'

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
  }
  interface TypertRemoteNamespaceMap {
    commandcode: {
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
   */
  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) return
    const generation = ++this.generation
    this.inFlight = true
    this.current = { ...this.current, status: 'loading', error: undefined }
    this.publish()
    try {
      const response = await this.remote.report()
      if (this.disposed || generation !== this.generation) return
      if (response.ok) {
        this.current = { status: 'ready', report: response.value, error: undefined, fetchedAt: Date.now() }
      } else {
        this.current = { ...this.current, status: 'error', error: response.error.message }
      }
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return
      this.current = {
        ...this.current,
        status: 'error',
        error: readableErrorText(error),
      }
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

/** Host facts drive the usage card, including keys invisible to browser credentials. */
export function usageCardState(usage: UsagePageState) {
  const accounts = usage.report?.accounts ?? []
  return {
    loading: usage.status === 'loading',
    shouldRefresh: usage.status === 'idle',
    noKey: accounts.length > 0 && !accounts.some(account => account.configured),
  }
}
