/**
 * Oversize probe: send a deliberately huge prompt (and optional huge output
 * budget) and report exactly what the provider answers with, raw trace on.
 *
 *   PROMPT_CHARS=1600000 PROBE_MODEL=stealth/pixel-canary node --import tsx scripts/probe-oversize.mjs
 *   PROMPT_CHARS=1000000 PROBE_MAX_TOKENS=64000 PROBE_MODEL=stealth/pixel-canary ...
 *
 * The point is the wording of the refusal: a 400 that names the context window
 * is already classified as CONTEXT_WINDOW_EXCEEDED by the adapter, while an
 * in-band error event (or an empty stream) is not.
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

const chars = Number(process.env.PROMPT_CHARS ?? 1_600_000)
const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(Math.ceil(chars / 75)).slice(0, chars)

const tracePath = process.env.PROBE_TRACE ?? join(tmpdir(), 'dsh-commandcode-oversize.jsonl')
process.env.DSH_COMMANDCODE_TRACE = tracePath

const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai',
    workingDir: process.cwd(),
    modelsCachePath: '/tmp/cc-probe-models.json',
    requestTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS),
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ...(process.env.PROBE_PROTOCOL ? { protocol: process.env.PROBE_PROTOCOL } : {}),
  }),
  resolveApiKey: async () => KEY,
})

const model = process.env.PROBE_MODEL ?? 'stealth/pixel-canary'
console.log(`model=${model} promptChars=${filler.length} maxTokens=${process.env.PROBE_MAX_TOKENS ?? 1024}`)

const started = Date.now()
let outcome = 'completed'
let headersAt
const counts = new Map()
// The window-aware output budget needs the catalog (it carries contextWindow).
// The engine warms it through resolveModel/listModels before dispatch; a bare
// adapter script must do the same or the clamp silently does nothing.
await adapter.resolveModel('commandcode', model).catch((error) => {
  console.log(`catalog warm-up failed: ${String(error?.message ?? error).slice(0, 120)}`)
})
try {
  for await (const chunk of adapter.stream({
    provider: 'commandcode',
    model,
    maxTokens: Number(process.env.PROBE_MAX_TOKENS ?? 1024),
    messages: [
      { id: 'o1', role: 'user', content: [{ type: 'text', text: 'Here is a long document. Reply with exactly: ok' }], source: { kind: 'user' } },
      { id: 'o2', role: 'user', content: [{ type: 'text', text: filler }], source: { kind: 'user' } },
    ],
  })) {
    if (headersAt === undefined) headersAt = Date.now() - started
    counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1)
  }
} catch (error) {
  outcome = `FAILED code=${error?.code} status=${error?.failure?.status ?? '-'} :: ${String(error?.message).slice(0, 600)}`
}
console.log(`outcome: ${outcome} in ${Date.now() - started}ms`)
console.log(`chunks: ${[...counts].map(([k, n]) => `${k}×${n}`).join(' ') || '(none)'}`)

let lines = []
try {
  lines = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
} catch {
  console.error('no trace file was written')
}
for (const record of lines) {
  if (record.event === 'chunk') continue
  console.log('trace:', JSON.stringify(record).slice(0, 900))
}
for (const record of lines) {
  if (record.event !== 'chunk') continue
  const text = String(record.text ?? '')
  if (text.includes('error') || text.includes('Error')) console.log('raw chunk:', text.slice(0, 900))
}
console.log(`raw chunks recorded: ${lines.filter((r) => r.event === 'chunk').length}`)
