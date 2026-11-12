/** 网关事实的唯一所有者：目录先校验再发布，调用快照与跨调用学习分别持有。 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { providerError } from './llm-error.ts'
import { DEFAULT_MESSAGES_MAX_TOKENS, MODEL_OUTPUT_TOKEN_LIMITS, requiresMessagesEndpoint } from './capabilities.ts'
import { isRecord, numberValue, stringValue } from './wire-guards.ts'
import { OUTPUT_LIMIT_REJECTION, parseOutputCeiling } from './provider-errors.ts'

export const DEFAULT_MAX_OUTPUT_TOKENS = 131_072
export const MODEL_CATALOG_TTL_MS = 5 * 60_000
const MODEL_CATALOG_RETRY_MS = 10_000
const MODEL_CACHE_VERSION = 3
export interface GatewaySource { apiBase: string; modelsCachePath: string }
export interface CommandCodeModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** 保留来源公布值，派生预算不能作为持久化的权威上限。 */
  publishedMaxTokens?: number
  supportedEndpoints: readonly string[]
}
const learned = new Map<string, Map<string, number>>()
const published = new Map<string, Map<string, number>>()
// 跨实例发布序号只按网关共享；刷新失败也不能把发布权交还旧响应。
const generations = new Map<string, number>()
const validLimit = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0
const fallbackLimit = (model: string) => MODEL_OUTPUT_TOKEN_LIMITS.get(model) ?? (requiresMessagesEndpoint(model) ? DEFAULT_MESSAGES_MAX_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS)
export function learnedOutputLimit(apiBase: string, model: string): number {
  return learned.get(apiBase)?.get(model) ?? Infinity
}
export function modelOutputTokenLimit(apiBase: string, model: string): number {
  return Math.min(published.get(apiBase)?.get(model) ?? fallbackLimit(model), learnedOutputLimit(apiBase, model))
}

/**
 * 从本次目录记录的独立输出上限重新推导预算，不能复用已经被旧窗口压低的 maxTokens。
 * 公布值固定在该记录，不读取并发刷新后的共享目录；只继续采纳同网关更低的学习上限。
 */
export function catalogModelMaxTokens(apiBase: string, model: CommandCodeModel, contextWindow = model.contextWindow): number {
  return Math.min(contextWindow, model.publishedMaxTokens ?? fallbackLimit(model.id), learnedOutputLimit(apiBase, model.id))
}

/** 是否更新共享事实与是否值得重试是两个问题；以本次实发预算判断拒绝。 */
export function outputCeilingRefusal(apiBase: string, model: string, sent: number, error: unknown): number | undefined {
  if (!(error instanceof LlmError) || !OUTPUT_LIMIT_REJECTION.test(error.message)) return undefined
  const stated = parseOutputCeiling(error.message)
  if (!validLimit(stated) || stated >= sent) return undefined
  let limits = learned.get(apiBase)
  if (limits === undefined) learned.set(apiBase, limits = new Map())
  const next = Math.min(stated, learnedOutputLimit(apiBase, model))
  limits.set(model, next)
  return next
}

function normalizeModel(raw: unknown, apiBase: string, disk: boolean): CommandCodeModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = stringValue(raw.id), name = stringValue(raw.name)
  const contextWindow = numberValue(disk ? raw.contextWindow : raw.context_length)
  if (!id || !name || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  const limit = numberValue(disk ? raw.publishedMaxTokens : raw.max_output_tokens)
  const endpoints = disk ? raw.supportedEndpoints : raw.supported_endpoints
  return {
    id, name, contextWindow,
    maxTokens: Math.min(contextWindow, validLimit(limit) ? limit : fallbackLimit(id), learnedOutputLimit(apiBase, id)),
    ...(validLimit(limit) ? { publishedMaxTokens: limit } : {}),
    supportedEndpoints: Array.isArray(endpoints) ? endpoints.filter((item): item is string => typeof item === 'string') : [],
  }
}
function parseCatalog(value: unknown, apiBase: string): CommandCodeModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) throw providerError('Unexpected Command Code models response shape', 'PROVIDER_PROTOCOL_ERROR')
  const rows = value.data.map(raw => normalizeModel(raw, apiBase, false)).filter((row): row is CommandCodeModel => row !== undefined)
  if (rows.length === 0) throw providerError('Command Code returned an empty model catalog', 'PROVIDER_PROTOCOL_ERROR')
  return rows
}
async function readCache(source: GatewaySource): Promise<CommandCodeModel[]> {
  const value: unknown = JSON.parse(await readFile(source.modelsCachePath, 'utf8'))
  if (!isRecord(value) || value.version !== MODEL_CACHE_VERSION || value.apiBase !== source.apiBase || !Array.isArray(value.models)) throw new Error('Invalid model cache source')
  const rows = value.models.map(raw => normalizeModel(raw, source.apiBase, true)).filter((row): row is CommandCodeModel => row !== undefined)
  if (rows.length === 0) throw new Error('Empty model cache')
  return rows
}
function publish(apiBase: string, rows: readonly CommandCodeModel[]): void {
  published.set(apiBase, new Map(rows.flatMap(row => row.publishedMaxTokens === undefined ? [] : [[row.id, row.publishedMaxTokens] as const])))
}
async function writeCache(source: GatewaySource, rows: readonly CommandCodeModel[], mayCommit: () => boolean): Promise<void> {
  await mkdir(dirname(source.modelsCachePath), { recursive: true })
  const temp = `${source.modelsCachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ version: MODEL_CACHE_VERSION, apiBase: source.apiBase, models: rows }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (mayCommit()) await rename(temp, source.modelsCachePath)
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}
interface CatalogState {
  source: string
  rows: CommandCodeModel[]
  expiresAt: number
  /**
   * 这批 `rows` 从哪来。`'none'` = 本进程还没加载；`'disk'` = 只读过磁盘缓存
   * （`snapshot()` 灌入，没有联网成功过）；`'network'` = 本进程联网成功过。
   * `loaded()` 只认 `'network'`：磁盘副本没有年龄校验，不能当首屏。
   */
  origin: 'none' | 'disk' | 'network'
  disk?: Promise<CommandCodeModel[]>
  inflight?: Promise<CommandCodeModel[]>
}
function copyRows(rows: readonly CommandCodeModel[]): CommandCodeModel[] {
  return rows.map(row => ({ ...row, supportedEndpoints: [...row.supportedEndpoints] }))
}

export class GatewayFacts {
  private state: CatalogState | undefined
  constructor(private readonly fetchCatalog: (source: GatewaySource) => Promise<unknown>) {}
  private forSource(source: GatewaySource): CatalogState {
    const identity = JSON.stringify([source.apiBase, source.modelsCachePath])
    if (this.state?.source !== identity) this.state = { source: identity, rows: [], expiresAt: 0, origin: 'none' }
    return this.state
  }
  /** 模型解析保持原有热目录直读；不把生成的磁盘冷读取推广到其他入口。 */
  knownModel(source: GatewaySource, model: string): CommandCodeModel | undefined {
    const row = this.forSource(source).rows.find(candidate => candidate.id === model)
    return row === undefined ? undefined : copyRows([row])[0]
  }
  /**
   * 本进程**联网成功过**的目录；否则返回 undefined。
   *
   * 判据是来源而不是「内存里有行」：`snapshot()` 会把磁盘缓存写进同一份
   * `state.rows`（生成路径需要它），若只看行数，冷启动先发过一次聊天再打开
   * 选择器时，首屏拿到的就是没有年龄校验的磁盘副本——正是本方法要排除的东西。
   * 空目录同样返回 undefined：刷新失败后的空行（`expiresAt` 已进入重试窗口）
   * 不能让选择器把「暂时读不到」画成「没有模型」，调用方应回落到 `refresh()`。
   */
  loaded(source: GatewaySource): CommandCodeModel[] | undefined {
    const state = this.forSource(source)
    if (state.origin !== 'network' || state.rows.length === 0) return undefined
    return copyRows(state.rows)
  }
  /** 生成只读取本地目录；捕获状态后不再转向实例的新来源。 */
  async snapshot(source: GatewaySource): Promise<CommandCodeModel[]> {
    const state = this.forSource(source)
    if (state.rows.length > 0 || state.expiresAt > 0) return copyRows(state.rows)
    state.disk ??= readCache(source).catch(() => [])
    const rows = await state.disk
    if (state.rows.length > 0 || state.expiresAt > 0) return copyRows(state.rows)
    if (state.inflight === undefined) {
      state.rows = rows
      // 只标记来源，不改变 snapshot 的返回值：生成路径照旧立刻拿到磁盘行。
      if (rows.length > 0 && state.origin === 'none') state.origin = 'disk'
    }
    return copyRows(rows)
  }
  async refresh(source: GatewaySource, signal?: AbortSignal): Promise<CommandCodeModel[]> {
    signal?.throwIfAborted()
    const state = this.forSource(source)
    if (Date.now() < state.expiresAt) return copyRows(state.rows)
    if (state.inflight === undefined) {
      const generation = (generations.get(source.apiBase) ?? 0) + 1
      generations.set(source.apiBase, generation)
      const mayPublish = () => this.state === state && generations.get(source.apiBase) === generation
      state.inflight = (async () => {
        let rows: CommandCodeModel[], ttl = MODEL_CATALOG_TTL_MS
        let network = false
        try {
          rows = parseCatalog(await this.fetchCatalog(source), source.apiBase)
          network = true
          if (mayPublish()) {
            publish(source.apiBase, rows)
            await writeCache(source, rows, mayPublish).catch(() => undefined)
          }
        } catch {
          ttl = MODEL_CATALOG_RETRY_MS
          rows = state.rows.length > 0 ? state.rows : await readCache(source).catch(() => [])
          // 磁盘只能在尚无联网刷新及共享有效事实的冷启动补充来源，不能倒灌。
          if (mayPublish() && !published.has(source.apiBase) && rows.length > 0) publish(source.apiBase, rows)
        }
        state.rows = rows
        state.expiresAt = Date.now() + ttl
        // 来源只升不降：一次联网成功后，后来的失败回退仍是「联网过的行」；
        // 从未联网、只拿到磁盘副本时如实记为磁盘来源，`loaded()` 不会用它当首屏。
        if (network) state.origin = 'network'
        else if (state.origin === 'none' && rows.length > 0) state.origin = 'disk'
        return rows
      })().finally(() => { delete state.inflight })
    }
    const inflight = state.inflight
    if (!signal) return copyRows(await inflight)
    const rows = await new Promise<CommandCodeModel[]>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      inflight.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
    return copyRows(rows)
  }
}
