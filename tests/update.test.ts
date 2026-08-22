/**
 * Update-hint tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the settings page's plugin-update hint logic: tolerant semver
 * comparison, strict registry-payload parsing, the throttled localStorage
 * cache, and checkForUpdate's failure semantics (degrade silently, keep any
 * previously learned version, never hammer the registry).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NPM_LATEST_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_CACHE_KEY,
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  isNewerVersion,
  localStorageUpdateStore,
  parseLatestVersion,
} from '../src/client/update.ts'

test('compareVersions orders releases numerically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.2.4', '1.2.3') > 0)
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0)
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0)
  // Numeric parts compare numerically, not lexically.
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  // Tolerant extras: leading v and unparsable parts.
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.x.0', '1.0.0'), 0)
})

test('compareVersions applies prerelease rules', () => {
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0)
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.1') > 0)
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-alpha.1') > 0)
  // Numeric identifiers sort below alphanumeric ones.
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0)
  // A shorter identifier list sorts first.
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0)
})

test('isNewerVersion is strictly greater-than', () => {
  assert.equal(isNewerVersion('0.8.0', '0.7.1'), true)
  assert.equal(isNewerVersion('0.7.1', '0.7.1'), false)
  assert.equal(isNewerVersion('0.7.0', '0.7.1'), false)
  assert.equal(isNewerVersion('1.0.0-rc.1', '1.0.0'), false)
})

test('parseLatestVersion accepts the registry manifest and rejects junk', () => {
  assert.equal(parseLatestVersion({ name: '@mars-sea/dsh-commandcode-provider', version: '0.8.0' }), '0.8.0')
  assert.throws(() => parseLatestVersion(null))
  assert.throws(() => parseLatestVersion('0.8.0'))
  assert.throws(() => parseLatestVersion({}))
  assert.throws(() => parseLatestVersion({ version: 42 }))
  assert.throws(() => parseLatestVersion({ version: 'not-semver' }))
})

/** An in-memory stand-in for localStorage. */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: () => null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as unknown as Storage
}

/** A storage whose every method throws, for the degrade-silently paths. */
function makeBrokenStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  } as unknown as Storage
}

interface FetchStub extends Function {
  (...args: Parameters<typeof fetch>): Promise<Response>
  calls: number
  urls: string[]
}

/** A scripted fetch stub counting invocations and recording URLs. */
function makeFetch(impl: () => Promise<Response>): FetchStub {
  const stub = ((_input: RequestInfo | URL) => {
    stub.calls += 1
    const url = String(_input)
    stub.urls.push(url)
    return impl()
  }) as FetchStub
  stub.calls = 0
  stub.urls = []
  return stub
}

function okResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response
}

test('localStorageUpdateStore round-trips records and tolerates damage', () => {
  const storage = makeMemoryStorage()
  const store = localStorageUpdateStore(storage)
  assert.equal(store.read(), undefined)

  store.write({ at: 1000, version: '0.8.0' })
  assert.deepEqual(store.read(), { at: 1000, version: '0.8.0' })

  // Corrupted payloads read as absent, never throw.
  storage.setItem(UPDATE_CHECK_CACHE_KEY, '{broken json')
  assert.equal(store.read(), undefined)
  storage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify({ at: 'nope' }))
  assert.equal(store.read(), undefined)

  // Broken storage degrades both ways.
  const broken = localStorageUpdateStore(makeBrokenStorage())
  assert.equal(broken.read(), undefined)
  assert.doesNotThrow(() => broken.write({ at: 1 }))

  // Missing storage entirely (SSR-ish contexts) is fine too.
  const absent = localStorageUpdateStore(undefined)
  assert.equal(absent.read(), undefined)
  assert.doesNotThrow(() => absent.write({ at: 1 }))
})

test('checkForUpdate fetches once on a cold store and reports only newer versions', async () => {
  const store = localStorageUpdateStore(makeMemoryStorage())
  const fetchImpl = makeFetch(async () => okResponse({ version: '0.8.0' }))
  const now = 1_000_000_000_000

  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now, store, fetchImpl }), '0.8.0')
  assert.equal(fetchImpl.calls, 1)
  assert.deepEqual(fetchImpl.urls, [NPM_LATEST_URL])
  assert.deepEqual(store.read(), { at: now, version: '0.8.0' })

  // Same version published upstream: checked, but no hint.
  assert.equal(
    await checkForUpdate({
      currentVersion: '0.8.0',
      now,
      store,
      fetchImpl: makeFetch(async () => okResponse({ version: '0.8.0' })),
    }),
    undefined,
  )
})

test('checkForUpdate serves a fresh cache without touching the network', async () => {
  const store = localStorageUpdateStore(makeMemoryStorage())
  const now = 1_000_000_000_000
  store.write({ at: now - UPDATE_CHECK_INTERVAL_MS + 60_000, version: '0.9.0' })
  const fetchImpl = makeFetch(async () => okResponse({ version: '0.9.0' }))

  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now, store, fetchImpl }), '0.9.0')
  assert.equal(fetchImpl.calls, 0)

  // A cached version that is NOT newer stays silent too.
  store.write({ at: now, version: '0.1.0' })
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now, store, fetchImpl }), undefined)
  assert.equal(fetchImpl.calls, 0)
})

test('checkForUpdate refetches past the throttle window', async () => {
  const store = localStorageUpdateStore(makeMemoryStorage())
  const now = 1_000_000_000_000
  store.write({ at: now - UPDATE_CHECK_INTERVAL_MS - 1, version: '0.7.0' })
  const fetchImpl = makeFetch(async () => okResponse({ version: '0.8.2' }))

  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now, store, fetchImpl }), '0.8.2')
  assert.equal(fetchImpl.calls, 1)
  assert.deepEqual(store.read(), { at: now, version: '0.8.2' })
})

test('checkForUpdate survives failures and keeps a previously learned version', async () => {
  const store = localStorageUpdateStore(makeMemoryStorage())
  const now = 1_000_000_000_000

  // Cold + failing: no hint, but the attempt time is recorded so the next
  // page open inside the window does not retry the network.
  const failing = makeFetch(async () => {
    throw new Error('offline')
  })
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now, store, fetchImpl: failing }), undefined)
  assert.equal(failing.calls, 1)
  assert.deepEqual(store.read(), { at: now, version: undefined })

  const later = now + 60_000
  const withinWindow = makeFetch(async () => okResponse({ version: '0.9.0' }))
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now: later, store, fetchImpl: withinWindow }), undefined)
  assert.equal(withinWindow.calls, 0)

  // Non-OK statuses count as failures too (stale cache forces the network).
  store.write({ at: now - UPDATE_CHECK_INTERVAL_MS - 1 })
  const httpError = makeFetch(async () => ({ ok: false, status: 503 }) as unknown as Response)
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now: later, store, fetchImpl: httpError }), undefined)

  // A failure AFTER a good check keeps serving the learned version.
  store.write({ at: now - UPDATE_CHECK_INTERVAL_MS - 1, version: '0.8.5' })
  const refetched = makeFetch(async () => {
    throw new Error('offline again')
  })
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now: later, store, fetchImpl: refetched }), '0.8.5')
  assert.deepEqual(store.read(), { at: later, version: '0.8.5' })

  // Malformed payloads are failures, never bogus hints.
  store.write({ at: now - UPDATE_CHECK_INTERVAL_MS - 1 })
  const malformed = makeFetch(async () => okResponse({ unexpected: true }))
  assert.equal(await checkForUpdate({ currentVersion: '0.7.1', now: later, store, fetchImpl: malformed }), undefined)
})

test('fetchLatestVersion parses the manifest over the wire shape', async () => {
  const fetchImpl = makeFetch(async () =>
    okResponse({ name: '@mars-sea/dsh-commandcode-provider', version: '1.2.3' }))
  assert.equal(await fetchLatestVersion(fetchImpl), '1.2.3')
  await assert.rejects(fetchLatestVersion(makeFetch(async () => ({ ok: false, status: 404 }) as unknown as Response)))
})
