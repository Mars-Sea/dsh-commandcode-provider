/**
 * Measure the drift between the harness's text estimate and the provider's
 * real token count for the same text.
 *
 * The engine's token meter prices text at `CHARS_PER_TOKEN = 4`
 * (`@deepseek-ai/dsh-token-meter`), i.e. ceil(UTF-16 length / 4). The provider
 * counts with a real tokenizer. Compaction pressure and the adapter's output
 * reservation are only as good as that estimate, so the drift factor is the
 * number that decides whether a long session can still be served.
 *
 *   CJK_CHARS=20000 node --import tsx scripts/probe-cjk-drift.mjs
 *   LATIN_CHARS=20000 node --import tsx scripts/probe-cjk-drift.mjs
 */

import { CommandCodeAdapter, resolveAuthFileApiKey, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'

const KEY = process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey()
if (!KEY) {
  console.error('no credential: set COMMANDCODE_API_KEY or run `command-code login`')
  process.exit(2)
}

const cjkChars = Number(process.env.CJK_CHARS ?? 0)
const latinChars = Number(process.env.LATIN_CHARS ?? 0)
const cjkUnit = '这是一段用于测量分词漂移的中文文本，包含标点符号与数字 12345。'
const latinUnit = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
const text = cjkChars > 0
  ? cjkUnit.repeat(Math.ceil(cjkChars / cjkUnit.length)).slice(0, cjkChars)
  : latinUnit.repeat(Math.ceil(latinChars / latinUnit.length)).slice(0, latinChars)

// The engine's own heuristic: ceil(block.text.length / 4) + BLOCK_OVERHEAD.
const meterEstimate = Math.ceil(text.length / 4) + 4
console.log(`kind=${cjkChars > 0 ? 'cjk' : 'latin'} chars=${text.length} (utf8 bytes=${Buffer.byteLength(text)})`)
console.log(`engine meter estimate: ${meterEstimate} tokens`)

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

let usage
let outcome = 'completed'
try {
  for await (const chunk of adapter.stream({
    provider: 'commandcode',
    model: process.env.PROBE_MODEL ?? 'stealth/space-bunny-alpha',
    maxTokens: Number(process.env.PROBE_MAX_TOKENS ?? 16),
    messages: [
      { id: 'c1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      { id: 'c2', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: ok' }], source: { kind: 'user' } },
    ],
  })) {
    if (chunk.type === 'usage') usage = chunk.usage
  }
} catch (error) {
  outcome = `FAILED code=${error?.code} :: ${String(error?.message).slice(0, 200)}`
}
console.log(`outcome: ${outcome}`)
console.log(`provider usage: ${JSON.stringify(usage)}`)
if (usage !== undefined) {
  const real = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  console.log(`drift: meter ${meterEstimate} vs provider ${real} tokens -> provider is ${(real / meterEstimate).toFixed(2)}x the estimate`)
}
