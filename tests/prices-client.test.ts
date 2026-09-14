/**
 * Price-table controller tests (node:test, zero deps). Run with `npm test`.
 *
 * `CommandCodePricesController` is a one-shot cache in front of the
 * `commandcode/prices` Remote: `ensure()` is safe to call from every mount
 * point, fetches at most once, and must read a Host half that serves no such
 * endpoint as a permanent "no prices" state rather than throwing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CommandCodePricesController } from '../src/client/prices.ts'
import type { CommandCodePriceTable } from '../src/usage-wire.ts'

const TABLE: CommandCodePriceTable = {
  models: [{ id: 'commandcode/test', slug: 'test', inputCost: 1, outputCost: 2, cacheReadCost: 0.1 }],
  peakHours: [[1, 4]],
}

test('ensure() fetches once and caches the table for the page lifetime', async () => {
  let calls = 0
  const controller = new CommandCodePricesController({
    prices: async () => {
      calls += 1
      return { ok: true, value: TABLE }
    },
  })
  const seen: string[] = []
  controller.subscribe(() => seen.push(controller.state().status))

  controller.ensure()
  assert.equal(controller.state().status, 'loading')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.state().status, 'ready')
  assert.deepEqual(controller.state().table, TABLE)

  controller.ensure()
  controller.ensure()
  await Promise.resolve()
  assert.equal(calls, 1, 'a second mount must join the cached table')
  assert.deepEqual(seen, ['loading', 'ready'])
})

test('a concurrent ensure() while one is in flight does not double-fetch', async () => {
  let calls = 0
  let release: ((value: { ok: true; value: CommandCodePriceTable }) => void) | undefined
  const controller = new CommandCodePricesController({
    prices: () => {
      calls += 1
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })

  controller.ensure()
  controller.ensure()
  assert.equal(calls, 1)
  release?.({ ok: true, value: TABLE })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.state().status, 'ready')
})

test('a failure stays retryable instead of caching the error', async () => {
  let calls = 0
  const controller = new CommandCodePricesController({
    prices: async () => {
      calls += 1
      if (calls === 1) return { ok: false, error: { message: 'not mounted yet' } }
      return { ok: true, value: TABLE }
    },
  })

  controller.ensure()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.state().status, 'error')
  assert.equal(controller.state().error, 'not mounted yet')

  controller.ensure()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 2)
  assert.equal(controller.state().status, 'ready')
})

test('a thrown request lands in the error state with its message', async () => {
  const controller = new CommandCodePricesController({
    prices: async () => {
      throw new Error('transport exploded')
    },
  })
  controller.ensure()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.state().status, 'error')
  assert.equal(controller.state().error, 'transport exploded')
})

test('a Host without the price endpoint is a permanent no-prices state, not a throw', async () => {
  // The Host and this bundle can be a cross-version pair: an older Host mounts
  // no `commandcode/prices` descriptor, so the namespace member is absent.
  const controller = new CommandCodePricesController({})
  controller.ensure()
  assert.equal(controller.state().status, 'error')
  assert.match(controller.state().error ?? '', /no commandcode\/prices endpoint/)
})

test('a disposed controller drops in-flight results and stops publishing', async () => {
  let release: ((value: { ok: true; value: CommandCodePriceTable }) => void) | undefined
  const controller = new CommandCodePricesController({
    prices: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  const seen: string[] = []
  controller.subscribe(() => seen.push(controller.state().status))

  controller.ensure()
  controller.dispose()
  release?.({ ok: true, value: TABLE })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, ['loading'])
  assert.equal(controller.state().status, 'loading')
})
