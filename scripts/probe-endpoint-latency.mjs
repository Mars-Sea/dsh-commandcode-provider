/**
 * Compare Command Code generation endpoints through this plugin's adapter.
 *
 * The adapter builds the CLI and Chat Completions requests. For Responses, its
 * fetch seam converts the already-built Chat request into Responses format and
 * converts Responses stream events back into Chat events for the same adapter.
 * This measures the real endpoint, while keeping one synthetic conversation,
 * model, effort, output cap, API key, and timeout across the three routes.
 * The Responses bridge is experimental test code, not a product implementation.
 *
 * BENCH_DRY_RUN=1 node --import tsx scripts/probe-endpoint-latency.mjs
 * BENCH_ROUNDS=3 node --import tsx scripts/probe-endpoint-latency.mjs
 *
 * Results contain timings, counts, status, and request IDs only. No key, raw
 * conversation, request body, or response text is saved.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { CommandCodeAdapter, resolveAuthFileApiKey } from '../src/adapter.ts'

const MODEL = 'deepseek/deepseek-v4.1-flash'
const ROUTES = ['chat', 'responses', 'cli']
const BASE = 'https://api.commandcode.ai'
const REPORT = process.env.BENCH_REPORT ?? '/private/tmp/commandcode-endpoint-benchmark-20260928.json'
const DRY = process.env.BENCH_DRY_RUN === '1'
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3)
const HISTORY_CHARS = Number(process.env.BENCH_HISTORY_CHARS ?? 780_000)
assert(Number.isSafeInteger(ROUNDS) && ROUNDS >= 0 && ROUNDS <= 5)
assert(Number.isSafeInteger(HISTORY_CHARS) && HISTORY_CHARS >= 10_000 && HISTORY_CHARS <= 1_000_000)
const KEY = DRY ? 'dry-run-key' : process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey()
if (!KEY) throw new Error('No Command Code credential is configured')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const encoder = new TextEncoder()
const report = {
  method: 'CommandCodeAdapter.stream for all routes; Responses uses a fetch-seam wire bridge',
  fixture: { model: MODEL, effort: 'max', longMaxTokens: 64_000, longHistoryCharacters: HISTORY_CHARS,
    messageCount: 191, toolCount: 32, sameKeyForEveryRoute: true, requestTimeoutMs: 60_000 },
  dryRun: DRY,
  results: [],
}
function save() { writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
function message(id, role, value) {
  return { id, role, content: [{ type: 'text', text: value }],
    source: role === 'assistant' ? { kind: 'model', provider: 'commandcode', model: MODEL } : { kind: 'user' } }
}
const longSystem = 'Synthetic coding assistant benchmark. Answer the final question with exactly OK.\n'
  + 'Static instruction section. '.repeat(2_500)
const tools = Array.from({ length: 32 }, (_, n) => ({
  name: `synthetic_tool_${String(n).padStart(2, '0')}`,
  description: `Synthetic tool ${n}; not needed for this question. ` + 'Read-only deterministic helper. '.repeat(23),
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Synthetic file path' },
    offset: { type: 'integer', description: 'Starting offset' } }, required: ['path'] },
}))
function fixture(round, long) {
  if (!long) return { system: 'Synthetic endpoint smoke test. Reply exactly OK.', tools: [],
    messages: [message('smoke', 'user', 'Reply exactly OK.')], maxTokens: 1024 }
  const source = Array.from({ length: 190 }, (_, n) =>
    `Synthetic module ${n}, round ${round}: analyze deterministic records, preserve the order, and do not call tools. `
    + `Record ${n}: ` + `alpha-${n % 17} beta-${n % 37} gamma-${n % 71}. `.repeat(120))
  const current = source.reduce((n, s) => n + s.length, 0)
  const scale = HISTORY_CHARS / current
  const messages = source.map((s, n) => {
    const target = Math.max(1, Math.floor(s.length * scale))
    return message(`long-${n}`, n % 2 === 0 ? 'user' : 'assistant',
      s.repeat(Math.ceil(target / s.length)).slice(0, target))
  })
  messages.push(message('final', 'user', 'For this synthetic benchmark, return exactly OK. Do not use tools.'))
  return { system: longSystem, tools, messages, maxTokens: 64_000 }
}

function toResponses(chat) {
  assert.equal(chat.model, MODEL)
  assert.equal(chat.reasoning_effort, 'max')
  const converted = {
    model: chat.model,
    input: chat.messages,
    max_output_tokens: chat.max_tokens,
    reasoning: { effort: chat.reasoning_effort },
    temperature: chat.temperature,
    stream: true,
  }
  if (chat.tools?.length) converted.tools = chat.tools.map((tool) => ({
    type: 'function', name: tool.function.name,
    description: tool.function.description, parameters: tool.function.parameters,
  }))
  return converted
}

function sse(value) { return encoder.encode(`data: ${JSON.stringify(value)}\n\n`) }
function normalizeUsage(raw) {
  const source = raw?.response?.usage ?? raw?.usage
  if (!source) return undefined
  return { inputTokens: source.input_tokens, outputTokens: source.output_tokens,
    cachedTokens: source.input_tokens_details?.cached_tokens }
}
function tapStream(body, route, row, started) {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let completed = false
  const transform = new TransformStream({
    transform(bytes, controller) {
      row.firstBodyMs ??= Math.round(performance.now() - started)
      row.responseBytes = (row.responseBytes ?? 0) + bytes.byteLength
      if (route !== 'responses') controller.enqueue(bytes)
      buffer += decoder.decode(bytes, { stream: true })
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue }
        if (!line.startsWith('data:') && !line.trimStart().startsWith('{')) continue
        const value = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (!value || value === '[DONE]') continue
        let event
        try { event = JSON.parse(value) } catch { continue }
        const type = event.type ?? eventName
        row.firstEventMs ??= Math.round(performance.now() - started)
        row.events = (row.events ?? 0) + 1
        if (route === 'responses') {
          const delta = typeof event.delta === 'string' ? event.delta : ''
          if (type === 'response.output_text.delta' && delta) {
            row.firstTextMs ??= Math.round(performance.now() - started)
            row.outputCharacters = (row.outputCharacters ?? 0) + delta.length
            controller.enqueue(sse({ choices: [{ delta: { content: delta }, finish_reason: null }] }))
          } else if (/^response\.reasoning.*\.delta$/.test(type) && delta) {
            row.firstReasoningMs ??= Math.round(performance.now() - started)
            controller.enqueue(sse({ choices: [{ delta: { reasoning: delta }, finish_reason: null }] }))
          } else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
            row.toolCalls = (row.toolCalls ?? 0) + 1
            controller.enqueue(sse({ choices: [{ delta: { tool_calls: [{ index: row.toolCalls - 1,
              id: event.item.call_id, function: { name: event.item.name, arguments: event.item.arguments ?? '{}' } }] },
              finish_reason: null }] }))
          } else if (type === 'response.completed') {
            completed = true
            row.usage = normalizeUsage(event)
            controller.enqueue(sse({ choices: [{ delta: {}, finish_reason: row.toolCalls ? 'tool_calls' : 'stop' }] }))
          } else if (type === 'response.failed') {
            row.providerFailure = true
            controller.enqueue(sse({ error: { message: 'Responses request failed', statusCode: 502 } }))
          }
        } else if (route === 'cli') {
          if (type === 'text-delta' && event.text) row.firstTextMs ??= Math.round(performance.now() - started)
          if (type === 'reasoning-delta' && event.text) row.firstReasoningMs ??= Math.round(performance.now() - started)
        } else {
          const delta = event.choices?.[0]?.delta
          if (delta?.content) row.firstTextMs ??= Math.round(performance.now() - started)
          if (delta?.reasoning || delta?.reasoning_content) row.firstReasoningMs ??= Math.round(performance.now() - started)
        }
      }
    },
    flush(controller) {
      row.bodyEndMs = Math.round(performance.now() - started)
      if (route === 'responses' && !completed && !row.providerFailure) row.noTerminalEvent = true
    },
  })
  return body.pipeThrough(transform)
}

async function run(route, round, long) {
  const input = fixture(round, long)
  const row = { route, round, size: long ? 'long' : 'smoke',
    fixtureHash: hash(JSON.stringify(input)),
    historyCharacters: input.messages.reduce((n, m) => n + m.content[0].text.length, 0) }
  const started = performance.now()
  const adapter = new CommandCodeAdapter({
    options: () => ({ apiBase: BASE, workingDir: '/synthetic/endpoint-benchmark',
      modelsCachePath: '/private/tmp/commandcode-endpoint-models.json',
      requestTimeoutMs: 60_000, streamIdleTimeoutMs: 300_000,
      protocol: route === 'cli' ? 'cli' : 'openai' }),
    resolveApiKey: async () => KEY,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [
        { id: MODEL, name: MODEL, context_length: 1_000_000, max_output_tokens: 64_000 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      let destination = String(url)
      let options = init
      if (route === 'responses') {
        destination = `${BASE}/provider/v1/responses`
        options = { ...init, body: JSON.stringify(toResponses(JSON.parse(String(init.body)))) }
      }
      row.actualPath = new URL(destination).pathname
      row.requestBytes = Buffer.byteLength(String(options.body))
      if (DRY) {
        const output = route === 'responses'
          ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n'
            + 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n'
          : route === 'cli'
            ? 'data: {"type":"text-delta","text":"OK"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
            : 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n'
              + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        row.httpStatus = 200
        row.headersMs = Math.round(performance.now() - started)
        return new Response(tapStream(new Response(output).body, route, row, started), { status: 200 })
      }
      const response = await fetch(destination, options)
      row.headersMs = Math.round(performance.now() - started)
      row.httpStatus = response.status
      row.requestId = response.headers.get('x-request-id') ?? undefined
      if (!response.ok || !response.body) return response
      return new Response(tapStream(response.body, route, row, started),
        { status: response.status, headers: response.headers })
    },
  })
  try {
    await adapter.listModels('commandcode', { unfiltered: true })
    let finished = false
    for await (const chunk of adapter.stream({ provider: 'commandcode', model: MODEL,
      sessionId: `session-123e4567-e89b-42d3-a456-42661417400${round + 3}`,
      system: input.system, tools: input.tools, messages: input.messages,
      reasoningEffort: 'max', maxTokens: input.maxTokens })) {
      if (chunk.type === 'text-delta' && chunk.text) row.firstAdapterTextMs ??= Math.round(performance.now() - started)
      if (chunk.type === 'reasoning-delta' && chunk.text) row.firstAdapterReasoningMs ??= Math.round(performance.now() - started)
      if (chunk.type === 'usage' && route !== 'responses') row.usage = chunk.usage
      if (chunk.type === 'finish') { row.finishReason = chunk.reason; finished = true }
    }
    row.ok = finished && !row.providerFailure && !row.noTerminalEvent && !row.toolCalls
  } catch (error) {
    row.ok = false
    row.errorCode = error?.code ?? error?.name ?? 'UNKNOWN'
    row.errorStatus = error?.failure?.status
    row.rootCause = error?.cause?.cause?.code ?? error?.cause?.code
  }
  row.totalMs = Math.round(performance.now() - started)
  report.results.push(row)
  save()
  console.log(JSON.stringify({ route, round, size: row.size, ok: row.ok, status: row.httpStatus,
    headersMs: row.headersMs, firstTextMs: row.firstTextMs, firstReasoningMs: row.firstReasoningMs,
    totalMs: row.totalMs, inputTokens: row.usage?.inputTokens, cachedTokens: row.usage?.cachedTokens,
    outputTokens: row.usage?.outputTokens, errorCode: row.errorCode }))
  return row
}

save()
for (const route of ROUTES) await run(route, -1, false)
if (report.results.some((r) => r.size === 'smoke' && !r.ok)) {
  console.log('At least one smoke request failed; skipping long runs.')
  process.exitCode = 2
} else {
  const orders = [ROUTES, ['responses', 'cli', 'chat'], ['cli', 'chat', 'responses']]
  for (let round = 0; round < ROUNDS; round++) {
    for (const route of orders[round]) await run(route, round, true)
  }
}
console.log(`Report: ${REPORT}`)
