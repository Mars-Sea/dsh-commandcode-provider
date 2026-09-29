/**
 * Vendored Command Code model prices: the per-token rates the official pricing
 * page publishes, which is what lets the composer price a session in dollars.
 * Every figure is USD per 1,000,000 tokens.
 *
 * Source: the model array embedded in
 * https://commandcode.ai/docs/resources/pricing-limits, read out of its
 * Next.js flight payload. That payload is the only place the `timeOfDay` and
 * `contextTiers` blocks exist, so it is what the generator parses — but it is
 * NOT trusted on its own: the generator also reads the page's rendered table
 * and reports any rate where the two disagree. A figure can be internally
 * consistent and still be the wrong row (this table once carried
 * `0.22 → 0.44` for a model the page prices `0.15 → 0.30` — exactly the 2× the
 * peak/off-peak rule promises), so the cross-check exists to catch that class
 * of error rather than to restate the invariant.
 *
 * Three buckets are always published (inputCost, outputCost, cacheReadCost);
 * cacheWriteCost is published for a minority of models. A model without the
 * key has UNPRICED cache-write tokens: never invent a multiplier for them, and
 * never fold them into the input rate. A published `0` is a different fact and
 * is kept as a real zero — see the note on the GPT rows below.
 *
 * Time-of-day models store a `peak` triplet only. The page repeats the flat
 * rates inside its own offPeak block, so the top-level rates ARE the off-peak
 * rates and only the peak override is worth keeping — the generator asserts
 * that equality and refuses to emit otherwise. Whether "now" counts as peak is
 * decided by `isPeakPricingHour()` in ./capabilities.ts, on the same
 * Monday-Friday UTC schedule the model picker labels.
 *
 * Context-tiered models carry every band, with inclusive prompt-token bounds
 * and an unbounded final band. The durable cost projection selects each
 * request's band from its input/cache buckets, never from session totals.
 *
 * Discounted rows carry both price sets. The page publishes a deal's
 * PROMOTIONAL rates as the row's ordinary figures and its pre-discount
 * `listRates` alongside, so the generator copies both and the table picks
 * between them with `dealLabel()`'s clock. That keeps a lapsed discount from
 * pricing a session below what the provider now charges — the same "a stale
 * snapshot never shows a lapsed discount" rule the picker badge follows, applied
 * to dollars rather than to a label. The page's own `discountPercent` is NOT
 * used for this: it is a marketing figure that does not divide out (MiMo V2.5's
 * "98% off" prices three buckets at 5.7×, 14.3× and 57× of list).
 *
 * Do not hand-edit the table below: run `node scripts/sync-model-prices.mjs`,
 * which re-reads the page, asserts the structure and the off-peak equality,
 * prints cross-check warnings for a human, and rewrites only the rows.
 * `--check` reports drift without writing (exit 1 on drift, exit 2 when the
 * page could not be read, so a network failure never reads as "up to date").
 * Everything else in this file — this doc, the types, the slug rules, the
 * table builder — is written by hand and survives that rewrite.
 *
 * @module dsh-commandcode-provider/model-prices
 */

import type { CommandCodeModelPrice, CommandCodeModelRates, CommandCodePriceTable } from './usage-wire.ts'
import { KNOWN_PLANS, PEAK_HOUR_RANGES, dealLabel, isFreeModel } from './capabilities.ts'
import { PLAN_ORDER } from './plan-tiers.ts'

/** One pricing-page context band: the rates charged inside `maxContext` tokens. */
interface ModelPriceContextTier {
  readonly maxContext?: number
  readonly rates: readonly number[]
  /**
   * The band's pre-discount rates, present only for a row carrying a deal. See
   * {@link ModelPriceRow.listRates}.
   */
  readonly listRates?: readonly number[]
}

/**
 * A model's per-model monthly allowance, in USD, per plan tier.
 *
 * This is the page's `planAllowanceUsd`: how much of the plan's monthly credit
 * pool this ONE model may draw. It is not extra money — every allowance draws
 * on the same pool — and the page publishes it for GOAT and Pro only ("the
 * boost is a per-model allowance, so it lives on the plans that have them"), so
 * there is no `go`, `max` or `provider` figure to read. Deals are baked in:
 * `MiniMaxAI/MiniMax-M3` carries `$47 / $57` precisely because its 2× promotion
 * is already folded into the allowance.
 */
export interface ModelAllowance {
  readonly goat: number
  readonly pro: number
}

/**
 * The plan tiers a per-model allowance exists for, cheapest first. Ordering
 * matters: {@link allowanceTierForWeight} matches a tier weight against these
 * rather than against hard-coded numbers, so this table and the subscription
 * table cannot drift apart silently.
 */
const ALLOWANCE_TIERS = ['goat', 'pro'] as const

/**
 * Which allowance bracket a plan-tier weight belongs to, or undefined when that
 * plan has no per-model allowance.
 *
 * Weights come from `KNOWN_SUBSCRIPTION_PLANS` (go 0 · goat 1 · pro 2 ·
 * provider 3 · max/ultra 4) and {@link PLAN_ORDER} is the same scale, which is
 * what makes the lookup exact: Go, Provider, Max and Ultra have no published
 * allowance, and answering with a neighbouring tier's figure would be a
 * fabricated number rather than a missing one.
 */
export function allowanceTierForWeight(
  tierWeight: number | undefined,
): keyof ModelAllowance | undefined {
  if (tierWeight === undefined) return undefined
  return ALLOWANCE_TIERS.find((tier) => PLAN_ORDER[tier] === tierWeight)
}

/**
 * One pricing-page row. `rates` is `[input, output, cacheRead, cacheWrite?]`
 * and `peak` is the `[input, output, cacheRead]` triplet charged inside the
 * peak windows. All figures are USD per 1,000,000 tokens.
 *
 * `listRates` appears only on rows whose page record carries a `deal`: those
 * `rates` are the PROMOTIONAL figures, and `listRates` is what the row reverts
 * to when the deal lapses. {@link modelPriceTable} picks between the two with
 * the same clock {@link dealLabel} uses, so a discount that has expired stops
 * pricing a session at the promotional rate even before the next sync — the
 * badge and the dollars always agree. A permanent deal (no `expiresAt`) never
 * lapses, and a row with no `listRates` has nothing to fall back to.
 *
 * `allowance` is a different KIND of number from everything else here: dollars
 * per month, not dollars per million tokens. It never enters the price table —
 * {@link modelAllowanceFor} serves it to the settings page instead.
 */
interface ModelPriceRow {
  readonly id: string
  readonly rates: readonly number[]
  readonly listRates?: readonly number[]
  readonly peak?: readonly number[]
  readonly allowance?: ModelAllowance
  readonly contextTiers?: readonly ModelPriceContextTier[]
}

/**
 * Every price row the page publishes, ordered by its own slug.
 *
 * Note on the GPT rows: `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini` and
 * `gpt-5.5` carry a LITERAL `cacheWriteCost: 0` — a different fact from a
 * missing key, because `ratesOf()` keeps it and the readout then charges
 * cache writes at zero instead of reporting them unpriced. That is what the
 * page's JSON says; its rendered column shows `—` for exactly these four while
 * rendering a genuine zero as `$0.00` elsewhere, so the page contradicts
 * itself. The table stays faithful to the machine-readable source and the
 * discrepancy is recorded in AGENTS.md rather than papered over here.
 */
const MODEL_PRICE_ROWS: readonly ModelPriceRow[] = [
  { id: 'claude-fable-5', rates: [10, 50, 1, 12.5], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-fable-5-1', rates: [10, 50, 0.25, 12.5], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-haiku-4-5', rates: [1, 5, 0.1, 1.25], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-opus-4-6', rates: [5, 25, 0.5, 6.25], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-opus-4-7', rates: [5, 25, 0.5, 6.25], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-opus-4-8', rates: [5, 25, 0.5, 6.25], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-opus-5', rates: [5, 25, 0.5, 6.25], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-opus-5-5', rates: [4, 20, 0.2, 5], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-sonnet-4-6', rates: [3, 15, 0.3, 3.75], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-sonnet-5', rates: [2, 10, 0.2, 2.5], allowance: { goat: 20, pro: 20 } },
  { id: 'claude-sonnet-5-5', rates: [2, 10, 0.2, 2.5], allowance: { goat: 10, pro: 20 } },
  { id: 'deepseek-v4-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006], allowance: { goat: 60, pro: 70 } },
  { id: 'deepseek-v4-flash-fast', rates: [0.28, 0.56, 0.07], allowance: { goat: 20, pro: 30 } },
  { id: 'deepseek-v4-flash-vision-exp', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006], allowance: { goat: 20, pro: 30 } },
  { id: 'deepseek-v4-pro', rates: [0.66, 1.98, 0.022], peak: [1.32, 3.96, 0.044], allowance: { goat: 20, pro: 30 } },
  { id: 'deepseek-v4.1-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006], allowance: { goat: 60, pro: 70 } },
  { id: 'deepseek-v4.1-flash-fast', rates: [0.16, 0.58, 0.016], peak: [0.32, 1.16, 0.032], allowance: { goat: 60, pro: 70 } },
  { id: 'fugu-ultra', rates: [5, 30, 0.5], allowance: { goat: 20, pro: 20 } },
  { id: 'gemini-3.1-flash-lite', rates: [0.25, 1.5, 0.03], allowance: { goat: 20, pro: 20 } },
  { id: 'gemini-3.5-flash', rates: [1.5, 9, 0.15], allowance: { goat: 20, pro: 20 } },
  { id: 'gemini-3.5-flash-lite', rates: [0.3, 2.5, 0.03], allowance: { goat: 20, pro: 20 } },
  { id: 'gemini-3.6-flash', rates: [1.5, 7.5, 0.15], allowance: { goat: 20, pro: 20 } },
  { id: 'gemini-3.7-flash', rates: [1.5, 7.5, 0.15, 0.08334], allowance: { goat: 40, pro: 50 } },
  { id: 'gemini-3.8-flash', rates: [1.5, 7.5, 0.15], allowance: { goat: 40, pro: 50 } },
  { id: 'glm-5', rates: [1, 3.2, 0.2], allowance: { goat: 20, pro: 30 } },
  { id: 'glm-5.1', rates: [1.4, 4.4, 0.26], allowance: { goat: 20, pro: 30 } },
  { id: 'glm-5.2', rates: [1.4, 4.4, 0.26], allowance: { goat: 70, pro: 80 } },
  { id: 'glm-5.2-fast', rates: [3, 10.25, 0.5], allowance: { goat: 20, pro: 30 } },
  { id: 'glm-5.3', rates: [1.4, 4.4, 0.26], allowance: { goat: 20, pro: 30 } },
  { id: 'glm-5.3-flash', rates: [0.15, 0.5, 0.03], allowance: { goat: 40, pro: 50 } },
  { id: 'glm-5.3-flashx', rates: [0.37, 1.25, 0.075], allowance: { goat: 20, pro: 30 } },
  { id: 'gpt-5.3-codex', rates: [2, 8, 0.5, 0], allowance: { goat: 20, pro: 20 } },
  { id: 'gpt-5.4', rates: [2.5, 15, 0.25, 0], allowance: { goat: 20, pro: 20 } },
  { id: 'gpt-5.4-mini', rates: [0.75, 4.5, 0.075, 0], allowance: { goat: 20, pro: 20 } },
  { id: 'gpt-5.5', rates: [5, 30, 0.5, 0], allowance: { goat: 20, pro: 20 } },
  { id: 'gpt-5.6-luna', rates: [0.2, 1.2, 0.02, 0.25], allowance: { goat: 20, pro: 30 }, contextTiers: [{"maxContext":272000,"rates":[0.2,1.2,0.02,0.25]},{"rates":[0.4,1.8,0.04,0.5]}] },
  { id: 'gpt-5.6-sol', rates: [5, 30, 0.5, 6.25], allowance: { goat: 70, pro: 80 }, contextTiers: [{"maxContext":272000,"rates":[5,30,0.5,6.25]},{"rates":[10,45,1,12.5]}] },
  { id: 'gpt-5.6-terra', rates: [2, 12, 0.2, 2.5], allowance: { goat: 20, pro: 20 }, contextTiers: [{"maxContext":272000,"rates":[2,12,0.2,2.5]},{"rates":[4,18,0.4,5]}] },
  { id: 'gpt-6-astra', rates: [10, 50, 1, 12.5], allowance: { goat: 20, pro: 20 }, contextTiers: [{"maxContext":272000,"rates":[10,50,1,12.5]},{"rates":[20,75,2,25]}] },
  { id: 'gpt-6-luna', rates: [0.1, 0.5, 0.01, 0.125], allowance: { goat: 20, pro: 30 }, contextTiers: [{"maxContext":272000,"rates":[0.1,0.5,0.01,0.125]},{"rates":[0.2,0.75,0.02,0.25]}] },
  { id: 'gpt-6-sol', rates: [2, 10, 0.2, 2.5], allowance: { goat: 20, pro: 20 }, contextTiers: [{"maxContext":272000,"rates":[2,10,0.2,2.5]},{"rates":[4,15,0.4,5]}] },
  { id: 'grok-4.5', rates: [2, 6, 0.5], allowance: { goat: 20, pro: 30 } },
  { id: 'grok-4.6', rates: [2, 6, 0.5], allowance: { goat: 20, pro: 30 }, contextTiers: [{"maxContext":200000,"rates":[2,6,0.5]},{"rates":[4,12,1]}] },
  { id: 'grok-4.7', rates: [1.2, 3.6, 0.3], listRates: [2, 6, 0.5], allowance: { goat: 20, pro: 30 }, contextTiers: [{"maxContext":200000,"rates":[1.2,3.6,0.3],"listRates":[2,6,0.5]},{"rates":[2.4,7.2,0.6],"listRates":[4,12,1]}] },
  { id: 'inkling', rates: [1, 4.05, 0.17], allowance: { goat: 20, pro: 30 } },
  { id: 'inkling-small', rates: [0.5, 1.2, 0.1], allowance: { goat: 20, pro: 30 } },
  { id: 'kimi-k2.5', rates: [0.6, 3, 0.1], allowance: { goat: 20, pro: 30 } },
  { id: 'kimi-k2.6', rates: [0.95, 4, 0.16], allowance: { goat: 20, pro: 30 } },
  { id: 'kimi-k2.7-code', rates: [0.95, 4, 0.19], allowance: { goat: 60, pro: 70 } },
  { id: 'kimi-k2.7-code-highspeed', rates: [1.9, 8, 0.38], allowance: { goat: 20, pro: 30 } },
  { id: 'kimi-k3', rates: [3, 15, 0.3], allowance: { goat: 20, pro: 30 } },
  { id: 'longcat-2.0', rates: [0.3, 1.2, 0.006], allowance: { goat: 50, pro: 60 } },
  { id: 'mimo-v2.5', rates: [0.14, 0.28, 0.0028], listRates: [0.8, 4, 0.16], allowance: { goat: 30, pro: 40 } },
  { id: 'mimo-v2.5-pro', rates: [0.435, 0.87, 0.0036], listRates: [2, 6, 0.4], allowance: { goat: 20, pro: 30 } },
  { id: 'mimo-v2.6-flash', rates: [0.14, 0.28, 0.0028], allowance: { goat: 20, pro: 30 } },
  { id: 'mimo-v2.6-pro', rates: [0.435, 0.87, 0.0036], allowance: { goat: 20, pro: 30 } },
  { id: 'mimo-v2.6-pro-ultraspeed', rates: [4.35, 8.7, 0.036], allowance: { goat: 10, pro: 20 } },
  { id: 'minimax-m2.5', rates: [0.3, 1.2, 0.03], allowance: { goat: 20, pro: 30 } },
  { id: 'minimax-m2.7', rates: [0.3, 1.2, 0.06], allowance: { goat: 20, pro: 30 } },
  { id: 'minimax-m3', rates: [0.3, 1.2, 0.06], listRates: [0.6, 2.4, 0.12], allowance: { goat: 47, pro: 57 } },
  { id: 'muse-spark-1.1', rates: [1.25, 4.25, 0.15], allowance: { goat: 20, pro: 20 } },
  { id: 'muse-spark-1.2', rates: [1.25, 4.25, 0.15], allowance: { goat: 20, pro: 30 } },
  { id: 'muse-spark-1.2-contributor', rates: [0.1, 0.2, 0.002], allowance: { goat: 20, pro: 30 } },
  { id: 'muse-spark-1.3', rates: [1.25, 4.25, 0.15], allowance: { goat: 20, pro: 30 } },
  { id: 'muse-spark-1.3-contributor', rates: [0.1, 0.2, 0.002], allowance: { goat: 20, pro: 30 } },
  { id: 'nemotron-3-ultra', rates: [0.6, 2.4, 0.12], allowance: { goat: 20, pro: 30 } },
  { id: 'qwen-3.6-max', rates: [1.3, 7.8, 0.26, 1.63], allowance: { goat: 20, pro: 30 } },
  { id: 'qwen-3.6-plus', rates: [0.5, 3, 0.1], allowance: { goat: 33, pro: 43 }, contextTiers: [{"maxContext":256000,"rates":[0.5,3,0.1]},{"rates":[2,6,0.2]}] },
  { id: 'qwen-3.7-flash', rates: [0.03, 0.13, 0.006, 0.038], allowance: { goat: 20, pro: 30 }, contextTiers: [{"maxContext":32000,"rates":[0.03,0.13,0.006,0.038]},{"maxContext":256000,"rates":[0.1,0.4,0.02,0.125]},{"rates":[0.2,0.8,0.04,0.25]}] },
  { id: 'qwen-3.7-max', rates: [2.5, 7.5, 0.5, 3.13], allowance: { goat: 33, pro: 43 } },
  { id: 'qwen-3.7-plus', rates: [0.4, 1.6, 0.08, 0.5], allowance: { goat: 33, pro: 43 }, contextTiers: [{"maxContext":256000,"rates":[0.4,1.6,0.08,0.5]},{"rates":[1.2,4.8,0.24,1.5]}] },
  { id: 'qwen-3.8-27b', rates: [0.4, 3, 0.04], allowance: { goat: 70, pro: 80 } },
  { id: 'qwen-3.8-flash', rates: [0.16, 0.47, 0.016], allowance: { goat: 20, pro: 30 } },
  { id: 'qwen-3.8-max', rates: [2, 6, 0.25, 2.5], allowance: { goat: 20, pro: 30 } },
  { id: 'qwen-3.8-max-0902', rates: [2, 6, 0.25], allowance: { goat: 20, pro: 30 } },
  { id: 'qwen-3.8-omni-flash', rates: [0.15, 0.47, 0.016], allowance: { goat: 20, pro: 30 } },
  { id: 'step-3.5-flash', rates: [0.09, 0.3, 0.02], allowance: { goat: 20, pro: 30 } },
  { id: 'step-3.7-flash', rates: [0.2, 1.15, 0.04], allowance: { goat: 20, pro: 30 } },
  { id: 'step-5-preview', rates: [1, 2.7, 0.05], allowance: { goat: 20, pro: 30 } },
  { id: 'tencent/hy3-paid', rates: [0.14, 0.58, 0.035], allowance: { goat: 70, pro: 80 } },
  { id: 'tencent/hy4-preview', rates: [0.834, 2.501, 0.042], allowance: { goat: 20, pro: 30 } },
  { id: 'typesafe/jev', rates: [0.042, 0, 0], allowance: { goat: 20, pro: 30 } },
]

/**
 * Catalog ids no candidate rule can reach, because the page names the model
 * differently from the catalog. `tests/model-prices.test.ts` fails whenever a
 * catalog model has no price, so a new miss lands here as a visible decision
 * rather than a silently unpriced model.
 */
const PRICE_SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  // The page lists it by its short name; the catalog carries the full one.
  'nvidia/nemotron-3-ultra-550b-a55b': 'nemotron-3-ultra',
}

/**
 * Plausible price slugs for one catalog model id, most specific first.
 *
 * The page normalizes to lowercase and usually drops the vendor segment, but
 * not consistently: `tencent/hy4-preview` keeps its prefix while
 * `Qwen/Qwen3.8-Max-0902` becomes `qwen-3.8-max-0902`, with a hyphen the
 * catalog id does not have. Generating candidates and taking the first that
 * exists in the vendored table absorbs that drift without a hand-maintained map
 * of eighty ids.
 */
function priceSlugCandidates(modelId: string): string[] {
  const lower = modelId.toLowerCase()
  const bare = lower.includes('/') ? lower.slice(lower.indexOf('/') + 1) : lower
  const out = new Set<string>()
  const add = (slug: string): void => {
    const hyphenated = slug.replace(/^([a-z]+)(\d)/, '$1-$2')
    out.add(slug)
    out.add(hyphenated)
    out.add(slug.replace(/-\d{8}$/, ''))
    out.add(slug.replace(/-(preview|latest)$/, ''))
    out.add(hyphenated.replace(/-\d{8}$/, ''))
    out.add(hyphenated.replace(/-(preview|latest)$/, ''))
  }
  add(lower)
  add(bare)
  return [...out]
}

/** The pricing-page slug for one catalog model id, or undefined when unpriced. */
function priceSlugFor(modelId: string, known: ReadonlySet<string>): string | undefined {
  const override = PRICE_SLUG_OVERRIDES[modelId]
  if (override !== undefined) return known.has(override) ? override : undefined
  return priceSlugCandidates(modelId).find((slug) => known.has(slug))
}

/** Split a stored triplet/quadruplet into the wire rate shape. */
function ratesOf(values: readonly number[]): CommandCodeModelRates {
  // Indexed access is asserted rather than defaulted: the generator only ever
  // emits rows with the three published rates, so a short row is a broken table
  // and must not silently become a free model.
  const rates: CommandCodeModelRates = {
    inputCost: values[0]!,
    outputCost: values[1]!,
    cacheReadCost: values[2]!,
  }
  if (values[3] !== undefined) rates.cacheWriteCost = values[3]
  return rates
}

/**
 * Build the full price row the browser prices a session with.
 *
 * Every figure switches together: once the deal stops being live, the base
 * rates AND each context band come from the pre-discount set, so a session
 * priced after a promotion ends can never mix the two.
 */
function wireRow(id: string, slug: string, row: ModelPriceRow, now: number): CommandCodeModelPrice {
  // `dealLabel()` answers undefined both for "no deal" and for "deal expired";
  // `listRates` exist only on discounted rows, so the pair settles which set
  // applies. A row with one and not the other falls back to its current rates.
  const promotional = dealLabel(id, now) !== undefined
  const price: CommandCodeModelPrice = {
    id,
    slug,
    ...ratesOf(promotional ? row.rates : (row.listRates ?? row.rates)),
  }
  if (row.peak !== undefined) price.peak = ratesOf(row.peak)
  if (row.contextTiers !== undefined) {
    price.contextTiers = row.contextTiers.map((tier) => ({
      ...ratesOf(promotional ? tier.rates : (tier.listRates ?? tier.rates)),
      ...(tier.maxContext === undefined ? {} : { maxContext: tier.maxContext }),
    }))
  }
  return price
}

/**
 * Build the table the composer prices a session with.
 *
 * Rows are keyed by CATALOG id wherever the two namespaces reconcile, because
 * that is what a session reports, and every row also carries its page slug as a
 * second lookup key. Price rows no catalog model claims are served under the
 * slug alone, so drift in either direction still prices. Free models are served
 * explicitly at zero so the composer can say so instead of showing nothing; the
 * peak windows travel with the table so the browser applies the very schedule
 * this snapshot knows instead of restating it.
 *
 * `now` (defaults to `Date.now()`) resolves lapsed promotions: a discounted row
 * whose `expiresAt` has passed is served at its pre-discount `listRates`, the
 * same instant {@link dealLabel} stops showing its badge. The table is rebuilt
 * per request, so that switch needs no redeploy.
 */
export function modelPriceTable(now: number = Date.now()): CommandCodePriceTable {
  const bySlug = new Map(MODEL_PRICE_ROWS.map((row) => [row.id, row]))
  const known = new Set(bySlug.keys())
  const models: CommandCodeModelPrice[] = []
  const claimed = new Set<string>()

  for (const catalogId of Object.keys(KNOWN_PLANS)) {
    if (isFreeModel(catalogId) || catalogId.endsWith(':free')) {
      models.push({ id: catalogId, slug: catalogId, inputCost: 0, outputCost: 0, cacheReadCost: 0, free: true })
      continue
    }
    const slug = priceSlugFor(catalogId, known)
    if (slug === undefined) continue
    const row = bySlug.get(slug)
    if (row === undefined) continue
    claimed.add(slug)
    models.push(wireRow(catalogId, slug, row, now))
  }

  for (const row of MODEL_PRICE_ROWS) {
    if (claimed.has(row.id)) continue
    models.push(wireRow(row.id, row.id, row, now))
  }

  return {
    models,
    peakHours: PEAK_HOUR_RANGES.map(([start, end]) => [start, end] as [number, number]),
  }
}

/** Slug-keyed view of the rows, built once: neither table nor allowance mutates. */
const ROWS_BY_SLUG: ReadonlyMap<string, ModelPriceRow> = new Map(
  MODEL_PRICE_ROWS.map((row) => [row.id, row]),
)
const KNOWN_SLUGS: ReadonlySet<string> = new Set(ROWS_BY_SLUG.keys())

/**
 * The per-model monthly allowance for a CATALOG model id, or undefined when the
 * page carries none (a model without a price row, or the free stealth previews
 * the estimator array omits).
 *
 * Resolution rides the same slug rules as the price table, so
 * `MiniMaxAI/MiniMax-M3` finds the row the page files under `minimax-m3` — the
 * settings page must not grow a second mapping that can drift from this one.
 * The settings page asks for a model only while rendering a list it already
 * has, so this stays a pure lookup with no clock: an allowance is not
 * time-dependent (a plan's figure does not lapse the way a promotional rate
 * does; when the page re-prices it, the next sync carries it).
 */
export function modelAllowanceFor(modelId: string): ModelAllowance | undefined {
  const slug = priceSlugFor(modelId, KNOWN_SLUGS)
  if (slug === undefined) return undefined
  return ROWS_BY_SLUG.get(slug)?.allowance
}

