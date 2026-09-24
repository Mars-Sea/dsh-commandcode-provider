/**
 * Browser controller for the "Command Code" settings page.
 *
 * The page lives at the same settings-nav level as General / Models / Plugins
 * (a `settings.section` entry, id `commandcode`). It exists because the
 * Models page renders an unknown-adapter-family card for the `commandcode`
 * provider and deliberately disables its submit — the API key cannot be
 * configured there. This page owns the connection facts the plugin resolves
 * per request:
 *
 *   - API key   -> written through the credentials domain under the reference
 *                  the plugin resolves (`apiKeyEnv`, default
 *                  `COMMANDCODE_API_KEY`). The literal never rides a response,
 *                  so the control only reports whether one is configured.
 *   - API base  -> the `llm-commandcode` settings namespace (`apiBase`), same
 *                  namespace the Models page card addresses.
 *   - Timeouts, behavior switches, model visibility -> the same namespace,
 *                  staged and written on save.
 *   - Accounts  -> `accounts`, `activeAccount`, `modelAccountRules` and the
 *                  per-account credentials, committed immediately.
 *
 * The controller mirrors the plugin-card pattern from the harness's own
 * settings UI: it binds the `llm-commandcode` namespace through a
 * `SettingsScope` — this plugin's own binding of `remote.settings` (see
 * `./settings-scope.ts`; the harness's `settingsScope` wrapper existed only
 * through 0.1.6 and was removed with the 0.1.7 settings rewrite, while the
 * wire underneath spans every supported release) — keeps a staged draft of
 * edits, and writes them on save through `scope.set` / the credentials
 * domain. The Host stays the single fact source; the snapshot is republished
 * after each accepted write.
 *
 * This module is deliberately free of JSX — it only produces the state face
 * the React component renders.
 */

/** The settings namespace the plugin registers (host half, src/index.ts). */
export const COMMANDCODE_NS = 'llm-commandcode'
/** Default credential reference the plugin resolves when none is named. */
export const DEFAULT_API_KEY_REF = 'COMMANDCODE_API_KEY'

/** The settings-scope snapshot fields consumed by this controller. */
export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** Current settings-scope service face used without importing a browser plugin value. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
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
   * The model catalog for the settings page's model editors (the
   * routing-rule editor and the visible-models filter; Host-side). Absent
   * on legacy transports without the Remote mount — the editors degrade to
   * the empty-catalog state.
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
  /**
   * Why the draft is invalid — a non-number (`format`) or an out-of-range
   * number (`tooSmall`/`tooLarge`); undefined when valid.
   */
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
  /** Credential reference this account's key lives under. */
  ref: string
  /** Stored label (falls back to the reference). */
  label: string
  /** Whether a key is stored for this account (Host-reported). */
  configured: boolean
  /** Whether the credentials domain can store the key. */
  writable: boolean
}

/** The immediate account operations, named for the failure copy. */
export type AccountOperation = 'create' | 'rename' | 'remove' | 'key' | 'active' | 'models'

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
}

/** The page's full state face, projected from the scope + drafts + credential. */
export interface SettingsPageState {
  /** Whether the namespace snapshot is ready. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the API key is currently configured (Host-reported). */
  apiKeyConfigured: boolean
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
  /** apiBase draft. */
  apiBase: StagedField
  /** requestTimeoutMs draft. */
  requestTimeoutMs: StagedField
  /** streamIdleTimeoutMs draft. */
  streamIdleTimeoutMs: StagedField
  /**
   * transportMaxRetries draft: how many transport failures one request absorbs
   * before the failure surfaces (issue #39's second report — the retry policy's
   * 1000-attempt, 15-minute cadence turned a 10-second TCP connect timeout into
   * an ~8-minute stall). Unset means the Host default, so it stages like the
   * timeout fields above rather than as a toggle with an implicit default.
   */
  transportMaxRetries: StagedField
  /**
   * filterModelsByPlan draft, staged as `'true'`/`'false'`/`''` (unset). The
   * component renders it as a toggle; `''` means "inherit the default" (on).
   */
  filterModelsByPlan: StagedField
  /**
   * webSearch draft, staged as `'true'`/`'false'`/`''` (unset). The component
   * renders it as a toggle; `''` means "inherit the default" (on — Command Code
   * serves the dsh web_search tool).
   */
  webSearch: StagedField
  /**
   * showSidebarQuota draft, staged as `'true'`/`'false'`/`''` (unset). The
   * component renders it as a toggle; `''` means "inherit the default" (off —
   * the sidebar quota card is opt-in, so an unset document shows nothing on
   * the left).
   */
  showSidebarQuota: StagedField
  /**
   * commandGuard draft, staged as `'true'`/`'false'`/`''` (unset). The component
   * renders it as a toggle; `''` means "inherit the default" (off — the guard
   * turns a decision model's opinion into an approval grant, so it is opt-in).
   */
  commandGuard: StagedField
  /**
   * commandGuardLevel draft: `'high'` / `'medium'` / `'low'`, or `''` (unset,
   * which the Host reads as `'medium'`). The page renders it as a three-way
   * segmented control.
   */
  commandGuardLevel: StagedField
  /**
   * zdr draft, staged as `'true'`/`'false'`/`''` (unset). The component
   * renders it as a toggle; `''` means "inherit the default" (off — ZDR
   * changes which upstream serves a request and usually what it costs, so it
   * is opt-in like the guard above).
   */
  zdr: StagedField
  /**
   * Whether the STORED document turns the sidebar quota card on
   * (`showSidebarQuota === true`). This is the fact the sidebar card itself
   * follows — deliberately NOT the staged draft above: the page has an explicit
   * Save, and a card that appeared from an unsaved draft would outlive a
   * discarded edit (the staging lives as long as the client does) until the
   * next page load. The stored fact flips the moment a save lands, so the card
   * still appears/disappears without a reload.
   */
  sidebarQuota: boolean
  /**
   * The stored pinned account: a slot id (`default` or an extra account's
   * credential reference); `''` means "auto — first usable account".
   */
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
  /** Effective visible-model allowlist: staged draft or stored value. Empty = show all. */
  visibleModels: string[]
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
  /**
   * Monotonic counter bumped once per accepted save. The component watches it
   * to flash the save bar's "saved" confirmation (timing lives in the component; the
   * controller stays a plain state machine with no timers).
   */
  savedCount: number
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
 * Decimals pass: the Host schema is `z.number()` too, and a fractional
 * millisecond value is harmless even if pointless.
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

/** A field limited to fixed string choices; an empty draft clears it. */
function choiceField(field: string, choices: readonly string[]): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' && choices.includes(value) ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return choices.includes(trimmed) ? { kind: 'set', value: trimmed } : { kind: 'invalid', reason: 'format' }
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
 * Inclusive bounds for the millisecond timeout fields, mirroring the Host
 * Config schema (`z.number().min(1).max(MAX_TIMER_DELAY_MS)` in src/index.ts;
 * `MAX_TIMER_DELAY_MS` is dsh-timeout's 2^31-1 timer ceiling). The client
 * bundle cannot import the node-side package, so the bound is pinned here —
 * the host remains the final gate.
 */
export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 2147483647

/** The command guard's auto-approve levels, strictest first. */
export const COMMAND_GUARD_LEVEL_CHOICES = ['high', 'medium', 'low'] as const

/** The level an unset `commandGuardLevel` reads as on the Host. */
export const COMMAND_GUARD_DEFAULT_LEVEL_CHOICE = 'medium'

/** The fields this page edits inside the `llm-commandcode` namespace. */
const SECTION_FIELDS: FieldSpec[] = [
  textField('apiBase'),
  numberField('requestTimeoutMs', { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }),
  numberField('streamIdleTimeoutMs', { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }),
  // A COUNT of retries, not a millisecond wait: it shares the Host schema's
  // 0..50 bounds (`MAX_TRANSPORT_MAX_RETRIES` in src/transport-retry.ts, applied
  // to `transportMaxRetries` in src/index.ts) rather than the timer ceiling
  // above, so a draft can never be saved in a shape the Host rejects. The Host
  // stays the final gate, and the client bundle cannot import that node-side
  // module — `tests/transport-retry.test.ts` pins the schema's bound against
  // the constant so this mirrored literal cannot drift unnoticed.
  numberField('transportMaxRetries', { min: 0, max: 50 }),
  booleanField('filterModelsByPlan'),
  booleanField('webSearch'),
  booleanField('showSidebarQuota'),
  booleanField('commandGuard'),
  // Mirrors COMMAND_GUARD_LEVELS in the Host's `src/command-guard.ts`; this
  // bundle cannot import that node-side module, and the Host schema stays the
  // final gate.
  choiceField('commandGuardLevel', COMMAND_GUARD_LEVEL_CHOICES),
  booleanField('zdr'),
]

/** Whether two model-id lists are equal as sets (order-insensitive). */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** One stored routing rule, normalized. */
interface StoredRule {
  models: string[]
  account: string
}

/**
 * Fold routing rules into one model list per account with the runtime's
 * first-match-wins order (`matchModelRule()` in src/accounts.ts): a model
 * claimed by an earlier rule is ignored by every later one. Account order is
 * first appearance, which keeps a rewrite's rule order stable.
 */
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

/** Serialize a per-account model map back into `modelAccountRules`. */
function rulesFromMap(map: ReadonlyMap<string, readonly string[]>): StoredRule[] {
  const out: StoredRule[] = []
  for (const [account, models] of map) {
    if (models.length > 0) out.push({ models: [...models], account })
  }
  return out
}

/**
 * Controller bridging the `llm-commandcode` scope and the credentials domain
 * onto the page.
 *
 * Two write paths with different contracts:
 * - The staged form (connection, behavior and model-visibility fields, plus
 *   the Models-page card's default key draft) lands on `save()`.
 * - Account management (create, rename, remove, key replacement, pinning and
 *   per-account models) commits IMMEDIATELY and serially. A new account had to
 *   be saved before browser sign-in could target it (the Host refuses a login
 *   for a reference the stored `accounts` list does not name), which turned
 *   "add an account" into edit → save → sign in; committing each operation
 *   removes that dance and keeps unrelated staged edits out of it.
 */
export class CommandCodeSettingsController {
  private readonly scope: SettingsScope<Record<string, unknown>>
  private readonly api: SettingsPageApi
  private readonly specs = new Map(SECTION_FIELDS.map((spec) => [spec.field, spec]))
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly disposers: Array<() => void> = []
  private disposed = false
  /** The credential reference the default account resolves. */
  private credentialRef = DEFAULT_API_KEY_REF
  /** Host-reported configured/writable state per credential reference. */
  private readonly credentialStates = new Map<string, { configured: boolean; writable: boolean }>()
  /** Staged visible-model allowlist (undefined = no draft). */
  private visibleModelsDraft: string[] | undefined = undefined
  /** The catalog the model editors offer (Host-side). */
  private catalogModels: CatalogModelOption[] = []
  private catalogFailed = false
  private saving = false
  private failed = false
  private savedCount = 0
  /** Tail of the serial account-operation queue. */
  private accountQueue: Promise<unknown> = Promise.resolve()
  private accountPending = 0
  private accountFailed: AccountOperation | undefined = undefined

  /**
   * @param scope - bound scope for the `llm-commandcode` namespace.
   * @param api - credentials wire face.
   */
  constructor(
    scope: SettingsScope<Record<string, unknown>>,
    api: SettingsPageApi,
  ) {
    this.scope = scope
    this.api = api
    this.disposers.push(scope.subscribe(() => {
      this.recomputeCredentialRef()
      void this.describeAll()
      this.publish()
    }))
    this.recomputeCredentialRef()
    void this.describeAll()
    this.refreshCatalog()
  }

  /** Release every subscription held on external sources. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    this.listeners.clear()
  }

  /**
   * The credential reference the section names, or the provider default. A
   * user who renamed `apiKeyEnv` in the profile Config gets a page that
   * addresses the renamed ref instead of silently writing the default —
   * mirroring the Models page's `refFor()`.
   */
  private recomputeCredentialRef(): void {
    const snapshot = this.scope.getSnapshot()
    const named = typeof snapshot.value?.apiKeyEnv === 'string' && snapshot.value.apiKeyEnv.length > 0
      ? snapshot.value.apiKeyEnv
      : DEFAULT_API_KEY_REF
    if (named === this.credentialRef) return
    this.credentialStates.delete(this.credentialRef)
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
    const credential = this.credentialStates.get(this.credentialRef)
    const accounts = this.effectiveAccounts()
    const active = this.sectionValue('activeAccount')
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      apiKeyConfigured: credential?.configured ?? false,
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
      filterModelsByPlan: this.field('filterModelsByPlan'),
      webSearch: this.field('webSearch'),
      showSidebarQuota: this.field('showSidebarQuota'),
      commandGuard: this.field('commandGuard'),
      commandGuardLevel: this.field('commandGuardLevel'),
      zdr: this.field('zdr'),
      sidebarQuota: this.sectionValue('showSidebarQuota') === true,
      activeAccount: typeof active === 'string' ? active : '',
      accounts,
      accountModels: Object.fromEntries(accountModelMap(this.storedRules())),
      accountBusy: this.accountPending > 0,
      accountFailed: this.accountFailed,
      visibleModels: this.effectiveVisibleModels(),
      catalogModels: this.catalogModels,
      catalogFailed: this.catalogFailed,
      dirty: plan.length > 0 || this.visibleModelsDirty(),
      invalid: plan.some((item) => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
      savedCount: this.savedCount,
    }
  }

  // -----------------------------------------------------------------------
  // Staged form
  // -----------------------------------------------------------------------

  /** Stage one field's draft text. */
  edit(field: string, text: string): void {
    if (field !== 'apiKey') this.spec(field)
    this.staged.set(field, { text, clear: false })
    this.failed = false
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
    this.publish()
  }

  /** Discard every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && this.visibleModelsDraft === undefined && !this.failed) return
    this.staged.clear()
    this.visibleModelsDraft = undefined
    this.failed = false
    this.publish()
  }

  /**
   * Re-read the Host's credential facts without any staged edit. The browser
   * login stores a key Host-side behind the page's back; the plugin entry
   * calls this when a login lands so the configured/writable badges follow.
   */
  refreshCredentials(): void {
    void this.describeAll()
  }

  /** Write every staged edit, then re-read the Host's accepted state. */
  async save(): Promise<void> {
    const plan = this.plan()
    const visibleRuns = this.visibleModelsPlan()
    if ((plan.length === 0 && visibleRuns.length === 0) || this.saving) return
    const runs: Array<() => Promise<boolean>> = []
    for (const item of plan) {
      if (item.run === undefined) return
      runs.push(item.run)
    }
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    // Stop at the first failure: later writes would persist a partial state
    // the staged drafts no longer describe. A throwing write counts as a
    // failure too (the scope seam may reject).
    for (const run of [...runs, ...visibleRuns]) {
      let ok = false
      try {
        ok = await run()
      } catch {
        ok = false
      }
      if (!ok) {
        landed = false
        break
      }
    }
    this.saving = false
    this.failed = !landed
    if (landed) {
      this.savedCount += 1
      this.staged.clear()
      this.visibleModelsDraft = undefined
    } else {
      this.reconcileStaging()
    }
    this.publish()
  }

  /** Stage the visible-model allowlist (multi-select). */
  editVisibleModels(models: string[]): void {
    this.visibleModelsDraft = [...models]
    this.failed = false
    this.publish()
  }

  /** Stage "show all models" (clears the allowlist). */
  clearVisibleModels(): void {
    this.visibleModelsDraft = []
    this.failed = false
    this.publish()
  }

  // -----------------------------------------------------------------------
  // Immediate account management
  // -----------------------------------------------------------------------

  /**
   * Create one extra account now and return its credential reference, or
   * undefined when the account could not be stored. With `key` the key lands
   * first, so a stored row never names a reference whose key write failed;
   * without it the row is stored keyless so browser sign-in can target it.
   */
  async createAccount(input: { label: string; key?: string }): Promise<string | undefined> {
    let created: string | undefined
    await this.runAccountOp('create', async () => {
      const ref = this.nextAccountRef()
      const key = input.key?.trim() ?? ''
      if (key !== '' && !(await this.writeKeyTo(ref, key))) return false
      const label = input.label.trim() === '' ? ref : input.label.trim()
      let ok = false
      try {
        ok = await this.writeAccountList([...this.rawStoredAccounts(), { label, apiKeyEnv: ref }])
      } catch {
        ok = false
      }
      if (!ok) {
        if (key !== '') await this.unsetKey(ref)
        return false
      }
      created = ref
      return true
    })
    return created
  }

  /** Rename one stored extra account now. */
  renameAccount(ref: string, label: string): Promise<boolean> {
    const next = label.trim()
    return this.runAccountOp('rename', async () => {
      if (next === '') return false
      const list = this.rawStoredAccounts().map((entry) => entry.apiKeyEnv === ref ? { ...entry, label: next } : { ...entry })
      return this.writeAccountList(list)
    })
  }

  /**
   * Remove one stored extra account now: its stored key, its dedicated
   * models and a pin naming it go with it, so nothing orphaned remains.
   */
  removeAccount(ref: string): Promise<boolean> {
    return this.runAccountOp('remove', async () => {
      if (this.credentialStates.get(ref)?.configured === true && !(await this.unsetKey(ref))) return false
      const list = this.rawStoredAccounts().filter((entry) => entry.apiKeyEnv !== ref).map((entry) => ({ ...entry }))
      if (!(await this.writeAccountList(list))) return false
      const map = accountModelMap(this.storedRules())
      if (map.has(ref)) {
        map.delete(ref)
        if (!(await this.writeRules(rulesFromMap(map)))) return false
      }
      if (this.sectionValue('activeAccount') === ref) return this.clear('activeAccount')
      return true
    })
  }

  /** Store a replacement key now; `target` is `'default'` or an extra account's reference. */
  setAccountKey(target: string, key: string): Promise<boolean> {
    const value = key.trim()
    return this.runAccountOp('key', async () => {
      if (value === '') return false
      return this.writeKeyTo(this.refFor(target), value)
    })
  }

  /** Remove a stored key now; `target` is `'default'` or an extra account's reference. */
  clearAccountKey(target: string): Promise<boolean> {
    return this.runAccountOp('key', () => this.unsetKey(this.refFor(target)))
  }

  /** Pin the serving account now (`''` returns to automatic rotation). */
  setActiveAccount(id: string): Promise<boolean> {
    return this.runAccountOp('active', () => id === ''
      ? this.clear('activeAccount')
      : this.store('activeAccount', id))
  }

  /**
   * Replace one account's dedicated models now. A model belongs to one
   * account at a time, so each selected model is moved out of any other
   * account's list — the stored rules then carry no shadowed entries.
   */
  setAccountModels(target: string, models: readonly string[]): Promise<boolean> {
    return this.runAccountOp('models', async () => {
      const chosen = [...new Set(models.filter((id) => id !== ''))]
      const taken = new Set(chosen)
      const map = accountModelMap(this.storedRules())
      for (const [account, list] of map) {
        if (account !== target) map.set(account, list.filter((id) => !taken.has(id)))
      }
      map.set(target, chosen)
      return this.writeRules(rulesFromMap(map))
    })
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Run one account operation after every earlier one, tracking busy/failure. */
  private runAccountOp(op: AccountOperation, run: () => Promise<boolean>): Promise<boolean> {
    this.accountPending += 1
    this.accountFailed = undefined
    this.publish()
    const result = this.accountQueue.then(async () => {
      if (!this.scope.getSnapshot().writable) return false
      try {
        return await run()
      } catch {
        return false
      }
    })
    this.accountQueue = result
    return result.then((ok) => {
      this.accountPending -= 1
      if (!ok) this.accountFailed = op
      this.publish()
      return ok
    })
  }

  private refFor(target: string): string {
    return target === 'default' ? this.credentialRef : target
  }

  /**
   * The first free `<credentialRef>_<n>` reference. Derived from the default
   * reference's name, so a renamed `apiKeyEnv` yields `MY_KEY_2`-style refs
   * consistent with the default slot.
   */
  private nextAccountRef(): string {
    const used = new Set([this.credentialRef, ...this.storedExtras().map((extra) => extra.ref)])
    let n = 2
    while (used.has(`${this.credentialRef}_${n}`)) n += 1
    return `${this.credentialRef}_${n}`
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

  /**
   * The writes a save would perform, in staged order. A field whose draft is
   * not a value its spec accepts carries no write (the save refuses).
   */
  private plan(): Array<{ field: string; run: (() => Promise<boolean>) | undefined }> {
    const plan: Array<{ field: string; run: (() => Promise<boolean>) | undefined }> = []
    for (const [field, staged] of this.staged) {
      if (field === 'apiKey') {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => this.writeKeyTo(this.credentialRef, value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const parsed = spec.parse(staged.text)
      if (parsed.kind === 'invalid') plan.push({ field, run: undefined })
      else if (parsed.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, parsed.value) })
    }
    return plan
  }

  /** Drop staged drafts a partially landed save already stored. */
  private reconcileStaging(): void {
    for (const [field, staged] of [...this.staged]) {
      if (field === 'apiKey' || staged.clear) continue
      if (staged.text === this.spec(field).format(this.sectionValue(field))) this.staged.delete(field)
    }
    if (this.visibleModelsDraft !== undefined && sameModels(this.visibleModelsDraft, this.storedVisibleModels())) {
      this.visibleModelsDraft = undefined
    }
  }

  private async clear(field: string): Promise<boolean> {
    if (!this.stored(field)) return true
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: string | number | boolean): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  /** Write one account's key, then re-read the Host's credential states. */
  private async writeKeyTo(ref: string, value: string): Promise<boolean> {
    try {
      const response = await this.api.credentials.set(ref, value)
      if (!response.ok) return false
    } catch {
      return false
    }
    await this.describeAll([ref])
    return this.credentialStates.get(ref)?.configured ?? false
  }

  /** Unset one stored credential, then re-read the Host's credential states. */
  private async unsetKey(ref: string): Promise<boolean> {
    try {
      const response = await this.api.credentials.unset(ref)
      if (!response.ok) return false
    } catch {
      return false
    }
    await this.describeAll([ref])
    return this.credentialStates.get(ref)?.configured !== true
  }

  /**
   * Ask the credentials domain about every reference this page writes, plus
   * `extra` — a key written for an account whose row is not stored yet.
   */
  private async describeAll(extra: readonly string[] = []): Promise<void> {
    const refs = [...new Set([this.credentialRef, ...this.storedExtras().map((account) => account.ref), ...extra])]
    let response: Awaited<ReturnType<SettingsPageApi['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe(refs)
    } catch {
      return
    }
    if (!response.ok) return
    let changed = false
    for (const ref of refs) {
      const view = response.value?.[ref]
      const next = {
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      }
      const prev = this.credentialStates.get(ref)
      if (prev === undefined || prev.configured !== next.configured || prev.writable !== next.writable) {
        this.credentialStates.set(ref, next)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  /**
   * Fetch the model catalog for the settings page's model editors through
   * the Host Remote. Runs once at construction; call again (e.g. from the
   * client entry once the Remote mount lands) to (re)try — a later success
   * clears a prior failure flag so the editors recover without a page reload.
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

  // -----------------------------------------------------------------------
  // Stored accounts and rules
  // -----------------------------------------------------------------------

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
      configured: this.credentialStates.get(extra.ref)?.configured ?? false,
      writable: this.credentialStates.get(extra.ref)?.writable ?? true,
    }))
  }

  /** Persist a full accounts list and verify the Host stored it. */
  private async writeAccountList(list: Array<Record<string, unknown>>): Promise<boolean> {
    await this.scope.set('accounts', list)
    const after = this.rawStoredAccounts()
    return after.length === list.length
      && list.every((item, index) => after[index]?.apiKeyEnv === item.apiKeyEnv && after[index]?.label === item.label)
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

  /** Persist routing rules and verify the Host stored them. */
  private async writeRules(list: StoredRule[]): Promise<boolean> {
    await this.scope.set('modelAccountRules', list)
    const after = this.storedRules()
    return after.length === list.length
      && list.every((item, index) =>
        after[index] !== undefined
        && sameModels(after[index].models, item.models)
        && after[index].account === item.account)
  }

  /** The stored visible-model allowlist (`visibleModels`); empty = show all. */
  private storedVisibleModels(): string[] {
    const raw = this.scope.getSnapshot().value?.visibleModels
    if (!Array.isArray(raw)) return []
    return raw.filter((m): m is string => typeof m === 'string' && m !== '')
  }

  private effectiveVisibleModels(): string[] {
    return this.visibleModelsDraft ?? this.storedVisibleModels()
  }

  private visibleModelsDirty(): boolean {
    return this.visibleModelsDraft !== undefined
      && !sameModels(this.visibleModelsDraft, this.storedVisibleModels())
  }

  private visibleModelsPlan(): Array<() => Promise<boolean>> {
    if (!this.visibleModelsDirty()) return []
    return [async () => {
      const list = this.visibleModelsDraft ?? []
      await this.scope.set('visibleModels', list)
      return sameModels(this.storedVisibleModels(), list)
    }]
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}
