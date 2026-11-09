/** 可选宿主历史服务：读实时优先的完整语料库，绝不加载会话为实时或写回日志。 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandCodeAdapter } from './adapter.ts'
import { KNOWN_EFFORTS } from './capabilities.ts'
import { buildAnalytics, foldRequests, type AnalyticsLog, type RequestFact, type ScenarioModel } from './analytics.ts'
import { parseAnalyticsQuery, type AnalyticsQuery, type AnalyticsReport } from './analytics-wire.ts'
import { modelPriceTable } from './model-prices.ts'

export interface HistoryQuery {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string } }>>
  readSession(id: string): Promise<AnalyticsLog>
}
export const ANALYTICS_SESSION_LIMIT = 500
export const ANALYTICS_EVENT_LIMIT = 200000
/** 逐会话失败隔离；上限和遗漏计数会返回界面，部分结果不能伪装成完整历史。 */
export async function readAnalyticsHistory(history: HistoryQuery | undefined, input: AnalyticsQuery, catalog: () => Promise<ScenarioModel[]>, signal?: AbortSignal): Promise<AnalyticsReport> {
  const query = parseAnalyticsQuery(input), table = modelPriceTable()
  if (!history) return { ...buildAnalytics([], query, table, []), status: 'unavailable' }
  const records = await history.listSessions(signal)
  const facts: RequestFact[] = []
  let scannedSessions = 0, unreadableSessions = 0, skippedSessions = 0, events = 0, truncated = records.length > ANALYTICS_SESSION_LIMIT
  for (const entry of records.slice(0, ANALYTICS_SESSION_LIMIT)) {
    if (signal?.aborted) throw new Error('模型分析已取消')
    if (events >= ANALYTICS_EVENT_LIMIT) { truncated = true; break }
    scannedSessions++
    try {
      const log = await history.readSession(entry.header.id)
      // 老宿主或第三方服务缺少精确继承边界时跳过，不能猜测分支切点。
      if (!Number.isSafeInteger(log.inheritedEventCount) || log.inheritedEventCount < 0 || log.inheritedEventCount > log.events.length) { skippedSessions++; continue }
      events += log.events.length
      if (events > ANALYTICS_EVENT_LIMIT) { skippedSessions++; truncated = true; break }
      facts.push(...foldRequests(entry.header.id, log))
    } catch { unreadableSessions++ }
  }
  let selected = facts
  if (query.mode === 'recent') {
    const latest = new Map<string, number>()
    for (const f of facts) latest.set(f.session, Math.max(latest.get(f.session) ?? 0, f.at))
    const ids = new Set([...latest].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, query.limit).map(([id]) => id))
    selected = facts.filter(f => ids.has(f.session))
  }
  let models: ScenarioModel[] = [], catalogUnavailable = false
  if (signal?.aborted) throw new Error('模型分析已取消')
  try { models = await catalog() } catch { catalogUnavailable = true }
  const report = buildAnalytics(selected, query, table, models)
  return { ...report, scannedSessions, unreadableSessions, skippedSessions, truncated, catalogUnavailable, monthlyEstimate: truncated || unreadableSessions > 0 || skippedSessions > 0 ? null : report.monthlyEstimate }
}
/** 用反射和可选 fiber 对接，保持未挂载历史服务的无界面/TUI 配置可用。 */
export function createAnalyticsReader(ctx: Context, adapter: Pick<CommandCodeAdapter, 'listModels' | 'resolveModel'>) {
  let history: HistoryQuery | undefined, busy = false
  ctx.inject(['sessionQuery'], c => {
    const service = c.get('sessionQuery') as HistoryQuery | undefined
    if (typeof service?.listSessions !== 'function' || typeof service.readSession !== 'function') return
    history = service
    c.effect(() => () => { if (history === service) history = undefined }, 'commandcode analytics history')
  })
  return async (query: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsReport> => {
    if (busy) throw new Error('模型分析正在读取历史，请稍后刷新')
    busy = true
    try {
      return await readAnalyticsHistory(history, query, async () => {
        // `catalogNames` gives the upstream catalog name verbatim, so neither
        // the ` (CC)` marker nor a `modelNames` override leaks into the report
        // (issue #121) — the analytics names stay stable while the picker label
        // can be customized.
        const available = await adapter.listModels('commandcode', { catalogNames: true })
        return Promise.all(available.map(async m => {
          const resolved = await adapter.resolveModel('commandcode', m.id)
          return { id: m.id, name: m.name, contextWindow: resolved.context?.contextWindow ?? null, images: resolved.inputModalities?.includes('image') ?? false, efforts: [...(KNOWN_EFFORTS[m.id] ?? [])] }
        }))
      }, signal)
    } finally { busy = false }
  }
}
