/**
 * Session-cost view model for the composer readout.
 *
 * Deliberately JSX-free and React-free, mirroring `./panel.ts`: it turns the
 * session's token accounting plus the Host's price table into one presentation
 * value AND the exact text the two surfaces of the harness's token-usage UI
 * receive — the amount appended to the shipped pill, and the rows appended to
 * the shipped usage dialog. Node tests therefore drive the whole calculation,
 * and every user-visible string, without a DOM.
 *
 * The figures it prices are the session's DURABLE cumulative buckets, which is
 * what the composer's own "N tokens" pill reads too (`tokenUsage`), so the two
 * surfaces can never disagree about how much was used. Dollars are computed
 * here because Command Code publishes per-token rates and bills against
 * dollar-denominated windows; the account's own reported `totalCost` is a
 * billing PERIOD figure, not this session's.
 *
 * Three rules are load-bearing:
 *
 * 1. **Only Command Code usage is priced.** A session served by another
 *    provider must render nothing, never a Command Code estimate.
 * 2. **A missing rate is never invented.** The pricing page publishes
 *    input/output/cache-read rates for every model but a cache-WRITE rate for
 *    only some, so unpriced cache-write tokens are surfaced as such rather than
 *    charged at a guessed multiple of the input rate.
 * 3. **Unpriceable means invisible.** No usage, no model, no table, an unknown
 *    model, or all-zero buckets renders nothing at all — a confident `$0.00`
 *    would be a lie, and this module never returns one.
 *
 * @module dsh-commandcode-provider/client/session-cost
 */

import type { CommandCodeModelPrice, CommandCodeModelRates, CommandCodePriceTable } from '../usage-wire.ts'
import { formatMoney, formatMoneyExact, formatTokensCompact } from './usage.ts'

/** Tokens per published rate unit — the pricing page quotes USD per million. */
const TOKENS_PER_RATE_UNIT = 1_000_000

/** The provider route whose usage this surface prices. */
const COMMANDCODE_PROVIDER = 'commandcode'

/**
 * The English copy for this surface.
 *
 * A plain constant, NOT the `settings.commandcode` locale namespace: like the
 * plans & quota panel, the readout stays English on a Chinese harness. Do not
 * route it through `ctx.locale`.
 */
export const SESSION_COST_COPY = {
  /** Shown instead of an amount when the model costs nothing on every plan. */
  free: 'Free',
  /**
   * The separator the readout prefixes itself with, so the cost reads as the
   * last item of the token-usage pill's text run rather than a control beside
   * it. Rendered with the same colour and margins the shipped pill uses
   * between its own items.
   */
  separator: '·',
  /** The heading the tooltip leads with. */
  panelTitle: 'Session cost',
  /** Marks a total computed from a single model on a session that used more. */
  approximate: '≈',
  /** Tooltip line for the unpriced cache-write tokens. */
  unpricedCacheWrite: 'cache write tokens have no published rate',
  /** Tooltip line naming the rate half in force. */
  peakRates: 'peak rates',
  /** Tooltip line naming the rate half in force. */
  offPeakRates: 'off-peak rates',
  /** Tooltip line explaining the approximate marker. */
  approximateNote: 'this session has used more than one model',
  /** Row/tooltip label for uncached prompt tokens. */
  uncachedInput: 'uncached input',
  /** Row/tooltip label for completion tokens. */
  output: 'output',
  /** Row/tooltip label for cache-served input tokens. */
  cacheRead: 'cache read',
  /** Row/tooltip label for cache-written input tokens. */
  cacheWrite: 'cache write',
} as const

/**
 * The session's cumulative token buckets, as the `tokenUsage` projection
 * carries them. Declared structurally and defensively: this bundle does not
 * depend on the session-controller package, and a bucket the provider never
 * reported is absent rather than zero.
 */
export interface SessionUsageBuckets {
  readonly uncachedInputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One entry of the `modelSelection` projection. */
export interface SessionModelSelection {
  readonly provider: string
  readonly model: string
}

/**
 * The `modelSelection` projection: the selection the latest request consumed,
 * and the one the next request will use (falling back to the former).
 */
export interface SessionModelSelectionProjection {
  readonly lastUsed: SessionModelSelection | null
  readonly next: SessionModelSelection | null
}

/** Everything the view needs, already read off the seats by the component. */
export interface SessionCostInput {
  /** The durable cumulative token buckets, or undefined before any request. */
  usage: SessionUsageBuckets | undefined
  /** The session's model selection fold, or undefined on an older Host. */
  selection: SessionModelSelectionProjection | undefined
  /** The Host's price table, or undefined until it lands. */
  table: CommandCodePriceTable | undefined
  /** Current wall-clock millis, injected so the peak-hour rule is testable. */
  now: number
}

/** One bucket's line in the usage dialog. */
export interface SessionCostBucketRow {
  /** Stable key. */
  key: 'uncachedInput' | 'cacheRead' | 'cacheWrite' | 'output'
  /** Row label. */
  label: string
  /** Tokens charged in this bucket; a bucket that charged nothing withholds its
   *  row rather than printing a meaningless zero. */
  tokens: number
  /** What this bucket cost, or undefined when the table has no rate for it. */
  costText: string | undefined
}

/** The composer readout's presentation value. */
export interface SessionCostView {
  /** Priced total in dollars. */
  total: number
  /** Visible amount text, e.g. `$0.0123` (or the free word, when free). */
  value: string
  /** Full tooltip/accessible text, including the bucket breakdown. */
  title: string
  /** Per-bucket lines for the usage dialog, in reading order. */
  rows: SessionCostBucketRow[]
  /** Caveat lines for the pill's tooltip (rate half, approximation, unpriced). */
  notes: string[]
  /** The model costs nothing on every plan right now. */
  free: boolean
  /** The model's `peak` rates are in force. */
  peak: boolean
  /** Cache-write tokens the table has no rate for (never guessed, so the
   *  total is a floor rather than an estimate). */
  unpricedCacheWriteTokens: number
  /** The session has used more than one model, so a one-model total is
   *  approximate. */
  approximate: boolean
}

/** A finite, non-negative count — anything else reads as absent. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Whether `now` falls inside a peak-pricing window, per the windows that travel
 * with the price table. Monday–Friday (UTC) only, and each window is
 * end-exclusive — the same rule the Host snapshot applies when it labels the
 * model picker. The schedule is read from the wire rather than restated so
 * there is one definition of the windows, on the Host.
 */
export function isPeakHour(now: number, peakHours: ReadonlyArray<readonly [number, number]>): boolean {
  const at = new Date(now)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return peakHours.some(([start, end]) => hour >= start && hour < end)
}

/**
 * The rates in force for one model at `now`, and whether they are the peak
 * override. A row with no `peak` block is flat-priced — its top-level rates are
 * the off-peak rates, which is why the snapshot stores only the override.
 */
function ratesAt(
  price: CommandCodeModelPrice,
  now: number,
  peakHours: ReadonlyArray<readonly [number, number]>,
): { rates: CommandCodeModelRates; peak: boolean } {
  if (price.peak !== undefined && isPeakHour(now, peakHours)) {
    return { rates: price.peak, peak: true }
  }
  return { rates: price, peak: false }
}

/**
 * Index a price table for lookup. Rows are keyed by catalog id and by pricing
 * slug, both exact and lowercased, because a session reports a catalog id while
 * a row no catalog model claims is served under the page's slug.
 */
function indexTable(table: CommandCodePriceTable): Map<string, CommandCodeModelPrice> {
  const index = new Map<string, CommandCodeModelPrice>()
  for (const price of table.models) {
    for (const key of [price.id, price.slug]) {
      if (typeof key !== 'string' || key === '') continue
      if (!index.has(key)) index.set(key, price)
      const lower = key.toLowerCase()
      if (!index.has(lower)) index.set(lower, price)
    }
  }
  return index
}

/**
 * The model whose rates price this session, plus whether the session has used
 * more than one.
 *
 * `lastUsed` is the selection the latest recorded request consumed, so it is
 * what the accumulated tokens were actually billed at; `next` differs only when
 * a newer selection is pending, which is precisely the signal that more than one
 * model has served this session.
 */
function resolveModel(
  selection: SessionModelSelectionProjection | undefined,
): { model: string; approximate: boolean } | undefined {
  const lastUsed = selection?.lastUsed ?? null
  const next = selection?.next ?? null
  const chosen = lastUsed ?? next
  if (chosen === null || typeof chosen.model !== 'string' || chosen.model === '') return undefined
  if (chosen.provider !== COMMANDCODE_PROVIDER) return undefined
  const approximate = lastUsed !== null && next !== null && lastUsed.model !== next.model
  return { model: chosen.model, approximate }
}

/**
 * The dollar cost of each bucket, plus the total and the unpriced remainder.
 *
 * Every bucket is charged at its own published rate; the cache-write bucket
 * contributes only when the model publishes a rate for it, otherwise its tokens
 * are returned as {@link SessionCostView.unpricedCacheWriteTokens} and its own
 * cost stays undefined so the panel can say so instead of printing a zero.
 */
interface SessionCostBreakdown {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number | undefined
  output: number
  total: number
  unpricedCacheWriteTokens: number
}

function costOf(
  usage: SessionUsageBuckets,
  rates: CommandCodeModelRates,
  free: boolean,
): SessionCostBreakdown {
  if (free) {
    return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, unpricedCacheWriteTokens: 0 }
  }
  const perUnit = (tokens: number, rate: number): number => (tokens * rate) / TOKENS_PER_RATE_UNIT
  const uncachedInput = perUnit(count(usage.uncachedInputTokens), rates.inputCost)
  const output = perUnit(count(usage.outputTokens), rates.outputCost)
  const cacheRead = perUnit(count(usage.cacheReadTokens), rates.cacheReadCost)
  const cacheWriteTokens = count(usage.cacheWriteTokens)
  const cacheWrite = rates.cacheWriteCost === undefined
    ? undefined
    : perUnit(cacheWriteTokens, rates.cacheWriteCost)
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    total: uncachedInput + output + cacheRead + (cacheWrite ?? 0),
    unpricedCacheWriteTokens: rates.cacheWriteCost === undefined ? cacheWriteTokens : 0,
  }
}

/**
 * Amount text for a session cost.
 *
 * The panel's `money()` convention (2 decimals, 4 below a cent) is right for
 * billing windows, but a live session total starts far below a cent, where
 * `toFixed(4)` would print a flat `$0.0000` — which reads as broken rather than
 * as small. So a total under $0.0001 is stated as a bound instead.
 */
export function sessionCostAmount(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return formatMoney(0)
  if (total < 0.0001) return `<$0.0001`
  return total < 0.01 ? formatMoneyExact(total) : formatMoney(total)
}

/** One `label value` clause of the tooltip. */
function clause(label: string, tokens: number): string | undefined {
  return tokens > 0 ? `${label} ${formatTokensCompact(tokens)}` : undefined
}

/**
 * Build the composer readout, or undefined when there is nothing honest to show.
 *
 * Undefined is the correct answer for a session with no usage yet, a session
 * another provider served, a model the price table does not know, and a table
 * that has not landed — the pill simply is not there.
 */
export function buildSessionCostView(input: SessionCostInput): SessionCostView | undefined {
  const { usage, table, now } = input
  if (usage === undefined || table === undefined || table.models.length === 0) return undefined
  const resolved = resolveModel(input.selection)
  if (resolved === undefined) return undefined

  const price = indexTable(table).get(resolved.model)
  if (price === undefined) return undefined

  const free = price.free === true
  const { rates, peak } = ratesAt(price, now, table.peakHours)
  const breakdown = costOf(usage, rates, free)
  const { total, unpricedCacheWriteTokens } = breakdown

  const uncachedInput = count(usage.uncachedInputTokens)
  const output = count(usage.outputTokens)
  const cacheRead = count(usage.cacheReadTokens)
  const cacheWrite = count(usage.cacheWriteTokens)
  // No billed token of any kind means there is nothing to report yet: a `$0.00`
  // pill on a session that has not made a request would be noise, not
  // information, and on a free model it would be redundant.
  if (uncachedInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined

  const value = free
    ? SESSION_COST_COPY.free
    : `${resolved.approximate ? SESSION_COST_COPY.approximate : ''}${sessionCostAmount(total)}`
  const money = (amount: number | undefined): string | undefined =>
    amount === undefined ? undefined : sessionCostAmount(amount)
  // Reading order mirrors the prompt's own order: what was charged at the input
  // rate, then the two cache buckets, then what the model produced.
  const rows: SessionCostBucketRow[] = [
    { key: 'uncachedInput', label: SESSION_COST_COPY.uncachedInput, tokens: uncachedInput, costText: money(breakdown.uncachedInput) },
    { key: 'cacheRead', label: SESSION_COST_COPY.cacheRead, tokens: cacheRead, costText: money(breakdown.cacheRead) },
    { key: 'cacheWrite', label: SESSION_COST_COPY.cacheWrite, tokens: cacheWrite, costText: money(breakdown.cacheWrite) },
    { key: 'output', label: SESSION_COST_COPY.output, tokens: output, costText: money(breakdown.output) },
  ]
  // Widened to `string | undefined` before filtering: the copy table is `as
  // const`, so the array would otherwise infer a union of literal types that a
  // `part is string` predicate is not assignable to.
  const notes = ([
    free ? undefined : (peak ? SESSION_COST_COPY.peakRates : SESSION_COST_COPY.offPeakRates),
    unpricedCacheWriteTokens > 0 ? SESSION_COST_COPY.unpricedCacheWrite : undefined,
    resolved.approximate ? SESSION_COST_COPY.approximateNote : undefined,
  ] as Array<string | undefined>).filter((part): part is string => part !== undefined)
  const title = [
    `${SESSION_COST_COPY.panelTitle} ${free ? SESSION_COST_COPY.free : sessionCostAmount(total)}`,
    clause(SESSION_COST_COPY.uncachedInput, uncachedInput),
    clause(SESSION_COST_COPY.output, output),
    clause(SESSION_COST_COPY.cacheRead, cacheRead),
    clause(SESSION_COST_COPY.cacheWrite, cacheWrite),
    ...notes,
  ].join(' · ')

  return {
    total,
    value,
    title,
    rows,
    notes,
    free,
    peak,
    unpricedCacheWriteTokens,
    approximate: resolved.approximate,
  }
}

/**
 * The two nodes the text appended to the harness's token-usage pill is made of.
 *
 * The separator is a node of its own because it carries the shipped pill's
 * SEPARATOR colour rather than its label colour; the pill is a flex row whose
 * `gap` already spaces the appended item, so the separator is what makes the
 * result read as one continuous run (`1.2M tokens · Cache hit 87% · $0.0123`)
 * rather than as a value parked at the end of it.
 */
export interface SessionCostPillRun {
  /** The shipped pill's own separator glyph. */
  separator: string
  /** The amount, `≈` marker and free word included. */
  value: string
}

/** Split the appended run into the two nodes the display creates. */
export function sessionCostPillRun(view: SessionCostView): SessionCostPillRun {
  return { separator: SESSION_COST_COPY.separator, value: view.value }
}

/**
 * How the harness's own usage dialog is decorated: one entry per row the
 * shipped component renders, IN ITS OWN ORDER.
 *
 * The price goes on the right of the row it belongs to (`3,206,544 tok  $0.07`)
 * rather than in a block of our own rows beneath them, so the dialog keeps the
 * harness's layout and gains nothing to read past.
 *
 * Two rows are special. `cacheHit` carries a percentage, not a count, so it is
 * never priced. `cacheWrite` is HIDDEN and never priced: the pricing page
 * publishes a cache-write rate for a minority of models, so its cell read
 * `unpriced` far more often than a number; its tokens still count toward the
 * total the pill shows.
 */
export type SessionCostShippedRow = 'cacheHit' | 'uncachedInput' | 'cacheRead' | 'cacheWrite' | 'output'

/** One shipped dialog row and what to do with it. */
export interface SessionCostRowDecoration {
  /** Which shipped row this is. */
  row: SessionCostShippedRow
  /**
   * The exact token count that row must be showing, or undefined for a row that
   * carries no count. The display layer verifies it before decorating anything:
   * the shipped labels are the `chat` locale's own strings (never English), so
   * rows are matched POSITIONALLY and this is what proves the position is right.
   */
  tokens: number | undefined
  /** The price to append to the row's value, or undefined to leave it alone. */
  amount: string | undefined
  /** Whether the row is dropped from the dialog entirely. */
  hidden: boolean
}

/**
 * Decorate the harness's usage dialog, row by row.
 *
 * The row sequence mirrors the shipped component's conditions exactly — the
 * cache-hit row exists while there is billed prompt input, the cache-write row
 * while those tokens are non-zero — because the display layer matches what it
 * finds positionally. A shape it cannot confirm is a shape it does not touch.
 *
 * A free model decorates nothing: every row's cost is zero by definition, the
 * pill already says `Free`, and a column of `$0.00` would be noise. A bucket
 * whose rate the page does not publish is likewise left unfilled rather than
 * filled with an invented number.
 */
export function sessionCostRowDecorations(view: SessionCostView): SessionCostRowDecoration[] {
  const bucket = (key: SessionCostBucketRow['key']): number =>
    view.rows.find((row) => row.key === key)?.tokens ?? 0
  const price = (key: SessionCostBucketRow['key']): string | undefined => {
    if (view.free) return undefined
    return view.rows.find((row) => row.key === key)?.costText
  }
  const uncachedInput = bucket('uncachedInput')
  const cacheRead = bucket('cacheRead')
  const cacheWrite = bucket('cacheWrite')
  const output = bucket('output')
  const plan: SessionCostRowDecoration[] = []
  if (uncachedInput + cacheRead + cacheWrite > 0) {
    plan.push({ row: 'cacheHit', tokens: undefined, amount: undefined, hidden: false })
  }
  plan.push({ row: 'uncachedInput', tokens: uncachedInput, amount: price('uncachedInput'), hidden: false })
  plan.push({ row: 'cacheRead', tokens: cacheRead, amount: price('cacheRead'), hidden: false })
  if (cacheWrite !== 0) {
    plan.push({ row: 'cacheWrite', tokens: cacheWrite, amount: undefined, hidden: true })
  }
  plan.push({ row: 'output', tokens: output, amount: price('output'), hidden: false })
  return plan
}
