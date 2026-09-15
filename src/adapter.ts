/**
 * DeepSeek Harness LLM adapter for the Command Code Provider API.
 *
 * Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
 * community-maintained integration; you need your own Command Code account
 * and API key or subscription, and Command Code's terms apply.
 *
 * Wire protocol (reverse-engineered by the pi plugin, command-code@1.28.4;
 * re-verified against command-code@1.54.0 — endpoints, request shape, and
 * stream events unchanged):
 *   POST {apiBase}/alpha/generate
 *   body: { config, memory, taste, skills, params: { model, messages, tools,
 *          system, max_tokens, temperature, stream, reasoning_effort? }, threadId }
 *   SSE-ish JSONL events: text-delta | reasoning-start/delta/end | tool-call
 *                         | tool-result | finish | error
 *   Model catalog: GET {apiBase}/provider/v1/models -> { object: 'list', data: [...] }
 *
 * The adapter is deliberately free of cordis/schemastery: it receives a
 * per-request options thunk and an API-key resolver from the plugin entry
 * (src/index.ts), so a settings change reaches the very next request.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  errorChain,
  offloadRequestImagesWithPolicy,
  offloadedImageText,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { RETRY_MAX_DELAY_MS } from './accounts.ts'

import {
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  capabilityDescription,
  compareByPlan,
  modelVisibleInPlan,
  subscriptionPlanInfo,
  type CommandCodeBillingAccess,
} from './capabilities.ts'

// ---------------------------------------------------------------------------
// Request / connection defaults (protocol constants). The model/plan/deal
// capability snapshot lives in ./capabilities.ts — the sync-only surface.
// ---------------------------------------------------------------------------
export const COMMAND_CODE_CLI_VERSION = '1.54.0'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const DEFAULT_GENERATE_MAX_TOKENS = 64_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const MODELS_TIMEOUT_MS = 10_000
/** How long the picker's plan-filter billing facts stay cached before refetching. */
export const BILLING_ACCESS_TTL_MS = 5 * 60_000
/**
 * How long a learned CLI-only protocol preference stays cached per account.
 * After this TTL a request may probe Provider API again, so an upgraded Go
 * account can recover without a restart.
 */
export const PROTOCOL_CACHE_TTL_MS = 15 * 60_000
/** Endpoint protocol selected for one generate call. */
type CommandCodeProtocol = 'cli' | 'openai'

/** The entry-plan tier weight (`individual-go` in KNOWN_SUBSCRIPTION_PLANS). */
const GO_TIER_WEIGHT = 0

/** Hard cap on account rotations within one request (one attempt per distinct key). */
const MAX_ACCOUNT_ROTATIONS = 16

/**
 * Subscription statuses the CLI treats as live (`Mr` in command-code's
 * cli.mjs): the plan gate applies only under one of these.
 */
const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due'])
/** Head-of-request timeout: how long to wait for the first response byte. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const MODEL_CACHE_VERSION = 1

// ---------------------------------------------------------------------------
// Small helpers (ported from converters.ts / models.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
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
 */
const TERMINAL_STREAM_ERROR_MARKERS = [
  'premium_credits_exhausted',
  'model_not_in_plan',
  'insufficient credits',
]

function hasTerminalStreamMarker(message: string): boolean {
  const lower = message.toLowerCase()
  return TERMINAL_STREAM_ERROR_MARKERS.some((marker) => lower.includes(marker))
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
 * Classify one in-band stream `error` payload into the failure the caller
 * throws. Shared by both transports — the CLI transport delivers it as an
 * `error` event (`{ type: 'error', error }`), the Provider API transport as a
 * top-level `error` member of an SSE chunk — so the two cannot drift apart.
 *
 * The wording decides before the status does, mirroring the official CLI's
 * `classifyKind` (which reads the message first) and the harness helpers
 * (which exist so thrown and in-band delivery share one classifier). Order is
 * load-bearing:
 *
 * - A context-window rejection is terminal for THIS request but recoverable by
 *   the harness: `dsh-compaction-basic` listens on `agent/request-error` for
 *   `CONTEXT_WINDOW_EXCEEDED` and answers it with a compaction + retry of the
 *   reduced surface. That is what lets a long session survive a request that
 *   outgrew the model's window, and it is what the official CLI does (its
 *   non-retryable `truncated` kind). Reported as retryable `SERVER` — where
 *   this wording landed before — the adapter resent the byte-identical
 *   oversized request up to `maxRetries` times and the session could never
 *   recover, which is exactly the endless-retry-at-long-context report
 *   (issue #39).
 * - Credits/plan wording is terminal, so an exhausted balance or a model
 *   outside the plan is not retried as if it were a transient rate limit.
 * - Only then does the status/`isRetryable` pair decide, as before.
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

  if (isContextOverflowDetail(detail)) {
    // Bilingual — the harness renders this message verbatim in its retry
    // chrome — and it names the recovery the harness is already performing.
    return new LlmError(
      `Command Code stream error: ${message}`
      + '；Command Code API 拒绝了这次请求：内容超出模型上下文窗口。正在压缩上下文后重试；如仍失败，请新建会话或减少上下文',
      CONTEXT_WINDOW_EXCEEDED_CODE,
      statusOption,
    )
  }
  const terminal = hasTerminalStreamMarker(detail)
  const retryableStatus = statusCode !== undefined && (statusCode === 429 || statusCode >= 500)
  const retryable = isRetryable === true
    || (statusCode !== undefined ? retryableStatus : (isRetryable !== false && !terminal))
  if (!retryable) {
    return new LlmError(
      `Command Code stream error: ${message}`,
      'PROVIDER_STREAM_ERROR',
      statusOption,
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
// Tool-schema normalization (issue #35)
// The gateway validates every function schema's ROOT as an object schema and
// rejects the whole request otherwise (`schema must be a JSON Schema of
// type: "object", got type: null`). Tool schemas do not always come from
// the harness's own typed builder, which always declares `type: 'object'`: a
// third-party plugin or an MCP bridge can register a hand-written schema, and
// a generator can emit a root `$ref`. Neither is this plugin's to correct, but
// the request is the plugin's to send, so every schema leaving here is
// normalized to the object root the provider requires. Only the root is
// touched, and every path returns a copy: the harness may deep-freeze the
// caller's schema.
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
// Credential fallback from the official Command Code CLI auth file. Used as
// the last fallback by the plugin entry, so a user who already logged in with
// `command-code login` can reuse that credential. Only the official CLI's own
// file is read — pi/OMP auth files are intentionally not scanned, so their
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
// Model catalog discovery with on-disk cache fallback (ported from models.ts)
// ---------------------------------------------------------------------------

interface CommandCodeModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

function parseCatalogResponse(value: unknown): CommandCodeModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new LlmError('Unexpected Command Code models response shape', 'PROVIDER_PROTOCOL_ERROR')
  }
  const models: CommandCodeModel[] = []
  for (const entry of value.data) {
    if (!isRecord(entry)) continue
    const id = stringValue(entry.id)
    const name = stringValue(entry.name)
    const contextLength = numberValue(entry.context_length)
    if (!id || !name || !contextLength || contextLength <= 0) continue
    models.push({
      id,
      name,
      contextWindow: contextLength,
      maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
    })
  }
  if (models.length === 0) {
    throw new LlmError('Command Code returned an empty model catalog', 'PROVIDER_PROTOCOL_ERROR')
  }
  return models
}

async function readModelsCache(cachePath: string): Promise<CommandCodeModel[]> {
  const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf-8'))
  if (!isRecord(parsed) || parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid model cache at ${cachePath}`)
  }
  return parsed.models as CommandCodeModel[]
}

async function writeModelsCache(cachePath: string, models: CommandCodeModel[]): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const tmp = `${cachePath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    await rename(tmp, cachePath)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Message conversion: harness Message[] -> Command Code wire messages.
// Both transports replay historical reasoning. The CLI transport carries it as
// a `reasoning` block inside the assistant message (the shape the official
// CLI's `toWireMessages` emits), the Provider API transport as the
// `reasoning_content` field, because DeepSeek's thinking-mode contract
// requires the previous chain of thought to be passed back whenever tool calls
// are in play (issue #34). Only tool calls with a paired tool result are
// replayed on both transports.
// ---------------------------------------------------------------------------

/**
 * Collect the tool calls that have a paired tool result, plus each call's
 * name. The name map feeds the `toolName` of replayed tool results: some
 * backends (e.g. Google Gemini `functionResponse`) reject a result whose
 * function name is empty, so the real name must round-trip (the official
 * CLI does the same via its `tool_use_id -> toolName` map).
 */
function pairedToolCalls(messages: readonly Message[]): {
  ids: Set<string>
  names: Map<string, string>
} {
  const callIds = new Set<string>()
  const names = new Map<string, string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call') {
        callIds.add(block.id)
        names.set(block.id, block.name)
      }
      if (block.type === 'tool-result') resultIds.add(block.toolCallId)
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
 * sequential alias is enough: no durable state, no cross-request stability,
 * and the harness log keeps the original ids.
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
 * invisible to a Vision model (issue #30). Deduplication keeps a result that
 * repeats one attachment from paying for the same pixels twice.
 */
function toolResultMedia(block: Extract<ContentBlock, { type: 'tool-result' }>): ToolResultMedia {
  const chunks: string[] = []
  const images: ImageAttachmentRef[] = []
  const seen = new Set<string>()
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const nested of blocks) {
      if (nested.type === 'text' || nested.type === 'reasoning') {
        if (nested.text) chunks.push(nested.text)
        continue
      }
      if (nested.type === 'image') {
        if (!seen.has(nested.attachment.attachmentId)) {
          seen.add(nested.attachment.attachmentId)
          images.push(nested.attachment)
        }
        continue
      }
      if (nested.type === 'tool-result') walk(nested.content)
    }
  }
  walk(block.content)
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
 * The note names the tool call the image came out of, because a turn's
 * carriers are emitted as a group after the whole tool group (issue #33):
 * position alone would have to carry the association, and every `read_image`
 * result renders the same envelope text, so two parallel calls would produce
 * two identical notes. The id is the WIRE id — the one the model saw on the
 * `tool-call` it issued and on the tool message just above — so an overlong
 * cross-provider id is named by the alias that replaced it, not by the
 * harness-side id the model never saw.
 *
 * Count and pixel dimensions are appended when the tool's own text does not
 * already state them (a result that returns the image and nothing else).
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

function hasImageContent(message: Message): boolean {
  const check = (blocks: readonly ContentBlock[]): boolean =>
    blocks.some(
      (b) => b.type === 'image' || (b.type === 'tool-result' && check(b.content)),
    )
  return check(message.content)
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
// The harness core already ships the mechanism the two official adapters use
// (`offloadRequestImagesWithPolicy` + `offloadedImageText`): the oldest images
// beyond a budget are replaced, in whole quanta, by a model-visible
// placeholder that names the attachment, so the recent tail keeps its pixels
// and the session survives. The budget is accounted in the encoded form,
// because it is the base64 the wire actually carries that has to fit.
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

/**
 * Project request history under one image budget: the oldest images past it
 * become placeholder text in place, the newest keep their bytes, and a history
 * already inside the budget is returned as the SAME array — the caller uses
 * that identity to tell "nothing evicted" from "evicted".
 *
 * Nested tool-result images ride the same core walk, which is exactly right
 * for this adapter: an evicted `read_image` result surfaces its placeholder as
 * the tool message's own text, so no carrier user message is emitted for it.
 */
function projectRequestImages(
  messages: readonly Message[],
  budget: RequestImageBudget,
): readonly Message[] {
  return offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    maxBytes: budget.maxBytes,
    maxImages: budget.maxImages,
    byteQuantum: budget.byteQuantum,
    countQuantum: budget.countQuantum,
    // No execution-world path is resolvable from the adapter (it holds no
    // filesystem provider), so the placeholder carries attachment identity and
    // the re-attach advice, which is what the core helper emits for that case.
    placeholder: (ref) => offloadedImageText(ref),
  })
}

/**
 * The request options one budget produced: the caller's own object when the
 * history was already inside the budget, else a copy carrying the projection.
 * The next rung of the ladder is applied to the CURRENT projection, never to
 * the raw history — otherwise a retry could reintroduce images the first rung
 * had already evicted.
 */
function withImageBudget(options: GenerateOptions, budget: RequestImageBudget): GenerateOptions {
  const projected = projectRequestImages(options.messages, budget)
  return projected === options.messages ? options : { ...options, messages: [...projected] }
}

/**
 * Convert one image reference to the Command Code wire format, as the official
 * CLI does: `{ type: 'image', source: { type: 'base64', media_type, data } }`.
 * Bytes come from the durable attachment service; the media type is the one
 * verified at save time.
 */
async function imageToCommandCode(
  ref: ImageAttachmentRef,
  readImage: (ref: ImageAttachmentRef) => Promise<Uint8Array>,
): Promise<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> {
  const data = await readImage(ref)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: ref.mediaType,
      data: Buffer.from(data).toString('base64'),
    },
  }
}

async function messagesToCC(
  messages: readonly Message[],
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>,
): Promise<unknown[]> {
  const out: unknown[] = []
  const { ids: paired, names: toolNames } = pairedToolCalls(messages)
  // Remap cross-provider ids the gateway would reject (issue #23); the
  // result side resolves through the same map so each pair stays correlated.
  const wireIds = wireToolCallIds(paired)

  // Tool-returned images ride as user messages after their tool result. The
  // harness can emit several tool calls in one assistant turn, and the
  // gateway expects an assistant's tool blocks to be answered consecutively:
  // a user message interleaved between tool results breaks the pairing and
  // the request is rejected. So image carriers are buffered and flushed only
  // once the whole tool group (or the next non-tool message) has been emitted.
  const pendingImages: unknown[] = []
  const flushPendingImages = () => {
    for (const message of pendingImages) out.push(message)
    pendingImages.length = 0
  }

  for (const message of messages) {
    if (message.role === 'system') continue // folded into params.system by the caller

    if (message.role === 'user' && message.source.kind !== 'tool') {
      flushPendingImages()
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        if (block.type === 'image') {
          // The caller (stream) has already gated image input on model
          // capability and attachment-service availability, so reaching this
          // branch with no resolver is an internal contract violation.
          if (!readImage) {
            throw new LlmError(
              'Image input requires the durable attachment service',
              'UNSUPPORTED_CONTENT',
            )
          }
          parts.push(await imageToCommandCode(block.attachment, readImage))
        }
      }
      // A user message that converted to nothing carries no information, and
      // an empty content array is a needless gateway-compat risk, so it is
      // dropped — the same rule the Provider API converter applies below.
      // (`dsh-llm-deepseek` instead pushes `content: ''`; skipping is the
      // safer half of that divergence to keep.) The flush above has already
      // run, so a pending image carrier is never dropped with it.
      if (parts.length === 0) continue
      out.push({ role: 'user', content: parts })
      continue
    }

    if (message.role === 'assistant') {
      flushPendingImages()
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'reasoning') {
          // Replay the thinking block, exactly as the official CLI's
          // `toWireMessages` does (command-code@1.54.0: a `thinking` block
          // becomes `{ type: 'reasoning', text }`). This is not optional
          // politeness: the gateway rebuilds the provider request from these
          // blocks, and a DeepSeek thinking-mode assistant turn whose tool
          // calls arrive without its reasoning is rejected with "The
          // `reasoning_content` in the thinking mode must be passed back to
          // the API" — which failed every tool-loop turn (issue #34).
          parts.push({ type: 'reasoning', text: block.text })
        } else if (block.type === 'tool-call' && paired.has(block.id)) {
          parts.push({
            type: 'tool-call',
            toolCallId: wireIds.get(block.id) ?? block.id,
            toolName: block.name,
            input: recordOrEmpty(block.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }

    // tool-result message (user role, single tool-result block)
    if (message.role === 'user' && message.source.kind === 'tool') {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      const media = toolResultMedia(block)
      // Resolved once: the tool message and the carrier note below must name
      // the same call, or the model cannot tie an image back to its result.
      const wireToolCallId = wireIds.get(block.toolCallId) ?? block.toolCallId
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: wireToolCallId,
            // `paired` guarantees a call with this id exists, so the map
            // always hits; `|| 'unknown'` also guards an empty call name
            // (matches the official CLI's `?? "unknown"` fallback).
            toolName: toolNames.get(block.toolCallId) || 'unknown',
            output: block.isError
              ? { type: 'error-text', value: toolResultTextForWire(media) }
              : { type: 'text', value: toolResultTextForWire(media) },
          },
        ],
      })
      // Images a tool returned (e.g. `read_image`) cannot ride inside the
      // tool result on this wire, so they follow it as a user message —
      // otherwise a Vision model receives the metadata text and no pixels.
      if (media.images.length > 0) {
        if (!readImage) {
          throw new LlmError(
            'Image input requires the durable attachment service',
            'UNSUPPORTED_CONTENT',
          )
        }
        const carried: unknown[] = [{ type: 'text', text: toolResultImageNote(media, wireToolCallId) }]
        for (const attachment of media.images) {
          carried.push(await imageToCommandCode(attachment, readImage))
        }
        pendingImages.push({ role: 'user', content: carried })
      }
    }
  }
  flushPendingImages()
  return out
}

/**
 * Convert one image reference to the OpenAI Chat Completions wire format:
 * `{ type: 'image_url', image_url: { url: 'data:...;base64,...' } }`.
 */
async function imageToOpenAI(
  ref: ImageAttachmentRef,
  readImage: (ref: ImageAttachmentRef) => Promise<Uint8Array>,
): Promise<{ type: 'image_url'; image_url: { url: string } }> {
  const data = await readImage(ref)
  return {
    type: 'image_url',
    image_url: {
      url: `data:${ref.mediaType};base64,${Buffer.from(data).toString('base64')}`,
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
async function messagesToOpenAI(
  messages: readonly Message[],
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>,
): Promise<unknown[]> {
  const out: unknown[] = []
  const { ids: paired } = pairedToolCalls(messages)
  // Same overlong-id remap as the CLI transport (issue #23): OpenAI
  // `tool_call_id` fields accept longer values, but the remap keeps both
  // transports consistent and correlation only needs to hold per request.
  const wireIds = wireToolCallIds(paired)

  // Tool-returned images ride as user messages after their tool result. The
  // harness can emit several tool calls in one assistant turn, and the
  // gateway expects an assistant's tool blocks to be answered consecutively:
  // a user message interleaved between tool results breaks the pairing and
  // the request is rejected. So image carriers are buffered and flushed only
  // once the whole tool group (or the next non-tool message) has been emitted.
  const pendingImages: unknown[] = []
  const flushPendingImages = () => {
    for (const message of pendingImages) out.push(message)
    pendingImages.length = 0
  }

  for (const message of messages) {
    // System messages are folded into the single top-level system message by
    // the caller, matching the existing adapter's conversation folding.
    if (message.role === 'system') continue

    if (message.role === 'user' && message.source.kind !== 'tool') {
      flushPendingImages()
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        if (block.type === 'image') {
          if (!readImage) {
            throw new LlmError(
              'Image input requires the durable attachment service',
              'UNSUPPORTED_CONTENT',
            )
          }
          parts.push(await imageToOpenAI(block.attachment, readImage))
        }
      }
      // Same rule as the CLI converter: a converted-to-nothing user message is
      // dropped rather than sent as an empty content array. The flush above
      // already ran, so a pending image carrier survives this skip.
      if (parts.length === 0) continue
      const hasImage = parts.some((part) => (part as { type?: string }).type === 'image_url')
      if (!hasImage && parts.length === 1) {
        out.push({ role: 'user', content: (parts[0] as { text: string }).text })
      } else {
        // Preserve separate text/image parts rather than silently joining
        // text blocks together.
        out.push({ role: 'user', content: parts })
      }
      continue
    }

    if (message.role === 'assistant') {
      flushPendingImages()
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
          function: {
            name: block.name,
            arguments: block.arguments,
          },
        }))

      if (text === '' && reasoning === '' && toolCalls.length === 0) continue
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: text === '' ? null : text,
      }
      // Chat Completions / DeepSeek thinking mode: replay historical reasoning
      // so tool-calling loops can continue from the previous chain of thought.
      if (reasoning !== '') assistant.reasoning_content = reasoning
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      out.push(assistant)
      continue
    }

    // tool-result message (user role, single tool-result block)
    if (message.role === 'user' && message.source.kind === 'tool') {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      const media = toolResultMedia(block)
      // Resolved once: the tool message and the carrier note below must name
      // the same call, or the model cannot tie an image back to its result.
      const wireToolCallId = wireIds.get(block.toolCallId) ?? block.toolCallId
      out.push({
        role: 'tool',
        tool_call_id: wireToolCallId,
        content: toolResultTextForWire(media),
      })
      // Chat Completions allows no image part under `role: 'tool'`, so a
      // tool-returned image (e.g. `read_image`) follows as a user message.
      if (media.images.length > 0) {
        if (!readImage) {
          throw new LlmError(
            'Image input requires the durable attachment service',
            'UNSUPPORTED_CONTENT',
          )
        }
        const carried: unknown[] = [{ type: 'text', text: toolResultImageNote(media, wireToolCallId) }]
        for (const attachment of media.images) {
          carried.push(await imageToOpenAI(attachment, readImage))
        }
        pendingImages.push({ role: 'user', content: carried })
      }
    }
  }
  flushPendingImages()
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
/** Connection facts resolved fresh per request by the plugin entry. */
export interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/chat/completions`, `/provider/v1/models`). */
  apiBase: string
  /** Working directory reported to the API (project slug, config block). */
  workingDir: string
  /** Model catalog cache path. */
  modelsCachePath: string
  /**
   * Milliseconds to wait for generate response headers / first byte (default 60s).
   * Must not bound the subsequent body stream — long generations are gated by
   * {@link streamIdleTimeoutMs} and the caller AbortSignal instead.
   */
  requestTimeoutMs: number
  /** Milliseconds a stream may stall before it is treated as a dead connection (default 300s). */
  streamIdleTimeoutMs: number
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
}

/**
 * Resolve the durable attachment service, or undefined when the host does not
 * provide one. Called lazily only when a request actually carries images, so a
 * text-only request never depends on the attachment seam.
 */
export type ResolveAttachments = () => AttachmentStore | undefined

/** Everything the adapter needs beyond the request itself. */
export interface CommandCodeAdapterDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
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
   * refused with 429 (`rate-limit`) or 401 (`invalid-credential`) before
   * any response body streamed. The host marks that key and returns the next
   * account's key to retry with, or `undefined` to surface the failure.
   * Only pre-stream rejections rotate — a mid-stream failure never replays a
   * partially consumed generation against another account.
   */
  rotateApiKey?: (rejectedKey: string, rejection: 'rate-limit' | 'invalid-credential', connection: C, model?: string) => Promise<string | undefined>
  /** HTTP transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Resolve the optional durable attachment service for image input (tests); defaults to none. */
  resolveAttachments?: ResolveAttachments
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
export type UsageBlockReason = 'invalid-key' | 'service-unavailable' | 'network'

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
   * `service-unavailable` (every call answered 5xx), or `network` (no HTTP
   * response at all). Undefined when any endpoint succeeded.
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

/** Parse one window-limit block (`fiveHour` / `weekly`). */
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
 * error, the degraded per-endpoint view would hide the root cause behind
 * a generic "partial data" note — name it instead.
 */
function classifyTotalFailure(
  failures: readonly string[],
  failedStatuses: ReadonlyArray<number | undefined>,
): UsageBlockReason | undefined {
  // Four endpoints are fetched (whoami, usage/summary, billing/credits,
  // billing/subscriptions; the last may carry an orgId query, so the
  // classification counts endpoints, not paths).
  if (failures.length !== USAGE_ENDPOINT_COUNT) return undefined
  const codes = failedStatuses.filter((status): status is number => status !== undefined)
  if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code === 401)) {
    return 'invalid-key'
  }
  if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code >= 500)) {
    return 'service-unavailable'
  }
  if (codes.length === 0) return 'network'
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
  /** Folded system text (top-level system + system-role messages). */
  systemText: string
  /** Per-call image byte resolver; set only when the request carries images. */
  readImage: ((ref: ImageAttachmentRef) => Promise<Uint8Array>) | undefined
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
      system: facts.systemText,
      max_tokens: facts.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: true,
      ...(facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}),
    },
    threadId: randomUUID(),
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
 * One connect attempt's inputs: everything `connectGenerate` needs beyond
 * the per-attempt key and protocol. Passed explicitly (not closed over) so
 * the rotation loop's mutation of `protocol`/`body` stays visible at the
 * call site.
 */
interface GenerateConnectDeps {
  options: GenerateOptions
  connection: CommandCodeConnectionOptions
  fetchImpl: typeof fetch
}

/**
 * One pre-stream connect attempt: POST the body and wait for response
 * headers only (`requestTimeoutMs` must never bound the body stream — see
 * the caller). Returns the live response plus its cleanup, or the rejection
 * facts for the rotation loop to classify. Every failure path cleans up
 * before returning or throwing; on success the caller-abort listener
 * outlives the connect phase (it aborts a stalled body read), so the
 * streaming tail calls cleanup.
 */
async function connectGenerate(
  deps: GenerateConnectDeps,
  key: string,
  protocol: CommandCodeProtocol,
  body: Record<string, unknown>,
): Promise<{ response: Response; cleanup: () => void } | { status: number; errText: string; retryAfterMs?: number }> {
  const { options, connection, fetchImpl } = deps
  const connectAbort = new AbortController()
  let connectTimedOut = false
  const endpoint = protocol === 'cli'
    ? `${connection.apiBase}/alpha/generate`
    : `${connection.apiBase}/provider/v1/chat/completions`
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
  const headers = protocol === 'cli'
    ? {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'x-command-code-version': COMMAND_CODE_CLI_VERSION,
        'x-cli-environment': 'production',
        'x-project-slug': projectSlugFromPath(connection.workingDir),
        'x-taste-learning': 'true',
        'x-co-flag': 'false',
        ...attributionHeaders(),
      }
    : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
        // Deliberately no x-command-code-version / x-cli-environment:
        // this is the documented OpenAI-format surface, not the CLI
        // transport — do not "fix" these in.
        ...attributionHeaders(),
      }
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: connectAbort.signal,
    })
    clearTimeout(connectTimer)
  } catch (error: unknown) {
    cleanup()
    if (options.signal?.aborted) {
      throw error
    }
    if (connectTimedOut || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new LlmError(
        `Command Code API request to ${endpoint} did not respond within ${connection.requestTimeoutMs}ms`
        + `: ${errorChain(error)}`
        + `；Command Code API 请求在 ${connection.requestTimeoutMs} 毫秒内未收到响应——通常是网络或代理问题，请检查后重试`,
        'TIMEOUT',
        { cause: error },
      )
    }
    // fetch wraps every transport failure (DNS, refused connection, TLS,
    // proxy, reset) in a bare `TypeError: fetch failed` whose actionable
    // detail lives on `cause`. Include the full chain so the failure reason
    // shown in the web UI (which renders only the message, not `cause`)
    // names the real root cause instead of a generic wrapper.
    throw new LlmError(
      `Command Code API request to ${endpoint} failed: ${errorChain(error)}`
      + '；Command Code API 请求连接失败——通常是网络或代理问题，请检查网络或代理设置后重试',
      'TRANSPORT',
      { cause: error },
    )
  }

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
  /** Buffered OpenAI tool-call fragments, flushed at finish. */
  openAiToolCalls: Array<{ index: number; id?: string; name: string; arguments: string }>
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
    openAiToolCalls: [],
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
  private readonly fetchImpl: typeof fetch
  private readonly resolveAttachments: ResolveAttachments | undefined
  // Billing facts are per account: with a multi-account pool each key has its
  // own subscription tier, so the cache and the in-flight dedupe are keyed by
  // the resolved API key (process-local only, never logged). Entries are
  // small and bounded by the account count in practice; a changed key simply
  // starts a fresh entry while the orphaned one goes cold (no eviction —
  // transience is intentional, persistence would serve stale tiers).
  private readonly billingAccess = new Map<string, { value: CommandCodeBillingAccess | undefined; at: number }>()
  private readonly billingAccessInflight = new Map<string, Promise<CommandCodeBillingAccess | undefined>>()
  // Protocol preference is per account: the Go plan is the only plan without
  // Provider API access, and that fact is independent of model. A negative
  // result (provider API rejected this key with upgrade_required) is cached so
  // every request does not pay the double TTFT of probing then falling back.
  // Same bounded-by-account-count note as above: no eviction by design.
  private readonly protocolCache = new Map<string, { useCli: boolean; at: number }>()

  constructor(private readonly deps: CommandCodeAdapterDeps<C>) {
    super()
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.resolveAttachments = deps.resolveAttachments
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
   * Near-unbounded retry for transient failures only (`mode: 'normal'` with
   * an explicit 1000-attempt cap — opencode-style persistence without the
   * unbounded loop): `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/
   * `EMPTY_RESPONSE` retry up to 1000 times with waits doubling from 500 ms
   * and capping at 15 minutes (±10% jitter), so an exhausted 5-hour window
   * recovers in-session instead of failing after two tries. Permanent
   * failures (an invalid key's `INVALID_CREDENTIAL`, `UNSUPPORTED_CONTENT`,
   * plan rejections) are absent from the whitelist and surface immediately
   * instead of looping. Waits the pool/adapter attach as
   * `providerRetryAfterMs` are honored verbatim at or below the 15-minute
   * cap and never attached above it (in normal mode a longer attached wait
   * makes the executor abandon the retry outright — see RETRY_MAX_DELAY_MS).
   *
   * Captured once at route registration (dsh-llm snapshots this value), so a
   * future config knob for it would apply on profile restart, not per request.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 1000,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        backoff: { initialDelayMs: 500, maxDelayMs: RETRY_MAX_DELAY_MS, jitterRatio: 0.1 },
      },
      'llm-commandcode: retryPolicy',
    )
  }

  /** Refresh the catalog (live fetch, cache fallback) and return it. */
  private async loadCatalog(signal?: AbortSignal): Promise<CommandCodeModel[]> {
    const { apiBase, modelsCachePath } = this.deps.options()
    try {
      const response = await this.fetchImpl(`${apiBase}/provider/v1/models`, {
        headers: { accept: 'application/json', ...attributionHeaders() },
        signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`models endpoint returned ${response.status}`)
      }
      this.catalog = parseCatalogResponse(await response.json())
      await writeModelsCache(modelsCachePath, this.catalog).catch(() => undefined)
    } catch (error) {
      if (signal?.aborted) throw error
      // A catalog refresh failure is a degradation, not a request failure:
      // fall back to the last successful catalog on disk (or the in-memory
      // one from an earlier successful load). The adapter still serves any
      // model the user names; only the advisory selector loses entries.
      this.catalog = await readModelsCache(modelsCachePath).catch(() => this.catalog)
    }
    return this.catalog
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
    // Plan filter: hide models above the account's subscription tier. Fails
    // open — a billing-fetch problem, an unknown plan, or a positive
    // on-demand balance all keep the full catalog visible, and the server
    // remains the final gate (403 MODEL_NOT_IN_PLAN). The catalog itself is
    // never filtered: resolveModel still serves every model.
    const access = this.deps.options().filterModelsByPlan === false
      ? undefined
      : await this.loadBillingAccess()
    // Visible-model allowlist: empty/unset means "show everything".
    const visible = this.deps.options().visibleModels
    const allow = Array.isArray(visible) && visible.length > 0
      ? new Set(visible.filter((id) => typeof id === 'string' && id !== ''))
      : undefined
    // Per-model overrides, written by the terminal settings page's checkboxes
    // (its seam can only give each model its own boolean field, and a boolean
    // cannot express "this id is in the list"). An explicit flag decides the
    // model on its own; everything unflagged still follows the array above, so
    // a composition-config allowlist and the web page keep working untouched.
    const overrides = this.deps.options().modelVisibility
    return catalog
      .filter((model) => modelVisibleInPlan(model.id, access))
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

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
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
    const key = apiKey ?? (await this.deps.resolveApiKey(connection))
    return {
      Authorization: `Bearer ${key}`,
      'x-command-code-version': COMMAND_CODE_CLI_VERSION,
      'x-cli-environment': 'production',
      ...attributionHeaders(),
    }
  }

  /**
   * Fetch one account endpoint and parse its JSON body. Returns the HTTP
   * status alongside the parsed record so each caller applies its own
   * failure accounting: the billing probe fails open silently, the usage
   * report books failures per endpoint. Non-2xx and non-record bodies come
   * back without a record; only a transport throw propagates to the caller.
   */
  private async fetchEndpointJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; record?: Record<string, unknown> }> {
    const response = await this.fetchImpl(url, {
      headers,
      // A hung account endpoint must not stall the picker / usage card forever.
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
    if (!response.ok) return { status: response.status }
    const parsed: unknown = await response.json()
    return { status: response.status, ...(isRecord(parsed) ? { record: parsed } : {}) }
  }

  /**
   * The billing facts behind the picker's plan filter, cached for
   * {@link BILLING_ACCESS_TTL_MS} and shared across concurrent callers.
   * `undefined` means "unknown — show everything" (fail-open).
   */
  private async loadBillingAccess(): Promise<CommandCodeBillingAccess | undefined> {
    let apiKey: string
    try {
      apiKey = await this.deps.resolveApiKey(this.deps.options())
    } catch {
      return undefined
    }
    const cached = this.billingAccess.get(apiKey)
    if (cached !== undefined && Date.now() - cached.at < BILLING_ACCESS_TTL_MS) return cached.value
    const existing = this.billingAccessInflight.get(apiKey)
    if (existing !== undefined) return existing
    const inflight = this.fetchBillingAccess(apiKey)
      .then((value) => {
        this.billingAccess.set(apiKey, { value, at: Date.now() })
        return value
      })
      .finally(() => {
        this.billingAccessInflight.delete(apiKey)
      })
    this.billingAccessInflight.set(apiKey, inflight)
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
  private async fetchBillingAccess(apiKey: string): Promise<CommandCodeBillingAccess | undefined> {
    try {
      const connection = this.deps.options()
      const headers = await this.accountHeaders(apiKey)
      const base = connection.apiBase
      // Billing probe fails open silently: any non-record is "unknown".
      const getJson = async (path: string): Promise<Record<string, unknown> | undefined> =>
        (await this.fetchEndpointJson(`${base}${path}`, headers)).record
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
  private cachedBillingTierWeight(apiKey: string): number | undefined {
    const hit = this.billingAccess.get(apiKey)
    if (hit === undefined || Date.now() - hit.at >= BILLING_ACCESS_TTL_MS) return undefined
    return hit.value?.tierWeight
  }

  /** Cached protocol decision for a key, or undefined when expired/unknown. */
  private cachedProtocolUseCli(apiKey: string): boolean | undefined {
    const hit = this.protocolCache.get(apiKey)
    if (hit === undefined || Date.now() - hit.at >= PROTOCOL_CACHE_TTL_MS) return undefined
    return hit.useCli
  }

  private rememberProtocol(apiKey: string, useCli: boolean): void {
    this.protocolCache.set(apiKey, { useCli, at: Date.now() })
  }

  /**
   * Choose the initial protocol for one request. A fresh protocol cache entry
   * wins; otherwise a cached (not network-fetched) billing tier of Go is
   * treated as CLI-only. Unknown accounts default to Provider API and fall
   * back only after an `upgrade_required` rejection.
   */
  private resolveProtocol(apiKey: string): CommandCodeProtocol {
    const forced = this.deps.options().protocol
    if (forced === 'cli' || forced === 'openai') return forced
    const cached = this.cachedProtocolUseCli(apiKey)
    if (cached !== undefined) return cached ? 'cli' : 'openai'
    if (this.cachedBillingTierWeight(apiKey) === GO_TIER_WEIGHT) {
      this.rememberProtocol(apiKey, true)
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
   */
  async getUsage(apiKey?: string): Promise<CommandCodeUsageReport> {
    const connection = this.deps.options()
    const base = connection.apiBase
    const headers = await this.accountHeaders(apiKey)
    const failures: string[] = []
    // HTTP status per failed endpoint (undefined for transport failures), in
    // failure order — the all-failed classification below reads it.
    const failedStatuses: Array<number | undefined> = []

    const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const { status, record } = await this.fetchEndpointJson(`${base}${path}`, headers)
        if (record === undefined) {
          failures.push(`${path}: HTTP ${status}`)
          failedStatuses.push(status)
          return undefined
        }
        return record
      } catch (error: unknown) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        failedStatuses.push(undefined)
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

    const blocked = classifyTotalFailure(failures, failedStatuses)
    if (blocked !== undefined) report.blocked = blocked

    return report
  }

  /**
   * Probe one account's five-hour window from `/alpha/billing/credits`. The
   * multi-account pool calls this when every account is marked exhausted: an
   * account whose window no longer reports `exceeded` is revived, and the
   * `resetAt` values feed the "earliest reset" error message. Returns
   * `undefined` when the probe itself failed (transport, non-200, or a
   * payload without window limits) — a failed probe never changes pool state.
   */
  async probeFiveHourWindow(apiKey: string): Promise<{ exceeded: boolean; resetAt: number } | undefined> {
    try {
      const connection = this.deps.options()
      const response = await this.fetchImpl(`${connection.apiBase}/alpha/billing/credits`, {
        headers: await this.accountHeaders(apiKey),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const parsed: unknown = await response.json()
      if (!isRecord(parsed)) return undefined
      const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : undefined
      const fiveHour = windowLimits && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined
      if (fiveHour === undefined) return undefined
      return { exceeded: fiveHour.exceeded === true, resetAt: numberValue(fiveHour.resetAt) ?? 0 }
    } catch {
      return undefined
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop?.length) {
      // The Command Code wire format has no documented stop field; refuse
      // loudly instead of silently dropping a request field.
      throw new LlmError('Command Code adapter does not support stop sequences', 'UNSUPPORTED_OPTION')
    }
    const hasImages = options.messages.some(hasImageContent)
    // Per-call image byte resolver, set only when this request carries images.
    // Local, not an instance field: concurrent streams must never read each
    // other's resolver.
    let readImage: ((ref: ImageAttachmentRef) => Promise<Uint8Array>) | undefined
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
      readImage = (ref) => attachments.readImage(ref).then((stored) => stored.data)
    }

    const connection = this.deps.options()
    // The model id reaches key resolution so hosts with model→account routing
    // rules can pick the account that covers this model.
    let apiKey = await this.deps.resolveApiKey(connection, options.model)
    // Cap maxTokens from the in-memory catalog: it warms via listModels /
    // resolveModel on picker paths, and a fresh-process catalog must not add
    // a models fetch (and its failure modes) in front of every generate.
    const modelMax = this.catalog.find((m) => m.id === options.model)?.maxTokens
      ?? DEFAULT_MAX_OUTPUT_TOKENS
    const maxTokens = Math.min(
      options.maxTokens ?? modelMax,
      modelMax,
      DEFAULT_GENERATE_MAX_TOKENS,
    )

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
    // accounts default to the documented Provider Chat Completions surface.
    let protocol: CommandCodeProtocol = this.resolveProtocol(apiKey)
    // Image budget (issue #37): the body is built from the PROJECTED history,
    // never the raw one, so the oldest images past the cap travel as
    // placeholder text instead of a body the gateway refuses outright. Rung 0
    // is the standing budget; a 413 below steps down the ladder.
    let requestOptions = withImageBudget(options, REQUEST_IMAGE_BUDGETS[0]!)
    let imageBudgetIndex = 0
    const buildBody = async (target: CommandCodeProtocol): Promise<Record<string, unknown>> =>
      target === 'cli'
        ? buildCliBody(requestOptions, connection, { maxTokens, reasoningEffort, systemText, readImage })
        : buildOpenAIBody(requestOptions, { maxTokens, reasoningEffort, systemText, readImage })
    let body: Record<string, unknown> = await buildBody(protocol)


    // Account rotation loop: the first attempt uses the pool's active key; a
    // pre-stream 429/401 rotates to the next account (at most one attempt per
    // distinct key, hard-capped so a misbehaving hook cannot loop forever).
    // requestTimeoutMs bounds the headers wait of EACH attempt (see
    // connectGenerate); the body is account-independent, nothing has
    // streamed yet, so the switch is invisible to the caller.
    const tried = new Set<string>()
    const connectDeps: GenerateConnectDeps = { options, connection, fetchImpl: this.fetchImpl }
    let connected: { response: Response; cleanup: () => void } | undefined
    for (;;) {
      tried.add(apiKey)
      const attempt = await connectGenerate(connectDeps, apiKey, protocol, body)
      if ('response' in attempt) {
        connected = attempt
        break
      }
      // Provider API is the preferred surface for non-Go accounts. If the
      // gateway says the key is on the Go plan (the only plan without API
      // access), remember that and retry the same key through /alpha/generate
      // without burning the double TTFT on every later request.
      if (
        protocol === 'openai'
        && isUpgradeRequiredError(attempt.status, attempt.errText)
      ) {
        protocol = 'cli'
        this.rememberProtocol(apiKey, true)
        body = await buildBody('cli')
        continue
      }
      // Request too large (issue #37): the standing budget is only an
      // estimate — the cap also covers text and tool bytes — so one 413 steps
      // the image budget down and resends. Safe like the rotation below:
      // nothing streamed, the same key stays in use, and a request with no
      // images left to evict is not resent (the stricter rung returns the
      // same options, so this branch cannot loop).
      if (attempt.status === 413 && imageBudgetIndex + 1 < REQUEST_IMAGE_BUDGETS.length) {
        const tightened = withImageBudget(requestOptions, REQUEST_IMAGE_BUDGETS[imageBudgetIndex + 1]!)
        if (tightened !== requestOptions) {
          imageBudgetIndex += 1
          requestOptions = tightened
          body = await buildBody(protocol)
          continue
        }
      }
      const rotate = this.deps.rotateApiKey
      if (
        (attempt.status === 429 || attempt.status === 401)
        && rotate !== undefined
        && options.signal?.aborted !== true
        && tried.size < MAX_ACCOUNT_ROTATIONS
      ) {
        const next = await rotate(apiKey, attempt.status === 429 ? 'rate-limit' : 'invalid-credential', connection, options.model)
        if (next !== undefined && !tried.has(next)) {
          apiKey = next
          continue
        }
      }
      throw generateHttpError(attempt.status, attempt.errText, attempt.retryAfterMs)
    }
    if (connected === undefined) {
      // Unreachable: the loop only exits via `break` (connected set) or
      // `throw` above. The guard keeps the narrowing explicit.
      throw new LlmError('Command Code API connection failed without a response', 'TRANSPORT')
    }
    const { response, cleanup } = connected
    if (!response.body) {
      cleanup()
      throw new LlmError('Command Code API returned no response body', 'PROVIDER_PROTOCOL_ERROR')
    }

    // --- SSE/JSONL event stream -> harness StreamChunk protocol ---
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Stream idle watchdog: a generation that stalls this long has a dead
    // connection (the API keeps the socket open between reasoning/text
    // bursts). The default (300s) is deliberately generous: frontier
    // reasoning models (xhigh/max effort) can legitimately stay silent for
    // minutes while thinking, and the official CLI sets no idle cap at all —
    // an aggressive cap turns long thinking into spurious TIMEOUTs and
    // retries. reader.cancel() unblocks a pending read(), which the loop then
    // turns into a TIMEOUT failure instead of hanging forever.
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
    const handle = (event: unknown): StreamChunk[] => handleEvent(asm, protocol, event)
    try {
      let finished = false
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>
        armIdle()
        try {
          read = await reader.read()
        } catch (error: unknown) {
          // A mid-stream transport failure (connection reset, TLS teardown)
          // surfaces here. Caller cancellation propagates as-is.
          if (options.signal?.aborted) throw error
          throw new LlmError(
            `Command Code API stream from ${connection.apiBase} failed while reading: ${errorChain(error)}`
            + '；Command Code API 流式响应中途断开——网络波动所致，重试通常可恢复',
            'TRANSPORT',
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
          if (idleFired) {
            throw new LlmError(
              `Command Code API stream from ${connection.apiBase} was idle for ${connection.streamIdleTimeoutMs}ms`
              + ' (no events) and was treated as a dead connection'
              + `；Command Code API 流式响应已 ${connection.streamIdleTimeoutMs} 毫秒无任何事件，被判定为死连接——长思考模型可在设置中调大流空闲超时`,
              'TIMEOUT',
            )
          }
          if (buffer.trim()) {
            // The final line may lack its trailing newline: account its
            // chunks exactly like the line loop (a trailing `finish` must
            // set `finished`, or the tail below would emit a second one).
            for (const chunk of handle(parseStreamEventLine(buffer))) {
              yield chunk
              if (chunk.type === 'finish') finished = true
            }
          }
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const chunks = handle(parseStreamEventLine(line))
          for (const chunk of chunks) {
            yield chunk
            if (chunk.type === 'finish') finished = true
          }
        }
        if (finished) break
      }
      if (!finished) {
        // Stream ended without a finish event: close open blocks and
        // terminate according to the adapter contract (usage, then finish).
        yield* closeText(asm)
        yield* closeReasoning(asm)
        if (protocol === 'openai') yield* emitOpenAiToolCalls(asm)
        if (!asm.sawContent) {
          throw new LlmError('Command Code returned an empty response；Command Code 返回了空响应，重试通常可恢复', 'EMPTY_RESPONSE')
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } finally {
      clearIdle()
      cleanup()
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
 * 429's `Retry-After` header rides along as
 * `providerRetryAfterMs` so dsh-llm-retry can wait exactly that long instead
 * of guessing at the backoff cadence — capped at RETRY_MAX_DELAY_MS, because
 * in normal mode a longer attached wait makes the executor abandon the retry
 * outright instead of falling back to local backoff.
 *
 * One body is read, not just its status: a client-side rejection whose
 * `error.code`/`type`/`message` names the model context window is reported as
 * `CONTEXT_WINDOW_EXCEEDED` (see the branch below), because that failure has a
 * recovery the harness performs and a generic provider error does not.
 */
function generateHttpError(status: number, errText: string, retryAfterMs?: number): LlmError {
  let providerCode: string | undefined
  let providerDetail = ''
  try {
    const parsed: unknown = JSON.parse(errText)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      providerCode = stringValue(parsed.error.code)
      providerDetail = [stringValue(parsed.error.code), stringValue(parsed.error.type), stringValue(parsed.error.message)]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' ')
    }
  } catch {
    // Plain-text bodies: rely on the status mapping below.
  }
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
  // Bilingual — the harness renders this message verbatim.
  const overflowDetail = providerDetail !== '' ? providerDetail : errText.slice(0, 500)
  if (status < 500 && isContextOverflowDetail(overflowDetail)) {
    return new LlmError(
      `Command Code API error ${status}: the request exceeds the model's context window`
      + ' — this session is being compacted and the request retried'
      + `；Command Code API 返回 ${status}：请求内容超出模型上下文窗口——正在压缩上下文后重试；如仍失败，请新建会话或减少上下文`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
      { status },
    )
  }
  if (status === 401) {
    // An invalid or missing credential is a config problem, not a
    // transport failure: retrying it identically cannot succeed. Bilingual —
    // the harness UI renders this message verbatim in its retry chrome.
    return new LlmError(
      `Command Code API error 401 (${detail}): the API key is missing or invalid — check the`
      + ' key stored for COMMANDCODE_API_KEY (Models page) or the auth file'
      + '；Command Code API 返回 401：API 密钥缺失或无效——请在设置页检查 COMMANDCODE_API_KEY 存储的密钥，或检查 auth 文件',
      'INVALID_CREDENTIAL',
      { status: 401 },
    )
  }
  if (status === 413) {
    // Request-body cap (issue #37). Command Code documents no 413 at all, so
    // without this branch the reader sees a bare "HTTP 413" and no way to tell
    // it apart from a generic provider failure. Reaching here means the
    // adapter already dropped this request's oldest images as far as its
    // budget ladder allows, or the body is large without images at all, so
    // the advice is the only remaining lever the user has. Bilingual — the
    // harness UI renders this message verbatim in its retry chrome.
    return new LlmError(
      'Command Code API error 413: the request body exceeds the provider\'s size limit'
      + ' (the cap is undocumented, measured at about 50 MB) — the session history is too large'
      + ' to send, usually because of accumulated image attachments. Start a new session, or'
      + ' drop the image-heavy part of this one, and retry'
      + '；Command Code API 返回 413：请求体超过服务端的体积上限（官方未公开，实测约 50 MB）'
      + '——会话历史过大，通常是历史图片累积所致。请新建会话，或移除本会话中图片较多的部分后重试',
      'PROVIDER_HTTP_ERROR',
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
 * 5xx is the provider's own "we are temporarily unavailable" class (Cloudflare's
 * 520-527 included; a 520 body says exactly that in words) and the only sane
 * answer to it is the byte-identical resend the retry policy exists to make.
 * Keeping it on `PROVIDER_HTTP_ERROR` — absent from the whitelist by design, so
 * that a 403 plan rejection or a 400 shape error fails fast — made the one
 * failure that asks to be retried the only one that never was, while the same
 * status arriving as an in-band stream `error` event was classified retryable
 * `SERVER` (see the `error` case of {@link handleCliEvent}). 408 is the same
 * story for the request itself. Everything else stays permanent: a 400/403/404/
 * 409/422 rejection repeats identically on every attempt.
 */
function httpErrorCode(status: number): string {
  if (status === 429) return 'RATE_LIMIT'
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
      asm.sawContent = true
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
    case 'finish': {
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
      if (usage) {
        const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const totalInput = numberValue(usage.inputTokens) ?? 0
        const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
        const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
        // Harness TokenUsage counts are disjoint: uncached input only.
        const tokenUsage: TokenUsage = {
          inputTokens:
            numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
          outputTokens: numberValue(usage.outputTokens) ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        }
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
  // The Provider API transport reports a mid-stream failure as an `error`
  // member of an SSE chunk rather than as an event type of its own. Ignoring
  // it — as this handler used to — let the stream end with no finish event, so
  // a context-window or quota rejection surfaced only as a generic
  // EMPTY_RESPONSE (which the retry policy repeats) and the real cause was
  // lost. Route it through the classifier the CLI transport uses.
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

  const reasoningDelta = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content) ?? ''
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
    asm.sawContent = true
    chunks.push({ type: 'text-delta', index: asm.textIndex, text: contentDelta })
  }

  if (Array.isArray(delta.tool_calls)) {
    asm.sawContent = true
    for (const rawCall of delta.tool_calls) {
      if (!isRecord(rawCall)) continue
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
    chunks.push(...closeText(asm), ...closeReasoning(asm), ...emitOpenAiToolCalls(asm))
    if (event.usage !== undefined) {
      chunks.push({ type: 'usage', usage: mapOpenAIUsage(event.usage) })
    }
    chunks.push({ type: 'finish', reason: mapFinishReason(choice.finish_reason) })
  }
  return chunks
}

/** Dispatch one parsed stream event to the active transport's handler. */
function handleEvent(asm: BlockAssembler, protocol: CommandCodeProtocol, event: unknown): StreamChunk[] {
  return protocol === 'openai' ? handleOpenAIEvent(asm, event) : handleCliEvent(asm, event)
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
  if (reason === 'tool-calls' || reason === 'tool_calls') return { kind: 'tool-calls' }
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

/**
 * True when a Provider API pre-stream rejection is Command Code's Go-plan
 * gate (`upgrade_required`). Only this exact class of rejection should fall
 * back to the CLI /alpha/generate transport; other 4xx/5xx must surface as
 * ordinary errors so real account/model problems are not masked.
 */
function isUpgradeRequiredError(status: number, errText: string): boolean {
  if (status !== 403) return false
  const lower = errText.toLowerCase()
  if (lower.includes('upgrade_required')) return true
  if (lower.includes('go plan') && lower.includes('api access')) return true
  if (lower.includes('only plan without api access')) return true
  if (lower.includes('upgrade to goat or higher')) return true
  try {
    const parsed: unknown = JSON.parse(errText)
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed
      const code = stringValue(error.code) ?? stringValue(error.type)
      if (code?.toLowerCase() === 'upgrade_required') return true
      const message = stringValue(error.message) ?? ''
      if (message.toLowerCase().includes('go plan') && message.toLowerCase().includes('api access')) return true
    }
  } catch {
    // Already handled via the plain-text substring checks above.
  }
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
