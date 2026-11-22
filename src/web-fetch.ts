/**
 * Command Code web-FETCH provider over `ctx.web`.
 *
 * The official CLI's built-in `web_fetch` tool POSTs `{ url, format }` to
 * `{apiBase}/alpha/web-fetch` and reads `{ content, url?, status? }` back,
 * authenticating with the SAME `Authorization: Bearer <key>` and
 * `x-command-code-version` headers the model adapter uses (command-code@1.89.1,
 * `createWebFetchTool`, and the official tools reference). This provider
 * therefore reuses the plugin's existing credential chain and `apiBase`, so the
 * model-facing `web_fetch` tool needs no separate key, endpoint or model — the
 * same relationship `web-search.ts` has for `web_search`.
 *
 * ## What is deliberately NOT sent
 *
 * The CLI tool exposes two more parameters that this provider cannot and must
 * not forward, because dsh's fetch seam does not model them:
 *
 * - `startIndex` — pagination into long pages. It is NOT a wire field: the CLI
 *   slices the `content` it received, client-side. The gateway answers with the
 *   whole page, and `dsh-tool-web` owns the windowing of a long body (it caps the
 *   rendered output and appends its own truncation notice), so this provider
 *   forwards the body untouched rather than re-implementing a window.
 * - `timeout` — a per-call server budget. The caller's `AbortSignal` is the
 *   seam's cancellation contract, and `dsh-tool-web` already applies a
 *   cooperative deadline.
 *
 * The remaining CLI-only behavior (upgrading `http` to `https`, the private/
 * loopback URL guard, the 15-minute response cache) is NOT assumed to exist
 * server-side: this provider runs the URL guard itself before spending a
 * billable request (`fetchUrlGuard`).
 *
 * ## Body kind
 *
 * The provider asks for `format: 'markdown'` — the CLI default, and the only
 * format dsh's model-facing tool renders usefully — and delivers it as
 * `{ kind: 'text' }`. `dsh-tool-web` passes a `text` body through verbatim and
 * only converts an `html` body with its own DOM pipeline, so converting here
 * would mean shipping a second HTML converter for no reader.
 *
 * @module dsh-commandcode-provider/web-fetch
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
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
import { createCommandCodeSelection } from './web-selection.ts'
import type { WebSelectionDeps, WebSelectionField, WebSelectionHandle } from './web-selection.ts'

/** Stable id this provider registers under in `ctx.web`'s FETCH registry. */
export const COMMANDCODE_FETCH_PROVIDER_ID = 'commandcode'

/** The endpoint the fetch POST goes to; `{apiBase}` is prepended. */
export const FETCH_ROUTE = '/alpha/web-fetch'

/** The `format` this provider always requests; see the module comment. */
const FETCH_FORMAT = 'markdown'

/** Upper bound on a request URL, mirroring the CLI's client-side guard. */
const MAX_URL_LENGTH = 2_048

/**
 * IPv4 ranges that are not publicly routable. The gateway is the authority on
 * refusing these; this table only keeps a doomed request from being billed.
 */
const BLOCKED_IPV4_PATTERNS: readonly RegExp[] = [
  /^0\./,                  // "this network"
  /^10\./,                 // private
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
  /^127\./,                // loopback
  /^169\.254\./,           // link-local (cloud metadata)
  /^172\.(?:1[6-9]|2\d|3[01])\./, // private
  /^192\.0\.0\.0$/,        // IETF protocol assignments
  /^192\.168\./,           // private
  /^198\.1[89]\./,         // benchmarking
  /^2(?:2[4-9]|3\d)\./,    // multicast + reserved
  /^255\.255\.255\.255$/,  // broadcast
]

/** Host labels the CLI refuses outright. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'broadcasthost'])

/** The URL a fetch will actually request, or the reason it is refused. */
export type FetchUrlVerdict =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * Whether a hostname is a private, loopback or link-local literal address.
 *
 * Only literal IPs and the reserved names are judged: resolving a name here
 * would be a DNS lookup on the request path, and the seam's `available()` /
 * guard contract is explicitly network-free. A name that resolves to a private
 * address is the gateway's to refuse.
 *
 * @param hostname - the URL's hostname, already lower-cased by `URL`.
 * @returns true when the host literal or reserved name is not publicly routable.
 */
function isPrivateHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(bare)) return true
  // A single-label name (`intranet`, `router`) is never a public site.
  if (!bare.includes('.') && !bare.includes(':')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) {
    return BLOCKED_IPV4_PATTERNS.some(pattern => pattern.test(bare))
  }
  // IPv6 literals: loopback, unspecified, unique-local (fc00::/7), link-local
  // (fe80::/10), and IPv4-mapped forms of the same.
  if (bare.includes(':')) {
    const normalized = bare.toLowerCase()
    if (normalized === '::' || normalized === '::1') return true
    if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) return true
    if (/^fe[89ab][0-9a-f]?:/.test(normalized)) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)
    if (mapped !== null) return BLOCKED_IPV4_PATTERNS.some(pattern => pattern.test(mapped[1]!))
    return false
  }
  return false
}

/**
 * Validate a fetch target before any billable request is made.
 *
 * This mirrors the CLI's client-side guard, which it runs before its own
 * request: a URL that the gateway would refuse anyway must not cost a round
 * trip, and a URL pointing at the operator's own network must never be handed
 * to a remote service. The gateway repeats these checks; this is defense in
 * depth, not a replacement.
 *
 * @param raw - the URL from the fetch request.
 * @returns the upgraded URL, or the refusal.
 */
export function fetchUrlGuard(raw: string): FetchUrlVerdict {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, code: 'WEB_INVALID_URL', reason: 'the URL is empty' }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, code: 'WEB_INVALID_URL', reason: `the URL exceeds ${MAX_URL_LENGTH} characters` }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch (error: unknown) {
    return { ok: false, code: 'WEB_INVALID_URL', reason: `invalid URL: ${trimmed}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'WEB_INVALID_URL', reason: `unsupported scheme "${url.protocol}" (only http and https are allowed)` }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, code: 'WEB_BLOCKED_URL', reason: 'credentials in URLs are not allowed' }
  }
  if (isPrivateHostname(url.hostname)) {
    return { ok: false, code: 'WEB_BLOCKED_URL', reason: `private, loopback or single-label host "${url.hostname}" is not fetchable` }
  }
  // The CLI upgrades plain http to https, because the service fetches over TLS.
  if (url.protocol === 'http:') {
    url.protocol = 'https:'
    if (url.port === '80') url.port = ''
  }
  return { ok: true, url: url.toString() }
}

/** The `web` config field the fetch selection reads and writes. */
export const WEB_FETCH_SELECTION_FIELD: WebSelectionField = 'fetchProvider'

/**
 * Align `web.fetchProvider` with one end of the `webFetch` toggle.
 *
 * A thin, named wrapper over {@link createCommandCodeSelection}: the fetch half
 * keeps its own factory so no call site has to know the field name, exactly as
 * the search half does.
 *
 * @param deps - the running `web` service, a settings resolver, and a log sink.
 * @returns a synchronous handle; failures are logged, never thrown.
 */
export function createCommandCodeFetchSelection(deps: WebSelectionDeps): WebSelectionHandle {
  return createCommandCodeSelection(deps, {
    field: WEB_FETCH_SELECTION_FIELD,
    providerId: COMMANDCODE_FETCH_PROVIDER_ID,
    subject: 'web fetch',
  })
}

/** The JSON a successful fetch answers with. All three fields were observed on the wire. */
interface FetchPayload {
  content?: unknown
  url?: unknown
  status?: unknown
}

/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
export type CommandCodeFetchProviderDeps = WebProviderDeps

/**
 * A `ctx.web` fetch provider backed by the Command Code Provider API, reusing
 * the plugin's credential chain and `apiBase` so the model-facing `web_fetch`
 * tool needs no separate configuration. Selection between multiple fetch
 * providers is the web seam's job (the plugin pins `fetchProvider:
 * commandcode` through {@link import('./web-selection.ts').createCommandCodeSelection}).
 */
export class CommandCodeFetchProvider implements WebFetchProvider {
  readonly id = COMMANDCODE_FETCH_PROVIDER_ID
  // No `title` on purpose: the shipped web settings page renders a provider in
  // its menu as `title ?? id`, and the SEARCH provider declares none, so it shows
  // the bare id. Declaring a title here would label the two halves of the same
  // route differently in one page ("commandcode" vs "Command Code") and read like
  // two different backends. Both menus therefore show `commandcode`.
  /**
   * Picker description: what this provider suits and what it cannot do.
   *
   * Deliberately says nothing about cost — the shipped local provider's own line
   * is "free, can reach intranet and local addresses, no JavaScript/sign-in pages
   * or PDFs", and billing belongs to the account page, not to a picker.
   *
   * It also makes NO JavaScript claim. The CLI's own tool description says its
   * `web_fetch` "handles JavaScript-rendered pages", but that is upstream's
   * wording, not something this account was able to demonstrate: two genuinely
   * client-rendered apps (excalidraw.com, app.diagrams.net) came back as just
   * their page title — 21 and 41 characters — while static pages returned
   * thousands. Advertising a capability the evidence contradicts is worse than
   * saying less, so this line states only what was observed: whose servers run
   * the fetch, the Markdown result, and the addresses it cannot reach.
   * `en` is required by `LocalizedText`.
   */
  readonly description = {
    en: 'Fetched by Command Code\'s servers and returned as Markdown. Cannot reach intranet or local addresses.',
    zh: '由 Command Code 服务器抓取，返回 Markdown。无法访问内网和本机地址。',
  }

  constructor(private readonly deps: CommandCodeFetchProviderDeps) {}

  /** Cheap local check; must not make network calls. Presence of a parseable base is enough. */
  available(): boolean {
    const base = this.deps.apiBase()
    return base.length > 0 && URL.canParse(base)
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    throwIfAborted(signal, 'Command Code web fetch aborted')
    const guard = fetchUrlGuard(request.url)
    if (!guard.ok) {
      throw new WebError(`Command Code web fetch cannot fetch ${JSON.stringify(request.url)}: ${guard.reason}`, guard.code)
    }
    const apiBase = this.deps.apiBase()
    if (!URL.canParse(apiBase)) {
      throw new WebError(
        `Command Code web fetch is misconfigured: apiBase ${JSON.stringify(apiBase)} is not a valid URL`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const key = await this.resolveKey(signal, apiBase)
    throwIfAborted(signal, 'Command Code web fetch aborted')
    const endpoint = `${apiBase.replace(/\/$/, '')}${FETCH_ROUTE}`

    let response: Response | undefined
    let lastError: unknown
    const startedAt = Date.now()
    for (let attempt = 1; attempt <= WEB_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal, 'Command Code web fetch aborted')
      try {
        response = await (this.deps.fetchImpl ?? fetch)(endpoint, {
          method: 'POST',
          headers: webRequestHeaders(key),
          body: JSON.stringify({ url: guard.url, format: FETCH_FORMAT }),
          ...signal !== undefined ? { signal } : {},
        })
        break
      } catch (error: unknown) {
        // Cancellation is never retried, and a received-response path below is
        // never reached: this catch only covers a fetch that got no response.
        // Every such rejection counts as transient; see the module comment for
        // why a code allowlist would be worse.
        if (signal?.aborted === true || isAbortError(error)) {
          throw abortedError(signal, error, 'Command Code web fetch aborted')
        }
        lastError = error
        if (attempt === WEB_REQUEST_MAX_ATTEMPTS) break
        await (this.deps.retryWait ?? webRetryWait)(webRetryDelayMs(attempt), signal)
      }
    }
    if (response === undefined) {
      throw new WebError(
        transportFailureMessage('web fetch', lastError, apiBase, WEB_REQUEST_MAX_ATTEMPTS, Date.now() - startedAt),
        'WEB_PROVIDER_ERROR',
        { cause: lastError },
      )
    }

    if (!response.ok) {
      throw new WebError(await failureMessage(response, signal), 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw abortedError(signal, error, 'Command Code web fetch aborted')
      }
      throw new WebError('Command Code web fetch returned an unparseable response body', 'WEB_PROVIDER_ERROR', { cause: error })
    }

    return toFetchResult(payload, guard.url, signal)
  }

  private async resolveKey(signal: AbortSignal | undefined, apiBase: string): Promise<string> {
    let key: string | undefined
    try {
      key = await this.deps.resolveKey(apiBase)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw abortedError(signal, error, 'Command Code web fetch aborted')
      }
      // Preserve the plugin's structured credential/usage taxonomy so the web
      // tool surfaces the real cause (e.g. every account exhausted, key
      // invalid). A MISSING credential maps to WEB_PROVIDER_CREDENTIAL_MISSING;
      // real rejections (INVALID_CREDENTIAL / RATE_LIMIT) keep their message
      // but ride the provider-error code the tool understands.
      if (error instanceof Error && typeof (error as HarnessError).code === 'string') {
        const code = (error as HarnessError).code
        if (code === 'MISSING_CREDENTIAL') {
          throw new WebError(error.message, 'WEB_PROVIDER_CREDENTIAL_MISSING', { cause: error })
        }
        if (code === 'INVALID_CREDENTIAL' || code === 'RATE_LIMIT') {
          throw new WebError(error.message, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }
      throw new WebError(
        `Command Code web fetch credential resolution failed: ${readableErrorText(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (key === undefined || key.length === 0) {
      throw new WebError(
        'Command Code web fetch has no API key; store COMMANDCODE_API_KEY through the credentials service (the web Models page writes it), export it in the launching environment, set config.apiKey, or run `command-code login` to write ~/.commandcode/auth.json',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    return key
  }
}

/**
 * Narrow one raw `{ content, url?, status? }` body into the seam's closed
 * `WebFetchResult` union.
 *
 * A non-2xx upstream status is still a RESULT, not a throw: the seam documents
 * "a successful network fetch of a non-2xx response is a result", so the status
 * travels to the model rather than becoming an exception the tool has to
 * unwrap. Empty content for a 2xx is the one case that cannot be represented as
 * a page, so it fails loudly instead of pretending the fetch succeeded.
 *
 * @param payload - the parsed response body.
 * @param requestedUrl - the URL actually sent (already guarded and upgraded).
 * @param signal - the caller's signal, so a truncated read surfaces as an abort.
 * @returns the mapped result.
 */
function toFetchResult(payload: unknown, requestedUrl: string, signal: AbortSignal | undefined): WebFetchResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WebError('Command Code web fetch returned an unexpected response shape (expected an object with a `content` string)', 'WEB_PROVIDER_ERROR')
  }
  const body = payload as FetchPayload
  if (typeof body.content !== 'string') {
    throw new WebError('Command Code web fetch returned no `content` string', 'WEB_PROVIDER_ERROR')
  }
  const status = typeof body.status === 'number' && Number.isFinite(body.status) ? body.status : 200
  const finalUrl = typeof body.url === 'string' && body.url.trim().length > 0 ? body.url.trim() : requestedUrl
  if (status >= 200 && status < 300 && body.content.length === 0) {
    throw new WebError(
      `Command Code web fetch returned an empty page for ${finalUrl} (HTTP ${status}); the page may require sign-in, be JavaScript-only, or be blocked`,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (signal?.aborted === true) throw abortedError(signal, undefined, 'Command Code web fetch aborted')
  // Pass the body through untouched and report `truncated: false`.
  //
  // The gateway returns the WHOLE page: `startIndex` is not a wire field, it is
  // the CLI's own client-side window over the returned `content`. Cutting here
  // therefore loses text the caller never had a second chance to read — the seam
  // has no continuation parameter — and it cut at 100,000 while `dsh-tool-web`
  // renders up to 200,000. Windowing belongs to that tool, which caps the
  // rendered output and appends its own truncation notice.
  return {
    url: finalUrl,
    statusCode: status,
    body: { kind: 'text', content: body.content } as WebFetchBody,
    truncated: false,
  }
}

/**
 * Build the diagnosis for a non-success response.
 *
 * The error body is read with a cap, so a proxy's HTML error page cannot flood
 * the tool result. A JSON error with `error: { code, message }` (the gateway's
 * own shape) is rendered as `code — message`; anything else is quoted up to 200
 * characters.
 *
 * @param response - the non-success response.
 * @param signal - the caller's signal.
 * @returns the message for the thrown `WebError`.
 */
async function failureMessage(response: Response, signal: AbortSignal | undefined): Promise<string> {
  let message = `Command Code web fetch failed (HTTP ${response.status})`
  try {
    const parsed: unknown = await response.json()
    const detail = typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined
    if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
    else if (typeof detail === 'object' && detail !== null) {
      const code = (detail as { code?: unknown }).code
      const inner = (detail as { message?: unknown }).message
      if (typeof code === 'string' || typeof inner === 'string') {
        message += `: ${typeof code === 'string' ? code : ''}${typeof code === 'string' && typeof inner === 'string' ? ' — ' : ''}${typeof inner === 'string' ? inner : ''}`
      }
    }
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error, 'Command Code web fetch aborted')
    // Non-JSON error bodies (proxy/gateway HTML): keep a truncated slice
    // so the status line still says something actionable.
    const text = await response.text().catch(() => '')
    const slice = text.trim().slice(0, 200)
    if (slice !== '') message += `: ${slice}`
  }
  return message
}
