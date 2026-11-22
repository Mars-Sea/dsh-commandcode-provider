/** 手动读取历史，旧宿主可降级；查询切换和卸载后不接受过期结果。 */
import { parseAnalyticsQuery, parseAnalyticsReport, type AnalyticsQuery, type AnalyticsReport } from '../analytics-wire.ts'
type AnalyticsResult =
  | { readonly ok: true; readonly value: AnalyticsReport }
  | { readonly ok: false; readonly error: { readonly message: string } }
export interface AnalyticsRemote { analytics?(query: AnalyticsQuery): Promise<AnalyticsResult> }
export interface AnalyticsState { status: 'idle' | 'loading' | 'ready' | 'error'; report?: AnalyticsReport; error?: string }
export class AnalyticsController {
  private current: AnalyticsState = { status: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0
  private disposed = false
  private query: AnalyticsQuery = { mode: 'recent', limit: 20 }
  constructor(private remote: AnalyticsRemote) {}
  state() { return this.current }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  dispose() { this.disposed = true; this.generation++; this.listeners.clear() }
  reload() { this.generation++; this.set({ status: 'idle' }) }
  refresh(query = this.query) {
    if (this.disposed) return
    const requested = parseAnalyticsQuery(query)
    this.query = requested
    const generation = ++this.generation
    this.set({ status: 'loading' })
    const call = this.remote.analytics
    if (!call) { this.set({ status: 'error', error: '宿主不支持模型分析，请更新插件' }); return }
    void Promise.resolve().then(() => call(requested)).then(result => {
      if (this.disposed || generation !== this.generation) return
      if (!result.ok) { this.set({ status: 'error', error: result.error.message === '宿主不支持模型分析，请更新插件' ? result.error.message : '模型分析读取失败，请稍后刷新或检查宿主日志' }); return }
      this.set({ status: 'ready', report: parseAnalyticsReport(result.value) })
    }).catch(() => {
      if (!this.disposed && generation === this.generation) this.set({ status: 'error', error: '模型分析读取失败，请稍后刷新或检查宿主日志' })
    })
  }
  private set(state: AnalyticsState) { this.current = state; for (const listener of this.listeners) listener() }
}
