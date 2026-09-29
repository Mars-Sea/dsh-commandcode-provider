/**
 * 阶段 0 · E 组：最后一次尝试复现 thinking 块并测回传。
 *
 * 观察：B5 未带 thinking 参数却产生了 thinking 块；D2 带了 thinking:{type:'adaptive'}
 * 反而没有。本组逐个变量对照，找出真正的触发条件。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { resolveAuthFileApiKey } from '../src/adapter.ts'

const KEY = resolveAuthFileApiKey()
const ENDPOINT = 'https://api.commandcode.ai/provider/v1/messages'
const MODEL = 'claude-sonnet-5-5'
const HEADERS = { 'content-type': 'application/json', 'accept-encoding': 'identity', Accept: 'text/event-stream', Authorization: `Bearer ${KEY}` }
const results = []

function tinyPng(size = 64) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const b = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) { const row = y * (size * 3 + 1); for (let x = 0; x < size; x++) { raw[row + 1 + x * 3] = 40; raw[row + 2 + x * 3] = 90; raw[row + 3 + x * 3] = 160 } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng().toString('base64') } }

async function call(body) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  if (!r.ok) return { status: r.status, error: await r.text() }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = []
  const slot = () => { const t = events.at(-1); if (t && t.event !== undefined && t.data === undefined) return t; const n = {}; events.push(n); return n }
  for (;;) { const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) { const t = line.replace(/\r$/, ''); if (!t) continue; const s = slot()
      if (t.startsWith('event:')) { s.event = t.slice(6).trim(); continue }
      if (t.startsWith('data:')) { try { s.data = JSON.parse(t.slice(5).trim()) } catch { /* 忽略 */ } } } }
  return { status: r.status, events }
}
function assemble(events) {
  const blocks = new Map()
  for (const e of events) { const d = e.data; if (!d) continue
    if (d.type === 'content_block_start') blocks.set(d.index, { ...d.content_block })
    else if (d.type === 'content_block_delta') { const b = blocks.get(d.index) ?? {}
      if (d.delta.type === 'text_delta') b.text = (b.text ?? '') + d.delta.text
      if (d.delta.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.delta.thinking
      if (d.delta.type === 'signature_delta') b.signature = (b.signature ?? '') + d.delta.signature
      if (d.delta.type === 'input_json_delta') b._j = (b._j ?? '') + d.delta.partial_json
      blocks.set(d.index, b) }
    else if (d.type === 'content_block_stop') { const b = blocks.get(d.index) ?? {}; if (b.type === 'tool_use' && b._j !== undefined) { try { b.input = JSON.parse(b._j) } catch { b.input = {} } } delete b._j; blocks.set(d.index, b) } }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
}
const TOOLS = [{ name: 'screenshot', description: 'Take a screenshot of a page.', input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } }]

// 逐个变量对照：哪一个让模型真的思考。
const variants = [
  ['V1 原样B5(无thinking参数)', {}],
  ['V2 thinking:adaptive', { thinking: { type: 'adaptive' } }],
  ['V3 effort=max', { output_config: { effort: 'max' } }],
  ['V4 adaptive+effort=xhigh', { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } }],
  ['V5 thinking:between_tools', { thinking: { type: 'between_tools' } }],
]

// ============ E0：output_config.effort 的合法值域（早退，零成本）============
// 合并自原 D1：`reasoningEffort` 只能映射到这里的一个子集，所以完整值域是
// 映射表的事实依据，而不是猜的。实测 `none` 不存在、`xhigh` 存在。
console.log('\n========== E0：output_config.effort 值域 ==========\n')
for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'bogus']) {
  const r = await call({ model: MODEL, max_tokens: 16, stream: true, output_config: { effort },
    messages: [{ role: 'user', content: 'Hi' }] })
  const d = r.error ? (() => { try { return JSON.parse(r.error)?.error?.message ?? r.error } catch { return r.error } })() : '200 接受'
  results.push({ id: `E0 effort=${effort}`, status: r.status, detail: String(d) })
  console.log(`E0 effort=${effort.padEnd(8)} ${r.status}  ${String(d).slice(0, 165)}`)
}

console.log('\n========== E1：thinking 触发条件逐变量对照 ==========\n')
let winner = null
for (const [label, extra] of variants) {
  const r = await call({ model: MODEL, max_tokens: 700, stream: true, tools: TOOLS, system: 'You have a screenshot tool. Always call it, then describe what you see.',
    messages: [{ role: 'user', content: 'Take a screenshot of the login page, then describe it.' }], ...extra })
  if (r.error) { console.log(`${label.padEnd(28)} 失败 ${r.status} ${r.error.slice(0, 110)}`); results.push({ id: label, status: r.status, error: r.error.slice(0, 200) }); continue }
  const blocks = assemble(r.events)
  const thinking = blocks.find((b) => b.type === 'thinking')
  const toolUse = blocks.find((b) => b.type === 'tool_use')
  console.log(`${label.padEnd(28)} 块=${JSON.stringify(blocks.map((b) => b.type))}${thinking ? `  thinking=${thinking.thinking?.length}字 signature=${(thinking.signature ?? '').length}字` : ''}`)
  results.push({ id: label, status: r.status, kinds: blocks.map((b) => b.type), thinkingLen: thinking?.thinking?.length, sigLen: thinking?.signature?.length })
  if (thinking && toolUse && !winner) winner = { thinking, toolUse, label }
}

if (!winner) { console.log('\n所有变体都未同时产生 thinking + tool_use，E2 跳过'); writeFileSync('/tmp/cc-messages-probe-E.json', JSON.stringify(results, null, 2)); process.exit(0) }

console.log(`\n用「${winner.label}」产生的 thinking 做回传对照：\n`)
const SYS = 'You have a screenshot tool. Always call it, then describe what you see.'
const ASK = 'Take a screenshot of the login page, then describe it.'
const TR = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [IMAGE, { type: 'text', text: 'Screenshot attached.' }] }] })
const round2 = async (label, content, id) => {
  const r = await call({ model: MODEL, max_tokens: 120, stream: true, tools: TOOLS, messages: [
    { role: 'user', content: ASK }, { role: 'assistant', content }, TR(id) ] })
  const d = r.error ? (() => { try { return JSON.parse(r.error)?.error?.message ?? r.error } catch { return r.error } })() : `200 stop=${r.events.find((e) => e.data?.type === 'message_delta')?.data?.delta?.stop_reason}`
  console.log(`${label.padEnd(34)} ${r.status}  ${String(d).slice(0, 170)}`)
  results.push({ id: `E2 ${label}`, status: r.status, detail: String(d) })
}
await round2('原样回传 thinking+signature', [winner.thinking, winner.toolUse], winner.toolUse.id)
await round2('thinking 保留但 signature 空串', [{ ...winner.thinking, signature: '' }, winner.toolUse], winner.toolUse.id)
await round2('thinking 块无 signature 键', [{ type: 'thinking', thinking: winner.thinking.thinking }, winner.toolUse], winner.toolUse.id)
await round2('thinking 文字置空只留 signature', [{ type: 'thinking', thinking: '', signature: winner.thinking.signature }, winner.toolUse], winner.toolUse.id)
await round2('完全剥掉 thinking', [winner.toolUse], winner.toolUse.id)

// ============ E3：tool_use.id 长度（合并自原 D3）============
// CLI 通道必须把 id 截到 64 字符（`wireToolCallIds()`），所以要确认 Messages
// 是否也有这个约束。两侧一致即可，id 多长都接受——这决定了那个截断能否在
// 本通道退场。最后一行是对照：两侧不一致必须失败，否则上面三行没有意义。
const withId = (id) => [{ ...winner.toolUse, id }]
const LONG_ID = `toolu_${'x'.repeat(80)}`
await round2('id 缩短到 8 字符（两侧一致）', withId('toolu_ab'), 'toolu_ab')
await round2('id 加长到 86 字符（两侧一致）', withId(LONG_ID), LONG_ID)
await round2('id 两侧不一致（对照，应失败）', withId('toolu_mismatch'), 'toolu_other')

writeFileSync('/tmp/cc-messages-probe-E.json', JSON.stringify(results, null, 2))
console.log('\n\n结果已存 /tmp/cc-messages-probe-E.json')
