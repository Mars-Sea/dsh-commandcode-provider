/** Shared, JSON-only billing facts. No Host or browser runtime imports. */
import type { CommandCodeModelPrice, CommandCodeModelRates, CommandCodePriceTable } from './usage-wire.ts'

export interface CostTokens {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Requests with identical model/rates are folded into one group. */
export interface CostUsageGroup {
  provider: string
  model: string
  at: number | null
  contextTokens: number
  tokens: CostTokens
}

export interface SessionCostFacts {
  pricingKey: number
  groups: CostUsageGroup[]
}

export const zeroCostTokens = (): CostTokens => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
export const COST_TOKEN_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

export function peakHour(at: number, windows: ReadonlyArray<readonly [number, number]>): boolean {
  const time = new Date(at)
  return time.getUTCDay() !== 0 && time.getUTCDay() !== 6
    && windows.some(([start, end]) => time.getUTCHours() >= start && time.getUTCHours() < end)
}

/**
 * All prompt billing buckets determine a request's band, never cumulative session input.
 *
 * A tiered model returns the matching band and does NOT then apply `peak`: the
 * page publishes those two dimensions independently, no row carries both today,
 * and the generator would report a tiered row on every sync — so the combination
 * becoming real is visible before it reaches a user. This ordering is a latent
 * choice, not a verified upstream rule.
 */
export function requestRates(price: CommandCodeModelPrice, at: number | null, contextTokens: number, table: CommandCodePriceTable): CommandCodeModelRates {
  // The first band whose bound accepts the prompt. ORDER IS LOAD-BEARING, and
  // both producers enforce it: the generator refuses non-ascending bounds or a
  // bounded last band, and the wire parser rejects the same shapes — so a
  // conforming table cannot present bands out of order, and this `find` cannot
  // select a band a later one should have won.
  const tier = price.contextTiers?.find(tier => tier.maxContext === undefined || contextTokens <= tier.maxContext)
  if (tier !== undefined) return tier
  return price.peak !== undefined && at !== null && peakHour(at, table.peakHours) ? price.peak : price
}

/** Cache version and wire guard: changing bands/rates must refold historical groups. */
export function pricingKey(table: CommandCodePriceTable): number {
  const rates = (r: CommandCodeModelRates) => [r.inputCost, r.outputCost, r.cacheReadCost, r.cacheWriteCost ?? null]
  const canonical = JSON.stringify(['commandCodeCost-v1', table.peakHours, table.models.map(p => [p.id, p.slug, p.free === true, rates(p), p.peak ? rates(p.peak) : null, p.contextTiers?.map(t => [t.maxContext ?? null, rates(t)]) ?? null])])
  let hash = 2166136261
  for (const c of canonical) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0
  return hash
}

/** Only safe to merge requests whose billing classification is identical. */
export function costGroupKey(group: CostUsageGroup, table: CommandCodePriceTable): string {
  const price = table.models.find(p => p.id === group.model || p.slug === group.model)
  return JSON.stringify([group.provider, group.model, price === undefined ? null : requestRates(price, group.at, group.contextTokens, table), group.at === null])
}
