/**
 * Replay a stored session's history through the adapter, live.
 *
 * Purpose: an OLD session (restored from disk) fails where a fresh one works.
 * The adapter only ever sees the reconstructed message list, so rebuilding that
 * list from the jsonl and driving a real request isolates "the payload shape of
 * an old history" from the harness.
 *
 *   node --import tsx scripts/replay-session.mjs <session-file> [maxSteps]
 *
 * Never prints the credential. The raw trace lands in $TMPDIR.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeAdapter, resolveAuthFileApiKey, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'

const target = process.argv[2]
if (!target) {
  console.error('usage: node --import tsx scripts/replay-session.mjs <session.v4.jsonl.zstd> [maxMessages]')
  process.exit(2)
}

const KEY = process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey()
if (!KEY) {
  console.error('no credential: set COMMANDCODE_API_KEY or run `command-code login`')
  process.exit(2)
}

const raw = target.endsWith('.zstd')
  ? execFileSync('zstd', ['-dc', target], { maxBuffer: 1 << 30 }).toString('utf8')
  : readFileSync(target, 'utf8')

/**
 * The last `request/header` the harness recorded for this session: the exact
 * model, reasoning effort, maxTokens, system prompt and tool schemas the real
 * turn sent. Replaying with these makes the probe faithful instead of a
 * stripped-down approximation.
 */
function lastRequestHeader() {
  let header
  let system
  for (const line of raw.split('\n')) {
    if (!line.includes('request/header') && !line.includes('system/message')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'request/header') header = event.data.header
    if (event.type === 'system/message' && system === undefined) {
      system = event.data.message.content.map((b) => b.text ?? '').join('\n')
    }
  }
  return { header, system }
}
const recorded = lastRequestHeader()

/**
 * Rebuild the request message list from the event log, mirroring what the
 * harness replays: user turns, assistant turns (text + reasoning + tool calls)
 * and their paired tool results. The trailing `pad` user turn is what a
 * restored session actually sends — the user's new message.
 */
function rebuild(maxMessages) {
  const messages = []
  const push = (m) => {
    messages.push({ ...m, id: m.id ?? `r${messages.length}` })
    const id = messages[messages.length - 1].id
    // dsh keys content blocks per message id.
    if (m.role === 'assistant') {
      messages[messages.length - 1] = {
        ...messages[messages.length - 1],
        content: m.content.map((block, index) => ({ ...block, id: `${id}-${index}` })),
      }
    }
    return id
  }

  const byCallId = new Map()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data
    if (event.type === 'user/message' && data?.surfaceOp !== 'replace') {
      push({ role: 'user', content: data.content, source: data.source })
    } else if (event.type === 'assistant/message' && data?.message) {
      push({ role: 'assistant', content: data.message.content, source: data.message.source })
    } else if (event.type === 'tool/result' && data?.message) {
      const id = push({ role: 'tool', content: data.message.content, source: data.message.source, toolCallId: data.message.toolCallId })
      byCallId.set(data.message.toolCallId, id)
    }
  }
  const trimmed = maxMessages ? messages.slice(-maxMessages) : messages
  const counts = { user: 0, assistant: 0, tool: 0 }
  let text = 0
  let reasoning = 0
  let toolCalls = 0
  for (const m of trimmed) {
    counts[m.role] = (counts[m.role] ?? 0) + 1
    for (const block of m.content ?? []) {
      if (block.type === 'text') text++
      else if (block.type === 'reasoning') reasoning += (block.text ?? '').length
      else if (block.type === 'tool-call') toolCalls++
    }
  }
  return { messages: trimmed, stats: { ...counts, textBlocks: text, reasoningChars: reasoning, toolCalls } }
}

const maxMessages = Number(process.argv[3] ?? 0)
const { messages, stats } = rebuild(maxMessages)
const padText = process.env.REPLAY_PROMPT ?? 'Reply with exactly: ok'
messages.push({
  role: 'user',
  id: 'replay-pad',
  content: [{ type: 'text', text: padText }],
  source: { kind: 'user' },
})

console.log('history:', JSON.stringify(stats))
console.log('messages:', messages.length, '| approx chars:', JSON.stringify(messages).length)

const tracePath = process.env.REPLAY_TRACE ?? join(tmpdir(), 'dsh-commandcode-replay.jsonl')
process.env.DSH_COMMANDCODE_TRACE = tracePath
console.log('trace ->', tracePath)

const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai',
    workingDir: process.cwd(),
    modelsCachePath: '/tmp/cc-replay-models.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ...(process.env.REPLAY_PROTOCOL ? { protocol: process.env.REPLAY_PROTOCOL } : {}),
  }),
  resolveApiKey: async () => KEY,
})

const model = process.env.REPLAY_MODEL ?? recorded.header?.config?.model ?? 'deepseek/deepseek-v4.1-flash'
const tools = process.env.REPLAY_NO_TOOLS ? undefined : recorded.header?.tools
const system = process.env.REPLAY_NO_SYSTEM ? undefined : recorded.system
const reasoningEffort = process.env.REPLAY_NO_EFFORT ? undefined : recorded.header?.config?.reasoningEffort
console.log('recorded request:', JSON.stringify({
  model,
  reasoningEffort,
  maxTokens: recorded.header?.config?.maxTokens,
  tools: tools?.length ?? 0,
  systemChars: system?.length ?? 0,
}))

const counts = new Map()
const started = Date.now()
let outcome = 'completed'
try {
  for await (const chunk of adapter.stream({
    provider: 'commandcode',
    model,
    maxTokens: Number(process.env.REPLAY_MAX_TOKENS ?? recorded.header?.config?.maxTokens ?? 2048),
    reasoningEffort,
    system,
    tools,
    sessionId: process.env.REPLAY_SESSION_ID,
    messages,
  })) {
    counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1)
    if (chunk.type === 'text-delta' && process.env.REPLAY_VERBOSE) process.stdout.write(chunk.text)
  }
} catch (error) {
  outcome = `FAILED code=${error?.code} status=${error?.failure?.status ?? '-'} :: ${String(error?.message).slice(0, 500)}`
}
console.log(`\nmodel: ${model}`)
console.log(`outcome: ${outcome} in ${Date.now() - started}ms`)
console.log(`chunks: ${[...counts].map(([k, n]) => `${k}×${n}`).join(' ') || '(none)'}`)

if (existsSync(tracePath)) {
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const record = JSON.parse(line)
    if (record.event === 'chunk') continue
    console.log('trace:', JSON.stringify(record).slice(0, 600))
  }
  console.log('raw chunks recorded:', lines.filter((l) => JSON.parse(l).event === 'chunk').length)
}
