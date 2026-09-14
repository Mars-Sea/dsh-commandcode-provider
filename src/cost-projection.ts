/** Durable cost facts: mirrors token-meter's replacement/retry rules across v1/v2 logs. */
import type { Context } from '@deepseek-ai/cordis'
import { modelPriceTable } from './model-prices.ts'
import { COST_TOKEN_KEYS, costGroupKey, pricingKey, zeroCostTokens, type CostTokens, type CostUsageGroup, type SessionCostFacts } from './cost-facts.ts'

interface CostState {
  selection: { provider: string; model: string } | null
  at: number | null
  last: { turn: number; step: number; group: CostUsageGroup } | null
  facts: SessionCostFacts
}
interface LogEvent { type: string; time: number; data: unknown }
const record = (v: unknown): Record<string, unknown> | undefined => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function tokensOf(value: unknown): CostTokens | undefined {
  const u = record(value)
  if (!u || !finite(u.inputTokens) || !finite(u.outputTokens)) return undefined
  if (u.cacheReadTokens !== undefined && !finite(u.cacheReadTokens) || u.cacheWriteTokens !== undefined && !finite(u.cacheWriteTokens)) return undefined
  return { uncachedInputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens as number ?? 0, cacheWriteTokens: u.cacheWriteTokens as number ?? 0 }
}

/** Current v2 settlements store the last usage in their stream; v1 stores chunk events. */
function usageOf(type: string, data: Record<string, unknown>): CostTokens | undefined {
  if (type === 'assistant/chunk') {
    const chunk = record(data.chunk)
    return chunk?.type === 'usage' ? tokensOf(chunk.usage) : undefined
  }
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined
  const direct = tokensOf(data.usage)
  if (direct !== undefined) return direct
  if (!Array.isArray(data.stream)) return undefined
  for (let i = data.stream.length - 1; i >= 0; i--) {
    const item = record(data.stream[i])
    const chunk = item?.type === 'chunk' ? record(item.chunk) : undefined
    if (chunk?.type === 'usage') return tokensOf(chunk.usage)
  }
  return undefined
}

function parseState(value: unknown): CostState {
  const s = record(value), facts = record(s?.facts)
  if (!s || !facts || !finite(facts.pricingKey) || !Array.isArray(facts.groups)) throw new TypeError('invalid commandCodeCost state')
  const group = (v: unknown): boolean => {
    const g = record(v), t = record(g?.tokens)
    return !!g && typeof g.provider === 'string' && typeof g.model === 'string' && (g.at === null || finite(g.at)) && finite(g.contextTokens) && !!t && COST_TOKEN_KEYS.every(k => finite(t[k]))
  }
  const sel = record(s.selection), last = record(s.last)
  if (!(s.selection === null || sel && typeof sel.provider === 'string' && typeof sel.model === 'string')
    || !(s.at === null || finite(s.at)) || !facts.groups.every(group)
    || !(s.last === null || last && finite(last.turn) && finite(last.step) && group(last.group))) throw new TypeError('invalid commandCodeCost state')
  return value as CostState
}

/** Optional registry uses only synchronous parse/view; no new runtime module is required. */
export function createCostProjection(table = modelPriceTable()) {
  const version = pricingKey(table)
  return {
    key: 'commandCodeCost', stateVersion: version,
    stateSchema: { parse: parseState },
    init: (): CostState => ({ selection: null, at: null, last: null, facts: { pricingKey: version, groups: [] } }),
    apply(state: CostState, event: LogEvent): CostState {
      const data = record(event.data)
      if (!data) return state
      if (event.type === 'request/header') {
        const config = record(record(data.header)?.config)
        return { ...state, selection: config && typeof config.provider === 'string' && typeof config.model === 'string' ? { provider: config.provider, model: config.model } : null }
      }
      if (event.type === 'step/start' || event.type === 'llm/retry-started') return { ...state, at: finite(event.time) ? event.time : null, last: null }
      const tokens = usageOf(event.type, data)
      if (tokens === undefined || !finite(data.turn) || !finite(data.step)) return state
      const previous = state.last?.turn === data.turn && state.last.step === data.step ? state.last.group : undefined
      const group: CostUsageGroup = { provider: state.selection?.provider ?? '', model: state.selection?.model ?? '', at: state.at, contextTokens: tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens, tokens }
      if (previous && JSON.stringify(previous) === JSON.stringify(group)) return state
      const groups = state.facts.groups.map(g => ({ ...g, tokens: { ...g.tokens } }))
      if (previous) {
        const old = groups.find(g => costGroupKey(g, table) === costGroupKey(previous, table))
        if (old) for (const k of COST_TOKEN_KEYS) old.tokens[k] -= previous.tokens[k]
      }
      let target = groups.find(g => costGroupKey(g, table) === costGroupKey(group, table))
      if (!target) { target = { ...group, tokens: zeroCostTokens() }; groups.push(target) }
      for (const k of COST_TOKEN_KEYS) target.tokens[k] += tokens[k]
      return { ...state, last: { turn: data.turn, step: data.step, group }, facts: { pricingKey: version, groups: groups.filter(g => COST_TOKEN_KEYS.some(k => g.tokens[k] > 0)) } }
    },
    wire: {
      view: (state: CostState) => state.facts,
      viewSchema: { parse(value: unknown): SessionCostFacts { return parseState({ selection: null, at: null, last: null, facts: value }).facts } },
    },
  }
}

export function installCostProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], c => {
    const registry = c.get('sessionProjections') as { register(definition: ReturnType<typeof createCostProjection>): () => void } | undefined
    if (typeof registry?.register === 'function') c.effect(() => registry.register(createCostProjection()), 'commandcode cost projection')
  })
}
