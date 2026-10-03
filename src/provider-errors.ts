/** 连接拒绝与流内错误共享同一分类，避免错误恢复因响应载体不同而漂移。 */
import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmError, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import { RETRY_MAX_DELAY_MS } from './accounts.ts'
import { THROTTLED_CODE } from './transient-retry.ts'
import { booleanValue, isRecord, numberValue, stringValue } from './wire-guards.ts'

/** Keep the two user-facing languages and error metadata together. */
export function bilingual(code: string, en: string, zh: string, options?: LlmErrorOptions): LlmError {
  return new LlmError(`${en}；${zh}`, code, options)
}

/**
 * Terminal stream-error markers from the official CLI (`Xw` in command-code's
 * cli.mjs): these always mean "retrying cannot succeed", so the adapter must
 * not classify them as transient server errors.
 *
 * Written with spaces rather than the CLI's underscores, because
 * {@link hasTerminalStreamMarker} normalizes the separator before matching:
 * a JSON body usually carries `premium credits exhausted` while the CLI's own
 * list is written `premium_credits_exhausted`, and both are the same refusal
 * (the pre-stream classifier normalizes identically).
 */
const TERMINAL_STREAM_ERROR_MARKERS = [
  'premium credits exhausted',
  'model not in plan',
  'insufficient credits',
]

function hasTerminalStreamMarker(message: string): boolean {
  const normalized = message.toLowerCase().replaceAll('_', ' ')
  return TERMINAL_STREAM_ERROR_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Context-window wording the provider uses to reject a request that outgrew
 * the model's window. `isContextWindowExceededError` is the harness's own
 * provider-neutral classifier — and the contract `CONTEXT_WINDOW_EXCEEDED`
 * exists for — so it decides; the official CLI's `truncated` pattern adds the
 * phrasings Command Code's upstreams emit that the harness helper does not
 * cover (a bare `prompt is too long`, or a complaint about `max_tokens`).
 * The CLI matches these first and answers them by compacting and retrying —
 * never by resending the request unchanged.
 */
const CLI_CONTEXT_OVERFLOW_PATTERN = /prompt is too long|context.*(length|window)|max_tokens|maximum.*tokens/i

function isContextOverflowDetail(detail: string): boolean {
  return isContextWindowExceededError(detail) || CLI_CONTEXT_OVERFLOW_PATTERN.test(detail)
}

/**
 * A request-side `max_tokens` refusal, told apart from a context overflow that
 * mentions the same field. Kept narrow on purpose: the overflow pattern also
 * matches a bare `max_tokens`, so this must name the specific shapes the
 * endpoint uses — a ceiling comparison, its prose about output tokens, or a
 * request-validation error on the field.
 */
export const OUTPUT_LIMIT_REJECTION = new RegExp([
  'max_tokens:\\s*\\d+\\s*>\\s*\\d+',
  'maximum allowed number of output tokens',
  'invalid input[^\\n]*max_tokens',
  'expected number[^\\n]*at max_tokens',
].join('|'), 'i')

/**
 * The output ceiling the endpoint states in a `max_tokens` refusal, read off
 * its own comparison: `max_tokens: 131072 > 128000` yields 128000.
 *
 * Only the comparison form is parsed. The other shapes
 * {@link OUTPUT_LIMIT_REJECTION} matches — a bare validation error, or the
 * prose without the numbers — name no ceiling, and guessing one would be worse
 * than failing: a fabricated value is indistinguishable from a real one at the
 * point where it decides the next request's budget.
 */
export function parseOutputCeiling(detail: string): number | undefined {
  const stated = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(detail)?.[1]
  if (stated === undefined) return undefined
  const ceiling = Number(stated)
  return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : undefined
}

/**
 * Whether one rejection says "ZDR requested, no ZDR-capable upstream": the
 * provider spells the code `cmd_zdr_no_providers` in JSON error bodies and
 * `CMD_ZDR_NO_PROVIDERS` in plain-text ones (the official CLI's own
 * classifier checks both spellings, and its error text tells the user to
 * unset `CMD_ZDR`). Underscore-separated matching normalizes the separator, so
 * one comparison covers the variants — the same normalization the pre-stream
 * rejection classifier and `hasTerminalStreamMarker` already use.
 */
const ZDR_NO_PROVIDERS_PATTERN = /cmd[_\s-]?zdr[_\s-]?no[_\s-]?providers/i

function isZdrNoProviders(providerCode: string | undefined, providerDetail: string, errText: string): boolean {
  return ZDR_NO_PROVIDERS_PATTERN.test(providerCode ?? '')
    || ZDR_NO_PROVIDERS_PATTERN.test(providerDetail)
    || ZDR_NO_PROVIDERS_PATTERN.test(errText)
}

/**
 * Classify one in-band stream `error` payload into the failure the caller
 * throws. Shared by both transports — the CLI transport delivers it as an
 * `error` event, the Provider API transport as a top-level `error` member of
 * an SSE chunk — so the two cannot drift apart.
 *
 * The wording decides before the status does, mirroring the official CLI's
 * `classifyKind` (which reads the message first). Order is load-bearing:
 *
 * - A context-window rejection is terminal for THIS request but recoverable by
 *   the harness: `dsh-compaction-basic` listens on `agent/request-error` for
 *   `CONTEXT_WINDOW_EXCEEDED` and answers it with a compaction + retry of the
 *   reduced surface. Reported as retryable `SERVER` instead, the adapter resent
 *   the byte-identical oversized request up to `maxRetries` times and the
 *   session could never recover (issue #39).
 * - Credits/plan wording is terminal, so an exhausted balance or a model
 *   outside the plan is not retried as if it were a transient rate limit.
 * - Only then does the status/`isRetryable` pair decide.
 */
export function streamErrorToLlmError(value: unknown, fallbackMessage?: string): LlmError {
  const record = isRecord(value) ? value : undefined
  const message = record
    ? (stringValue(record.message) ?? JSON.stringify(record))
    : (stringValue(value) ?? fallbackMessage ?? 'Stream error')
  const statusCode = record === undefined
    ? undefined
    : (numberValue(record.statusCode) ?? numberValue(record.status))
  const isRetryable = record === undefined ? undefined : booleanValue(record.isRetryable)
  // Every available provider code/type/message goes to the classifiers: the
  // wording can live in any of them and both harness helpers document their
  // input as the joined detail.
  const detail = [stringValue(record?.code), stringValue(record?.type), message]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
  const statusOption = statusCode !== undefined ? { status: statusCode } : undefined

  if (OUTPUT_LIMIT_REJECTION.test(detail)) {
    // Checked BEFORE the overflow test, and that ordering is the whole point:
    // `isContextOverflowDetail` matches a bare `max_tokens`, so this refusal
    // used to be reported as an oversized session. The harness then compacted a
    // context that was within budget and resent the identical request, which the
    // endpoint refused identically (issue #71) — a turn that could not recover,
    // described to the user as one that could. A stream-side refusal has no
    // status to report, so the wording names the field only.
    const stated = /max_tokens:\s*\d+\s*>\s*\d+/i.exec(detail)?.[0]
    return bilingual(
      'PROVIDER_STREAM_ERROR',
      `Command Code refused the request's max_tokens for this model`
      + (stated !== undefined ? ` (${stated})` : '')
      + ' — the session is not oversized, so compacting it will not help;'
      + ' lower "Max output tokens" or pick a model with a larger output ceiling',
      `Command Code 拒绝了本次请求的 max_tokens（该模型的输出上限更低）`
      + (stated !== undefined ? `（${stated}）` : '')
      + '——会话内容并未超长，压缩上下文无效；请调低「最大输出 token」或改用输出上限更大的模型',
      statusOption,
    )
  }

  if (isContextOverflowDetail(detail)) {
    // Bilingual — the harness renders this message verbatim in its retry
    // chrome — and it names the recovery the harness is already performing.
    return bilingual(
      CONTEXT_WINDOW_EXCEEDED_CODE,
      `Command Code stream error: ${message}`,
      'Command Code API 拒绝了这次请求：内容超出模型上下文窗口。正在压缩上下文后重试；如仍失败，请新建会话或减少上下文',
      statusOption,
    )
  }
  const terminal = hasTerminalStreamMarker(detail)
  const retryableStatus = statusCode !== undefined && (statusCode === 429 || statusCode >= 500)
  // An explicit refusal and a terminal marker both outrank the STATUS, so a 5xx
  // that carries "insufficient credits" (or `isRetryable: false`) cannot be
  // answered with `SERVER` and unnecessarily retried by the route policy.
  // An explicit `isRetryable: true` still wins over everything.
  const retryable = isRetryable === true
    || (isRetryable === false || terminal
      ? false
      : (statusCode !== undefined ? retryableStatus : true))
  if (!retryable) {
    return new LlmError(
      `Command Code stream error: ${message}`,
      'PROVIDER_STREAM_ERROR',
      statusOption,
    )
  }
  const rejection = classifyAccountRejection(statusCode ?? 0, JSON.stringify(value) ?? message)
  if (rejection?.reason === 'rate-limit' || rejection?.reason === 'throttled') {
    const wait = rejection.resetAtMs === undefined ? 0 : Math.min(RETRY_MAX_DELAY_MS, Math.max(1000, rejection.resetAtMs - Date.now()))
    return bilingual(
      rejection.reason === 'rate-limit' ? 'RATE_LIMIT' : THROTTLED_CODE,
      `Command Code stream error: ${message}`,
      rejection.reason === 'rate-limit' ? 'Command Code 用量窗口已限流，等待恢复' : 'Command Code 请求暂时被限流，正在重试',
      { ...statusOption, ...(wait > 0 ? { providerRetryAfterMs: wait } : {}) },
    )
  }
  return new LlmError(
    `Command Code stream error: ${message}`,
    'SERVER',
    statusOption,
  )
}

/**
 * Why a pre-stream rejection rotates to another account. `rate-limit` (a usage
 * window the provider NAMED), `throttled` (a 429 that named no window) and
 * `invalid-credential` are the three the pool records as marks; `unavailable`
 * is an account-scoped rejection that must NOT become a mark — the account's
 * key is valid and its windows may be open, the ACCOUNT just cannot serve THIS
 * request — so the pool moves on without remembering anything.
 *
 * The window/throttle split decides what the pool may CLAIM, never whether it
 * rotates (issue #54); the evidence that separates them is in
 * {@link classifyAccountRejection}.
 */
export type AccountRotationReason = 'rate-limit' | 'throttled' | 'invalid-credential' | 'unavailable'

interface ParsedProviderError {
  root?: Record<string, unknown>
  nested?: Record<string, unknown> | undefined
  code?: string | undefined
  type?: string | undefined
  /** The sentence to SHOW: one nesting level peeled when the body double-encoded it. */
  message?: string | undefined
  /**
   * The message exactly as the body carried it. Pattern matching must read
   * this, not {@link message}: the double-encoded form embeds a whole second
   * document whose `type` (`provider_error`) is part of how a gateway
   * distinguishes an over-reserved request from an ordinary one, and peeling
   * it before the test drops that evidence.
   */
  rawMessage?: string | undefined
  rateLimit?: Record<string, unknown> | undefined
}

/**
 * Unwrap one level of a double-encoded provider message.
 *
 * The Messages endpoint sometimes reports a rejection with `error.message`
 * holding a whole JSON document rather than the sentence
 * (`{"type":"error","error":{"type":"invalid_request_error","message":"{\"type\":
 * \"error\",…}"},"request_id":"req_…"}`, measured 2026-09-29). Showing that blob
 * to the user hides the actual refusal, so one nesting level is peeled; the
 * outer text is returned unchanged when it is not JSON or carries no message.
 */
function unwrapProviderMessage(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw
  try {
    const inner: unknown = JSON.parse(trimmed)
    if (!isRecord(inner)) return raw
    const nested = isRecord(inner.error) ? inner.error : undefined
    return stringValue((nested ?? inner).message) ?? raw
  } catch {
    return raw
  }
}

/** Parse a rejected body once, retaining the nested/root distinction. */
export function parseProviderError(errText: string): ParsedProviderError {
  try {
    const parsed: unknown = JSON.parse(errText)
    if (!isRecord(parsed)) return { message: errText }
    const nested = isRecord(parsed.error) ? parsed.error : undefined
    const body = nested ?? parsed
    const rawMessage = stringValue(body.message)
    return {
      root: parsed,
      nested,
      code: stringValue(body.code),
      type: stringValue(body.type),
      rawMessage,
      // The body itself is the floor, never `undefined`: the Messages endpoint
      // answers some rejections with bare prose (`Invalid input: expected
      // number, received undefined at max_tokens`, `Too small: expected array to
      // have >=1 items at messages`), and dropping those lost the only sentence
      // the user could act on.
      message: unwrapProviderMessage(rawMessage) ?? errText,
      rateLimit: isRecord(body.rateLimit) ? body.rateLimit : undefined,
    }
  } catch {
    return { message: errText }
  }
}

/**
 * Map a pre-stream generate HTTP failure onto a stable LlmError. Command
 * Code folds several business rejections into 403 (plan limits, CLI version,
 * model access): prefer the machine-readable `error.code` when present; the
 * status alone cannot distinguish them. The status also decides the failure
 * CODE via {@link httpErrorCode}, which is what the retry policy routes on —
 * a transient 5xx must not be reported as a permanent provider rejection. A
 * 429's `Retry-After` header rides along as `providerRetryAfterMs` so
 * dsh-llm-retry can wait exactly that long instead of guessing at the backoff
 * cadence — capped at RETRY_MAX_DELAY_MS, because in normal mode a longer
 * attached wait makes the executor abandon the retry outright.
 *
 * One body is read, not just its status: a client-side rejection whose
 * `error.code`/`type`/`message` names the model context window is reported as
 * `CONTEXT_WINDOW_EXCEEDED`, because that failure has a recovery the harness
 * performs and a generic provider error does not. Every message built here is
 * bilingual — the harness renders it verbatim in its retry chrome.
 */
export function generateHttpError(
  status: number,
  errText: string,
  retryAfterMs?: number,
  parsed: ParsedProviderError = parseProviderError(errText),
): LlmError {
  // Historically this diagnosis reads only a nested `error` envelope; root
  // fields still feed account rotation and the Go-plan fallback below.
  const providerCode = parsed.nested === undefined ? undefined : parsed.code
  // The RAW message joins the detail: pattern tests below need every field the
  // body carried, including the parts `unwrapProviderMessage` peels off.
  const providerDetail = parsed.nested === undefined ? '' : [parsed.code, parsed.type, parsed.rawMessage ?? parsed.message]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
  const detail = providerCode ?? `HTTP ${status}`
  // A context-window rejection is not a generic provider failure: the request
  // is well-formed but larger than the model's window, and the harness knows
  // how to recover — dsh-compaction-basic answers CONTEXT_WINDOW_EXCEEDED on
  // `agent/request-error` with a compaction plus a retry of the reduced
  // surface. Reported as a plain provider rejection it failed the turn with no
  // way back but a manual /compact, and the same wording delivered in-band was
  // retried unchanged (issue #39). Checked before the 413 branch so an
  // over-context rejection that happens to carry that status gets the recovery
  // rather than the body-size advice. Only client-side rejections (`status <
  // 500`) are inspected, and the parsed provider fields are preferred over the
  // raw body, so an HTML error page cannot mention its way into a compaction.
  const overflowDetail = providerDetail !== '' ? providerDetail : errText.slice(0, 500)
  // A request-side OUTPUT cap is not a context overflow, but it reads like one:
  // the endpoint's own rejection is `max_tokens: 200000 > 128000, which is the
  // maximum allowed number of output tokens for <model>` (measured 2026-09-29),
  // and `max_tokens` is one of the overflow patterns. Letting it through would
  // compact a session that is not oversized — at full price, on a long context —
  // and the reduced request would be refused identically. Checked first.
  if (status < 500 && OUTPUT_LIMIT_REJECTION.test(overflowDetail)) {
    // Quote what the endpoint said: "200000 against a 128000 ceiling" and a bare
    // validation error are different problems, and naming neither leaves the
    // user guessing which setting to change.
    const stated = /max_tokens:\s*\d+\s*>\s*\d+/.exec(overflowDetail)?.[0]
      ?? (parsed.message !== undefined && parsed.message.length <= 200 ? parsed.message : undefined)
    return bilingual(
      'PROVIDER_HTTP_ERROR',
      `Command Code API error ${status}: this request's max_tokens is not valid for this model`
      + (stated ? ` (${stated})` : '')
      + ' — the session is not oversized, so compacting it will not help; lower "Max output tokens"'
      + ' or pick a model with a larger output ceiling',
      `Command Code API 返回 ${status}：本次请求的 max_tokens 对该模型不合法`
      + (stated ? `（${stated}）` : '')
      + '——会话内容并未超长，压缩上下文无效；请调低「最大输出 token」或改用输出上限更大的模型',
      { status },
    )
  }
  if (status < 500 && isContextOverflowDetail(overflowDetail)) {
    return bilingual(
      CONTEXT_WINDOW_EXCEEDED_CODE,
      `Command Code API error ${status}: the request exceeds the model's context window`
      + ' — this session is being compacted and the request retried',
      `Command Code API 返回 ${status}：请求内容超出模型上下文窗口——正在压缩上下文后重试；如仍失败，请新建会话或减少上下文`,
      { status },
    )
  }
  if (status === 422 && isZdrNoProviders(providerCode, providerDetail, errText)) {
    // Zero data retention refused (the `zdr` connection option is on): either
    // this model has no ZDR-capable upstream, or none had capacity at that
    // moment. The code is matched shape-insensitively because the provider
    // spells it both ways (`cmd_zdr_no_providers` in the JSON error body,
    // `CMD_ZDR_NO_PROVIDERS` in plain-text ones, exactly as the official CLI's
    // classifier reads it), and the CLI's own user guidance is to unset CMD_ZDR.
    return bilingual(
      'PROVIDER_HTTP_ERROR',
      `Command Code API error 422 (${detail}): zero data retention is enforced but no ZDR-capable`
      + ' upstream is available for this model — turn the ZDR setting off (or use another model)',
      'Command Code API 返回 422：已开启零数据保留（ZDR），但该模型当前没有可用的 ZDR 上游——'
      + '请关闭 ZDR 开关，或改用其他模型',
      { status: 422 },
    )
  }
  if (status === 401) {
    // An invalid or missing credential is a config problem, not a transport
    // failure: retrying it identically cannot succeed.
    return bilingual(
      'INVALID_CREDENTIAL',
      `Command Code API error 401 (${detail}): the API key is missing or invalid — check the`
      + ' key stored for COMMANDCODE_API_KEY (Models page) or the auth file',
      'Command Code API 返回 401：API 密钥缺失或无效——请在设置页检查 COMMANDCODE_API_KEY 存储的密钥，或检查 auth 文件',
      { status: 401 },
    )
  }
  if (status === 413) {
    // Request-body cap (issue #37). Command Code documents no 413 at all, so
    // without this branch the reader sees a bare "HTTP 413" and no way to tell
    // it apart from a generic provider failure. Reaching here means the
    // adapter already dropped this request's oldest images as far as its
    // budget ladder allows, or the body is large without images at all, so
    // the advice is the only remaining lever the user has.
    return bilingual(
      'PROVIDER_HTTP_ERROR',
      'Command Code API error 413: the request body exceeds the provider\'s size limit'
      + ' (the cap is undocumented, measured at about 50 MB) — the session history is too large'
      + ' to send, usually because of accumulated image attachments. Start a new session, or'
      + ' drop the image-heavy part of this one, and retry',
      'Command Code API 返回 413：请求体超过服务端的体积上限（官方未公开，实测约 50 MB）'
      + '——会话历史过大，通常是历史图片累积所致。请新建会话，或移除本会话中图片较多的部分后重试',
      { status: 413 },
    )
  }
  // 上游正文可能回显输入或返回整页英文错误；仅展示中文解释和有界错误码。
  // 分类仍使用上面的原始正文，不能因为收敛展示文案改变重试与压缩行为。
  const diagnosticCode = parsed.code ?? /^\s*(MODEL_NOT_IN_PLAN|INSUFFICIENT_CREDITS|USAGE_EXCEEDED|PREMIUM_CREDITS_EXHAUSTED)\b/i.exec(parsed.message ?? '')?.[1]
  const diagnostic = diagnosticCode !== undefined && /^[A-Za-z0-9_.:-]{1,80}$/.test(diagnosticCode)
    ? `（${diagnosticCode}）` : ''
  return new LlmError(
    `Command Code 请求失败（HTTP ${status}）${diagnostic}：`
      + (status === 429 ? '请求受到用量或速率限制，请稍后重试并检查账户额度。'
        : status === 408 ? '服务端处理超时，请稍后重试。'
          : status >= 500 ? '上游服务暂时无法完成请求，请稍后重试。'
          : '服务端拒绝了本次请求，请检查模型、套餐和请求设置。'),
    httpErrorCode(status),
    {
      status,
      ...(retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= RETRY_MAX_DELAY_MS
        ? { providerRetryAfterMs: retryAfterMs }
        : {}),
    },
  )
}

/**
 * Classify a pre-stream HTTP status into the failure code the route's retry
 * policy keys on. dsh-llm-retry matches `retryableCodes` only — never the
 * status, never the provider's `error.type` — so a status that arrives here as
 * a permanent code is never retried, whatever it says about itself.
 *
 * 5xx is the provider's own "temporarily unavailable" class (Cloudflare's
 * 520-527 included) and the only sane answer to it is the byte-identical
 * resend the retry policy exists to make; 408 is the same story for the
 * request itself. Everything else stays permanent: a 400/403/404/409/422
 * rejection repeats identically on every attempt.
 */
function httpErrorCode(status: number): string {
  if (status === 429) return THROTTLED_CODE
  if (status === 408) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_HTTP_ERROR'
}


/**
 * Parse an HTTP `Retry-After` value (delay-seconds or an HTTP-date) into
 * milliseconds; undefined when absent or unparseable. An HTTP-date in the
 * past yields 0, which the caller drops (LlmError wants a positive delay).
 * A delay-seconds value whose millisecond product is not finite (e.g. `1e308`)
 * also yields undefined: LlmError validates its options and would otherwise
 * replace the provider failure with an internal construction error.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = seconds * 1000
    return Number.isFinite(ms) ? Math.round(ms) : undefined
  }
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * Classify a pre-stream rejection that is about the ACCOUNT rather than about
 * the request, using the official CLI's own rules (command-code@1.56.0:
 * `parseWindowLimitError`, `isInsufficientCreditsRequestError`,
 * `parseSpendCapError` and the terminal-marker list
 * `["premium_credits_exhausted", "model_not_in_plan", "insufficient credits"]`).
 * Undefined means "not an account-scoped rejection": a malformed request, an
 * oversized body or a context overflow must fail fast instead of walking the
 * whole account pool.
 *
 * It must recognize the whole account-scoped class, not just 429/401: when it
 * did not, an account that could not pay, or could not run the model, stayed
 * "usable" in the pool and was handed out again on the next request (issue
 * #51's follow-up). The four reasons are defined on
 * {@link AccountRotationReason}; what this function owes them is the evidence
 * split:
 *
 *   - `rate-limit` / `throttled`: the code `RATE_LIMITED` is the authoritative
 *     signal — the CLI accepts the code OR a 429 status — and only a body that
 *     NAMES a window (`error.rateLimit.window`, see {@link readWindowLimitEvidence})
 *     may be called a spent one. A bare 429 is a burst/model/spend limiter the
 *     billing endpoint cannot see, so it stays `throttled` and the host claims
 *     no window (issue #54).
 *   - `unavailable`: no credits, or a model outside this account's plan, so it
 *     rotates but must NOT mark the key — the fact is about the model or the
 *     balance, and either can change without the key changing.
 */

/**
 * The provider's structured "this account cannot serve this request" codes.
 *
 * Status-independent on purpose, mirroring the CLI's classifier, which reads
 * the code before any status guard: a 5xx carrying one of these must rotate
 * past the account instead of being retried as a transient provider failure,
 * because the same request against the same account cannot succeed. Only the
 * prose scan below is confined to 4xx.
 */
const ACCOUNT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'USAGE_EXCEEDED',
  'INSUFFICIENT_CREDITS',
  'PREMIUM_CREDITS_EXHAUSTED',
  'MODEL_NOT_IN_PLAN',
])

export function classifyAccountRejection(
  status: number,
  errText: string,
  parsed: ParsedProviderError = parseProviderError(errText),
): { reason: AccountRotationReason; resetAtMs?: number } | undefined {
  const code = (parsed.code ?? parsed.type)?.toUpperCase()
  if (status === 429 || code === 'RATE_LIMITED') {
    const evidence = readWindowLimitEvidence(errText, parsed)
    // A plain throttle carries no reset: an `error.rateLimit.reset` without a
    // window label is the provider saying "come back later", not "this window
    // is spent", and a mark pinned to it would be a window claim the body never
    // made.
    if (evidence.window === undefined) return { reason: 'throttled' }
    return evidence.resetAtMs === undefined
      ? { reason: 'rate-limit' }
      : { reason: 'rate-limit', resetAtMs: evidence.resetAtMs }
  }
  if (status === 401) return { reason: 'invalid-credential' }
  // The structured account codes are checked BEFORE the status guard, exactly
  // like `RATE_LIMITED` above: a gateway that proxies the provider's own
  // credits/plan rejection under a 5xx is still reporting a fact about this
  // account, and treating it as "the provider is unavailable" is what turned a
  // permanent refusal into a retried one — `SERVER` enters the retry policy
  // while the sibling accounts that could serve are never
  // consulted. The guard below therefore covers only the rejections with NO
  // such code, whose evidence is prose.
  if (code !== undefined && ACCOUNT_UNAVAILABLE_CODES.has(code)) return { reason: 'unavailable' }
  if (status < 400 || status >= 500) return undefined
  // Underscored and spaced spellings are the same words: a JSON body carries
  // `insufficient_credits` / `model_not_in_plan`, while the CLI's own marker
  // list is written with spaces. Normalizing the separator keeps both wire
  // spellings classified, and the explicit code list above covers a body that
  // carries a code and no message at all.
  const lower = errText.toLowerCase().replaceAll('_', ' ')
  if (
    lower.includes('insufficient credits')
    || lower.includes('premium credits exhausted')
    || lower.includes('model not in plan')
    || /insufficient (credit|balance)/.test(lower)
    || /out of credit/.test(lower)
    || /not (available|included)[^.]{0,40}plan/.test(lower)
    || lower.includes('upgrade your plan')
  ) {
    return { reason: 'unavailable' }
  }
  return undefined
}

/**
 * How far ahead a provider-published reset may be and still be trusted.
 *
 * Generous on purpose: the weekly window is the longest this provider meters,
 * and the value is a plausibility bound rather than a policy. Beyond it the
 * reset is dropped rather than clamped, which leaves the account's mark
 * `unknown` — the state the pool's probe pass re-checks — instead of a
 * cooldown that never expires.
 */
export const MAX_TRUSTED_RESET_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The usage-window evidence carried by a rejected request, mirroring the CLI's
 * `parseWindowLimitError` → `resolveWindowLabel`/`extractResetAtMs` pair.
 *
 * `window` is present only when the body actually names one: a
 * `error.rateLimit.window` of `fiveHour`/`weekly`/`daily`, or the "usage limit
 * for your plan" wording (read as `weekly` when it says so, else `fiveHour`).
 * That is the CLI's own bar for calling a rejection a WINDOW limit, and it is
 * what keeps a bare 429 — a burst limiter, a model-level limit, a spend cap
 * `windowLimits` cannot show — from being reported as an exhausted window
 * (issue #54).
 *
 * `resetAtMs` is the reset the body publishes: `error.rateLimit.reset` is
 * SECONDS (`1e3 * reset`, like the CLI), and a `resets at <ISO>` stamp in the
 * message is honored as the fallback. Either can be present without the other;
 * the window label is what decides the classification.
 */
function readWindowLimitEvidence(
  errText: string,
  parsed: ParsedProviderError,
): { window?: 'fiveHour' | 'weekly' | 'daily'; resetAtMs?: number } {
  const named = stringValue(parsed.rateLimit?.window)
  const message = parsed.message ?? stringValue(parsed.root?.message) ?? ''
  const seconds = numberValue(parsed.rateLimit?.reset)
  const window = named === 'fiveHour' || named === 'weekly' || named === 'daily'
    ? named
    : /usage limit for your plan/i.test(message) || /usage limit for your plan/i.test(errText)
      ? (/weekly/i.test(message) ? 'weekly' : 'fiveHour')
      : undefined
  const stamp = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message)?.[1]
    ?? /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(errText)?.[1]
  const stamped = stamp === undefined ? undefined : Date.parse(stamp)
  const published = seconds !== undefined && seconds > 0
    ? Math.round(seconds * 1000)
    : stamped !== undefined && !Number.isNaN(stamped) ? stamped : undefined
  // A published reset is UNTRUSTED input, and two things break on a bogus
  // magnitude: `new Date(...).toISOString()` throws `RangeError: Invalid time
  // value` (replacing the intended RATE_LIMIT with an internal error), and a
  // mark pinned beyond the horizon becomes a `cooldown` no probe will ever
  // revisit — the account leaves rotation for the life of the process. A usage
  // window resets within days, so anything further out is not a reset this
  // route can act on: dropping it degrades the mark to `unknown`, which the
  // pool's probe pass re-checks.
  const resetAtMs = published !== undefined
    && Number.isFinite(published)
    && published - Date.now() <= MAX_TRUSTED_RESET_MS
    ? published
    : undefined
  return {
    ...(window === undefined ? {} : { window }),
    ...(resetAtMs === undefined ? {} : { resetAtMs }),
  }
}

/**
 * True when a pre-stream rejection is Command Code's Go-plan gate
 * (`upgrade_required`) — the only plan without Provider API access. Only this
 * class of rejection should fall back to the CLI `/alpha/generate` transport;
 * other 4xx/5xx must surface as ordinary errors so real account/model
 * problems are not masked.
 */
export function isUpgradeRequiredError(
  status: number,
  errText: string,
  parsed: ParsedProviderError = parseProviderError(errText),
): boolean {
  if (status !== 403) return false
  const lower = errText.toLowerCase()
  if (lower.includes('upgrade_required')) return true
  if (lower.includes('go plan') && lower.includes('api access')) return true
  if (lower.includes('only plan without api access')) return true
  if (lower.includes('upgrade to goat or higher')) return true
  if ((parsed.code ?? parsed.type)?.toLowerCase() === 'upgrade_required') return true
  if (parsed.message?.toLowerCase().includes('go plan') && parsed.message.toLowerCase().includes('api access')) return true
  return false
}
