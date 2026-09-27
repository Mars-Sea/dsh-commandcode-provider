/**
 * A bounded retry budget for `TRANSPORT` failures (issue #39, second report).
 *
 * The route policy (`providerRetryPolicy` in `./adapter.ts`) is near-unbounded
 * on purpose — 1000 attempts doubling to a 15-minute cap — because it exists
 * for failures the provider ASKS to have retried, where the wait is the point.
 * A connection that cannot be established is not that: either a blip the first
 * few attempts absorb, or an outage no in-request waiting fixes (and its waits
 * count BEFORE each attempt, so attempt 11 alone already waits 512 s). So
 * transport failures get their own budget; waiting out a real outage is the
 * user's call, and the next send starts a fresh budget.
 *
 * Not counted here: the pre-stream recovery the ADAPTER performs inside one
 * `stream()` call (account rotation, the 413 image-budget step-down, the
 * Provider-API → CLI switch) — invisible to the caller and bounded on its own.
 * This budget caps only the harness's retry loop.
 *
 * Reset rule: the budget clears at each new STEP (one step = one model request).
 * `agent/status` → `idle` is NOT it, though it looks natural: the loop's
 * `setPhase` emits it only on a status CHANGE, and a turn's steps all run inside
 * one `running` phase, so a reset there would fail every later step of an outage
 * turn at once instead of retrying each. `assistant/attempt` is wrong the other
 * way — the loop appends it for the FAILED attempt itself, before dispatching
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
 * On the route policy's cadence (`initialDelayMs: 500` doubling) this buys waits
 * of 0.5/1/2/4/8 s, so the default absorbs an ordinary blip for ~15.5 s and then
 * reports instead of continuing into the 16 s, 32 s … 15-minute waits.
 */
export const DEFAULT_TRANSPORT_MAX_RETRIES = 5

/**
 * Ceiling for {@link DEFAULT_TRANSPORT_MAX_RETRIES}'s setting.
 *
 * Far above the default on purpose: raising the budget is a legitimate answer
 * to a genuinely flaky link, so this is a plausibility bound, not a
 * recommendation. The same number is mirrored in `Config`'s schema and the
 * settings page's field bound, and `tests/transport-retry.test.ts` pins the
 * schema against this constant.
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
 * Pure and exported on purpose: the choice of event is the part of this design
 * that is easy to get plausibly wrong (see the module comment), so it is stated
 * once, where a test can pin it.
 *
 * @param type - the appended session event's type.
 * @returns `'reset'` for a new step, `'forget'` when the turn ended (the
 *   session → agent mapping is no longer needed), otherwise `'none'`.
 */
export function transportResetAction(type: string): 'reset' | 'forget' | 'none' {
  if (type === 'step/start') return 'reset'
  if (type === 'turn/end') return 'forget'
  return 'none'
}

/**
 * The diagnosis a capped turn ends with. Bilingual, because the harness renders
 * a failed turn's message verbatim and this plugin's other user-facing failures
 * are too; it names the retry budget and the checks that actually help instead
 * of the bare "fetch failed" chain the retry chrome would otherwise show.
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
