/**
 * One-shot live probe: drive the adapter through a real request with the
 * raw-stream trace on, then report how the stream ended.
 *
 * This is the isolation test for "the reply stopped in the middle and nothing
 * said why": it removes the harness, the web shell and the session from the
 * picture, so a cut observed here is the provider's (or the network's) and a
 * clean `finished` here means the cut lives above the adapter.
 *
 * Never prints the credential. Run:
 *   node --import tsx scripts/probe-stream.mjs
 *   PROBE_MAX_TOKENS=1500 node --import tsx scripts/probe-stream.mjs
 *   PROBE_MODEL=xiaomi/mimo-v2.6-pro node --import tsx scripts/probe-stream.mjs
 *   PROBE_PROMPT='count to 300' node --import tsx scripts/probe-stream.mjs
 *
 * The raw trace lands in `$TMPDIR/dsh-commandcode-probe.jsonl`; its path is
 * printed, and its chunk records carry the model's output verbatim.
 */

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeAdapter, resolveAuthFileApiKey, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'

const KEY = process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey()
if (!KEY) {
  console.error('no credential: set COMMANDCODE_API_KEY or run `command-code login`')
  process.exit(2)
}

const tracePath = process.env.PROBE_TRACE ?? join(tmpdir(), 'dsh-commandcode-probe.jsonl')
process.env.DSH_COMMANDCODE_TRACE = tracePath
console.log(`credential: resolved; trace -> ${tracePath}`)

const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai',
    workingDir: process.cwd(),
    modelsCachePath: '/tmp/cc-probe-models.json',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  }),
  resolveApiKey: async () => KEY,
})

const started = Date.now()
const counts = new Map()
let outcome = 'completed'
try {
  for await (const chunk of adapter.stream({
    provider: 'commandcode',
    model: process.env.PROBE_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    maxTokens: Number(process.env.PROBE_MAX_TOKENS ?? 32),
    messages: [{
      id: 'probe-1',
      role: 'user',
      content: [{ type: 'text', text: process.env.PROBE_PROMPT ?? 'Reply with exactly: ok' }],
      source: { kind: 'user' },
    }],
  })) {
    counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1)
  }
} catch (error) {
  outcome = `FAILED code=${error?.code} :: ${String(error?.message).slice(0, 400)}`
}
console.log(`outcome: ${outcome} in ${Date.now() - started}ms`)
console.log(`chunks: ${[...counts].map(([kind, n]) => `${kind}×${n}`).join(' ')}`)

let lines = []
try {
  lines = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
} catch {
  console.error('no trace file was written')
}
for (const record of lines) {
  if (record.event === 'chunk') continue
  console.log('trace:', JSON.stringify(record))
}
console.log(`raw chunks recorded: ${lines.filter((r) => r.event === 'chunk').length}`)
console.log('finished without a cut:', outcome === 'completed')
