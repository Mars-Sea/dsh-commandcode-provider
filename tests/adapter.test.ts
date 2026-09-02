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
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '../src/adapter.ts'
import {
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_THINKING_MODELS,
  KNOWN_PLANS,
  KNOWN_DEALS,
  KNOWN_PEAK_PRICING,
  planLabel,
  dealLabel,
  formatContext,
  capabilityDescription,
  peakPricingLabel,
  peakPricingState,
  compareByPlan,
} from '../src/capabilities.ts'
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
  // The tool result round-trips under role 'tool' with the real tool name
  // (Gemini rejects tool results whose function name is empty).
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.ok(toolMsg)
  const resultPart = (toolMsg.content as Record<string, unknown>[])[0]!
  assert.equal(resultPart.type, 'tool-result')
  assert.equal(resultPart.toolCallId, callId)
  assert.equal(resultPart.toolName, 'bash')
})

test('stream() falls back to "unknown" for an empty tool-call name', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const callId = 'call-empty-name'
  const adapter = makeAdapter({ fetchImpl })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      userMessage('List files'),
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: '', arguments: '{}' }],
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
    // Text-only DeepSeek models carry a time-of-day pricing marker (Peak/Half
    // by current UTC hour) instead of an Image marker.
    assert.match(textOnly.description, /^Go · (?:Peak|Half)$/)
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
  // DeepSeek V4 Pro's 75% off deal was retired 2026-08-16 16:00 UTC and removed
  // from KNOWN_DEALS once it lapsed, so the picker reflects the deal-free
  // description. DeepSeek models carry time-of-day pricing, so the
  // peak/off-peak marker (Peak/Half) depends on the current UTC hour; the
  // fixed parts stay deterministic.
  assert.match(byId.get('deepseek/deepseek-v4-pro')!.description, /^Go · (?:Peak|Half) · 1M$/)
  assert.deepEqual(byId.get('deepseek/deepseek-v4-flash')!.inputModalities, ['text'])
  assert.match(byId.get('deepseek/deepseek-v4-flash')!.description, /^Go · (?:Peak|Half) · 1M$/)
  assert.equal(byId.get('poolside/laguna-s-2.1-free')!.description, 'Go · FREE · 256K')
  // The picker shows rows in returned order: the free model leads, then Go
  // models, then Pro, alphabetically within a tier (input order was
  // deliberately shuffled).
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
  // Pro account: Provider-tier model hidden, Go/Pro/unknown visible.
  assert.deepEqual(ids.sort(), ['claude-sonnet-5', 'deepseek/deepseek-v4-pro', 'some-future-model'])
})

test('modelVisibleInPlan() fails open on every uncertainty', async () => {
  const { modelVisibleInPlan } = await import('../src/capabilities.ts')
  // No billing data at all -> visible.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', undefined), true)
  // Positive on-demand balance -> visible regardless of tier.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: 0, onDemandCredits: 1 }), true)
  // Unknown account tier -> visible.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: undefined, onDemandCredits: 0 }), true)
  // Unknown model -> visible.
  assert.equal(modelVisibleInPlan('some-future-model', { tierWeight: 0, onDemandCredits: 0 }), true)
  // Tier comparison itself.
  assert.equal(modelVisibleInPlan('deepseek/deepseek-v4-pro', { tierWeight: 0, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-sonnet-5', { tierWeight: 0, onDemandCredits: 0 }), false)
  assert.equal(modelVisibleInPlan('claude-sonnet-5', { tierWeight: 2, onDemandCredits: 0 }), true)
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: 4, onDemandCredits: 0 }), true)
})

test('compareByPlan() sorts free models first, then plan tier, then name', () => {
  // Free models (KNOWN_DEALS free: true) lead the list regardless of tier.
  assert.ok(compareByPlan(
    { id: 'minimax/minimax-m3-free', name: 'MiniMax M3 (CC)' },
    { id: 'claude-opus-5', name: 'Claude Opus 5 (CC)' },
  ) < 0)
  // A paid Go model still sorts before a higher-tier model...
  assert.ok(compareByPlan(
    { id: 'zai-org/GLM-5.2', name: 'GLM-5.2 (CC)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CC)' },
  ) < 0)
  // ...but after every free model.
  assert.ok(compareByPlan(
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
    { id: 'zai-org/GLM-5.2', name: 'GLM-5.2 (CC)' },
  ) < 0)
  // Free models order among themselves by name.
  assert.ok(compareByPlan(
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
    { id: 'minimax/minimax-m2.7-free', name: 'MiniMax M2.7 (CC)' },
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
        && /被判定为死连接/.test(e.message ?? '')
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
  // Regression for CodeQL js/polynomial-redos (alert #1): the old
  // `/^-+|-+$/` alternation made the unanchored `-+$` retry every start
  // position on `a<dashes>b`, i.e. O(n^2) — ~14.5s for 200k dashes. The
  // lookbehind trim is linear; 100k dashes must finish in well under a
  // second (a quadratic implementation takes ~3.5s here).
  const longDashPath = `a${'-'.repeat(100_000)}b`
  const start = Date.now()
  assert.equal(projectSlugFromPath(longDashPath), 'a-b')
  assert.ok(Date.now() - start < 1_000, 'slugification of 100k dashes must stay linear')
})

test('known efforts snapshot covers the models the catalog advertises', () => {
  assert.ok(KNOWN_EFFORTS['deepseek/deepseek-v4-flash'])
  assert.ok(KNOWN_EFFORTS['claude-opus-5'])
  // claude-fable-5-1 (Claude Fable 5.1, command-code@1.40.0) carries the same
  // five-level effort set as claude-fable-5 in the Provider-API table.
  assert.deepEqual(KNOWN_EFFORTS['claude-fable-5-1'], ['low', 'medium', 'high', 'xhigh', 'max'])
  // Added in command-code@1.28.0/1.28.1 ("Add Qwen 3.8 27B" + efforts fix):
  // all three Qwen 3.8 models carry ['low','medium','xhigh'] in the ZA table.
  // Qwen 3.8 Flash joined in command-code@1.36.0.
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-27B'], ['low', 'medium', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-Flash'], ['low', 'medium', 'xhigh'])
  // command-code@1.32.0 added DeepSeek V4 Flash Vision (exp) with
  // ['high','max']; 1.35.0 added z-ai/glm-5.3-flash (the stealth/ox-alpha
  // successor after the preview ended in 1.34.0) with the same effort set.
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-vision-exp'], ['high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['z-ai/glm-5.3-flash'], ['low', 'high', 'max'])
  // stealth/ox-alpha left the catalog in 1.34.0 when its preview ended.
  assert.ok(!KNOWN_EFFORTS['stealth/ox-alpha'])
  // command-code@1.39.0 added DeepSeek V4 Flash Fast; 1.39.1 dropped medium
  // for it, so the 1.39.2 table ships ['low','high','max'].
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-fast'], ['low', 'high', 'max'])
  // Synced from the official command-code@1.40.1 model table (re-verified
  // against 1.28.4, 1.30.1, 1.31.0, 1.32.1, 1.32.2, 1.33.0, 1.36.0, 1.37.0,
  // 1.39.2 and 1.40.1 along the way):
  // models that ship with effort levels must be present, and absent ones must
  // stay out. The 0.2.0 snapshot wrongly added ten models (Kimi K2.5, MiMo
  // V2.5, Claude Haiku 4.5, MiniMax M2.5, Muse Spark 1.2 Contributor, Tencent
  // Hy3, ...) that carry NO reasoningEfforts in the CLI's ZA table.
  assert.ok(!KNOWN_EFFORTS['moonshotai/Kimi-K2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5-pro'])
  assert.ok(!KNOWN_EFFORTS['claude-haiku-4-5-20251001'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M2.5'])
  assert.ok(!KNOWN_EFFORTS['meta/muse-spark-1.2-contributor'])
  assert.ok(!KNOWN_EFFORTS['tencent/hy3-paid'])
  assert.ok(!KNOWN_EFFORTS['tencent/Hy3'])
  // tencent/hy4-preview gained selectable ['low','medium','high'] efforts in
  // command-code@1.38.0 (it previously reasoned automatically with none).
  assert.deepEqual(KNOWN_EFFORTS['tencent/hy4-preview'], ['low', 'medium', 'high'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M3']) // no official effort levels
  // moonshotai/Kimi-K3 gained selectable ['low','high','max'] efforts in
  // command-code@1.39.3 (it previously reasoned automatically with none).
  assert.deepEqual(KNOWN_EFFORTS['moonshotai/Kimi-K3'], ['low', 'high', 'max'])
})

test('known thinking snapshot covers reasoning models without effort levels', () => {
  assert.ok(KNOWN_THINKING_MODELS.has('MiniMaxAI/MiniMax-M3'))
  assert.ok(KNOWN_THINKING_MODELS.has('Qwen/Qwen3.7-Max'))
  assert.ok(KNOWN_THINKING_MODELS.has('thinkingmachines/inkling'))
  // MiniMax M3 Free (command-code@1.33.0) reasons automatically like its paid
  // sibling — reasoning:!0 with no effort levels in the ZA table.
  assert.ok(KNOWN_THINKING_MODELS.has('minimax/minimax-m3-free'))
  // stealth/ox-alpha reasoned automatically until command-code@1.32.1 gave it
  // selectable ['low','high','max'] efforts; the model then left the catalog
  // entirely in 1.34.0 when its preview ended. It belongs to neither set now.
  assert.ok(!KNOWN_THINKING_MODELS.has('stealth/ox-alpha'))
  // Re-verified against the command-code@1.28.4 ZA table (2026-08-18),
  // re-confirmed against 1.30.1 (2026-08-21), 1.37.0 (2026-08-28) and 1.38.2:
  // these think automatically (reasoning:!0, no efforts) and belong in the set.
  // tencent/hy4-preview joined in command-code@1.37.0 (OpenRouter-routed, 1M,
  // no efforts) but gained selectable ['low','medium','high'] efforts in
  // 1.38.0 and moved to KNOWN_EFFORTS. moonshotai/Kimi-K3 followed the same
  // path in command-code@1.39.3 (['low','high','max']).
  assert.ok(KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K2.7-Code-Highspeed'))
  assert.ok(KNOWN_THINKING_MODELS.has('tencent/hy3-paid'))
  assert.ok(!KNOWN_THINKING_MODELS.has('tencent/hy4-preview'))
  assert.ok(!KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K3'))
  assert.ok(KNOWN_THINKING_MODELS.has('meta/muse-spark-1.2-contributor'))
  // GLM-5/5.1/5.2-Fast are NOT reasoning-capable (ZA reasoning:false, docs
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

test('known image models snapshot has stable anchor entries', () => {
  // Anchors that must never drift: a flagship vision model and a text-only
  // model (the latter is deliberately absent).
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-sonnet-5'))
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-5.4'))
  // claude-fable-5-1 (command-code@1.40.0) is Vision per the official registry
  // ("Text input, Vision, Reasoning"), like its claude-fable-5 predecessor.
  assert.ok(KNOWN_IMAGE_MODELS.has('claude-fable-5-1'))
  // stealth/ox-alpha (command-code@1.31.0) was Vision; the model left the
  // catalog in 1.34.0 when its preview ended, so it is no longer whitelisted.
  assert.ok(!KNOWN_IMAGE_MODELS.has('stealth/ox-alpha'))
  // DeepSeek V4 Flash Vision (exp) (command-code@1.32.0) is Vision per the
  // official registry; its non-Vision siblings stay text-only.
  assert.ok(KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash-vision-exp'))
  // Qwen 3.8 27B (command-code@1.28.0) and Qwen 3.8 Flash (1.36.0) are
  // Vision per the official registry.
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-27B'))
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-Flash'))
  // z-ai/glm-5.3-flash (command-code@1.35.0) replaced stealth/ox-alpha as
  // the open-weight 1M-context Vision reasoning model and is Vision.
  assert.ok(KNOWN_IMAGE_MODELS.has('z-ai/glm-5.3-flash'))
  // MiniMax M3 Free (command-code@1.33.0) is Vision ("Text input, Vision,
  // Reasoning") like the paid M3; its M2.7 Free sibling stays text-only.
  assert.ok(KNOWN_IMAGE_MODELS.has('minimax/minimax-m3-free'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('minimax/minimax-m2.7-free'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-pro'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('zai-org/GLM-5.3'))
})

test('known plan snapshot tiers models by the official plan pages', () => {
  // Go: the entry plan covers open models + a few premium ones.
  assert.equal(KNOWN_PLANS['MiniMaxAI/MiniMax-M3'], 'go')
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash'], 'go')
  // DeepSeek V4 Flash Vision (exp) (command-code@1.32.0) joined the Go plan.
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash-vision-exp'], 'go')
  // DeepSeek V4 Flash Fast (command-code@1.39.0) is a Go-tier open model.
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4-flash-fast'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.7-Max'], 'go')
  assert.equal(KNOWN_PLANS['gpt-5.6-luna'], 'go')
  // Qwen 3.8 27B (command-code@1.28.0) and Qwen 3.8 Flash (1.36.0) are on
  // the Go plan page.
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-27B'], 'go')
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-Flash'], 'go')
  // z-ai/glm-5.3-flash (command-code@1.35.0) replaced stealth/ox-alpha on
  // the Go plan when the stealth preview ended in 1.34.0.
  assert.equal(KNOWN_PLANS['z-ai/glm-5.3-flash'], 'go')
  // tencent/hy4-preview (command-code@1.37.0, OpenRouter-routed, 1M) joined Go.
  assert.equal(KNOWN_PLANS['tencent/hy4-preview'], 'go')
  assert.equal(KNOWN_PLANS['stealth/ox-alpha'], undefined)
  // Tencent Hy3 (the hidden free variant, distinct from tencent/hy3-paid) is
  // a Go-tier open model; ling-3.0-flash-free (deprecated, free promo ended
  // 2026-08-03) is also on Go. Both closed coverage gaps in the 1.38.2 sync.
  assert.equal(KNOWN_PLANS['tencent/Hy3'], 'go')
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.0-flash-free'], 'go')
  // MiniMax M3/M2.7 Free variants (command-code@1.33.0) are promo rows of the
  // Go-tier open models — same tier as their paid siblings.
  assert.equal(KNOWN_PLANS['minimax/minimax-m3-free'], 'go')
  assert.equal(KNOWN_PLANS['minimax/minimax-m2.7-free'], 'go')
  // GOAT adds a handful of closed/premium models (GPT-5.6 Sol joined in
  // command-code@1.27.0, "50% off in GOAT and above" per the changelog).
  assert.equal(KNOWN_PLANS['google/gemini-3.7-flash'], 'goat')
  assert.equal(KNOWN_PLANS['xai/grok-4.6'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.2'], 'goat')
  assert.equal(KNOWN_PLANS['gpt-5.6-sol'], 'goat')
  // Pro adds Claude Sonnet/Haiku, GPT-5.x, Gemini 3.5/3.1.
  assert.equal(KNOWN_PLANS['claude-sonnet-5'], 'pro')
  assert.equal(KNOWN_PLANS['gpt-5.4'], 'pro')
  assert.equal(KNOWN_PLANS['google/gemini-3.5-flash'], 'pro')
  // Provider/Max: Claude Opus/Fable and Fugu Ultra are not on lower plans.
  assert.equal(KNOWN_PLANS['claude-opus-5'], 'provider')
  assert.equal(KNOWN_PLANS['claude-fable-5'], 'provider')
  // claude-fable-5-1 (Claude Fable 5.1, command-code@1.40.0) is Provider/Max
  // exactly like claude-fable-5 — official plan pages grant it only
  // individual-provider/max/ultra + teams-pro, and the CLI blocks it on
  // Go/GOAT/Pro. It must be mapped so the picker's plan filter does not fail
  // open and show a Provider/Max model to every subscription.
  assert.equal(KNOWN_PLANS['claude-fable-5-1'], 'provider')
  assert.equal(KNOWN_PLANS['sakana/fugu-ultra'], 'provider')
  // Labels match the official tier names.
  assert.equal(planLabel('MiniMaxAI/MiniMax-M3'), 'Go')
  assert.equal(planLabel('claude-sonnet-5'), 'Pro')
  assert.equal(planLabel('claude-opus-5'), 'Provider')
  assert.equal(planLabel('some-future-model'), undefined)
})

test('known deals snapshot has anchors and expiry-aware labels', () => {
  // DeepSeek V4 Pro's 75% off deal was retired on 2026-08-16 16:00 UTC when
  // DeepSeek moved to peak/off-peak pricing, and was removed from the snapshot
  // once it lapsed (see KNOWN_PEAK_PRICING).
  assert.equal(KNOWN_DEALS['deepseek/deepseek-v4-pro'], undefined)
  // Free model is marked free.
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free'].free, true)
  // stealth/ox-alpha's free deal ended in command-code@1.34.0 when the model
  // was retired; its successor z-ai/glm-5.3-flash has no deal (1.35.0).
  assert.equal(KNOWN_DEALS['stealth/ox-alpha'], undefined)
  assert.equal(KNOWN_DEALS['z-ai/glm-5.3-flash'], undefined)
  // MiniMax M3/M2.7 Free (command-code@1.33.0) were retired in
  // command-code@1.39.2 ("Retire MiniMax free models"): the CLI hides them and
  // the pricing page no longer lists them as free, so the FREE entries are
  // removed from the snapshot rather than left to lapse on their old
  // 2026-09-05 expiry.
  assert.equal(KNOWN_DEALS['minimax/minimax-m3-free'], undefined)
  assert.equal(KNOWN_DEALS['minimax/minimax-m2.7-free'], undefined)
  // Gemini 3.7 Flash's 50% off deal was retired from the pricing page in the
  // command-code@1.38.2 sync; the model now shows at full price.
  assert.equal(KNOWN_DEALS['google/gemini-3.7-flash'], undefined)
})

test('dealLabel() hides a deal after its expiry date', () => {
  // The MiniMax free promos were retired in command-code@1.39.2 — removed from
  // the snapshot entirely — so they report no label at any time.
  assert.equal(dealLabel('minimax/minimax-m3-free', Date.parse('2026-09-05T12:00:00Z')), undefined)
  assert.equal(dealLabel('minimax/minimax-m3-free', Date.parse('2026-09-06T00:00:00Z')), undefined)
  assert.equal(dealLabel('minimax/minimax-m2.7-free', Date.parse('2026-09-06T00:00:00Z')), undefined)
  // Permanent deals are unaffected by any time.
  assert.equal(dealLabel('MiniMaxAI/MiniMax-M3', Date.parse('2030-01-01T00:00:00Z')), '50% off')
  // DeepSeek V4 Pro's deal was removed from the snapshot after it lapsed; the
  // model now carries peak/off-peak pricing instead (KNOWN_PEAK_PRICING).
  assert.equal(dealLabel('deepseek/deepseek-v4-pro', Date.parse('2026-08-15T00:00:00Z')), undefined)
  // Free label survives until capacity ends (treated as permanent here).
  assert.equal(dealLabel('poolside/laguna-s-2.1-free', Date.parse('2030-01-01T00:00:00Z')), 'FREE')
  // No deal -> undefined.
  assert.equal(dealLabel('claude-sonnet-5'), undefined)
  // Gemini 3.7 Flash's deal was retired in the 1.38.2 sync: no label at any time.
  assert.equal(dealLabel('google/gemini-3.7-flash', Date.parse('2026-12-31T12:00:00Z')), undefined)
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
  // Text-only model: no Image marker. DeepSeek V4 Flash carries time-of-day
  // pricing; a fixed off-peak time (17:00 UTC) shows the `Half` marker.
  assert.equal(
    capabilityDescription('deepseek/deepseek-v4-flash', 1_000_000, Date.parse('2026-08-17T17:00:00Z')),
    'Go · Half · 1M',
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
  // All DeepSeek hourly-priced models are in the time-of-day pricing snapshot
  // (the V4 Flash Vision variant shares V4 Flash's windows per the pricing page).
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-pro'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-vision-exp'))
  // DeepSeek V4 Flash Fast (command-code@1.39.0) shares V4 Flash's peak windows
  // and peak prices per the pricing page's off-peak annotation.
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-fast'))
  // Non-peak-priced models report no state. Qwen 3.8 Max looks annotated when
  // the pricing page is flattened to text, but its hover annotation actually
  // lives in the V4 Flash Vision row above it (each annotation states exactly
  // 2x that row's own prices) — Qwen's own row carries none. Same for the
  // new tencent/hy4-preview (1.37.0, text-only, priced per token, not per hour).
  assert.ok(!KNOWN_PEAK_PRICING.has('Qwen/Qwen3.8-Max'))
  assert.ok(!KNOWN_PEAK_PRICING.has('tencent/hy4-preview'))
  assert.equal(peakPricingState('claude-sonnet-5', Date.parse('2026-08-17T17:00:00Z')), undefined)
  assert.equal(peakPricingLabel('claude-sonnet-5', Date.parse('2026-08-17T17:00:00Z')), undefined)

  // Official windows: peak 01:00–04:00 and 06:00–10:00 UTC, off-peak otherwise.
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
  // Peak is 7 hours/day total (01-03 + 06-09 = 3 + 4).
  let peakHours = 0
  for (let h = 0; h < 24; h++) {
    if (peakPricingState('deepseek/deepseek-v4-flash', peak(h)) === 'peak') peakHours++
  }
  assert.equal(peakHours, 7)
})

test('CLI version and API base constants are stable', () => {
  // command-code@1.40.1 (2026-09-02): 1.39.0 added DeepSeek V4 Flash Fast,
  // 1.39.1 dropped medium effort for it, 1.39.2 retired the MiniMax free
  // models, 1.39.3 added Kimi K3 effort levels, 1.40.0 added Fable 5.1 (a
  // Provider-API model on the Provider/Max tier). The version rides every
  // request as x-command-code-version.
  assert.equal(COMMAND_CODE_CLI_VERSION, '1.40.1')
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

const FINISH_STREAM = 'data: {"type":"finish","finishReason":"stop"}\n\n'

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

  // Two connect attempts: key-1 refused, key-2 served; the rotation hook saw
  // the rejection exactly once and the stream finished normally.
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
  assert.deepEqual(rotated, [['key-1', 'rate-limit']])
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
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
    (err: unknown) => (err as { code?: string }).code === 'RATE_LIMIT',
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
    (err: unknown) => (err as { code?: string }).code === 'RATE_LIMIT',
  )
  assert.deepEqual(calls.map((call) => call.key), ['key-1', 'key-2'])
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

test('probeFiveHourWindow() parses the five-hour window limit', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: { windowLimits: { fiveHour: { used: 5, cap: 5, exceeded: true, resetAt: 1_800_000_000_000 } } },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeFiveHourWindow('key-1'), { exceeded: true, resetAt: 1_800_000_000_000 })
})

test('probeFiveHourWindow() degrades to undefined on endpoint or shape failure', async () => {
  const failing = makeAdapter({ fetchImpl: fetchReturning(500, 'boom') })
  assert.equal(await failing.probeFiveHourWindow('key-1'), undefined)
  const shapeless = makeAdapter({ fetchImpl: fetchReturning(200, JSON.stringify({ credits: {} })) })
  assert.equal(await shapeless.probeFiveHourWindow('key-1'), undefined)
})

test('providerRetryPolicy() pins the near-unbounded transient-only retry policy', () => {
  // dsh-llm-retry executes this at the agent-step boundary: normal mode with
  // an explicit 1000-attempt cap retries the five transient codes (an
  // opencode-like persistence that still fails fast on permanent errors such
  // as INVALID_CREDENTIAL), waits double from 500 ms capped at 15 minutes
  // with ±10% jitter, and honors an attached providerRetryAfterMs at or
  // below the cap. Pinned so a dsh default change cannot silently alter the
  // visible retry cadence or whitelist.
  const adapter = makeAdapter()
  const policy = adapter.providerRetryPolicy('commandcode')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 1000)
  assert.deepEqual([...policy.retryableCodes], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  assert.equal(policy.initialDelayMs, 500)
  assert.equal(policy.maxDelayMs, 900000)
  assert.equal(policy.jitterRatio, 0.1)
})

test('providerInfo() names the picker group "Command Code"', () => {
  // The model picker renders provider groups in registration order with the
  // adapter-supplied name as the sticky group title; the base class would
  // show the raw route id ("commandcode"). Pinned so the display name stays
  // in step with the Models settings page card (displayName "Command Code"),
  // and the id keeps equaling the route (dsh-llm validates that).
  const adapter = makeAdapter()
  assert.deepEqual(adapter.providerInfo('commandcode'), { id: 'commandcode', name: 'Command Code' })
})

test('stream() attaches a 429 Retry-After header as providerRetryAfterMs', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(429, 'rate limited', { 'retry-after': '7' }) })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const e = err as { code?: string; failure?: { providerRetryAfterMs?: number } }
      return e.code === 'RATE_LIMIT' && e.failure?.providerRetryAfterMs === 7000
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
      return e.code === 'RATE_LIMIT' && e.failure?.providerRetryAfterMs === undefined
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
      return e.code === 'RATE_LIMIT' && e.failure?.providerRetryAfterMs === undefined
    },
  )
})

// ---------------------------------------------------------------------------
// getUsage(): total-failure classification (the settings card's blocked banner)
// ---------------------------------------------------------------------------

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
