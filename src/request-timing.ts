/** 请求耗时只记录阶段、计数和状态；不记录消息、凭据、请求头或错误正文。 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const REQUEST_TIMING_ENV = 'DSH_COMMANDCODE_TIMING'
type Phase = 'credentials' | 'images' | 'body' | 'serialization' | 'headers'
type Outcome = 'finished' | 'error' | 'aborted' | 'cancelled'

export interface RequestTimingSummary {
  version: 1
  startedAt: number
  model: string
  outcome: Outcome
  errorCode?: string
  totalMs: number
  phasesMs: Record<Phase, number>
  firstByteMs?: number
  firstContentMs?: number
  attempts: Array<{ protocol: string; bodyBytes: number; headersMs: number; status?: number }>
}

export type RequestTimingSink = (summary: RequestTimingSummary) => void | Promise<void>

/** 每次生成独立计时；可注入时钟验证顺序，不依赖真实等待。 */
export class RequestTiming {
  private readonly started: number
  private readonly summary: RequestTimingSummary

  constructor(model: string, private readonly sink?: RequestTimingSink, private readonly now = () => performance.now()) {
    this.started = now()
    this.summary = {
      version: 1, startedAt: Date.now(), model, outcome: 'cancelled', totalMs: 0,
      phasesMs: { credentials: 0, images: 0, body: 0, serialization: 0, headers: 0 }, attempts: [],
    }
  }

  /** 返回结束函数，确保成功和异常都计入同一阶段。阶段可嵌套，不能直接相加。 */
  phase(name: Phase): () => void {
    if (!this.sink) return () => {}
    const start = this.now()
    return () => { this.summary.phasesMs[name] += this.now() - start }
  }

  attempt(protocol: string, bodyBytes: number): (status?: number) => void {
    if (!this.sink) return () => {}
    const start = this.now()
    const attempt = { protocol, bodyBytes, headersMs: 0 }
    this.summary.attempts.push(attempt)
    return (status) => {
      Object.assign(attempt, { headersMs: this.now() - start, ...(status === undefined ? {} : { status }) })
      this.summary.phasesMs.headers += attempt.headersMs
    }
  }

  first(kind: 'firstByteMs' | 'firstContentMs'): void {
    if (this.sink && this.summary[kind] === undefined) this.summary[kind] = this.now() - this.started
  }

  async close(outcome: Outcome, errorCode?: string): Promise<void> {
    if (!this.sink) return
    this.summary.outcome = outcome
    this.summary.totalMs = this.now() - this.started
    if (errorCode !== undefined) this.summary.errorCode = errorCode
    // 观测失败不能改变生成结果；每次请求只异步写一条，避免逐块同步磁盘写入。
    try { await this.sink(this.summary) } catch { /* 诊断降级不影响请求。 */ }
  }
}

/** 与原始流诊断独立开关，便于仅收集数值耗时。 */
export function openRequestTiming(model: string, sink?: RequestTimingSink): RequestTiming {
  if (sink) return new RequestTiming(model, sink)
  const raw = process.env[REQUEST_TIMING_ENV]?.trim()
  if (!raw || ['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return new RequestTiming(model)
  const path = ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
    ? join(tmpdir(), 'dsh-commandcode-timing.jsonl') : raw
  return new RequestTiming(model, async (summary) => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(summary)}\n`, { mode: 0o600 })
  })
}
