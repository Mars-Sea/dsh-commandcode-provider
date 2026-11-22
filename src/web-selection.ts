/**
 * The provider-selection seam over `ctx.web` — which registered backend the
 * web seam actually runs, for one capability at a time.
 *
 * dsh 0.2.1-rc.2 turned both choices into `Volatile` fields of the `web` profile
 * entry (`searchProvider` / `fetchProvider`), so they are changed through the
 * host settings service rather than by assigning a runtime field. The supported
 * engine range (`engines.dsh`) starts at rc.2, so that reference is the only
 * shape this module serves.
 *
 * Both capabilities share ONE implementation: the seam is field-generic
 * ({@link WebSelectionField}), because search and fetch differ only in the
 * field name they read and write. Everything else — the "never displace a pin
 * we did not write" rule, the preexisting/degraded restore split, the
 * coalescing write queue, the in-memory fallback — is identical, and keeping
 * one copy is what stops the two toggles from drifting apart.
 *
 * @module dsh-commandcode-provider/web-selection
 */

import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { isVolatileRef, volatileWrite } from './config-volatile.ts'

/**
 * The `web` profile-entry field one selection owns. Each value is also the
 * `WebRuntimeConfig` member of the same name.
 */
export type WebSelectionField = 'searchProvider' | 'fetchProvider'

/**
 * Profile entry id whose volatile provider fields select the backends.
 *
 * The hosting profile declares it in `dsh-base`'s cordis patch as
 * `- id: web` / `name: '@deepseek-ai/dsh-web'`, and the shipped web-search
 * settings page addresses the very same namespace — that page and this plugin
 * are therefore two writers of ONE field per capability (see
 * {@link createCommandCodeSelection} for how they avoid fighting).
 */
export const WEB_SELECTION_NAMESPACE = 'web'

/**
 * Structural view of the host settings service.
 *
 * Spelled structurally rather than imported: only these three members are used,
 * and a narrower contract keeps the tests' double honest. Every member is
 * called inside a `try`, because a host mounted without `configEditor` /
 * `profileContext` throws from `describe()` rather than answering empty.
 */
export interface WebSelectionSettings {
  /** Every configurable entry's form view; the `web` row is absent when it has no volatile field. */
  describe(): unknown
  /** Merge fields into that entry's live config (the official volatile write). */
  update(ns: string, patch: object): Promise<void>
  /** Reset the entry's live fields, then set the supplied ones. */
  replace(ns: string, section: object): Promise<void>
}

/** Failure and visibility sink; implementations must never throw. */
export interface WebSelectionLogger {
  warn(message: string): void
  info(message: string): void
}

/**
 * Tracked selection state for one capability.
 *
 * `owner` is true while this plugin is the one asserting the selection: it
 * wrote the value, or found it already equal to ours AND attributed it to a
 * user-layer pin. Disabling only ever gives back what `owner` covers.
 *
 * `preexisting` marks the one case where the value is NOT ours to give back:
 * the field already read our id while the USER LAYER held nothing, so the value
 * came from the deployment's composed config or the environment variable of the
 * same name. Restoring there would write over a pin this plugin never took.
 *
 * `foreign` is a non-our pin found in the user layer — the shipped web-search
 * settings page writes `deepseek-search-api` / `deepseek-fetch-api`, and any
 * sibling plugin may pin its own id. A foreign pin is never displaced;
 * `foreign` keeps the value so the state (and the log line) can name who owns
 * the backend.
 *
 * `displaced` is the config value at takeover time. It is what the DEGRADED
 * (memory-only) restore writes back; the persisted path restores the composed
 * base instead, because a copy of it in the user layer would outlive a later
 * deployment change.
 */
export interface CommandCodeSelection {
  owner: boolean
  preexisting: boolean
  foreign: string | undefined
  displaced: string | undefined
}

/** Fresh selection state: the plugin starts out not owning the selection. */
export function commandCodeSelection(): CommandCodeSelection {
  return { owner: false, preexisting: false, foreign: undefined, displaced: undefined }
}

/** What one observation of the live selection reports. */
interface SelectionView {
  /** Config-level value of the field; `undefined` = the field is unset. */
  configured: string | undefined
  /** The user layer's explicit value, when one exists. */
  pinned: string | undefined
  /** The composed (inherited) value the user layer falls back to. */
  base: string | undefined
  /** Raw user-layer section, so a restore can preserve unrelated fields. */
  user: Record<string, unknown>
  /** Whether the official, disk-backed write path is available. */
  persistent: boolean
}

/** One queued write; a later intent replaces an earlier queued one. */
interface SelectionIntent {
  kind: 'take' | 'restore'
  displaced: string | undefined
}

/** Dependencies {@link createCommandCodeSelection} resolves per call. */
export interface WebSelectionDeps {
  /** The running `web` service whose selection field backs the degraded write. */
  web: WebRuntime
  /** Host settings service, resolved per use because it may activate after `web`. */
  settings: () => WebSelectionSettings | undefined
  /** Failure and visibility sink. */
  logger: WebSelectionLogger
}

/** One capability's concrete selection configuration. */
export interface WebSelectionOptions {
  /** The `web` config field this selection reads and writes. */
  field: WebSelectionField
  /** The provider id this selection asserts, and the id a foreign pin is measured against. */
  providerId: string
  /** What the user-facing log lines call the capability (`web search` / `web fetch`). */
  subject: string
}

/** The handle `src/index.ts` drives; every member is synchronous and non-throwing. */
export interface WebSelectionHandle {
  /** Live state, for callers that surface who currently owns the backend. */
  readonly state: CommandCodeSelection
  /** Align the selection with one end of its toggle. Never throws. */
  apply(enable: boolean): void
  /** Resolve once every queued write has settled. */
  settled(): Promise<void>
  /** Fiber release: drop queued writes and restore in memory ONLY — never on disk. */
  release(): void
}

/** Read one member of a plain object or array without trusting its shape. */
function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

/** A string member, or `undefined` for anything else (including `null`). */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The settings row describing the `web` entry, when the host serves one. */
function selectionRow(settings: WebSelectionSettings): unknown {
  let rows: unknown
  try {
    rows = settings.describe()
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  return rows.find(row => text(member(row, 'ns')) === WEB_SELECTION_NAMESPACE)
}

/**
 * The volatile reference backing one provider field.
 *
 * `config` is a TypeScript-private parameter property on `WebRuntime`, so at
 * runtime it is an ordinary own field — the only handle to a reference the host
 * exposes no public accessor for. Reading it structurally means a hardened
 * runtime degrades to "not writable" instead of throwing.
 */
function providerRef(web: WebRuntime, field: WebSelectionField): unknown {
  return member(member(web, 'config'), field)
}

/** Observe the live selection of one field; `undefined` when nothing can be observed. */
function readView(deps: WebSelectionDeps, field: WebSelectionField): SelectionView | undefined {
  const settings = deps.settings()
  if (settings !== undefined) {
    const row = selectionRow(settings)
    if (row !== undefined) {
      const user = member(row, 'user')
      const userValue = text(member(user, field))
      const baseValue = text(member(member(row, 'base'), field))
      return {
        configured: text(member(member(row, 'value'), field)),
        // A user-layer value that merely REPEATS the composed default is not a
        // pin. The host materializes the whole section on every write — one
        // toggle taking its field over also lands the OTHER capability's
        // composed value in the user layer — so a raw presence test would read
        // that copy as "someone chose this", and the second toggle could then
        // never take its own field over. A deliberate pin still differs from the
        // composed default, because pinning a value equal to the default changes
        // nothing and so is never what a user means.
        pinned: userValue !== undefined && userValue !== baseValue ? userValue : undefined,
        base: baseValue,
        user: typeof user === 'object' && user !== null && !Array.isArray(user)
          ? { ...user as Record<string, unknown> }
          : {},
        persistent: true,
      }
    }
  }
  // Settings is absent, or serves no row for `web`: only the running runtime is
  // observable, so a foreign pin cannot be seen and `base` is unknown.
  const ref = providerRef(deps.web, field)
  if (isVolatileRef(ref)) {
    let current: unknown
    try {
      current = ref.get()
    } catch {
      return undefined
    }
    if (current !== undefined && typeof current !== 'string') return undefined
    return { configured: current, pinned: undefined, base: undefined, user: {}, persistent: false }
  }
  return undefined
}

/**
 * The selection seam over one `ctx.web` provider field.
 *
 * ## Why settings rather than the runtime instance
 *
 * 0.2.1-rc.2's `WebRuntime` reads `this.config.<field>.get()` on EVERY search and
 * fetch, and the loader commits a settings write into that same reference in
 * place (`Entry._commitVolatile`) without remounting the entry. Writing the
 * reference directly therefore works, but leaves the value out of the profile:
 * the next commit for that entry — including one caused by an unrelated field
 * such as the OTHER capability's provider — re-resolves the raw config and
 * overwrites it. `ctx.settings.update()` / `replace()` is the documented path
 * and the one the shipped web-search settings page uses, so this plugin takes
 * it first and falls back to the reference only when settings is unavailable or
 * refuses (see `volatileWrite`).
 *
 * ## Two writers, one field
 *
 * The shipped web-search settings page writes these fields too. This seam never
 * displaces a pin it did not write: a non-our-own value in the USER LAYER stops
 * the takeover, the value is recorded on {@link CommandCodeSelection.foreign}
 * and named in one `info` line, and the provider stays registered but
 * unselected. A value the user layer does not carry is the deployment's own
 * default, and taking it over is the toggle's whole purpose. A user-layer value
 * equal to our own id is treated as ours: nothing else writes that id, so it can
 * only be a previous run of this plugin or a deliberate manual pin, and turning
 * the toggle off restores the composed default in both cases.
 *
 * @param deps - the running `web` service, a settings resolver, and a log sink.
 * @param options - which field and id this selection owns.
 * @returns a synchronous handle; failures are logged, never thrown.
 */
export function createCommandCodeSelection(
  deps: WebSelectionDeps,
  options: WebSelectionOptions,
): WebSelectionHandle {
  const { field, providerId, subject } = options
  const state = commandCodeSelection()
  let pending: { key: string; intent: SelectionIntent } | undefined
  let activeKey: string | undefined
  let running = false
  let closed = false
  let waiters: Array<() => void> = []

  const warn = (message: string): void => {
    try {
      deps.logger.warn(message)
    } catch { /* a broken sink must not break selection */ }
  }
  const info = (message: string): void => {
    try {
      deps.logger.info(message)
    } catch { /* a broken sink must not break selection */ }
  }

  /**
   * Commit the selection in memory; the last resort before giving up.
   *
   * The volatile reference is what the operation reads on every supported
   * engine (`engines.dsh` starts at 0.2.1-rc.2), so it is the only in-memory
   * seam.
   */
  const memoryWrite = (value: string | undefined): boolean => {
    if (volatileWrite(providerRef(deps.web, field), value)) return true
    warn(`llm-commandcode: ${subject} selection could not be applied (settings refused the write and the running web runtime is not writable); the provider stays registered but unselected`)
    return false
  }

  /** Run one intent against a FRESH observation; never throws. */
  const perform = async (intent: SelectionIntent): Promise<void> => {
    let view: SelectionView | undefined
    try {
      view = readView(deps, field)
    } catch {
      view = undefined
    }
    if (view === undefined) return
    const settings = view.persistent ? deps.settings() : undefined
    if (intent.kind === 'take') {
      // Re-check the precondition at the last moment: the settings page may have
      // pinned a backend between the decision and this write.
      if (view.pinned !== undefined && view.pinned !== providerId) return
      if (settings !== undefined) {
        try {
          await settings.update(WEB_SELECTION_NAMESPACE, { [field]: providerId })
          return
        } catch (error) {
          warn(`llm-commandcode: writing web.${field} through settings failed (${error instanceof Error ? error.message : String(error)}); falling back to the running config`)
        }
      }
      memoryWrite(providerId)
      return
    }
    // Restore. A foreign pin written while our take was in flight owns the field
    // now, and putting our old value back would silently revert the user.
    if (view.pinned !== undefined && view.pinned !== providerId) return
    if (settings !== undefined) {
      // `replace` resets the whole section, so the user's other fields must ride
      // along; the composed base supplies ours, and omitting it drops the key
      // entirely when the deployment composes no default. The OTHER capability's
      // user-layer value rides along untouched for the same reason.
      const section = { ...view.user }
      delete section[field]
      if (view.base !== undefined) section[field] = view.base
      try {
        await settings.replace(WEB_SELECTION_NAMESPACE, section)
        return
      } catch (error) {
        warn(`llm-commandcode: restoring web.${field} through settings failed (${error instanceof Error ? error.message : String(error)}); falling back to the running config`)
      }
    }
    memoryWrite(intent.displaced)
  }

  const flush = (): void => {
    const done = waiters
    waiters = []
    for (const resolve of done) resolve()
  }

  const drain = async (): Promise<void> => {
    running = true
    try {
      while (pending !== undefined && !closed) {
        const item = pending
        pending = undefined
        activeKey = item.key
        await perform(item.intent)
      }
    } finally {
      running = false
      activeKey = undefined
      flush()
    }
  }

  /**
   * Queue one intent, skipping an identical one already queued or in flight. A
   * later DIFFERENT intent replaces the queued one: the toggle is a state, not a
   * log, so only the newest position has to land.
   */
  const submit = (key: string, intent: SelectionIntent): void => {
    if (closed) return
    if (key === activeKey && pending === undefined) return
    if (pending?.key === key) return
    pending = { key, intent }
    if (!running) void drain()
  }

  const apply = (enable: boolean): void => {
    try {
      const view = readView(deps, field)
      if (view === undefined) return
      if (!enable) {
        if (!state.owner) return
        state.owner = false
        if (state.preexisting) {
          // The value was never ours: it came from the composed config or the
          // environment, and writing our memory of it back would clear a pin we
          // did not take.
          state.preexisting = false
          return
        }
        submit('restore', { kind: 'restore', displaced: state.displaced })
        return
      }
      if (view.pinned !== undefined && view.pinned !== providerId) {
        if (state.foreign !== view.pinned) {
          state.foreign = view.pinned
          info(`llm-commandcode: ${subject} backend "${view.pinned}" was chosen in the web-search settings page; leaving that explicit choice in place, so the commandcode provider stays registered but unselected`)
        }
        state.owner = false
        state.preexisting = false
        return
      }
      state.foreign = undefined
      if (view.configured === providerId) {
        // Already at the target. With a readable user layer, ownership is decided
        // by whether that layer carries our id. Without one — a host that serves
        // no settings for `web` — that test cannot be made at all,
        // and a re-apply finding our own id is OURS: a config reload re-runs this
        // effect while the toggle stays on, so dropping ownership here would make
        // the later release leave the displaced backend behind forever.
        state.owner = view.pinned === providerId
          || (!view.persistent && state.owner)
        state.preexisting = !state.owner
        if (state.owner && state.displaced === undefined) state.displaced = view.base
        return
      }
      state.displaced = view.configured
      state.preexisting = false
      state.owner = true
      submit('take', { kind: 'take', displaced: view.configured })
    } catch (error) {
      warn(`llm-commandcode: aligning the ${subject} selection failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return {
    state,
    apply,
    settled: () => (running || pending !== undefined
      ? new Promise<void>(resolve => { waiters.push(resolve) })
      : Promise.resolve()),
    release: () => {
      // Fiber release runs on unload and on shutdown. A disk write there would
      // need an ACTIVE entry fiber and the HMR exclusive lock, so the profile is
      // left alone: only the running reference is handed back, best effort.
      closed = true
      pending = undefined
      if (state.owner && !state.preexisting) memoryWrite(state.displaced)
      state.owner = false
      state.preexisting = false
      if (!running) flush()
    },
  }
}
