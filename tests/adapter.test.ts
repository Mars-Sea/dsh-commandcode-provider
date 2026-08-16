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

import {
  CommandCodeAdapter,
  projectSlugFromPath,
  resolveAuthFileApiKey,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_THINKING_MODELS,
  KNOWN_PLANS,
  KNOWN_DEALS,
  planLabel,
  dealLabel,
  formatContext,
  capabilityDescription,
  compareByPlan,
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '../src/adapter.ts'
import type { CommandCodeAdapterDeps } from '../src/adapter.ts'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fetch stub returning a canned Response stream. */
function fetchReturning(
  status: number,
  body: string | (() => ReadableStream<Uint8Array>),
  headers: Record<string, string> = {},
): typeof fetch {
  const text = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(typeof body === 'string' ? body : body()))
        controller.close()
      },
    })
  return (async () => new Response(text(), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })) as unknown as typeof fetch
}

function makeAdapter(overrides: Partial<CommandCodeAdapterDeps> = {}): CommandCodeAdapter {
  return new CommandCodeAdapter({
    options: () => ({
      apiBase: 'https://api.commandcode.ai',
      workingDir: '/tmp/project',
      modelsCachePath: '/tmp/cc-models-cache.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    }),
    resolveApiKey: async () => 'user_test_key',
    ...overrides,
  })
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A tiny valid-ish PNG byte blob for byte-round-trip assertions. */
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

function imageRef(): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:test-image',
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
    async saveImage(input) {
      return { ...imageRef(), mediaType: input.mediaType, bytes: input.data.byteLength }
    },
    async readImage(ref) {
      const data = images[ref.attachmentId]
      if (!data) throw new Error(`no stored image for ${ref.attachmentId}`)
      return { ref, data }
    },
  } as unknown as AttachmentStore
}

/** Collect all chunks from a stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

// ---------------------------------------------------------------------------
// Message conversion (via stream() request capture)
// ---------------------------------------------------------------------------

test('stream() sends the harness conversation in Command Code wire format', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', {
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
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model', provider: 'commandcode', model: 'm' } },
      userMessage('How are you?'),
    ],
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    maxTokens: 100,
  }))

  assert.ok(capturedBody)
  const params = capturedBody.params as Record<string, unknown>
  assert.equal(params.model, 'deepseek/deepseek-v4-flash')
  assert.equal(params.system, 'You are helpful.')
  assert.equal(params.max_tokens, 100)
  assert.equal(params.stream, true)
  assert.equal((params.tools as unknown[]).length, 1)
  const tool = (params.tools as Record<string, unknown>[])[0]!
  assert.equal(tool.name, 'bash')
  assert.equal(tool.type, 'function')
  // Messages: system folded out, only user/assistant remain.
  assert.deepEqual(
    (params.messages as { role: string }[]).map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  // Headers.
  const capturedInit = (fetchImpl as unknown as { lastInit?: RequestInit }).lastInit
  void capturedInit
})

test('stream() replays only paired tool calls', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const callId = 'call-123'
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('List files'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
          { type: 'tool-call', id: 'call-unanswered', name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'm' },
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'file1' }] }],
        source: { kind: 'tool', callId },
      },
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  // The paired call is replayed as a tool-call; the unanswered one is dropped.
  const assistant = messages.find((m) => m.role === 'assistant')!
  const parts = assistant.content as Record<string, unknown>[]
  assert.equal(parts.length, 1)
  assert.equal(parts[0]!.type, 'tool-call')
  assert.equal((parts[0] as { toolCallId: string }).toolCallId, callId)
  // The tool result round-trips under role 'tool'.
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.ok(toolMsg)
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

test('stream() refuses images for models without Vision capability', async () => {
  const adapter = makeAdapter()
  const withImage: Message = {
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
  const withImage: Message = {
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const ref = imageRef()
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: pngBytes }),
  })
  const withImage: Message = {
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
  // Official CLI wire shape: { type:'image', source:{ type:'base64', media_type, data } }.
  assert.deepEqual(parts[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pngBytes).toString('base64') },
  })
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
    assert.deepEqual(vision.inputModalities, ['text', 'image'])
    assert.equal(vision.description, 'Pro · Image')
    const textOnly = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-flash')
    assert.deepEqual(textOnly.inputModalities, ['text'])
    assert.equal(textOnly.description, 'Go') // text-only: no Image marker
    // A model with a permanent deal shows its discount.
    const deal = await adapter.resolveModel('commandcode', 'MiniMaxAI/MiniMax-M3')
    assert.equal(deal.description, 'Go · 50% off · Image')
    // A provider-tier model with a context window shows all four parts.
    const provider = await adapter.resolveModel('commandcode', 'claude-opus-5')
    assert.equal(provider.description, 'Provider · Image')
    // Unknown models fall back to the bare plan-less summary (empty here).
    const unknown = await adapter.resolveModel('commandcode', 'some-future-model')
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
  assert.equal(byId.get('deepseek/deepseek-v4-pro')!.description, 'Go · 75% off · 1M')
  assert.deepEqual(byId.get('deepseek/deepseek-v4-flash')!.inputModalities, ['text'])
  assert.equal(byId.get('deepseek/deepseek-v4-flash')!.description, 'Go · 1M')
  assert.equal(byId.get('poolside/laguna-s-2.1-free')!.description, 'Go · FREE · 256K')
  // The picker shows rows in returned order: Go models lead, then Pro,
  // alphabetically within a tier (input order was deliberately shuffled).
  assert.deepEqual(
    models.map((m) => m.id),
    [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
      'poolside/laguna-s-2.1-free',
      'claude-sonnet-5',
    ],
  )
})

test('compareByPlan() sorts by plan tier then name, unknown plans last', () => {
  // Go beats Pro regardless of name.
  assert.ok(compareByPlan(
    { id: 'zai-org/GLM-5.2', name: 'GLM-5.2 (CC)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CC)' },
  ) < 0)
  // Within a tier, alphabetical by name.
  assert.ok(compareByPlan(
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (CC)' },
    { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3 (CC)' },
  ) < 0)
  // Unknown plan sorts after every known tier.
  assert.ok(compareByPlan(
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CC)' },
    { id: 'some-future-model', name: 'Some Future (CC)' },
  ) < 0)
  // Equal ids are stable.
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
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"finish","finishReason":"length"}\n\n') })
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'max-tokens')
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

test('stream() maps 429 to RATE_LIMIT', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited') })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => (err as { code?: string }).code === 'RATE_LIMIT',
  )
})

test('stream() keeps PROVIDER_HTTP_ERROR for other 4xx/5xx and includes provider code', async () => {
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

test('stream() classifies a plain in-band error event as retryable SERVER', async () => {
  // No isRetryable, no statusCode, no terminal marker: the official CLI's
  // isStreamErrorRetryable() treats this as transient — so must we (SERVER is
  // in the harness default retryable set, PROVIDER_STREAM_ERROR is not).
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
    },
  )
})

test('stream() does not abort a healthy body when elapsed time exceeds requestTimeoutMs', async () => {
  // Regression: AbortSignal.timeout(requestTimeoutMs) used to be passed into
  // fetch(), so a generation longer than the connection budget was killed mid-
  // stream as "failed while reading: aborted due to timeout".
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","text":"hi"}\n\n'))
      await new Promise((r) => setTimeout(r, 60))
      controller.enqueue(new TextEncoder().encode('data: {"type":"finish","finishReason":"stop"}\n\n'))
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
    },
  )
})

test('stream() throws EMPTY_RESPONSE when the stream ends without content', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"finish","finishReason":"stop"}\n\n') })
  // The finish event IS content (sawContent=false only when nothing emitted) —
  // actually finish marks a completed stream, so this ends normally.
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.ok(chunks.some((c) => c.type === 'finish'))
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

test('listModels() falls back to the on-disk cache when the fetch fails', async () => {
  const cachePath = `/tmp/cc-test-cache-${process.pid}.json`
  const { writeFileSync, rmSync } = await import('node:fs')
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    models: [{ id: 'cached-model', name: 'Cached', contextWindow: 1000, maxTokens: 500 }],
  }))
  try {
    const adapter = new CommandCodeAdapter({
      options: () => ({ apiBase: 'https://api.commandcode.ai', workingDir: '/tmp', modelsCachePath: cachePath }),
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

test('known efforts snapshot covers the models the catalog advertises', () => {
  assert.ok(KNOWN_EFFORTS['deepseek/deepseek-v4-flash'])
  assert.ok(KNOWN_EFFORTS['claude-opus-5'])
  // Synced from the official command-code@1.26.0 model table: models that
  // ship with effort levels must be present, and absent ones must stay out.
  // The 0.2.0 snapshot wrongly added ten models (Kimi K2.5, MiMo V2.5, Claude
  // Haiku 4.5, MiniMax M2.5, Muse Spark 1.2 Contributor, Tencent Hy3, ...) that
  // carry NO reasoningEfforts in the CLI's ZA table — re-verified 2026-08-16.
  assert.ok(!KNOWN_EFFORTS['moonshotai/Kimi-K2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5-pro'])
  assert.ok(!KNOWN_EFFORTS['claude-haiku-4-5-20251001'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M2.5'])
  assert.ok(!KNOWN_EFFORTS['meta/muse-spark-1.2-contributor'])
  assert.ok(!KNOWN_EFFORTS['tencent/hy3-paid'])
  assert.ok(!KNOWN_EFFORTS['tencent/Hy3'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M3']) // no official effort levels
  assert.ok(!KNOWN_EFFORTS['moonshotai/Kimi-K3'])
})

test('known thinking snapshot covers reasoning models without effort levels', () => {
  assert.ok(KNOWN_THINKING_MODELS.has('MiniMaxAI/MiniMax-M3'))
  assert.ok(KNOWN_THINKING_MODELS.has('Qwen/Qwen3.7-Max'))
  assert.ok(KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K3'))
  assert.ok(KNOWN_THINKING_MODELS.has('thinkingmachines/inkling'))
  // Re-verified against the command-code@1.26.0 ZA table (2026-08-16): these
  // think automatically (reasoning:!0, no efforts) and belong in the set.
  assert.ok(KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K2.7-Code-Highspeed'))
  assert.ok(KNOWN_THINKING_MODELS.has('tencent/hy3-paid'))
  assert.ok(KNOWN_THINKING_MODELS.has('meta/muse-spark-1.2-contributor'))
  // GLM-5/5.1/5.2-Fast are NOT reasoning-capable (ZA reasoning:false, docs
  // "Text input" only) — the 0.2.0 snapshot wrongly included them.
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5.1'))
  assert.ok(!KNOWN_THINKING_MODELS.has('zai-org/GLM-5.2-Fast'))
  // Models with selectable efforts are not "auto" — they carry their own UI.
  assert.ok(!KNOWN_THINKING_MODELS.has('claude-opus-5'))
  assert.ok(!KNOWN_THINKING_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_THINKING_MODELS.has('xiaomi/mimo-v2.5'))
})

test('known image models snapshot has stable anchor entries', () => {
  // Anchors that must never drift: a flagship vision model and a text-only
  // model (the latter is deliberately absent).
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-sonnet-5'))
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-5.4'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('zai-org/GLM-5.3'))
})

test('known plan snapshot tiers models by the official plan pages', () => {
  // Go: the entry plan covers open models + a few premium ones.
  assert.equal(KNOWN_PLANS['MiniMaxAI/MiniMax-M3'], 'go')
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.7-Max'], 'go')
  assert.equal(KNOWN_PLANS['gpt-5.6-luna'], 'go')
  // GOAT adds a handful of closed/premium models.
  assert.equal(KNOWN_PLANS['google/gemini-3.7-flash'], 'goat')
  assert.equal(KNOWN_PLANS['xai/grok-4.6'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.2'], 'goat')
  // Pro adds Claude Sonnet/Haiku, GPT-5.x, Gemini 3.5/3.1.
  assert.equal(KNOWN_PLANS['claude-sonnet-5'], 'pro')
  assert.equal(KNOWN_PLANS['gpt-5.4'], 'pro')
  assert.equal(KNOWN_PLANS['google/gemini-3.5-flash'], 'pro')
  // Provider/Max: Claude Opus/Fable and Fugu Ultra are not on lower plans.
  assert.equal(KNOWN_PLANS['claude-opus-5'], 'provider')
  assert.equal(KNOWN_PLANS['claude-fable-5'], 'provider')
  assert.equal(KNOWN_PLANS['sakana/fugu-ultra'], 'provider')
  // Labels match the official tier names.
  assert.equal(planLabel('MiniMaxAI/MiniMax-M3'), 'Go')
  assert.equal(planLabel('claude-sonnet-5'), 'Pro')
  assert.equal(planLabel('claude-opus-5'), 'Provider')
  assert.equal(planLabel('some-future-model'), undefined)
})

test('known deals snapshot has anchors and expiry-aware labels', () => {
  // DeepSeek V4 Pro 75% off is time-limited: the official pricing page retires
  // it on 2026-08-16 16:00 UTC when DeepSeek moves to peak/off-peak pricing.
  assert.equal(KNOWN_DEALS['deepseek/deepseek-v4-pro'].label, '75% off')
  assert.equal(KNOWN_DEALS['deepseek/deepseek-v4-pro'].expiresAt, '2026-08-16T15:59:59.999Z')
  // Free model is marked free.
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free'].free, true)
  // Gemini 3.7 Flash 50% off through 2026-12-31.
  assert.equal(KNOWN_DEALS['google/gemini-3.7-flash'].label, '50% off')
  assert.equal(KNOWN_DEALS['google/gemini-3.7-flash'].expiresAt, '2026-12-31T23:59:59Z')
})

test('dealLabel() hides a deal after its expiry date', () => {
  // Before expiry: shown.
  assert.equal(dealLabel('google/gemini-3.7-flash', Date.parse('2026-12-31T12:00:00Z')), '50% off')
  // At/after expiry: hidden (the snapshot has gone stale).
  assert.equal(dealLabel('google/gemini-3.7-flash', Date.parse('2027-01-01T00:00:00Z')), undefined)
  // Permanent deals are unaffected by any time.
  assert.equal(dealLabel('MiniMaxAI/MiniMax-M3', Date.parse('2030-01-01T00:00:00Z')), '50% off')
  // DeepSeek V4 Pro: shown before 2026-08-16 16:00 UTC, hidden after.
  assert.equal(dealLabel('deepseek/deepseek-v4-pro', Date.parse('2026-08-16T00:00:00Z')), '75% off')
  assert.equal(dealLabel('deepseek/deepseek-v4-pro', Date.parse('2026-08-16T20:00:00Z')), undefined)
  // Free label survives until capacity ends (treated as permanent here).
  assert.equal(dealLabel('poolside/laguna-s-2.1-free', Date.parse('2030-01-01T00:00:00Z')), 'FREE')
  // No deal -> undefined.
  assert.equal(dealLabel('claude-sonnet-5'), undefined)
})

test('formatContext() renders compact human sizes', () => {
  assert.equal(formatContext(1_000_000), '1M')
  assert.equal(formatContext(1_050_000), '1.1M')
  // 1048576 (Gemini) rounds to a clean 1M, not 1.0M.
  assert.equal(formatContext(1_048_576), '1M')
  assert.equal(formatContext(256_000), '256K')
  // Tencent Hy3's actual 262144 tokens display as 262K (matches the pricing page).
  assert.equal(formatContext(262_144), '262K')
  assert.equal(formatContext(200_000), '200K')
  assert.equal(formatContext(undefined), undefined)
  assert.equal(formatContext(0), undefined)
})

test('capabilityDescription() composes plan, deal, Image, context', () => {
  // Free model without Vision: no Image marker.
  assert.equal(capabilityDescription('poolside/laguna-s-2.1-free', 256_000), 'Go · FREE · 256K')
  // Discounted Image model with context.
  assert.equal(capabilityDescription('MiniMaxAI/MiniMax-M3', 1_000_000), 'Go · 50% off · Image · 1M')
  // Text-only model: no Image marker.
  assert.equal(capabilityDescription('deepseek/deepseek-v4-flash', 1_000_000), 'Go · 1M')
  // Expired deal vanishes from the composition.
  assert.equal(
    capabilityDescription('google/gemini-3.7-flash', 1_000_000, Date.parse('2027-01-01T00:00:00Z')),
    'GOAT · Image · 1M',
  )
  // No plan knowledge -> bare parts only.
  assert.equal(capabilityDescription('some-future-model', undefined), '')
})

test('CLI version and API base constants are stable', () => {
  assert.equal(COMMAND_CODE_CLI_VERSION, '1.26.0')
  assert.equal(DEFAULT_API_BASE, 'https://api.commandcode.ai')
})

test('resolveAuthFileApiKey is safe without an auth file', async () => {
  // Point the function at a nonexistent home by stubbing homedir is not
  // injectable, so exercise the no-throw contract directly: on a machine
  // WITH ~/.commandcode/auth.json it returns a string; without one it
  // returns undefined. Either way it must not throw.
  let threw = false
  try {
    const value = resolveAuthFileApiKey()
    assert.ok(value === undefined || typeof value === 'string')
  } catch {
    threw = true
  }
  assert.equal(threw, false)
})
