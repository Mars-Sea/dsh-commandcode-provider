/** Snapshot-store compatibility tests. */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshotStore } from '../src/client/snapshot-store.ts'

test('set publishes changed snapshots and skips identical values', () => {
  const store = createSnapshotStore({ value: 1 })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  const initial = store.getSnapshot()

  store.set(initial)
  assert.equal(notifications, 0)

  const next = { value: 2 }
  store.set(next)
  assert.equal(store.getSnapshot(), next)
  assert.equal(notifications, 1)
})

test('subscriber failures do not suppress later subscribers', () => {
  const store = createSnapshotStore(0)
  const originalError = console.error
  const reported: unknown[][] = []
  let observed = 0
  console.error = (...args: unknown[]) => { reported.push(args) }
  try {
    store.subscribe(() => { throw new Error('broken subscriber') })
    store.subscribe(() => { observed += 1 })
    store.set(1)
  } finally {
    console.error = originalError
  }

  assert.equal(observed, 1)
  assert.equal(reported.length, 1)
  assert.match(String(reported[0]?.[0]), /snapshot subscriber failed/)
})

test('unsubscribe stops later notifications', () => {
  const store = createSnapshotStore(0)
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })

  store.set(1)
  unsubscribe()
  store.set(2)

  assert.equal(notifications, 1)
})
