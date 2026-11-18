/**
 * Shared request plumbing for the two `ctx.web` providers.
 *
 * `web-search.ts` and `web-fetch.ts` hit sibling endpoints of the same gateway
 * with the same headers, the same credential chain, and the same failure
 * taxonomy, so everything below is written once here instead of twice:
 *
 * - the bounded retry cadence for a fetch that never received a response;
 * - the abortable retry wait;
 * - the cancellation error that preserves the caller's reason;
 * - the transport-failure diagnosis that names the cause, target and attempt
 *   count without ever echoing a credential.
 *
 * ## Why these two endpoints retry at all, and only this far
 *
 * The endpoints are read-only and idempotent, and the failure issue #117
 * observed arrived before any HTTP status — a network-level `fetch failed`, not
 * a plan/credential verdict. Meanwhile a received status (401/403/429/5xx) is
 * the server's answer, and a body failure means the request was already accepted
 * and may have been executed, so replaying either risks duplicate billing. The
 * retry therefore covers exactly "the request never got a response".
 *
 * Cancellation always wins: an aborted call stops before the next attempt and
 * still reports the provider's own abort code.
 *
 * @module dsh-commandcode-provider/web-request
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { COMMAND_CODE_CLI_VERSION } from './adapter.ts'
import { readableErrorText } from './readable-error.ts'
import { IDENTITY_ENCODING_HEADER } from './response-encoding.ts'
import { httpOrigin, transportFailureReason } from './transport-failure.ts'

/**
 * Attempts per request: the first try plus two retries.
 *
 * dsh fans a multi-query SEARCH call out concurrently and aborts the siblings of
 * the first failure, so retrying here is what keeps one connection blip from
 * discarding a four-query research step (issue #117). A FETCH is a single
 * request, but the same budget still applies: one blip should not cost the whole
 * page. Two retries cover the common transient cases. The budget deliberately
 * brushes the web tool's default 30 s cooperative deadline, so a slow
 * connect-timeout failure can hit that deadline mid-retry and surface as the
 * abort code instead of the terminal diagnosis; the full arithmetic and the
 * rejected alternatives live in docs/agent-reference/accounts-and-retry.md.
 */
export const WEB_REQUEST_MAX_ATTEMPTS = 3

/** Base wait before the second attempt; each later wait doubles. */
const RETRY_BASE_DELAY_MS = 500

/** ±fraction applied to each wait so concurrent requests do not retry in lockstep. */
const RETRY_JITTER_RATIO = 0.2

/**
 * Wait before the next attempt, doubling from 500 ms with ±20% jitter.
 *
 * The jitter matters more for search than for fetch: a four-query fan-out that
 * shares one network hiccup would otherwise reconnect all four at the same
 * instant. Exported so the cadence is pinned without waiting on real timers.
 *
 * @param attempt - the failed attempt number, starting at 1.
 * @returns the delay in milliseconds.
 */
export function webRetryDelayMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  const jitter = 1 + (Math.random() * 2 - 1) * RETRY_JITTER_RATIO
  return Math.round(base * jitter)
}

/** Whether a caught value is the runtime's own abort rejection. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * The failure a request ends with once every attempt has failed.
 *
 * `fetch failed` alone cannot distinguish a reset from a connect timeout from
 * a dead proxy (issue #117), so the cause code, target origin and elapsed time
 * ride along. The origin comes from `httpOrigin()`, which drops paths and
 * query strings, so a reverse proxy prefix or a credential never leaks here.
 *
 * @param subject - user-facing name of the operation (`web search` / `web fetch`).
 * @param error - the last transport rejection.
 * @param apiBase - the gateway the request targeted.
 * @param attempts - how many attempts were spent.
 * @param elapsedMs - wall time from the first attempt.
 * @returns the diagnosis text.
 */
export function transportFailureMessage(
  subject: string,
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
  return `Command Code ${subject} request failed: ${readableErrorText(error)}（${details.join('；')}）`
}

/**
 * The connection facts and test seams both providers need. Kept structural so a
 * provider class stays cordis-free and drivable from a plain node test.
 */
export interface WebProviderDeps {
  /**
   * 使用本次调用已捕获的网关解析账号，探测不能在等待后转到另一个网关。
   */
  resolveKey(apiBase?: string): Promise<string | undefined>
  /** The API base host (defaults to `https://api.commandcode.ai`). */
  apiBase(): string
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable retry wait for tests; defaults to the module's abortable retry wait. */
  retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Sleep before a retry, resolving early only by rejecting with the caller's
 * cancellation. A plain `setTimeout` would let an aborted tool call sit out a
 * wait it no longer needs; this keeps the abort responsive and preserves the
 * provider's abort taxonomy.
 *
 * Exported so the cancellation behavior is pinned without waiting out a real
 * 500 ms timer: tests can either await this helper directly or wrap it to learn
 * when the wait started.
 */
export function webRetryWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortedError(signal, signal.reason))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortedError(signal, signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build a provider's stable cancellation error while retaining the caller's
 * reason.
 *
 * @param signal - the caller's signal, when it aborted.
 * @param fallback - the rejection that revealed the abort.
 * @param message - the provider-specific message.
 * @returns a `WebError` carrying `WEB_ABORTED`.
 */
export function abortedError(
  signal: AbortSignal | undefined,
  fallback: unknown,
  message = 'Command Code web request aborted',
): WebError {
  return new WebError(message, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/**
 * Re-throw as the cancellation error when the caller has already aborted.
 *
 * @param signal - the caller's signal.
 * @param message - the provider-specific message.
 */
export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted === true) throw abortedError(signal, undefined, message)
}

/**
 * The headers every Command Code web request carries, identical on both
 * endpoints so the gateway cannot tell the two apart by provenance.
 *
 * @param key - the resolved Command Code key.
 * @returns the request headers.
 */
export function webRequestHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...IDENTITY_ENCODING_HEADER,
    Authorization: `Bearer ${key}`,
    'x-command-code-version': COMMAND_CODE_CLI_VERSION,
    'x-cli-environment': 'production',
    ...attributionHeaders(),
  }
}
