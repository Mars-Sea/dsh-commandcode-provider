/**
 * 阶段 0 探测：采集 /provider/v1/messages 的真实 wire 契约。
 *
 * 分两组：
 *   A 组 —— 故意发错的请求，网关侧早退，不产生 output token，成本近乎为零。
 *   B 组 —— 必须用 claude-sonnet-5-5（GOAT 套餐下唯一可用的 Claude 模型），
 *           max_tokens 一律设到最小。
 *
 * 只输出状态码、事件类型序列、字段名与形状，不保存正文、不打印凭据。
 */
import { writeFileSync } from 'node:fs'
import { resolveAuthFileApiKey } from '../src/adapter.ts'

const KEY = resolveAuthFileApiKey()
const ENDPOINT = 'https://api.commandcode.ai/provider/v1/messages'
const BASE_HEADERS = {
  'content-type': 'application/json',
  'accept-encoding': 'identity',
  Authorization: `Bearer ${KEY}`,
}
const out = { groupA: [], groupB: [] }

async function post(body, { stream = true } = {}) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...BASE_HEADERS, Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 把 SSE 流拆成事件序列：{event, data} 列表。保留 data 的键名形状，不保留长文本。 */
function shape(value, depth = 0) {
  if (value === null || value === undefined) return value === null ? 'null' : 'undefined'
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : []
  if (typeof value === 'object') {
    if (depth > 4) return '{…}'
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]))
  }
  if (typeof value === 'string') return value.length > 40 ? `<str:${value.length}>` : value
  return value
}

/** SSE 的 `event:` 行和 `data:` 行属于同一个事件，取最后一条或新建。 */
function lastSlot(events) {
  const tail = events.at(-1)
  if (tail && tail.event !== undefined && tail.data === undefined) return tail
  const slot = {}
  events.push(slot)
  return slot
}

async function readSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '')
      if (!trimmed) continue
      const slot = lastSlot(events)
      if (trimmed.startsWith('event:')) { slot.event = trimmed.slice(6).trim(); continue }
      if (!trimmed.startsWith('data:')) continue
      const raw = trimmed.slice(5).trim()
      if (raw === '[DONE]') { slot.done = true; continue }
      try { slot.data = shape(JSON.parse(raw)) } catch { slot.raw = raw.slice(0, 120) }
    }
  }
  return events
}

// ---------------------------------------------------------------- A 组（零成本）

console.log('\n========== A 组：网关契约（早退，不产生 output） ==========\n')

// A1 已采：非 Claude 模型路由错误。
const a1 = await post({ model: 'stealth/space-bunny-alpha', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
out.groupA.push({ id: 'A1 非Claude路由错误', status: a1.status, body: shape(JSON.parse(await a1.text())) })
console.log(`A1 非 Claude 路由错误        ${a1.status}  ${JSON.stringify(out.groupA.at(-1).body)}`)

// A3 网关是否跨端点强校验工具 schema 根类型（issue #35 规则是否适用于 Messages）。
for (const [label, parameters] of [
  ['无 type 的 object 形状', { properties: { a: { type: 'string' } }, required: ['a'] }],
  ['完全无 type 的空 schema', {}],
  ['正常 type:object', { type: 'object', properties: { a: { type: 'string' } } }],
]) {
  const r = await post({ model: 'claude-sonnet-5-5', max_tokens: 1, stream: false,
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [{ name: 't', description: 'd', input_schema: parameters }] })
  const text = await r.text()
  let parsed; try { parsed = shape(JSON.parse(text)) } catch { parsed = text.slice(0, 120) }
  out.groupA.push({ id: `A3 工具schema: ${label}`, status: r.status, body: parsed })
  console.log(`A3 schema ${label.padEnd(18)} ${r.status}  ${JSON.stringify(parsed).slice(0, 110)}`)
}

// A4 max_tokens 全局顶（服务端全局 200000，超出即 400）。
for (const max of [200_000, 200_704, 1_000_000]) {
  const r = await post({ model: 'claude-sonnet-5-5', max_tokens: max, stream: false, messages: [{ role: 'user', content: 'Hi' }] })
  const text = await r.text()
  let parsed; try { parsed = shape(JSON.parse(text)) } catch { parsed = text.slice(0, 100) }
  out.groupA.push({ id: `A4 max_tokens=${max}`, status: r.status, body: parsed })
  console.log(`A4 max_tokens=${String(max).padEnd(9)}      ${r.status}  ${JSON.stringify(parsed).slice(0, 110)}`)
}

// A5 必填字段与非法字段校验。
for (const [label, body] of [
  ['缺 max_tokens', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Hi' }] }],
  ['缺 messages', { model: 'claude-sonnet-5-5', max_tokens: 1 }],
  ['未知顶层字段', { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }], totally_unknown_field: 1 }],
  ['system 为字符串', { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }], system: 'You are terse.' }],
  ['assistant 首条', { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }],
  ['空 messages', { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] }],
]) {
  const r = await post({ ...body, stream: false })
  const text = await r.text()
  let parsed; try { parsed = shape(JSON.parse(text)) } catch { parsed = text.slice(0, 100) }
  out.groupA.push({ id: `A5 ${label}`, status: r.status, body: parsed })
  console.log(`A5 ${label.padEnd(20)}      ${r.status}  ${JSON.stringify(parsed).slice(0, 105)}`)
}

// A6 错误走 HTTP 状态码还是流内 error 事件。
const a6 = await post({ model: 'claude-sonnet-5-5', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'Hi' }], bogus_field: true })
let a6body
if (a6.body) a6body = await readSse(a6)
else a6body = await a6.text()
out.groupA.push({ id: 'A6 流式+非法字段', status: a6.status, shape: a6body })
console.log(`A6 流式 + 非法字段           ${a6.status}  ${JSON.stringify(a6body).slice(0, 220)}`)

// A7 非流式响应的完整形状（含 usage）。
const a7 = await post({ model: 'claude-sonnet-5-5', max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'Hi' }] })
const a7text = await a7.text()
let a7parsed; try { a7parsed = shape(JSON.parse(a7text)) } catch { a7parsed = a7text.slice(0, 150) }
out.groupA.push({ id: 'A7 非流式响应形状', status: a7.status, body: a7parsed })
console.log(`A7 非流式响应形状            ${a7.status}\n   ${JSON.stringify(a7parsed, null, 1).replace(/\n\s*/g, ' ').slice(0, 700)}`)

writeFileSync('/tmp/cc-messages-probe-A.json', JSON.stringify(out.groupA, null, 2))
console.log('\nA 组结果已存 /tmp/cc-messages-probe-A.json')
