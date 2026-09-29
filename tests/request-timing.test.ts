import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestTiming, type RequestTimingSummary } from '../src/request-timing.ts'
import { absorbTransientFailure, resetTransientFailures } from '../src/transient-retry.ts'

test('阶段耗时、首内容和失败尝试可分别观测', async () => {
  let now = 0
  let summary: RequestTimingSummary | undefined
  const timing = new RequestTiming('model', (value) => { summary = value }, () => now)
  const credentials = timing.phase('credentials')
  now = 12
  credentials()
  const first = timing.attempt('openai', 123)
  now = 42
  first(429)
  const second = timing.attempt('cli', 150)
  now = 62
  second(200)
  now = 70
  timing.first('firstByteMs')
  now = 80
  timing.first('firstContentMs')
  now = 90
  timing.first('firstContentMs')
  await timing.close('finished')
  assert.equal(summary?.phasesMs.credentials, 12)
  assert.equal(summary?.phasesMs.headers, 50)
  assert.equal(summary?.firstByteMs, 70)
  assert.equal(summary?.firstContentMs, 80)
  assert.equal(summary?.totalMs, 90)
  assert.deepEqual(summary?.attempts.map((attempt) => attempt.status), [429, 200])
})

test('耗时接收器失败不改变请求结果', async () => {
  const timing = new RequestTiming('model', () => { throw new Error('unwritable') })
  await assert.doesNotReject(timing.close('error', 'SERVER'))
})

test('普通临时故障共享三次预算，窗口限流和传输错误不消耗它', () => {
  const agent = {}
  assert.equal(absorbTransientFailure(agent, 'SERVER'), 'retry')
  assert.equal(absorbTransientFailure(agent, 'RATE_LIMIT'), 'ignored')
  assert.equal(absorbTransientFailure(agent, 'TRANSPORT'), 'ignored')
  assert.equal(absorbTransientFailure(agent, 'EMPTY_RESPONSE'), 'retry')
  assert.equal(absorbTransientFailure(agent, 'THROTTLED'), 'retry')
  assert.equal(absorbTransientFailure(agent, 'TIMEOUT'), 'exhausted')
  assert.equal(absorbTransientFailure({}, 'TIMEOUT'), 'retry')
  resetTransientFailures(agent)
  assert.equal(absorbTransientFailure(agent, 'TIMEOUT'), 'retry')
})

test('真实插件注册的预算处理器尊重提供商、取消以及每个步骤的重置', async () => {
  const { apply } = await import('../src/index.ts')
  const listeners = new Map<string, (...args: any[]) => any>()
  const context = {
    llm: { registerConfigurableProviders: () => undefined, registerAdapter: () => undefined },
    inject: () => undefined,
    on: (name: string, listener: (...args: any[]) => any) => { listeners.set(name, listener) },
    effect: () => undefined,
    logger: { warn: () => undefined },
  } as unknown as Parameters<typeof apply>[0]
  apply(context, {} as Parameters<typeof apply>[1])
  const handler = listeners.get('agent/request-error')!
  const session = {}, agent = { session }
  let delegated = 0
  const next = async () => { delegated++; return { kind: 'retry' } }
  const payload = { agent, provider: 'commandcode', failure: { code: 'SERVER', message: 'test' }, signal: new AbortController().signal }
  const aborted = new AbortController(); aborted.abort()
  for (let i = 0; i < 5; i++) {
    await handler({ ...payload, provider: 'other' }, next)
    await handler({ ...payload, signal: aborted.signal }, next)
  }
  for (let i = 0; i < 3; i++) await handler(payload, next)
  assert.equal(delegated, 13)
  await assert.rejects(handler(payload, next), /3 次自动重试/)
  listeners.get('session/event')!(session, { type: 'assistant/attempt' })
  await assert.rejects(handler(payload, next), /3 次自动重试/)
  listeners.get('session/event')!(session, { type: 'step/start' })
  await handler(payload, next)
  for (let i = 0; i < 5; i++) await handler({ ...payload, failure: { code: 'RATE_LIMIT', message: 'window' } }, next)
  await handler(payload, next)
  await handler(payload, next)
  await assert.rejects(handler(payload, next), /3 次自动重试/)
})
