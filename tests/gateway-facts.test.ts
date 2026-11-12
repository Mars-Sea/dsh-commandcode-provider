import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerError } from '../src/llm-error.ts'
import { GatewayFacts, modelOutputTokenLimit, outputCeilingRefusal } from '../src/gateway-facts.ts'

const model = 'synthetic/facts'
const source = (name: string) => ({ apiBase: `https://${name}.invalid`, modelsCachePath: '' })
const catalog = (limit?: number) => ({ object: 'list', data: [{ id: model, name: '合成模型', context_length: 1000000, supported_endpoints: ['/messages'], ...(limit === undefined ? {} : { max_output_tokens: limit }) }] })
function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { enter, release, entered, waiting }
}

test('跨实例最新刷新发布，迟到的旧响应仍能服务原等待者', async () => {
  const s = source('facts-cross-instance'), barrier = gate()
  const old = new GatewayFacts(async () => { barrier.enter(); await barrier.waiting; return catalog(20000) })
  const newer = new GatewayFacts(async () => catalog(90000))
  const waiting = old.refresh(s)
  await barrier.entered
  await newer.refresh(s)
  barrier.release()
  assert.equal((await waiting)[0]?.publishedMaxTokens, 20000)
  assert.equal(modelOutputTokenLimit(s.apiBase, model), 90000)
})

test('新刷新失败不交还旧发布权，并保留上次有效事实', async () => {
  const s = source('facts-newer-failure'), barrier = gate()
  await new GatewayFacts(async () => catalog(90000)).refresh(s)
  const old = new GatewayFacts(async () => { barrier.enter(); await barrier.waiting; return catalog(20000) })
  const waiting = old.refresh(s)
  await barrier.entered
  assert.deepEqual(await new GatewayFacts(async () => ({ object: 'list', data: [] })).refresh(s), [])
  barrier.release()
  await waiting
  assert.equal(modelOutputTokenLimit(s.apiBase, model), 90000)
})

for (const [name, invalid] of [
  ['形状错误', { data: [] }],
  ['无有效模型', { object: 'list', data: [{ id: model, context_length: 1000, max_output_tokens: 1 }] }],
  ['非法上下文', { object: 'list', data: [{ id: model, name: '无效', context_length: -1, max_output_tokens: 1 }] }],
] as const) {
  test(`${name}不修改共享事实`, async () => {
    const s = source(`facts-invalid-${name}`)
    await new GatewayFacts(async () => catalog(90000)).refresh(s)
    await new GatewayFacts(async () => invalid).refresh(s)
    assert.equal(modelOutputTokenLimit(s.apiBase, model), 90000)
  })
}

test('有效新目录移除公布字段时完整替换旧字段', async () => {
  const s = source('facts-remove-field')
  await new GatewayFacts(async () => catalog(90000)).refresh(s)
  const rows = await new GatewayFacts(async () => catalog()).refresh(s)
  assert.equal(rows[0]?.publishedMaxTokens, undefined)
  assert.equal(rows[0]?.maxTokens, 131072)
  assert.equal(modelOutputTokenLimit(s.apiBase, model), 131072)
})

test('单个等待者取消不取消共享刷新，也不产生第二次获取', async () => {
  const s = source('facts-cancel-waiter'), barrier = gate()
  let calls = 0
  const facts = new GatewayFacts(async () => { calls++; barrier.enter(); await barrier.waiting; return catalog(90000) })
  const control = new AbortController(), reason = new Error('合成取消')
  const cancelled = facts.refresh(s, control.signal)
  const rejected = assert.rejects(cancelled, error => error === reason)
  await barrier.entered
  const other = facts.refresh(s)
  control.abort(reason)
  await rejected
  barrier.release()
  assert.equal((await other)[0]?.maxTokens, 90000)
  assert.equal(calls, 1)
})

test('目录接口返回独立记录与路由数组，不暴露共享可变镜像', async () => {
  const s = source('facts-copy'), facts = new GatewayFacts(async () => catalog(90000))
  const first = await facts.refresh(s)
  first[0]!.maxTokens = 1
  ;(first[0]!.supportedEndpoints as string[]).splice(0)
  const second = await facts.snapshot(s)
  assert.equal(second[0]?.maxTokens, 90000)
  assert.deepEqual(second[0]?.supportedEndpoints, ['/messages'])
})

test('磁盘冷读取无需联网，且旧磁盘不能清除或覆盖联网公布事实', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-facts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = { ...source('facts-disk'), modelsCachePath: join(dir, 'models.json') }
  await writeFile(s.modelsCachePath, JSON.stringify({ version: 3, apiBase: s.apiBase, models: [{ id: model, name: '缓存模型', contextWindow: 1000000, maxTokens: 1, publishedMaxTokens: 20000, supportedEndpoints: ['/messages'] }] }))
  await new GatewayFacts(async () => catalog(90000)).refresh({ ...s, modelsCachePath: '' })
  let calls = 0
  const cold = new GatewayFacts(async () => { calls++; throw new Error('合成失败') })
  assert.equal((await cold.snapshot(s))[0]?.maxTokens, 20000)
  await cold.refresh(s)
  assert.equal(calls, 1)
  assert.equal(modelOutputTokenLimit(s.apiBase, model), 90000)
})

test('版本或网关不匹配的磁盘不能成为目录事实', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = { ...source('facts-disk-source'), modelsCachePath: join(dir, 'models.json') }
  for (const data of [{ version: 2, apiBase: s.apiBase }, { version: 3, apiBase: 'https://other.invalid' }]) {
    await writeFile(s.modelsCachePath, JSON.stringify({ ...data, models: [{ id: model, name: '缓存模型', contextWindow: 1000 }] }))
    assert.deepEqual(await new GatewayFacts(async () => catalog()).snapshot(s), [])
  }
})

test('上限拒绝以实发值判断，共享学习只降低且按网关隔离', () => {
  const a = source('facts-learning-a').apiBase, b = source('facts-learning-b').apiBase
  const error = (limit: number) => providerError(`max_tokens: 131072 > ${limit}, which is the maximum allowed number of output tokens`, 'PROVIDER_HTTP_ERROR')
  assert.equal(outputCeilingRefusal(a, model, 131072, error(20000)), 20000)
  assert.equal(outputCeilingRefusal(a, model, 131072, error(40000)), 20000)
  assert.equal(outputCeilingRefusal(a, model, 20000, error(40000)), undefined)
  assert.equal(outputCeilingRefusal(a, model, 20000, error(0)), undefined)
  assert.equal(modelOutputTokenLimit(a, model), 20000)
  assert.equal(modelOutputTokenLimit(b, model), 131072)
})

// ---------------------------------------------------------------------------
// `loaded()` 的来源判据（PR #98 审查修复 R3/R4）
//
// 选择器首屏只允许用「本进程联网成功过」的非空目录：`snapshot()` 会把磁盘
// 缓存灌进同一份 state.rows，若只看行数，冷启动先聊过天再打开选择器就会拿
// 没有年龄校验的磁盘副本当首屏；刷新失败后的空目录也不配冒充热数据。
// ---------------------------------------------------------------------------

test('loaded() 在进程从未加载目录时返回 undefined', () => {
  const s = source('facts-loaded-cold')
  assert.equal(new GatewayFacts(async () => catalog()).loaded(s), undefined)
})

test('snapshot() 灌入的磁盘行不算联网来源，loaded() 仍返回 undefined', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-loaded-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = { ...source('facts-loaded-disk'), modelsCachePath: join(dir, 'models.json') }
  await writeFile(s.modelsCachePath, JSON.stringify({ version: 3, apiBase: s.apiBase, models: [{ id: model, name: '缓存模型', contextWindow: 1000000, maxTokens: 1, publishedMaxTokens: 20000, supportedEndpoints: ['/messages'] }] }))
  let calls = 0
  const facts = new GatewayFacts(async () => { calls += 1; return catalog(90000) })
  assert.equal((await facts.snapshot(s))[0]?.maxTokens, 20000, '生成路径照旧立刻拿到磁盘行')
  assert.equal(facts.loaded(s), undefined, '磁盘副本不能当选择器首屏')
  await facts.refresh(s)
  assert.equal(facts.loaded(s)?.[0]?.maxTokens, 90000, '联网成功之后才允许先画')
  assert.equal(calls, 1)
})

test('刷新失败且无磁盘缓存时 loaded() 返回 undefined，不把空目录当热数据', async () => {
  const s = source('facts-loaded-failure')
  const facts = new GatewayFacts(async () => { throw new Error('合成失败') })
  assert.deepEqual(await facts.refresh(s), [])
  assert.equal(facts.loaded(s), undefined)
})

test('loaded() 返回独立副本，调用方改写不会污染内部目录', async () => {
  const s = source('facts-loaded-copy')
  const facts = new GatewayFacts(async () => catalog(90000))
  await facts.refresh(s)
  const painted = facts.loaded(s)!
  painted[0]!.maxTokens = 1
  ;(painted[0]!.supportedEndpoints as string[]).splice(0)
  const again = facts.loaded(s)!
  assert.equal(again[0]?.maxTokens, 90000)
  assert.deepEqual(again[0]?.supportedEndpoints, ['/messages'])
})
