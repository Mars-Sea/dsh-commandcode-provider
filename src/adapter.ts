/**
 * DeepSeek Harness LLM adapter for the Command Code Provider API.
 *
 * Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
 * community-maintained integration; you need your own Command Code account
 * and API key or subscription, and Command Code's terms apply.
 *
 * Wire protocol (reverse-engineered by the pi plugin, command-code@1.28.4;
 * re-verified against command-code@1.40.1 — endpoints, request shape, and
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
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { RETRY_MAX_DELAY_MS } from './accounts.ts'

/**
 * Brand a provider-issued tool-call id through the host chunk vocabulary.
 *
 * Do not named-import `CallId` / `ToolCallId` from `@deepseek-ai/dsh-llm`.
 * rc.6 / 0.1.1-rc.1 export `CallId`; 0.1.2-alpha.1 renamed that constructor
 * to `ToolCallId`. A missing named ESM export fails plugin-tree load before
 * any adapter code runs (deepseek-ai/deepseek-harness#4827).
 */
function toolCallId(id: string): Extract<StreamChunk, { type: 'tool-call-delta' }>['id'] {
  return id as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
}

// ---------------------------------------------------------------------------
// Static capability snapshot (from the official command-code@1.40.1 bundled
// model catalog, dist/cli.mjs). The Provider API does not expose reasoning
// metadata; models omitted here let Command Code choose their reasoning
// depth, matching the official CLI.
// ---------------------------------------------------------------------------

export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // Re-verified against the authoritative command-code@1.40.1 bundled model
  // table (dist/cli.mjs, the provider effort map): exactly these models carry
  // selectable efforts. Models marked 'reasoning:!0' without efforts
  // (e.g. MiniMax M3, Muse Spark 1.1, Tencent Hy3, GLM-5/5.1/5.2-Fast)
  // think automatically and are absent here - the CLI omits
  // 'reasoning_effort' for them, so the picker must not offer a selector. Do
  // NOT add entries from the OAuth provider tables (anthropic/openai) - only
  // the Provider-API table is authoritative for this plugin's route.
  // `stealth/ox-alpha` (['low', 'high', 'max']) was removed in
  // command-code@1.34.0 when its preview ended; its successor,
  // `z-ai/glm-5.3-flash`, ships the same effort set.
  // `tencent/hy4-preview` gained ['low', 'medium', 'high'] in
  // command-code@1.38.0 (it previously thought automatically with no
  // selectable levels).
  // `moonshotai/Kimi-K3` gained ['low', 'high', 'max'] in command-code@1.39.3
  // (it previously thought automatically with no selectable levels).
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  // `deepseek/deepseek-v4-flash-fast` joined in command-code@1.39.0
  // ("Add DeepSeek V4 Flash Fast"); 1.39.1 dropped `medium` for it, and
  // the 1.39.2 table ships ['low', 'high', 'max'].
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['high', 'max'],
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
  // `moonshotai/Kimi-K3` gained selectable ['low', 'high', 'max'] efforts in
  // command-code@1.39.3 ("Add low, high, and max reasoning effort support for
  // Kimi K3"); it previously reasoned automatically with no levels.
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
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
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Max',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'deepseek/deepseek-v4-flash-vision-exp',
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
  'minimax/minimax-m3-free',
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
  'z-ai/glm-5.3-flash',
])

/**
 * Models the official CLI's model table (command-code@1.40.1) marks
 * `reasoning:!0` but defines no selectable `reasoning_effort` levels — they
 * think automatically, with Command Code driving the depth. This is the
 * authoritative "thinks, effort not adjustable" set: `KNOWN_EFFORTS` (which
 * mirrors the CLI's effort map exactly) stays the sole source for selectable
 * effort levels, and this snapshot is not surfaced in the picker's compact
 * description — it exists for programmatic consumers.
 *
 * Source: the command-code@1.40.1 bundled model table (dist/cli.mjs),
 * cross-checked with https://commandcode.ai/docs/reference/cli/models.
 * (`stealth/ox-alpha` left this set in command-code@1.32.1, which gave it
 * selectable `['low', 'high', 'max']` efforts; the preview then ended in
 * 1.34.0, removing the model from the catalog entirely. `tencent/hy4-preview`
 * joined this set in command-code@1.37.0 — reasoning:!0, no efforts, 1M
 * context, routed through OpenRouter — then gained selectable
 * `['low', 'medium', 'high']` efforts in command-code@1.38.0 and moved to
 * `KNOWN_EFFORTS`. `moonshotai/Kimi-K3` followed the same path in
 * command-code@1.39.3 — it gained `['low', 'high', 'max']` efforts and moved
 * to `KNOWN_EFFORTS`.)
 * Keep in sync via the dsh-commandcode-upstream skill.
 */
export const KNOWN_THINKING_MODELS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'minimax/minimax-m3-free',
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
  // --- Go (42) ---
  'MiniMaxAI/MiniMax-M2.5': 'go',
  'MiniMaxAI/MiniMax-M2.7': 'go',
  'MiniMaxAI/MiniMax-M3': 'go',
  'Qwen/Qwen3.6-Max-Preview': 'go',
  'Qwen/Qwen3.6-Plus': 'go',
  'Qwen/Qwen3.7-Flash': 'go',
  'Qwen/Qwen3.7-Max': 'go',
  'Qwen/Qwen3.7-Plus': 'go',
  'Qwen/Qwen3.8-27B': 'go',
  'Qwen/Qwen3.8-Flash': 'go',
  'Qwen/Qwen3.8-Max': 'go',
  // command-code@1.39.0 added DeepSeek V4 Flash Fast; it is a Go-tier model
  // alongside the rest of the DeepSeek V4 family.
  'deepseek/deepseek-v4-flash-fast': 'go',
  'deepseek/deepseek-v4-flash': 'go',
  'deepseek/deepseek-v4-flash-vision-exp': 'go',
  'deepseek/deepseek-v4-pro': 'go',
  'gpt-5.6-luna': 'go',
  'inclusionai/ling-3.0-flash-free': 'go',
  'meta/muse-spark-1.2-contributor': 'go',
  'minimax/minimax-m2.7-free': 'go',
  'minimax/minimax-m3-free': 'go',
  'moonshotai/Kimi-K2.5': 'go',
  'moonshotai/Kimi-K2.6': 'go',
  'moonshotai/Kimi-K2.7-Code': 'go',
  'moonshotai/Kimi-K2.7-Code-Highspeed': 'go',
  'moonshotai/Kimi-K3': 'go',
  'nvidia/nemotron-3-ultra-550b-a55b': 'go',
  'poolside/laguna-s-2.1-free': 'go',
  'stepfun/Step-3.5-Flash': 'go',
  'stepfun/Step-3.7-Flash': 'go',
  'tencent/Hy3': 'go',
  'tencent/hy3-paid': 'go',
  'tencent/hy4-preview': 'go',
  'thinkingmachines/inkling': 'go',
  'thinkingmachines/inkling-small': 'go',
  'xai/grok-4.5': 'go',
  'xiaomi/mimo-v2.5': 'go',
  'xiaomi/mimo-v2.5-pro': 'go',
  'z-ai/glm-5.3-flash': 'go',
  'zai-org/GLM-5': 'go',
  'zai-org/GLM-5.1': 'go',
  'zai-org/GLM-5.2': 'go',
  'zai-org/GLM-5.2-Fast': 'go',
  'zai-org/GLM-5.3': 'go',
  // --- GOAT (4 more) ---
  'google/gemini-3.7-flash': 'goat',
  'gpt-5.6-sol': 'goat',
  'meta/muse-spark-1.2': 'goat',
  'xai/grok-4.6': 'goat',
  // --- Pro (13 more) ---
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
 * Whether a model is free (requests cost no credits), per the pricing page's
 * deals (`KNOWN_DEALS` `free: true`). Free models lead the picker regardless
 * of tier — they are usable by every account, so they are the best default
 * candidates.
 */
export function isFreeModel(modelId: string): boolean {
  return KNOWN_DEALS[modelId]?.free === true
}

/**
 * Comparator for the model picker: free models first (zero credit cost, usable
 * by every account), then by plan tier (lowest first), then by model name,
 * then by id as a tiebreak. Models with no known plan sort last.
 */
export function compareByPlan(
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  const freeDelta = Number(isFreeModel(b.id)) - Number(isFreeModel(a.id))
  if (freeDelta !== 0) return freeDelta
  const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  if (pa !== pb) return pa - pb
  const nameDiff = a.name.localeCompare(b.name)
  if (nameDiff !== 0) return nameDiff
  return a.id.localeCompare(b.id)
}

/**
 * Subscription plan table, synced from the official CLI bundle's plan maps
 * (`Nn`/`$n` in command-code@1.31.0 `dist/cli.mjs`, re-verified unchanged
 * against 1.32.2 where they appear as `Zn`/`er`): subscription `planId`
 * prefix → display name and the plan's monthly credit total. This is the
 * account's own subscription (from `/alpha/billing/subscriptions`) — distinct
 * from {@link KNOWN_PLANS}, which maps catalog models to their minimum tier.
 *
 * `tierWeight` is plugin-added (not from the CLI maps): the plan's rank on
 * the {@link PLAN_ORDER} scale, used by the picker's plan filter
 * ({@link modelVisibleInPlan}) to hide models above the account's tier.
 */
export const KNOWN_SUBSCRIPTION_PLANS: Readonly<Record<string, { name: string; monthlyCredits: number; tierWeight: number }>> = {
  'individual-go': { name: 'Go', monthlyCredits: 10, tierWeight: 0 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70, tierWeight: 1 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30, tierWeight: 2 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80, tierWeight: 2 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15, tierWeight: 3 },
  'individual-max': { name: 'Max', monthlyCredits: 150, tierWeight: 4 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300, tierWeight: 4 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40, tierWeight: 2 },
}

/** Plan-id prefixes, longest first — the CLI's prefix-match order. */
const SUBSCRIPTION_PLAN_PREFIXES = Object.keys(KNOWN_SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length)

/**
 * Resolve a subscription `planId` (e.g. `individual-pro-v1`) to its display
 * name and monthly credit total, mirroring the CLI's `getPlanInfo`:
 * normalize (lowercase, `_` → `-`), then longest-prefix match so
 * `individual-pro-v1` wins over `individual-pro`. Unknown ids return
 * `undefined`.
 */
export function subscriptionPlanInfo(planId: string): { name: string; monthlyCredits: number; tierWeight: number } | undefined {
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  const prefix = SUBSCRIPTION_PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate))
  return prefix === undefined ? undefined : KNOWN_SUBSCRIPTION_PLANS[prefix]
}

/**
 * The billing facts the picker's plan filter needs, fetched by mirroring the
 * CLI's `createBilling` flow (whoami → orgId, then `/alpha/billing/subscriptions`
 * for the plan id and `/alpha/billing/credits` for the on-demand balances).
 */
export interface CommandCodeBillingAccess {
  /** Account plan tier weight on the {@link PLAN_ORDER} scale; undefined when the plan is unknown. */
  tierWeight: number | undefined
  /**
   * Purchased + free on-demand credit balance. The official access model
   * (`evaluateModelAccess` in the CLI) allows every model when the account
   * holds any on-demand credits — the plan gate only applies at zero balance.
   */
  onDemandCredits: number
}

/**
 * Whether the picker lists `modelId` for an account with the given billing
 * access. Fails open at every uncertainty: no billing data, an unknown plan,
 * or a model outside {@link KNOWN_PLANS} all keep the model visible — the
 * server remains the final gate (`403 MODEL_NOT_IN_PLAN`).
 */
export function modelVisibleInPlan(modelId: string, access: CommandCodeBillingAccess | undefined): boolean {
  if (access === undefined) return true
  if (access.onDemandCredits > 0) return true
  if (access.tierWeight === undefined) return true
  const tier = KNOWN_PLANS[modelId]
  if (tier === undefined) return true
  const weight = PLAN_ORDER[tier]
  if (weight === undefined) return true
  return weight <= access.tierWeight
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
  // Gemini 3.7 Flash's 50% off deal was retired from the official pricing
  // page's #deals section (command-code@1.38.2 sync); the model now shows at
  // full price.
  'MiniMaxAI/MiniMax-M3': { label: '50% off' },
  'xiaomi/mimo-v2.5-pro': { label: '99% off' },
  'xiaomi/mimo-v2.5': { label: '98% off' },
  // The MiniMax M3 / M2.7 FREE promo variants were retired in
  // command-code@1.39.2 ("Retire MiniMax free models"): the official CLI hides
  // them and the pricing page no longer lists them as free, so the free
  // entries that shipped through 1.38.2 (with a 2026-09-05 expiry) are removed
  // here rather than left to lapse on schedule. The paid MiniMax M3 / M2.7
  // rows keep their own rates.
  'poolside/laguna-s-2.1-free': { label: 'FREE', free: true },
}

/**
 * Models with time-of-day (peak/off-peak) pricing, per the official pricing
 * page (`/docs/resources/pricing-limits`). Since 2026-08-16 16:00 UTC, DeepSeek
 * charges by the hour: peak hours are 01:00–04:00 and 06:00–10:00 UTC (7h/day,
 * full price); the other 17 hours are off-peak at half price. The V4 Flash
 * Vision (exp) variant (command-code@1.32.0) shares the V4 Flash windows and
 * peak prices ($0.44/$1.32) — each row's hover annotation states exactly 2×
 * that row's displayed off-peak prices. The picker shows the
 * *current* state as a compact
 * label (`Peak`/`Half`) matching the English noun style of the other markers
 * (`Image`, `FREE`), so a developer can tell at a glance whether calling the
 * model right now is cheap or expensive.
 *
 * Extraction caution: in the page's HTML each annotation div sits inside its
 * OWN row's container, immediately before the NEXT row starts — flattening
 * the page to text makes every annotation look like it belongs to the model
 * printed after it. Verify membership against the enclosing row and the 2×
 * price relation, not the flat-text neighbor.
 *
 * Keep in sync with the official pricing page when the model set or the peak
 * windows change (see the dsh-commandcode-upstream skill).
 */
export const KNOWN_PEAK_PRICING: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  // Added in command-code@1.39.0: DeepSeek V4 Flash Fast shares the V4 Flash
  // peak windows and peak prices ($0.44 / $1.32 per the pricing page's
  // off-peak annotation).
  'deepseek/deepseek-v4-flash-fast',
])

/** Peak hours (UTC, hour-of-day range end-exclusive): 01–03 and 06–09. */
const PEAK_HOUR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
]

/**
 * Whether `now` (defaults to `Date.now()`) falls in a peak-pricing hour for
 * time-of-day-priced models. `undefined` for models outside the snapshot.
 */
export function peakPricingState(
  modelId: string,
  now: number = Date.now(),
): 'peak' | 'off-peak' | undefined {
  if (!KNOWN_PEAK_PRICING.has(modelId)) return undefined
  const hour = new Date(now).getUTCHours()
  const inPeak = PEAK_HOUR_RANGES.some(([start, end]) => hour >= start && hour < end)
  return inPeak ? 'peak' : 'off-peak'
}

/**
 * Compact label for the current peak/off-peak state: `Peak` (full price) or
 * `Half` (off-peak, half price). These English nouns match the picker's other
 * markers (`Go`, `Image`, `FREE`), and since they appear only on time-of-day
 * priced models they double as a "priced by the hour" signal. Returns undefined
 * for models without time-of-day pricing.
 */
export function peakPricingLabel(
  modelId: string,
  now: number = Date.now(),
): string | undefined {
  const state = peakPricingState(modelId, now)
  if (state === undefined) return undefined
  return state === 'peak' ? 'Peak' : 'Half'
}

export const COMMAND_CODE_CLI_VERSION = '1.40.1'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const DEFAULT_GENERATE_MAX_TOKENS = 64_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const MODELS_TIMEOUT_MS = 10_000
/** How long the picker's plan-filter billing facts stay cached before refetching. */
export const BILLING_ACCESS_TTL_MS = 5 * 60_000

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
 * deal (discount or FREE), then the current peak/off-peak state (`Peak`/`Half`)
 * for time-of-day-priced models, then `Image` for Vision-capable models, then
 * the context window. Text-only models simply omit the Image marker — "Text
 * only" adds nothing the picker needs to show.
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
  const peak = peakPricingLabel(modelId, now)
  if (peak !== undefined) parts.push(peak)
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
  const { ids: paired, names: toolNames } = pairedToolCalls(messages)

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
            // `paired` guarantees a call with this id exists, so the map
            // always hits; `|| 'unknown'` also guards an empty call name
            // (matches the official CLI's `?? "unknown"` fallback).
            toolName: toolNames.get(block.toolCallId) || 'unknown',
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
  /**
   * Whether the picker hides models above the account's subscription tier
   * (default true). The filter fails open: unknown plan, billing-endpoint
   * failure, a positive on-demand credit balance, or an unmapped model all
   * keep the full catalog visible. Set false to always list every model.
   */
  filterModelsByPlan?: boolean
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
  /** Five-hour rolling window limits. */
  fiveHour: { used: number; cap: number; exceeded: boolean; resetAt: number }
  /** Weekly window limits. */
  weekly: { used: number; cap: number; exceeded: boolean; resetAt: number }
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

export class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private catalog: CommandCodeModel[] = []
  private readonly fetchImpl: typeof fetch
  private readonly resolveAttachments: ResolveAttachments | undefined
  // Billing facts are per account: with a multi-account pool each key has its
  // own subscription tier, so the cache and the in-flight dedupe are keyed by
  // the resolved API key (process-local only, never logged).
  private readonly billingAccess = new Map<string, { value: CommandCodeBillingAccess | undefined; at: number }>()
  private readonly billingAccessInflight = new Map<string, Promise<CommandCodeBillingAccess | undefined>>()

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

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.loadCatalog()
    // Plan filter: hide models above the account's subscription tier. Fails
    // open — a billing-fetch problem, an unknown plan, or a positive
    // on-demand balance all keep the full catalog visible, and the server
    // remains the final gate (403 MODEL_NOT_IN_PLAN). The catalog itself is
    // never filtered: resolveModel still serves every model.
    const access = this.deps.options().filterModelsByPlan === false
      ? undefined
      : await this.loadBillingAccess()
    return catalog
      .filter((model) => modelVisibleInPlan(model.id, access))
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
      const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
        const response = await this.fetchImpl(`${base}${path}`, {
          headers,
          // A hung billing connection must not stall the picker forever.
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        })
        if (!response.ok) return undefined
        const parsed: unknown = await response.json()
        return isRecord(parsed) ? parsed : undefined
      }
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
        const response = await this.fetchImpl(`${base}${path}`, {
          headers,
          // A hung account endpoint degrades into `failures` instead of
          // stalling the usage card / command forever.
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        })
        if (!response.ok) {
          failures.push(`${path}: HTTP ${response.status}`)
          failedStatuses.push(response.status)
          return undefined
        }
        const parsed: unknown = await response.json()
        return isRecord(parsed) ? parsed : undefined
      } catch (error: unknown) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        failedStatuses.push(undefined)
        return undefined
      }
    }

    const report: CommandCodeUsageReport = { failures }

    // whoami -> account identity (+ org id for the billing endpoints).
    const whoami = await getJson('/alpha/whoami')
    const whoamiData = whoami && isRecord(whoami.user) ? whoami.user : undefined
    if (whoamiData) {
      report.account = {
        id: stringValue(whoamiData.id) ?? '',
        name: stringValue(whoamiData.name) ?? '',
        userName: stringValue(whoamiData.userName) ?? '',
      }
    }
    const orgData = whoami && isRecord(whoami.org) ? whoami.org : undefined
    const orgId = orgData === undefined ? undefined : stringValue(orgData.id)

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

    // billing/subscriptions -> plan identity + billing period. The credits
    // response may also carry a planId; it is the fallback when the
    // subscriptions endpoint fails. Mirrors the CLI: orgId rides as a query
    // param when whoami reported one.
    const subscription = await getJson(orgId === undefined
      ? '/alpha/billing/subscriptions'
      : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`)
    const subData = subscription && isRecord(subscription.data) ? subscription.data : undefined
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

    // Classify a TOTAL failure: when every endpoint failed with one class of
    // error, the degraded per-endpoint view would hide the root cause behind
    // a generic "partial data" note — name it instead. Four endpoints are
    // fetched (whoami, usage/summary, billing/credits, billing/subscriptions;
    // the last may carry an orgId query, so classification counts, not paths).
    if (failures.length === USAGE_ENDPOINT_COUNT) {
      const codes = failedStatuses.filter((status): status is number => status !== undefined)
      if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code === 401)) {
        report.blocked = 'invalid-key'
      } else if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code >= 500)) {
        report.blocked = 'service-unavailable'
      } else if (codes.length === 0) {
        report.blocked = 'network'
      }
    }

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
    //
    // One connect attempt per account key: a pre-stream 429/401 hands the key
    // to the multi-account rotation hook (when the host wired one) and retries
    // with the next account — the request body is account-independent and
    // nothing has streamed yet, so the switch is invisible to the caller.
    const connect = async (
      key: string,
    ): Promise<{ response: Response; cleanup: () => void } | { status: number; errText: string; retryAfterMs?: number }> => {
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
      // On success the caller-abort listener must outlive the connect phase
      // (it aborts a stalled body read), so the streaming tail calls cleanup;
      // every failure path cleans up before returning or throwing.
      const cleanup = () => {
        clearTimeout(connectTimer)
        if (options.signal) {
          options.signal.removeEventListener('abort', onCallerAbort)
        }
      }

      let response: Response
      try {
        response = await this.fetchImpl(`${connection.apiBase}/alpha/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
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
        cleanup()
        if (options.signal?.aborted) {
          throw error
        }
        if (connectTimedOut || (error instanceof DOMException && error.name === 'TimeoutError')) {
          throw new LlmError(
            `Command Code API request to ${connection.apiBase}/alpha/generate did not respond within ${connection.requestTimeoutMs}ms`
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
          `Command Code API request to ${connection.apiBase}/alpha/generate failed: ${errorChain(error)}`
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

    // Account rotation loop: the first attempt uses the pool's active key; a
    // pre-stream 429/401 rotates to the next account (at most one attempt per
    // distinct key, hard-capped so a misbehaving hook cannot loop forever).
    const tried = new Set<string>()
    let connected: { response: Response; cleanup: () => void } | undefined
    for (;;) {
      tried.add(apiKey)
      const attempt = await connect(apiKey)
      if ('response' in attempt) {
        connected = attempt
        break
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
            { type: 'tool-call-delta', index, id: toolCallId(id), name, argumentsDelta: args },
            {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id: toolCallId(id), name, arguments: args },
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

/** Hard cap on account rotations within one request (one attempt per distinct key). */
const MAX_ACCOUNT_ROTATIONS = 16

/**
 * Map a pre-stream generate HTTP failure onto a stable LlmError. Command
 * Code folds several business rejections into 403 (plan limits, CLI version,
 * model access): prefer the machine-readable `error.code` when present; the
 * status alone cannot distinguish them. A 429's `Retry-After` rides along as
 * `providerRetryAfterMs` so dsh-llm-retry can wait exactly that long instead
 * of guessing at the backoff cadence — capped at RETRY_MAX_DELAY_MS, because
 * in normal mode a longer attached wait makes the executor abandon the retry
 * outright instead of falling back to local backoff.
 */
function generateHttpError(status: number, errText: string, retryAfterMs?: number): LlmError {
  let providerCode: string | undefined
  try {
    const parsed: unknown = JSON.parse(errText)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      providerCode = stringValue(parsed.error.code)
    }
  } catch {
    // Plain-text bodies: rely on the status mapping below.
  }
  const detail = providerCode ?? `HTTP ${status}`
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
  return new LlmError(
    `Command Code API error ${status}${detail === `HTTP ${status}` ? '' : ` (${detail})`}: ${errText.slice(0, 500)}`,
    status === 429 ? 'RATE_LIMIT' : 'PROVIDER_HTTP_ERROR',
    {
      status,
      ...(retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= RETRY_MAX_DELAY_MS
        ? { providerRetryAfterMs: retryAfterMs }
        : {}),
    },
  )
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
