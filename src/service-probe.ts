/**
 * Host-side connectivity probe behind `commandcode/probe`.
 *
 * Sends one GET to the configured API base and classifies the answer the way
 * Upptime's monitor does: its default `expectedStatusCodes` are the 2xx family
 * (minus 209+ quirks) plus 3xx redirects, so a 200/301 counts as up and
 * anything else (401, 404, 5xx) is an HTTP-level failure. A timeout or a
 * network error is reported separately, because "cannot reach it" and "it
 * answered 500" are different problems for the user.
 *
 * The base is probed AS CONFIGURED, path prefix included: this plugin sends
 * model requests by concatenating `${apiBase}${path}`, so a base behind a
 * prefix reverse proxy only answers inside that prefix, and collapsing to the
 * host root would report a false failure for a base that works.
 *
 * The probe never throws: every failure becomes an outcome the row can render.
 * The request is deliberately unauthenticated and body-less — it must not touch
 * the credential seam or the quota, and it measures the same surface the status
 * page monitors.
 *
 * @module dsh-commandcode-provider/service-probe
 */

import type { CommandCodeProbeResult, ProbeOutcome } from './service-probe-wire.ts'

/** Abort a hung probe; the settings row must not wait on a dead endpoint. */
export const PROBE_TIMEOUT_MS = 5_000

/**
 * HTTP statuses Upptime's default monitor accepts as `up` (from
 * `uptime-monitor`'s `expectedStatusCodes` fallback). Kept in sync with the
 * page's monitor rather than invented here: a 401 or 404 means the endpoint
 * answered but is not the surface the official check calls healthy.
 */
const UP_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
  300, 301, 302, 303, 304, 305, 306, 307, 308,
])

/** Turn the response status into the outcome the row renders. */
export function probeOutcomeForStatus(status: number): ProbeOutcome {
  return UP_STATUSES.has(status) ? 'ok' : 'http-error'
}

/**
 * Resolve the URL one probe must hit for a configured base.
 *
 * The configured base is an ENDPOINT, not an origin: every model request this
 * plugin issues is built by string concatenation (`${apiBase}${path}`), so the
 * base's path prefix is load-bearing. A reverse proxy mounted on a prefix
 * (`http://127.0.0.1:18797/bili/https://api.commandcode.ai`) routes only
 * inside that prefix — `new URL('/', base)` targets the proxy's own root
 * instead and reports an HTTP failure for a base that carries real traffic.
 * Keep the configured path and only normalize the trailing slash, so the
 * monitor's body-less GET lands on the same shape the real requests use.
 *
 * Throws when `URL` cannot parse the base; the caller turns that into
 * `unreachable`.
 */
export function probeTargetOf(apiBase: string): string {
  const parsed = new URL(apiBase.trim())
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
  return parsed.toString()
}

/**
 * Probe the configured API base once. Never rejects: an invalid base, a
 * timeout and a transport failure all resolve to an outcome.
 *
 * `redirect: 'manual'` keeps the classification on the FIRST response, exactly
 * like the monitor's HTTP client; following a redirect would report the final
 * destination's status as if it were the API's own.
 */
export async function probeCommandCode(options: {
  /** The effective API base from the live config (defaults to the official host). */
  apiBase: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}): Promise<CommandCodeProbeResult> {
  const now = options.now ?? Date.now
  let url: string
  try {
    url = probeTargetOf(options.apiBase)
  } catch {
    return { outcome: 'unreachable', status: 0, latencyMs: 0, checkedAt: now() }
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS)

  const started = Date.now()
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: '*/*' },
    })
    const latencyMs = Math.max(0, Date.now() - started)
    // The body is irrelevant and may be large on a custom base; release it
    // instead of leaving the socket to the GC.
    try {
      await response.body?.cancel()
    } catch {
      // A body that cannot be cancelled is not a probe failure.
    }
    return {
      outcome: probeOutcomeForStatus(response.status),
      status: response.status,
      latencyMs,
      checkedAt: now(),
    }
  } catch {
    return {
      outcome: timedOut ? 'timeout' : 'unreachable',
      status: 0,
      latencyMs: 0,
      checkedAt: now(),
    }
  } finally {
    clearTimeout(timer)
  }
}
