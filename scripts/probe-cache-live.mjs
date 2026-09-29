/**
 * Authenticated, paid issue #64 cache probe against Command Code's CLI route.
 * It uses only synthetic conversation text and generated images. The report
 * contains numeric usage and request hashes, never credentials or raw content.
 *
 * Run: node --import tsx scripts/probe-cache-live.mjs
 * Override: LIVE_PREFIX_LINES=2000 LIVE_REPORT_PATH=/private/tmp/report.json
 * Set LIVE_ENGINE_MODULES to the dsh engine's node_modules directory when the
 * local rc.2 engine is installed somewhere other than the default below.
 * LIVE_IMAGE_NOTE_MODE=none removes the image-carrier note for an A/B run.
 * LIVE_CACHE_MARK=image tests an ephemeral marker on image content blocks.
 * LIVE_ADAPTER_OFFLOAD=1 drives the opt-in adapter failure through the real
 * dsh image-offload selector, then retries against the live service.
 * LIVE_CLI_PARITY=1 removes plugin-only tool type/temperature fields and sets
 * the official CLI's standard permission mode, without changing image history.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandCodeAdapter, resolveAuthFileApiKey } from '../src/adapter.ts'

const engineModules = process.env.LIVE_ENGINE_MODULES ?? '/Users/mars-sea/.npm/_npx/4f4f47d9854f3c73/node_modules'
const requireEngine = createRequire(`${engineModules}/@deepseek-ai/dsh-attachment-local/package.json`)
const sharp = requireEngine('sharp')
const { readRequestImageFile } = await import(`${engineModules}/@deepseek-ai/dsh-attachment-local/lib/index.js`)
const { offloadOldestImages } = await import(`${engineModules}/@deepseek-ai/dsh-compaction-image-offload/lib/types/image-offload.js`)

const key = process.env.COMMANDCODE_API_KEY ?? resolveAuthFileApiKey()
if (!key) throw new Error('Command Code credential unavailable')
const reportPath = process.env.LIVE_REPORT_PATH ?? '/private/tmp/commandcode-issue64-live-report.json'
const cacheRoot = '/private/tmp/commandcode-issue64-live-images'
const imageNoteMode = process.env.LIVE_IMAGE_NOTE_MODE ?? 'normal'
assert(['normal', 'none'].includes(imageNoteMode))
const cacheMarkMode = process.env.LIVE_CACHE_MARK ?? 'none'
assert(['none', 'image', 'image-tail-text'].includes(cacheMarkMode))
const offloadAfterImage = process.env.LIVE_OFFLOAD_AFTER_IMAGE === '1'
const adapterOffload = process.env.LIVE_ADAPTER_OFFLOAD === '1'
assert(!(offloadAfterImage && adapterOffload), 'choose one offload mode')
const cliParityMode = process.env.LIVE_CLI_PARITY === '1'
const growthMode = process.env.LIVE_GROWTH_MODE === '1'
const model = 'deepseek/deepseek-v4.1-flash'
const sessionId = process.env.LIVE_SESSION_ID ?? 'session-123e4567-e89b-42d3-a456-426614174002'
const hash = (value) => createHash('sha256').update(value).digest('hex')
let nextId = 0
const message = (role, content, extra = {}) => ({
  id: `synthetic-${++nextId}`, role, content,
  source: role === 'assistant' ? { kind: 'model', provider: 'commandcode', model } : { kind: 'user' },
  ...extra,
})
const text = (value) => ({ type: 'text', text: value })
const lines = Number(process.env.LIVE_PREFIX_LINES ?? 2000)
const prefixSalt = process.env.LIVE_PREFIX_SALT ?? ''
assert(Number.isSafeInteger(lines) && lines >= 1 && lines <= 5000)
const prefix = `${prefixSalt}\n` + Array.from({ length: lines }, (_, i) =>
  `synthetic-file-${String(i).padStart(5, '0')}: parse module ${i % 97} with call ${i % 311}; record sorted events and return deterministic status ${i.toString(36)}.`,
).join('\n')

const sources = new Map()
for (let i = 1; i <= 3; i++) {
  const data = new Uint8Array(await sharp({ create: {
    width: 1800, height: 1200, channels: 3,
    background: { r: i * 54, g: i * 37, b: i * 61 },
  } }).png().toBuffer())
  const ref = { attachmentId: `sha256:${hash(data)}`, mediaType: 'image/png', bytes: data.byteLength, width: 1800, height: 1200 }
  sources.set(ref.attachmentId, { ref, data })
}
const refs = [...sources.values()].map(({ ref }) => ref)
const attachments = {
  readImageRequest: async (ref, target) => {
    const source = sources.get(ref.attachmentId)
    assert(source, 'unknown synthetic image')
    return readRequestImageFile(cacheRoot, source, target)
  },
}

let inFlight
const adapter = new CommandCodeAdapter({
  options: () => ({
    apiBase: 'https://api.commandcode.ai', workingDir: '/synthetic/issue64',
    modelsCachePath: '/private/tmp/cc-issue64-models.json',
    requestTimeoutMs: 60_000, streamIdleTimeoutMs: 120_000, protocol: 'cli',
    offloadSeenImagesForCache: adapterOffload,
  }),
  resolveApiKey: async () => key,
  resolveAttachments: () => attachments,
  fetchImpl: async (input, init) => {
    const body = JSON.parse(String(init?.body))
    if (imageNoteMode === 'none') {
      for (const wireMessage of body.params.messages) {
        if (wireMessage.role !== 'user' || !Array.isArray(wireMessage.content)) continue
        if (!wireMessage.content.some((item) => item.type === 'image')) continue
        wireMessage.content = wireMessage.content.filter((item) =>
          item.type !== 'text' || !/^Attached image\(s\) from tool result \(/.test(item.text))
      }
    }
    if (cacheMarkMode === 'image') {
      for (const wireMessage of body.params.messages) {
        if (!Array.isArray(wireMessage.content)) continue
        for (const item of wireMessage.content) {
          if (item.type === 'image') item.cache_control = { type: 'ephemeral' }
        }
      }
    }
    if (cacheMarkMode === 'image-tail-text') {
      for (const wireMessage of body.params.messages) {
        if (wireMessage.role !== 'user' || !Array.isArray(wireMessage.content)) continue
        if (wireMessage.content.some((item) => item.type === 'image')) {
          wireMessage.content.push({ type: 'text', text: '[end of image]', cache_control: { type: 'ephemeral' } })
        }
      }
    }
    if (cliParityMode) {
      body.params.tools = body.params.tools.map(({ type, ...tool }) => {
        assert.equal(type, 'function')
        return tool
      })
      delete body.params.temperature
      body.permissionMode = 'standard'
    }
    const wireMessages = body.params.messages
    const hashes = wireMessages.map((item) => hash(JSON.stringify(item)))
    const previous = inFlight.previousHashes
    inFlight.messageCount = hashes.length
    inFlight.prefixStable = previous === undefined || previous.every((item, i) => item === hashes[i])
    inFlight.staticHash = hash(JSON.stringify({
      config: body.config, system: body.params.system,
      tools: body.params.tools, threadId: body.threadId,
    }))
    inFlight.hashes = hashes
    inFlight.path = new URL(String(input)).pathname
    const response = await fetch(input, imageNoteMode === 'normal' && cacheMarkMode === 'none' && !cliParityMode ? init : { ...init, body: JSON.stringify(body) })
    inFlight.httpStatus = response.status
    inFlight.requestId = response.headers.get('x-request-id') ?? undefined
    return response
  },
})

const tools = Array.from({ length: 26 }, (_, i) => ({
  name: i === 0 ? 'read_image' : `synthetic_tool_${i}`,
  description: `Synthetic test tool ${i}`,
  parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
}))
const messages = [message('user', [text(`Inspect this synthetic log; reply with only OK.\n${prefix}`)])]
const report = {
  fixture: { model, protocol: 'cli', imageNoteMode, cacheMarkMode, offloadAfterImage, adapterOffload, cliParityMode, growthMode, textLines: lines, textCharacters: prefix.length, imageDimensions: [1800, 1200], toolCount: tools.length, saltedPrefix: prefixSalt !== '' },
  requests: [],
}
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })

async function run(label) {
  const started = Date.now()
  const entry = { label }
  const previous = report.requests.at(-1)
  inFlight = { previousHashes: previous?.hashes }
  let output = ''
  for (let retry = 0; ; retry++) {
    try {
      for await (const chunk of adapter.stream({
        provider: 'commandcode', model, sessionId,
        system: 'This is a synthetic cache probe. Respond with only OK.',
        tools, maxTokens: 256, messages,
      })) {
        entry.firstChunkMs ??= Date.now() - started
        if (chunk.type === 'text-delta') output += chunk.text ?? ''
        if (chunk.type === 'usage') entry.usage = chunk.usage
        if (chunk.type === 'finish') entry.finish = chunk.reason
      }
      entry.ok = true
      break
    } catch (error) {
      if (adapterOffload && error?.code === 'IMAGE_OFFLOAD_REQUIRED' && retry < 5) {
        const count = error.failure?.offloadImages
        assert(Number.isSafeInteger(count) && count > 0)
        const events = messages.map((item) => ({
          type: item.role === 'user' ? 'user/message' : item.role === 'tool' ? 'tool/result' : 'assistant/message',
          message: item,
        }))
        let selected = 0
        const session = {
          eventAt: (seq) => events[seq - 1],
          deriveEventMessage: (event) => event.message,
          append: (type, data) => {
            assert.equal(type, 'image/offload')
            for (const target of data.targets) {
              const images = events[target.seq - 1].message.content.filter((block) => block.type === 'image')
              for (const index of target.imageIndexes) {
                assert(images[index] && images[index].offloaded !== true)
                images[index].offloaded = true
                selected++
              }
            }
          },
        }
        assert(offloadOldestImages(session, events.map((_, index) => index + 1), count))
        entry.offloadedImages = (entry.offloadedImages ?? 0) + selected
        continue
      }
      entry.ok = false
      entry.error = { code: error?.code, message: String(error?.message).slice(0, 200) }
      break
    }
  }
  entry.elapsedMs = Date.now() - started
  entry.path = inFlight.path
  entry.httpStatus = inFlight.httpStatus
  entry.requestId = inFlight.requestId
  entry.messageCount = inFlight.messageCount
  entry.prefixStable = inFlight.prefixStable
  entry.staticHash = inFlight.staticHash
  entry.hashes = inFlight.hashes
  entry.outputCharacters = output.length
  report.requests.push(entry)
  save()
  console.log(JSON.stringify({ label, ok: entry.ok, httpStatus: entry.httpStatus,
    elapsedMs: entry.elapsedMs, firstChunkMs: entry.firstChunkMs,
    inputTokens: entry.usage?.inputTokens, cacheReadTokens: entry.usage?.cacheReadTokens,
    cacheWriteTokens: entry.usage?.cacheWriteTokens,
    prefixStable: entry.prefixStable, messageCount: entry.messageCount,
    errorCode: entry.error?.code, offloadedImages: entry.offloadedImages }))
  if (!entry.ok) throw new Error(`Live request ${label} failed; see ${reportPath}`)
  if (output) messages.push(message('assistant', [text(output)]))
}

function addUser(value) { messages.push(message('user', [text(value)])) }
function addImage(index) {
  const callId = `call-synthetic-image-${index}`
  messages.push(message('assistant', [{ type: 'tool-call', id: callId, name: 'read_image', arguments: JSON.stringify({ file_path: `/synthetic/image-${index}.png` }) }]))
  messages.push(message('tool', [text(`Synthetic image ${index}, 1800x1200`), { type: 'image', attachment: refs[index - 1] }], {
    toolCallId: callId, isError: false, source: { kind: 'tool', callId },
  }))
}

function addTextOnlyToolResult() {
  const callId = 'call-synthetic-text-control'
  messages.push(message('assistant', [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{"file_path":"/synthetic/text-only.txt"}' }]))
  messages.push(message('tool', [text('Synthetic text-only tool result. '.repeat(45))], {
    toolCallId: callId, isError: false, source: { kind: 'tool', callId },
  }))
}

try {
  const markOldImagesOffloaded = () => {
    if (!offloadAfterImage) return
    for (const prior of messages) {
      for (const block of prior.content) {
        if (block.type === 'image') block.offloaded = true
      }
    }
  }
  await run('base')
  if (growthMode) {
    addUser('Inspect synthetic image 1. Reply OK.')
    addImage(1)
    await run('image-1')
    markOldImagesOffloaded()
    addUser(`Continue after image 1. Reply OK.\n${prefix}`)
    await run('growth-text')
    addUser('Inspect synthetic image 2. Reply OK.')
    addImage(2)
    await run('image-2')
  } else {
    addUser('Continue reading the same synthetic log. Reply OK.')
    await run('text-after-base')
    for (let i = 1; i <= 3; i++) {
      addUser(`Inspect synthetic image ${i}. Reply OK.`)
      addImage(i)
      await run(`image-${i}`)
      markOldImagesOffloaded()
      addUser(`Continue after image ${i}. Reply OK.`)
      await run(`text-after-image-${i}`)
      if (i === 1) {
        addUser('Inspect the synthetic text-only tool result. Reply OK.')
        addTextOnlyToolResult()
        await run('text-tool-control')
        addUser('Continue after the text-only tool result. Reply OK.')
        await run('text-after-tool-control')
      }
    }
  }
  report.complete = true
  save()
  console.log(JSON.stringify({ complete: true, reportPath }))
} catch (error) {
  report.complete = false
  save()
  console.error(String(error?.message).slice(0, 200))
  process.exitCode = 1
}
