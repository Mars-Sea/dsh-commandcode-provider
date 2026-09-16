/**
 * A bounded retry budget for `TRANSPORT` failures (issue #39, second report).
 *
 * The route's retry policy (`providerRetryPolicy` in `./adapter.ts`) is
 * deliberately near-unbounded: 1000 attempts with waits doubling to a 15-minute
 * cap. That shape exists for the failures a provider ASKS to have retried — an
 * exhausted 5-hour window, a Cloudflare 520 — where the wait is the point.
 *
 * A transport failure is not that. The reporter's second event at ~710k
 * context was `Connect Timeout Error ... timeout: 10000ms` (undici's own
 * connect timeout; this plugin's `requestTimeoutMs` is 60s) and, on another
 * attempt, `read ECONNRESET` against `/alpha/generate`. Because `TRANSPORT` is
 * in the whitelist, each of those entered the same 1000-attempt loop: with
 * `initialDelayMs: 500` doubling, the wait before attempt 11 alone is 512 s and
 * the cumulative wait before it is ~500 s — the "模型请求重试已取消（11/1000）·
 * 482s" the reporter photographed is that 512 s countdown, 30 s into it — and
 * those waits are counted BEFORE each retry attempt, not after it.
 *
 * A connection that cannot be established is either a sub-second blip (the
 * first few attempts recover it, invisibly) or an outage that no amount of
 * waiting inside one request will fix. So transport failures get their own
 * budget, and when it is exhausted the failure is surfaced with the diagnosis
 * instead of manufacturing a multi-minute stall. Waiting out a real outage is
 * the user's call — the next send starts a fresh budget — and
 * `dsh-llm-retry`'s window for rate limits is untouched.
 *
 * Deliberately NOT counted here: the pre-stream recovery the ADAPTER performs
 * inside one `stream()` call (account rotation on 429/401, the 413 image-budget
 * step-down, the Provider-API → CLI protocol switch). Those are invisible to
 * the caller and bounded on their own; this budget caps only the harness's
 * retry loop.
 *
 * Reset rule: the budget clears at each new STEP — one step is exactly one
 * model request (`step/start` is appended immediately before the call) — so the
 * cap is per logical request and the next step of the same turn gets its own
 * grace. `agent/status` → `idle` is NOT the reset signal even though it looks
 * like the natural one: the agent loop's `setPhase` emits it only on a status
 * CHANGE, and a turn's steps all run inside one `running` phase, so it never
 * fires between them — a budget reset only there would be per-turn, and an
 * outage would fail every later step of that turn immediately instead of
 * retrying each. `assistant/attempt` is wrong for the opposite reason: the loop
 * appends it for the FAILED attempt itself, *before* dispatching
 * `agent/request-error`, so resetting on it would clear the budget on every
 * failure and restore the very loop this module exists to stop.
 *
 * @module
 */

/** Failure code this budget covers. */
export const TRANSPORT_FAILURE_CODE = 'TRANSPORT'

/**
 * Transport failures to absorb before surfacing the failure, by default.
 *
 * The waits between the attempts come from the route policy's cadence
 * (`initialDelayMs: 500` doubling): the retries this setting buys are scheduled
 * 0.5 s, 1 s, 2 s, 4 s and 8 s after the failures that preceded them, so the
 * default absorbs an ordinary blip for ~15.5 s and then reports the failure
 * instead of continuing into the 16 s, 32 s … 15-minute waits. (Those figures
 * are the waits BEFORE each retry attempt, which is how the harness's own retry
 * chrome counts them — the `· 482s` on the reporter's row is one such wait.)
 */
export const DEFAULT_TRANSPORT_MAX_RETRIES = 5

/**
 * Ceiling for {@link DEFAULT_TRANSPORT_MAX_RETRIES}'s setting.
 *
 * Deliberately far above the default rather than near it: raising the budget is
 * a legitimate answer to a genuinely flaky link, and the cap is a plausibility
 * bound, not a recommendation. The same number is mirrored in `Config`'s schema
 * and in the settings page's field bound (the client bundle cannot import this
 * node-side module); `tests/transport-retry.test.ts` pins the schema's bound
 * against this constant, which is what makes a drift visible.
 */
export const MAX_TRANSPORT_MAX_RETRIES = 50

/** Why {@link absorbTransportFailure} answered the way it did. */
export type TransportRetryDecision = 'retry' | 'exhausted' | 'ignored'

/** One agent's live transport-failure count, keyed weakly so a dropped agent cannot leak. */
const counts = new WeakMap<object, number>()

/**
 * Count one attempt's outcome against the transport budget.
 *
 * @param agent - the identity the budget is scoped to (the agent object).
 * @param failureCode - the failed attempt's `LlmFailure.code`.
 * @param maxRetries - transport retries to absorb before the failure surfaces.
 * @returns `'ignored'` for any non-transport code (the route policy decides
 *   those, unchanged), `'retry'` while the budget has room, `'exhausted'` once
 *   it does not.
 */
export function absorbTransportFailure(
  agent: object,
  failureCode: string,
  maxRetries: number,
): TransportRetryDecision {
  if (failureCode !== TRANSPORT_FAILURE_CODE) return 'ignored'
  const used = counts.get(agent) ?? 0
  if (used >= maxRetries) return 'exhausted'
  counts.set(agent, used + 1)
  return 'retry'
}

/** Clear one agent's transport budget (a new step starts, or the turn ended). */
export function resetTransportFailures(agent: object): void {
  counts.delete(agent)
}

/**
 * What one session event means for the transport budget.
 *
 * Exported and pure on purpose: the choice of event is the part of this design
 * that is easy to get plausibly wrong (`agent/status` → `idle` looks like the
 * natural reset and is not one — see the module comment), so it is stated once,
 * here, where a test can pin it, instead of being implied by a listener body.
 *
 * @param type - the appended session event's type.
 * @returns `'reset'` for a new step (one model request), `'forget'` when the
 *   turn ended and the session → agent mapping is no longer needed, otherwise
 *   `'none'`.
 */
export function transportResetAction(type: string): 'reset' | 'forget' | 'none' {
  if (type === 'step/start') return 'reset'
  if (type === 'turn/end') return 'forget'
  return 'none'
}

/**
 * The diagnosis a capped turn ends with. Bilingual, because the harness renders
 * a failed turn's message verbatim and this plugin's other user-facing failures
 * are bilingual too (see the adapter's error builders). It names the retry
 * budget and the checks that actually help, instead of the bare "fetch failed"
 * chain the retry chrome would otherwise show.
 */
export function transportBudgetMessage(failureMessage: string, maxRetries: number): string {
  return `${failureMessage}`
    + '；Command Code API 连接在连续重试后仍失败——已停止重试以免整轮卡死。'
    + `插件已自动重试 ${maxRetries} 次。通常说明当前网络到 api.commandcode.ai 的连接不通，`
    + '常见原因是代理未生效：DSH 只读取环境变量 HTTPS_PROXY/HTTP_PROXY（系统代理/PAC 不会被读取），'
    + '请确认启动 DSH 的终端里已导出代理，或先关闭代理直连后重试。网络恢复后直接重发即可'
    + ` — Command Code API transport still failed after ${maxRetries} automatic retries, which were`
    + ' stopped so the turn could not stall for minutes. This is a connectivity problem between this'
    + ' machine and api.commandcode.ai, not a context-window or request-size rejection. Common cause:'
    + ' the proxy is not reaching the harness — DSH reads HTTPS_PROXY/HTTP_PROXY from the environment'
    + ' only (a Windows system proxy/PAC setting is not consulted), so export it in the launching'
    + ' shell, or turn the proxy off and retry. Resend when the network recovers; the budget is per'
    + ' request and has been reset'
}
