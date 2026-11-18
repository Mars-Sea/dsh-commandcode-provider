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
 * The SELECTION seam — which registered search backend `ctx.web` actually runs
 * — lives in `web-selection.ts`, because search and fetch select through the
 * same field-generic mechanism. It is re-exported here so this module stays the
 * one import surface for the search half.
 *
 * ## Search retries
 *
 * `dsh-tool-web` fans several queries out concurrently and aborts the whole
 * batch on the FIRST failure (it rethrows that failure; issue #117), so one
 * transient connection failure used to discard every result. The endpoint is
 * read-only and idempotent, and the failure the issue observed arrived before
 * any HTTP status — a network-level `fetch failed`, not a plan/credential
 * verdict. This provider therefore repeats a fetch that never received a
 * response, up to {@link WEB_REQUEST_MAX_ATTEMPTS} attempts with jittered
 * exponential backoff, and leaves every received status (401/403/429/…) and
 * every response-body failure untouched: a received status is the server's
 * answer, and a body failure means the request was already accepted and may
 * have been executed, so replaying it risks duplicate billing. Cancellation
 * always wins — an aborted call (including the tool's cooperative deadline)
 * stops before the next attempt and still reports `WEB_ABORTED`. The shared
 * cadence itself lives in `web-request.ts`.
 *
 * Every non-cancel `fetch` rejection counts as retryable: the engine does not
 * classify the `error.cause` for us, and a deterministic failure (an expired
 * certificate, an argument the runtime rejects) merely costs the bounded
 * backoff before the same error surfaces. That is cheaper than maintaining a
 * transient-code allowlist that silently drops an unlisted blip.
 *
 * @module dsh-commandcode-provider/web-search
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebRuntime, WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { HarnessError } from '@deepseek-ai/dsh-llm'
import { readableErrorText } from './readable-error.ts'
import {
  WEB_REQUEST_MAX_ATTEMPTS,
  abortedError,
  isAbortError,
  throwIfAborted,
  transportFailureMessage,
  webRequestHeaders,
  webRetryDelayMs,
  webRetryWait,
} from './web-request.ts'
import type { WebProviderDeps } from './web-request.ts'
import {
  WEB_SELECTION_NAMESPACE,
  commandCodeSelection,
  createCommandCodeSelection,
} from './web-selection.ts'
import type {
  CommandCodeSelection,
  WebSelectionDeps,
  WebSelectionField,
  WebSelectionHandle,
  WebSelectionLogger,
  WebSelectionOptions,
  WebSelectionSettings,
} from './web-selection.ts'

// The selection seam serves BOTH web capabilities and is re-exported here so the
// many existing imports of it from this module keep working unchanged.
export {
  WEB_SELECTION_NAMESPACE,
  commandCodeSelection,
  createCommandCodeSelection,
}
export type {
  CommandCodeSelection,
  WebSelectionDeps,
  WebSelectionField,
  WebSelectionHandle,
  WebSelectionLogger,
  WebSelectionOptions,
  WebSelectionSettings,
}

/** Selection state for the search capability, kept under the module's historical name. */
export type CommandCodeSearchSelection = CommandCodeSelection

/** The search selection handle, kept under the module's historical name. */
export type WebSearchSelectionHandle = WebSelectionHandle

/** Search-selection dependencies, kept under the module's historical name. */
export type WebSearchSelectionDeps = WebSelectionDeps

/**
 * Fresh, unowned selection state.
 *
 * Kept as a named wrapper (rather than only the generic
 * {@link commandCodeSelection}) because this module is where the search half has
 * always published it.
 *
 * @returns zeroed search-selection state.
 */
export function commandCodeSearchSelection(): CommandCodeSearchSelection {
  return commandCodeSelection()
}

/** The `web` config field the search selection reads and writes. */
export const WEB_SEARCH_SELECTION_FIELD: WebSelectionField = 'searchProvider'

/**
 * The factory-declared search provider id dsh ships by default (from
 * `dsh-base`'s cordis patch `web.config.searchProvider`). A documented
 * reference only: disabling this plugin's `webSearch` toggle restores the
 * PREVIOUSLY selected backend, never this default (issue #26).
 */
export const DEFAULT_WEB_SEARCH_PROVIDER_ID = 'deepseek-official'

/**
 * Align `web.searchProvider` with one end of the `webSearch` toggle.
 *
 * A thin, named wrapper over {@link createCommandCodeSelection}: the search
 * half keeps its own factory so no call site has to know the field name.
 *
 * @param deps - the running `web` service, a settings resolver, and a log sink.
 * @returns a synchronous handle; failures are logged, never thrown.
 */
export function createCommandCodeSearchSelection(deps: WebSelectionDeps): WebSelectionHandle {
  return createCommandCodeSelection(deps, {
    field: WEB_SEARCH_SELECTION_FIELD,
    providerId: COMMANDCODE_SEARCH_PROVIDER_ID,
    subject: 'web search',
  })
}

/** Re-exported so a caller can reach the running service type without importing dsh-web. */
export type { WebRuntime }

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
 * The shared {@link WEB_REQUEST_MAX_ATTEMPTS} budget, re-exported under this
 * module's historical name because tests and docs cite it.
 */
export const SEARCH_MAX_ATTEMPTS = WEB_REQUEST_MAX_ATTEMPTS

/**
 * Wait before the next attempt, doubling from 500 ms with ±20% jitter.
 *
 * @param attempt - the failed attempt number, starting at 1.
 * @returns the delay in milliseconds.
 */
export function searchRetryDelayMs(attempt: number): number {
  return webRetryDelayMs(attempt)
}

/**
 * Sleep before a retry, resolving early only by rejecting with the caller's
 * cancellation.
 *
 * @param delayMs - how long to wait.
 * @param signal - the caller's cancellation.
 */
export function searchRetryWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return webRetryWait(delayMs, signal)
}

/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
export type CommandCodeSearchProviderDeps = WebProviderDeps

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
          headers: webRequestHeaders(key),
          body: JSON.stringify(body),
          ...signal !== undefined ? { signal } : {},
        })
        break
      } catch (error: unknown) {
        // Cancellation is never retried, and a received-response path below is
        // never reached: this catch only covers a fetch that got no response.
        // Every such rejection counts as transient; see the module comment for
        // why a code allowlist would be worse.
        if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
        lastError = error
        if (attempt === SEARCH_MAX_ATTEMPTS) break
        await (this.deps.retryWait ?? webRetryWait)(searchRetryDelayMs(attempt), signal)
      }
    }
    if (response === undefined) {
      throw new WebError(
        transportFailureMessage('web search', lastError, apiBase, SEARCH_MAX_ATTEMPTS, Date.now() - startedAt),
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
        if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
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
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
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
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
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

/** Stable id this provider registers under in `ctx.web`. */
export const COMMANDCODE_SEARCH_PROVIDER_ID = 'commandcode'
