/**
 * Settings-page fold state tests (node:test, zero deps). Run with `npm test`.
 *
 * The page remembers which of its four groups are open in one localStorage key
 * (决策记录第十章第4条). These cases pin the defaults, the tolerant parse that
 * lets a partial or foreign record degrade group by group, and the storage
 * adapter's promise that a broken storage never breaks the page.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FOLD_STATE,
  FOLD_STATE_KEY,
  expandGroups,
  localStorageFoldStore,
  parseFoldState,
} from '../src/client/group-fold.ts'

/** A Map-backed stand-in for `Storage`; `failing` makes every call throw. */
function memoryStorage(initial: Record<string, string> = {}, failing = false): Storage {
  const data = new Map(Object.entries(initial))
  const guard = () => { if (failing) throw new Error('storage blocked') }
  return {
    get length() { return data.size },
    clear() { guard(); data.clear() },
    getItem(key: string) { guard(); return data.get(key) ?? null },
    key(index: number) { return [...data.keys()][index] ?? null },
    removeItem(key: string) { guard(); data.delete(key) },
    setItem(key: string, value: string) { guard(); data.set(key, value) },
  }
}

test('first visit: only Accounts is open', () => {
  assert.deepEqual(parseFoldState(null), {
    accounts: true, models: false, context: false, advanced: false,
  })
})

test('unusable records fall back to the defaults', () => {
  for (const raw of ['', 'not json', '[]', 'null', '42', '"open"']) {
    assert.deepEqual(parseFoldState(raw), DEFAULT_FOLD_STATE, raw)
  }
})

test('a partial record keeps the groups it knows and defaults the rest', () => {
  const state = parseFoldState(JSON.stringify({ models: true, accounts: false, context: 'yes', removed: true }))
  assert.equal(state.models, true)
  assert.equal(state.accounts, false)
  assert.equal(state.context, false, 'a non-boolean flag is ignored')
  assert.equal(state.advanced, false)
  assert.equal('removed' in state, false, 'unknown groups are dropped')
})

test('expandGroups opens only the named groups and keeps the rest', () => {
  const next = expandGroups(DEFAULT_FOLD_STATE, ['advanced'])
  assert.equal(next.advanced, true)
  assert.equal(next.models, false)
  assert.equal(next.accounts, true)
  assert.equal(expandGroups(next, ['advanced']), next, 'nothing to open returns the same state')
})

test('the store round-trips through one key', () => {
  const storage = memoryStorage()
  const store = localStorageFoldStore(storage)
  const state = { ...DEFAULT_FOLD_STATE, context: true }
  store.write(state)
  assert.deepEqual(JSON.parse(storage.getItem(FOLD_STATE_KEY) ?? ''), state)
  assert.deepEqual(store.read(), state)
})

test('a missing or throwing storage reads as the defaults and drops writes', () => {
  assert.deepEqual(localStorageFoldStore(undefined).read(), DEFAULT_FOLD_STATE)
  const broken = localStorageFoldStore(memoryStorage({}, true))
  assert.deepEqual(broken.read(), DEFAULT_FOLD_STATE)
  assert.doesNotThrow(() => broken.write({ ...DEFAULT_FOLD_STATE, models: true }))
})
