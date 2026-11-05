/**
 * Service-status tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the browser-half contract of the status row: which facts are read
 * out of the Upptime files, the source order (raw host, then jsDelivr), the
 * cache TTL, and the rule that NO failure ever throws — a broken check degrades
 * to a stale snapshot or an explicit "unknown". The view cases pin the copy
 * keys and the age buckets, so a wording or threshold change fails here rather
 * than only in the browser.
 *
 * The React tree is not rendered: `./service-status.ts` is deliberately
 * React-free, like the other controller modules in this directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { zh, type SettingsCommandCodeKey } from '../src/client/locales.ts'
import {
  SERVICE_PROBE_ATTEMPTS,
  SERVICE_PROBE_RETRY_DELAY_MS,
  SERVICE_STATUS_CACHE_KEY,
  SERVICE_STATUS_LAG_WARN_MS,
  SERVICE_STATUS_STALE_MS,
  SERVICE_STATUS_TTL_MS,
  STATUS_PAGE_URL,
  compactUptime,
  checkServiceStatus,
  localStorageServiceStatusStore,
  parseStateFile,
  parseSummary,
  runServiceProbeWithRetry,
  serviceStatusView,
} from '../src/client/service-status.ts'
import type { ServiceProbe, ServiceStatusSnapshot, ServiceStatusStore } from '../src/client/service-status.ts'

/** The real Chinese dictionary, with `{name}` params substituted. */
const t = (key: SettingsCommandCodeKey, params: Record<string, unknown> = {}): string =>
  zh[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))

const NOW = Date.parse('2026-10-21T10:00:00.000Z')
const CHECKED = Date.parse('2026-10-21T09:00:00.000Z')
const RAW = 'https://raw.test/history'
const CDN = 'https://cdn.test/history'
const SOURCES = [RAW, CDN]

const SUMMARY_BODY = JSON.stringify([
  {
    name: 'Command Code',
    url: 'https://api.commandcode.ai',
    slug: 'command-code',
    status: 'up',
    uptimeWeek: '100.00%',
    uptimeMonth: '99.98%',
    timeWeek: 114,
  },
])

const STATE_BODY = [
  'url: https://api.commandcode.ai',
  'status: up',
  'code: 200',
  'responseTime: 159',
  `lastUpdated: ${new Date(CHECKED).toISOString()}`,
  '',
].join('\n')

interface FetchStub extends Function {
  (...args: Parameters<typeof fetch>): Promise<Response>
  calls: number
  urls: string[]
}

function textResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response
}

function notFoundResponse(): Response {
  return { ok: false, status: 404, text: async () => '' } as unknown as Response
}

/** A scripted fetch: `impl` answers by URL, undefined becomes a 404. */
function makeFetch(impl: (url: string) => Response | undefined): FetchStub {
  const stub = ((input: RequestInfo | URL) => {
    stub.calls += 1
    const url = String(input)
    stub.urls.push(url)
    return Promise.resolve(impl(url) ?? notFoundResponse())
  }) as FetchStub
  stub.calls = 0
  stub.urls = []
  return stub
}

/** An in-memory stand-in for localStorage. */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
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

interface MemoryStore extends ServiceStatusStore {
  current: ServiceStatusSnapshot | undefined
}

function memoryStore(initial?: ServiceStatusSnapshot): MemoryStore {
  const store: MemoryStore = {
    current: initial,
    read: () => store.current,
    write: (next) => {
      store.current = next
    },
  }
  return store
}

function upSnapshot(overrides: Partial<ServiceStatusSnapshot> = {}): ServiceStatusSnapshot {
  return {
    level: 'up',
    checkedAt: NOW - 5 * 60_000,
    uptimeWeek: '100.00%',
    uptimeMonth: '99.98%',
    responseTimeWeekMs: 114,
    live: true,
    stale: false,
    fetchedAt: NOW,
    ...overrides,
  }
}

test('parseSummary picks the monitored site and maps its verdict', () => {
  const facts = parseSummary([
    { url: 'https://other.example', status: 'down', uptimeWeek: '1.00%' },
    { url: 'https://api.commandcode.ai', status: 'degraded', uptimeWeek: '99.50%', uptimeMonth: '99.90%', timeWeek: 210 },
  ])
  assert.equal(facts.level, 'degraded')
  assert.equal(facts.uptimeWeek, '99.50%')
  assert.equal(facts.uptimeMonth, '99.90%')
  assert.equal(facts.responseTimeWeekMs, 210)
})

test('parseSummary falls back to the slug, then the first record', () => {
  assert.equal(parseSummary([{ slug: 'command-code', status: 'down' }]).level, 'down')
  assert.equal(parseSummary([{ name: 'Renamed', status: 'up' }]).level, 'up')
})

test('parseSummary rejects payloads that cannot answer', () => {
  assert.throws(() => parseSummary({}))
  assert.throws(() => parseSummary([]))
  assert.throws(() => parseSummary([{ url: 'https://api.commandcode.ai', status: 'weird' }]))
})

test('parseStateFile reads the monitor scalar fields and ignores junk', () => {
  const state = parseStateFile(STATE_BODY)
  assert.equal(state.level, 'up')
  assert.equal(state.code, 200)
  assert.equal(state.responseTimeMs, 159)
  assert.equal(state.checkedAt, CHECKED)

  const sparse = parseStateFile('not yaml at all\nstatus: down\n')
  assert.equal(sparse.level, 'down')
  assert.equal(sparse.checkedAt, undefined)
  assert.equal(sparse.code, undefined)
})

test('checkServiceStatus returns a fresh cache without touching the network', async () => {
  const cached = upSnapshot({ fetchedAt: NOW - SERVICE_STATUS_TTL_MS + 1 })
  const store = memoryStore(cached)
  const fetchImpl = makeFetch(() => {
    throw new Error('must not fetch')
  })
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot, cached)
  assert.equal(fetchImpl.calls, 0)
})

test('checkServiceStatus reads both files from the first source and caches the result', async () => {
  const store = memoryStore()
  const fetchImpl = makeFetch((url) => {
    if (url === `${RAW}/summary.json`) return textResponse(SUMMARY_BODY)
    if (url === `${RAW}/command-code.yml`) return textResponse(STATE_BODY)
    return undefined
  })
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot.live, true)
  assert.equal(snapshot.stale, false)
  assert.equal(snapshot.level, 'up')
  assert.equal(snapshot.checkedAt, CHECKED)
  assert.equal(snapshot.uptimeWeek, '100.00%')
  assert.equal(snapshot.uptimeMonth, '99.98%')
  assert.equal(snapshot.responseTimeWeekMs, 114)
  assert.equal(snapshot.fetchedAt, NOW)
  assert.equal(fetchImpl.calls, 2)
  assert.equal(store.current?.fetchedAt, NOW)
})

test('checkServiceStatus falls back to the next mirror when the first fails', async () => {
  const store = memoryStore()
  const fetchImpl = makeFetch((url) => {
    if (url === `${CDN}/summary.json`) return textResponse(SUMMARY_BODY)
    if (url === `${CDN}/command-code.yml`) return textResponse(STATE_BODY)
    return undefined
  })
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot.live, true)
  assert.deepEqual(fetchImpl.urls, [
    `${RAW}/summary.json`,
    `${RAW}/command-code.yml`,
    `${CDN}/summary.json`,
    `${CDN}/command-code.yml`,
  ])
})

test('checkServiceStatus serves a stale cache when every source fails', async () => {
  const cached = upSnapshot({ fetchedAt: NOW - SERVICE_STATUS_TTL_MS - 1 })
  const store = memoryStore(cached)
  const fetchImpl = makeFetch(() => undefined)
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot.live, false)
  assert.equal(snapshot.stale, true)
  assert.equal(snapshot.level, 'up')
  assert.equal(snapshot.fetchedAt, cached.fetchedAt)
})

test('checkServiceStatus degrades to unknown with no cache and no source', async () => {
  const store = memoryStore()
  const fetchImpl = makeFetch(() => undefined)
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot.level, 'unknown')
  assert.equal(snapshot.live, false)
  assert.equal(snapshot.stale, false)
  assert.equal(store.current, undefined)
})

test('a missing state file still yields a live snapshot, without a check time', async () => {
  const store = memoryStore()
  const fetchImpl = makeFetch((url) => {
    if (url === `${RAW}/summary.json`) return textResponse(SUMMARY_BODY)
    return undefined
  })
  const snapshot = await checkServiceStatus({ store, now: NOW, fetchImpl, sources: SOURCES })
  assert.equal(snapshot.live, true)
  assert.equal(snapshot.checkedAt, undefined)
  assert.equal(snapshot.responseTimeWeekMs, 114)
})

/** The live probe, already landed: a 200 in 129 ms. */
const PROBE_OK: ServiceProbe = {
  kind: 'result',
  result: { outcome: 'ok', status: 200, latencyMs: 129, checkedAt: NOW },
}

test('serviceStatusView renders the checking state before the first check lands', () => {
  const view = serviceStatusView(undefined, { kind: 'checking' }, t, NOW)
  assert.equal(view.checking, true)
  assert.equal(view.label, zh.serviceStatusChecking)
  assert.equal(view.officialTone, 'checking')
  assert.deepEqual(view.badge, { label: zh.serviceStatusChecking, tone: 'checking' })
  assert.deepEqual(view.detailParts, [])
  assert.equal(view.local, zh.serviceStatusLocalChecking)
  assert.equal(view.localTone, 'muted')
  assert.equal(view.localChecking, true)
  assert.equal(view.linkLabel, zh.serviceStatusOpen)
})

test('serviceStatusView names the verdict, the aggregates and the published age', () => {
  const view = serviceStatusView(upSnapshot(), PROBE_OK, t, NOW)
  assert.equal(view.checking, false)
  assert.equal(view.label, zh.serviceStatusUp)
  assert.equal(view.officialTone, 'ok')
  assert.deepEqual(view.badge, { label: zh.serviceStatusUp, tone: 'ok' })
  // Padding zeros dropped (100.00% → 100%), both windows under one "uptime",
  // each aggregate its own segment so the page never breaks inside one.
  assert.deepEqual(view.detailParts, ['可用率 7 天 100% / 30 天 99.98%', '平均响应 114 ms'])
  assert.equal(view.updated, t('serviceStatusUpdatedMinutes', { count: 5 }))
  assert.equal(view.lag, undefined)
  assert.equal(view.notice, undefined)
  assert.equal(view.local, t('serviceStatusLocalOk', { latency: 129 }))
  assert.equal(view.localTone, 'ok')
})

test('serviceStatusView marks a stale snapshot with the last-known notice', () => {
  const stale = serviceStatusView(upSnapshot({ live: false, stale: true }), PROBE_OK, t, NOW)
  assert.equal(stale.label, zh.serviceStatusUp)
  assert.equal(stale.notice, zh.serviceStatusStale)

  const unavailable = serviceStatusView({ level: 'unknown', live: false, stale: false, fetchedAt: NOW }, PROBE_OK, t, NOW)
  assert.equal(unavailable.label, zh.serviceStatusUnknown)
  assert.equal(unavailable.notice, zh.serviceStatusUnavailable)
})

test('serviceStatusView buckets the published age and tolerates a missing timestamp', () => {
  assert.equal(serviceStatusView(upSnapshot({ checkedAt: NOW - 30_000 }), PROBE_OK, t, NOW).updated, zh.serviceStatusUpdatedJustNow)
  assert.equal(
    serviceStatusView(upSnapshot({ checkedAt: NOW - 3 * 60 * 60_000 }), PROBE_OK, t, NOW).updated,
    t('serviceStatusUpdatedHours', { count: 3 }),
  )
  // Under a day the age still renders; at a day the staleness branch takes over
  // (pinned separately), so this bucket stops at 23 hours.
  assert.equal(
    serviceStatusView(upSnapshot({ checkedAt: NOW - 23 * 60 * 60_000 }), PROBE_OK, t, NOW).updated,
    t('serviceStatusUpdatedHours', { count: 23 }),
  )
  assert.equal(serviceStatusView(upSnapshot({ checkedAt: undefined }), PROBE_OK, t, NOW).updated, zh.serviceStatusUpdatedUnknown)
})

test('serviceStatusView explains the publication lag only once the record is old', () => {
  assert.equal(serviceStatusView(upSnapshot({ checkedAt: NOW - 5 * 60_000 }), PROBE_OK, t, NOW).lag, undefined)
  assert.equal(serviceStatusView(upSnapshot({ checkedAt: NOW - SERVICE_STATUS_LAG_WARN_MS }), PROBE_OK, t, NOW).lag, zh.serviceStatusLag)
})

test('serviceStatusView renders every local probe outcome', () => {
  const at = (probe: ServiceProbe) => serviceStatusView(upSnapshot(), probe, t, NOW)

  const httpError = at({ kind: 'result', result: { outcome: 'http-error', status: 503, latencyMs: 12, checkedAt: NOW } })
  assert.equal(httpError.local, t('serviceStatusLocalHttp', { status: 503 }))
  assert.equal(httpError.localTone, 'warn')

  const timeout = at({ kind: 'result', result: { outcome: 'timeout', status: 0, latencyMs: 0, checkedAt: NOW } })
  assert.equal(timeout.local, zh.serviceStatusLocalTimeout)
  assert.equal(timeout.localTone, 'warn')

  const unreachable = at({ kind: 'result', result: { outcome: 'unreachable', status: 0, latencyMs: 0, checkedAt: NOW } })
  assert.equal(unreachable.local, zh.serviceStatusLocalUnreachable)
  assert.equal(unreachable.localTone, 'warn')

  const unavailable = at({ kind: 'unavailable' })
  assert.equal(unavailable.local, zh.serviceStatusLocalUnavailable)
  assert.equal(unavailable.localTone, 'muted')
  assert.equal(unavailable.localChecking, false)
})

test('localStorageServiceStatusStore round-trips and tolerates damaged storage', () => {
  const storage = makeMemoryStorage()
  const store = localStorageServiceStatusStore(storage)
  assert.equal(store.read(), undefined)

  const snapshot = upSnapshot()
  store.write(snapshot)
  assert.deepEqual(store.read(), snapshot)
  assert.notEqual(storage.getItem(SERVICE_STATUS_CACHE_KEY), null)

  storage.setItem(SERVICE_STATUS_CACHE_KEY, '{not json')
  assert.equal(store.read(), undefined)

  const broken = localStorageServiceStatusStore(makeBrokenStorage())
  assert.equal(broken.read(), undefined)
  broken.write(snapshot)
})

test('the status page link is the public page', () => {
  assert.equal(STATUS_PAGE_URL, 'https://status.commandcode.ai/')
})

test('compactUptime drops padding zeros and leaves anything else as published', () => {
  assert.equal(compactUptime('100.00%'), '100%')
  assert.equal(compactUptime('99.90%'), '99.9%')
  assert.equal(compactUptime('99.95%'), '99.95%')
  assert.equal(compactUptime('100%'), '100%')
  assert.equal(compactUptime('n/a'), 'n/a')
})

test('serviceStatusView: a failed local probe never replaces the published verdict on the heading', () => {
  const at = (probe: ServiceProbe) => serviceStatusView(upSnapshot(), probe, t, NOW)
  // A probe that did not get through says so on its own line (with a retry),
  // but the heading keeps reporting the published verdict: "this Host could not
  // reach the API just now" is not a service verdict.
  const unreachable = at({ kind: 'result', result: { outcome: 'unreachable', status: 0, latencyMs: 0, checkedAt: NOW } })
  assert.equal(unreachable.label, zh.serviceStatusUp)
  assert.equal(unreachable.officialTone, 'ok')
  assert.deepEqual(unreachable.badge, { label: zh.serviceStatusUp, tone: 'ok' })
  for (const probe of [
    { kind: 'result', result: { outcome: 'timeout', status: 0, latencyMs: 0, checkedAt: NOW } },
    { kind: 'result', result: { outcome: 'http-error', status: 503, latencyMs: 12, checkedAt: NOW } },
    { kind: 'checking' },
    { kind: 'unavailable' },
  ] as ServiceProbe[]) {
    assert.deepEqual(at(probe).badge, { label: zh.serviceStatusUp, tone: 'ok' })
  }
})

test('serviceStatusView reports a published record older than a day as stale', () => {
  const checked = NOW - 3 * 24 * 60 * 60_000
  const view = serviceStatusView(upSnapshot({ checkedAt: checked }), PROBE_OK, t, NOW)
  assert.equal(view.officialStale, true)
  // The publish date replaces the verdict: no green "operational" from days ago.
  assert.equal(view.label, t('serviceStatusStaleAt', { date: '2026-10-18' }))
  assert.equal(view.officialTone, 'idle')
  // The heading badge is short; the row's label carries the date.
  assert.deepEqual(view.badge, { label: t('serviceStatusBadgeStale', { count: 3 }), tone: 'idle' })
  // The compact line keeps only the 7-day uptime …
  assert.deepEqual(view.detailParts, ['可用率 7 天 100%'])
  // … and the 30-day window plus the average response move to the date tooltip.
  assert.equal(view.hiddenDetail, '可用率 7 天 100% / 30 天 99.98% · 平均响应 114 ms')
  // No repeated age line and no lag tooltip: the label already says it.
  assert.equal(view.updated, undefined)
  assert.equal(view.lag, undefined)
})

test('serviceStatusView: the staleness boundary is one day, and stale keeps the local half intact', () => {
  const justUnder = serviceStatusView(upSnapshot({ checkedAt: NOW - SERVICE_STATUS_STALE_MS + 1 }), PROBE_OK, t, NOW)
  assert.equal(justUnder.officialStale, false)
  assert.equal(justUnder.label, zh.serviceStatusUp)
  assert.equal(justUnder.officialTone, 'ok')
  assert.equal(justUnder.detailParts[0], '可用率 7 天 100% / 30 天 99.98%')

  const exactly = serviceStatusView(upSnapshot({ checkedAt: NOW - SERVICE_STATUS_STALE_MS }), PROBE_OK, t, NOW)
  assert.equal(exactly.officialStale, true)
  assert.equal(exactly.label, t('serviceStatusStaleAt', { date: '2026-10-20' }))
  assert.equal(exactly.local, t('serviceStatusLocalOk', { latency: 129 }))
  assert.deepEqual(exactly.badge, { label: t('serviceStatusBadgeStale', { count: 1 }), tone: 'idle' })
})

test('serviceStatusView: a stale record still reports a live verdict when re-fetched, without inventing freshness', () => {
  // The snapshot's own `fetchedAt` is irrelevant: freshness is the monitor's
  // publish time, so a successful fetch of old data stays marked stale.
  const view = serviceStatusView(upSnapshot({ checkedAt: NOW - 4 * 24 * 60 * 60_000, fetchedAt: NOW }), PROBE_OK, t, NOW)
  assert.equal(view.officialStale, true)
  assert.equal(view.notice, undefined)
  assert.equal(view.updated, undefined)
})

// ---- Host probe retry ----

/** One probe answer, already shaped like the row's result. */
const PROBE_RESULT_OK = { outcome: 'ok', status: 200, latencyMs: 90, checkedAt: NOW } as const
const PROBE_RESULT_TIMEOUT = { outcome: 'timeout', status: 0, latencyMs: 0, checkedAt: NOW } as const

test('runServiceProbeWithRetry returns a first-attempt success and does not retry it', async () => {
  let calls = 0
  const probe = await runServiceProbeWithRetry(async () => {
    calls += 1
    return { ok: true, value: { ...PROBE_RESULT_OK } }
  }, { sleep: async () => {} })
  assert.deepEqual(probe, { kind: 'result', result: PROBE_RESULT_OK })
  assert.equal(calls, 1)
})

test('runServiceProbeWithRetry retries a failed probe once and returns the second answer', async () => {
  let calls = 0
  const sleeps: number[] = []
  const probe = await runServiceProbeWithRetry(async () => {
    calls += 1
    return calls === 1
      ? { ok: true, value: { ...PROBE_RESULT_TIMEOUT } }
      : { ok: true, value: { ...PROBE_RESULT_OK } }
  }, { sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(probe, { kind: 'result', result: PROBE_RESULT_OK })
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [SERVICE_PROBE_RETRY_DELAY_MS])
})

test('runServiceProbeWithRetry reports the last measured failure after both attempts', async () => {
  let calls = 0
  const probe = await runServiceProbeWithRetry(async () => {
    calls += 1
    return { ok: true, value: { ...PROBE_RESULT_TIMEOUT } }
  }, { sleep: async () => {} })
  assert.deepEqual(probe, { kind: 'result', result: PROBE_RESULT_TIMEOUT })
  assert.equal(calls, SERVICE_PROBE_ATTEMPTS)
})

test('runServiceProbeWithRetry degrades to unavailable when the Host refuses the call', async () => {
  let calls = 0
  const probe = await runServiceProbeWithRetry(async () => {
    calls += 1
    throw new Error('gateway not mounted')
  }, { sleep: async () => {} })
  assert.deepEqual(probe, { kind: 'unavailable' })
  assert.equal(calls, SERVICE_PROBE_ATTEMPTS)
})

test('runServiceProbeWithRetry keeps a measured failure when a later call is refused', async () => {
  let calls = 0
  const probe = await runServiceProbeWithRetry(async () => {
    calls += 1
    if (calls === 1) return { ok: true, value: { ...PROBE_RESULT_TIMEOUT } }
    throw new Error('gateway dropped')
  }, { sleep: async () => {} })
  assert.deepEqual(probe, { kind: 'result', result: PROBE_RESULT_TIMEOUT })
})

test('serviceStatusView maps every published level to its dot tone', () => {
  assert.equal(serviceStatusView(upSnapshot({ level: 'degraded' }), PROBE_OK, t, NOW).officialTone, 'warn')
  assert.equal(serviceStatusView(upSnapshot({ level: 'down' }), PROBE_OK, t, NOW).officialTone, 'error')
  assert.equal(serviceStatusView(upSnapshot({ level: 'unknown' }), PROBE_OK, t, NOW).officialTone, 'idle')
})
