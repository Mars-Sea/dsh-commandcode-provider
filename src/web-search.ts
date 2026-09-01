/**
 * dsh-commandcode-provider — Command Code web search provider over `ctx.web`.
 *
 * The official Command Code CLI ships a built-in `web_search` tool that POSTs
 * `{ query, numResults, allowedDomains?, blockedDomains? }` to
 * `{apiBase}/alpha/web-search` and reads `{ results: [{ title, url, snippet }] }`
 * back. It authenticates with the SAME `Authorization: Bearer <key>` header and
 * `x-command-code-version` the model adapter uses, so this provider reuses the
 * plugin's existing credential chain (`COMMANDCODE_API_KEY` → credentials seam →
 * `~/.commandcode/auth.json`) — no separate DeepSeek key, no extra endpoint.
 *
 * This mirrors the host-side `@deepseek-ai/dsh-web-search-deepseek` provider in
 * shape: a cordis-free class registered into the web seam, resolving its key per
 * search, mapping each server-side result to the harness's normalized
 * `WebSearchSource`. The web seam owns `maxResults` truncation.
 *
 * @module dsh-commandcode-provider/web-search
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { attributionHeaders, type HarnessError } from '@deepseek-ai/dsh-llm'
import { COMMAND_CODE_CLI_VERSION } from './adapter.ts'

/** Stable id this provider registers under in `ctx.web`. */
export const COMMANDCODE_SEARCH_PROVIDER_ID = 'commandcode'

/**
 * The factory-declared search provider id dsh ships by default (from
 * `dsh-base`'s cordis patch `web.config.searchProvider`). A plugin that wants
 * its own backend to win rewrites `WebRuntime.searchProviderId` to its own id;
 * disabling that plugin restores this value.
 */
export const DEFAULT_WEB_SEARCH_PROVIDER_ID = 'deepseek-official'

/**
 * A structurally-typed view of `WebRuntime`'s private selection field.
 *
 * `searchProviderId` is declared `private readonly` on the class, but the
 * compiled runtime property is a plain writable field read per search call
 * (`web.search()` reads `this.searchProviderId` on every invocation). dsh
 * offers no public API to change the selected search provider at runtime, so
 * this seam mutates the instance field directly. That is a deliberate, bounded
 * dependency on the runtime shape: if dsh ever makes the field `#private` or
 * caches it in a closure, this write silently stops applying and the plugin
 * falls back to its provider remaining registered-but-unselected (the boot-time
 * `searchProvider: commandcode` cordis patch is the durable alternative).
 */
interface WebRuntimeSearchField {
  /** The selected search provider id; read per call by `search()`. */
  searchProviderId: string | undefined
}

/**
 * Point the web seam's search selection at this plugin's provider (`commandcode`).
 * Sets the runtime field; the next search call honours it because `search()`
 * re-reads `searchProviderId` each time. Returns the prior id (or undefined).
 */
export function selectCommandCodeSearchProvider(web: WebRuntime, enable: boolean): string | undefined {
  const field = web as unknown as WebRuntimeSearchField
  const prior = field.searchProviderId
  field.searchProviderId = enable ? COMMANDCODE_SEARCH_PROVIDER_ID : DEFAULT_WEB_SEARCH_PROVIDER_ID
  return prior
}

/** Command Code's lower/upper bound on `numResults` (from the CLI's `web_search` schema). */
const MIN_NUM_RESULTS = 1
const MAX_NUM_RESULTS = 10
/** CLI default when the caller sets no result cap. */
const DEFAULT_NUM_RESULTS = 5

/** The endpoint the search POST goes to; `{apiBase}` is prepended. */
const SEARCH_ROUTE = '/alpha/web-search'

/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
export interface CommandCodeSearchProviderDeps {
  /** Resolve one usable Command Code key (credential seam → env → auth file), or undefined when none. */
  resolveKey(): Promise<string | undefined>
  /** The API base host (defaults to `https://api.commandcode.ai`). */
  apiBase(): string
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
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
 * A `ctx.web` search provider backed by the Command Code Provider API. Reuses
 * the plugin's credential chain and `apiBase`, so search "just works" with the
 * existing key — the model-facing `web_search` tool needs no separate
 * configuration. Selection between multiple search providers is the web seam's
 * job (pin `searchProvider: commandcode` if ambiguous).
 */
export class CommandCodeSearchProvider implements WebSearchProvider {
  readonly id = COMMANDCODE_SEARCH_PROVIDER_ID

  constructor(private readonly deps: CommandCodeSearchProviderDeps) {}

  /** Cheap local check; must not make network calls. Presence of a key path + a parseable base is enough. */
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
    const key = await this.resolveKey(signal)
    throwIfAborted(signal)
    const endpoint = `${apiBase.replace(/\/$/, '')}${SEARCH_ROUTE}`

    const body = {
      query: request.query,
      numResults: clampNumResults(request.maxResults),
    }

    let response: Response
    try {
      response = await (this.deps.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'x-command-code-version': COMMAND_CODE_CLI_VERSION,
          'x-cli-environment': 'production',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `Command Code web search request failed: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
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
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError('Command Code web search returned an unparseable response body', 'WEB_PROVIDER_ERROR')
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

  private async resolveKey(signal: AbortSignal | undefined): Promise<string> {
    let key: string | undefined
    try {
      key = await this.deps.resolveKey()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      // Preserve the plugin's structured credential/usage taxonomy so the web
      // tool surfaces the real cause (e.g. every account exhausted, key
      // invalid) instead of a generic provider failure. The actionable
      // "no key configured" case maps to WEB_PROVIDER_CREDENTIAL_MISSING;
      // real rejection causes (INVALID_CREDENTIAL / RATE_LIMIT) keep their
      // message but ride the provider-error code the tool understands.
      if (error instanceof Error && typeof (error as HarnessError).code === 'string') {
        const code = (error as HarnessError).code
        if (code === 'MISSING_CREDENTIAL') throw new WebError(error.message, 'WEB_PROVIDER_CREDENTIAL_MISSING', { cause: error })
        if (code === 'INVALID_CREDENTIAL' || code === 'RATE_LIMIT') {
          throw new WebError(error.message, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }
      throw new WebError(
        `Command Code web search credential resolution failed: ${error instanceof Error ? error.message : String(error)}`,
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
