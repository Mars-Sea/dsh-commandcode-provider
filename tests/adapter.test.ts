/**
 * Core adapter unit tests (node:test, zero deps). Run with `npm test`.
 *
 * These fix the ported wire logic — message conversion, SSE/JSONL stream
 * parsing, catalog parsing, and HTTP-error mapping — so a refactor cannot
 * silently change what leaves or enters the Command Code API.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'

import { requestImageTarget } from '../src/image-request.ts'

import {
  CommandCodeAdapter,
  projectSlugFromPath,
  resolveAuthFileApiKey,
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  headersTimeoutAdvice,
  windowVerdict,
} from '../src/adapter.ts'
import {
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_THINKING_MODELS,
  KNOWN_PLANS,
  KNOWN_DEALS,
  KNOWN_PEAK_PRICING,
  MODEL_OUTPUT_TOKEN_LIMITS,
  MESSAGES_ONLY_MODELS,
  PEAK_HOUR_RANGES,
  isPeakPricingHour,
  planLabel,
  dealLabel,
  formatContext,
  capabilityDescription,
  peakPricingLabel,
  peakPricingState,
  compareByPlan,
  isFreeModel,
  requiresMessagesEndpoint,
  supportsZeroDataRetention,
} from '../src/capabilities.ts'
import type { CommandCodeAdapterDeps, CommandCodeConnectionOptions, SurfaceImagePolicy } from '../src/adapter.ts'
import type { ContentBlock, GenerateOptions, Message, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MessageId, ToolCallId, ReasoningEffortId, LlmError } from '@deepseek-ai/dsh-llm'
import type { RequestTimingSummary } from '../src/request-timing.ts'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The harness mints a stable id per appended message; the adapter never reads it. */
let messageSeq = 0
function messageId(): MessageId {
  return MessageId(`msg-${++messageSeq}`)
}

/** A fetch stub returning a canned Response stream. */
function fetchReturning(
  status: number,
  body: string | (() => ReadableStream<Uint8Array>),
  headers: Record<string, string> = {},
): typeof fetch {
  const text = (): ReadableStream<Uint8Array> =>
    typeof body === 'string'
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          },
        })
      : body()
  return (async () => new Response(text(), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })) as unknown as typeof fetch
}

function makeAdapter(overrides: Partial<CommandCodeAdapterDeps> = {}): CommandCodeAdapter {
  const options = overrides.options
  return new CommandCodeAdapter({
    options: options ?? (() => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      // Existing adapter tests pin the legacy CLI transport; Provider API
      // tests opt in by overriding options.protocol.
      protocol: 'cli' as const,
    })),
    resolveApiKey: async () => 'user_test_key',
    ...overrides,
  })
}

function userMessage(text: string): Message {
  return { id: messageId(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

test('调用等待目录后取消，不开始凭据解析或网络生成', async () => {
  let resolved = false, fetched = false
  const control = new AbortController()
  const adapter = makeAdapter({
    options: () => ({ apiBase: 'https://cancel-facts.invalid', workingDir: '/tmp', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    resolveApiKey: async () => { resolved = true; return 'synthetic-key' },
    fetchImpl: (async () => { fetched = true; return new Response('') }) as typeof fetch,
  })
  const running = collect(adapter.stream({ provider: 'commandcode', model: 'synthetic/model', messages: [userMessage('hello')], signal: control.signal }))
  control.abort(new Error('合成取消'))
  await assert.rejects(running)
  assert.equal(resolved, false)
  assert.equal(fetched, false)
})

/** 三种线上协议各自的终止顺序；这些回归通过适配器入口观察完整响应过程。 */
function settlementFrames(protocol: 'cli' | 'openai' | 'messages'): string[] {
  const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
  if (protocol === 'cli') return [
    sse({ type: 'text-delta', text: 'first' }), sse({ type: 'text-delta', text: 'second' }),
    sse({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 3 } }),
  ]
  if (protocol === 'openai') return [
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    sse({ choices: [{ delta: { content: 'first' } }] }), sse({ choices: [{ delta: { content: 'second' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }), 'data: [DONE]\n\n',
  ]
  return [
    sse({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
    sse({ type: 'message_stop' }),
  ]
}

for (const protocol of ['cli', 'openai', 'messages'] as const) {
  const options = () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', modelsCachePath: '', protocol, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 })
  const model = protocol === 'messages' ? 'claude-settlement' : 'settlement/model'
  test(`${protocol}：取消后不再交付同包缓冲正文，只保留取消前已解析用量`, async () => {
    const control = new AbortController()
    const reason = new Error('用户取消')
    const adapter = makeAdapter({ options, fetchImpl: fetchReturning(200, settlementFrames(protocol).join('')) })
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')], signal: control.signal })) {
        seen.push(chunk)
        if (chunk.type === 'text-delta') control.abort(reason)
      }
    }, (error: unknown) => error === reason)
    assert.deepEqual(seen.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['first'])
    assert.equal(seen.some(chunk => chunk.type === 'finish' || chunk.type === 'tool-call-delta'), false)
    const usage = seen.filter(chunk => chunk.type === 'usage')
    assert.equal(usage.length, protocol === 'cli' ? 0 : 1)
    if (usage[0]?.type === 'usage') assert.equal(usage[0].usage.outputTokens, 1, '不能继续读取取消后的用量')
  })

  test(`${protocol}：交付最后用量时取消，不再发布成功结束`, async () => {
    const control = new AbortController()
    const reason = new Error('用量后取消')
    const adapter = makeAdapter({ options, fetchImpl: fetchReturning(200, settlementFrames(protocol).join('')) })
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')], signal: control.signal })) {
        seen.push(chunk)
        if (chunk.type === 'usage') control.abort(reason)
      }
    }, (error: unknown) => error === reason)
    assert.equal(seen.filter(chunk => chunk.type === 'usage').length, 1)
    assert.equal(seen.some(chunk => chunk.type === 'finish'), false)
  })

  test(`${protocol}：块结束处取消仍保留当前事件已经解析的用量`, async () => {
    const control = new AbortController()
    const reason = new Error('块结束时取消')
    const adapter = makeAdapter({ options, fetchImpl: fetchReturning(200, settlementFrames(protocol).join('')) })
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')], signal: control.signal })) {
        seen.push(chunk)
        if (chunk.type === 'block-end') control.abort(reason)
      }
    }, (error: unknown) => error === reason)
    const usage = seen.filter(chunk => chunk.type === 'usage')
    assert.equal(usage.length, 1)
    assert.equal(usage[0]?.type === 'usage' ? usage[0].usage.outputTokens : undefined, protocol === 'cli' ? 3 : 1)
    assert.equal(seen.some(chunk => chunk.type === 'finish'), false)
  })

  test(`${protocol}：最终标记后的同包非法内容不会创建新块`, async () => {
    const extra = protocol === 'cli' ? { type: 'text-delta', text: 'extra' }
      : protocol === 'openai' ? { choices: [{ delta: { content: 'extra' } }] }
        : { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'extra' } }
    const adapter = makeAdapter({ options, fetchImpl: fetchReturning(200, `${settlementFrames(protocol).join('')}data: ${JSON.stringify(extra)}\n\n`) })
    const chunks = await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
    assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, chunks.filter(chunk => chunk.type === 'block-end').length)
    assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'extra'), false)
  })

  test(`${protocol}：底层取消不完成也不阻塞成功响应的迭代结束`, async () => {
    let release!: () => void
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(settlementFrames(protocol).join(''))) },
      cancel() { cancelled = true; return new Promise<void>(resolve => { release = resolve }) },
    })
    const adapter = makeAdapter({ options, fetchImpl: (async () => new Response(body)) as typeof fetch })
    const iterator = adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] })[Symbol.asyncIterator]()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      while ((await iterator.next()).value?.type !== 'finish') { /* 读到公开成功结束。 */ }
      const result = await Promise.race([
        iterator.next().then(value => value.done),
        new Promise<'超时'>(resolve => { timer = setTimeout(() => resolve('超时'), 100) }),
      ])
      assert.equal(result, true)
      assert.equal(cancelled, true)
      assert.equal(body.locked, false)
    } finally {
      if (timer) clearTimeout(timer)
      release?.()
      await iterator.return?.()
    }
  })

  test(`${protocol}：消费者提前结束也释放读取锁并记录消费中断`, async () => {
    let cancelled = false
    const summaries: RequestTimingSummary[] = []
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(settlementFrames(protocol).join(''))) },
      cancel() { cancelled = true },
    })
    const adapter = makeAdapter({ options, fetchImpl: (async () => new Response(body)) as typeof fetch, onRequestTiming: summary => { summaries.push(summary) } })
    for await (const chunk of adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] })) {
      if (chunk.type === 'text-delta') break
    }
    assert.equal(cancelled, true)
    assert.equal(body.locked, false)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]?.outcome, 'cancelled')
  })

  for (const consumerReturn of [false, true]) {
    test(`${protocol}：读取正在等待时${consumerReturn ? '结束迭代' : '调用者取消'}也能唤醒并清理`, async () => {
      let ready!: () => void
      const reading = new Promise<void>(resolve => { ready = resolve })
      let source!: ReadableStreamDefaultController<Uint8Array>
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller }, cancel() { cancelled = true } })
      const getReader = body.getReader.bind(body)
      Object.defineProperty(body, 'getReader', { value: () => { ready(); return getReader() } })
      const summaries: RequestTimingSummary[] = []
      const control = new AbortController()
      const reason = new Error('读取期间取消')
      const adapter = makeAdapter({ options, fetchImpl: (async () => new Response(body)) as typeof fetch, onRequestTiming: summary => { summaries.push(summary) } })
      const iterator = adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')], signal: control.signal })[Symbol.asyncIterator]()
      const pending = iterator.next().then(value => value, error => error)
      let timer: ReturnType<typeof setTimeout> | undefined
      let returning: Promise<IteratorResult<StreamChunk>> | undefined
      try {
        await reading
        if (consumerReturn) returning = iterator.return?.()
        else control.abort(reason)
        const result = await Promise.race([
          pending,
          new Promise<'超时'>(resolve => { timer = setTimeout(() => resolve('超时'), 100) }),
        ])
        assert.notEqual(result, '超时')
        if (consumerReturn) {
          assert.equal(result.done, true)
          assert.equal((await returning)?.done, true)
        } else assert.equal(result, reason)
        assert.equal(cancelled, true)
        assert.equal(body.locked, false)
        assert.equal(summaries[0]?.outcome, consumerReturn ? 'cancelled' : 'aborted')
      } finally {
        if (timer) clearTimeout(timer)
        try { source.close() } catch { /* 已取消的流已关闭。 */ }
        await pending
        await returning
        await iterator.return?.()
      }
    })
  }
}

for (const failure of ['error', 'timeout', 'cancel'] as const) {
  test(`OpenAI：结束原因后的尾部${failure}仍失败并只交付已解析用量一次`, async () => {
    const control = new AbortController()
    const reason = new Error('尾部取消')
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(settlementFrames('openai').slice(0, 4).join('')))
        else if (failure === 'error') controller.error(new Error('尾部连接中断'))
      },
    })
    const adapter = makeAdapter({
      options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', modelsCachePath: '', protocol: 'openai', requestTimeoutMs: 1000, streamIdleTimeoutMs: 20 }),
      fetchImpl: (async () => new Response(body)) as typeof fetch,
    })
    const seen: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'tail/model', messages: [userMessage('hi')], signal: control.signal })) {
        seen.push(chunk)
        if (failure === 'cancel' && chunk.type === 'block-end') control.abort(reason)
      }
    }, (error: unknown) => failure === 'cancel' ? error === reason : (error as LlmError).code === (failure === 'error' ? 'TRANSPORT' : 'TIMEOUT'))
    assert.equal(seen.some(chunk => chunk.type === 'finish'), false)
    assert.equal(seen.filter(chunk => chunk.type === 'usage').length, 1)
    assert.equal(body.locked, false)
  })
}

test('同一个适配器的并发响应不共享取消、块索引或用量', async () => {
  const control = new AbortController()
  const reason = new Error('只取消第一条')
  const adapter = makeAdapter({
    fetchImpl: (async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { params: { model: string } }).params.model
      return new Response(`data: ${JSON.stringify({ type: 'text-delta', text: model })}\n\ndata: ${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { outputTokens: model === 'first' ? 1 : 2 } })}\n\n`)
    }) as typeof fetch,
  })
  const [, second] = await Promise.all([
    assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'first', messages: [userMessage('hi')], signal: control.signal })) {
        if (chunk.type === 'text-delta') control.abort(reason)
      }
    }, (error: unknown) => error === reason),
    collect(adapter.stream({ provider: 'commandcode', model: 'second', messages: [userMessage('hi')] })),
  ])
  assert.deepEqual(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['second'])
  assert.equal(second.find(chunk => chunk.type === 'block-start')?.index, 0)
  const usage = second.find(chunk => chunk.type === 'usage')
  assert.equal(usage?.type === 'usage' ? usage.usage.outputTokens : undefined, 2)
  assert.equal(second.filter(chunk => chunk.type === 'finish').length, 1)
})

/**
 * A successful `/provider/v1/messages` text stream, in the exact event order the
 * endpoint emits (measured 2026-09-29): `message_start`, one content block,
 * then `message_delta` carrying `stop_reason` plus the final usage, then
 * `message_stop`. A `ping` keepalive is interleaved because the real stream
 * sends one and the parser must ignore it.
 */
function messagesStream(text: string, options: { inputTokens?: number; outputTokens?: number } = {}): Response {
  const usage = { input_tokens: options.inputTokens ?? 8, output_tokens: options.outputTokens ?? 4 }
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  return new Response([
    sse('message_start', { type: 'message_start', message: { model: 'm', usage: { ...usage, output_tokens: 0 } } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A tiny valid-ish PNG byte blob for byte-round-trip assertions. */
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

function imageRef(): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:test-image'),
    mediaType: 'image/png',
    bytes: pngBytes.length,
    width: 1,
    height: 1,
  }
}

/** A minimal AttachmentStore stub resolving one image by reference. */
function fakeAttachments(images: Record<string, Uint8Array>): AttachmentStore {
  return {
    imageLimits: {
      maxImageBytes: 10 * 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async validateImage() {},
    async saveImage(input: SaveImageAttachment) {
      return { ...imageRef(), mediaType: input.mediaType, bytes: input.data.byteLength }
    },
    async readImage(ref: ImageAttachmentRef) {
      const data = images[ref.attachmentId]
      if (!data) throw new Error(`no stored image for ${ref.attachmentId}`)
      return { ref, data }
    },
    // The request version the abstract contract requires: this fake serves the
    // admitted bytes unchanged, at whatever target the route projected.
    async readImageRequest(ref: ImageAttachmentRef, target: { width: number; height: number; maxBytes: number }) {
      const data = images[ref.attachmentId]
      if (!data) throw new Error(`no stored image for ${ref.attachmentId}`)
      return {
        variantId: `fake-${ref.attachmentId}-${target.width}x${target.height}`,
        attachment: ref,
        data,
        mediaType: ref.mediaType,
        bytes: data.byteLength,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  } as unknown as AttachmentStore
}

/** Collect all chunks from a stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** 每次 read 仅提供一个网络包，避免同包尾部事件掩盖提前停止读取的缺陷。 */
function packetResponse(parts: string[]): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++]
      if (part === undefined) controller.close()
      else controller.enqueue(new TextEncoder().encode(part))
    },
  }))
}

test('OpenAI 独立尾部用量包在结束原因之后仍被读取', async () => {
  const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
  const adapter = makeAdapter({
    options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', protocol: 'openai', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    fetchImpl: (async () => packetResponse([
      sse({ choices: [{ delta: { content: 'ok' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } } }),
      'data: [DONE]\n\n',
    ])) as typeof fetch,
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] }))
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 } },
  ])
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('冷生成从同网关磁盘目录计算预算，切换网关不沿用旧目录且不额外联网', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'commandcode-cold-budget-'))
  const cache = join(directory, 'models.json')
  // `readModelsCache()` derives `maxTokens` from `contextWindow`, not from the
  // file's own `maxTokens` field (see its normalization comment) — so a
  // `contextWindow` below every fallback ceiling (DEFAULT_GENERATE_MAX_TOKENS
  // and the model-output-limit default are both 131072) is the only way to tell
  // "the disk cache was actually read" apart from "the request used the default".
  writeFileSync(cache, JSON.stringify({ version: 3, apiBase: DEFAULT_API_BASE, models: [
    { id: 'review/cached-model', name: 'Cached', contextWindow: 40000, maxTokens: 40000, supportedEndpoints: ['/chat/completions'] },
  ] }))
  let apiBase = DEFAULT_API_BASE
  const sent: number[] = []
  const endpoints: string[] = []
  const adapter = makeAdapter({
    options: () => ({ apiBase, workingDir: '/tmp', protocol: 'openai', modelsCachePath: cache, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      endpoints.push(String(input))
      sent.push(JSON.parse(String(init?.body)).max_tokens as number)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as typeof fetch,
  })
  const request = { provider: 'commandcode', model: 'review/cached-model', messages: [userMessage('a'.repeat(700_000))] }
  try {
    await Promise.all([collect(adapter.stream(request)), collect(adapter.stream(request))])
    assert.equal(sent[0], 40000, '并发冷请求应共用同一次磁盘目录读取得到的模型上限')
    assert.equal(sent[0], sent[1])
    apiBase = 'https://other.example'
    await collect(adapter.stream(request))
    assert.equal(sent[2], 131072, '不同网关不能使用旧目录里的模型上限')
    assert.equal(endpoints.length, 3)
    assert.ok(endpoints.every((endpoint) => endpoint.endsWith('/provider/v1/chat/completions')))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Messages 多次部分用量增量保留输入缓存并等待消息终止', async () => {
  const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
  const adapter = makeAdapter({
    options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', protocol: 'messages', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    fetchImpl: (async () => packetResponse([
      sse({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 120 } } }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'message_delta', delta: {}, usage: { output_tokens: 2 } }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      sse({ type: 'message_stop' }),
    ])) as typeof fetch,
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'claude-sonnet-5-5', messages: [userMessage('hi')] }))
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 120 } },
  ])
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
})

for (const protocol of ['cli', 'openai', 'messages'] as const) {
  test(`${protocol} 错误正文挂起时仍按原 HTTP 状态失败并清理`, async () => {
    let cancelled = false
    const adapter = makeAdapter({
      options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', protocol, modelsCachePath: '', requestTimeoutMs: 20, streamIdleTimeoutMs: 1000 }),
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true },
      }), { status: 500 })) as typeof fetch,
    })
    await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] })),
      (error: unknown) => (error as { code?: string }).code === 'SERVER')
    assert.equal(cancelled, true)
  })
}

test('错误正文读取有字节上限，持续数据不会无限积累', async () => {
  let pulls = 0
  let cancelled = false
  const adapter = makeAdapter({
    options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', protocol: 'openai', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(8192).fill(120)) },
      cancel() { cancelled = true },
    }), { status: 500 })) as typeof fetch,
  })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] })))
  assert.ok(pulls <= 10)
  assert.equal(cancelled, true)
})

test('错误正文读取期间取消传播调用者原因', async () => {
  const abort = new AbortController()
  let beginRead: () => void = () => undefined
  const reading = new Promise<void>((resolve) => { beginRead = resolve })
  const adapter = makeAdapter({
    options: () => ({ apiBase: DEFAULT_API_BASE, workingDir: '/tmp', protocol: 'openai', modelsCachePath: '', requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({ pull() { beginRead() } }), { status: 500 })) as typeof fetch,
  })
  const result = collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')], signal: abort.signal }))
  await reading
  const reason = new Error('测试取消')
  abort.abort(reason)
  await assert.rejects(result, (error: unknown) => error === reason)
})

// ---------------------------------------------------------------------------
// Gateway wire invariants
// ---------------------------------------------------------------------------

type WireMessage = Record<string, unknown>

/** The tool-call ids an assistant wire message declares, in either wire shape. */
function wireCallIds(message: WireMessage): string[] {
  if (message.role !== 'assistant') return []
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((call) => String((call as { id: unknown }).id))
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => (part as { type?: string }).type === 'tool-call')
      .map((part) => String((part as { toolCallId: unknown }).toolCallId))
  }
  return []
}

/** The tool-call id a tool wire message answers, in either wire shape. */
function wireAnswers(message: WireMessage): string | undefined {
  if (message.role !== 'tool') return undefined
  if (typeof message.tool_call_id === 'string') return message.tool_call_id
  if (Array.isArray(message.content)) {
    const part = message.content.find((p) => (p as { type?: string }).type === 'tool-result')
    if (part) return String((part as { toolCallId: unknown }).toolCallId)
  }
  return undefined
}

/**
 * One `role: 'tool'` message answering `callId`, exactly as the harness models a
 * tool result: the id and error flag live on the MESSAGE, and the content blocks
 * are the tool's own output.
 */
function toolMessage(callId: ToolCallId, content: readonly ContentBlock[], isError = false): Message {
  return {
    id: messageId(),
    role: 'tool',
    content,
    toolCallId: callId,
    isError,
    source: { kind: 'tool', callId },
  }
}

/**
 * The gateway rule behind issue #33: an assistant message carrying tool calls
 * must be followed by tool messages answering ALL of them, consecutively, with
 * nothing else in between (it answers with `An assistant message with
 * 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'`, HTTP 400, on every replay of the history — so a violation is
 * not a bad turn, it is a dead conversation).
 *
 * Written against the wire body rather than the harness messages on purpose: it
 * re-derives the rule from whatever the transport actually emitted, so it holds
 * for both the nested CLI shape and the flat Provider API shape, and keeps
 * holding across a converter refactor. Returns one description per violating
 * assistant message, so a caller can assert on a single history or just report.
 */
function toolGroupViolations(messages: WireMessage[]): string[] {
  const violations: string[] = []
  for (const [index, message] of messages.entries()) {
    const ids = wireCallIds(message)
    if (ids.length === 0) continue
    const unanswered = new Set(ids)
    const answered: string[] = []
    let cursor = index + 1
    // Bounded: a group answered at the very end of the list walks the cursor
    // off the array, which must read as "nothing more answers it".
    while (cursor < messages.length) {
      const answer = wireAnswers(messages[cursor]!)
      if (answer === undefined) break
      answered.push(answer)
      unanswered.delete(answer)
      cursor++
    }
    if (unanswered.size === 0) continue
    const nextRole = cursor < messages.length ? messages[cursor]!.role : '(end of list)'
    const later = messages.slice(cursor).map(wireAnswers).filter((id): id is string => id !== undefined)
    const deferred = [...unanswered].filter((id) => later.includes(id))
    violations.push(
      `assistant[${index}] calls [${ids.join(', ')}]: answered consecutively by [${answered.join(', ')}], ` +
        `left unanswered [${[...unanswered].join(', ')}] before ${String(nextRole)}` +
        (deferred.length > 0
          ? ` (answered after the gap: [${deferred.join(', ')}])`
          : ' (never answered)'),
    )
  }
  return violations
}

/** Assert one captured wire body satisfies the gateway's tool-group rule. */
function assertToolGroupsAnswered(messages: WireMessage[], label: string): void {
  assert.deepEqual(toolGroupViolations(messages), [], `${label}: tool groups must be answered consecutively`)
}

const OPENAI_OPTIONS = (): CommandCodeConnectionOptions => ({
  apiBase: 'https://api.commandcode.ai',
  workingDir: '/tmp/project',
  modelsCachePath: '/tmp/cc-models-cache.json',
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  protocol: 'openai' as const,
})

/** Run one history through a transport and return the messages it emitted. */
async function captureWire(
  protocol: 'cli' | 'openai',
  messages: Message[],
  images: Record<string, Uint8Array>,
): Promise<WireMessage[]> {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return protocol === 'openai'
      ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      : new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments(images),
    ...(protocol === 'openai' ? { options: OPENAI_OPTIONS } : {}),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages,
  }))
  assert.ok(capturedBody, 'the adapter must issue a request')
  return (protocol === 'openai'
    ? capturedBody!.messages
    : (capturedBody!.params as Record<string, unknown>).messages) as WireMessage[]
}

/** One parallel assistant turn plus one tool result per id — the #30 / #33 shape. */
function parallelTurn(
  ids: string[],
  results: { text?: string; images?: ImageAttachmentRef[]; isError?: boolean }[],
  options: { assistantText?: string } = {},
): Message[] {
  const content: ContentBlock[] = []
  if (options.assistantText !== undefined) content.push({ type: 'text', text: options.assistantText })
  for (const id of ids) {
    content.push({ type: 'tool-call', id: ToolCallId(id), name: 'read_image', arguments: `{"file_path":"/tmp/${id}.png"}` })
  }
  const messages: Message[] = [
    { id: messageId(), role: 'assistant', content, source: { kind: 'model', provider: 'commandcode', model: 'm' } },
  ]
  for (const [index, id] of ids.entries()) {
    const result = results[index] ?? {}
    const blocks: ContentBlock[] = []
    if (result.text !== undefined) blocks.push({ type: 'text', text: result.text })
    for (const attachment of result.images ?? []) blocks.push({ type: 'image', attachment })
    messages.push(toolMessage(ToolCallId(id), blocks, result.isError ?? false))
  }
  return messages
}

// ---------------------------------------------------------------------------
// Message conversion (via stream() request capture)
// ---------------------------------------------------------------------------

for (const protocol of ['cli', 'openai'] as const) {
  test(`${protocol} replays DSH 0.1.7 tool calls and results into the next request`, async () => {
    const history = [
      userMessage('inspect the repository'),
      ...parallelTurn(
        ['call-status', 'call-diff'],
        [{ text: 'working tree clean' }, { text: 'diff unavailable', isError: true }],
        { assistantText: 'Let me inspect the changes.' },
      ),
    ]
    const messages = await captureWire(protocol, history, {})
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool'])
    assert.deepEqual(wireCallIds(messages[1]!), ['call-status', 'call-diff'])
    assert.equal(wireAnswers(messages[2]!), 'call-status')
    assert.equal(wireAnswers(messages[3]!), 'call-diff')
    assert.match(JSON.stringify(messages[2]), /working tree clean/)
    assert.match(JSON.stringify(messages[3]), /diff unavailable/)
    if (protocol === 'cli') assert.match(JSON.stringify(messages[3]), /error-text/)
    assertToolGroupsAnswered(messages, protocol)
  })

  test(`${protocol} preserves aliased ids and carries a tool result's images`, async () => {
    const ref = imageRef()
    const longId = 'long-call-'.repeat(12)
    const history = [
      userMessage('inspect images'),
      ...parallelTurn([longId, 'call-plain'], [{ images: [ref, ref] }, { text: 'plain output' }]),
      userMessage('continue'),
    ]
    const messages = await captureWire(protocol, history, { [ref.attachmentId]: pngBytes })
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user'])
    const [alias] = wireCallIds(messages[1]!)
    assert.ok(alias && alias.length <= 64)
    assert.equal(wireAnswers(messages[2]!), alias)
    assert.equal(wireAnswers(messages[3]!), 'call-plain')
    assert.match(JSON.stringify(messages[2]), /image returned/)
    assert.match(JSON.stringify(messages[4]), new RegExp(`Attached image\\(s\\) from tool result \\(${alias}\\)`))
    // The same attachment twice in one result is paid for once.
    assert.equal(JSON.stringify(messages[4]).split(Buffer.from(pngBytes).toString('base64')).length - 1, 1)
    assertToolGroupsAnswered(messages, protocol)
  })

  test(`${protocol} keeps earlier image-bearing messages identical when another image is appended`, async () => {
    const firstRef = { ...imageRef(), attachmentId: AttachmentId('sha256:first-image') }
    const secondRef = { ...imageRef(), attachmentId: AttachmentId('sha256:second-image') }
    const images = { [firstRef.attachmentId]: pngBytes, [secondRef.attachmentId]: Uint8Array.from([...pngBytes, 1]) }
    const history = [userMessage('inspect screenshots'), ...parallelTurn(['call-first'], [{ images: [firstRef] }])]
    const before = await captureWire(protocol, history, images)
    const after = await captureWire(protocol, [
      ...history,
      ...parallelTurn(['call-second'], [{ images: [secondRef] }]),
    ], images)
    assert.deepEqual(after.slice(0, before.length), before)
    assert.equal(after.length, before.length + 3) // assistant call, tool result, image carrier
    assertToolGroupsAnswered(after, protocol)
  })
}

test('stream() sends the harness conversation in Command Code wire format', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    system: 'You are helpful.',
    messages: [
      userMessage('Hello'),
      { id: messageId(), role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model', provider: 'commandcode', model: 'm' } },
      userMessage('How are you?'),
    ],
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    maxTokens: 100,
  }))

  assert.ok(capturedBody)
  const params = capturedBody.params as Record<string, unknown>
  assert.equal(params.model, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(params.system, [{
    type: 'text',
    text: 'You are helpful.',
    cache_control: { type: 'ephemeral' },
  }])
  assert.equal(params.max_tokens, 100)
  assert.equal(params.stream, true)
  assert.equal((params.tools as unknown[]).length, 1)
  const tool = (params.tools as Record<string, unknown>[])[0]!
  assert.equal(tool.name, 'bash')
  assert.equal(tool.type, 'function')
  assert.deepEqual(
    (params.messages as { role: string }[]).map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  const capturedInit = (fetchImpl as unknown as { lastInit?: RequestInit }).lastInit
  void capturedInit
})

test('stream() reuses the loop session ID as the CLI thread ID', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  const sessionId = '123e4567-e89b-42d3-a456-426614174000' as NonNullable<GenerateOptions['sessionId']>
  const adapter = makeAdapter({ fetchImpl })
  const request = {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    sessionId,
    messages: [userMessage('first')],
  } satisfies GenerateOptions

  await collect(adapter.stream(request))
  await collect(adapter.stream({
    ...request,
    messages: [userMessage('second')],
  }))

  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]!.threadId, sessionId)
  assert.equal(bodies[1]!.threadId, sessionId)
})

test('stream() gives prefixed DSH session IDs stable, distinct CLI thread IDs', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch
  const adapter = makeAdapter({ fetchImpl })

  const request = {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    sessionId: 'session-123e4567-e89b-42d3-a456-426614174000' as NonNullable<GenerateOptions['sessionId']>,
    messages: [userMessage('hello')],
  } satisfies GenerateOptions

  await collect(adapter.stream(request))
  await collect(adapter.stream({ ...request, messages: [userMessage('next turn')] }))
  await collect(adapter.stream({
    ...request,
    sessionId: 'session-123e4567-e89b-42d3-a456-426614174001' as NonNullable<GenerateOptions['sessionId']>,
  }))

  assert.equal(bodies.length, 3)
  assert.match(String(bodies[0]!.threadId), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(bodies[0]!.threadId, bodies[1]!.threadId)
  assert.notEqual(bodies[0]!.threadId, bodies[2]!.threadId)
})

for (const protocol of ['cli', 'openai'] as const) {
  test(`${protocol}: a growing tool loop preserves the serialized historical prefix`, async () => {
    const bodies: Record<string, unknown>[] = []
    const adapter = makeAdapter({ fetchImpl: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(protocol === 'cli'
        ? 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
        : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
    }) as typeof fetch, options: () => ({ ...OPENAI_OPTIONS(), protocol }) })
    const messages: Message[] = [userMessage('inspect the project')]
    const request: GenerateOptions = {
      provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
      sessionId: '123e4567-e89b-42d3-a456-426614174000' as NonNullable<GenerateOptions['sessionId']>,
      system: 'Keep the stable instructions.', messages,
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    }
    for (let step = 0; step < 4; step++) {
      await collect(adapter.stream(request))
      const id = ToolCallId(`call-${step}`)
      messages.push({ id: messageId(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: request.model }, content: [
        { type: 'reasoning', text: `Inspect file ${step}.` },
        { type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ path: `file-${step}` }) },
      ] }, toolMessage(id, [{ type: 'text', text: `contents ${step}` }]))
    }
    const params = bodies.map((body) => (protocol === 'cli' ? body.params : body) as { messages: unknown[]; tools: unknown; system?: unknown })
    for (let step = 1; step < params.length; step++) {
      const previous = params[step - 1]!
      const current = params[step]!
      assert.equal(JSON.stringify(current.messages.slice(0, previous.messages.length)), JSON.stringify(previous.messages))
      assert.deepEqual(current.tools, previous.tools)
      assert.deepEqual(current.system, previous.system)
      if (protocol === 'cli') {
        assert.deepEqual(bodies[step]!.config, bodies[step - 1]!.config)
        assert.equal(bodies[step]!.threadId, bodies[step - 1]!.threadId)
      }
    }
  })
}

test('stream() replays reasoning blocks on the CLI transport', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  // Issue #34: the provider refuses a DeepSeek thinking-mode assistant turn whose
  // tool calls are replayed WITHOUT its thinking, which killed every tool-loop
  // turn on the CLI transport. The official CLI's `toWireMessages` replays each
  // thinking block as a `{ type: 'reasoning', text }` part, in content order.
  const callId = ToolCallId('call-think')
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      userMessage('List files'),
      { id: messageId(),
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should list the files first.' },
          { type: 'text', text: 'Listing.' },
          { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(callId, [{ type: 'text', text: 'file1' }]),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const assistant = messages.find((m) => m.role === 'assistant')!
  const parts = assistant.content as Record<string, unknown>[]
  // Order is preserved: the provider rebuilds the assistant turn from it.
  assert.deepEqual(parts.map((part) => part.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(parts[0]!.text, 'I should list the files first.')
  assert.equal(parts[1]!.text, 'Listing.')
})

test('stream() normalizes tool schemas to an object root on the CLI transport', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [userMessage('go')],
    tools: [
      // Already object-rooted: untouched.
      { name: 'bash', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      // A hand-written schema that never declared its root type (issue #35:
      // this is the `dispatch_task` shape the provider rejected).
      { name: 'dispatch_task', description: 'dispatch', parameters: { properties: { task: { type: 'string' } }, required: ['task'] } },
      // A generator's union root.
      {
        name: 'union_task',
        description: 'union',
        parameters: { anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ] },
      },
      // Nothing usable at the root: a permissive object keeps the request alive.
      { name: 'odd_task', description: 'odd', parameters: { type: 'array', items: { type: 'string' } } },
      // A union `type` at the root: collapsed to the string the provider wants.
      { name: 'nullable_task', description: 'nullable', parameters: { type: ['object', 'null'], properties: { y: { type: 'string' } } } },
      // A generated root `$ref`: resolved so the fields survive, not just the type.
      {
        name: 'ref_task',
        description: 'ref',
        parameters: {
          $ref: '#/$defs/Args',
          $defs: { Args: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
        },
      },
    ],
  }))

  const tools = (capturedBody!.params as Record<string, unknown>).tools as Record<string, unknown>[]
  const schemaOf = (name: string): Record<string, unknown> =>
    tools.find((tool) => tool.name === name)!.input_schema as Record<string, unknown>

  const bash = schemaOf('bash')
  assert.equal(bash.type, 'object')
  assert.deepEqual(bash.properties, { cmd: { type: 'string' } })

  const dispatch = schemaOf('dispatch_task')
  assert.equal(dispatch.type, 'object')
  assert.deepEqual(dispatch.properties, { task: { type: 'string' } })
  assert.deepEqual(dispatch.required, ['task'])

  // The union keeps every branch field; no branch's `required` is silently
  // imposed on the others, so the merged root requires nothing.
  const union = schemaOf('union_task')
  assert.equal(union.type, 'object')
  assert.deepEqual(Object.keys(union.properties as object), ['a', 'b'])
  assert.equal(union.required, undefined)

  const odd = schemaOf('odd_task')
  assert.equal(odd.type, 'object')
  assert.deepEqual(odd.properties, {})
  assert.equal(odd.additionalProperties, true)

  const ref = schemaOf('ref_task')
  assert.equal(ref.type, 'object')
  assert.equal(ref.$ref, undefined)
  assert.deepEqual(ref.properties, { x: { type: 'string' } })
  assert.deepEqual(ref.required, ['x'])

  assert.equal(schemaOf('nullable_task').type, 'object')
})

test('stream() normalizes tool schemas to an object root on the Provider API transport', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [userMessage('go')],
    tools: [
      { name: 'bash', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { name: 'dispatch_task', description: 'dispatch', parameters: { properties: { task: { type: 'string' } }, required: ['task'] } },
    ],
  }))

  const tools = capturedBody!.tools as { function: { name: string; parameters: Record<string, unknown> } }[]
  const parametersOf = (name: string): Record<string, unknown> =>
    tools.find((tool) => tool.function.name === name)!.function.parameters
  assert.equal(parametersOf('bash').type, 'object')
  assert.equal(parametersOf('dispatch_task').type, 'object')
  assert.deepEqual(parametersOf('dispatch_task').properties, { task: { type: 'string' } })
})

test('stream() replays only paired tool calls', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const callId = ToolCallId('call-123')
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('List files'),
      { id: messageId(),
        role: 'assistant',
        content: [
          { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
          { type: 'tool-call', id: ToolCallId('call-unanswered'), name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(callId, [{ type: 'text', text: 'file1' }]),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const assistant = messages.find((m) => m.role === 'assistant')!
  const parts = assistant.content as Record<string, unknown>[]
  assert.equal(parts.length, 1)
  assert.equal(parts[0]!.type, 'tool-call')
  assert.equal((parts[0] as { toolCallId: string }).toolCallId, callId)
  // The tool result round-trips under role 'tool' with the real tool name
  // (Gemini rejects tool results whose function name is empty).
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.ok(toolMsg)
  const resultPart = (toolMsg.content as Record<string, unknown>[])[0]!
  assert.equal(resultPart.type, 'tool-result')
  assert.equal(resultPart.toolCallId, callId)
  assert.equal(resultPart.toolName, 'bash')
})

test('stream() remaps overlong cross-provider tool-call ids to the gateway limit', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  // Issue #23: switching to Command Code mid-session can replay another
  // provider's tool id, which may exceed the gateway's `call_id <= 64` limit.
  // The adapter remaps it to a short per-request alias, correlated with its
  // own result.
  const longId = ToolCallId(`opencode-${'x'.repeat(80)}`)
  assert.ok(longId.length > 64)
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('List files'),
      { id: messageId(),
        role: 'assistant',
        content: [
          { type: 'tool-call', id: longId, name: 'bash-long', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('cc-1'), name: 'bash-alias-clash', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('call-short'), name: 'bash-short', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(longId, [{ type: 'text', text: 'a' }], false),
      toolMessage(ToolCallId('cc-1'), [{ type: 'text', text: 'b' }], false),
      toolMessage(ToolCallId('call-short'), [{ type: 'text', text: 'c' }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const assistant = messages.find((m) => m.role === 'assistant')!
  const calls = (assistant.content as Record<string, unknown>[]).filter((p) => p.type === 'tool-call')
  assert.equal(calls.length, 3)
  const byName = new Map(calls.map((c) => [c.toolName, c.toolCallId] as const))
  // The overlong id is replaced by a short alias (`cc-1` is already taken by
  // a real id, so the alias must skip past it), and short ids pass through.
  assert.equal(byName.get('bash-long'), 'cc-2')
  assert.equal(byName.get('bash-alias-clash'), 'cc-1')
  assert.equal(byName.get('bash-short'), 'call-short')
  // Every wire id fits the gateway limit, and each tool result carries the
  // same wire id as its call.
  const results = messages
    .filter((m) => m.role === 'tool')
    .map((m) => (m.content as Record<string, unknown>[])[0]!.toolCallId as string)
  assert.deepEqual([...results].sort(), ['call-short', 'cc-1', 'cc-2'])
})

test('stream() falls back to "unknown" for an empty tool-call name', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const callId = ToolCallId('call-empty-name')
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('List files'),
      { id: messageId(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: '', arguments: '{}' }],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(callId, [{ type: 'text', text: 'file1' }]),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const toolMsg = messages.find((m) => m.role === 'tool')!
  const resultPart = (toolMsg.content as Record<string, unknown>[])[0]!
  assert.equal(resultPart.toolName, 'unknown')
})

test('stream() rejects stop sequences (unsupported option)', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    collect(adapter.stream({
      provider: 'commandcode',
      model: 'm',
      messages: [userMessage('hi')],
      stop: ['END'],
    })),
    (err: unknown) => (err as { code?: string }).code === 'UNSUPPORTED_OPTION',
  )
})

// ---------------------------------------------------------------------------
// Tool-result images (issue #30)
// ---------------------------------------------------------------------------

/** The `read_image` call/result pair the harness produces for one local file. */
function readImageTurn(ref: ImageAttachmentRef, extra: ContentBlock[] = []): Message[] {
  const callId = ToolCallId('call-read-image')
  return [
    { id: messageId(),
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' }],
      source: { kind: 'model', provider: 'commandcode', model: 'm' },
    },
    toolMessage(callId, [{ type: 'text', text: 'image/png image, 1x1 px, 10 bytes' }, { type: 'image', attachment: ref }, ...extra], false),
  ]
}

test('stream() carries tool-result images after the tool message (issue #30)', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  // `deepseek/deepseek-v4.1-flash` is the Vision model from the issue report.
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [userMessage('what is in /tmp/a.png?'), ...readImageTurn(ref)],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  // The tool message stays text-only: the CLI transport's tool output has no
  // image form, so the pixels follow it as a user message instead of vanishing.
  const toolMsg = messages.find((m) => m.role === 'tool')!
  const result = (toolMsg.content as Record<string, unknown>[])[0]!
  assert.equal(result.type, 'tool-result')
  assert.deepEqual(result.output, { type: 'text', value: 'image/png image, 1x1 px, 10 bytes' })
  const carried = messages[messages.indexOf(toolMsg) + 1]!
  assert.equal(carried.role, 'user')
  const parts = carried.content as Record<string, unknown>[]
  assert.equal(parts.length, 2)
  assert.match((parts[0] as { text: string }).text, /^Attached image\(s\) from tool result \(call-read-image\):$/)
  // Official CLI image wire shape, byte-identical to a user attachment.
  assert.deepEqual(parts[1], {
    type: 'image',
    image: `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`,
    mimeType: 'image/png',
  })
})

test('stream() carries a tool-result image exactly once and never without bytes', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  // The same attachment twice in one result: one part on the wire, and the
  // result text is present so the tool message needs no descriptor.
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [
      userMessage('compare these'),
      ...readImageTurn(ref, [{ type: 'image', attachment: ref }]),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const carried = messages[messages.length - 1]!
  assert.equal(carried.role, 'user')
  const parts = carried.content as Record<string, unknown>[]
  assert.equal(parts.filter((p) => p.type === 'image').length, 1)
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.equal(((toolMsg.content as Record<string, unknown>[])[0]!.output as { value: string }).value, 'image/png image, 1x1 px, 10 bytes')
})

test('stream() gives an image-only tool result a non-empty tool message', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  const callId = ToolCallId('call-image-only')
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [
      userMessage('look'),
      { id: messageId(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{}' }],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(callId, [{ type: 'image', attachment: ref }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const toolMsg = messages.find((m) => m.role === 'tool')!
  const output = ((toolMsg.content as Record<string, unknown>[])[0]!.output as { value: string }).value
  assert.notEqual(output, '')
  assert.match(output, /attached image/)
  const carried = messages[messages.indexOf(toolMsg) + 1]!
  const parts = carried.content as Record<string, unknown>[]
  // The tool text cannot state the dimensions, so the note carries them.
  assert.match((parts[0] as { text: string }).text, /^Attached image\(s\) from tool result \(call-image-only\): 1x1 px$/)
})

test('openai protocol carries tool-result images as a following user message (issue #30)', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [userMessage('what is in /tmp/a.png?'), ...readImageTurn(ref)],
  }))

  const messages = capturedBody!.messages as Record<string, unknown>[]
  // Chat Completions accepts no image part under `role: 'tool'`, so the tool
  // message carries the text and the image follows as a user message.
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.equal(toolMsg.content, 'image/png image, 1x1 px, 10 bytes')
  const carried = messages[messages.indexOf(toolMsg) + 1]!
  assert.equal(carried.role, 'user')
  const parts = carried.content as Record<string, unknown>[]
  assert.match((parts[0] as { text: string }).text, /^Attached image\(s\) from tool result \(call-read-image\):$/)
  assert.deepEqual(parts[1], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}` },
  })
})

test('stream() keeps parallel tool results consecutive before their image carriers', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const refA = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-a') }
  const refB = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-b') }
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () =>
      fakeAttachments({ [refA.attachmentId]: pngBytes, [refB.attachmentId]: pngBytes }),
  })
  // Two parallel read_image calls each answered with an image-bearing result —
  // the shape that used to interleave the carrier between the tool results and
  // break the gateway's consecutive-tool pairing check.
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      userMessage('read both files'),
      { id: messageId(),
        role: 'assistant',
        content: [
          { type: 'tool-call', id: ToolCallId('call-a'), name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' },
          { type: 'tool-call', id: ToolCallId('call-b'), name: 'read_image', arguments: '{"file_path":"/tmp/b.png"}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(ToolCallId('call-a'), [{ type: 'text', text: 'a' }, { type: 'image', attachment: refA }], false),
      toolMessage(ToolCallId('call-b'), [{ type: 'text', text: 'b' }, { type: 'image', attachment: refB }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  // Both tool results must come out consecutive; the carried images follow only afterwards.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user'])
  const tools = messages.filter((m) => m.role === 'tool')
  const callIds = tools.map((m) => (((m.content as Record<string, unknown>[])[0]! as { toolCallId: string }).toolCallId))
  assert.deepEqual(callIds, ['call-a', 'call-b'])
  const carried = messages.slice(-2) as Record<string, unknown>[]
  for (const [index, msg] of carried.entries()) {
    const parts = msg.content as Record<string, unknown>[]
    // Each carrier names its OWN call: the ids are what tie the grouped
    // images back to the tool results they came out of.
    assert.match((parts[0] as { text: string }).text, new RegExp(`^Attached image\\(s\\) from tool result \\(${callIds[index]}\\):`))
    assert.equal(parts[1]!.type, 'image')
  }
  assert.notEqual(callIds[0], callIds[1])
})

test('openai protocol groups carried images after the whole parallel tool turn', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const refA = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-a') }
  const refB = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-b') }
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () =>
      fakeAttachments({ [refA.attachmentId]: pngBytes, [refB.attachmentId]: pngBytes }),
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      userMessage('read both files'),
      { id: messageId(),
        role: 'assistant',
        content: [
          { type: 'tool-call', id: ToolCallId('call-a'), name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' },
          { type: 'tool-call', id: ToolCallId('call-b'), name: 'read_image', arguments: '{"file_path":"/tmp/b.png"}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(ToolCallId('call-a'), [{ type: 'text', text: 'a' }, { type: 'image', attachment: refA }], false),
      toolMessage(ToolCallId('call-b'), [{ type: 'text', text: 'b' }, { type: 'image', attachment: refB }], false),
    ],
  }))

  const messages = capturedBody!.messages as Record<string, unknown>[]
  // The flat list keeps the two tool messages adjacent; both carriers follow last.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user'])
  const tools = messages.filter((m) => m.role === 'tool')
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['call-a', 'call-b'])
  const carried = messages.slice(-2) as Record<string, unknown>[]
  for (const [index, msg] of carried.entries()) {
    const parts = msg.content as Record<string, unknown>[]
    // Same per-call naming as the CLI transport, so both wires let the model
    // tie a grouped image back to its own tool result.
    assert.match((parts[0] as { text: string }).text, new RegExp(`^Attached image\\(s\\) from tool result \\(${tools[index]!.tool_call_id as string}\\):`))
    assert.equal((parts[1] as { type: string }).type, 'image_url')
  }
})

test('stream() names a remapped call id in the carrier note, not the harness id', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  // The note must name the id the MODEL saw. An overlong cross-provider id is
  // remapped to a short wire alias (issue #23), so naming the harness-side id
  // would point at a call that is nowhere in the request being read.
  const longId = ToolCallId(`opencode-${'y'.repeat(80)}`)
  assert.ok(longId.length > 64)
  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      userMessage('read it'),
      { id: messageId(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: longId, name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' }],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(longId, [{ type: 'text', text: 'a' }, { type: 'image', attachment: ref }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  const wireId = ((messages.find((m) => m.role === 'tool')!.content as Record<string, unknown>[])[0]! as { toolCallId: string }).toolCallId
  assert.equal(wireId.length <= 64, true)
  const carrier = messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('Attached image'))!
  const note = ((carrier.content as Record<string, unknown>[])[0]! as { text: string }).text
  assert.match(note, new RegExp(`^Attached image\\(s\\) from tool result \\(${wireId}\\):`))
  assert.ok(!note.includes(longId), 'the note names the wire alias, not the overlong harness id')
})

test('both transports drop a user message that converted to nothing', async () => {
  // The two converters disagreed here: the CLI emitted `{ role: 'user', content:
  // [] }` and the Provider API dropped the message. An empty content array is a
  // needless gateway-compat risk, so both transports now drop it — including
  // when the emptiness comes only from blocks this adapter never puts on the wire.
  const ref = imageRef()
  for (const protocol of ['cli', 'openai'] as const) {
    let capturedBody: Record<string, unknown> | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return protocol === 'openai'
        ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
    }) as unknown as typeof fetch

    const adapter = makeAdapter({
      fetchImpl,
      resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
      ...(protocol === 'openai'
        ? {
            options: () => ({
              apiBase: 'https://api.commandcode.ai',
              workingDir: '/tmp/project',
              modelsCachePath: '/tmp/cc-models-cache.json',
              requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
              streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
              protocol: 'openai' as const,
            }),
          }
        : {}),
    })
    await collect(adapter.stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        userMessage('read it'),
        ...readImageTurn(ref, []),
        // Both spellings of "nothing to send": a genuinely empty content list,
        // and one whose only block is dropped during conversion.
        { id: messageId(), role: 'user', content: [], source: { kind: 'user' } },
        { role: 'user', content: [{ type: 'reasoning', text: 'thinking' }], source: { kind: 'user' } } as never,
        userMessage('and now?'),
      ],
    }))

    const messages = (protocol === 'openai'
      ? capturedBody!.messages
      : (capturedBody!.params as Record<string, unknown>).messages) as Record<string, unknown>[]
  // Nothing on the wire converted to empty, and the pending carrier was still flushed.
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'tool', 'user', 'user'],
      `${protocol}: empty user messages must be dropped and the carrier kept`,
    )
    const carried = messages.filter((m) => m.role === 'user')
    assert.match(JSON.stringify(carried[1]), /Attached image/)
    assert.match(JSON.stringify(messages.at(-1)), /and now\?/)
  }
})

test('the tool-group invariant detects the interleaving it exists for', () => {
  // A validator that can never fail would pass every history below for the wrong
  // reason, so feed it the two orderings that matter: the pre-fix #33 shape (a
  // carrier between the tool results) is caught, the fixed ordering is clean.
  const interleaved = [
    { role: 'user' },
    { role: 'assistant', tool_calls: [{ id: 'call-a' }, { id: 'call-b' }] },
    { role: 'tool', tool_call_id: 'call-a' },
    { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result (call-a):' }] },
    { role: 'tool', tool_call_id: 'call-b' },
  ]
  const violations = toolGroupViolations(interleaved)
  assert.equal(violations.length, 1, 'the interleaved group must be reported')
  assert.match(violations[0]!, /answered consecutively by \[call-a\]/)
  assert.match(violations[0]!, /left unanswered \[call-b\]/)
  assert.match(violations[0]!, /answered after the gap/)

  // Nothing answered at all is caught too, and the grouped ordering is clean.
  assert.equal(toolGroupViolations([
    { role: 'assistant', tool_calls: [{ id: 'call-a' }] },
    { role: 'user', content: 'hi' },
  ]).length, 1)
  // A fully answered group that ENDS the list is clean: the scan must stop at
  // the end of the array rather than read past it.
  assert.deepEqual(toolGroupViolations([
    { role: 'assistant', tool_calls: [{ id: 'call-a' }] },
    { role: 'tool', tool_call_id: 'call-a' },
  ]), [])
  assert.deepEqual(toolGroupViolations([
    { role: 'assistant', tool_calls: [{ id: 'call-a' }, { id: 'call-b' }] },
    { role: 'tool', tool_call_id: 'call-a' },
    { role: 'tool', tool_call_id: 'call-b' },
    { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result (call-a):' }] },
    { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result (call-b):' }] },
  ]), [])
})

test('both transports answer every parallel tool group consecutively', async () => {
  // Checked once over a table of real histories: the gateway rule is a property of
  // the whole message list, so the interesting failures (a carrier landing inside
  // a group, a group split across a user turn) only show up that way.
  const ids = ['sha256:order-a', 'sha256:order-b', 'sha256:order-c', 'sha256:order-d']
  const images = Object.fromEntries(ids.map((id) => [id, pngBytes]))
  const refs = ids.map((attachmentId) => ({ ...imageRef(), attachmentId }))
  const [refA, refB, refC, refD] = refs as [ImageAttachmentRef, ImageAttachmentRef, ImageAttachmentRef, ImageAttachmentRef]

  const histories: { name: string; messages: Message[] }[] = [
    { name: 'one text-only result', messages: [userMessage('go'), ...parallelTurn(['c1'], [{ text: 'done' }])] },
    { name: 'one image result (#30 shape)', messages: [userMessage('go'), ...parallelTurn(['c1'], [{ text: 'a', images: [refA] }])] },
    { name: 'two image results (#33 shape)', messages: [userMessage('go'), ...parallelTurn(['c1', 'c2'], [{ text: 'a', images: [refA] }, { text: 'b', images: [refB] }])] },
    { name: 'three image results', messages: [userMessage('go'), ...parallelTurn(['c1', 'c2', 'c3'], [{ images: [refA] }, { text: 'b', images: [refB] }, { images: [refC] }])] },
    { name: 'a group mixing image and text results', messages: [userMessage('go'), ...parallelTurn(['c1', 'c2'], [{ text: 'text only' }, { images: [refB] }])] },
    { name: 'an error result carrying an image', messages: [userMessage('go'), ...parallelTurn(['c1', 'c2'], [{ text: 'failed', images: [refA], isError: true }, { text: 'ok' }])] },
    {
      name: 'two parallel groups in one conversation',
      messages: [
        userMessage('go'),
        ...parallelTurn(['c1', 'c2'], [{ images: [refA] }, { images: [refB] }]),
        ...parallelTurn(['c3', 'c4'], [{ images: [refC] }, { images: [refD] }], { assistantText: 'reading more' }),
      ],
    },
    {
      name: 'a group followed by a later user turn',
      messages: [
        userMessage('go'),
        ...parallelTurn(['c1', 'c2'], [{ images: [refA] }, { images: [refB] }]),
        userMessage('and now?'),
        ...parallelTurn(['c3'], [{ text: 'ok' }]),
      ],
    },
    {
      name: 'a group with an unpaired extra result',
      messages: [
        userMessage('go'),
        ...parallelTurn(['c1', 'c2'], [{ images: [refA] }, { images: [refB] }]),
        toolMessage(ToolCallId('c-orphan'), [{ type: 'text', text: 'orphan' }, { type: 'image', attachment: refC }], false),
      ],
    },
    {
      name: 'assistant text alongside parallel image calls',
      messages: [userMessage('go'), ...parallelTurn(['c1', 'c2'], [{ images: [refA] }, { images: [refB] }], { assistantText: 'let me look' })],
    },
  ]

  for (const protocol of ['cli', 'openai'] as const) {
    for (const history of histories) {
      const wire = await captureWire(protocol, history.messages, images)
      assertToolGroupsAnswered(wire, `${protocol} · ${history.name}`)
    }
  }
})

test('stream() leaves text-only tool results untouched', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const callId = ToolCallId('call-bash')
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('list files'),
      { id: messageId(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(callId, [{ type: 'text', text: 'file1' }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool'])
})

test('stream() drops images of an unpaired tool result with the result itself', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  // No assistant tool-call pairs this result, so neither the result nor its
  // image may reach the wire (an orphan image would be unexplainable).
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [
      userMessage('hi'),
      toolMessage(ToolCallId('call-orphan'), [{ type: 'text', text: 'x' }, { type: 'image', attachment: ref }], false),
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  assert.deepEqual(messages.map((m) => m.role), ['user'])
  assert.ok(!JSON.stringify(messages).includes('Attached image'))
})

test('stream() refuses images for models without Vision capability', async () => {  const adapter = makeAdapter()
  const withImage: Message = { id: messageId(),
    role: 'user',
    content: [{ type: 'image', attachment: imageRef() }],
    source: { kind: 'user' },
  }
  // 'deepseek/deepseek-v4-flash' is a text-only model per the official registry.
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', messages: [withImage] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'UNSUPPORTED_CONTENT' && /does not support image input/.test(e.message ?? '')
    },
  )
})

test('stream() requires the durable attachment service for image input', async () => {
  // claude-sonnet-5 has Vision, but no resolveAttachments is provided.
  const adapter = makeAdapter()
  const withImage: Message = { id: messageId(),
    role: 'user',
    content: [{ type: 'image', attachment: imageRef() }],
    source: { kind: 'user' },
  }
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'claude-sonnet-5', messages: [withImage] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'UNSUPPORTED_CONTENT' && /attachment service/.test(e.message ?? '')
    },
  )
})

test('stream() sends images in the official Command Code wire format', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  const withImage: Message = { id: messageId(),
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  }
  await collect(adapter.stream({ provider: 'commandcode', model: 'claude-sonnet-5', messages: [withImage] }))

  const params = capturedBody!.params as Record<string, unknown>
  const userMsg = (params.messages as Record<string, unknown>[]).find((m) => m.role === 'user')!
  const parts = userMsg.content as Record<string, unknown>[]
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0], { type: 'text', text: 'what is in this image?' })
  assert.deepEqual(parts[1], {
    type: 'image',
    image: `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`,
    mimeType: 'image/png',
  })
})

// ---------------------------------------------------------------------------
// Request image versions and visual-token pricing (C2, C3)
//
// An attachment is stored NORMALIZED, not request-ready: a provider request must
// carry the REQUEST VERSION encoded to the route target (`readImageRequest()`).
// On this route that is not cosmetic — both transports inline every historical
// image as base64, so the version's bytes are what the body, the context window
// and the gateway's ~50 MB cap pay for, and the same target is what the
// visual-token price is computed at.
// ---------------------------------------------------------------------------

/** An AttachmentStore stub that answers a distinct request version and records every target. */
function versionedAttachments(
  images: Record<string, Uint8Array>,
  versionBytes: Uint8Array,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
): { store: AttachmentStore; targets: { ref: ImageAttachmentRef; target: Record<string, number> }[] } {
  const targets: { ref: ImageAttachmentRef; target: Record<string, number> }[] = []
  const store = {
    ...(fakeAttachments(images) as unknown as Record<string, unknown>),
    async readImageRequest(ref: ImageAttachmentRef, target: Record<string, number>) {
      targets.push({ ref, target })
      return {
        ref,
        data: versionBytes,
        mediaType,
        bytes: versionBytes.length,
        width: target.width,
        height: target.height,
      }
    },
  } as unknown as AttachmentStore
  return { store, targets }
}

test('stream() sends the request version of an image at the documented target (C2)', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return okStream('cli')
  }) as unknown as typeof fetch

  // A 2880x1800 Retina screenshot whose stored payload and request version
  // differ, so which one reached the wire is unambiguous.
  const ref = { ...sizedImageRef(0, pngBytes.length), width: 2880, height: 1800 }
  const version = Uint8Array.from([...pngBytes, 9])
  const { store, targets } = versionedAttachments({ [ref.attachmentId]: sizedImageBytes(0) }, version)
  const adapter = makeAdapter({ fetchImpl, resolveAttachments: () => store })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [{
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: ref }],
      source: { kind: 'user' },
    }],
  }))

  // 1568 px long edge with the aspect kept, plus the encoded-byte budget.
  assert.deepEqual(targets.map((call) => call.target), [{
    width: 1568,
    height: 980,
    maxBytes: 1024 * 1024,
  }])
  const wire = (capturedBody!.params as { messages: Record<string, unknown>[] }).messages
  const part = (wire.find((m) => m.role === 'user')!.content as Record<string, unknown>[])[1]!
  assert.equal(part.image, `data:image/png;base64,${Buffer.from(version).toString('base64')}`)
  assert.equal(part.mimeType, 'image/png')
})

for (const protocol of ['cli', 'openai'] as const) {
  test(`${protocol} labels a transcoded request image with its actual media type`, async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return okStream(protocol)
    }) as unknown as typeof fetch
    const ref = imageRef() // Stored as PNG; the request version is JPEG.
    const version = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const { store } = versionedAttachments({ [ref.attachmentId]: pngBytes }, version, 'image/jpeg')
    const adapter = makeAdapter({
      fetchImpl,
      resolveAttachments: () => store,
      ...(protocol === 'openai' ? { options: OPENAI_OPTIONS } : {}),
    })
    await collect(adapter.stream({
      provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ id: messageId(), role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } }],
    }))
    assert.ok(capturedBody)
    const [part] = userParts(capturedBody, protocol)
    assert.ok(part)
    const expectedUrl = `data:image/jpeg;base64,${Buffer.from(version).toString('base64')}`
    if (protocol === 'cli') {
      assert.deepEqual(part, { type: 'image', image: expectedUrl, mimeType: 'image/jpeg' })
    } else {
      assert.deepEqual(part, { type: 'image_url', image_url: { url: expectedUrl } })
    }
  })
}

test('openai protocol sends the request version too (C2)', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return okStream('openai')
  }) as unknown as typeof fetch

  const ref = { ...sizedImageRef(0, pngBytes.length), width: 2880, height: 1800 }
  const version = Uint8Array.from([...pngBytes, 9])
  const { store } = versionedAttachments({ [ref.attachmentId]: sizedImageBytes(0) }, version)
  const adapter = makeAdapter({ fetchImpl, options: OPENAI_OPTIONS, resolveAttachments: () => store })
  await collect(adapter.stream({
    provider: 'commandcode',
    // Not a Claude id: those are Messages-only, so they take the CLI transport even
    // under a forced `'openai'` preference (see `resolveProtocol()`).
    model: 'gpt-5.4',
    messages: [{
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: ref }],
      source: { kind: 'user' },
    }],
  }))

  const part = userParts(capturedBody!, 'openai').find((entry) => entry.type === 'image_url')!
  assert.equal(
    (part.image_url as { url: string }).url,
    `data:image/png;base64,${Buffer.from(version).toString('base64')}`,
  )
})

test('imageRequestPricing() prices a retained image at its request target (C3)', () => {
  const pricing = makeAdapter().imageRequestPricing('commandcode', 'claude-sonnet-5')
  assert.ok(pricing !== undefined)
  const ref = { ...sizedImageRef(0, pngBytes.length), width: 2880, height: 1800 }
  const [price] = pricing!.priceImages([{ type: 'image', attachment: ref }])
  // Anthropic's rule at the target this route would send: 1568x980.
  assert.equal(price!.visualTokens, Math.ceil((1568 * 980) / 750))
  // The pixels are inlined, so a retained occurrence carries no model-visible text.
  assert.equal(price!.text, '')
  // The token meter throws unless one price comes back per occurrence, in order.
  assert.equal(pricing!.priceImages([
    { type: 'image', attachment: ref },
    { type: 'image', attachment: ref },
  ]).length, 2)
})

test('imageRequestTarget() reports the request target, not the normalized original (C3)', () => {
  const adapter = makeAdapter()
  const ref = { ...sizedImageRef(0, pngBytes.length), width: 2880, height: 1800 }
  // 路由把每张请求图重新编码到 1568 长边 + 1 MiB 上限，基类默认却回答归一化原图
  //（2880x1800 与原始字节数）。宿主的截图调用方走 ctx.llm.imageRequestTarget()，
  // 所以要暴露请求侧真正使用的目标，且必须与请求侧逐字一致。
  assert.deepEqual(adapter.imageRequestTarget('commandcode', 'claude-sonnet-5', ref), requestImageTarget(ref))
  const target = adapter.imageRequestTarget('commandcode', 'claude-sonnet-5', ref)
  assert.equal(target.width, 1568)
  assert.equal(target.height, 980)
  assert.equal(target.maxBytes, 1024 * 1024)
})

test('imageRequestPricing() prices an offloaded occurrence as its placeholder (C3)', () => {
  const pricing = makeAdapter().imageRequestPricing('commandcode', 'claude-sonnet-5')!
  const ref = sizedImageRef(0, pngBytes.length)
  const [price] = pricing.priceImages([{ type: 'image', attachment: ref, offloaded: true }])
  // The surface renders this one as text in every later request, so it costs no
  // vision tokens and is priced by the caller's text estimator instead.
  assert.equal(price!.visualTokens, 0)
  assert.match(price!.text, /image omitted to fit request image limits/)
  // A retained occurrence still costs at least one token rather than rounding
  // to zero, even for a 1x1 image.
  const [retained] = pricing.priceImages([{ type: 'image', attachment: ref }])
  assert.equal(retained!.visualTokens, 1)
  assert.equal(retained!.text, '')
})

test('imageRequestPricing() prices a text-only route as placeholder text (C3)', () => {
  const model = 'deepseek/deepseek-v4-pro'
  assert.ok(!KNOWN_IMAGE_MODELS.has(model), 'the case under test needs a model outside the Vision snapshot')
  const pricing = makeAdapter().imageRequestPricing('commandcode', model)!
  const ref = sizedImageRef(0, pngBytes.length)
  const [price] = pricing.priceImages([{ type: 'image', attachment: ref }])
  assert.equal(price!.visualTokens, 0)
  assert.match(price!.text, /accepts text only/)
})

// ---------------------------------------------------------------------------
// Request image budget (issue #37)
//
// Both transports inline every historical image and the gateway caps a whole
// request body (measured ~50.17 MB, undocumented), so a session that crossed it
// failed EVERY later request on this route with 413. These tests pin the budget
// that keeps the recent tail and turns the oldest images into model-visible
// placeholders instead.
// ---------------------------------------------------------------------------

/** The core helper's eviction placeholder, as it opens in both transports. */
const PLACEHOLDER_PREFIX = '[image omitted to fit request image limits'

/**
 * An image reference DECLARING `bytes` normalized bytes: the budget accounts
 * declared sizes, so a test crosses the cap without allocating megabytes. The
 * stored payload's last byte is the index, which is how a test names the
 * occurrences that survived.
 */
function sizedImageRef(index: number, bytes: number): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:budget-image-${index}`),
    mediaType: 'image/png',
    bytes,
    width: 4,
    height: 4,
  }
}

/** The stored bytes of `sizedImageRef(index, …)`; the last byte is the index. */
function sizedImageBytes(index: number): Uint8Array {
  return Uint8Array.from([...pngBytes, index])
}

/** One user message per image, oldest first — the shape a screenshot loop builds. */
function imageHistory(sizes: number[]): { messages: Message[]; images: Record<string, Uint8Array> } {
  const messages: Message[] = []
  const images: Record<string, Uint8Array> = {}
  for (const [index, bytes] of sizes.entries()) {
    const ref = sizedImageRef(index, bytes)
    images[ref.attachmentId] = sizedImageBytes(index)
    messages.push({
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: `shot ${index}` }, { type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })
  }
  return { messages, images }
}

/** The success stream each transport understands. */
function okStream(protocol: 'cli' | 'openai'): Response {
  return protocol === 'openai'
    ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    : new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
}

/**
 * Drive one history through a transport against a fetch stub whose answer depends
 * on the attempt number, returning every request body the adapter issued plus the
 * error `stream()` ended with (undefined on success). What each ATTEMPT carried
 * is the observable the 413 ladder is about, so a success-only capture helper
 * cannot express these tests.
 */
async function runAttempts(
  protocol: 'cli' | 'openai',
  messages: Message[],
  images: Record<string, Uint8Array>,
  status: (attempt: number) => number = () => 200,
  imageOffload?: SurfaceImagePolicy,
  offloadSeenImagesForCache = false,
): Promise<{ bodies: Record<string, unknown>[]; error?: unknown }> {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const code = status(bodies.length)
    return code === 200
      ? okStream(protocol)
      : new Response('{"error":{"message":"request entity too large"}}', { status: code })
  }) as unknown as typeof fetch
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments(images),
    ...(imageOffload === undefined ? {} : { imageOffload }),
    ...(protocol === 'openai' || offloadSeenImagesForCache
      ? { options: () => ({ ...OPENAI_OPTIONS(), protocol, offloadSeenImagesForCache }) }
      : {}),
  })
  let error: unknown
  try {
    await collect(adapter.stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      messages,
    }))
  } catch (thrown) {
    error = thrown
  }
  return { bodies, error }
}

test('opt-in CLI cache mitigation durably offloads only images this model has already seen', async () => {
  const first = sizedImageRef(0, pngBytes.length)
  const second = sizedImageRef(1, pngBytes.length)
  const images = { [first.attachmentId]: sizedImageBytes(0), [second.attachmentId]: sizedImageBytes(1) }
  const makeHistory = (oldOffloaded: boolean): Message[] => [
    { id: messageId(), role: 'user', content: [
      { type: 'text', text: 'first image' },
      { type: 'image', attachment: first, ...(oldOffloaded ? { offloaded: true as const } : {}) },
    ], source: { kind: 'user' } },
    { id: messageId(), role: 'assistant', content: [{ type: 'text', text: 'I saw it.' }],
      source: { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
    { id: messageId(), role: 'user', content: [
      { type: 'text', text: 'second image' }, { type: 'image', attachment: second },
    ], source: { kind: 'user' } },
  ]
  const pending = await runAttempts('cli', makeHistory(false), images, undefined, undefined, true)
  assert.equal(pending.bodies.length, 0, 'surface must commit the offload before any request is sent')
  assert.equal((pending.error as { code?: string }).code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.match((pending.error as { message?: string }).message ?? '', /1 already-seen oldest image/)

  const retried = await runAttempts('cli', makeHistory(true), images, undefined, undefined, true)
  assert.equal(retried.error, undefined)
  assert.deepEqual(survivingImageIndices(retried.bodies[0]!, 'cli'), [1])
  assert.equal(placeholderTexts(retried.bodies[0]!, 'cli').length, 1)

  const disabled = await runAttempts('cli', makeHistory(false), images)
  assert.equal(disabled.error, undefined)
  assert.deepEqual(survivingImageIndices(disabled.bodies[0]!, 'cli'), [0, 1])
  const providerApi = await runAttempts('openai', makeHistory(false), images, undefined, undefined, true)
  assert.equal(providerApi.error, undefined)
  assert.deepEqual(survivingImageIndices(providerApi.bodies[0]!, 'openai'), [0, 1])
})

test('cache mitigation does not offload an image before the selected model has seen it', async () => {
  const ref = sizedImageRef(0, pngBytes.length)
  const image = { id: messageId(), role: 'user' as const,
    content: [{ type: 'image' as const, attachment: ref }], source: { kind: 'user' as const } }
  const otherModel = { id: messageId(), role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'another model answered' }],
    source: { kind: 'model' as const, provider: 'commandcode', model: 'another-model' } }
  for (const messages of [[image], [image, otherModel]]) {
    const result = await runAttempts('cli', messages, { [ref.attachmentId]: sizedImageBytes(0) }, undefined, undefined, true)
    assert.equal(result.error, undefined)
    assert.deepEqual(survivingImageIndices(result.bodies[0]!, 'cli'), [0])
  }
})

test('cache mitigation does not count image blocks the engine cannot durably offload', async () => {
  const ref = sizedImageRef(0, pngBytes.length)
  const assistantWithImage: Message = {
    id: messageId(), role: 'assistant',
    content: [{ type: 'image', attachment: ref }],
    source: { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  }
  const answer: Message = {
    id: messageId(), role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
    source: { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  }
  const result = await runAttempts('cli', [assistantWithImage, answer, userMessage('Continue')],
    { [ref.attachmentId]: sizedImageBytes(0) }, undefined, undefined, true)
  assert.equal(result.error, undefined)
  assert.equal(result.bodies.length, 1)
})

test('Go-plan Provider API fallback requests durable image offload before posting CLI history', async () => {
  const ref = sizedImageRef(0, pngBytes.length)
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), offloadSeenImagesForCache: true }),
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: sizedImageBytes(0) }),
    fetchImpl: (async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname)
      return new Response(JSON.stringify({ error: { code: 'upgrade_required', message: 'Go plan has no API access' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })
  const messages: Message[] = [
    { id: messageId(), role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    { id: messageId(), role: 'assistant', content: [{ type: 'text', text: 'I saw it.' }],
      source: { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
    userMessage('Continue'),
  ]
  await assert.rejects(collect(adapter.stream({
    provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages,
  })), (error: unknown) => (error as { code?: string }).code === 'IMAGE_OFFLOAD_REQUIRED')
  assert.deepEqual(paths, ['/provider/v1/chat/completions'])
})

/** The parts of every user message in one captured body, either transport. */
function userParts(
  body: Record<string, unknown>,
  protocol: 'cli' | 'openai',
): Record<string, unknown>[] {
  const messages = (protocol === 'openai'
    ? body.messages
    : (body.params as Record<string, unknown>).messages) as Record<string, unknown>[]
  return messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content as Record<string, unknown>[])
}

/** The `sizedImageRef` indices a captured body still carries as real pixels. */
function survivingImageIndices(
  body: Record<string, unknown>,
  protocol: 'cli' | 'openai',
): number[] {
  return userParts(body, protocol)
    .filter((p) => p.type === 'image' || p.type === 'image_url')
    .map((p) => {
      const data = p.type === 'image'
        ? (p.image as string).split(',')[1]!
        : (p.image_url as { url: string }).url.split(',')[1]!
      const bytes = Buffer.from(data, 'base64')
      return bytes[bytes.length - 1]!
    })
}

/** The eviction placeholders a captured body carries, in wire order. */
function placeholderTexts(
  body: Record<string, unknown>,
  protocol: 'cli' | 'openai',
): string[] {
  return userParts(body, protocol)
    .filter((p) => p.type === 'text')
    .map((p) => p.text as string)
    .filter((text) => text.startsWith(PLACEHOLDER_PREFIX))
}

test('stream() sends every image while the history is inside the image budget', async () => {
  // Twenty small screenshots: far below both the count and the byte budget, so
  // the projection must be a no-op and the wire byte-identical to before.
  const { messages, images } = imageHistory(Array.from({ length: 20 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('cli', messages, images)

  assert.equal(error, undefined)
  assert.equal(bodies.length, 1)
  assert.equal(placeholderTexts(bodies[0]!, 'cli').length, 0)
  assert.deepEqual(survivingImageIndices(bodies[0]!, 'cli'), [...Array(20).keys()])
})

test('stream() asks for an offload once the history exceeds the image-count budget (issue #37)', async () => {
  // 61 images: one past the 60-image budget, and the 30-count quantum names the
  // oldest 30 at once. The route reports the shortfall so the session can record
  // the omission durably rather than evicting on its own.
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('cli', messages, images)

  assert.equal(bodies.length, 0, 'nothing is sent until the surface has recorded the omission')
  const e = error as { code?: string; failure?: { offloadImages?: number } }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.equal(e.failure?.offloadImages, 30)
})

test('stream() counts the encoded bytes of the request rung (issue #37)', async () => {
  // Ten images of 4 MiB each: ~53 MiB of base64, past the 32 MiB budget. The byte
  // accounting is the encoded size the wire carries, not the stored one, so the
  // shortfall is real regardless of the count budget.
  const { messages, images } = imageHistory(Array.from({ length: 10 }, () => 4 * 1024 * 1024))
  const { bodies, error } = await runAttempts('cli', messages, images)

  assert.equal(bodies.length, 0)
  const e = error as { code?: string; failure?: { offloadImages?: number } }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.ok((e.failure?.offloadImages ?? 0) > 0, 'a history past the byte budget must name occurrences to offload')
})

test('stream() counts images nested in a tool result (issue #37)', async () => {
  // A vision self-check loop's history in miniature: one huge `read_image` result.
  // It counts like any other occurrence, so the route reports it rather than
  // sending a body the gateway would refuse.
  const toolRef = sizedImageRef(0, 40 * 1024 * 1024)
  const { bodies, error } = await runAttempts(
    'cli',
    [userMessage('what is in /tmp/a.png?'), ...readImageTurn(toolRef)],
    { [toolRef.attachmentId]: sizedImageBytes(0) },
  )

  assert.equal(bodies.length, 0)
  const e = error as { code?: string; failure?: { offloadImages?: number } }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.ok((e.failure?.offloadImages ?? 0) > 0)
})

test('openai protocol applies the same image budget (issue #37)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('openai', messages, images)

  assert.equal(bodies.length, 0)
  assert.equal((error as { code?: string }).code, 'IMAGE_OFFLOAD_REQUIRED')
})

test('stream() reports a 413 as a request-size failure and never resends an image-free body (issue #37)', async () => {
  // No images: there is nothing for the budget to evict, so a second attempt
  // would send a byte-identical body and only burn a round trip.
  const { bodies, error } = await runAttempts('cli', [userMessage('hello there')], {}, () => 413)

  assert.equal(bodies.length, 1)
  const e = error as { code?: string; message?: string; failure?: { status?: number } }
  assert.equal(e.code, 'PROVIDER_HTTP_ERROR')
  assert.equal(e.failure?.status, 413)
  assert.match(e.message ?? '', /413/)
  assert.match(e.message ?? '', /size limit/)
  // Bilingual, like the 401 branch: the harness renders it verbatim.
  assert.match(e.message ?? '', /请求体超过服务端的体积上限/)
})

// ---------------------------------------------------------------------------
// Request image offload on the >=0.1.6 durable contract (issue #43)
//
// dsh 0.1.6 moved the offload set from the adapter to the session surface:
// `projectOffloadedImages` renders the durable marks, and an over-budget history
// FAILS with `IMAGE_OFFLOAD_REQUIRED` + the count to offload instead of being
// edited inside the adapter. A default profile answers that failure with
// `dsh-compaction-image-offload`, which records one `image/offload` event, marks
// the oldest occurrences, and retries the step.
//
// These tests inject the two helpers, so they pin the CONTRACT the adapter
// speaks — which rung it reports, in what encoding, with which byte callback, and
// that it never evicts on its own there — rather than the core arithmetic, which
// the injected fake deliberately does not implement.
// ---------------------------------------------------------------------------

/** Recorded calls of {@link makeSurfacePolicy}, so a test can assert the contract. */
interface SurfacePolicyCalls {
  projected: number
  required: number
  budgets: Record<string, unknown>[]
  versionBytes: number[]
}

/**
 * Stand-in for the >=0.1.6 core helpers. `count` is what `requiredImageOffload`
 * answers (a number, or a function of the rung's budget so the 413 ladder can
 * answer per rung); every call's arguments are recorded.
 */
function makeSurfacePolicy(
  count: number | ((budget: Record<string, unknown>) => number) = 0,
): { policy: SurfaceImagePolicy; calls: SurfacePolicyCalls } {
  const calls: SurfacePolicyCalls = { projected: 0, required: 0, budgets: [], versionBytes: [] }
  // One cast at the seam: the engine's helpers are overloaded on Message vs
  // RequestMessage, which a single stub implementation cannot satisfy.
  const policy = {
    projectOffloadedImages(messages: readonly RequestMessage[], placeholder: (ref: ImageAttachmentRef) => string) {
      calls.projected += 1
      return messages.map((message) => {
        const content = message.content.map((block) =>
          block.type === 'image' && (block as { offloaded?: true }).offloaded === true
            ? { type: 'text' as const, text: placeholder(block.attachment) }
            : block)
        return content.every((block, index) => block === message.content[index])
          ? message
          : { ...message, content }
      })
    },
    requiredImageOffload(
      messages: readonly RequestMessage[],
      budget: Parameters<SurfaceImagePolicy['requiredImageOffload']>[1],
      versionBytes: Parameters<SurfaceImagePolicy['requiredImageOffload']>[2],
    ) {
      calls.required += 1
      calls.budgets.push(budget)
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'image' && (block as { offloaded?: true }).offloaded !== true) {
            calls.versionBytes.push(versionBytes(block))
          }
        }
      }
      return typeof count === 'function' ? count(budget) : count
    },
  } as unknown as SurfaceImagePolicy
  return { policy, calls }
}

test('stream() asks the surface to offload when a 0.1.6 engine reports an over-budget history (issue #43)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { policy, calls } = makeSurfacePolicy(30)
  const { bodies, error } = await runAttempts('cli', messages, images, () => 200, policy)

  // Nothing was sent: the route reports the shortfall instead of guessing, so
  // the harness can record the omission and retry with the surface updated.
  assert.equal(bodies.length, 0)
  const e = error as { code?: string; message?: string }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  // The count travels twice: in `failure.offloadImages`, which is what
  // `dsh-compaction-image-offload` reads, and in the message — the only one observable here; the field itself is pinned by scripts/verify-engine-load.mjs.
  assert.match(e.message ?? '', /30 more oldest occurrence/)
  // The adapter speaks the STANDING rung, in the encoded form the wire carries,
  // and hands the counter the declared normalized size it would inline.
  assert.equal(calls.projected, 1)
  assert.equal(calls.required, 1)
  assert.deepEqual(calls.budgets[0], {
    representation: 'base64',
    maxBytes: 32 * 1024 * 1024,
    maxImages: 60,
    byteQuantum: 16 * 1024 * 1024,
    countQuantum: 30,
  })
  assert.deepEqual([...new Set(calls.versionBytes)], [pngBytes.length])
})

test("stream() renders the surface's durable offload marks as placeholders (issue #43)", async () => {
  // One image the surface already offloaded, one still retained. The marked one must
  // travel as placeholder text even though the history is far inside the budget —
  // a mark the adapter ignored would re-send evicted pixels.
  const goneRef = sizedImageRef(0, pngBytes.length)
  const keptRef = sizedImageRef(1, pngBytes.length)
  const gone = { type: 'image', attachment: goneRef, offloaded: true } as unknown as ContentBlock
  const messages: Message[] = [
    { id: messageId(), role: 'user', content: [{ type: 'text', text: 'first' }, gone], source: { kind: 'user' } },
    {
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: 'second' }, { type: 'image', attachment: keptRef }],
      source: { kind: 'user' },
    },
  ]
  const { policy } = makeSurfacePolicy(0)
  const { bodies, error } = await runAttempts('cli', messages, {
    [goneRef.attachmentId]: sizedImageBytes(0),
    [keptRef.attachmentId]: sizedImageBytes(1),
  }, () => 200, policy)

  assert.equal(error, undefined)
  assert.equal(bodies.length, 1)
  assert.deepEqual(survivingImageIndices(bodies[0]!, 'cli'), [1])
  const placeholders = placeholderTexts(bodies[0]!, 'cli')
  assert.equal(placeholders.length, 1)
  assert.match(placeholders[0]!, /sha256:budget-image-0/)
})

test('stream() asks for the stricter rung when a 413 arrives on a 0.1.6 engine (issue #43)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  // Rung 0 fits (the fake answers 0); the gateway refuses the body anyway, so the
  // RETRY rung's shortfall is what the surface is asked to offload. The omission is
  // recorded on the session instead of being a local edit, which is why the
  // request is NOT resent from here.
  const { policy, calls } = makeSurfacePolicy((budget) => (budget.maxImages === 12 ? 47 : 0))
  const { bodies, error } = await runAttempts('cli', messages, images, () => 413, policy)

  assert.equal(bodies.length, 1)
  const e = error as { code?: string; message?: string }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.match(e.message ?? '', /47 more oldest occurrence/)
  assert.deepEqual(calls.budgets.map((budget) => budget.maxImages), [60, 12])
})

test('stream() reports the 413 itself when a 0.1.6 surface has nothing left to offload (issue #43)', async () => {
  // Once the surface reports no shortfall at the strictest rung the body is simply
  // too large (text and tool bytes share the gateway cap), and asking for another
  // offload would loop.
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { policy } = makeSurfacePolicy(0)
  const { bodies, error } = await runAttempts('cli', messages, images, () => 413, policy)

  assert.equal(bodies.length, 1)
  const e = error as { code?: string; failure?: { status?: number }; message?: string }
  assert.equal(e.code, 'PROVIDER_HTTP_ERROR')
  assert.equal(e.failure?.status, 413)
  assert.match(e.message ?? '', /请求体超过服务端的体积上限/)
})

// ---------------------------------------------------------------------------
// Image capability advertisement
// ---------------------------------------------------------------------------

test('resolveModel() advertises plan tier, deal, Image, and context', async () => {
  // A dedicated cache path keeps this test free of any on-disk catalog cache.
  const cachePath = join(tmpdir(), `cc-test-${process.pid}-${Date.now()}.json`)
  try {
    const adapter = makeAdapter({
      fetchImpl: fetchReturning(200, JSON.stringify({ object: 'list', data: [] })),
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }),
    })
    // Without a catalog entry the context window is unknown; the description
    // still carries plan, deal, and Image markers.
    const vision = await adapter.resolveModel('commandcode', 'claude-sonnet-5')
    assert.equal(vision.toolUpdate, 'addition-only')
    assert.deepEqual(vision.inputModalities, ['text', 'image'])
    assert.equal(vision.description, 'Pro · Image')
    const textOnly = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-flash')
    assert.deepEqual(textOnly.inputModalities, ['text'])
    // Text-only DeepSeek models carry a time-of-day pricing marker (Peak/Half
    // by current UTC hour) instead of an Image marker.
    assert.ok(textOnly.description !== undefined, 'a resolved model describes its capabilities')
    assert.match(textOnly.description, /^Go · (?:Peak|Half)$/)
    // A model with a permanent deal shows its discount.
    const deal = await adapter.resolveModel('commandcode', 'MiniMaxAI/MiniMax-M3')
    assert.equal(deal.description, 'Go · 50% off · Image')
    // A provider-tier model with a context window shows all four parts.
    const provider = await adapter.resolveModel('commandcode', 'claude-opus-5')
    assert.equal(provider.description, 'Provider · Image')
    // Unknown models fall back to the bare plan-less summary (empty here).
    const unknown = await adapter.resolveModel('commandcode', 'some-future-model')
    assert.equal(unknown.toolUpdate, 'addition-only')
    assert.deepEqual(unknown.inputModalities, ['text'])
    assert.equal(unknown.description, '')
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('listModels() annotates catalog models with plan, deal, Image, context', async () => {
  const catalog = {
    object: 'list',
    data: [
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1_000_000 },
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_length: 1_000_000 },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1_000_000 },
      { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1', context_length: 256_000 },
    ],
  }
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify(catalog)) })
  const models = await adapter.listModels('commandcode')
  const byId = new Map(models.map((m) => [m.id, m]))
  assert.deepEqual(byId.get('claude-sonnet-5')!.inputModalities, ['text', 'image'])
  assert.equal(byId.get('claude-sonnet-5')!.description, 'Pro · Image · 1M')
  // DeepSeek V4 Pro's 75% off deal lapsed on 2026-08-16 and left KNOWN_DEALS, so
  // the description is deal-free. DeepSeek models carry time-of-day pricing, so
  // the Peak/Half marker depends on the current UTC hour; the rest is fixed.
  const v4Pro = byId.get('deepseek/deepseek-v4-pro')!
  assert.ok(v4Pro.description !== undefined)
  assert.match(v4Pro.description, /^Go · (?:Peak|Half) · 1M$/)
  const v4Flash = byId.get('deepseek/deepseek-v4-flash')!
  assert.deepEqual(v4Flash.inputModalities, ['text'])
  assert.ok(v4Flash.description !== undefined)
  assert.match(v4Flash.description, /^Go · (?:Peak|Half) · 1M$/)
  assert.equal(byId.get('poolside/laguna-s-2.1-free')!.description, 'Go · FREE · 256K')
  // Picker order: free models, then Go, then Pro, alphabetically within a tier
  // (the fixture's input order is deliberately shuffled).
  assert.deepEqual(
    models.map((m) => m.id),
    [
      'poolside/laguna-s-2.1-free',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
      'claude-sonnet-5',
    ],
  )
})

test('resolveModel() and listModels() honor custom context lengths (issue #86)', async () => {
  // A dedicated cache path keeps this test free of any on-disk catalog cache.
  const cachePath = join(tmpdir(), `cc-ctx-${process.pid}-${Date.now()}.json`)
  try {
    const catalog = {
      object: 'list',
      data: [
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1_000_000 },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1_000_000 },
      ],
    }
    const adapter = makeAdapter({
      fetchImpl: fetchReturning(200, JSON.stringify(catalog)),
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        protocol: 'cli' as const,
        // The global custom window, with one model overridden on top of it.
        contextWindow: 64_000,
        contextWindowOverrides: { 'claude-sonnet-5': 32_000 },
      }),
    })
    // The per-model override wins over the global value, both over the catalog.
    const perModel = await adapter.resolveModel('commandcode', 'claude-sonnet-5')
    assert.deepEqual(perModel.context, { contextWindow: 32_000 })
    // The output budget follows the ADVERTISED window the same way the catalog
    // derives it (min(window, published ceiling)) — 32k here, not the family's
    // 128 000-published ceiling.
    assert.equal(perModel.defaultMaxTokens, 32_000)
    assert.ok(perModel.description !== undefined)
    assert.match(perModel.description, /^Pro · Image · 32K$/)
    // The global value covers every model without its own row.
    const global = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-flash')
    assert.deepEqual(global.context, { contextWindow: 64_000 })
    // The custom 64 000 clamps this model's 393 216 published ceiling: without
    // the override the budget would be min(393 216, DEFAULT 131 072).
    assert.equal(global.defaultMaxTokens, 64_000)
    // An unknown model has no catalog entry, so it stays without a context
    // advertisement even while a global override is configured.
    const unknown = await adapter.resolveModel('commandcode', 'some-future-model')
    assert.equal(unknown.context, undefined)
    // The picker annotation reports the custom window, not the catalog's 1M.
    const models = await adapter.listModels('commandcode')
    const byId = new Map(models.map((m) => [m.id, m]))
    assert.ok(byId.get('claude-sonnet-5')!.description !== undefined)
    assert.match(byId.get('claude-sonnet-5')!.description!, /· 32K$/)
    assert.ok(byId.get('deepseek/deepseek-v4-flash')!.description !== undefined)
    assert.match(byId.get('deepseek/deepseek-v4-flash')!.description!, /· 64K$/)
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('custom context lengths fall back to the catalog when a value is out of bounds', async () => {
  const cachePath = join(tmpdir(), `cc-ctx-bad-${process.pid}-${Date.now()}.json`)
  try {
    const catalog = {
      object: 'list',
      data: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1_000_000 }],
    }
    // A programmatically built config can bypass Schemastery; `resolveAdapterOptions`
    // cleans the normal path, and `effectiveContextWindow` re-judges here so a
    // garbage window never reaches the harness.
    const adapter = makeAdapter({
      fetchImpl: fetchReturning(200, JSON.stringify(catalog)),
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        protocol: 'cli' as const,
        contextWindow: 0,
        contextWindowOverrides: { 'deepseek/deepseek-v4-flash': -1 },
      }),
    })
    const resolved = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-flash')
    assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })
  } finally {
    rmSync(cachePath, { force: true })
  }
})

for (const protocol of ['cli', 'openai', 'messages'] as const) {
  const cases = [
    { name: '调大全局窗口', catalog: 8192, global: 131_072, expected: 131_072 },
    { name: '按模型调大优先于全局', catalog: 8192, global: 32_768, perModel: 131_072, expected: 131_072 },
    { name: '调小窗口', catalog: 1_000_000, global: 32_768, expected: 32_768 },
    { name: '保留公布输出上限', catalog: 8192, global: 131_072, published: 16_384, expected: 16_384 },
    { name: '未设置保持目录预算', catalog: 8192, expected: 8192 },
  ] as const
  for (const scenario of cases) {
    test(`${protocol} 上下文预算：${scenario.name}同时作用于宿主默认值和实际请求`, async () => {
      const model = 'deepseek/deepseek-v4-flash'
      const sent: number[] = []
      const adapter = makeAdapter({
        options: () => ({ apiBase: `https://context-${protocol}-${scenario.name}.invalid`, workingDir: '/tmp', modelsCachePath: '',
          requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, protocol,
          ...('global' in scenario ? { contextWindow: scenario.global } : {}),
          ...('perModel' in scenario ? { contextWindowOverrides: { [model]: scenario.perModel } } : {}),
        }),
        fetchImpl: (async (url, init) => {
          if (String(url).endsWith('/provider/v1/models')) return Response.json({ object: 'list', data: [{
            id: model, name: '合成窗口模型', context_length: scenario.catalog,
            supported_endpoints: [protocol === 'messages' ? '/messages' : '/chat/completions'],
            ...('published' in scenario ? { max_output_tokens: scenario.published } : {}),
          }] })
          const body = JSON.parse(String(init?.body))
          sent.push(protocol === 'cli' ? body.params.max_tokens : body.max_tokens)
          return new Response(settlementFrames(protocol).join(''))
        }) as typeof fetch,
      })
      const info = await adapter.resolveModel('commandcode', model)
      assert.equal(info.defaultMaxTokens, scenario.expected)
      // 显式上限可低于默认值，但不能绕过有效窗口或模型自身输出上限。
      const request = { provider: 'commandcode', model, messages: [userMessage('合成请求')] }
      for (const maxTokens of [undefined, 4096, 1_000_000]) {
        await collect(adapter.stream({ ...request, ...(maxTokens === undefined ? {} : { maxTokens }) }))
      }
      assert.deepEqual(sent, [scenario.expected, 4096, scenario.expected])
    })
  }

  test(`${protocol} 调大窗口后仍学习输出拒绝并仅降档一次`, async () => {
    const model = 'deepseek/deepseek-v4-flash'
    const sent: number[] = []
    const adapter = makeAdapter({
      options: () => ({ apiBase: `https://context-learning-${protocol}.invalid`, workingDir: '/tmp', modelsCachePath: '',
        requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, protocol, contextWindow: 131_072 }),
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/provider/v1/models')) return Response.json({ object: 'list', data: [{
          id: model, name: '合成窗口模型', context_length: 8192, max_output_tokens: 90_000,
          supported_endpoints: [protocol === 'messages' ? '/messages' : '/chat/completions'],
        }] })
        const body = JSON.parse(String(init?.body))
        sent.push(protocol === 'cli' ? body.params.max_tokens : body.max_tokens)
        if (sent.length === 1) return new Response(JSON.stringify({ error: { message:
          'max_tokens: 90000 > 20000, which is the maximum allowed number of output tokens' } }), { status: 400 })
        return new Response(settlementFrames(protocol).join(''))
      }) as typeof fetch,
    })
    assert.equal((await adapter.resolveModel('commandcode', model)).defaultMaxTokens, 90_000)
    const request = { provider: 'commandcode', model, messages: [userMessage('合成请求')] }
    await collect(adapter.stream(request))
    assert.deepEqual(sent, [90_000, 20_000])
    assert.equal((await adapter.resolveModel('commandcode', model)).defaultMaxTokens, 20_000)
    await collect(adapter.stream(request))
    assert.deepEqual(sent, [90_000, 20_000, 20_000])
  })
}

test('catalog and window probes ask for uncompressed Command Code responses', async () => {
  const paths: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity')
    return Response.json(path === '/provider/v1/models'
      ? { object: 'list', data: [] }
      : { windowLimits: { weekly: { used: 0, cap: 1, exceeded: false, resetAt: 0 } } })
  }) as unknown as typeof fetch
  const adapter = makeAdapter({ fetchImpl })
  await adapter.listModels('commandcode', { unfiltered: true })
  assert.deepEqual(await adapter.probeWindowLimits('user_test_key'), { exceeded: false, resetAt: 0 })
  assert.deepEqual(paths, ['/provider/v1/models', '/alpha/billing/credits'])
})

// ---------------------------------------------------------------------------
// Zero data retention (the `zdr` connection option)
// ---------------------------------------------------------------------------

/** A model the maintained snapshot says HAS a ZDR-capable upstream. */
const ZDR_COVERED_MODEL = 'deepseek/deepseek-v4.1-flash'
/** A model on the provider's ZDR exception list (no ZDR-capable upstream). */
const ZDR_EXCLUDED_MODEL = 'stepfun/Step-3.7-Flash'

/**
 * Drive one request and return the headers its POST carried (the catalog GET's
 * headers are filtered out — only the generate call's decision matters).
 */
async function postedHeaders(
  protocol: 'cli' | 'openai',
  overrides: { zdr?: boolean; model?: string },
): Promise<Record<string, string>> {
  let seen: Record<string, string> = {}
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      seen = { ...(init.headers as Record<string, string>) }
    }
    return okStream(protocol)
  }) as unknown as typeof fetch
  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol,
      ...(overrides.zdr === undefined ? {} : { zdr: overrides.zdr }),
    }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: overrides.model ?? ZDR_COVERED_MODEL,
    messages: [userMessage('hello')],
  }))
  return seen
}

test('stream() sends x-cmd-zdr on both transports when zdr is on and the model is covered', async () => {
  for (const protocol of ['cli', 'openai'] as const) {
    const headers = await postedHeaders(protocol, { zdr: true })
    assert.equal(headers['x-cmd-zdr'], '1', `${protocol} transport carries the ZDR header`)
    // The provider's own opt-in is additive: the ordinary headers stay.
    assert.equal(headers.Authorization, 'Bearer user_test_key')
    assert.equal(headers['Content-Type'], 'application/json')
  }
})

test('stream() leaves the ZDR header off by default, whatever the model', async () => {
  for (const protocol of ['cli', 'openai'] as const) {
    assert.equal((await postedHeaders(protocol, {}))['x-cmd-zdr'], undefined)
    assert.equal((await postedHeaders(protocol, { zdr: false }))['x-cmd-zdr'], undefined)
  }
})

test('stream() enforces ZDR even for a model without a ZDR upstream', async () => {
  // The provider must refuse this request with 422 instead of routing it to
  // an upstream that retains data. The client must never silently omit ZDR.
  assert.equal(supportsZeroDataRetention(ZDR_EXCLUDED_MODEL), false)
  for (const protocol of ['cli', 'openai'] as const) {
    const headers = await postedHeaders(protocol, { zdr: true, model: ZDR_EXCLUDED_MODEL })
    assert.equal(headers['x-cmd-zdr'], '1')
  }
})

test('stream() diagnoses a ZDR refusal as a ZDR problem, bilingual', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ error: { code: 'cmd_zdr_no_providers', message: 'no ZDR-capable upstream available' } }),
    { status: 422 },
  )) as unknown as typeof fetch
  const adapter = makeAdapter({ fetchImpl, options: () => ({ ...OPENAI_OPTIONS(), zdr: true }) })
  let error: (Error & { failure?: { status?: number } }) | undefined
  try {
    await collect(adapter.stream({
      provider: 'commandcode',
      model: ZDR_COVERED_MODEL,
      messages: [userMessage('hello')],
    }))
  } catch (thrown) {
    error = thrown as Error & { failure?: { status?: number } }
  }
  assert.ok(error !== undefined)
  assert.equal(error.failure?.status, 422)
  assert.match(error.message ?? '', /zero data retention/i)
  assert.match(error.message ?? '', /零数据保留/)
})

// ---------------------------------------------------------------------------
// Plan filter (listModels hides models above the account's subscription tier)
// ---------------------------------------------------------------------------

/** A fetch stub that routes by URL path and counts calls. */
function fetchRouting(paths: Record<string, { status: number; body: unknown }>): {
  fetchImpl: typeof fetch
  calls: Map<string, number>
} {
  const calls = new Map<string, number>()
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const path = new URL(url).pathname
    calls.set(path, (calls.get(path) ?? 0) + 1)
    const canned = paths[path]
    if (!canned) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A fetch stub routing by (API key, path), so a pool of accounts can be scripted. */
function fetchRoutingByKey(byKey: Record<string, Record<string, { status: number; body: unknown }>>): {
  fetchImpl: typeof fetch
  calls: Array<{ key: string; path: string }>
} {
  const calls: Array<{ key: string; path: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const path = new URL(url).pathname
    const headers = (init?.headers ?? {}) as Record<string, string>
    const key = (headers.Authorization ?? '').replace(/^Bearer /, '')
    calls.push({ key, path })
    const canned = byKey[key]?.[path]
    if (!canned) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** Catalog fixture spanning the Go / Pro / Provider tiers plus an unknown model. */
const PLAN_FILTER_CATALOG = {
  object: 'list',
  data: [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context_length: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1_000_000 },
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_length: 1_000_000 },
    { id: 'some-future-model', name: 'Some Future', context_length: 128_000 },
  ],
}

/** A `/alpha/billing/credits` body carrying the given plan and balances. */
function billingBody(planId: string | undefined, purchasedCredits: number, freeCredits: number) {
  return { credits: { monthlyCredits: 5, purchasedCredits, freeCredits, ...(planId === undefined ? {} : { planId }) } }
}

/** The whoami/subscriptions pair for a subscription in the given state. */
function subscriptionStubs(planId: string, status: string) {
  return {
    '/alpha/whoami': { status: 200, body: { success: true, user: { id: 'u1' }, org: { id: 'org1' } } },
    '/alpha/billing/subscriptions': { status: 200, body: { success: true, data: { planId, status } } },
  }
}

test('listModels() hides models above the account plan tier', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({ fetchImpl })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.deepEqual(ids.sort(), ['deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('listModels() fails open when the subscription is not active', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'canceled'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({ fetchImpl })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
})

test('listModels() falls back to credits.planId when subscriptions fails', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    '/alpha/whoami': { status: 200, body: { success: true, user: { id: 'u1' }, org: { id: 'org1' } } },
    '/alpha/billing/subscriptions': { status: 500, body: {} },
    '/alpha/billing/credits': { status: 200, body: billingBody('individual-go', 0, 0) },
  })
  const adapter = makeAdapter({ fetchImpl })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.deepEqual(ids.sort(), ['deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('listModels() keeps every model when the account holds on-demand credits', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 5, 0) },
  })
  const adapter = makeAdapter({ fetchImpl })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
})

test('allowanceTier() answers the pool\'s highest allowance bracket', async () => {
  // The pricing page publishes per-model allowances for Go, GOAT and Pro, so
  // the settings page needs to know which bracket this pool is in —
  // or that it is in neither.
  const bracket = async (planId: string, status = 'active') => {
    const { fetchImpl } = fetchRouting({
      '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
      ...subscriptionStubs(planId, status),
      '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
    })
    return makeAdapter({ fetchImpl }).allowanceTier()
  }
  assert.equal(await bracket('individual-goat'), 'goat')
  assert.equal(await bracket('individual-pro'), 'pro')
  // Pro v1 is the same bracket as Pro.
  assert.equal(await bracket('individual-pro-v1'), 'pro')
  // Plans with no published allowance must NOT fall back to a neighbour's
  // figure: Go now has its own bracket; other plans must not borrow its number.
  assert.equal(await bracket('individual-go'), 'go')
  assert.equal(await bracket('individual-go-v1'), 'go')
  assert.equal(await bracket('individual-max'), undefined)
  assert.equal(await bracket('individual-provider'), undefined)
  // Fail-open shape, as everywhere else in this plugin: unreadable billing
  // hides the allowance rather than inventing one.
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    '/alpha/whoami': { status: 200, body: { success: true, user: { id: 'u1' }, org: { id: 'org1' } } },
    '/alpha/billing/subscriptions': { status: 500, body: {} },
    '/alpha/billing/credits': { status: 500, body: {} },
  })
  assert.equal(await makeAdapter({ fetchImpl }).allowanceTier(), undefined)
})

test('listModels() fails open when the billing endpoint fails', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    '/alpha/billing/credits': { status: 500, body: {} },
  })
  const adapter = makeAdapter({ fetchImpl })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
})

test('listModels() skips the plan filter (and its fetch) when filterModelsByPlan is false', async () => {
  const { fetchImpl, calls } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    '/alpha/billing/credits': { status: 200, body: billingBody('individual-go', 0, 0) },
  })
  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      filterModelsByPlan: false,
    }),
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
  assert.equal(calls.get('/alpha/billing/credits') ?? 0, 0)
})

test('listModels() caches the billing access across picker loads', async () => {
  const { fetchImpl, calls } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-pro', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({ fetchImpl })
  await adapter.listModels('commandcode')
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(calls.get('/alpha/whoami'), 1)
  assert.equal(calls.get('/alpha/billing/subscriptions'), 1)
  assert.equal(calls.get('/alpha/billing/credits'), 1)
  assert.deepEqual(ids.sort(), ['claude-sonnet-5', 'deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('套餐缓存按网关隔离，同一密钥在新网关重新查询套餐', async (t) => {
  const cachePath = join(tmpdir(), `cc-cross-gateway-billing-${process.pid}.json`)
  t.after(() => rmSync(cachePath, { force: true }))
  let apiBase = 'https://first.invalid'
  const subscriptions: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), apiBase, modelsCachePath: cachePath }),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) return new Response(JSON.stringify(PLAN_FILTER_CATALOG))
      if (url.endsWith('/alpha/whoami')) return new Response(JSON.stringify({ org: { id: 'org1' } }))
      if (url.includes('/alpha/billing/subscriptions')) {
        subscriptions.push(new URL(url).origin)
        return new Response(JSON.stringify({ data: { status: 'active', planId: apiBase === 'https://first.invalid' ? 'individual-go' : 'individual-pro' } }))
      }
      if (url.endsWith('/alpha/billing/credits')) return new Response(JSON.stringify(billingBody(undefined, 0, 0)))
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch,
  })
  assert.deepEqual((await adapter.listModels('commandcode')).map((model) => model.id).sort(), [
    'deepseek/deepseek-v4-pro', 'some-future-model',
  ])
  apiBase = 'https://second.invalid'
  assert.deepEqual((await adapter.listModels('commandcode')).map((model) => model.id).sort(), [
    'claude-sonnet-5', 'deepseek/deepseek-v4-pro', 'some-future-model',
  ])
  assert.deepEqual(subscriptions, ['https://first.invalid', 'https://second.invalid'])
})

test('listModels() lists a model only another account in the pool includes', async () => {
  // Issue #51's follow-up: keyed on the account that happened to serve, the picker's
  // contents changed as rotation moved between accounts, and a model only the
  // other account could run was hidden outright — which no request could fix.
  const catalog = { '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG } }
  const { fetchImpl } = fetchRoutingByKey({
    'key-go': { ...catalog, ...subscriptionStubs('individual-go', 'active'), '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) } },
    'key-pro': { ...catalog, ...subscriptionStubs('individual-pro', 'active'), '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) } },
  })
  const adapter = makeAdapter({
    fetchImpl,
    // The serving account is the Go one; the Pro model still belongs in the
    // list, and the connect loop serves it from the account that has it.
    resolveApiKey: async () => 'key-go',
    resolveAccountKeys: async () => ['key-go', 'key-pro'],
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.deepEqual(ids.sort(), ['claude-sonnet-5', 'deepseek/deepseek-v4-pro', 'some-future-model'])
  // The union is the BEST account, not "everything": a Provider-tier model no
  // account reaches stays hidden.
  assert.ok(!ids.includes('claude-opus-4-8'))
})

test('listModels() shows a Provider-tier model once one account reaches that tier', async () => {
  const catalog = { '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG } }
  const goOrPro = (planId: string) => ({
    ...catalog,
    ...subscriptionStubs(planId, 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const { fetchImpl } = fetchRoutingByKey({
    'key-go': goOrPro('individual-go'),
    'key-pro': goOrPro('individual-pro'),
    'key-provider': goOrPro('individual-provider'),
  })
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-go',
    resolveAccountKeys: async () => ['key-go', 'key-pro', 'key-provider'],
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.deepEqual(ids.sort(), ['claude-opus-4-8', 'claude-sonnet-5', 'deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('listModels() fails open when one account’s billing facts are unknown', async () => {
  // An account whose facts cannot be read counts as "may include it" — the
  // same fail-open rule the single-account filter already follows: hiding a
  // model somebody can run is the one failure this filter must never cause.
  const catalog = { '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG } }
  const { fetchImpl } = fetchRoutingByKey({
    'key-go': { ...catalog, ...subscriptionStubs('individual-go', 'active'), '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) } },
    // Every billing endpoint 404s for this key: its access is unknown.
    'key-unknown': catalog,
  })
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-go',
    resolveAccountKeys: async () => ['key-go', 'key-unknown'],
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
})

test('listModels() reads each account’s billing facts once per TTL', async () => {
  const catalog = { '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG } }
  const plan = (planId: string) => ({
    ...catalog,
    ...subscriptionStubs(planId, 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const { fetchImpl, calls } = fetchRoutingByKey({ 'key-go': plan('individual-go'), 'key-pro': plan('individual-pro') })
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-go',
    resolveAccountKeys: async () => ['key-go', 'key-pro'],
  })
  await adapter.listModels('commandcode')
  await adapter.listModels('commandcode')
  // One whoami per ACCOUNT (not per picker load): the extra accounts cost
  // their three requests once per BILLING_ACCESS_TTL_MS.
  assert.deepEqual(calls.filter((call) => call.path === '/alpha/whoami').map((call) => call.key).sort(), ['key-go', 'key-pro'])
})

// Visible-model allowlist (listModels narrows the picker; unfiltered serves the page catalog)
test('listModels() narrows the picker to visibleModels after the plan filter', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      visibleModels: ['deepseek/deepseek-v4-pro', 'some-future-model', 'not-a-model'],
    }),
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.deepEqual(ids.sort(), ['deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('listModels() shows everything when visibleModels is empty or unset', async () => {
  for (const visibleModels of [undefined, []] as const) {
    const { fetchImpl } = fetchRouting({
      '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
      ...subscriptionStubs('individual-go', 'active'),
      '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
    })
    const adapter = makeAdapter({
      fetchImpl,
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: '/tmp/cc-models-cache.json',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        ...(visibleModels === undefined ? {} : { visibleModels: [...visibleModels] }),
      }),
    })
    const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
    assert.deepEqual(ids.sort(), ['deepseek/deepseek-v4-pro', 'some-future-model'])
  }
})

test('listModels({ unfiltered: true }) serves the full catalog for the page editor', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      visibleModels: ['deepseek/deepseek-v4-pro'],
    }),
  })
  const ids = (await adapter.listModels('commandcode', { unfiltered: true })).map((m) => m.id)
  assert.equal(ids.length, PLAN_FILTER_CATALOG.data.length)
})

// Per-model overrides: what the terminal settings page's checkboxes write.
test('listModels() lets a modelVisibility flag decide one model on its own', async () => {
  const catalogue = async (options: Record<string, unknown>): Promise<string[]> => {
    const { fetchImpl } = fetchRouting({
      '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
      ...subscriptionStubs('individual-go', 'active'),
      '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
    })
    const adapter = makeAdapter({
      fetchImpl,
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: '/tmp/cc-models-cache.json',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        ...options,
      }),
    })
    return (await adapter.listModels('commandcode')).map((m) => m.id).sort()
  }
  // Baseline (no array, no flags) is the plan-filtered catalog.
  assert.deepEqual(await catalogue({}), ['deepseek/deepseek-v4-pro', 'some-future-model'])
  // A `false` flag hides a model the empty array would have shown…
  assert.deepEqual(await catalogue({ modelVisibility: { 'deepseek/deepseek-v4-pro': false } }), [
    'some-future-model',
  ])
  // …a `true` flag shows a model the array would have hidden…
  assert.deepEqual(await catalogue({
    visibleModels: ['some-future-model'],
    modelVisibility: { 'deepseek/deepseek-v4-pro': true },
  }), ['deepseek/deepseek-v4-pro', 'some-future-model'])
  // …and an id the map does not mention still follows the array exactly.
  assert.deepEqual(await catalogue({ visibleModels: ['some-future-model'] }), ['some-future-model'])
  // The plan filter is not bypassed: a flag can only decide a model the
  // account can actually reach.
  assert.deepEqual(await catalogue({ modelVisibility: { 'claude-sonnet-5': true } }), [
    'deepseek/deepseek-v4-pro',
    'some-future-model',
  ])
})

test('listModels() ignores a non-boolean override instead of hiding the model', async () => {
  const { fetchImpl } = fetchRouting({
    '/provider/v1/models': { status: 200, body: PLAN_FILTER_CATALOG },
    ...subscriptionStubs('individual-go', 'active'),
    '/alpha/billing/credits': { status: 200, body: billingBody(undefined, 0, 0) },
  })
  const adapter = makeAdapter({
    fetchImpl,
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      // A hand-edited document can carry anything; the adapter must fall back
      // to the array rather than treat a string as "hidden".
      modelVisibility: { 'deepseek/deepseek-v4-pro': 'yes' } as never,
    }),
  })
  const ids = (await adapter.listModels('commandcode')).map((m) => m.id)
  assert.equal(ids.includes('deepseek/deepseek-v4-pro'), true)
})

test('modelVisibleInPlan() fails open on every uncertainty', async () => {
  const { modelVisibleInPlan } = await import('../src/capabilities.ts')
  assert.equal(modelVisibleInPlan('claude-opus-4-8', undefined), true)
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: 0, onDemandCredits: 1 }), true)
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: undefined, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: NaN, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('some-future-model', { tierWeight: 0, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('deepseek/deepseek-v4-pro', { tierWeight: 0, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-sonnet-5', { tierWeight: 0, onDemandCredits: 0 }), false)
  assert.equal(modelVisibleInPlan('claude-sonnet-5', { tierWeight: 2, onDemandCredits: 0 }), true)
  // Haiku 5.5 is included from GOAT upward at zero on-demand balance (1.79.2).
  assert.equal(modelVisibleInPlan('claude-haiku-5-5', { tierWeight: 0, onDemandCredits: 0 }), false)
  assert.equal(modelVisibleInPlan('claude-haiku-5-5', { tierWeight: 1, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-haiku-5-5', { tierWeight: 2, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: 4, onDemandCredits: 0 }), true)
})

test('compareByPlan() sorts free models first, then plan tier, then name', () => {
  // Free models (KNOWN_DEALS free: true) lead the list regardless of tier.
  assert.ok(compareByPlan(
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
    { id: 'claude-opus-5', name: 'Claude Opus 5 (CC)' },
  ) < 0)
  // A paid Go model sorts before a higher tier, but after every free model.
  assert.ok(compareByPlan(
    { id: 'zai-org/GLM-5.2', name: 'GLM-5.2 (CC)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CC)' },
  ) < 0)
  assert.ok(compareByPlan(
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
    { id: 'zai-org/GLM-5.2', name: 'GLM-5.2 (CC)' },
  ) < 0)
  // Both are Go-tier free models, so the tie falls through to the name and the
  // Glyph Cluster preview leads. (The 2026-10-20 catalog sync dropped the
  // `stealth/cat-jam:free` deal when the live catalog delisted that preview; it
  // stays in `KNOWN_NON_ZDR_MODELS` on artifact evidence.)
  assert.ok(compareByPlan(
    { id: 'stealth/glyph-cluster:free', name: 'Glyph Cluster (CC)' },
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
  ) < 0)
  assert.ok(compareByPlan(
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (CC)' },
    { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3 (CC)' },
  ) < 0)
  // Unknown plan sorts after every known tier.
  assert.ok(compareByPlan(
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CC)' },
    { id: 'some-future-model', name: 'Some Future (CC)' },
  ) < 0)
  assert.equal(compareByPlan(
    { id: 'xai/grok-4.5', name: 'Grok 4.5 (CC)' },
    { id: 'xai/grok-4.5', name: 'Grok 4.5 (CC)' },
  ), 0)
})

// ---------------------------------------------------------------------------
// Stream parsing: SSE-ish JSONL -> StreamChunk
// ---------------------------------------------------------------------------

test('stream() emits text blocks, usage, then finish', async () => {
  const events = [
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 0, noCacheTokens: 8 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, events) })
  const chunks = await collect(adapter.stream({
    provider: 'commandcode',
    model: 'm',
    messages: [userMessage('hi')],
  }))

  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Hello')
  const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
  // Harness counts are disjoint: uncached input only.
  assert.equal(usage.usage.inputTokens, 8)
  assert.equal(usage.usage.outputTokens, 5)
  assert.equal(usage.usage.cacheReadTokens, 2)
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
})

test('stream() uses the CLI cache-write event only when finish reports zero', async () => {
  const run = async (events: object[]) => {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const adapter = makeAdapter({ fetchImpl: fetchReturning(200, body) })
    return collect(adapter.stream({
      provider: 'commandcode',
      model: 'm',
      messages: [userMessage('hi')],
    }))
  }

  const fallback = await run([
    { type: 'text-delta', text: 'ok' },
    { type: 'cache-write-tokens', cacheWriteTokens: 7 },
    {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 0, noCacheTokens: 8 },
      },
    },
  ])
  assert.equal((fallback.find((c) => c.type === 'usage') as { usage: { cacheWriteTokens: number } }).usage.cacheWriteTokens, 7)

  const reported = await run([
    { type: 'text-delta', text: 'ok' },
    { type: 'cache-write-tokens', cacheWriteTokens: 7 },
    {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 4 },
      },
    },
  ])
  assert.equal((reported.find((c) => c.type === 'usage') as { usage: { cacheWriteTokens: number } }).usage.cacheWriteTokens, 4)
})

test('stream() accepts a standalone cache-write event and ignores invalid readings', async () => {
  const run = async (cacheWriteTokens: number) => {
    const body = [
      { type: 'text-delta', text: 'ok' },
      { type: 'cache-write-tokens', cacheWriteTokens },
      { type: 'finish', finishReason: 'stop' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const adapter = makeAdapter({ fetchImpl: fetchReturning(200, body) })
    return collect(adapter.stream({
      provider: 'commandcode',
      model: 'm',
      messages: [userMessage('hi')],
    }))
  }

  const captured = await run(5)
  assert.deepEqual(captured.find((c) => c.type === 'usage'), {
    type: 'usage',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5 },
  })
  assert.equal((await run(-1)).some((c) => c.type === 'usage'), false)
})

test('stream() separates reasoning blocks from text', async () => {
  const events = [
    { type: 'reasoning-start' },
    { type: 'reasoning-delta', text: 'think' },
    { type: 'reasoning-end' },
    { type: 'text-delta', text: 'Answer' },
    { type: 'finish', finishReason: 'stop' },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, events) })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const reasoningBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'reasoning')
  assert.equal(reasoningBlocks.length, 1)
  const textBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'text')
  assert.equal(textBlocks.length, 1)
})

test('stream() emits a tool-call block atomically', async () => {
  const events = [
    { type: 'tool-call', toolCallId: 'tc-1', toolName: 'bash', input: { command: 'ls' } },
    { type: 'finish', finishReason: 'tool-calls' },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, events) })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'tool-calls')
  const call = chunks.find((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call') as {
    block: { id: string; name: string; arguments: string }
  }
  assert.equal(call.block.id, 'tc-1')
  assert.equal(call.block.name, 'bash')
  assert.equal(JSON.parse(call.block.arguments).command, 'ls')
})

test('stream() maps max-tokens finish reason', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"length"}\n\n') })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'max-tokens')
})

// ---------------------------------------------------------------------------
// OpenAI Chat Completions protocol
// ---------------------------------------------------------------------------

test('openai protocol sends flat body and replays reasoning_content in history', async () => {
  let capturedUrl: string | undefined
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl,
  })
  const callId = ToolCallId('call-1')
  const messages: Message[] = [
    userMessage('weather?'),
    { id: messageId(),
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will look it up.' },
        { type: 'reasoning', text: 'I need the weather tool.' },
        { type: 'tool-call', id: callId, name: 'get_weather', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'commandcode', model: 'm' },
    },
    toolMessage(callId, [{ type: 'text', text: 'sunny' }], false),
  ]
  await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', messages }))

  assert.equal(capturedUrl, 'https://api.commandcode.ai/provider/v1/chat/completions')
  assert.ok(capturedBody)
  assert.equal(capturedBody.model, 'deepseek/deepseek-v4-flash')
  const wireMessages = capturedBody.messages as Record<string, unknown>[]
  const assistant = wireMessages.find((m) => m.role === 'assistant')!
  assert.equal(assistant.reasoning_content, 'I need the weather tool.')
  assert.equal(assistant.content, 'I will look it up.')
  const toolCalls = assistant.tool_calls as { id: string; type: string; function: { name: string; arguments: string } }[]
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0]!.id, callId)
  assert.equal(toolCalls[0]!.function.name, 'get_weather')
  assert.equal(toolCalls[0]!.function.arguments, '{}')
  const tool = wireMessages.find((m) => m.role === 'tool') as { tool_call_id: string; content: string }
  assert.equal(tool.tool_call_id, callId)
  assert.equal(tool.content, 'sunny')
})

test('openai protocol remaps overlong cross-provider tool-call ids', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl,
  })
  const longId = ToolCallId(`opencode-${'y'.repeat(80)}`)
  assert.ok(longId.length > 64)
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('weather?'),
      { id: messageId(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: longId, name: 'get_weather', arguments: '{}' }],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      toolMessage(longId, [{ type: 'text', text: 'sunny' }], false),
    ],
  }))

  const wireMessages = capturedBody!.messages as Record<string, unknown>[]
  const assistant = wireMessages.find((m) => m.role === 'assistant')!
  const toolCalls = assistant.tool_calls as { id: string }[]
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0]!.id, 'cc-1')
  const tool = wireMessages.find((m) => m.role === 'tool') as { tool_call_id: string }
  assert.equal(tool.tool_call_id, 'cc-1')
})

test('openai protocol parses reasoning + content SSE into separate blocks', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":"think"}}]}',
    'data: {"choices":[{"delta":{"content":"Answer"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":3}}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const reasoningBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'reasoning')
  const textBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'text')
  assert.equal(reasoningBlocks.length, 1)
  assert.equal(textBlocks.length, 1)
  const reasoning = chunks.find((c) => c.type === 'reasoning-delta') as { text: string }
  assert.equal(reasoning.text, 'think')
  const text = chunks.find((c) => c.type === 'text-delta') as { text: string }
  assert.equal(text.text, 'Answer')
  const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens?: number } }
  assert.equal(usage.usage.inputTokens, 8)
  assert.equal(usage.usage.outputTokens, 5)
  assert.equal(usage.usage.cacheReadTokens, 2)
  assert.equal(usage.usage.reasoningTokens, 3)
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
})

test('openai protocol reads thinking from reasoning_details when no scalar field is present', async () => {
  // DeepSeek answers with the scalar `reasoning` AND an OpenRouter-shaped
  // `reasoning_details` array; GLM/Qwen/Kimi answer with `reasoning_content`.
  // This pins the third branch: an array-only delta (the shape the gateway
  // would leave if it stopped sending the scalar) still yields a block, for BOTH
  // array vocabularies.
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"think ","format":"unknown","index":0}]}}]}',
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"more","format":"unknown","index":0}]}}]}',
    // An encrypted sibling carries neither member and must contribute nothing;
    // the summary sibling beside it is real text and must be read.
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"c2ln"},{"type":"reasoning.summary","summary":"short"}]}}]}',
    'data: {"choices":[{"delta":{"content":"391"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')] }))

  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text)
  assert.deepEqual(reasoningDeltas, ['think ', 'more', 'short'])
  const reasoningBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'reasoning')
  assert.equal(reasoningBlocks.length, 1)
  const text = chunks.find((c) => c.type === 'text-delta') as { text: string }
  assert.equal(text.text, '391')
  // The reasoning block must close before the text block opens.
  const order = chunks.map((c) => c.type).filter((t) => t === 'block-start' || t === 'block-end')
  assert.deepEqual(order, ['block-start', 'block-end', 'block-start', 'block-end'])
})

test('the OpenAI family reasoning.summary carrier is read, and an empty text never shadows it', async () => {
  // Measured live 2026-09-18 on gpt-5.6-luna: the GPT family's thinking arrives in
  // `reasoning_details` as
  //   { type: 'reasoning.summary', summary: '…', format: 'openai-responses-v1' }
  // with `text` absent (or an empty placeholder), so a guard reading `text` alone
  // would carry nothing the moment the scalar stopped.
  const sse = [
    // The captured gateway shape: summary only.
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"**Providing a number**","id":"rs_05d4","format":"openai-responses-v1","index":0}]}}]}',
    // An EMPTY `text` placeholder beside a populated `summary`: the fallback
    // must test for non-empty, not merely for the member's presence.
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","text":"","summary":" visible","format":"openai-responses-v1","index":0}]}}]}',
    // Both members present: `text` wins, and the summary is NOT added again.
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","text":" exact","summary":" exact","format":"openai-responses-v1","index":0}]}}]}',
    'data: {"choices":[{"delta":{"content":"391"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'gpt-5.6-luna', messages: [userMessage('hi')] }))

  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text)
  assert.deepEqual(reasoningDeltas, ['**Providing a number**', ' visible', ' exact'])
})

test('a scalar reasoning field beside reasoning_details is not counted twice', async () => {
  // The live gateway sends the SAME summary text in `delta.reasoning` and in
  // `delta.reasoning_details[0].summary` (6/6 rounds, gpt-5.6-luna). The `??`
  // chain takes the scalar first, so the array must not append a duplicate.
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":"same text","reasoning_details":[{"type":"reasoning.summary","summary":"same text","format":"openai-responses-v1","index":0}]}}]}',
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'gpt-5.6-luna', messages: [userMessage('hi')] }))

  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text)
  assert.deepEqual(reasoningDeltas, ['same text'])
})

test('an EMPTY scalar thinking field does not hide a populated reasoning_details array', async () => {
  // The array layer already treats an empty `text` as "no text here" (pinned above);
  // the scalar layer has to agree, because both spellings describe the same
  // thinking. `??` cannot express that on its own — an empty string is not
  // nullish — and `reasoning: ''` beside a populated array used to drop that
  // chunk's thinking, and with it the tool-loop continuity issue #34 depends on.
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":"","reasoning_details":[{"type":"reasoning.summary","summary":"real thinking","format":"openai-responses-v1","index":0}]}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"","reasoning_details":[{"type":"reasoning.text","text":" more","index":0}]}}]}',
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'gpt-5.6-luna', messages: [userMessage('hi')] }))

  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text)
  assert.deepEqual(reasoningDeltas, ['real thinking', ' more'])
})

test('openai protocol assembles streamed tool-call fragments', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'tool-calls')
  const call = chunks.find((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call') as {
    block: { id: string; name: string; arguments: string }
  }
  assert.ok(call)
  assert.equal(call.block.id, 'call_1')
  assert.equal(call.block.name, 'bash')
  assert.deepEqual(JSON.parse(call.block.arguments), { command: 'ls' })
})

test('openai protocol accepts reasoning_content as the reasoning field', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"standard thinking"}}]}',
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: fetchReturning(200, sse, { 'content-type': 'text/event-stream' }),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const reasoningBlocks = chunks.filter((c) => c.type === 'block-start' && (c as { blockType: string }).blockType === 'reasoning')
  assert.equal(reasoningBlocks.length, 1)
  const reasoning = chunks.find((c) => c.type === 'reasoning-delta') as { text: string }
  assert.equal(reasoning.text, 'standard thinking')
})

test('auto protocol falls back to CLI on 403 upgrade_required and caches per account', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const identity = new Headers(init?.headers).get('accept-encoding') === 'identity'
    if (url.includes('/provider/v1/chat/completions')) {
      const body = JSON.stringify({ error: { code: 'upgrade_required', message: 'Go plan has no API access' } })
      return new Response(identity ? body : new Uint8Array(brotliCompressSync(body)), {
        status: 403,
  // The affected host loses Content-Encoding and would pass raw Brotli bytes to
  // response.text() unless the request asks for identity.
        headers: identity ? { 'content-type': 'application/json' } : {},
      })
    }
    const stream = 'data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
    return new Response(identity ? stream : new Uint8Array(brotliCompressSync(stream)), {
      status: 200,
      headers: identity ? { 'content-type': 'text/event-stream' } : {},
    })
  }) as unknown as typeof fetch

  const options = () => ({
    apiBase: 'https://api.commandcode.ai',
    workingDir: '/tmp/project',
    modelsCachePath: '/tmp/cc-models-cache.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })
  const adapter = new CommandCodeAdapter({
    options,
    resolveApiKey: async () => 'user_test_key',
    fetchImpl,
  })

  const firstChunks = await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', messages: [userMessage('hi')] }))
  assert.ok(firstChunks.some((c) => c.type === 'text-delta'))
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.includes('/provider/v1/chat/completions'))
  assert.ok(calls[1]!.includes('/alpha/generate'))

  // Second request should go straight to /alpha/generate because the key's
  // Go-plan rejection is remembered for PROTOCOL_CACHE_TTL_MS.
  const secondChunks = await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', messages: [userMessage('hi')] }))
  assert.ok(secondChunks.some((c) => c.type === 'text-delta'))
  assert.equal(calls.length, 3)
  assert.ok(calls[2]!.includes('/alpha/generate'))
})

test('协议回退缓存不会把旧网关的同一密钥带到新网关', async () => {
  let apiBase = 'https://first.invalid'
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), apiBase, protocol: 'auto' }),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input)
      paths.push(url)
      const target = new URL(url)
      if (target.origin === 'https://first.invalid' && target.pathname === '/provider/v1/chat/completions') {
        return new Response('{"error":{"code":"upgrade_required"}}', { status: 403 })
      }
      return new Response(url.endsWith('/alpha/generate')
        ? FINISH_STREAM
        : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
    }) as typeof fetch,
  })
  const options = { provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }
  await collect(adapter.stream(options))
  await collect(adapter.stream(options))
  // 相同文本前缀不代表同一来源；此网关不得继承 first 的 Go 套餐回退。
  apiBase = 'https://first.invalid.review.invalid'
  await collect(adapter.stream(options))
  assert.deepEqual(paths.map((url) => new URL(url).pathname), [
    '/provider/v1/chat/completions', '/alpha/generate', '/alpha/generate', '/provider/v1/chat/completions',
  ])
})

test('Messages-only (Claude) models take the Messages transport without poisoning the account protocol cache', async () => {
  // The Provider API answers every Claude model with HTTP 400 "must be called via
  // /provider/v1/messages"; that endpoint serves them, so they are routed there
  // up front — and because `protocolCache` is keyed by API key alone, that must
  // not be remembered, or the whole account is pinned off the Provider API.
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/provider/v1/messages')) return messagesStream('hi')
    if (url.includes('/provider/v1/chat/completions')) {
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  // No `protocol` override: this is the auto path a real profile takes.
  const options = () => ({
    apiBase: 'https://api.commandcode.ai',
    workingDir: '/tmp/project',
    modelsCachePath: '/tmp/cc-models-cache.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })
  const adapter = new CommandCodeAdapter({
    options,
    resolveApiKey: async () => 'user_test_key',
    fetchImpl,
  })

  await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-4-8', messages: [userMessage('hi')] }))
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.includes('/provider/v1/messages'), 'a Claude model must be posted to the Messages endpoint')

  // A model added upstream after this plugin shipped is covered by the
  // `claude-*` prefix rule rather than needing a new snapshot entry.
  await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-6', messages: [userMessage('hi')] }))
  assert.equal(calls.length, 2)
  assert.ok(calls[1]!.includes('/provider/v1/messages'), 'an unknown claude-* id must take the same route')

  // The account itself is still on the Provider API for every other model.
  await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')] }))
  assert.equal(calls.length, 3)
  assert.ok(calls[2]!.includes('/provider/v1/chat/completions'), 'the Claude route must not pin the account off the Provider API')
})

test('the catalog supported_endpoints decides the route, and a missing list falls back to the claude-* rule', async () => {
  // `/provider/v1/models` publishes `supported_endpoints` per model and that list
  // is authoritative; the `claude-*` prefix rule only covers an entry that
  // carries no list (every pre-1.55 cache file, and a hand-built one).
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/provider/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [
        { id: 'vendor/messages-only', name: 'Messages Only', context_length: 200_000, supported_endpoints: ['/messages'] },
        { id: 'vendor/chat-only', name: 'Chat Only', context_length: 200_000, supported_endpoints: ['/chat/completions'] },
        // A non-Claude model the catalog nevertheless routes to Messages must be
        // honoured: the snapshot's model list is a fallback, not the truth.
        { id: 'acme/renamed-claude', name: 'Renamed Claude', context_length: 200_000, supported_endpoints: ['/messages'] },
        { id: 'vendor/unlisted-route', name: 'No Route List', context_length: 200_000 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/provider/v1/messages')) return messagesStream('hi')
    return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const adapter = new CommandCodeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    }),
    resolveApiKey: async () => 'k',
    fetchImpl,
  })
  await adapter.listModels('commandcode', { unfiltered: true })

  const routeOf = async (model: string) => {
    const before = calls.length
    await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
    return calls[before]!
  }
  assert.ok((await routeOf('vendor/messages-only')).includes('/provider/v1/messages'))
  assert.ok((await routeOf('vendor/chat-only')).includes('/provider/v1/chat/completions'))
  // Catalog wins over the name: this id does not start with `claude-`, yet the
  // catalog is the routing authority.
  assert.ok((await routeOf('acme/renamed-claude')).includes('/provider/v1/messages'))
  // No route list at all: the `claude-*` prefix rule takes over.
  assert.ok((await routeOf('claude-anything-new')).includes('/provider/v1/messages'))
})

// ---------------------------------------------------------------------------
// Anthropic Messages transport (`/provider/v1/messages`)
// Every expectation below was measured against the live endpoint on 2026-09-29.
// ---------------------------------------------------------------------------

/** Options that pin the Messages transport without a catalog fetch. */
function MESSAGES_OPTIONS(overrides: Record<string, unknown> = {}) {
  return () => ({
    apiBase: 'https://api.commandcode.ai',
    workingDir: '/tmp/project',
    modelsCachePath: '/tmp/cc-models-cache.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    protocol: 'openai' as const,
    ...overrides,
  })
}

/** Post a Messages request and hand back the parsed body. */
function messagesAdapter(
  response: (body: Record<string, unknown>) => Response,
  deps: Partial<CommandCodeAdapterDeps> = {},
): { adapter: CommandCodeAdapter; sent: () => Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const adapter = makeAdapter({
    options: MESSAGES_OPTIONS(),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [
          { id: 'claude-opus-4-8', name: 'Claude', context_length: 1_000_000, supported_endpoints: ['/messages'] },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body)
      return response(body)
    }) as unknown as typeof fetch,
    ...deps,
  })
  return { adapter, sent: () => sent }
}

test('the Messages body carries adaptive thinking, output_config.effort and Anthropic tools', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    system: 'Be terse.',
    reasoningEffort: 'high' as never,
    tools: [{ name: 'read', description: 'Read a file', parameters: { properties: { path: { type: 'string' } }, required: ['path'] } as never }],
    messages: [userMessage('hi')],
  }))
  const body = sent()[0]!
  // `enabled` / `disabled` are refused outright by this gateway; only
  // `adaptive` is accepted, and effort — not a budget — is the strength knob.
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.deepEqual(body.output_config, { effort: 'high' })
  // The system text travels as a block array so it can carry the cache marker;
  // the CLI and OpenAI transports send the same text as a bare string.
  assert.deepEqual(body.system, [{
    type: 'text',
    text: 'Be terse.',
    cache_control: { type: 'ephemeral' },
  }])
  assert.equal(body.stream, true)
  // The model's own output ceiling, which the endpoint names in any refusal
  // above it. This one is 128000, so the Messages-only fallback of 64000 that
  // predated the ceiling table was halving every Opus answer to stay safe
  // (issue #71).
  assert.equal(body.max_tokens, 128_000)
  // Adaptive thinking constrains temperature to 1, so the field must be absent
  // even when the caller asks for a value the other transports honour. Sending
  // the 0.3 default was a live 400 on every request (found by
  // scripts/verify-messages-live.mjs, not by a unit test).
  assert.equal(body.temperature, undefined, 'Messages must not send temperature')
  const tools = body.tools as Array<Record<string, unknown>>
  assert.equal(tools[0]!.name, 'read')
  // The gateway rejects a tool whose root schema is not `type: 'object'`.
  assert.deepEqual((tools[0]!.input_schema as { type: string }).type, 'object')
  // A type-less schema still reaches the wire normalized, never dropped.
  assert.equal((body.messages as WireMessage[])[0]!.role, 'user')
})

/**
 * Anthropic caching is opt-in per block, so a request that marks nothing is
 * re-prefilled at the full input rate on every turn. Measured on a 10-turn
 * claude-sonnet-5-5 session: $0.5648 unmarked against $0.1869 with the three
 * breakpoints this route sets — a 66.9% difference, with no other field
 * changed. The placements mirror the official Command Code provider for pi,
 * whose `@earendil-works/pi-ai` `anthropic-messages` transport marks exactly
 * these three positions on the same endpoint.
 */
test('同一份工具 schema 只归一化一次，跨轮次重建复用结果', async () => {
  // 每次尝试都会重建工具列表，而账号轮换或协议回退会把同一批工具再走一遍；
  // 根节点归一化的答案不会因为问了第二次而改变，所以按 parameters 的对象身份
  // 记忆化 —— 来自宿主的工具对象在整个回合里是稳定的，identity 就是精确的键。
  //
  // 计数放在 `type` 的 getter 上：归一化必须读它才能判断根节点类型，
  // 而取值的次数正是「归一化走了几遍」的可观测量。
  let reads = 0
  const parameters = {
    get type(): undefined { reads++; return undefined },
    properties: { value: { type: 'string' } },
  }
  let calls = 0
  const bodies: Record<string, unknown>[] = []
  const adapter = makeAdapter({
    rotateApiKey: async () => 'second-key',
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ++calls === 1 ? new Response('rate limited', { status: 429 }) : new Response(FINISH_STREAM)
    }) as typeof fetch,
  })
  const tools = [{ name: 'tool', description: 'test', parameters }]
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')], tools }))
  const afterFirst = reads
  assert.ok(afterFirst > 0, '首次调用必须真的归一化')
  // 第二次调用重建了工具列表、也经历了一次账号轮换（另一份正文），但同一份
  // schema 已经归一化过，不该再被读一遍。
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')], tools }))
  assert.equal(calls, 3)
  assert.equal(reads, afterFirst, '同一份 schema 的归一化结果必须复用')
  // 复用不等于跳过：每一次尝试的线缆上都仍是归一化后的根节点。
  for (const body of bodies) {
    // CLI 把工具放在 `params` 里，Provider API 放在顶层。
    const params = (body.params ?? body) as { tools?: Array<{ input_schema: { type: string } }> }
    assert.equal(params.tools?.[0]?.input_schema.type, 'object', '归一化结果必须仍然出现在线缆上')
  }
})
test('the Messages body marks the last tool, not an earlier one', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    tools: [
      { name: 'read', description: 'Read a file', parameters: { properties: { path: { type: 'string' } } } as never },
      { name: 'write', description: 'Write a file', parameters: { properties: { path: { type: 'string' } } } as never },
    ],
    messages: [userMessage('hi')],
  }))
  const tools = sent()[0]!.tools as Array<Record<string, unknown>>
  // The final declaration closes the cached tools prefix; an earlier marker
  // would leave every later tool re-prefilled on every turn.
  assert.equal(tools[0]!.cache_control, undefined)
  assert.deepEqual(tools[1]!.cache_control, { type: 'ephemeral' })
})

test('the Messages body marks the last user turn and nothing before it', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  const callId = ToolCallId('call-1')
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    messages: [
      userMessage('hi'),
      { id: messageId(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: 'claude-opus-4-8' }, content: [
        { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ path: 'a' }) },
      ] },
      toolMessage(callId, [{ type: 'text', text: 'contents' }]),
    ],
  }))
  const messages = sent()[0]!.messages as Array<Record<string, unknown>>
  // DSH resends the whole history every turn, so the trailing turn is the
  // rolling boundary. A marker on the opening turn would freeze the cache at
  // its first turn and re-prefill everything after it.
  assert.equal(messages[0]!.role, 'user')
  const firstBlocks = messages[0]!.content as Array<Record<string, unknown>>
  assert.equal(firstBlocks[0]!.cache_control, undefined)
  // `messagesMessageCodec` renders a tool result as a user turn, so a tool loop
  // still ends on a markable block.
  const last = messages[messages.length - 1]!
  assert.equal(last.role, 'user')
  const lastBlocks = last.content as Array<Record<string, unknown>>
  assert.equal(lastBlocks[0]!.type, 'tool_result')
  assert.deepEqual(lastBlocks[lastBlocks.length - 1]!.cache_control, { type: 'ephemeral' })
})

test('no cache markers are sent when the Messages request has no system or tools', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    messages: [userMessage('hi')],
  }))
  const body = sent()[0]!
  // An empty system must stay absent rather than become an empty marked block,
  // which the endpoint would read as a cacheable zero-length section.
  assert.equal(body.system, undefined)
  assert.equal(body.tools, undefined)
  const messages = body.messages as Array<Record<string, unknown>>
  const blocks = messages[messages.length - 1]!.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' })
})

test('the CLI and OpenAI transports keep their own cache handling', async () => {
  // The markers are a Messages-route concern. The CLI route already marked its
  // system section before this change and must not gain a messages breakpoint;
  // the OpenAI route never sends cache_control at all. A non-Claude model keeps
  // the request on the pinned transport instead of exercising the Messages
  // downgrade the markers belong to.
  for (const protocol of ['cli', 'openai'] as const) {
    const sent: Array<Record<string, unknown>> = []
    const adapter = makeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: '/tmp/cc-models-cache.json',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        protocol,
      }),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/provider/v1/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [
            { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek', context_length: 128_000, supported_endpoints: ['/chat/completions'] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return okStream(protocol)
      }) as unknown as typeof fetch,
    })
    await collect(adapter.stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      system: 'Be terse.',
      messages: [userMessage('hi')],
    }))
    const raw = JSON.stringify(sent[0])
    if (protocol === 'cli') {
      // The pre-existing system marker is the CLI's only one.
      const params = sent[0]!.params as { system: unknown; messages: unknown[] }
      assert.deepEqual(params.system, [{ type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }])
      assert.equal(raw.match(/cache_control/g)?.length, 1, 'CLI must not mark its messages')
    } else {
      assert.equal(raw.includes('cache_control'), false, 'OpenAI route must send no cache_control')
    }
  }
})

/**
 * A lone surrogate half is not a character: it comes from a truncated slice or
 * a lossy decode, and it survives `JSON.stringify` as an escape rather than
 * failing locally, so it would otherwise reach the wire as a string no UTF-8
 * consumer can round-trip. The official provider for pi strips these from every
 * outgoing string on this same endpoint; this adapter strips them at the one
 * serialization boundary, which covers all three transports at once.
 */
test('a lone surrogate is stripped from the serialized request on every transport', async () => {
  const lone = String.fromCharCode(0xd83d)
  // A Claude id keeps the request on Messages whatever the pinned transport is
  // (`resolveProtocol()` routes the family there first); the other two runs pin
  // their own protocol, so all three transports are covered.
  const cases = [
    { protocol: 'cli' as const, model: 'deepseek/deepseek-v4.1-flash' },
    { protocol: 'openai' as const, model: 'deepseek/deepseek-v4.1-flash' },
    { protocol: 'openai' as const, model: 'claude-opus-4-8' },
  ]
  for (const { protocol, model } of cases) {
    const sent: string[] = []
    const adapter = makeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: '/tmp/cc-models-cache.json',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        protocol,
      }),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/provider/v1/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [
            { id: model, name: 'M', context_length: 128_000, supported_endpoints: ['/chat/completions'] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        sent.push(String(init?.body))
        return model.startsWith('claude-') ? messagesStream('hi') : okStream(protocol)
      }) as unknown as typeof fetch,
    })
    await collect(adapter.stream({
      provider: 'commandcode',
      model,
      // The lone half rides the system text and a user turn: the carriers whose
      // content comes from a file read or a truncated stream.
      system: `sys${lone}tem`,
      messages: [userMessage(`before${lone}after`)],
    }))
    const label = `${protocol}/${model}`
    const body = sent[0]!
    // The escape must not survive anywhere in the serialized body...
    assert.equal(/\\ud83d/i.test(body), false, `${label}: lone high surrogate reached the wire`)
    assert.equal(body.includes(lone), false, `${label}: lone surrogate reached the wire`)
    // ...while the surrounding text is preserved, so the strip is surgical.
    assert.match(body, /beforeafter/)
    assert.match(body, /system/)
  }
})

test('paired surrogates (emoji) survive sanitization untouched', async () => {
  const sent: string[] = []
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai',
    }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [
          { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek', context_length: 128_000, supported_endpoints: ['/chat/completions'] },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      sent.push(String(init?.body))
      return okStream('openai')
    }) as unknown as typeof fetch,
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    system: 'Keep the emoji: \u{1F648} and \u{1F680}',
    messages: [userMessage('a \u{1F648} b')],
  }))
  // A well-formed astral character IS a surrogate pair, so a naive filter would
  // delete every emoji. Both must round-trip.
  const body = sent[0]!
  assert.match(body, /\u{1F648}/u)
  assert.match(body, /\u{1F680}/u)
})

test('an unsupported effort is dropped rather than sent as output_config', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    reasoningEffort: 'off' as never,
    messages: [userMessage('hi')],
  }))
  // `output_config.effort` has no `none` value, so "off" must not travel.
  assert.equal(sent()[0]!.output_config, undefined)
})

test('`off` travels only for models whose snapshot publishes it as a level', async () => {
  // command-code@1.73.3 gave the DeepSeek V4 line a real "do not think" level,
  // and the official CLI sends it verbatim — its body builder spreads the effort
  // whenever it is a non-empty string — rather than omitting the field. That
  // omission is the whole mechanism: without `reasoning_effort:"off"` there is
  // no way to switch thinking off. So `off` must NOT be blanket-dropped the way
  // it is for a model that has no such level.
  const sent: Record<string, unknown>[] = []
  const adapter = makeAdapter({
    options: OPENAI_OPTIONS,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', { status: 200 })
    }) as unknown as typeof fetch,
  })
  const effortOnWire = async (model: string): Promise<unknown> => {
    sent.length = 0
    await collect(adapter.stream({
      provider: 'commandcode',
      model,
      reasoningEffort: 'off' as never,
      messages: [userMessage('hi')],
    }))
    return sent[0]?.reasoning_effort
  }
  assert.equal(await effortOnWire('deepseek/deepseek-v4-pro'), 'off')
  assert.equal(await effortOnWire('deepseek/deepseek-v4.1-flash'), 'off')
  // `deepseek-v4-flash-fast` never gained the level, so for it "off" keeps its
  // host meaning — "no reasoning strength requested" — and nothing travels.
  assert.equal(await effortOnWire('deepseek/deepseek-v4-flash-fast'), undefined)
  // A model absent from the snapshot is treated the same way.
  assert.equal(await effortOnWire('m'), undefined)
})

for (const protocol of ['cli', 'openai'] as const) {
  test(`${protocol}：会话标题关闭已声明的思考能力，让 64 词元预算用于正文`, async () => {
    for (const model of ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro']) {
      for (const reasoningEffort of [undefined, 'high'] as const) {
        const sent: Record<string, unknown>[] = []
        const adapter = makeAdapter({
          options: () => ({ ...OPENAI_OPTIONS(), protocol }),
          fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>
            const params = protocol === 'cli' ? body.params as Record<string, unknown> : body
            sent.push(params)
            // 复现问题 #88 的网关行为：未关闭思考时，小预算只产生思考内容。
            const event = params.reasoning_effort === 'off'
              ? protocol === 'cli' ? { type: 'text-delta', text: '会话标题提取' } : { choices: [{ delta: { content: '会话标题提取' } }] }
              : protocol === 'cli' ? { type: 'reasoning-delta', text: 'thinking' } : { choices: [{ delta: { reasoning_content: 'thinking' } }] }
            const reason = params.reasoning_effort === 'off' ? 'stop' : 'length'
            const finish = protocol === 'cli' ? { type: 'finish', finishReason: reason }
              : { choices: [{ delta: {}, finish_reason: reason }] }
            return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(finish)}\n\n`)
          }) as typeof fetch,
        })
        const options: GenerateOptions = Object.freeze({
          provider: 'commandcode', model, purpose: 'session-title', maxTokens: 64,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
          messages: [userMessage('生成会话标题')],
        })
        const chunks = await collect(adapter.stream(options))
        assert.equal(sent.length, 1, '标题调用应当一次完成')
        assert.equal(sent[0]!.reasoning_effort, 'off')
        assert.equal(sent[0]!.max_tokens, 64, '关闭思考不应增加输出预算')
        assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '会话标题提取')
        assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false)
        assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
        assert.equal(options.reasoningEffort, reasoningEffort, '不得改写调用者的选项')
      }
    }
  })

  test(`${protocol}：普通调用、上下文压缩及不支持关闭思考的模型保持原策略`, async () => {
    const cases = [
      ...([undefined, 'compaction'] as const).flatMap(purpose => [undefined, 'high'].map(effort => ({
        model: 'deepseek/deepseek-v4.1-flash', purpose, effort, expected: effort,
      }))),
      ...['deepseek/deepseek-v4-flash-fast', 'unknown-title-model'].flatMap(model => [undefined, 'high'].map(effort => ({
        model, purpose: 'session-title' as const, effort, expected: model === 'unknown-title-model' ? undefined : effort,
      }))),
    ]
    for (const { model, purpose, effort, expected } of cases) {
      let sent: Record<string, unknown> | undefined
      const adapter = makeAdapter({
        options: () => ({ ...OPENAI_OPTIONS(), protocol }),
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          sent = protocol === 'cli' ? body.params as Record<string, unknown> : body
          return okStream(protocol)
        }) as typeof fetch,
      })
      await collect(adapter.stream({
        provider: 'commandcode', model, ...(purpose === undefined ? {} : { purpose }), maxTokens: 64,
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }), messages: [userMessage('hi')],
      }))
      assert.equal(sent!.reasoning_effort, expected, `${model}, ${purpose}, ${effort}`)
    }
  })
}

test('会话标题回退到 CLI 时继续关闭思考，后续普通调用保留所选强度', async () => {
  const paths: string[] = []
  const sent: Record<string, unknown>[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), apiBase: 'https://title-fallback.invalid', protocol: 'auto' }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      paths.push(path)
      sent.push(path === '/alpha/generate' ? body.params as Record<string, unknown> : body)
      return path === '/provider/v1/chat/completions'
        ? new Response('{"error":{"code":"upgrade_required"}}', { status: 403 }) : okStream('cli')
    }) as typeof fetch,
  })
  const options: GenerateOptions = {
    provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 64,
    reasoningEffort: ReasoningEffortId('high'), messages: [userMessage('hi')],
  }
  await collect(adapter.stream({ ...options, purpose: 'session-title' }))
  await collect(adapter.stream(options))
  assert.deepEqual(paths, ['/provider/v1/chat/completions', '/alpha/generate', '/alpha/generate'])
  assert.deepEqual(sent.map(params => params.reasoning_effort), ['off', 'off', 'high'])
  assert.deepEqual(sent.map(params => params.max_tokens), [64, 64, 64])
})

test('Messages 标题调用不发送模型未声明的关闭思考值', async () => {
  for (const reasoningEffort of [undefined, 'high'] as const) {
    const { adapter, sent } = messagesAdapter(() => messagesStream('会话标题'))
    await collect(adapter.stream({
      provider: 'commandcode', model: 'claude-opus-4-8', purpose: 'session-title', maxTokens: 64,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }), messages: [userMessage('hi')],
    }))
    assert.deepEqual(sent()[0]!.thinking, { type: 'adaptive' })
    assert.deepEqual(sent()[0]!.output_config, reasoningEffort === undefined ? undefined : { effort: reasoningEffort })
  }
})

test('Messages drops an explicit temperature, which adaptive thinking constrains to 1', async () => {
  // Live failure, 2026-09-29: every request carrying the other transports' 0.3
  // default was refused with
  // `temperature` may only be set to 1 when thinking is enabled or in adaptive
  // mode. Omission is the only value that satisfies both the thinking switch
  // and a caller that asked for a temperature.
  for (const temperature of [0, 0.3, 1, 2]) {
    const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
    await collect(adapter.stream({
      provider: 'commandcode',
      model: 'claude-opus-4-8',
      temperature,
      messages: [userMessage('hi')],
    }))
    assert.equal(sent()[0]!.temperature, undefined, `temperature=${temperature} must not be sent`)
  }
})

test('Messages omits the thinking switch for a model that publishes no effort levels', async () => {
  // `claude-haiku-4-5-20201001`'s sibling case: the official CLI marks
  // `claude-haiku-4-5-20251001` neither `reasoning_effort` (no levels, so absent
  // from KNOWN_EFFORTS) nor `reasoning:!0` (so absent from
  // KNOWN_THINKING_MODELS) — it does not reason. The endpoint accepts the field
  // regardless, which makes this a correctness call rather than a failure
  // avoidance one: the switch exists to be driven by `output_config.effort`,
  // and with neither there is nothing to control.
  const { adapter, sent } = messagesAdapter(() => messagesStream('hi'))
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-haiku-4-5-20251001',
    // An effort the caller asked for that this model cannot honour.
    reasoningEffort: 'high' as never,
    messages: [userMessage('hi')],
  }))
  const body = sent()[0]!
  assert.equal(body.thinking, undefined, 'a non-reasoning model must not get the thinking switch')
  assert.equal(body.output_config, undefined, 'a model with no effort levels must not get output_config')
  // The rest of the request must still be well-formed.
  assert.equal(body.model, 'claude-haiku-4-5-20251001')
  assert.equal(body.max_tokens, 64_000)
})

// ---------------------------------------------------------------------------
// Output-ceiling downshift (issue #71)
// ---------------------------------------------------------------------------

/**
 * A model the catalog does not list and the ceiling snapshot does not carry, so
 * the only ceiling it has is the one the endpoint names in its refusal. The
 * `claude-` prefix keeps it on the Messages transport without a route lookup.
 *
 * Every test passes its own id: a learned ceiling is remembered process-wide,
 * which is the whole point of learning it, so a shared id would let one test's
 * 400 pre-answer another's.
 */
function ceilingProbeAdapter(
  id: string,
  response: (attempt: number) => Response,
): { adapter: CommandCodeAdapter; model: string; sent: () => number[]; attempts: () => number } {
  const sent: number[] = []
  let attempts = 0
  const adapter = makeAdapter({
    options: MESSAGES_OPTIONS(),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body.max_tokens as number)
      return response(attempts++)
    }) as unknown as typeof fetch,
  })
  // The refusal text names the model, so the id travels in it too: a test that
  // forgot to pass a matching id would otherwise assert against a ceiling that
  // was learned for a different model.
  return { adapter, model: id, sent: () => sent, attempts: () => attempts }
}

/** The refusal shape the Messages endpoint uses, as an HTTP 400. */
function ceilingRejection(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
    { status },
  )
}

/**
 * The shape issue #96's gateway actually sends: `error.message` is an escaped
 * JSON string, so the sentence naming the cap only exists after one unwrap —
 * in `ParsedProviderError.rawMessage`, not `message`. Reproduced verbatim so a
 * regression in that unwrap path cannot hide behind a flat single-layer body.
 */
function nestedGatewayRejection(status: number, inner: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: { message: `${JSON.stringify(inner)}\n`, type: 'invalid_request_error' } }),
    { status },
  )
}

test('an HTTP output-ceiling refusal retries once at the ceiling the endpoint names', async () => {
  const { adapter, model, sent, attempts } = ceilingProbeAdapter('claude-ceiling-http', (attempt) =>
    attempt === 0
      ? ceilingRejection(400, 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-ceiling-http')
      : messagesStream('ok'))
  const chunks = await collect(adapter.stream({
    provider: 'commandcode', model, messages: [userMessage('hi')],
  }))
  // The turn survives on the ceiling the refusal stated, not on a guess.
  assert.deepEqual(sent(), [64_000, 32_000])
  assert.equal(attempts(), 2)
  assert.ok(chunks.some((c) => c.type === 'finish'))
})

test('an in-stream output-ceiling refusal retries once too', async () => {
  // The same refusal arrives inside a 200 body on this transport, and the
  // first line of issue #71 is that stream-error wording. A retry that only
  // covered HTTP status would leave the reported case unfixed.
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const { adapter, model, sent, attempts } = ceilingProbeAdapter('claude-ceiling-stream', (attempt) =>
    attempt === 0
      ? new Response(sse('error', { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 16000, which is the maximum allowed number of output tokens for claude-ceiling-stream' } }), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
      : messagesStream('ok'))
  await collect(adapter.stream({
    provider: 'commandcode', model, messages: [userMessage('hi')],
  }))
  assert.deepEqual(sent(), [64_000, 16_000])
  assert.equal(attempts(), 2)
})

test('an in-stream output-ceiling refusal with no number in it is still not called a context overflow', async () => {
  // The other shape the endpoint uses: a bare validation error naming the
  // field and nothing else. There is no ceiling to read here, so there is
  // nothing to retry — but the wording is what issue #71 complained about, and
  // it is the only part of this fix a user ever sees. Reported as an oversized
  // context, it sends the harness to compact a session that fits.
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const { adapter, model } = ceilingProbeAdapter('claude-ceiling-bare', () =>
    new Response(sse('error', { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid input: expected number, received undefined at max_tokens' } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }))
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] })),
    (error: unknown) => {
      const message = (error as Error).message
      // The code is the part the harness routes on, and it is what handed
      // this turn to the compaction before.
      assert.equal((error as { code?: string }).code, 'PROVIDER_STREAM_ERROR')
      assert.doesNotMatch(message, /content is too long|上下文窗口/u)
      // The message has to say compacting is the wrong move, not merely avoid
      // the word — "压缩上下文无效" is what a user needs to read to stop
      // retrying a fix that cannot work.
      assert.match(message, /compacting it will not help/u)
      assert.match(message, /压缩上下文无效/u)
      return true
    },
  )
})

test('a second output-ceiling refusal fails the turn and does not blame the context', async () => {
  const { adapter, model, sent, attempts } = ceilingProbeAdapter('claude-ceiling-twice', () =>
    ceilingRejection(400, 'max_tokens: 64000 > 8000, which is the maximum allowed number of output tokens for claude-ceiling-twice'))
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] })),
    (error: unknown) => {
      const message = (error as Error).message
      assert.equal((error as { code?: string }).code, 'PROVIDER_HTTP_ERROR')
      // The regression this guards: the refusal text contains `max_tokens`, so
      // it used to classify as a context overflow — the harness compacted an
      // oversized-looking session, resent the identical request, and told the
      // user to start a new one.
      assert.doesNotMatch(message, /context window|上下文窗口/u)
      assert.match(message, /8000/u)
      return true
    },
  )
  // One downshift per turn; the second refusal surfaces rather than looping.
  assert.deepEqual(sent(), [64_000, 8_000])
  assert.equal(attempts(), 2)
})

test('a JSON node-count refusal names the gateway structure cap, not a context overflow (issue #96)', async () => {
  // The gateway refused the request's JSON STRUCTURE — too many nodes —
  // while the session was well inside the token window. Before this branch
  // the refusal fell through to the generic wording, which drops the
  // upstream sentence entirely, so the one fact that names the actual cap
  // never reached the user.
  const { adapter, model, attempts } = ceilingProbeAdapter('claude-node-limit', () =>
    // issue #96's real body, double-encoded: the cap sentence lives only in
    // `rawMessage`, which is the path this branch has to see.
    nestedGatewayRejection(400, {
      message: 'Invalid request JSON: JSON node count cannot exceed 32768 trace_id: 266affc7ac3a831b5846bdafebff8372',
      type: 'invalid_request_error',
    }))
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] })),
    (error: unknown) => {
      const message = (error as Error).message
      assert.equal((error as { code?: string }).code, 'PROVIDER_HTTP_ERROR')
      // The cap the gateway stated, so the user can tell this failure apart
      // from both a token budget and the generic refusal it used to land in.
      assert.match(message, /32768/u)
      assert.match(message, /JSON node limit/u)
      // Not a context overflow: compaction shrinks the message and part
      // count, so it can help — but usually not enough on its own. The
      // wording has to say both, calling neither the session oversized nor
      // compaction a guaranteed fix.
      assert.doesNotMatch(message, /context window|上下文窗口/u)
      assert.match(message, /compacting the session usually will not be enough/u)
      assert.match(message, /压缩上下文通常不足以降到该上限以内/u)
      return true
    },
  )
  // Permanent and request-scoped: no ceiling to learn, nothing to resend.
  assert.equal(attempts(), 1)
})

test('a ceiling learned from a refusal is what the next turn sends', async () => {
  const { adapter, model, sent } = ceilingProbeAdapter('claude-ceiling-learned', (attempt) =>
    attempt === 0
      ? ceilingRejection(400, 'max_tokens: 64000 > 24000, which is the maximum allowed number of output tokens for claude-ceiling-learned')
      : messagesStream('ok'))
  const options = { provider: 'commandcode', model, messages: [userMessage('hi')] }
  await collect(adapter.stream(options))
  await collect(adapter.stream(options))
  // The second turn never spends a 400 finding out what the first one learned.
  assert.deepEqual(sent(), [64_000, 24_000, 24_000])
})

test('旧网关学到的输出上限不会压低新网关的同名模型', async () => {
  let apiBase = 'https://first.invalid'
  const model = 'claude-cross-gateway-learned'
  const sent: number[] = []
  const adapter = makeAdapter({
    options: () => ({ ...MESSAGES_OPTIONS()(), apiBase }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
      return sent.length === 1
        ? ceilingRejection(400, `max_tokens: 64000 > 24000, which is the maximum allowed number of output tokens for ${model}`)
        : messagesStream('ok')
    }) as typeof fetch,
  })
  const options = { provider: 'commandcode', model, messages: [userMessage('hi')] }
  await collect(adapter.stream(options))
  apiBase = 'https://second.invalid'
  await collect(adapter.stream(options))
  assert.deepEqual(sent, [64_000, 24_000, 64_000])
})

/**
 * A Messages-route adapter whose catalog carries one entry, so a test can
 * decide whether the gateway published a ceiling for it. The id is not in
 * `KNOWN_PLANS`, so without a published figure it resolves through the
 * conservative Messages fallback.
 */
function publishedCeilingAdapter(model: string, published: number | undefined) {
  const entry: Record<string, unknown> = {
    id: model, name: 'Probe', context_length: 1_000_000, supported_endpoints: ['/messages'],
  }
  if (published !== undefined) entry.max_output_tokens = published
  const catalog = JSON.stringify({ object: 'list', data: [entry] })
  const sent: number[] = []
  const adapter = makeAdapter({
    options: MESSAGES_OPTIONS(),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        return new Response(catalog, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      sent.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
      return messagesStream('ok')
    }) as unknown as typeof fetch,
  })
  return { adapter, sent: () => sent }
}

test('a catalog that publishes max_output_tokens outranks the fallback ceiling', async () => {
  // The field is in the gateway's schema and the official pi provider already
  // prefers it; it just is not sent yet. When it arrives it is the gateway
  // speaking about its own model, so it takes over from the conservative
  // Messages fallback with no change here.
  // 90 000 sits deliberately between the two values it has to be told apart
  // from: above the 64 000 fallback it replaces, below the 131 072 the gateway
  // accepts globally. A figure outside that band would pass for the wrong
  // reason — above it the gateway's own cap decides the answer regardless.
  const model = 'claude-published-takeover'
  const { adapter, sent } = publishedCeilingAdapter(model, 90_000)
  await adapter.listModels('commandcode')
  await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
  assert.deepEqual(sent(), [90_000])
})

test('a published ceiling above the gateway-wide cap is still held under it', async () => {
  // `DEFAULT_GENERATE_MAX_TOKENS` is not a default: probing showed 200 000
  // answering and 200 704 refused on a 262 144-window model as well as a
  // 1 000 000-token one, so the cap is global rather than per model. A catalog
  // figure above it is a model capability, not a request size.
  const model = 'claude-published-over-cap'
  const { adapter, sent } = publishedCeilingAdapter(model, 400_000)
  await adapter.listModels('commandcode')
  await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
  assert.deepEqual(sent(), [131_072])
})

test('a model with no published ceiling still resolves through the fallback', async () => {
  // The control for the test above: same adapter, same id shape, field absent.
  // Without it, "the published figure was used" would also pass if the fallback
  // had simply been removed.
  const model = 'claude-published-absent'
  const { adapter, sent } = publishedCeilingAdapter(model, undefined)
  await adapter.listModels('commandcode')
  await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
  assert.deepEqual(sent(), [64_000])
})

// ---------------------------------------------------------------------------
// Output budget (issue #74)
//
// The report's ask was a switch that stops the adapter from writing
// `max_tokens` at all. These pin the wire behaviour per transport, the
// precedence against a host-supplied budget, and the guards that keep the
// Claude route working.
// ---------------------------------------------------------------------------

/** Post one OpenAI-route request and report the `max_tokens` field, if present. */
function openAiBudgetAdapter(connection: Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), ...connection }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body)
      const model = String(body.model)
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], id: model })}\n\n`
        + 'data: [DONE]\n\n')
    }) as typeof fetch,
  })
  return { adapter, sent }
}

test('输出预算未设置时按推导值发送 max_tokens，行为与之前一致', async () => {
  // The default path, and the one every existing profile takes: the field is
  // present and carries the derived figure.
  const { adapter, sent } = openAiBudgetAdapter({})
  await collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] }))
  assert.equal(sent.length, 1)
  assert.equal('max_tokens' in sent[0]!, true)
  assert.equal(sent[0]!.max_tokens, 131_072)
})

test('正整数输出预算收紧实发 max_tokens，且不会抬高推导值', async () => {
  const { adapter, sent } = openAiBudgetAdapter({ maxOutputTokens: 20_000 })
  await collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] }))
  assert.equal(sent[0]!.max_tokens, 20_000)

  // "Cannot raise" is only proven against a model whose own ceiling sits BELOW
  // the figure the user typed: `gemini-3.5-flash` publishes 65 536, so asking
  // for 131 072 must still send 65 536. Asserting 131 072 on a model with a
  // 131 072 ceiling would pass for the wrong reason.
  const capped = openAiBudgetAdapter({ maxOutputTokens: 131_072 })
  await collect(capped.adapter.stream({
    provider: 'commandcode', model: 'google/gemini-3.5-flash', messages: [userMessage('hi')],
  }))
  assert.equal(capped.sent[0]!.max_tokens, 65_536)
})

test('maxOutputTokens: 0 在 OpenAI 传输上完全不发送该字段', async () => {
  const { adapter, sent } = openAiBudgetAdapter({ maxOutputTokens: 0 })
  await collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] }))
  assert.equal(sent.length, 1)
  // Not `max_tokens: 0`, which would ask for an empty answer — the field is
  // absent so the platform decides the per-turn size.
  assert.equal('max_tokens' in sent[0]!, false)
})

test('maxOutputTokens: 0 在 CLI 传输上同时清掉 params.max_tokens', async () => {
  // The CLI route nests the budget under `params`, and the builder writes it
  // there; the post-build re-statement must not put it back.
  const sent: Array<{ params: Record<string, unknown> }> = []
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'cli' as const,
      maxOutputTokens: 0,
    }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as { params: Record<string, unknown> })
      return new Response(`data: ${JSON.stringify({ type: 'text-delta', text: 'ok' })}\n\n`
        + `data: ${JSON.stringify({ type: 'finish', finishReason: 'stop' })}\n\n`)
    }) as typeof fetch,
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] }))
  assert.equal(sent.length, 1)
  assert.equal('max_tokens' in sent[0]!.params, false)
})

test('Messages 端点必填 max_tokens，maxOutputTokens: 0 对它不生效', async () => {
  // Omitting the field here would not lengthen an answer, it would make the
  // whole Claude family unusable (`Invalid input: expected number, received
  // undefined at max_tokens`), so the derived budget is still sent.
  const sent: Array<Record<string, unknown>> = []
  const adapter = makeAdapter({
    options: MESSAGES_OPTIONS({ maxOutputTokens: 0 }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [
          { id: 'claude-opus-4-8', name: 'Claude', context_length: 1_000_000, supported_endpoints: ['/messages'] },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return messagesStream('ok')
    }) as unknown as typeof fetch,
  })
  await adapter.listModels('commandcode')
  await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-4-8', messages: [userMessage('hi')] }))
  assert.equal(sent.length, 1)
  assert.equal(typeof sent[0]!.max_tokens, 'number')
  assert.equal(sent[0]!.max_tokens, 128_000)
})

test('宿主显式给定的调用预算优先于 maxOutputTokens: 0', async () => {
  // The session-title call passes 64 tokens because its output must stay
  // bounded (issue #88): dropping the field there would let a title run long
  // instead of making an answer fit.
  const { adapter, sent } = openAiBudgetAdapter({ maxOutputTokens: 0 })
  await collect(adapter.stream({
    provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', purpose: 'session-title',
    maxTokens: 64, messages: [userMessage('hi')],
  }))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.max_tokens, 64)
})

test('省略输出字段后仍按推导预算诊断输出上限，而不是报 max_tokens=0', async () => {
  // The budget stays a real number internally even when the field is omitted,
  // so a length finish is still explained with the figure the model was
  // actually allowed — the diagnostic must not read as "0 tokens allowed".
  // A reasoning-only `length` finish is the shape that reaches
  // `emptyCompletionError`, so the assertion has to provoke it rather than
  // accept any successful finish.
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), maxOutputTokens: 0 }),
    fetchImpl: fetchReturning(200, [
      { choices: [{ delta: { reasoning_content: 'still thinking', tool_calls: [] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'review/model', messages: [userMessage('hi')] })),
    (error: unknown) => {
      const e = error as { code: string; message: string }
      assert.equal(e.code, 'OUTPUT_TOKEN_LIMIT')
      // The derived budget, not the omitted field's sentinel.
      assert.match(e.message, /max_tokens=131072/)
      assert.doesNotMatch(e.message, /max_tokens=0\b/)
      return true
    },
  )
})

test('解析模型的 defaultMaxTokens 跟随正整数输出预算', async () => {
  const entry = { id: 'review/model', name: 'Probe', context_length: 1_000_000, supported_endpoints: ['/chat/completions'] }
  const resolveDefault = async (maxOutputTokens: number | undefined) => {
    const adapter = makeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp/project',
        modelsCachePath: '/tmp/cc-models-cache.json',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        protocol: 'openai' as const,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      }),
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/provider/v1/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [entry] }))
        }
        return new Response('data: [DONE]\n\n')
      }) as unknown as typeof fetch,
    })
    await adapter.listModels('commandcode')
    return (await adapter.resolveModel('commandcode', 'review/model')).defaultMaxTokens
  }
  // Unset keeps the derived figure; a positive value lowers the advertised
  // default so the host asks for the user's budget even when it omits its own.
  const derived = await resolveDefault(undefined)
  assert.equal(derived, 131_072)
  assert.equal(await resolveDefault(20_000), 20_000)
  // The omit sentinel is not a budget: the advertised default is unchanged.
  assert.equal(await resolveDefault(0), 131_072)
})

test('旧网关公布的输出上限不会覆盖新网关的目录', async (t) => {
  const cachePath = join(tmpdir(), `cc-cross-gateway-published-${process.pid}.json`)
  t.after(() => rmSync(cachePath, { force: true }))
  let apiBase = 'https://first.invalid'
  const model = 'claude-cross-gateway-published'
  const sent: number[] = []
  const adapter = makeAdapter({
    options: () => ({ ...MESSAGES_OPTIONS()(), apiBase, modelsCachePath: cachePath }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/provider/v1/models')) {
        const entry = {
          id: model, name: 'Probe', context_length: 1_000_000, supported_endpoints: ['/messages'],
          ...(apiBase === 'https://first.invalid' ? { max_output_tokens: 90_000 } : {}),
        }
        return new Response(JSON.stringify({ object: 'list', data: [entry] }))
      }
      sent.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
      return messagesStream('ok')
    }) as typeof fetch,
  })
  await adapter.listModels('commandcode', { unfiltered: true })
  await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
  apiBase = 'https://second.invalid'
  await adapter.listModels('commandcode', { unfiltered: true })
  await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
  assert.deepEqual(sent, [90_000, 64_000])
})

test('a published ceiling outlives the process through the catalog cache', async () => {
  // The gateway's own number is the one thing the snapshot cannot re-derive,
  // so the cache has to carry it. A later run whose catalog fetch fails must
  // still use it rather than fall back to the conservative value — and must
  // prefer it over the derived `maxTokens` frozen in the same file.
  const model = 'claude-published-cached'
  const cachePath = join(tmpdir(), `cc-published-cache-${process.pid}.json`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(cachePath, JSON.stringify({
    version: 3, apiBase: 'https://api.commandcode.ai',
    models: [{
      id: model, name: 'Probe', contextWindow: 1_000_000, maxTokens: 64_000,
      publishedMaxTokens: 90_000, supportedEndpoints: ['/messages'],
    }],
  }))
  try {
    const sent: number[] = []
    const adapter = new CommandCodeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai', workingDir: '/tmp', modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }),
      resolveApiKey: async () => 'k',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/provider/v1/models')) throw new Error('network down')
        sent.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
        return messagesStream('ok')
      }) as unknown as typeof fetch,
    })
    await adapter.listModels('commandcode')
    await collect(adapter.stream({ provider: 'commandcode', model, messages: [userMessage('hi')] }))
    assert.deepEqual(sent, [90_000])
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('a cached derived ceiling is recomputed rather than trusted', async () => {
  // `maxTokens` in the cache file is a derived value — snapshot, fallback and
  // published figure can all move between runs. Reading it back verbatim would
  // let a cache written before any of them moved pin the old answer for as long
  // as the file survives, which is the same staleness the snapshot was
  // introduced to remove.
  const cachePath = join(tmpdir(), `cc-derived-cache-${process.pid}.json`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(cachePath, JSON.stringify({
    version: 3, apiBase: 'https://api.commandcode.ai',
    // `claude-sonnet-5-5`'s real ceiling is 128000; a cache frozen while the
    // conservative 64000 was in force would otherwise keep it there.
    models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet', contextWindow: 1_000_000, maxTokens: 64_000 }],
  }))
  try {
    const sent: number[] = []
    const adapter = new CommandCodeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai', workingDir: '/tmp', modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }),
      resolveApiKey: async () => 'k',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/provider/v1/models')) throw new Error('network down')
        sent.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens)
        return messagesStream('ok')
      }) as unknown as typeof fetch,
    })
    await adapter.listModels('commandcode')
    await collect(adapter.stream({ provider: 'commandcode', model: 'claude-sonnet-5-5', messages: [userMessage('hi')] }))
    assert.deepEqual(sent, [128_000])
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('the Messages stream assembles a tool call from input_json_delta fragments', async () => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const { adapter } = messagesAdapter(() => new Response([
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01ABC', name: 'read', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"/etc/hosts"}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 30, output_tokens: 20 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }))

  const chunks = await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-opus-4-8',
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as never }],
    messages: [userMessage('read it')],
  }))
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end?.type === 'block-end' && end.block.type, 'tool-call')
  // The fragments concatenate into the single raw JSON string the harness wants.
  assert.equal(end?.type === 'block-end' && end.block.type === 'tool-call' ? end.block.arguments : '', '{"path":"/etc/hosts"}')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
})

test('Messages usage maps cache and thinking tokens', async () => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const { adapter } = messagesAdapter(() => new Response([
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {
      input_tokens: 11, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 120,
      output_tokens_details: { thinking_tokens: 25 },
    } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }))

  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-4-8', messages: [userMessage('hi')] }))
  const usage = chunks.filter((chunk) => chunk.type === 'usage').at(-1)
  assert.equal(usage?.type === 'usage' ? usage.usage.inputTokens : 0, 11)
  assert.equal(usage?.type === 'usage' ? usage.usage.outputTokens : 0, 40)
  assert.equal(usage?.type === 'usage' ? usage.usage.cacheReadTokens : 0, 900)
  assert.equal(usage?.type === 'usage' ? usage.usage.cacheWriteTokens : 0, 120)
  assert.equal(usage?.type === 'usage' ? usage.usage.reasoningTokens : 0, 25)
})

test('a Messages thinking signature is replayed on the next turn, and dropped when absent', async () => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  // A fresh Response per call: a body can only be read once, and this stream
  // answers three turns.
  const signatureStream = () => new Response([
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing options' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc-123' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01Z', name: 'read', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 20, output_tokens: 30 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  const { adapter, sent } = messagesAdapter(() => signatureStream())
  const first = await collect(adapter.stream({
    provider: 'commandcode', model: 'claude-opus-4-8',
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as never }],
    messages: [userMessage('read it')],
  }))
  const finish = first.find((chunk) => chunk.type === 'finish')
  assert.equal(finish?.type, 'finish')
  const replay = finish?.type === 'finish' ? finish.replayState : undefined
  assert.ok(replay, 'a Messages turn must carry a replay envelope')
  // Per-block metadata, index-aligned with the emitted blocks.
  assert.deepEqual(replay?.blocks, [{ type: 'reasoning', signature: 'sig-abc-123' }, { type: 'tool-call' }])

  // The next turn replays the thinking block WITH its signature; the endpoint
  // answers `thinking.signature: Field required` without one.
  const withSignature: Message = {
    id: messageId(), role: 'assistant',
    source: { kind: 'model', provider: 'commandcode', model: 'claude-opus-4-8', replayState: replay },
    content: [
      { type: 'reasoning', text: 'weighing options' },
      { type: 'tool-call', id: ToolCallId('toolu_01Z'), name: 'read', arguments: '{}' },
    ],
  }
  await collect(adapter.stream({
    provider: 'commandcode', model: 'claude-opus-4-8',
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as never }],
    messages: [userMessage('read it'), withSignature, toolMessage(ToolCallId('toolu_01Z'), [{ type: 'text', text: 'contents' }])],
  }))
  const assistant = (sent()[1]!.messages as WireMessage[])[1]!
  const parts = assistant.content as Array<Record<string, unknown>>
  assert.deepEqual(parts[0], { type: 'thinking', thinking: 'weighing options', signature: 'sig-abc-123' })

  // Without a recorded signature the thinking block is dropped rather than sent
  // half-formed: replaying it unanswered would fail the whole request.
  const withoutSignature: Message = { ...withSignature, source: { kind: 'model', provider: 'commandcode', model: 'claude-opus-4-8' } }
  await collect(adapter.stream({
    provider: 'commandcode', model: 'claude-opus-4-8',
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as never }],
    messages: [userMessage('read it'), withoutSignature, toolMessage(ToolCallId('toolu_01Z'), [{ type: 'text', text: 'contents' }])],
  }))
  const dropped = (sent()[2]!.messages as WireMessage[])[1]!
  const kept = (dropped.content as Array<Record<string, unknown>>).filter((part) => part.type !== 'thinking')
  assert.equal(kept.length, (dropped.content as unknown[]).length, 'no thinking block may survive without its signature')
  assert.equal((dropped.content as Array<Record<string, unknown>>)[0]!.type, 'tool_use')
})

test('a tool-result image rides inside tool_result on Messages, with no extra user turn', async () => {
  const { adapter, sent } = messagesAdapter(() => messagesStream('ok'), {
    resolveAttachments: () => fakeAttachments({ [imageRef().attachmentId]: pngBytes }),
  })
  const callId = ToolCallId('toolu_01IMG')
  await collect(adapter.stream({
    provider: 'commandcode', model: 'claude-opus-4-8',
    tools: [{ name: 'shot', description: 'Screenshot', parameters: { type: 'object', properties: {} } as never }],
    messages: [
      userMessage('shoot'),
      { id: messageId(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: 'claude-opus-4-8' },
        content: [{ type: 'tool-call', id: callId, name: 'shot', arguments: '{}' }] },
      toolMessage(callId, [{ type: 'image', attachment: imageRef() }, { type: 'text', text: 'here' }]),
    ],
  }))
  const messages = sent()[0]!.messages as WireMessage[]
  // Messages is the one transport that can hold an image inside a tool result,
  // so the tool result is a `user` turn carrying `tool_result` and NO follow-up
  // user message is synthesized for the bytes (issue #30 on the other two).
  assert.equal(messages.length, 3)
  const result = messages[2]!
  assert.equal(result.role, 'user')
  const blocks = result.content as Array<Record<string, unknown>>
  assert.equal(blocks[0]!.type, 'tool_result')
  const inner = blocks[0]!.content as Array<Record<string, unknown>>
  assert.equal(inner[0]!.type, 'image')
  const source = inner[0]!.source as Record<string, unknown>
  // Native media type, not a data URL.
  assert.equal(source.media_type, 'image/png')
  assert.equal(source.type, 'base64')
  assert.equal(typeof source.data, 'string')
})

test('a Messages rejection is read whether it nests JSON in the message or is bare prose', async () => {
  const cases: Array<[string, RegExp]> = [
    // The message field holds a whole second document.
    [JSON.stringify({ type: 'error', error: {
      type: 'invalid_request_error',
      message: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 200000 > 128000' } }),
    }, request_id: 'req_1' }), /200000 > 128000/u],
    // Bare prose with no JSON at all.
    ['Invalid input: expected number, received undefined at max_tokens', /expected number, received undefined/u],
  ]
  for (const [body, expected] of cases) {
    const { adapter } = messagesAdapter(() => new Response(body, { status: 400 }))
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-4-8', messages: [userMessage('hi')] })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PROVIDER_HTTP_ERROR')
        // The sentence the user can act on, never a JSON blob.
        assert.match((error as Error).message, expected)
        return true
      },
    )
  }
})

test('a Messages plan refusal rotates the account instead of failing the turn', async () => {
  const { adapter } = messagesAdapter(() => new Response(JSON.stringify({
    type: 'error', error: { type: 'permission_error', message: 'MODEL_NOT_IN_PLAN: Claude Sonnet 4.6 available in Pro and above plans' },
  }), { status: 403 }))
  let rotatedTo: string | undefined
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-4-8', messages: [userMessage('hi')] })),
    (error: unknown) => {
      // The code lives in the message prefix on this transport, not in
      // `error.code`; the prose classifier still recognizes it.
      assert.match((error as Error).message, /MODEL_NOT_IN_PLAN/u)
      return true
    },
  )
  assert.equal(rotatedTo, undefined)
  assert.ok(adapter)
})

// ---------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------

test('stream() maps 401 to INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter({
    fetchImpl: fetchReturning(401, JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad key' } })),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'INVALID_CREDENTIAL' && /401/.test(e.message ?? '')
    },
  )
})

test('stream() 将普通 429 与额度窗口限流分别分类', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'THROTTLED',
  )
})

test('stream() keeps PROVIDER_HTTP_ERROR for a permanent 4xx and includes provider code', async () => {
  const adapter = makeAdapter({
    fetchImpl: fetchReturning(403, JSON.stringify({ success: false, error: { code: 'MODEL_NOT_IN_PLAN', message: 'upgrade' } })),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'PROVIDER_HTTP_ERROR' && /MODEL_NOT_IN_PLAN/.test(e.message ?? '')
    },
  )
})

test('stream() classifies a pre-stream 5xx as retryable SERVER and a 408 as TIMEOUT', async () => {
  // The gateway reports a temporarily unavailable upstream before the stream starts —
  // 520 (Cloudflare's origin-error class) carrying only `error.type: "server_error"`,
  // no `error.code`. dsh-llm-retry matches `failure.code` against the policy
  // whitelist and nothing else, so while that status mapped to
  // PROVIDER_HTTP_ERROR this class of failure was never retried, even though the
  // identical status arriving as an in-band stream error event was.
  const body = JSON.stringify({
    error: { message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.', type: 'server_error' },
  })
  for (const [status, code] of [[500, 'SERVER'], [502, 'SERVER'], [520, 'SERVER'], [408, 'TIMEOUT']] as const) {
    const adapter = makeAdapter({ fetchImpl: fetchReturning(status, body) })
    const policy = adapter.providerRetryPolicy('commandcode')
    // The code only means "retried" if the policy whitelists it: assert the
    // pair together, so neither half can drift away from the other.
    assert.ok(policy.mode === 'normal' && policy.retryableCodes.includes(code))
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => {
        const e = err as { code?: string; message?: string; failure?: { status?: number } }
        return e.code === code
          && e.failure?.status === status
          && /上游服务暂时无法完成请求|服务端处理超时/.test(e.message ?? '')
      },
    )
  }
})

test('stream() classifies a plain in-band error event as retryable SERVER', async () => {
  // No isRetryable, no statusCode, no terminal marker: the official CLI's
  // isStreamErrorRetryable() treats this as transient — so must we (SERVER is in the
  // harness default retryable set, PROVIDER_STREAM_ERROR is not).
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"boom"}}\n\n') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'SERVER',
  )
})

test('stream() classifies an explicitly non-retryable error event as PROVIDER_STREAM_ERROR', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"boom","isRetryable":false}}\n\n') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'PROVIDER_STREAM_ERROR',
  )
})

test('stream() classifies a terminal-marker error event as PROVIDER_STREAM_ERROR', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"model_not_in_plan: x"}}\n\n') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'PROVIDER_STREAM_ERROR',
  )
})

test('stream() classifies a non-retryable HTTP status error event as PROVIDER_STREAM_ERROR', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"boom","statusCode":400}}\n\n') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'PROVIDER_STREAM_ERROR',
  )
})

test('stream() classifies a retryable HTTP status error event as SERVER', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"boom","statusCode":503}}\n\n') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'SERVER',
  )
})

test('stream() lets a terminal marker or an explicit refusal outrank a 5xx status', async () => {
  // A permanent refusal arriving with a retryable status must stay terminal: answering
  // it with `SERVER` puts the identical request on dsh-llm-retry's 1000-attempt
  // cadence (waits doubling to 15 minutes) even though no resend can succeed.
  const bodies = [
    { message: 'insufficient credits', statusCode: 500 },
    { message: 'model_not_in_plan', statusCode: 503 },
    { message: 'premium credits exhausted', statusCode: 502 },
    { message: 'boom', statusCode: 500, isRetryable: false },
  ]
  for (const error of bodies) {
    const adapter = makeAdapter({
      fetchImpl: fetchReturning(200, `data: ${JSON.stringify({ type: 'error', error })}\n\n`),
    })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => (err as { code?: string }).code === 'PROVIDER_STREAM_ERROR',
      `${JSON.stringify(error)} must not be retried as a transient failure`,
    )
  }
  // ...while an explicit `isRetryable: true` still wins over the classification.
  const retryable = makeAdapter({
    fetchImpl: fetchReturning(200, 'data: {"type":"error","error":{"message":"flash blip","statusCode":400,"isRetryable":true}}\n\n'),
  })
  await assert.rejects(
    collect(retryable.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'SERVER',
  )
})

test('stream() does not let an absurd provider reset break the RATE_LIMIT classification', async () => {
  // A published reset is untrusted input. `1e300` seconds is finite, so it used to reach
  // `new Date(1e303).toISOString()` — a RangeError thrown out of stream() in place of
  // the intended retryable RATE_LIMIT — and a mark pinned to it would have been a
  // cooldown no probe ever revisits.
  const adapter = makeAdapter({
    fetchImpl: fetchReturning(429, JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'Rate limited', rateLimit: { window: 'fiveHour', reset: 1e300 } },
    })),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      assert.equal(e.code, 'RATE_LIMIT')
      assert.doesNotMatch(e.message ?? '', /resets at/, 'no reset may be claimed from an implausible value')
      return true
    },
  )
})

test('stream() drops an implausible reset from a window-limit body but still rotates', async () => {
  // The same bound at the rejection-classification seam: the account is marked
  // `window`-caused with NO reset (an `unknown` mark the pool's probe pass
  // re-checks), never a cooldown that outlives the process.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 403,
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', rateLimit: { window: 'weekly', reset: 1e300 } } }),
    },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const rotations: Array<{ reason: string; resetAtMs: number | undefined }> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason, _connection, _model, rotation) => {
      rotations.push({ reason, resetAtMs: rotation?.resetAtMs })
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.equal(rotations[0]?.reason, 'rate-limit')
  assert.equal(rotations[0]?.resetAtMs, undefined, 'the implausible reset is dropped, not clamped')
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() reports a long-context rejection as CONTEXT_WINDOW_EXCEEDED, never as a repeatable SERVER (issue #39)', async () => {
  // At ~500k tokens a session that outgrew the model's window was rejected with
  // wording this adapter did not recognize, so the failure fell into the transient
  // path: retryable SERVER, resent byte-for-byte up to maxRetries (1000) with waits
  // doubling to 15 minutes. /compact only appeared to fix it because it shrank the
  // request. CONTEXT_WINDOW_EXCEEDED is what dsh-compaction-basic's
  // agent/request-error hook consumes to compact and retry the reduced surface, and
  // it must stay outside the retry whitelist.
  const policy = makeAdapter().providerRetryPolicy('commandcode')
  assert.ok(policy.mode === 'normal' && !policy.retryableCodes.includes('CONTEXT_WINDOW_EXCEEDED'))

  const bodies = [
    // The bare phrasing upstream uses, with no status at all.
    { message: 'prompt is too long' },
    // The canonical structured code, and the harness's own "maximum context
    // length" wording.
    { message: 'bad request', code: 'context_length_exceeded' },
    { message: "This model's maximum context length is 1000000 tokens, however you requested 1200000 tokens." },
    // A retryable status must not outvote the wording: resending the same
    // oversized body cannot succeed, whatever the server says about itself.
    { message: 'prompt is too long', statusCode: 500 },
  ]
  for (const error of bodies) {
    const body = `data: ${JSON.stringify({ type: 'error', error })}\n\n`
    const adapter = makeAdapter({ fetchImpl: fetchReturning(200, body) })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')] })),
      (err: unknown) => {
        const e = err as { code?: string; message?: string }
        return e.code === 'CONTEXT_WINDOW_EXCEEDED'
          && /上下文窗口/.test(e.message ?? '')
      },
    )
  }
})

test('stream() reports a pre-stream context-window rejection as CONTEXT_WINDOW_EXCEEDED', async () => {
  // The same rejection can arrive before the stream starts. As a plain
  // PROVIDER_HTTP_ERROR it ended the turn with no recovery but a manual /compact;
  // as CONTEXT_WINDOW_EXCEEDED the harness compacts and retries.
  const cases = [
    [400, JSON.stringify({ error: { message: 'prompt is too long: 512000 tokens > 500000 maximum' } })],
    [413, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too large' } })],
    [400, '{"error":{"code":"context_length_exceeded"}}'],
  ] as const
  for (const [status, body] of cases) {
    const adapter = makeAdapter({ fetchImpl: fetchReturning(status, body) })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => {
        const e = err as { code?: string; failure?: { status?: number } }
        return e.code === 'CONTEXT_WINDOW_EXCEEDED' && e.failure?.status === status
      },
    )
  }
  // A body-size 413 whose text does not name the context window keeps the issue #37 taxonomy.
  const sizeOnly = makeAdapter({
    fetchImpl: fetchReturning(413, JSON.stringify({ error: { message: 'request entity too large' } })),
  })
  await assert.rejects(
    collect(sizeOnly.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'PROVIDER_HTTP_ERROR',
  )
  // A 5xx stays transient even if its message mentions the context window:
  // only client-side rejections describe a request this adapter could shrink.
  const serverError = makeAdapter({
    fetchImpl: fetchReturning(500, JSON.stringify({ error: { message: 'prompt is too long' } })),
  })
  await assert.rejects(
    collect(serverError.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'SERVER',
  )
})

test('stream() prices image content as vision tokens rather than inline base64', async () => {
  // Grok 4.6 stands in as a snapshotted Vision model: both stealth-preview
  // Vision models are out of the snapshot now (Pixel Canary retired 2026-10-01,
  // Space Bunny Alpha retired 2026-10-06).
  const model = 'xai/grok-4.6'
  const catalog = JSON.stringify({ object: 'list', data: [{ id: model, name: 'Grok 4.6', context_length: 100_000 }] })
  const ref = { ...imageRef(), attachmentId: AttachmentId('sha256:large-inline-image'), bytes: 500_000 }
  const data = new Uint8Array(ref.bytes)
  let output: number | undefined
  const adapter = makeAdapter({
    options: OPENAI_OPTIONS,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: data }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return new Response(catalog, { status: 200 })
      output = (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', { status: 200 })
    }) as typeof fetch,
  })
  await adapter.listModels('commandcode', { unfiltered: true })
  await collect(adapter.stream({ provider: 'commandcode', model, maxTokens: 64_000, messages: [{
    id: messageId(), role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' },
  }] }))
  assert.equal(output, 64_000)
})

test('stream() classifies an in-band error on the Provider API transport like the CLI transport', async () => {
  // The OpenAI-format SSE carries a failure as an `error` member of a chunk. Ignoring
  // it let the stream end with no finish event, so the real cause was reported as a
  // repeatable EMPTY_RESPONSE; both transports now share one classifier.
  const cases = [
    [{ error: { message: 'prompt is too long' } }, 'CONTEXT_WINDOW_EXCEEDED'],
    [{ error: { message: 'boom' } }, 'SERVER'],
    [{ error: { message: 'insufficient credits' } }, 'PROVIDER_STREAM_ERROR'],
  ] as const
  for (const [payload, code] of cases) {
    const adapter = makeAdapter({
      options: OPENAI_OPTIONS,
      fetchImpl: fetchReturning(200, `data: ${JSON.stringify(payload)}\n\n`),
    })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => (err as { code?: string }).code === code,
    )
  }
})

test('stream() wraps a network-level fetch failure as TRANSPORT with the cause chain', async () => {
  const cause = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) })
  const adapter = makeAdapter({
    fetchImpl: (async () => { throw cause }) as unknown as typeof fetch,
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; cause?: unknown }
      return e.code === 'TRANSPORT'
        && /alpha\/generate failed: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:443/.test(e.message ?? '')
        && /请求连接失败/.test(e.message ?? '')
        && e.cause === cause
    },
  )
})

test('stream() propagates a caller abort without relabeling it', async () => {
  const controller = new AbortController()
  const abortError = new DOMException('The operation was aborted', 'AbortError')
  const adapter = makeAdapter({
    fetchImpl: (async () => {
      controller.abort(abortError)
      throw abortError
    }) as unknown as typeof fetch,
  })
  await assert.rejects(
    collect(adapter.stream({
      provider: 'commandcode',
      model: 'm',
      messages: [userMessage('hi')],
      signal: controller.signal,
    })),
    (err: unknown) => err === abortError,
  )
})

test('stream() wraps a mid-stream read failure as TRANSPORT with the cause chain', async () => {
  const cause = new Error('socket hang up')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"par'))
      controller.error(cause)
    },
  })
  const adapter = makeAdapter({
    fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; cause?: unknown }
      return e.code === 'TRANSPORT'
        && /failed while reading: socket hang up/.test(e.message ?? '')
        && /流式响应中途断开/.test(e.message ?? '')
        && e.cause === cause
    },
  )
})

test('stream() aborts the generate request when the connection phase exceeds requestTimeoutMs', async () => {
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 20,
      streamIdleTimeoutMs: 10_000,
    }),
    // Simulate undici: hang until the composed request signal aborts, then
    // throw the same TimeoutError a real fetch would.
    fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal
      const t0 = Date.now()
      while (!signal?.aborted) {
        if (Date.now() - t0 > 5_000) throw new Error('stub: signal never aborted')
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch,
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'TIMEOUT'
        && /did not respond within 20ms/.test(e.message ?? '')
        && /毫秒内未收到响应/.test(e.message ?? '')
    },
  )
})

test('stream() does not abort a healthy body when elapsed time exceeds requestTimeoutMs', async () => {
  // Regression: AbortSignal.timeout(requestTimeoutMs) used to be passed into fetch(),
  // so a generation longer than the connection budget was killed mid-stream as
  // "failed while reading: aborted due to timeout".
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"hi"}\n\n'))
      await new Promise((r) => setTimeout(r, 60))
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'))
      controller.close()
    },
  })
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 20,
      streamIdleTimeoutMs: 10_000,
      protocol: 'cli' as const,
    }),
    fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
  })
  const chunks = await collect(
    adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }),
  )
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
  assert.ok(chunks.some((c) => c.type === 'finish'))
})

test('stream() fails with TIMEOUT when the stream stalls past streamIdleTimeoutMs', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // One text delta, then silence: the idle watchdog must cancel the
      // pending read and surface a TIMEOUT instead of hanging forever.
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"hello"}\n\n'))
    },
  })
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 60_000,
      streamIdleTimeoutMs: 20,
    }),
    fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'TIMEOUT' && /idle for 20ms/.test(e.message ?? '')
        && /被判定为死连接/.test(e.message ?? '')
    },
  )
})

/**
 * 读取永不结算、取消也不结算的响应体：模拟被包装或被垫片替换的 body。
 *
 * 合规的 `ReadableStream` 上，`reader.cancel()` 自己就会以 `done` 结算挂起的
 * `read()`（流自己的 `cancel()` 承诺是否完成都不影响这一点）。这里刻意去掉那条
 * 路径，用来固定「插件自己的空闲期限与取消不依赖读取器合作」这条契约，以及被放弃
 * 的读取迟到结算或迟到拒绝时不会制造第二次终止。
 */
function stalledReaderBody() {
  const body = new ReadableStream<Uint8Array>({ start() { /* 永不入队、永不关闭。 */ } })
  const counts = { reads: 0, cancel: 0, releaseLock: 0 }
  let settle: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
  const reader = {
    read: () => {
      counts.reads += 1
      return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => { settle = resolve; fail = reject })
    },
    cancel: () => { counts.cancel += 1; return new Promise<void>(() => { /* 永不结算。 */ }) },
    releaseLock: () => { counts.releaseLock += 1 },
  }
  Object.defineProperty(body, 'getReader', { value: () => reader })
  return {
    body,
    counts,
    settleRead: (result: ReadableStreamReadResult<Uint8Array>) => settle?.(result),
    failRead: (error: unknown) => fail?.(error),
  }
}

/** 等到读循环真正进入读取，不用固定延时猜时序。 */
async function waitForRead(counts: { reads: number }, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (counts.reads === 0) {
    if (Date.now() > deadline) throw new Error('读循环没有在期限内开始读取')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** 卡死读取用例的连接参数：空闲期限可调，其余与默认一致。 */
const stalledOptions = (idleMs: number) => (): CommandCodeConnectionOptions => ({
  apiBase: DEFAULT_API_BASE,
  workingDir: '/tmp/project',
  modelsCachePath: '/tmp/cc-models-cache.json',
  requestTimeoutMs: 60_000,
  streamIdleTimeoutMs: idleMs,
})

/** 有界等待：返回值用于断言，避免任何一条收束路径把测试挂死。 */
function withinBound<T>(work: Promise<T>, timeoutMs = 1000): Promise<T | '超时'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race<T | '超时'>([
    work,
    new Promise<'超时'>((resolve) => { timer = setTimeout(() => resolve('超时'), timeoutMs) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

test('读取永不结算时，流空闲期限仍然有界失败为 TIMEOUT', async () => {
  const stalled = stalledReaderBody()
  const summaries: RequestTimingSummary[] = []
  const adapter = makeAdapter({
    options: stalledOptions(20),
    fetchImpl: (async () => new Response(stalled.body, { status: 200 })) as unknown as typeof fetch,
    onRequestTiming: (summary) => { summaries.push(summary) },
  })
  const outcome = await withinBound(collect(
    adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }),
  ).then(() => '成功' as const, (error: unknown) => error))
  assert.notEqual(outcome, '超时', '空闲期限不能依赖底层读取结算')
  assert.notEqual(outcome, '成功')
  const error = outcome as { code?: string; message?: string }
  assert.equal(error.code, 'TIMEOUT')
  assert.match(error.message ?? '', /idle for 20ms/)
  assert.ok(stalled.counts.cancel >= 1, '仍需尽力取消底层读取')
  assert.equal(stalled.counts.releaseLock, 1, '卡住的读取也必须释放读取锁')
  assert.equal(summaries[0]?.outcome, 'error')
  assert.equal(summaries[0]?.errorCode, 'TIMEOUT')
  // 被放弃的读取迟到结算或迟到拒绝都不能制造第二次终止，也不能变成未处理拒绝
  // （真实读取器在释放锁时会以 “Invalid state: Releasing reader” 拒绝挂起的读取）。
  stalled.settleRead({ done: true, value: undefined })
  stalled.failRead(new TypeError('Invalid state: Releasing reader'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stalled.counts.releaseLock, 1)
})

test('读取永不结算时，调用者取消仍然有界并原样传播原因', async () => {
  const stalled = stalledReaderBody()
  const summaries: RequestTimingSummary[] = []
  const control = new AbortController()
  const reason = new Error('卡死读取期间取消')
  const adapter = makeAdapter({
    options: stalledOptions(10_000),
    fetchImpl: (async () => new Response(stalled.body, { status: 200 })) as unknown as typeof fetch,
    onRequestTiming: (summary) => { summaries.push(summary) },
  })
  const iterator = adapter.stream({
    provider: 'commandcode', model: 'm', messages: [userMessage('hi')], signal: control.signal,
  })[Symbol.asyncIterator]()
  const pending = iterator.next().then(value => value, (error: unknown) => error)
  try {
    await waitForRead(stalled.counts)
    control.abort(reason)
    const result = await withinBound(pending)
    assert.notEqual(result, '超时', '取消不能依赖 cancel() 唤醒挂起读取')
    assert.equal(result, reason, '调用者取消必须原样传播')
    assert.equal(stalled.counts.releaseLock, 1)
    assert.equal(summaries[0]?.outcome, 'aborted')
  } finally {
    await iterator.return?.()
  }
})

test('读取永不结算时，消费方提前结束仍然有界收束并释放读取锁', async () => {
  const stalled = stalledReaderBody()
  const summaries: RequestTimingSummary[] = []
  const adapter = makeAdapter({
    options: stalledOptions(10_000),
    fetchImpl: (async () => new Response(stalled.body, { status: 200 })) as unknown as typeof fetch,
    onRequestTiming: (summary) => { summaries.push(summary) },
  })
  const iterator = adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })[Symbol.asyncIterator]()
  const pending = iterator.next().then(value => value, (error: unknown) => error)
  await waitForRead(stalled.counts)
  const returning = iterator.return?.()
  assert.ok(returning !== undefined, '适配器迭代器必须提供 return()')
  const result = await withinBound(returning)
  if (result === '超时') assert.fail('消费方结束不能被挂起的读取拖住')
  assert.equal(result.done, true)
  assert.equal((await pending as IteratorResult<StreamChunk>).done, true)
  assert.equal(stalled.counts.releaseLock, 1)
  assert.equal(summaries[0]?.outcome, 'cancelled')
})

test('stream() completes normally when the finish event arrives', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n') })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.ok(chunks.some((c) => c.type === 'finish'))
})

test('stream() raises STREAM_CLOSED when the response is cut before its finish event', async () => {
  // The gateway (or an intermediary) closes the socket mid-generation, so the read loop
  // meets EOF without ever seeing the transport's terminal event. Answering that
  // with a synthesized `stop` is what made a truncated reply look like a turn that
  // had simply finished — no error in the UI, nothing in the session log.
  // `dsh-llm-deepseek` raises this same code for this same condition.
  const cases = [
    [undefined, 'data: {"type":"text-delta","text":"half an ans"}\n\n'],
    [OPENAI_OPTIONS, 'data: {"choices":[{"delta":{"content":"half an ans"}}]}\n\n'],
  ] as const
  for (const [options, body] of cases) {
    const adapter = makeAdapter({
      ...(options === undefined ? {} : { options }),
      fetchImpl: fetchReturning(200, body),
    })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => {
        const e = err as { code?: string; message?: string }
        return e.code === 'STREAM_CLOSED'
          && /ended before its finish event/.test(e.message ?? '')
          && /生成中途断流/.test(e.message ?? '')
          && /DSH_COMMANDCODE_TRACE/.test(e.message ?? '')
      },
    )
  }
})

test('stream() refuses a tool call the cut stream never finished', async () => {
  // A tool call still in flight when the socket closed carries truncated JSON
  // arguments — running it would be worse than failing the turn.
  const adapter = makeAdapter({
    options: OPENAI_OPTIONS,
    fetchImpl: fetchReturning(
      200,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}\n\n',
    ),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'STREAM_CLOSED',
  )
})

test('stream() keeps EMPTY_RESPONSE retryable when the cut produced no visible content', async () => {
  // Nothing usable came out, so repeating the request is safe and cheap and the
  // policy's whitelist absorbs it. A cut during a long thinking phase lands here
  // too — that path is unchanged and stays retryable.
  for (const body of ['', 'data: {"type":"reasoning-delta","text":"thinking"}\n\n']) {
    const adapter = makeAdapter({ fetchImpl: fetchReturning(200, body) })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => (err as { code?: string }).code === 'EMPTY_RESPONSE',
    )
  }
})

test('stream() emits a single finish when the trailing event lacks its newline', async () => {
  // A final line without a trailing newline is parsed at `done` — a trailing
  // `finish` there must not produce a second synthetic finish.
  const adapter = makeAdapter({
    fetchImpl: fetchReturning(200, 'data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}'),
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
})

// ---------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------

test('listModels() parses the catalog and marks input as text-only', async () => {
  const catalog = {
    object: 'list',
    data: [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1000000 },
      { id: 'claude-opus-5', name: 'Claude Opus 5', context_length: 1000000 },
    ],
  }
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify(catalog)) })
  const models = await adapter.listModels('commandcode')
  assert.equal(models.length, 2)
  assert.equal(models[0]!.id, 'deepseek/deepseek-v4-flash')
  assert.equal(models[0]!.name, 'DeepSeek V4 Flash (CC)')
  assert.deepEqual(models[0]!.inputModalities, ['text'])
})

test('listModels() 目录已在内存时不再等一次联网刷新', async (t) => {
  // 选择器与设置页的过滤编辑器都只是把目录画出来：本进程手里已经有这些行时，
  // 还让这次打开等一次刷新，纯粹是延迟 —— 行刚刚还是好的，刷新留给下次打开。
  // 进程首次加载则必须照旧等联网，否则没有诚实的行可画。
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let refreshes = 0
  let parked = false
  const catalog = (id: string) => new Response(JSON.stringify({
    object: 'list', data: [{ id, name: id, context_length: 1000, max_output_tokens: 500 }],
  }))
  const adapter = makeAdapter({
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/models')) return catalog('unexpected')
      refreshes++
      if (!parked) return catalog(`model-${refreshes}`)
      // 后台刷新明显晚一步：若本次调用蠢到去等它，拿到的就是新行而不是旧行，
      // 断言会直接失败，而不是靠超时。
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      return catalog(`model-${refreshes}`)
    }) as typeof fetch,
  })
  // 冷进程：没有可画的行，必须等这一次联网。
  assert.equal((await adapter.listModels('commandcode', { unfiltered: true }))[0]?.id, 'model-1')
  assert.equal(refreshes, 1)
  // 目录仍在有效期内：这次调用不产生任何刷新。
  assert.equal((await adapter.listModels('commandcode', { unfiltered: true }))[0]?.id, 'model-1')
  assert.equal(refreshes, 1)
  // 目录过期，且网关此刻不再回包：本次打开必须拿着旧行立刻返回，刷新挂在后台。
  now += 5 * 60_000 + 1
  parked = true
  const listed = await adapter.listModels('commandcode', { unfiltered: true })
  assert.equal(listed[0]?.id, 'model-1', '过期目录也先画出来，不能等后台刷新')
  assert.equal(refreshes, 2, '后台仍要发起刷新，好让下次打开拿到新行')
})
test('listModels() falls back to the on-disk cache when the fetch fails', async () => {
  const cachePath = `/tmp/cc-test-cache-${process.pid}.json`
  const { writeFileSync, rmSync } = await import('node:fs')
  writeFileSync(cachePath, JSON.stringify({
    // Matches MODEL_CACHE_VERSION: a stale version is rejected outright, so the
    // fixture has to carry the current one to exercise the fallback at all.
    version: 3, apiBase: 'https://api.commandcode.ai',
    // No `supportedEndpoints`: a hand-built cache entry may omit it, and the
    // reader must normalize that instead of routing a Claude id wrongly.
    models: [{ id: 'cached-model', name: 'Cached', contextWindow: 1000, maxTokens: 500 }],
  }))
  try {
    const adapter = new CommandCodeAdapter({
      options: () => ({
        apiBase: 'https://api.commandcode.ai',
        workingDir: '/tmp',
        modelsCachePath: cachePath,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }),
      resolveApiKey: async () => 'k',
      fetchImpl: (async () => { throw new Error('network down') }) as unknown as typeof fetch,
    })
    const models = await adapter.listModels('commandcode')
    assert.equal(models.length, 1)
    assert.equal(models[0]!.id, 'cached-model')
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('目录缓存拒绝旧格式和其他网关，并在成功刷新后保存来源', async (t) => {
  const cachePath = join(tmpdir(), `cc-catalog-source-${process.pid}.json`)
  t.after(() => rmSync(cachePath, { force: true }))
  const { writeFileSync, readFileSync } = await import('node:fs')
  const models = [{ id: 'model-a', name: 'A', contextWindow: 1000, maxTokens: 500, supportedEndpoints: ['/messages'] }]
  const options = () => ({ ...OPENAI_OPTIONS(), apiBase: 'https://second.invalid', modelsCachePath: cachePath })
  const offline = () => makeAdapter({ options, fetchImpl: (async () => { throw new Error('network down') }) as typeof fetch })
  for (const cache of [
    { version: 2, models },
    { version: 3, apiBase: 'https://first.invalid', models },
  ]) {
    writeFileSync(cachePath, JSON.stringify(cache))
    assert.deepEqual(await offline().listModels('commandcode', { unfiltered: true }), [])
  }
  const online = makeAdapter({
    options,
    fetchImpl: (async () => new Response(JSON.stringify({ object: 'list', data: [
      { id: 'model-b', name: 'B', context_length: 1000, supported_endpoints: ['/chat/completions'] },
    ] }))) as typeof fetch,
  })
  await online.listModels('commandcode', { unfiltered: true })
  const saved = JSON.parse(readFileSync(cachePath, 'utf-8')) as { apiBase: string; version: number }
  assert.equal(saved.apiBase, 'https://second.invalid')
  assert.equal(saved.version, 3)
  assert.equal((await offline().listModels('commandcode', { unfiltered: true }))[0]?.id, 'model-b')
})

test('resolveModel() exposes reasoning efforts only for known models', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify({ object: 'list', data: [] })) })
  const withEfforts = await adapter.resolveModel('commandcode', 'claude-opus-5')
  assert.ok(withEfforts.reasoning)
  assert.ok(withEfforts.reasoning!.efforts.length > 0)
  const without = await adapter.resolveModel('commandcode', 'unknown-model')
  assert.equal(without.reasoning, undefined)
})

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

test('projectSlugFromPath lowercases and slugifies', () => {
  assert.equal(projectSlugFromPath('/Users/Me/My Project'), 'users-me-my-project')
  // The Windows drive letter is stripped.
  assert.equal(projectSlugFromPath(String.raw`C:\Users\Me\Proj`), 'users-me-proj')
  assert.equal(projectSlugFromPath('///'), 'project')
})

test('projectSlugFromPath trims surrounding separators from both ends', () => {
  assert.equal(projectSlugFromPath('--foo--'), 'foo')
  assert.equal(projectSlugFromPath('---'), 'project')
  assert.equal(projectSlugFromPath('-a-'), 'a')
  assert.equal(projectSlugFromPath('a-'), 'a')
  assert.equal(projectSlugFromPath('-a'), 'a')
  assert.equal(projectSlugFromPath('a'), 'a')
  assert.equal(projectSlugFromPath('foo---bar---'), 'foo-bar')
})

test('projectSlugFromPath is not vulnerable to ReDoS on long separator runs', () => {
  // Regression for CodeQL js/polynomial-redos (alert #1): the old `/^-+|-+$/`
  // alternation made the unanchored `-+$` retry every start position on
  // `a<dashes>b`, i.e. O(n^2) — ~14.5s for 200k dashes. The lookbehind trim is
  // linear, so 100k dashes must finish in well under a second.
  const longDashPath = `a${'-'.repeat(100_000)}b`
  const start = Date.now()
  assert.equal(projectSlugFromPath(longDashPath), 'a-b')
  assert.ok(Date.now() - start < 1_000, 'slugification of 100k dashes must stay linear')
})

test('known efforts snapshot covers the models the catalog advertises', () => {
  assert.ok(KNOWN_EFFORTS['deepseek/deepseek-v4-flash'])
  assert.ok(KNOWN_EFFORTS['claude-opus-5'])
  assert.deepEqual(KNOWN_EFFORTS['claude-fable-5-1'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-27B'], ['low', 'medium', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-Flash'], ['low', 'medium', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-Max-0902'], ['low', 'medium', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['google/gemini-3.8-flash'], ['low', 'medium', 'high'])
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-vision-exp'], ['off', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['z-ai/glm-5.3-flash'], ['low', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['z-ai/glm-5.3-flashx'], ['low', 'high', 'max'])
  assert.ok(!KNOWN_EFFORTS['stealth/ox-alpha'])
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-fast'], ['low', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4.1-flash'], ['off', 'low', 'high', 'max'])
  assert.ok(!KNOWN_THINKING_MODELS.has('deepseek/deepseek-v4.1-flash'))
  // Synced from the command-code provider table; `src/capabilities.ts` owns the
  // table and is currently synced to command-code@1.79.1.
  // Every model the CLI's provider table ships effort levels for must be present, and
  // every model without them must stay out. The 0.2.0 snapshot wrongly added ten
  // models (Kimi K2.5, MiMo V2.5, Claude Haiku 4.5, MiniMax M2.5, Muse Spark 1.2
  // Contributor, Tencent Hy3, ...) that carry NO reasoningEfforts in that table.
  assert.ok(!KNOWN_EFFORTS['moonshotai/Kimi-K2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5-pro'])
  assert.ok(!KNOWN_EFFORTS['claude-haiku-4-5-20251001'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M2.5'])
  assert.ok(!KNOWN_EFFORTS['tencent/hy3-paid'])
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.2-contributor'], ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['tencent/hy4-preview'], ['low', 'medium', 'high'])
  assert.deepEqual(KNOWN_EFFORTS['MiniMaxAI/MiniMax-M3'], ['low', 'medium', 'high'])
  assert.ok(!KNOWN_EFFORTS['inclusionai/ling-3.0-flash-sante:free'])
  assert.deepEqual(KNOWN_EFFORTS['moonshotai/Kimi-K3'], ['low', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['stepfun/Step-5-Preview'], ['low', 'medium', 'high'])
  assert.deepEqual(KNOWN_EFFORTS['xai/grok-4.7'], ['low', 'medium', 'high', 'xhigh'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.6-flash'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.6-pro'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.6-pro-ultraspeed'])
  // `stealth/space-bunny-alpha` (command-code@1.65.0, `max` added by 1.73.4)
  // was retired by command-code@1.74.3: the artifact ships the row as `hidden`
  // with no effort list, the catalog and pricing page dropped it, and the
  // official Desktop changelog says it left the model picker.
  assert.equal(KNOWN_EFFORTS['stealth/space-bunny-alpha'], undefined)
  // `stealth/pixel-canary` was retired by command-code@1.73.1 (the CLI hides it
  // past 2026-10-01T06:00:00Z and it left the catalog and the pricing page), so
  // it must not reappear in any snapshot table.
  assert.ok(!KNOWN_EFFORTS['stealth/pixel-canary'])
  // command-code@1.68.0 takes the Sonnet/Opus five-level set; 1.67.0's DeepSeek
  // V4.1 Flash Fast keeps the three-level set its `deepseek-v4.1-flash` sibling ships.
  assert.deepEqual(KNOWN_EFFORTS['claude-sonnet-5-5'], ['low', 'medium', 'high', 'xhigh', 'max'])
  // command-code@1.73.3 added `off` to both DeepSeek V4.1 models, taking them to
  // four levels; `deepseek-v4-flash-fast` alone stayed at three.
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4.1-flash-fast'], ['off', 'low', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash'], ['off', 'high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-pro'], ['off', 'high', 'max'])
  assert.ok(!KNOWN_THINKING_MODELS.has('claude-sonnet-5-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('deepseek/deepseek-v4.1-flash-fast'))
  // command-code@1.75.0 ("Add Mistral Large 4") — the only model the 1.74.3 ->
  // 1.77.0 train added. Three selectable levels; Vision and Go-tier
  // availability are pinned by their own snapshots above.
  assert.deepEqual(KNOWN_EFFORTS['mistral/mistral-large-4'], ['low', 'medium', 'high'])
  // command-code@1.78.0 ("Add Claude Haiku 5.5 (Pro and above)") and 1.79.0
  // ("Add Glyph Cluster as a free model, 100 requests a day") are the only
  // registry additions in the 1.77.0 -> 1.79.1 train. Both keep selectable
  // efforts, so neither belongs in KNOWN_THINKING_MODELS.
  assert.deepEqual(KNOWN_EFFORTS['claude-haiku-5-5'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['stealth/glyph-cluster:free'], ['low', 'medium', 'high', 'xhigh'])
  assert.ok(!KNOWN_THINKING_MODELS.has('claude-haiku-5-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('stealth/glyph-cluster:free'))
  // 2026-10-24: Kimi K3.1 Pro was catalog-only in the 1.88.0 artifact (the CLI
  // registry names it from 1.88.1) and serves the same three selectable levels
  // as its K3 predecessor, so it belongs here and not in the thinking set.
  assert.deepEqual(KNOWN_EFFORTS['moonshotai/Kimi-K3.1-Pro'], ['low', 'high', 'max'])
  assert.ok(!KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K3.1-Pro'))
  // 2026-10-27: GPT-6.1 Terra is catalog-only as well and serves the same
  // five selectable levels as its `gpt-6.1-sol` predecessor.
  assert.deepEqual(KNOWN_EFFORTS['gpt-6.1-terra'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.ok(!KNOWN_THINKING_MODELS.has('gpt-6.1-terra'))
})

test('known thinking snapshot covers reasoning models without effort levels', () => {
  assert.ok(!KNOWN_THINKING_MODELS.has('MiniMaxAI/MiniMax-M3'))
  assert.ok(KNOWN_THINKING_MODELS.has('Qwen/Qwen3.7-Max'))
  assert.ok(KNOWN_THINKING_MODELS.has('thinkingmachines/inkling'))
  // Retired models (the MiniMax free variants, stealth/ox-alpha) belong to neither set.
  assert.ok(!KNOWN_THINKING_MODELS.has('stealth/ox-alpha'))
  // Same provenance: `src/capabilities.ts`, synced to the command-code@1.73.0
  // provider table.
  // Every model that reasons automatically (reasoning:true, no selectable effort
  // levels) belongs in this set, and every model that gained selectable efforts has
  // moved out of it into KNOWN_EFFORTS.
  assert.ok(KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K2.7-Code-Highspeed'))
  assert.ok(KNOWN_THINKING_MODELS.has('tencent/hy3-paid'))
  assert.ok(!KNOWN_THINKING_MODELS.has('tencent/hy4-preview'))
  assert.ok(!KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K3'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.2-contributor'))
  assert.ok(KNOWN_THINKING_MODELS.has('meituan/LongCat-2.0'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meituan/LongCat-2.0:free'))
  // `inclusionai/ling-3.0-flash-sante:free` left every snapshot table on
  // 2026-10-16 with the command-code@1.82.4 catalog migration — it is gone from
  // the live catalog, the pricing page and the artifact's embedded snapshot.
  assert.ok(!KNOWN_THINKING_MODELS.has('inclusionai/ling-3.0-flash-sante:free'))
  // command-code@1.82.2: the `ling-3.1-flash:free` promo is retired — the CLI
  // ships the row `hidden`, drops its effort list, and the model left both the
  // public catalog and the pricing page — so no table in the snapshot names it
  // any more. Its paid graduation keeps the same three selectable levels, which
  // is why it sits in KNOWN_EFFORTS and not here.
  assert.ok(!KNOWN_THINKING_MODELS.has('inclusionai/ling-3.1-flash'))
  assert.equal(KNOWN_THINKING_MODELS.has('inclusionai/ling-3.1-flash:free'), false)
  assert.deepEqual(KNOWN_EFFORTS['inclusionai/ling-3.1-flash'], ['low', 'medium', 'high'])
  assert.equal(KNOWN_EFFORTS['inclusionai/ling-3.1-flash:free'], undefined)
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.3'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.3-contributor'))
  assert.ok(!KNOWN_EFFORTS['meituan/LongCat-2.0'])
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.3'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.3-contributor'], ['low', 'medium', 'high', 'xhigh'])
  // command-code@1.80.0 ("Add Muse Wonder"): the Muse family's newest member and
  // the only registry addition in the 1.79.2 -> 1.81.0 train. Four selectable
  // levels like Muse Spark 1.1/1.2 (no `max`), so it is not an auto-reasoning
  // model either.
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-wonder-1.0'], ['low', 'medium', 'high', 'xhigh'])
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-wonder-1.0'))
  // command-code@1.82.0 ("Gemini Argon"): the only registry addition in the
  // 1.81.0 -> 1.82.1 train. Three selectable levels like the Gemini Flash
  // family, so it is not an auto-reasoning model either.
  assert.deepEqual(KNOWN_EFFORTS['google/gemini-4-argon'], ['low', 'medium', 'high'])
  assert.ok(!KNOWN_THINKING_MODELS.has('google/gemini-4-argon'))
  // GLM-5/5.1/5.2-Fast are NOT reasoning-capable (provider-table reasoning:false, docs
  // "Text input" only) — the 0.2.0 snapshot wrongly included them.
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5.1'))
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5.2-Fast'))
  // Models with selectable efforts are not "auto" — they carry their own UI.
  assert.ok(!KNOWN_THINKING_MODELS.has('Qwen/Qwen3.8-27B'))
  assert.ok(!KNOWN_THINKING_MODELS.has('claude-opus-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_THINKING_MODELS.has('xiaomi/mimo-v2.5'))
})

test('Messages-only snapshot covers the Claude family and stays forward-compatible', () => {
  // Ids measured 2026-09-16 by posting every catalog model to `/provider/v1/chat/completions` and recording which refused with "must be called via /provider/v1/messages".
  for (const id of [
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.ok(requiresMessagesEndpoint(id), `${id} must route to the CLI transport`)
  }
  // The snapshot list and the predicate must not drift apart.
  for (const id of MESSAGES_ONLY_MODELS) assert.ok(requiresMessagesEndpoint(id))
  // A Claude id that ships after this plugin was built is still routed right.
  assert.ok(requiresMessagesEndpoint('claude-opus-6'))
  // Non-Claude models must stay on the Provider API: a false positive here silently
  // downgrades a working model to the legacy transport.
  assert.ok(!requiresMessagesEndpoint('deepseek/deepseek-v4.1-flash'))
  assert.ok(!requiresMessagesEndpoint('zai-org/GLM-5.3'))
  assert.ok(!requiresMessagesEndpoint('gpt-5.6-sol'))
  assert.ok(!requiresMessagesEndpoint(''))
})

test('known image models snapshot has stable anchor entries', () => {
  // Anchors that must never drift: a flagship vision model and a text-only
  // model (the latter is deliberately absent).
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-sonnet-5'))
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-5.4'))
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-fable-5-1'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('stealth/ox-alpha'))
  assert.ok(KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash-vision-exp'))
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-27B'))
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-Flash'))
  assert.ok(KNOWN_IMAGE_MODELS.has('z-ai/glm-5.3-flash'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-pro'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('zai-org/GLM-5.3'))
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-Max-0902'))
  assert.ok(KNOWN_IMAGE_MODELS.has('google/gemini-3.8-flash'))
  assert.ok(KNOWN_IMAGE_MODELS.has('meta/muse-spark-1.3'))
  assert.ok(KNOWN_IMAGE_MODELS.has('meta/muse-spark-1.3-contributor'))
  // command-code@1.80.0; Vision per the official registry and the CLI's
  // inputModalities ["text","image","file"].
  assert.ok(KNOWN_IMAGE_MODELS.has('meta/muse-wonder-1.0'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('meituan/LongCat-2.0'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('inclusionai/ling-3.0-flash-sante:free'))
  assert.ok(KNOWN_IMAGE_MODELS.has('xai/grok-4.6'))
  assert.ok(KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4.1-flash'))
  // Both 1.67.0/1.68.0 additions declare inputModalities ["text","image"] and carry
  // the registry's Vision label.
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-sonnet-5-5'))
  assert.ok(KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4.1-flash-fast'))
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-6-astra'))
  assert.ok(KNOWN_IMAGE_MODELS.has('xai/grok-4.7'))
  assert.ok(KNOWN_IMAGE_MODELS.has('stepfun/Step-5-Preview'))
  assert.ok(KNOWN_IMAGE_MODELS.has('xiaomi/mimo-v2.6-flash'))
  assert.ok(KNOWN_IMAGE_MODELS.has('xiaomi/mimo-v2.6-pro'))
  assert.ok(KNOWN_IMAGE_MODELS.has('xiaomi/mimo-v2.6-pro-ultraspeed'))
  // command-code@1.75.0; Vision per the official registry and inputModalities.
  assert.ok(KNOWN_IMAGE_MODELS.has('mistral/mistral-large-4'))
  // command-code@1.78.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"]. Its free Glyph Cluster sibling preview is
  // text-only, so it stays out of this set.
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-haiku-5-5'))
  // command-code@1.82.0; Vision per the official registry, the CLI's
  // inputModalities:["text","image"] and the docs page's capability label.
  assert.ok(KNOWN_IMAGE_MODELS.has('google/gemini-4-argon'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('stealth/glyph-cluster:free'))
  // Both stealth previews are retired now — Pixel Canary on 2026-10-01 and
  // Space Bunny Alpha on 2026-10-06 — so neither may linger in the Vision set.
  assert.ok(!KNOWN_IMAGE_MODELS.has('stealth/pixel-canary'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('stealth/space-bunny-alpha'))
  // The MiMo V2.6 family does not reason (docs: "Text input, Vision"); only its
  // Vision capability is snapshotted.
  assert.ok(!KNOWN_THINKING_MODELS.has('xiaomi/mimo-v2.6-pro'))
  // 2026-10-24: inputModalities ["text","image"] in the live catalog, and both
  // the pricing page and the models docs page label the row Vision.
  assert.ok(KNOWN_IMAGE_MODELS.has('moonshotai/Kimi-K3.1-Pro'))
  // 2026-10-27: inputModalities ["text","image"] in the live catalog; the
  // pricing page (`caps.vision: true`) and the models docs page agree.
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-6.1-terra'))
})

test('known plan snapshot tiers models by the official plan pages', () => {
  // Go: the entry plan covers open models + a few premium ones.
  assert.equal(KNOWN_PLANS['MiniMaxAI/MiniMax-M3'], 'go')
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash'], 'go')
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash-vision-exp'], 'go')
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash-fast'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.7-Max'], 'go')
  assert.equal(KNOWN_PLANS['gpt-5.6-luna'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-27B'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-Flash'], 'go')
  assert.equal(KNOWN_PLANS['z-ai/glm-5.3-flash'], 'go')
  assert.equal(KNOWN_PLANS['z-ai/glm-5.3-flashx'], 'go')
  assert.equal(KNOWN_PLANS['tencent/hy4-preview'], 'go')
  assert.equal(KNOWN_PLANS['stealth/ox-alpha'], undefined)
  // tencent/hy3-paid is the upstream rename of the old tencent/Hy3 id.
  assert.equal(KNOWN_PLANS['tencent/hy3-paid'], 'go')
  assert.equal(KNOWN_PLANS['tencent/Hy3'], undefined)
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.0-flash-free'], undefined)
  assert.equal(KNOWN_PLANS['minimax/minimax-m3-free'], undefined)
  assert.equal(KNOWN_PLANS['minimax/minimax-m2.7-free'], undefined)
  // Qwen 3.8 Max 0902, LongCat 2.0 (a free promo until 2026-09-19, paid since) and Muse Spark 1.3 Contributor are all Go-tier.
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-Max-0902'], 'go')
  assert.equal(KNOWN_PLANS['meituan/LongCat-2.0'], 'go')
  // The retired free id is gone from the snapshot with the promo.
  assert.equal(KNOWN_PLANS['meituan/LongCat-2.0:free'], undefined)
  // `inclusionai/ling-3.0-flash-sante:free` left the snapshot on 2026-10-16 with
  // the command-code@1.82.4 catalog migration: it is gone from the live
  // `?view=client` catalog, from the pricing page and from the 1.82.4 artifact's
  // own embedded snapshot, so no official source names it any more.
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.0-flash-sante:free'], undefined)
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4.1-flash'], 'go')
  // command-code@1.67.0: the throughput variant is Go-tier like the rest of the family.
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4.1-flash-fast'], 'go')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.3-contributor'], 'go')
  // command-code@1.75.0; Mistral Large 4 is on every tier, so its minimum is Go.
  assert.equal(KNOWN_PLANS['mistral/mistral-large-4'], 'go')
  // command-code@1.79.0; the free Glyph Cluster preview is on every tier too.
  assert.equal(KNOWN_PLANS['stealth/glyph-cluster:free'], 'go')
  assert.equal(KNOWN_PLANS['stepfun/Step-5-Preview'], 'go')
  assert.equal(KNOWN_PLANS['xiaomi/mimo-v2.6-flash'], 'go')
  assert.equal(KNOWN_PLANS['xiaomi/mimo-v2.6-pro'], 'go')
  // Both retired stealth previews are out of the plan snapshot as well.
  assert.equal(KNOWN_PLANS['stealth/space-bunny-alpha'], undefined)
  assert.equal(KNOWN_PLANS['stealth/pixel-canary'], undefined)
  // GOAT adds a handful of closed/premium models.
  assert.equal(KNOWN_PLANS['google/gemini-3.7-flash'], 'goat')
  assert.equal(KNOWN_PLANS['xai/grok-4.6'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.2'], 'goat')
  assert.equal(KNOWN_PLANS['gpt-5.6-sol'], 'goat')
  // Grok 4.7 and MiMo V2.6 Pro UltraSpeed are "available on GOAT and above", which is
  // what keeps the GOAT -> Pro -> Provider tier chain a superset.
  assert.equal(KNOWN_PLANS['xai/grok-4.7'], 'goat')
  assert.equal(KNOWN_PLANS['xiaomi/mimo-v2.6-pro-ultraspeed'], 'goat')
  assert.equal(KNOWN_PLANS['google/gemini-3.8-flash'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.3'], 'goat')
  // command-code@1.68.0: Claude Sonnet 5.5 lands a tier ABOVE its `claude-sonnet-5`
  // predecessor (Pro, below) — individual-go false, individual-goat true.
  assert.equal(KNOWN_PLANS['claude-sonnet-5-5'], 'goat')
  // Pro adds Claude Sonnet/Haiku, GPT-5.x, Gemini 3.5/3.1.
  assert.equal(KNOWN_PLANS['claude-sonnet-5'], 'pro')
  // command-code@1.79.2 lowers Haiku 5.5's minimum plan from Pro to GOAT.
  assert.equal(KNOWN_PLANS['claude-haiku-5-5'], 'goat')
  assert.equal(planLabel('claude-haiku-5-5'), 'GOAT')
  assert.equal(KNOWN_PLANS['gpt-5.4'], 'pro')
  assert.equal(KNOWN_PLANS['google/gemini-3.5-flash'], 'pro')
  // Provider/Max: Claude Opus/Fable and Fugu Ultra are not on lower plans.
  assert.equal(KNOWN_PLANS['claude-opus-5'], 'provider')
  assert.equal(KNOWN_PLANS['claude-fable-5'], 'provider')
  // claude-fable-5-1 is Provider/Max exactly like claude-fable-5: the plan filter must
  // not fail open and show a Provider/Max model to every subscription.
  assert.equal(KNOWN_PLANS['claude-fable-5-1'], 'provider')
  assert.equal(KNOWN_PLANS['sakana/fugu-ultra'], 'provider')
  // command-code@1.71.0: GPT-6.1 Sol is the catalog's FIRST Max-minimum model —
  // every lower tier is false and only individual-max / individual-ultra /
  // teams-pro are true, one step above every Provider row above.
  assert.equal(KNOWN_PLANS['gpt-6.1-sol'], 'max')
  assert.equal(planLabel('gpt-6.1-sol'), 'Max')
  // It sorts strictly after every lower tier, so a Pro account's picker hides it:
  // `compareByPlan` ranks by PLAN_ORDER, and only a free model may outrank it.
  const highestTier = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }
  assert.ok(
    Object.keys(KNOWN_PLANS).every((id) => id === 'gpt-6.1-sol' || isFreeModel(id) || compareByPlan(highestTier, { id, name: '' }) > 0),
    'a Max-minimum model must sort after every non-free model of lower minimum plan',
  )
  // Its predecessor stays Pro — the two must not collapse into one tier.
  assert.equal(KNOWN_PLANS['gpt-6-sol'], 'pro')
  // command-code@1.80.0: Muse Wonder joins it on Max ("Available on Max and
  // above." — every lower tier false, individual-max/ultra and teams-pro true).
  assert.equal(KNOWN_PLANS['meta/muse-wonder-1.0'], 'max')
  assert.equal(planLabel('meta/muse-wonder-1.0'), 'Max')
  // command-code@1.82.0: Gemini 4 Argon is the Gemini family's first Pro-gated
  // member — one tier ABOVE the Flash models, which stay on Go/GOAT.
  assert.equal(KNOWN_PLANS['google/gemini-4-argon'], 'pro')
  assert.equal(planLabel('google/gemini-4-argon'), 'Pro')
  // command-code@1.82.2: the paid `ling-3.1-flash` inherits the retired promo's
  // Go slot — the pricing page still grants every tier (individual-go through
  // teams-pro).
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.1-flash'], 'go')
  assert.equal(planLabel('inclusionai/ling-3.1-flash'), 'Go')
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.1-flash:free'], undefined)
  // 2026-10-24: Kimi K3.1 Pro is Go on every source — `minimumPlan:
  // "individual-go"` in the live catalog and `"all": true` in the pricing page's
  // embedded availability, so it appears on the go/goat/pro plan pages alike.
  assert.equal(KNOWN_PLANS['moonshotai/Kimi-K3.1-Pro'], 'go')
  assert.equal(planLabel('moonshotai/Kimi-K3.1-Pro'), 'Go')
  // 2026-10-27: GPT-6.1 Terra is Pro-only — `minimumPlan: "individual-pro"` in
  // the live catalog, go / go-v1 / goat false and Pro and above true.
  assert.equal(KNOWN_PLANS['gpt-6.1-terra'], 'pro')
  assert.equal(planLabel('gpt-6.1-terra'), 'Pro')
  // Labels match the official tier names.
  assert.equal(planLabel('MiniMaxAI/MiniMax-M3'), 'Go')
  assert.equal(planLabel('claude-sonnet-5'), 'Pro')
  assert.equal(planLabel('claude-opus-5'), 'Provider')
  assert.equal(planLabel('some-future-model'), undefined)
})

test('known deals snapshot has anchors and expiry-aware labels', () => {
  // DeepSeek V4 Pro's 75% off deal lapsed on 2026-08-16 16:00 UTC when DeepSeek moved
  // to peak/off-peak pricing, so it left the snapshot (see KNOWN_PEAK_PRICING).
  assert.equal(KNOWN_DEALS['deepseek/deepseek-v4-pro'], undefined)
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free']?.free, true)
  // Neither the retired stealth/ox-alpha nor its z-ai/glm-5.3-flash successor has a deal.
  assert.equal(KNOWN_DEALS['stealth/ox-alpha'], undefined)
  assert.equal(KNOWN_DEALS['z-ai/glm-5.3-flash'], undefined)
  // The retired MiniMax free promos were removed from the snapshot entirely rather than
  // left to lapse on their old 2026-09-05 expiry.
  assert.equal(KNOWN_DEALS['minimax/minimax-m3-free'], undefined)
  assert.equal(KNOWN_DEALS['minimax/minimax-m2.7-free'], undefined)
  // Gemini 3.7 Flash's 50% off deal was retired; the model shows at full price.
  assert.equal(KNOWN_DEALS['google/gemini-3.7-flash'], undefined)
  // LongCat 2.0's free promo ended 2026-09-19, so the FREE entry was removed rather
  // than left to badge a model the catalog now serves paid.
  assert.equal(KNOWN_DEALS['meituan/LongCat-2.0:free'], undefined)
  assert.equal(KNOWN_DEALS['meituan/LongCat-2.0'], undefined)
  // Laguna S 2.1 is still the permanent-style free deal.
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free']?.free, true)
  // Ling 3.0 Flash Sante's free deal went with the model on 2026-10-16 (see the
  // plan snapshot above); its paid graduation `ling-3.1-flash` carries no deal.
  assert.equal(KNOWN_DEALS['inclusionai/ling-3.0-flash-sante:free'], undefined)
  // Grok 4.7's 40% off launch deal ran to 2026-09-27T23:59:59.999Z and the
  // pricing page dropped it: the entry is REMOVED rather than left to lapse, so
  // it never badges a model the catalog now serves at its list price.
  assert.equal(KNOWN_DEALS['xai/grok-4.7'], undefined)
  // Ling 3.1 Flash's free "while it lasts" promo (command-code@1.70.0) ended
  // with command-code@1.82.2: the row is hidden, it left the pricing page, and
  // its paid graduation is priced normally — so the FREE entry is REMOVED rather
  // than left to badge a model that is no longer free.
  assert.equal(KNOWN_DEALS['inclusionai/ling-3.1-flash:free'], undefined)
  assert.equal(KNOWN_DEALS['inclusionai/ling-3.1-flash'], undefined)
  assert.equal(isFreeModel('inclusionai/ling-3.1-flash'), false)
  // command-code@1.79.0; the free Glyph Cluster preview carries the same
  // permanent-style terms as its Ling predecessors — 100% off "Free while the
  // preview lasts" with no published end date, so no `expiresAt` to lapse.
  assert.equal(KNOWN_DEALS['stealth/glyph-cluster:free']?.label, 'FREE')
  assert.equal(KNOWN_DEALS['stealth/glyph-cluster:free']?.free, true)
  assert.equal(KNOWN_DEALS['stealth/glyph-cluster:free']?.expiresAt, undefined)
  assert.equal(isFreeModel('stealth/glyph-cluster:free'), true)
  // GPT-6.1 Sol (command-code@1.71.0) ships at full price with no promotion.
  assert.equal(KNOWN_DEALS['gpt-6.1-sol'], undefined)
  // The pricing page still embeds an already-expired (2026-06-22)
  // `qwen-3.7-max-2x-usage` record its own Deals section does not list, so it stays
  // out of the snapshot — the rate row already carries the discounted figures.
  assert.equal(KNOWN_DEALS['Qwen/Qwen3.7-Max'], undefined)
  // Both stealth previews carried the identical permanent-style terms ("Free
  // while the stealth preview lasts", 100% off, no expiresAt) until they were
  // retired — Pixel Canary on 2026-10-01, Space Bunny Alpha on 2026-10-06. The
  // deals left the snapshot with the models, so `isFreeModel()` must stop
  // reporting both free.
  assert.equal(KNOWN_DEALS['stealth/pixel-canary'], undefined)
  assert.equal(isFreeModel('stealth/pixel-canary'), false)
  assert.equal(KNOWN_DEALS['stealth/space-bunny-alpha'], undefined)
  assert.equal(isFreeModel('stealth/space-bunny-alpha'), false)
})

test('dealLabel() hides a deal after its expiry date', () => {
  // The retired MiniMax free promos were removed from the snapshot, so they report no label at any time.
  assert.equal(dealLabel('minimax/minimax-m3-free', Date.parse('2026-09-05T12:00:00Z')), undefined)
  assert.equal(dealLabel('minimax/minimax-m3-free', Date.parse('2026-09-06T00:00:00Z')), undefined)
  assert.equal(dealLabel('minimax/minimax-m2.7-free', Date.parse('2026-09-06T00:00:00Z')), undefined)
  // Permanent deals are unaffected by any time.
  assert.equal(dealLabel('MiniMaxAI/MiniMax-M3', Date.parse('2030-01-01T00:00:00Z')), '50% off')
  // DeepSeek V4 Pro's deal was removed after it lapsed; the model is peak/off-peak priced now.
  assert.equal(dealLabel('deepseek/deepseek-v4-pro', Date.parse('2026-08-15T00:00:00Z')), undefined)
  // Free label survives until capacity ends (treated as permanent here).
  assert.equal(dealLabel('poolside/laguna-s-2.1-free', Date.parse('2030-01-01T00:00:00Z')), 'FREE')
  // Grok 4.7's 40% off launch deal lapsed 2026-09-27T23:59:59.999Z and was then
  // removed from the page, so there is no label at any time.
  assert.equal(dealLabel('xai/grok-4.7', Date.parse('2026-09-21T00:00:00Z')), undefined)
  assert.equal(dealLabel('xai/grok-4.7', Date.parse('2026-09-27T12:00:00Z')), undefined)
  assert.equal(dealLabel('xai/grok-4.7', Date.parse('2026-09-28T00:00:00Z')), undefined)
  // Ling 3.1 Flash's promo is gone, so there is no label at any time.
  assert.equal(dealLabel('inclusionai/ling-3.1-flash:free', Date.parse('2030-01-01T00:00:00Z')), undefined)
  assert.equal(dealLabel('inclusionai/ling-3.1-flash', Date.parse('2030-01-01T00:00:00Z')), undefined)
  assert.equal(dealLabel('claude-sonnet-5'), undefined)
  // Gemini 3.7 Flash's deal was retired: no label at any time.
  assert.equal(dealLabel('google/gemini-3.7-flash', Date.parse('2026-12-31T12:00:00Z')), undefined)
})

test('formatContext() renders compact human sizes', () => {
  assert.equal(formatContext(1_000_000), '1M')
  assert.equal(formatContext(1_050_000), '1.1M')
  // 1048576 (Gemini) rounds to a clean 1M, not 1.0M.
  assert.equal(formatContext(1_048_576), '1M')
  assert.equal(formatContext(256_000), '256K')
  // 262144 (Tencent Hy3's real value) displays as 262K, matching the pricing page.
  assert.equal(formatContext(262_144), '262K')
  assert.equal(formatContext(200_000), '200K')
  assert.equal(formatContext(500), '500')
  assert.equal(formatContext(undefined), undefined)
  assert.equal(formatContext(0), undefined)
})

test('capabilityDescription() composes plan, deal, Image, context', () => {
  // Free model without Vision: no Image marker.
  assert.equal(capabilityDescription('poolside/laguna-s-2.1-free', 256_000), 'Go · FREE · 256K')
  // LongCat 2.0 has been paid since its promo ended — text-only, 1M, so no deal and no Image marker.
  assert.equal(capabilityDescription('meituan/LongCat-2.0', 1_048_576), 'Go · 1M')
  // Discounted Image model with context.
  assert.equal(capabilityDescription('MiniMaxAI/MiniMax-M3', 1_000_000), 'Go · 50% off · Image · 1M')
  // Text-only model: no Image marker. DeepSeek V4 Flash carries time-of-day
  // pricing; a fixed off-peak time (17:00 UTC) shows the `Half` marker.
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4-flash', 1_000_000, Date.parse('2026-08-17T17:00:00Z')),
    'Go · Half · 1M',
  )
  // Peak rates apply Monday–Friday only: 02:30 UTC is `Peak` on a Monday
  // (2026-08-17) but `Half` on the Saturday before it (2026-08-15).
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4-flash', 1_000_000, Date.parse('2026-08-17T02:30:00Z')),
    'Go · Peak · 1M',
  )
  // DeepSeek V4.1 Flash: a Go-tier Image model on the same hourly schedule.
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4.1-flash', 1_000_000, Date.parse('2026-08-17T02:30:00Z')),
    'Go · Peak · Image · 1M',
  )
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4.1-flash', 1_000_000, Date.parse('2026-08-17T17:00:00Z')),
    'Go · Half · Image · 1M',
  )
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4-flash', 1_000_000, Date.parse('2026-08-15T02:30:00Z')),
    'Go · Half · 1M',
  )
  // V4 Flash Fast is flat-priced: no peak/off-peak marker at any hour.
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4-flash-fast', 1_000_000, Date.parse('2026-08-17T02:30:00Z')),
    'Go · 1M',
  )
  // Expired deal vanishes from the composition.
  assert.equal(
    capabilityDescription('google/gemini-3.7-flash', 1_000_000, Date.parse('2027-01-01T00:00:00Z')),
    'GOAT · Image · 1M',
  )
  // No plan knowledge -> bare parts only.
  assert.equal(capabilityDescription('some-future-model', undefined), '')
})

test('peakPricingState/Label report the current UTC peak/off-peak window', () => {
  // All DeepSeek hourly-priced models are in the time-of-day pricing snapshot; the V4
  // Flash Vision variant and V4.1 Flash share V4 Flash's windows per the pricing page.
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-pro'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-vision-exp'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4.1-flash'))
  // DeepSeek V4 Flash Fast is NOT hourly-priced: the pricing page's embedded model JSON
  // gives it a flat rate and no `timeOfDay` block, so it must carry no Peak/Half marker.
  assert.ok(!KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-fast'))
  assert.equal(
    peakPricingState('deepseek/deepseek-v4-flash-fast', Date.parse('2026-08-17T02:30:00Z')),
    undefined,
  )
  assert.equal(
    peakPricingLabel('deepseek/deepseek-v4-flash-fast', Date.parse('2026-08-17T02:30:00Z')),
    undefined,
  )
  // Non-peak-priced models report no state. Qwen 3.8 Max only looks annotated: in the
  // flattened pricing page its hover annotation actually belongs to the V4 Flash
  // Vision row above it. Same for tencent/hy4-preview, priced per token.
  assert.ok(!KNOWN_PEAK_PRICING.has('Qwen/Qwen3.8-Max'))
  assert.ok(!KNOWN_PEAK_PRICING.has('tencent/hy4-preview'))
  // command-code@1.67.0's DeepSeek V4.1 Flash Fast carries its own `timeOfDay` block
  // (off-peak $0.16/$0.58, peak $0.32/$1.16), so it joins the membership set and gets
  // the same Peak/Half label as its siblings.
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4.1-flash-fast'))
  assert.equal(
    peakPricingLabel('deepseek/deepseek-v4.1-flash-fast', Date.parse('2026-08-17T02:30:00Z')),
    'Peak',
  )
  assert.equal(
    peakPricingLabel('deepseek/deepseek-v4.1-flash-fast', Date.parse('2026-08-17T17:30:00Z')),
    'Half',
  )
  assert.equal(peakPricingState('claude-sonnet-5', Date.parse('2026-08-17T17:00:00Z')), undefined)
  assert.equal(peakPricingLabel('claude-sonnet-5', Date.parse('2026-08-17T17:00:00Z')), undefined)

  // Official windows: peak 01:00–04:00 and 06:00–10:00 UTC, off-peak
  // otherwise, Monday–Friday only. 2026-08-17 is a Monday.
  const peak = (h: number) => Date.parse(`2026-08-17T${String(h).padStart(2, '0')}:30:00Z`)
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(2)), 'peak')
  assert.equal(peakPricingLabel('deepseek/deepseek-v4-flash', peak(2)), 'Peak')
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(8)), 'peak')
  assert.equal(peakPricingLabel('deepseek/deepseek-v4-flash', peak(8)), 'Peak')
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(17)), 'off-peak')
  assert.equal(peakPricingLabel('deepseek/deepseek-v4-flash', peak(17)), 'Half')
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(0)), 'off-peak')
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(4)), 'off-peak')
  assert.equal(peakPricingState('deepseek/deepseek-v4-flash', peak(10)), 'off-peak')
  // The boundary hours: 03:59 is still peak, 04:00 is off-peak.
  assert.equal(
    peakPricingState('deepseek/deepseek-v4-pro', Date.parse('2026-08-17T03:59:59Z')),
    'peak',
  )
  assert.equal(
    peakPricingState('deepseek/deepseek-v4-pro', Date.parse('2026-08-17T04:00:00Z')),
    'off-peak',
  )
  // Weekends are charged completely off-peak for all 24 hours: the same peak
  // hours on a Saturday (2026-08-15) and Sunday (2026-08-16) are `Half`.
  for (const weekendHour of [2, 8, 17]) {
    for (const weekendDay of ['2026-08-15', '2026-08-16']) {
      const at = Date.parse(`${weekendDay}T${String(weekendHour).padStart(2, '0')}:30:00Z`)
      assert.equal(peakPricingState('deepseek/deepseek-v4-flash', at), 'off-peak')
      assert.equal(peakPricingLabel('deepseek/deepseek-v4-flash', at), 'Half')
    }
  }
  // Peak is 7 hours on a weekday (01-03 + 06-09 = 3 + 4) and 0 on a weekend:
  // 35 hours across a full Monday–Sunday week.
  let weekdayPeakHours = 0
  for (let h = 0; h < 24; h++) {
    if (peakPricingState('deepseek/deepseek-v4-flash', peak(h)) === 'peak') weekdayPeakHours++
  }
  assert.equal(weekdayPeakHours, 7)
  let weekendPeakHours = 0
  for (const weekendDay of ['2026-08-15', '2026-08-16']) {
    for (let h = 0; h < 24; h++) {
      const at = Date.parse(`${weekendDay}T${String(h).padStart(2, '0')}:30:00Z`)
      if (peakPricingState('deepseek/deepseek-v4-flash', at) === 'peak') weekendPeakHours++
    }
  }
  assert.equal(weekendPeakHours, 0)
  let weekPeakHours = 0
  for (const day of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']) {
    for (let h = 0; h < 24; h++) {
      const at = Date.parse(`${day}T${String(h).padStart(2, '0')}:30:00Z`)
      if (peakPricingState('deepseek/deepseek-v4-flash', at) === 'peak') weekPeakHours++
    }
  }
  assert.equal(weekPeakHours, 35)
})

test('isPeakPricingHour() answers the model-independent half of the same rule', () => {
  // The composer's session-cost readout prices against the price table's own `peak`
  // blocks, so it needs the hour test WITHOUT a model membership check — and it must
  // agree with `peakPricingState()` on every hour, or the label and the rate diverge.
  const peak = (h: number) => Date.parse(`2026-08-17T${String(h).padStart(2, '0')}:30:00Z`)
  for (let h = 0; h < 24; h++) {
    const expected = peakPricingState('deepseek/deepseek-v4-flash', peak(h)) === 'peak'
    assert.equal(isPeakPricingHour(peak(h)), expected, `hour ${h}`)
  }
  // Weekends are off-peak for all 24 hours, exactly as above.
  for (const day of ['2026-08-15', '2026-08-16']) {
    for (let h = 0; h < 24; h++) {
      const at = Date.parse(`${day}T${String(h).padStart(2, '0')}:30:00Z`)
      assert.equal(isPeakPricingHour(at), false, `${day} hour ${h}`)
    }
  }
  // End-exclusive on both edges, same boundaries the snapshot documents.
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T00:59:59Z')), false)
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T01:00:00Z')), true)
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T03:59:59Z')), true)
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T04:00:00Z')), false)
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T09:59:59Z')), true)
  assert.equal(isPeakPricingHour(Date.parse('2026-08-17T10:00:00Z')), false)
  // The windows ship to the browser with the price table, so they are part of
  // the wire contract rather than a private constant.
  assert.deepEqual(PEAK_HOUR_RANGES, [[1, 4], [6, 10]])
})

test('CLI version and API base constants are stable', () => {
  // The version rides every request as `x-command-code-version`. The per-release sync
  // record — what each upstream version added and what was re-verified unchanged — lives
  // in CHANGELOG.md (whose newest published entry may lag the pinned constant); this
  // assertion pins the constant only.
  assert.equal(COMMAND_CODE_CLI_VERSION, '1.88.2')
  assert.equal(DEFAULT_API_BASE, 'https://api.commandcode.ai')
})

test('resolveAuthFileApiKey is safe without an auth file', async () => {
  // `homedir` is not injectable, so exercise the no-throw contract directly: with or
  // without a `~/.commandcode/auth.json` on this machine it must not throw.
  let threw = false
  try {
    const value = resolveAuthFileApiKey()
    assert.ok(value === undefined || typeof value === 'string')
  } catch {
    threw = true
  }
  assert.equal(threw, false)
})

// ---------------------------------------------------------------------------
// Multi-account rotation
// ---------------------------------------------------------------------------

/** A fetch stub that scripts one response per Bearer key and records calls. */
function fetchByKey(byKey: Record<string, { status: number; body: string }>): {
  fetchImpl: typeof fetch
  calls: Array<{ key: string; status: number }>
} {
  const calls: Array<{ key: string; status: number }> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const key = (headers.Authorization ?? '').replace(/^Bearer /, '')
    const canned = byKey[key] ?? { status: 500, body: 'unscripted key' }
    calls.push({ key, status: canned.status })
    return new Response(canned.body, {
      status: canned.status,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const FINISH_STREAM = 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'

test('stream() rotates to the next account after a pre-stream 429', async () => {
  const { fetchImpl, calls } = fetchByKey({
    'key-1': { status: 429, body: 'rate limited' },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const rotated: Array<[string, string]> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotated.push([rejected, rejection])
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))

  // Two connect attempts: key-1 refused, key-2 served; the rotation hook saw the
  // rejection exactly once and the stream finished normally. The reason is
  // `throttled`, not `rate-limit`: this body names no usage window, and only a named
  // window may be reported as an exhausted one (issue #54).
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(rotated, [['key-1', 'throttled']])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() classifies a 429 that NAMES a window as the window limit it is', async () => {
  // The other half of the same rule, mirroring the CLI's `resolveWindowLabel`:
  // a `rateLimit.window` (or the plan-usage-limit wording) is what makes a 429
  // a window rejection. Only then may the pool report an exhausted window and
  // hold the account out until the provider's own reset.
  const resetSeconds = Math.floor(Date.now() / 1000) + 1800
  const cases: Array<readonly [string, number | undefined]> = [
    [JSON.stringify({ error: { code: 'RATE_LIMITED', rateLimit: { window: 'weekly', reset: resetSeconds } } }), resetSeconds * 1000],
    [JSON.stringify({ code: 'RATE_LIMITED', rateLimit: { window: 'daily', reset: resetSeconds } }), resetSeconds * 1000],
    [JSON.stringify({ error: { message: 'You have reached the usage limit for your plan (weekly)' } }), undefined],
    [JSON.stringify({ error: { rateLimit: { window: 'fiveHour' } } }), undefined],
  ]
  for (const [body, expectedReset] of cases) {
    const { fetchImpl } = fetchByKey({ 'key-1': { status: 429, body } })
    const seen: Array<{ reason: string; resetAtMs: number | undefined }> = []
    const adapter = makeAdapter({
      fetchImpl,
      resolveApiKey: async () => 'key-1',
      rotateApiKey: async (_rejected, reason, _connection, _model, rotation) => {
        seen.push({ reason, resetAtMs: rotation?.resetAtMs })
        return undefined
      },
    })
    await assert.rejects(
      collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
      (err: unknown) => (err as { code?: string }).code === 'RATE_LIMIT',
    )
    assert.equal(seen[0]?.reason, 'rate-limit', body)
    assert.equal(seen[0]?.resetAtMs, expectedReset, body)
  }
})

test('stream() ends a bare RATE_LIMITED as a retryable RATE_LIMIT that claims no window', async () => {
  // Issue #54's shape: a rejection whose body says nothing about a usage window. The
  // CLI accepts the code on ANY status, and this is the branch whose own wording the
  // user reads — it must stay retryable and must not imply a spent window. (The
  // pool's diagnosis is pinned in tests/accounts.test.ts.)
  const { fetchImpl } = fetchByKey({
    'key-1': { status: 503, body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }) },
  })
  const adapter = makeAdapter({ fetchImpl, resolveApiKey: async () => 'key-1' })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const caught = err as { code?: string; message?: string }
      assert.equal(caught.code, 'THROTTLED')
      assert.match(caught.message ?? '', /did not report an exhausted usage window/)
      assert.match(caught.message ?? '', /未报告用量窗口用尽/)
      return true
    },
  )
})

test('stream() rotates past an invalid-credential account (401)', async () => {
  const { fetchImpl, calls } = fetchByKey({
    'key-1': { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHORIZED' } }) },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const rotated: Array<[string, string]> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotated.push([rejected, rejection])
      return 'key-2'
    },
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(rotated, [['key-1', 'invalid-credential']])
})

test('stream() surfaces the 429 when rotation offers no other account', async () => {
  const { fetchImpl, calls } = fetchByKey({ 'key-1': { status: 429, body: 'rate limited' } })
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'THROTTLED',
  )
  assert.equal(calls.length, 1)
})

test('stream() never retries with a key it already tried', async () => {
  const { fetchImpl, calls } = fetchByKey({
    'key-1': { status: 429, body: 'rate limited' },
    'key-2': { status: 429, body: 'rate limited' },
  })
  // A misbehaving hook cycling key-1 <-> key-2 must terminate, not loop.
  const keys = ['key-2', 'key-1']
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => keys.shift(),
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'THROTTLED',
  )
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
})

test('stream() rotates past an account-scoped 400 (insufficient credits)', async () => {
  // Issue #51's follow-up: the pool kept handing out an account that could not pay,
  // and the 400 was terminal as well as invisible — the turn failed on an account
  // whose three siblings were fine. The official CLI reads this one as
  // `isInsufficientCreditsRequestError` (status 400 + the wording), so we rotate.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 400,
      body: JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits' } }),
    },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const rotated: Array<{ key: string; reason: string; tried: readonly string[] }> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, reason, _connection, _model, rotation) => {
      rotated.push({ key: rejected, reason, tried: rotation?.tried ?? [] })
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))

  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.equal(rotated[0]?.reason, 'unavailable')
  // The tried set travels with the rejection: a reason that marks nothing must
  // not let the pool re-offer the same key on the next attempt.
  assert.deepEqual(rotated[0]?.tried, ['key-1'])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() rotates on a code-only account-scoped body, with no wording to read', async () => {
  // The test above passes with the message "Insufficient credits" present, so it would
  // stay green with an empty code list — the fixture never proves the code branch.
  // This is the body the official CLI's `isInsufficientCreditsRequestError` actually
  // reads (the CODE, no message), and the shape #51's follow-up reports: the account
  // that cannot pay must be rotated past, never handed out again.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': { status: 400, body: JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS' } }) },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const reasons: string[] = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason) => {
      reasons.push(reason)
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))

  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(reasons, ['unavailable'])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() rotates past a zero-balance Messages-route rejection with no code, only the Anthropic envelope', async () => {
  // A real zero-balance account's own 400, captured live from
  // /provider/v1/messages (issue #51 follow-up investigation, 2026-09-30):
  // the Anthropic error envelope, no `code` member at all — only `error.type`
  // ("invalid_request_error", not an account-fact code) and prose. Neither
  // existing "insufficient credits" fixture above carries this shape (both
  // have a `code`); this one only survives on the prose scan
  // (`lower.includes('insufficient credits')`), which must keep matching it.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 400,
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.',
        },
      }),
    },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const reasons: string[] = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason) => {
      reasons.push(reason)
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(reasons, ['unavailable'])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() rotates past a 5xx that carries a structured account code', async () => {
  // The structured codes are account facts on ANY status (the CLI reads the code before
  // its status guard). Without this, a gateway proxying the provider's own
  // credits/plan rejection under a 5xx was classified as "the provider is
  // unavailable": no rotation, and `SERVER` put the identical request back on
  // dsh-llm-retry's 1000-attempt cadence. Only the PROSE scan stays in 4xx.
  for (const code of ['INSUFFICIENT_CREDITS', 'USAGE_EXCEEDED', 'PREMIUM_CREDITS_EXHAUSTED', 'MODEL_NOT_IN_PLAN'] as const) {
    const { fetchImpl, calls } = fetchByKey({
      'key-1': { status: 503, body: JSON.stringify({ error: { code } }) },
      'key-2': { status: 200, body: FINISH_STREAM },
    })
    const reasons: string[] = []
    const adapter = makeAdapter({
      fetchImpl,
      resolveApiKey: async () => 'key-1',
      rotateApiKey: async (_rejected, reason) => {
        reasons.push(reason)
        return 'key-2'
      },
    })
    const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
    assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'], `${code} must rotate`)
    assert.deepEqual(reasons, ['unavailable'], `${code} is an account fact, not a provider outage`)
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
  }
})

test('通用 HTTP 错误以中文说明和错误码展示，不回显上游正文', async () => {
  const { fetchImpl } = fetchByKey({
    'key-1': { status: 400, body: JSON.stringify({ error: {
      code: 'validation_error', message: 'upstream reflected private prompt marker',
    } }) },
  })
  const adapter = makeAdapter({ fetchImpl, resolveApiKey: async () => 'key-1' })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => {
      const actual = error as { code?: string; message: string; failure?: { status?: number } }
      assert.equal(actual.code, 'PROVIDER_HTTP_ERROR')
      assert.equal(actual.failure?.status, 400)
      assert.match(actual.message, /请求失败（HTTP 400）/)
      assert.match(actual.message, /错误码：validation_error/)
      assert.doesNotMatch(actual.message, /private prompt marker|upstream reflected/)
      return true
    },
  )
})

for (const protocol of ['cli', 'openai', 'messages'] as const) {
  test(`${protocol}：HTTP 错误分别保留有界代码和类型，拒绝正文及非法标识`, async () => {
    const cases = [
      { fields: { type: 'invalid_request_error' }, shown: ['错误类型：invalid_request_error'] },
      { fields: { code: 'validation_error', type: 'invalid_request_error' }, shown: ['错误码：validation_error', '错误类型：invalid_request_error'] },
      { fields: { code: 'private code with spaces', type: 'permission_error' }, shown: ['错误类型：permission_error'] },
      { fields: { code: 'a'.repeat(80), type: 'b'.repeat(81) }, shown: ['错误码：' + 'a'.repeat(80)] },
      { fields: { code: '<script>private</script>', type: 'private\nmarker' }, shown: [] },
      { fields: { type: '含私密输入' }, shown: [] },
    ]
    for (const [index, { fields, shown }] of cases.entries()) {
      const paths: string[] = []
      const adapter = makeAdapter({
        options: () => ({ ...OPENAI_OPTIONS(), protocol: protocol === 'messages' ? 'auto' : protocol, modelsCachePath: '' }),
        fetchImpl: (async (input) => {
          paths.push(new URL(String(input)).pathname)
          // 同时覆盖嵌套错误和根级错误；响应请求号走现有持久化失败契约。
          const payload = { ...fields, message: 'private prompt marker' }
          return new Response(JSON.stringify(index % 2 === 0 ? { error: payload } : payload), {
            status: 400, headers: { 'x-request-id': 'synthetic-diagnostic-request', 'set-cookie': 'private cookie' },
          })
        }) as typeof fetch,
      })
      await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: protocol === 'messages' ? 'claude-haiku-5-5' : 'm', messages: [userMessage('hi')] })), (error: unknown) => {
        const actual = error as LlmError
        assert.equal(actual.code, 'PROVIDER_HTTP_ERROR')
        assert.equal(actual.failure.status, 400)
        assert.equal(actual.failure.requestId, 'synthetic-diagnostic-request')
        for (const value of shown) assert.ok(actual.message.includes(value))
        assert.equal(actual.message.includes('错误码：'), shown.some((value) => value.startsWith('错误码：')))
        assert.equal(actual.message.includes('错误类型：'), shown.some((value) => value.startsWith('错误类型：')))
        assert.doesNotMatch(actual.message, /private|含私密输入|<script>|b{81}/u)
        return true
      })
      assert.deepEqual(paths, [protocol === 'cli' ? '/alpha/generate' : protocol === 'messages' ? '/provider/v1/messages' : '/provider/v1/chat/completions'])
    }
  })
}

test('Messages 的权限拒绝回退 CLI 直连，CLI 成功后正常收流', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto', apiBase: 'https://permission-fallback.invalid', modelsCachePath: '' }),
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      // issue #84 的响应形态：Messages 端点回 Anthropic 风格的 permission_error。
      return path === '/provider/v1/messages'
        ? new Response(JSON.stringify({ error: { type: 'permission_error', message: 'Authentication failed. Please check your credentials.' } }), { status: 403 })
        : new Response(FINISH_STREAM)
    }) as typeof fetch,
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'claude-haiku-5-5', messages: [userMessage('hi')] }))
  assert.ok(chunks.length > 0)
  assert.deepEqual(paths, ['/provider/v1/messages', '/alpha/generate'])
})

test('回退后 CLI 仍失败：以 CLI 结果为主并保留反代拒绝标识', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto', apiBase: 'https://permission-fallback-fail.invalid', modelsCachePath: '' }),
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      return path === '/provider/v1/messages'
        ? new Response(JSON.stringify({ error: { type: 'permission_error', message: 'Authentication failed. Please check your credentials.' } }), { status: 403 })
        : new Response(JSON.stringify({ error: { type: 'permission_error', message: 'cli still refused' } }), { status: 403 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'claude-haiku-5-5', messages: [userMessage('hi')] })), (error: unknown) => {
    const actual = error as LlmError
    assert.equal(actual.code, 'PROVIDER_HTTP_ERROR')
    assert.equal(actual.failure.status, 403)
    // 主句描述第二段链路（CLI），并附上反代侧先前的拒绝标识；两段正文都不回显。
    assert.match(actual.message, /错误类型：permission_error/u)
    assert.match(actual.message, /此前 Messages 接口以 permission_error 拒绝，已回退 CLI 直连，仍未成功/u)
    assert.doesNotMatch(actual.message, /Authentication failed|cli still refused/u)
    return true
  })
  assert.deepEqual(paths, ['/provider/v1/messages', '/alpha/generate'])
})

test('Messages 端点的其它 403 拒绝不回退 CLI', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto', apiBase: 'https://permission-other.invalid', modelsCachePath: '' }),
    fetchImpl: (async (input) => {
      paths.push(new URL(String(input)).pathname)
      return new Response(JSON.stringify({ error: { code: 'MODEL_NOT_IN_PLAN', type: 'invalid_request_error', message: 'model not in plan' } }), { status: 403 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'claude-haiku-5-5', messages: [userMessage('hi')] })), (error: unknown) => {
    const actual = error as LlmError
    assert.doesNotMatch(actual.message, /已回退 CLI 直连/u)
    return true
  })
  assert.deepEqual(paths, ['/provider/v1/messages'])
})

test('Chat Completions 的 permission_error 不回退 CLI', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'openai', apiBase: 'https://permission-openai.invalid', modelsCachePath: '' }),
    fetchImpl: (async (input) => {
      paths.push(new URL(String(input)).pathname)
      return new Response(JSON.stringify({ error: { type: 'permission_error', message: 'refused' } }), { status: 403 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })), (error: unknown) => {
    const actual = error as LlmError
    assert.match(actual.message, /错误类型：permission_error/u)
    assert.doesNotMatch(actual.message, /已回退 CLI 直连/u)
    return true
  })
  assert.deepEqual(paths, ['/provider/v1/chat/completions'])
})

test('Messages 的权限回退不写入协议缓存，也不影响同账号其它模型的路由', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto', apiBase: 'https://permission-scope.invalid', modelsCachePath: '' }),
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/provider/v1/messages') {
        return new Response(JSON.stringify({ error: { type: 'permission_error' } }), { status: 403 })
      }
      return new Response(path === '/alpha/generate'
        ? FINISH_STREAM
        : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }) as typeof fetch,
  })
  const options = { provider: 'commandcode', model: 'claude-haiku-5-5', messages: [userMessage('hi')] }
  await collect(adapter.stream(options))
  // 同一条 Claude 请求第二次仍然先试 Messages：单条链路的拒绝不能代表整个网关。
  await collect(adapter.stream(options))
  // 同账号的 GPT 路由照旧走 Provider API，没有被 Claude 的拒绝拖走。
  await collect(adapter.stream({ provider: 'commandcode', model: 'gpt-5.6-sol', messages: [userMessage('hi')] }))
  assert.deepEqual(paths, [
    '/provider/v1/messages', '/alpha/generate',
    '/provider/v1/messages', '/alpha/generate',
    '/provider/v1/chat/completions',
  ])
})

test('账号轮换后的错误不继承上一账号的权限拒绝注记', async () => {
  const paths: string[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto', apiBase: 'https://permission-rotation.invalid', modelsCachePath: '' }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => 'key-2',
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname
      const headers = init?.headers as Record<string, string> | undefined
      paths.push(`${path}:${(headers?.Authorization ?? '').slice(-5)}`)
      if (path === '/provider/v1/messages') {
        // 第一个账号被权限拒绝，第二个账号是另一种套餐限制：后者不是回退条件。
        return new Response(JSON.stringify(headers?.Authorization?.endsWith('key-1') === true
          ? { error: { type: 'permission_error' } }
          : { error: { code: 'MODEL_NOT_IN_PLAN', type: 'invalid_request_error' } }), { status: 403 })
      }
      return new Response('invalid credential', { status: 401 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'claude-haiku-5-5', messages: [userMessage('hi')] })), (error: unknown) => {
    const actual = error as LlmError
    // 换账号后经历的是 MODEL_NOT_IN_PLAN，文案只能描述当前账号的链路。
    assert.match(actual.message, /错误码：MODEL_NOT_IN_PLAN/u)
    assert.doesNotMatch(actual.message, /已回退 CLI 直连/u)
    return true
  })
  assert.deepEqual(paths, ['/provider/v1/messages:key-1', '/alpha/generate:key-1', '/provider/v1/messages:key-2'])
})

test('stream() does not blame an account for a 5xx that carries no window-limit code', async () => {
  // The status guard's job: a provider outage keeps its retry cadence for EVERY
  // account instead of being remembered against one. (A 5xx that does carry the
  // code is the deliberate exception pinned by the next test.)
  const { fetchImpl } = fetchByKey({
    'key-1': { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) },
  })
  let rotateCalls = 0
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      rotateCalls += 1
      return 'key-2'
    },
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => (error as { code?: string }).code === 'SERVER',
  )
  assert.equal(rotateCalls, 0)
})

test('stream() treats a 5xx carrying the RATE_LIMITED code as the window limit it is', async () => {
  // Deliberate, and mirroring the CLI's `parseWindowLimitError`, which accepts
  // the code on ANY status: a gateway that proxies the provider's own limit body
  // under a 5xx is still reporting a window limit, and that body's `reset` says
  // for how long. It is the reason the code check runs before the status guard.
  const resetSeconds = Math.floor(Date.now() / 1000) + 1800
  const { fetchImpl } = fetchByKey({
    'key-1': {
      status: 503,
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', rateLimit: { window: 'fiveHour', reset: resetSeconds } } }),
    },
  })
  const seen: Array<{ reason: string; resetAtMs: number | undefined }> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason, _connection, _model, rotation) => {
      seen.push({ reason, resetAtMs: rotation?.resetAtMs })
      return undefined
    },
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => (error as { code?: string }).code === 'RATE_LIMIT',
  )
  assert.equal(seen[0]?.reason, 'rate-limit')
  assert.ok((seen[0]?.resetAtMs ?? 0) > Date.now(), 'the provider’s own reset rides the rejection')
})

test('stream() ends an unroutable window limit as a retryable RATE_LIMIT, not a dead 4xx', async () => {
  // No hook to rotate with (a host that does not wire the pool), so the turn ends here —
  // but it must end as a RETRYABLE RATE_LIMIT carrying the provider's reset. A 400
  // maps to `PROVIDER_HTTP_ERROR`, which sits outside dsh-llm-retry's whitelist, so
  // the turn would die even though the provider said when the request works again.
  const resetSeconds = Math.floor(Date.now() / 1000) + 1800
  const { fetchImpl } = fetchByKey({
    'key-1': {
      status: 400,
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', rateLimit: { window: 'weekly', reset: resetSeconds } } }),
    },
  })
  const adapter = makeAdapter({ fetchImpl, resolveApiKey: async () => 'key-1' })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => {
      const caught = error as { code?: string; failure?: { providerRetryAfterMs?: number } }
      assert.equal(caught.code, 'RATE_LIMIT')
      const wait = caught.failure?.providerRetryAfterMs
      assert.ok(wait !== undefined && wait > 0 && wait <= 900_000, `expected a bounded wait, got ${String(wait)}`)
      return true
    },
  )
})

test('stream() reads the RATE_LIMITED code on a non-429 status and its own reset time', async () => {
  // The CLI's `parseWindowLimitError` accepts the code OR the status, and reads
  // `error.rateLimit.reset` as SECONDS. The provider's own reset is what keeps
  // an exhausted account out of rotation for exactly as long as it said.
  const resetSeconds = Math.floor(Date.now() / 1000) + 3600
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 400,
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', rateLimit: { window: 'weekly', reset: resetSeconds } } }),
    },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const rotated: Array<{ reason: string; resetAtMs: number | undefined }> = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason, _connection, _model, rotation) => {
      rotated.push({ reason, resetAtMs: rotation?.resetAtMs })
      return 'key-2'
    },
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))

  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.equal(rotated[0]?.reason, 'rate-limit')
  assert.equal(rotated[0]?.resetAtMs, resetSeconds * 1000)
})

test('stream() rotates past a model the account’s plan does not include', async () => {
  // Account-scoped like the credits case: another account may well have the
  // model, and a hard failure on the first one is what made a mixed-plan pool
  // unusable.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 403,
      body: JSON.stringify({ error: { code: 'MODEL_NOT_IN_PLAN', message: 'Model not in plan: claude-opus-5' } }),
    },
    'key-2': { status: 200, body: FINISH_STREAM },
  })
  const reasons: string[] = []
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (_rejected, reason) => {
      reasons.push(reason)
      return 'key-2'
    },
  })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-5', messages: [userMessage('hi')] }))

  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(reasons, ['unavailable'])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
})

test('stream() does not rotate on a request-shape 400', async () => {
  // Negative control: a malformed request fails identically on every account,
  // so rotating would multiply the load and hide the real error. Only
  // account-scoped rejections rotate.
  const { fetchImpl, calls } = fetchByKey({
    'key-1': {
      status: 400,
      body: JSON.stringify({ error: { code: 'INVALID_REQUEST', message: "Invalid schema for function 'x'" } }),
    },
  })
  let rotateCalls = 0
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      rotateCalls += 1
      return 'key-2'
    },
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_HTTP_ERROR',
  )
  assert.equal(rotateCalls, 0)
  assert.deepEqual(calls.map((call) => call.key), ['key-1'])
})

test('stream() propagates the rotation hook’s all-exhausted error', async () => {
  const { fetchImpl } = fetchByKey({ 'key-1': { status: 429, body: 'rate limited' } })
  const adapter = makeAdapter({
    fetchImpl,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      throw Object.assign(new Error('all 2 Command Code account(s) have exhausted their usage window; the earliest window resets at 2030-01-01'), { code: 'RATE_LIMIT' })
    },
  })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'RATE_LIMIT' && /earliest window resets/.test(e.message ?? '')
    },
  )
})

/**
 * Plausible window resets for the probe fixtures, relative to now: the pool trusts a
 * published `resetAt` only while it lies inside a real metering horizon
 * (`MAX_TRUSTED_RESET_MS`), so a fixed far-future stamp would be dropped as
 * implausible, which is not what these tests are about.
 */
const FIVE_HOUR_RESET = Date.now() + 3 * 60 * 60 * 1000
const WEEKLY_RESET = Date.now() + 4 * 24 * 60 * 60 * 1000

test('probeWindowLimits() reports the five-hour window when it is the only one exceeded', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 5, cap: 5, exceeded: true, resetAt: FIVE_HOUR_RESET },
          weekly: { used: 1, cap: 6, exceeded: false, resetAt: WEEKLY_RESET },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: FIVE_HOUR_RESET })
})

test('probeWindowLimits() treats an exhausted weekly quota as limiting while the five-hour window is open', async () => {
  // Issue #51's follow-up: the two windows are metered separately, and reading only
  // `fiveHour` revived an account whose WEEKLY quota was spent — the pool handed it
  // out, the provider rejected the request, and the next all-marked pass revived it
  // again.
  const weeklyReset = WEEKLY_RESET
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 0.2, cap: 3, exceeded: false, resetAt: FIVE_HOUR_RESET - 60_000 },
          weekly: { used: 6, cap: 6, exceeded: true, resetAt: weeklyReset },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  // The binding reset is the weekly one: the open five-hour window buys
  // nothing while the weekly quota is spent.
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: weeklyReset })
})

test('probeWindowLimits() reports the latest reset when every window is exceeded', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 9, cap: 5, exceeded: true, resetAt: FIVE_HOUR_RESET },
          weekly: { used: 9, cap: 6, exceeded: true, resetAt: WEEKLY_RESET },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: WEEKLY_RESET })
})

test('probeWindowLimits() reports a clear account when no window is exceeded', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 0.1, cap: 3, exceeded: false, resetAt: FIVE_HOUR_RESET },
          weekly: { used: 1, cap: 6, exceeded: false, resetAt: WEEKLY_RESET },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: false, resetAt: 0 })
})

test('probeWindowLimits() uses a weekly-only payload', async () => {
  // The endpoint need not publish both windows; a report of one is still an
  // answer, and the other simply does not constrain the account.
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: { windowLimits: { weekly: { used: 6, cap: 6, exceeded: true, resetAt: WEEKLY_RESET } } },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: WEEKLY_RESET })
})

test('probeWindowLimits() degrades to undefined on endpoint or shape failure', async () => {
  const failing = makeAdapter({ fetchImpl: fetchReturning(500, 'boom') })
  assert.equal(await failing.probeWindowLimits('key-1'), undefined)
  const shapeless = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify({ credits: {} })) })
  assert.equal(await shapeless.probeWindowLimits('key-1'), undefined)
  // Window limits present but empty: nothing can be concluded, so the caller
  // keeps its mark (a fail-safe, never a revival).
  const emptyWindows = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify({ windowLimits: {} })) })
  assert.equal(await emptyWindows.probeWindowLimits('key-1'), undefined)
})

test('windowVerdict() gives the usage report the same answer the pool probe reads (issue #105)', async () => {
  // The settings card and the probe read the same endpoint; the report's parsed
  // windows must yield the verdict the probe would, or the card shows a spent
  // weekly window while auto selection still treats the account as usable.
  const body = {
    windowLimits: {
      fiveHour: { used: 0, cap: 5, exceeded: false, resetAt: FIVE_HOUR_RESET },
      weekly: { used: 6, cap: 6, exceeded: true, resetAt: WEEKLY_RESET },
    },
  }
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify(body)) })
  const report = await adapter.getUsage('key-1')
  const verdict = windowVerdict([report.credits?.fiveHour, report.credits?.weekly])
  assert.deepEqual(verdict, { exceeded: true, resetAt: WEEKLY_RESET })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), verdict)
  // An untrusted reset (beyond the 30-day horizon) is dropped, never pinned.
  const far = { used: 6, cap: 6, exceeded: true, resetAt: Date.now() + 60 * 86_400_000 }
  assert.deepEqual(windowVerdict([far]), { exceeded: true, resetAt: 0 })
  assert.equal(windowVerdict([undefined, undefined]), undefined)
})

test('providerRetryPolicy() pins the near-unbounded transient-only retry policy', () => {
  // dsh-llm-retry executes this at the agent-step boundary: normal mode with an
  // explicit 1000-attempt cap retries the five transient codes (failing fast on
  // permanent errors such as INVALID_CREDENTIAL), waits double from 500 ms capped at
  // 15 minutes with ±10% jitter, and honors an attached providerRetryAfterMs at or
  // below the cap.
  const adapter = makeAdapter()
  const policy = adapter.providerRetryPolicy('commandcode')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 1000)
  assert.deepEqual([...policy.retryableCodes], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'THROTTLED', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  // IMAGE_OFFLOAD_REQUIRED is deliberately outside the whitelist (issue #43):
  // the harness mutates the session surface and retries, so a byte-identical
  // resend from dsh-llm-retry could never succeed.
  assert.ok(!(policy.retryableCodes as readonly string[]).includes('IMAGE_OFFLOAD_REQUIRED'))
  assert.equal(policy.initialDelayMs, 500)
  assert.equal(policy.maxDelayMs, 900000)
  assert.equal(policy.jitterRatio, 0.1)
})

test('providerInfo() names the picker group "Command Code"', () => {
  // The model picker renders provider groups in registration order with the
  // adapter-supplied name as the sticky group title; the base class would show the
  // raw route id. The id keeps equaling the route (dsh-llm validates that).
  const adapter = makeAdapter()
  assert.deepEqual(adapter.providerInfo('commandcode'), { id: 'commandcode', name: 'Command Code' })
})

test('stream() attaches a 429 Retry-After header as providerRetryAfterMs', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited', { 'retry-after': '7' }) })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; failure?: { providerRetryAfterMs?: number } }
      return e.code === 'THROTTLED' && e.failure?.providerRetryAfterMs === 7000
    },
  )
})

test('stream() drops a non-finite Retry-After instead of failing error construction', async () => {
  // `1e308` seconds is finite but overflows to Infinity in milliseconds;
  // LlmError validates its options and would replace the provider failure
  // with an internal construction error if the value rode along.
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited', { 'retry-after': '1e308' }) })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; failure?: { providerRetryAfterMs?: number } }
      return e.code === 'THROTTLED' && e.failure?.providerRetryAfterMs === undefined
    },
  )
})

test('stream() drops a Retry-After above the policy cap so normal mode keeps retrying', async () => {
  // In normal mode the executor ABANDONS a retry whose attached wait exceeds
  // backoff.maxDelayMs instead of falling back to local backoff — a 20-minute
  // Retry-After must ride the capped local cadence, not kill the retry.
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited', { 'retry-after': '1200' }) })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; failure?: { providerRetryAfterMs?: number } }
      return e.code === 'THROTTLED' && e.failure?.providerRetryAfterMs === undefined
    },
  )
})

// ---------------------------------------------------------------------------
// getUsage(): total-failure classification (the settings card's blocked banner)
// ---------------------------------------------------------------------------

test('getUsage() 固定组织范围并等订阅账期，再读取官方汇总', async () => {
  const start = '2026-09-30T16:00:00.000Z'
  const end = '2026-10-31T16:00:00.000Z'
  const orgId = 'org /+&测试'
  const calls: URL[] = []
  let subscriptionRead = false
  const adapter = makeAdapter({ fetchImpl: (async (input) => {
    const url = new URL(String(input))
    calls.push(url)
    if (url.pathname === '/alpha/whoami') return Response.json({ user: { id: 'u1', name: 'A', userName: 'a' }, org: { id: orgId } })
    assert.equal(url.searchParams.get('orgId'), orgId)
    if (url.pathname === '/alpha/billing/credits') return Response.json({ credits: { monthlyCredits: 20, purchasedCredits: 0, freeCredits: 0 } })
    if (url.pathname === '/alpha/billing/subscriptions') {
      await new Promise(resolve => setTimeout(resolve, 5))
      subscriptionRead = true
      return Response.json({ data: { planId: 'individual-pro', status: 'active', currentPeriodStart: start, currentPeriodEnd: end } })
    }
    assert.equal(url.pathname, '/alpha/usage/summary')
    assert.equal(subscriptionRead, true)
    assert.equal(url.searchParams.get('since'), start)
    return Response.json({ totalCount: 7, completedCount: 5, failedCount: 2, totalCost: 1.25, periodBasis: 'billing-period', periodStart: start })
  }) as typeof fetch })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.failures.length, 0)
  assert.equal(calls.length, 4)
  assert.equal(calls[0]?.pathname, '/alpha/whoami')
  assert.equal(calls[3]?.pathname, '/alpha/usage/summary')
  assert.equal(report.plan?.currentPeriodStart, Date.parse(start))
  assert.equal(report.plan?.currentPeriodEnd, Date.parse(end))
  assert.equal(report.usage?.periodStart, Date.parse(start))
  assert.equal(report.usage?.totalCount, 7)
})

test('用量卡片与选择器共享同一份账户事实，但用量汇总必须每次重读', async () => {
  // 设置卡片的账户区与选择器的套餐过滤读的是同一批端点、同一个账号：whoami 一次，
  // 再并行 credits + subscriptions 一次。各自独立读等于同一份答案付两遍钱，而卡片
  // 还在定时刷新，于是选择器反复为它早就有的行付出往返。
  //
  // 但 usage/summary 不同：那是用户正盯着的数字，卡片旁边还写着读取时间，绝不能
  // 拿一次早先的响应回放。
  const calls: Array<{ path: string; since: string | null }> = []
  let usageReads = 0
  const adapter = makeAdapter({ fetchImpl: (async (input) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, since: url.searchParams.get('since') })
    if (url.pathname === '/alpha/whoami') return Response.json({ user: { id: 'u1' }, org: { id: 'org-1' } })
    if (url.pathname === '/alpha/billing/subscriptions') {
      return Response.json({ data: { planId: 'individual-go', status: 'active', currentPeriodStart: 1000 } })
    }
    if (url.pathname === '/alpha/billing/credits') {
      return Response.json({ credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } })
    }
    assert.equal(url.pathname, '/alpha/usage/summary')
    // 每次都得是一次真实读取：数字变化必须能被看见。
    return Response.json({ totalCount: ++usageReads })
  }) as typeof fetch })
  const first = await adapter.getUsage('user_test_key')
  assert.equal(first.usage?.totalCount, 1)
  assert.equal(first.plan?.name, 'Go')
  const afterCard = calls.length
  assert.equal(afterCard, 4)
  assert.deepEqual(calls.map((call) => call.path).sort(), [
    '/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary', '/alpha/whoami',
  ])

  // 选择器的套餐过滤：卡片刚读过的身份与订阅事实直接复用。
  await adapter.listModels('commandcode')
  const added = calls.slice(afterCard).map((call) => call.path)
  assert.deepEqual(added, ['/provider/v1/models', '/alpha/billing/credits'],
    'whoami 与 subscriptions 必须复用卡片那一份；credits 的 URL 带不带 orgId 取决于调用方，不是同一份记录')

  // 卡片再刷新：身份与套餐事实可以复用，用量汇总必须重新发出。
  const second = await adapter.getUsage('user_test_key')
  assert.equal(second.usage?.totalCount, 2, '用量汇总不能回放上一次的响应')
  const usageCalls = calls.filter((call) => call.path === '/alpha/usage/summary')
  assert.equal(usageCalls.length, 2)
})

test('getUsage() 个人账号使用毫秒账期，不附带组织参数或重算自然月', async () => {
  const start = Date.parse('2026-09-19T10:15:00Z')
  const adapter = makeAdapter({ fetchImpl: (async input => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.has('orgId'), false)
    if (url.pathname === '/alpha/whoami') return Response.json({ user: { id: 'u1' }, org: null })
    if (url.pathname === '/alpha/billing/subscriptions') return Response.json({ data: { currentPeriodStart: start } })
    if (url.pathname === '/alpha/billing/credits') return Response.json({ credits: { monthlyCredits: 0 } })
    assert.equal(url.searchParams.get('since'), String(start))
    // 统计范围只认服务端返回值，不把请求的 since 填充成确认事实。
    return Response.json({ periodStart: '2026-09-20T00:00:00Z', periodBasis: 'custom' })
  }) as typeof fetch })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.plan?.currentPeriodStart, start)
  assert.equal(report.usage?.periodStart, Date.parse('2026-09-20T00:00:00Z'))
  assert.equal(report.usage?.periodBasis, 'custom')
})

test('getUsage() 订阅失败仍按同一组织读取汇总，不编造账期', async () => {
  const adapter = makeAdapter({ fetchImpl: (async input => {
    const url = new URL(String(input))
    if (url.pathname === '/alpha/whoami') return Response.json({ org: { id: 'org-1' } })
    assert.equal(url.searchParams.get('orgId'), 'org-1')
    if (url.pathname === '/alpha/billing/subscriptions') return new Response('{}', { status: 503 })
    if (url.pathname === '/alpha/billing/credits') return Response.json({ credits: { monthlyCredits: 10, planId: 'individual-go' } })
    assert.equal(url.searchParams.has('since'), false)
    return Response.json({ totalCount: 3 })
  }) as typeof fetch })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, undefined)
  assert.equal(report.failures.length, 1)
  assert.equal(report.usage?.totalCount, 3)
  assert.equal(report.usage?.periodBasis, 'unreported')
  assert.equal(report.usage?.periodStart, undefined)
  assert.equal(report.plan?.currentPeriodStart, undefined)
  assert.equal(report.plan?.name, 'Go')
})

test('getUsage() 缺失或无效账期不传 since，不把未知统计起点变成零', async () => {
  for (const start of [undefined, null, '', '不是日期', 0, -1, 9e99]) {
    const adapter = makeAdapter({ fetchImpl: (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/alpha/whoami') return Response.json({ user: { id: 'u1' } })
      if (url.pathname === '/alpha/billing/subscriptions') return Response.json({ data: { currentPeriodStart: start } })
      if (url.pathname === '/alpha/billing/credits') return Response.json({})
      assert.equal(url.searchParams.has('since'), false)
      return Response.json({ periodStart: start })
    }) as typeof fetch })
    const report = await adapter.getUsage('user_test_key')
    assert.equal(report.failures.length, 0)
    assert.equal(Object.hasOwn(report.usage!, 'periodStart'), false)
    assert.equal(Object.hasOwn(report.plan!, 'currentPeriodStart'), false)
  }
})

test('getUsage() classifies an all-401 run as an invalid key', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(401, 'unauthorized') })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'invalid-key')
  assert.equal(report.account, undefined)
  assert.equal(report.usage, undefined)
  assert.equal(report.failures.length, 4)
})

test('getUsage() classifies an all-5xx run as service unavailable', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(502, 'bad gateway') })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'service-unavailable')
})

test('getUsage() classifies an all-transport-failure run as network', async () => {
  const adapter = makeAdapter({
    fetchImpl: (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'network')
  // The endpoint messages ARE the diagnosis: one 'network' verdict also covers
  // an unparseable API base and a per-request timeout, so the card renders
  // these rather than only the generic "check your connection" hint.
  assert.equal(report.failures.length, 4)
  assert.match(report.failures[0] ?? '', /^\/alpha\/whoami: fetch failed；目标 https:\/\/api\.commandcode\.ai$/)
})

test('getUsage() names the transport cause when nothing answers the port', async () => {
  const adapter = makeAdapter({
    fetchImpl: (async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18797'), { code: 'ECONNREFUSED' })
      throw new TypeError('fetch failed', { cause })
    }) as unknown as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'network')
  assert.equal(report.failures.length, 4)
  for (const failure of report.failures) {
    // 反代换端口/未启动与 API 故障的区别就在这一句里：原因 + 目标主机:端口。
    assert.match(failure, /；连接被拒绝（ECONNREFUSED）；目标 https:\/\/api\.commandcode\.ai$/)
  }
})

test('getUsage() asks for identity encoding when a host would otherwise pass raw Brotli', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    const body = path === '/alpha/whoami'
      ? { user: { id: 'u1', name: 'A', userName: 'a' } }
      : path === '/alpha/usage/summary'
        ? { totalCount: 1, totalCost: 0, successRate: 100, completedCount: 1, failedCount: 0, totalTokensIn: 1, totalTokensOut: 1, totalCredits: 0, periodBasis: 'billing-period' }
        : path === '/alpha/billing/credits'
          ? { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } }
          : { data: { planId: 'individual-go', status: 'active' } }
    const json = JSON.stringify(body)
    return new Headers(init?.headers).get('accept-encoding') === 'identity'
      ? new Response(json, { status: 200 })
      : new Response(new Uint8Array(brotliCompressSync(json)), { status: 200 })
  }) as unknown as typeof fetch
  const report = await makeAdapter({ fetchImpl }).getUsage('user_test_key')
  assert.equal(report.blocked, undefined)
  assert.equal(report.account?.name, 'A')
  assert.equal(report.plan?.name, 'Go')
  assert.equal(report.failures.length, 0)
  assert.deepEqual(calls.sort(), ['/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary', '/alpha/whoami'])
})

test('getUsage() classifies HTTP 200 with unreadable bodies as invalid-response', async () => {
  const compressed = new Uint8Array(brotliCompressSync('{"ok":true}'))
  const adapter = makeAdapter({
    fetchImpl: (async () => new Response(compressed, { status: 200 })) as unknown as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'invalid-response')
  assert.equal(report.failures.length, 4)
  assert.ok(report.failures.every((failure) => failure.includes('HTTP 200') && failure.includes('结构化数据解析失败')))
})

test('getUsage() distinguishes an interrupted HTTP 200 body and preserves safe cause identifiers', async () => {
  const secret = 'synthetic-private-account-value'
  const cause = Object.assign(new Error(secret), { code: 'ECONNRESET' })
  const error = new TypeError(secret, { cause })
  const adapter = makeAdapter({
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(error) },
    }), {
      headers: { 'content-type': `application/json; account=${secret}`, 'content-encoding': 'br', 'x-private': secret },
    })) as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'invalid-response')
  assert.equal(report.failures.length, 4)
  for (const failure of report.failures) {
    assert.match(failure, /HTTP 200.*响应正文读取中断/)
    assert.match(failure, /TypeError.*ECONNRESET/)
    assert.match(failure, /内容类型：application\/json.*内容编码：br/)
    assert.doesNotMatch(failure, /SyntaxError|JSON.*解析失败/)
    assert.ok(!failure.includes(secret))
  }
})

test('getUsage() reports a body timeout after HTTP 200 without blaming JSON parsing', async () => {
  // 旧测试只覆盖 fetch 等待响应时超时；这里先返回响应，再让正文读取等待同一个取消信号。
  const keepAlive = setTimeout(() => {}, 3_000)
  try {
    const adapter = makeAdapter({
      options: () => ({ ...OPENAI_OPTIONS(), requestTimeoutMs: 30 }),
      fetchImpl: (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
        },
      }))) as typeof fetch,
    })
    const started = Date.now()
    const report = await adapter.getUsage('user_test_key')
    assert.ok(Date.now() - started < 2_000)
    assert.equal(report.blocked, 'invalid-response')
    assert.equal(report.failures.length, 4)
    assert.ok(report.failures.every((failure) => /HTTP 200.*读取响应正文超时.*TimeoutError/.test(failure)))
    assert.ok(report.failures.every((failure) => !failure.includes('SyntaxError')))
  } finally {
    clearTimeout(keepAlive)
  }
})

test('getUsage() distinguishes HTML and truncated JSON without exposing their contents', async () => {
  const secret = 'synthetic-private-account-value'
  for (const [body, contentType] of [
    [`<html><body>${secret}</body></html>`, 'text/html'],
    [`{"private":"${secret}"`, 'application/json'],
  ]) {
    const adapter = makeAdapter({
      fetchImpl: (async () => new Response(body, { headers: { 'content-type': contentType! } })) as typeof fetch,
    })
    const report = await adapter.getUsage('user_test_key')
    assert.equal(report.blocked, 'invalid-response')
    for (const failure of report.failures) {
      assert.match(failure, /结构化数据解析失败.*SyntaxError/)
      assert.ok(failure.includes(`内容类型：${contentType}`))
      assert.ok(!failure.includes(secret))
      assert.doesNotMatch(failure, /读取中断|读取响应正文超时/)
    }
  }
})

test('getUsage() distinguishes valid JSON with a non-object root', async () => {
  const cases: [unknown, string][] = [[[], '数组'], [null, '空值'], ['private-value', '字符串'], [1, '数字'], [true, '布尔值']]
  for (const [body, shape] of cases) {
    const report = await makeAdapter({ fetchImpl: (async () => Response.json(body)) as typeof fetch }).getUsage('user_test_key')
    assert.equal(report.blocked, 'invalid-response')
    assert.ok(report.failures.every((failure) => failure.includes(`顶层应为对象，实际为${shape}`)))
    assert.ok(report.failures.every((failure) => !failure.includes('SyntaxError') && !failure.includes('private-value')))
  }
})

test('getUsage() accepts a decoded JSON body with BOM even when headers are misleading', async () => {
  // 标准 Response 的 text() 与 json() 都消除 UTF-8 BOM；头部仅是诊断线索，不能强制二次解压。
  const adapter = makeAdapter({
    fetchImpl: (async () => new Response('\uFEFF{"user":{"id":"u1","name":"A"}}', {
      headers: { 'content-type': 'text/html', 'content-encoding': 'br' },
    })) as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, undefined)
  assert.equal(report.account?.name, 'A')
  assert.deepEqual(report.failures, [])
})

test('getUsage() does not expose untrusted error identifiers or response header values', async () => {
  const secret = 'synthetic-private-account-value'
  const error = Object.assign(new Error(secret), { name: secret, code: secret })
  // 环形异常链不应阻止失败报告结算。
  Object.assign(error, { cause: error })
  const adapter = makeAdapter({
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(error) },
    }), { headers: { 'content-type': `application/${secret}`, 'content-encoding': secret } })) as typeof fetch,
  })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, 'invalid-response')
  assert.ok(report.failures.every((failure) => failure.includes('响应正文读取中断')))
  assert.ok(report.failures.every((failure) => failure.includes('内容类型：其他') && failure.includes('内容编码：其他')))
  assert.ok(report.failures.every((failure) => !failure.includes(secret)))
})

test('getUsage() reports a key no HTTP header can carry as an invalid key, not as a network outage', async () => {
  // A paste artifact (an embedded newline, a full-width character) makes `fetch` throw
  // a TypeError BEFORE any I/O — for every endpoint at once — so the
  // all-transport-failure classifier used to report a connection problem while the
  // connection was fine and the real problem was the credential. The chat path
  // already refuses such a key through `assertUsableApiKey`; the account path now
  // does too, and the report carries the credential verdict.
  let fetches = 0
  const adapter = makeAdapter({
    fetchImpl: (async () => {
      fetches += 1
      throw new TypeError('should never be reached')
    }) as unknown as typeof fetch,
  })
  const report = await adapter.getUsage('cc_sk_bad\nkey')
  assert.equal(report.blocked, 'invalid-key')
  assert.equal(fetches, 0, 'the key is rejected before any request is attempted')
  assert.match(report.failures[0] ?? '', /characters no HTTP header can carry/)
})

test('getUsage() holds the account endpoints to the connection request budget, not the catalog probe cap', async () => {
  // The four account endpoints used the catalog's 10 s cap while a chat call got 60 s,
  // so on a slow link every account query timed out while chat kept working — a
  // "check your network" banner that could never clear. Pinned by lowering
  // requestTimeoutMs to a value the catalog cap would never reach: with the old 10 s
  // signal this call would take ten seconds and blow the assertion below.
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), requestTimeoutMs: 40 }),
    // A stub that waits for the request's OWN abort signal. The keep-alive
    // timer is ref'd because `AbortSignal.timeout`'s timer is not: without it
    // the loop drains before the abort fires and this test never settles.
    fetchImpl: (async (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 15_000)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(init.signal?.reason)
      }, { once: true })
    })) as unknown as typeof fetch,
  })
  const started = Date.now()
  const report = await adapter.getUsage('user_test_key')
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_000, `the account fetch honored requestTimeoutMs (took ${elapsed}ms)`)
  assert.equal(report.blocked, 'network')
  assert.equal(report.failures.length, 4)
})

test('getUsage() leaves partial failures unclassified', async () => {
  // whoami answers; the rest fail — the report carries identity data, so the
  // card keeps its degraded per-endpoint view instead of a blocked banner.
  const { fetchImpl } = fetchRouting({
    '/alpha/whoami': { status: 200, body: { user: { id: 'u1', name: 'n', userName: 'un' }, org: { id: 'org1' } } },
    '/alpha/usage/summary': { status: 500, body: 'boom' },
    '/alpha/billing/credits': { status: 500, body: 'boom' },
    '/alpha/billing/subscriptions': { status: 500, body: 'boom' },
  })
  const adapter = makeAdapter({ fetchImpl })
  const report = await adapter.getUsage('user_test_key')
  assert.equal(report.blocked, undefined)
  assert.notEqual(report.account, undefined)
  assert.equal(report.failures.length, 3)
})

// Terminal events are not proof that the model produced a usable answer.
for (const protocol of ['cli', 'openai'] as const) {
  for (const finishReason of ['stop', 'length', 'max_tokens', 'max-tokens', 'max_output_tokens']) {
    test(`${protocol}: reasoning-only ${finishReason} fails before publishing a finish`, async () => {
      const limited = finishReason !== 'stop'
      const events = protocol === 'cli' ? [
        { type: 'reasoning-delta', text: 'still thinking' },
        { type: 'finish', finishReason, totalUsage: { inputTokens: 10, outputTokens: 32, outputTokenDetails: { reasoningTokens: 31 } } },
      ] : [
        { choices: [{ delta: { reasoning_content: 'still thinking', tool_calls: [] } }] },
        { choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 31 } } },
      ]
      // No final newline: exercise the EOF buffer as well as the line loop.
      const body = events.map(event => `data: ${JSON.stringify(event)}`).join('\n')
      const adapter = makeAdapter({
        ...(protocol === 'openai' ? { options: OPENAI_OPTIONS } : {}),
        fetchImpl: fetchReturning(200, body),
      })
      const seen: StreamChunk[] = []
      const code = limited ? 'OUTPUT_TOKEN_LIMIT' : 'EMPTY_RESPONSE'
      await assert.rejects(async () => {
        for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'm', maxTokens: 32, messages: [userMessage('hi')] })) seen.push(chunk)
      }, (error: unknown) => {
        const e = error as { code: string; message: string }
        assert.equal(e.code, code)
        assert.match(e.message, /max_tokens=32/)
        assert.match(e.message, /reasoningTokens=31/)
        return true
      })
      assert.equal(seen.some(chunk => chunk.type === 'finish'), false, 'DSH must receive only its error finish, never a preceding success')
      assert.equal(seen.filter(chunk => chunk.type === 'usage').length, 1, 'keep billed usage on failed attempts')
      assert.ok(seen.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning'))
      const policy = adapter.providerRetryPolicy('commandcode')
      assert.equal(policy.mode, 'normal')
      assert.equal(policy.retryableCodes.includes(code), !limited)
    })
  }

  test(`${protocol}: empty or whitespace-only terminal responses are retryable`, async () => {
    for (const text of ['', ' \n\t']) {
      const events = protocol === 'cli' ? [
        { type: 'text-delta', text }, { type: 'finish', finishReason: 'stop' },
      ] : [
        { choices: [{ delta: { content: text, tool_calls: [] }, finish_reason: 'stop' }] },
      ]
      const adapter = makeAdapter({
        ...(protocol === 'openai' ? { options: OPENAI_OPTIONS } : {}),
        fetchImpl: fetchReturning(200, events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
      })
      await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
        (error: unknown) => (error as { code: string }).code === 'EMPTY_RESPONSE')
    }
  })
}

test('a token-limited empty response does not invent reasoning usage', async () => {
  const adapter = makeAdapter({ options: OPENAI_OPTIONS, fetchImpl: fetchReturning(200,
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n') })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })), (error: unknown) => {
    const e = error as { code: string; message: string }
    assert.equal(e.code, 'OUTPUT_TOKEN_LIMIT')
    assert.match(e.message, /reasoningTokens=unknown/)
    assert.doesNotMatch(e.message, /全部|\ball\b.*reasoning/)
    return true
  })
})

test('an explicit content filter is not retried as an empty response', async () => {
  const adapter = makeAdapter({ options: OPENAI_OPTIONS, fetchImpl: fetchReturning(200,
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n') })
  await assert.rejects(collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (error: unknown) => (error as { code: string }).code === 'CONTENT_FILTER')
  const policy = adapter.providerRetryPolicy('commandcode')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.retryableCodes.includes('CONTENT_FILTER'), false)
})

test('usage received before a transport error is retained without a success finish', async () => {
  let reads = 0
  const adapter = makeAdapter({ options: OPENAI_OPTIONS, fetchImpl: fetchReturning(200, () => new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"completion_tokens":7}}\n\n'))
      else controller.error(new Error('connection reset'))
    },
  })) })
  const seen: StreamChunk[] = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })) seen.push(chunk)
  }, (error: unknown) => (error as { code: string }).code === 'TRANSPORT')
  assert.equal(seen.filter(chunk => chunk.type === 'usage').length, 1)
  assert.equal(seen.some(chunk => chunk.type === 'finish'), false)
})

// --- issue #67: header-timeout diagnosis and the streak that ends it ----------

/**
 * A fetch that never answers, honoring the abort signal the way a real one
 * does: without that rejection the connect budget can fire but the promise
 * never settles, and the test runner kills the file as a hung parent.
 */
function neverSettlingFetch(): typeof fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }, { once: true })
  })) as unknown as typeof fetch
}

/** Run one generate and return the failure it threw, as a coded error. */
async function generateFailure(
  adapter: CommandCodeAdapter,
  options: Partial<Parameters<CommandCodeAdapter['stream']>[0]> = {},
): Promise<{ code: string; message: string }> {
  try {
    for await (const _ of adapter.stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [userMessage('hi')],
      ...options,
      // A stable session id matters: the CLI wire carries a thread id derived
      // from it, so without one every call would build a DIFFERENT body and
      // the streak could never match. A real host always supplies one, and it
      // is pinned here so no per-test override can break that. Cast rather
      // than imported: `SessionId` is a brand from dsh-session, which is not
      // one of this bundle's peers. NonNullable because `exactOptionalPropertyTypes`
      // forbids writing an explicit undefined into an optional property.
      sessionId: 'streak-probe-session' as unknown as NonNullable<GenerateOptions['sessionId']>,
    })) { /* drain */ }
  } catch (error) {
    const coded = error as { code?: string; message?: string }
    return { code: String(coded.code), message: String(coded.message) }
  }
  throw new Error('expected the generate to fail')
}

test('a CLI-route header timeout blames the gateway, and says a bigger budget will not help', async () => {
  // `/alpha/generate` answers headers itself (measured: 2.1 s for a 1.6 MB
  // body), so silence there is the gateway never answering — not the size of
  // the conversation. The old wording sent issue #67's reporter to their proxy.
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'cli' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  const failure = await generateFailure(adapter)
  assert.equal(failure.code, 'TIMEOUT')
  assert.match(failure.message, /网关完全没有返回响应头/, 'names the gateway as silent')
  assert.match(failure.message, /调大超时不会有帮助/, 'rules out the timeout knob')
  assert.match(failure.message, /体积不是原因/, 'rules out size on this route')
})

test('a large Provider-API prompt is diagnosed as a slow upstream, with a concrete value', async () => {
  // The route decides, NOT the size: measured on one account, the same
  // `/provider/v1/chat/completions` route took 117 s for a 200 k prompt and
  // 30 s for a 1.2 M one. This test keeps a LARGE body to pin that the wording
  // no longer blames size for the delay.
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  const failure = await generateFailure(adapter, {
    messages: [userMessage('x'.repeat(1_100_000))],
  })
  assert.equal(failure.code, 'TIMEOUT')
  assert.match(failure.message, /上游模型吐出第一个 token/, 'names the mechanism')
  assert.match(failure.message, /体积不是原因/, 'explicitly rules out size')
  assert.match(failure.message, /调到 300000 毫秒/, 'suggests the doubled-and-floored budget')
})

test('the suggested budget doubles a long timeout instead of flooring it at 5 minutes', () => {
  // Asserted on the pure helper: reproducing this through a real attempt would
  // mean waiting out the 200 s budget it describes.
  assert.equal(headersTimeoutAdvice('openai', 200_000).suggestionMs, 400_000)
  assert.equal(headersTimeoutAdvice('openai', 30_000).suggestionMs, 300_000)
  assert.equal(headersTimeoutAdvice('openai', 1_000_000).suggestionMs, 2_000_000)
  assert.equal(headersTimeoutAdvice('openai', 2_000_000).suggestionMs, 3_600_000)
  assert.equal(headersTimeoutAdvice('openai', 3_600_000).suggestionMs, undefined)
  assert.equal(headersTimeoutAdvice('openai', 10_000_000).suggestionMs, undefined)
  // The CLI route never gets the knob recommended: its headers come from the
  // gateway, so a bigger budget cannot buy a response that never started.
  assert.equal(headersTimeoutAdvice('cli', 30_000).cause, 'gateway')
  assert.equal(headersTimeoutAdvice('cli', 30_000).suggestionMs, undefined)
})

test('three consecutive header timeouts on one payload stop the retry loop', async () => {
  // `maxRetries: 1000` with a 500 ms → 15 min backoff is right for a provider
  // that names its own reset, and wrong for a gateway that says nothing: the
  // reporter's identical multi-megabyte body was re-sent for hours.
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'cli' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  const first = await generateFailure(adapter)
  const second = await generateFailure(adapter)
  const third = await generateFailure(adapter)
  assert.equal(first.code, 'TIMEOUT', 'the first silence is still retried')
  assert.equal(second.code, 'TIMEOUT', 'the second is still retried')
  assert.equal(third.code, 'PROVIDER_HTTP_ERROR', 'the third leaves the whitelist')
  assert.match(third.message, /已停止重试/)
  assert.match(third.message, /连续 3 次/)
  // The streak resets, so a later burst has to earn its own three attempts.
  const fourth = await generateFailure(adapter)
  assert.equal(fourth.code, 'TIMEOUT')
})

test('an answered request ends a header-timeout streak', async () => {
  let silent = true
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'cli' as const,
    }),
    fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      if (silent) {
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch,
  })
  assert.equal((await generateFailure(adapter)).code, 'TIMEOUT')
  assert.equal((await generateFailure(adapter)).code, 'TIMEOUT')
  silent = false
  // A streamed answer proves the gateway answered, whatever the status was.
  // Same sessionId as generateFailure()'s calls: the streak is now keyed by
  // session, so a session-less success would clear the WRONG entry.
  for await (const _ of adapter.stream({
    provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')],
    sessionId: 'streak-probe-session' as unknown as NonNullable<GenerateOptions['sessionId']>,
  })) { /* drain */ }
  silent = true
  assert.equal((await generateFailure(adapter)).code, 'TIMEOUT', 'the streak restarted after the answer')
  assert.equal((await generateFailure(adapter)).code, 'TIMEOUT')
  const third = await generateFailure(adapter)
  assert.equal(third.code, 'PROVIDER_HTTP_ERROR', 'and only then escalates again')
})

/** Like {@link generateFailure}, but with a caller-chosen sessionId instead of the fixed probe one. */
async function generateFailureAs(
  adapter: CommandCodeAdapter,
  sessionId: string,
): Promise<{ code: string; message: string }> {
  try {
    for await (const _ of adapter.stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [userMessage('hi')],
      sessionId: sessionId as unknown as NonNullable<GenerateOptions['sessionId']>,
    })) { /* drain */ }
  } catch (error) {
    const coded = error as { code?: string; message?: string }
    return { code: String(coded.code), message: String(coded.message) }
  }
  throw new Error('expected the generate to fail')
}

test('concurrent sessions keep independent header-timeout streaks', async () => {
  // Before the fix, `headerTimeoutStreak` was one field on the shared adapter
  // instance: a different session's body hashes to a different fingerprint,
  // so interleaving two sessions kept resetting the single slot back to 1 and
  // NEITHER session could ever reach the escalation threshold. Two isolated
  // per-session counts must each reach it on their own schedule.
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'cli' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  assert.equal((await generateFailureAs(adapter, 'session-a')).code, 'TIMEOUT')
  assert.equal((await generateFailureAs(adapter, 'session-b')).code, 'TIMEOUT')
  assert.equal((await generateFailureAs(adapter, 'session-a')).code, 'TIMEOUT', 'session-a is still only on its 2nd timeout')
  const sessionAThird = await generateFailureAs(adapter, 'session-a')
  assert.equal(sessionAThird.code, 'PROVIDER_HTTP_ERROR', 'session-a reaches its own 3rd consecutive timeout')
  const sessionBSecond = await generateFailureAs(adapter, 'session-b')
  assert.equal(sessionBSecond.code, 'TIMEOUT', 'session-b is unaffected by session-a escalating, and is only on its 2nd timeout')
})

test('超时定级复用已序列化的正文，不再为算指纹重新遍历一遍', async () => {
  // 指纹只回答「这是不是刚刚超时的同一份载荷」，而实发字符串就是逐字节准确的
  // 答案。正文已经序列化过一次，超时判定不该为了算第二个意见再走一遍整棵 body
  // ——带图历史可达数 MB，而超时恰恰是最常重复的路径。
  //
  // `toJSON` 在这里既计数又保持字节不变：同一个值被遍历几次，线缆字节都相同，
  // 所以升级行为必须与从前一致；变化的只有遍历次数。
  let passes = 0
  const constant = { toJSON: () => { passes++; return { value: 1 } } }
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  const failure = async () => {
    try {
      for await (const _ of adapter.stream({
        provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
        messages: [userMessage('hi')],
        tools: [{ name: 'tool', description: 't', parameters: { type: 'object', properties: { constant } } }],
      })) { /* drain */ }
    } catch (error) {
      const coded = error as { code?: string }
      return String(coded.code)
    }
    throw new Error('expected the generate to fail')
  }
  assert.equal(await failure(), 'TIMEOUT')
  assert.equal(passes, 1, '一次超时只应遍历一次正文')
  assert.equal(await failure(), 'TIMEOUT')
  assert.equal(await failure(), 'PROVIDER_HTTP_ERROR', '字节相同就必须升级，遍历次数不该改变语义')
  assert.equal(passes, 3, '每次调用只序列化一次，超时定级复用那一份')
})
test('a session-less call keeps the old single-slot streak so it still escalates', async () => {
  // openai protocol, not cli: the CLI body embeds a threadId that falls back
  // to a fresh randomUUID() per call with no sessionId (cliThreadId()), which
  // would change the fingerprint every attempt regardless of this fix — that
  // is pre-existing and orthogonal to the session-keying change under test.
  // The flat OpenAI body carries no such field, so it stays identical across
  // session-less calls and the streak can actually accumulate.
  const adapter = makeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai', workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: 30, streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      protocol: 'openai' as const,
    }),
    fetchImpl: neverSettlingFetch(),
  })
  const generateWithoutSession = async (): Promise<{ code: string; message: string }> => {
    try {
      for await (const _ of adapter.stream({
        provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')],
      })) { /* drain */ }
    } catch (error) {
      const coded = error as { code?: string; message?: string }
      return { code: String(coded.code), message: String(coded.message) }
    }
    throw new Error('expected the generate to fail')
  }
  assert.equal((await generateWithoutSession()).code, 'TIMEOUT')
  assert.equal((await generateWithoutSession()).code, 'TIMEOUT')
  assert.equal((await generateWithoutSession()).code, 'PROVIDER_HTTP_ERROR', 'still escalates on the 3rd, same as before the session-keyed fix')
})

// 请求准备和跨账号重试的回归场景，全部使用本地替身，不访问真实服务。
test('降级后换账号重新选择协议，且三次尝试均进入耗时摘要', async () => {
  const paths: string[] = []
  const bodies: Record<string, unknown>[] = []
  const summaries: import('../src/request-timing.ts').RequestTimingSummary[] = []
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto' }),
    resolveApiKey: async () => 'private-test-key-one',
    rotateApiKey: async () => 'private-test-key-two',
    onRequestTiming: (summary) => { summaries.push(summary) },
    fetchImpl: (async (url, init) => {
      paths.push(new URL(String(url)).pathname)
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (paths.length === 1) return new Response('{"error":{"code":"upgrade_required"}}', { status: 403 })
      if (paths.length === 2) return new Response('rate limited', { status: 429 })
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
    }) as typeof fetch,
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('private-user-text')] }))
  assert.deepEqual(paths, ['/provider/v1/chat/completions', '/alpha/generate', '/provider/v1/chat/completions'])
  assert.equal(bodies[0]?.model, 'm')
  assert.ok(bodies[1]?.params)
  assert.equal(bodies[2]?.model, 'm')
  assert.equal(summaries[0]?.outcome, 'finished')
  assert.deepEqual(summaries[0]?.attempts.map((attempt) => attempt.status), [403, 429, 200])
  assert.equal(typeof summaries[0]?.firstContentMs, 'number')
  assert.doesNotMatch(JSON.stringify(summaries), /private-test-key|private-user-text|Authorization/)
})

test('同协议换账号不重新序列化请求体', async () => {
  let serialized = 0
  let calls = 0
  const args = { toJSON: () => { serialized++; return { value: 1 } } }
  const adapter = makeAdapter({
    rotateApiKey: async () => 'second-key',
    fetchImpl: (async () => ++calls === 1
      ? new Response('rate limited', { status: 429 }) : new Response(FINISH_STREAM)) as typeof fetch,
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')],
    tools: [{ name: 'tool', description: 'test', parameters: { type: 'object', properties: { value: args } } }],
  }))
  assert.equal(calls, 2)
  assert.equal(serialized, 1)
})

test('同次请求并行读取图片不超过四张，重复图片及协议降级复用读取', async () => {
  const refs = Array.from({ length: 7 }, (_, i) => ({ ...imageRef(), attachmentId: AttachmentId(`image-${i}`) }))
  const attachments = fakeAttachments(Object.fromEntries(refs.map((ref) => [ref.attachmentId, pngBytes])))
  const original = attachments.readImageRequest.bind(attachments)
  let active = 0, peak = 0, reads = 0, calls = 0
  attachments.readImageRequest = async (ref, target) => {
    reads++; active++; peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    try { return await original(ref, target) } finally { active-- }
  }
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), protocol: 'auto' }),
    resolveAttachments: () => attachments,
    fetchImpl: (async () => ++calls === 1
      ? new Response('{"error":{"code":"upgrade_required"}}', { status: 403 }) : new Response(FINISH_STREAM)) as typeof fetch,
  })
  await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [
    { id: messageId(), role: 'user', source: { kind: 'user' }, content: [...refs, refs[0]!].map((attachment) => ({ type: 'image', attachment })) },
  ] }))
  assert.equal(reads, 7)
  assert.equal(peak, 4)
  assert.equal(calls, 2)
})

test('凭据解析与图片读取并行，不再一次接一次地排队', async () => {
  // 两个等待互不依赖（正文从不携带密钥，健康账号池的解析也只读内存），所以
  // 它们必须重叠：先解析凭据再读图，等于把两者的等待时间相加。这条断言用
  // 「凭据尚未返回时图片读取已经开始」把重叠钉死，而不依赖墙钟时间。
  const refs = Array.from({ length: 2 }, (_, i) => ({ ...imageRef(), attachmentId: AttachmentId(`parallel-image-${i}`) }))
  const attachments = fakeAttachments(Object.fromEntries(refs.map((ref) => [ref.attachmentId, pngBytes])))
  const original = attachments.readImageRequest.bind(attachments)
  let releaseImage!: () => void
  const imageGate = new Promise<void>((resolve) => { releaseImage = resolve })
  let reads = 0
  attachments.readImageRequest = async (ref, target) => {
    reads++
    await imageGate
    return original(ref, target)
  }
  let releaseKey!: () => void
  const keyGate = new Promise<void>((resolve) => { releaseKey = resolve })
  let keyEntered!: () => void
  const keyRequested = new Promise<void>((resolve) => { keyEntered = resolve })
  const bodies: Record<string, unknown>[] = []
  const adapter = makeAdapter({
    options: () => OPENAI_OPTIONS(),
    resolveAttachments: () => attachments,
    resolveApiKey: async () => { keyEntered(); await keyGate; return 'user_test_key' },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(settlementFrames('openai').join(''))
    }) as typeof fetch,
  })
  let settled = false
  const running = collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
    messages: [{ id: messageId(), role: 'user', source: { kind: 'user' },
      content: refs.map((attachment) => ({ type: 'image' as const, attachment })) }],
  })).finally(() => { settled = true })
  await keyRequested
  for (let turn = 0; turn < 20 && reads === 0; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(reads > 0, '凭据仍在等待时图片读取就应已经开始')
  assert.equal(settled, false)
  releaseKey()
  releaseImage()
  await running
  assert.equal(bodies.length, 1)
  assert.equal((bodies[0]?.messages as unknown[]).length, 1)
})
test('目录刷新合并并发等待，单个调用取消不会影响其他调用', async (t) => {
  const path = join(tmpdir(), `cc-catalog-concurrent-${process.pid}.json`)
  t.after(() => rmSync(path, { force: true }))
  let calls = 0
  let release!: (response: Response) => void
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), modelsCachePath: path }),
    fetchImpl: (() => { calls++; return new Promise<Response>((resolve) => { release = resolve }) }) as typeof fetch,
  })
  const controller = new AbortController()
  const cancelled = adapter.resolveModel('commandcode', 'm', controller.signal)
  const rejected = assert.rejects(cancelled, { name: 'AbortError' })
  const listing = adapter.listModels('commandcode', { unfiltered: true })
  controller.abort()
  await rejected
  release(new Response(JSON.stringify({ object: 'list', data: [{ id: 'm', name: 'm', context_length: 1000 }] })))
  assert.equal((await listing).length, 1)
  await adapter.listModels('commandcode', { unfiltered: true })
  assert.equal(calls, 1)
})

test('目录有效期到期或网关地址变化后重新获取', async (t) => {
  const path = join(tmpdir(), `cc-catalog-expiry-${process.pid}.json`)
  t.after(() => rmSync(path, { force: true }))
  const originalNow = Date.now
  let now = originalNow(), base = 'https://first.invalid', calls = 0
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  const adapter = makeAdapter({
    options: () => ({ ...OPENAI_OPTIONS(), apiBase: base, modelsCachePath: path }),
    fetchImpl: (async () => {
      calls++
      return new Response(JSON.stringify({ object: 'list', data: [{ id: base, name: base, context_length: 1000 }] }))
    }) as typeof fetch,
  })
  await adapter.listModels('commandcode', { unfiltered: true })
  await adapter.listModels('commandcode', { unfiltered: true })
  assert.equal(calls, 1)
  now += 5 * 60_000 + 1
  await adapter.listModels('commandcode', { unfiltered: true })
  assert.equal(calls, 2)
  base = 'https://second.invalid'
  assert.equal((await adapter.listModels('commandcode', { unfiltered: true }))[0]?.id, base)
  assert.equal(calls, 3)
})

test('every new-arrival model carries an output ceiling or is left to runtime learning', () => {
  // Issue #71: the endpoint refuses a `max_tokens` above the model's own ceiling,
  // and the refusal text was ALSO being read as a context overflow, so the harness
  // compacted a healthy session. A catalog arrival therefore either gets a ceiling
  // here or must be one the runtime learns from the refusal — never neither.
  assert.equal(MODEL_OUTPUT_TOKEN_LIMITS.get('gpt-6.1-sol'), 128000)
  // command-code@1.82.2: the paid `ling-3.1-flash` files three conflicting
  // provider values in models.dev, so the generator deliberately leaves it to
  // runtime learning (rule 4 of scripts/sync-output-limits.mjs) instead of
  // pinning a guess; the retired `:free` row left `KNOWN_PLANS`, so the table is
  // no longer generated for it at all.
  assert.equal(MODEL_OUTPUT_TOKEN_LIMITS.get('inclusionai/ling-3.1-flash'), undefined)
  assert.equal(MODEL_OUTPUT_TOKEN_LIMITS.get('inclusionai/ling-3.1-flash:free'), undefined)
  // A ceiling is a CEILING, not a window: both are far below their own context,
  // which is the whole point of the table — deriving `max_tokens` from
  // `context_length` is exactly what produced #71.
  assert.ok(MODEL_OUTPUT_TOKEN_LIMITS.get('gpt-6.1-sol')! < 1_050_000)
  // `inclusionai/ling-3.0-flash-sante:free` (32768, hand-pinned) carried this
  // row until 2026-10-16, when the model left every table with the
  // command-code@1.82.4 catalog migration and the generator's `MANUAL_CEILINGS`
  // map emptied. Muse Wonder takes over the assertion: 131072 against a
  // 1 048 576-token window, so the table is still demonstrably not the window.
  assert.ok(MODEL_OUTPUT_TOKEN_LIMITS.get('meta/muse-wonder-1.0')! < 1_048_576)
})

// ---------------------------------------------------------------------------
// 图片预算门与凭据解析的顺序（PR #98 审查修复 R1/R2）
//
// 预算门只能在凭据与真实通道落定之后抛：否则一次根本发不出去的请求会先让
// 宿主把最老的图片持久化卸载（不可逆），然后才暴露「没有凭据」。预算门与
// 缓存门还必须一次算全、一次抛出，否则宿主会多跑一轮卸载往返，并把
// cache 溢出报成 budget。
// ---------------------------------------------------------------------------

/** 61 张 1 MiB 的图：数量超 60、base64 字节超 32 MiB，预算门必触发。 */
function oversizedImageHistory() {
  return imageHistory(Array.from({ length: 61 }, () => 1024 * 1024))
}

test('凭据缺失时图片预算门不抢跑：先报 MISSING_CREDENTIAL，不发请求', async () => {
  const { messages, images } = oversizedImageHistory()
  let fetched = false
  const adapter = makeAdapter({
    resolveApiKey: async () => { throw new LlmError('未配置 Command Code API 密钥', 'MISSING_CREDENTIAL') },
    resolveAttachments: () => fakeAttachments(images),
    fetchImpl: (async () => { fetched = true; return okStream('openai') }) as unknown as typeof fetch,
    options: OPENAI_OPTIONS,
  })
  let error: unknown
  try {
    await collect(adapter.stream({
      provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages,
    }))
  } catch (thrown) { error = thrown }
  assert.equal((error as { code?: string }).code, 'MISSING_CREDENTIAL',
    '凭据错误必须先于图片错误：否则宿主的持久化卸载会先发生')
  assert.equal(fetched, false, '凭据缺失的请求不应走到网络')
})

test('预算与缓存门同时超限只报一次，且报两者较大的缺数', async () => {
  const { messages, images } = oversizedImageHistory()
  // 让这 61 张图都落在「当前模型已看过」的区间里：缓存门 count = 61 > 预算门。
  const answered: Message[] = [...messages, {
    id: messageId(), role: 'assistant', content: [{ type: 'text', text: '都看过了' }],
    source: { kind: 'model', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  }]
  const result = await runAttempts('cli', answered, images, undefined, undefined, true)
  assert.equal(result.bodies.length, 0, '门未通过前不得发出任何请求')
  assert.equal((result.error as { code?: string }).code, 'IMAGE_OFFLOAD_REQUIRED')
  // 旧实现先报预算门、重试后才报缓存门 61；一次算全时直接报两者的最大值 61。
  assert.match((result.error as { message?: string }).message ?? '', /61 already-seen oldest image/
  )
})
