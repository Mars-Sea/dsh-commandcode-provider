/**
 * 端到端 LIVE 验证：驱动**插件自己的** CommandCodeAdapter 走真实的
 * `/provider/v1/messages`，而不是手写 fetch 打到网关。
 *
 * 与 `probe-messages-*.mjs` 的区别：那些探测网关接受什么，这份验证本插件
 * 写的那条通道是否真的能跑通——路由、body、流装配、工具循环、signature
 * 存与回传、原生工具结果图片，全部用真实响应。
 *
 * 只输出判定、事件计数与请求体形状摘要；不打印凭据、不保存会话正文。
 * 成本：短提示 + 压低的 max_tokens，约 $0.01~0.03。
 *
 *   VERIFY_DRY_RUN=1 node --import tsx scripts/verify-messages-live.mjs
 *   node --import tsx scripts/verify-messages-live.mjs
 */
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeAdapter, resolveAuthFileApiKey, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { randomUUID } from 'node:crypto'

const DRY = process.env.VERIFY_DRY_RUN === '1'
const KEY = DRY ? 'dry-run-key' : resolveAuthFileApiKey()
if (!KEY) throw new Error('No Command Code credential is configured')
const MODEL = 'claude-sonnet-5-5'
const BASE = 'https://api.commandcode.ai'

const cacheDir = mkdtempSync(join(tmpdir(), 'cc-messages-verify-'))
const modelsCachePath = join(cacheDir, 'models.json')

/** 记录每次真实请求的 URL 与 body 形状（不记录 header，不含凭据）。 */
const requests = []
const recordingFetch = async (url, init) => {
  let body
  try { body = JSON.parse(String(init?.body)) } catch { body = undefined }
  requests.push({ url: String(url), body })
  return fetch(url, init)
}

const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: BASE,
    workingDir: '/tmp/commandcode-messages-verify',
    modelsCachePath,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  }),
  resolveApiKey: async () => KEY,
  resolveAttachments: () => ({
    readImageRequest: async (ref) => ({ mediaType: ref.mediaType, data: png() }),
  }),
  fetchImpl: recordingFetch,
})

/** A tiny valid 64x64 PNG; the wire shape is what matters, not the picture. */
function png() {
  const size = 64
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const b = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) { const row = y * (size * 3 + 1); for (let x = 0; x < size; x++) { raw[row + 1 + x * 3] = 30; raw[row + 2 + x * 3] = 80; raw[row + 3 + x * 3] = 150 } }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

const imageRef = () => ({
  attachmentId: AttachmentId(`sha256:${randomUUID()}`),
  mediaType: 'image/png', bytes: png().length, width: 64, height: 64,
})
const mid = () => MessageId(randomUUID())
const user = (text) => ({ id: mid(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const results = []
function record(name, passed, detail) {
  results.push({ name, passed, detail })
  console.log(`  ${passed ? '通过' : '失败'}  ${name}`)
  if (detail) console.log(`        ${detail}`)
}
async function step(name, fn) {
  try {
    const detail = await fn()
    record(name, true, detail)
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
}

const collect = async (stream) => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
const textOf = (chunks) => chunks
  .filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const blocksOf = (chunks) => chunks.filter((c) => c.type === 'block-end').map((c) => c.block)
const lastFinish = (chunks) => chunks.filter((c) => c.type === 'finish').at(-1)
const usageOf = (chunks) => chunks.filter((c) => c.type === 'usage').at(-1)

console.log(`\n===== Messages 通道端到端 LIVE 验证 · ${MODEL}${DRY ? ' · DRY RUN' : ''} =====\n`)

if (DRY) {
  // A dry run must touch the network ZERO times, not send a doomed request.
  console.log('DRY RUN：不发出任何请求。去掉 VERIFY_DRY_RUN=1 才会真正打网关并消耗额度。\n')
  process.exit(0)
}

// Warm the catalog the way a picker path does, so max_tokens resolves from
// the model's own recorded ceiling rather than a fallback.
const catalog = await adapter.listModels('commandcode', { unfiltered: true })
const entry = catalog.find((m) => m.id === MODEL)
console.log(`目录：${catalog.length} 个模型，${MODEL} 上下文 ${entry?.context?.contextWindow ?? '?'}，默认输出 ${entry?.defaultMaxTokens ?? '?'}\n`)

await step('1 · 路由：Claude 走 /provider/v1/messages', async () => {
  const before = requests.length
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: MODEL, maxTokens: 32, messages: [user('Reply exactly OK.')] }))
  const sent = requests[before]
  assert.ok(sent, '没有发出请求')
  assert.ok(sent.url.includes('/provider/v1/messages'), `打到了 ${sent.url}`)
  assert.equal(sent.body.thinking?.type, 'adaptive', 'thinking 形态不是 adaptive')
  assert.equal(typeof sent.body.max_tokens, 'number')
  return `端点 ${new URL(sent.url).pathname} · max_tokens=${sent.body.max_tokens} · 回答「${textOf(chunks).slice(0, 20)}」`
})

await step('2 · 流装配：usage 与终止事件完整', async () => {
  const chunks = await collect(adapter.stream({ provider: 'commandcode', model: MODEL, maxTokens: 32, messages: [user('Reply exactly OK.')] }))
  const usage = usageOf(chunks)
  const finish = lastFinish(chunks)
  assert.ok(usage, '没有 usage')
  assert.ok((usage.usage.inputTokens ?? 0) > 0, 'inputTokens 为 0')
  assert.ok(finish, '没有 finish')
  assert.equal(finish.reason.kind, 'stop')
  return `in=${usage.usage.inputTokens} out=${usage.usage.outputTokens} finish=${finish.reason.kind} 块数=${blocksOf(chunks).length}`
})

await step('3 · 工具调用：input_json_delta 装配出可执行参数', async () => {
  const before = requests.length
  const chunks = await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 512,
    system: 'You must call read_file. Do not answer in text.',
    tools: [{ name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [user('Read the file /etc/hosts using the tool.')],
  }))
  const call = blocksOf(chunks).find((b) => b.type === 'tool-call')
  assert.ok(call, `没有装配出 tool-call，实际块：${JSON.stringify(blocksOf(chunks).map((b) => b.type))}`)
  assert.equal(call.name, 'read_file')
  const args = JSON.parse(call.arguments)
  assert.equal(args.path, '/etc/hosts', `参数不对：${call.arguments}`)
  assert.equal(lastFinish(chunks).reason.kind, 'tool-calls')
  const wire = requests[before].body
  assert.equal(wire.tools[0].input_schema.type, 'object', '工具 schema 根类型不是 object')
  return `tool_use id=${call.id} args=${JSON.stringify(args)} · schema 根=object`
})

await step('4 · 工具结果回传：第二轮继续生成', async () => {
  const first = await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 512,
    system: 'You must call read_file. Do not answer in text.',
    tools: [{ name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [user('Read the file /etc/hosts using the tool.')],
  }))
  const call = blocksOf(first).find((b) => b.type === 'tool-call')
  assert.ok(call, '第一轮没有 tool-call')
  const before = requests.length
  const second = await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 300,
    system: 'You must call read_file. Do not answer in text.',
    tools: [{ name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [
      user('Read the file /etc/hosts using the tool.'),
      { id: mid(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: MODEL, replayState: lastFinish(first).replayState },
        content: blocksOf(first) },
      { id: mid(), role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id },
        content: [{ type: 'text', text: '127.0.0.1 localhost' }] },
    ],
  }))
  const toolResult = (requests[before].body.messages ?? []).find((m) =>
    Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
  assert.ok(toolResult, '请求里没有 tool_result')
  const block = toolResult.content.find((b) => b.type === 'tool_result')
  assert.equal(block.tool_use_id, call.id, 'tool_use_id 与发出的 tool_use 不匹配')
  assert.ok(textOf(second).length > 0, '第二轮没有文本输出')
  return `tool_use_id 对齐 · 第二轮回答「${textOf(second).slice(0, 60)}」`
})

await step('5 · 图片输入：source.media_type 形状', async () => {
  const before = requests.length
  const chunks = await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 32,
    messages: [{ id: mid(), role: 'user', content: [
      { type: 'image', attachment: imageRef() },
      { type: 'text', text: 'What single color fills this image? Reply with one English word.' },
    ], source: { kind: 'user' } }],
  }))
  const image = (requests[before].body.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === 'image')
  assert.ok(image, '请求里没有 image 块')
  assert.equal(image.source.type, 'base64')
  assert.equal(image.source.media_type, 'image/png')
  assert.ok(image.source.data.length > 100, 'base64 数据过短')
  return `media_type=${image.source.media_type} base64=${image.source.data.length}字符 · 回答「${textOf(chunks).slice(0, 20)}」`
})

await step('6 · 工具结果图片：原生留在 tool_result 里', async () => {
  const callId = ToolCallId('toolu_verify_img')
  const before = requests.length
  await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 300,
    system: 'You have a screenshot tool. Always call it, then describe what you see.',
    tools: [{ name: 'screenshot', description: 'Take a screenshot of a page.', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } }],
    messages: [
      user('Take a screenshot of the dashboard, then describe it.'),
      { id: mid(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: MODEL },
        content: [{ type: 'tool-call', id: callId, name: 'screenshot', arguments: JSON.stringify({ target: 'dashboard' }) }] },
      { id: mid(), role: 'tool', toolCallId: callId, source: { kind: 'tool', callId: callId }, content: [
        { type: 'image', attachment: imageRef() },
        { type: 'text', text: 'Screenshot attached.' },
      ] },
    ],
  }))
  const messages = requests[before].body.messages ?? []
  const toolResult = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === 'tool_result')
  assert.ok(toolResult, '请求里没有 tool_result')
  const inner = toolResult.content.find((b) => b.type === 'image')
  assert.ok(inner, `tool_result 里没有图片，实际内容：${JSON.stringify(toolResult.content.map((b) => b.type))}`)
  // 关键：图片没有被拆成额外的 user 消息。
  assert.equal(messages.length, 3, `应为 3 条消息，实际 ${messages.length}：${JSON.stringify(messages.map((m) => m.role))}`)
  return `图片原生存于 tool_result · 消息数 ${messages.length}（无额外 user 消息）`
})

await step('7 · 思维链 signature：写入 replayState 并在下一轮回传', async () => {
  // A tool-calling prompt is too easy: the model calls the tool without
  // thinking. A pure reasoning prompt at `effort: 'max'` reliably produces a
  // thinking block (measured across three task shapes), so the signature path
  // is actually exercised rather than skipped.
  const REASON = 'A bat and a ball cost 1.10 together. The bat costs 1.00 more than the ball. How much does the ball cost? Reason it through.'
  const first = await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 900, reasoningEffort: 'max',
    messages: [user(REASON)],
  }))
  const replay = lastFinish(first).replayState
  assert.ok(replay, '没有 replayState')
  const signature = (replay.blocks ?? []).find((b) => b && typeof b.signature === 'string' && b.signature.length > 0)
  assert.ok(signature, `replayState.blocks 里没有 signature：${JSON.stringify(replay.blocks)}`)
  assert.ok(blocksOf(first).some((b) => b.type === 'reasoning'), '没有装配出 reasoning 块')
  // The signature must never appear as a reasoning DELTA — it is not model-visible.
  assert.equal(first.filter((c) => c.type === 'reasoning-delta').some((c) => c.text.includes('sig-')), false)

  const before = requests.length
  // No effort on the follow-up: replayed thinking does not need re-triggering,
  // and asking for `max` again would spend the whole budget thinking and trip
  // the (correct) OUTPUT_TOKEN_LIMIT path instead of exercising the replay.
  await collect(adapter.stream({
    provider: 'commandcode', model: MODEL, maxTokens: 800,
    messages: [
      user(REASON),
      { id: mid(), role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: MODEL, replayState: replay },
        content: blocksOf(first) },
      user('Now state the answer in one word.'),
    ],
  }))
  const assistant = (requests[before].body.messages ?? []).find((m) => m.role === 'assistant')
  const thinking = (assistant?.content ?? []).find((b) => b.type === 'thinking')
  assert.ok(thinking, `回传的 assistant 内容里没有 thinking 块：${JSON.stringify(assistant?.content?.map((b) => b.type))}`)
  assert.equal(thinking.signature, signature.signature, '回传的 signature 与记录的不一致')
  assert.equal(requests[before].body.temperature, undefined, 'Messages 通道不得发送 temperature')
  return `signature 长度 ${thinking.signature.length} · 存与回传一致 · temperature 未发送`
})

rmSync(cacheDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.passed)
console.log(`\n===== ${results.length - failed.length} / ${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`)
  process.exitCode = 1
}
