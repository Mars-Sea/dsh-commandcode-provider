/** 设置写入过程：同一控制器的意图按顺序执行，配置确认与凭据确认分别保留。
 * 生产使用现有远端设置／凭据，测试替换这些依赖；不提供跨服务事务。 */
import { readVisibility } from '../model-visibility.ts'
import type { SettingsPageApi, SettingsScope, SettingsScopeSnapshot } from './settings.ts'
import type { SettingsMutationResult, SettingsPathOp } from './settings-scope.ts'

export const DEFAULT_API_KEY_REF = 'COMMANDCODE_API_KEY'
export interface StoredRule { models: string[]; account: string }

/** 与宿主路由的第一条匹配规则一致，重复模型只归属于先出现的账号。 */
export function accountModelMap(rules: readonly StoredRule[]): Map<string, string[]> {
  const claimed = new Set<string>()
  const map = new Map<string, string[]>()
  for (const rule of rules) {
    const list = map.get(rule.account) ?? []
    for (const model of rule.models) {
      if (claimed.has(model)) continue
      claimed.add(model)
      list.push(model)
    }
    map.set(rule.account, list)
  }
  return map
}

export interface SettingsWriteResult {
  config: 'none' | 'confirmed' | 'conflict' | 'unconfirmed'
  credential: 'none' | 'not-issued' | 'confirmed' | 'unconfirmed'
  issue: 'target-changed' | 'closed' | 'cleanup-pending' | undefined
  refreshFailed: boolean
  /** 实际发出调用的原引用，仅用于核对；从不包含密钥内容。 */
  credentialRef: string | undefined
}

export type SettingsWriteIntent =
  | { kind: 'save'; ops: readonly SettingsPathOp[]; visibleModels?: readonly string[]; key?: string }
  | { kind: 'rename'; ref: string; label: string }
  | { kind: 'remove' | 'cleanup'; ref: string }
  | { kind: 'key'; target: string; value?: string }
  | { kind: 'active'; id: string }
  | { kind: 'models'; target: string; models: readonly string[] }

type Snapshot = SettingsScopeSnapshot<Record<string, unknown>>
type CredentialInfo = { configured: boolean; writable: boolean }
type FieldBaseline = { value: unknown; base: unknown; user: unknown; overridden: boolean }
interface Command {
  intent: SettingsWriteIntent
  ops: readonly SettingsPathOp[]
  baseline: Map<string, FieldBaseline>
  defaultRef: string | undefined
}
interface QueuedWrite { command: Command; resolve(result: SettingsWriteResult): void }

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const result = (): SettingsWriteResult => ({ config: 'none', credential: 'none', issue: undefined, refreshFailed: false, credentialRef: undefined })
const closedResult = (): SettingsWriteResult => ({ ...result(), issue: 'closed' })
const fieldBaseline = (snapshot: Snapshot, field: string): FieldBaseline => ({
  value: snapshot.value?.[field], base: record(snapshot.base)[field], user: record(snapshot.user)[field],
  overridden: Object.hasOwn(record(snapshot.user), field),
})

/** 不用显示文本比较配置；数组顺序与显式覆盖／继承也是写入事实。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const left = record(a), right = record(b)
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

export function writeCompleted(outcome: SettingsWriteResult): boolean {
  return outcome.issue === undefined && outcome.config !== 'conflict' && outcome.config !== 'unconfirmed'
    && outcome.credential !== 'not-issued' && outcome.credential !== 'unconfirmed'
}

export class SettingsWriter {
  private readonly pending: QueuedWrite[] = []
  private running = false
  private closed = false
  private readonly facts = new Map<string, CredentialInfo>()
  /** 每个引用独立的读写世代，防止旧描述覆盖随后确认的凭据修改。 */
  private readonly factVersions = new Map<string, number>()
  private refreshGeneration = 0
  private refreshFailed = false

  constructor(
    private readonly scope: SettingsScope<Record<string, unknown>>,
    private readonly credentials: SettingsPageApi['credentials'],
    private readonly onFactsChanged: () => void,
  ) {}

  credential(ref: string): CredentialInfo | undefined { return this.facts.get(ref) }
  factsRefreshFailed(): boolean { return this.refreshFailed }

  /** 在入队时捕获意图与目标；执行者不能重新读取页面草稿。 */
  submit(intent: SettingsWriteIntent): Promise<SettingsWriteResult> {
    if (this.closed) return Promise.resolve(closedResult())
    const owned = structuredClone(intent)
    const snapshot = this.scope.getSnapshot()
    const ops = owned.kind === 'save' ? [...owned.ops] : []
    if (owned.kind === 'save' && owned.visibleModels !== undefined) {
      const list = [...owned.visibleModels]
      const keys = new Set<string>()
      for (const layer of [snapshot.base, snapshot.user, snapshot.value]) {
        for (const id of Object.keys(readVisibility(record(layer).modelVisibility))) keys.add(id)
      }
      ops.push({ op: 'set', path: ['visibleModels'], value: list },
        { op: 'set', path: ['modelVisibility'], value: Object.fromEntries([...keys].map(id => [id, list.length === 0 || list.includes(id)])) })
    }
    const baseline = new Map(ops.map(op => [op.path[0]!, structuredClone(fieldBaseline(snapshot, op.path[0]!))]))
    const defaultRef = (owned.kind === 'save' && owned.key !== undefined) || (owned.kind === 'key' && owned.target === 'default')
      ? this.defaultRef() : undefined
    return new Promise(resolve => {
      this.pending.push({ command: { intent: owned, ops, baseline, defaultRef }, resolve })
      if (!this.running) void this.drain()
    })
  }

  /** 销毁不等待远端；未发出的任务立即结束，已发调用只能自然收束。 */
  dispose(): void {
    this.closed = true
    for (const task of this.pending.splice(0)) task.resolve(closedResult())
    this.facts.clear()
    this.factVersions.clear()
  }

  private async drain(): Promise<void> {
    this.running = true
    try {
      for (;;) {
        const task = this.pending.shift()
        if (task === undefined) break
        let outcome: SettingsWriteResult
        try { outcome = this.closed ? closedResult() : await this.execute(task.command) }
        catch { outcome = { ...result(), config: 'unconfirmed' } }
        task.resolve(outcome)
      }
    } finally { this.running = false }
  }

  private defaultRef(): string {
    const ref = this.scope.getSnapshot().value?.apiKeyEnv
    return typeof ref === 'string' && ref !== '' ? ref : DEFAULT_API_KEY_REF
  }
  private value(field: string): unknown { return this.scope.getSnapshot().value?.[field] }
  private accounts(): Record<string, unknown>[] {
    const raw = this.value('accounts')
    return Array.isArray(raw) ? raw.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] : []
  }
  private rules(): StoredRule[] {
    const raw = this.value('modelAccountRules')
    if (!Array.isArray(raw)) return []
    return raw.flatMap(item => {
      const rule = record(item)
      const models = Array.isArray(rule.models) ? rule.models.filter((id): id is string => typeof id === 'string' && id !== '') : []
      return models.length ? [{ models, account: typeof rule.account === 'string' && rule.account !== '' ? rule.account : 'default' }] : []
    })
  }
  private cleanupRefs(): string[] {
    const raw = this.value('credentialCleanupRefs')
    return Array.isArray(raw) ? [...new Set(raw.filter((ref): ref is string => typeof ref === 'string' && ref !== ''))] : []
  }
  private bump(ref: string): number {
    const next = (this.factVersions.get(ref) ?? 0) + 1
    this.factVersions.set(ref, next)
    return next
  }

  /** 只刷新事实；此入口永远不重放凭据修改。缺少条目不能解释为不存在。 */
  async refreshCredentials(extra: readonly string[] = []): Promise<boolean> {
    if (this.closed) return false
    const refs = [...new Set([this.defaultRef(), ...this.accounts().flatMap(account => typeof account.apiKeyEnv === 'string' ? [account.apiKeyEnv] : []), ...extra])]
    const generation = ++this.refreshGeneration
    const versions = new Map(refs.map(ref => [ref, this.bump(ref)]))
    let success = false
    try {
      const response = await this.credentials.describe(refs)
      if (this.closed) return false
      success = response.ok && refs.every(ref => typeof response.value?.[ref]?.configured === 'boolean')
      success = success && refs.every(ref => this.factVersions.get(ref) === versions.get(ref))
      if (success) for (const ref of refs) {
        if (this.factVersions.get(ref) !== versions.get(ref)) continue
        const view = response.value![ref]!
        this.facts.set(ref, { configured: view.configured, writable: view.writable ?? true })
      }
    } catch { /* 未读到新事实时保留最后已确认结果，不猜测不存在。 */ }
    if (!this.closed && generation === this.refreshGeneration) {
      this.refreshFailed = !success
      this.onFactsChanged()
    }
    return success
  }

  private async commit(ops: readonly SettingsPathOp[], baseline?: ReadonlyMap<string, FieldBaseline>): Promise<SettingsMutationResult> {
    if (this.closed) return 'cancelled'
    const snapshot = this.scope.getSnapshot()
    if (!snapshot.writable || this.scope.mutate === undefined) return 'failed'
    if (baseline && [...baseline].some(([field, before]) => !sameValue(before, fieldBaseline(snapshot, field)))) return 'conflict'
    try { return await this.scope.mutate(ops, snapshot.revision) }
    catch { return 'failed' }
  }

  private async configure(outcome: SettingsWriteResult, ops: readonly SettingsPathOp[], baseline?: ReadonlyMap<string, FieldBaseline>): Promise<boolean> {
    if (ops.length === 0) return true
    const confirmation = await this.commit(ops, baseline)
    outcome.config = confirmation === 'accepted' ? 'confirmed' : confirmation === 'conflict' ? 'conflict' : 'unconfirmed'
    if (confirmation === 'cancelled' || this.closed) outcome.issue = 'closed'
    return confirmation === 'accepted' && !this.closed
  }

  private async changeCredential(outcome: SettingsWriteResult, ref: string, value: string | undefined, defaultRef?: string): Promise<void> {
    outcome.credential = 'not-issued'
    if (this.closed) { outcome.issue = 'closed'; return }
    if (defaultRef !== undefined && this.defaultRef() !== defaultRef) { outcome.issue = 'target-changed'; return }
    outcome.credentialRef = ref
    this.bump(ref)
    try {
      const response = value === undefined ? await this.credentials.unset(ref) : await this.credentials.set(ref, value)
      outcome.credential = response.ok ? 'confirmed' : 'unconfirmed'
    } catch { outcome.credential = 'unconfirmed' }
    if (this.closed) { outcome.issue = 'closed'; return }
    this.bump(ref)
    // 远端写入确认说明引用已修改；后续读回不提供密钥内容校验。
    if (outcome.credential === 'confirmed') {
      this.facts.set(ref, { configured: value !== undefined, writable: this.facts.get(ref)?.writable ?? true })
      this.onFactsChanged()
    }
    if (defaultRef !== undefined && this.defaultRef() !== defaultRef) outcome.issue = 'target-changed'
    outcome.refreshFailed = !(await this.refreshCredentials([ref]))
    if (defaultRef !== undefined && this.defaultRef() !== defaultRef) outcome.issue = 'target-changed'
    if (this.closed) outcome.issue = 'closed'
  }

  private async execute(command: Command): Promise<SettingsWriteResult> {
    const outcome = result()
    const intent = command.intent
    if (!this.scope.getSnapshot().writable) return {
      ...outcome,
      config: intent.kind === 'key' || (intent.kind === 'save' && command.ops.length === 0) ? 'none' : 'unconfirmed',
      credential: intent.kind === 'key' || (intent.kind === 'save' && intent.key !== undefined) ? 'not-issued' : 'none',
    }
    if (intent.kind === 'save') {
      if (intent.key !== undefined) outcome.credential = 'not-issued'
      if (!(await this.configure(outcome, command.ops, command.baseline))) return outcome
      if (intent.key !== undefined) await this.changeCredential(outcome, command.defaultRef!, intent.key, command.defaultRef)
    } else if (intent.kind === 'key') {
      if (intent.value !== undefined && intent.value.trim() === '') return { ...outcome, credential: 'not-issued' }
      await this.changeCredential(outcome, command.defaultRef ?? intent.target, intent.value, command.defaultRef)
    } else if (intent.kind === 'rename') {
      if (intent.label === '') return { ...outcome, config: 'unconfirmed' }
      await this.configure(outcome, [{ op: 'set', path: ['accounts'], value: this.accounts().map(account => account.apiKeyEnv === intent.ref ? { ...account, label: intent.label } : { ...account }) }])
    } else if (intent.kind === 'active') {
      // 恢复自动轮换与恢复继承不同；基础层有固定账号时必须显式覆盖为空。
      const base = record(this.scope.getSnapshot().base).activeAccount
      const op: SettingsPathOp = intent.id !== '' || (typeof base === 'string' && base !== '')
        ? { op: 'set', path: ['activeAccount'], value: intent.id } : { op: 'unset', path: ['activeAccount'] }
      await this.configure(outcome, [op])
    } else if (intent.kind === 'models') {
      const chosen = [...new Set(intent.models.filter(id => id !== ''))]
      const taken = new Set(chosen)
      const map = accountModelMap(this.rules())
      for (const [account, models] of map) if (account !== intent.target) map.set(account, models.filter(id => !taken.has(id)))
      map.set(intent.target, chosen)
      const rules = [...map].flatMap(([account, models]) => models.length ? [{ account, models }] : [])
      await this.configure(outcome, [{ op: 'set', path: ['modelAccountRules'], value: rules }])
    } else {
      if (intent.kind === 'remove') {
        if (!this.accounts().some(account => account.apiKeyEnv === intent.ref) && !this.cleanupRefs().includes(intent.ref)) return { ...outcome, config: 'unconfirmed' }
        const snapshot = this.scope.getSnapshot()
        const ops: SettingsPathOp[] = [
          { op: 'set', path: ['accounts'], value: this.accounts().filter(account => account.apiKeyEnv !== intent.ref).map(account => ({ ...account })) },
          { op: 'set', path: ['modelAccountRules'], value: this.rules().filter(rule => rule.account !== intent.ref) },
          { op: 'set', path: ['credentialCleanupRefs'], value: [...new Set([...this.cleanupRefs(), intent.ref])] },
        ]
        if (this.value('activeAccount') === intent.ref) ops.push(record(snapshot.base).activeAccount === intent.ref
          ? { op: 'set', path: ['activeAccount'], value: '' } : { op: 'unset', path: ['activeAccount'] })
        if (!(await this.configure(outcome, ops))) return outcome
      }
      await this.cleanRemoved(outcome, intent.ref)
    }
    return outcome
  }

  private async cleanRemoved(outcome: SettingsWriteResult, ref: string): Promise<void> {
    if (!this.cleanupRefs().includes(ref)) {
      if (outcome.config !== 'confirmed') outcome.config = 'unconfirmed'
      outcome.issue = 'cleanup-pending'
      return
    }
    if (this.closed) { outcome.issue = 'closed'; return }
    if (!(await this.refreshCredentials([ref]))) { outcome.credential = 'not-issued'; outcome.refreshFailed = true; return }
    if (this.closed) { outcome.issue = 'closed'; return }
    const inherited = record(this.scope.getSnapshot().base).accounts
    const referenced = ref === this.defaultRef() || this.accounts().some(account => account.apiKeyEnv === ref)
      || (Array.isArray(inherited) && inherited.some(account => record(account).apiKeyEnv === ref))
      || this.rules().some(rule => rule.account === ref) || this.value('activeAccount') === ref
    if (!referenced && this.facts.get(ref)?.configured === true) {
      await this.changeCredential(outcome, ref, undefined)
      if (!writeCompleted(outcome) || outcome.refreshFailed) {
        if (outcome.issue === undefined && outcome.credential === 'confirmed') outcome.issue = 'cleanup-pending'
        return
      }
    }
    if (this.closed) { outcome.issue = 'closed'; return }
    // 最后一步失败不能抹掉前面已经确认的账号移除／凭据清理事实。
    const cleanup = result()
    if (!(await this.configure(cleanup, [{ op: 'set', path: ['credentialCleanupRefs'], value: this.cleanupRefs().filter(entry => entry !== ref) }]))) {
      if (outcome.config === 'none') outcome.config = cleanup.config
      outcome.issue = cleanup.issue ?? 'cleanup-pending'
    } else if (outcome.config === 'none') outcome.config = cleanup.config
  }
}
