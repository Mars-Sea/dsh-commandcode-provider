/**
 * Host-side connectivity probe behind `commandcode/probe`.
 *
 * Answers one question: can THIS Host reach the configured Command Code API?
 * It therefore sends one unauthenticated GET to `{apiBase}/alpha/whoami` — the
 * same endpoint the plugin's own login validation and account queries hit, so
 * prefix-mounted reverse proxies, gateway routing and TLS are exercised exactly
 * as real traffic will exercise them.
 *
 * This used to probe the host root via `new URL('/', apiBase)`, which silently
 * drops any path prefix in `apiBase` (`apiBase` is a plain string, so a proxy
 * mount such as `http://127.0.0.1:18797/bili/https://api.commandcode.ai` is a
 * permitted config). The probe then asked the proxy's root instead of Command
 * Code and reported a false failure while real requests worked (issue #111).
 *
 * Statuses are read as REACHABILITY, not authorization: a credential-less GET
 * of `/alpha/whoami` is answered with 401 (or 403 behind some gateways), and
 * that answer is positive proof the API's auth layer replied from this Host.
 * 404/429/5xx remain HTTP-level failures; a timeout and a transport error stay
 * distinguishable, because "cannot reach it" and "it answered 500" are
 * different problems for the user.
 *
 * The probe never throws: every failure becomes an outcome the row can render.
 * The request is deliberately unauthenticated and body-less — it must not touch
 * the credential seam or the quota.
 *
 * @module dsh-commandcode-provider/service-probe
 */

import type { CommandCodeProbeResult, ProbeOutcome } from './service-probe-wire.ts'

/** Abort a hung probe; the settings row must not wait on a dead endpoint. */
export const PROBE_TIMEOUT_MS = 5_000

/** The endpoint whose answer proves the API's auth layer is reachable. */
const PROBE_PATH = '/alpha/whoami'

/**
 * HTTP statuses that prove the probed endpoint answered.
 *
 * 2xx/3xx are the positive answers. 401/403 belong here because the probe is
 * deliberately credential-less: the expected answer to an unauthenticated GET
 * of `/alpha/whoami` IS 401, and treating it as a failure would report every
 * healthy host as down. Everything else (404 from a wrong base path, 429, 5xx)
 * means the endpoint the plugin actually uses did not answer as a live API.
 */
const REACHABLE_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
  300, 301, 302, 303, 304, 305, 306, 307, 308,
  401, 403,
])

/** Turn the response status into the outcome the row renders. */
export function probeOutcomeForStatus(status: number): ProbeOutcome {
  return REACHABLE_STATUSES.has(status) ? 'ok' : 'http-error'
}

/**
 * Probe the configured API base once. Never rejects: an invalid base, a
 * timeout and a transport failure all resolve to an outcome.
 *
 * `redirect: 'manual'` keeps the classification on the FIRST response; the
 * probe reports what this Host reached, not where a redirect chain ends up.
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
    // 与真实请求同一拼接方式（`${apiBase}${path}`，见 adapter 的 fetchJson），
    // 反向代理挂载的路径前缀因此原样保留。这里刻意不做尾斜杠归一化：探活
    // 若比真实请求更宽容，就会出现「状态行正常、聊天全 404」的反向误导。
    if (!URL.canParse(options.apiBase)) throw new TypeError('invalid api base')
    url = `${options.apiBase}${PROBE_PATH}`
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
