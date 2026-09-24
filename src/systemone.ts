/**
 * Host-side client for Command Code's System One decision endpoint
 * (`POST {apiBase}/provider/v1/systemone`).
 *
 * `typesafe/jev` is **not a chat model**: it takes a `state` plus typed
 * questions and answers with probabilities, never text, and it never streams.
 * It is therefore absent from `/provider/v1/models` (so the picker can never
 * offer it) and must never be registered as a model route — this plugin uses it
 * as an internal advisor instead: the command guard in `./command-guard.ts`
 * asks it whether a shell command is safe to auto-approve.
 *
 * The three question types are the whole vocabulary (command-code@1.65.0
 * `systemOneRequestSchema`, unchanged since 1.64.0):
 *
 * - `noul` — "is this true?", optional `criteria: { true, false }` describing
 *   each verdict. Answers with `noul`, the probability of *yes*.
 * - `choice` — "which one?", `criteria` maps each option key to its
 *   description. Answers with `choice`, plus optional `confidence` and
 *   `probabilities`.
 * - `score` — "where on this rubric?", `criteria` is an array of at least two
 *   levels, lowest first. Answers with `score`, `legend` and `probabilities`.
 *
 * A request carries at most 20 questions and every answer is keyed by the
 * question id it belongs to. `usage` is reported per request, in tokens.
 *
 * Billing: free through 2026-09-24T23:59:59Z, then $0.042 per 1M input tokens
 * with output free. The model has **no ZDR-capable upstream**, so a request
 * carrying `x-cmd-zdr: 1` is refused with HTTP 422 `cmd_zdr_no_providers` —
 * this client never sends that header, and it must stay that way even though
 * the plugin now ships a ZDR switch for chat (`Config.zdr` → the `x-cmd-zdr: 1`
 * header per model, gated on `KNOWN_NON_ZDR_MODELS`): the decision endpoint is
 * reached through THIS module's own request path, never through the adapter's
 * chat connection, so the two cannot drift — and a deployment that later widens
 * ZDR must exclude this endpoint rather than route it through the switch.
 *
 * Auth is the plugin's ordinary chain (the multi-account pool, the credentials
 * seam, the CLI auth file) through the same `Authorization: Bearer <key>` and
 * `x-command-code-version` headers every other endpoint uses.
 *
 * @module dsh-commandcode-provider/systemone
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { COMMAND_CODE_CLI_VERSION } from './adapter.ts'
import { IDENTITY_ENCODING_HEADER } from './response-encoding.ts'

/** Path of the decision endpoint, relative to `apiBase`. */
export const SYSTEMONE_ROUTE = '/provider/v1/systemone'

/** The one decision model the endpoint serves today (aliases: `jev`, `jev-latest`, `typesafe-ai/jev`). */
export const SYSTEMONE_MODEL = 'typesafe/jev'

/** Server-enforced ceiling on questions per request (command-code@1.65.0 `zP`). */
export const SYSTEMONE_MAX_QUESTIONS = 20

/** Milliseconds a decision may take before the caller gives up on it. */
export const SYSTEMONE_DEFAULT_TIMEOUT_MS = 1500

/** A criterion description: free-form JSON, rendered to the model as context. */
export type SystemOneInstructions =
  | string
  | number
  | boolean
  | null
  | readonly SystemOneInstructions[]
  | { readonly [key: string]: SystemOneInstructions }

/** One typed question. The `criteria` shape is fixed by the question's type. */
export type SystemOneQuestion =
  | {
    readonly type: 'noul'
    readonly instructions: SystemOneInstructions
    readonly criteria?: { readonly true?: SystemOneInstructions; readonly false?: SystemOneInstructions }
  }
  | {
    readonly type: 'choice'
    readonly instructions: SystemOneInstructions
    readonly criteria: { readonly [option: string]: SystemOneInstructions }
  }
  | {
    readonly type: 'score'
    readonly instructions: SystemOneInstructions
    readonly criteria: readonly SystemOneInstructions[]
  }

/** One decision request: the situation, and the typed questions about it. */
export interface SystemOneRequest {
  /** Decision model id; defaults to {@link SYSTEMONE_MODEL} at the call site. */
  readonly model?: string
  /** The situation under judgement — text, or any JSON the question can refer to. */
  readonly state: SystemOneInstructions
  /** Questions keyed by a stable id, echoed in the answers. At most {@link SYSTEMONE_MAX_QUESTIONS}. */
  readonly questions: { readonly [id: string]: SystemOneQuestion }
}

/** One parsed answer. Only the members this plugin consumes are kept. */
export type SystemOneAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | {
    readonly type: 'choice'
    readonly choice: string
    readonly confidence?: number
    readonly probabilities?: Readonly<Record<string, number>>
  }
  | {
    readonly type: 'score'
    readonly score: number
    readonly confidence?: number
    readonly probabilities?: Readonly<Record<string, number>>
  }

/** Per-request token usage as the endpoint reports it. */
export interface SystemOneUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** A parsed decision response. */
export interface SystemOneResponse {
  /** The model that answered, when the endpoint echoes one. */
  readonly model?: string
  /** Answers keyed by question id. */
  readonly answers: Readonly<Record<string, SystemOneAnswer>>
  /** Token usage, when the endpoint reports it. */
  readonly usage?: SystemOneUsage
}

/** Why a decision call produced no usable answer. */
export type SystemOneFailureKind =
  /** The request could not be built (no questions, too many, an invalid apiBase). */
  | 'invalid-request'
  /** No usable credential — the pool's own MISSING_CREDENTIAL / invalid-key surface. */
  | 'credential'
  /** The endpoint answered a non-2xx status. */
  | 'http'
  /** The connection failed before a response arrived. */
  | 'network'
  /** The decision did not arrive inside the caller's budget. */
  | 'timeout'
  /** The caller withdrew the request (the approval was answered elsewhere). */
  | 'aborted'
  /** A 2xx body that is not a decision response. */
  | 'invalid-response'

/** The one error type this client throws. Callers fail closed on it. */
export class SystemOneError extends Error {
  constructor(
    message: string,
    readonly kind: SystemOneFailureKind,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SystemOneError'
  }
}

/** Everything the client needs beyond the request itself. */
export interface SystemOneDeps {
  /** Provider API base URL, read per call (settings-aware). */
  apiBase: () => string
  /** Resolve a usable API key from the plugin's own chain. */
  resolveApiKey: () => Promise<string>
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Deadline plus the reason it fired, so a caller can tell a timeout from a withdrawal. */
interface SystemOneDeadline {
  readonly signal: AbortSignal
  /** Whether the caller's own signal was the one that aborted. */
  callerAborted: () => boolean
  /** Whether the timeout was the one that aborted. */
  timedOut: () => boolean
  /** Clear the timer and the caller listener; always called in a `finally`. */
  dispose: () => void
}

/**
 * Combine the caller's signal with a timeout, keeping the two distinguishable:
 * a timeout is this client's own budget expiring (the guard delegates to the
 * user) while a caller abort means the approval was already withdrawn (answer
 * nothing) — both fail closed, but the diagnosis must not lie about which.
 *
 * The timer is a plain `setTimeout` rather than `AbortSignal.timeout()`, whose
 * timer Node unrefs: with nothing else pending (a test double, a socket that
 * never opened) an unref'd timer lets the process exit while the promise is
 * still pending, which reads as a hang rather than as the timeout it is.
 */
function deadlineOf(signal: AbortSignal | undefined, timeoutMs: number): SystemOneDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = (): void => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  return {
    signal: controller.signal,
    callerAborted: () => signal?.aborted === true,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Whether a caught value is an abort-shaped failure. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Stop waiting for an operation that does not accept an AbortSignal. */
function withinDeadline<T>(operation: Promise<T>, deadline: SystemOneDeadline, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(deadline.callerAborted()
        ? new SystemOneError('decision request aborted', 'aborted')
        : new SystemOneError(`decision request timed out after ${timeoutMs}ms`, 'timeout'))
    }
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        deadline.signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        deadline.signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
    if (deadline.signal.aborted) onAbort()
  })
}

/** A finite number in `[0, 1]`, or undefined. */
function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

/** A finite number, or undefined. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A record of finite numbers (probabilities), or undefined when the shape is off. */
function numberRecord(value: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const parsed = finite(entry)
    if (parsed === undefined) return undefined
    out[key] = parsed
  }
  return out
}

/**
 * Parse one answer entry strictly by its own `type`. A body whose answer does
 * not carry the member its type promises is rejected rather than defaulted:
 * an absent probability is exactly the case the caller must not read as "safe".
 *
 * @param value - one raw entry from the response's `answers` object.
 * @returns the parsed answer, or undefined when the entry is malformed.
 */
export function parseSystemOneAnswer(value: unknown): SystemOneAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.type === 'noul') {
    const noul = probability(raw.noul)
    return noul === undefined ? undefined : { type: 'noul', noul }
  }
  if (raw.type === 'choice') {
    if (typeof raw.choice !== 'string' || raw.choice === '') return undefined
    const confidence = raw.confidence === undefined ? undefined : probability(raw.confidence)
    if (raw.confidence !== undefined && confidence === undefined) return undefined
    const probabilities = raw.probabilities === undefined ? undefined : numberRecord(raw.probabilities)
    if (raw.probabilities !== undefined && probabilities === undefined) return undefined
    return {
      type: 'choice',
      choice: raw.choice,
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities === undefined ? {} : { probabilities }),
    }
  }
  if (raw.type === 'score') {
    const score = finite(raw.score)
    if (score === undefined) return undefined
    const confidence = raw.confidence === undefined ? undefined : probability(raw.confidence)
    if (raw.confidence !== undefined && confidence === undefined) return undefined
    const probabilities = raw.probabilities === undefined ? undefined : numberRecord(raw.probabilities)
    if (raw.probabilities !== undefined && probabilities === undefined) return undefined
    return {
      type: 'score',
      score,
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities === undefined ? {} : { probabilities }),
    }
  }
  return undefined
}

/**
 * Parse a decision response body. Every answer entry must be well formed — one
 * malformed entry fails the whole response, because a partially understood
 * decision is not a decision. Unknown extra members are ignored so a server-side
 * addition cannot break the guard.
 *
 * @param value - the decoded JSON body.
 * @returns the parsed response, or undefined when the body is not one.
 */
export function parseSystemOneResponse(value: unknown): SystemOneResponse | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const rawAnswers = raw.answers
  if (typeof rawAnswers !== 'object' || rawAnswers === null || Array.isArray(rawAnswers)) return undefined
  const entries = Object.entries(rawAnswers)
  if (entries.length === 0) return undefined
  const answers: Record<string, SystemOneAnswer> = {}
  for (const [id, entry] of entries) {
    const answer = parseSystemOneAnswer(entry)
    if (answer === undefined) return undefined
    answers[id] = answer
  }
  const usage = raw.usage === undefined ? undefined : parseUsage(raw.usage)
  if (raw.usage !== undefined && usage === undefined) return undefined
  return {
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    answers,
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Parse the optional `usage` member; an unreadable one is a malformed body. */
function parseUsage(value: unknown): SystemOneUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const inputTokens = raw.input_tokens === undefined ? undefined : finite(raw.input_tokens)
  if (raw.input_tokens !== undefined && inputTokens === undefined) return undefined
  const outputTokens = raw.output_tokens === undefined ? undefined : finite(raw.output_tokens)
  if (raw.output_tokens !== undefined && outputTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}

/** Validate the outgoing request where the server would only reject it with a 400. */
function assertRequest(request: SystemOneRequest): void {
  const ids = Object.keys(request.questions)
  if (ids.length === 0) throw new SystemOneError('a decision request needs at least one question', 'invalid-request')
  if (ids.length > SYSTEMONE_MAX_QUESTIONS) {
    throw new SystemOneError(
      `a decision request carries at most ${SYSTEMONE_MAX_QUESTIONS} questions (got ${ids.length})`,
      'invalid-request',
    )
  }
  for (const id of ids) {
    if (id.trim() === '') throw new SystemOneError('every decision question needs a non-empty id', 'invalid-request')
  }
}

/** Read the endpoint's error body into a one-line diagnosis. */
async function httpFailure(response: Response): Promise<SystemOneError> {
  let detail = ''
  try {
    const text = await response.text()
    const slice = text.trim().slice(0, 200)
    if (slice !== '') detail = `: ${slice}`
  } catch {
    // A body that cannot be read adds nothing; the status is the diagnosis.
  }
  return new SystemOneError(
    `Command Code decision request failed (HTTP ${response.status})${detail}`,
    'http',
    response.status,
  )
}

/**
 * Run one decision request.
 *
 * @param deps - connection facts, credential chain and fetch seam.
 * @param request - the state and typed questions.
 * @param options - caller cancellation and the per-call budget.
 * @returns the parsed decision.
 * @throws {SystemOneError} on every failure path; callers fail closed.
 */
export async function runSystemOne(
  deps: SystemOneDeps,
  request: SystemOneRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SystemOneResponse> {
  assertRequest(request)
  const apiBase = deps.apiBase()
  if (!URL.canParse(apiBase)) {
    throw new SystemOneError(
      `Command Code decision request is misconfigured: apiBase ${JSON.stringify(apiBase)} is not a valid URL`,
      'invalid-request',
    )
  }
  if (options.signal?.aborted === true) throw new SystemOneError('decision request aborted', 'aborted')
  const timeoutMs = options.timeoutMs ?? SYSTEMONE_DEFAULT_TIMEOUT_MS
  const deadline = deadlineOf(options.signal, timeoutMs)
  try {
    let key: string
    try {
      key = await withinDeadline(Promise.resolve().then(() => deps.resolveApiKey()), deadline, timeoutMs)
    } catch (error) {
      if (error instanceof SystemOneError && (error.kind === 'aborted' || error.kind === 'timeout')) throw error
      throw new SystemOneError(
        `Command Code decision request has no usable credential: ${error instanceof Error ? error.message : String(error)}`,
        'credential',
        undefined,
        { cause: error },
      )
    }

    const body = {
      model: request.model ?? SYSTEMONE_MODEL,
      state: request.state,
      questions: request.questions,
    }

    // The credential chain can take a moment (the pool may probe a window), and
    // the caller may withdraw — or the budget may expire — while it runs. Re-check
    // before opening the connection: a real fetch would reject an aborted signal
    // on its own, but the diagnosis belongs to this client, and a deployment with
    // its own transport must not have to re-derive it.
    if (deadline.signal.aborted) {
      throw deadline.callerAborted()
        ? new SystemOneError('decision request aborted', 'aborted')
        : new SystemOneError(`decision request timed out after ${timeoutMs}ms`, 'timeout')
    }

    let response: Response
    try {
      response = await (deps.fetchImpl ?? fetch)(`${apiBase.replace(/\/$/, '')}${SYSTEMONE_ROUTE}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...IDENTITY_ENCODING_HEADER,
          Authorization: `Bearer ${key}`,
          'x-command-code-version': COMMAND_CODE_CLI_VERSION,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      })
    } catch (error) {
      if (deadline.callerAborted()) throw new SystemOneError('decision request aborted', 'aborted', undefined, { cause: error })
      if (deadline.timedOut() || isAbortError(error)) {
        throw new SystemOneError(`decision request timed out after ${timeoutMs}ms`, 'timeout', undefined, { cause: error })
      }
      throw new SystemOneError(
        `Command Code decision request failed: ${error instanceof Error ? error.message : String(error)}`,
        'network',
        undefined,
        { cause: error },
      )
    }

    if (!response.ok) throw await httpFailure(response)

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (deadline.callerAborted()) throw new SystemOneError('decision request aborted', 'aborted', undefined, { cause: error })
      throw new SystemOneError('Command Code returned an unparseable decision body', 'invalid-response', undefined, { cause: error })
    }
    const parsed = parseSystemOneResponse(payload)
    if (parsed === undefined) {
      throw new SystemOneError('Command Code returned a decision body this plugin cannot read', 'invalid-response')
    }
    return parsed
  } finally {
    // Always: a live timeout timer would otherwise hold the process open, and a
    // caller listener would outlive the request it belongs to.
    deadline.dispose()
  }
}
