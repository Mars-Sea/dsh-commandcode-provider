/**
 * Vendored price-table tests (node:test, zero deps). Run with `npm test`.
 *
 * The table is the Host half of the composer's session-cost readout, so what
 * matters here is the JOIN with the catalog: a catalog model the table cannot
 * reach shows no cost at all, which looks identical to "this model is free" to
 * a user. These tests therefore pin the join itself, not just the numbers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { modelPriceTable } from '../src/model-prices.ts'
import { KNOWN_PLANS, PEAK_HOUR_RANGES, isFreeModel } from '../src/capabilities.ts'

const table = modelPriceTable()
const byId = new Map(table.models.map((price) => [price.id, price]))

test('every catalog model is either priced or explicitly free', () => {
  const unreachable = Object.keys(KNOWN_PLANS).filter((id) => {
    if (isFreeModel(id) || id.endsWith(':free')) return false
    return byId.get(id) === undefined
  })
  // A new catalog model without a price row fails HERE rather than silently
  // rendering no cost in the composer. When upstream adds a model: sync
  // `MODEL_PRICE_ROWS` from the pricing page (see the dsh-commandcode-upstream
  // skill) or record it in the corpus below.
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
  // half, which is what `ratesAt()` prices with outside the windows.
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
  // them under the slug is what lets a session on such a model still price.
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
