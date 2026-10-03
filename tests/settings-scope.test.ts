/**
 * Settings-scope lifecycle over the `remote.settings` wire (node:test, no
 * network, no React): the whole contract the settings page and the Models-page
 * card depend on, driven through a fake remote.
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
import { CommandCodeSettingsController, type SettingsScopeSnapshot } from '../src/client/settings.ts'

/** Drain every pending microtask and zero-delay timer (the fake remote's own answer delay is two nested hops, ≤2ms). */
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

function fakeContext(options?: { mountSettings?: boolean }): FakeRemote {
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
      const answer: Row | { error: string } = mutateAnswer ?? { ...row({ revision: 7 }), ns }
      return 'error' in answer && typeof answer.error === 'string'
        ? { ok: false, error: { message: answer.error } }
        : { ok: true, value: answer as Row }
    },
  }
  // The real `remote` service: `settings` is a Cordis service nested under it,
  // so reading the property without `inject(['remote.settings'])` THROWS. This
  // getter is the regression guard for EVERY test in this file.
  const remote = {
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

test('a Host-backed scope derives ready state from the directory row', async () => {
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

test('多字段删除通过一次带版本的宿主变更提交，冲突后恢复真实快照', async () => {
  const fake = fakeContext()
  const before = { accounts: [{ label: 'A', apiKeyEnv: 'A_KEY' }], activeAccount: 'A_KEY' }
  fake.answerDescribe({ writable: true, namespaces: [row({ value: before })] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const ops: SettingsPathOp[] = [
    { op: 'set', path: ['accounts'], value: [] },
    { op: 'unset', path: ['activeAccount'] },
    { op: 'set', path: ['credentialCleanupRefs'], value: ['A_KEY'] },
  ]
  fake.answerMutate({ error: 'SETTINGS_CONFLICT' })
  await scope.mutate!(ops, 3)
  assert.deepEqual(fake.mutateCalls(), [{ ns: 'llm-commandcode', ops, revision: 3 }])
  assert.deepEqual(scope.getSnapshot().value, before)
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
  // A forwarded invalidation is one retry trigger (the inject-arrival refresh
  // funnels through the same load()); the ladder below covers no-invalidation.
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
  // The controller's save contract: after set() resolves, the user layer must
  // already show the value (read-your-write, no wire re-read).
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
  // The held view keeps the pre-write user layer — the controller reads that as
  // "the write did not land" and keeps the drafts staged.
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
  // The reported failure: cordis answers a read of `ctx.remote.settings` with
  // `cannot get property "remote.settings" without inject`, the scope swallowed
  // it in the read's own try/catch, and every control rendered disabled. The
  // entry now captures the namespace inside `ctx.inject(['remote.settings'], …)`.
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

test('a remote page uses Host persistence; the Host supplies write authority', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.mode, 'host')
  assert.equal(snapshot.writable, true)
  assert.equal(fake.describeCalls(), 1, 'the client asks the Host for the directory regardless of page origin')
  fake.answerMutate(row({ user: { apiBase: 'https://remote.example' }, revision: 4 }))
  await scope.set('apiBase', 'https://remote.example')
  assert.equal(fake.mutateCalls().length, 1, 'the Host, not the browser origin, receives and authorizes the write')
  assert.deepEqual(scope.getSnapshot().user, { apiBase: 'https://remote.example' })
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

// Bounded retry of a failed FIRST read

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
  // snapshot forever: every control renders disabled and nothing else re-reads
  // (the forwarded invalidations need a live Host to fire). The failure here is
  // a Host that was still starting up.
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


test('宿主拒绝后重读值恰好相同，仍不能冒充本次写入确认', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  let keyWrites = 0
  const controller = new CommandCodeSettingsController(scope, {
    credentials: {
      async describe(refs) { return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])) } },
      async set() { keyWrites++; return { ok: true } },
      async unset() { return { ok: true } },
    },
  })
  controller.edit('apiBase', 'https://same.example')
  controller.edit('apiKey', 'synthetic-key')
  fake.answerDescribe({ writable: true, namespaces: [row({ value: { apiBase: 'https://same.example' }, user: { apiBase: 'https://same.example' }, revision: 9 })] })
  fake.answerMutate({ error: 'SETTINGS_CONFLICT: synthetic conflict' })
  const outcome = await controller.save()
  assert.equal(outcome?.config, 'conflict')
  assert.equal(keyWrites, 0)
  assert.equal(controller.state().savedCount, 0)
  assert.equal(controller.state().apiKey.text, 'synthetic-key')
  assert.equal(scope.getSnapshot().value?.apiBase, 'https://same.example')
  controller.dispose()
  await scope.dispose()
})

test('变更返回缺失配置行不是确认，且不能污染最后有效镜像', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  fake.answerMutate({ ns: 'llm-commandcode', revision: 7 })
  assert.equal(await scope.mutate([{ op: 'set', path: ['apiBase'], value: 'https://synthetic.example' }]), 'failed')
  assert.equal(scope.getSnapshot().revision, 3)
  await scope.dispose()
  assert.equal(await scope.mutate([{ op: 'unset', path: ['apiBase'] }]), 'cancelled')
})

test('销毁后已发配置的接受结果保留，未发任务明确取消', async () => {
  const fake = fakeContext()
  fake.answerDescribe({ writable: true, namespaces: [row()] })
  const scope = createSettingsScope<Record<string, unknown>>(fake.context, 'llm-commandcode', fake.resolveRemote)
  await flush()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const mutate = fake.settingsNamespace.mutate
  fake.settingsNamespace.mutate = async (...args) => { const result = mutate(...args); await gate; return result }
  const first = scope.mutate([{ op: 'set', path: ['apiBase'], value: 'https://synthetic.example' }])
  const next = scope.mutate([{ op: 'unset', path: ['apiBase'] }])
  await flush()
  const closing = scope.dispose()
  release()
  assert.equal(await first, 'accepted')
  assert.equal(await next, 'cancelled')
  await closing
  assert.equal(fake.mutateCalls().length, 1)
})
