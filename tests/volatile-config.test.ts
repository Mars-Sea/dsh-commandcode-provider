/** Volatile-config helpers: marking and plain-view unwrapping. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVolatileRef, markVolatile, unwrapVolatileConfig } from '../src/config-volatile.ts'

test('markVolatile applies .volatile() and returns its result', () => {
  const marked = { meta: { volatile: true } }
  let called = 0
  const schema = {
    meta: { type: 'boolean' },
    volatile(): unknown {
      called += 1
      return marked
    },
  }
  assert.equal(markVolatile(schema), marked)
  assert.equal(called, 1)
})

test('isVolatileRef recognizes the frozen { get() } reference cosmokit hands out', () => {
  const ref = Object.freeze({ get: () => 42 })
  assert.equal(isVolatileRef(ref), true)
})

test('isVolatileRef rejects ordinary config shapes, including frozen ones', () => {
  assert.equal(isVolatileRef(null), false)
  assert.equal(isVolatileRef(undefined), false)
  assert.equal(isVolatileRef('skylark'), false)
  assert.equal(isVolatileRef({ apiBase: 'https://example.com' }), false)
  assert.equal(isVolatileRef(Object.freeze({ apiBase: 'https://example.com' })), false)
  // Arrays are values, not references — even frozen ones.
  assert.equal(isVolatileRef(Object.freeze([1, 2, 3])), false)
  // A frozen container without get() is not a reference either.
  assert.equal(isVolatileRef(Object.freeze({ value: 1 })), false)
})

test('unwrapVolatileConfig reads a plain config into an equivalent plain view', () => {
  const plain = { apiBase: 'https://example.com', visibleModels: ['a'] }
  assert.deepEqual(unwrapVolatileConfig(plain), plain)
  assert.deepEqual(unwrapVolatileConfig({}), {})
})

test('unwrapVolatileConfig passes a non-object through untouched', () => {
  const value = undefined as unknown as Record<string, unknown>
  assert.equal(unwrapVolatileConfig(value), value)
})

test('unwrapVolatileConfig reads each reference and returns a fresh view', () => {
  let live = 'first'
  const ref = Object.freeze({ get: () => live })
  const source = { apiBase: ref, transportMaxRetries: 5 }
  const first = unwrapVolatileConfig(source)
  assert.deepEqual(first, { apiBase: 'first', transportMaxRetries: 5 })
  // The reference's identity is stable while its value changes, so the ONLY
  // correct read is a fresh unwrap per call — a stale snapshot must be impossible.
  live = 'second'
  const second = unwrapVolatileConfig(source)
  assert.deepEqual(second, { apiBase: 'second', transportMaxRetries: 5 })
  assert.notEqual(first, second)
  // The raw config still carries the reference: unwrapping never mutates.
  assert.equal(source.apiBase, ref)
})

test('unwrapVolatileConfig only unwraps top-level fields', () => {
  // Volatile marks are authored on top-level fields only, so one level is
  // complete by construction; a nested frozen object (e.g. inside a value)
  // must pass through by identity rather than be probed for get().
  const nested = Object.freeze({ get: () => 'inner' })
  const source = { accounts: [{ label: nested }] }
  const view = unwrapVolatileConfig(source)
  assert.notEqual(view, source)
  const [entry] = view.accounts
  assert.ok(entry)
  assert.equal(entry.label, nested)
})
