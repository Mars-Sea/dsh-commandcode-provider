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
 * This snapshot lives in its own module so the frequent CLI/doc sync diffs stay
 * reviewable: src/adapter.ts holds only the stable wire/runtime logic.
 */
// ---------------------------------------------------------------------------
// Static capability snapshot (from the official command-code@1.53.0 bundled
// model catalog, dist/cli.mjs). The Provider API does not expose reasoning
// metadata; models omitted here let Command Code choose their reasoning
// depth, matching the official CLI.
// ---------------------------------------------------------------------------

export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // Re-verified against the authoritative command-code@1.53.0 bundled model
  // table (dist/cli.mjs, the provider effort map): exactly these models carry
  // selectable efforts. Models marked 'reasoning:!0' without efforts
  // (e.g. Tencent Hy3, GLM-5/5.1/5.2-Fast)
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
  // command-code@1.41.0 added `Qwen/Qwen3.8-Max-0902` and command-code@1.43.0
  // added `google/gemini-3.8-flash`; both carry effort sets matching their
  // existing family members. command-code@1.45.0 added selectable
  // ['low', 'medium', 'high', 'xhigh'] efforts for the Muse Spark family
  // (1.1, 1.2, 1.2-contributor, 1.3, 1.3-contributor); they previously reasoned
  // automatically with no selectable levels. command-code@1.48.0 added the
  // `max` effort tier to Muse Spark 1.3 (previously ['low','medium','high',
  // 'xhigh']); 1.3 and 1.3-contributor now ship different effort sets.
  // command-code@1.49.0 added `gpt-6-astra` with the five-level effort set.
  // command-code@1.51.0 briefly added `deepseek/deepseek-v4.1-flash-beta`
  // (text+image, reasoning without selectable efforts, hidden behind a
  // 2026-09-10 expiry gate); command-code@1.51.2 removed it from the bundle
  // entirely, so no snapshot entry is needed.
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-0902': ['low', 'medium', 'xhigh'],
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
  // command-code@1.53.0 added DeepSeek V4.1 Flash ("Add new
  // deepseek/deepseek-v4.1-flash model"); the bundle ships
  // ['low', 'high', 'max'] for it.
  'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'],
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
  // command-code@1.43.0 added Gemini 3.8 Flash with the same three-level
  // effort set as the rest of the Gemini Flash family.
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  // Muse Spark family (command-code@1.45.0: "Reasoning levels for Muse
  // Spark 1.3") gained selectable ['low', 'medium', 'high', 'xhigh'] efforts
  // — they previously reasoned automatically with no levels.
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  // command-code@1.48.0 added `max` to Muse Spark 1.3; 1.3-contributor keeps
  // the four-level set.
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  // command-code@1.49.0 added GPT-6 Astra with the full five-level effort set.
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.51.3 gave MiniMax M3 selectable ['low', 'medium', 'high']
  // efforts (it previously reasoned automatically with no levels and lived in
  // KNOWN_THINKING_MODELS; the hidden `minimax/minimax-m3-free` sibling gained
  // the same set in the bundle). No CLI changelog entry exists for 1.51.1–1.51.3
  // yet — this was read from the 1.51.3 bundled model table.
  // command-code@1.52.0 added `inclusionai/ling-3.0-flash-sante:free` with
  // automatic reasoning and no selectable efforts, so the effort map is
  // unchanged by that release.
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
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
  // command-code@1.41.0 added Qwen 3.8 Max 0902; Vision per the official
  // registry ("Text input, Vision, Reasoning") and the CLI's
  // inputModalities:["text","image"].
  'Qwen/Qwen3.8-Max-0902',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'deepseek/deepseek-v4-flash-vision-exp',
  // command-code@1.53.0 added DeepSeek V4.1 Flash; Vision per the official
  // registry ("Text input, Vision, Reasoning") and the CLI's
  // inputModalities:["text","image"].
  'deepseek/deepseek-v4.1-flash',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  // command-code@1.43.0 added Gemini 3.8 Flash; Vision per the official
  // registry and the CLI's inputModalities:["text","image"].
  'google/gemini-3.8-flash',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  // command-code@1.49.0 added GPT-6 Astra; Vision per the official registry
  // and the CLI's inputModalities:["text","image"].
  'gpt-6-astra',
  // command-code@1.44.0 added Muse Spark 1.3 and its Contributor sibling;
  // both are Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.3-contributor',
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
  // command-code@1.47.0 marked Grok 4.6 vision-capable (it was text-only in
  // 1.46.0); re-verified present in the 1.53.0 bundle's
  // inputModalities:["text","image"] entries.
  'xai/grok-4.6',
  'xiaomi/mimo-v2.5',
  'z-ai/glm-5.3-flash',
])

/**
 * Models the official CLI's model table (command-code@1.53.0) marks
 * `reasoning:!0` but defines no selectable `reasoning_effort` levels — they
 * think automatically, with Command Code driving the depth. This is the
 * authoritative "thinks, effort not adjustable" set: `KNOWN_EFFORTS` (which
 * mirrors the CLI's effort map exactly) stays the sole source for selectable
 * effort levels, and this snapshot is not surfaced in the picker's compact
 * description — it exists for programmatic consumers.
 *
 * Source: the command-code@1.53.0 bundled model table (dist/cli.mjs),
 * cross-checked with https://commandcode.ai/docs/reference/cli/models.
 * (`stealth/ox-alpha` left this set in command-code@1.32.1, which gave it
 * selectable `['low', 'high', 'max']` efforts; the preview then ended in
 * 1.34.0, removing the model from the catalog entirely. `tencent/hy4-preview`
 * joined this set in command-code@1.37.0 — reasoning:!0, no efforts, 1M
 * context, routed through OpenRouter — then gained selectable
 * `['low', 'medium', 'high']` efforts in command-code@1.38.0 and moved to
 * `KNOWN_EFFORTS`. `moonshotai/Kimi-K3` followed the same path in
 * command-code@1.39.3 — it gained `['low', 'high', 'max']` efforts and moved
 * to `KNOWN_EFFORTS`. command-code@1.42.0 added `meituan/LongCat-2.0:free`
 * (reasoning:!0, no efforts). command-code@1.45.0 gave the Muse Spark family
 * (1.1, 1.2, 1.2-contributor, 1.3, 1.3-contributor) selectable
 * `['low', 'medium', 'high', 'xhigh']` efforts — they moved to `KNOWN_EFFORTS`.
 * command-code@1.51.3 gave `MiniMaxAI/MiniMax-M3` selectable
 * `['low', 'medium', 'high']` efforts — it moved to `KNOWN_EFFORTS` too.
 * command-code@1.52.0 added `inclusionai/ling-3.0-flash-sante:free`
 * (reasoning:!0, no efforts).)
 * command-code@1.53.0 added `deepseek/deepseek-v4.1-flash` with selectable
 * ['low', 'high', 'max'] efforts, so it lives in `KNOWN_EFFORTS`, not here.)
 * Keep in sync via the dsh-commandcode-upstream skill.
 */
export const KNOWN_THINKING_MODELS: ReadonlySet<string> = new Set([
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  // LongCat 2.0 (command-code@1.42.0, Meituan's trillion-parameter coding
  // model, 1M context) is free and text-only, with automatic reasoning.
  'meituan/LongCat-2.0:free',
  // Ling 3.0 Flash Sante (command-code@1.52.0, 262K context, text-only) is
  // free and reasons automatically with no selectable efforts.
  'inclusionai/ling-3.0-flash-sante:free',
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
 * command-code@1.41.0 added `Qwen/Qwen3.8-Max-0902` (Go) and 1.42.0 added
 * `meituan/LongCat-2.0:free` (Go, free promo); command-code@1.43.0 added
 * `google/gemini-3.8-flash` (GOAT) and 1.44.0 added `meta/muse-spark-1.3`
 * (GOAT) plus its Contributor sibling (Go); command-code@1.52.0 added the
 * free `inclusionai/ling-3.0-flash-sante:free` (Go); command-code@1.53.0
 * added `deepseek/deepseek-v4.1-flash` (Go).
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
  // --- Go (44) ---
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
  // command-code@1.41.0 added Qwen 3.8 Max 0902; it sits on the Go plan page.
  'Qwen/Qwen3.8-Max-0902': 'go',
  // command-code@1.39.0 added DeepSeek V4 Flash Fast; it is a Go-tier model
  // alongside the rest of the DeepSeek V4 family.
  'deepseek/deepseek-v4-flash-fast': 'go',
  // command-code@1.53.0 added DeepSeek V4.1 Flash ("Add new
  // deepseek/deepseek-v4.1-flash model"); the pricing page's embedded
  // availability grants it every plan including Go, and the Go/GOAT/Pro/Max
  // plan pages all list it.
  'deepseek/deepseek-v4.1-flash': 'go',
  'deepseek/deepseek-v4-flash': 'go',
  'deepseek/deepseek-v4-flash-vision-exp': 'go',
  'deepseek/deepseek-v4-pro': 'go',
  'gpt-5.6-luna': 'go',
  // command-code@1.42.0 added Meituan's LongCat 2.0 as a free Go-tier model
  // ("LongCat 2.0 free model" — 100% off while it lasts, every plan).
  'meituan/LongCat-2.0:free': 'go',
  // command-code@1.52.0 added Ling 3.0 Flash Sante as a free Go-tier model
  // ("free, up to 100 requests a day", every plan) — the successor to the
  // retired `inclusionai/ling-3.0-flash-free` promo.
  'inclusionai/ling-3.0-flash-sante:free': 'go',
  // command-code@1.44.0 added Muse Spark 1.3 Contributor on every plan
  // including Go, like its 1.2 Contributor sibling.
  'meta/muse-spark-1.2-contributor': 'go',
  'meta/muse-spark-1.3-contributor': 'go',

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
  // --- GOAT (6 more) ---
  'google/gemini-3.7-flash': 'goat',
  // command-code@1.43.0 added Gemini 3.8 Flash; the pricing page marks it
  // "Available on GOAT and above", like the rest of the Gemini Flash family.
  'google/gemini-3.8-flash': 'goat',
  'gpt-5.6-sol': 'goat',
  'meta/muse-spark-1.2': 'goat',
  // command-code@1.44.0 added Muse Spark 1.3; the pricing page marks it
  // "Available on GOAT and above", like the 1.2/1.1 models.
  'meta/muse-spark-1.3': 'goat',
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
  // --- Provider / Max (7) ---
  'claude-fable-5-1': 'provider',
  'claude-fable-5': 'provider',
  'claude-opus-4-7': 'provider',
  'claude-opus-4-8': 'provider',
  'claude-opus-5': 'provider',
  // command-code@1.49.0 added GPT-6 Astra; per the pricing page it sits on
  // Max (Provider/Max tier).
  'gpt-6-astra': 'provider',
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
 * (located by the `"individual-go"` key in command-code@1.53.0 `dist/cli.mjs`,
 * re-verified unchanged through 1.53.0): subscription `planId`
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
 * a non-finite weight (corrupt billing fact), or a model outside
 * {@link KNOWN_PLANS} all keep the model visible — the server remains the
 * final gate (`403 MODEL_NOT_IN_PLAN`).
 */
export function modelVisibleInPlan(modelId: string, access: CommandCodeBillingAccess | undefined): boolean {
  if (access === undefined) return true
  if (access.onDemandCredits > 0) return true
  if (access.tierWeight === undefined || !Number.isFinite(access.tierWeight)) return true
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
  // Meituan's LongCat 2.0 (command-code@1.42.0, "LongCat 2.0 free model") is
  // 100% off while it lasts — a permanent-style deal (no fixed end date; the
  // pricing page's DEAL block says "Term: while it lasts"). Free requests cost
  // no credits on every plan, like Laguna S 2.1.
  'meituan/LongCat-2.0:free': { label: 'FREE', free: true },
  // Ling 3.0 Flash Sante (command-code@1.52.0) is free "up to 100 requests a
  // day" while the promo lasts — a permanent-style deal (no fixed end date,
  // like LongCat 2.0). Free requests cost no credits on every plan.
  'inclusionai/ling-3.0-flash-sante:free': { label: 'FREE', free: true },
}

/**
 * Models with time-of-day (peak/off-peak) pricing, per the official pricing
 * page (`/docs/resources/pricing-limits`). Since 2026-08-16 16:00 UTC, DeepSeek
 * charges by the hour: peak hours are 01:00–04:00 and 06:00–10:00 UTC (7h per
 * weekday, full price) **Monday to Friday only**; the other 17 hours of a
 * weekday and every hour of Saturday/Sunday (UTC) are off-peak at half price.
 * The V4 Flash Vision (exp) variant (command-code@1.32.0) shares the V4 Flash
 * windows and peak prices ($0.44/$1.32) — each row's hover annotation states
 * exactly 2× that row's displayed off-peak prices. The picker shows the
 * *current* state as a compact
 * label (`Peak`/`Half`) matching the English noun style of the other markers
 * (`Image`, `FREE`), so a developer can tell at a glance whether calling the
 * model right now is cheap or expensive.
 *
 * Authoritative extraction: the pricing page embeds a model JSON array whose
 * hourly-priced entries carry a `timeOfDay` block
 * (`{ windows: "01–04 & 06–10 UTC, Mon–Fri", peakHoursPerDay: 7,
 * offPeakHoursPerDay: 17, peak: {...}, offPeak: {...} }`). Exactly four models
 * carry it: V4 Pro, V4 Flash, V4 Flash Vision (exp), and V4.1 Flash (added in
 * command-code@1.53.0 at $0.15/$0.60 off-peak, $0.30/$1.20 peak — the same
 * schedule as the other three).
 *
 * Extraction caution: the rendered HTML rows are a trap. Each annotation div
 * sits inside its OWN row's container, immediately before the NEXT row starts,
 * so flattening the page to text makes every annotation look like it belongs
 * to the model printed after it — that is how `deepseek/deepseek-v4-flash-fast`
 * was wrongly added here (its row is flat-priced at $0.28/$0.56/$0.07 and has
 * no `timeOfDay` block). Trust the embedded JSON's `timeOfDay` membership and
 * the 2× price relation, never the flat-text neighbor.
 *
 * Keep in sync with the official pricing page when the model set, the peak
 * windows, or the weekday rule change (see the dsh-commandcode-upstream skill).
 */
export const KNOWN_PEAK_PRICING: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  // command-code@1.53.0 added DeepSeek V4.1 Flash with the same `timeOfDay`
  // block as the other DeepSeek models (off-peak $0.15/$0.60, peak
  // $0.30/$1.20, 01–04 & 06–10 UTC Mon–Fri).
  'deepseek/deepseek-v4.1-flash',
])

/**
 * Peak hours (UTC, hour-of-day range end-exclusive): 01–03 and 06–09.
 * Weekday-only — see `peakPricingState()`; weekends are fully off-peak.
 *
 * Exported because the vendored price table (`./model-prices.ts`) ships these
 * windows to the browser with the table itself: the composer prices a session
 * against the very schedule this snapshot knows rather than restating it, so
 * there is one place to update when the windows move.
 */
export const PEAK_HOUR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
]

/**
 * Whether `now` (defaults to `Date.now()`) falls inside a peak-pricing window,
 * ignoring which model is asking. Peak rates apply Monday–Friday (UTC) only,
 * so a weekend timestamp is off-peak even inside {@link PEAK_HOUR_RANGES}.
 *
 * Model-independent on purpose: `peakPricingState()` adds the membership test
 * on top for the picker's label, while the price table selects peak rates from
 * a row's own `peak` block — so a model whose catalog id spelling differs from
 * the one in {@link KNOWN_PEAK_PRICING} still gets the right half of the day.
 */
export function isPeakPricingHour(now: number = Date.now()): boolean {
  const at = new Date(now)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return PEAK_HOUR_RANGES.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Whether `now` (defaults to `Date.now()`) falls in a peak-pricing window for
 * time-of-day-priced models. Peak rates apply Monday–Friday (UTC) only: the
 * official rule charges Saturday and Sunday completely off-peak for all 24
 * hours, so a weekend timestamp is off-peak even inside `PEAK_HOUR_RANGES`.
 * `undefined` for models outside the snapshot.
 */
export function peakPricingState(
  modelId: string,
  now: number = Date.now(),
): 'peak' | 'off-peak' | undefined {
  if (!KNOWN_PEAK_PRICING.has(modelId)) return undefined
  return isPeakPricingHour(now) ? 'peak' : 'off-peak'
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
 * `256_000 -> "256K"`, `262_144 -> "262K"` (floor to the nearest K).
 * Returns undefined for unknown/absent sizes; values under 1K render raw.
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
  if (contextWindow < 1_000) return String(Math.floor(contextWindow))
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
