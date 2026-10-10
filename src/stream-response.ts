/** 单次成功连接后的响应过程：拥有读取、协议终止、取消、最终用量和本地释放。
 * 调度层只转交响应；三种线上事件的装配差异保留在本模块内部。 */
import { randomUUID } from 'node:crypto'
import { LlmError, ProviderRequestId, ToolCallId, errorChain, type FinishReason, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { bilingual, streamErrorToLlmError } from './provider-errors.ts'
import { isRecord, numberValue, stringValue, recordOrEmpty } from './wire-guards.ts'
import { boundTraceText, STREAM_TRACE_ENV, type StreamTrace } from './stream-trace.ts'
import type { RequestTiming } from './request-timing.ts'

/** 仅供本次消费生命周期使用，不作为服务商错误或用户取消向外传播。 */
class ConsumerStreamClosed extends Error {}

/**
 * 读循环唤醒闸门的标记值：底层 read() 既不结算、取消也叫不醒时，由闸门结束这次等待。
 * 它不是错误，只在读循环内部出现，用来把「读取完成」与「读取卡住」区分开。
 */
const READ_STALLED = Symbol('readStalled')

/**
 * 异步生成器的 return 会排在正在等待的 next 后面，因此必须先通过独立信号
 * 唤醒当前读取，再让生成器执行 finally。消费方已结束时不再交付用量或错误。
 */
export function ownedResponseStream(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const consumer = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, consumer.signal]) : consumer.signal
  const source = run(signal)[Symbol.asyncIterator]()
  let closed = false
  const done = (): IteratorResult<StreamChunk> => ({ done: true, value: undefined })
  const iterator: AsyncIterableIterator<StreamChunk> = {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (closed) return done()
      try {
        const result = await source.next()
        return closed ? done() : result
      } catch (error) {
        if (closed) return done()
        throw error
      }
    },
    async return() {
      if (!closed) {
        closed = true
        consumer.abort(new ConsumerStreamClosed('消费方已结束读取'))
      }
      await source.return?.()
      return done()
    },
  }
  return iterator
}

export interface StreamResponseContext {
  protocol: CommandCodeProtocol
  signal: AbortSignal | undefined
  maxTokens: number
  apiBase: string
  streamIdleTimeoutMs: number
  responseMetadata: ResponseMetadata
  trace: StreamTrace
  timing: RequestTiming
  /** 解除连接阶段转交的取消监听；任何退出路径均调用一次。 */
  cleanup(): void
}

/** 唯一过程入口；诊断或释放失败不能在成功结束后再制造第二个结束。 */
export async function* settleStreamResponse(response: Response, context: StreamResponseContext): AsyncIterable<StreamChunk> {
  try { yield* readResponse(response, context) }
  finally {
    try { context.cleanup() } catch { /* 本地连接监听释放失败不改变模型结果。 */ }
    context.trace.close()
  }
}

async function* readResponse(response: Response, context: StreamResponseContext): AsyncIterable<StreamChunk> {
  const { protocol, signal, maxTokens, apiBase, streamIdleTimeoutMs, responseMetadata, trace, timing } = context
  if (!response.body) {
    trace.record('end', { outcome: 'empty', code: 'PROVIDER_PROTOCOL_ERROR' })
    throw failureWithRequestId(new LlmError('Command Code API returned no response body', 'PROVIDER_PROTOCOL_ERROR'), responseMetadata)
  }

  // --- SSE/JSONL event stream -> harness StreamChunk protocol ---
  const reader = response.body.getReader()
  const cancelReader = () => {
    try { void reader.cancel().catch(() => undefined) }
    catch { /* 已释放的读取器不影响已决定的终止结果。 */ }
  }
  // 读取唤醒闸门：空闲计时器与取消信号都先解开它，再尽力取消底层读取。合规流上
  // cancel() 自己就会以 done 结算挂起的 read()；但被包装或被垫片替换的 body 可能
  // 既不给结果也不响应取消，只依赖 cancel() 会让空闲期限、调用者取消和消费方结束
  // 三条路径一起卡死。闸门让这三条路径始终有界，且不改变正常读取的顺序。
  let openGate: (() => void) | undefined
  const wakeRead = () => openGate?.()
  const onAbort = () => { wakeRead(); cancelReader() }
  const decoder = new TextDecoder()
  let buffer = ''

  // The request fingerprint was recorded before connect; this is the
  // response half of the same opt-in trace. See ./stream-trace.ts for why
  // the raw response stream remains the artifact that separates a provider
  // cut from a parser miss.
  const streamStartedAt = Date.now()
  let chunkCount = 0
  let totalBytes = 0
  let lastChunkAt = streamStartedAt

  // Stream idle watchdog: a generation that stalls this long has a dead
  // connection (the API keeps the socket open between reasoning/text
  // bursts). The default (300s) is deliberately generous — frontier
  // reasoning models can legitimately stay silent for minutes while
  // thinking, and the official CLI sets no idle cap at all. Firing opens the
  // read gate — so the loop ends even for a reader that ignores cancel() —
  // and best-effort cancels the underlying read; the loop turns that into a
  // TIMEOUT failure instead of hanging forever.
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleFired = false
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      wakeRead()
      cancelReader()
    }, streamIdleTimeoutMs)
  }
  const clearIdle = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }
  /** 空闲期限结束读循环时的唯一错误文本；读取结算与读取卡住两条路径共用。 */
  const idleTimeoutError = () => bilingual(
    'TIMEOUT',
    `Command Code API stream from ${apiBase} was idle for ${streamIdleTimeoutMs}ms`
    + ' (no events) and was treated as a dead connection',
    `Command Code API 流式响应已 ${streamIdleTimeoutMs} 毫秒无任何事件，被判定为死连接——长思考模型可在设置中调大流空闲超时`,
  )

  const asm = createBlockAssembler()
  let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
  let usage: TokenUsage | undefined
  let usageEmitted = false
  let endRecorded = false
  let protocolStopped = false
  /** 读循环收束（读到 EOF 或读取卡住）共用的诊断事实，两处记录字段保持一致。 */
  const eofFacts = () => ({
    chunks: chunkCount,
    bytes: totalBytes,
    silentMs: Date.now() - lastChunkAt,
    totalMs: Date.now() - streamStartedAt,
    finishSeen: finish !== undefined,
    idleFired,
    buffered: buffer.length,
  })
  // Do not publish success until the assembled answer has been checked.
  // DSH converts an adapter throw into an error finish; throwing AFTER a
  // success finish would violate its single-terminal-event contract.
  function* handle(event: unknown): Generator<StreamChunk> {
    captureResponseIdentifiers(responseMetadata, event)
    if (isRecord(event) && ((protocol === 'messages' && event.type === 'message_stop')
      || (protocol === 'cli' && event.type === 'finish'))) protocolStopped = true
    const chunks = handleEvent(asm, protocol, event)
    // 一个线上事件已经解析完毕后，先保存其结束与用量事实。消费者可在
    // 任意块片段处取消；取消只停止交付，不能丢掉此时已经解析到的用量。
    for (const chunk of chunks) {
      if (chunk.type === 'finish') finish = chunk
      else if (chunk.type === 'usage') usage = chunk.usage
    }
    for (const chunk of chunks) {
      if (chunk.type === 'finish' || chunk.type === 'usage') continue
      signal?.throwIfAborted()
      yield chunk
    }
  }
  function* handleLine(line: string): Generator<StreamChunk> {
    signal?.throwIfAborted()
    if (protocol === 'openai' && line.trim().replace(/^data:\s*/, '') === '[DONE]') {
      protocolStopped = true
      return
    }
    yield* handle(parseStreamEventLine(line))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      let read: ReadableStreamReadResult<Uint8Array> | typeof READ_STALLED
      // 每次读取换一个新闸门：上一轮的闸门一旦解开就不再代表这次等待。
      const gate = new Promise<typeof READ_STALLED>(resolve => { openGate = () => resolve(READ_STALLED) })
      armIdle()
      try {
        const pending = reader.read()
        // 闸门先到时这个读取会被放弃：它可能永不结算，也可能迟到以「读取器已释放」
        // 拒绝。结果已经不再需要，挂一个空 catch 免得它升级成未处理拒绝（Node 默认致命）。
        void pending.catch(() => undefined)
        read = await Promise.race([pending, gate])
      } catch (error: unknown) {
        // A mid-stream transport failure (connection reset, TLS teardown)
        // surfaces here. Caller cancellation propagates as-is.
        signal?.throwIfAborted()
        trace.record('read-error', {
          chunks: chunkCount,
          bytes: totalBytes,
          silentMs: Date.now() - lastChunkAt,
          message: errorChain(error),
        })
        throw bilingual(
          'TRANSPORT',
          `Command Code API stream from ${apiBase} failed while reading: ${errorChain(error)}`,
          'Command Code API 流式响应中途断开——网络波动所致，重试通常可恢复',
          { cause: error },
        )
      } finally {
        clearIdle()
        openGate = undefined
      }
      if (read === READ_STALLED) {
        // 期限或取消叫不醒底层读取：闸门自己结束等待。取消优先——调用者取消必须
        // 原样传播，不能被记成超时失败；只有在没有取消时才按空闲期限失败。
        trace.record('eof', { ...eofFacts(), readStalled: true })
        signal?.throwIfAborted()
        throw idleTimeoutError()
      }
      signal?.throwIfAborted()
      const { done, value } = read
      if (done) {
        // The idle watchdog cancels the reader to unblock a stalled read;
        // cancel() resolves a pending read() as done, so a done here after
        // the watchdog fired is a timeout, not a normal stream end.
        trace.record('eof', eofFacts())
        if (idleFired) throw idleTimeoutError()
        if (buffer.trim()) {
          // The final line may lack its trailing newline; it uses the same
          // terminal validation as events parsed in the line loop.
          yield* handleLine(buffer)
        }
        break
      }
      const text = decoder.decode(value, { stream: true })
      if (value.byteLength > 0) timing.first('firstByteMs')
      buffer += text
      chunkCount += 1
      totalBytes += value.byteLength
      lastChunkAt = Date.now()
      trace.record('chunk', {
        n: chunkCount,
        bytes: value.byteLength,
        text: boundTraceText(text),
      })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const [index, line] of lines.entries()) {
        yield* handleLine(line)
        if (protocolStopped) {
          let ignoredLines = 0
          for (let rest = index + 1; rest < lines.length; rest++) if (lines[rest]?.trim()) ignoredLines++
          const buffered = buffer.trim().length
          if (ignoredLines > 0 || buffered > 0) trace.record('protocol-stop', { protocol, ignoredLines, buffered })
          break
        }
      }
      // OpenAI 的 finish_reason 之后还可能有独立用量包；Messages 在
      // message_stop 才结束。CLI 的 finish 则本身就是协议终止事件。
      if (protocolStopped) break
    }
    signal?.throwIfAborted()
    // Preserve the provider's usage even when this attempt fails. Usage is
    // cumulative, so only the latest sample is emitted, before the terminal.
    if (usage !== undefined) {
      usageEmitted = true
      yield { type: 'usage', usage }
    }
    signal?.throwIfAborted()
    if (finish !== undefined) {
      const failure = asm.sawContent
        ? undefined
        : emptyCompletionError(asm.finishReason, maxTokens, usage)
      trace.record('end', {
        outcome: failure === undefined
          ? 'finished'
          : failure.code === 'OUTPUT_TOKEN_LIMIT'
            ? 'output-token-limit'
            : 'empty',
        finishReason: asm.finishReason,
        ...(failure === undefined ? {} : { code: failure.code }),
        maxTokens,
        ...(usage === undefined ? {} : { usage }),
        chunks: chunkCount,
        bytes: totalBytes,
        totalMs: Date.now() - streamStartedAt,
        sawContent: asm.sawContent,
        responseMetadata,
      })
      endRecorded = true
      if (failure !== undefined) throw failure
      // One envelope for both halves: response-level correlation ids and,
      // on the Messages transport, the per-block thinking signature the next
      // request must replay. DSH discards the whole envelope when `blocks`
      // does not line up with the emitted block count, so the array is
      // indexed by the same chunk index that was allocated at block-start.
      const replayBlocks = asm.replayBlocks
      const carryReplay = hasResponseIdentifiers(responseMetadata) || replayBlocks.length > 0
      yield carryReplay
        ? {
            ...finish,
            replayState: {
              response: responseMetadata,
              ...(replayBlocks.length > 0 ? { blocks: replayBlocks } : {}),
            },
          }
        : finish
    } else {
      // 未收到生成结束原因的 EOF 不能伪造成功；正文或工具片段存在时
      // 按断流处理，纯思考或空白仍按空响应处理，保留既有重试分类。
      const elapsed = Date.now() - streamStartedAt
      const detail = `${chunkCount} chunk(s), ${totalBytes} bytes, ${elapsed}ms`
      trace.record('end', {
        outcome: asm.sawContent ? 'stream-closed' : 'empty',
        chunks: chunkCount,
        bytes: totalBytes,
        totalMs: elapsed,
        sawContent: asm.sawContent,
        responseMetadata,
      })
      endRecorded = true
      if (!asm.sawContent) {
        // Nothing usable came out of it (no visible text, no tool call): the
        // request has no tool action to replay, and this code is in the retry
        // policy's whitelist — the cut is absorbed instead of surfaced. A cut
        // during a long thinking phase lands here.
        throw bilingual('EMPTY_RESPONSE', 'Command Code returned an empty response', 'Command Code 返回了空响应，重试通常可恢复')
      }
      throw bilingual(
        'STREAM_CLOSED',
        `Command Code API stream from ${apiBase} ended before its finish event (${detail})`
        + ' — the response was closed mid-generation, so this is not the model stopping by itself',
        'Command Code API 流式响应在结束事件之前被关闭（生成中途断流），并非模型主动结束——请重试'
        + `；若频繁出现，可用 ${STREAM_TRACE_ENV}=<文件路径> 抓取原始流以定位断流原因`,
      )
    }
  } catch (error: unknown) {
    // A later read/provider error must not discard usage already received.
    if (!usageEmitted && usage !== undefined) yield { type: 'usage', usage }
    if (!endRecorded) {
      trace.record('end', {
        outcome: signal?.aborted ? signal.reason instanceof ConsumerStreamClosed ? 'cancelled' : 'aborted' : 'error',
        code: error instanceof LlmError ? error.code : 'unknown',
        finishReason: asm.finishReason,
        maxTokens,
        ...(usage === undefined ? {} : { usage }),
        sawContent: asm.sawContent,
        chunks: chunkCount,
        bytes: totalBytes,
        totalMs: Date.now() - streamStartedAt,
        responseMetadata,
      })
    }
    endRecorded = true
    signal?.throwIfAborted()
    throw failureWithRequestId(error, responseMetadata)
  } finally {
    clearIdle()
    signal?.removeEventListener('abort', onAbort)
    // 消费者提前结束没有继续接收的能力，不能在 finally 强行交付用量。
    if (!endRecorded) trace.record('end', { outcome: signal?.aborted && !(signal.reason instanceof ConsumerStreamClosed) ? 'aborted' : 'cancelled',
      ...(usage === undefined ? {} : { usage }), chunks: chunkCount, bytes: totalBytes, responseMetadata })
    cancelReader()
    // 取消立即终止本地读取；不等底层 cancel 承诺，以免它拖住整个响应。
    try { reader.releaseLock() } catch { /* 本地清理失败不覆盖成功或原始错误。 */ }
  }
}

/**
 * Endpoint protocol selected for one generate call.
 *
 * `messages` is the Anthropic Messages surface at
 * `{apiBase}/provider/v1/messages`, the only Provider API route the Claude
 * family answers (posted to `/chat/completions` they refuse with `400 Model
 * "<id>" must be called via /provider/v1/messages`). `openai` is the
 * documented Chat Completions surface; `cli` is Command Code's private
 * `/alpha/generate` transport, kept for Go-plan keys (the one plan without
 * Provider API access) and as the `upgrade_required` fallback.
 */
export type CommandCodeProtocol = 'cli' | 'openai' | 'messages'

/** Only provider correlation headers, never a wholesale response-header dump. */
const RESPONSE_ID_HEADERS = ['x-request-id', 'request-id', 'x-trace-id', 'x-generation-id', 'traceparent'] as const

export function responseIdentifiers(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of RESPONSE_ID_HEADERS) {
    const value = diagnosticId(headers.get(name))
    if (value !== undefined) result[name] = value
  }
  return result
}

function diagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 ? value : undefined
}

/** Small, JSON-only response facts that DSH can retain on the assistant source. */
export interface ResponseMetadata {
  protocol: CommandCodeProtocol
  headers: Record<string, string>
  responseId?: string
  generationId?: string
  providerRequestId?: string
  traceId?: string
}

function captureResponseIdentifiers(metadata: ResponseMetadata, event: unknown): void {
  if (!isRecord(event)) return
  // An OpenAI completion id or an AI SDK response-metadata id names the
  // response. A tool-call id does not, so never collect generic CLI event ids.
  if ((metadata.protocol === 'openai' && Array.isArray(event.choices)) || event.type === 'response-metadata') {
    const id = diagnosticId(event.id)
    if (id !== undefined) metadata.responseId = id
  }
  for (const name of ['generationId', 'providerRequestId', 'traceId'] as const) {
    const id = diagnosticId(event[name])
    if (id !== undefined) metadata[name] = id
  }
}

function hasResponseIdentifiers(metadata: ResponseMetadata): boolean {
  return Object.keys(metadata.headers).length > 0 || metadata.responseId !== undefined
    || metadata.generationId !== undefined || metadata.providerRequestId !== undefined || metadata.traceId !== undefined
}

/** Keep the provider's request id on DSH's durable failure, when it supplied one. */
export function failureWithRequestId(error: unknown, metadata: ResponseMetadata): unknown {
  const id = metadata.providerRequestId ?? metadata.headers['x-request-id'] ?? metadata.headers['request-id']
  if (!(error instanceof LlmError) || error.failure.requestId !== undefined || id === undefined) return error
  return new LlmError(error.message, error.code, {
    ...error.failure,
    requestId: ProviderRequestId(id),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  })
}

/**
 * Thinking text carried by an OpenRouter-shaped `reasoning_details` array,
 * concatenated in the order the gateway sent it.
 *
 * Entries are read by their own text members rather than filtered on `type`:
 * DeepSeek sends `{ type: 'reasoning.text', text }` while the OpenAI family
 * sends `{ type: 'reasoning.summary', summary }` — the same summary text the
 * scalar `delta.reasoning` carries. A `type` filter would drop one family, and
 * losing thinking is the failure this exists to prevent. `text` wins per entry,
 * but an EMPTY `text` must not shadow a populated `summary` (the Responses wire
 * emits `text: ''` placeholders), so the fallback tests for non-empty rather
 * than merely present. Encrypted-blob entries carry neither member and
 * contribute nothing; no entry carries both, so nothing is counted twice.
 *
 * Returns undefined when the array yields nothing, so the caller's `??` chain
 * keeps falling through instead of treating "no text" as a reasoning delta.
 */
function reasoningDetailsText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  let text = ''
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const exact = stringValue(entry.text)
    const summary = stringValue(entry.summary)
    text += exact !== undefined && exact !== '' ? exact : (summary ?? '')
  }
  return text === '' ? undefined : text
}

/**
 * One SCALAR thinking delta, treating an empty string as "this chunk carries
 * none" — the same rule {@link reasoningDetailsText} applies inside the array.
 * The scalar and the array describe the same thinking, so an empty spelling of
 * one must not shadow populated text in the other (the Responses wire pads with
 * `text: ''`), and `??` alone cannot express that.
 */
function nonEmptyText(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/**
 * One emitted block's replay metadata, stored in the terminal chunk's
 * `replayState.blocks` and handed back on the next request through the
 * assistant message's `source.replayState`.
 *
 * The Messages endpoint rejects a replayed `thinking` block without its
 * `signature` (`thinking.signature: Field required`), and a thinking block
 * with empty text is accepted, so the signature is the part that must
 * survive the round trip.
 */
interface MessagesReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  signature?: string
}

/**
 * 三种协议共享的块装配状态；正文与思考分别至多有一个正在输出的块。
 */
interface BlockAssembler {
  nextIndex: number
  textIndex: number
  textContent: string
  reasoningIndex: number
  reasoningContent: string
  sawContent: boolean
  /** Provider spelling, retained for terminal diagnostics rather than inferred from usage. */
  finishReason: string | undefined
  /**
   * command-code@1.65.2's standalone cache-write reading. The finish event's
   * totalUsage can report zero even though the request wrote cache entries;
   * the official CLI keeps this last valid event and uses it only as the
   * zero/missing fallback.
   */
  cliCacheWriteTokens: number | undefined
  /** Buffered OpenAI tool-call fragments, flushed at finish. */
  openAiToolCalls: Array<{ index: number; id?: string; name: string; arguments: string }>
  /** Messages-transport block state, keyed by the wire `index`. */
  messagesBlocks: Map<number, MessagesBlockState>
  /** Messages 的用量分散在开始与增量事件中，缺失字段保留此前累计值。 */
  messagesUsage: TokenUsage | undefined
  /**
   * Per-emitted-block replay metadata, indexed by the harness chunk index.
   * Only the Messages transport records entries (the thinking `signature`);
   * the other two leave it empty, which is legal — an adapter whose metadata
   * is independent of block structure omits the field entirely.
   */
  replayBlocks: MessagesReplayBlock[]
}

/** One Messages content block while it streams. */
interface MessagesBlockState {
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  signature: string
  json: string
  id: string
  name: string
  /** The harness chunk index this block was opened under, or -1 before open. */
  chunkIndex: number
}

/** Fresh block-assembly state for one stream. */
function createBlockAssembler(): BlockAssembler {
  return {
    nextIndex: 0,
    textIndex: -1,
    textContent: '',
    reasoningIndex: -1,
    reasoningContent: '',
    sawContent: false,
    finishReason: undefined,
    cliCacheWriteTokens: undefined,
    openAiToolCalls: [],
    messagesBlocks: new Map(),
    messagesUsage: undefined,
    replayBlocks: [],
  }
}

function* closeText(asm: BlockAssembler): Generator<StreamChunk> {
  if (asm.textIndex < 0) return
  yield {
    type: 'block-end',
    index: asm.textIndex,
    block: { type: 'text', text: asm.textContent },
  }
  asm.textIndex = -1
  asm.textContent = ''
}

function* closeReasoning(asm: BlockAssembler): Generator<StreamChunk> {
  if (asm.reasoningIndex < 0) return
  yield {
    type: 'block-end',
    index: asm.reasoningIndex,
    block: { type: 'reasoning', text: asm.reasoningContent },
  }
  asm.reasoningIndex = -1
  asm.reasoningContent = ''
}

function* emitOpenAiToolCalls(asm: BlockAssembler): Generator<StreamChunk> {
  for (const call of asm.openAiToolCalls) {
    const id = call.id ?? randomUUID()
    const name = call.name ?? ''
    const args = call.arguments || '{}'
    const index = asm.nextIndex++
    asm.sawContent = true
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
    }
  }
  asm.openAiToolCalls.length = 0
}


/**
 * Handle one CLI-transport (`/alpha/generate`) stream event, appending
 * harness StreamChunks. Pure over the passed assembler — no stream() locals.
 */
function handleCliEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks

  switch (event.type) {
    case 'text-delta': {
      chunks.push(...closeReasoning(asm))
      if (asm.textIndex < 0) {
        asm.textIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.textIndex, blockType: 'text' })
      }
      const delta = stringValue(event.text) ?? ''
      asm.textContent += delta
      if (delta.trim() !== '') asm.sawContent = true
      chunks.push({ type: 'text-delta', index: asm.textIndex, text: delta })
      break
    }
    case 'reasoning-delta': {
      chunks.push(...closeText(asm))
      if (asm.reasoningIndex < 0) {
        asm.reasoningIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.reasoningIndex, blockType: 'reasoning' })
      }
      const delta = stringValue(event.text) ?? ''
      asm.reasoningContent += delta
      chunks.push({ type: 'reasoning-delta', index: asm.reasoningIndex, text: delta })
      break
    }
    case 'reasoning-start':
      chunks.push(...closeText(asm))
      break
    case 'reasoning-end':
      chunks.push(...closeReasoning(asm))
      break
    case 'tool-call': {
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const id = stringValue(event.toolCallId) ?? randomUUID()
      const name = stringValue(event.toolName) ?? ''
      const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments))
      const index = asm.nextIndex++
      asm.sawContent = true
      chunks.push(
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args },
        {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
        },
      )
      break
    }
    case 'cache-write-tokens': {
      const cacheWrite = numberValue(event.cacheWriteTokens)
      if (cacheWrite !== undefined && cacheWrite >= 0) asm.cliCacheWriteTokens = cacheWrite
      break
    }
    case 'finish': {
      asm.finishReason = stringValue(event.finishReason)
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
      const capturedCacheWrite = asm.cliCacheWriteTokens
      if (usage || capturedCacheWrite !== undefined) {
        const details = isRecord(usage?.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const totalInput = numberValue(usage?.inputTokens) ?? 0
        const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
        const reportedCacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
        const cacheWrite = reportedCacheWrite === 0 && capturedCacheWrite !== undefined
          ? capturedCacheWrite
          : reportedCacheWrite
        // Harness TokenUsage counts are disjoint: uncached input only.
        const tokenUsage: TokenUsage = {
          inputTokens:
            numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
          outputTokens: numberValue(usage?.outputTokens) ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        }
        const outputDetails = isRecord(usage?.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const reasoningTokens = numberValue(outputDetails?.reasoningTokens) ?? numberValue(usage?.reasoningTokens)
        if (reasoningTokens !== undefined) tokenUsage.reasoningTokens = reasoningTokens
        chunks.push({ type: 'usage', usage: tokenUsage })
      }
      chunks.push({ type: 'finish', reason: mapFinishReason(event.finishReason) })
      break
    }
    case 'error': {
      // Classification lives in streamErrorToLlmError, shared with the
      // Provider API transport's own in-band error member so the two cannot
      // drift: a stream error that is explicitly non-retryable, carries a
      // terminal marker (quota/plan/credits), or reports a non-retryable HTTP
      // status is a hard failure, and a context-window rejection is the
      // harness's CONTEXT_WINDOW_EXCEEDED (compact and retry). Anything else
      // is a transient mid-stream drop the retry policy should repeat.
      throw streamErrorToLlmError(event.error, stringValue(event.message))
    }
  }
  return chunks
}

/**
 * Handle one OpenAI-transport (`/provider/v1/chat/completions`) SSE event.
 * Same assembler contract as {@link handleCliEvent}; tool-call fragments
 * buffer on the assembler and flush at finish.
 */
function handleOpenAIEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks
  // The Provider API transport reports a mid-stream failure as an `error` member
  // of an SSE chunk rather than as an event type of its own; ignoring it let
  // the stream end with no finish event, so a context-window or quota rejection
  // surfaced only as a generic EMPTY_RESPONSE (which the retry policy repeats)
  // and the real cause was lost.
  if (event.error !== undefined) throw streamErrorToLlmError(event.error, stringValue(event.message))
  const choices = event.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    // A standalone usage chunk (some OpenAI-compatible servers send it
    // before [DONE]) still carries usage.
    if (event.usage !== undefined) {
      chunks.push({ type: 'usage', usage: mapOpenAIUsage(event.usage) })
    }
    return chunks
  }
  const choice = isRecord(choices[0]) ? choices[0] : {}
  const delta = isRecord(choice.delta) ? choice.delta : {}

  // Thinking text arrives under a different field per model family, and the
  // gateway does not normalize the spelling: DeepSeek answers with the scalar
  // `reasoning` PLUS a `reasoning_details` array, GLM/Qwen/Kimi with the
  // DeepSeek-native `reasoning_content`, and the OpenAI family with the scalar
  // `reasoning` PLUS a `reasoning_details` array whose entry is
  // `{ type: 'reasoning.summary', summary }` (measured live 2026-09-18 on
  // gpt-5.6-luna, 6/6 rounds: the scalar and the array's `summary` carried the
  // identical text every time). All three spellings are read here, in that
  // order, so no family's thinking is dropped; the scalar wins over the array,
  // which is a forward guard rather than the live path for any family (every
  // family that sends the array also sends a scalar alongside it). See
  // {@link reasoningDetailsText} for the array's two vocabularies.
  const reasoningDelta =
    nonEmptyText(stringValue(delta.reasoning))
    ?? nonEmptyText(stringValue(delta.reasoning_content))
    ?? reasoningDetailsText(delta.reasoning_details)
    ?? ''
  if (reasoningDelta !== '') {
    chunks.push(...closeText(asm))
    if (asm.reasoningIndex < 0) {
      asm.reasoningIndex = asm.nextIndex++
      chunks.push({ type: 'block-start', index: asm.reasoningIndex, blockType: 'reasoning' })
    }
    asm.reasoningContent += reasoningDelta
    chunks.push({ type: 'reasoning-delta', index: asm.reasoningIndex, text: reasoningDelta })
  }

  const contentDelta = stringValue(delta.content) ?? ''
  if (contentDelta !== '') {
    chunks.push(...closeReasoning(asm))
    if (asm.textIndex < 0) {
      asm.textIndex = asm.nextIndex++
      chunks.push({ type: 'block-start', index: asm.textIndex, blockType: 'text' })
    }
    asm.textContent += contentDelta
    if (contentDelta.trim() !== '') asm.sawContent = true
    chunks.push({ type: 'text-delta', index: asm.textIndex, text: contentDelta })
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const rawCall of delta.tool_calls) {
      if (!isRecord(rawCall)) continue
      asm.sawContent = true
      const callIndex = numberValue(rawCall.index) ?? 0
      let existing = asm.openAiToolCalls.find((call) => call.index === callIndex)
      const fn = isRecord(rawCall.function) ? rawCall.function : undefined
      const id = stringValue(rawCall.id)
      const name = fn === undefined ? undefined : stringValue(fn.name)
      const argDelta = fn === undefined
        ? undefined
        : (stringValue(fn.arguments) ?? (fn.arguments === undefined ? '' : JSON.stringify(fn.arguments)))
      if (!existing) {
        existing = {
          index: callIndex,
          name: name ?? '',
          arguments: argDelta ?? '',
        }
        if (id !== undefined) existing.id = id
        asm.openAiToolCalls.push(existing)
      } else {
        if (id !== undefined && existing.id === undefined) existing.id = id
        if (name !== undefined && existing.name === '') existing.name = name
        if (argDelta !== undefined) existing.arguments += argDelta
      }
    }
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    asm.finishReason = stringValue(choice.finish_reason)
    chunks.push(...closeText(asm), ...closeReasoning(asm), ...emitOpenAiToolCalls(asm))
    if (event.usage !== undefined) {
      chunks.push({ type: 'usage', usage: mapOpenAIUsage(event.usage) })
    }
    chunks.push({ type: 'finish', reason: mapFinishReason(choice.finish_reason) })
  }
  return chunks
}

/**
 * Messages `usage` → the harness meter.
 *
 * The field names are the Anthropic ones, and unlike Chat Completions
 * `input_tokens` already excludes cache reads and writes, so it is mapped
 * as-is rather than reduced (the shape `dsh-llm-deepseek` implements).
 * Measured 2026-09-29: `{ input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens, output_tokens_details:
 * { thinking_tokens } }`, plus gateway additions the meter ignores.
 */
function mapMessagesUsage(raw: unknown, previous?: TokenUsage): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const inputTokens = numberValue(raw.input_tokens) ?? previous?.inputTokens ?? 0
  const outputTokens = numberValue(raw.output_tokens) ?? previous?.outputTokens ?? 0
  const cacheRead = numberValue(raw.cache_read_input_tokens) ?? previous?.cacheReadTokens ?? 0
  const cacheWrite = numberValue(raw.cache_creation_input_tokens) ?? previous?.cacheWriteTokens ?? 0
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined
  const reasoningTokens = numberValue(details?.thinking_tokens) ?? previous?.reasoningTokens
  const usage: TokenUsage = {
    inputTokens: Math.max(0, inputTokens),
    outputTokens,
    cacheReadTokens: cacheRead,
  }
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/** The harness block type one Messages content block maps to. */
function messagesBlockType(native: Record<string, unknown>): MessagesBlockState['type'] | undefined {
  if (native.type === 'text') return 'text'
  if (native.type === 'thinking') return 'reasoning'
  if (native.type === 'tool_use') return 'tool-call'
  return undefined
}

/**
 * Handle one Messages-transport stream event, appending harness StreamChunks.
 *
 * The event sequence is the Anthropic one measured on 2026-09-29:
 * `message_start`, then per content block `content_block_start` /
 * `content_block_delta`* / `content_block_stop`, then `message_delta`
 * (carrying `stop_reason` and the final usage) and `message_stop`. A `ping`
 * keepalive interleaves freely and carries no content. The terminal chunks are
 * NOT emitted here: `stream()` holds the success finish until it has validated
 * the assembled answer, and it attaches the replay envelope.
 */
function handleMessagesEvent(asm: BlockAssembler, event: unknown): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!isRecord(event)) return chunks

  switch (event.type) {
    case 'message_start': {
      const message = isRecord(event.message) ? event.message : undefined
      const usage = mapMessagesUsage(message?.usage)
      if (usage) {
        asm.messagesUsage = usage
        chunks.push({ type: 'usage', usage })
      }
      break
    }
    case 'content_block_start': {
      const wireIndex = numberValue(event.index)
      const native = isRecord(event.content_block) ? event.content_block : undefined
      const type = native ? messagesBlockType(native) : undefined
      if (wireIndex === undefined || type === undefined) break
      // Allocate the harness index only for a block this route can represent,
      // so replayBlocks stays aligned with the emitted block count.
      const chunkIndex = asm.nextIndex++
      const state: MessagesBlockState = {
        type,
        text: stringValue(native?.text) ?? '',
        signature: stringValue(native?.signature) ?? '',
        json: '',
        id: stringValue(native?.id) ?? '',
        name: stringValue(native?.name) ?? '',
        chunkIndex,
      }
      asm.messagesBlocks.set(wireIndex, state)
      asm.replayBlocks[chunkIndex] = { type }
      chunks.push({ type: 'block-start', index: chunkIndex, blockType: type })
      if (type === 'tool-call' && state.id !== '') {
        chunks.push({
          type: 'tool-call-delta',
          index: chunkIndex,
          id: ToolCallId(state.id),
          name: state.name,
          argumentsDelta: '',
        })
      }
      break
    }
    case 'content_block_delta': {
      const wireIndex = numberValue(event.index)
      const state = wireIndex === undefined ? undefined : asm.messagesBlocks.get(wireIndex)
      const delta = isRecord(event.delta) ? event.delta : undefined
      if (!state || !delta) break
      const index = state.chunkIndex
      if (delta.type === 'text_delta' && state.type === 'text') {
        const text = stringValue(delta.text) ?? ''
        state.text += text
        if (text.trim() !== '') asm.sawContent = true
        chunks.push({ type: 'text-delta', index, text })
      } else if (delta.type === 'thinking_delta' && state.type === 'reasoning') {
        const text = stringValue(delta.thinking) ?? ''
        state.text += text
        chunks.push({ type: 'reasoning-delta', index, text })
      } else if (delta.type === 'signature_delta' && state.type === 'reasoning') {
        // Not model-visible content: it rides the replay envelope so the next
        // request can send the block back, never a reasoning delta.
        state.signature += stringValue(delta.signature) ?? ''
        const entry = asm.replayBlocks[index]
        if (entry) entry.signature = state.signature
      } else if (delta.type === 'input_json_delta' && state.type === 'tool-call') {
        const fragment = stringValue(delta.partial_json) ?? ''
        state.json += fragment
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.id),
          name: state.name,
          argumentsDelta: fragment,
        })
      }
      break
    }
    case 'content_block_stop': {
      const wireIndex = numberValue(event.index)
      if (wireIndex === undefined) break
      const state = asm.messagesBlocks.get(wireIndex)
      if (!state) break
      asm.messagesBlocks.delete(wireIndex)
      const index = state.chunkIndex
      if (state.type === 'text') {
        if (state.text.trim() !== '') asm.sawContent = true
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: state.text } })
      } else if (state.type === 'reasoning') {
        chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.text } })
      } else {
        if (state.id !== '') asm.sawContent = true
        chunks.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.json || '{}' },
        })
      }
      break
    }
    case 'message_delta': {
      const delta = isRecord(event.delta) ? event.delta : undefined
      const reason = stringValue(delta?.stop_reason)
      if (reason !== undefined) asm.finishReason = reason
      const usage = mapMessagesUsage(event.usage, asm.messagesUsage)
      if (usage) {
        asm.messagesUsage = usage
        chunks.push({ type: 'usage', usage })
      }
      break
    }
    case 'message_stop':
      chunks.push({ type: 'finish', reason: mapFinishReason(asm.finishReason) })
      break
    case 'ping':
      break
    case 'error':
      throw streamErrorToLlmError(event.error ?? event, stringValue(event.message))
    default:
      break
  }
  return chunks
}

function handleEvent(asm: BlockAssembler, protocol: CommandCodeProtocol, event: unknown): StreamChunk[] {
  if (protocol === 'cli') return handleCliEvent(asm, event)
  return protocol === 'messages' ? handleMessagesEvent(asm, event) : handleOpenAIEvent(asm, event)
}

/** 三种协议的结束原因统一映射为宿主分类，保留线上名称用于诊断。 */
function mapFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool-calls' || reason === 'tool_calls' || reason === 'tool_use') return { kind: 'tool-calls' }
  if (
    reason === 'length' ||
    reason === 'max_tokens' ||
    reason === 'max-tokens' ||
    reason === 'max_output_tokens'
  ) {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/** A terminal marker without text or tools is a failed attempt, not a completed turn. */
function emptyCompletionError(
  reason: string | undefined, maxTokens: number, usage: TokenUsage | undefined,
): LlmError {
  const detail = `finish_reason=${reason ?? 'unknown'}, max_tokens=${maxTokens}, outputTokens=${usage?.outputTokens ?? 'unknown'}, reasoningTokens=${usage?.reasoningTokens ?? 'unknown'}`
  if (mapFinishReason(reason).kind === 'max-tokens') {
    // A length finish proves a generation limit, not how all tokens were spent.
    // Keep this outside the retry whitelist: replaying the identical budget
    // can repeatedly charge for reasoning without ever producing an answer. A
    // genuine context-window rejection has its own upstream wording and is
    // classified separately by `generateHttpError()`'s `isContextOverflowDetail`
    // branch / `streamErrorToLlmError()`'s in-band equivalent — not inferred
    // here from a client-side estimate (see 决策记录 for why the estimate-based
    // `requestContextBudget()`/`floored` signal this branch used to read was
    // removed, issue #74).
    return bilingual(
      'OUTPUT_TOKEN_LIMIT',
      `Command Code reached the output token limit without producing answer text or a tool call (${detail})`,
      'Command Code 已达到输出 token 上限，但没有生成正文或工具调用；请调整思考强度，或在模型和接口上限内增加输出预算',
    )
  }
  if (reason === 'content_filter' || reason === 'content-filter') {
    return bilingual('CONTENT_FILTER', `Command Code filtered the response (${detail})`, 'Command Code 拦截了响应，未生成正文或工具调用')
  }
  return bilingual(
    'EMPTY_RESPONSE',
    `Command Code finished without producing answer text or a tool call (${detail})`,
    'Command Code 返回了空响应（可能只有思考内容），重试通常可恢复',
  )
}

/** Map an OpenAI Chat Completions usage payload to harness disjoint counts. */
function mapOpenAIUsage(usage: unknown): TokenUsage {
  const source = isRecord(usage) ? usage : {}
  const promptTokens = numberValue(source.prompt_tokens) ?? 0
  const outputTokens = numberValue(source.completion_tokens) ?? 0
  const totalTokens = numberValue(source.total_tokens)
  const promptDetails = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : undefined
  const cacheRead = numberValue(promptDetails?.cached_tokens) ?? 0
  const cacheWrite = numberValue(promptDetails?.cache_creation_input_tokens) ?? 0
  const completionDetails = isRecord(source.completion_tokens_details) ? source.completion_tokens_details : undefined
  const reasoningTokens = numberValue(completionDetails?.reasoning_tokens)
  const usageOut: TokenUsage = {
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens,
    cacheReadTokens: cacheRead,
  }
  if (cacheWrite > 0) usageOut.cacheWriteTokens = cacheWrite
  if (reasoningTokens !== undefined) usageOut.reasoningTokens = reasoningTokens
  if (totalTokens !== undefined) usageOut.totalTokens = totalTokens
  return usageOut
}
