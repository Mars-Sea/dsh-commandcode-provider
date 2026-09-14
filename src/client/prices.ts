/**
 * Browser controller for the model price table the composer's session-cost
 * figure depends on.
 *
 * The rates are vendored Host-side (`src/model-prices.ts`) and cross the
 * `commandcode/prices` Remote, so the browser never carries its own copy that
 * could drift from the snapshot, and a price update reaches an open page
 * without rebuilding the client bundle.
 *
 * Successful reads are cached until the Host namespace rebinds. Transient
 * failures retry three times with bounded backoff; manual refresh can retry
 * after that. Rebinding drops stale in-flight results and resets the budget.
 * Missing endpoints are permanent until the namespace changes.
 *
 * Deliberately JSX-free, mirroring `./usage.ts`.
 *
 * @module dsh-commandcode-provider/client/prices
 */

import type { CommandCodePriceTable } from '../usage-wire.ts'

/** The narrow slice of the mounted Remote this controller calls. */
export interface PricesRemote {
  /**
   * Optional because the Host and the browser bundle can be a cross-version
   * pair: a Host half older than this feature serves no `commandcode/prices`
   * endpoint, and the controller must read that as "no price table" instead of
   * calling an undefined method.
   */
  prices?(): Promise<
    | { ok: true; value: CommandCodePriceTable }
    | { ok: false; error: { message: string; permanent?: boolean } }
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
export interface PriceRetryTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const RETRY_TIMER: PriceRetryTimer = {
  set(callback, ms) { const handle = setTimeout(callback, ms); handle.unref?.(); return handle },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export class CommandCodePricesController {
  private readonly remote: PricesRemote
  private readonly listeners = new Set<() => void>()
  private current: SessionCostPricesState = IDLE
  private generation = 0
  private inFlight = false
  private disposed = false

  private retryHandle: unknown
  private attempts = 0
  private permanent = false
  private readonly timer: PriceRetryTimer

  constructor(remote: PricesRemote, timer: PriceRetryTimer = RETRY_TIMER) {
    this.timer = timer
    this.remote = remote
  }

  /** Release every subscription. Idempotent; in-flight results are dropped. */
  dispose(): void {
    this.disposed = true
    this.clearRetry()
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
    if (this.disposed || this.permanent || this.inFlight || this.current.status === 'ready') return
    this.clearRetry()
    const call = this.remote.prices
    // An older Host half serves no price endpoint. That is a permanent
    // condition for this page, so it lands in the error state (the readout
    // stays hidden) rather than retrying on every mount.
    if (typeof call !== 'function') {
      this.permanent = true
      this.publish({ status: 'error', table: undefined, error: 'the Host serves no commandcode/prices endpoint' })
      return
    }
    const generation = this.generation
    this.inFlight = true
    this.attempts += 1
    this.publish({ status: 'loading', table: this.current.table, error: undefined })
    let request: ReturnType<NonNullable<PricesRemote['prices']>>
    try { request = call.call(this.remote) } catch (error) { request = Promise.reject(error) }
    void request.then((result) => {
      if (this.disposed || generation !== this.generation) return
      this.inFlight = false
      if (result.ok) {
        this.publish({ status: 'ready', table: result.value, error: undefined })
        return
      }
      this.permanent = result.error.permanent === true
      this.publish({ status: 'error', table: undefined, error: result.error.message })
      this.scheduleRetry()
    }, (error: unknown) => {
      if (this.disposed || generation !== this.generation) return
      this.inFlight = false
      this.publish({
        status: 'error',
        table: undefined,
        error: error instanceof Error ? error.message : String(error),
      })
      this.scheduleRetry()
    })
  }

  /** Rebinding a Host invalidates cached prices and restarts the bounded retry budget. */
  reload(): void {
    if (this.disposed) return
    this.generation += 1
    this.inFlight = false
    this.clearRetry()
    this.permanent = false
    this.attempts = 0
    this.current = IDLE
    this.ensure()
  }

  private clearRetry(): void {
    if (this.retryHandle !== undefined) this.timer.clear(this.retryHandle)
    this.retryHandle = undefined
  }

  private scheduleRetry(): void {
    if (this.disposed || this.permanent || this.attempts >= 4) return
    this.retryHandle = this.timer.set(() => { this.retryHandle = undefined; this.ensure() }, 1000 * 2 ** (this.attempts - 1))
  }

  private publish(next: SessionCostPricesState): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }
}
