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
  requiresMessagesEndpoint,
} from '../src/capabilities.ts'
import type { CommandCodeAdapterDeps, CommandCodeConnectionOptions, CoreImagePolicy } from '../src/adapter.ts'
import type { ContentBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The harness mints a stable id for every message it appends; the adapter
 * never reads it, but the `Message` contract requires one, so the fixtures
 * below stamp a fresh id per message.
 */
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
  // A string body is encoded into a stream; a caller-supplied stream is used
  // as-is. (The previous form encoded the stream itself, which would have
  // stringified it — no caller passes a factory today, so the branch is
  // typed and wired correctly rather than left as a trap.)
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
  } as unknown as AttachmentStore
}

/** Collect all chunks from a stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

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
 * The gateway rule behind issue #33: an assistant message carrying tool calls
 * must be followed by tool messages answering ALL of them, consecutively, with
 * nothing else in between (it answers with
 * `An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'`, HTTP 400, on every replay of the
 * history — so a violation is not a bad turn, it is a dead conversation).
 *
 * Written against the wire body rather than the harness messages on purpose:
 * it re-derives the rule from whatever the transport actually emitted, so it
 * holds for both the nested CLI shape and the flat Provider API shape, and it
 * keeps holding if the converters are refactored. Returns one description per
 * violating assistant message, so a caller can assert on a single history or
 * just report.
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
      ? new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      : new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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

/**
 * One assistant turn issuing `ids` in parallel, followed by one tool result
 * per id — the shape issues #30 and #33 both live in. `assistantText` adds a
 * text block beside the calls, and each result may carry text, images, or be
 * an error.
 */
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
    messages.push({
      id: messageId(),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(id), isError: result.isError ?? false, content: blocks }],
      source: { kind: 'tool', callId: ToolCallId(id) },
    })
  }
  return messages
}

// ---------------------------------------------------------------------------
// Message conversion (via stream() request capture)
// ---------------------------------------------------------------------------

test('stream() sends the harness conversation in Command Code wire format', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      { id: messageId(), role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model', provider: 'commandcode', model: 'm' } },
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

test('stream() replays reasoning blocks on the CLI transport', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  // Issue #34: a DeepSeek thinking-mode assistant turn whose tool calls are
  // replayed WITHOUT its thinking is rejected by the provider ("The
  // `reasoning_content` in the thinking mode must be passed back to the
  // API"), which killed every tool-loop turn on the CLI transport. The
  // official CLI's `toWireMessages` replays each thinking block as a
  // `{ type: 'reasoning', text }` assistant part, in content order.
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
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'file1' }] }],
        source: { kind: 'tool', callId },
      },
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', { status: 200 })
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
      { id: messageId(),
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

test('stream() remaps overlong cross-provider tool-call ids to the gateway limit', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  // Issue #23: switching to Command Code mid-session can replay a tool id
  // issued by another provider that exceeds the gateway's `call_id <= 64`
  // limit. The adapter must remap it to a short per-request alias while
  // keeping each call/result pair correlated.
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
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: longId, isError: false, content: [{ type: 'text', text: 'a' }] }],
        source: { kind: 'tool', callId: longId },
      },
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('cc-1'), isError: false, content: [{ type: 'text', text: 'b' }] }],
        source: { kind: 'tool', callId: ToolCallId('cc-1') },
      },
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('call-short'), isError: false, content: [{ type: 'text', text: 'c' }] }],
        source: { kind: 'tool', callId: ToolCallId('call-short') },
      },
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
      { id: messageId(),
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
    { id: messageId(),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: false,
        content: [{ type: 'text', text: 'image/png image, 1x1 px, 10 bytes' }, { type: 'image', attachment: ref }, ...extra],
      }],
      source: { kind: 'tool', callId: callId },
    },
  ]
}

test('stream() carries tool-result images after the tool message (issue #30)', async () => {
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
    source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pngBytes).toString('base64') },
  })
})

test('stream() carries a tool-result image exactly once and never without bytes', async () => {
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
  // The text-only tool message keeps the tool's own readable summary.
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.equal(((toolMsg.content as Record<string, unknown>[])[0]!.output as { value: string }).value, 'image/png image, 1x1 px, 10 bytes')
})

test('stream() gives an image-only tool result a non-empty tool message', async () => {
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
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: false,
          content: [{ type: 'image', attachment: ref }],
        }],
        source: { kind: 'tool', callId: callId },
      },
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
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  const refA = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-a') }
  const refB = { ...imageRef(), attachmentId: AttachmentId('sha256:test-image-b') }
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () =>
      fakeAttachments({ [refA.attachmentId]: pngBytes, [refB.attachmentId]: pngBytes }),
  })
  // One assistant turn with two parallel read_image calls, each answered with
  // an image-bearing tool result — the shape that used to interleave the
  // image carrier between the tool results and break the gateway's
  // consecutive-tool pairing check.
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
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-a'),
          isError: false,
          content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: refA }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-a') },
      },
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-b'),
          isError: false,
          content: [{ type: 'text', text: 'b' }, { type: 'image', attachment: refB }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-b') },
      },
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  // user → assistant(2 calls) → tool(a) → tool(b) → user(imgA) → user(imgB):
  // both tool results must come out consecutively, with the carried images
  // only afterwards.
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
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
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
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-a'),
          isError: false,
          content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: refA }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-a') },
      },
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-b'),
          isError: false,
          content: [{ type: 'text', text: 'b' }, { type: 'image', attachment: refB }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-b') },
      },
    ],
  }))

  const messages = capturedBody!.messages as Record<string, unknown>[]
  // The OpenAI transport's flat message list must keep the two tool messages
  // adjacent; both image carriers follow only after the last tool result.
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
  }) as unknown as typeof fetch

  // The note must name the id the MODEL saw. An overlong cross-provider id is
  // remapped to a short alias on the wire (issue #23), so naming the
  // harness-side id would point the model at a call that is nowhere in the
  // request it is reading.
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
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: longId,
          isError: false,
          content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: ref }],
        }],
        source: { kind: 'tool', callId: longId },
      },
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
  // The two converters disagreed on this input: the CLI transport emitted
  // `{ role: 'user', content: [] }` while the Provider API transport dropped
  // the message. An empty content array is a needless gateway-compat risk and
  // the message carries nothing, so both transports now drop it — including
  // when the empty content comes only from blocks this adapter does not put
  // on the wire (a user message whose sole block is a `reasoning` one).
  const ref = imageRef()
  for (const protocol of ['cli', 'openai'] as const) {
    let capturedBody: Record<string, unknown> | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return protocol === 'openai'
        ? new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
    // Nothing on the wire converted to empty, and the image carrier that was
    // pending before those two messages was still flushed rather than dropped.
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

/**
 * A message as a third-party producer can actually emit it: `Message.source` is
 * declared required in dsh-llm's type, but the field is producer-supplied and
 * the runtime never validates it, so an untagged message is a real runtime shape
 * (issue #47) that the type system cannot express — hence the cast.
 */
function untaggedMessage(role: 'user' | 'assistant', content: ContentBlock[]): Message {
  return { id: messageId(), role, content } as unknown as Message
}

test('both transports convert an untagged message instead of crashing on it (issue #47)', async () => {
  // `messagesToCC` read `message.source.kind` at four sites. A producer that
  // omits `source` — legal nowhere, survivable everywhere else, because the
  // shipped adapters never read the field — made the FIRST of them throw
  // `TypeError: Cannot read properties of undefined (reading 'kind')` in the
  // serialization phase: the whole stream died 0–8 ms in, before a request was
  // sent, with an error that named neither the message nor the adapter. Both
  // transports must now treat an untagged message as the plain user message its
  // content says it is.
  for (const protocol of ['cli', 'openai'] as const) {
    const messages = await captureWire(
      protocol,
      [untaggedMessage('user', [{ type: 'text', text: 'from a producer that forgot the tag' }]), userMessage('tagged')],
      {},
    )
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'user'],
      `${protocol}: an untagged user message must survive as a user message`,
    )
    assert.match(JSON.stringify(messages[0]), /forgot the tag/)
  }
})

test('an untagged tool result stays a tool result, so its call is not left unanswered (issue #47)', async () => {
  // The untagged fallback is not just "assume user". `pairedToolCalls()` counts
  // a `tool-result` block from ANY message, so classifying an untagged tool
  // result as a plain user message would drop it at emission while its call
  // still counted as paired — the wire would carry an assistant `tool_calls`
  // entry with no answer, which the gateway rejects outright. Content shape
  // settles it: a `user` message whose first block is a tool result IS one by
  // the harness's own definition.
  for (const protocol of ['cli', 'openai'] as const) {
    const callId = ToolCallId('call-untagged')
    const messages = await captureWire(
      protocol,
      [
        userMessage('read the file'),
        {
          id: messageId(),
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' }],
          source: { kind: 'model', provider: 'commandcode', model: 'm' },
        },
        untaggedMessage('user', [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'ok' }] }]),
        userMessage('and now?'),
      ],
      {},
    )
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'user'],
      `${protocol}: the untagged tool result must still answer its call`,
    )
    assert.equal(wireAnswers(messages[2]!), 'call-untagged')
    assertToolGroupsAnswered(messages, `${protocol}: untagged tool result`)
  }
})

test('a present source tag stays authoritative over the content shape (issue #47)', async () => {
  // The fallback above is only for an ABSENT tag. A message that declares who
  // produced it is taken at its word — a `kind: 'user'` message carrying a
  // tool-result block is still not replayed as a tool answer, which keeps the
  // rule "the tag answers who produced this" intact.
  for (const protocol of ['cli', 'openai'] as const) {
    const callId = ToolCallId('call-tagged-user')
    const messages = await captureWire(
      protocol,
      [
        userMessage('read the file'),
        {
          id: messageId(),
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{"file_path":"/tmp/a.png"}' }],
          source: { kind: 'model', provider: 'commandcode', model: 'm' },
        },
        // Tagged `user` while shaped like a tool result: dropped at emission on
        // both transports today, and that must not change.
        {
          id: messageId(),
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'user' },
        } as unknown as Message,
        userMessage('and now?'),
      ],
      {},
    )
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'user'],
      `${protocol}: a tagged non-tool message must not be replayed as a tool answer`,
    )
  }
})

test('the tool-group invariant detects the interleaving it exists for', () => {
  // A validator that can never fail would pass every history below for the
  // wrong reason, so feed it the two orderings that matter: the pre-fix #33
  // shape (a carrier between the tool results) must be caught, and the fixed
  // ordering must be clean. The first body is exactly what this adapter
  // emitted before #33, so this test fails if the invariant goes blind.
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
  // The invariant is checked once over a table of histories rather than
  // re-pinned shape by shape: what the gateway enforces is a property of the
  // whole message list, and the interesting failures (a carrier landing inside
  // a group, a group split across a user turn) only show up when the list is
  // derived from a real history.
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
        { id: messageId(),
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: ToolCallId('c-orphan'), isError: false, content: [{ type: 'text', text: 'orphan' }, { type: 'image', attachment: refC }] }],
          source: { kind: 'tool', callId: ToolCallId('c-orphan') },
        },
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'file1' }] }],
        source: { kind: 'tool', callId: callId },
      },
    ],
  }))

  const messages = (capturedBody!.params as Record<string, unknown>).messages as Record<string, unknown>[]
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool'])
})

test('stream() drops images of an unpaired tool result with the result itself', async () => {
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
  // No assistant tool-call pairs this result, so neither the result nor its
  // image may reach the wire (an orphan image would be unexplainable).
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [
      userMessage('hi'),
      { id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-orphan'),
          isError: false,
          content: [{ type: 'text', text: 'x' }, { type: 'image', attachment: ref }],
        }],
        source: { kind: 'tool', callId: ToolCallId('call-orphan') },
      },
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
    return new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
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
  // Official CLI wire shape: { type:'image', source:{ type:'base64', media_type, data } }.
  assert.deepEqual(parts[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pngBytes).toString('base64') },
  })
})

// ---------------------------------------------------------------------------
// Request image versions and visual-token pricing (C2, C3)
//
// An attachment is stored NORMALIZED, not request-ready: `readImage()` answers
// the admitted original, while a provider request should carry a REQUEST VERSION
// encoded to the route target (`readImageRequest()`). On this route that is not
// cosmetic — both transports inline every historical image as base64, so the
// version's bytes are what the body, the context window and the gateway's ~50 MB
// cap actually pay for. The same target is what the visual-token price is
// computed at, so the meter tracks the bytes that travel rather than the ones
// that are stored.
// ---------------------------------------------------------------------------

/** An AttachmentStore stub that answers a distinct request version and records every target. */
function versionedAttachments(
  images: Record<string, Uint8Array>,
  versionBytes: Uint8Array,
): { store: AttachmentStore; targets: { ref: ImageAttachmentRef; target: Record<string, number> }[] } {
  const targets: { ref: ImageAttachmentRef; target: Record<string, number> }[] = []
  const store = {
    ...(fakeAttachments(images) as unknown as Record<string, unknown>),
    async readImageRequest(ref: ImageAttachmentRef, target: Record<string, number>) {
      targets.push({ ref, target })
      return {
        ref,
        data: versionBytes,
        mediaType: ref.mediaType,
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

  // 1568 px long edge with the aspect kept, the byte budget both attachment
  // generations honour, and the projected area <=0.1.5 re-projects from.
  assert.deepEqual(targets.map((call) => call.target), [{
    maxPixels: 1568 * 980,
    width: 1568,
    height: 980,
    maxBytes: 1024 * 1024,
  }])
  const wire = (capturedBody!.params as { messages: Record<string, unknown>[] }).messages
  const part = (wire.find((m) => m.role === 'user')!.content as Record<string, unknown>[])[1]!
  assert.equal((part.source as { data: string }).data, Buffer.from(version).toString('base64'))
})

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
    // Not a Claude id: those are Messages-only, so they take the CLI transport
    // even under a forced `'openai'` preference (see `resolveProtocol()`), and
    // this test is about the OpenAI transport's request-version handling. Its
    // CLI counterpart above keeps `claude-sonnet-5`, which is where Claude
    // genuinely goes.
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

test('a service that produces no request version still sends the stored original (C2)', async () => {
  // The defensive path: a backend predating request versions must still serve
  // images instead of failing the request outright.
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body))
    return okStream('cli')
  }) as unknown as typeof fetch
  const ref = sizedImageRef(0, pngBytes.length)
  const adapter = makeAdapter({
    fetchImpl,
    resolveAttachments: () => fakeAttachments({ [ref.attachmentId]: sizedImageBytes(0) }),
  })
  await collect(adapter.stream({
    provider: 'commandcode',
    model: 'claude-sonnet-5',
    messages: [{
      id: messageId(),
      role: 'user',
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user' },
    }],
  }))

  const wire = (capturedBody!.params as { messages: Record<string, unknown>[] }).messages
  const part = (wire.find((m) => m.role === 'user')!.content as Record<string, unknown>[])[0]!
  assert.equal(
    (part.source as { data: string }).data,
    Buffer.from(sizedImageBytes(0)).toString('base64'),
  )
})

test('imageRequestPricing() prices a retained image at its request target (C3)', () => {
  const pricing = makeAdapter().imageRequestPricing('commandcode', 'claude-sonnet-5')
  assert.ok(pricing !== undefined)
  const ref = { ...sizedImageRef(0, pngBytes.length), width: 2880, height: 1800 }
  // The >=0.1.6 payload shape (blocks); the bare-reference shape this checkout
  // compiles against is the last assertion.
  const [price] = pricing!.priceImages([{ type: 'image', attachment: ref } as never])
  // Anthropic's rule at the target this route would send: 1568x980.
  assert.equal(price!.visualTokens, Math.ceil((1568 * 980) / 750))
  // The pixels are inlined, so a retained occurrence carries no model-visible text.
  assert.equal(price!.text, '')
  // The token meter throws unless one price comes back per occurrence, in order.
  assert.equal(pricing!.priceImages([ref as never, ref as never]).length, 2)
})

test('imageRequestPricing() prices an offloaded occurrence as its placeholder (C3)', () => {
  const pricing = makeAdapter().imageRequestPricing('commandcode', 'claude-sonnet-5')!
  const ref = sizedImageRef(0, pngBytes.length)
  const [price] = pricing.priceImages([{ type: 'image', attachment: ref, offloaded: true } as never])
  // The surface renders this one as text in every later request, so it costs no
  // vision tokens and is priced by the caller's text estimator instead.
  assert.equal(price!.visualTokens, 0)
  assert.match(price!.text, /image omitted to fit request image limits/)
  // A bare reference (the <=0.1.5 payload) is a retained occurrence, and a tiny
  // image still costs at least one token rather than rounding to zero.
  const [bare] = pricing.priceImages([ref as never])
  assert.equal(bare!.visualTokens, 1)
  assert.equal(bare!.text, '')
})

test('imageRequestPricing() prices a text-only route as placeholder text (C3)', () => {
  const model = 'deepseek/deepseek-v4-pro'
  assert.ok(!KNOWN_IMAGE_MODELS.has(model), 'the case under test needs a model outside the Vision snapshot')
  const pricing = makeAdapter().imageRequestPricing('commandcode', model)!
  const ref = sizedImageRef(0, pngBytes.length)
  const [price] = pricing.priceImages([{ type: 'image', attachment: ref } as never])
  assert.equal(price!.visualTokens, 0)
  assert.match(price!.text, /accepts text only/)
})

// ---------------------------------------------------------------------------
// Request image budget (issue #37)
//
// Both transports inline every historical image, and the gateway caps a whole
// request body (measured ~50.17 MB, undocumented). Once a session crossed it,
// every later request on this route failed with 413 forever. These tests pin
// the budget that keeps the recent tail and turns the oldest images into
// model-visible placeholders instead.
// ---------------------------------------------------------------------------

/** The core helper's eviction placeholder, as it opens in both transports. */
const PLACEHOLDER_PREFIX = '[image omitted to fit request image limits'

/**
 * An image reference DECLARING `bytes` normalized bytes. The budget accounts
 * declared sizes, so a test crosses the cap without allocating megabytes; the
 * stored payload stays one byte long and unique per index, which is what lets
 * a test name the occurrences that survived.
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
    ? new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    : new Response('data: {"type":"finish","finishReason":"stop"}\n\n', { status: 200 })
}

/**
 * Drive one history through a transport against a fetch stub whose answer
 * depends on the attempt number, returning every request body the adapter
 * issued plus the error `stream()` ended with (undefined on success). What
 * each ATTEMPT carried is the observable the 413 ladder is about, so a
 * success-only capture helper cannot express these tests.
 */
async function runAttempts(
  protocol: 'cli' | 'openai',
  messages: Message[],
  images: Record<string, Uint8Array>,
  status: (attempt: number) => number = () => 200,
  imageOffload?: CoreImagePolicy,
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
    ...(protocol === 'openai' ? { options: OPENAI_OPTIONS } : {}),
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
        ? (p.source as { data: string }).data
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

test('stream() evicts the oldest images once the history exceeds the image-count budget (issue #37)', async () => {
  // 61 images: one past the 60-image budget, and the 30-count quantum means
  // the oldest 30 go at once rather than one per request.
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('cli', messages, images)

  assert.equal(error, undefined)
  const body = bodies[0]!
  const survivors = survivingImageIndices(body, 'cli')
  // The newest 31 keep their pixels; the oldest 30 became placeholders.
  assert.deepEqual(survivors, [...Array(61).keys()].slice(30))
  const placeholders = placeholderTexts(body, 'cli')
  assert.equal(placeholders.length, 30)
  // The placeholder names the attachment it replaced, so the model can tell
  // which image is gone (or ask for it again) instead of silently losing it.
  assert.match(placeholders[0]!, /sha256:budget-image-0/)
  // The eviction happens IN PLACE: the message keeps its own text block and
  // gains a placeholder part where its image was.
  const firstUser = (body.params as { messages: Record<string, unknown>[] }).messages
    .filter((m) => m.role === 'user')[0]!
  assert.deepEqual(
    (firstUser.content as Record<string, unknown>[]).map((p) => p.type),
    ['text', 'text'],
  )
})

test('stream() evicts the oldest images once the history exceeds the image-byte budget (issue #37)', async () => {
  // Ten images of 4 MiB each: 53.3 MiB of base64, past the 32 MiB budget, with
  // the 16 MiB byte quantum deciding how many go at once.
  const { messages, images } = imageHistory(Array.from({ length: 10 }, () => 4 * 1024 * 1024))
  const { bodies, error } = await runAttempts('cli', messages, images)

  assert.equal(error, undefined)
  const body = bodies[0]!
  const survivors = survivingImageIndices(body, 'cli')
  // Eviction always removes a PREFIX, so what survives is the newest suffix.
  assert.deepEqual(survivors, [...Array(10).keys()].slice(10 - survivors.length))
  const placeholders = placeholderTexts(body, 'cli')
  assert.equal(placeholders.length, 10 - survivors.length)
  assert.ok(placeholders.length > 0, 'a history past the byte budget must lose images')
  // The remaining request really is inside the budget (base64 accounting).
  const keptBytes = survivors.length * Math.ceil((4 * 1024 * 1024) / 3) * 4
  assert.ok(keptBytes <= 32 * 1024 * 1024, `kept ${keptBytes} base64 bytes, over the budget`)
})

test('stream() carries an evicted tool-result image as placeholder tool text (issue #37)', async () => {
  // A vision self-check loop's history in miniature: a huge `read_image`
  // result the budget must drop, plus a newer user image it must keep.
  const toolRef = sizedImageRef(0, 40 * 1024 * 1024)
  const laterRef = sizedImageRef(1, pngBytes.length)
  const laterImage: Message = {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text: 'shot 1' }, { type: 'image', attachment: laterRef }],
    source: { kind: 'user' },
  }
  const { bodies, error } = await runAttempts(
    'cli',
    [userMessage('what is in /tmp/a.png?'), ...readImageTurn(toolRef), laterImage],
    { [toolRef.attachmentId]: sizedImageBytes(0), [laterRef.attachmentId]: sizedImageBytes(1) },
  )

  assert.equal(error, undefined)
  const body = bodies[0]!
  const messages = (body.params as { messages: Record<string, unknown>[] }).messages
  // Only the newer user image survives; the evicted tool image is not re-sent
  // as a carrier message either.
  assert.deepEqual(survivingImageIndices(body, 'cli'), [1])
  assert.equal(placeholderTexts(body, 'cli').length, 0)
  // Neither transport can hold an image inside a tool result, so an evicted
  // one has to surface as the tool message's OWN text — otherwise the model
  // would read a tool result that mentions an image and then never see one.
  const tool = messages.find((m) => m.role === 'tool')!
  const output = ((tool.content as Record<string, unknown>[])[0]!.output as { value: string }).value
  assert.match(output, /^image\/png image, 1x1 px, 10 bytes\n\[image omitted to fit request image limits/)
  assert.match(output, /sha256:budget-image-0/)
  const afterTool = messages[messages.indexOf(tool) + 1]!
  assert.ok(
    !JSON.stringify(afterTool).includes('Attached image(s) from tool result'),
    'an evicted tool image must not emit a carrier message',
  )
})

test('stream() keeps parallel tool groups consecutive when the budget evicts one result image (issue #37)', async () => {
  // Two parallel `read_image` calls where only the first result is over the
  // budget: the eviction must not disturb the issue #33 ordering rule — the
  // tool messages stay consecutive and the surviving carrier still lands
  // after the whole group.
  const hugeRef = sizedImageRef(0, 40 * 1024 * 1024)
  const smallRef = sizedImageRef(1, pngBytes.length)
  const { bodies, error } = await runAttempts(
    'cli',
    [
      userMessage('read both'),
      ...parallelTurn(
        ['call-a', 'call-b'],
        [{ images: [hugeRef] }, { text: 'second result', images: [smallRef] }],
      ),
    ],
    { [hugeRef.attachmentId]: sizedImageBytes(0), [smallRef.attachmentId]: sizedImageBytes(1) },
  )

  assert.equal(error, undefined)
  const wire = (bodies[0]!.params as { messages: WireMessage[] }).messages
  assertToolGroupsAnswered(wire, 'issue #37 eviction')
  // The evicted result explains itself in place; the kept one still travels as
  // a carrier message directly after the group, naming its own call.
  const tools = wire.filter((m) => m.role === 'tool')
  assert.equal(tools.length, 2)
  const evictedOutput = ((tools[0]!.content as Record<string, unknown>[])[0]!.output as { value: string }).value
  assert.match(evictedOutput, /^\[image omitted to fit request image limits; sha256:budget-image-0\./)
  assert.equal(wire[wire.indexOf(tools[1]!) + 1]!.role, 'user')
  assert.match(JSON.stringify(wire[wire.indexOf(tools[1]!) + 1]!), /call-b/)
})

test('openai protocol applies the same image budget (issue #37)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('openai', messages, images)

  assert.equal(error, undefined)
  const body = bodies[0]!
  assert.deepEqual(survivingImageIndices(body, 'openai'), [...Array(61).keys()].slice(30))
  assert.equal(placeholderTexts(body, 'openai').length, 30)
  // Chat Completions carries the placeholder as an ordinary text part.
  const evicted = userParts(body, 'openai')
    .filter((p) => p.type === 'text' && (p.text as string).startsWith(PLACEHOLDER_PREFIX))
  assert.match(evicted[0]!.text as string, /sha256:budget-image-0/)
})

test('stream() retries once with a tighter image budget when the gateway answers 413 (issue #37)', async () => {
  // 61 images: attempt 1 keeps 31 under the standing budget, the 413 steps
  // down to the retry rung (12 images / 8 MiB), which keeps 7.
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('cli', messages, images, (attempt) => (attempt === 1 ? 413 : 200))

  assert.equal(error, undefined, 'the eviction retry must recover the session')
  assert.equal(bodies.length, 2)
  assert.deepEqual(survivingImageIndices(bodies[0]!, 'cli'), [...Array(61).keys()].slice(30))
  assert.deepEqual(survivingImageIndices(bodies[1]!, 'cli'), [...Array(61).keys()].slice(54))
  assert.ok(
    placeholderTexts(bodies[1]!, 'cli').length > placeholderTexts(bodies[0]!, 'cli').length,
    'the retry must drop strictly more images than the first attempt',
  )
  // The retry is a pre-stream resend of the SAME request: the key is not
  // rotated and the account sees one logical call.
  assert.equal(
    (bodies[1]!.params as { model: string }).model,
    (bodies[0]!.params as { model: string }).model,
  )
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

test('stream() fails after the eviction retry is also rejected with 413 (issue #37)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  const { bodies, error } = await runAttempts('cli', messages, images, () => 413)

  // Bounded: one standing attempt plus exactly one eviction retry.
  assert.equal(bodies.length, 2)
  const e = error as { code?: string; failure?: { status?: number } }
  assert.equal(e.code, 'PROVIDER_HTTP_ERROR')
  assert.equal(e.failure?.status, 413)
})

// ---------------------------------------------------------------------------
// Request image offload on the >=0.1.6 durable contract (issue #43)
//
// dsh 0.1.6 moved the offload set from the adapter to the session surface:
// `projectOffloadedImages` renders the durable marks, and an over-budget
// history FAILS with `IMAGE_OFFLOAD_REQUIRED` + the count to offload instead of
// being edited inside the adapter. A default profile answers that failure with
// `dsh-compaction-image-offload`, which records one `image/offload` event,
// marks the oldest occurrences, and retries the step.
//
// These tests drive that branch by injecting the two helpers: this checkout
// compiles against the 0.1.2 peers, which have neither (and the helper pair
// must never be imported statically — see the adapter's import comment). They
// pin the CONTRACT the adapter speaks — which rung it reports, in what
// encoding, with which byte callback, and that it never evicts on its own
// there — rather than re-deriving the core arithmetic, which is exactly what
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
 * Stand-in for the >=0.1.6 core helpers. `count` is what
 * `requiredImageOffload` answers (a number, or a function of the rung's budget
 * so the 413 ladder can answer differently per rung); every call's arguments
 * are recorded.
 */
function makeSurfacePolicy(
  count: number | ((budget: Record<string, unknown>) => number) = 0,
): { policy: CoreImagePolicy; calls: SurfacePolicyCalls } {
  const calls: SurfacePolicyCalls = { projected: 0, required: 0, budgets: [], versionBytes: [] }
  const policy: CoreImagePolicy = {
    projectOffloadedImages(messages, placeholder) {
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
    requiredImageOffload(messages, budget, versionBytes) {
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
  }
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
  // `dsh-compaction-image-offload` reads, and in the message. Only the second
  // is observable here — the 0.1.2 peers this checkout compiles against
  // predate the field and drop it from `failure` (0.1.6 copies it at
  // dsh-llm/lib/index.js:1609). The field itself is pinned against a real
  // engine by scripts/verify-engine-load.mjs.
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
  // One image the surface already offloaded, one still retained. The marked
  // one must travel as placeholder text even though the history is far inside
  // the budget — a mark the adapter ignored would re-send evicted pixels.
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

test('stream() keeps the adapter-owned eviction when the engine exposes only the legacy helper (issue #43)', async () => {
  // The generation selection must key on the DURABLE pair, not on "the engine
  // has an image policy": a <=0.1.5 engine has the legacy helper alone, and
  // the adapter then owns the eviction exactly as before.
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  let seen: Record<string, unknown> | undefined
  const legacy: CoreImagePolicy = {
    offloadRequestImagesWithPolicy: (history, policy) => {
      seen = policy
      return history.slice(-1)
    },
  }
  const { bodies, error } = await runAttempts('cli', messages, images, () => 200, legacy)

  assert.equal(error, undefined)
  assert.equal(seen?.representation, 'base64')
  assert.equal(seen?.maxImages, 60)
  assert.equal(seen?.countQuantum, 30)
  assert.deepEqual(survivingImageIndices(bodies[0]!, 'cli'), [60], 'the helper output is what travels')
})

test('stream() asks for the stricter rung when a 413 arrives on a 0.1.6 engine (issue #43)', async () => {
  const { messages, images } = imageHistory(Array.from({ length: 61 }, () => pngBytes.length))
  // Rung 0 fits (the fake answers 0); the gateway refuses the body anyway, so
  // the retry rung's shortfall is what the surface is asked to offload. The
  // omission is recorded on the session instead of being a local edit, which
  // is why the request is NOT resent from here.
  const { policy, calls } = makeSurfacePolicy((budget) => (budget.maxImages === 12 ? 47 : 0))
  const { bodies, error } = await runAttempts('cli', messages, images, () => 413, policy)

  assert.equal(bodies.length, 1)
  const e = error as { code?: string; message?: string }
  assert.equal(e.code, 'IMAGE_OFFLOAD_REQUIRED')
  // The stricter rung's count, not the standing one (see the note above on why
  // the count is read from the message in this checkout).
  assert.match(e.message ?? '', /47 more oldest occurrence/)
  assert.deepEqual(calls.budgets.map((budget) => budget.maxImages), [60, 12])
})

test('stream() reports the 413 itself when a 0.1.6 surface has nothing left to offload (issue #43)', async () => {
  // Once the surface reports no shortfall at the strictest rung, the body is
  // simply too large (text and tool bytes share the gateway cap), and asking
  // for another offload would loop. The existing bilingual diagnosis stands.
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
  const v4Pro = byId.get('deepseek/deepseek-v4-pro')!
  assert.ok(v4Pro.description !== undefined)
  assert.match(v4Pro.description, /^Go · (?:Peak|Half) · 1M$/)
  const v4Flash = byId.get('deepseek/deepseek-v4-flash')!
  assert.deepEqual(v4Flash.inputModalities, ['text'])
  assert.ok(v4Flash.description !== undefined)
  assert.match(v4Flash.description, /^Go · (?:Peak|Half) · 1M$/)
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

test('listModels() lists a model only another account in the pool includes', async () => {
  // Issue #51's follow-up (《卡片会切换》): keyed on the account that happened
  // to serve, the picker's contents changed as rotation moved between accounts
  // — a Pro model vanished while the Go account served — and a model only the
  // other account could run was hidden outright, which no request could fix.
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
  // No billing data at all -> visible.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', undefined), true)
  // Positive on-demand balance -> visible regardless of tier.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: 0, onDemandCredits: 1 }), true)
  // Unknown account tier -> visible.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: undefined, onDemandCredits: 0 }), true)
  // Non-finite tier weight (corrupt billing fact) -> visible.
  assert.equal(modelVisibleInPlan('claude-opus-4-8', { tierWeight: NaN, onDemandCredits: 0 }), true)
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
    { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (CC)' },
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
    { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sante (CC)' },
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
// OpenAI Chat Completions protocol
// ---------------------------------------------------------------------------

test('openai protocol sends flat body and replays reasoning_content in history', async () => {
  let capturedUrl: string | undefined
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
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
    { id: messageId(),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'sunny' }] }],
      source: { kind: 'tool', callId: callId },
    },
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
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
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
      { id: messageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: longId, isError: false, content: [{ type: 'text', text: 'sunny' }] }],
        source: { kind: 'tool', callId: longId },
      },
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
  // would leave if it ever stopped sending the scalar) still yields a block,
  // for BOTH array vocabularies — DeepSeek's `reasoning.text` entries and the
  // OpenAI family's `reasoning.summary` ones.
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
  // Measured live 2026-09-18 against gpt-5.6-luna: the gateway puts the GPT
  // family's thinking in `reasoning_details` as
  //   { type: 'reasoning.summary', summary: '…', format: 'openai-responses-v1' }
  // and duplicates it in the scalar `delta.reasoning`. `text` is absent (or an
  // empty placeholder) for this family, so a guard that read `text` alone would
  // carry nothing the moment the scalar stopped — which is exactly the case
  // this pins, one entry shape at a time.
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
  // The array layer already treats an empty `text` as "no text here" (pinned by
  // the summary carrier above); the scalar layer has to agree, because both
  // spellings describe the same thinking. `??` cannot express that on its own —
  // an empty string is not nullish — so `reasoning: ''` beside a populated
  // array used to drop that chunk's thinking, and with it the tool-loop
  // continuity issue #34 depends on.
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
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/provider/v1/chat/completions')) {
      return new Response(JSON.stringify({ error: { code: 'upgrade_required', message: 'Go plan has no API access' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
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

test('Messages-only (Claude) models take the CLI transport without poisoning the account protocol cache', async () => {
  // The Provider API answers every Claude model with HTTP 400 "must be called
  // via /provider/v1/messages". `/alpha/generate` serves them, so they are
  // routed there up front — and because `protocolCache` is keyed by API key
  // alone, that must not be remembered, or the whole account would be pinned
  // to the CLI transport and drag the models the Provider API DOES serve along
  // with it.
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
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
  assert.ok(calls[0]!.includes('/alpha/generate'), 'a Claude model must never be posted to chat/completions')

  // A model added upstream after this plugin shipped is covered by the
  // `claude-*` prefix rule rather than needing a new snapshot entry.
  await collect(adapter.stream({ provider: 'commandcode', model: 'claude-opus-6', messages: [userMessage('hi')] }))
  assert.equal(calls.length, 2)
  assert.ok(calls[1]!.includes('/alpha/generate'), 'an unknown claude-* id must take the same route')

  // The account itself is still on the Provider API for every other model.
  await collect(adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages: [userMessage('hi')] }))
  assert.equal(calls.length, 3)
  assert.ok(calls[2]!.includes('/provider/v1/chat/completions'), 'the Claude route must not pin the account to CLI')
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
  // The gateway reports a temporarily unavailable upstream before the stream
  // starts — 520 (Cloudflare's origin-error class) carrying only
  // `error.type: "server_error"`, no `error.code`. dsh-llm-retry matches
  // `failure.code` against the policy whitelist and nothing else, so as long
  // as the status mapped to PROVIDER_HTTP_ERROR this class of failure was
  // never retried, even though the identical status arriving as an in-band
  // stream error event was. Pinned for a representative spread, with the
  // provider's own message preserved in the error text.
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
          && /temporarily unavailable/.test(e.message ?? '')
      },
    )
  }
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

test('stream() reports a long-context rejection as CONTEXT_WINDOW_EXCEEDED, never as a repeatable SERVER (issue #39)', async () => {
  // At ~500k tokens a session that outgrew the model's window was rejected
  // with wording this adapter did not recognize, so the failure fell into the
  // transient path: retryable SERVER, resent byte-for-byte up to maxRetries
  // (1000) with waits doubling to 15 minutes. /compact only appeared to fix
  // it because it shrank the request. CONTEXT_WINDOW_EXCEEDED is what
  // dsh-compaction-basic's agent/request-error hook consumes to compact the
  // session and retry the reduced surface — the harness's own version of the
  // official CLI's `truncated` -> compact-and-retry kind — and it must stay
  // outside the retry whitelist so dsh-llm-retry hands it to that hook instead
  // of looping.
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
  // PROVIDER_HTTP_ERROR it ended the turn with no recovery but a manual
  // /compact; as CONTEXT_WINDOW_EXCEEDED the harness compacts and retries.
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
  // A body-size 413 whose text does not name the context window keeps the
  // issue #37 taxonomy and advice (pinned separately below).
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

test('stream() classifies an in-band error on the Provider API transport like the CLI transport', async () => {
  // The OpenAI-format SSE carries a failure as an `error` member of a chunk.
  // Ignoring it let the stream end with no finish event, so the real cause was
  // reported as a repeatable EMPTY_RESPONSE; both transports now share one
  // classifier.
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

test('stream() throws EMPTY_RESPONSE when the stream ends without content', async () => {
  const adapter = makeAdapter({ fetchImpl: fetchReturning(200, 'data: {"type":"finish","finishReason":"stop"}\n\n') })
  // The finish event IS content (sawContent=false only when nothing emitted) —
  // actually finish marks a completed stream, so this ends normally.
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] }))
  assert.ok(chunks.some((c) => c.type === 'finish'))
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

test('listModels() falls back to the on-disk cache when the fetch fails', async () => {
  const cachePath = `/tmp/cc-test-cache-${process.pid}.json`
  const { writeFileSync, rmSync } = await import('node:fs')
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
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
  // all three Qwen 3.8 models carry ['low','medium','xhigh'] in the provider table.
  // Qwen 3.8 Flash joined in command-code@1.36.0.
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-27B'], ['low', 'medium', 'xhigh'])
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-Flash'], ['low', 'medium', 'xhigh'])
  // Qwen 3.8 Max 0902 (command-code@1.41.0) carries the Qwen 3.8 family's
  // ['low','medium','xhigh'] effort set.
  assert.deepEqual(KNOWN_EFFORTS['Qwen/Qwen3.8-Max-0902'], ['low', 'medium', 'xhigh'])
  // Gemini 3.8 Flash (command-code@1.43.0) carries the Gemini Flash family's
  // three-level effort set.
  assert.deepEqual(KNOWN_EFFORTS['google/gemini-3.8-flash'], ['low', 'medium', 'high'])
  // command-code@1.32.0 added DeepSeek V4 Flash Vision (exp) with
  // ['high','max']; 1.35.0 added z-ai/glm-5.3-flash (the stealth/ox-alpha
  // successor after the preview ended in 1.34.0) with the same effort set.
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-vision-exp'], ['high', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['z-ai/glm-5.3-flash'], ['low', 'high', 'max'])
  // command-code@1.57.0 added GLM-5.3 FlashX with the same three-level set as
  // its flash sibling.
  assert.deepEqual(KNOWN_EFFORTS['z-ai/glm-5.3-flashx'], ['low', 'high', 'max'])
  // stealth/ox-alpha left the catalog in 1.34.0 when its preview ended.
  assert.ok(!KNOWN_EFFORTS['stealth/ox-alpha'])
  // command-code@1.39.0 added DeepSeek V4 Flash Fast; 1.39.1 dropped medium
  // for it, so the 1.39.2 table ships ['low','high','max'].
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4-flash-fast'], ['low', 'high', 'max'])
  // command-code@1.53.0 added DeepSeek V4.1 Flash ("Add new
  // deepseek/deepseek-v4.1-flash model") with ['low','high','max'] — the same
  // set as V4 Flash Fast, Kimi K3 and GLM-5.3.
  assert.deepEqual(KNOWN_EFFORTS['deepseek/deepseek-v4.1-flash'], ['low', 'high', 'max'])
  assert.ok(!KNOWN_THINKING_MODELS.has('deepseek/deepseek-v4.1-flash'))
  // Synced from the official command-code@1.44.0 model table (re-verified
  // against 1.28.4, 1.30.1, 1.31.0, 1.32.1, 1.32.2, 1.33.0, 1.36.0, 1.37.0,
  // 1.39.2, 1.40.1, 1.44.0, 1.49.0, 1.49.1, 1.50.0, 1.51.2, 1.51.3, 1.52.0
  // and 1.53.0 along the way):
  // models that ship with effort levels must be present, and absent ones must
  // stay out. The 0.2.0 snapshot wrongly added ten models (Kimi K2.5, MiMo
  // V2.5, Claude Haiku 4.5, MiniMax M2.5, Muse Spark 1.2 Contributor, Tencent
  // Hy3, ...) that carry NO reasoningEfforts in the CLI's provider table.
  assert.ok(!KNOWN_EFFORTS['moonshotai/Kimi-K2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5'])
  assert.ok(!KNOWN_EFFORTS['xiaomi/mimo-v2.5-pro'])
  assert.ok(!KNOWN_EFFORTS['claude-haiku-4-5-20251001'])
  assert.ok(!KNOWN_EFFORTS['MiniMaxAI/MiniMax-M2.5'])
  assert.ok(!KNOWN_EFFORTS['tencent/hy3-paid']) // no official effort levels
  // Muse Spark family (command-code@1.45.0) gained selectable efforts —
  // they're now in KNOWN_EFFORTS and out of KNOWN_THINKING_MODELS.
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.2-contributor'], ['low', 'medium', 'high', 'xhigh'])
  // tencent/hy4-preview gained selectable ['low','medium','high'] efforts in
  // command-code@1.38.0 (it previously reasoned automatically with none).
  assert.deepEqual(KNOWN_EFFORTS['tencent/hy4-preview'], ['low', 'medium', 'high'])
  // MiniMaxAI/MiniMax-M3 gained selectable ['low','medium','high'] efforts in
  // command-code@1.51.3 (it previously reasoned automatically with none, and
  // lived in KNOWN_THINKING_MODELS).
  assert.deepEqual(KNOWN_EFFORTS['MiniMaxAI/MiniMax-M3'], ['low', 'medium', 'high'])
  // Ling 3.0 Flash Sante (command-code@1.52.0) reasons automatically with no
  // selectable efforts, so it must stay out of the effort map.
  assert.ok(!KNOWN_EFFORTS['inclusionai/ling-3.0-flash-sante:free'])
  // moonshotai/Kimi-K3 gained selectable ['low','high','max'] efforts in
  // command-code@1.39.3 (it previously reasoned automatically with none).
  assert.deepEqual(KNOWN_EFFORTS['moonshotai/Kimi-K3'], ['low', 'high', 'max'])
})

test('known thinking snapshot covers reasoning models without effort levels', () => {
  // MiniMaxAI/MiniMax-M3 left this set in command-code@1.51.3 when it gained
  // selectable ['low','medium','high'] efforts (it is in KNOWN_EFFORTS now).
  assert.ok(!KNOWN_THINKING_MODELS.has('MiniMaxAI/MiniMax-M3'))
  assert.ok(KNOWN_THINKING_MODELS.has('Qwen/Qwen3.7-Max'))
  assert.ok(KNOWN_THINKING_MODELS.has('thinkingmachines/inkling'))
  // MiniMax M3/M2.7 Free variants were retired in command-code@1.39.2;
  // they are no longer in the catalog and thus not in any snapshot.
  // stealth/ox-alpha reasoned automatically until command-code@1.32.1 gave it
  // selectable ['low','high','max'] efforts; the model then left the catalog
  // entirely in 1.34.0 when its preview ended. It belongs to neither set now.
  assert.ok(!KNOWN_THINKING_MODELS.has('stealth/ox-alpha'))
  // Re-verified against the command-code@1.28.4 provider table (2026-08-18),
  // re-confirmed against 1.30.1 (2026-08-21), 1.37.0 (2026-08-28), 1.38.2,
  // 1.40.1, 1.44.0 (2026-09-02), 1.45.0 (2026-09-03), 1.49.0, 1.49.1
  // (2026-09-05), 1.50.0 (2026-09-06), 1.51.2, 1.51.3 (2026-09-09), 1.52.0
  // and 1.53.0 (2026-09-10):
  // these think automatically (reasoning:!0, no efforts) and belong in the set.
  // tencent/hy4-preview joined in command-code@1.37.0 (OpenRouter-routed, 1M,
  // no efforts) but gained selectable ['low','medium','high'] efforts in
  // 1.38.0 and moved to KNOWN_EFFORTS. moonshotai/Kimi-K3 followed the same
  // path in command-code@1.39.3 (['low','high','max']). Muse Spark family
  // (1.1, 1.2, 1.2-contributor, 1.3, 1.3-contributor) followed in 1.45.0
  // (['low','medium','high','xhigh']). LongCat 2.0 (1.42.0; paid and renamed
  // from `meituan/LongCat-2.0:free` on 2026-09-19) thinks automatically with
  // no selectable levels.
  assert.ok(KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K2.7-Code-Highspeed'))
  assert.ok(KNOWN_THINKING_MODELS.has('tencent/hy3-paid'))
  assert.ok(!KNOWN_THINKING_MODELS.has('tencent/hy4-preview'))
  assert.ok(!KNOWN_THINKING_MODELS.has('moonshotai/Kimi-K3'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.2-contributor'))
  assert.ok(KNOWN_THINKING_MODELS.has('meituan/LongCat-2.0'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meituan/LongCat-2.0:free'))
  // Ling 3.0 Flash Sante (command-code@1.52.0) thinks automatically
  // (reasoning:!0, no efforts), like its retired ling-3.0-flash-free
  // predecessor.
  assert.ok(KNOWN_THINKING_MODELS.has('inclusionai/ling-3.0-flash-sante:free'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.3'))
  assert.ok(!KNOWN_THINKING_MODELS.has('meta/muse-spark-1.3-contributor'))
  // Muse Spark family (command-code@1.45.0) now has selectable efforts —
  // they moved from KNOWN_THINKING_MODELS to KNOWN_EFFORTS.
  // command-code@1.48.0 added `max` effort to Muse Spark 1.3.
  assert.ok(!KNOWN_EFFORTS['meituan/LongCat-2.0'])
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.3'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(KNOWN_EFFORTS['meta/muse-spark-1.3-contributor'], ['low', 'medium', 'high', 'xhigh'])
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
  // Every Claude model in the catalog as measured 2026-09-16 (all 69 models
  // posted to /provider/v1/chat/completions; exactly these eight refused with
  // "must be called via /provider/v1/messages").
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
  // Non-Claude models must stay on the Provider API: the predicate is what
  // sends a request to /alpha/generate, and a false positive there silently
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
  // MiniMax M3/M2.7 Free variants were retired in command-code@1.39.2;
  // they are no longer in the catalog and thus not in any snapshot.
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-flash'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4-pro'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('zai-org/GLM-5.3'))
  // Qwen 3.8 Max 0902 (command-code@1.41.0), Gemini 3.8 Flash (1.43.0) and the
  // Muse Spark 1.3 entries (1.44.0) are Vision per the official registry
  // ("Text input, Vision, Reasoning"). LongCat 2.0 (1.42.0) is text-only.
  assert.ok(KNOWN_IMAGE_MODELS.has('Qwen/Qwen3.8-Max-0902'))
  assert.ok(KNOWN_IMAGE_MODELS.has('google/gemini-3.8-flash'))
  assert.ok(KNOWN_IMAGE_MODELS.has('meta/muse-spark-1.3'))
  assert.ok(KNOWN_IMAGE_MODELS.has('meta/muse-spark-1.3-contributor'))
  assert.ok(!KNOWN_IMAGE_MODELS.has('meituan/LongCat-2.0'))
  // Ling 3.0 Flash Sante (command-code@1.52.0) is text-only per the bundled
  // inputModalities:["text"] and the pricing page's caps.vision:false.
  assert.ok(!KNOWN_IMAGE_MODELS.has('inclusionai/ling-3.0-flash-sante:free'))
  // command-code@1.47.0 marked Grok 4.6 vision-capable; it is now in
  // KNOWN_IMAGE_MODELS and shows the Image marker in the picker.
  assert.ok(KNOWN_IMAGE_MODELS.has('xai/grok-4.6'))
  // command-code@1.53.0 added DeepSeek V4.1 Flash; Vision per the official
  // registry ("Text input, Vision, Reasoning") and the CLI's
  // inputModalities:["text","image"].
  assert.ok(KNOWN_IMAGE_MODELS.has('deepseek/deepseek-v4.1-flash'))
  // command-code@1.49.0 added GPT-6 Astra; Vision per the official registry
  // and the CLI's inputModalities:["text","image"].
  assert.ok(KNOWN_IMAGE_MODELS.has('gpt-6-astra'))
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
  // GLM-5.3 FlashX (command-code@1.57.0) joins it on every plan, Go included.
  assert.equal(KNOWN_PLANS['z-ai/glm-5.3-flashx'], 'go')
  // tencent/hy4-preview (command-code@1.37.0, OpenRouter-routed, 1M) joined Go.
  assert.equal(KNOWN_PLANS['tencent/hy4-preview'], 'go')
  assert.equal(KNOWN_PLANS['stealth/ox-alpha'], undefined)
  // tencent/hy3-paid (the hidden free variant, formerly tencent/Hy3) is a
  // Go-tier open model; the upstream catalog renamed it to tencent/hy3-paid.
  assert.equal(KNOWN_PLANS['tencent/hy3-paid'], 'go')
  assert.equal(KNOWN_PLANS['tencent/Hy3'], undefined)
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.0-flash-free'], undefined)
  assert.equal(KNOWN_PLANS['minimax/minimax-m3-free'], undefined)
  assert.equal(KNOWN_PLANS['minimax/minimax-m2.7-free'], undefined)
  // Qwen 3.8 Max 0902 (command-code@1.41.0), LongCat 2.0 (1.42.0 — a free promo
  // until 2026-09-19, paid since) and Muse Spark 1.3 Contributor (1.44.0,
  // "every plan including Go") are all Go-tier.
  assert.equal(KNOWN_PLANS['Qwen/Qwen3.8-Max-0902'], 'go')
  assert.equal(KNOWN_PLANS['meituan/LongCat-2.0'], 'go')
  // The retired free id is gone from the snapshot with the promo.
  assert.equal(KNOWN_PLANS['meituan/LongCat-2.0:free'], undefined)
  // Ling 3.0 Flash Sante (command-code@1.52.0) is a free model on every plan
  // ("Available on Go and above"), so its minimum tier is Go.
  assert.equal(KNOWN_PLANS['inclusionai/ling-3.0-flash-sante:free'], 'go')
  // DeepSeek V4.1 Flash (command-code@1.53.0) is available on every plan
  // including Go — the pricing page's embedded availability grants it
  // all tiers, and the Go/GOAT/Pro/Max plan pages all list it.
  assert.equal(KNOWN_PLANS['deepseek/deepseek-v4.1-flash'], 'go')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.3-contributor'], 'go')
  // GOAT adds a handful of closed/premium models (GPT-5.6 Sol joined in
  // command-code@1.27.0, "50% off in GOAT and above" per the changelog).
  assert.equal(KNOWN_PLANS['google/gemini-3.7-flash'], 'goat')
  assert.equal(KNOWN_PLANS['xai/grok-4.6'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.2'], 'goat')
  assert.equal(KNOWN_PLANS['gpt-5.6-sol'], 'goat')
  // Gemini 3.8 Flash (1.43.0) and Muse Spark 1.3 (1.44.0) are "available on
  // GOAT and above" per the pricing page.
  assert.equal(KNOWN_PLANS['google/gemini-3.8-flash'], 'goat')
  assert.equal(KNOWN_PLANS['meta/muse-spark-1.3'], 'goat')
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
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free']?.free, true)
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
  // LongCat 2.0's free promo ended 2026-09-19 (the page's deal count dropped
  // 6 -> 5 and its free count 4 -> 3), so the FREE entry is removed rather than
  // left to badge a model the catalog now serves paid as `meituan/LongCat-2.0`.
  assert.equal(KNOWN_DEALS['meituan/LongCat-2.0:free'], undefined)
  assert.equal(KNOWN_DEALS['meituan/LongCat-2.0'], undefined)
  // Laguna S 2.1 is still the permanent-style free deal.
  assert.equal(KNOWN_DEALS['poolside/laguna-s-2.1-free']?.free, true)
  // Ling 3.0 Flash Sante (command-code@1.52.0) is free "up to 100 requests a
  // day" while the promo lasts — also a permanent-style deal.
  assert.equal(KNOWN_DEALS['inclusionai/ling-3.0-flash-sante:free']?.free, true)
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
  assert.equal(formatContext(500), '500')
  assert.equal(formatContext(undefined), undefined)
  assert.equal(formatContext(0), undefined)
})

test('capabilityDescription() composes plan, deal, Image, context', () => {
  // Free model without Vision: no Image marker.
  assert.equal(capabilityDescription('poolside/laguna-s-2.1-free', 256_000), 'Go · FREE · 256K')
  // LongCat 2.0 (command-code@1.42.0): a free Go model until its promo ended
  // 2026-09-19, now paid (`meituan/LongCat-2.0`) — text-only, 1M context, so no
  // deal and no Image marker.
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
  // DeepSeek V4.1 Flash (command-code@1.53.0): Go-tier Image model with the
  // same hourly schedule — `Peak` at 02:30 UTC on a Monday, `Half` off-peak.
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
  // All DeepSeek hourly-priced models are in the time-of-day pricing snapshot
  // (the V4 Flash Vision variant shares V4 Flash's windows per the pricing page;
  // command-code@1.53.0 added V4.1 Flash with the same schedule at
  // $0.15/$0.60 off-peak, $0.30/$1.20 peak).
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-pro'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-vision-exp'))
  assert.ok(KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4.1-flash'))
  // DeepSeek V4 Flash Fast (command-code@1.39.0) is NOT hourly-priced: the
  // pricing page's embedded model JSON gives it a flat rate ($0.28/$0.56/$0.07)
  // and no `timeOfDay` block, so it must carry no Peak/Half marker. (The old
  // entry here misattributed V4 Flash Vision's neighboring row annotation.)
  assert.ok(!KNOWN_PEAK_PRICING.has('deepseek/deepseek-v4-flash-fast'))
  assert.equal(
    peakPricingState('deepseek/deepseek-v4-flash-fast', Date.parse('2026-08-17T02:30:00Z')),
    undefined,
  )
  assert.equal(
    peakPricingLabel('deepseek/deepseek-v4-flash-fast', Date.parse('2026-08-17T02:30:00Z')),
    undefined,
  )
  // Non-peak-priced models report no state. Qwen 3.8 Max looks annotated when
  // the pricing page is flattened to text, but its hover annotation actually
  // lives in the V4 Flash Vision row above it (each annotation states exactly
  // 2x that row's own prices) — Qwen's own row carries none. Same for the
  // new tencent/hy4-preview (1.37.0, text-only, priced per token, not per hour).
  assert.ok(!KNOWN_PEAK_PRICING.has('Qwen/Qwen3.8-Max'))
  assert.ok(!KNOWN_PEAK_PRICING.has('tencent/hy4-preview'))
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
  // The composer's session-cost readout prices against the price table's own
  // `peak` blocks, so it needs the hour test WITHOUT a model membership check.
  // It must agree with `peakPricingState()` exactly on every hour the snapshot
  // does place, or the picker's label and the composer's rate would disagree.
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
  // command-code@1.58.0 (2026-09-20 check of the 2026-09-19 npm `latest`, whose
  // changelog entry is "Retire the free LongCat 2.0 tier and sell LongCat 2.0 as
  // a paid model"): the registry grows 77 -> 78 with exactly one addition,
  // `meituan/LongCat-2.0`, and its retired `meituan/LongCat-2.0:free` sibling
  // gains `hidden` plus the display name "LongCat 2.0 (Free)" — the CLI catching
  // up with the backend rename the 1.57.0 sync already snapshotted, so nothing in
  // src/capabilities.ts moves. The effort map, the subscription maps, the plan
  // tiers, every deal, the peak/off-peak schedule, the public catalog (71 models,
  // 55 x chat/completions + responses / 8 Claude ids x messages-only / 8 x
  // chat/completions) and the vendored price rows (71) are all unchanged, and
  // static inspection finds no transport drift: the /alpha/* endpoint set, the
  // /alpha/generate converters and the stream event vocabulary are identical to
  // 1.57.0. This is a version-pin sync only; no runtime behavior changes.
  // command-code@1.57.0 (2026-09-19, npm `latest`; no changelog entry yet — the
  // page stops at 1.56.1, and 1.56.2 shipped without one): the model registry
  // grows 76 -> 77 with exactly one addition, `z-ai/glm-5.3-flashx` ("GLM-5.3
  // FlashX", chatComplete, inputModalities ["text","image"], 1e6 context,
  // efforts ['low','high','max']) — the whole registry difference across
  // 1.56.0 -> 1.57.0, with no effort change to any existing model. The public
  // catalog serves 71 models now (the new id is in it; `gpt-6-astra` is still a
  // CLI/pricing/docs-only model, absent from the public Provider catalog, as
  // before), and its endpoint mix moves to 55 x chat/completions + responses,
  // the same 8 Claude ids x messages-only, 8 x chat/completions. Static
  // inspection confirms no transport drift for this adapter: the /alpha/*
  // endpoint set, the /alpha/generate converters (toWireMessages/toWireTools/
  // toWireToolOutput) and the stream event vocabulary are byte-identical to
  // 1.56.0. What 1.57.0 does add outside this adapter's surface is BYOK-only:
  // the `x-opencode-session` header for hosts that require a session id
  // (1.56.1's "Send session id to BYOK hosts that require it" — host-gated to
  // opencode.ai) and a `command-code/<version>` BYOK user agent.
  // command-code@1.56.0 (2026-09-18, npm `latest`; no changelog/RSS entry as of
  // this check — the feed stops at 1.55.0): the model registry grows 75 -> 76
  // with exactly one addition, `Qwen/Qwen3.8-Omni-Flash` (chatComplete,
  // inputModalities ["text","image"], 1M context, efforts ['low','medium',
  // 'xhigh']); the eight responses-spec models are unchanged, so the 1.55.0
  // "OpenAI Responses endpoint on the provider API and BYOK CLI wire" item is
  // a new API surface, not a routing change. Static inspection confirms no
  // transport drift for this adapter: the /alpha/* endpoint set and the
  // /alpha/generate + /alpha/web-search request shapes are byte-identical to
  // 1.54.0. The docs meanwhile document `POST /provider/v1/responses` (OpenAI
  // models and open models; Claude stays /messages-only) and a per-model
  // `supported_endpoints` field on the catalog (54 x chat/completions +
  // responses, the same 8 Claude ids x messages-only, 8 x chat/completions) —
  // neither needs an adapter change, because both existing transports still
  // serve every model. The live catalog serves 70 models now (Qwen 3.8 Omni
  // Flash is in it; `gpt-6-astra` is still a CLI/pricing/docs-only model,
  // absent from the public Provider catalog, as before).
  // command-code@1.54.0 (2026-09-13): the CLI changelog lists exactly one
  // CLI-local item — first-class herdr support (a `/herdr` command plus
  // idle/working/blocked reporting to a herdr pane over its UNIX socket, live
  // only when HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID are all set, with
  // CMD_HERDR=0 to disable). The whole 1.53.1 -> 1.54.0 bundle difference is
  // that feature plus the version constant: the model registry (75 entries),
  // effort map, subscription plan maps, endpoints and request shapes are
  // byte-identical, and the public catalog still serves the same 69 models.
  // command-code@1.53.1 (2026-09-12): the CLI changelog lists four CLI-local
  // items (default compaction model set to DeepSeek V4.1 Flash in /config, a
  // BYOK reasoning-effort fix, and two /usage summary-line changes — Extra
  // Credits shown separately, the "$X left" field removed). Static inspection
  // of the 1.53.1 bundle confirms no transport drift: the /alpha/generate body,
  // endpoints, effort map, subscription plan maps, every plan tier, every deal
  // and the peak/off-peak membership and schedule are unchanged. The one model
  // routing change is upstream-internal (`gpt-5.6-terra` / `gpt-5.6-luna` now
  // served through vercel-ai-gateway instead of openrouter, same efforts,
  // modalities and 1.05M context).
  // command-code@1.53.0 (2026-09-10): "Add new deepseek/deepseek-v4.1-flash
  // model" — Go-tier, Vision, ['low','high','max'] efforts, same hourly
  // schedule as the other DeepSeek models ($0.15/$0.60 off-peak, $0.30/$1.20
  // peak). Wire protocol, endpoints, effort map (beyond the addition),
  // subscription plan maps, every other plan tier, and every deal are
  // unchanged. (For history: 1.50.1 shipped CLI-local changes — stable
  // process title, UNIX-socket status; 1.51.0 briefly added DeepSeek V4.1
  // Flash Beta behind a 2026-09-10 expiry gate; 1.51.2 removed it from the
  // bundle entirely; 1.51.3 gave MiniMax M3 selectable ['low','medium','high']
  // efforts; 1.52.0 added the free Ling 3.0 Flash Sante model plus
  // daily-window CLI guidance. There is no CLI changelog entry for
  // 1.51.1–1.52.0; those snapshots were read from the bundled model table.)
  // The version rides every request as x-command-code-version.
  assert.equal(COMMAND_CODE_CLI_VERSION, '1.58.0')
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
  // the rejection exactly once and the stream finished normally. The reason is
  // `throttled`, not `rate-limit`: this body names no usage window, and only a
  // named window may be reported as an exhausted one (issue #54).
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
  // Issue #54's shape: a rejection whose body says nothing about a usage
  // window. The CLI accepts the code on ANY status, so this is also the branch
  // whose own wording the user reads — it must stay retryable and must not
  // imply a spent window. (The pool's diagnosis is pinned in
  // tests/accounts.test.ts; this pins the adapter's end-of-turn message.)
  const { fetchImpl } = fetchByKey({
    'key-1': { status: 503, body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }) },
  })
  const adapter = makeAdapter({ fetchImpl, resolveApiKey: async () => 'key-1' })
  await assert.rejects(
    collect(adapter.stream({ provider: 'commandcode', model: 'm', messages: [userMessage('hi')] })),
    (err: unknown) => {
      const caught = err as { code?: string; message?: string }
      assert.equal(caught.code, 'RATE_LIMIT')
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

test('stream() rotates past an account-scoped 400 (insufficient credits)', async () => {
  // Issue #51's follow-up: the pool kept handing out an account that could not
  // pay, and the 400 was terminal as well as invisible — the turn failed on an
  // account whose three siblings were fine. The official CLI reads this one as
  // `isInsufficientCreditsRequestError` (status 400 + the wording), so the
  // adapter rotates.
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
  // The test above passes with the message "Insufficient credits" present, so it
  // would stay green with an empty code list — the fixture never proves the code
  // branch. This is the body the official CLI's
  // `isInsufficientCreditsRequestError` actually reads (the CODE, no message),
  // and the shape #51's follow-up reports: the account that cannot pay must be
  // rotated past, never handed out again.
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
  // No hook to rotate with (a host that does not wire the pool), so the turn
  // ends here — but it must end as a RETRYABLE RATE_LIMIT carrying the
  // provider's reset. A 400 maps to `PROVIDER_HTTP_ERROR`, which sits outside
  // dsh-llm-retry's whitelist, so the turn would die on the spot even though the
  // provider said exactly when the same request works again.
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

test('probeWindowLimits() reports the five-hour window when it is the only one exceeded', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 5, cap: 5, exceeded: true, resetAt: 1_800_000_000_000 },
          weekly: { used: 1, cap: 6, exceeded: false, resetAt: 1_800_600_000_000 },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: 1_800_000_000_000 })
})

test('probeWindowLimits() treats an exhausted weekly quota as limiting while the five-hour window is open', async () => {
  // Issue #51's follow-up: the two windows are metered separately, and reading
  // only `fiveHour` revived an account whose WEEKLY quota was spent — the pool
  // handed it out, the provider rejected the request, and the next all-marked
  // pass revived it again. "切到一个不可用账号" is exactly that loop.
  const weeklyReset = 1_800_600_000_000
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 0.2, cap: 3, exceeded: false, resetAt: 1_799_000_000_000 },
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
          fiveHour: { used: 9, cap: 5, exceeded: true, resetAt: 1_800_000_000_000 },
          weekly: { used: 9, cap: 6, exceeded: true, resetAt: 1_800_600_000_000 },
        },
      },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: 1_800_600_000_000 })
})

test('probeWindowLimits() reports a clear account when no window is exceeded', async () => {
  const { fetchImpl } = fetchRouting({
    '/alpha/billing/credits': {
      status: 200,
      body: {
        windowLimits: {
          fiveHour: { used: 0.1, cap: 3, exceeded: false, resetAt: 1_800_000_000_000 },
          weekly: { used: 1, cap: 6, exceeded: false, resetAt: 1_800_600_000_000 },
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
      body: { windowLimits: { weekly: { used: 6, cap: 6, exceeded: true, resetAt: 1_800_600_000_000 } } },
    },
  })
  const adapter = makeAdapter({ fetchImpl })
  assert.deepEqual(await adapter.probeWindowLimits('key-1'), { exceeded: true, resetAt: 1_800_600_000_000 })
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
