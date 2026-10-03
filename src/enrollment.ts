/** 宿主拥有账号开通的副作用；页面/连接只拥有取消权。恢复日志先于凭据写入落盘。 */
import type { EnrollmentInput, EnrollmentRecord, EnrollmentState } from './enrollment-wire.ts'
import type { CommandCodeLoginCredentials } from './login.ts'
import type { CommandCodeLoginStatus } from './login-wire.ts'

interface Account { label?: string; apiKeyEnv?: string; apiKey?: string }
export interface EnrollmentConfig {
  apiKeyEnv?: string
  accounts?: Account[]
  accountEnrollmentTasks?: EnrollmentRecord[]
  credentialCleanupRefs?: string[]
  modelAccountRules?: { models: string[]; account: string }[]
  activeAccount?: string
}
export interface EnrollmentSettings {
  writable: boolean
  read(): { value: EnrollmentConfig; revision: number; base?: EnrollmentConfig }
  mutate(ops: { op: 'set'; path: string[]; value: unknown }[], revision: number): Promise<void>
}
export interface EnrollmentLogin {
  begin(ref?: string): Promise<CommandCodeLoginStatus>
  status(): CommandCodeLoginStatus
  onChange(listener: () => void): () => void
  cancelAndDrain(): Promise<void>
  dispose(): void
}
export interface EnrollmentDeps {
  settings(): EnrollmentSettings | undefined
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
  set(ref: string, key: string): Promise<void>
  unset(ref: string): Promise<void>
  login(store: (credentials: CommandCodeLoginCredentials) => Promise<void>): EnrollmentLogin
}
interface Task {
  owner: string
  state: EnrollmentState
  cancelled: boolean
  writeStarted?: boolean
  cleanupStarted?: boolean
  work?: Promise<void>
  flow?: EnrollmentLogin
}
const terminal = (state: EnrollmentState) => ['finished', 'cancelled', 'failed', 'cleanup-needed', 'naming'].includes(state.phase)

export class AccountEnrollmentManager {
  private readonly tasks = new Map<string, Task>()
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly pages = new Set<string>()
  constructor(private readonly deps: EnrollmentDeps) {}
  /** 每页独立的持续调用才代表页面生命期；宿主的 operator Peer 由所有浏览器共享。 */
  watch(owner: string): () => void {
    if (this.closed || this.pages.has(owner)) throw new Error('账号开通页面已关闭或重复连接')
    this.pages.add(owner)
    return () => { this.pages.delete(owner); this.disconnect(owner) }
  }
  hasPage(owner: string): boolean { return this.pages.has(owner) }

  /** begin 不等待整个过程；客户端预先生成的 id 让早到的取消也能生效。 */
  begin(owner: string, input: EnrollmentInput): EnrollmentState {
    this.prune()
    const existing = this.tasks.get(input.id)
    if (existing) return this.owned(owner, input.id).state
    if (this.closed) throw new Error('账号开通服务已关闭')
    if (this.records().some((record) => record.id === input.id)) throw new Error('已有未完成记录，请先处理')
    const task: Task = { owner, cancelled: false, state: { id: input.id, ref: '', phase: 'creating', message: '正在创建账号' } }
    this.tasks.set(input.id, task)
    task.work = this.run(task, input).catch(() => {
      task.state = { ...task.state, phase: 'cleanup-needed', message: '收尾未完成，请重试' }
    })
    return task.state
  }
  status(owner: string, id: string): EnrollmentState {
    const task = this.tasks.get(id)
    if (task) return this.owned(owner, id).state
    const record = this.records().find((record) => record.id === id)
    if (!record) throw new Error('账号开通过程不存在')
    return this.recovered(record)
  }
  pending(owner: string): EnrollmentState[] {
    return this.records().filter((record) => {
      const task = this.tasks.get(record.id)
      return !task || ((task.owner === '' || task.owner === owner) && terminal(task.state))
    })
      .map((record) => this.tasks.get(record.id)?.state ?? this.recovered(record))
  }
  /** 离开已登录的待命名过程等同接受已有名称，其余阶段等待写入结束再补偿。 */
  async cancel(owner: string, id: string): Promise<EnrollmentState> {
    this.prune()
    let task = this.tasks.get(id)
    if (!task) {
      if (this.records().some((record) => record.id === id)) return this.retry(owner, id)
      // 取消先于 begin 到达时留下墓碑，不能随后创建账号。
      task = { owner, cancelled: true, state: { id, ref: '', phase: 'cancelled', message: '已取消' } }
      this.tasks.set(id, task)
      return task.state
    }
    task = this.owned(owner, id)
    if (task.state.phase === 'naming') return this.name(owner, id)
    if (terminal(task.state)) return task.state
    task.cancelled = true
    task.state = { ...task.state, phase: 'cancelling', message: '正在等待写入结束并清理' }
    await task.flow?.cancelAndDrain()
    await task.work
    return task.state
  }
  disconnect(owner: string): void {
    for (const [id, task] of this.tasks) if (task.owner === owner) void this.cancel(owner, id).catch(() => {}).finally(() => { task.owner = '' })
  }
  dispose(): void { this.closed = true; for (const task of this.tasks.values()) this.disconnect(task.owner) }

  async name(owner: string, id: string, name?: string): Promise<EnrollmentState> {
    const task = this.tasks.get(id)
    if (task) this.owned(owner, id)
    const record = this.records().find((item) => item.id === id)
    if (!record && task?.state.phase === 'finished') return task.state
    if (!record || (record.phase !== 'naming' && task?.state.phase !== 'naming')) throw new Error('账号尚未进入待命名阶段')
    try {
      await this.change((value) => {
        const accounts = value.accounts ?? []
        if (!accounts.some((account) => account.apiKeyEnv === record.ref)) throw new Error('账号已被移除')
        return {
          ...(name?.trim() ? { accounts: accounts.map((account) => account.apiKeyEnv === record.ref ? { ...account, label: name.trim() } : account) } : {}),
          accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).filter((item) => item.id !== id),
        }
      })
      return this.publish(task, { id, ref: record.ref, phase: 'finished', message: '账号开通完成' })
    } catch {
      return this.publish(task, { id, ref: record.ref, phase: 'naming', message: '账号已登录，名称保存失败，请重试或接受已有名称', ...(name ? { suggestedName: name } : {}) })
    }
  }
  async retry(owner: string, id: string, name?: string): Promise<EnrollmentState> {
    const existing = this.tasks.get(id)
    if (existing) {
      this.owned(owner, id)
      await existing.work
      if (!terminal(existing.state)) throw new Error('账号开通仍在进行')
    }
    const record = this.records().find((item) => item.id === id)
    if (!record) return this.status(owner, id)
    if (record.phase === 'naming' || existing?.state.phase === 'naming') return this.name(owner, id, name)
    const task = existing ?? { owner, cancelled: true, writeStarted: true, state: this.recovered(record) }
    this.tasks.set(id, task)
    task.work = this.cleanup(task).catch(() => { task.state = { ...task.state, phase: 'cleanup-needed', message: '清理未完成，请重试' } })
    await task.work
    return task.state
  }
  private async run(task: Task, input: EnrollmentInput): Promise<void> {
    try {
      await this.change(async (value) => {
        const base = value.apiKeyEnv ?? 'COMMANDCODE_API_KEY'
        const occupied = new Set([base, ...(value.accounts ?? []).map((account) => account.apiKeyEnv), ...(value.credentialCleanupRefs ?? []), ...(value.accountEnrollmentTasks ?? []).map((item) => item.ref)])
        let n = 2
        let ref = ''
        // 配置未引用的环境/存储密钥也属于已占用引用，不能用新开通覆盖。
        for (let attempt = 0; attempt < 128; attempt++, n++) {
          if (occupied.has(`${base}_${n}`)) continue
          const candidate = `${base}_${n}`
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) throw new Error('凭据引用无效')
          const info = await this.deps.describe(candidate)
          if (info.configured) continue
          if (!info.writable) throw new Error('凭据不可写')
          ref = candidate
          break
        }
        if (!ref) throw new Error('没有可用凭据引用')
        task.state = { ...task.state, ref }
        return {
          accounts: [...(value.accounts ?? []), { label: input.label, apiKeyEnv: ref }],
          accountEnrollmentTasks: [...(value.accountEnrollmentTasks ?? []), { id: input.id, ref, phase: 'pending', label: input.label }],
        }
      })
      if (task.cancelled) return await this.cleanup(task)
      const info = await this.deps.describe(task.state.ref)
      // 分配引用不应覆盖环境或其他凭据；真正写入仍由凭据服务执行权限检查。
      if (info.configured || !info.writable) throw new Error('凭据引用已占用或不可写')
      let suggested: string | undefined
      if (input.mode === 'manual') await this.store(task, input.key!)
      else {
        const flow = this.deps.login(async (credentials) => { await this.store(task, credentials.apiKey) })
        task.flow = flow
        const result = await new Promise<CommandCodeLoginStatus>((resolve, reject) => {
          const off = flow.onChange(() => {
            const status = flow.status()
            if (status.state === 'success' || status.state === 'failed') { off(); resolve(status) }
          })
          void flow.begin(task.state.ref).then((status) => {
            if (!task.cancelled && status.state === 'waiting') task.state = { ...task.state, phase: 'waiting', message: '等待浏览器登录', ...(status.authUrl ? { authUrl: status.authUrl } : {}) }
            if (task.cancelled) void flow.cancelAndDrain()
          }, (error: unknown) => { off(); reject(error) })
        })
        if (result.state !== 'success') throw new Error('浏览器登录未完成')
        suggested = input.automaticName ? result.userName?.trim() : undefined
      }
      if (task.cancelled) return await this.cleanup(task)
      // 先登记已登录事实，再尝试命名。命名失败绝不走删除凭据的补偿分支。
      task.state = { ...task.state, phase: 'naming', message: '账号已登录，正在保存名称', ...(suggested ? { suggestedName: suggested } : {}) }
      try {
        await this.change((value) => ({ accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).map((item) => item.id === input.id ? { ...item, phase: 'naming', label: suggested || item.label } : item) }))
      } catch {
        if (task.state.phase === 'finished') return
        task.state = { ...task.state, message: '账号已登录，名称保存失败，请重试或接受已有名称' }
        return
      }
      await this.name(task.owner, input.id, suggested)
    } catch {
      // 清理本身失败必须留待用户重试，不能被开通失败分支再次自动执行。
      if (task.cleanupStarted) throw new Error('账号清理未完成')
      await task.flow?.cancelAndDrain()
      if (task.state.ref && this.records().some((item) => item.id === task.state.id)) await this.cleanup(task)
      else task.state = { ...task.state, phase: task.cancelled ? 'cancelled' : 'failed', message: task.cancelled ? '已取消' : '账号开通失败，未创建账号' }
    } finally { task.flow?.dispose() }
  }
  private async store(task: Task, key: string): Promise<void> {
    if (task.cancelled) throw new Error('已取消')
    task.state = { ...task.state, phase: 'writing', message: '正在保存凭据' }
    task.writeStarted = true
    await this.deps.set(task.state.ref, key)
    if (!(await this.deps.describe(task.state.ref)).configured) throw new Error('凭据写入未确认')
  }
  private async cleanup(task: Task): Promise<void> {
    task.cleanupStarted = true
    const { id, ref } = task.state
    const snapshot = this.settings().read()
    if ((snapshot.value.apiKeyEnv ?? 'COMMANDCODE_API_KEY') === ref || snapshot.base?.accounts?.some((account) => account.apiKeyEnv === ref)) throw new Error('不能清理默认或继承账号')
    await this.change((value) => {
      const record = (value.accountEnrollmentTasks ?? []).find((item) => item.id === id)
      if (!record || record.phase === 'naming') throw new Error('不能清理已登录账号')
      return {
        accounts: (value.accounts ?? []).filter((account) => account.apiKeyEnv !== ref),
        modelAccountRules: (value.modelAccountRules ?? []).filter((rule) => rule.account !== ref),
        ...(value.activeAccount === ref ? { activeAccount: '' } : {}),
        credentialCleanupRefs: [...new Set([...(value.credentialCleanupRefs ?? []), ref])],
        accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).map((item) => item.id === id ? { ...item, phase: 'cleanup' } : item),
      }
    })
    const value = this.settings().read().value
    if ((value.apiKeyEnv ?? 'COMMANDCODE_API_KEY') === ref || (value.accounts ?? []).some((account) => account.apiKeyEnv === ref) || (value.modelAccountRules ?? []).some((rule) => rule.account === ref) || value.activeAccount === ref) throw new Error('引用仍被使用，不能清理')
    const info = await this.deps.describe(ref)
    if (info.configured && task.writeStarted) {
      if (!info.writable) throw new Error('凭据不可清理')
      await this.deps.unset(ref)
      if ((await this.deps.describe(ref)).configured) throw new Error('凭据删除未确认')
    }
    await this.change((current) => ({
      accountEnrollmentTasks: (current.accountEnrollmentTasks ?? []).filter((item) => item.id !== id),
      credentialCleanupRefs: (current.credentialCleanupRefs ?? []).filter((item) => item !== ref),
    }))
    task.state = { id, ref, phase: task.cancelled ? 'cancelled' : 'failed', message: task.cancelled ? '已取消并清理' : '开通失败，已清理临时账号' }
  }
  private settings(): EnrollmentSettings {
    const settings = this.deps.settings()
    if (!settings?.writable) throw new Error('设置服务不可写')
    return settings
  }
  private records(): EnrollmentRecord[] { return this.deps.settings()?.read().value.accountEnrollmentTasks ?? [] }
  private change(patch: (value: EnrollmentConfig) => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<void> {
    const work = this.writes.catch(() => {}).then(async () => {
      const settings = this.settings()
      const { value, revision } = settings.read()
      const fields = await patch(value)
      await settings.mutate(Object.entries(fields).map(([key, item]) => ({ op: 'set', path: [key], value: item })), revision)
    })
    this.writes = work
    return work
  }
  private owned(owner: string, id: string): Task {
    const task = this.tasks.get(id)
    if (!task || (task.owner !== '' && task.owner !== owner)) throw new Error('不能操作其他连接的开通过程')
    if (task.owner === '') task.owner = owner
    return task
  }
  private publish(task: Task | undefined, state: EnrollmentState): EnrollmentState { if (task) task.state = state; return state }
  /** 只淘汰已完成且没有恢复日志的旧状态，活跃过程和未收尾事实始终保留。 */
  private prune(): void {
    if (this.tasks.size < 256) return
    const recorded = new Set(this.records().map((record) => record.id))
    for (const [id, task] of this.tasks) {
      if (this.tasks.size < 256) break
      if (terminal(task.state) && !recorded.has(id) && !this.pages.has(task.owner)) this.tasks.delete(id)
    }
  }
  private recovered(record: EnrollmentRecord): EnrollmentState {
    return { id: record.id, ref: record.ref, phase: record.phase === 'naming' ? 'naming' : 'cleanup-needed', message: record.phase === 'naming' ? '已登录账号等待确认名称' : '账号开通收尾未完成，请重试', ...(record.phase === 'naming' ? { suggestedName: record.label } : {}) }
  }
}
