/**
 * Command Code web-search provider over `ctx.web`.
 *
 * The official CLI's built-in `web_search` tool POSTs
 * `{ query, numResults, allowedDomains?, blockedDomains? }` to
 * `{apiBase}/alpha/web-search` and reads `{ results: [{ title, url, snippet }] }`
 * back, authenticating with the SAME `Authorization: Bearer <key>` and
 * `x-command-code-version` headers the model adapter uses. This provider
 * therefore reuses the plugin's existing credential chain and `apiBase`, so
 * the model-facing `web_search` tool needs no separate configuration.
 *
 * The second half of this module is the SELECTION seam: which registered search
 * backend `ctx.web` actually runs. dsh 0.2.1-rc.2 turned the choice into a per-call
 * `Volatile` field of the `web` profile entry, so it is changed through the host
 * settings service rather than by assigning a runtime field. The supported
 * engine range (`engines.dsh`) starts at rc.2, so that reference is the only
 * shape this module serves — see {@link createCommandCodeSearchSelection}.
 *
 * ## Search retries
 *
 * `dsh-tool-web` fans several queries out concurrently and aborts the whole
 * batch on the FIRST failure (it rethrows that failure; issue #117), so one
 * transient connection failure used to discard every result. The endpoint is
 * read-only and idempotent, and the failure the issue observed arrived before
 * any HTTP status — a network-level `fetch failed`, not a plan/credential
 * verdict. This provider therefore repeats a fetch that never received a
 * response, up to SEARCH_MAX_ATTEMPTS attempts with jittered
 * exponential backoff, and leaves every received status (401/403/429/…) and
 * every response-body failure untouched: a received status is the server's
 * answer, and a body failure means the request was already accepted and may
 * have been executed, so replaying it risks duplicate billing. Cancellation
 * always wins — an aborted call (including the tool's cooperative deadline)
 * stops before the next attempt and still reports `WEB_ABORTED`.
 *
 * Every non-cancel `fetch` rejection counts as retryable: the engine does not
 * classify the `error.cause` for us, and a deterministic failure (an expired
 * certificate, an argument the runtime rejects) merely costs the bounded
 * backoff before the same error surfaces. That is cheaper than maintaining a
 * transient-code allowlist that silently drops an unlisted blip.
 *
 * @module dsh-commandcode-provider/web-search
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { attributionHeaders, type HarnessError } from '@deepseek-ai/dsh-llm'
import { COMMAND_CODE_CLI_VERSION } from './adapter.ts'
import { isVolatileRef, volatileWrite } from './config-volatile.ts'
import { readableErrorText } from './readable-error.ts'
import { IDENTITY_ENCODING_HEADER } from './response-encoding.ts'
import { httpOrigin, transportFailureReason } from './transport-failure.ts'

/** Stable id this provider registers under in `ctx.web`. */
export const COMMANDCODE_SEARCH_PROVIDER_ID = 'commandcode'

/**
 * The factory-declared search provider id dsh ships by default (from
 * `dsh-base`'s cordis patch `web.config.searchProvider`). A documented
 * reference only: disabling this plugin's `webSearch` toggle restores the
 * PREVIOUSLY selected backend, never this default (issue #26).
 */
export const DEFAULT_WEB_SEARCH_PROVIDER_ID = 'deepseek-official'

/**
 * Profile entry id whose volatile `searchProvider` selects the search backend.
 *
 * The hosting profile declares it in `dsh-base`'s cordis patch as
 * `- id: web` / `name: '@deepseek-ai/dsh-web'`, and the shipped web-search
 * settings page addresses the very same namespace — that page and this plugin
 * are therefore two writers of ONE field (see
 * {@link createCommandCodeSearchSelection} for how they avoid fighting).
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
 * Tracked web-search selection state.
 *
 * `owner` is true while this plugin is the one asserting the selection: it
 * wrote the value, or found it already equal to ours AND attributed it to a
 * user-layer pin. Disabling only ever gives back what `owner` covers.
 *
 * `preexisting` marks the one case where the value is NOT ours to give back:
 * the field already read `commandcode` while the USER LAYER held nothing, so
 * the value came from the deployment's composed config or
 * `$DSH_WEB_SEARCH_PROVIDER`. Restoring there would write over a pin this
 * plugin never took.
 *
 * `foreign` is a non-`commandcode` pin found in the user layer — the shipped
 * web-search settings page writes `deepseek-search-api`, and any sibling plugin
 * may pin its own id. A foreign pin is never displaced; `foreign` keeps the
 * value so the state (and the log line) can name who owns the backend.
 *
 * `displaced` is the config value at takeover time. It is what the DEGRADED
 * (memory-only) restore writes back; the persisted path restores the composed
 * base instead, because a copy of it in the user layer would outlive a later
 * deployment change.
 */
export interface CommandCodeSearchSelection {
  owner: boolean
  preexisting: boolean
  foreign: string | undefined
  displaced: string | undefined
}

/** Fresh selection state: the plugin starts out not owning the selection. */
export function commandCodeSearchSelection(): CommandCodeSearchSelection {
  return { owner: false, preexisting: false, foreign: undefined, displaced: undefined }
}

/** What one observation of the live selection reports. */
interface SelectionView {
  /** Config-level value of `web.searchProvider`; `undefined` = the field is unset. */
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

/** Dependencies {@link createCommandCodeSearchSelection} resolves per call. */
export interface WebSearchSelectionDeps {
  /** The running `web` service whose selection field backs the degraded write. */
  web: WebRuntime
  /** Host settings service, resolved per use because it may activate after `web`. */
  settings: () => WebSelectionSettings | undefined
  /** Failure and visibility sink. */
  logger: WebSelectionLogger
}

/** The handle `src/index.ts` drives; every member is synchronous and non-throwing. */
export interface WebSearchSelectionHandle {
  /** Live state, for callers that surface who currently owns the backend. */
  readonly state: CommandCodeSearchSelection
  /** Align the selection with one end of the `webSearch` toggle. Never throws. */
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
 * The volatile reference backing `web.searchProvider`.
 *
 * `config` is a TypeScript-private parameter property on `WebRuntime`, so at
 * runtime it is an ordinary own field — the only handle to a reference the host
 * exposes no public accessor for. Reading it structurally means a hardened
 * runtime degrades to "not writable" instead of throwing.
 */
function searchProviderRef(web: WebRuntime): unknown {
  return member(member(web, 'config'), 'searchProvider')
}

/** Observe the live selection; `undefined` when nothing can be observed. */
function readView(deps: WebSearchSelectionDeps): SelectionView | undefined {
  const settings = deps.settings()
  if (settings !== undefined) {
    const row = selectionRow(settings)
    if (row !== undefined) {
      const user = member(row, 'user')
      return {
        configured: text(member(member(row, 'value'), 'searchProvider')),
        pinned: text(member(user, 'searchProvider')),
        base: text(member(member(row, 'base'), 'searchProvider')),
        user: typeof user === 'object' && user !== null && !Array.isArray(user)
          ? { ...user as Record<string, unknown> }
          : {},
        persistent: true,
      }
    }
  }
  // Settings is absent, or serves no row for `web`: only the running runtime is
  // observable, so a foreign pin cannot be seen and `base` is unknown.
  const ref = searchProviderRef(deps.web)
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
 * The selection seam over `ctx.web`.
 *
 * ## Why settings rather than the runtime instance
 *
 * 0.2.1-rc.2's `WebRuntime` reads `this.config.searchProvider.get()` on EVERY
 * search and fetch, and the loader commits a settings write into that same
 * reference in place (`Entry._commitVolatile`) without remounting the entry.
 * Writing the reference directly therefore works, but leaves the value out of
 * the profile: the next commit for that entry — including one caused by an
 * unrelated field such as `fetchProvider` — re-resolves the raw config and
 * overwrites it. `ctx.settings.update()` / `replace()` is the documented path
 * and the one the shipped web-search settings page uses, so this plugin takes
 * it first and falls back to the reference only when settings is unavailable or
 * refuses (see `volatileWrite`).
 *
 * ## Two writers, one field
 *
 * The shipped web-search settings page writes `web.searchProvider` too
 * (`deepseek-search-api` / `deepseek-official`). This seam never displaces a
 * pin it did not write: a non-`commandcode` value in the USER LAYER stops the
 * takeover, the value is recorded on {@link CommandCodeSearchSelection.foreign}
 * and named in one `info` line, and the provider stays registered but
 * unselected. A value the user layer does not carry is the deployment's own
 * default, and taking it over is the toggle's whole purpose. A user-layer
 * `commandcode` is treated as ours: nothing else writes that id, so it can only
 * be a previous run of this plugin or a deliberate manual pin, and turning the
 * toggle off restores the composed default in both cases.
 *
 * @param deps - the running `web` service, a settings resolver, and a log sink.
 * @returns a synchronous handle; failures are logged, never thrown.
 */
export function createCommandCodeSearchSelection(deps: WebSearchSelectionDeps): WebSearchSelectionHandle {
  const state = commandCodeSearchSelection()
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
   * The volatile reference is what `search()` reads on every supported engine
   * (`engines.dsh` starts at 0.2.1-rc.2), so it is the only in-memory seam.
   */
  const memoryWrite = (value: string | undefined): boolean => {
    if (volatileWrite(searchProviderRef(deps.web), value)) return true
    warn('llm-commandcode: web search selection could not be applied (settings refused the write and the running web runtime is not writable); the provider stays registered but unselected')
    return false
  }

  /** Run one intent against a FRESH observation; never throws. */
  const perform = async (intent: SelectionIntent): Promise<void> => {
    let view: SelectionView | undefined
    try {
      view = readView(deps)
    } catch {
      view = undefined
    }
    if (view === undefined) return
    const settings = view.persistent ? deps.settings() : undefined
    if (intent.kind === 'take') {
      // Re-check the precondition at the last moment: the settings page may have
      // pinned a backend between the decision and this write.
      if (view.pinned !== undefined && view.pinned !== COMMANDCODE_SEARCH_PROVIDER_ID) return
      if (settings !== undefined) {
        try {
          await settings.update(WEB_SELECTION_NAMESPACE, { searchProvider: COMMANDCODE_SEARCH_PROVIDER_ID })
          return
        } catch (error) {
          warn(`llm-commandcode: writing web.searchProvider through settings failed (${error instanceof Error ? error.message : String(error)}); falling back to the running config`)
        }
      }
      memoryWrite(COMMANDCODE_SEARCH_PROVIDER_ID)
      return
    }
    // Restore. A foreign pin written while our take was in flight owns the field
    // now, and putting our old value back would silently revert the user.
    if (view.pinned !== undefined && view.pinned !== COMMANDCODE_SEARCH_PROVIDER_ID) return
    if (settings !== undefined) {
      // `replace` resets the whole section, so the user's other fields must ride
      // along; the composed base supplies ours, and omitting it drops the key
      // entirely when the deployment composes no default.
      const section = { ...view.user }
      delete section.searchProvider
      if (view.base !== undefined) section.searchProvider = view.base
      try {
        await settings.replace(WEB_SELECTION_NAMESPACE, section)
        return
      } catch (error) {
        warn(`llm-commandcode: restoring web.searchProvider through settings failed (${error instanceof Error ? error.message : String(error)}); falling back to the running config`)
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
      const view = readView(deps)
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
      if (view.pinned !== undefined && view.pinned !== COMMANDCODE_SEARCH_PROVIDER_ID) {
        if (state.foreign !== view.pinned) {
          state.foreign = view.pinned
          info(`llm-commandcode: web search backend "${view.pinned}" was chosen in the web-search settings page; leaving that explicit choice in place, so the commandcode provider stays registered but unselected`)
        }
        state.owner = false
        state.preexisting = false
        return
      }
      state.foreign = undefined
      if (view.configured === COMMANDCODE_SEARCH_PROVIDER_ID) {
        // Already at the target. With a readable user layer, ownership is decided
        // by whether that layer carries our id. Without one — a host that serves
        // no settings for `web` — that test cannot be made at all,
        // and a re-apply finding our own id is OURS: a config reload re-runs this
        // effect while the toggle stays on, so dropping ownership here would make
        // the later release leave the displaced backend behind forever.
        state.owner = view.pinned === COMMANDCODE_SEARCH_PROVIDER_ID
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
      warn(`llm-commandcode: aligning the web search selection failed (${error instanceof Error ? error.message : String(error)})`)
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

/** Command Code's lower/upper bound on `numResults` (from the CLI's `web_search` schema). */
const MIN_NUM_RESULTS = 1
const MAX_NUM_RESULTS = 10
/** CLI default when the caller sets no result cap. */
const DEFAULT_NUM_RESULTS = 5

/** The endpoint the search POST goes to; `{apiBase}` is prepended. */
const SEARCH_ROUTE = '/alpha/web-search'

/**
 * Attempts per search: the first try plus two retries.
 *
 * dsh fans a multi-query call out concurrently and aborts the siblings of the
 * first failure, so retrying HERE is what keeps one connection blip from
 * discarding a four-query research step (issue #117). Two retries cover the
 * common transient cases. The budget deliberately brushes the web tool's
 * default 30 s cooperative deadline, so a slow connect-timeout failure can hit
 * that deadline mid-retry and surface as `WEB_ABORTED` instead of the terminal
 * diagnosis; the full arithmetic and the rejected alternatives live in
 * docs/agent-reference/accounts-and-retry.md.
 */
export const SEARCH_MAX_ATTEMPTS = 3

/** Base wait before the second attempt; each later wait doubles. */
const SEARCH_RETRY_BASE_DELAY_MS = 500

/** ±fraction applied to each wait so concurrent queries do not retry in lockstep. */
const SEARCH_RETRY_JITTER_RATIO = 0.2

/**
 * Wait before the next attempt, doubling from 500 ms with ±20% jitter.
 *
 * The jitter matters here more than on the model path: a four-query fan-out
 * that shares one network hiccup would otherwise reconnect all four at the
 * same instant. Exported so the cadence is pinned without waiting on real
 * timers.
 *
 * @param attempt - the failed attempt number, starting at 1.
 * @returns the delay in milliseconds.
 */
export function searchRetryDelayMs(attempt: number): number {
  const base = SEARCH_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  const jitter = 1 + (Math.random() * 2 - 1) * SEARCH_RETRY_JITTER_RATIO
  return Math.round(base * jitter)
}

/**
 * Sleep before a retry, resolving early only by rejecting with the caller's
 * cancellation. A plain `setTimeout` would let an aborted tool call sit out a
 * wait it no longer needs; this keeps the abort responsive and preserves the
 * `WEB_ABORTED` taxonomy.
 *
 * Exported so the cancellation behavior is pinned without waiting out a real
 * 500 ms timer: tests can either await this helper directly or wrap it to learn
 * when the wait started.
 */
export function searchRetryWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(searchAborted(signal, signal.reason))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(searchAborted(signal, signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The failure a search ends with once every attempt has failed.
 *
 * `fetch failed` alone cannot distinguish a reset from a connect timeout from
 * a dead proxy (issue #117), so the cause code, target origin and elapsed time
 * ride along. The origin comes from `httpOrigin()`, which drops paths and
 * query strings, so a reverse proxy prefix or a credential never leaks here.
 */
function transportFailureMessage(
  error: unknown,
  apiBase: string,
  attempts: number,
  elapsedMs: number,
): string {
  const origin = httpOrigin(apiBase)
  const details = [
    transportFailureReason(error),
    origin === undefined ? undefined : `目标 ${origin}`,
    `耗时 ${elapsedMs}ms`,
    `已尝试 ${attempts} 次`,
  ].filter((detail): detail is string => detail !== undefined)
  return `Command Code web search request failed: ${readableErrorText(error)}（${details.join('；')}）`
}

/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
export interface CommandCodeSearchProviderDeps {
  /** 使用搜索已捕获的网关解析账号，探测不能在等待后转到另一个网关。 */
  resolveKey(apiBase?: string): Promise<string | undefined>
  /** The API base host (defaults to `https://api.commandcode.ai`). */
  apiBase(): string
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable retry wait for tests; defaults to the module's abortable retry wait. */
  retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Clamp a DSH `maxResults` bound into Command Code's 1–10 range, applying the
 * CLI default of 5 when the caller supplied none.
 */
function clampNumResults(maxResults: number | undefined): number {
  return maxResults === undefined
    ? DEFAULT_NUM_RESULTS
    : Math.max(MIN_NUM_RESULTS, Math.min(MAX_NUM_RESULTS, Math.round(maxResults)))
}

/** Build a `WebSearchSource` from one raw `{ title, url, snippet }` result, omitting empty optional fields. */
function toSource(result: { url?: string; title?: string; snippet?: string }): WebSearchSource | undefined {
  const url = result.url?.trim()
  if (url === undefined || url.length === 0) return undefined
  const title = result.title?.trim()
  const snippet = result.snippet?.trim()
  return {
    url,
    ...title !== undefined && title.length > 0 ? { title } : {},
    ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal: AbortSignal | undefined, fallback: unknown): WebError {
  return new WebError('Command Code web search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw searchAborted(signal, undefined)
}

/**
 * A `ctx.web` search provider backed by the Command Code Provider API, reusing
 * the plugin's credential chain and `apiBase` so the model-facing `web_search`
 * tool needs no separate configuration. Selection between multiple search
 * providers is the web seam's job (pin `searchProvider: commandcode` if
 * ambiguous).
 */
export class CommandCodeSearchProvider implements WebSearchProvider {
  readonly id = COMMANDCODE_SEARCH_PROVIDER_ID

  constructor(private readonly deps: CommandCodeSearchProviderDeps) {}

  /** Cheap local check; must not make network calls. Presence of a parseable base is enough. */
  available(): boolean {
    const base = this.deps.apiBase()
    return base.length > 0 && URL.canParse(base)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const apiBase = this.deps.apiBase()
    if (!URL.canParse(apiBase)) {
      throw new WebError(
        `Command Code web search is misconfigured: apiBase ${JSON.stringify(apiBase)} is not a valid URL`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const key = await this.resolveKey(signal, apiBase)
    throwIfAborted(signal)
    const endpoint = `${apiBase.replace(/\/$/, '')}${SEARCH_ROUTE}`

    const body = {
      query: request.query,
      numResults: clampNumResults(request.maxResults),
    }

    let response: Response | undefined
    let lastError: unknown
    const startedAt = Date.now()
    for (let attempt = 1; attempt <= SEARCH_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal)
      try {
        response = await (this.deps.fetchImpl ?? fetch)(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...IDENTITY_ENCODING_HEADER,
            Authorization: `Bearer ${key}`,
            'x-command-code-version': COMMAND_CODE_CLI_VERSION,
            'x-cli-environment': 'production',
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          ...signal !== undefined ? { signal } : {},
        })
        break
      } catch (error: unknown) {
        // Cancellation is never retried, and a received-response path below is
        // never reached: this catch only covers a fetch that got no response.
        // Every such rejection counts as transient; see the module comment for
        // why a code allowlist would be worse.
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        lastError = error
        if (attempt === SEARCH_MAX_ATTEMPTS) break
        await (this.deps.retryWait ?? searchRetryWait)(searchRetryDelayMs(attempt), signal)
      }
    }
    if (response === undefined) {
      throw new WebError(
        transportFailureMessage(lastError, apiBase, SEARCH_MAX_ATTEMPTS, Date.now() - startedAt),
        'WEB_PROVIDER_ERROR',
        { cause: lastError },
      )
    }

    if (!response.ok) {
      let message = `Command Code web search failed (HTTP ${response.status})`
      try {
        const parsed: unknown = await response.json()
        const detail = typeof parsed === 'object' && parsed !== null
          ? (parsed as { error?: unknown })?.error
          : undefined
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
        else if (typeof detail === 'object' && detail !== null) {
          const code = (detail as { code?: unknown })?.code
          const inner = (detail as { message?: unknown })?.message
          if (typeof code === 'string' || typeof inner === 'string') {
            message += `: ${typeof code === 'string' ? code : ''}${typeof code === 'string' && typeof inner === 'string' ? ' — ' : ''}${typeof inner === 'string' ? inner : ''}`
          }
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Non-JSON error bodies (proxy/gateway HTML): keep a truncated slice
        // so the status line still says something actionable.
        const text = await response.text().catch(() => '')
        const slice = text.trim().slice(0, 200)
        if (slice !== '') message += `: ${slice}`
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError('Command Code web search returned an unparseable response body', 'WEB_PROVIDER_ERROR', { cause: error })
    }

    const results = (payload as { results?: unknown })?.results
    if (!Array.isArray(results)) {
      throw new WebError(
        'Command Code web search returned no results array (the server may have rejected the query)',
        'WEB_PROVIDER_ERROR',
      )
    }

    const sources: WebSearchSource[] = []
    const seen = new Set<string>()
    for (const item of results) {
      if (typeof item !== 'object' || item === null) continue
      const source = toSource(item as { url?: string; title?: string; snippet?: string })
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      sources.push(source)
    }

    return { sources, truncated: false }
  }

  private async resolveKey(signal: AbortSignal | undefined, apiBase: string): Promise<string> {
    let key: string | undefined
    try {
      key = await this.deps.resolveKey(apiBase)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      // Preserve the plugin's structured credential/usage taxonomy so the web
      // tool surfaces the real cause (e.g. every account exhausted, key
      // invalid). A MISSING credential maps to WEB_PROVIDER_CREDENTIAL_MISSING;
      // real rejections (INVALID_CREDENTIAL / RATE_LIMIT) keep their message
      // but ride the provider-error code the tool understands.
      if (error instanceof Error && typeof (error as HarnessError).code === 'string') {
        const code = (error as HarnessError).code
        if (code === 'MISSING_CREDENTIAL') throw new WebError(error.message, 'WEB_PROVIDER_CREDENTIAL_MISSING', { cause: error })
        if (code === 'INVALID_CREDENTIAL' || code === 'RATE_LIMIT') {
          throw new WebError(error.message, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }
      throw new WebError(
        `Command Code web search credential resolution failed: ${readableErrorText(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (key === undefined || key.length === 0) {
      throw new WebError(
        'Command Code web search has no API key; store COMMANDCODE_API_KEY through the credentials service (the web Models page writes it), export it in the launching environment, set config.apiKey, or run `command-code login` to write ~/.commandcode/auth.json',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    return key
  }
}
