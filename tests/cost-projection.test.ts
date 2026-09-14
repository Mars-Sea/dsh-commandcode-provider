import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createCostProjection, installCostProjection } from '../src/cost-projection.ts'
import { modelPriceTable } from '../src/model-prices.ts'
import { COST_TOKEN_KEYS, zeroCostTokens } from '../src/cost-facts.ts'
import { buildSessionCostView } from '../src/client/session-cost.ts'
import type { CommandCodePriceTable } from '../src/usage-wire.ts'

const table: CommandCodePriceTable = { peakHours: [[1, 4]], models: [
  { id: 'expensive', slug: 'expensive', inputCost: 10, outputCost: 50, cacheReadCost: 1 },
  { id: 'cheap', slug: 'cheap', inputCost: .2, outputCost: 1, cacheReadCost: .02 },
  { id: 'free', slug: 'free', inputCost: 0, outputCost: 0, cacheReadCost: 0, free: true },
  { id: 'hourly', slug: 'hourly', inputCost: .15, outputCost: .6, cacheReadCost: .003, peak: { inputCost: .3, outputCost: 1.2, cacheReadCost: .006 } },
] }
const off = Date.parse('2026-09-14T00:30Z'), peak = Date.parse('2026-09-14T01:30Z')
function harness(prices = table) {
  const unit = createCostProjection(prices)
  let state = unit.init()
  const send = (type: string, data: unknown, time = off) => { state = unit.apply(state, { type, data, time }) }
  const start = (model: string, turn = 1, at = off, provider = 'commandcode') => {
    send('step/start', { turn, step: 1 }, at)
    send('request/header', { header: { config: { provider, model } } }, at)
  }
  const usage = (inputTokens: number, turn = 1, extra = {}) => send('assistant/message', { turn, step: 1, usage: { inputTokens, outputTokens: 0, ...extra } })
  const view = (now = off) => {
    const facts = unit.wire.view(state), totals = zeroCostTokens()
    for (const g of facts.groups) for (const k of COST_TOKEN_KEYS) totals[k] += g.tokens[k]
    return buildSessionCostView({ usage: totals, facts, table: prices, selection: undefined, now })
  }
  return { unit, send, start, usage, view, state: () => state }
}

test('model switches and free models retain the costs of earlier requests', () => {
  const h = harness()
  h.start('expensive'); h.usage(1_000_000)
  h.start('cheap', 2); h.usage(1_000, 2)
  assert.ok(Math.abs(h.view()!.total - 10.0002) < 1e-10)
  h.start('free', 3); h.usage(1_000_000, 3)
  assert.equal(h.view()!.free, false)
  assert.ok(Math.abs(h.view()!.total - 10.0002) < 1e-10)
})

test('request-time rates survive reopening a session in another pricing window', () => {
  const h = harness()
  h.start('hourly'); h.usage(1_000_000)
  assert.equal(h.view(off)!.total, .15)
  assert.equal(h.view(peak)!.total, .15)
  h.start('hourly', 2, peak); h.usage(1_000_000, 2)
  assert.ok(Math.abs(h.view(off)!.total - .45) < 1e-10)
})

test('other providers and unknown models are excluded and explicitly mark a subtotal', () => {
  const h = harness()
  h.start('expensive', 1, off, 'other'); h.usage(1_000_000)
  assert.equal(h.view(), undefined)
  h.start('cheap', 2); h.usage(1_000_000, 2)
  h.start('unknown', 3); h.usage(1_000_000, 3)
  assert.equal(h.view()!.total, .2)
  assert.match(h.view()!.value, /^≥/)
  assert.match(h.view()!.title, /subtotal/)
})

test('v1 usage samples replace within an attempt; retries add instead of double counting', () => {
  const h = harness()
  h.start('cheap')
  h.send('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } })
  h.usage(200)
  assert.equal(h.state().facts.groups[0]!.tokens.uncachedInputTokens, 200)
  const before = h.state(); h.usage(200); assert.equal(h.state(), before)
  h.send('llm/retry-started', { turn: 1, step: 1 }, peak)
  h.usage(300)
  assert.equal(h.state().facts.groups[0]!.tokens.uncachedInputTokens, 500)
})

test('v2 successful and failed settlements use the last compact-stream usage sample', () => {
  const h = harness(); h.start('cheap')
  h.send('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: off, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } },
    { type: 'chunk', time: off, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 0 } } },
  ] })
  h.send('llm/retry-started', { turn: 1, step: 1 })
  h.send('assistant/message', { turn: 1, step: 1, stream: [{ type: 'chunk', time: off, chunk: { type: 'usage', usage: { inputTokens: 300, outputTokens: 0 } } }] })
  assert.equal(h.state().facts.groups[0]!.tokens.uncachedInputTokens, 500)
})

test('context bands use all request input buckets, inclusive boundaries, and never session totals', () => {
  const prices = modelPriceTable()
  for (const [tokens, rate] of [[272000, .2], [272001, .4]] as const) {
    const h = harness(prices); h.start('gpt-5.6-luna'); h.usage(tokens)
    assert.ok(Math.abs(h.view()!.total - tokens * rate / 1e6) < 1e-10)
  }
  const h = harness(prices)
  h.start('gpt-5.6-luna'); h.usage(200000)
  h.start('gpt-5.6-luna', 2); h.usage(200000, 2)
  assert.equal(h.view()!.total, .08)
  assert.equal(h.state().facts.groups.length, 1, 'equal rates aggregate rather than sending every request')
  h.start('gpt-5.6-luna', 3); h.usage(1, 3, { cacheReadTokens: 272000 })
  assert.ok(Math.abs(h.view()!.total - (.08 + .4 / 1e6 + 272000 * .04 / 1e6)) < 1e-10)
})

test('a revised same-attempt sample crossing a tier subtracts the old rate group', () => {
  const h = harness(modelPriceTable()); h.start('gpt-5.6-luna'); h.usage(272000); h.usage(272001)
  assert.equal(h.state().facts.groups.length, 1)
  assert.ok(Math.abs(h.view()!.total - 272001 * .4 / 1e6) < 1e-10)
})

test('old Hosts and mismatched projection cuts do not produce invented costs', () => {
  assert.equal(buildSessionCostView({ usage: { uncachedInputTokens: 10 }, table, selection: { lastUsed: { provider: 'commandcode', model: 'cheap' }, next: null }, now: off }), undefined)
  const h = harness(); h.start('cheap'); h.usage(100)
  assert.equal(buildSessionCostView({ usage: { uncachedInputTokens: 101 }, facts: h.state().facts, table, selection: undefined, now: off }), undefined)
  assert.equal(buildSessionCostView({ usage: { uncachedInputTokens: 100 }, facts: h.state().facts, table: { ...table, peakHours: [] }, selection: undefined, now: off }), undefined)
})

test('real registry replays history, checkpoints/forks and removes the optional projection', async () => {
  const ctx = new Context()
  const store = await ctx.plugin(SessionStore)
  const projections = await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin({ apply: installCostProjection })
  await new Promise(resolve => setTimeout(resolve, 0))
  const unit = createCostProjection()
  const registry = ctx.sessionProjections
  const session = ctx.sessions.create()
  // Restore drives actual persisted log values; no browser/session-memory accumulator is used.
  const events = [
    { type: 'step/start', time: off, seq: 0, data: { turn: 1, step: 1 } },
    { type: 'request/header', time: off, seq: 1, data: { header: { config: { provider: 'commandcode', model: 'gpt-5.6-luna' } } } },
    { type: 'assistant/message', time: off, seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 0 } } },
  ]
  const restored = registry.restore({}, events as never, 0 as never, session.header, 0 as never)
  const facts = (restored.snapshot.values as Record<string, unknown>).commandCodeCost
  assert.ok(facts)
  assert.deepEqual((registry.viewCheckpoint(restored.checkpoint) as Record<string, unknown>).commandCodeCost, facts)
  assert.throws(() => unit.stateSchema.parse({ facts: { pricingKey: 1, groups: [{ tokens: { outputTokens: -1 } }] } }))
  await fiber.dispose()
  assert.equal((registry.snapshot(session).values as Record<string, unknown>).commandCodeCost, undefined)
  await projections.dispose()
  await store.dispose()
})

test('free usage does not turn unpriced groups into a confident zero subtotal', () => {
  for (const [model, provider, extra] of [
    ['cheap', 'other', {}],
    ['unknown', 'commandcode', {}],
    ['cheap', 'commandcode', { cacheWriteTokens: 100 }],
  ] as const) {
    const h = harness(); h.start('free'); h.usage(100)
    assert.equal(h.view()!.value, 'Free')
    h.start(model, 2, off, provider); h.usage(model === 'cheap' && provider === 'commandcode' ? 0 : 100, 2, extra)
    assert.equal(h.view(), undefined, `${provider}/${model} cannot establish zero spending`)
    h.start('cheap', 3); h.usage(1000, 3)
    assert.ok(h.view()!.total > 0, 'a paid subtotal remains visible')
  }
})
