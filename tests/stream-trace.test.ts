/**
 * Raw-stream trace tests (`src/stream-trace.ts` + its adapter wiring).
 *
 * The trace is the diagnostic this plugin gained for "the response stopped in
 * the middle and nothing said why": it is the only artifact that separates a
 * provider-side cut from a parser miss. These tests pin that it stays free when
 * off, that it never takes the request down with it, and that the records it
 * writes actually describe a cut — the adapter-side assertions drive a real
 * `stream()` through both endings.
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
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { CommandCodeConnectionOptions } from '../src/adapter.ts'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'

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

// ---------------------------------------------------------------------------
// Switch resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Adapter wiring
// ---------------------------------------------------------------------------

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
    ['stream-open', 'response', 'chunk', 'end', 'stream-close'],
  )
  const response = written[1]!
  assert.equal(response.protocol, 'cli')
  assert.equal(response.endpoint, 'https://api.commandcode.ai/alpha/generate')
  assert.equal(response.status, 200)
  assert.equal(written[2]!.text, 'data: {"type":"text-delta","text":"hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n')
  assert.equal(written[3]!.outcome, 'finished')
  assert.equal(written[3]!.sawContent, true)
})

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
