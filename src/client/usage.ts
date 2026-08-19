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
 * Deliberately JSX-free, mirroring `./settings.ts`.
 *
 * @module dsh-commandcode-provider/client/usage
 */

import type { CommandCodeAccountsReport } from '../usage-wire.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Merge the plugin's Remote endpoint into the harness's typed client Remote
 * surface (the same declaration pattern the harness's generated
 * typert.remote-client files use), so `ctx.remote.commandcode.report()` is
 * typed once the contribution is mounted.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'commandcode/report': () => Promise<RemoteResult<CommandCodeAccountsReport>>
  }
  interface TypertRemoteNamespaceMap {
    commandcode: {
      report: () => Promise<RemoteResult<CommandCodeAccountsReport>>
    }
  }
}

/** The narrow slice of the mounted Remote this controller calls. */
export interface UsageRemote {
  report(): Promise<
    | { ok: true; value: CommandCodeAccountsReport }
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
        error: error instanceof Error ? error.message : String(error),
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

// ---------------------------------------------------------------------------
// Display formatting (shared by the component, covered by node tests)
// ---------------------------------------------------------------------------

/** Format a dollar amount compactly (2 decimals). */
export function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}

/** Format a dollar amount precisely (4 decimals) for small totals. */
export function formatMoneyExact(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Format a large token count compactly (1.9M style). */
export function formatTokensCompact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

/** One window's fill ratio in [0, 1]; 0 when uncapped. */
export function windowRatio(used: number, cap: number): number {
  if (cap <= 0) return 0
  return Math.max(0, Math.min(1, used / cap))
}

/** Format a millis timestamp as a local short date-time; empty when unset. */
export function formatResetAt(ms: number): string {
  if (ms <= 0) return ''
  return new Date(ms).toLocaleString()
}
