/**
 * DeepSeek Harness LLM adapter for the Command Code Provider API.
 *
 * Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
 * community-maintained integration; you need your own Command Code account
 * and API key or subscription, and Command Code's terms apply.
 *
 * Owns the three chat transports (`/alpha/generate`, `/provider/v1/chat/completions`,
 * `/provider/v1/messages`),
 * message conversion, SSE/JSONL parsing, the catalog + its on-disk cache, and
 * the pre-stream account rotation loop. The wire protocol is
 * reverse-engineered (command-code@1.28.4, re-verified through 1.72.1);
 * docs/agent-reference/adapter-protocol.md holds the full protocol record.
 *
 * The adapter is deliberately free of cordis/schemastery: it receives a
 * per-request options thunk and an API-key resolver from the plugin entry
 * (src/index.ts), so a settings change reaches the very next request.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { IDENTITY_ENCODING_HEADER } from './response-encoding.ts'

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

import {
  assertUsableApiKey,
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  ToolCallId,
  errorChain,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  offloadedImageText,
  projectOffloadedImages,
  requiredImageOffload,
  resolveRetryPolicy,
  textOnlyImageText,
  type ImageBlock,
  type LlmErrorOptions,
  type LlmImageRequestBudget,
  type LlmImageRequestPrice,
  type LlmImageRequestPricing,
  type ResolvedRetryPolicy,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { RETRY_MAX_DELAY_MS } from './accounts.ts'
import { requestImageTarget } from './image-request.ts'
import { commandCodeImageTokens } from './image-tokens.ts'
import { allowanceTierForWeight } from './model-prices.ts'
import { boundTraceText, openStreamTrace, STREAM_TRACE_ENV } from './stream-trace.ts'
import { openRequestTiming, type RequestTiming, type RequestTimingSink } from './request-timing.ts'
import { THROTTLED_CODE } from './transient-retry.ts'
import { booleanValue, isRecord, numberValue, stringValue } from './wire-guards.ts'

import {
  DEFAULT_MESSAGES_MAX_TOKENS,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  MODEL_OUTPUT_TOKEN_LIMITS,
  capabilityDescription,
  compareByPlan,
  modelVisibleForAnyAccount,
  requiresMessagesEndpoint,
  subscriptionPlanInfo,
  type CommandCodeBillingAccess,
} from './capabilities.ts'

/**
 * Output ceilings the endpoint has named in a live rejection, per model.
 *
 * The snapshot in ./capabilities.ts carries the vendor-published ceiling for
 * 74 of the 84 catalog models (see scripts/sync-output-limits.mjs). The other
 * 10 are models no vendor publishes yet, and a gateway is free to sit below
 * the vendor figure even where one exists — so this map is the correction
 * channel, not a fallback of last resort: the endpoint states the model's own
 * ceiling in its rejection, so one wasted round trip is enough to know it for
 * the rest of the process.
 *
 * Shared by adapters for the same gateway, but not across apiBase values: a
 * proxy can enforce a smaller ceiling for the same model id. Only ever tightens
 * within that gateway, so a stale catalog row cannot undo a live refusal.
 */
const learnedOutputLimits = new Map<string, Map<string, number>>()

/**
 * Output ceilings the CATALOG published, per model.
 *
 * `/provider/v1/models` carries `max_output_tokens` in its schema and the
 * official pi provider already prefers it, but the endpoint does not send it
 * yet — so this is empty today and fills in on its own the day it does. It sits
 * above the models.dev snapshot and below what a live rejection proved, because
 * that ordering is also the order of trust: the gateway knows its own ceiling,
 * a rejection proves it, and models.dev is a third party describing the same
 * model. Restored from the on-disk catalog cache so a published ceiling
 * survives a restart without waiting for the next catalog fetch.
 */
const publishedOutputLimits = new Map<string, Map<string, number>>()

/** Keep model facts from one gateway from constraining another gateway. */
function outputLimitsFor(store: Map<string, Map<string, number>>, apiBase: string): Map<string, number> {
  let limits = store.get(apiBase)
  if (limits === undefined) {
    limits = new Map()
    store.set(apiBase, limits)
  }
  return limits
}

/**
 * The output ceiling this gateway route sends for `modelId`.
 *
 * `/provider/v1/models` publishes `context_length` and `supported_endpoints`
 * but no output cap today, while each endpoint refuses a larger `max_tokens` per
 * model — the Messages endpoint names its own in the rejection (`max_tokens:
 * 200000 > 128000, which is the maximum allowed number of output tokens for
 * claude-sonnet-5-5`). What the endpoint has already named wins, then the
 * catalog's own figure once it publishes one, then the snapshot, then — for
 * the Messages-route models only — the conservative value, because the ceilings
 * actually observed are below the global default and assuming otherwise would
 * fail every request.
 */
function modelOutputTokenLimit(apiBase: string, modelId: string): number {
  const learned = outputLimitsFor(learnedOutputLimits, apiBase).get(modelId)
  const known = outputLimitsFor(publishedOutputLimits, apiBase).get(modelId) ?? MODEL_OUTPUT_TOKEN_LIMITS.get(modelId)
  if (learned !== undefined && (known === undefined || learned < known)) return learned
  if (known !== undefined) return known
  return requiresMessagesEndpoint(modelId) ? DEFAULT_MESSAGES_MAX_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Record a ceiling the endpoint just stated, if it is one this route can act
 * on: a real number, and one below what the next request would otherwise send.
 * A ceiling at or above the current budget describes a request that was not
 * refused for being too large, and acting on it would be a guess.
 */
function noteOutputCeiling(apiBase: string, modelId: string, ceiling: number): boolean {
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) return false
  if (ceiling >= modelOutputTokenLimit(apiBase, modelId)) return false
  outputLimitsFor(learnedOutputLimits, apiBase).set(modelId, ceiling)
  return true
}

/**
 * The ceiling to retry this turn with, when `error` is a request-side output
 * refusal the route can act on — else undefined, meaning surface it.
 *
 * Read from the message, so it covers both shapes the same refusal arrives in:
 * an HTTP 400 (`PROVIDER_HTTP_ERROR`) and an in-stream error frame
 * (`PROVIDER_STREAM_ERROR`). Both carry the endpoint's wording, and both are
 * already classified as output refusals rather than context overflows by the
 * time they reach here.
 *
 * Recording is what makes the retry pay off: the ceiling is kept for this
 * gateway and model, so a refused turn leaves its next request correct.
 */
function outputCeilingRefusal(apiBase: string, modelId: string, error: unknown): number | undefined {
  if (!(error instanceof LlmError)) return undefined
  const detail = error.message
  if (!OUTPUT_LIMIT_REJECTION.test(detail)) return undefined
  const stated = parseOutputCeiling(detail)
  if (stated === undefined) return undefined
  return noteOutputCeiling(apiBase, modelId, stated) ? stated : undefined
}

/** Keep the two user-facing languages and error metadata together. */
function bilingual(code: string, en: string, zh: string, options?: LlmErrorOptions): LlmError {
  return new LlmError(`${en}；${zh}`, code, options)
}

// ---------------------------------------------------------------------------
// Request / connection defaults (protocol constants). The model/plan/deal
// capability snapshot lives in ./capabilities.ts — the sync-only surface.
// ---------------------------------------------------------------------------
export const COMMAND_CODE_CLI_VERSION = '1.72.1'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'

/**
 * The output budget this bundle asks for, and the ceiling it will never exceed.
 *
 * 131 072, chosen against a measured provider limit rather than a round guess.
 * Probing `/alpha/generate` directly on 2026-09-28: 64 000 → 200, 131 072 → 200,
 * 196 608 → 200, **200 000 → 200, 200 704 → 400**, 1 000 000 → 400. The server
 * therefore caps `max_tokens` at 200 000, and it does so identically for a
 * 262 144-window model (`stealth/pixel-canary`) and a 1 000 000-window one
 * (`stealth/space-bunny-alpha`) — the cap is global, not per model. 131 072
 * keeps a 35 % margin under it while covering the real output ceiling of the
 * models that have one (Claude 64 K, Gemini 64 K, several at 128 K).
 *
 * The old 64 000 was never a provider requirement: it cost nothing in latency
 * (a 64 000 request answered headers in 1.28 s against 1.57 s for 131 072) but
 * it did cap what a model could ever say in one turn.
 *
 * This is only an UPPER bound. `requestContextBudget` lowers it per request
 * from the prompt actually being sent, so raising the ceiling cannot push a
 * large session over its window.
 */
export const DEFAULT_GENERATE_MAX_TOKENS = 131_072

/**
 * The fallback when the catalog carries no output ceiling for a model.
 *
 * `/provider/v1/models` publishes only `context_length` — no output limit — so
 * the catalog cannot learn one per model and derives a stand-in from the
 * window instead. Kept equal to {@link DEFAULT_GENERATE_MAX_TOKENS} on purpose:
 * a lower value here would silently re-cap every request through
 * `Math.min(contextLength, this)` before the ceiling above is ever consulted.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 131_072
/** Preserve a small usable answer budget when the heuristic overshoots. */
const MIN_CONTEXT_OUTPUT_TOKENS = 1_024
export const MODELS_TIMEOUT_MS = 10_000
/** 目录短期复用；刷新失败只短暂退避，避免反复阻塞模型选择器。 */
export const MODEL_CATALOG_TTL_MS = 5 * 60_000
const MODEL_CATALOG_RETRY_MS = 10_000
/** How long the picker's plan-filter billing facts stay cached before refetching. */
export const BILLING_ACCESS_TTL_MS = 5 * 60_000
/**
 * How long a learned CLI-only protocol preference stays cached per account.
 * After this TTL a request may probe Provider API again, so an upgraded Go
 * account can recover without a restart.
 */
export const PROTOCOL_CACHE_TTL_MS = 15 * 60_000
/**
 * Endpoint protocol selected for one generate call.
 *
 * `messages` is the Anthropic Messages surface at
 * `{apiBase}/provider/v1/messages`, the only Provider API route the Claude
 * family answers (posted to `/chat/completions` they refuse with `400 Model
 * "<id>" must be called via /provider/v1/messages`). `openai` is the
 * documented Chat Completions surface; `cli` is Command Code's private
 * `/alpha/generate` transport, kept for Go-plan keys (the one plan without
 * Provider API access) and as the `upgrade_required` fallback.
 */
type CommandCodeProtocol = 'cli' | 'openai' | 'messages'

/** The entry-plan tier weight (`individual-go` in KNOWN_SUBSCRIPTION_PLANS). */
const GO_TIER_WEIGHT = 0

/** Hard cap on account rotations within one request (one attempt per distinct key). */
const MAX_ACCOUNT_ROTATIONS = 16

/**
 * Subscription statuses the CLI treats as live (`Mr` in command-code's
 * cli.mjs): the plan gate applies only under one of these.
 */
const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due'])
/**
 * Head-of-request timeout: how long to wait for the first response byte.
 *
 * 300 s, and that number is the official CLI's, not a round choice. Decompiled
 * from `command-code@1.66.0`: its `createNodeTransport` fetch passes only the
 * caller's `signal` and sets no timeout at all, so the model request inherits
 * Node/undici's own default — measured at 301.0 s against a local server that
 * accepts the connection and never sends headers. The previous 60 s default was
 * five times stricter than the CLI it emulates, and being stricter only ever
 * costs legitimate requests: a slow upstream first token on the Provider API
 * route can outlast 60 s, and the official CLI simply waits it out. Measured
 * headers (2026-09-28, 26 250-token prompt, `max_tokens: 16` to separate the
 * header from the generation): `/alpha/generate` 2.12 / 2.56 / 2.75 s,
 * `/provider/v1/chat/completions` 5.52 / 2.98 / 3.70 s — a ~1.1 s median gap
 * with the Provider API route varying over a 2.5 s span against the CLI route's
 * 0.6 s. A gateway that is genuinely dead now takes longer to name itself,
 * which is what the consecutive-timeout streak exists to bound (three
 * attempts, then a diagnosis instead of another re-send).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Version 3 binds cached catalog facts to their gateway; older files lack a safe source. */
const MODEL_CACHE_VERSION = 3

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A size-and-hash summary safe to put in an opt-in diagnostic trace. */
interface ValueFingerprint {
  bytes: number
  sha256: string
}

/**
 * A lone UTF-16 surrogate half: a high surrogate not followed by a low one, or
 * a low surrogate not preceded by a high one. Such a half is not a character —
 * it only arises from a truncated slice, a lossy decode, or a lone `\uD83D`
 * escape — and it survives `JSON.stringify` as an escape (`"\ud83d"`) rather
 * than failing locally, so the request leaves the process carrying a string no
 * UTF-8 consumer can round-trip. Providers running strict decoders reject it.
 *
 * This is the same expression `@earendil-works/pi-ai` applies to every outgoing
 * string on this endpoint. Valid astral characters (emoji and anything else
 * outside the BMP) are PAIRED surrogates and pass through untouched.
 */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * A cheap pre-test for "this string contains any surrogate code unit at all",
 * paired or not. The exact pattern above needs lookaround, which V8 cannot
 * optimize into a fast scan; this one is a plain range test. Real prompts are
 * overwhelmingly ASCII-plus-CJK with no surrogates, so the common case pays one
 * linear scan instead of the lookaround pass. Measured on a 412 KB request
 * body: 1.40 ms with the exact pattern alone against 0.77 ms with this gate,
 * where a bare `JSON.stringify` is 0.59 ms.
 */
const ANY_SURROGATE_PATTERN = /[\uD800-\uDFFF]/

/**
 * Drop lone surrogate halves from one outgoing string.
 *
 * Applied at the single point a request body is serialized, so every field of
 * every transport is covered — system text, message content, tool schemas and
 * tool results alike — instead of enumerating the fields that can carry text
 * and missing one. The value is returned unchanged whenever it holds no
 * surrogate at all, which is the ordinary case.
 *
 * The `test()` call deliberately uses the flagless {@link ANY_SURROGATE_PATTERN}:
 * a global regex is stateful, so testing with one would advance `lastIndex` and
 * make consecutive calls on the same string alternate between true and false.
 * `replace()` resets `lastIndex` itself, so the global pattern is safe there.
 */
function sanitizeSurrogates<T>(value: T): T {
  if (typeof value !== 'string') return value
  return ANY_SURROGATE_PATTERN.test(value)
    ? (value.replace(LONE_SURROGATE_PATTERN, '') as T)
    : value
}

/** Hash one request value without retaining or logging its contents. */
function fingerprintValue(value: unknown): ValueFingerprint {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    serialized = String(value)
  }
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: createHash('sha256').update(serialized).digest('hex'),
  }
}

/**
 * Structural request facts for issue #64's cache diagnosis.
 *
 * This deliberately records hashes and counts, never the prompt, tool
 * descriptions, image bytes, headers, or credentials. `body` catches changes
 * in any wire field; the named sections make a changed system/tools/messages
 * prefix visible without making the trace a copy of the conversation.
 */
function requestFingerprint(protocol: CommandCodeProtocol, body: Record<string, unknown>): Record<string, unknown> {
  const params = protocol === 'cli' ? recordOrEmpty(body.params) : body
  const messages = Array.isArray(params.messages) ? params.messages : []
  const tools = Array.isArray(params.tools) ? params.tools : []
  return {
    protocol,
    model: typeof params.model === 'string' ? params.model : undefined,
    threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
    body: fingerprintValue(body),
    config: fingerprintValue(body.config),
    system: fingerprintValue(protocol === 'cli' ? params.system : messages.filter((m) => isRecord(m) && m.role === 'system')),
    tools: {
      count: tools.length,
      ...fingerprintValue(tools),
    },
    messages: {
      count: messages.length,
      roles: messages.map((message) => isRecord(message) && typeof message.role === 'string' ? message.role : 'unknown'),
      ...fingerprintValue(messages),
      // Whole-history hashes change on every append. Per-message hashes let
      // adjacent requests identify the first changed byte-bearing message.
      items: messages.map((message) => fingerprintValue(message)),
    },
  }
}

/** Only provider correlation headers, never a wholesale response-header dump. */
const RESPONSE_ID_HEADERS = ['x-request-id', 'request-id', 'x-trace-id', 'x-generation-id', 'traceparent'] as const

function responseIdentifiers(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of RESPONSE_ID_HEADERS) {
    const value = diagnosticId(headers.get(name))
    if (value !== undefined) result[name] = value
  }
  return result
}

function diagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 ? value : undefined
}

/** Small, JSON-only response facts that DSH can retain on the assistant source. */
interface ResponseMetadata {
  protocol: CommandCodeProtocol
  headers: Record<string, string>
  responseId?: string
  generationId?: string
  providerRequestId?: string
  traceId?: string
}

function captureResponseIdentifiers(metadata: ResponseMetadata, event: unknown): void {
  if (!isRecord(event)) return
  // An OpenAI completion id or an AI SDK response-metadata id names the
  // response. A tool-call id does not, so never collect generic CLI event ids.
  if ((metadata.protocol === 'openai' && Array.isArray(event.choices)) || event.type === 'response-metadata') {
    const id = diagnosticId(event.id)
    if (id !== undefined) metadata.responseId = id
  }
  for (const name of ['generationId', 'providerRequestId', 'traceId'] as const) {
    const id = diagnosticId(event[name])
    if (id !== undefined) metadata[name] = id
  }
}

function hasResponseIdentifiers(metadata: ResponseMetadata): boolean {
  return Object.keys(metadata.headers).length > 0 || metadata.responseId !== undefined
    || metadata.generationId !== undefined || metadata.providerRequestId !== undefined || metadata.traceId !== undefined
}

/** Keep the provider's request id on DSH's durable failure, when it supplied one. */
function failureWithRequestId(error: unknown, metadata: ResponseMetadata): unknown {
  const id = metadata.providerRequestId ?? metadata.headers['x-request-id'] ?? metadata.headers['request-id']
  if (!(error instanceof LlmError) || error.failure.requestId !== undefined || id === undefined) return error
  return new LlmError(error.message, error.code, {
    ...error.failure,
    requestId: ProviderRequestId(id),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  })
}

/**
 * Thinking text carried by an OpenRouter-shaped `reasoning_details` array,
 * concatenated in the order the gateway sent it.
 *
 * Entries are read by their own text members rather than filtered on `type`:
 * DeepSeek sends `{ type: 'reasoning.text', text }` while the OpenAI family
 * sends `{ type: 'reasoning.summary', summary }` — the same summary text the
 * scalar `delta.reasoning` carries. A `type` filter would drop one family, and
 * losing thinking is the failure this exists to prevent. `text` wins per entry,
 * but an EMPTY `text` must not shadow a populated `summary` (the Responses wire
 * emits `text: ''` placeholders), so the fallback tests for non-empty rather
 * than merely present. Encrypted-blob entries carry neither member and
 * contribute nothing; no entry carries both, so nothing is counted twice.
 *
 * Returns undefined when the array yields nothing, so the caller's `??` chain
 * keeps falling through instead of treating "no text" as a reasoning delta.
 */
function reasoningDetailsText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  let text = ''
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const exact = stringValue(entry.text)
    const summary = stringValue(entry.summary)
    text += exact !== undefined && exact !== '' ? exact : (summary ?? '')
  }
  return text === '' ? undefined : text
}

/**
 * One SCALAR thinking delta, treating an empty string as "this chunk carries
 * none" — the same rule {@link reasoningDetailsText} applies inside the array.
 * The scalar and the array describe the same thinking, so an empty spelling of
 * one must not shadow populated text in the other (the Responses wire pads with
 * `text: ''`), and `??` alone cannot express that.
 */
function nonEmptyText(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** Parse a billing-period timestamp (ISO string or millis) into millis; 0 when absent/invalid. */
function periodEndValue(value: unknown): number {
  const asNumber = numberValue(value)
  if (asNumber !== undefined) return asNumber
  const asString = stringValue(value)
  if (asString === undefined) return 0
  const parsed = Date.parse(asString)
  return Number.isNaN(parsed) ? 0 : parsed
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

/** A gateway refusal observed for an over-reserved request, but not unique to that cause. */
const AMBIGUOUS_SIZE_REJECTION = /\bmodel could not complete the request\b/i

/**
 * A request-side `max_tokens` refusal, told apart from a context overflow that
 * mentions the same field. Kept narrow on purpose: the overflow pattern also
 * matches a bare `max_tokens`, so this must name the specific shapes the
 * endpoint uses — a ceiling comparison, its prose about output tokens, or a
 * request-validation error on the field.
 */
const OUTPUT_LIMIT_REJECTION = new RegExp([
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
function parseOutputCeiling(detail: string): number | undefined {
  const stated = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(detail)?.[1]
  if (stated === undefined) return undefined
  const ceiling = Number(stated)
  return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : undefined
}

/**
 * The advice floor for a Provider-API timeout: doubling a 60 s budget is still
 * short for a slow upstream first token, so the suggestion never goes below 5
 * minutes. Capped by `RETRY_MAX_DELAY_MS` rather than the schema's timer
 * ceiling on purpose — a single header wait that outlasts the whole retry
 * backoff is not a budget, and clamping to the engine constant would also pull
 * a runtime dependency into the bundle.
 */
const MIN_SUGGESTED_TIMEOUT_MS = 300_000

/**
 * Why one attempt saw no response headers, and what the user can do about it.
 *
 * The TRANSPORT is the reliable signal; the request size is not — and the
 * mechanism is read straight out of the official CLI rather than inferred from
 * a timing. `createNodeTransport` passes only the caller's `signal` and sets no
 * timeout, so the two routes differ in WHO answers the headers:
 * `/alpha/generate` has the gateway answer them before the model starts, while
 * `/provider/v1/chat/completions` cannot answer until its upstream emits a
 * first token, so whatever that upstream is doing is charged to the header
 * wait. Measured 2026-09-28 (26 250-token prompt, `max_tokens: 16`):
 * `/alpha/generate` 2.12 / 2.56 / 2.75 s, `/provider/v1/chat/completions`
 * 5.52 / 2.98 / 3.70 s — a ~1.1 s median gap, with the Provider API route
 * swinging across 2.5 s where the CLI route moved 0.6 s. A larger prompt moves
 * neither, which is why an earlier draft that branched on a 1 MiB body
 * threshold was wrong: size is not the variable here. Only the route decides.
 *
 * @param protocol - the transport the attempt used.
 * @param timeoutMs - the header budget that just expired.
 */
export function headersTimeoutAdvice(
  protocol: CommandCodeProtocol,
  timeoutMs: number,
): { cause: 'gateway' | 'upstream-first-token'; suggestionMs?: number } {
  if (protocol === 'openai') {
    return {
      cause: 'upstream-first-token',
      // That route charges the upstream's time-to-first-token to this wait, so
      // a larger budget is the one thing that can help when it expires.
      suggestionMs: Math.min(RETRY_MAX_DELAY_MS, Math.max(timeoutMs * 2, MIN_SUGGESTED_TIMEOUT_MS)),
    }
  }
  return { cause: 'gateway' }
}

/**
 * How many consecutive header timeouts on ONE unchanged payload stop being a
 * blip. The retry policy whitelists `TIMEOUT` with `maxRetries: 1000` and a
 * 500 ms → 15 min backoff, which is right for a provider that says when to
 * come back but wrong for a gateway that simply never answers: the reporter
 * saw the identical multi-megabyte body re-sent for hours (issue #67) instead
 * of a diagnosis. Three is where a 60 s budget has already spent three
 * minutes waiting, so the cost of being wrong is bounded and the user gets an
 * answer either way.
 */
const MAX_CONSECUTIVE_HEADER_TIMEOUTS = 3

/** Streak key for a session-less call, so those keep the old single-slot semantics instead of never escalating. */
const GLOBAL_HEADER_TIMEOUT_KEY = '\u0000global'

/** UTF-8 byte length, computed only on the timeout path so a large body is encoded once, not per attempt. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The thrown headers timeout, worded for the cause it actually has.
 *
 * Every earlier version of this message said "通常是网络或代理问题" for both
 * transports, which is actively wrong for a large `/provider/v1/chat/completions`
 * prompt: there the model simply needs longer than any budget, and a user sent
 * to check their proxy never finds anything. The code stays `TIMEOUT` (still
 * retryable) in both branches — only the diagnosis and the advice change.
 */
function headersTimeoutError(input: {
  protocol: CommandCodeProtocol
  endpoint: string
  body: string
  timeoutMs: number
  cause: unknown
}): LlmError {
  const { protocol, endpoint, timeoutMs, cause } = input
  const bytes = utf8ByteLength(input.body)
  const megabytes = `${(bytes / 1_048_576).toFixed(1)} MB`
  const advice = headersTimeoutAdvice(protocol, timeoutMs)
  if (advice.cause === 'upstream-first-token') {
    const suggestion = advice.suggestionMs ?? timeoutMs
    return bilingual(
      'TIMEOUT',
      `Command Code API request to ${endpoint} did not respond within ${timeoutMs}ms: this route withholds response headers until the upstream model emits its first token, and it did not start within the budget. Raise "Request timeout" in the plugin's advanced settings to ${suggestion}ms, or compact the session or start a new one. The request body was ${megabytes}, but size is not the cause here — a slow upstream is. ${errorChain(cause)}`,
      `Command Code API 请求在 ${timeoutMs} 毫秒内未收到响应：该路由要等上游模型吐出第一个 token 才返回响应头，而上游在预算内没有开始作答。可在插件「高级」设置里把「请求超时」调到 ${suggestion} 毫秒，或压缩上下文 / 新开会话。本次请求体约 ${megabytes}，但体积不是原因——慢的是上游。（${errorChain(cause)}）`,
      { cause },
    )
  }
  return bilingual(
    'TIMEOUT',
    `Command Code API request to ${endpoint} did not respond within ${timeoutMs}ms: the gateway returned no response headers at all — it answers headers itself before the model replies. This is usually provider queueing, a Go-plan capacity limit, or a network/proxy path problem; a longer timeout will not help, but retrying usually recovers. The request body was ${megabytes}, and size is not the cause on this route. ${errorChain(cause)}`,
    `Command Code API 请求在 ${timeoutMs} 毫秒内未收到响应：网关完全没有返回响应头——它会在模型开始回答前先返回响应头。这通常是服务商排队、Go 套餐容量限制，或网络/代理链路问题；调大超时不会有帮助，重试通常可恢复。本次请求体约 ${megabytes}，而在该路由上体积不是原因。（${errorChain(cause)}）`,
    { cause },
  )
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
function streamErrorToLlmError(value: unknown, fallbackMessage?: string): LlmError {
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

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Tool-schema normalization (issue #35). The gateway validates every function
// schema's ROOT as an object schema and rejects the whole request otherwise.
// Tool schemas do not always come from the harness's own typed builder: a
// third-party plugin or an MCP bridge can register a hand-written schema, and
// a generator can emit a root `$ref`. Neither is this plugin's to correct, but
// the request is the plugin's to send, so every schema leaving here is
// normalized to the object root the provider requires.
// ---------------------------------------------------------------------------

/** How deep a root `$ref` / combinator chain is followed while normalizing. */
const SCHEMA_NORMALIZE_MAX_DEPTH = 4

/**
 * Whether a type-less node is object-shaped enough to be one with the type
 * declared: `properties`/`required`/`additionalProperties` only make sense on
 * an object, and a schema carrying them was meant to be one.
 */
function isObjectShaped(node: Record<string, unknown>): boolean {
  return (
    isRecord(node.properties) ||
    isRecord(node.patternProperties) ||
    Array.isArray(node.required) ||
    node.additionalProperties !== undefined
  )
}

/** The `required` names of one schema node, ignoring malformed entries. */
function requiredNames(node: Record<string, unknown>): string[] {
  return Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === 'string') : []
}

/** Resolve a local `#/...` pointer inside the schema that carried it. */
function resolveLocalRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(node)) return undefined
    node = node[segment]
  }
  return isRecord(node) ? node : undefined
}

/**
 * Flatten a type-less combinator node into one object schema, so the model
 * still sees the branch fields instead of an argument-free tool. `allOf`
 * branches must all hold, so their `required` entries are all kept; `anyOf` /
 * `oneOf` branches are alternatives, so only a name required by every branch
 * survives. Returns undefined when no branch describes an object.
 */
function mergeCombinatorBranches(
  node: Record<string, unknown>,
  depth: number,
): Record<string, unknown> | undefined {
  // A plugin can hand over a self-referential schema object; the bound keeps
  // the walk finite (JSON-parsed schemas are acyclic, JS ones need not be).
  if (depth >= SCHEMA_NORMALIZE_MAX_DEPTH) return undefined
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  const alternatives: string[][] = []
  let sawBranch = false

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    const objectBranches: Record<string, unknown>[] = []
    for (const branch of branches) {
      if (!isRecord(branch)) continue
      objectBranches.push(toolParametersSchema(branch, depth + 1))
    }
    if (objectBranches.length === 0) continue
    sawBranch = true
    // An `anyOf`/`oneOf` group contributes the intersection of its branches;
    // an `allOf` group contributes the union.
    const names = objectBranches.map(requiredNames)
    if (key === 'allOf') for (const name of names.flat()) required.add(name)
    else if (names.length > 0) {
      alternatives.push(names[0]!.filter((name) => names.every((list) => list.includes(name))))
    }
    for (const branch of objectBranches) {
      const branchProperties = isRecord(branch.properties) ? branch.properties : {}
      for (const [name, schema] of Object.entries(branchProperties)) {
        if (!(name in properties)) properties[name] = schema
      }
    }
  }
  if (!sawBranch) return undefined
  // A name must satisfy every group, so each group's intersection joins the
  // union: an allOf-required field and an anyOf-common field are both required.
  for (const group of alternatives) for (const name of group) required.add(name)

  const merged: Record<string, unknown> = { type: 'object', properties }
  if (required.size > 0) merged.required = [...required]
  // The merged schema is a superset of the alternatives it replaced, so it
  // stays open unless the node itself closed it.
  if (node.additionalProperties !== undefined) merged.additionalProperties = node.additionalProperties
  for (const key of ['description', 'title'] as const) {
    if (node[key] !== undefined) merged[key] = node[key]
  }
  return merged
}

/**
 * Normalize one tool's parameters schema to an object-rooted JSON Schema.
 * A schema that already declares an object root is passed through untouched;
 * a type-less object-shaped one gains the type; a root `$ref` or combinator is
 * resolved/merged; anything else (an array/scalar root, or no schema at all)
 * degrades to a permissive free-form object, because a request the provider
 * refuses helps no one and the tool's own description is still in the prompt.
 * Only the root is touched and every path returns a copy: the harness may
 * deep-freeze the caller's schema.
 */
function toolParametersSchema(parameters: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(parameters)) return { type: 'object', properties: {}, additionalProperties: true }
  if (parameters.type === 'object') return parameters
  // `["object", "null"]` is accepted by JSON Schema but not by the provider's
  // validator, which compares the root `type` against the string "object".
  if (Array.isArray(parameters.type) && parameters.type.includes('object')) {
    return { ...parameters, type: 'object' }
  }

  if (parameters.type === undefined || parameters.type === null) {
    if (typeof parameters.$ref === 'string' && depth < SCHEMA_NORMALIZE_MAX_DEPTH) {
      const target = resolveLocalRef(parameters, parameters.$ref)
      if (target !== undefined) {
        const { $ref: _ref, ...rest } = parameters
        return toolParametersSchema({ ...target, ...rest }, depth + 1)
      }
    }
    if (isObjectShaped(parameters)) return { ...parameters, type: 'object' }
    const merged = mergeCombinatorBranches(parameters, depth)
    if (merged !== undefined) return merged
    // A root `$ref` this plugin cannot resolve still gets the declared type:
    // that is what the provider validates for, and an object is what every
    // schema generator emits one for.
    if (typeof parameters.$ref === 'string') return { ...parameters, type: 'object' }
  }

  return { type: 'object', properties: {}, additionalProperties: true }
}

export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    // Trim leading/trailing separators. This must stay linear: the classic
    // `/^-+|-+$/` form is ambiguous — on `a<200k dashes>b` the unanchored
    // `-+$` retries every start position, giving O(n^2) matching (CodeQL
    // js/polynomial-redos). The negative lookbehind `(?<!-)` restricts `-+$`
    // to the first dash of the trailing run, so only one start position is
    // tried. Verified empirically: ~14.5s -> ~0ms on a 200k-dash input.
    .replace(/^-+|(?<!-)-+$/g, '')
  return slug || 'project'
}

function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Credential fallback from the official Command Code CLI auth file, the last
// fallback in the plugin entry's resolution order. Only the official CLI's own
// file is read — pi/OMP auth files are intentionally NOT scanned, so their
// credentials and formats cannot surprise this adapter.
// ---------------------------------------------------------------------------

/** Extract the key from the CLI's nested credential records (`command-code`). */
function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === 'api') return stringValue(value.key)
  if (type === 'oauth') return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/** Read a usable Command Code credential from the official CLI auth file. */
export function resolveAuthFileApiKey(): string | undefined {
  const authPath = join(homedir(), '.commandcode', 'auth.json')
  try {
    if (!existsSync(authPath)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (!isRecord(parsed)) return undefined
    const direct = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode)
    if (direct) return direct
    const nested =
      apiKeyFromCredentialRecord(parsed.commandcode) ??
      apiKeyFromCredentialRecord(parsed['command-code'])
    return nested
  } catch {
    // Ignore malformed or unreadable auth file.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Model catalog discovery with on-disk cache fallback
// ---------------------------------------------------------------------------

interface CommandCodeModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * The output ceiling the catalog PUBLISHED for this model, as distinct from
   * the one {@link maxTokens} was resolved to. The gateway has this field in
   * its schema and the official pi provider already reads it, but it does not
   * send it yet — the endpoint currently stops after `supported_endpoints`
   * (see the pi provider's `CommandCodeModelListItem`). Carried separately so
   * that a value cached before this field existed cannot outlive it: the
   * snapshot in ./capabilities.ts and the runtime's learned limits are both
   * re-derivable, while a published number is the one thing only the gateway
   * can say.
   */
  publishedMaxTokens?: number
  /**
   * The catalog's own per-model route list, e.g. `['/chat/completions',
   * '/responses']` or `['/messages']`. New as of command-code@1.55.0 and the
   * authoritative routing source: a model listed only under `/messages`
   * answers `400 Model "<id>" must be called via /provider/v1/messages` on
   * every other route. Absent from older cache files, in which case
   * `resolveProtocol()` falls back to {@link requiresMessagesEndpoint}.
   */
  supportedEndpoints: readonly string[]
}

function parseCatalogResponse(value: unknown, apiBase: string): CommandCodeModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new LlmError('Unexpected Command Code models response shape', 'PROVIDER_PROTOCOL_ERROR')
  }
  // A refreshed catalog may remove a previously published field; do not let
  // its older value silently outlive the response from this same gateway.
  publishedOutputLimits.set(apiBase, new Map())
  const models: CommandCodeModel[] = []
  for (const entry of value.data) {
    if (!isRecord(entry)) continue
    const id = stringValue(entry.id)
    const name = stringValue(entry.name)
    const contextLength = numberValue(entry.context_length)
    if (!id || !name || !contextLength || contextLength <= 0) continue
    const endpoints = Array.isArray(entry.supported_endpoints)
      ? entry.supported_endpoints.filter((item): item is string => typeof item === 'string')
      : []
    // The gateway's own ceiling, when it publishes one. Today it sends nothing
    // after `supported_endpoints`, so this is normally absent and the snapshot
    // answers instead; recording it here is what lets the published figure take
    // over the moment it appears, with no change here.
    const published = numberValue(entry.max_output_tokens)
    if (published !== undefined && published > 0) outputLimitsFor(publishedOutputLimits, apiBase).set(id, published)
    models.push({
      id,
      name,
      contextWindow: contextLength,
      // The catalog publishes no output ceiling yet, but each endpoint refuses a
      // larger `max_tokens` per model (the Messages endpoint names its own in
      // the rejection), so the ceiling comes from the capability snapshot.
      maxTokens: Math.min(contextLength, modelOutputTokenLimit(apiBase, id)),
      ...(published !== undefined && published > 0 ? { publishedMaxTokens: published } : {}),
      supportedEndpoints: endpoints,
    })
  }
  if (models.length === 0) {
    throw new LlmError('Command Code returned an empty model catalog', 'PROVIDER_PROTOCOL_ERROR')
  }
  return models
}

async function readModelsCache(cachePath: string, apiBase: string): Promise<CommandCodeModel[]> {
  const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf-8'))
  // Earlier cache files did not identify their gateway. Even the default path
  // may have been written by a custom apiBase, so an unscoped file is unsafe.
  if (!isRecord(parsed) || parsed.version !== MODEL_CACHE_VERSION
    || parsed.apiBase !== apiBase || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid model cache at ${cachePath}`)
  }
  publishedOutputLimits.set(apiBase, new Map())
  // Normalize rather than trust the file: a hand-edited or fixture cache may
  // omit `supported_endpoints`, and an absent list must degrade to the
  // `claude-*` prefix rule instead of routing Claude to the wrong transport.
  return parsed.models.map((entry) => {
    const model = isRecord(entry) ? entry : {}
    const endpoints = Array.isArray(model.supportedEndpoints)
      ? model.supportedEndpoints.filter((item): item is string => typeof item === 'string')
      : []
    // A published ceiling is the gateway's own, so it is restored — but
    // `maxTokens` is NOT taken from the file. It is a DERIVED value: the
    // snapshot, the fallback and the gateway's published figure can all move
    // between two runs, and a cache written before any of them moved would
    // otherwise pin the old answer for as long as the file survives. The
    // catalog cache exists to spare a network fetch, not to freeze a
    // conclusion (issue #71).
    const id = stringValue(model.id)
    const published = numberValue(model.publishedMaxTokens)
    if (id !== undefined && published !== undefined && published > 0) {
      outputLimitsFor(publishedOutputLimits, apiBase).set(id, published)
    }
    const contextWindow = numberValue(model.contextWindow)
    return {
      ...model,
      supportedEndpoints: endpoints,
      maxTokens: id === undefined || contextWindow === undefined
        ? numberValue(model.maxTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS
        : Math.min(contextWindow, modelOutputTokenLimit(apiBase, id)),
    } as unknown as CommandCodeModel
  })
}

async function writeModelsCache(
  cachePath: string,
  apiBase: string,
  models: CommandCodeModel[],
  mayCommit: () => boolean,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  // Separate refreshes can overlap while settings change; one refresh must
  // never rename or delete another refresh's temporary file.
  const tmp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: MODEL_CACHE_VERSION, apiBase, models }, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    if (mayCommit()) await rename(tmp, cachePath)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Message conversion: harness RequestMessage[] -> Command Code wire messages.
// Both transports replay historical reasoning — as a `reasoning` block on
// `/alpha/generate` (the official CLI's `toWireMessages` shape) and as
// `reasoning_content` on `/provider/v1/chat/completions` — because DeepSeek's
// thinking-mode contract requires the previous chain of thought to be passed
// back whenever tool calls are in play (issue #34). Only tool calls with a
// paired tool result are replayed on both transports.
// ---------------------------------------------------------------------------

/** The tool result one `role: 'tool'` message answers. */
interface ToolResultView {
  readonly toolCallId: string
  readonly isError?: boolean
  readonly content: readonly ContentBlock[]
}

/**
 * The tool result one message answers, or undefined when it answers none.
 *
 * The harness models a tool result as its own `role: 'tool'` message carrying
 * `toolCallId`/`isError` beside raw content blocks (`MessageRoleMap.tool` is
 * the only role a tool result can arrive on). Pairing and emission MUST agree
 * on this same view, or a dropped result either drops its call too (making the
 * model forget completed work) or leaves an unanswered call on the wire.
 */
function toolResultOf(message: RequestMessage): ToolResultView | undefined {
  if (message.role !== 'tool') return undefined
  const { toolCallId, content } = message
  if (typeof toolCallId !== 'string' || toolCallId === '') return undefined
  return { toolCallId, isError: message.isError ?? false, content }
}

/**
 * Collect the tool calls that have a paired tool result, plus each call's
 * name. The name map feeds the `toolName` of replayed tool results: some
 * backends (e.g. Google Gemini `functionResponse`) reject a result whose
 * function name is empty, so the real name must round-trip (the official
 * CLI does the same via its `tool_use_id -> toolName` map).
 */
function pairedToolCalls(messages: readonly RequestMessage[]): {
  ids: Set<string>
  names: Map<string, string>
} {
  const callIds = new Set<string>()
  const names = new Map<string, string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    const result = toolResultOf(message)
    if (result) resultIds.add(result.toolCallId)
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call') {
        callIds.add(block.id)
        names.set(block.id, block.name)
      }
    }
  }
  return { ids: new Set([...callIds].filter((id) => resultIds.has(id))), names }
}

/**
 * The Command Code gateway rejects tool call ids longer than 64 characters
 * (`input[N].call_id` must be `<= 64`, issue #23). Cross-provider histories
 * can carry longer ids — e.g. switching to Command Code mid-session after
 * another provider issued the call — so overlong paired ids are remapped to
 * short per-request aliases. Correlation only needs to hold within one
 * request (each call travels with its result in the same body), so a
 * sequential alias is enough: no durable state, and the harness log keeps the
 * original ids.
 */
const MAX_WIRE_TOOL_CALL_ID_LENGTH = 64

/**
 * Map each paired tool-call id to its wire id: ids within the gateway limit
 * pass through verbatim, overlong ids get a collision-free `cc-<n>` alias.
 * Callers must resolve BOTH the tool-call and its paired tool-result through
 * the returned map so the pair stays correlated.
 */
function wireToolCallIds(paired: ReadonlySet<string>): Map<string, string> {
  const wire = new Map<string, string>()
  const taken = new Set<string>()
  for (const id of paired) {
    if (id.length <= MAX_WIRE_TOOL_CALL_ID_LENGTH) {
      wire.set(id, id)
      taken.add(id)
    }
  }
  let seq = 1
  for (const id of paired) {
    if (wire.has(id)) continue
    let alias = `cc-${seq++}`
    while (taken.has(alias)) alias = `cc-${seq++}`
    wire.set(id, alias)
    taken.add(alias)
  }
  return wire
}

function blockText(block: ContentBlock): string {
  return block.type === 'text' || block.type === 'reasoning' ? block.text : ''
}

/**
 * One paired tool result as the wire needs it: its text and the images the
 * tool returned. Neither wire transport can carry an image inside a tool
 * result (`/provider/v1/chat/completions` forbids non-text `role: 'tool'`
 * content, and the CLI transport's own `tool-result` output is text-only), so
 * those images travel in a user message emitted right after the tool message —
 * the same shape `@deepseek-ai/dsh-llm-deepseek` uses (issue #30).
 */
interface ToolResultMedia {
  /** Visible result text; `''` when the result carried images but no text. */
  text: string
  /** Nested image references, in block order, deduplicated by attachment id. */
  images: ImageAttachmentRef[]
}

/**
 * Collect text and nested images of one tool result. The harness `read_image`
 * tool returns both, so dropping the image half is what made a tool-read image
 * invisible to a Vision model (issue #30); deduplication keeps a result that
 * repeats one attachment from paying for the same pixels twice.
 */
function toolResultMedia(block: ToolResultView): ToolResultMedia {
  const chunks: string[] = []
  const images: ImageAttachmentRef[] = []
  const seen = new Set<string>()
  for (const nested of block.content) {
    if (nested.type === 'text' || nested.type === 'reasoning') {
      if (nested.text) chunks.push(nested.text)
      continue
    }
    if (nested.type === 'image' && !seen.has(nested.attachment.attachmentId)) {
      seen.add(nested.attachment.attachmentId)
      images.push(nested.attachment)
    }
  }
  return { text: chunks.join('\n'), images }
}

/**
 * Result text for the wire's `role: 'tool'` message. A tool that returned only
 * an image (and possibly a nested image-only tool result) has no text at all,
 * and neither transport accepts an empty tool content string, so it gets a
 * descriptor pointing at the user message that follows with the pixels.
 */
function toolResultTextForWire(media: ToolResultMedia): string {
  return media.text || (media.images.length > 0 ? '(image returned; see the attached image)' : '')
}

/** Leading line of the user message that carries a tool result's images. */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result'

/**
 * The model-visible note introducing the images carried out of one tool
 * result. Neither transport merges them back into the tool result, so this
 * line is what tells the model the image it is about to see belongs to the
 * tool it just ran rather than to the user; it also leads the part list,
 * because an image-first content array is what some gateways reject.
 *
 * The note names the tool call the image came out of: a turn's carriers are
 * emitted as a group after the whole tool group (issue #33), so position
 * cannot carry the association — and every `read_image` result renders the
 * same envelope text, so two parallel calls would produce two identical
 * notes. The id is the WIRE id, the one the model saw on the `tool-call` and
 * on the tool message just above, so an overlong cross-provider id is named
 * by the alias that replaced it. Count and pixel dimensions are appended
 * when the tool's own text does not already state them.
 */
function toolResultImageNote(media: ToolResultMedia, toolCallId: string): string {
  const lead = `${TOOL_RESULT_IMAGE_TEXT} (${toolCallId}):`
  const first = media.images[0]
  if (first === undefined) return lead
  const dimensions = `${first.width}x${first.height} px`
  if (first.width <= 0 || first.height <= 0 || media.text.includes(dimensions)) {
    return lead
  }
  const count = media.images.length > 1 ? `${media.images.length} images, ` : ''
  return `${lead} ${count}${dimensions}`
}

function hasImageContent(message: RequestMessage): boolean {
  return message.content.some((block) => block.type === 'image')
}

// ---------------------------------------------------------------------------
// Request image budget (issue #37)
//
// Both transports inline EVERY historical image as base64, so a long session
// — a vision self-check loop reading back dozens of screenshots — keeps
// growing the body until it crosses the gateway's request cap (measured at
// ~50.17 MB, undocumented). From that point on every request on this route
// fails with HTTP 413 for the rest of the session, because history is never
// reclaimed, even though the same conversation works on another provider.
//
// The offload set is a DURABLE surface fact, not a local edit: the adapter
// renders the surface's `offloaded` marks with `projectOffloadedImages`, and a
// history that still exceeds the budget does NOT evict — it fails with
// `IMAGE_OFFLOAD_REQUIRED` + `offloadImages`, which the default
// `dsh-compaction-image-offload` plugin turns into one `image/offload` session
// event and a retry. Every later request on the session then carries the same
// placeholder text, across restore and fork. The budget is accounted in the
// encoded form, because it is the base64 the wire actually carries that has to
// fit.
// ---------------------------------------------------------------------------

/**
 * Primary image budget for one request body. 32 MiB of base64 images leaves a
 * wide margin under the measured ~50 MB cap for text, tool schemas, and JSON
 * overhead, and the 16 MiB byte quantum means one eviction frees a real block
 * of the budget instead of one image per request.
 */
const REQUEST_IMAGE_MAX_BASE64_BYTES = 32 * 1024 * 1024
/** Primary image-count budget; a long screenshot loop stays well under it. */
const REQUEST_IMAGE_MAX_COUNT = 60
/** Byte step one eviction removes; keeps the removed prefix stable per request. */
const REQUEST_IMAGE_BYTE_QUANTUM = 16 * 1024 * 1024
/** Count step one eviction removes, so the prefix does not creep per request. */
const REQUEST_IMAGE_COUNT_QUANTUM = 30

/**
 * The retry rung, used only after the gateway actually answered 413. The cap
 * covers text and tool bytes too, so it cannot be budgeted exactly from here;
 * this rung is aggressive on purpose — the alternative to a smaller request is
 * a session that cannot continue at all.
 */
const REQUEST_IMAGE_RETRY_MAX_BASE64_BYTES = 8 * 1024 * 1024
const REQUEST_IMAGE_RETRY_MAX_COUNT = 12
const REQUEST_IMAGE_RETRY_BYTE_QUANTUM = 8 * 1024 * 1024
const REQUEST_IMAGE_RETRY_COUNT_QUANTUM = 12

/** One rung of the image budget ladder: what a request may keep, and in what steps. */
interface RequestImageBudget {
  maxBytes: number
  maxImages: number
  byteQuantum: number
  countQuantum: number
}

/** The budget ladder: the primary rung first, the 413 eviction rung second. */
const REQUEST_IMAGE_BUDGETS: readonly RequestImageBudget[] = [
  {
    maxBytes: REQUEST_IMAGE_MAX_BASE64_BYTES,
    maxImages: REQUEST_IMAGE_MAX_COUNT,
    byteQuantum: REQUEST_IMAGE_BYTE_QUANTUM,
    countQuantum: REQUEST_IMAGE_COUNT_QUANTUM,
  },
  {
    maxBytes: REQUEST_IMAGE_RETRY_MAX_BASE64_BYTES,
    maxImages: REQUEST_IMAGE_RETRY_MAX_COUNT,
    byteQuantum: REQUEST_IMAGE_RETRY_BYTE_QUANTUM,
    countQuantum: REQUEST_IMAGE_RETRY_COUNT_QUANTUM,
  },
]

/** One occurrence's exact request-version byte length, as the core counter wants it. */
type ImageVersionBytes = (block: { attachment: ImageAttachmentRef }) => number

/**
 * The engine's durable-offload contract, as one object.
 *
 * Both members are required together: a half-populated policy would either lose
 * the surface's marks (re-sending evicted images as pixels) or lose the count
 * (silently sending an over-budget body), and neither is worth a partial
 * opt-in. The defaults are the engine's own helpers; the object exists so tests
 * can substitute a counting stub.
 */
export interface SurfaceImagePolicy {
  /** Render the surface's durable offload marks as placeholder text. */
  projectOffloadedImages: typeof projectOffloadedImages
  /** How many more leading retained occurrences must be offloaded. */
  requiredImageOffload: typeof requiredImageOffload
}

/** The engine's own helpers: what a process that injects nothing speaks. */
const ENGINE_IMAGE_POLICY: SurfaceImagePolicy = { projectOffloadedImages, requiredImageOffload }

/**
 * The failure a route raises instead of evicting on its own. The count is the
 * ONE thing the harness needs: `dsh-compaction-image-offload` records it as an
 * `image/offload` event, marks that many oldest retained occurrences, and
 * retries the step.
 *
 * Deliberately outside `providerRetryPolicy()`'s whitelist: a byte-identical
 * resend cannot succeed, so the retry belongs to the surface mutation, not to
 * dsh-llm-retry. On a profile that does not mount that plugin the failure is
 * terminal — every shipped profile reaches it through dsh-base.
 */
function imageOffloadRequired(missing: number, reason: 'budget' | 'cache' = 'budget'): LlmError {
  const options: LlmErrorOptions & { offloadImages: number } = { offloadImages: missing }
  return new LlmError(
    reason === 'cache'
      ? `commandcode cache-aware image history: ${missing} already-seen oldest image occurrence(s) must be offloaded before replay.`
      : `commandcode request images exceed the route budget; ${missing} more oldest occurrence(s) must be offloaded.`,
    IMAGE_OFFLOAD_REQUIRED_CODE,
    options,
  )
}

/** The budget members the core counter reads, plus the wire representation. */
type CoreImageBudget = Pick<
  LlmImageRequestBudget,
  'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'
>

/** The budget in the shape the core counter takes (representation + the rung). */
function coreBudget(budget: RequestImageBudget): CoreImageBudget {
  return { representation: 'base64', ...budget }
}

/**
 * Exact request-version bytes of one retained occurrence. The declared
 * normalized size IS what this adapter inlines (the body is built from
 * `attachments.readImage`, base64-encoded), so the accounting matches the wire
 * byte for byte, and the core helper expands it for `base64` on its own.
 */
const imageVersionBytes: ImageVersionBytes = (block) => block.attachment.bytes

/**
 * Request options under one budget rung: the surface's durable marks become
 * placeholder text, and an over-budget history FAILS with the count to offload
 * instead of being evicted here. Throws rather than returning, so no caller can
 * accidentally send a body this route already knows is too large.
 *
 * The next rung is applied to the CURRENT projection, never to the raw history —
 * otherwise the 413 retry could reintroduce images the first rung had already
 * evicted.
 */
function withSurfaceOffload(
  options: GenerateOptions,
  policy: SurfaceImagePolicy,
  budget: RequestImageBudget,
  cacheOffloadModel?: string,
): GenerateOptions {
  const marked = policy.projectOffloadedImages(options.messages, (ref) => offloadedImageText(ref))
  const messages = marked === options.messages ? options.messages : [...marked]
  const budgetMissing = policy.requiredImageOffload(messages, coreBudget(budget), imageVersionBytes)
  const cacheMissing = cacheOffloadModel === undefined ? 0 : seenImageOffloadCount(messages, cacheOffloadModel)
  const missing = Math.max(budgetMissing, cacheMissing)
  if (missing > 0) throw imageOffloadRequired(missing, cacheMissing > budgetMissing ? 'cache' : 'budget')
  return messages === options.messages ? options : { ...options, messages }
}

/**
 * Count retained images already followed by an answer from this same model.
 * The current tool result's image has not yet been seen by the model and must
 * stay on the wire. The engine can only offload durable user/tool input nodes;
 * assistant output and request-only input have no selectable surface event.
 */
function seenImageOffloadCount(messages: readonly RequestMessage[], model: string): number {
  let lastAnswer = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'assistant'
      && message.source.kind === 'model'
      && message.source.provider === 'commandcode'
      && message.source.model === model) lastAnswer = index
  }
  if (lastAnswer < 0) return 0
  let count = 0
  for (let index = 0; index < lastAnswer; index++) {
    const message = messages[index]!
    if ((message.role !== 'user' && message.role !== 'tool') || message.id === undefined) continue
    for (const block of message.content) {
      if (block.type === 'image') count++
    }
  }
  return count
}

/**
 * One image's bytes for the wire: the attachment service's REQUEST VERSION.
 *
 * `readImage()` answers the stored original, which is what admission accepted —
 * not what a provider request should carry. `readImageRequest()` re-encodes to
 * the route target in `./image-request.ts` and caches the result under it, so
 * the same attachment costs one encode per target instead of one per occurrence,
 * and the base64 the wire expands is bounded (both the pixel budget and, more to
 * the point here, the encoded bytes).
 */
async function readRequestImage(
  attachments: AttachmentStore,
  ref: ImageAttachmentRef,
): Promise<RequestImageAttachment> {
  return attachments.readImageRequest(ref, requestImageTarget(ref))
}

type ReadRequestImage = ((ref: ImageAttachmentRef) => Promise<RequestImageAttachment>) & {
  prepare?: (refs: readonly ImageAttachmentRef[]) => Promise<void>
}

/** 同一次生成及其协议切换共享图片读取，最多同时准备四张，避免内存峰值失控。 */
function requestImages(attachments: AttachmentStore, signal: AbortSignal | undefined, timing: RequestTiming): ReadRequestImage {
  const cache = new Map<string, Promise<RequestImageAttachment>>()
  const read: ReadRequestImage = (ref) => {
    signal?.throwIfAborted()
    const key = JSON.stringify([ref.attachmentId, requestImageTarget(ref)])
    let pending = cache.get(key)
    if (!pending) {
      pending = readRequestImage(attachments, ref)
      cache.set(key, pending)
    }
    return pending
  }
  read.prepare = async (refs) => {
    if (refs.length === 0) return
    const finishImages = timing.phase('images')
    let cursor = 0
    try {
      const workers = Array.from({ length: Math.min(4, refs.length) }, async () => {
        while (cursor < refs.length) {
          signal?.throwIfAborted()
          await read(refs[cursor++]!)
        }
      })
      // 等所有已开始的读取结束再抛错，避免失败请求留下未处理拒绝或后台工作。
      const results = await Promise.allSettled(workers)
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally { finishImages() }
  }
  return read
}

/**
 * Price one request occurrence.
 *
 * Two cases cost no vision tokens at all, and both are priced as their
 * model-visible TEXT so the caller's estimator can charge that instead (which
 * is what stops the meter counting an evicted image as context): a model that
 * accepts text only (the harness projects those images to placeholder text
 * before the request), and an occurrence the session surface has already
 * offloaded (the same placeholder text rides in every later request). A retained
 * occurrence on this route contributes no text at all — the pixels are inlined —
 * so its price is the family's visual-token count and nothing else.
 */
function priceRequestImage(
  block: ImageBlock,
  model: string,
  imageCapable: boolean,
): LlmImageRequestPrice {
  const ref = block.attachment
  if (!imageCapable) return { visualTokens: 0, text: textOnlyImageText(ref) }
  if (block.offloaded === true) return { visualTokens: 0, text: offloadedImageText(ref) }
  const target = requestImageTarget(ref)
  return { visualTokens: commandCodeImageTokens(model, target.width, target.height), text: '' }
}

/**
 * Convert one image reference to the final `/alpha/generate` wire format.
 * The official CLI accepts a base64 source internally, then toWireMessages()
 * sends a data URL plus mimeType. Use the request version's media type because
 * readImageRequest() can transcode the stored image to JPEG or WebP.
 */
async function imageToCommandCode(
  ref: ImageAttachmentRef,
  readImage: ReadRequestImage,
): Promise<{ type: 'image'; image: string; mimeType: string }> {
  const version = await readImage(ref)
  return {
    type: 'image',
    image: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
    mimeType: version.mediaType,
  }
}

interface MessageCodec {
  encodeImage: (ref: ImageAttachmentRef, readImage: ReadRequestImage) => Promise<unknown>
  encodeUser: (parts: unknown[]) => unknown
  encodeAssistant: (
    message: Extract<RequestMessage, { role: 'assistant' }>,
    paired: ReadonlySet<string>,
    wireIds: ReadonlyMap<string, string>,
  ) => unknown | undefined
  encodeTool: (
    result: ToolResultView,
    media: ToolResultMedia,
    wireId: string,
    toolName: string,
    readImage: ReadRequestImage | undefined,
  ) => unknown | Promise<unknown>
  /**
   * True when the transport can carry images inside a tool result, so
   * `convertMessages` must not split them into a following user message.
   * Only the Messages surface can: its `tool_result.content` accepts image
   * blocks, while the CLI's `tool-result.output` is text-only and Chat
   * Completions forbids non-text `role: 'tool'` content (issue #30).
   */
  carriesToolResultMedia: boolean
}

/**
 * One emitted block's replay metadata, stored in the terminal chunk's
 * `replayState.blocks` and handed back on the next request through the
 * assistant message's `source.replayState`.
 *
 * The Messages endpoint rejects a replayed `thinking` block without its
 * `signature` (`thinking.signature: Field required`), and a thinking block
 * with empty text is accepted, so the signature is the part that must
 * survive the round trip.
 */
interface MessagesReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  signature?: string
}

/**
 * The signature recorded for the reasoning block at `position` of a
 * historical assistant message, or undefined when the message was produced
 * by another route or an older plugin version.
 */
function messagesSignatureAt(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  position: number,
): string | undefined {
  const replay = message.source?.replayState
  if (!isRecord(replay) || !Array.isArray(replay.blocks)) return undefined
  const entry = replay.blocks[position]
  return isRecord(entry) ? stringValue(entry.signature) : undefined
}

/**
 * The common pairing and image-carrier ordering for both transports. Each
 * codec owns its wire shape: CLI content blocks and Chat Completions
 * reasoning/tool calls differ beyond the image envelope.
 */
async function convertMessages(
  messages: readonly RequestMessage[],
  readImage: ReadRequestImage | undefined,
  codec: MessageCodec,
): Promise<unknown[]> {
  const out: unknown[] = []
  const { ids: paired, names: toolNames } = pairedToolCalls(messages)
  if (readImage?.prepare) {
    const refs: ImageAttachmentRef[] = []
    // 只预读投影后实际发送的图片；孤立工具结果和已卸载图片不触碰附件服务。
    for (const message of messages) {
      const result = toolResultOf(message)
      if (message.role === 'user' && !result) {
        for (const block of message.content) if (block.type === 'image') refs.push(block.attachment)
      } else if (result && paired.has(result.toolCallId)) refs.push(...toolResultMedia(result).images)
    }
    await readImage.prepare(refs)
  }
  const wireIds = wireToolCallIds(paired)
  // Consecutive tool results must precede user image carriers, including when
  // an assistant turn has several parallel calls.
  const pendingImages: unknown[] = []
  const flushPendingImages = () => {
    for (const message of pendingImages) out.push(message)
    pendingImages.length = 0
  }
  const encodeImage = (ref: ImageAttachmentRef): Promise<unknown> => {
    if (!readImage) {
      throw new LlmError('Image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    return codec.encodeImage(ref, readImage)
  }

  for (const message of messages) {
    if (message.role === 'system') continue // folded into params.system by the caller

    const result = toolResultOf(message)
    if (message.role === 'user' && !result) {
      flushPendingImages()
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        if (block.type === 'image') parts.push(await encodeImage(block.attachment))
      }
      if (parts.length > 0) out.push(codec.encodeUser(parts))
      continue
    }

    if (message.role === 'assistant') {
      flushPendingImages()
      const assistant = codec.encodeAssistant(message, paired, wireIds)
      if (assistant !== undefined) out.push(assistant)
      continue
    }

    if (!result || !paired.has(result.toolCallId)) continue
    const media = toolResultMedia(result)
    const wireId = wireIds.get(result.toolCallId) ?? result.toolCallId
    out.push(await codec.encodeTool(result, media, wireId, toolNames.get(result.toolCallId) || 'unknown', readImage))
    if (!codec.carriesToolResultMedia && media.images.length > 0) {
      const carried: unknown[] = [{ type: 'text', text: toolResultImageNote(media, wireId) }]
      for (const attachment of media.images) carried.push(await encodeImage(attachment))
      pendingImages.push(codec.encodeUser(carried))
    }
  }
  flushPendingImages()
  return out
}

const ccMessageCodec: MessageCodec = {
  carriesToolResultMedia: false,
  encodeImage: imageToCommandCode,
  encodeUser: (parts) => ({ role: 'user', content: parts }),
  encodeAssistant: (message, paired, wireIds) => {
    const parts: unknown[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'reasoning') parts.push({ type: 'reasoning', text: block.text })
      else if (block.type === 'tool-call' && paired.has(block.id)) {
        parts.push({
          type: 'tool-call',
          toolCallId: wireIds.get(block.id) ?? block.id,
          toolName: block.name,
          input: recordOrEmpty(block.arguments),
        })
      }
    }
    return parts.length > 0 ? { role: 'assistant', content: parts } : undefined
  },
  encodeTool: (result, media, wireId, toolName) => ({
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: wireId,
      toolName,
      output: result.isError
        ? { type: 'error-text', value: toolResultTextForWire(media) }
        : { type: 'text', value: toolResultTextForWire(media) },
    }],
  }),
}

async function messagesToCC(
  messages: readonly RequestMessage[],
  readImage?: ReadRequestImage,
): Promise<unknown[]> {
  return convertMessages(messages, readImage, ccMessageCodec)
}

/**
 * Convert one image reference to the OpenAI Chat Completions wire format:
 * `{ type: 'image_url', image_url: { url: 'data:...;base64,...' } }`.
 */
async function imageToOpenAI(
  ref: ImageAttachmentRef,
  readImage: ReadRequestImage,
): Promise<{ type: 'image_url'; image_url: { url: string } }> {
  const version = await readImage(ref)
  return {
    type: 'image_url',
    image_url: {
      url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
    },
  }
}

/**
 * Convert harness messages to the OpenAI Chat Completions request shape.
 *
 * Unlike the Command Code CLI transport, this transport is the documented
 * Provider API surface. DeepSeek's thinking-mode contract requires historical
 * `reasoning_content` to be passed back whenever tools are in play, so this
 * converter intentionally DOES replay reasoning blocks as `reasoning_content`
 * on assistant messages. Only tool calls with a paired tool result are
 * replayed (same policy as the CLI path).
 */
const openAiMessageCodec: MessageCodec = {
  carriesToolResultMedia: false,
  encodeImage: imageToOpenAI,
  encodeUser: (parts) => {
    const hasImage = parts.some((part) => (part as { type?: string }).type === 'image_url')
    return !hasImage && parts.length === 1
      ? { role: 'user', content: (parts[0] as { text: string }).text }
      : { role: 'user', content: parts }
  },
  encodeAssistant: (message, paired, wireIds) => {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const reasoning = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
      .map((block) => block.text)
      .join('')
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call' && paired.has(block.id))
      .map((block) => ({
        id: wireIds.get(block.id) ?? block.id,
        type: 'function' as const,
        function: { name: block.name, arguments: block.arguments },
      }))
    if (text === '' && reasoning === '' && toolCalls.length === 0) return undefined
    const assistant: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text }
    if (reasoning !== '') assistant.reasoning_content = reasoning
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls
    return assistant
  },
  encodeTool: (_result, media, wireId) => ({
    role: 'tool',
    tool_call_id: wireId,
    content: toolResultTextForWire(media),
  }),
}

async function messagesToOpenAI(
  messages: readonly RequestMessage[],
  readImage?: ReadRequestImage,
): Promise<unknown[]> {
  return convertMessages(messages, readImage, openAiMessageCodec)
}

// ---------------------------------------------------------------------------
// Anthropic Messages transport (`/provider/v1/messages`)
// ---------------------------------------------------------------------------

/**
 * Convert one image reference to the Messages wire shape. Unlike the other two
 * transports this one keeps the native media type rather than a data URL, and
 * it may be used INSIDE a tool result — `tool_result.content` accepts image
 * blocks, which is why this codec sets `carriesToolResultMedia`.
 */
async function imageToMessages(
  ref: ImageAttachmentRef,
  readImage: ReadRequestImage,
): Promise<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> {
  const version = await readImage(ref)
  return {
    type: 'image',
    source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') },
  }
}

/** A tool call's `arguments` is a raw JSON string in the harness, an object here. */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Convert harness messages to the Anthropic Messages request shape.
 *
 * Differences from the other two transports, all measured against the live
 * endpoint on 2026-09-29:
 *
 * - Content is always a block array; there is no string shorthand, so a
 *   single-text user turn is still `{ role: 'user', content: [{type:'text'…}] }`.
 * - Tool results live in a `user` turn as `tool_result` blocks (not a
 *   `role: 'tool'` message) and may carry images natively, so no image is
 *   split into a separate user message here.
 * - A replayed `thinking` block is only valid WITH its `signature`: the
 *   endpoint answers `thinking.signature: Field required` without it, and
 *   `each thinking block must contain thinking` when the text is empty and
 *   the signature is blank. A reasoning block with no recorded signature is
 *   therefore dropped rather than sent — replaying it would fail the request,
 *   while omitting it is accepted (verified 200 both ways).
 * - The conversation must end with a user turn; the endpoint refuses an
 *   assistant prefill (`This model does not support assistant message
 *   prefill`), which `convertMessages` already guarantees for a tool loop.
 */
const messagesMessageCodec: MessageCodec = {
  carriesToolResultMedia: true,
  encodeImage: imageToMessages,
  encodeUser: (parts) => ({ role: 'user', content: parts }),
  encodeAssistant: (message, paired, wireIds) => {
    const parts: unknown[] = []
    let position = 0
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
        position++
        continue
      }
      if (block.type === 'reasoning') {
        const signature = messagesSignatureAt(message, position)
        if (signature !== undefined) {
          parts.push({ type: 'thinking', thinking: block.text, signature })
        }
        position++
        continue
      }
      if (block.type === 'tool-call' && paired.has(block.id)) {
        parts.push({
          type: 'tool_use',
          id: wireIds.get(block.id) ?? block.id,
          name: block.name,
          input: parseToolArguments(block.arguments),
        })
        position++
      }
    }
    return parts.length > 0 ? { role: 'assistant', content: parts } : undefined
  },
  encodeTool: async (result, media, wireId, _toolName, readImage) => {
    const content: unknown[] = []
    // Only this transport can carry the bytes here, so the resolver must exist
    // whenever the session holds a tool-result image; `convertMessages` has
    // already refused a request that carries one without it.
    if (readImage) {
      for (const attachment of media.images) content.push(await imageToMessages(attachment, readImage))
    }
    content.push({ type: 'text', text: toolResultTextForWire(media) })
    const toolResult: Record<string, unknown> = { type: 'tool_result', tool_use_id: wireId, content }
    if (result.isError) toolResult.is_error = true
    return { role: 'user', content: [toolResult] }
  },
}

async function messagesToMessages(
  messages: readonly RequestMessage[],
  readImage?: ReadRequestImage,
): Promise<unknown[]> {
  return convertMessages(messages, readImage, messagesMessageCodec)
}

/** Connection facts resolved fresh per request by the plugin entry. */
export interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/chat/completions`, `/provider/v1/models`). */
  apiBase: string
  /** Working directory reported to the API (project slug, config block). */
  workingDir: string
  /** Model catalog cache path. */
  modelsCachePath: string
  /**
   * Milliseconds to wait for generate response headers / first byte (default
   * 300s, the official CLI's own budget — see
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}).
   * Must not bound the subsequent body stream — long generations are gated by
   * {@link streamIdleTimeoutMs} and the caller AbortSignal instead.
   */
  requestTimeoutMs: number
  /** Milliseconds a stream may stall before it is treated as a dead connection (default 300s). */
  streamIdleTimeoutMs: number
  /**
   * Opt-in CLI cache mitigation: after this same model has answered with an
   * image in its history, ask dsh's durable image-offload surface to replace
   * that image before the next replay. This protects the growing text prefix
   * when Command Code's multimodal cache retreats to the first image, but the
   * model cannot inspect the old pixels again without a fresh tool/user image.
   */
  offloadSeenImagesForCache?: boolean
  /**
   * Whether the picker hides models above the account's subscription tier
   * (default true). The filter fails open: unknown plan, billing-endpoint
   * failure, a positive on-demand credit balance, or an unmapped model all
   * keep the full catalog visible. Set false to always list every model.
   */
  filterModelsByPlan?: boolean
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything"; applies after the subscription-tier filter.
   * The settings page persists it; the catalog endpoint serves the full
   * catalog regardless so the page can always offer every model.
   */
  visibleModels?: string[] | undefined
  /**
   * Per-model visibility overrides, keyed by catalog id. Written by the
   * terminal settings page, whose checkbox list gives every model its own
   * boolean field: a field writes one value at one path, so membership in
   * {@link visibleModels} cannot be expressed from there, while a flag can.
   * An id present here decides that model on its own (true = listed, false =
   * hidden); an id absent here follows {@link visibleModels} exactly as it did
   * before, so composition configs and the web page are unaffected.
   */
  modelVisibility?: Readonly<Record<string, boolean>> | undefined
  /**
   * Optional protocol hint. `'auto'` (default) uses billing/cache plus
   * Provider API fallback; `'cli'` forces `/alpha/generate`; `'openai'`
   * prefers `/provider/v1/chat/completions` but still falls back to the CLI
   * transport on `upgrade_required` (Go-plan keys have no Provider API
   * access — failing outright would strand them). This is a
   * connection-level test/operator seam and is intentionally not part of
   * the plugin's user settings schema.
   */
  protocol?: 'auto' | CommandCodeProtocol
  /**
   * Whether requests enforce zero data retention by sending the
   * `x-cmd-zdr: 1` header (the same opt-in the official CLI exposes as
   * `CMD_ZDR=1`). Default false. Every chat request carries the header when
   * enabled. The provider refuses a model without a ZDR-capable upstream with
   * 422 `cmd_zdr_no_providers`; never retry that request without the header.
   */
  zdr?: boolean
}

/**
 * Resolve the durable attachment service, or undefined when the host does not
 * provide one. Called lazily only when a request actually carries images, so a
 * text-only request never depends on the attachment seam.
 */
export type ResolveAttachments = () => AttachmentStore | undefined

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

/** What the rotation hook knows about the request it is rotating within. */
export interface AccountRotationContext {
  /** Every API key this request has already used, just-rejected key included. */
  tried: readonly string[]
  /** The provider's own reset time for a `rate-limit` rejection, in millis. */
  resetAtMs?: number
}

/** Everything the adapter needs beyond the request itself. */
export interface CommandCodeAdapterDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** 可选的数值耗时接收器；不接收提示词、凭据或错误正文。 */
  onRequestTiming?: RequestTimingSink
  /** Resolve the current connection facts (fresh per request, settings-aware). */
  options: () => C
  /**
   * Resolve a usable API key for the given connection facts and the request's
   * model id, or throw `MISSING_CREDENTIAL`. The model is optional: hosts
   * without model-aware routing ignore it.
   */
  resolveApiKey: (connection: C, model?: string) => Promise<string>
  /**
   * Multi-account rotation hook: the request sent with `rejectedKey` was
   * refused before any response body streamed, for an account-scoped reason
   * (see {@link AccountRotationReason}). The host marks that key when the
   * reason warrants it and returns the next account's key to retry with, or
   * `undefined` to surface the failure. Only pre-stream rejections rotate — a
   * mid-stream failure never replays a partially consumed generation against
   * another account.
   *
   * `rotation.tried` lists every key this request has already used (the
   * just-rejected one included). The host must not offer one of them again:
   * with several accounts a rejection that does not mark the key (a plan or
   * balance rejection is model-specific, not account-fatal) would otherwise
   * re-offer the same account on every attempt and the pool could never reach
   * the accounts behind it. `rotation.resetAtMs` carries the provider's own
   * reset time when the rejection body published one, so the host can hold the
   * key out until then instead of waiting for a billing probe to learn the
   * same fact.
   */
  rotateApiKey?: (
    rejectedKey: string,
    rejection: AccountRotationReason,
    connection: C,
    model?: string,
    rotation?: AccountRotationContext,
  ) => Promise<string | undefined>
  /**
   * Every API key the host can serve from, in rotation order and deduplicated
   * — the multi-account pool's own list. The picker's plan filter asks all of
   * them, because the pool (not any single account) is what serves a request;
   * a host without a pool omits this seam and the filter falls back to the key
   * that would serve the current request.
   */
  resolveAccountKeys?: () => Promise<readonly string[]>
  /** HTTP transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Resolve the optional durable attachment service for image input (tests); defaults to none. */
  resolveAttachments?: ResolveAttachments
  /**
   * Request-image policy override (tests); defaults to the engine's own
   * `projectOffloadedImages`/`requiredImageOffload`. Injecting a stub is how a
   * test observes the budget rungs a 413 walks.
   */
  imageOffload?: SurfaceImagePolicy
}

/** Account identity from `/alpha/whoami`. */
export interface CommandCodeAccount {
  id: string
  name: string
  userName: string
}

/** Usage summary from `/alpha/usage/summary`. */
export interface CommandCodeUsage {
  totalCount: number
  totalCost: number
  successRate: number
  completedCount: number
  failedCount: number
  totalTokensIn: number
  totalTokensOut: number
  totalCredits: number
  periodBasis: string
}

/** Credit/limit state from `/alpha/billing/credits`. */
export interface CommandCodeCredits {
  monthlyCredits: number
  purchasedCredits: number
  freeCredits: number
  /**
   * Whether the endpoint actually published a monthly balance. The scalar
   * above defaults to 0 for shape stability, which is a LIE about an omitted
   * field — and a false "0 left, fully consumed" on the dashboard. Consumers
   * that render the figure must check this first: an explicit `false` means
   * "not reported", not "nothing left".
   *
   * Optional on purpose. `undefined` means the flag itself was never recorded —
   * an older Host half, or a frame from before this field existed — and is read
   * as "assume reported", which is the behavior that shipped. Only an explicit
   * `false` from a Host that knows the balance was omitted suppresses the
   * figure, so a cross-version pair does not lose a real balance.
   */
  monthlyReported?: boolean
  purchasedReported?: boolean
  freeReported?: boolean
  /**
   * Five-hour rolling window limits, absent when the endpoint reported no such
   * window. Absence is NOT "a window with no cap": a reported window with
   * `cap === 0` is uncapped spend, while an absent one was never reported at
   * all, and only the un-reported case must keep a figure off the dashboard.
   */
  fiveHour?: { used: number; cap: number; exceeded: boolean; resetAt: number }
  /** Weekly window limits; absent under the same rule as {@link fiveHour}. */
  weekly?: { used: number; cap: number; exceeded: boolean; resetAt: number }
}

/** Subscription plan state from `/alpha/billing/subscriptions`. */
export interface CommandCodePlan {
  /** Raw subscription plan id (e.g. `individual-pro`); empty when unreported. */
  planId: string
  /** Display name (e.g. `Pro`); falls back to the raw id for unknown plans. */
  name: string
  /** Raw subscription status (`active`, `trialing`, `past_due`, …); empty when unreported. */
  status: string
  /** The plan's monthly credit total per {@link KNOWN_SUBSCRIPTION_PLANS}; null for unknown plans. */
  monthlyCredits: number | null
  /** Billing period end in millis; 0 when the endpoint did not report one. */
  currentPeriodEnd: number
}

/**
 * Why every account endpoint failed at once (the report then carries no data
 * at all, so the degraded per-endpoint view would hide the root cause behind
 * a generic "partial data" note). Undefined for partial failures.
 */
export type UsageBlockReason = 'invalid-key' | 'service-unavailable' | 'invalid-response' | 'network'

/** Account endpoints fetched by one `getUsage()` run (see the classification there). */
const USAGE_ENDPOINT_COUNT = 4

/** Everything the usage endpoints report, fetched together. */
export interface CommandCodeUsageReport {
  account?: CommandCodeAccount
  usage?: CommandCodeUsage
  credits?: CommandCodeCredits
  plan?: CommandCodePlan
  /** Endpoint failures degrade the report instead of failing it. */
  failures: string[]
  /**
   * The single reason every endpoint failed, when they all did: `invalid-key`
   * (every call rejected with 401 — the stored key is wrong or expired),
   * `service-unavailable` (every call answered 5xx), `invalid-response`
   * (every call answered but its body was not usable JSON), or `network`
   * (no HTTP response at all). Undefined when any endpoint succeeded.
   */
  blocked?: UsageBlockReason
}

/**
 * Parse one usage/summary payload into the report's usage section.
 * Returns undefined when the endpoint answered nothing usable.
 */
function parseUsageTotals(usage: Record<string, unknown> | undefined): CommandCodeUsage | undefined {
  // Note: `getUsage` always answers `usage` (200 with `{}` parses to zeros)
  // — undefined here means the endpoint failed or answered non-JSON, which
  // the caller already booked into `failures`.
  if (usage === undefined) return undefined
  return {
    totalCount: numberValue(usage.totalCount) ?? 0,
    totalCost: numberValue(usage.totalCost) ?? 0,
    successRate: numberValue(usage.successRate) ?? 0,
    completedCount: numberValue(usage.completedCount) ?? 0,
    failedCount: numberValue(usage.failedCount) ?? 0,
    totalTokensIn: numberValue(usage.totalTokensIn) ?? 0,
    totalTokensOut: numberValue(usage.totalTokensOut) ?? 0,
    totalCredits: numberValue(usage.totalCredits) ?? 0,
    periodBasis: stringValue(usage.periodBasis) ?? 'billing-period',
  }
}

/**
 * Parse one window block into a window limit, or undefined when the endpoint
 * reported no such window.
 *
 * Returning undefined (rather than a zeroed window) is load-bearing: the panel
 * must not draw a quota row for a window the account never reported, and a
 * zeroed window is indistinguishable from a genuinely uncapped one.
 */
function parseWindowLimit(value: unknown): CommandCodeCredits['fiveHour'] {
  const block = isRecord(value) ? value : undefined
  if (block === undefined) return undefined
  return {
    used: numberValue(block.used) ?? 0,
    cap: numberValue(block.cap) ?? 0,
    exceeded: block.exceeded === true,
    resetAt: numberValue(block.resetAt) ?? 0,
  }
}

/**
 * Parse one billing/credits payload into the report's credits section.
 * Returns undefined when the endpoint answered nothing usable.
 */
function parseCreditLimits(credits: Record<string, unknown> | undefined): CommandCodeCredits | undefined {
  if (credits === undefined) return undefined
  const creditsData = isRecord(credits.credits) ? credits.credits : undefined
  const windowLimits = isRecord(credits.windowLimits) ? credits.windowLimits : undefined
  const fiveHour = windowLimits !== undefined && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined
  const weekly = windowLimits !== undefined && isRecord(windowLimits.weekly) ? windowLimits.weekly : undefined
  if (creditsData === undefined && fiveHour === undefined && weekly === undefined) return undefined
  const parsed: CommandCodeCredits = {
    monthlyCredits: numberValue(creditsData?.monthlyCredits) ?? 0,
    purchasedCredits: numberValue(creditsData?.purchasedCredits) ?? 0,
    freeCredits: numberValue(creditsData?.freeCredits) ?? 0,
    // Recorded separately from the scalar: the panel must not report an
    // omitted balance as a consumed one.
    monthlyReported: numberValue(creditsData?.monthlyCredits) !== undefined,
    purchasedReported: numberValue(creditsData?.purchasedCredits) !== undefined,
    freeReported: numberValue(creditsData?.freeCredits) !== undefined,
  }
  // Optional members are only present when reported, never present-but-undefined
  // (`exactOptionalPropertyTypes`), so an absent window cannot be mistaken for a
  // parsed one with zeroed numbers.
  const fiveHourLimit = parseWindowLimit(fiveHour)
  const weeklyLimit = parseWindowLimit(weekly)
  if (fiveHourLimit !== undefined) parsed.fiveHour = fiveHourLimit
  if (weeklyLimit !== undefined) parsed.weekly = weeklyLimit
  return parsed
}

/**
 * Parse the account identity from whoami plus the plan identity from the
 * subscriptions/credits payloads. Returns the org id for the subscriptions
 * query alongside, so getUsage fetches whoami first and the rest in parallel.
 */
function parseAccountIdentity(whoami: Record<string, unknown> | undefined): {
  account: CommandCodeAccount | undefined
  orgId: string | undefined
} {
  const whoamiData = whoami !== undefined && isRecord(whoami.user) ? whoami.user : undefined
  const orgData = whoami !== undefined && isRecord(whoami.org) ? whoami.org : undefined
  return {
    account: whoamiData === undefined ? undefined : {
      id: stringValue(whoamiData.id) ?? '',
      name: stringValue(whoamiData.name) ?? '',
      userName: stringValue(whoamiData.userName) ?? '',
    },
    orgId: orgData === undefined ? undefined : stringValue(orgData.id),
  }
}

/**
 * Classify a TOTAL failure: when every endpoint failed with one class of
 * error, name the root cause instead of letting the degraded per-endpoint
 * view hide it behind a generic "partial data" note.
 */
type UsageEndpointFailure =
  | { kind: 'http'; status: number }
  | { kind: 'invalid-response'; status: number }
  | { kind: 'transport' }

function classifyTotalFailure(
  failures: readonly string[],
  failed: readonly UsageEndpointFailure[],
): UsageBlockReason | undefined {
  // Four endpoints are fetched (whoami, usage/summary, billing/credits,
  // billing/subscriptions; the last may carry an orgId query, so the
  // classification counts endpoints, not paths).
  if (failures.length !== USAGE_ENDPOINT_COUNT) return undefined
  if (failed.every((item) => item.kind === 'http' && item.status === 401)) {
    return 'invalid-key'
  }
  if (failed.every((item) => item.kind === 'http' && item.status >= 500)) {
    return 'service-unavailable'
  }
  if (failed.every((item) => item.kind === 'invalid-response')) return 'invalid-response'
  if (failed.every((item) => item.kind === 'transport')) return 'network'
  return undefined
}

/**
 * The shared facts one generate call needs, computed once up front so the
 * body builders, the connect loop, and the stream pump below all read the
 * same snapshot instead of closing over `stream()` locals.
 */
interface GenerateCallFacts {
  /** Resolved API key for the first attempt (rotation may replace it). */
  apiKey: string
  /** maxTokens cap for the request model (in-memory catalog, else default). */
  maxTokens: number
  /** Validated reasoning effort, or undefined when unset/unsupported. */
  reasoningEffort: string | undefined
  /**
   * True when the model publishes selectable effort levels, i.e. when thinking
   * is a choice this route can express. A model that neither offers levels nor
   * appears in `KNOWN_THINKING_MODELS` does not reason at all — the official
   * CLI's table marks it neither `reasoning_effort` nor `reasoning:!0` — so
   * the Messages transport must not open its thinking switch for it.
   */
  selectableEffort: boolean
  /** Folded system text (top-level system + system-role messages). */
  systemText: string
  /** Per-call request-image resolver; set only when the request carries images. */
  readImage: ReadRequestImage | undefined
}

/** UUID shape accepted by the official CLI's `toWireThreadId` helper. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// UUIDv5's URL namespace. Keep this stable so a restored DSH session retains
// the same provider thread ID across Host restarts.
const THREAD_ID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')

/**
 * Map the harness session identity to the CLI transport's UUID thread ID.
 *
 * The official CLI creates one thread ID per agent run and reuses it for the
 * tool-loop requests that follow. DSH stamps its loop-owned session ID onto
 * GenerateOptions, but ordinary IDs are `session-<UUID>`, not bare UUIDs.
 * UUIDv5 gives every non-UUID session ID a stable, wire-compatible mapping.
 * An already valid UUID remains unchanged; a one-shot call without a session
 * ID still gets a fresh thread ID.
 * This alone does not establish cache affinity (issue #64's A/B found none).
 */
function cliThreadId(sessionId: string | undefined): string {
  if (!sessionId) return randomUUID()
  if (UUID_PATTERN.test(sessionId)) return sessionId
  const digest = createHash('sha1')
    .update(THREAD_ID_NAMESPACE)
    .update('dsh-commandcode-provider/session/')
    .update(sessionId)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.toString('hex', 0, 16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The CLI wire's explicit system-section form.
 *
 * The official CLI's current transport sends system text as an array and marks
 * stable sections with Anthropic-compatible ephemeral cache control. DSH's
 * adapter has one already-folded system string rather than the CLI's internal
 * section list, so preserve that text as one cacheable section. This does not
 * recover the CLI's separate static/dynamic boundaries or guarantee a hit.
 */
function cliSystem(systemText: string): string | Record<string, unknown>[] {
  if (!systemText) return ''
  return [{
    type: 'text',
    text: systemText,
    cache_control: { type: 'ephemeral' },
  }]
}

/**
 * The Anthropic ephemeral cache marker, shared by every breakpoint this route
 * sets. One object is reused across positions because it is only ever
 * serialized, never mutated.
 *
 * No `ttl` is sent: the default 5-minute entry covers a continuously advancing
 * session, and `ttl: "1h"` is a separate billable tier whose read/write prices
 * are identical — it would only lengthen survival, not reduce cost.
 */
const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' }

/**
 * Content-block types that may carry the rolling breakpoint. Matches what the
 * official Command Code provider for pi marks through
 * `@earendil-works/pi-ai`'s `anthropic-messages` transport (its own list also
 * holds pi-internal `tool_addition` / `tool_removal`, which this route never
 * emits). Assistant-side blocks are deliberately excluded: a breakpoint on a
 * `thinking` or `tool_use` block caches a prefix the next turn invalidates.
 */
const CACHEABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'tool_result'])

/**
 * Mark the last user turn as the rolling cache breakpoint.
 *
 * Anthropic caching is explicit — a prefix is stored only when a
 * `cache_control` marker names it — so an unmarked route re-prefills the whole
 * replayed history at the full input price on every turn. Measured cost of that
 * omission on a 10-turn session: $0.5648, all of it at the undiscounted
 * $2/M input rate, against $0.1869 with the three breakpoints this route sets.
 *
 * The final user message is the rolling boundary: DSH resends the whole
 * history each turn, so a marker here grows with the conversation, whereas a
 * fixed `system`-only marker would leave every later turn's history
 * uncached. {@link messagesMessageCodec} renders both user input and tool
 * results as `role: 'user'`, so this covers a tool loop's trailing turn too.
 */
function markLastUserCacheControl(messages: unknown[]): void {
  const last = messages[messages.length - 1]
  if (!isRecord(last) || last.role !== 'user' || !Array.isArray(last.content)) return
  const lastBlock = last.content[last.content.length - 1]
  if (isRecord(lastBlock) && typeof lastBlock.type === 'string'
    && CACHEABLE_BLOCK_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = EPHEMERAL_CACHE_CONTROL
  }
}

/** Build the legacy CLI (`/alpha/generate`) request body for one call. */
async function buildCliBody(
  options: GenerateOptions,
  connection: CommandCodeConnectionOptions,
  facts: Pick<GenerateCallFacts, 'maxTokens' | 'reasoningEffort' | 'systemText' | 'readImage'>,
): Promise<Record<string, unknown>> {
  return {
    config: {
      workingDir: connection.workingDir,
      date: new Date().toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: options.model,
      messages: await messagesToCC(options.messages, facts.readImage),
      tools: (options.tools ?? []).map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        input_schema: toolParametersSchema(tool.parameters),
      })),
      system: cliSystem(facts.systemText),
      max_tokens: facts.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: true,
      ...(facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}),
    },
    threadId: cliThreadId(options.sessionId),
  }
}

/** Build the documented Provider Chat Completions request body for one call. */
async function buildOpenAIBody(
  options: GenerateOptions,
  facts: Pick<GenerateCallFacts, 'maxTokens' | 'reasoningEffort' | 'systemText' | 'readImage'>,
): Promise<Record<string, unknown>> {
  const openAiMessages = [
    ...(facts.systemText ? [{ role: 'system', content: facts.systemText }] : []),
    ...(await messagesToOpenAI(options.messages, facts.readImage)),
  ]
  const openAiTools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParametersSchema(tool.parameters),
    },
  }))
  return {
    model: options.model,
    messages: openAiMessages,
    ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
    max_tokens: facts.maxTokens,
    temperature: options.temperature ?? 0.3,
    stream: true,
    ...(facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}),
  }
}

/**
 * Build the Anthropic Messages request body for one call.
 *
 * Measured deviations from DeepSeek's own Messages API (the shape
 * `dsh-llm-deepseek` implements), all confirmed on 2026-09-29:
 *
 * - `thinking` accepts ONLY `{ type: 'adaptive' }` here. `enabled` and
 *   `disabled` are refused with `"thinking.type.enabled" is not supported for
 *   this model. Use "thinking.type.adaptive" and "output_config.effort" to
 *   control thinking behavior.`, and a `between_tools` value fails validation
 *   outright. The model reasons on its own; this switch only admits it.
 * - Reasoning strength travels in `output_config.effort`, whose accepted
 *   values are `low | medium | high | xhigh | max` — there is no `none`, and
 *   `xhigh` is absent from DeepSeek's own type.
 * - `stop_sequences` is a real field here, but this adapter still rejects
 *   `GenerateOptions.stop` in `stream()` because Command Code documents no
 *   equivalent for the other two transports.
 * - **`temperature` is never sent.** Adaptive thinking constrains it to 1:
 *   `` `temperature` may only be set to 1 when thinking is enabled or in
 *   adaptive mode `` (measured 2026-09-29 — every request carrying the other
 *   transports' 0.3 default was refused with HTTP 400). Omitting the field
 *   is the only way to honour both the thinking switch and a caller that
 *   asked for a temperature, so Claude loses sampling control on this route
 *   because the endpoint, not this adapter, removed it.
 * - `system` travels as a one-block ARRAY carrying `cache_control`, not as the
 *   bare string the other two transports send. Anthropic's caching is opt-in
 *   per block, and this route is the only Claude path, so the marker is what
 *   makes a session's replayed history bill at the cache-read rate instead of
 *   the full input rate. See {@link EPHEMERAL_CACHE_CONTROL}.
 */
async function buildMessagesBody(
  options: GenerateOptions,
  facts: Pick<GenerateCallFacts, 'maxTokens' | 'reasoningEffort' | 'selectableEffort' | 'systemText' | 'readImage'>,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: facts.maxTokens,
    stream: true,
    messages: await messagesToMessages(options.messages, facts.readImage),
  }
  // The thinking switch and the effort that drives it are one decision: the
  // endpoint's own wording is "Use `thinking.type.adaptive` AND
  // `output_config.effort` to control thinking behavior". Opening the switch
  // for a model that publishes neither (`claude-haiku-4-5-20251001` — no effort
  // levels, absent from `KNOWN_THINKING_MODELS`, so the official CLI does not
  // mark it `reasoning:!0` either) would ask a non-reasoning model to reason.
  // The field is accepted either way, so this is a correctness call rather than
  // a failure avoidance one.
  if (facts.selectableEffort) body.thinking = { type: 'adaptive' }
  if (facts.systemText) {
    body.system = [{
      type: 'text',
      text: facts.systemText,
      cache_control: EPHEMERAL_CACHE_CONTROL,
    }]
  }
  if (facts.reasoningEffort) body.output_config = { effort: facts.reasoningEffort }
  const tools: Record<string, unknown>[] = (options.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // The gateway rejects a tool whose root schema is not `type: 'object'`
    // (`tools.0.custom.input_schema.type: Field required`), so the same
    // normalization the other transports use applies here.
    input_schema: toolParametersSchema(tool.parameters),
  }))
  if (tools.length > 0) {
    // The last declaration is the one that closes the cached tools prefix;
    // marking an earlier tool would let the suffix re-prefill every turn.
    tools[tools.length - 1]!.cache_control = EPHEMERAL_CACHE_CONTROL
    body.tools = tools
  }
  markLastUserCacheControl(body.messages as unknown[])
  return body
}

interface RequestContextBudget {
  maxTokens: number
  /** The originally requested reservation would press against the known window. */
  sizePressure: boolean
}

/**
 * Estimate the text the selected transport actually sends. JSON framing and
 * punctuation each get a token; ordinary ASCII words get one, with an extra
 * allowance for long identifiers. UTF-8 bytes / 4 tracks the measured CJK
 * case better than the engine's UTF-16 characters / 4. This is a heuristic,
 * never proof that a prompt cannot fit: a valid long English prompt can still
 * be larger under this estimate than under the provider's tokenizer.
 */
function estimateWireInputTokens(
  protocol: CommandCodeProtocol,
  body: Record<string, unknown>,
  messages: readonly RequestMessage[],
  model: string,
): number {
  const params = protocol === 'cli' ? recordOrEmpty(body.params) : body
  // Inline image data is transfer encoding, not model-visible text. Count
  // those occurrences using the same per-model visual prices as the meter.
  const wire = JSON.stringify(params, (_key, value: unknown) =>
    typeof value === 'string' && /^data:[^,]*;base64,/.test(value) ? '[image]' : value)
  let tokens = 0
  for (const match of wire.matchAll(/[A-Za-z0-9_]+|[^\x00-\x7f]+|[^\s]/gu)) {
    const part = match[0]!
    if (/^[A-Za-z0-9_]+$/.test(part)) {
      tokens += 1 + Math.ceil(Math.max(0, part.length - 12) / 4)
    } else if (part.charCodeAt(0) > 127) {
      tokens += Math.ceil(Buffer.byteLength(part) / 4)
    } else {
      tokens += 1
    }
  }
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image') tokens += priceRequestImage(block, model, true).visualTokens
    }
  }
  return tokens
}

function requestContextBudget(
  protocol: CommandCodeProtocol,
  body: Record<string, unknown>,
  messages: readonly RequestMessage[],
  model: string,
  contextWindow: number | undefined,
  requestedMaxTokens: number,
): RequestContextBudget {
  if (contextWindow === undefined) return { maxTokens: requestedMaxTokens, sizePressure: false }
  const estimatedInput = estimateWireInputTokens(protocol, body, messages, model)
  const headroom = Math.min(16_384, Math.max(2_048, Math.ceil(contextWindow * 0.02)))
  const available = Math.floor(contextWindow - estimatedInput - headroom)
  // A heuristic overestimate must not reject a request that could succeed.
  // Send a small output reservation and let a provider's explicit overflow
  // signal invoke the harness's compaction path if the prompt truly is too big.
  const floor = Math.min(requestedMaxTokens, MIN_CONTEXT_OUTPUT_TOKENS, Math.max(1, Math.floor(contextWindow / 8)))
  return {
    maxTokens: Math.min(requestedMaxTokens, Math.max(floor, available)),
    sizePressure: estimatedInput >= contextWindow / 4
      && estimatedInput + requestedMaxTokens + headroom >= contextWindow,
  }
}

/**
 * One connect attempt's inputs: everything `connectGenerate` needs beyond
 * the per-attempt key and protocol. Passed explicitly (not closed over) so
 * the rotation loop's mutation of `protocol`/`body` stays visible at the
 * call site.
 */
/** The generate endpoint one protocol posts to. */
function protocolEndpoint(protocol: CommandCodeProtocol, apiBase: string): string {
  if (protocol === 'cli') return `${apiBase}/alpha/generate`
  return protocol === 'messages'
    ? `${apiBase}/provider/v1/messages`
    : `${apiBase}/provider/v1/chat/completions`
}

interface GenerateConnectDeps {
  options: GenerateOptions
  connection: CommandCodeConnectionOptions
  fetchImpl: typeof fetch
  timing: RequestTiming
  /** Observe headers even on rejected attempts before rotation/fallback. */
  onResponse: (response: Response) => void
}

/**
 * One pre-stream connect attempt: POST the body and wait for response
 * headers only (`requestTimeoutMs` must never bound the body stream). Returns
 * the live response plus its cleanup, or the rejection facts for the rotation
 * loop to classify. Every failure path cleans up before returning or throwing;
 * on success the caller-abort listener outlives the connect phase (it aborts a
 * stalled body read), so the streaming tail calls cleanup.
 */
async function connectGenerate(
  deps: GenerateConnectDeps,
  key: string,
  protocol: CommandCodeProtocol,
  serializedBody: string,
): Promise<{ response: Response; cleanup: () => void } | { status: number; errText: string; retryAfterMs?: number }> {
  const { options, connection, fetchImpl } = deps
  const connectAbort = new AbortController()
  let connectTimedOut = false
  const endpoint = protocolEndpoint(protocol, connection.apiBase)
  const connectTimer = setTimeout(() => {
    connectTimedOut = true
    connectAbort.abort(
      new DOMException(
        `Command Code API request to ${endpoint} did not respond within ${connection.requestTimeoutMs}ms`,
        'TimeoutError',
      ),
    )
  }, connection.requestTimeoutMs)
  const onCallerAbort = () => {
    connectAbort.abort(options.signal?.reason)
  }
  if (options.signal) {
    if (options.signal.aborted) {
      onCallerAbort()
    } else {
      options.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
  }
  const cleanup = () => {
    clearTimeout(connectTimer)
    if (options.signal) {
      options.signal.removeEventListener('abort', onCallerAbort)
    }
  }

  let response: Response
  // Enforce ZDR on every chat request when selected. The provider is the
  // routing authority: an unsupported model (or unavailable ZDR capacity)
  // fails with 422 rather than sending the prompt through a retaining upstream.
  // Never omit the header based on a client-side capability snapshot.
  const zdr = connection.zdr === true
  const sharedHeaders = {
    'Content-Type': 'application/json',
    ...IDENTITY_ENCODING_HEADER,
    Authorization: `Bearer ${key}`,
    ...(zdr ? { 'x-cmd-zdr': '1' } : {}),
    ...attributionHeaders(),
  }
  const headers = protocol === 'cli'
    ? {
        ...sharedHeaders,
        'x-command-code-version': COMMAND_CODE_CLI_VERSION,
        'x-cli-environment': 'production',
        'x-project-slug': projectSlugFromPath(connection.workingDir),
        'x-taste-learning': 'true',
        'x-co-flag': 'false',
      }
    : {
        ...sharedHeaders,
        Accept: 'text/event-stream',
        // Deliberately no x-command-code-version / x-cli-environment on either
        // documented Provider API surface: those identify the CLI transport,
        // not a public API client. ZDR is the one business header both share.
      }
  // 请求体由调用层缓存，同协议换账号只替换请求头，不重复序列化历史。
  const finishHeaders = deps.timing.attempt(protocol, Buffer.byteLength(serializedBody))
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: serializedBody,
      signal: connectAbort.signal,
    })
    finishHeaders(response.status)
    clearTimeout(connectTimer)
  } catch (error: unknown) {
    finishHeaders()
    cleanup()
    if (options.signal?.aborted) {
      throw error
    }
    if (connectTimedOut || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw headersTimeoutError({
        protocol, endpoint, body: serializedBody,
        timeoutMs: connection.requestTimeoutMs, cause: error,
      })
    }
    // fetch wraps every transport failure (DNS, refused connection, TLS,
    // proxy, reset) in a bare `TypeError: fetch failed` whose actionable
    // detail lives on `cause`. Include the full chain so the failure reason
    // shown in the web UI (which renders only the message, not `cause`)
    // names the real root cause instead of a generic wrapper.
    throw bilingual(
      'TRANSPORT',
      `Command Code API request to ${endpoint} failed: ${errorChain(error)}`,
      'Command Code API 请求连接失败——通常是网络或代理问题，请检查网络或代理设置后重试',
      { cause: error },
    )
  }

  deps.onResponse(response)
  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    cleanup()
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    // exactOptionalPropertyTypes: the key must be absent, not undefined.
    return retryAfterMs === undefined
      ? { status: response.status, errText }
      : { status: response.status, errText, retryAfterMs }
  }
  return { response, cleanup }
}

/**
 * The StreamChunk block-assembly state shared by both transport handlers:
 * at most one text block and one reasoning block are open at a time (same
 * assumption as the pi plugin).
 */
interface BlockAssembler {
  nextIndex: number
  textIndex: number
  textContent: string
  reasoningIndex: number
  reasoningContent: string
  sawContent: boolean
  /** Provider spelling, retained for terminal diagnostics rather than inferred from usage. */
  finishReason: string | undefined
  /**
   * command-code@1.65.2's standalone cache-write reading. The finish event's
   * totalUsage can report zero even though the request wrote cache entries;
   * the official CLI keeps this last valid event and uses it only as the
   * zero/missing fallback.
   */
  cliCacheWriteTokens: number | undefined
  /** Buffered OpenAI tool-call fragments, flushed at finish. */
  openAiToolCalls: Array<{ index: number; id?: string; name: string; arguments: string }>
  /** Messages-transport block state, keyed by the wire `index`. */
  messagesBlocks: Map<number, MessagesBlockState>
  /**
   * Per-emitted-block replay metadata, indexed by the harness chunk index.
   * Only the Messages transport records entries (the thinking `signature`);
   * the other two leave it empty, which is legal — an adapter whose metadata
   * is independent of block structure omits the field entirely.
   */
  replayBlocks: MessagesReplayBlock[]
}

/** One Messages content block while it streams. */
interface MessagesBlockState {
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  signature: string
  json: string
  id: string
  name: string
  /** The harness chunk index this block was opened under, or -1 before open. */
  chunkIndex: number
}

/** Fresh block-assembly state for one stream. */
function createBlockAssembler(): BlockAssembler {
  return {
    nextIndex: 0,
    textIndex: -1,
    textContent: '',
    reasoningIndex: -1,
    reasoningContent: '',
    sawContent: false,
    finishReason: undefined,
    cliCacheWriteTokens: undefined,
    openAiToolCalls: [],
    messagesBlocks: new Map(),
    replayBlocks: [],
  }
}

function* closeText(asm: BlockAssembler): Generator<StreamChunk> {
  if (asm.textIndex < 0) return
  yield {
    type: 'block-end',
    index: asm.textIndex,
    block: { type: 'text', text: asm.textContent },
  }
  asm.textIndex = -1
  asm.textContent = ''
}

function* closeReasoning(asm: BlockAssembler): Generator<StreamChunk> {
  if (asm.reasoningIndex < 0) return
  yield {
    type: 'block-end',
    index: asm.reasoningIndex,
    block: { type: 'reasoning', text: asm.reasoningContent },
  }
  asm.reasoningIndex = -1
  asm.reasoningContent = ''
}

function* emitOpenAiToolCalls(asm: BlockAssembler): Generator<StreamChunk> {
  for (const call of asm.openAiToolCalls) {
    const id = call.id ?? randomUUID()
    const name = call.name ?? ''
    const args = call.arguments || '{}'
    const index = asm.nextIndex++
    asm.sawContent = true
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
    }
  }
  asm.openAiToolCalls.length = 0
}

export class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private catalog: CommandCodeModel[] = []
  private catalogState: { source: string; expiresAt: number; inflight?: Promise<CommandCodeModel[]> } | undefined
  private readonly fetchImpl: typeof fetch
  private readonly resolveAttachments: ResolveAttachments | undefined
  /**
   * The durable-offload contract, resolved once (tests may inject a stub). The
   * contract cannot change while the process runs.
   */
  private readonly surfaceOffload: SurfaceImagePolicy
  // Billing facts are per gateway and account: a custom gateway can give the
  // same key a different tier. The key remains process-local and is never logged. Entries are
  // small and bounded by the account count in practice; a changed key simply
  // starts a fresh entry while the orphaned one goes cold (no eviction —
  // transience is intentional, persistence would serve stale tiers).
  private readonly billingAccess = new Map<string, { value: CommandCodeBillingAccess | undefined; at: number }>()
  private readonly billingAccessInflight = new Map<string, Promise<CommandCodeBillingAccess | undefined>>()
  // Protocol preference is per gateway and account: the Go plan is the only plan without
  // Provider API access, and that fact is independent of model. A negative
  // result (provider API rejected this key with upgrade_required) is cached so
  // every request does not pay the double TTFT of probing then falling back.
  // Same bounded-by-account-count note as above: no eviction by design.
  private readonly protocolCache = new Map<string, { protocol: 'cli' | 'openai'; at: number }>()

  /** Namespace account-derived facts by gateway without exposing the key. */
  private accountCacheKey(apiBase: string, apiKey: string): string {
    return JSON.stringify([apiBase, apiKey])
  }
  /**
   * Consecutive header timeouts for the last request shape, counted ACROSS
   * `stream()` calls: dsh-llm-retry re-invokes this same instance, so this is
   * the only place a streak can live. Keyed by `sessionId` (not by `agent`:
   * `GenerateOptions` carries no agent reference, only `sessionId`) so
   * concurrent sessions on this one shared adapter instance cannot clear or
   * inflate each other's count. A call with no `sessionId` (a one-shot,
   * session-less caller) falls back to {@link GLOBAL_HEADER_TIMEOUT_KEY},
   * matching the old single-slot behavior for exactly that case. Bounded by
   * {@link MAX_HEADER_TIMEOUT_STREAK_ENTRIES} with FIFO eviction (`Map`
   * preserves insertion order) since the key space is per-session rather than
   * per-account/model, so it is not naturally small like `protocolCache`.
   */
  private readonly headerTimeoutStreaks = new Map<string, { fingerprint: string; count: number }>()
  private static readonly MAX_HEADER_TIMEOUT_STREAK_ENTRIES = 200

  constructor(private readonly deps: CommandCodeAdapterDeps<C>) {
    super()
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.resolveAttachments = deps.resolveAttachments
    this.surfaceOffload = deps.imageOffload ?? ENGINE_IMAGE_POLICY
  }

  /**
   * Grade one failed attempt: a headers timeout that repeats on an unchanged
   * payload eventually leaves the retryable whitelist.
   *
   * `providerRetryPolicy()` cannot express this itself — dsh-llm's
   * `NormalRetryPolicyConfig` carries one `maxRetries` for every listed code.
   * Escalating here stops repeated identical header timeouts with a specific
   * diagnosis; the agent listener separately caps ordinary transient errors.
   *
   * @returns the error to surface: unchanged for any other failure, the
   * original timeout below the threshold, and a terminal one at it.
   */
  private gradeHeaderTimeout(
    error: unknown,
    protocol: CommandCodeProtocol,
    body: Record<string, unknown>,
    timeoutMs: number,
    sessionId: string | undefined,
  ): unknown {
    const timedOut = error instanceof LlmError && error.code === 'TIMEOUT'
    if (!timedOut) return error
    const key = sessionId ?? GLOBAL_HEADER_TIMEOUT_KEY
    const fingerprint = `${protocol}:${fingerprintValue(body).sha256}`
    const previous = this.headerTimeoutStreaks.get(key)
    const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1
    if (previous === undefined) {
      // FIFO eviction: the key space is per-session (unlike protocolCache's
      // per-account/model bound), so an unbounded Map would leak one entry
      // per abandoned session that timed out below the threshold and never
      // got a success or an escalation to clear it.
      if (this.headerTimeoutStreaks.size >= CommandCodeAdapter.MAX_HEADER_TIMEOUT_STREAK_ENTRIES) {
        const oldest = this.headerTimeoutStreaks.keys().next().value
        if (oldest !== undefined) this.headerTimeoutStreaks.delete(oldest)
      }
    } else {
      // Re-inserting moves the key to the end, so FIFO eviction above evicts
      // truly idle sessions first rather than one mid-streak.
      this.headerTimeoutStreaks.delete(key)
    }
    this.headerTimeoutStreaks.set(key, { fingerprint, count })
    if (count < MAX_CONSECUTIVE_HEADER_TIMEOUTS) return error
    // Reset so a later attempt starts a fresh streak instead of failing at once.
    this.headerTimeoutStreaks.delete(key)
    return bilingual(
      'PROVIDER_HTTP_ERROR',
      `Command Code API stopped retrying: the gateway returned no response headers on ${count} consecutive attempts at the same request, each after the full ${timeoutMs}ms budget, so this is not a network blip — it is provider queueing, a Go-plan capacity limit, or a network/proxy path problem. Resending the identical payload again is unlikely to help; wait for the provider to recover, or switch model or account.`,
      `Command Code API 已停止重试：同一请求连续 ${count} 次在 ${timeoutMs} 毫秒内都没有收到任何响应头，这不是网络抖动，而是服务商排队、Go 套餐容量限制或网络/代理链路问题。继续原样重发同一个请求通常无济于事——可以等服务商恢复，或换模型/换账号。`,
    )
  }

  /**
   * Display metadata for the picker's provider group header. The base class
   * returns the raw route id (`commandcode`, all lowercase) as the name, which
   * is what the model selector shows as this group's sticky title; return the
   * proper display name instead, matching the Models settings page card (the
   * configurable-provider `displayName`). The id must stay equal to the route.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code' }
  }

  /**
   * The official executor owns backoff and provider reset waits. Its high
   * route-wide cap lets a confirmed `RATE_LIMIT` window recover in-session;
   * our request-error listener limits `SERVER`/`TIMEOUT`/`EMPTY_RESPONSE`/
   * `THROTTLED` to three retries and `TRANSPORT` to its separate budget.
   * Waits double from 500 ms and cap at 15 minutes (±10% jitter). Permanent failures
   * (an invalid key's `INVALID_CREDENTIAL`, `UNSUPPORTED_CONTENT`, plan
   * rejections) are absent from the whitelist and surface immediately instead
   * of looping. Waits the pool/adapter attach as `providerRetryAfterMs` are
   * honored verbatim at or below the 15-minute cap and never attached above it
   * (in normal mode a longer attached wait makes the executor abandon the
   * retry outright — see RETRY_MAX_DELAY_MS).
   *
   * Captured once at route registration (dsh-llm snapshots this value), so a
   * future config knob for it would apply on profile restart, not per request.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 1000,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', THROTTLED_CODE, 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        backoff: { initialDelayMs: 500, maxDelayMs: RETRY_MAX_DELAY_MS, jitterRatio: 0.1 },
      },
      'llm-commandcode: retryPolicy',
    )
  }

  /**
   * Visual-token pricing for one exact model route (see `./image-tokens.ts`).
   *
   * Without this the token meter prices EVERY image with its structural
   * heuristic — a handful of tokens for a full screenshot — so an image-heavy
   * session reports far less context than it is actually carrying. The price is
   * computed at the dimensions this route would send (the same request target
   * `readImageRequest` encodes to), so the estimate tracks the wire rather than
   * the stored original. One price per occurrence, in order, is a hard
   * requirement — the meter throws when the counts differ.
   */
  override imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    const imageCapable = KNOWN_IMAGE_MODELS.has(model)
    return {
      priceImages: (images: readonly ImageBlock[]) =>
        images.map((image) => priceRequestImage(image, model, imageCapable)),
    }
  }

  /** 地址或缓存文件变化时丢弃旧目录，防止旧网关的路由声明影响新请求。 */
  private currentCatalogState(connection = this.deps.options()) {
    const { apiBase, modelsCachePath } = connection
    const source = JSON.stringify([apiBase, modelsCachePath])
    if (this.catalogState?.source !== source) {
      this.catalog = []
      this.catalogState = { source, expiresAt: 0 }
    }
    return this.catalogState
  }

  /** 共享一次刷新；调用者取消只结束自己的等待，不取消其他调用者的请求。 */
  private async loadCatalog(signal?: AbortSignal): Promise<CommandCodeModel[]> {
    signal?.throwIfAborted()
    const connection = this.deps.options()
    const state = this.currentCatalogState(connection)
    if (Date.now() < state.expiresAt) return this.catalog
    const { apiBase, modelsCachePath } = connection
    if (!state.inflight) {
      const fallback = this.catalog
      state.inflight = (async () => {
        let models: CommandCodeModel[]
        let ttl = MODEL_CATALOG_TTL_MS
        try {
          const { status, record } = await this.fetchJson(
            `${apiBase}/provider/v1/models`,
            { accept: 'application/json', ...IDENTITY_ENCODING_HEADER, ...attributionHeaders() },
            MODELS_TIMEOUT_MS,
          )
          if (status < 200 || status >= 300) throw new Error(`models endpoint returned ${status}`)
          models = parseCatalogResponse(record, apiBase)
          // 旧地址的并发刷新不得覆盖新地址的内存或磁盘目录。
          if (this.catalogState === state) {
            await writeModelsCache(modelsCachePath, apiBase, models, () => this.catalogState === state).catch(() => undefined)
          }
        } catch {
          ttl = MODEL_CATALOG_RETRY_MS
          models = await readModelsCache(modelsCachePath, apiBase).catch(() => fallback)
        }
        if (this.catalogState === state) {
          this.catalog = models
          state.expiresAt = Date.now() + ttl
        }
        return models
      })().finally(() => { delete state.inflight })
    }
    if (!signal) return state.inflight
    const inflight = state.inflight
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      inflight.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }

  override async listModels(
    provider: string,
    opts?: { unfiltered?: boolean },
  ): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.loadCatalog()
    const toInfo = (model: (typeof catalog)[number]) => {
      const vision = KNOWN_IMAGE_MODELS.has(model.id)
      return {
        provider,
        id: model.id,
        name: `${model.name} (CC)`,
        // The picker renders `description` under the model name: plan tier,
        // active deal, Image marker for Vision models, and context window.
        description: capabilityDescription(model.id, model.contextWindow),
        inputModalities: vision ? (['text', 'image'] as const) : (['text'] as const),
      }
    }
    // Unfiltered: the settings page's catalog endpoint serves the full catalog
    // so the filter editor can always offer every model.
    if (opts?.unfiltered === true) return catalog.map(toInfo).sort(compareByPlan)
    // Plan filter: hide models no account in the pool can run. Fails open —
    // a billing-fetch problem, an unknown plan, or a positive on-demand
    // balance all keep the catalog visible, and the server remains the final
    // gate (403 MODEL_NOT_IN_PLAN). The catalog itself is never filtered:
    // resolveModel still serves every model.
    //
    // EVERY account's entitlement is consulted, not just the one that happens
    // to serve right now (issue #51's follow-up: 《卡片会切换》). Keying the
    // filter on the serving account made the picker's contents depend on which
    // account rotation had reached, and it hid models the user's OTHER accounts
    // could run. The union is the honest question for a pool, and it only works
    // together with the entitlement rotation in the connect loop.
    const accesses = this.deps.options().filterModelsByPlan === false
      ? undefined
      : await this.loadPoolBillingAccess()
    // Visible-model allowlist, then the terminal settings page's per-model
    // boolean overrides (its schema seam can only give each model its own
    // flag, which cannot express "this id is in the list"). Both are defined
    // on {@link CommandCodeConnectionOptions}.
    const visible = this.deps.options().visibleModels
    const allow = Array.isArray(visible) && visible.length > 0
      ? new Set(visible.filter((id) => typeof id === 'string' && id !== ''))
      : undefined
    const overrides = this.deps.options().modelVisibility
    return catalog
      .filter((model) => modelVisibleForAnyAccount(model.id, accesses))
      .filter((model) => {
        const override = overrides?.[model.id]
        if (typeof override === 'boolean') return override
        return allow === undefined || allow.has(model.id)
      })
      .map(toInfo)
      // The picker renders rows in the order returned: sort by plan tier
      // (Go first, … Provider last) so the models a Go-plan user can actually
      // use lead the list, then alphabetically within each tier.
      .sort(compareByPlan)
  }

  /**
   * The per-model allowance bracket this account POOL falls into, or undefined
   * when there is nothing honest to show.
   *
   * The pricing page publishes a per-model monthly allowance for GOAT and Pro
   * only — its own words are "the boost is a per-model allowance, so it lives on
   * the plans that have them" — so a pool whose highest plan is Go, Provider,
   * Max or Ultra gets undefined rather than a neighbouring tier's figure. Taking
   * the HIGHEST tier matches the question the picker already answers for a pool
   * (see `modelVisibleForAnyAccount`): what the user can reach, not what the one
   * account serving this request happens to be. The fail-open shape is the same
   * too — an unreachable billing endpoint yields undefined, which hides the
   * allowance instead of inventing one.
   */
  async allowanceTier(): Promise<'goat' | 'pro' | undefined> {
    const accesses = await this.loadPoolBillingAccess()
    if (accesses === undefined) return undefined
    let highest: number | undefined
    for (const access of accesses) {
      const weight = access?.tierWeight
      if (weight === undefined) continue
      if (highest === undefined || weight > highest) highest = weight
    }
    // `allowanceTierForWeight` owns the weight → bracket mapping (and the
    // decision that Go, Provider, Max and Ultra have no bracket at all), so this
    // method only has to answer "what is the highest plan in the pool?".
    return allowanceTierForWeight(highest)
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.currentCatalogState()
    const entry =
      this.catalog.find((m) => m.id === model) ??
      (await this.loadCatalog(signal)).find((m) => m.id === model)

    const efforts = KNOWN_EFFORTS[model]
    const vision = KNOWN_IMAGE_MODELS.has(model)
    return {
      provider,
      id: model,
      name: entry ? `${entry.name} (CC)` : model,
      description: capabilityDescription(model, entry?.contextWindow),
      inputModalities: vision ? (['text', 'image'] as const) : (['text'] as const),
      // Both Command Code transports send the complete active tool declaration
      // list on every request. They do not need a provider-native deferred
      // tool marker, but they can still consume the rc.2 harness projection:
      // `tool-addition` messages are ignored by the wire converters and the
      // projected `options.tools` already contains the newly active schema.
      // Advertising addition-only lets dsh keep one conversation/request
      // series when a plugin enables a tool mid-session; removals are handled
      // by omission from that active list, not by a removal event.
      toolUpdate: 'addition-only' as const,
      ...(entry
        ? {
            context: { contextWindow: entry.contextWindow },
            defaultMaxTokens: Math.min(entry.maxTokens, DEFAULT_GENERATE_MAX_TOKENS),
          }
        : {}),
      // Omit `reasoning` entirely for models without known effort support:
      // the harness then treats the model as having no selectable efforts.
      ...(efforts
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({
                id: ReasoningEffortId(effort),
                name: effort,
              })),
            },
          }
        : {}),
    }
  }

  /** The headers every authenticated account endpoint shares. */
  private async accountHeaders(apiKey?: string): Promise<Record<string, string>> {
    const connection = this.deps.options()
    const raw = apiKey ?? (await this.deps.resolveApiKey(connection))
    // Every account endpoint runs the chat path's own `assertUsableApiKey`
    // check, or a key carrying a character no HTTP header can hold throws
    // inside `fetch` BEFORE any I/O — once per endpoint — and the report reads
    // as "the network is down". The credential reference is read structurally:
    // it belongs to the host's resolved options, not to this adapter's
    // connection type, and it only names the key in the rejection message.
    const named = (connection as { apiKeyEnv?: unknown }).apiKeyEnv
    const ref = typeof named === 'string' && named !== '' ? named : 'the stored credential'
    const key = assertUsableApiKey(raw, 'llm-commandcode', ref)
    return {
      Authorization: `Bearer ${key}`,
      ...IDENTITY_ENCODING_HEADER,
      'x-command-code-version': COMMAND_CODE_CLI_VERSION,
      'x-cli-environment': 'production',
      ...attributionHeaders(),
    }
  }

  /**
   * Fetch one JSON GET and return its HTTP status with a parsed record. The
   * catalog, billing probe, and usage report each apply their own failure
   * policy. Non-2xx and invalid JSON bodies come back without a record; only
   * a fetch failure propagates to the caller.
   *
   * `timeoutMs` is the caller's budget, unless it provides its own signal.
   * The usage report passes the connection's request budget rather than the
   * catalog/picker's shorter default.
   */
  private async fetchJson(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number = MODELS_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<{ status: number; record?: Record<string, unknown>; invalidResponse?: boolean }> {
    const response = await this.fetchImpl(url, {
      headers,
      // A hung account endpoint must not stall the picker / usage card forever.
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { status: response.status }
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return { status: response.status, invalidResponse: true }
    }
    return isRecord(parsed)
      ? { status: response.status, record: parsed }
      : { status: response.status, invalidResponse: true }
  }

  /**
   * Every account's billing facts behind the picker's plan filter, in the
   * pool's rotation order and cached per key for {@link BILLING_ACCESS_TTL_MS}
   * (so the extra accounts cost their three requests once per TTL, not once
   * per picker load). `undefined` means the filter cannot be evaluated at all
   * — no key resolved — which {@link modelVisibleForAnyAccount} reads as
   * "show everything".
   */
  private async loadPoolBillingAccess(): Promise<readonly (CommandCodeBillingAccess | undefined)[] | undefined> {
    const keys = await this.poolAccountKeys()
    if (keys.length === 0) return undefined
    const apiBase = this.deps.options().apiBase
    return Promise.all(keys.map((key) => this.loadBillingAccessForKey(apiBase, key)))
  }

  /**
   * The API keys the picker's plan filter must consult: every account the host
   * can serve from, in rotation order, when the host exposes one. A host
   * without a pool (or without the seam) reports just the key that would serve
   * this request — exactly the pre-pool behaviour.
   */
  private async poolAccountKeys(): Promise<readonly string[]> {
    try {
      const keys = await this.deps.resolveAccountKeys?.()
      const usable = (keys ?? []).filter((key) => typeof key === 'string' && key !== '')
      if (usable.length > 0) return usable
    } catch {
      // Fall through to the single-key answer below.
    }
    try {
      return [await this.deps.resolveApiKey(this.deps.options())]
    } catch {
      return []
    }
  }

  /**
   * One account's billing facts, cached for {@link BILLING_ACCESS_TTL_MS} and
   * shared across concurrent callers. `undefined` means "unknown — show
   * everything" (fail-open).
   */
  private async loadBillingAccessForKey(apiBase: string, apiKey: string): Promise<CommandCodeBillingAccess | undefined> {
    const cacheKey = this.accountCacheKey(apiBase, apiKey)
    const cached = this.billingAccess.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < BILLING_ACCESS_TTL_MS) return cached.value
    const existing = this.billingAccessInflight.get(cacheKey)
    if (existing !== undefined) return existing
    const inflight = this.fetchBillingAccess(apiBase, apiKey)
      .then((value) => {
        this.billingAccess.set(cacheKey, { value, at: Date.now() })
        return value
      })
      .finally(() => {
        this.billingAccessInflight.delete(cacheKey)
      })
    this.billingAccessInflight.set(cacheKey, inflight)
    return inflight
  }

  /**
   * The billing facts behind the picker's plan filter, mirroring the CLI's
   * `createBilling` flow: whoami yields the org id, then the subscriptions
   * and credits endpoints answer in parallel. The plan id is honored only
   * when the subscription reports an active-ish status (the CLI's rule); when
   * the subscriptions endpoint fails entirely, `credits.planId` is the
   * fallback (the CLI stamps plan identity from it too). Any failure resolves
   * to `undefined` (fail-open) rather than breaking the picker.
   */
  private async fetchBillingAccess(apiBase: string, apiKey: string): Promise<CommandCodeBillingAccess | undefined> {
    try {
      const headers = await this.accountHeaders(apiKey)
      // Billing probe fails open silently: any non-record is "unknown".
      const getJson = async (path: string): Promise<Record<string, unknown> | undefined> =>
        (await this.fetchJson(`${apiBase}${path}`, headers)).record
      const whoami = await getJson('/alpha/whoami')
      const orgData = whoami && isRecord(whoami.org) ? whoami.org : undefined
      const orgId = orgData === undefined ? undefined : stringValue(orgData.id)
      const [subscription, credits] = await Promise.all([
        getJson(orgId === undefined
          ? '/alpha/billing/subscriptions'
          : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`),
        getJson('/alpha/billing/credits'),
      ])
      const subData = subscription && isRecord(subscription.data) ? subscription.data : undefined
      const creditsData = credits && isRecord(credits.credits) ? credits.credits : undefined
      if (subData === undefined && creditsData === undefined) return undefined
      let planId: string | undefined
      if (subData !== undefined) {
        const status = stringValue(subData.status)
        if (status !== undefined && ACTIVE_SUBSCRIPTION_STATUSES.has(status)) planId = stringValue(subData.planId)
      } else {
        planId = stringValue(creditsData?.planId)
      }
      return {
        tierWeight: planId === undefined ? undefined : subscriptionPlanInfo(planId)?.tierWeight,
        onDemandCredits: (numberValue(creditsData?.purchasedCredits) ?? 0) + (numberValue(creditsData?.freeCredits) ?? 0),
      }
    } catch {
      return undefined
    }
  }

  /** Fresh cached billing tier weight for a key, or undefined when not known. */
  private cachedBillingTierWeight(apiBase: string, apiKey: string): number | undefined {
    const hit = this.billingAccess.get(this.accountCacheKey(apiBase, apiKey))
    if (hit === undefined || Date.now() - hit.at >= BILLING_ACCESS_TTL_MS) return undefined
    return hit.value?.tierWeight
  }

  /** Cached protocol decision for a key, or undefined when expired/unknown. */
  private cachedProtocol(apiBase: string, apiKey: string): 'cli' | 'openai' | undefined {
    const hit = this.protocolCache.get(this.accountCacheKey(apiBase, apiKey))
    if (hit === undefined || Date.now() - hit.at >= PROTOCOL_CACHE_TTL_MS) return undefined
    return hit.protocol
  }

  private rememberProtocol(apiBase: string, apiKey: string, protocol: 'cli' | 'openai'): void {
    this.protocolCache.set(this.accountCacheKey(apiBase, apiKey), { protocol, at: Date.now() })
  }

  /**
   * True when the catalog routes `model` to `/provider/v1/messages`.
   *
   * The catalog's own `supported_endpoints` is authoritative (it is what
   * upstream publishes per model); `requiresMessagesEndpoint()` — the
   * `claude-*` prefix rule — is the fallback for a catalog entry that carries
   * no route list, which is the shape every pre-1.55 cache file has.
   */
  private routesToMessages(model: string): boolean {
    const entry = this.catalog.find((candidate) => candidate.id === model)
    if (entry !== undefined && entry.supportedEndpoints.length > 0) {
      return entry.supportedEndpoints.includes('/messages')
    }
    return requiresMessagesEndpoint(model)
  }

  /**
   * Choose the initial protocol for one request.
   *
   * Models the Provider API serves only through `/provider/v1/messages` (the
   * Claude family) take the Messages transport on any tier and even under a
   * forced `'openai'` preference: that option is documented as "prefer the
   * Provider API, still fall back", and the 400 these models answer with on
   * Chat Completions (`Model "<id>" must be called via /provider/v1/messages`)
   * is a hard refusal, not a preference to honour.
   *
   * That decision is deliberately NOT written to `protocolCache`, which is
   * keyed by gateway and API key: it depends on the model, not just the account, so
   * remembering it would pin the whole ACCOUNT to one transport and drag
   * every other model along (issue #46).
   *
   * Otherwise a fresh protocol cache entry wins, then a cached (not
   * network-fetched) billing tier of Go — the one plan without Provider API
   * access. Unknown accounts default to Chat Completions and fall back to the
   * CLI transport only after an `upgrade_required` rejection.
   */
  private resolveProtocol(apiBase: string, apiKey: string, model: string): CommandCodeProtocol {
    const forced = this.deps.options().protocol
    if (forced === 'cli') return forced
    if (this.routesToMessages(model)) return 'messages'
    if (forced === 'openai') return forced
    const cached = this.cachedProtocol(apiBase, apiKey)
    if (cached !== undefined) return cached
    if (this.cachedBillingTierWeight(apiBase, apiKey) === GO_TIER_WEIGHT) {
      this.rememberProtocol(apiBase, apiKey, 'cli')
      return 'cli'
    }
    return 'openai'
  }


  /**
   * Fetch account, usage, credit, and subscription state from the Command
   * Code account endpoints (`/alpha/whoami`, `/alpha/usage/summary`,
   * `/alpha/billing/credits`, `/alpha/billing/subscriptions`).
   * Each endpoint degrades independently: a failed one lands in `failures`
   * while the rest still report, so a transient outage never blanks the whole
   * view. Requires a usable API key (throws `MISSING_CREDENTIAL` otherwise).
   * Pass `apiKey` to report on a specific account of a multi-account pool;
   * the default resolves the currently active account.
   *
   * Two failure modes are NOT "the network is down", and the report must say
   * so rather than let {@link classifyTotalFailure} blame the connection: a
   * key that no HTTP header can carry (a stray newline from a paste, a
   * full-width character) makes `fetch` throw a `TypeError` before any I/O,
   * for every endpoint at once, so this path runs `assertUsableApiKey` too and
   * answers `blocked: 'invalid-key'`; and the four endpoints get the SAME
   * per-request budget as a chat call (`connection.requestTimeoutMs`, default
   * 60 s), not the catalog's 10 s probe budget, because on a slow link a 10 s
   * cap made every account query time out while chat kept working.
   */
  async getUsage(apiKey?: string): Promise<CommandCodeUsageReport> {
    const connection = this.deps.options()
    const base = connection.apiBase
    let headers: Record<string, string>
    try {
      headers = await this.accountHeaders(apiKey)
    } catch (error: unknown) {
      // An unusable key is a CREDENTIAL verdict, not a transport one. A
      // missing key still propagates (the caller renders the unconfigured
      // state); only the harness's own "characters no header can carry"
      // rejection — and a blank resolved key — becomes `invalid-key`.
      if (error instanceof LlmError && error.code === 'INVALID_CREDENTIAL') {
        return { failures: [error.message], blocked: 'invalid-key' }
      }
      throw error
    }
    const failures: string[] = []
    // Keep received-but-unreadable bodies separate from requests that never
    // received a response. The former used to be counted as "network".
    const failed: UsageEndpointFailure[] = []

    const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const { status, record, invalidResponse } = await this.fetchJson(
          `${base}${path}`,
          headers,
          connection.requestTimeoutMs,
        )
        if (record === undefined) {
          failures.push(`${path}: HTTP ${status}${invalidResponse ? ' returned an unreadable or invalid JSON body' : ''}`)
          failed.push(invalidResponse ? { kind: 'invalid-response', status } : { kind: 'http', status })
          return undefined
        }
        return record
      } catch (error: unknown) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        failed.push({ kind: 'transport' })
        return undefined
      }
    }

    const report: CommandCodeUsageReport = { failures }

    // whoami first (account identity + the org id the subscriptions query
    // needs); the other three endpoints are independent once headers exist,
    // so they run in parallel instead of paying 4x the timeout serially.
    const whoami = await getJson('/alpha/whoami')
    const { account, orgId } = parseAccountIdentity(whoami)
    if (account !== undefined) report.account = account
    const [usage, credits, subscription] = await Promise.all([
      getJson('/alpha/usage/summary'),
      getJson('/alpha/billing/credits'),
      getJson(orgId === undefined
        ? '/alpha/billing/subscriptions'
        : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`),
    ])

    // usage/summary -> totals.
    const totals = parseUsageTotals(usage)
    if (totals !== undefined) report.usage = totals

    // billing/credits -> credit + window limits.
    const limits = parseCreditLimits(credits)
    if (limits !== undefined) report.credits = limits

    // billing/subscriptions -> plan identity + billing period. The credits
    // response may also carry a planId; it is the fallback when the
    // subscriptions endpoint fails.
    const subData = subscription !== undefined && isRecord(subscription.data) ? subscription.data : undefined
    const creditsData = credits !== undefined && isRecord(credits.credits) ? credits.credits : undefined
    const planId = stringValue(subData?.planId) ?? stringValue(creditsData?.planId)
    if (subData !== undefined || planId !== undefined) {
      const info = planId === undefined ? undefined : subscriptionPlanInfo(planId)
      report.plan = {
        planId: planId ?? '',
        name: info?.name ?? planId ?? '',
        status: stringValue(subData?.status) ?? '',
        monthlyCredits: info?.monthlyCredits ?? null,
        currentPeriodEnd: periodEndValue(subData?.currentPeriodEnd),
      }
    }

    const blocked = classifyTotalFailure(failures, failed)
    if (blocked !== undefined) report.blocked = blocked

    return report
  }

  /**
   * Probe one account's real usage windows from `/alpha/billing/credits`. The
   * multi-account pool calls this when every account is marked exhausted: an
   * account whose windows no longer report `exceeded` is revived, and the
   * `resetAt` values feed the "earliest reset" error message.
   *
   * BOTH windows the endpoint publishes are read, not just `fiveHour`. An
   * account can have an open five-hour window and an exhausted WEEKLY quota at
   * the same time (the two are metered separately), and reading only the
   * shorter one revived such an account as "usable" — the pool then handed it
   * out, the provider rejected the request again, and the next all-marked pass
   * revived it once more (issue #51's follow-up: "切到一个不可用账号").
   * `exceeded` is therefore true when ANY published window is exceeded, and
   * `resetAt` is the LATEST reset among the exceeded ones — the binding
   * constraint, because a clear five-hour window buys nothing while the weekly
   * quota is spent.
   *
   * Returns `undefined` when the probe itself failed (transport, non-200, or a
   * payload with no window limits at all) — a failed probe never changes pool
   * state. The credit balances are deliberately NOT part of this answer: they
   * carry no reset time, and the server remains the final gate on them.
   */
  async probeWindowLimits(apiKey: string): Promise<{ exceeded: boolean; resetAt: number } | undefined> {
    try {
      const connection = this.deps.options()
      const { record: parsed } = await this.fetchJson(
        `${connection.apiBase}/alpha/billing/credits`,
        await this.accountHeaders(apiKey),
      )
      if (parsed === undefined) return undefined
      const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : undefined
      if (windowLimits === undefined) return undefined
      let reported = false
      let exceeded = false
      let resetAt = 0
      for (const raw of [windowLimits.fiveHour, windowLimits.weekly]) {
        const window = isRecord(raw) ? parseWindowLimit(raw) : undefined
        if (window === undefined) continue
        reported = true
        if (!window.exceeded) continue
        exceeded = true
        // Same untrusted-magnitude rule as the rejection body's reset: a value
        // beyond the horizon is not a reset this route can act on, and pinning
        // a cooldown to it would keep the account out of rotation for the life
        // of the process (nothing probes a `cooldown`). Dropping it leaves the
        // mark `unknown`, which the next probe pass re-checks.
        if (window.resetAt > 0 && window.resetAt - Date.now() <= MAX_TRUSTED_RESET_MS) {
          resetAt = Math.max(resetAt, window.resetAt)
        }
      }
      // No window in the payload at all: nothing can be concluded, so the
      // caller keeps the mark (fail-safe, exactly like a failed probe).
      if (!reported) return undefined
      return { exceeded, resetAt: exceeded ? resetAt : 0 }
    } catch {
      return undefined
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const timing = openRequestTiming(options.model, this.deps.onRequestTiming)
    let outcome: 'finished' | 'error' | 'aborted' | 'cancelled' = 'cancelled'
    let errorCode: string | undefined
    try {
      for await (const chunk of this.streamRequest(options, timing)) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
          timing.first('firstContentMs')
        }
        if (chunk.type === 'finish') outcome = 'finished'
        yield chunk
      }
    } catch (error) {
      outcome = options.signal?.aborted ? 'aborted' : 'error'
      errorCode = error instanceof LlmError ? error.code : 'unknown'
      throw error
    } finally {
      await timing.close(outcome, errorCode)
    }
  }

  /**
   * One turn, with at most one output-ceiling downshift.
   *
   * The ceiling a model accepts is not published anywhere the request can be
   * built from (see `modelOutputTokenLimit`), and the endpoint states it only
   * by refusing. That refusal is worth one retry rather than a failed turn: the
   * harness's own recovery for it — compact the context — cannot help, because
   * nothing about the context is wrong, and resending the identical request
   * would be refused identically (issue #71). Reading the stated ceiling off
   * the rejection turns one wasted turn into one, for good: it is recorded
   * process-wide, so the next request for this model is built correctly
   * without spending the round trip again.
   *
   * Only BEFORE the first chunk reaches the host. Once a delta has been
   * delivered the answer is already partly on screen, and a second request
   * would duplicate it — so from that point the error stands and says what is
   * actually wrong. One downshift per turn, and a second refusal surfaces.
   */
  private async *streamRequest(options: GenerateOptions, timing: RequestTiming): AsyncIterable<StreamChunk> {
    for (let attempt = 0; ; attempt++) {
      const connection = this.deps.options()
      // Set before the hand-off, not after: a consumer that tears down on the
      // chunk has already seen it.
      let delivered = false
      try {
        for await (const chunk of this.streamAttempt(options, timing, connection)) {
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        const ceiling = delivered ? undefined : outputCeilingRefusal(connection.apiBase, options.model, error)
        if (attempt > 0 || ceiling === undefined) throw error
      }
    }
  }

  private async *streamAttempt(
    options: GenerateOptions,
    timing: RequestTiming,
    connection: C,
  ): AsyncIterable<StreamChunk> {
    this.currentCatalogState(connection)
    if (options.stop?.length) {
      // The Command Code wire format has no documented stop field; refuse
      // loudly instead of silently dropping a request field.
      throw new LlmError('Command Code adapter does not support stop sequences', 'UNSUPPORTED_OPTION')
    }
    const hasImages = options.messages.some(hasImageContent)
    // Per-call request-image resolver, set only when this request carries images.
    // Local, not an instance field: concurrent streams must never read each
    // other's resolver.
    let readImage: ReadRequestImage | undefined
    if (hasImages) {
      // Model-capability gate: only models the official registry lists with
      // Vision accept images natively. Command Code's own CLI falls back to a
      // client-side VISION side-call for text-only models; this adapter does
      // not reproduce that interactive feature, so it refuses loudly instead
      // of sending bytes to a model that cannot read them.
      if (!KNOWN_IMAGE_MODELS.has(options.model)) {
        throw new LlmError(
          `Command Code model "${options.model}" does not support image input;`
          + ' switch to a Vision-capable model (see the model registry)',
          'UNSUPPORTED_CONTENT',
        )
      }
      // Attachment seam: images arrive as durable references; resolving them
      // requires the host's attachment service.
      const attachments = this.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'Command Code image input requires the durable attachment service',
          'UNSUPPORTED_CONTENT',
        )
      }
      readImage = requestImages(attachments, options.signal, timing)
    }

    // The model id reaches key resolution so hosts with model→account routing
    // rules can pick the account that covers this model.
    const finishCredentials = timing.phase('credentials')
    let apiKey: string
    try { apiKey = await this.deps.resolveApiKey(connection, options.model) } finally { finishCredentials() }
    // Cap maxTokens from the in-memory catalog: it warms via listModels /
    // resolveModel on picker paths, and a fresh-process catalog must not add
    // a models fetch (and its failure modes) in front of every generate.
    const modelEntry = this.catalog.find((m) => m.id === options.model)
    // A catalog that has not warmed yet must still respect the model's own
    // output ceiling: the Messages endpoint refuses a `max_tokens` above it by
    // name, and falling back to the global default here would fail every first
    // request of a fresh process for a Messages-route model.
    //
    // Both candidates are ceilings, so the smaller binds. A warm catalog row is
    // a context-derived estimate (see parseCatalogResponse), and a value the
    // endpoint has already named outranks any estimate — otherwise a learned
    // limit would be masked by a catalog that warmed from the same guess.
    const modelMax = Math.min(
      modelEntry?.maxTokens ?? Infinity,
      modelOutputTokenLimit(connection.apiBase, options.model),
    )
    const requestedMaxTokens = Math.min(
      options.maxTokens ?? modelMax,
      modelMax,
      DEFAULT_GENERATE_MAX_TOKENS,
    )
    let maxTokens = requestedMaxTokens
    let contextBudget: RequestContextBudget = { maxTokens, sizePressure: false }

    const effort = options.reasoningEffort as string | undefined
    const supported = KNOWN_EFFORTS[options.model]
    const reasoningEffort =
      effort && effort !== 'off' && supported?.includes(effort) ? effort : undefined

    const systemText = [
      options.system ?? '',
      ...options.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content.map(blockText).filter(Boolean).join('\n')),
    ]
      .filter(Boolean)
      .join('\n\n')

    // Endpoint protocol: billing/cache may know Go plan -> CLI; unknown
    // accounts default to the documented Provider Chat Completions surface
    // (`resolveProtocol()` routes Claude to Messages on Provider API access).
    let protocol: CommandCodeProtocol = this.resolveProtocol(connection.apiBase, apiKey, options.model)
    // Image budget (issue #37): the body is built from the PROJECTED history,
    // never the raw one. Rung 0 is the standing budget; a 413 below steps down
    // the ladder. The session surface owns the offload set, so this throws
    // `IMAGE_OFFLOAD_REQUIRED` when more images must go; the retry then
    // arrives with the surface already updated.
    let requestOptions = withSurfaceOffload(
      options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0]!,
      connection.offloadSeenImagesForCache === true && protocol === 'cli' ? options.model : undefined,
    )
    const buildBody = async (target: CommandCodeProtocol): Promise<Record<string, unknown>> => {
      const finishBody = timing.phase('body')
      try {
      const facts = {
        maxTokens: requestedMaxTokens,
        reasoningEffort,
        // Reuse the lookup `stream()` already did: a model with no effort
        // levels offers nothing for the thinking switch to control.
        selectableEffort: supported !== undefined && supported.length > 0,
        systemText,
        readImage,
      }
      const built = target === 'cli'
        ? await buildCliBody(requestOptions, connection, facts)
        : target === 'messages'
          ? await buildMessagesBody(requestOptions, facts)
          : await buildOpenAIBody(requestOptions, facts)
      contextBudget = requestContextBudget(
        target, built, requestOptions.messages, options.model, modelEntry?.contextWindow, requestedMaxTokens,
      )
      maxTokens = contextBudget.maxTokens
      if (target === 'cli') recordOrEmpty(built.params).max_tokens = maxTokens
      else built.max_tokens = maxTokens
      return built
      } finally { finishBody() }
    }
    let body: Record<string, unknown> = await buildBody(protocol)
    const serializedBodies = new WeakMap<Record<string, unknown>, string>()

    // The opt-in trace now starts before the first connect attempt so a cache
    // miss can be correlated with the exact request shape that produced it.
    // The record contains hashes and counts only; see requestFingerprint().
    const trace = openStreamTrace(`${options.provider}/${options.model}`)

    // Account rotation loop: the first attempt uses the pool's active key; a
    // pre-stream 429/401 rotates to the next account (at most one attempt per
    // distinct key, hard-capped so a misbehaving hook cannot loop forever).
    // requestTimeoutMs bounds the headers wait of EACH attempt (see
    // connectGenerate); the body is account-independent, nothing has
    // streamed yet, so the switch is invisible to the caller.
    const tried = new Set<string>()
    let attemptNumber = 0
    let responseMetadata: ResponseMetadata = { protocol, headers: {} }
    const connectDeps: GenerateConnectDeps = {
      options, connection, fetchImpl: this.fetchImpl, timing,
      onResponse: (response) => {
        // Any answer from the gateway ends a header-timeout streak, whatever
        // its status: the silence being measured is over.
        this.headerTimeoutStreaks.delete(options.sessionId ?? GLOBAL_HEADER_TIMEOUT_KEY)
        responseMetadata = { protocol, headers: responseIdentifiers(response.headers) }
        trace.record('response', {
          protocol,
          endpoint: protocolEndpoint(protocol, connection.apiBase),
          status: response.status,
          attempt: attemptNumber,
          accountsTried: tried.size,
          maxTokens,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          headers: responseMetadata.headers,
        })
      },
    }
    let connected: { response: Response; cleanup: () => void } | undefined
    try {
      for (;;) {
        tried.add(apiKey)
        attemptNumber++
        responseMetadata = { protocol, headers: {} }
        if (trace.enabled) trace.record('request', {
          attempt: attemptNumber,
          sessionId: options.sessionId,
          ...requestFingerprint(protocol, body),
        })
        let serialized = serializedBodies.get(body)
        if (serialized === undefined) {
          const finishSerialization = timing.phase('serialization')
          // The replacer runs at the one boundary every transport and every
          // field crosses, so a lone surrogate anywhere in the body is removed
          // before it can reach the wire. Non-string values pass through the
          // identity path, and a string without surrogates is returned as-is.
          try {
            serialized = JSON.stringify(body, (_key, value: unknown) => sanitizeSurrogates(value))
          } finally { finishSerialization() }
          serializedBodies.set(body, serialized)
        }
        const attempt = await connectGenerate(connectDeps, apiKey, protocol, serialized)
        if ('response' in attempt) {
          connected = attempt
          break
        }
        const providerError = parseProviderError(attempt.errText)
        // The Provider API is the preferred surface for non-Go accounts. If the
        // gateway says the key is on the Go plan (the only plan without API
        // access), retry the same key through /alpha/generate without burning
        // the double TTFT on every later request.
        //
        // The Messages surface is included, but its downgrade is NOT cached:
        // the cache is keyed by gateway and API key, and a Claude-only refusal says
        // nothing about the account's other models, so remembering it would
        // drag DeepSeek, GLM and Qwen off the Provider API for the whole TTL
        // (issue #46). A Go-plan account never reaches here in the first place
        // — its cached billing tier already routes it to the CLI transport.
        if (
          protocol !== 'cli'
          && isUpgradeRequiredError(attempt.status, attempt.errText, providerError)
        ) {
          const wasMessages = protocol === 'messages'
          protocol = 'cli'
          if (!wasMessages) this.rememberProtocol(connection.apiBase, apiKey, 'cli')
          requestOptions = withSurfaceOffload(
            options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0]!,
            connection.offloadSeenImagesForCache === true ? options.model : undefined,
          )
          body = await buildBody('cli')
          continue
        }
        // Request too large (issue #37): the standing budget is only an
        // estimate — the cap also covers text and tool bytes — so one 413 steps
        // the image budget down and asks for another offload, as a durable
        // surface mutation rather than a local edit, so the extra omissions
        // survive the retry. Zero missing means the images are already gone and
        // the body is simply too big: fall through to the 413 diagnosis instead
        // of asking for an offload that cannot happen, which is also what keeps
        // the branch from looping.
        if (attempt.status === 413 && REQUEST_IMAGE_BUDGETS.length > 1) {
          const missing = this.surfaceOffload.requiredImageOffload(
            requestOptions.messages,
            coreBudget(REQUEST_IMAGE_BUDGETS[1]!),
            imageVersionBytes,
          )
          if (missing > 0) throw imageOffloadRequired(missing)
        }
        const rotate = this.deps.rotateApiKey
        // Account-scoped rejection (429/RATE_LIMITED, 401, or "this account
        // cannot serve"): retry the same body with another account when the host
        // has one. The tried set travels along so a rejection that does not mark
        // the key cannot make the pool re-offer it forever.
        const rejection = classifyAccountRejection(attempt.status, attempt.errText, providerError)
        if (
          rejection !== undefined
          && rotate !== undefined
          && options.signal?.aborted !== true
          && tried.size < MAX_ACCOUNT_ROTATIONS
        ) {
          const next = await rotate(apiKey, rejection.reason, connection, options.model, {
            tried: [...tried],
            ...(rejection.resetAtMs !== undefined && { resetAtMs: rejection.resetAtMs }),
          })
          if (next !== undefined && !tried.has(next)) {
            apiKey = next
            // 降级只描述上一账号；新账号必须按自己的套餐/缓存重新选择通道。
            const nextProtocol = this.resolveProtocol(connection.apiBase, apiKey, options.model)
            if (nextProtocol !== protocol) {
              protocol = nextProtocol
              requestOptions = withSurfaceOffload(
                options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0]!,
                connection.offloadSeenImagesForCache === true && protocol === 'cli' ? options.model : undefined,
              )
              body = await buildBody(protocol)
            }
            continue
          }
        }
        // The provider named a window limit — or refused the request as a plain
        // throttle — and no other account could serve. The turn must fail as a
        // RATE_LIMIT carrying that reset rather than as the generic
        // `PROVIDER_HTTP_ERROR` this status maps to: the CLI accepts the
        // `RATE_LIMITED` code on ANY status, and `PROVIDER_HTTP_ERROR` sits
        // outside dsh-llm-retry's whitelist — so without this the turn dies on
        // the spot even though the provider said exactly when the same request
        // would work again.
        //
        // The two reasons keep their own wording: only a NAMED window may be
        // described as a spent window (issue #54), while a plain throttle says
        // what it is and leaves the window verdict to the pool's own diagnosis.
        // 只有明确的额度窗口保留长等待；普通限流使用独立的短重试预算。
        if (
          rejection !== undefined
          && (rejection.reason === 'rate-limit' || rejection.reason === 'throttled')
        ) {
          const reset = rejection.resetAtMs
          const wait = reset === undefined
            ? (attempt.retryAfterMs ?? 0)
            : Math.min(Math.max(1000, reset - Date.now()), RETRY_MAX_DELAY_MS)
          const when = reset === undefined ? undefined : new Date(reset).toISOString()
          const window = rejection.reason === 'rate-limit'
          throw bilingual(
            window ? 'RATE_LIMIT' : THROTTLED_CODE,
            (window
              ? 'llm-commandcode: the Command Code account is rate limited'
              : 'llm-commandcode: the Command Code account is rate limited (429)'
                + ' — the provider did not report an exhausted usage window')
              + (when === undefined ? '' : ` — the provider reports it resets at ${when}`),
            (window
                ? '当前 Command Code 账户已被限流'
                : '当前 Command Code 账户被限流（429），服务商未报告用量窗口用尽')
              + (when === undefined ? '' : `，服务商给出的重置时间为 ${when}`),
            { status: attempt.status, ...(wait > 0 && wait <= RETRY_MAX_DELAY_MS ? { providerRetryAfterMs: wait } : {}) },
          )
        }
        throw generateHttpError(attempt.status, attempt.errText, attempt.retryAfterMs, providerError, contextBudget.sizePressure)
      }
    } catch (error) {
      trace.record('connect-error', { message: boundTraceText(errorChain(error)), responseMetadata })
      trace.close()
      if (options.signal?.aborted) throw error
      throw failureWithRequestId(
        this.gradeHeaderTimeout(error, protocol, body, connection.requestTimeoutMs, options.sessionId),
        responseMetadata,
      )
    }
    if (connected === undefined) {
      // Unreachable: the loop only exits via `break` or `throw`. The guard
      // keeps the narrowing explicit.
      throw new LlmError('Command Code API connection failed without a response', 'TRANSPORT')
    }
    const { response, cleanup } = connected
    if (!response.body) {
      cleanup()
      trace.record('end', { outcome: 'empty', code: 'PROVIDER_PROTOCOL_ERROR' })
      trace.close()
      throw failureWithRequestId(new LlmError('Command Code API returned no response body', 'PROVIDER_PROTOCOL_ERROR'), responseMetadata)
    }

    // --- SSE/JSONL event stream -> harness StreamChunk protocol ---
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // The request fingerprint was recorded before connect; this is the
    // response half of the same opt-in trace. See ./stream-trace.ts for why
    // the raw response stream remains the artifact that separates a provider
    // cut from a parser miss.
    const streamStartedAt = Date.now()
    let chunkCount = 0
    let totalBytes = 0
    let lastChunkAt = streamStartedAt

    // Stream idle watchdog: a generation that stalls this long has a dead
    // connection (the API keeps the socket open between reasoning/text
    // bursts). The default (300s) is deliberately generous — frontier
    // reasoning models can legitimately stay silent for minutes while
    // thinking, and the official CLI sets no idle cap at all. reader.cancel()
    // unblocks a pending read(), which the loop then turns into a TIMEOUT
    // failure instead of hanging forever.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let idleFired = false
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleFired = true
        void reader.cancel().catch(() => undefined)
      }, connection.streamIdleTimeoutMs)
    }
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const asm = createBlockAssembler()
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    let usage: TokenUsage | undefined
    let usageEmitted = false
    let endRecorded = false
    // Do not publish success until the assembled answer has been checked.
    // DSH converts an adapter throw into an error finish; throwing AFTER a
    // success finish would violate its single-terminal-event contract.
    function* handle(event: unknown): Generator<StreamChunk> {
      captureResponseIdentifiers(responseMetadata, event)
      for (const chunk of handleEvent(asm, protocol, event)) {
        if (chunk.type === 'finish') finish = chunk
        else if (chunk.type === 'usage') usage = chunk.usage
        else yield chunk
      }
    }
    try {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>
        armIdle()
        try {
          read = await reader.read()
        } catch (error: unknown) {
          // A mid-stream transport failure (connection reset, TLS teardown)
          // surfaces here. Caller cancellation propagates as-is.
          if (options.signal?.aborted) throw error
          trace.record('read-error', {
            chunks: chunkCount,
            bytes: totalBytes,
            silentMs: Date.now() - lastChunkAt,
            message: errorChain(error),
          })
          throw bilingual(
            'TRANSPORT',
            `Command Code API stream from ${connection.apiBase} failed while reading: ${errorChain(error)}`,
            'Command Code API 流式响应中途断开——网络波动所致，重试通常可恢复',
            { cause: error },
          )
        } finally {
          clearIdle()
        }
        const { done, value } = read
        if (done) {
          // The idle watchdog cancels the reader to unblock a stalled read;
          // cancel() resolves a pending read() as done, so a done here after
          // the watchdog fired is a timeout, not a normal stream end.
          trace.record('eof', {
            chunks: chunkCount,
            bytes: totalBytes,
            silentMs: Date.now() - lastChunkAt,
            totalMs: Date.now() - streamStartedAt,
            finishSeen: finish !== undefined,
            idleFired,
            buffered: buffer.length,
          })
          if (idleFired) {
            throw bilingual(
              'TIMEOUT',
              `Command Code API stream from ${connection.apiBase} was idle for ${connection.streamIdleTimeoutMs}ms`
              + ' (no events) and was treated as a dead connection',
              `Command Code API 流式响应已 ${connection.streamIdleTimeoutMs} 毫秒无任何事件，被判定为死连接——长思考模型可在设置中调大流空闲超时`,
            )
          }
          if (buffer.trim()) {
            // The final line may lack its trailing newline; it uses the same
            // terminal validation as events parsed in the line loop.
            yield* handle(parseStreamEventLine(buffer))
          }
          break
        }
        const text = decoder.decode(value, { stream: true })
        if (value.byteLength > 0) timing.first('firstByteMs')
        buffer += text
        chunkCount += 1
        totalBytes += value.byteLength
        lastChunkAt = Date.now()
        trace.record('chunk', {
          n: chunkCount,
          bytes: value.byteLength,
          text: boundTraceText(text),
        })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          yield* handle(parseStreamEventLine(line))
        }
        if (finish !== undefined) break
      }
      // Preserve the provider's usage even when this attempt fails. Usage is
      // cumulative, so only the latest sample is emitted, before the terminal.
      if (usage !== undefined) {
        usageEmitted = true
        yield { type: 'usage', usage }
      }
      if (finish !== undefined) {
        const failure = asm.sawContent ? undefined : emptyCompletionError(asm.finishReason, maxTokens, usage)
        trace.record('end', {
          outcome: failure === undefined ? 'finished' : failure.code === 'OUTPUT_TOKEN_LIMIT' ? 'output-token-limit' : 'empty',
          finishReason: asm.finishReason,
          ...(failure === undefined ? {} : { code: failure.code }),
          maxTokens,
          ...(usage === undefined ? {} : { usage }),
          chunks: chunkCount,
          bytes: totalBytes,
          totalMs: Date.now() - streamStartedAt,
          sawContent: asm.sawContent,
          responseMetadata,
        })
        endRecorded = true
        if (failure !== undefined) throw failure
        // One envelope for both halves: response-level correlation ids and,
        // on the Messages transport, the per-block thinking signature the next
        // request must replay. DSH discards the whole envelope when `blocks`
        // does not line up with the emitted block count, so the array is
        // indexed by the same chunk index that was allocated at block-start.
        const replayBlocks = asm.replayBlocks
        const carryReplay = hasResponseIdentifiers(responseMetadata) || replayBlocks.length > 0
        yield carryReplay
          ? {
              ...finish,
              replayState: {
                response: responseMetadata,
                ...(replayBlocks.length > 0 ? { blocks: replayBlocks } : {}),
              },
            }
          : finish
      } else {
        // The stream ended without its terminal event, and that is NOT a normal
        // ending — it must not be reported as one. Both transports terminate
        // explicitly (the CLI transport with a `finish` event, the Provider API
        // with a final `finish_reason` chunk), so an EOF here means the response
        // was closed mid-generation: the gateway, an intermediary proxy, or the
        // network. Synthesizing a clean `stop` is what turned a truncated answer
        // into a turn that just ended, with nothing saying why
        // (`dsh-llm-deepseek`'s `translate()` raises this same code for this
        // same condition).
        const elapsed = Date.now() - streamStartedAt
        const detail = `${chunkCount} chunk(s), ${totalBytes} bytes, ${elapsed}ms`
        trace.record('end', {
          outcome: asm.sawContent ? 'stream-closed' : 'empty',
          chunks: chunkCount,
          bytes: totalBytes,
          totalMs: elapsed,
          sawContent: asm.sawContent,
          responseMetadata,
        })
        endRecorded = true
        if (!asm.sawContent) {
          // Nothing usable came out of it (no visible text, no tool call): the
          // request has no tool action to replay, and this code is in the retry
          // policy's whitelist — the cut is absorbed instead of surfaced. A cut
          // during a long thinking phase lands here.
          throw bilingual('EMPTY_RESPONSE', 'Command Code returned an empty response', 'Command Code 返回了空响应，重试通常可恢复')
        }
        throw bilingual(
          'STREAM_CLOSED',
          `Command Code API stream from ${connection.apiBase} ended before its finish event (${detail})`
          + ' — the response was closed mid-generation, so this is not the model stopping by itself',
          'Command Code API 流式响应在结束事件之前被关闭（生成中途断流），并非模型主动结束——请重试'
          + `；若频繁出现，可用 ${STREAM_TRACE_ENV}=<文件路径> 抓取原始流以定位断流原因`,
        )
      }
    } catch (error: unknown) {
      // A later read/provider error must not discard usage already received.
      if (!usageEmitted && usage !== undefined) yield { type: 'usage', usage }
      if (!endRecorded) {
        trace.record('end', {
          outcome: options.signal?.aborted ? 'aborted' : 'error',
          code: error instanceof LlmError ? error.code : 'unknown',
          finishReason: asm.finishReason,
          maxTokens,
          ...(usage === undefined ? {} : { usage }),
          sawContent: asm.sawContent,
          chunks: chunkCount,
          bytes: totalBytes,
          totalMs: Date.now() - streamStartedAt,
          responseMetadata,
        })
      }
      throw options.signal?.aborted ? error : failureWithRequestId(error, responseMetadata)
    } finally {
      clearIdle()
      cleanup()
      trace.close()
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
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
function parseProviderError(errText: string): ParsedProviderError {
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

function generateHttpError(
  status: number,
  errText: string,
  retryAfterMs?: number,
  parsed: ParsedProviderError = parseProviderError(errText),
  sizePressure = false,
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
  // The gateway can wrap an over-reserved request in a generic provider_error
  // 400 with no context wording. That phrase alone also covers unrelated
  // upstream failures, so use the known model window and THIS request's size
  // pressure before asking the harness to compact. Do not turn an ordinary
  // empty stream, timeout, or small provider_error into a false overflow.
  if (status === 400 && sizePressure && AMBIGUOUS_SIZE_REJECTION.test(providerDetail)
    && /\bprovider_error\b/i.test(providerDetail)) {
    return bilingual(
      CONTEXT_WINDOW_EXCEEDED_CODE,
      'Command Code API error 400: the provider could not complete a request near the model context limit'
      + ' — compacting the session and retrying',
      'Command Code API 返回 400：请求接近模型上下文上限，服务商无法完成——正在压缩上下文后重试',
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
  return new LlmError(
    `Command Code API error ${status}${detail === `HTTP ${status}` ? '' : ` (${detail})`}: ${errText.slice(0, 500)}`,
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
 * Handle one CLI-transport (`/alpha/generate`) stream event, appending
 * harness StreamChunks. Pure over the passed assembler — no stream() locals.
 */
function handleCliEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks

  switch (event.type) {
    case 'text-delta': {
      chunks.push(...closeReasoning(asm))
      if (asm.textIndex < 0) {
        asm.textIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.textIndex, blockType: 'text' })
      }
      const delta = stringValue(event.text) ?? ''
      asm.textContent += delta
      if (delta.trim() !== '') asm.sawContent = true
      chunks.push({ type: 'text-delta', index: asm.textIndex, text: delta })
      break
    }
    case 'reasoning-delta': {
      chunks.push(...closeText(asm))
      if (asm.reasoningIndex < 0) {
        asm.reasoningIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.reasoningIndex, blockType: 'reasoning' })
      }
      const delta = stringValue(event.text) ?? ''
      asm.reasoningContent += delta
      chunks.push({ type: 'reasoning-delta', index: asm.reasoningIndex, text: delta })
      break
    }
    case 'reasoning-start':
      chunks.push(...closeText(asm))
      break
    case 'reasoning-end':
      chunks.push(...closeReasoning(asm))
      break
    case 'tool-call': {
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const id = stringValue(event.toolCallId) ?? randomUUID()
      const name = stringValue(event.toolName) ?? ''
      const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments))
      const index = asm.nextIndex++
      asm.sawContent = true
      chunks.push(
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args },
        {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
        },
      )
      break
    }
    case 'cache-write-tokens': {
      const cacheWrite = numberValue(event.cacheWriteTokens)
      if (cacheWrite !== undefined && cacheWrite >= 0) asm.cliCacheWriteTokens = cacheWrite
      break
    }
    case 'finish': {
      asm.finishReason = stringValue(event.finishReason)
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
      const capturedCacheWrite = asm.cliCacheWriteTokens
      if (usage || capturedCacheWrite !== undefined) {
        const details = isRecord(usage?.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const totalInput = numberValue(usage?.inputTokens) ?? 0
        const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
        const reportedCacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
        const cacheWrite = reportedCacheWrite === 0 && capturedCacheWrite !== undefined
          ? capturedCacheWrite
          : reportedCacheWrite
        // Harness TokenUsage counts are disjoint: uncached input only.
        const tokenUsage: TokenUsage = {
          inputTokens:
            numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
          outputTokens: numberValue(usage?.outputTokens) ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        }
        const outputDetails = isRecord(usage?.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const reasoningTokens = numberValue(outputDetails?.reasoningTokens) ?? numberValue(usage?.reasoningTokens)
        if (reasoningTokens !== undefined) tokenUsage.reasoningTokens = reasoningTokens
        chunks.push({ type: 'usage', usage: tokenUsage })
      }
      chunks.push({ type: 'finish', reason: mapFinishReason(event.finishReason) })
      break
    }
    case 'error': {
      // Classification lives in streamErrorToLlmError, shared with the
      // Provider API transport's own in-band error member so the two cannot
      // drift: a stream error that is explicitly non-retryable, carries a
      // terminal marker (quota/plan/credits), or reports a non-retryable HTTP
      // status is a hard failure, and a context-window rejection is the
      // harness's CONTEXT_WINDOW_EXCEEDED (compact and retry). Anything else
      // is a transient mid-stream drop the retry policy should repeat.
      throw streamErrorToLlmError(event.error, stringValue(event.message))
    }
  }
  return chunks
}

/**
 * Handle one OpenAI-transport (`/provider/v1/chat/completions`) SSE event.
 * Same assembler contract as {@link handleCliEvent}; tool-call fragments
 * buffer on the assembler and flush at finish.
 */
function handleOpenAIEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks
  // The Provider API transport reports a mid-stream failure as an `error` member
  // of an SSE chunk rather than as an event type of its own; ignoring it let
  // the stream end with no finish event, so a context-window or quota rejection
  // surfaced only as a generic EMPTY_RESPONSE (which the retry policy repeats)
  // and the real cause was lost.
  if (event.error !== undefined) throw streamErrorToLlmError(event.error, stringValue(event.message))
  const choices = event.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    // A standalone usage chunk (some OpenAI-compatible servers send it
    // before [DONE]) still carries usage.
    if (event.usage !== undefined) {
      chunks.push({ type: 'usage', usage: mapOpenAIUsage(event.usage) })
    }
    return chunks
  }
  const choice = isRecord(choices[0]) ? choices[0] : {}
  const delta = isRecord(choice.delta) ? choice.delta : {}

  // Thinking text arrives under a different field per model family, and the
  // gateway does not normalize the spelling: DeepSeek answers with the scalar
  // `reasoning` PLUS a `reasoning_details` array, GLM/Qwen/Kimi with the
  // DeepSeek-native `reasoning_content`, and the OpenAI family with the scalar
  // `reasoning` PLUS a `reasoning_details` array whose entry is
  // `{ type: 'reasoning.summary', summary }` (measured live 2026-09-18 on
  // gpt-5.6-luna, 6/6 rounds: the scalar and the array's `summary` carried the
  // identical text every time). All three spellings are read here, in that
  // order, so no family's thinking is dropped; the scalar wins over the array,
  // which is a forward guard rather than the live path for any family (every
  // family that sends the array also sends a scalar alongside it). See
  // {@link reasoningDetailsText} for the array's two vocabularies.
  const reasoningDelta =
    nonEmptyText(stringValue(delta.reasoning))
    ?? nonEmptyText(stringValue(delta.reasoning_content))
    ?? reasoningDetailsText(delta.reasoning_details)
    ?? ''
  if (reasoningDelta !== '') {
    chunks.push(...closeText(asm))
    if (asm.reasoningIndex < 0) {
      asm.reasoningIndex = asm.nextIndex++
      chunks.push({ type: 'block-start', index: asm.reasoningIndex, blockType: 'reasoning' })
    }
    asm.reasoningContent += reasoningDelta
    chunks.push({ type: 'reasoning-delta', index: asm.reasoningIndex, text: reasoningDelta })
  }

  const contentDelta = stringValue(delta.content) ?? ''
  if (contentDelta !== '') {
    chunks.push(...closeReasoning(asm))
    if (asm.textIndex < 0) {
      asm.textIndex = asm.nextIndex++
      chunks.push({ type: 'block-start', index: asm.textIndex, blockType: 'text' })
    }
    asm.textContent += contentDelta
    if (contentDelta.trim() !== '') asm.sawContent = true
    chunks.push({ type: 'text-delta', index: asm.textIndex, text: contentDelta })
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const rawCall of delta.tool_calls) {
      if (!isRecord(rawCall)) continue
      asm.sawContent = true
      const callIndex = numberValue(rawCall.index) ?? 0
      let existing = asm.openAiToolCalls.find((call) => call.index === callIndex)
      const fn = isRecord(rawCall.function) ? rawCall.function : undefined
      const id = stringValue(rawCall.id)
      const name = fn === undefined ? undefined : stringValue(fn.name)
      const argDelta = fn === undefined
        ? undefined
        : (stringValue(fn.arguments) ?? (fn.arguments === undefined ? '' : JSON.stringify(fn.arguments)))
      if (!existing) {
        existing = {
          index: callIndex,
          name: name ?? '',
          arguments: argDelta ?? '',
        }
        if (id !== undefined) existing.id = id
        asm.openAiToolCalls.push(existing)
      } else {
        if (id !== undefined && existing.id === undefined) existing.id = id
        if (name !== undefined && existing.name === '') existing.name = name
        if (argDelta !== undefined) existing.arguments += argDelta
      }
    }
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    asm.finishReason = stringValue(choice.finish_reason)
    chunks.push(...closeText(asm), ...closeReasoning(asm), ...emitOpenAiToolCalls(asm))
    if (event.usage !== undefined) {
      chunks.push({ type: 'usage', usage: mapOpenAIUsage(event.usage) })
    }
    chunks.push({ type: 'finish', reason: mapFinishReason(choice.finish_reason) })
  }
  return chunks
}

/** Dispatch one parsed stream event to the active transport's handler. */
/**
 * Messages `usage` → the harness meter.
 *
 * The field names are the Anthropic ones, and unlike Chat Completions
 * `input_tokens` already excludes cache reads and writes, so it is mapped
 * as-is rather than reduced (the shape `dsh-llm-deepseek` implements).
 * Measured 2026-09-29: `{ input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens, output_tokens_details:
 * { thinking_tokens } }`, plus gateway additions the meter ignores.
 */
function mapMessagesUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const inputTokens = numberValue(raw.input_tokens) ?? 0
  const outputTokens = numberValue(raw.output_tokens) ?? 0
  const cacheRead = numberValue(raw.cache_read_input_tokens) ?? 0
  const cacheWrite = numberValue(raw.cache_creation_input_tokens) ?? 0
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined
  const reasoningTokens = numberValue(details?.thinking_tokens)
  const usage: TokenUsage = {
    inputTokens: Math.max(0, inputTokens),
    outputTokens,
    cacheReadTokens: cacheRead,
  }
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/** The harness block type one Messages content block maps to. */
function messagesBlockType(native: Record<string, unknown>): MessagesBlockState['type'] | undefined {
  if (native.type === 'text') return 'text'
  if (native.type === 'thinking') return 'reasoning'
  if (native.type === 'tool_use') return 'tool-call'
  return undefined
}

/**
 * Handle one Messages-transport stream event, appending harness StreamChunks.
 *
 * The event sequence is the Anthropic one measured on 2026-09-29:
 * `message_start`, then per content block `content_block_start` /
 * `content_block_delta`* / `content_block_stop`, then `message_delta`
 * (carrying `stop_reason` and the final usage) and `message_stop`. A `ping`
 * keepalive interleaves freely and carries no content. The terminal chunks are
 * NOT emitted here: `stream()` holds the success finish until it has validated
 * the assembled answer, and it attaches the replay envelope.
 */
function handleMessagesEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks

  switch (event.type) {
    case 'message_start': {
      const message = isRecord(event.message) ? event.message : undefined
      const usage = mapMessagesUsage(message?.usage)
      if (usage) chunks.push({ type: 'usage', usage })
      break
    }
    case 'content_block_start': {
      const wireIndex = numberValue(event.index)
      const native = isRecord(event.content_block) ? event.content_block : undefined
      const type = native ? messagesBlockType(native) : undefined
      if (wireIndex === undefined || type === undefined) break
      // Allocate the harness index only for a block this route can represent,
      // so replayBlocks stays aligned with the emitted block count.
      const chunkIndex = asm.nextIndex++
      const state: MessagesBlockState = {
        type,
        text: stringValue(native?.text) ?? '',
        signature: stringValue(native?.signature) ?? '',
        json: '',
        id: stringValue(native?.id) ?? '',
        name: stringValue(native?.name) ?? '',
        chunkIndex,
      }
      asm.messagesBlocks.set(wireIndex, state)
      asm.replayBlocks[chunkIndex] = { type }
      chunks.push({ type: 'block-start', index: chunkIndex, blockType: type })
      if (type === 'tool-call' && state.id !== '') {
        chunks.push({
          type: 'tool-call-delta',
          index: chunkIndex,
          id: ToolCallId(state.id),
          name: state.name,
          argumentsDelta: '',
        })
      }
      break
    }
    case 'content_block_delta': {
      const wireIndex = numberValue(event.index)
      const state = wireIndex === undefined ? undefined : asm.messagesBlocks.get(wireIndex)
      const delta = isRecord(event.delta) ? event.delta : undefined
      if (!state || !delta) break
      const index = state.chunkIndex
      if (delta.type === 'text_delta' && state.type === 'text') {
        const text = stringValue(delta.text) ?? ''
        state.text += text
        if (text.trim() !== '') asm.sawContent = true
        chunks.push({ type: 'text-delta', index, text })
      } else if (delta.type === 'thinking_delta' && state.type === 'reasoning') {
        const text = stringValue(delta.thinking) ?? ''
        state.text += text
        chunks.push({ type: 'reasoning-delta', index, text })
      } else if (delta.type === 'signature_delta' && state.type === 'reasoning') {
        // Not model-visible content: it rides the replay envelope so the next
        // request can send the block back, never a reasoning delta.
        state.signature += stringValue(delta.signature) ?? ''
        const entry = asm.replayBlocks[index]
        if (entry) entry.signature = state.signature
      } else if (delta.type === 'input_json_delta' && state.type === 'tool-call') {
        const fragment = stringValue(delta.partial_json) ?? ''
        state.json += fragment
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.id),
          name: state.name,
          argumentsDelta: fragment,
        })
      }
      break
    }
    case 'content_block_stop': {
      const wireIndex = numberValue(event.index)
      if (wireIndex === undefined) break
      const state = asm.messagesBlocks.get(wireIndex)
      if (!state) break
      asm.messagesBlocks.delete(wireIndex)
      const index = state.chunkIndex
      if (state.type === 'text') {
        if (state.text.trim() !== '') asm.sawContent = true
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: state.text } })
      } else if (state.type === 'reasoning') {
        chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.text } })
      } else {
        if (state.id !== '') asm.sawContent = true
        chunks.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.json || '{}' },
        })
      }
      break
    }
    case 'message_delta': {
      const delta = isRecord(event.delta) ? event.delta : undefined
      const reason = stringValue(delta?.stop_reason)
      if (reason !== undefined) asm.finishReason = reason
      const usage = mapMessagesUsage(event.usage)
      if (usage) chunks.push({ type: 'usage', usage })
      chunks.push({ type: 'finish', reason: mapFinishReason(reason) })
      break
    }
    case 'message_stop':
    case 'ping':
      break
    case 'error':
      throw streamErrorToLlmError(event.error ?? event, stringValue(event.message))
    default:
      break
  }
  return chunks
}

function handleEvent(asm: BlockAssembler, protocol: CommandCodeProtocol, event: unknown): StreamChunk[] {
  if (protocol === 'cli') return handleCliEvent(asm, event)
  return protocol === 'messages' ? handleMessagesEvent(asm, event) : handleOpenAIEvent(asm, event)
}


/**
 * Parse an HTTP `Retry-After` value (delay-seconds or an HTTP-date) into
 * milliseconds; undefined when absent or unparseable. An HTTP-date in the
 * past yields 0, which the caller drops (LlmError wants a positive delay).
 * A delay-seconds value whose millisecond product is not finite (e.g. `1e308`)
 * also yields undefined: LlmError validates its options and would otherwise
 * replace the provider failure with an internal construction error.
 */
function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
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
 * Map a stream finish reason onto the harness taxonomy. The two transports
 * spell tool-calls differently (`tool-calls` on the CLI transport,
 * `tool_calls` on the OpenAI transport) but share every other reason, so
 * one function serves both — a new reason cannot drift between them.
 */
function mapFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool-calls' || reason === 'tool_calls' || reason === 'tool_use') return { kind: 'tool-calls' }
  if (
    reason === 'length' ||
    reason === 'max_tokens' ||
    reason === 'max-tokens' ||
    reason === 'max_output_tokens'
  ) {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/** A terminal marker without text or tools is a failed attempt, not a completed turn. */
function emptyCompletionError(reason: string | undefined, maxTokens: number, usage: TokenUsage | undefined): LlmError {
  const detail = `finish_reason=${reason ?? 'unknown'}, max_tokens=${maxTokens}, outputTokens=${usage?.outputTokens ?? 'unknown'}, reasoningTokens=${usage?.reasoningTokens ?? 'unknown'}`
  if (mapFinishReason(reason).kind === 'max-tokens') {
    // A length finish proves a generation limit, not how all tokens were spent.
    // Keep this outside the retry whitelist: replaying the identical budget
    // can repeatedly charge for reasoning without ever producing an answer.
    return bilingual(
      'OUTPUT_TOKEN_LIMIT',
      `Command Code reached the output token limit without producing answer text or a tool call (${detail})`,
      'Command Code 已达到输出 token 上限，但没有生成正文或工具调用；请调整思考强度，或在模型和接口上限内增加输出预算',
    )
  }
  if (reason === 'content_filter' || reason === 'content-filter') {
    return bilingual('CONTENT_FILTER', `Command Code filtered the response (${detail})`, 'Command Code 拦截了响应，未生成正文或工具调用')
  }
  return bilingual(
    'EMPTY_RESPONSE',
    `Command Code finished without producing answer text or a tool call (${detail})`,
    'Command Code 返回了空响应（可能只有思考内容），重试通常可恢复',
  )
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

function classifyAccountRejection(
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
const MAX_TRUSTED_RESET_MS = 30 * 24 * 60 * 60 * 1000

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
function isUpgradeRequiredError(
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

/** Map an OpenAI Chat Completions usage payload to harness disjoint counts. */
function mapOpenAIUsage(usage: unknown): TokenUsage {
  const source = isRecord(usage) ? usage : {}
  const promptTokens = numberValue(source.prompt_tokens) ?? 0
  const outputTokens = numberValue(source.completion_tokens) ?? 0
  const totalTokens = numberValue(source.total_tokens)
  const promptDetails = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : undefined
  const cacheRead = numberValue(promptDetails?.cached_tokens) ?? 0
  const cacheWrite = numberValue(promptDetails?.cache_creation_input_tokens) ?? 0
  const completionDetails = isRecord(source.completion_tokens_details) ? source.completion_tokens_details : undefined
  const reasoningTokens = numberValue(completionDetails?.reasoning_tokens)
  const usageOut: TokenUsage = {
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens,
    cacheReadTokens: cacheRead,
  }
  if (cacheWrite > 0) usageOut.cacheWriteTokens = cacheWrite
  if (reasoningTokens !== undefined) usageOut.reasoningTokens = reasoningTokens
  if (totalTokens !== undefined) usageOut.totalTokens = totalTokens
  return usageOut
}
