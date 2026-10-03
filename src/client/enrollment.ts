/** 每次设置页挂载独立拥有一个开通控制器；共享设置/用量控制器仍保持插件生命周期。 */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { EnrollmentAction, EnrollmentInput, EnrollmentPage, EnrollmentState } from '../enrollment-wire.ts'
import { createSnapshotStore } from './snapshot-store.ts'
import { openLoginPage } from './login-page.ts'

export interface EnrollmentRemote {
  enrollmentBegin(input: EnrollmentInput): Promise<RemoteResult<EnrollmentState>>
  enrollmentStatus(input: EnrollmentAction): Promise<RemoteResult<EnrollmentState>>
  enrollmentCancel(input: EnrollmentAction): Promise<RemoteResult<EnrollmentState>>
  enrollmentName(input: EnrollmentAction): Promise<RemoteResult<EnrollmentState>>
  enrollmentRetry(input: EnrollmentAction): Promise<RemoteResult<EnrollmentState>>
  enrollmentPending(input: EnrollmentPage): Promise<RemoteResult<EnrollmentState[]>>
  enrollmentWatch(input: EnrollmentPage): RemoteStreamHandle<boolean, never>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'commandcode/enrollmentBegin': EnrollmentRemote['enrollmentBegin']
    'commandcode/enrollmentStatus': EnrollmentRemote['enrollmentStatus']
    'commandcode/enrollmentCancel': EnrollmentRemote['enrollmentCancel']
    'commandcode/enrollmentName': EnrollmentRemote['enrollmentName']
    'commandcode/enrollmentRetry': EnrollmentRemote['enrollmentRetry']
    'commandcode/enrollmentPending': EnrollmentRemote['enrollmentPending']
    'commandcode/enrollmentWatch': EnrollmentRemote['enrollmentWatch']
  }
}
export interface EnrollmentPageState { active: EnrollmentState | undefined; pending: EnrollmentState[]; error: string | undefined }
const live = (state: EnrollmentState) => ['creating', 'waiting', 'writing', 'cancelling'].includes(state.phase)
export class AccountEnrollmentController {
  readonly store = createSnapshotStore<EnrollmentPageState>({ active: undefined, pending: [], error: undefined })
  private id: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private pageId: string
  private watch: RemoteStreamHandle<boolean, never> | undefined
  private ready: Promise<void> | undefined
  private openedPage = false
  constructor(private readonly remote: () => EnrollmentRemote, private readonly changed: () => void, private readonly pollMs = 750, private readonly newId = () => crypto.randomUUID(), private readonly openPage = openLoginPage) { this.pageId = newId() }
  /** 支持 React 开发模式的挂载检查；每次挂载仍重新读取宿主事实。 */
  activate(): void { if (this.disposed) this.pageId = this.newId(); this.disposed = false; void this.refresh() }
  reset(): void { if (!this.id) this.store.set({ ...this.store.getSnapshot(), active: undefined, error: undefined }) }
  async refresh(): Promise<void> {
    try {
      const result = await this.remote().enrollmentPending({ pageId: this.pageId })
      if (result.ok && !this.disposed) this.store.set({ ...this.store.getSnapshot(), pending: result.value })
    } catch { /* 旧宿主或连接暂不可用，开始开通时再提供明确提示。 */ }
  }
  async begin(input: Omit<EnrollmentInput, 'id' | 'pageId'>): Promise<void> {
    if (this.id || this.disposed) return
    const id = this.newId()
    const pageId = this.pageId
    this.id = id
    this.openedPage = false
    this.store.set({ ...this.store.getSnapshot(), error: undefined, active: { id, ref: '', phase: 'creating', message: '正在创建账号' } })
    try {
      await this.ensureWatch()
      if (this.disposed || this.id !== id || this.pageId !== pageId) return
      const result = await this.remote().enrollmentBegin({ ...input, id, pageId })
      if (this.disposed || this.id !== id) {
        // begin 回复晚到时再取消一次，覆盖传输层乱序或早到的取消失败。
        await this.remote().enrollmentCancel({ id, pageId })
        return
      }
      this.receive(id, result)
    } catch {
      if (this.id === id) this.cancel()
      this.failure('账号开通请求失败，请检查连接后重试')
    }
  }
  /** 页面可立即离开；宿主仍等待写入和补偿收尾。 */
  cancel(): void {
    const id = this.id
    const pageId = this.pageId
    this.id = undefined
    this.stopTimer()
    if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), active: undefined })
    if (id) void Promise.resolve().then(() => this.remote().enrollmentCancel({ id, pageId })).then(() => { this.changed(); void this.refresh() }, () => this.failure('取消请求未确认，重新连接后请检查未完成记录'))
  }
  async name(name?: string): Promise<void> {
    const id = this.id
    if (!id) return
    try { this.receive(id, await this.remote().enrollmentName({ id, pageId: this.pageId, ...(name ? { name } : {}) })) }
    catch { this.failure('名称保存失败，请重试或接受已有名称') }
  }
  async recover(record: EnrollmentState, name?: string): Promise<void> {
    try {
      const result = await this.remote().enrollmentRetry({ id: record.id, pageId: this.pageId, ...(name ? { name } : {}) })
      if (!result.ok) this.failure('收尾未完成，请重试')
      else if (!this.disposed && this.store.getSnapshot().active?.id === record.id) {
        this.store.set({ ...this.store.getSnapshot(), active: result.value, error: undefined })
      }
      this.changed()
      await this.refresh()
    } catch { this.failure('收尾请求失败，请检查连接后重试') }
  }
  dispose(): void { this.disposed = true; this.cancel(); this.watch?.dispose(); this.watch = undefined; this.ready = undefined }
  private ensureWatch(): Promise<void> {
    if (this.ready) return this.ready
    const handle = this.remote().enrollmentWatch({ pageId: this.pageId })
    const iterator = handle[Symbol.asyncIterator]()
    this.watch = handle
    this.ready = iterator.next().then((first) => {
      if (first.done || first.value !== true || this.watch !== handle) throw new Error('页面观察流未建立')
      // 不重连原观察流；载体断开就是该页面过程结束，由宿主补偿。
      void (async () => {
        try { while (!(await iterator.next()).done) { /* 保持调用直到载体结束。 */ } }
        catch { /* 终止统一在 finally 中处理。 */ }
        finally {
          if (this.watch === handle && !this.disposed) {
            this.watch = undefined
            this.ready = undefined
            this.cancel()
            this.failure('开通连接已断开，宿主正在收尾；重连后请检查未完成记录')
          }
        }
      })()
    }).catch((error: unknown) => { handle.dispose(); if (this.watch === handle) { this.watch = undefined; this.ready = undefined }; throw error })
    return this.ready
  }
  private receive(id: string, result: RemoteResult<EnrollmentState>): void {
    if (this.disposed || this.id !== id) return
    if (!result.ok) { this.failure('宿主无法完成账号开通，请检查连接与写入权限'); return }
    const active = result.value
    // 地址可能由后续轮询返回；只接受仍属于当前页面过程的地址，且每次过程只打开一次。
    if (active.phase === 'waiting' && active.authUrl && !this.openedPage) {
      this.openedPage = true
      this.openPage(active.authUrl)
    }
    this.store.set({ ...this.store.getSnapshot(), active, error: undefined })
    if (live(active)) {
      this.stopTimer()
      this.timer = setTimeout(() => { void this.poll(id) }, this.pollMs)
    } else {
      this.changed()
      void this.refresh()
      if (active.phase !== 'naming') this.id = undefined
    }
  }
  private async poll(id: string): Promise<void> {
    if (this.disposed || this.id !== id) return
    try { this.receive(id, await this.remote().enrollmentStatus({ id, pageId: this.pageId })) }
    catch {
      this.failure('开通状态暂不可用，正在等待重新连接')
      if (!this.disposed && this.id === id) this.timer = setTimeout(() => { void this.poll(id) }, this.pollMs)
    }
  }
  private failure(message: string): void { if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), error: message }) }
  private stopTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
}
