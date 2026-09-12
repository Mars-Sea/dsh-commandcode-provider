/**
 * Browser controller for the model price table the composer's session-cost
 * figure depends on.
 *
 * The rates are vendored Host-side (`src/model-prices.ts`) and cross the
 * `commandcode/prices` Remote, so the browser never carries its own copy that
 * could drift from the snapshot, and a price update reaches an open page
 * without rebuilding the client bundle.
 *
 * The table is static for the life of a page, so this controller is a one-shot
 * cache rather than a poll: `ensure()` fetches at most once and is a no-op once
 * it has succeeded, and a failure stays retryable because the surface that needs
 * it can mount before the Remote namespace is live (the composer is often
 * already on screen when the plugin's client half applies). Nothing here
 * refreshes on a timer — unlike the account-usage card, whose endpoint really
 * does move.
 *
 * Deliberately JSX-free, mirroring `./usage.ts`.
 *
 * @module dsh-commandcode-provider/client/prices
 */

import type { CommandCodePriceTable } from '../usage-wire.ts'

/** The narrow slice of the mounted Remote this controller calls. */
export interface PricesRemote {
  prices(): Promise<
    | { ok: true; value: CommandCodePriceTable }
    | { ok: false; error: { message: string } }
  >
}

/** The price table's fetch lifecycle. */
export type PricesStatus =
  /** Never requested. */
  | 'idle'
  /** A fetch is in flight. */
  | 'loading'
  /** The table is loaded and cached for the page's lifetime. */
  | 'ready'
  /** The last fetch failed; `ensure()` may try again. */
  | 'error'

/** The readout's price-table state face. */
export interface SessionCostPricesState {
  status: PricesStatus
  /** The cached table (only ever set once). */
  table: CommandCodePriceTable | undefined
  /** The last failure's message. */
  error: string | undefined
}

const IDLE: SessionCostPricesState = { status: 'idle', table: undefined, error: undefined }

/**
 * One-shot cache over the `commandcode/prices` Remote. Public API mirrors
 * {@link CommandCodeUsageController}: `state()`, `subscribe`, and `ensure()`.
 */
export class CommandCodePricesController {
  private readonly remote: PricesRemote
  private readonly listeners = new Set<() => void>()
  private current: SessionCostPricesState = IDLE
  private inFlight = false
  private disposed = false

  constructor(remote: PricesRemote) {
    this.remote = remote
  }

  /** Release every subscription. Idempotent; in-flight results are dropped. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  /** Subscribe to state projections. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The current state face. */
  state(): SessionCostPricesState {
    return this.current
  }

  /**
   * Fetch the table unless it is already loaded or in flight. Safe to call from
   * every mount point: the Remote namespace landing and the composer mounting
   * are both triggers, in either order, and only one request is ever issued.
   */
  ensure(): void {
    if (this.disposed || this.inFlight || this.current.status === 'ready') return
    this.inFlight = true
    this.publish({ status: 'loading', table: this.current.table, error: undefined })
    void this.remote.prices().then((result) => {
      if (this.disposed) return
      this.inFlight = false
      if (result.ok) {
        this.publish({ status: 'ready', table: result.value, error: undefined })
        return
      }
      this.publish({ status: 'error', table: undefined, error: result.error.message })
    }, (error: unknown) => {
      if (this.disposed) return
      this.inFlight = false
      this.publish({
        status: 'error',
        table: undefined,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private publish(next: SessionCostPricesState): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }
}
