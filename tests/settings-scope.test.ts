/**
 * Settings-scope lifecycle over the `remote.settings` wire.
 *
 * The wire is byte-identical from 0.1.2-rc.1 through 0.1.7-alpha.1
 * (`describe()` → the directory view; `mutate(ns, ops, revision)` → the fresh
 * namespace ROW), so these tests pin the whole contract the settings page
 * and the Models-page card depend on — through a fake remote, no network,
 * no React.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSettingsScope,
  SETTINGS_DESCRIBE_RETRY_MS,
  type SettingsPathOp,
  type SettingsRemoteNamespace,
  type SettingsRetryTimer,
  type SettingsScopeContext,
} from '../src/client/settings-scope.ts'
import type { SettingsScopeSnapshot } from '../src/client/settings.ts'

/**
 * Drain every pending microtask and nested zero-delay timer. One 5ms macrotask
 * outlasts the whole chain (the fake remote's own answer delay is two nested
 * `setTimeout(0)` hops, i.e. ≤2ms), so a settled state machine is guaranteed
 * to be observable when this resolves.
 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 5) })
}

type Row = Record<string, unknown>
type View = { writable: boolean; hasDocument?: boolean; namespaces: Row[] }

interface FakeRemote {
  context: SettingsScopeContext
  /**
   * The inject-captured namespace seam the entry hands the scope. It answers
   * `undefined` until {@link FakeRemote.mountSettings} runs — exactly the
   * handshake `ctx.inject(['remote.settings'], …)` performs on a real engine.
   */
  resolveRemote: () => SettingsRemoteNamespace | undefined
  /** The namespace object itself, for tests that patch one method. */
  settingsNamespace: SettingsRemoteNamespace
  /** Simulate the `remote.settings` service becoming available (inject fires). */
  mountSettings(): void
  describeCalls: () => number
  mutateCalls: () => Array<{ ns: string; ops: readonly SettingsPathOp[]; revision: number | undefined }>
  /** Queue the next `describe()` answers; the last one sticks. */
  answerDescribe(view: View | { error: string }): void
  /** Queue the next `mutate()` answers; the last one sticks. */
  answerMutate(row: Row | { error: string }): void
  fireDocumentUpdated(): void
  fireConnectionReset(): void
}

function fakeContext(options?: { loopback?: boolean; mountSettings?: boolean }): FakeRemote {
  const loopback = options?.loopback ?? true
  let mounted = options?.mountSettings ?? true
  let viewAnswer: View | { error: string } = {
    writable: true,
    namespaces: [],
  }
  let mutateAnswer: Row | { error: string } | undefined
  const describes: number[] = []
  const mutates: Array<{ ns: string; ops: readonly SettingsPathOp[]; revision: number | undefined }> = []
  const listeners = new Map<string, () => void>()
  const settingsNamespace: SettingsRemoteNamespace = {
    async describe() {
      describes.push(1)
      await Promise.resolve()
      return 'error' in viewAnswer && typeof viewAnswer.error === 'string'
        ? { ok: false, error: { message: viewAnswer.error } }
        : { ok: true, value: viewAnswer as View }
    },
    async mutate(ns: string, ops: readonly SettingsPathOp[], revision?: number) {
      mutates.push({ ns, ops, revision })
      await Promise.resolve()
      const answer: Row | { error: string } = mutateAnswer ?? { ns, revision: 7 }
      return 'error' in answer && typeof answer.error === 'string'
        ? { ok: false, error: { message: answer.error } }
        : { ok: true, value: answer as Row }
    },
  }
  // The real `remote` service: `settings` is a Cordis service nested under it,
  // so reading the property without `inject(['remote.settings'])` THROWS. This
  // getter is the regression guard — the scope must reach its
  // namespace through the inject-captured seam, never through `ctx.remote`.
  const remote = {
    $host: { isLoopback: loopback },
    $on(event: string, listener: () => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get settings(): never {
      throw new Error('cannot get property "remote.settings" without inject')
    },
  }
  const context: SettingsScopeContext = {
    remote,
    on(event, listener) {
      listeners.set(event, () => { listener() })
      return () => { listeners.delete(event) }
    },
  }
  return {
    context,
    settingsNamespace,
    resolveRemote: () => (mounted ? settingsNamespace : undefined),
    mountSettings: () => { mounted = true },
    describeCalls: () => describes.length,
    mutateCalls: () => mutates,
    answerDescribe: (next) => { viewAnswer = next },
    answerMutate: (next) => { mutateAnswer = next },
    fireDocumentUpdated: () => listeners.get('settings/document-updated')?.(),
    fireConnectionReset: () => listeners.get('connection/reset')?.(),
  }
}

const row = (overrides?: Row): Row => ({
  ns: 'llm-commandcode',
  value: { apiBase: 'https://example.com' },
  base: { apiBase: undefined },
  user: {},
  revision: 3,
  schema: {},
  autoGenerate: false,
  applies: 'live',
  secrets: [],
  ...overrides,
})

test('a loopback scope derives ready state from the directory row', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  assert.equal(scope.getSnapshot().status, 'loading')
  await flush()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.writable, true)
  assert.equal(snapshot.mode, 'host')
  assert.equal(snapshot.revision, 3)
  assert.deepEqual(snapshot.value, { apiBase: 'https://example.com' })
  assert.deepEqual(snapshot.user, {})
  assert.equal(fake.describeCalls(), 1)
  await scope.dispose()
})

test('a namespace missing from the directory reads unavailable', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row({ ns: 'someone-else' })] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.writable, true)
  await scope.dispose()
})

test('a failed first read holds at loading and recovers on the next invalidation', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ error: 'gateway down' })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  assert.equal(scope.getSnapshot().status, 'loading')
  // The forwarded invalidation is one retry trigger (the inject-arrival
  // refresh in the plugin entry funnels through the same load()); the bounded
  // timer ladder below covers the case where no invalidation ever arrives.
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  fake.fireDocumentUpdated()
  await flush()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(fake.describeCalls(), 2)
  await scope.dispose()
})

test('a transient failure after a successful read keeps the held view', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  fake.answerDescribe({ error: 'blip' })
  fake.fireConnectionReset()
  await flush()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'ready', 'a failed re-read must never blank the page')
  assert.deepEqual(snapshot.value, { apiBase: 'https://example.com' })
  await scope.dispose()
})

test('set() fences with the row revision, then folds the answered row in', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  fake.answerMutate(row({ user: { apiBase: 'https://new.example' }, revision: 4 }))
  await scope.set('apiBase', 'https://new.example')
  const [call] = fake.mutateCalls()
  assert.ok(call, 'set() issued exactly one write')
  assert.equal(call.ns, 'llm-commandcode')
  assert.deepEqual(call.ops, [{ op: 'set', path: ['apiBase'], value: 'https://new.example' }])
  assert.equal(call.revision, 3, 'the first write carries the revision it was read at')
  // The controller's save contract: after set() resolves, the snapshot's user
  // layer must already show the value (read-your-write without a wire re-read).
  const snapshot = scope.getSnapshot()
  assert.deepEqual(snapshot.user, { apiBase: 'https://new.example' })
  assert.equal(snapshot.revision, 4, 'the answered row replaces the held one')
  await scope.dispose()
})

test('unset() sends the unset op form', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row({ user: { workingDir: '/tmp' } })] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  fake.answerMutate(row({ user: {}, revision: 5 }))
  await scope.unset('workingDir')
  const [call] = fake.mutateCalls()
  assert.ok(call, 'unset() issued exactly one write')
  assert.deepEqual(call.ops, [{ op: 'unset', path: ['workingDir'] }])
  assert.deepEqual(scope.getSnapshot().user, {})
  await scope.dispose()
})

test('a rejected write re-reads the Host instead of folding the stale answer', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const describesBefore = fake.describeCalls()
  fake.answerMutate({ error: 'SETTINGS_CONFLICT: revision 3 expected, 9 actual' })
  await scope.set('apiBase', 'https://raced.example')
  assert.equal(fake.describeCalls(), describesBefore + 1, 'recovery is a describe re-read')
  // The held view still holds the pre-write user layer — the controller reads
  // that as "the write did not land" and keeps the drafts staged.
  assert.deepEqual(scope.getSnapshot().user, {})
  await scope.dispose()
})

test('writes serialize: one mutate in flight, the next queued behind it', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = fake.settingsNamespace.mutate
  fake.settingsNamespace.mutate = (ns, ops, revision) => {
    const pending = original(ns, ops, revision) // registers the call synchronously
    return gate.then(() => pending) // ...but holds its settlement until released
  }
  const first = scope.set('apiBase', 'https://one.example')
  const second = scope.set('apiBase', 'https://two.example')
  await flush()
  assert.equal(fake.mutateCalls().length, 1, 'the second write waits for the first')
  release?.()
  await Promise.all([first, second])
  assert.equal(fake.mutateCalls().length, 2)
  const revisions = fake.mutateCalls().map((call) => call.revision)
  assert.deepEqual(
    revisions,
    [3, 7],
    'the first write fences from the held revision; the queued second takes the superseded answer\'s revision',
  )
  await scope.dispose()
})

test('an unmounted namespace keeps the page read-only until the inject lands', async () => {
  // The reported failure: the scope read `ctx.remote.settings` directly, cordis
  // threw `cannot get property "remote.settings" without inject`, the throw was
  // swallowed by the read's own try/catch, and the page rendered read-only with
  // every control disabled. The entry now captures the namespace inside
  // `ctx.inject(['remote.settings'], …)` and re-reads when it lands.
  const fake = fakeContext({ mountSettings: false })
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const before = scope.getSnapshot()
  assert.equal(before.status, 'loading', 'nothing was read yet')
  assert.equal(before.writable, false, 'the initial snapshot is not writable — the page renders read-only')
  assert.equal(fake.describeCalls(), 0, 'an unresolved namespace issues no wire call')

  // The inject fires: the entry captures the namespace and refreshes.
  fake.mountSettings()
  scope.refresh()
  await flush()
  const after = scope.getSnapshot()
  assert.equal(after.status, 'ready')
  assert.equal(after.writable, true, 'the served view is writable, so the page is interactive')
  assert.deepEqual(after.value, { apiBase: 'https://example.com' })
  assert.equal(fake.describeCalls(), 1)
  await scope.dispose()
})

test('the namespace is never read off ctx.remote (the fake context throws)', async () => {
  const fake = fakeContext()
  // The engine's own answer to a nested-service read without inject; every
  // test in this file builds its context with this getter, so reading the
  // namespace off the context anywhere in the module fails the whole suite.
  assert.throws(
    () => (fake.context.remote as unknown as Record<string, unknown>).settings,
    /cannot get property "remote\.settings" without inject/,
  )
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  assert.equal(scope.getSnapshot().status, 'ready')
  await scope.dispose()
})

test('an unmounted namespace rejects writes instead of throwing', async () => {
  const fake = fakeContext({ mountSettings: false })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  await scope.set('apiBase', 'https://nowhere.example')
  assert.equal(fake.mutateCalls().length, 0, 'no write crosses the wire')
  await scope.dispose()
})

test('a remote (non-loopback) page stays process-local: no reads, no writes', async () => {
  const fake = fakeContext({ loopback: false })
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.mode, 'memory')
  assert.equal(fake.describeCalls(), 0, 'memory persistence never reads the Host')
  await scope.set('apiBase', 'https://nowhere.example')
  assert.equal(fake.mutateCalls().length, 0, 'memory persistence never writes the Host')
  await scope.dispose()
})

test('dispose stops deriving: later invalidations and writes are inert', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  await scope.dispose()
  const describes = fake.describeCalls()
  fake.fireDocumentUpdated()
  fake.fireConnectionReset()
  await flush()
  assert.equal(fake.describeCalls(), describes, 'subscriptions were dropped with the scope')
  await scope.set('apiBase', 'https://late.example')
  assert.equal(fake.mutateCalls().length, 0)
})

test('subscription listeners notify consumers on snapshot changes', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: false, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  const seen: Array<SettingsScopeSnapshot<Record<string, unknown>>['status']> = []
  const off = scope.subscribe(() => { seen.push(scope.getSnapshot().status) })
  await flush()
  off()
  const afterUnsubscribe = seen.length
  fake.fireDocumentUpdated()
  await flush()
  assert.deepEqual(seen, ['ready'], 'one transition: loading → ready, then silence')
  assert.equal(seen.length, afterUnsubscribe)
  await scope.dispose()
})

// ---------------------------------------------------------------------------
// Bounded retry of a failed FIRST read
// ---------------------------------------------------------------------------

/** A timer seam a test can fire by hand, with the delays it was asked for. */
function fakeRetryTimer(): SettingsRetryTimer & { delays: number[]; fire(): void; pending(): boolean } {
  let callback: (() => void) | undefined
  const delays: number[] = []
  return {
    delays,
    set(next, ms) {
      callback = next
      delays.push(ms)
      return next
    },
    clear(handle) {
      if (callback === handle) callback = undefined
    },
    pending: () => callback !== undefined,
    fire() {
      const run = callback
      callback = undefined
      run?.()
    },
  }
}

test('a failed first read retries on the injected timer and converges', async () => {
  // Without this retry the scope keeps its initial `loading`/`writable: false`
  // snapshot forever: every control on the settings page renders disabled
  // behind a "read-only" banner, and nothing else re-reads (the forwarded
  // invalidations need a live Host to fire). The failure here is a Host that
  // was still starting up.
  const fake = fakeContext()
  fake.answerDescribe({ error: 'gateway still starting' })
  const timer = fakeRetryTimer()
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote, timer)
  await flush()
  assert.equal(scope.getSnapshot().status, 'loading')
  assert.deepEqual(timer.delays, [SETTINGS_DESCRIBE_RETRY_MS[0]], 'the first retry rides the shortest delay')

  fake.answerDescribe({ writable: true, namespaces: [row()] })
  timer.fire()
  await flush()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(scope.getSnapshot().writable, true)
  assert.equal(fake.describeCalls(), 2)
  assert.equal(timer.pending(), false, 'a successful read ends the ladder')
  await scope.dispose()
})

test('the describe retry is bounded and stops after the ladder is spent', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ error: 'still down' })
  const timer = fakeRetryTimer()
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote, timer)
  await flush()
  for (let spent = 0; spent < SETTINGS_DESCRIBE_RETRY_MS.length; spent += 1) {
    assert.equal(timer.pending(), true, `retry ${spent + 1} should be scheduled`)
    timer.fire()
    await flush()
  }
  assert.deepEqual(timer.delays, [...SETTINGS_DESCRIBE_RETRY_MS])
  assert.equal(timer.pending(), false, 'the ladder is spent, so no further retry is scheduled')
  assert.equal(scope.getSnapshot().status, 'loading')
  // The forwarded invalidation is still the manual way out.
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  fake.fireDocumentUpdated()
  await flush()
  assert.equal(scope.getSnapshot().status, 'ready')
  await scope.dispose()
})

test('a failed re-read with a held view does not schedule a retry', async () => {
  // The page is already showing the last good document; retrying would only
  // spend wire reads on a mirror that has something honest to render.
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const timer = fakeRetryTimer()
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote, timer)
  await flush()
  fake.answerDescribe({ error: 'blip' })
  fake.fireConnectionReset()
  await flush()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(timer.pending(), false)
  await scope.dispose()
})

test('dispose cancels a pending describe retry', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ error: 'down' })
  const timer = fakeRetryTimer()
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote, timer)
  await flush()
  assert.equal(timer.pending(), true)
  await scope.dispose()
  assert.equal(timer.pending(), false, 'the ladder is dropped with the scope')
  const describes = fake.describeCalls()
  timer.fire()
  await flush()
  assert.equal(fake.describeCalls(), describes, 'a disposed scope never re-reads')
})
