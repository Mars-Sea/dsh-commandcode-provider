/**
 * Browser settings scope over the `remote.settings` Typert namespace.
 *
 * Until dsh 0.1.6 the web client bound `ctx.settingsScope` — a wrapper
 * `ui-settings` provided, itself derived from a shared mirror of
 * `remote.settings.describe()`. The 0.1.7 settings rewrite REMOVED that
 * wrapper service (settings became schema-derived profile Config forms), but
 * the wire underneath — `describe()`, `mutate(namespace, ops, revision)`, the
 * forwarded `settings/document-updated` invalidation, and the view shape
 * `{ writable, namespaces: [{ ns, value, base, user, revision, schema }] }` —
 * is byte-identical from 0.1.2-rc.1 through 0.1.7-alpha.1 (verified against
 * both engines' `ui-settings` bundles, which drove the SAME mirror/controller
 * pair from the first release this plugin supports to the newest).
 *
 * So this module speaks that wire directly and implements the
 * `SettingsScope<T>` face the settings-page controller already consumes —
 * one path for every supported engine, no dependency on a wrapper that only
 * half of them ship:
 *
 *   - A mirror serializes `describe()` reads behind one snapshot store (a
 *     read during a read marks exactly one rerun; a FAILED read keeps the
 *     held view, so a transient Host error never blanks the page).
 *   - The scope derives this namespace's row from the mirror — `ready` with
 *     the row's value when present, `unavailable` when the namespace is not
 *     in the directory — and writes through a single-flight `mutate` queue
 *     fenced by the row's revision, folding each accepted answer back into
 *     the mirror and re-reading after a rejected one.
 *   - Every page asks the Host for the current directory and writes through
 *     the Host's `settings` Remote. The Host/gateway owns the authenticated
 *     remote-write decision and reports it as `view.writable`; this client does
 *     not infer write permission from localhost, URL shape, or browser origin.
 *
 * The namespace object is NOT read off the context: `remote.settings` is a
 * Cordis service nested under `remote`, and Cordis throws
 * `cannot get property "remote.settings" without inject` for an undeclared
 * read. It arrives through the `resolveRemote` seam instead — an object
 * captured inside `ctx.inject(['remote.settings'], …)` by the client entry
 * (see {@link SettingsRemoteResolver} for the failure this prevents).
 *
 * React-free on purpose, so `tests/settings-scope.test.ts` can drive the
 * whole lifecycle over a fake remote.
 *
 * @module dsh-commandcode-provider/client/settings-scope
 */

import type { SettingsScope, SettingsScopeSnapshot } from './settings.ts'
import { createSnapshotStore, type SnapshotStore } from './snapshot-store.ts'

/** Result envelope of one current Typert Remote call. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } | undefined }

/** One path-addressed form edit — the `SettingsPathOp` wire shape. */
export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/** One entry's row inside a `settings.describe()` view — `SettingsNamespaceView`. */
interface SettingsNamespaceRow {
  ns?: unknown
  value?: unknown
  base?: unknown
  user?: unknown
  revision?: unknown
}

/** The `settings.describe()` view: the directory plus the Host's write posture. */
interface SettingsView {
  namespaces?: SettingsNamespaceRow[] | undefined
  writable?: boolean | undefined
}

/** The `remote.settings` namespace this scope calls. Structural: never imported. */
export interface SettingsRemoteNamespace {
  describe(): Promise<Envelope<SettingsView>>
  /** A write answers with the fresh ROW for its namespace, not the directory. */
  mutate(
    namespace: string,
    ops: readonly SettingsPathOp[],
    revision?: number,
  ): Promise<Envelope<SettingsNamespaceRow>>
}

/**
 * Reads the `remote.settings` namespace object, or `undefined` while it is not
 * mounted.
 *
 * This is a SEAM rather than a property on {@link SettingsScopeContext} because
 * `remote.settings` is a Cordis service nested under `remote`, and Cordis
 * throws for an undeclared nested read:
 *
 *     Error: cannot get property "remote.settings" without inject
 *
 * The service object therefore has to be captured inside a context that
 * declares it (`ctx.inject(['remote.settings'], (settingsCtx) => …)`) and handed
 * in here. Reading it off our own `ctx.remote` instead throws on EVERY
 * supported engine — including ≤0.1.6, whose `remote.settings` namespace is the
 * same shape — and the throw lands inside this module's own `try`/`catch`, so
 * the failure is silent: no describe is ever sent, the scope keeps its initial
 * `writable: false` snapshot, and the settings page renders read-only with every
 * control disabled. That was the 0.1.7 settings-page report.
 */
export type SettingsRemoteResolver = () => SettingsRemoteNamespace | undefined

/**
 * The client `Context` slice this module consumes, typed structurally so the
 * browser bundle never imports a version-specific module value and node tests
 * can hand in a plain object. Only `remote` itself (a declared service) is read
 * here — never `remote.<namespace>`, which requires its own inject.
 */
export interface SettingsScopeContext {
  remote: {
    $on?: ((event: string, listener: () => void) => (() => void) | undefined) | undefined
  }
  /** Connection lifecycle; older clients and tests may omit it. */
  on?: ((event: string, listener: () => void) => unknown) | undefined
}

/** Mirror snapshot: one in-flight-or-idle describe read and its held view. */
interface MirrorState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  view: SettingsView | null
  error: string | null
}

/**
 * Backoff before re-reading a directory whose FIRST read failed, in millis.
 *
 * A first read can lose to a Host that is still coming up (the gateway's WS
 * handshake, a settings service mid-start): the failure is transient, but the
 * scope has nothing held, so it keeps its initial `{ status: 'loading',
 * writable: false }` snapshot — and every control on the settings page renders
 * disabled behind a "read-only" banner. Nothing else would ever re-read it:
 * the forwarded `settings/document-updated` and `connection/reset` signals need
 * a live Host to fire, and the namespace only re-mounts on a page reload. So a
 * failure with NOTHING held retries on this bounded ladder; a failure with a
 * held view keeps it (no retry — the page is already showing the last good
 * document, and `tests/settings-scope.test.ts` pins that).
 */
export const SETTINGS_DESCRIBE_RETRY_MS: readonly number[] = [1000, 2000, 4000]

/** Timer seam for the bounded describe retry; tests drive it without waiting. */
export interface SettingsRetryTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The production timer: a browser/node timeout, no polling. */
const REAL_SETTINGS_TIMER: SettingsRetryTimer = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Shallow equality over the snapshot fields, so an unchanged derive never churns subscribers. */
function sameSnapshot(a: SettingsScopeSnapshot<never>, b: SettingsScopeSnapshot<never>): boolean {
  return a.status === b.status
    && Object.is(a.value, b.value)
    && Object.is(a.base, b.base)
    && Object.is(a.user, b.user)
    && Object.is(a.revision, b.revision)
    && a.writable === b.writable
    && a.mode === b.mode
}

/** Accept a decoded row value only when it is the object a settings section is. */
function decodeRow(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * One shared mirror of the Host `settings.describe()` view.
 *
 * The run loop is the harness's own: serialize behind `inFlight`, fold a
 * concurrent invalidation into exactly one rerun, and hold the previous view
 * across a failed read (status stays `ready` with an `error`, or returns to
 * `idle` when nothing was ever held).
 */
class SettingsDescribeMirror {
  private readonly store: SnapshotStore<MirrorState>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  /** Pending retry handle and how many of {@link SETTINGS_DESCRIBE_RETRY_MS} are spent. */
  private retryHandle: unknown
  private retries = 0
  private disposed = false

  /**
   * @param resolveRemote - Reads the inject-captured `remote.settings` namespace.
   * @param timer - Retry timer seam (see {@link SETTINGS_DESCRIBE_RETRY_MS}).
   */
  constructor(
    private readonly resolveRemote: SettingsRemoteResolver,
    private readonly timer: SettingsRetryTimer = REAL_SETTINGS_TIMER,
  ) {
    this.store = createSnapshotStore<MirrorState>({
      status: 'idle',
      view: null,
      error: null,
    })
  }

  getSnapshot(): MirrorState {
    return this.store.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** The cheap idempotent entry: kick a first read. */
  ensure(): void {
    void this.load()
  }

  /**
   * Refresh from the Host. A call during an in-flight read marks one rerun
   * after it settles instead of racing a second wire read.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    // A live read supersedes a scheduled retry: the retry exists only to
    // revive a mirror that nothing else would ever re-read.
    this.clearRetry()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * Fold one write answer's namespace ROW into the held view without a wire
   * read, and invalidate any read still in flight: a read begun before the
   * write committed must not publish the pre-write document over it. With no
   * held document the answer is not published as a partial document — the
   * next read (or the failed-write recovery) picks it up.
   * @param row - The namespace view a settings write answered with.
   */
  acceptView(row: SettingsNamespaceRow): void {
    const before = this.store.getSnapshot()
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    if (before.view === null) return
    const held = before.view
    const namespaces = held.namespaces?.some((candidate) => candidate.ns === row.ns)
      ? held.namespaces.map((candidate) => (candidate.ns === row.ns ? row : candidate))
      : [...(held.namespaces ?? []), row]
    this.store.set({ ...before, view: { ...held, namespaces } })
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        this.rerun = false
        const generation = ++this.generation
        let outcome: { view: SettingsView } | { failure: string }
        try {
          const namespace = this.resolveRemote()
          if (namespace === undefined) throw new Error('the settings remote namespace is not mounted')
          const response = await namespace.describe()
          if (response.ok) {
            const value: unknown = response.value
            // The mirror holds a VIEW or nothing: an empty/malformed answer
            // must not be published as `ready` with an undefined view, or the
            // derive below would read through it. (Upstream guards the same way
            // by testing the held view for `undefined`.)
            outcome = typeof value === 'object' && value !== null
              ? { view: value as SettingsView }
              : { failure: 'settings describe answered no view' }
          } else {
            outcome = { failure: response.error?.message ?? 'settings describe failed' }
          }
        } catch (error: unknown) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        if (generation !== this.generation) continue
        if ('view' in outcome) {
          this.retries = 0
          this.store.set({ status: 'ready', view: outcome.view, error: null })
        } else {
          const held = this.store.getSnapshot()
          this.store.set({
            status: held.view === null ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          })
          // Nothing was EVER held: the scope is stuck on its initial
          // `loading`/`writable: false` snapshot, which the settings page
          // renders as a fully disabled form. Retry on the bounded ladder so a
          // Host that was still starting up heals without a page reload; a
          // held view needs none (the page already shows the last good
          // document).
          if (held.view === null) this.scheduleRetry()
        }
        if (!this.rerun) break
      }
    } finally {
      this.inFlight = undefined
    }
  }

  /**
   * Schedule the next retry of a failed FIRST read ({@link SETTINGS_DESCRIBE_RETRY_MS}).
   * Bounded: once the ladder is spent the scope keeps its degraded snapshot,
   * exactly as before, until an invalidation or a namespace re-mount arrives.
   */
  private scheduleRetry(): void {
    if (this.disposed || this.retries >= SETTINGS_DESCRIBE_RETRY_MS.length) return
    const delay = SETTINGS_DESCRIBE_RETRY_MS[this.retries]!
    this.retries += 1
    this.retryHandle = this.timer.set(() => {
      this.retryHandle = undefined
      void this.load()
    }, delay)
  }

  /** Cancel a pending retry (a live read is starting, or the scope is going away). */
  private clearRetry(): void {
    if (this.retryHandle !== undefined) this.timer.clear(this.retryHandle)
    this.retryHandle = undefined
  }

  /** Stop the mirror: no further reads, and no retry may fire after disposal. */
  dispose(): void {
    this.disposed = true
    this.clearRetry()
  }
}

/**
 * One namespace's derived scope over the shared mirror, plus its serialized
 * Host writes. This is the face `CommandCodeSettingsController` consumes
 * (`getSnapshot` / `subscribe` / `set` / `unset`), so the controller itself
 * needs no changes for either generation.
 */
class RemoteSettingsScope<T> implements SettingsScope<T> {
  private readonly resolveRemote: SettingsRemoteResolver
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private readonly mirror: SettingsDescribeMirror
  private readonly namespace: string
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private unsubscribe: (() => void) | undefined
  /** Revision answered by a superseded write still ahead of the mirror. */
  private pendingRevision: number | undefined

  constructor(
    resolveRemote: SettingsRemoteResolver,
    mirror: SettingsDescribeMirror,
    namespace: string,
  ) {
    this.resolveRemote = resolveRemote
    this.mirror = mirror
    this.namespace = namespace
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    })
    this.unsubscribe = mirror.subscribe(() => { this.derive() })
    this.derive()
  }

  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Queue one field write (the single-path `set` op form). */
  set(field: string, value: unknown): Promise<void> {
    return this.mutate([{ op: 'set', path: [field], value }])
  }

  /** Queue one field clear (the single-path `unset` op form). */
  unset(field: string): Promise<void> {
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  /**
   * Queue one atomic namespace mutation behind the single-flight fence.
   * A rejected write (e.g. `SETTINGS_CONFLICT`) re-reads the Host so the
   * snapshot reports what actually landed; an accepted one folds its answer
   * in directly — unless a newer write already superseded it, in which case
   * that answer's revision becomes the next write's fence.
   */
  private mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    const ownedOps = structuredClone(ops)
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision
      const response = await this.mutateRemote(ownedOps, revision)
      if (!response.ok) {
        await this.recover(generation)
        return
      }
      if (this.disposed) return
      const row = response.value
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(row)
      } else {
        this.pendingRevision = typeof row.revision === 'number' ? row.revision : undefined
      }
    })
  }

  private async mutateRemote(
    ops: readonly SettingsPathOp[],
    revision: number | undefined,
  ): Promise<Envelope<SettingsNamespaceRow>> {
    try {
      const namespace = this.resolveRemote()
      if (namespace === undefined) {
        return { ok: false, error: { message: 'the settings remote namespace is not mounted' } }
      }
      return await namespace.mutate(this.namespace, ops, revision)
    } catch (error: unknown) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    await this.mirror.load()
  }

  /** Derive this namespace's snapshot from the mirror's held view. */
  private derive(): void {
    if (this.disposed) return
    const mirrored = this.mirror.getSnapshot()
    // `undefined` as well as `null`: the held view is only ever the wire's
    // answer, and a malformed one never reaches the store (see `run`).
    if (mirrored.view === null || mirrored.view === undefined) return
    const writable = mirrored.view.writable === true
    const row = mirrored.view.namespaces?.find((candidate) => candidate.ns === this.namespace)
    if (row === undefined) {
      this.publish({ status: 'unavailable', writable })
      return
    }
    const decoded = decodeRow(row.value)
    if (decoded === undefined) return
    this.publish({
      status: 'ready',
      writable,
      value: decoded as T,
      base: row.base,
      user: row.user,
      revision: typeof row.revision === 'number' ? row.revision : undefined,
    })
  }

  /** Publish `next` over the current snapshot, skipping the write when nothing changed. */
  private publish(next: {
    status: SettingsScopeSnapshot<T>['status']
    writable: boolean
    value?: T
    base?: unknown
    user?: unknown
    revision?: number | undefined
  }): void {
    const current = this.store.getSnapshot()
    const candidate: SettingsScopeSnapshot<T> = {
      status: next.status,
      value: 'value' in next ? next.value : current.value,
      base: 'base' in next ? next.base : current.base,
      user: 'user' in next ? next.user : current.user,
      revision: 'revision' in next ? next.revision : current.revision,
      writable: next.writable,
      mode: current.mode,
    }
    if (sameSnapshot(candidate as SettingsScopeSnapshot<never>, current as SettingsScopeSnapshot<never>)) return
    this.store.set(candidate)
  }

  /** Queue operations one at a time; disposal makes the queue inert. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    this.tail = task.catch(() => {})
    return task
  }

  /** Stop queued operations, stop deriving, and wait for the current wire call to settle. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }
}

/** The scope plus the handles the plugin entry wires into its fiber lifecycle. */
export interface ManagedSettingsScope<T> extends SettingsScope<T> {
  /** Re-read the Host — used when the `remote.settings` namespace mounts after boot. */
  refresh(): void
  /** Stop deriving, drop the forwarded-event subscriptions, and settle in-flight work. */
  dispose(): Promise<void>
}

/**
 * Build the plugin's settings scope for one namespace.
 *
 * Subscribes the two signals that can move the Host view — the forwarded
 * `settings/document-updated` invalidation and (when the client exposes it)
 * `connection/reset` — kicks the first describe read, and derives the
 * namespace row on every mirror change.
 *
 * `resolveRemote` is the INJECT-CAPTURED namespace (see
 * {@link SettingsRemoteResolver}): `remote.settings` is a Cordis service nested
 * under `remote`, so a read through our own context throws and has to be
 * replaced by an object captured inside `ctx.inject(['remote.settings'], …)`.
 * The caller that owns that inject calls {@link ManagedSettingsScope.refresh}
 * once the namespace lands, which is what turns the first, namespace-less read
 * into a served one; a profile that never mounts the namespace leaves the page
 * in its degraded (`unavailable`, read-only) state instead of throwing.
 *
 * @param context - The client context slice (only the declared `remote` service is read).
 * @param namespace - Settings namespace (profile entry id) this scope binds.
 * @param resolveRemote - Reads the inject-captured `remote.settings` namespace.
 * @returns The scope plus the refresh/dispose handles the entry wires into its fiber.
 */
export function createSettingsScope<T>(
  context: SettingsScopeContext,
  namespace: string,
  resolveRemote: SettingsRemoteResolver,
  timer: SettingsRetryTimer = REAL_SETTINGS_TIMER,
): ManagedSettingsScope<T> {
  // The Host/gateway owns the remote-write decision. The client always reads
  // the settings directory and submits writes; `view.writable` is the Host's
  // rendered authorization fact, not a local hostname or Origin guess.
  const mirror = new SettingsDescribeMirror(resolveRemote, timer)
  const scope = new RemoteSettingsScope<T>(resolveRemote, mirror, namespace)
  const disposers: Array<() => void> = []
  if (typeof context.remote.$on === 'function') {
    const off = context.remote.$on('settings/document-updated', () => { mirror.ensure() })
    if (typeof off === 'function') disposers.push(off)
  }
  if (typeof context.on === 'function') {
    const off = context.on('connection/reset', () => { void mirror.load() })
    if (typeof off === 'function') disposers.push(off as () => void)
  }
  mirror.ensure()
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
    set: (field, value) => scope.set(field, value),
    unset: (field) => scope.unset(field),
    refresh: () => { void mirror.load() },
    dispose: async () => {
      for (const dispose of disposers.splice(0)) dispose()
      // Before the scope: a pending describe retry would otherwise re-read a
      // directory nobody is rendering any more.
      mirror.dispose()
      await scope.dispose()
    },
  }
}
