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
 *   - Working dir, request/stream timeouts -> the same namespace.
 *
 * The controller mirrors the plugin-card pattern from the harness's own
 * settings UI: it binds the `llm-commandcode` namespace through the
 * `settingsScope` service, keeps a staged draft of edits, and writes them on
 * save through `scope.set` / the credentials domain. The Host stays the
 * single fact source; the snapshot is republished after each accepted write.
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
}

/** The Host-description observable the page reads the process cwd from. */
export interface HostDescriptionSource {
  getSnapshot(): { cwd?: string } | undefined
  subscribe(fn: () => void): () => void
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

/** One extra account row's staged state (the default account uses `apiKey`). */
export interface AccountItemState {
  /** Stable id — the account's credential reference. */
  id: string
  /** Credential reference this account's key lives under. */
  ref: string
  /** Label draft text (the stored/generated label until edited). */
  label: string
  /** The API key draft (write-only; starts blank, never echoes the stored key). */
  keyText: string
  /** Whether a key is stored for this account (Host-reported). */
  configured: boolean
  /** Whether the credentials domain can store the key. */
  writable: boolean
  /** Staged for addition (not yet saved). */
  added: boolean
  /** Staged for key removal on the next save (the stored key is bad/unwanted). */
  clearStaged: boolean
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
  /** The API key draft (write-only; starts blank, never echoes the stored key). */
  apiKey: StagedField
  /** Whether the default account's stored key is staged for removal on the next save. */
  apiKeyClearStaged: boolean
  /** apiBase draft. */
  apiBase: StagedField
  /** workingDir draft. */
  workingDir: StagedField
  /**
   * The working directory a blank `workingDir` resolves to: the Host
   * process cwd (`host.describe().cwd`). Shown as the field's placeholder so
   * the user sees what "leave it empty" means — no configuration needed.
   */
  defaultWorkingDir: string | undefined
  /** requestTimeoutMs draft. */
  requestTimeoutMs: StagedField
  /** streamIdleTimeoutMs draft. */
  streamIdleTimeoutMs: StagedField
  /**
   * filterModelsByPlan draft, staged as `'true'`/`'false'`/`''` (unset). The
   * component renders it as a toggle; `''` means "inherit the default" (on).
   */
  filterModelsByPlan: StagedField
  /**
   * The manually selected active account, staged as a slot id (`default`
   * or an extra account's credential reference); `''` means "auto — first
   * usable account". The component renders it as a select.
   */
  activeAccount: StagedField
  /** Extra accounts (multi-account rotation), in rotation order. */
  accounts: AccountItemState[]
  /** Refs of stored accounts staged for removal (the usage card hides them). */
  accountsRemoving: string[]
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
   * to flash the "Saved ✓" affordance (timing lives in the component; the
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

/** The fields this page edits inside the `llm-commandcode` namespace. */
const SECTION_FIELDS: FieldSpec[] = [
  textField('apiBase'),
  textField('workingDir'),
  numberField('requestTimeoutMs', { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }),
  numberField('streamIdleTimeoutMs', { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }),
  booleanField('filterModelsByPlan'),
  textField('activeAccount'),
]

/**
 * Controller bridging the `llm-commandcode` scope and the credentials domain
 * onto the page. Public API mirrors the harness's CardForm actions, so the
 * component stays thin.
 */
export class CommandCodeSettingsController {
  private readonly scope: SettingsScope<Record<string, unknown>>
  private readonly api: SettingsPageApi
  private readonly specs = new Map(SECTION_FIELDS.map((spec) => [spec.field, spec]))
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly disposers: Array<() => void> = []
  private disposed = false
  private defaultWorkingDir: string | undefined
  /** The credential reference the default account resolves. */
  private credentialRef = DEFAULT_API_KEY_REF
  /** Host-reported configured/writable state per credential reference. */
  private readonly credentialStates = new Map<string, { configured: boolean; writable: boolean }>()
  /** Staged account additions (not yet saved). */
  private addedAccounts: Array<{ label: string; ref: string }> = []
  /** Staged removals of stored extra accounts, by credential reference. */
  private readonly removedRefs = new Set<string>()
  /** Staged label drafts, by credential reference. */
  private readonly labelDrafts = new Map<string, string>()
  /** Staged key drafts, by credential reference (blank = keep stored key). */
  private readonly keyDrafts = new Map<string, string>()
  /** Credential references staged for removal on the next save. */
  private readonly keyClears = new Set<string>()
  private saving = false
  private failed = false
  private savedCount = 0

  /**
   * @param scope - bound scope for the `llm-commandcode` namespace.
   * @param api - credentials wire face.
   * @param hostDescription - the Host-description observable whose `cwd` is
   *   shown as the placeholder a blank `workingDir` field resolves to.
   */
  constructor(
    scope: SettingsScope<Record<string, unknown>>,
    api: SettingsPageApi,
    hostDescription?: HostDescriptionSource,
  ) {
    this.scope = scope
    this.api = api
    this.disposers.push(scope.subscribe(() => {
      this.recomputeCredentialRef()
      void this.describeAll()
      this.publish()
    }))
    if (hostDescription !== undefined) {
      this.defaultWorkingDir = hostDescription.getSnapshot()?.cwd
      this.disposers.push(hostDescription.subscribe(() => {
        if (this.disposed) return
        const cwd = hostDescription.getSnapshot()?.cwd
        if (cwd !== this.defaultWorkingDir) {
          this.defaultWorkingDir = cwd
          this.publish()
        }
      }))
    }
    this.recomputeCredentialRef()
    void this.describeAll()
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
   * user who renamed `apiKeyEnv` in `settings.yaml` (or the composition
   * config) gets a page that addresses the renamed ref instead of silently
   * writing the default — mirroring the Models page's `refFor()`.
   */
  private recomputeCredentialRef(): void {
    const snapshot = this.scope.getSnapshot()
    const named = typeof snapshot.value?.apiKeyEnv === 'string' && snapshot.value.apiKeyEnv.length > 0
      ? snapshot.value.apiKeyEnv
      : DEFAULT_API_KEY_REF
    if (named === this.credentialRef) return
    this.credentialRef = named
    this.credentialStates.delete(named)
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
      apiKeyClearStaged: this.keyClears.has(this.credentialRef),
      apiBase: this.field('apiBase'),
      workingDir: this.field('workingDir'),
      defaultWorkingDir: this.defaultWorkingDir,
      requestTimeoutMs: this.field('requestTimeoutMs'),
      streamIdleTimeoutMs: this.field('streamIdleTimeoutMs'),
      filterModelsByPlan: this.field('filterModelsByPlan'),
      activeAccount: this.field('activeAccount'),
      accounts,
      accountsRemoving: [...this.removedRefs],
      dirty: plan.length > 0 || this.accountsDirty(),
      invalid: plan.some((item) => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
      savedCount: this.savedCount,
    }
  }

  /** Stage a new extra account (saved on the next `save()`). */
  addAccount(): void {
    const used = new Set([
      this.credentialRef,
      ...this.storedExtras().map((extra) => extra.ref),
      ...this.addedAccounts.map((extra) => extra.ref),
    ])
    let n = 2
    while (used.has(`COMMANDCODE_API_KEY_${n}`)) n += 1
    const index = this.storedExtras().length + this.addedAccounts.length + 2
    this.addedAccounts.push({ label: `Account ${index}`, ref: `COMMANDCODE_API_KEY_${n}` })
    this.failed = false
    void this.describeAll()
    this.publish()
  }

  /** Stage one extra account's removal (or drop an unsaved addition). */
  removeAccount(id: string): void {
    const addedIndex = this.addedAccounts.findIndex((extra) => extra.ref === id)
    if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1)
    else this.removedRefs.add(id)
    this.labelDrafts.delete(id)
    this.keyDrafts.delete(id)
    // A pinned active account that is going away must not linger as a ghost
    // selection: stage its clear alongside the removal (the host would fall
    // back to rotation order, but the stored value would be meaningless).
    const stagedActive = this.staged.get('activeAccount')
    const activeValue = stagedActive !== undefined
      ? stagedActive.clear ? '' : stagedActive.text
      : typeof this.sectionValue('activeAccount') === 'string' ? this.sectionValue('activeAccount') as string : ''
    if (activeValue === id) {
      this.staged.set('activeAccount', { text: '', clear: true })
    }
    this.failed = false
    this.publish()
  }

  /** Stage one extra account's label draft. */
  editAccountLabel(id: string, text: string): void {
    this.labelDrafts.set(id, text)
    this.failed = false
    this.publish()
  }

  /** Stage one extra account's key draft (blank keeps the stored key). */
  editAccountKey(id: string, text: string): void {
    this.keyDrafts.set(id, text)
    // Typing a replacement cancels a staged removal — the two intents are
    // mutually exclusive (replace vs remove), and a staged clear would
    // otherwise silently discard what is being typed.
    this.keyClears.delete(id)
    this.failed = false
    this.publish()
  }

  /**
   * Toggle the staged removal of one account's stored key: the next save
   * unsets the credential so the account reports unconfigured and falls back
   * to its other key sources. Only meaningful while a key is actually
   * stored. `target` is `'default'` (the implicit first account) or an extra
   * account's credential reference.
   */
  toggleKeyClear(target: string): void {
    const ref = target === 'default' ? this.credentialRef : target
    if (this.keyClears.has(ref)) {
      this.keyClears.delete(ref)
    } else {
      if (this.credentialStates.get(ref)?.configured !== true) return
      // A staged replacement and a staged removal are mutually exclusive.
      this.keyDrafts.delete(ref)
      if (ref === this.credentialRef) this.staged.delete('apiKey')
      this.keyClears.add(ref)
    }
    this.failed = false
    void this.describeAll()
    this.publish()
  }

  /** Stage one field's draft text. */
  edit(field: string, text: string): void {
    this.staged.set(field, { text, clear: false })
    // Typing a replacement for the default key cancels a staged removal.
    if (field === 'apiKey') this.keyClears.delete(this.credentialRef)
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
    if (this.staged.size === 0 && !this.accountsStaged() && !this.failed) return
    this.staged.clear()
    this.clearAccountStaging()
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
    const accountRuns = this.accountPlan()
    if ((plan.length === 0 && accountRuns.length === 0) || this.saving) return
    const runs: Array<() => Promise<boolean>> = []
    for (const item of plan) {
      if (item.run === undefined) return
      runs.push(item.run)
    }
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    // Keys land first so a saved accounts list never names a ref whose key
    // write failed silently; the accounts list itself writes last. Stop at
    // the first failure: running later writes after a failed one would
    // persist a partial state the staged drafts no longer describe.
    for (const run of [...runs, ...accountRuns]) {
      if (!(await run())) {
        landed = false
        break
      }
    }
    this.saving = false
    this.failed = !landed
    if (landed) {
      this.savedCount += 1
      this.staged.clear()
      this.clearAccountStaging()
    } else {
      // A failed save may still have landed earlier writes (e.g. the accounts
      // list made it while a key write did not). Reconcile the staging with
      // the stored section so a landed account is not simultaneously stored
      // AND staged-for-addition (which a retry would persist twice).
      this.reconcileAccountStaging()
    }
    this.publish()
  }

  /**
   * Drop account staging the stored section already reflects: additions whose
   * ref is now stored, removals whose ref is gone, and label drafts matching
   * the stored label. Key drafts are kept — a landed key write is idempotent
   * on retry, and the draft carries the user's intent when it was the
   * accounts write that failed.
   */
  private reconcileAccountStaging(): void {
    const stored = new Set(this.storedExtras().map((extra) => extra.ref))
    this.addedAccounts = this.addedAccounts.filter((extra) => !stored.has(extra.ref))
    for (const ref of [...this.removedRefs]) {
      if (!stored.has(ref)) this.removedRefs.delete(ref)
    }
    for (const [ref, text] of [...this.labelDrafts]) {
      const storedLabel = this.storedExtras().find((extra) => extra.ref === ref)?.label
      if (storedLabel === undefined || storedLabel === text.trim()) this.labelDrafts.delete(ref)
    }
    // A landed clear already did its job (the Host reports unconfigured);
    // keep only clears that failed so a retry re-attempts them.
    for (const ref of [...this.keyClears]) {
      if (this.credentialStates.get(ref)?.configured !== true) this.keyClears.delete(ref)
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
        if (value !== '') {
          plan.push({ field, run: () => this.writeKey(value) })
        }
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

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: string | number | boolean): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  /** Write the staged default key, then re-read whether the Host holds it. */
  private async writeKey(value: string): Promise<boolean> {
    return this.writeKeyTo(this.credentialRef, value)
  }

  /** Write one account's key, then re-read the Host's credential states. */
  private async writeKeyTo(ref: string, value: string): Promise<boolean> {
    try {
      const response = await this.api.credentials.set(ref, value)
      if (!response.ok) return false
    } catch {
      return false
    }
    await this.describeAll()
    return this.credentialStates.get(ref)?.configured ?? false
  }

  /** Ask the credentials domain about every reference this page writes. */
  private async describeAll(): Promise<void> {
    const refs = [
      this.credentialRef,
      ...this.storedExtras().map((extra) => extra.ref),
      ...this.addedAccounts.map((extra) => extra.ref),
    ]
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

  // -----------------------------------------------------------------------
  // Multi-account staging
  // -----------------------------------------------------------------------

  /** The stored extra accounts from the settings section (`accounts`). */
  private storedExtras(): Array<{ label: string; ref: string }> {
    const raw = this.scope.getSnapshot().value?.accounts
    if (!Array.isArray(raw)) return []
    const out: Array<{ label: string; ref: string }> = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const ref = record.apiKeyEnv
      if (typeof ref !== 'string' || ref === '') continue
      const label = record.label
      out.push({ label: typeof label === 'string' && label !== '' ? label : ref, ref })
    }
    return out
  }

  /** Every extra account row: stored (minus staged removals) + staged adds. */
  private effectiveAccounts(): AccountItemState[] {
    const stored = this.storedExtras()
      .filter((extra) => !this.removedRefs.has(extra.ref))
      .map((extra) => ({ ...extra, added: false }))
    const added = this.addedAccounts.map((extra) => ({ ...extra, added: true }))
    return [...stored, ...added].map((extra) => ({
      id: extra.ref,
      ref: extra.ref,
      label: this.labelDrafts.get(extra.ref) ?? extra.label,
      keyText: this.keyDrafts.get(extra.ref) ?? '',
      configured: this.credentialStates.get(extra.ref)?.configured ?? false,
      writable: this.credentialStates.get(extra.ref)?.writable ?? true,
      added: extra.added,
      clearStaged: this.keyClears.has(extra.ref),
    }))
  }

  /** Whether any account-level staging (add/remove/label/key/clear) exists. */
  private accountsStaged(): boolean {
    return this.addedAccounts.length > 0
      || this.removedRefs.size > 0
      || this.labelDrafts.size > 0
      || this.keyDrafts.size > 0
      || this.keyClears.size > 0
  }

  /** Whether the staged account edits differ from the stored section. */
  private accountsDirty(): boolean {
    if (this.addedAccounts.length > 0 || this.removedRefs.size > 0) return true
    for (const [ref, text] of this.labelDrafts) {
      const base = this.storedExtras().find((extra) => extra.ref === ref)?.label
      if (base !== undefined && text.trim() !== '' && text !== base) return true
    }
    for (const text of this.keyDrafts.values()) {
      if (text.trim() !== '') return true
    }
    // A staged clear is only meaningful while the key is actually stored —
    // staging one against an unconfigured ref is a no-op, not dirt.
    for (const ref of this.keyClears) {
      if (this.credentialStates.get(ref)?.configured === true) return true
    }
    return false
  }

  /** Reset every account-level staged edit. */
  private clearAccountStaging(): void {
    this.addedAccounts = []
    this.removedRefs.clear()
    this.labelDrafts.clear()
    this.keyDrafts.clear()
    this.keyClears.clear()
  }

  /** Unset one stored credential, then re-read the Host's credential states. */
  private async unsetKey(ref: string): Promise<boolean> {
    try {
      const response = await this.api.credentials.unset(ref)
      if (!response.ok) return false
    } catch {
      return false
    }
    await this.describeAll()
    return this.credentialStates.get(ref)?.configured !== true
  }

  /** The account-level writes a save performs (empty when nothing staged). */
  private accountPlan(): Array<() => Promise<boolean>> {
    if (!this.accountsDirty()) return []
    const runs: Array<() => Promise<boolean>> = []
    // Staged removals land first: a cleared credential must be gone before
    // the accounts list write, or a removed row would leave an orphaned
    // secret behind. Removed rows keep their clear (clean removal).
    for (const ref of this.keyClears) {
      if (this.credentialStates.get(ref)?.configured === true) {
        runs.push(() => this.unsetKey(ref))
      }
    }
    for (const [ref, text] of this.keyDrafts) {
      const value = text.trim()
      if (value !== '' && !this.removedRefs.has(ref) && !this.keyClears.has(ref)) {
        runs.push(() => this.writeKeyTo(ref, value))
      }
    }
    runs.push(() => this.writeAccounts())
    return runs
  }

  /** Persist the staged accounts list into the settings section. */
  private async writeAccounts(): Promise<boolean> {
    const base = [
      ...this.storedExtras().filter((extra) => !this.removedRefs.has(extra.ref)),
      ...this.addedAccounts,
    ]
    // Defensive dedupe by ref: a partially landed earlier save can leave an
    // account both stored and staged-for-addition; never persist duplicates.
    const seen = new Set<string>()
    const list = base.filter((extra) => !seen.has(extra.ref) && (seen.add(extra.ref), true)).map((extra) => {
      const draft = this.labelDrafts.get(extra.ref)?.trim()
      return { label: draft !== undefined && draft !== '' ? draft : extra.label, apiKeyEnv: extra.ref }
    })
    await this.scope.set('accounts', list)
    const after = this.storedExtras()
    return after.length === list.length
      && list.every((item, index) => after[index]?.ref === item.apiKeyEnv)
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}
