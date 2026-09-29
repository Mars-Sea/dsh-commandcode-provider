/** Shared plan-tier presentation facts; safe to inline into the browser bundle. */

export const PLAN_TIER_ORDER = ['go', 'goat', 'pro', 'provider', 'max'] as const

export const PLAN_LABELS: Readonly<Record<string, string>> = {
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  provider: 'Provider',
  max: 'Max',
}

export const PLAN_ORDER: Readonly<Record<string, number>> = Object.fromEntries(
  PLAN_TIER_ORDER.map((tier, index) => [tier, index]),
)
