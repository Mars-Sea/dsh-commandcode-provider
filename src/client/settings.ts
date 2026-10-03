/** 设置页面控制器只负责输入校验、草稿版本与页面投影。
 * 保存及即时账号操作由同一个设置写入过程持有；设置与凭据分别确认。 */

import { MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../timeout-limits.ts'
import { modelIsVisible, readVisibility } from '../model-visibility.ts'
import type { SettingsMutationResult, SettingsPathOp } from './settings-scope.ts'
import { SettingsWriter, DEFAULT_API_KEY_REF, accountModelMap, writeCompleted, type StoredRule, type SettingsWriteIntent, type SettingsWriteResult } from './settings-write.ts'
export { DEFAULT_API_KEY_REF, accountModelMap } from './settings-write.ts'

/** The settings namespace the plugin registers (host half, src/index.ts). */
export const COMMANDCODE_NS = 'llm-commandcode'

/** The settings-scope snapshot fields consumed by this controller. */
export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host'
}

/** Current settings-scope service face used without importing a browser plugin value. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
  /** 多字段共用一次宿主版本检查并返回确认；缺少此能力不能提交配置。 */
  mutate?(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<SettingsMutationResult>
}

/** Result envelope returned by one current Typert Remote call. */
interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { message: string }
}

/** Credential facts returned without exposing the credential value. */
interface CredentialInfo {
  configured: boolean
  writable: boolean
}

/** The narrow slice of the wire face this controller needs. */
export interface SettingsPageApi {
  /** Credential methods exposed by the current Typert Remote namespace. */
  credentials: {
    describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
    set(ref: string, value: string): Promise<RemoteResult<void>>
    unset(ref: string): Promise<RemoteResult<void>>
  }
  /**
   * The model catalog for the model editors (Host-side). Optional: a transport
   * without the Remote mount leaves the editors on the empty-catalog state.
   */
  models?(): Promise<RemoteResult<{ models: CatalogModelOption[] }>>
}

/** One editable text field's staged state (blank = keep stored value). */
export interface StagedField {
  /** Live draft text the input shows. */
  text: string
  /** Whether the user explicitly cleared the field (reset to inherited). */
  clear: boolean
  /** Whether the user layer carries this field (marks it overridden). */
  overridden: boolean
  /** Whether the staged draft fails to parse (blocks save). */
  invalid: boolean
  /** `format`, `tooSmall`/`tooLarge`; undefined when valid. */
  invalidReason: InvalidReason | undefined
}

/** Why a staged draft fails validation (drives the per-field error copy). */
export type InvalidReason = 'format' | 'tooSmall' | 'tooLarge'

/**
 * One extra account row. Account management commits immediately (no page
 * save), so a row carries only Host facts — never a staged draft.
 */
export interface AccountItemState {
  /** Stable id — the account's credential reference (also its slot id). */
  id: string
  ref: string
  /** Stored label (falls back to the reference). */
  label: string
  configured: boolean
  credentialKnown: boolean
  writable: boolean
}

/** The immediate account operations, named for the failure copy. */
export type AccountOperation = 'rename' | 'remove' | 'key' | 'active' | 'models'

/** One selectable catalog model in the settings page's model editors. */
export interface CatalogModelOption {
  id: string
  name: string
  /**
   * Minimum plan-tier key (a Host `KNOWN_PLANS` value), or undefined for
   * models outside the snapshot / older Hosts. Drives the tier headings in
   * the editor dropdowns; absent tiers render unheaded.
   */
  tier?: string
  /**
   * Per-model MONTHLY allowance in USD, already resolved Host-side against the
   * account pool's highest plan (Go, GOAT and Pro publish one). Undefined for
   * plans without an allowance, for models the page has no row for, and for
   * older Hosts — the row then shows no allowance instead of a guess.
   */
  allowance?: number
}

/** The page's full state face, projected from the scope + drafts + credential. */
export interface SettingsPageState {
  /** Whether the namespace snapshot is ready. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the API key is currently configured (Host-reported). */
  apiKeyConfigured: boolean
  /** 没有描述或写入确认时状态未知，不能显示为未配置。 */
  apiKeyKnown: boolean
  /** Whether ANY account (default or extra) has a stored key — gates the usage card. */
  anyAccountConfigured: boolean
  /** Whether the credentials domain can store the key. */
  apiKeyWritable: boolean
  /**
   * The default API key draft (write-only; starts blank, never echoes the
   * stored key). Only the Models-page card stages it for its own save; the
   * settings page writes keys immediately through `setAccountKey()`.
   */
  apiKey: StagedField
  apiBase: StagedField
  requestTimeoutMs: StagedField
  streamIdleTimeoutMs: StagedField
  /**
   * transportMaxRetries draft: how many transport failures one request absorbs
   * before the failure surfaces (issue #39's second report — the retry policy's
   * 1000-attempt, 15-minute cadence turned a 10-second TCP connect timeout into
   * an ~8-minute stall). Unset means the Host default, so it stages like the
   * timeout fields above rather than as a toggle with an implicit default.
   */
  transportMaxRetries: StagedField
  /** Opt-in durable offload of images after this model has answered. */
  offloadSeenImagesForCache: StagedField
  /** filterModelsByPlan draft; `''` = "inherit the default" (on). */
  filterModelsByPlan: StagedField
  /** webSearch draft; `''` = "inherit the default" (on — this route serves dsh's web_search). */
  webSearch: StagedField
  /** showSidebarQuota draft; `''` = "inherit the default" (off — the card is opt-in). */
  showSidebarQuota: StagedField
  /** zdr draft; `''` = "inherit the default" (off — ZDR is opt-in). */
  zdr: StagedField
  /**
   * Whether the STORED document turns the sidebar quota card on
   * (`showSidebarQuota === true`). Deliberately NOT the staged draft above: the
   * page has an explicit Save, and a card that appeared from an unsaved draft
   * would outlive a discarded edit (staging lives as long as the client does)
   * until the next page load.
   */
  sidebarQuota: boolean
  /** The stored pinned account: a slot id; `''` = "auto — first usable account". */
  activeAccount: string
  /** Extra accounts (multi-account rotation), in rotation order. */
  accounts: AccountItemState[]
  /**
   * Each account's dedicated models, keyed by slot id, derived from the stored
   * `modelAccountRules` with the runtime's first-match-wins semantics, so a
   * model sits under exactly the one account that would serve it.
   */
  accountModels: Record<string, string[]>
  /** Whether an immediate account operation is in flight. */
  accountBusy: boolean
  /** The last immediate account operation that failed (cleared by the next one). */
  accountFailed: AccountOperation | undefined
  /** 已移除账户的待清理凭据引用，来自持久化配置，刷新后仍能重试。 */
  pendingCredentialCleanup: string[]
  /** 宿主开通尚未完成的引用，不展示可操作的账号行。 */
  accountEnrollmentRefs: string[]
  /** Effective visible-model allowlist: staged draft or stored value. Empty = show all. */
  visibleModels: string[]
  /** 区分不受限制与终端显式隐藏全部；不能用空数组推断显示全部。 */
  visibleModelsAll: boolean
  /** The catalog the model editors offer (Host-side, empty until loaded). */
  catalogModels: CatalogModelOption[]
  /** Whether the catalog fetch failed (editors fall back to typing). */
  catalogFailed: boolean
  /** Whether any staged edit differs from the stored section. */
  dirty: boolean
  /** Whether a staged numeric field fails to parse (save blocked). */
  invalid: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save failed (drafts retained for correction). */
  failed: boolean
  /** Monotonic counter bumped once per accepted save (the component flashes on it). */
  savedCount: number
  /** 本次写入各阶段的确认事实，不用整体失败推断回滚。 */
  saveResult: SettingsWriteResult | undefined
  accountResult: SettingsWriteResult | undefined
  credentialRefreshFailed: boolean
}

/** Parsed outcome of one field's draft. */
type Parsed =
  | { kind: 'set'; value: string | number | boolean }
  | { kind: 'clear' }
  | { kind: 'invalid'; reason: InvalidReason }

/** One field's staged draft (internal; the public face adds derived flags). */
interface Staged {
  text: string
  clear: boolean
}

/** A field conversion spec. */
interface FieldSpec {
  field: string
  format(value: unknown): string
  parse(text: string): Parsed
}

/** A free-text field; an empty draft clears it. */
function textField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A numeric field; an empty draft clears it, anything non-numeric blocks
 * save, and an optional inclusive `bounds` range rejects out-of-range values
 * with a specific reason (the Host schema would reject them at save time with
 * only a generic failure — catching it here names the problem while typing).
 * Decimals pass, like the Host schema's `z.number()`.
 */
function numberField(field: string, bounds?: { min?: number; max?: number }): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return { kind: 'invalid', reason: 'format' }
      if (bounds?.min !== undefined && parsed < bounds.min) return { kind: 'invalid', reason: 'tooSmall' }
      if (bounds?.max !== undefined && parsed > bounds.max) return { kind: 'invalid', reason: 'tooLarge' }
      return { kind: 'set', value: parsed }
    },
  }
}

/**
 * A boolean field, staged as the strings `'true'`/`'false'` (an empty draft
 * clears it). The component renders a toggle and only ever stages these two
 * strings; anything else blocks save.
 */
function booleanField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return { kind: 'invalid', reason: 'format' }
    },
  }
}

/**
 * The second-based bounds the timeout fields are EDITED in.
 *
 * The stored unit stays milliseconds — that is the Host schema
 * (`z.number().min(1).max(MAX_TIMER_DELAY_MS)` in src/index.ts, dsh-timeout's
 * 2^31-1 timer ceiling), and switching it would break every existing profile —
 * so this is presentation only: the field formats ms ÷ 1000 on the way in and
 * multiplies by 1000 on the way out. 3600 rather than the Host's ceiling (~24.8
 * days), because a header wait longer than an hour is a hung process, not a
 * budget, and the input is the place to refuse it. A hand-written profile can
 * still carry a larger value; `secondsField` displays that true number rather
 * than silently clamping, it just cannot be re-typed here.
 */
export { MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../timeout-limits.ts'

/**
 * 秒制输入保留毫秒精度，兼容已有 1500ms、1ms 等配置。
 *
 * Milliseconds are the wrong unit to show: the defaults are 300000 and the
 * ceiling is 2147483647, so the page asked users to do arithmetic to answer
 * "how long is a reasonable wait". `format` divides, `parse` multiplies, and
 * the stored value never leaves milliseconds.
 *
 * 最多三位小数；不接受更多位数后悄悄取整，避免页面与存储不一致。
 */
function secondsField(field: string, bounds: { min: number; max: number }): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value / 1000) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || !/^-?(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(trimmed)) return { kind: 'invalid', reason: 'format' }
      if (parsed < bounds.min) return { kind: 'invalid', reason: 'tooSmall' }
      if (parsed > bounds.max) return { kind: 'invalid', reason: 'tooLarge' }
      return { kind: 'set', value: Math.round(parsed * 1000) }
    },
  }
}

/** The fields this page edits inside the `llm-commandcode` namespace. */
const SECTION_FIELDS: FieldSpec[] = [
  textField('apiBase'),
  secondsField('requestTimeoutMs', { min: MIN_TIMEOUT_SECONDS, max: MAX_TIMEOUT_SECONDS }),
  secondsField('streamIdleTimeoutMs', { min: MIN_TIMEOUT_SECONDS, max: MAX_TIMEOUT_SECONDS }),
  // A COUNT of retries, not a millisecond wait: it shares the Host schema's
  // 0..50 bounds (`MAX_TRANSPORT_MAX_RETRIES` in src/transport-retry.ts, applied
  // to `transportMaxRetries` in src/index.ts) rather than the timer ceiling
  // above, so a draft can never be saved in a shape the Host rejects. The Host
  // stays the final gate, and the client bundle cannot import that node-side
  // module — `tests/transport-retry.test.ts` pins the schema's bound against
  // the constant so this mirrored literal cannot drift unnoticed.
  numberField('transportMaxRetries', { min: 0, max: 50 }),
  booleanField('offloadSeenImagesForCache'),
  booleanField('filterModelsByPlan'),
  booleanField('webSearch'),
  booleanField('showSidebarQuota'),
  booleanField('zdr'),
]

/** Whether two model-id lists are equal as sets (order-insensitive). */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** 共享控制器跨普通切页保存草稿，插件销毁才关闭写入过程。 */
export class CommandCodeSettingsController {
  private readonly scope: SettingsScope<Record<string, unknown>>
  private readonly api: SettingsPageApi
  private readonly specs = new Map(SECTION_FIELDS.map((spec) => [spec.field, spec]))
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly disposers: Array<() => void> = []
  private disposed = false
  private credentialRef = DEFAULT_API_KEY_REF
  private readonly writer: SettingsWriter
  private saveResult: SettingsWriteResult | undefined
  private accountResult: SettingsWriteResult | undefined
  /** Staged visible-model allowlist (undefined = no draft). */
  private visibleModelsDraft: string[] | undefined = undefined
  private catalogModels: CatalogModelOption[] = []
  private catalogFailed = false
  private saving = false
  private failed = false
  private savedCount = 0
  private accountPending = 0
  private accountFailed: AccountOperation | undefined = undefined

  constructor(
    scope: SettingsScope<Record<string, unknown>>,
    api: SettingsPageApi,
  ) {
    this.scope = scope
    this.api = api
    this.writer = new SettingsWriter(scope, api.credentials, () => this.publish())
    this.disposers.push(scope.subscribe(() => {
      this.recomputeCredentialRef()
      void this.writer.refreshCredentials()
      this.publish()
    }))
    this.recomputeCredentialRef()
    void this.writer.refreshCredentials()
    this.refreshCatalog()
  }

  /** Release every subscription held on external sources. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.writer.dispose()
    this.staged.clear()
    this.visibleModelsDraft = undefined
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    this.listeners.clear()
  }

  /**
   * The credential reference the section names, or the provider default. A
   * user who renamed `apiKeyEnv` in the profile Config gets a page that
   * addresses the renamed ref instead of silently writing the default —
   * 与模型卡共享同一设置引用。
   */
  private recomputeCredentialRef(): void {
    const snapshot = this.scope.getSnapshot()
    const named = typeof snapshot.value?.apiKeyEnv === 'string' && snapshot.value.apiKeyEnv.length > 0
      ? snapshot.value.apiKeyEnv
      : DEFAULT_API_KEY_REF
    if (named === this.credentialRef) return
    this.credentialRef = named
  }

  /** Subscribe to state projections. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Build the current page state face. */
  state(): SettingsPageState {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    const credential = this.writer.credential(this.credentialRef)
    const accounts = this.effectiveAccounts()
    const active = this.sectionValue('activeAccount')
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      apiKeyConfigured: credential?.configured ?? false,
      apiKeyKnown: credential !== undefined,
      anyAccountConfigured: (credential?.configured ?? false) || accounts.some((account) => account.configured),
      apiKeyWritable: credential?.writable ?? true,
      apiKey: {
        text: this.staged.get('apiKey')?.text ?? '',
        clear: false,
        overridden: false,
        invalid: false,
        invalidReason: undefined,
      },
      apiBase: this.field('apiBase'),
      requestTimeoutMs: this.field('requestTimeoutMs'),
      streamIdleTimeoutMs: this.field('streamIdleTimeoutMs'),
      transportMaxRetries: this.field('transportMaxRetries'),
      offloadSeenImagesForCache: this.field('offloadSeenImagesForCache'),
      filterModelsByPlan: this.field('filterModelsByPlan'),
      webSearch: this.field('webSearch'),
      showSidebarQuota: this.field('showSidebarQuota'),
      zdr: this.field('zdr'),
      sidebarQuota: this.sectionValue('showSidebarQuota') === true,
      activeAccount: typeof active === 'string' ? active : '',
      accounts,
      accountModels: Object.fromEntries(accountModelMap(this.storedRules())),
      accountBusy: this.accountPending > 0,
      accountFailed: this.accountFailed,
      pendingCredentialCleanup: this.cleanupRefs().filter((ref) => !this.enrollmentRefs(true).includes(ref)),
      accountEnrollmentRefs: this.enrollmentRefs(false),
      visibleModels: this.effectiveVisibleModels(),
      visibleModelsAll: this.visibleModelsDraft === undefined ? this.storedShowsAll() : this.visibleModelsDraft.length === 0,
      catalogModels: this.catalogModels,
      catalogFailed: this.catalogFailed,
      dirty: plan.length > 0 || this.visibleModelsDirty(),
      invalid: plan.some((item) => item.change === undefined),
      saving: this.saving,
      failed: this.failed,
      savedCount: this.savedCount,
      saveResult: this.saveResult,
      accountResult: this.accountResult,
      credentialRefreshFailed: this.writer.factsRefreshFailed(),
    }
  }

  // --- Staged form ---

  private enrollmentRefs(includeNamed: boolean): string[] {
    const records = this.sectionValue('accountEnrollmentTasks')
    if (!Array.isArray(records)) return []
    return records.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      return typeof record.ref === 'string' && (includeNamed || record.phase !== 'naming') ? [record.ref] : []
    })
  }

  /** Stage one field's draft text. */
  edit(field: string, text: string): void {
    if (field !== 'apiKey') this.spec(field)
    this.staged.set(field, { text, clear: false })
    this.failed = false
    this.saveResult = undefined
    this.publish()
  }

  /** Reset one section field to its inherited (composition) value. */
  resetField(field: string): void {
    if (field === 'apiKey') {
      this.staged.delete('apiKey')
      this.failed = false
      this.publish()
      return
    }
    const spec = this.spec(field)
    this.staged.set(field, { text: spec.format(this.baseValue(field)), clear: true })
    this.failed = false
    this.saveResult = undefined
    this.publish()
  }

  /** Discard every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && this.visibleModelsDraft === undefined && !this.failed) return
    this.staged.clear()
    this.visibleModelsDraft = undefined
    this.failed = false
    this.saveResult = undefined
    this.publish()
  }

  /**
   * Re-read the Host's credential facts without any staged edit. The browser
   * login stores a key Host-side behind the page's back; the plugin entry
   * calls this when a login lands so the configured/writable badges follow.
   */
  async refreshCredentials(): Promise<void> {
    if (!(await this.writer.refreshCredentials()) || this.disposed) return
    if (this.saveResult) this.saveResult = { ...this.saveResult, refreshFailed: false }
    if (this.accountResult) this.accountResult = { ...this.accountResult, refreshFailed: false }
    this.publish()
  }

  /** 冻结点击时的草稿；只清理本次已确认且期间未被替换的对象。 */
  async save(): Promise<SettingsWriteResult | undefined> {
    if (this.disposed || this.saving) return
    const submitted = new Map(this.staged)
    const submittedVisible = this.visibleModelsDraft
    const plan = this.plan()
    const visibleDirty = this.visibleModelsDirty()
    if ((plan.length === 0 && !visibleDirty) || plan.some(item => item.change === undefined)) return
    const ops = plan.flatMap(item => typeof item.change === 'object' ? [item.change] : [])
    const key = plan.find(item => item.field === 'apiKey')?.change
    this.saving = true
    this.failed = false
    this.saveResult = undefined
    // 入队先于通知订阅者，避免通知回调发起的后续操作插队。
    const completion = this.writer.submit({ kind: 'save', ops,
      ...(visibleDirty ? { visibleModels: submittedVisible ?? [] } : {}),
      ...(typeof key === 'string' ? { key } : {}),
    })
    this.publish()
    const outcome = await completion
    if (this.disposed) return outcome
    this.saving = false
    this.saveResult = outcome
    this.failed = !writeCompleted(outcome)
    if (!this.failed) this.savedCount += 1
    for (const [field, draft] of submitted) {
      const confirmed = field === 'apiKey'
        ? outcome.credential === 'confirmed' && outcome.issue === undefined
        : outcome.config === 'confirmed' || writeCompleted(outcome)
      if (confirmed && this.staged.get(field) === draft) this.staged.delete(field)
    }
    if ((outcome.config === 'confirmed' || writeCompleted(outcome)) && this.visibleModelsDraft === submittedVisible) this.visibleModelsDraft = undefined
    this.publish()
    return outcome
  }

  /** Stage the visible-model allowlist (multi-select). */
  editVisibleModels(models: string[]): void {
    this.visibleModelsDraft = [...models]
    this.failed = false
    this.saveResult = undefined
    this.publish()
  }

  /** Stage "show all models" (clears the allowlist). */
  clearVisibleModels(): void {
    this.visibleModelsDraft = []
    this.failed = false
    this.saveResult = undefined
    this.publish()
  }

  // --- Immediate account management ---

  renameAccount(ref: string, label: string): Promise<boolean> {
    return this.runAccountOp('rename', { kind: 'rename', ref, label: label.trim() })
  }

  /** 配置移除确认后才清理凭据，失败记录留在宿主清理队列。 */
  removeAccount(ref: string): Promise<boolean> {
    return this.runAccountOp('remove', { kind: 'remove', ref })
  }

  retryCredentialCleanup(ref: string): Promise<boolean> {
    return this.runAccountOp('remove', { kind: 'cleanup', ref })
  }

  private cleanupRefs(): string[] {
    const raw = this.sectionValue('credentialCleanupRefs')
    return Array.isArray(raw) ? [...new Set(raw.filter((ref): ref is string => typeof ref === 'string' && ref !== ''))] : []
  }

  setAccountKey(target: string, key: string): Promise<boolean> {
    return this.runAccountOp('key', { kind: 'key', target, value: key.trim() })
  }

  clearAccountKey(target: string): Promise<boolean> {
    return this.runAccountOp('key', { kind: 'key', target })
  }

  setActiveAccount(id: string): Promise<boolean> {
    return this.runAccountOp('active', { kind: 'active', id })
  }

  setAccountModels(target: string, models: readonly string[]): Promise<boolean> {
    return this.runAccountOp('models', { kind: 'models', target, models })
  }

  /** 即时入口与保存共享写入过程，只在这里维护页面忙碌投影。 */
  private async runAccountOp(op: AccountOperation, intent: SettingsWriteIntent): Promise<boolean> {
    this.accountPending += 1
    this.accountFailed = undefined
    this.accountResult = undefined
    const completion = this.writer.submit(intent)
    this.publish()
    const outcome = await completion
    this.accountPending -= 1
    if (this.disposed) return false
    const ok = writeCompleted(outcome)
    this.accountResult = outcome
    this.accountFailed = ok ? undefined : op
    this.publish()
    return ok
  }

  private spec(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`commandcode settings page has no field ${field}`)
    return spec
  }

  /** One field's rendered state: draft text, whether it is user-overridden, invalid. */
  private field(field: string): StagedField {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        clear: false,
        overridden: this.stored(field),
        invalid: false,
        invalidReason: undefined,
      }
    }
    const parsed = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      clear: staged.clear,
      overridden: parsed.kind === 'set',
      invalid: parsed.kind === 'invalid',
      invalidReason: parsed.kind === 'invalid' ? parsed.reason : undefined,
    }
  }

  private sectionValue(field: string): unknown {
    return this.scope.getSnapshot().value?.[field]
  }

  private baseValue(field: string): unknown {
    const base = this.scope.getSnapshot().base
    return typeof base === 'object' && base !== null && !Array.isArray(base)
      ? (base as Record<string, unknown>)[field]
      : undefined
  }

  private userLayer(): Record<string, unknown> | undefined {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null && !Array.isArray(user)
      ? (user as Record<string, unknown>)
      : undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.prototype.hasOwnProperty.call(user, field)
  }

  /** 纯提交计划；不捕获副作用闭包，也不在排队后重新读取草稿。 */
  private plan(): Array<{ field: string; change: SettingsPathOp | string | undefined }> {
    const plan: Array<{ field: string; change: SettingsPathOp | string | undefined }> = []
    for (const [field, staged] of this.staged) {
      if (field === 'apiKey') {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, change: value })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, change: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const parsed = spec.parse(staged.text)
      const change: SettingsPathOp | undefined = parsed.kind === 'invalid' ? undefined
        : parsed.kind === 'clear' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: parsed.value }
      plan.push({ field, change })
    }
    return plan
  }

  /**
   * Fetch the model catalog through the Host Remote. Runs once at construction;
   * call again (e.g. from the client entry once the Remote mount lands) to
   * (re)try — a later success clears a prior failure flag, so the editors
   * recover without a page reload.
   */
  refreshCatalog(): void {
    const models = this.api.models
    if (models === undefined) {
      this.catalogFailed = true
      this.publish()
      return
    }
    void models().then((response) => {
      if (response.ok && Array.isArray(response.value?.models)) {
        // Defensive per-entry shaping: the Remote result is untrusted at the
        // boundary, and an older Host predates the tier field.
        const shaped: CatalogModelOption[] = []
        for (const model of response.value.models) {
          if (typeof model !== 'object' || model === null) continue
          const entry = model as unknown as Record<string, unknown>
          if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
          shaped.push({
            id: entry.id,
            name: entry.name,
            ...(typeof entry.tier === 'string' ? { tier: entry.tier } : {}),
            ...(typeof entry.allowance === 'number' && Number.isFinite(entry.allowance)
              ? { allowance: entry.allowance }
              : {}),
          })
        }
        this.catalogModels = shaped
        this.catalogFailed = false
      } else {
        this.catalogFailed = true
      }
    }, () => {
      this.catalogFailed = true
    }).then(() => this.publish())
  }

  // --- Stored accounts and rules ---

  /** The raw `accounts` array of the stored section, verbatim. */
  private rawStoredAccounts(): Array<Record<string, unknown>> {
    const raw = this.scope.getSnapshot().value?.accounts
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  }

  /**
   * The stored extra accounts this page can address: the rows carrying a
   * credential reference. Entries it cannot name (a composition entry with a
   * literal `apiKey`, or an unknown shape) are never dropped — every list
   * write starts from {@link rawStoredAccounts} and copies them verbatim,
   * because the settings layer replaces the whole array.
   */
  private storedExtras(): Array<{ label: string; ref: string }> {
    const out: Array<{ label: string; ref: string }> = []
    const seen = new Set<string>()
    for (const record of this.rawStoredAccounts()) {
      const ref = record.apiKeyEnv
      if (typeof ref !== 'string' || ref === '' || seen.has(ref)) continue
      seen.add(ref)
      const label = record.label
      out.push({ label: typeof label === 'string' && label !== '' ? label : ref, ref })
    }
    return out
  }

  private effectiveAccounts(): AccountItemState[] {
    return this.storedExtras().map((extra) => ({
      id: extra.ref,
      ref: extra.ref,
      label: extra.label,
      configured: this.writer.credential(extra.ref)?.configured ?? false,
      credentialKnown: this.writer.credential(extra.ref) !== undefined,
      writable: this.writer.credential(extra.ref)?.writable ?? true,
    }))
  }

  /** The stored routing rules from the settings section (`modelAccountRules`). */
  private storedRules(): StoredRule[] {
    const raw = this.scope.getSnapshot().value?.modelAccountRules
    if (!Array.isArray(raw)) return []
    const out: StoredRule[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const models = Array.isArray(record.models)
        ? record.models.filter((m): m is string => typeof m === 'string' && m !== '')
        : []
      if (models.length === 0) continue
      out.push({
        models,
        account: typeof record.account === 'string' && record.account !== '' ? record.account : 'default',
      })
    }
    return out
  }

  /** 原始白名单；空列表延续现有的显示全部语义。 */
  private storedAllowlist(): string[] {
    const raw = this.scope.getSnapshot().value?.visibleModels
    if (!Array.isArray(raw)) return []
    return raw.filter((m): m is string => typeof m === 'string' && m !== '')
  }

  private storedShowsAll(): boolean {
    return this.storedAllowlist().length === 0
      && !Object.values(readVisibility(this.scope.getSnapshot().value?.modelVisibility)).includes(false)
  }

  /** 目录、白名单与显式显示的旧模型一起投影，目录失败不删除旧选择。 */
  private storedVisibleModels(): string[] {
    const list = this.storedAllowlist()
    const flags = readVisibility(this.scope.getSnapshot().value?.modelVisibility)
    const ids = [...new Set([...list, ...this.catalogModels.map((model) => model.id), ...Object.keys(flags)])]
    return ids.filter((id) => modelIsVisible(id, list, flags))
  }

  private effectiveVisibleModels(): string[] {
    if (this.visibleModelsDraft === undefined) return this.storedVisibleModels()
    return this.visibleModelsDraft.length === 0
      ? this.catalogModels.map((model) => model.id)
      : this.visibleModelsDraft
  }

  private visibleModelsDirty(): boolean {
    if (this.visibleModelsDraft === undefined) return false
    if (this.visibleModelsDraft.length === 0) return !this.storedShowsAll()
    return this.storedShowsAll() || !sameModels(this.visibleModelsDraft, this.storedVisibleModels())
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}
