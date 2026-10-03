import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandCodeAdapter, type CommandCodeConnectionOptions } from '../src/adapter.ts'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'

// 用真实适配器入口和可控异步等待验证跨模块时序，所有密钥及网关均为合成值。
const model = 'synthetic/request-facts'
const request = { provider: 'commandcode', model, messages: [{ id: MessageId('message'), role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }] } as GenerateOptions
function connection(apiBase: string): CommandCodeConnectionOptions {
  return { apiBase, workingDir: '/tmp', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, filterModelsByPlan: false }
}
function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { enter, release, entered, waiting }
}
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
function answer(url: string): Response {
  if (url.endsWith('/alpha/generate')) return new Response(sse({ type: 'text-delta', text: 'ok' }) + sse({ type: 'finish', finishReason: 'stop' }))
  if (url.endsWith('/messages')) return new Response([
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(sse).join(''))
  return new Response(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')
}
const catalog = (limit: number, endpoint = '/chat/completions') => new Response(JSON.stringify({ object: 'list', data: [{ id: model, name: '合成模型', context_length: 1000000, max_output_tokens: limit, supported_endpoints: [endpoint] }] }))
async function collect<C extends CommandCodeConnectionOptions>(adapter: CommandCodeAdapter<C>) { for await (const _ of adapter.stream(request)) { /* 读取到真实收束。 */ } }
const budget = (init?: RequestInit): number => { const body = JSON.parse(String(init?.body)); return body.max_tokens ?? body.params?.max_tokens }

test('凭据等待后连接、协议与隐私仍使用调用开始时的事实', async () => {
  const current = { ...connection('https://frozen-connection.invalid'), protocol: 'openai' as const, zdr: true }
  const barrier = gate(), sent: Array<{ url: string; zdr: string | null }> = []
  const adapter = new CommandCodeAdapter({ options: () => current,
    resolveApiKey: async () => { barrier.enter(); await barrier.waiting; return 'synthetic-key' },
    fetchImpl: (async (input, init) => { sent.push({ url: String(input), zdr: new Headers(init?.headers).get('x-cmd-zdr') }); return answer(String(input)) }) as typeof fetch,
  })
  const running = collect(adapter)
  await barrier.entered
  Object.assign(current, { apiBase: 'https://other-connection.invalid', protocol: 'cli', zdr: false })
  barrier.release()
  await running
  assert.deepEqual(sent, [{ url: 'https://frozen-connection.invalid/provider/v1/chat/completions', zdr: '1' }])
})

test('调用返回迭代器时就捕获连接，延后消费不读取新配置', async () => {
  let current = connection('https://iterator-created-a.invalid')
  const sent: string[] = []
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async input => { sent.push(String(input)); return answer(String(input)) }) as typeof fetch,
  })
  const stream = adapter.stream(request)
  current = connection('https://iterator-created-b.invalid')
  for await (const _ of stream) { /* 调用后才开始消费。 */ }
  assert.deepEqual(sent, ['https://iterator-created-a.invalid/provider/v1/chat/completions'])
})

test('旧迭代器延后消费不能撤销新网关目录刷新', async () => {
  const a = 'https://delayed-source-a.invalid', b = 'https://delayed-source-b.invalid'
  let current = connection(a)
  const barrier = gate(), sent: Array<{ url: string; max: number }> = []
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/models')) { barrier.enter(); await barrier.waiting; return catalog(20000) }
      sent.push({ url, max: budget(init) }); return answer(url)
    }) as typeof fetch,
  })
  const old = adapter.stream(request)
  current = connection(b)
  const refreshing = adapter.listModels('commandcode', { unfiltered: true })
  await barrier.entered
  for await (const _ of old) { /* 在新来源的刷新等待中消费旧迭代器。 */ }
  barrier.release()
  await refreshing
  await collect(adapter)
  assert.deepEqual(sent, [
    { url: `${a}/provider/v1/chat/completions`, max: 131072 },
    { url: `${b}/provider/v1/chat/completions`, max: 20000 },
  ])
})

test('账号轮换不读取另一网关刚刷新的目录路由或预算', async () => {
  const a = 'https://frozen-route-a.invalid', b = 'https://frozen-route-b.invalid'
  let current = connection(a)
  const barrier = gate(), sent: Array<{ url: string; max: number }> = []
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-first',
    rotateApiKey: async () => { barrier.enter(); await barrier.waiting; return 'synthetic-second' },
    fetchImpl: (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/models')) return catalog(url.startsWith(a) ? 20000 : 90000, url.startsWith(a) ? '/messages' : '/chat/completions')
      sent.push({ url, max: budget(init) })
      return sent.length === 1 ? new Response('invalid credential', { status: 401 }) : answer(url)
    }) as typeof fetch,
  })
  await adapter.listModels('commandcode', { unfiltered: true })
  const running = collect(adapter)
  await barrier.entered
  current = connection(b)
  await adapter.listModels('commandcode', { unfiltered: true })
  barrier.release()
  await running
  assert.deepEqual(sent, [1, 2].map(() => ({ url: `${a}/provider/v1/messages`, max: 20000 })))
})

test('旧缓存来源的刷新晚到不能覆盖已接管的共享上限', async () => {
  const base = 'https://publication-generation.invalid'
  let current = { ...connection(base), modelsCachePath: '/dev/null/old.json' }
  const barrier = gate(), sent: number[] = []
  let refreshes = 0
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => {
      if (String(input).endsWith('/models')) {
        if (++refreshes === 1) { barrier.enter(); await barrier.waiting; return catalog(20000) }
        return catalog(90000)
      }
      sent.push(budget(init)); return answer(String(input))
    }) as typeof fetch,
  })
  const old = adapter.listModels('commandcode', { unfiltered: true })
  await barrier.entered
  current = { ...current, modelsCachePath: '/dev/null/new.json' }
  await adapter.listModels('commandcode', { unfiltered: true })
  await collect(adapter)
  barrier.release()
  await old
  await collect(adapter)
  assert.deepEqual(sent, [90000, 90000])
})

test('另一实例解析空目录失败不能清除有效公布上限', async () => {
  const current = connection('https://invalid-publication.invalid'), sent: number[] = []
  const first = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => {
      if (String(input).endsWith('/models')) return catalog(90000)
      sent.push(budget(init)); return answer(String(input))
    }) as typeof fetch,
  })
  await first.listModels('commandcode', { unfiltered: true })
  const second = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async () => new Response(JSON.stringify({ object: 'list', data: [] }))) as typeof fetch,
  })
  await second.listModels('commandcode', { unfiltered: true })
  // 冷实例没有自己的目录，必须仍受上次有效的共享事实约束。
  const cold = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => { sent.push(budget(init)); return answer(String(input)) }) as typeof fetch,
  })
  await collect(cold)
  assert.deepEqual(sent, [90000])
})

test('并发已有较低学习值不会吞掉本次唯一降档机会', async () => {
  const current = connection('https://concurrent-downshift.invalid'), barrier = gate(), sent: number[] = []
  let requests = 0
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => {
      sent.push(budget(init))
      const index = ++requests
      if (index === 1) { barrier.enter(); await barrier.waiting; return new Response('max_tokens: 131072 > 40000, which is the maximum allowed number of output tokens', { status: 400 }) }
      if (index === 2) return new Response('max_tokens: 131072 > 20000, which is the maximum allowed number of output tokens', { status: 400 })
      return answer(String(input))
    }) as typeof fetch,
  })
  const late = collect(adapter)
  // 防止缺陷复现的拒绝被运行器认作未处理；仍在末尾等待并验证原承诺。
  void late.catch(() => undefined)
  await barrier.entered
  await collect(adapter)
  barrier.release()
  await late
  assert.deepEqual(sent, [131072, 131072, 20000, 20000])
})

for (const mode of ['账号轮换', '协议回退'] as const) {
  test(`${mode}发出前采纳其他请求刚学到的更低上限`, async () => {
    const current = connection(`https://lower-before-${mode === '账号轮换' ? 'rotation' : 'protocol'}.invalid`)
    const barrier = gate(), sent: number[] = []
    let attempts = 0
    const first = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-first',
      rotateApiKey: async () => { barrier.enter(); await barrier.waiting; return 'synthetic-next' },
      fetchImpl: (async (input, init) => {
        if (String(input).endsWith('/models')) return catalog(90000)
        sent.push(budget(init))
        if (++attempts === 1) {
          if (mode === '协议回退') { barrier.enter(); await barrier.waiting; return new Response(JSON.stringify({ error: { code: 'upgrade_required', message: 'upgrade_required' } }), { status: 403 }) }
          return new Response('invalid credential', { status: 401 })
        }
        return answer(String(input))
      }) as typeof fetch,
    })
    await first.listModels('commandcode', { unfiltered: true })
    const running = collect(first)
    await barrier.entered
    let secondAttempts = 0
    const second = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-other',
      fetchImpl: (async input => ++secondAttempts === 1
        ? new Response('max_tokens: 90000 > 20000, which is the maximum allowed number of output tokens', { status: 400 })
        : answer(String(input))) as typeof fetch,
    })
    await collect(second)
    barrier.release()
    await running
    assert.deepEqual(sent, [90000, 20000])
  })
}

test('唯一降档重试固定原网关，后续新调用才使用新配置', async () => {
  const a = 'https://downshift-frozen-a.invalid', b = 'https://downshift-frozen-b.invalid'
  let current = connection(a)
  const sent: Array<{ url: string; max: number }> = []
  const adapter = new CommandCodeAdapter({ options: () => current, resolveApiKey: async () => 'synthetic-key',
    fetchImpl: (async (input, init) => {
      sent.push({ url: String(input), max: budget(init) })
      if (sent.length === 1) {
        current = connection(b)
        return new Response('max_tokens: 131072 > 20000, which is the maximum allowed number of output tokens', { status: 400 })
      }
      return answer(String(input))
    }) as typeof fetch,
  })
  await collect(adapter)
  await collect(adapter)
  assert.deepEqual(sent, [
    { url: `${a}/provider/v1/chat/completions`, max: 131072 },
    { url: `${a}/provider/v1/chat/completions`, max: 20000 },
    { url: `${b}/provider/v1/chat/completions`, max: 131072 },
  ])
})
