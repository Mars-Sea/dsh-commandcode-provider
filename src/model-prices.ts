/**
 * Vendored Command Code model prices: the per-token rates the official
 * pricing page publishes, which is what lets the composer price a session in
 * dollars.
 *
 * Source: the model array embedded in
 * https://commandcode.ai/docs/resources/pricing-limits, read out of its
 * Next.js flight payload rather than off the rendered rows (the rows are a
 * trap — see the extraction note in AGENTS.md). Every figure is USD per
 * 1,000,000 tokens, which the page confirms itself: its Go-plan estimate for
 * DeepSeek V4 Flash (800 in / 200 out on a $10 budget) resolves to the ~42K
 * requests the page states, and ~26K once its typical 50K cache reads are
 * priced at the cacheRead rate.
 *
 * Three buckets are always published (inputCost, outputCost, cacheReadCost);
 * cacheWriteCost is published for a minority of models. A model without it
 * has UNPRICED cache-write tokens: never invent a multiplier for them, and
 * never fold them into the input rate.
 *
 * Time-of-day models store a `peak` triplet only. The page repeats the flat
 * rates inside its own offPeak block, so the top-level rates ARE the off-peak
 * rates and only the peak override is worth keeping — the generator asserts
 * that equality and refuses to emit otherwise. Whether "now" counts as peak is
 * decided by `isPeakPricingHour()` in ./capabilities.ts, on the same
 * Monday-Friday UTC schedule the model picker labels.
 *
 * Do not hand-edit the table below: run `node scripts/sync-model-prices.mjs`,
 * which re-reads the page's embedded JSON, asserts it still duplicates its
 * rates into `offPeak`, and rewrites only the rows. Everything else in this
 * file — this doc, the types, the slug rules, the table builder — is written by
 * hand and survives that rewrite.
 *
 * @module dsh-commandcode-provider/model-prices
 */

import type { CommandCodeModelPrice, CommandCodeModelRates, CommandCodePriceTable } from './usage-wire.ts'
import { KNOWN_PLANS, PEAK_HOUR_RANGES, isFreeModel } from './capabilities.ts'

/**
 * One pricing-page row. `rates` is `[input, output, cacheRead, cacheWrite?]`
 * and `peak` is the `[input, output, cacheRead]` triplet charged inside the
 * peak windows. All figures are USD per 1,000,000 tokens.
 */
interface ModelPriceRow {
  readonly id: string
  readonly rates: readonly number[]
  readonly peak?: readonly number[]
}

/** Every price row the page publishes, ordered by its own slug. */
const MODEL_PRICE_ROWS: readonly ModelPriceRow[] = [
  { id: 'claude-fable-5', rates: [10, 50, 1, 12.5] },
  { id: 'claude-fable-5-1', rates: [10, 50, 0.25, 12.5] },
  { id: 'claude-haiku-4-5', rates: [1, 5, 0.1, 1.25] },
  { id: 'claude-opus-4-6', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-7', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-4-8', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-opus-5', rates: [5, 25, 0.5, 6.25] },
  { id: 'claude-sonnet-4-6', rates: [3, 15, 0.3, 3.75] },
  { id: 'claude-sonnet-5', rates: [2, 10, 0.2, 2.5] },
  { id: 'deepseek-v4-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006] },
  { id: 'deepseek-v4-flash-fast', rates: [0.28, 0.56, 0.07] },
  { id: 'deepseek-v4-flash-vision-exp', rates: [0.22, 0.66, 0.007], peak: [0.44, 1.32, 0.014] },
  { id: 'deepseek-v4-pro', rates: [0.66, 1.98, 0.022], peak: [1.32, 3.96, 0.044] },
  { id: 'deepseek-v4.1-flash', rates: [0.15, 0.6, 0.003], peak: [0.3, 1.2, 0.006] },
  { id: 'fugu-ultra', rates: [5, 30, 0.5] },
  { id: 'gemini-3.1-flash-lite', rates: [0.25, 1.5, 0.03] },
  { id: 'gemini-3.5-flash', rates: [1.5, 9, 0.15] },
  { id: 'gemini-3.5-flash-lite', rates: [0.3, 2.5, 0.03] },
  { id: 'gemini-3.6-flash', rates: [1.5, 7.5, 0.15] },
  { id: 'gemini-3.7-flash', rates: [1.5, 7.5, 0.15, 0.08334] },
  { id: 'gemini-3.8-flash', rates: [1.5, 7.5, 0.15] },
  { id: 'glm-5', rates: [1, 3.2, 0.2] },
  { id: 'glm-5.1', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.2', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.2-fast', rates: [3, 10.25, 0.5] },
  { id: 'glm-5.3', rates: [1.4, 4.4, 0.26] },
  { id: 'glm-5.3-flash', rates: [0.15, 0.5, 0.03] },
  { id: 'gpt-5.3-codex', rates: [2, 8, 0.5, 0] },
  { id: 'gpt-5.4', rates: [2.5, 15, 0.25, 0] },
  { id: 'gpt-5.4-mini', rates: [0.75, 4.5, 0.075, 0] },
  { id: 'gpt-5.5', rates: [5, 30, 0.5, 0] },
  { id: 'gpt-5.6-luna', rates: [0.2, 1.2, 0.02, 0.25] },
  { id: 'gpt-5.6-sol', rates: [5, 30, 0.5, 6.25] },
  { id: 'gpt-5.6-terra', rates: [2, 12, 0.2, 2.5] },
  { id: 'gpt-6-astra', rates: [10, 50, 1, 12.5] },
  { id: 'grok-4.5', rates: [2, 6, 0.5] },
  { id: 'grok-4.6', rates: [2, 6, 0.5] },
  { id: 'inkling', rates: [1, 4.05, 0.17] },
  { id: 'inkling-small', rates: [0.5, 1.2, 0.1] },
  { id: 'kimi-k2.5', rates: [0.6, 3, 0.1] },
  { id: 'kimi-k2.6', rates: [0.95, 4, 0.16] },
  { id: 'kimi-k2.7-code', rates: [0.95, 4, 0.19] },
  { id: 'kimi-k2.7-code-highspeed', rates: [1.9, 8, 0.38] },
  { id: 'kimi-k3', rates: [3, 15, 0.3] },
  { id: 'mimo-v2.5', rates: [0.14, 0.28, 0.0028] },
  { id: 'mimo-v2.5-pro', rates: [0.435, 0.87, 0.0036] },
  { id: 'minimax-m2.5', rates: [0.3, 1.2, 0.03] },
  { id: 'minimax-m2.7', rates: [0.3, 1.2, 0.06] },
  { id: 'minimax-m3', rates: [0.3, 1.2, 0.06] },
  { id: 'muse-spark-1.1', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.2', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.2-contributor', rates: [0.1, 0.2, 0.002] },
  { id: 'muse-spark-1.3', rates: [1.25, 4.25, 0.15] },
  { id: 'muse-spark-1.3-contributor', rates: [0.1, 0.2, 0.002] },
  { id: 'nemotron-3-ultra', rates: [0.6, 2.4, 0.12] },
  { id: 'qwen-3.6-max', rates: [1.3, 7.8, 0.26, 1.63] },
  { id: 'qwen-3.6-plus', rates: [0.5, 3, 0.1] },
  { id: 'qwen-3.7-flash', rates: [0.03, 0.13, 0.006, 0.038] },
  { id: 'qwen-3.7-max', rates: [2.5, 7.5, 0.5, 3.13] },
  { id: 'qwen-3.7-plus', rates: [0.4, 1.6, 0.08, 0.5] },
  { id: 'qwen-3.8-27b', rates: [0.4, 3, 0.04] },
  { id: 'qwen-3.8-flash', rates: [0.16, 0.47, 0.016] },
  { id: 'qwen-3.8-max', rates: [2, 6, 0.25, 2.5] },
  { id: 'qwen-3.8-max-0902', rates: [2, 6, 0.25] },
  { id: 'step-3.5-flash', rates: [0.1, 0.3, 0.02] },
  { id: 'step-3.7-flash', rates: [0.2, 1.15, 0.04] },
  { id: 'tencent/hy3-paid', rates: [0.14, 0.58, 0.035] },
  { id: 'tencent/hy4-preview', rates: [0.834, 2.501, 0.042] },
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
 * exists in the vendored table absorbs that drift without a hand-maintained
 * map of seventy ids.
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
  // Indexed access is asserted rather than defaulted: the generator above only
  // ever emits rows with the three published rates, so a short row is a broken
  // table and must not silently become a free model.
  const rates: CommandCodeModelRates = {
    inputCost: values[0]!,
    outputCost: values[1]!,
    cacheReadCost: values[2]!,
  }
  if (values[3] !== undefined) rates.cacheWriteCost = values[3]
  return rates
}

/** Build the full price row the browser prices a session with. */
function wireRow(id: string, slug: string, row: ModelPriceRow): CommandCodeModelPrice {
  const price: CommandCodeModelPrice = { id, slug, ...ratesOf(row.rates) }
  if (row.peak !== undefined) price.peak = ratesOf(row.peak)
  return price
}

/**
 * Build the table the composer prices a session with.
 *
 * Rows are keyed by CATALOG id wherever the two namespaces reconcile, because
 * that is what a session reports, and every row also carries its page slug as a
 * second lookup key. Price rows no catalog model claims are served under the
 * slug alone, so drift in either direction still prices: a page rename the
 * catalog has not followed, or a model the catalog snapshot has not learned
 * yet. Free models are served explicitly at zero so the composer can say so
 * instead of showing nothing.
 *
 * The peak windows travel with the table, so the browser applies the very
 * schedule this snapshot knows instead of restating it.
 */
export function modelPriceTable(): CommandCodePriceTable {
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
    models.push(wireRow(catalogId, slug, row))
  }

  for (const row of MODEL_PRICE_ROWS) {
    if (claimed.has(row.id)) continue
    models.push(wireRow(row.id, row.id, row))
  }

  return {
    models,
    peakHours: PEAK_HOUR_RANGES.map(([start, end]) => [start, end] as [number, number]),
  }
}

