/**
 * 阶段 0 · B 组：用 claude-sonnet-5-5（GOAT 套餐下唯一可用 Claude）采集成功路径契约。
 *
 * max_tokens 一律设到最小；图片用 64x64 极小图（Anthropic 按面积计视觉 token，
 * 64x64 约 6 token），只为采 wire 形状，不为测模型能力。
 * 只输出事件类型序列与字段形状，不保存正文、不打印凭据。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { resolveAuthFileApiKey } from '../src/adapter.ts'

const KEY = resolveAuthFileApiKey()
const ENDPOINT = 'https://api.commandcode.ai/provider/v1/messages'
const MODEL = 'claude-sonnet-5-5'
const HEADERS = {
  'content-type': 'application/json',
  'accept-encoding': 'identity',
  Accept: 'text/event-stream',
  Authorization: `Bearer ${KEY}`,
}
const results = []

/** 最小合法 PNG：纯色 64x64，避免引入 sharp。 */
function tinyPng(size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = 40; raw[row + 2 + x * 3] = 90; raw[row + 3 + x * 3] = 160
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : []
  if (typeof value === 'object') {
    if (depth > 5) return '{…}'
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]))
  }
  if (typeof value === 'string') return value.length > 60 ? `<str:${value.length}>` : value
  return value
}

/** 读完整 SSE 事件序列（保留每条的 event 名与 data 形状，不截断条数）。 */
async function readSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const slot = () => {
    const tail = events.at(-1)
    if (tail && tail.event !== undefined && tail.data === undefined) return tail
    const next = {}; events.push(next); return next
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.replace(/\r$/, '')
      if (!t) continue
      const s = slot()
      if (t.startsWith('event:')) { s.event = t.slice(6).trim(); continue }
      if (!t.startsWith('data:')) continue
      const raw = t.slice(5).trim()
      if (raw === '[DONE]') { s.done = true; continue }
      try { s.data = shape(JSON.parse(raw)) } catch { s.raw = raw.slice(0, 100) }
    }
  }
  return events
}

async function probe(id, body) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  const events = r.body ? await readSse(r) : [{ raw: (await r.text()).slice(0, 300) }]
  const row = { id, status: r.status, eventCount: events.length, events }
  results.push(row)
  console.log(`\n───── ${id} → ${r.status} · ${events.length} 个事件 ─────`)
  for (const e of events) {
    const name = e.event ?? e.done ? (e.event ?? '[DONE]') : '(data only)'
    console.log('  ', String(name).padEnd(28), JSON.stringify(e.data ?? e.raw ?? '').slice(0, 260))
  }
  return row
}

const PNG = tinyPng()
const imageBlock = (alt) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
  ...(alt ? {} : {}),
})

// B1 纯文本成功流：完整事件序列。
await probe('B1 纯文本流', {
  model: MODEL, max_tokens: 32, stream: true,
  system: 'Reply exactly OK.',
  messages: [{ role: 'user', content: 'Reply exactly OK.' }],
})

// B2 工具调用：input_json_delta 的分片形状。
await probe('B2 工具调用流', {
  model: MODEL, max_tokens: 512, stream: true,
  system: 'You must call the read_file tool.',
  tools: [{
    name: 'read_file', description: 'Read a file from disk.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] },
  }],
  messages: [{ role: 'user', content: 'Read the file /etc/hosts using the tool.' }],
})

// B3 扩展思维链：thinking_delta 与 signature_delta。
await probe('B3 扩展思维链', {
  model: MODEL, max_tokens: 1200, stream: true,
  thinking: { type: 'enabled', budget_tokens: 1024 },
  messages: [{ role: 'user', content: 'What is 17*23? Think it through.' }],
})

// B4 图片输入。
await probe('B4 图片输入', {
  model: MODEL, max_tokens: 32, stream: true,
  messages: [{ role: 'user', content: [imageBlock(), { type: 'text', text: 'Reply with the word BLUE.' }] }],
})

// B5 工具结果里的图片 —— Anthropic 允许 tool_result.content 带 image block。
// 若网关支持，issue #30 在本通道有原生解法，无需把图片拆成额外的 user 消息。
await probe('B5 工具结果图片', {
  model: MODEL, max_tokens: 256, stream: true,
  tools: [{
    name: 'screenshot', description: 'Take a screenshot.',
    input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  }],
  messages: [
    { role: 'user', content: 'Take a screenshot of the login page.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_probe01', name: 'screenshot', input: { target: 'login' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_probe01', content: [imageBlock(), { type: 'text', text: 'Here is the screenshot.' }] },
    ] },
  ],
})

writeFileSync('/tmp/cc-messages-probe-B.json', JSON.stringify(results, null, 2))
console.log('\n\nB 组结果已存 /tmp/cc-messages-probe-B.json')
