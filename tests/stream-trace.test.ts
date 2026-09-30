/**
 * Raw-stream trace tests (`src/stream-trace.ts` + its adapter wiring).
 *
 * The trace is the diagnostic for "the response stopped in the middle and
 * nothing said why": it is the only artifact that separates a provider-side cut
 * from a parser miss. These pin that it stays free when off, that it never takes
 * the request down with it, and that its records describe a cut.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  boundTraceText,
  openStreamTrace,
  resolveStreamTracePath,
  STREAM_TRACE_DEFAULT_FILE,
  STREAM_TRACE_ENV,
  STREAM_TRACE_MAX_BYTES,
  STREAM_TRACE_MAX_TEXT,
} from '../src/stream-trace.ts'
import { CommandCodeAdapter, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'
import { BlockAssembler, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { CommandCodeConnectionOptions } from '../src/adapter.ts'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

/** A throwaway directory removed with the test that made it. */
function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-trace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Read a trace file back as records. */
function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Run one task with the trace variable set, restoring the environment after. */
async function withTraceEnv<T>(value: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const previous = process.env[STREAM_TRACE_ENV]
  if (value === undefined) delete process.env[STREAM_TRACE_ENV]
  else process.env[STREAM_TRACE_ENV] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[STREAM_TRACE_ENV]
    else process.env[STREAM_TRACE_ENV] = previous
  }
}

// Switch resolution

test('the trace is off unless the environment names it', () => {
  assert.equal(resolveStreamTracePath(undefined), undefined)
  assert.equal(resolveStreamTracePath(''), undefined)
  assert.equal(resolveStreamTracePath('   '), undefined)
  // A bare flag means "somewhere sensible", not "a file called 1".
  for (const flag of ['1', 'true', 'YES', 'On']) {
    assert.equal(resolveStreamTracePath(flag), join(tmpdir(), STREAM_TRACE_DEFAULT_FILE))
  }
  // Explicit off-spellings disable rather than becoming a file name: `false`
  // used to switch the trace ON and write the conversation to ./false.
  for (const off of ['0', 'false', 'FALSE', 'no', 'off', ' off ']) {
    assert.equal(resolveStreamTracePath(off), undefined)
  }
  assert.equal(resolveStreamTracePath('/tmp/x.jsonl'), '/tmp/x.jsonl')
  assert.equal(resolveStreamTracePath('  /tmp/x.jsonl  '), '/tmp/x.jsonl')
})

test('boundTraceText keeps short text and marks what it dropped', () => {
  assert.equal(boundTraceText('hello', 10), 'hello')
  assert.equal(boundTraceText('hello', 5), 'hello')
  assert.equal(boundTraceText('hello world', 5), 'hello…[+6 chars]')
  assert.equal(boundTraceText('x'.repeat(STREAM_TRACE_MAX_TEXT + 4)).endsWith('…[+4 chars]'), true)
})

// Writer

test('an unset switch yields an inert writer', () => {
  const trace = openStreamTrace('commandcode/m')
  assert.equal(trace.enabled, false)
  // Both members are safe to call on the disabled stand-in.
  trace.record('anything', { a: 1 })
  trace.close()
})

test('records are JSONL in arrival order, stamped with elapsed milliseconds', (t) => {
  const dir = scratch(t)
  const path = join(dir, 'nested', 'trace.jsonl')
  let clock = 1_000
  const trace = openStreamTrace('commandcode/deepseek', { path, now: () => clock })
  assert.equal(trace.enabled, true)
  assert.equal(records(path)[0]!.event, 'stream-open')
  clock = 1_250
  trace.record('chunk', { n: 1, text: 'hi' })
  clock = 9_999
  trace.close()
  const written = records(path)
  assert.deepEqual(written.map((r) => r.event), ['stream-open', 'chunk', 'stream-close'])
  assert.deepEqual(written.map((r) => r.at), [0, 250, 8999])
  assert.equal(written[1]!.scope, 'commandcode/deepseek')
  assert.equal(written[1]!.n, 1)
  assert.equal(written[1]!.text, 'hi')
  assert.equal(typeof written[2]!.bytes, 'number')
})

test('a trace that cannot be written disables itself instead of throwing', (t) => {
  const dir = scratch(t)
  // A path whose parent is a FILE cannot be prepared, so the writer degrades.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const trace = openStreamTrace('commandcode/m', { path: join(blocker, 'trace.jsonl') })
  assert.equal(trace.enabled, false)
  trace.record('chunk', { text: 'x' })
  trace.close()
})

test('an unserializable payload drops that record only', (t) => {
  const dir = scratch(t)
  const path = join(dir, 'trace.jsonl')
  const trace = openStreamTrace('commandcode/m', { path })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  trace.record('bad', cyclic)
  trace.record('good', { ok: true })
  assert.deepEqual(records(path).map((r) => r.event), ['stream-open', 'good'])
})

test('one request cannot write past the cap', (t) => {
  const dir = scratch(t)
  const path = join(dir, 'trace.jsonl')
  const trace = openStreamTrace('commandcode/m', { path })
  const payload = 'x'.repeat(64 * 1024)
  for (let i = 0; i < Math.ceil(STREAM_TRACE_MAX_BYTES / payload.length) + 4; i += 1) {
    trace.record('chunk', { text: payload })
  }
  const written = records(path)
  assert.equal(written[written.length - 1]!.event, 'trace-capped')
  assert.equal(written[written.length - 1]!.scope, 'commandcode/m')
  // Payload stops, but bounded terminal metadata survives a long generation.
  trace.record('after', {})
  trace.record('end', { outcome: 'output-token-limit', finishReason: 'length' })
  trace.close()
  trace.close()
  assert.deepEqual(records(path).slice(written.length).map(record => record.event), ['end', 'stream-close'])
  assert.equal(records(path).at(-2)?.finishReason, 'length')
})

// Adapter wiring

/** A fetch stub answering with one canned SSE body. */
function fetchStreaming(body: string): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }), { status: 200 })) as unknown as typeof fetch
}

function makeAdapter(fetchImpl: typeof fetch, protocol: 'cli' | 'openai' = 'cli'): CommandCodeAdapter {
  const options = (): CommandCodeConnectionOptions => ({
    apiBase: 'https://api.commandcode.ai',
    workingDir: '/tmp/project',
    modelsCachePath: '/tmp/cc-models-cache.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    protocol,
  })
  return new CommandCodeAdapter({
    options,
    resolveApiKey: async () => 'user_test_key',
    fetchImpl,
  })
}

async function drain(adapter: CommandCodeAdapter): Promise<StreamChunk[]> {
  const message: Message = {
    id: MessageId('msg-1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }
  const out: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'm', messages: [message] })) {
    out.push(chunk)
  }
  return out
}

test('the environment switch records a completed stream end to end', async (t) => {
  const dir = scratch(t)
  const path = join(dir, 'trace.jsonl')
  await withTraceEnv(path, async () => {
    const chunks = await drain(makeAdapter(fetchStreaming(
      'data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n',
    )))
    assert.ok(chunks.some((c) => c.type === 'finish'))
  })
  const written = records(path)
  assert.deepEqual(
    written.map((r) => r.event),
    ['stream-open', 'request', 'response', 'chunk', 'end', 'stream-close'],
  )
  const request = written[1]!
  assert.equal(request.protocol, 'cli')
  assert.equal(request.model, 'm')
  assert.equal(request.messages && (request.messages as { count: number }).count, 1)
  assert.match(String((request.body as { sha256: string }).sha256), /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(request).includes('hi'), false)
  const response = written[2]!
  assert.equal(response.protocol, 'cli')
  assert.equal(response.endpoint, 'https://api.commandcode.ai/alpha/generate')
  assert.equal(response.status, 200)
  assert.equal(written[3]!.text, 'data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n')
  assert.equal(written[4]!.outcome, 'finished')
  assert.equal(written[4]!.sawContent, true)
})

test('a pre-stream failure records the request fingerprint and closes the trace', async (t) => {
  const path = join(scratch(t), 'trace.jsonl')
  const fetchImpl = (async () => new Response('upstream unavailable', { status: 503 })) as unknown as typeof fetch
  await withTraceEnv(path, async () => {
    await assert.rejects(drain(makeAdapter(fetchImpl)))
  })
  const written = records(path)
  assert.deepEqual(written.map((r) => r.event), ['stream-open', 'request', 'response', 'connect-error', 'stream-close'])
  assert.equal(JSON.stringify(written[1]).includes('hi'), false)
  assert.equal(written[2]!.status, 503)
  assert.match(String(written[3]!.message), /上游服务暂时无法完成请求/)
})

test('disabled tracing does not serialize request values for fingerprints', async () => {
  let serializations = 0
  await withTraceEnv('off', async () => {
    const adapter = makeAdapter(fetchStreaming('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'))
    for await (const _ of adapter.stream({
      provider: 'commandcode', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'read', description: 'read', parameters: {
        type: 'object', toJSON() { serializations++; return { type: 'object' } },
      } }],
    })) { /* drain */ }
  })
  assert.equal(serializations, 1, 'only the HTTP body should be serialized')
})

test('protocol fallback records each attempt and retains only the successful response IDs', async (t) => {
  const path = join(scratch(t), 'fallback.jsonl')
  let calls = 0
  const adapter = makeAdapter((async () => {
    calls++
    return calls === 1
      ? new Response('{"error":{"code":"upgrade_required"}}', { status: 403, headers: { 'x-request-id': 'rejected-1' } })
      : new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', {
        headers: { 'x-request-id': 'accepted-2', 'set-cookie': 'PRIVATE COOKIE' },
      })
  }) as typeof fetch, 'openai')
  let chunks: StreamChunk[] = []
  await withTraceEnv(path, async () => { chunks = await drain(adapter) })
  const written = records(path)
  assert.deepEqual(written.filter((r) => r.event === 'request').map((r) => [r.attempt, r.protocol]), [[1, 'openai'], [2, 'cli']])
  assert.deepEqual(written.filter((r) => r.event === 'response').map((r) => [r.attempt, r.status, r.headers]), [
    [1, 403, { 'x-request-id': 'rejected-1' }], [2, 200, { 'x-request-id': 'accepted-2' }],
  ])
  assert.equal(new Set(written.map((r) => r.streamId)).size, 1)
  const finish = chunks.find((c) => c.type === 'finish')!
  assert.deepEqual(finish.replayState, { response: { protocol: 'cli', headers: { 'x-request-id': 'accepted-2' } } })
  assert.equal(JSON.stringify(written).includes('PRIVATE COOKIE'), false)
})

test('request IDs survive HTTP rejection and a cut stream in the durable failure', async () => {
  for (const cut of [false, true]) {
    const adapter = makeAdapter((async () => new Response(cut
      ? 'data: {"type":"text-delta","text":"half"}\n\n' : 'unavailable', {
      status: cut ? 200 : 503, headers: { 'x-request-id': 'failed-request' },
    })) as typeof fetch)
    await withTraceEnv('off', async () => {
      await assert.rejects(drain(adapter), (error: unknown) => {
        assert.ok(error instanceof LlmError)
        assert.equal(error.code, cut ? 'STREAM_CLOSED' : 'SERVER')
        assert.equal(error.failure.requestId, 'failed-request')
        if (!cut) assert.equal(error.failure.status, 503)
        return true
      })
    })
  }
})

for (const protocol of ['cli', 'openai'] as const) {
  test(`${protocol}: request fingerprints locate the first changed historical message`, async (t) => {
    const path = join(scratch(t), 'prefix.jsonl')
    const response = protocol === 'cli'
      ? 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
      : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
    const adapter = makeAdapter(fetchStreaming(response), protocol)
    const options: GenerateOptions = {
      provider: 'commandcode', model: 'm', system: 'PRIVATE SYSTEM',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE FIRST' }] }],
      tools: [{ name: 'read', description: 'PRIVATE TOOL', parameters: { type: 'object' } }],
    }
    await withTraceEnv(path, async () => {
      for await (const _ of adapter.stream(options)) { /* drain */ }
      options.messages.push({ role: 'user', content: [{ type: 'text', text: 'PRIVATE SECOND' }] })
      for await (const _ of adapter.stream(options)) { /* drain */ }
      options.messages[0] = { role: 'user', content: [{ type: 'text', text: 'PRIVATE REPLACEMENT' }] }
      for await (const _ of adapter.stream(options)) { /* drain */ }
    })
    const requests = records(path).filter((r) => r.event === 'request')
    assert.equal(requests[0]!.model, 'm')
    assert.equal((requests[0]!.tools as { count: number }).count, 1)
    assert.deepEqual(requests[0]!.system, requests[1]!.system)
    assert.deepEqual(requests[0]!.tools, requests[1]!.tools)
    const messages = requests.map((r) => r.messages as { count: number; items: unknown[] })
    const initial = protocol === 'cli' ? 1 : 2 // OpenAI carries its system as a message.
    assert.equal(messages[0]!.count, initial)
    assert.equal(messages[1]!.count, initial + 1)
    assert.deepEqual(messages[1]!.items.slice(0, initial), messages[0]!.items)
    assert.notDeepEqual(messages[2]!.items[initial - 1], messages[1]!.items[initial - 1])
    assert.deepEqual(messages[2]!.items[initial], messages[1]!.items[initial])
    assert.equal(JSON.stringify(requests).includes('PRIVATE'), false)
    assert.equal(new Set(requests.map((r) => r.streamId)).size, 3)
  })

  test(`${protocol}: response identifiers survive DSH assembly with tracing off`, async () => {
    const response = protocol === 'cli'
      ? 'data: {"type":"response-metadata","id":"generation-1"}\n\ndata: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
      : 'data: {"id":"generation-1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
    const adapter = makeAdapter((async () => new Response(response, { headers: {
      'x-request-id': 'request-1', 'x-trace-id': 'trace-1', 'set-cookie': 'PRIVATE COOKIE',
    } })) as typeof fetch, protocol)
    const assembly = new BlockAssembler()
    await withTraceEnv('off', async () => {
      for (const chunk of await drain(adapter)) assembly.push(chunk)
    })
    // The real loop explicitly copies the assembler's envelope onto source.
    const message = assembly.message({ provider: 'commandcode', model: 'm', replayState: assembly.replayState })
    assert.deepEqual(message.source.replayState, { response: {
      protocol, headers: { 'x-request-id': 'request-1', 'x-trace-id': 'trace-1' }, responseId: 'generation-1',
    } })
    assert.equal(JSON.stringify(message).includes('PRIVATE COOKIE'), false)
  })
}

test('a cut stream records why it was classified as cut', async (t) => {
  const dir = scratch(t)
  const path = join(dir, 'trace.jsonl')
  await withTraceEnv(path, async () => {
    await assert.rejects(drain(makeAdapter(fetchStreaming('data: {"type":"text-delta","text":"half"}\n\n'))))
  })
  const written = records(path)
  const eof = written.find((r) => r.event === 'eof')!
  assert.equal(eof.finishSeen, false)
  const end = written.find((r) => r.event === 'end')!
  assert.equal(end.outcome, 'stream-closed')
  assert.equal(end.sawContent, true)
  // The trace closes even on the failure path — that is the record a reporter
  // sends, so it must not be missing exactly when it matters.
  assert.equal(written[written.length - 1]!.event, 'stream-close')
})

test('an untouched process writes no trace anywhere', () => {
  assert.equal(process.env[STREAM_TRACE_ENV], undefined)
  assert.equal(openStreamTrace('commandcode/m').enabled, false)
})

for (const protocol of ['cli', 'openai'] as const) {
  for (const reason of ['stop', 'length']) {
    test(`${protocol}: trace distinguishes reasoning-only ${reason} from success and a cut`, async (t) => {
      const path = join(scratch(t), 'trace.jsonl')
      const events = protocol === 'cli' ? [
        { type: 'reasoning-delta', text: 'thinking' },
        { type: 'finish', finishReason: reason, totalUsage: { outputTokens: 8, outputTokenDetails: { reasoningTokens: 8 } } },
      ] : [
        { choices: [{ delta: { reasoning: 'thinking' } }] },
        { choices: [{ delta: {}, finish_reason: reason }], usage: { completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 8 } } },
      ]
      await withTraceEnv(path, async () => {
        await assert.rejects(drain(makeAdapter(fetchStreaming(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), protocol)))
      })
      const ends = records(path).filter(record => record.event === 'end')
      assert.equal(ends.length, 1)
      assert.equal(ends[0]!.outcome, reason === 'length' ? 'output-token-limit' : 'empty')
      assert.equal(ends[0]!.finishReason, reason)
      assert.equal(ends[0]!.sawContent, false)
      assert.equal((ends[0]!.usage as { reasoningTokens: number }).reasoningTokens, 8)
      assert.equal(records(path).at(-1)?.event, 'stream-close')
    })
  }
}
