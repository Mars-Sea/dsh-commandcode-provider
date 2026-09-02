/**
 * Static capability snapshot for the Command Code provider: model →
 * reasoning-effort levels, vision/thinking flags, model → minimum plan tier,
 * subscription-plan labels, deals, and hourly (peak/off-peak) pricing.
 *
 * Everything in this module is synced from official sources (the command-code
 * CLI bundle's model table and the official plan/pricing/model docs — see the
 * dsh-commandcode-upstream skill for the exact extraction procedures), and
 * changes whenever an upstream CLI release reshuffles models/plans/prices.
 * Keeping the snapshot in its own module confines those frequent sync diffs
 * here: src/adapter.ts holds only the stable wire/runtime logic and imports
 * these tables + read helpers.
 *
 * Snapshot read helpers (planLabel, dealLabel, formatContext,
 * capabilityDescription, peakPricing*, compareByPlan, modelVisibleInPlan,
 * subscriptionPlanInfo, isFreeModel) live here too — they exist only to read
 * the tables, so a sync never has to touch src/adapter.ts.
 *
 * Ported from pi-commandcode-provider (MIT); originally part of src/adapter.ts
 * and split out so upstream syncs stay reviewable.
 */
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
  // `claude-fable-5-1` (Claude Fable 5.1, command-code@1.40.0) ships the same
  // five-level effort set as its predecessor `claude-fable-5` and is served
  // by the Provider API (the Provider/Max tier; see KNOWN_PLANS).
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
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
  'claude-fable-5-1',
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
 * `claude-fable-5-1` (Claude Fable 5.1, added in command-code@1.40.0) is
 * Provider/Max-tier exactly like `claude-fable-5` — its availability matrix on
 * the official plan/pricing pages grants individual-provider/max/ultra and
 * teams-pro only, and the CLI's plan-access map blocks it on Go/GOAT/Pro.
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
  // --- Go (43) ---
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
  // --- Provider / Max (6) ---
  'claude-fable-5-1': 'provider',
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

// ---------------------------------------------------------------------------
// Snapshot read helpers (kept with the tables: a model/plan/deal sync must
// never touch src/adapter.ts)
// ---------------------------------------------------------------------------
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
