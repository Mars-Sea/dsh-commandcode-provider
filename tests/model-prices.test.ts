/**
 * Vendored price-table tests (node:test, zero deps). Run with `npm test`.
 *
 * The JOIN with the catalog is what matters: a catalog model the table cannot
 * reach shows no cost at all, indistinguishable from "this model is free".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { modelAllowanceFor, allowanceTierForWeight, modelPriceTable } from '../src/model-prices.ts'
import { KNOWN_PLANS, PEAK_HOUR_RANGES, dealLabel, isFreeModel } from '../src/capabilities.ts'

const table = modelPriceTable()
const byId = new Map(table.models.map((price) => [price.id, price]))

test('every catalog model is either priced or explicitly free', () => {
  const unreachable = Object.keys(KNOWN_PLANS).filter((id) => {
    if (isFreeModel(id) || id.endsWith(':free')) return false
    return byId.get(id) === undefined
  })
  // A new catalog model without a price row fails HERE rather than rendering no
  // cost: sync `MODEL_PRICE_ROWS` (see the dsh-commandcode-upstream skill) or
  // record the model below.
  assert.deepEqual(unreachable, [])
})

test('free catalog models carry zero rates and the free flag', () => {
  for (const id of Object.keys(KNOWN_PLANS)) {
    if (!isFreeModel(id) && !id.endsWith(':free')) continue
    const price = byId.get(id)
    assert.ok(price, `${id} should be served explicitly`)
    assert.equal(price.free, true)
    assert.equal(price.inputCost, 0)
    assert.equal(price.outputCost, 0)
    assert.equal(price.cacheReadCost, 0)
  }
})

test('a missing cache-write rate stays undefined rather than becoming zero', () => {
  // DeepSeek V4 Pro publishes no cache-write rate; a `0` here would render
  // cache-write tokens as free, which they are not.
  const pro = byId.get('deepseek/deepseek-v4-pro')
  assert.ok(pro)
  assert.equal(pro.cacheWriteCost, undefined)
  assert.equal(pro.inputCost, 0.66)
})

test('a published cache-write rate survives the table', () => {
  const sonnet = byId.get('claude-sonnet-4-6')
  assert.ok(sonnet, 'claude-sonnet-4-6 should be priced')
  assert.equal(sonnet.cacheWriteCost, 3.75)
})

test('time-of-day models carry a peak override and flat models do not', () => {
  const pro = byId.get('deepseek/deepseek-v4-pro')
  assert.ok(pro?.peak, 'the hourly-priced model keeps its peak block')
  assert.equal(pro.peak.inputCost, 1.32)
  // The table stores only the override: the top-level rates ARE the off-peak
  // half `ratesAt()` prices with outside the windows.
  assert.equal(pro.inputCost, 0.66)

  // `deepseek-v4-flash-fast` is flat-priced and must stay out of the peak set.
  const fast = byId.get('deepseek/deepseek-v4-flash-fast')
  assert.ok(fast)
  assert.equal(fast.peak, undefined)
})

test('the peak windows travel with the table', () => {
  assert.deepEqual(
    table.peakHours,
    PEAK_HOUR_RANGES.map(([start, end]) => [start, end]),
  )
  assert.deepEqual(table.peakHours, [[1, 4], [6, 10]])
})

test('price rows no catalog model claims are still served, keyed by slug', () => {
  const slugs = new Set(table.models.map((price) => price.slug))
  // The page names models the catalog snapshot has not learned yet; serving
  // them by slug lets a session on such a model still price.
  assert.ok(slugs.size > 0)
  for (const price of table.models) {
    assert.equal(typeof price.slug, 'string')
    assert.notEqual(price.slug, '')
    assert.equal(typeof price.inputCost, 'number')
    assert.equal(typeof price.outputCost, 'number')
    assert.equal(typeof price.cacheReadCost, 'number')
  }
})

test('a vendor-prefixed catalog id resolves to the page\'s unprefixed slug', () => {
  // `Qwen/Qwen3.8-Max-0902` → the page's `qwen-3.8-max-0902`: the vendor
  // segment is dropped AND a hyphen is inserted, which is exactly the drift
  // `priceSlugCandidates()` exists to absorb.
  const qwen = byId.get('Qwen/Qwen3.8-Max-0902')
  assert.ok(qwen, 'the catalog id must be the lookup key a session reports')
  assert.equal(qwen.slug, 'qwen-3.8-max-0902')
  assert.equal(qwen.inputCost, 2)
})

test('a dated catalog id resolves to the page\'s undated slug', () => {
  const haiku = byId.get('claude-haiku-4-5-20251001')
  assert.ok(haiku, 'the dated catalog id should reach the undated price row')
  assert.equal(haiku.slug, 'claude-haiku-4-5')
  assert.equal(haiku.inputCost, 1)
})

test('a row with no deal serves its rates and never reverts', () => {
  // Grok 4.7's 40%-off launch promotion ran 2026-09-21 → 2026-09-27T23:59:59.999Z
  // and the pricing page has since dropped it (command-code@1.72.1): the model
  // now publishes at list price, so its row carries plain `rates` and NO
  // `listRates`. Every clock therefore reads the same figures.
  const before = modelPriceTable(Date.parse('2026-09-21T00:00:00Z')).models.find((m) => m.id === 'xai/grok-4.7')
  const after = modelPriceTable(Date.parse('2026-09-28T00:00:00Z')).models.find((m) => m.id === 'xai/grok-4.7')
  assert.ok(before && after)

  assert.deepEqual(
    [before.inputCost, before.outputCost, before.cacheReadCost],
    [2, 6, 0.5],
    'the promotional figures are gone from the page, so list is what is charged',
  )
  assert.deepEqual(
    [after.inputCost, after.outputCost, after.cacheReadCost],
    [2, 6, 0.5],
    'past the old expiry nothing changes — there is no listRates to fall back to',
  )
  // Context bands are flat too: the row used to switch 1.2/2.4 with the deal.
  assert.deepEqual(before.contextTiers?.map((t) => t.inputCost), [2, 4])
  assert.deepEqual(after.contextTiers?.map((t) => t.inputCost), [2, 4])
})

test('the badge and the price revert on the same instant', () => {
  // The picker hides a lapsed deal through `dealLabel()`; the composer prices
  // through this table. One clock, or a user sees "no discount" next to a
  // discounted number. The boundary is inclusive on the expiry side.
  //
  // Grok 4.7 used to be the row carrying a dated deal; with it removed
  // (command-code@1.72.1) the snapshot has no live `expiresAt` left, so the
  // mechanism is pinned against its old boundary while asserting the row is
  // inert on BOTH sides — a future dated deal has to keep this agreement, and
  // a row whose deal is gone has to stop moving.
  const boundary = Date.parse('2026-09-27T23:59:59.999Z')
  for (const at of [boundary - 1, boundary, boundary + 1]) {
    const price = modelPriceTable(at).models.find((m) => m.id === 'xai/grok-4.7')
    assert.ok(price)
    assert.equal(dealLabel('xai/grok-4.7', at) !== undefined, false, `badge at ${at}`)
    assert.equal(price.inputCost, 2, `rate at ${at}`)
  }
})

test('a deal with no expiry never reverts', () => {
  // MiMo V2.5 and MiniMax M3 carry percentage deals with no published end date.
  // Their `listRates` are real data but must stay dormant: a permanent deal
  // lapses never, so the promotional rates are still the charged ones.
  const far = Date.parse('2030-01-01T00:00:00Z')
  const promo = modelPriceTable(far).models.find((m) => m.id === 'xiaomi/mimo-v2.5')
  assert.ok(promo)
  assert.deepEqual([promo.inputCost, promo.outputCost, promo.cacheReadCost], [0.14, 0.28, 0.0028])
})

test('per-model allowances resolve by the same slug rules as prices', () => {
  // MiniMax M3 is the row the pricing page documents in prose — "The deal is
  // baked into MiniMax M3's boosted per-model allowance: $47 of monthly usage on
  // GOAT, $57 on Pro" — so the snapshot and the page check each other.
  assert.deepEqual(modelAllowanceFor('MiniMaxAI/MiniMax-M3'), { goat: 47, pro: 57 })
  // Vendor-prefixed catalog id → the page's unprefixed slug.
  assert.deepEqual(modelAllowanceFor('xai/grok-4.7'), { goat: 20, pro: 30 })
  assert.deepEqual(modelAllowanceFor('claude-sonnet-5-5'), { goat: 10, pro: 20 })
  // Unknown ids answer undefined rather than a neighbouring model's figure.
  assert.equal(modelAllowanceFor('a-model-from-the-future'), undefined)
  assert.equal(modelAllowanceFor(''), undefined)
})

test('every priced catalog model carries both allowance brackets', () => {
  // The page publishes `planAllowanceUsd` on all 82 estimator records and
  // nowhere for Go/Provider/Max, so a missing bracket means the sync dropped a
  // row — the settings page would silently show no allowance for it.
  const missing: string[] = []
  for (const id of Object.keys(KNOWN_PLANS)) {
    if (isFreeModel(id) || id.endsWith(':free')) continue
    const allowance = modelAllowanceFor(id)
    if (allowance === undefined || !Number.isFinite(allowance.goat) || !Number.isFinite(allowance.pro)) {
      missing.push(id)
    }
  }
  assert.deepEqual(missing, [])
})

test('only GOAT and Pro map to an allowance bracket', () => {
  // Tier weights are the `KNOWN_SUBSCRIPTION_PLANS` scale (go 0 · goat 1 ·
  // pro 2 · provider 3 · max/ultra 4). Answering for Go/Provider/Max would be a
  // fabricated figure: the page has no allowance for those plans at all.
  assert.equal(allowanceTierForWeight(1), 'goat')
  assert.equal(allowanceTierForWeight(2), 'pro')
  assert.equal(allowanceTierForWeight(0), undefined)
  assert.equal(allowanceTierForWeight(3), undefined)
  assert.equal(allowanceTierForWeight(4), undefined)
  assert.equal(allowanceTierForWeight(undefined), undefined)
})
