/** One synthetic request, for tests that exercise the renderer rather than history folding. */
import { pricingKey, zeroCostTokens } from '../src/cost-facts.ts'
import type { SessionCostInput } from '../src/client/session-cost.ts'
export function withRequestFacts(input: SessionCostInput): SessionCostInput {
  const selection = input.selection?.lastUsed
  if (!selection || !input.table || !input.usage) return input
  const tokens = { ...zeroCostTokens(), ...input.usage }
  return { ...input, facts: { pricingKey: pricingKey(input.table), groups: [{ ...selection, at: input.now, contextTokens: tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens, tokens }] } }
}
