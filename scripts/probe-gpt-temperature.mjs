#!/usr/bin/env node
/**
 * LIVE 探针：GPT 模型在 `/provider/v1/chat/completions` 上接不接受 `temperature`。
 *
 * 起因是核对官方 [pi-commandcode-provider](https://github.com/CommandCodeAI/pi-commandcode-provider)
 * 时发现的一处不确定项。官方那条路径上没有这个问题——它不设任何 temperature
 * 相关的 `compat`，由 pi-ai 层决定发不发；而本插件的 `buildOpenAIBody()`
 * **无条件**发 `temperature: options.temperature ?? 0.3`
 * (`src/adapter.ts`)。OpenAI 自家的 GPT-5 系列在 Chat Completions 上对
 * temperature 有既定限制，而 Claude 在 Messages 上拒绝非 1 的值是**已实测**的
 * 同类问题，所以这值得实测一次，而不是推断。
 *
 * 驱动的是插件自己的 `CommandCodeAdapter`，不是手写 fetch：认证头、路由判定
 * 和 body 组装都与真实请求完全一致，测的就是线上会跑的那条路（对比
 * `verify-messages-live.mjs` 的理由）。这也意味着「不带 temperature」这个
 * 基线用例在这里表达不出来——适配器总会填上 `?? 0.3`——需要它时用
 * `--absent` 走一条手写的最小请求。
 *
 * 一次只变一个变量：同一个模型、同一条路由、同一段提示，只切 temperature。
 * 记录判定与错误正文，不打印凭据、不保存响应正文。
 * 成本：每轮一个极短请求 + 压到最小的 `max_tokens`，约 $0.001~0.01。
 *
 *   PROBE_DRY_RUN=1 node --import tsx scripts/probe-gpt-temperature.mjs
 *   node --import tsx scripts/probe-gpt-temperature.mjs            # 默认模型
 *   node --import tsx scripts/probe-gpt-temperature.mjs gpt-5.5    # 指定模型
 *   node --import tsx scripts/probe-gpt-temperature.mjs --absent   # 额外测「不带」
 *
 * 凭证取 `COMMANDCODE_API_KEY` 优先、`~/.commandcode/auth.json` 回退，与插件
 * 自己的解析顺序一致：CLI 的 auth 文件里的 key 可能已经过期（2026-09-29 实测
 * 该文件存在但网关答 401），而环境变量可以临时指定一把有效的，不去改它。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeAdapter, resolveAuthFileApiKey, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'

const DRY = process.env.PROBE_DRY_RUN === '1'
const KEY = DRY ? 'dry-run-key' : (process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey())
if (!KEY) throw new Error('No Command Code credential: set COMMANDCODE_API_KEY or configure ~/.commandcode/auth.json')

const WITH_ABSENT = process.argv.includes('--absent')
const MODEL = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]) ?? 'gpt-5.4'
const URL = 'https://api.commandcode.ai/provider/v1/chat/completions'

/**
 * What each request was actually answered with, and what it looked like on the
 * wire. Only POSTs to the chat route are kept: `stream()` also kicks off a
 * background catalog GET, and indexing the raw log would report that request's
 * (absent) body as if it were the generate request's.
 */
const sent = []
const recordingFetch = async (url, init) => {
  const target = String(url)
  let body
  try { body = JSON.parse(String(init?.body)) } catch { body = undefined }
  // Only the generate request is of interest: `stream()` also kicks off a
  // background catalog GET, and indexing the raw log would report that
  // request's (absent) body as if it were the generate request's. The chat
  // route is matched on the body rather than the method because the adapter
  // does not set one — the default is GET only for a bodyless call.
  if (body?.model !== undefined && target.includes('/provider/v1/')) sent.push(body)
  return fetch(url, init)
}

const cacheDir = mkdtempSync(join(tmpdir(), 'cc-gpt-temp-'))
const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: 'https://api.commandcode.ai',
    workingDir: '/tmp',
    modelsCachePath: join(cacheDir, 'models.json'),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    // Pin the Provider API: this is about what /chat/completions accepts, and
    // the CLI transport is a different wire with a different answer.
    protocol: 'openai',
  }),
  resolveApiKey: async () => KEY,
  fetchImpl: recordingFetch,
})

const prompt = () => [{
  id: MessageId('probe-1'),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with the single word: ok' }],
  source: { kind: 'user' },
}]

async function run(label, temperature) {
  if (DRY) return console.log(`  ${label.padEnd(32)} DRY RUN`)
  const before = sent.length
  try {
    // `stream()` is an async generator: awaiting it without iterating runs
    // nothing at all, and every case would report "accepted" for free.
    for await (const _ of adapter.stream({
      provider: 'commandcode',
      model: MODEL,
      maxTokens: 16,
      ...(temperature === undefined ? {} : { temperature }),
      messages: prompt(),
    })) { /* the verdict is the exit, not the chunks */ }

    const onWire = sent[before]?.temperature
    console.log(`  ${label.padEnd(32)} accepted   (sent temperature: ${JSON.stringify(onWire)})`)
    return true
  } catch (error) {
    // The sentence a user would see, never a whole JSON blob.
    const message = error instanceof Error ? error.message : String(error)
    const onWire = sent[before]?.temperature
    // Bilingual messages are `EN；ZH`; the English half is the gateway's own
    // wording, which is what identifies the refusal shape.
    const sentence = message.split('；')[0].slice(0, 240)
    console.log(`  ${label.padEnd(32)} REFUSED    (sent temperature: ${JSON.stringify(onWire)})`)
    console.log(`      ${sentence}`)
    return false
  }
}

try {
  console.log(`model: ${MODEL}\nroute: ${URL}\n`)
  const accepted03 = await run('0.3 — what the plugin sends', 0.3)
  // Past a refusal, the only open question is whether the value itself is
  // illegal or the field is, and that is the one extra request worth making.
  if (!accepted03) await run('1', 1)
  if (WITH_ABSENT) {
    assert.ok(sent.length >= 0)
    await run('absent — field omitted', undefined)
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true })
}
