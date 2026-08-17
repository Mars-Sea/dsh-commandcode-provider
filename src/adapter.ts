/**
 * DeepSeek Harness LLM adapter for the Command Code Provider API.
 *
 * Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
 * community-maintained integration; you need your own Command Code account
 * and API key or subscription, and Command Code's terms apply.
 *
 * Wire protocol (reverse-engineered by the pi plugin, command-code@1.26.0):
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
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  errorChain,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// Static capability snapshot (from the official command-code@1.26.0 bundled
// model catalog, dist/cli.mjs). The Provider API does not expose reasoning
// metadata; models omitted here let Command Code choose their reasoning
// depth, matching the official CLI.
// ---------------------------------------------------------------------------

export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // Re-verified against the authoritative command-code@1.26.0 bundled model
  // table (dist/cli.mjs, the 'ZA' object): exactly these models carry
  // 'reasoningEfforts'. Models marked 'reasoning:!0' without 'reasoningEfforts'
  // (e.g. Kimi K3, MiniMax M3, Muse Spark 1.2, Tencent Hy3, GLM-5/5.1/5.2-Fast)
  // think automatically and are absent here - the CLI omits 'reasoning_effort'
  // for them, so the picker must not offer a selector. Do NOT add entries from
  // the OAuth provider tables (anthropic/openai) - only the Provider-API 'ZA'
  // table is authoritative for this plugin's route.
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
}

/**
 * Models whose Capabilities include Vision, per the official Command Code
 * model registry (`https://commandcode.ai/docs/reference/cli/models`, generated
 * from the same registry as `cmd --list-models` / the `/model` picker).
 *
 * The Provider API does not expose modality metadata, so this snapshot is the
 * source of truth for image-input gating. Command Code's own CLI falls back to
 * a client-side VISION side-call for text-only models; this adapter does not
 * reproduce that interactive feature, so images sent to a model outside this
 * list are refused loudly (`UNSUPPORTED_CONTENT`) instead of being dropped or
 * sent to a model that cannot read them.
 *
 * Keep in sync with the official registry when new models ship (see the
 * dsh-commandcode-upstream skill).
 */
export const KNOWN_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.8-Max',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K3',
  'sakana/fugu-ultra',
  'stepfun/Step-3.7-Flash',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'xai/grok-4.5',
  'xiaomi/mimo-v2.5',
])

/**
 * Models the official CLI's model table (`ZA` in command-code@1.26.0) marks
 * `reasoning:!0` but defines no selectable `reasoning_effort` levels — they
 * think automatically, with Command Code driving the depth. This is the
 * authoritative "thinks, effort not adjustable" set: `KNOWN_EFFORTS` (which
 * mirrors the CLI's effort map exactly) stays the sole source for selectable
 * effort levels, and this snapshot is not surfaced in the picker's compact
 * description — it exists for programmatic consumers.
 *
 * Source: the command-code@1.26.0 bundled model table (dist/cli.mjs, the `ZA`
 * object), cross-checked with https://commandcode.ai/docs/reference/cli/models.
 * Keep in sync via the dsh-commandcode-upstream skill.
 */
export const KNOWN_THINKING_MODELS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'moonshotai/Kimi-K3',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
])

/**
 * The minimum subscription plan a model is included in, per the official plan
 * pages (`/docs/plans/go`, `/docs/plans/goat`, `/docs/plans/pro`, `/docs/plans/max`
 * and `/docs/resources/pricing-limits`). Each plan's model list is a superset of
 * the one below it: Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max. Models absent from every
 * plan list (Claude Opus/Fable, Fugu Ultra) are Provider-tier.
 *
 * The Provider API exposes no plan metadata, so this snapshot is the source of
 * truth for the picker's plan annotation — it answers "which plan do I need to
 * actually use this model?" at a glance. Plan labels use the official tier
 * names (`Go`, `GOAT`, `Pro`, `Provider`), with `Max` implying Provider.
 *
 * Keep in sync with the official plan pages when they change (see the
 * dsh-commandcode-upstream skill).
 */
export const KNOWN_PLANS: Readonly<Record<string, string>> = {
  // --- Go (33) ---
  'MiniMaxAI/MiniMax-M2.5': 'go',
  'MiniMaxAI/MiniMax-M2.7': 'go',
  'MiniMaxAI/MiniMax-M3': 'go',
  'Qwen/Qwen3.6-Max-Preview': 'go',
  'Qwen/Qwen3.6-Plus': 'go',
  'Qwen/Qwen3.7-Flash': 'go',
  'Qwen/Qwen3.7-Max': 'go',
  'Qwen/Qwen3.7-Plus': 'go',
  'Qwen/Qwen3.8-Max': 'go',
  'deepseek/deepseek-v4-flash': 'go',
  'deepseek/deepseek-v4-pro': 'go',
  'gpt-5.6-luna': 'go',
  'meta/muse-spark-1.2-contributor': 'go',
  'moonshotai/Kimi-K2.5': 'go',
  'moonshotai/Kimi-K2.6': 'go',
  'moonshotai/Kimi-K2.7-Code': 'go',
  'moonshotai/Kimi-K2.7-Code-Highspeed': 'go',
  'moonshotai/Kimi-K3': 'go',
  'nvidia/nemotron-3-ultra-550b-a55b': 'go',
  'poolside/laguna-s-2.1-free': 'go',
  'stepfun/Step-3.5-Flash': 'go',
  'stepfun/Step-3.7-Flash': 'go',
  'tencent/hy3-paid': 'go',
  'thinkingmachines/inkling': 'go',
  'thinkingmachines/inkling-small': 'go',
  'xai/grok-4.5': 'go',
  'xiaomi/mimo-v2.5': 'go',
  'xiaomi/mimo-v2.5-pro': 'go',
  'zai-org/GLM-5': 'go',
  'zai-org/GLM-5.1': 'go',
  'zai-org/GLM-5.2': 'go',
  'zai-org/GLM-5.2-Fast': 'go',
  'zai-org/GLM-5.3': 'go',
  // --- GOAT (3 more) ---
  'google/gemini-3.7-flash': 'goat',
  'meta/muse-spark-1.2': 'goat',
  'xai/grok-4.6': 'goat',
  // --- Pro (14 more) ---
  'claude-haiku-4-5-20251001': 'pro',
  'claude-sonnet-4-6': 'pro',
  'claude-sonnet-5': 'pro',
  'google/gemini-3.1-flash-lite': 'pro',
  'google/gemini-3.5-flash': 'pro',
  'google/gemini-3.5-flash-lite': 'pro',
  'google/gemini-3.6-flash': 'pro',
  'gpt-5.3-codex': 'pro',
  'gpt-5.4': 'pro',
  'gpt-5.4-mini': 'pro',
  'gpt-5.5': 'pro',
  'gpt-5.6-sol': 'pro',
  'gpt-5.6-terra': 'pro',
  'meta/muse-spark-1.1': 'pro',
  // --- Provider / Max (5) ---
  'claude-fable-5': 'provider',
  'claude-opus-4-7': 'provider',
  'claude-opus-4-8': 'provider',
  'claude-opus-5': 'provider',
  'sakana/fugu-ultra': 'provider',
}

/** Official display labels for each plan tier. */
export const PLAN_LABELS: Readonly<Record<string, string>> = {
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  provider: 'Provider',
  max: 'Max',
}

/**
 * Plan-tier sort weights, low to high. Models outside the snapshot (unknown
 * plans) sort after every known tier, keeping known models predictable.
 */
export const PLAN_ORDER: Readonly<Record<string, number>> = {
  go: 0,
  goat: 1,
  pro: 2,
  provider: 3,
  max: 4,
}

/**
 * Comparator for the model picker: sort by plan tier (lowest first), then by
 * model name, then by id as a tiebreak. Models with no known plan sort last.
 */
export function compareByPlan(
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  if (pa !== pb) return pa - pb
  const nameDiff = a.name.localeCompare(b.name)
  if (nameDiff !== 0) return nameDiff
  return a.id.localeCompare(b.id)
}

/**
 * Active pricing deals per the official pricing page
 * (`/docs/resources/pricing-limits#deals`). Each entry records the model's
 * promotional label and — critically — when it expires, so the picker never
 * shows a stale discount after the plugin's snapshot has gone out of date.
 *
 * - `expiresAt` is an ISO timestamp. When it is in the past (checked at
 *   render time against `Date.now()`), the deal label is hidden until the
 *   snapshot is refreshed from the official page. `undefined` means
 *   "no expiry" (permanent).
 * - `free` marks models whose requests cost no credits (Laguna S 2.1), shown
 *   as a `FREE` badge; it degrades to a plain discount once the deal lapses.
 *
 * Keep in sync with the official pricing page when deals change (see the
 * dsh-commandcode-upstream skill).
 */
export interface KnownDeal {
  /** Promotional label, e.g. "50% off" or "2× usage". */
  label: string
  /** Deal end date (ISO). `undefined` = permanent / no expiry. */
  expiresAt?: string
  /** Model is free (requests cost no credits). */
  free?: boolean
}

export const KNOWN_DEALS: Readonly<Record<string, KnownDeal>> = {
  // Official pricing page (pricing-limits#deals): DeepSeek V4 Pro's 75%-off
  // deal is measured against the old $1.74 list rate and retires when DeepSeek
  // moves to peak/off-peak pricing on 2026-08-16 16:00 UTC - the 'expiresAt'
  // below is that exact official end timestamp, so an un-updated plugin stops
  // showing the discount the moment it lapses.
  'deepseek/deepseek-v4-pro': { label: '75% off', expiresAt: '2026-08-16T15:59:59.999Z' },
  'google/gemini-3.7-flash': { label: '50% off', expiresAt: '2026-12-31T23:59:59Z' },
  'MiniMaxAI/MiniMax-M3': { label: '50% off' },
  'xiaomi/mimo-v2.5-pro': { label: '99% off' },
  'xiaomi/mimo-v2.5': { label: '98% off' },
  'poolside/laguna-s-2.1-free': { label: 'FREE', free: true },
}

export const COMMAND_CODE_CLI_VERSION = '1.26.0'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const DEFAULT_GENERATE_MAX_TOKENS = 64_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const MODELS_TIMEOUT_MS = 10_000
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

/**
 * Official display label for a model's minimum plan, or undefined for models
 * outside the snapshot (e.g. future catalog additions).
 */
export function planLabel(modelId: string): string | undefined {
  const plan = KNOWN_PLANS[modelId]
  return plan === undefined ? undefined : PLAN_LABELS[plan]
}

/**
 * The active deal label for a model, or undefined when the model has no deal
 * or the deal has expired. Expiry is judged against `now` (defaults to
 * `Date.now()`), so a snapshot that has gone stale stops showing its discount
 * the moment the official end date passes — the user never believes a lapsed
 * deal is still live. Permanent deals (no `expiresAt`) never lapse.
 */
export function dealLabel(modelId: string, now: number = Date.now()): string | undefined {
  const deal = KNOWN_DEALS[modelId]
  if (deal === undefined) return undefined
  if (deal.expiresAt !== undefined && now >= Date.parse(deal.expiresAt)) return undefined
  return deal.label
}

/**
 * Compact human-readable context window, e.g. `1_000_000 -> "1M"`,
 * `256_000 -> "256K"`, `262_144 -> "256K"` (floor to the nearest K).
 * Returns undefined for unknown/absent sizes.
 */
export function formatContext(contextWindow: number | undefined): string | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined
  }
  if (contextWindow >= 1_000_000) {
    const m = contextWindow / 1_000_000
    // Round to one decimal only when it adds information: 1_048_576 -> "1M",
    // 1_050_000 -> "1.1M".
    const rounded = Math.round(m * 10) / 10
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`
  }
  return `${Math.floor(contextWindow / 1_000)}K`
}

/**
 * Compact one-line summary for the model picker: plan tier, then any active
 * deal (discount or FREE), then `Image` for Vision-capable models, then the
 * context window. Text-only models simply omit the Image marker — "Text only"
 * adds nothing the picker needs to show.
 */
export function capabilityDescription(
  modelId: string,
  contextWindow?: number,
  now: number = Date.now(),
): string {
  const parts: string[] = []
  const plan = planLabel(modelId)
  if (plan !== undefined) parts.push(plan)
  const deal = dealLabel(modelId, now)
  if (deal !== undefined) parts.push(deal)
  if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push('Image')
  const ctx = formatContext(contextWindow)
  if (ctx !== undefined) parts.push(ctx)
  return parts.join(' · ')
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
// Reasoning blocks are intentionally NOT replayed (matches the pi plugin and
// the official CLI: prior private reasoning must not leak into later turns).
// Only tool calls with a paired tool result are replayed.
// ---------------------------------------------------------------------------

function pairedToolCallIds(messages: readonly Message[]): Set<string> {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call') callIds.add(block.id)
      if (block.type === 'tool-result') resultIds.add(block.toolCallId)
    }
  }
  return new Set([...callIds].filter((id) => resultIds.has(id)))
}

function blockText(block: ContentBlock): string {
  return block.type === 'text' || block.type === 'reasoning' ? block.text : ''
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool-result' }>): string {
  return block.content.map(blockText).filter(Boolean).join('\n')
}

function hasImageContent(message: Message): boolean {
  const check = (blocks: readonly ContentBlock[]): boolean =>
    blocks.some(
      (b) => b.type === 'image' || (b.type === 'tool-result' && check(b.content)),
    )
  return check(message.content)
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
  const paired = pairedToolCallIds(messages)

  for (const message of messages) {
    if (message.role === 'system') continue // folded into params.system by the caller

    if (message.role === 'user' && message.source.kind !== 'tool') {
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
      out.push({ role: 'user', content: parts })
      continue
    }

    if (message.role === 'assistant') {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool-call' && paired.has(block.id)) {
          parts.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: recordOrEmpty(block.arguments),
          })
        }
        // reasoning blocks: skipped by design (see header comment)
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }

    // tool-result message (user role, single tool-result block)
    if (message.role === 'user' && message.source.kind === 'tool') {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: block.toolCallId,
            toolName: '',
            output: block.isError
              ? { type: 'error-text', value: toolResultText(block) }
              : { type: 'text', value: toolResultText(block) },
          },
        ],
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
/** Connection facts resolved fresh per request by the plugin entry. */
export interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/models`). */
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
  /** Resolve a usable API key for the given connection facts, or throw `MISSING_CREDENTIAL`. */
  resolveApiKey: (connection: C) => Promise<string>
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
  /** Five-hour rolling window limits. */
  fiveHour: { used: number; cap: number; exceeded: boolean; resetAt: number }
  /** Weekly window limits. */
  weekly: { used: number; cap: number; exceeded: boolean; resetAt: number }
}

/** Everything the usage endpoints report, fetched together. */
export interface CommandCodeUsageReport {
  account?: CommandCodeAccount
  usage?: CommandCodeUsage
  credits?: CommandCodeCredits
  /** Endpoint failures degrade the report instead of failing it. */
  failures: string[]
}

export class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private catalog: CommandCodeModel[] = []
  private readonly fetchImpl: typeof fetch
  private readonly resolveAttachments: ResolveAttachments | undefined

  constructor(private readonly deps: CommandCodeAdapterDeps<C>) {
    super()
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.resolveAttachments = deps.resolveAttachments
  }

  /**
   * Command Code is a metered subscription API: 429 (rate limit) and 5xx
   * (transient server errors) are worth retrying at the agent-step boundary,
   * which is where dsh-llm-retry executes the policy returned here. The
   * default policy already retries `RATE_LIMIT` and `SERVER`; declaring it
   * explicitly documents the intent and gives the plugin entry a stable hook
   * to override (e.g. a stricter cap for a metered plan).
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(undefined, 'llm-commandcode: retryPolicy')
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

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.loadCatalog()
    return catalog
      .map((model) => {
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
      })
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

  /**
   * Fetch account, usage, and credit state from the Command Code account
   * endpoints (`/alpha/whoami`, `/alpha/usage/summary`, `/alpha/billing/credits`).
   * Each endpoint degrades independently: a failed one lands in `failures`
   * while the rest still report, so a transient outage never blanks the whole
   * view. Requires a usable API key (throws `MISSING_CREDENTIAL` otherwise).
   */
  async getUsage(): Promise<CommandCodeUsageReport> {
    const connection = this.deps.options()
    const apiKey = await this.deps.resolveApiKey(connection)
    const base = connection.apiBase
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'x-command-code-version': COMMAND_CODE_CLI_VERSION,
      'x-cli-environment': 'production',
      ...attributionHeaders(),
    }
    const failures: string[] = []

    const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const response = await this.fetchImpl(`${base}${path}`, { headers })
        if (!response.ok) {
          failures.push(`${path}: HTTP ${response.status}`)
          return undefined
        }
        const parsed: unknown = await response.json()
        return isRecord(parsed) ? parsed : undefined
      } catch (error: unknown) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    const report: CommandCodeUsageReport = { failures }

    // whoami -> account identity.
    const whoami = await getJson('/alpha/whoami')
    const whoamiData = whoami && isRecord(whoami.user) ? whoami.user : undefined
    if (whoamiData) {
      report.account = {
        id: stringValue(whoamiData.id) ?? '',
        name: stringValue(whoamiData.name) ?? '',
        userName: stringValue(whoamiData.userName) ?? '',
      }
    }

    // usage/summary -> totals.
    const usage = await getJson('/alpha/usage/summary')
    if (usage) {
      report.usage = {
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

    // billing/credits -> credit + window limits.
    const credits = await getJson('/alpha/billing/credits')
    const creditsData = credits && isRecord(credits.credits) ? credits.credits : undefined
    const windowLimits = credits && isRecord(credits.windowLimits) ? credits.windowLimits : undefined
    const fiveHour = windowLimits && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined
    const weekly = windowLimits && isRecord(windowLimits.weekly) ? windowLimits.weekly : undefined
    if (creditsData || fiveHour || weekly) {
      report.credits = {
        monthlyCredits: numberValue(creditsData?.monthlyCredits) ?? 0,
        purchasedCredits: numberValue(creditsData?.purchasedCredits) ?? 0,
        freeCredits: numberValue(creditsData?.freeCredits) ?? 0,
        fiveHour: {
          used: numberValue(fiveHour?.used) ?? 0,
          cap: numberValue(fiveHour?.cap) ?? 0,
          exceeded: fiveHour?.exceeded === true,
          resetAt: numberValue(fiveHour?.resetAt) ?? 0,
        },
        weekly: {
          used: numberValue(weekly?.used) ?? 0,
          cap: numberValue(weekly?.cap) ?? 0,
          exceeded: weekly?.exceeded === true,
          resetAt: numberValue(weekly?.resetAt) ?? 0,
        },
      }
    }

    return report
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
    const apiKey = await this.deps.resolveApiKey(connection)
    const entry = this.catalog.find((m) => m.id === options.model)
    const modelMax = entry?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
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

    const body = {
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
        messages: await messagesToCC(options.messages, readImage),
        tools: (options.tools ?? []).map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        system: systemText,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    }

    // requestTimeoutMs must only bound the wait for response headers.
    // Passing AbortSignal.timeout() straight into fetch() also aborts a healthy
    // body after that duration, which cuts long reasoning/generation mid-stream
    // and surfaces as "failed while reading: aborted due to timeout". After
    // headers arrive, only the caller signal and streamIdleTimeoutMs may abort.
    const connectAbort = new AbortController()
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      connectAbort.abort(
        new DOMException(
          `Command Code API request to ${connection.apiBase}/alpha/generate did not respond within ${connection.requestTimeoutMs}ms`,
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

    let response: Response
    try {
      response = await this.fetchImpl(`${connection.apiBase}/alpha/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'x-command-code-version': COMMAND_CODE_CLI_VERSION,
          'x-cli-environment': 'production',
          'x-project-slug': projectSlugFromPath(connection.workingDir),
          'x-taste-learning': 'true',
          'x-co-flag': 'false',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: connectAbort.signal,
      })
      clearTimeout(connectTimer)
    } catch (error: unknown) {
      clearTimeout(connectTimer)
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort)
      }
      if (options.signal?.aborted) {
        throw error
      }
      if (connectTimedOut || (error instanceof DOMException && error.name === 'TimeoutError')) {
        throw new LlmError(
          `Command Code API request to ${connection.apiBase}/alpha/generate did not respond within ${connection.requestTimeoutMs}ms`
          + `: ${errorChain(error)}`,
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
        `Command Code API request to ${connection.apiBase}/alpha/generate failed: ${errorChain(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort)
      }
      const errText = await response.text().catch(() => '')
      // Command Code folds several business rejections into 403 (plan limits,
      // CLI version, model access). Prefer the machine-readable `error.code`
      // when present; the status alone cannot distinguish them.
      let providerCode: string | undefined
      try {
        const parsed: unknown = JSON.parse(errText)
        if (isRecord(parsed) && isRecord(parsed.error)) {
          providerCode = stringValue(parsed.error.code)
        }
      } catch {
        // Plain-text bodies: rely on the status mapping below.
      }
      const detail = providerCode ?? `HTTP ${response.status}`
      if (response.status === 401) {
        // An invalid or missing credential is a config problem, not a
        // transport failure: retrying it identically cannot succeed.
        throw new LlmError(
          `Command Code API error 401 (${detail}): the API key is missing or invalid — check the`
          + ' key stored for COMMANDCODE_API_KEY (Models page) or the auth file',
          'INVALID_CREDENTIAL',
          { status: 401 },
        )
      }
      throw new LlmError(
        `Command Code API error ${response.status}${detail === `HTTP ${response.status}` ? '' : ` (${detail})`}: ${errText.slice(0, 500)}`,
        response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_HTTP_ERROR',
        { status: response.status },
      )
    }
    if (!response.body) {
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort)
      }
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

    // Block assembly state: at most one text block and one reasoning block
    // are open at a time (same assumption as the pi plugin).
    let nextIndex = 0
    let textIndex = -1
    let textContent = ''
    let reasoningIndex = -1
    let reasoningContent = ''
    let sawContent = false

    const closeText = function* (): Generator<StreamChunk> {
      if (textIndex < 0) return
      yield {
        type: 'block-end',
        index: textIndex,
        block: { type: 'text', text: textContent },
      }
      textIndex = -1
      textContent = ''
    }
    const closeReasoning = function* (): Generator<StreamChunk> {
      if (reasoningIndex < 0) return
      yield {
        type: 'block-end',
        index: reasoningIndex,
        block: { type: 'reasoning', text: reasoningContent },
      }
      reasoningIndex = -1
      reasoningContent = ''
    }

    const handleEvent = (event: unknown): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      if (!isRecord(event)) return chunks

      switch (event.type) {
        case 'text-delta': {
          chunks.push(...closeReasoning())
          if (textIndex < 0) {
            textIndex = nextIndex++
            chunks.push({ type: 'block-start', index: textIndex, blockType: 'text' })
          }
          const delta = stringValue(event.text) ?? ''
          textContent += delta
          sawContent = true
          chunks.push({ type: 'text-delta', index: textIndex, text: delta })
          break
        }
        case 'reasoning-delta': {
          chunks.push(...closeText())
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++
            chunks.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
          }
          const delta = stringValue(event.text) ?? ''
          reasoningContent += delta
          chunks.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta })
          break
        }
        case 'reasoning-start':
          chunks.push(...closeText())
          break
        case 'reasoning-end':
          chunks.push(...closeReasoning())
          break
        case 'tool-call': {
          chunks.push(...closeText(), ...closeReasoning())
          const id = stringValue(event.toolCallId) ?? randomUUID()
          const name = stringValue(event.toolName) ?? ''
          const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments))
          const index = nextIndex++
          sawContent = true
          chunks.push(
            { type: 'block-start', index, blockType: 'tool-call' },
            { type: 'tool-call-delta', index, id: CallId(id), name, argumentsDelta: args },
            {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id: CallId(id), name, arguments: args },
            },
          )
          break
        }
        case 'finish': {
          chunks.push(...closeText(), ...closeReasoning())
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
          // Mirror the official CLI's stream-error classification
          // (readStreamErrorEvent + isStreamErrorRetryable in command-code's
          // cli.mjs): a stream error that is explicitly non-retryable, carries
          // a terminal marker (quota/plan/credits), or reports a non-retryable
          // HTTP status is a hard failure; anything else is a transient
          // mid-stream drop that the harness's default retry policy should
          // retry (SERVER is in the default retryable set, PROVIDER_STREAM_ERROR
          // is not). Without this, a server-side blip that the official CLI
          // silently recovers from fails the whole turn.
          const err = isRecord(event.error) ? event.error : undefined
          const detail = isRecord(event.error)
            ? (stringValue(event.error.message) ?? JSON.stringify(event.error))
            : (stringValue(event.error) ?? stringValue(event.message) ?? 'Stream error')
          const statusCode = err ? numberValue(err.statusCode) : undefined
          const isRetryable = err ? booleanValue(err.isRetryable) : undefined
          const retryableStatus = statusCode !== undefined && (statusCode === 429 || statusCode >= 500)
          const terminal = hasTerminalStreamMarker(detail)
          const retryable = isRetryable === true
            || (statusCode !== undefined ? retryableStatus : (isRetryable !== false && !terminal))
          if (!retryable) {
            throw new LlmError(
              `Command Code stream error: ${detail}`,
              'PROVIDER_STREAM_ERROR',
              statusCode !== undefined ? { status: statusCode } : undefined,
            )
          }
          throw new LlmError(
            `Command Code stream error: ${detail}`,
            'SERVER',
            statusCode !== undefined ? { status: statusCode } : undefined,
          )
        }
      }
      return chunks
    }

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
            `Command Code API stream from ${connection.apiBase} failed while reading: ${errorChain(error)}`,
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
              + ' (no events) and was treated as a dead connection',
              'TIMEOUT',
            )
          }
          if (buffer.trim()) for (const chunk of handleEvent(parseStreamEventLine(buffer))) yield chunk
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const chunks = handleEvent(parseStreamEventLine(line))
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
        yield* closeText()
        yield* closeReasoning()
        if (!sawContent) {
          throw new LlmError('Command Code returned an empty response', 'EMPTY_RESPONSE')
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } finally {
      clearIdle()
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort)
      }
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

function mapFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool-calls') return { kind: 'tool-calls' }
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
