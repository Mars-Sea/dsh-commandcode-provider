import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountEnrollmentManager, type EnrollmentConfig, type EnrollmentDeps, type EnrollmentLogin } from '../src/enrollment.ts'
import { AccountEnrollmentController, type EnrollmentRemote } from '../src/client/enrollment.ts'
import { ENROLLMENT_DESCRIPTORS, parseEnrollmentInput, parseEnrollmentState, type EnrollmentInput, type EnrollmentState } from '../src/enrollment-wire.ts'
import type { CommandCodeLoginStatus } from '../src/login-wire.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Context } from '@deepseek-ai/cordis'
import { CommandCodeUsageService } from '../src/usage-remote.ts'
import { CommandCodeAdapter } from '../src/adapter.ts'

const owner = 'page-a'
const id = '00000000-0000-4000-8000-000000000001'
const nextId = '00000000-0000-4000-8000-000000000002'
const input = (extra: Partial<EnrollmentInput> = {}): EnrollmentInput => ({ id, pageId: nextId, mode: 'manual', label: '账号二', automaticName: true, ...(extra.mode === 'browser' ? {} : { key: 'synthetic-key' }), ...extra })
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise((done) => setTimeout(done, 2)) }
  assert.fail('等待状态超时')
}
function harness(initial: EnrollmentConfig = {}) {
  let value = structuredClone(initial)
  let revision = 1
  let writable = true
  const keys = new Map<string, string>()
  const changes: EnrollmentConfig[] = []
  const calls: string[] = []
  let mutateHook: ((ops: { path: string[]; value: unknown }[]) => Promise<void>) | undefined
  let setHook: (() => Promise<void>) | undefined
  let unsetFails = false
  let describeFails = false
  let store: ((credentials: { apiKey: string; userId: string; userName: string; keyName: string }) => Promise<void>) | undefined
  let loginState: CommandCodeLoginStatus = { state: 'idle' }
  let pendingStore: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const emit = (state: CommandCodeLoginStatus) => { loginState = state; for (const listener of [...listeners]) listener() }
  const login: EnrollmentLogin = {
    begin: async () => { emit({ state: 'waiting', authUrl: 'https://studio.example/authorize' }); return loginState },
    status: () => loginState,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    cancelAndDrain: async () => { emit({ state: 'failed', reason: 'cancelled' }); await pendingStore },
    dispose: () => { listeners.clear() },
  }
  const deps: EnrollmentDeps = {
    settings: () => ({
      get writable() { return writable },
      read: () => ({ value: structuredClone(value), revision }),
      mutate: async (ops, expected) => {
        assert.equal(expected, revision)
        await mutateHook?.(ops)
        assert.equal(expected, revision)
        for (const op of ops) (value as Record<string, unknown>)[op.path[0]!] = structuredClone(op.value)
        revision++
        changes.push(structuredClone(value))
      },
    }),
    describe: async (ref) => { if (describeFails) throw new Error('不确定'); return { configured: keys.has(ref), writable: true } },
    set: async (ref, key) => { calls.push('set'); await setHook?.(); keys.set(ref, key) },
    unset: async (ref) => { calls.push('unset'); if (unsetFails) throw new Error('清理失败'); keys.delete(ref) },
    login: (write) => { store = write; return login },
  }
  const manager = new AccountEnrollmentManager(deps)
  return {
    manager, deps, keys, changes, calls, value: () => value,
    mutateHook: (hook: typeof mutateHook) => { mutateHook = hook }, setHook: (hook: typeof setHook) => { setHook = hook },
    unsetFails: (fail: boolean) => { unsetFails = fail }, describeFails: (fail: boolean) => { describeFails = fail }, writable: (state: boolean) => { writable = state },
    succeed: async () => {
      assert.ok(store)
      pendingStore = store({ apiKey: 'browser-key', userId: 'synthetic-user', userName: '浏览器名称', keyName: 'test' })
      await pendingStore
      if (loginState.state !== 'failed') emit({ state: 'success', userName: '浏览器名称' })
    },
  }
}
async function settled(h: ReturnType<typeof harness>, taskId = id) {
  await until(() => ['finished', 'failed', 'cancelled', 'cleanup-needed'].includes(h.manager.status(owner, taskId).phase))
  return h.manager.status(owner, taskId)
}

test('手动开通先持久登记，完成后只留下账号和凭据，并保留组合配置密钥', async () => {
  const h = harness({ accounts: [{ label: '组合账号', apiKey: 'composition-secret' }] })
  h.setHook(async () => { assert.equal(h.value().accountEnrollmentTasks?.[0]?.phase, 'pending') })
  h.manager.begin(owner, input())
  assert.equal((await settled(h)).phase, 'finished')
  assert.equal(h.keys.get('COMMANDCODE_API_KEY_2'), 'synthetic-key')
  assert.equal(h.value().accounts?.[0]?.apiKey, 'composition-secret')
  assert.deepEqual(h.value().accountEnrollmentTasks, [])
  assert.ok(h.changes.every((change) => !JSON.stringify(change).includes('synthetic-key')))
})
test('浏览器自动命名失败保留账号，允许重试或接受已有名称', async () => {
  const h = harness()
  h.manager.begin(owner, input({ mode: 'browser' }))
  await until(() => h.manager.status(owner, id).phase === 'waiting')
  h.mutateHook(async (ops) => { if (ops.some((op) => op.path[0] === 'accounts' && (op.value as { label?: string }[])[0]?.label === '浏览器名称')) throw new Error('名称拒绝') })
  await h.succeed()
  await until(() => h.manager.status(owner, id).message.includes('名称保存失败'))
  assert.equal(h.keys.size, 1)
  assert.equal(h.value().accountEnrollmentTasks?.[0]?.phase, 'naming')
  assert.equal((await h.manager.name(owner, id, '浏览器名称')).phase, 'naming')
  assert.equal((await h.manager.cancel(owner, id)).phase, 'finished')
  assert.equal(h.value().accounts?.[0]?.label, '账号二')
  assert.equal(h.keys.size, 1)
})
test('取消写入中的手动账号：等实际写入结束才补偿，不留下迟到密钥', async () => {
  const h = harness()
  const writing = deferred()
  h.setHook(() => writing.promise)
  h.manager.begin(owner, input())
  await until(() => h.calls.includes('set'))
  let cancelled = false
  const cancel = h.manager.cancel(owner, id).then((state) => { cancelled = true; return state })
  await new Promise((done) => setTimeout(done, 5))
  assert.equal(cancelled, false)
  assert.deepEqual(h.calls, ['set'])
  writing.resolve()
  assert.equal((await cancel).phase, 'cancelled')
  assert.deepEqual(h.calls, ['set', 'unset'])
  assert.equal(h.keys.size, 0)
  assert.deepEqual(h.value().accounts, [])
})
test('取消浏览器写入等存储收束，未消费的默认登录流程不受影响', async () => {
  const h = harness()
  const writing = deferred()
  h.setHook(() => writing.promise)
  h.manager.begin(owner, input({ mode: 'browser' }))
  await until(() => h.manager.status(owner, id).phase === 'waiting')
  const complete = h.succeed()
  await until(() => h.calls.includes('set'))
  const cancel = h.manager.cancel(owner, id)
  assert.equal(h.calls.includes('unset'), false)
  writing.resolve()
  await complete
  await cancel
  assert.equal(h.keys.size, 0)
  assert.deepEqual(h.value().accountEnrollmentTasks, [])
})
test('取消早于 begin 和创建提交返回，均不开始凭据写入', async () => {
  const h = harness()
  await h.manager.cancel(owner, id)
  assert.equal(h.manager.begin(owner, input()).phase, 'cancelled')
  assert.equal(h.changes.length, 0)
  const creating = deferred()
  h.mutateHook(() => creating.promise)
  h.manager.begin(owner, input({ id: nextId }))
  const cancel = h.manager.cancel(owner, nextId)
  creating.resolve()
  assert.equal((await cancel).phase, 'cancelled')
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.value().accounts, [])
})
test('清理失败持久保留，重启后用户重试；不自动重试，不复用未清理引用', async () => {
  const h = harness()
  const writing = deferred()
  h.setHook(() => writing.promise)
  h.unsetFails(true)
  h.manager.begin(owner, input())
  await until(() => h.calls.includes('set'))
  const cancel = h.manager.cancel(owner, id)
  writing.resolve()
  assert.equal((await cancel).phase, 'cleanup-needed')
  assert.deepEqual(h.value().credentialCleanupRefs, ['COMMANDCODE_API_KEY_2'])
  assert.equal(h.value().accountEnrollmentTasks?.[0]?.phase, 'cleanup')
  assert.equal(h.calls.filter((call) => call === 'unset').length, 1)
  h.manager.begin(owner, input({ id: nextId }))
  assert.equal((await settled(h, nextId)).ref, 'COMMANDCODE_API_KEY_3')
  const restarted = new AccountEnrollmentManager(h.deps)
  assert.equal(restarted.pending('page-b')[0]?.phase, 'cleanup-needed')
  h.unsetFails(false)
  assert.equal((await restarted.retry('page-b', id)).phase, 'cancelled')
  assert.equal(h.keys.has('COMMANDCODE_API_KEY_2'), false)
})
test('连接结束取消活跃开通并释放失败记录，其他连接不能取消活跃过程', async () => {
  const h = harness()
  h.manager.begin(owner, input({ mode: 'browser' }))
  await until(() => h.manager.status(owner, id).phase === 'waiting')
  await assert.rejects(h.manager.cancel('page-b', id), /其他连接/)
  assert.deepEqual(h.manager.pending('page-b'), [])
  h.manager.disconnect(owner)
  await until(() => h.value().accountEnrollmentTasks?.length === 0)
  assert.equal(h.keys.size, 0)
})
test('不可写设置不会创建或写凭据；已有环境/存储凭据不能被新过程覆盖或删除', async () => {
  const h = harness()
  h.writable(false)
  h.manager.begin(owner, input())
  assert.equal((await settled(h)).phase, 'failed')
  assert.equal(h.calls.length, 0)
  const occupied = harness()
  occupied.keys.set('COMMANDCODE_API_KEY_2', 'preexisting')
  occupied.manager.begin(owner, input())
  assert.equal((await settled(occupied)).ref, 'COMMANDCODE_API_KEY_3')
  assert.equal(occupied.keys.get('COMMANDCODE_API_KEY_2'), 'preexisting')
  assert.deepEqual(occupied.calls, ['set'])
})
test('凭据确认失败仍可补偿，失败日志不含密钥或上游错误文本', async () => {
  const h = harness()
  h.setHook(async () => h.describeFails(true))
  h.manager.begin(owner, input())
  assert.equal((await settled(h)).phase, 'cleanup-needed')
  assert.equal(h.value().accountEnrollmentTasks?.[0]?.phase, 'cleanup')
  assert.ok(!JSON.stringify(h.manager.status(owner, id)).includes('synthetic-key'))
  h.describeFails(false)
  assert.equal((await h.manager.retry(owner, id)).phase, 'failed')
  assert.equal(h.keys.size, 0)
})
test('待命名日志保存失败也保留已登录账号，当前页面可以接受名称', async () => {
  const h = harness()
  h.mutateHook(async (ops) => { if (ops.some((op) => op.path[0] === 'accountEnrollmentTasks' && (op.value as { phase?: string }[])[0]?.phase === 'naming')) throw new Error('拒绝') })
  h.manager.begin(owner, input())
  await until(() => h.manager.status(owner, id).message.includes('名称保存失败'))
  assert.equal(h.keys.size, 1)
  assert.equal((await h.manager.name(owner, id)).phase, 'finished')
})
test('跨页面并发分配不会重用引用，默认引用及清理引用均保留', async () => {
  const h = harness({ apiKeyEnv: 'CUSTOM_KEY', credentialCleanupRefs: ['CUSTOM_KEY_2'] })
  h.manager.begin(owner, input())
  h.manager.begin('page-b', input({ id: nextId }))
  await settled(h)
  await until(() => h.manager.status('page-b', nextId).phase === 'finished')
  assert.deepEqual([...h.keys.keys()], ['CUSTOM_KEY_3', 'CUSTOM_KEY_4'])
})
test('恢复记录不能删除默认或继承账号，凭据和路由均保持', async () => {
  for (const inherited of [false, true]) {
    const ref = inherited ? 'INHERITED_KEY' : 'COMMANDCODE_API_KEY'
    const account = { label: '原账号', apiKeyEnv: ref }
    const h = harness({ accounts: [account], modelAccountRules: [{ account: ref, models: ['a'] }],
      accountEnrollmentTasks: [{ id, ref, phase: 'cleanup', label: '原账号' }] })
    h.keys.set(ref, 'preexisting')
    const settings = h.deps.settings()!
    h.deps.settings = () => ({ ...settings, read: () => ({ ...settings.read(), ...(inherited ? { base: { accounts: [account] } } : {}) }) })
    const manager = new AccountEnrollmentManager(h.deps)
    assert.equal((await manager.retry(owner, id)).phase, 'cleanup-needed')
    assert.deepEqual(h.value().accounts, [account])
    assert.equal(h.value().modelAccountRules?.[0]?.account, ref)
    assert.equal(h.keys.get(ref), 'preexisting')
    assert.deepEqual(h.calls, [])
  }
})
test('页面在待命名阶段结束，确认失败也不触发凭据清理，新页面可以重试名称', async () => {
  const h = harness()
  const release = h.manager.watch(owner)
  h.manager.begin(owner, input({ mode: 'browser' }))
  await until(() => h.manager.status(owner, id).phase === 'waiting')
  h.mutateHook(async (ops) => { if (ops.some((op) => op.path[0] === 'accountEnrollmentTasks' && (op.value as unknown[]).length === 0)) throw new Error('确认写入失败') })
  await h.succeed()
  await until(() => h.manager.status(owner, id).message.includes('名称保存失败'))
  release()
  await until(() => h.manager.pending('page-b').length === 1)
  assert.equal(h.keys.size, 1)
  assert.equal(h.calls.includes('unset'), false)
  h.mutateHook(undefined)
  const restarted = new AccountEnrollmentManager(h.deps)
  const pending = restarted.pending('page-b')[0]!
  assert.equal(pending.suggestedName, '浏览器名称')
  assert.equal((await restarted.retry('page-b', id, pending.suggestedName)).phase, 'finished')
  assert.equal(h.value().accounts?.[0]?.label, '浏览器名称')
})
test('开通双方契约严格校验并丢弃多余密钥字段', () => {
  assert.throws(() => parseEnrollmentInput({ ...input(), id: 'bad' }))
  assert.throws(() => parseEnrollmentInput({ ...input(), mode: 'browser' }))
  assert.throws(() => parseEnrollmentInput({ ...input(), key: ' ' }))
  assert.throws(() => parseEnrollmentState({ id, ref: 'KEY', phase: 'made-up', message: '' }))
  assert.equal('apiKey' in parseEnrollmentState({ id, ref: 'KEY', phase: 'waiting', message: '', apiKey: 'secret' }), false)
  assert.equal(new Set(ENROLLMENT_DESCRIPTORS.map((descriptor) => descriptor.method)).size, 7)
})

function clientRemote(overrides: Partial<EnrollmentRemote> = {}): EnrollmentRemote {
  const state: EnrollmentState = { id, ref: 'KEY_2', phase: 'waiting', message: '等待' }
  const result = async (): Promise<RemoteResult<EnrollmentState>> => ({ ok: true, value: state })
  return { enrollmentBegin: result, enrollmentStatus: result, enrollmentCancel: result, enrollmentName: result, enrollmentRetry: result, enrollmentPending: async () => ({ ok: true, value: [] }),
    enrollmentWatch: () => {
      const ended = deferred<IteratorResult<boolean>>()
      let first = true
      const iterator = { next: async (): Promise<IteratorResult<boolean>> => { if (first) { first = false; return { done: false, value: true } }; return ended.promise } }
      return { [Symbol.asyncIterator]: () => iterator,
        send: () => {}, end: () => {}, dispose: () => ended.resolve({ done: true, value: undefined }) }
    }, ...overrides }
}
test('页面卸载早于 begin 回复：立即按 id 取消，并在迟到回复后再次取消', async () => {
  const reply = deferred<RemoteResult<EnrollmentState>>()
  const requested = deferred()
  const cancels: string[] = []
  const opened: string[] = []
  const remote = clientRemote({ enrollmentBegin: () => { requested.resolve(); return reply.promise }, enrollmentCancel: async (action) => { cancels.push(action.id); return { ok: true, value: { id, ref: 'KEY_2', phase: 'cancelled', message: '取消' } } } })
  const controller = new AccountEnrollmentController(() => remote, () => {}, 5, () => id, (url) => { opened.push(url) })
  const start = controller.begin({ mode: 'browser', label: '账号', automaticName: false })
  assert.equal(controller.store.getSnapshot().active?.id, id)
  await requested.promise
  controller.dispose()
  await until(() => cancels.length === 1)
  reply.resolve({ ok: true, value: { id, ref: 'KEY_2', phase: 'waiting', authUrl: 'https://example.invalid/auth', message: '等待授权' } })
  await start
  assert.deepEqual(cancels, [id, id])
  assert.deepEqual(opened, [], '卸载后的迟到地址不打开授权页')
  assert.equal(controller.store.getSnapshot().active?.phase, 'creating', '卸载后不发布迟到结果')
})

test('新增账号在后续轮询收到地址时打开，重复状态不重复开页', async () => {
  const opened: string[] = []
  let polls = 0
  const reply = deferred<RemoteResult<EnrollmentState>>()
  const remote = clientRemote({
    enrollmentBegin: () => reply.promise,
    enrollmentStatus: async () => { polls++; return { ok: true, value: { id, ref: 'KEY_2', phase: 'waiting', authUrl: 'https://example.invalid/auth', message: '等待授权' } } },
  })
  const controller = new AccountEnrollmentController(() => remote, () => {}, 2, () => id, (url) => { opened.push(url) })
  try {
    const begin = controller.begin({ mode: 'browser', label: '账号', automaticName: true })
    assert.deepEqual(opened, [], '请求发出时尚无地址，不打开页面')
    reply.resolve({ ok: true, value: { id, ref: 'KEY_2', phase: 'creating', message: '创建中' } })
    await begin
    assert.deepEqual(opened, [])
    await until(() => polls >= 2)
    assert.deepEqual(opened, ['https://example.invalid/auth'])
    assert.equal(controller.store.getSnapshot().active?.authUrl, opened[0], '始终保留手动链接')
  } finally { controller.dispose() }
})

test('真实 Cordis 远端接收器：共享同一个 Peer 的两页互不取消，观察流断开只清理所属过程', async () => {
  const h = harness()
  const writing = deferred()
  h.setHook(() => writing.promise)
  const ctx = new Context()
  new CommandCodeUsageService(ctx, { adapter: new CommandCodeAdapter({ options: () => ({ apiBase: 'https://example.invalid', workingDir: '/tmp', modelsCachePath: '/tmp/enrollment-unused.json', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }), resolveApiKey: async () => 'synthetic-key' }), enrollment: h.manager })
  const control = new AbortController()
  const peer = { id: 'shared-operator', ctx, dispose: () => Promise.resolve() }
  const receiver = ctx.extend({ invocation: { peer, signal: control.signal } }).get('commandcodeUsage') as CommandCodeUsageService
  const page = { pageId: nextId }
  const stream = receiver.enrollmentWatch(page)[Symbol.asyncIterator]()
  assert.deepEqual(await stream.next(), { value: true, done: false })
  await receiver.enrollmentBegin(input())
  await until(() => h.calls.includes('set'))
  const other = ctx.extend({ invocation: { peer, signal: new AbortController().signal } }).get('commandcodeUsage') as CommandCodeUsageService
  await assert.rejects(other.enrollmentCancel({ id, pageId: '00000000-0000-4000-8000-000000000003' }), /其他连接/)
  const closed = stream.next()
  control.abort()
  assert.equal((await closed).done, true)
  assert.equal(h.keys.size, 0)
  assert.deepEqual(h.calls, ['set'], '已开始写入仍等待收束')
  writing.resolve()
  await until(() => h.value().accountEnrollmentTasks?.length === 0)
  assert.deepEqual(h.calls, ['set', 'unset'])
  assert.equal(h.keys.size, 0)
})
test('页面控制器轮询完成即停止，待命名仍可接受已有名称', async () => {
  let polls = 0
  const remote = clientRemote({ enrollmentStatus: async () => { polls++; return { ok: true, value: { id, ref: 'KEY_2', phase: 'naming', message: '待命名' } } }, enrollmentName: async () => ({ ok: true, value: { id, ref: 'KEY_2', phase: 'finished', message: '完成' } }) })
  const controller = new AccountEnrollmentController(() => remote, () => {}, 2, () => id)
  await controller.begin({ mode: 'browser', label: '账号', automaticName: true })
  await until(() => controller.store.getSnapshot().active?.phase === 'naming')
  await controller.name()
  assert.equal(controller.store.getSnapshot().active?.phase, 'finished')
  assert.equal(polls, 1)
  controller.dispose()
})
test('观察流未建立不会开始写入，失败后可重新尝试且页面不留密钥', async () => {
  let calls = 0
  const remote = clientRemote({ enrollmentWatch: () => { throw new Error('不支持') }, enrollmentBegin: async () => { calls++; throw new Error('不该调用') } })
  const controller = new AccountEnrollmentController(() => remote, () => {}, 2, () => id)
  await controller.begin({ mode: 'manual', label: '账号', automaticName: false, key: 'synthetic-key' })
  assert.equal(calls, 0)
  assert.equal(controller.store.getSnapshot().active, undefined)
  assert.ok(!JSON.stringify(controller.store.getSnapshot()).includes('synthetic-key'))
  assert.ok(controller.store.getSnapshot().error?.includes('请求失败'))
  controller.dispose()
})
