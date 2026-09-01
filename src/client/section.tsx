/**
 * React component for the "Command Code" settings page (browser half).
 *
 * Renders as a `settings.section` entry — a page at the same settings-nav
 * level as General / Models / Plugins. The shell supplies the nav row and
 * renders this body inside the content column. All copy comes from the
 * `settings.commandcode` locale namespace; all state comes from the
 * `CommandCodeSettingsController` injected by the slot registration.
 *
 * The layout mirrors the harness's settings pages: a max-width content
 * column, labelled fields with hints, a reset affordance, and a
 * save/discard footer. Rarely touched connection facts (API base, working
 * directory, timeouts, plan filter) fold into a collapsed Advanced card
 * (`AdvancedSection`) so the page leads with the key and the usage facts.
 * Styles are injected once by the client entry
 * (see src/client/index.ts) and class-prefixed `cc-` to stay local.
 */

import { useEffect, useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeCredits } from '../adapter.ts'
import type { CommandCodeAccountUsage, CommandCodeUsageReport } from '../usage-wire.ts'
import type { SettingsCommandCodeKey } from './locales.ts'
import type { AccountItemState, CatalogModelOption, RuleItemState, SettingsPageState, StagedField } from './settings.ts'
import type { CommandCodeLoginFailureReason } from '../login-wire.ts'
import type { LoginPageState } from './login.ts'
import type { UsagePageState } from './usage.ts'
import { formatMoney, formatMoneyExact, formatResetAt, formatTokensCompact, windowRatio } from './usage.ts'
import { PLUGIN_RELEASES_URL, PLUGIN_VERSION } from './version.ts'
import { checkForUpdate, localStorageUpdateStore } from './update.ts'

/** Props composed by the slot registration: locale seat + injected face. */
export interface CommandCodeSettingsProps {
  t: Translate<SettingsCommandCodeKey>
  useCommandCodeSettings<T>(selector: (state: SettingsPageState) => T): T
  useCommandCodeUsage<T>(selector: (state: UsagePageState) => T): T
  useCommandCodeLogin<T>(selector: (state: LoginPageState) => T): T
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  refreshUsage(): void
  beginLogin(): void
  cancelLogin(): void
  addAccount(): void
  removeAccount(id: string): void
  editAccountLabel(id: string, text: string): void
  editAccountKey(id: string, text: string): void
  toggleKeyClear(id: string): void
  addRule(): void
  removeRule(id: string): void
  editRuleModels(id: string, ids: string[]): void
  editRuleAccount(id: string, text: string): void
}

/** The section fields folded into the collapsible Advanced card. */
type AdvancedField = 'apiBase' | 'workingDir' | 'requestTimeoutMs' | 'streamIdleTimeoutMs' | 'filterModelsByPlan' | 'webSearch'
const ADVANCED_FIELDS: readonly AdvancedField[] = [
  'apiBase',
  'workingDir',
  'requestTimeoutMs',
  'streamIdleTimeoutMs',
  'filterModelsByPlan',
  'webSearch',
]

/** One labelled field row in the page body. */
function Field({
  id,
  label,
  hint,
  state,
  disabled,
  numeric,
  placeholder,
  onEdit,
  onReset,
  t,
}: {
  id: string
  label: string
  hint: string
  state: StagedField
  disabled: boolean
  numeric?: boolean
  placeholder?: string | undefined
  onEdit(text: string): void
  onReset(): void
  t: Translate<SettingsCommandCodeKey>
}) {
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor={id}>{label}</label>
        <span className="cc-badges">
          {state.overridden ? <span className="cc-badge">{t('overridden')}</span> : null}
          <button type="button" className="cc-reset" disabled={disabled} onClick={onReset}>{t('reset')}</button>
        </span>
      </div>
      <input
        id={id}
        className={state.invalid ? 'cc-input cc-inputInvalid' : 'cc-input'}
        type="text"
        inputMode={numeric ? 'numeric' : undefined}
        value={state.text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onEdit(event.target.value)}
      />
      <p className={state.invalid ? 'cc-invalid' : 'cc-hint'}>
        {state.invalid ? invalidCopy(state.invalidReason, t) : hint}
      </p>
    </div>
  )
}

/** The per-field error copy for a staged draft's failure reason. */
function invalidCopy(reason: StagedField['invalidReason'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'tooSmall') return t('numberTooSmall')
  if (reason === 'tooLarge') return t('numberTooLarge')
  return t('invalidNumber')
}

/**
 * The collapsed "Advanced" card: API base, working dir, both timeouts, and
 * the plan filter live here so the page leads with the facts a user actually
 * touches. Starts collapsed on every visit; expands on demand. While
 * collapsed, a badge names the customized count so a nonzero override stays
 * visible (a number field's error blocks save and must be reachable).
 */
function AdvancedSection({
  state,
  disabled,
  t,
  onEdit,
  onReset,
}: {
  state: SettingsPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onEdit(field: string, text: string): void
  onReset(field: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const overridden = ADVANCED_FIELDS.filter((field) => state[field].overridden).length
  const invalid = ADVANCED_FIELDS.some((field) => state[field].invalid)
  return (
    <div className="cc-card">
      <button
        type="button"
        className="cc-advancedHead"
        aria-expanded={expanded}
        aria-controls="cc-advanced-body"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="cc-advancedTitle">{t('advancedSettings')}</span>
        {overridden > 0 ? (
          <span className="cc-badge">
            {overridden === 1 ? t('advancedOverriddenOne') : t('advancedOverriddenMany').replace('{count}', String(overridden))}
          </span>
        ) : null}
        <span className="cc-advancedSpacer" />
        <span className={expanded ? 'cc-chevron cc-chevronUp' : 'cc-chevron'} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id="cc-advanced-body" className="cc-advancedBody">
          <p className="cc-hint">{t('advancedSettingsHint')}</p>
          <Field
            id="cc-api-base"
            label={t('apiBase')}
            hint={t('apiBaseHint')}
            state={state.apiBase}
            disabled={disabled}
            onEdit={(text) => onEdit('apiBase', text)}
            onReset={() => onReset('apiBase')}
            t={t}
          />
          <Field
            id="cc-working-dir"
            label={t('workingDir')}
            hint={t('workingDirHint')}
            state={state.workingDir}
            disabled={disabled}
            placeholder={state.defaultWorkingDir}
            onEdit={(text) => onEdit('workingDir', text)}
            onReset={() => onReset('workingDir')}
            t={t}
          />
          <Field
            id="cc-request-timeout"
            label={t('requestTimeoutMs')}
            hint={t('requestTimeoutMsHint')}
            state={state.requestTimeoutMs}
            disabled={disabled}
            numeric
            onEdit={(text) => onEdit('requestTimeoutMs', text)}
            onReset={() => onReset('requestTimeoutMs')}
            t={t}
          />
          <Field
            id="cc-stream-idle-timeout"
            label={t('streamIdleTimeoutMs')}
            hint={t('streamIdleTimeoutMsHint')}
            state={state.streamIdleTimeoutMs}
            disabled={disabled}
            numeric
            onEdit={(text) => onEdit('streamIdleTimeoutMs', text)}
            onReset={() => onReset('streamIdleTimeoutMs')}
            t={t}
          />
          <ToggleField
            id="cc-filter-models-by-plan"
            label={t('filterModelsByPlan')}
            hint={t('filterModelsByPlanHint')}
            state={state.filterModelsByPlan}
            disabled={disabled}
            defaultChecked
            onEdit={(text) => onEdit('filterModelsByPlan', text)}
            onReset={() => onReset('filterModelsByPlan')}
            t={t}
          />
          <ToggleField
            id="cc-web-search"
            label={t('webSearch')}
            hint={t('webSearchHint')}
            state={state.webSearch}
            disabled={disabled}
            defaultChecked
            onEdit={(text) => onEdit('webSearch', text)}
            onReset={() => onReset('webSearch')}
            t={t}
          />
        </div>
      ) : null}
      {expanded && invalid ? (
        <p className="cc-invalid" role="status">{t('advancedInvalid')}</p>
      ) : null}
    </div>
  )
}

/**
 * One boolean field row rendered as a toggle. The staged text is `'true'` /
 * `'false'` / `''` (unset → `defaultChecked`); toggling stages the string the
 * boolean field spec parses back into a real boolean on save.
 */
function ToggleField({
  id,
  label,
  hint,
  state,
  disabled,
  defaultChecked,
  onEdit,
  onReset,
  t,
}: {
  id: string
  label: string
  hint: string
  state: StagedField
  disabled: boolean
  defaultChecked: boolean
  onEdit(text: string): void
  onReset(): void
  t: Translate<SettingsCommandCodeKey>
}) {
  const checked = state.text === '' ? defaultChecked : state.text === 'true'
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor={id}>{label}</label>
        <span className="cc-badges">
          {state.overridden ? <span className="cc-badge">{t('overridden')}</span> : null}
          <button type="button" className="cc-reset" disabled={disabled} onClick={onReset}>{t('reset')}</button>
        </span>
      </div>
      <label className="cc-toggleRow">
        <input
          id={id}
          className="cc-toggle"
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onEdit(event.target.checked ? 'true' : 'false')}
        />
        <span className="cc-hint">{hint}</span>
      </label>
    </div>
  )
}

/**
 * The API-key control: write-only, reports configured state, never echoes the
 * key. The input is masked by default with a Show/Hide toggle so a pasted key
 * can be spot-checked without leaving the field, and a stored key can be
 * staged for removal (the next save unsets it) when it is bad or unwanted.
 */
function SecretKeyField({
  label,
  hint,
  state,
  disabled,
  configured,
  configuredLabel,
  unconfiguredLabel,
  clearStaged,
  showLabel,
  hideLabel,
  clearLabel,
  clearStagedLabel,
  undoClearLabel,
  onEdit,
  onToggleClear,
}: {
  label: string
  hint: string
  state: StagedField
  disabled: boolean
  configured: boolean
  configuredLabel: string
  unconfiguredLabel: string
  clearStaged: boolean
  showLabel: string
  hideLabel: string
  clearLabel: string
  clearStagedLabel: string
  undoClearLabel: string
  onEdit(text: string): void
  onToggleClear(): void
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor="cc-api-key">{label}</label>
        <span className="cc-badges">
          <span className={configured ? 'cc-badge' : 'cc-badgeMuted'}>
            {configured ? configuredLabel : unconfiguredLabel}
          </span>
          {clearStaged ? <span className="cc-badge cc-badgeWarn">{clearStagedLabel}</span> : null}
          {configured ? (
            <button type="button" className="cc-reset" disabled={disabled} onClick={onToggleClear}>
              {clearStaged ? undoClearLabel : clearLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="cc-reset"
            disabled={disabled}
            onClick={() => setVisible((value) => !value)}
          >
            {visible ? hideLabel : showLabel}
          </button>
        </span>
      </div>
      <input
        id="cc-api-key"
        className="cc-input"
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={state.text}
        disabled={disabled}
        onChange={(event) => onEdit(event.target.value)}
      />
      <p className="cc-hint">{hint}</p>
    </div>
  )
}

/** The per-reason copy for a failed login attempt. */
function loginFailureCopy(reason: CommandCodeLoginFailureReason | undefined, t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'denied') return t('loginDenied')
  if (reason === 'timeout') return t('loginTimeout')
  if (reason === 'invalid-key') return t('loginInvalidKey')
  if (reason === 'network') return t('loginNetwork')
  if (reason === 'unavailable') return t('loginStoreFailed')
  if (reason === 'cancelled') return t('loginCancelled')
  return t('loginFailedGeneric')
}

/**
 * The sign-in alternative to pasting a key: one field row that starts the
 * Host-side browser login, links to the Studio authorization page while the
 * attempt is live, and reports the outcome. The key itself never crosses to
 * the browser — only "who signed in" does.
 */
function LoginPanel({ state, disabled, t, onBegin, onCancel }: {
  state: LoginPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onBegin(): void
  onCancel(): void
}) {
  const busy = state.phase === 'starting' || state.phase === 'waiting'
  let hint = t('loginHintIdle')
  let hintTitle: string | undefined
  let hintClass = 'cc-hint'
  if (state.phase === 'starting' || state.phase === 'waiting') hint = t(state.phase === 'starting' ? 'loginStarting' : 'loginWaiting')
  else if (state.phase === 'success') {
    const keyName = state.keyName !== undefined && state.keyName !== '' ? ` · ${state.keyName}` : ''
    hint = `${t('loginSuccess')} ${state.userName ?? ''}${keyName}`.trim()
    hintClass = 'cc-loginDone'
  } else if (state.phase === 'failed') {
    hint = loginFailureCopy(state.reason, t)
    hintClass = 'cc-loginError'
    if (state.message !== undefined) hintTitle = state.message
  } else if (state.phase === 'unavailable') {
    hint = `${t('loginUnavailable')} ${state.message ?? ''}`.trim()
    hintClass = 'cc-loginError'
  }
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label">{t('loginTitle')}</label>
        <span className="cc-badges">
          {busy ? (
            <button type="button" className="cc-reset" onClick={onCancel}>{t('loginCancel')}</button>
          ) : (
            <button type="button" className="cc-reset" disabled={disabled} onClick={onBegin}>{t('loginButton')}</button>
          )}
        </span>
      </div>
      {state.authUrl !== undefined ? (
        <p className="cc-hint">
          <a className="cc-loginLink" href={state.authUrl} target="_blank" rel="noreferrer">{t('loginOpenLink')}</a>
        </p>
      ) : null}
      <p className={hintClass} title={hintTitle}>{hint}</p>
    </div>
  )
}

/** One stat tile in the account card's summary grid. */
function UsageStat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="cc-usageStat">
      <span className="cc-usageStatLabel">{label}</span>
      <span className="cc-usageStatValue">{value}</span>
      {sub !== undefined && sub !== '' ? <span className="cc-usageStatSub">{sub}</span> : null}
    </div>
  )
}

/** One window-limit row: label, used/cap, a fill bar, and the reset time. */
function UsageWindow({
  label,
  limit: { used, cap, exceeded, resetAt },
  t,
}: {
  label: string
  limit: CommandCodeCredits['fiveHour']
  t: Translate<SettingsCommandCodeKey>
}) {
  const ratio = windowRatio(used, cap)
  const reset = formatResetAt(resetAt)
  return (
    <div className="cc-usageWindow">
      <div className="cc-usageWindowHead">
        <span className="cc-usageWindowLabel">{label}</span>
        {exceeded ? <span className="cc-usageExceeded">{t('usageExceeded')}</span> : null}
        <span className="cc-usageWindowValue">{cap > 0 ? `${formatMoney(used)} / ${formatMoney(cap)}` : formatMoney(used)}</span>
      </div>
      <div className="cc-usageBar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <div className={exceeded ? 'cc-usageBarFill cc-usageBarFillWarn' : 'cc-usageBarFill'} style={{ width: `${ratio * 100}%` }} />
      </div>
      {reset !== '' ? <p className="cc-usageWindowReset">{t('usageReset')} {reset}</p> : null}
    </div>
  )
}

/** One account's rotation state as a short badge next to its label. */
function AccountMark({ entry, t }: { entry: CommandCodeAccountUsage; t: Translate<SettingsCommandCodeKey> }) {
  if (entry.active) return <span className="cc-usagePlan">{t('usageActive')}</span>
  if (entry.mark === 'invalid-credential') return <span className="cc-usagePlanStatus">{t('usageInvalidKey')}</span>
  if (entry.cooldownUntil > 0) {
    return <span className="cc-usagePlanStatus">{t('usageCooldown')} {formatResetAt(entry.cooldownUntil)}</span>
  }
  if (entry.mark === 'rate-limit') return <span className="cc-usagePlanStatus">{t('usageCooldown')}</span>
  return null
}

/**
 * One pool account's facts (identity, totals, credits, window limits)
 * rendered inside the account-usage card.
 */
function AccountReport({ entry, fetchedAt, t, onRemove }: {
  entry: CommandCodeAccountUsage
  /**
   * When the shared usage snapshot was fetched — shares the account's bottom
   * meta row with the billing period end so the two timestamps occupy one
   * line (period/partial facts left, fetch freshness right).
   */
  fetchedAt?: number | undefined
  t: Translate<SettingsCommandCodeKey>
  /** Present only for removable (non-default) accounts on a writable page. */
  onRemove?: (() => void) | undefined
}) {
  const report = entry.report
  const account = report.account
  const accountName = account === undefined ? '' : account.userName || account.name
  const credits = report.credits
  const plan = report.plan
  const planName = plan?.name ?? ''
  const planStatus = plan !== undefined && plan.status !== '' && plan.status !== 'active' ? plan.status : ''
  const showPeriod = plan !== undefined && plan.currentPeriodEnd > 0
  const showPartial = report.failures.length > 0 && report.blocked === undefined

  return (
    <div className="cc-accountReport">
      <div className="cc-usageHead">
        <h4 className="cc-usageTitle">{entry.label}</h4>
        <AccountMark entry={entry} t={t} />
        {accountName !== '' ? <span className="cc-usageAccount">{accountName}</span> : null}
        {planName !== '' ? <span className="cc-usagePlan">{planName}</span> : null}
        {planStatus !== '' ? <span className="cc-usagePlanStatus">{planStatus}</span> : null}
        <span className="cc-usageMetaSpacer" />
        {onRemove !== undefined ? (
          <button type="button" className="cc-usageRefresh" onClick={onRemove}>{t('accountRemove')}</button>
        ) : null}
      </div>

      {!entry.configured ? <p className="cc-usageHint">{t('usageUnconfigured')}</p> : null}

      {report.blocked !== undefined ? (
        <div className="cc-usageBlocked" role="alert">
          <p className="cc-usageBlockedTitle">{blockedTitle(report.blocked, t)}</p>
          <p className="cc-usageBlockedHint">{blockedHint(report.blocked, t)}</p>
        </div>
      ) : null}

      {report.usage !== undefined ? (
        <div className="cc-usageStats">
          <UsageStat
            label={t('usageRequests')}
            value={String(report.usage.completedCount)}
            sub={`${t('usageFailed')} ${report.usage.failedCount}`}
          />
          <UsageStat label={t('usageSuccessRate')} value={`${report.usage.successRate}%`} />
          <UsageStat
            label={t('usageCost')}
            value={formatMoneyExact(report.usage.totalCost)}
            sub={`${formatMoney(report.usage.totalCredits)} credits`}
          />
          <UsageStat
            label={t('usageTokens')}
            value={formatTokensCompact(report.usage.totalTokensIn + report.usage.totalTokensOut)}
            sub={`${formatTokensCompact(report.usage.totalTokensIn)} ${t('usageTokensIn')} / ${formatTokensCompact(report.usage.totalTokensOut)} ${t('usageTokensOut')}`}
          />
        </div>
      ) : null}

      {credits !== undefined ? (
        <div className="cc-usageStats">
          <UsageStat label={t('usageMonthly')} value={formatMoney(credits.monthlyCredits)} />
          <UsageStat label={t('usagePurchased')} value={formatMoney(credits.purchasedCredits)} />
          <UsageStat label={t('usageFree')} value={formatMoney(credits.freeCredits)} />
        </div>
      ) : null}

      {credits !== undefined ? (
        <div className="cc-usageWindows">
          <UsageWindow label={t('usageFiveHour')} limit={credits.fiveHour} t={t} />
          <UsageWindow label={t('usageWeekly')} limit={credits.weekly} t={t} />
        </div>
      ) : null}

      {showPeriod || showPartial || fetchedAt !== undefined ? (
        <div className="cc-usageMeta">
          {showPeriod ? (
            <p className="cc-usageUpdated">{t('usagePeriodEnd')} {new Date(plan.currentPeriodEnd).toLocaleDateString()}</p>
          ) : null}
          {showPartial ? (
            <p className="cc-usagePartial" title={report.failures.join('; ')}>{t('usagePartial')}</p>
          ) : null}
          <span className="cc-usageMetaSpacer" />
          {fetchedAt !== undefined ? (
            <p className="cc-usageUpdated">{t('usageUpdated')} {new Date(fetchedAt).toLocaleTimeString()}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The headline copy for a report whose every endpoint failed the same way. */
function blockedTitle(reason: CommandCodeUsageReport['blocked'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'invalid-key') return t('usageKeyInvalid')
  if (reason === 'service-unavailable') return t('usageServiceUnavailable')
  return t('usageNetworkError')
}

/** The actionable hint under a blocked report's headline. */
function blockedHint(reason: CommandCodeUsageReport['blocked'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'invalid-key') return t('usageKeyInvalidHint')
  if (reason === 'service-unavailable') return t('usageServiceUnavailableHint')
  return t('usageNetworkHint')
}

/** The status dot on an account tab: cooling/invalid warn, everything else ok. */
function AccountTabDot({ entry }: { entry: CommandCodeAccountUsage }) {
  const cls = entry.mark === 'invalid-credential'
    ? 'cc-tabDot cc-tabDotError'
    : entry.mark !== '' || entry.cooldownUntil > 0
      ? 'cc-tabDot cc-tabDotWarn'
      : 'cc-tabDot cc-tabDotOk'
  return <span className={cls} />
}

/**
 * The account-usage card: the `/commandcode` dashboard's facts rendered as
 * a native settings card. With several accounts the card is a carousel — a
 * tab strip (label + status dot) switches between accounts so the page stays
 * short; each account's report carries its own remove affordance (the
 * default account is not removable). Accounts staged for removal in the
 * management card are hidden here immediately. Data arrives through the
 * `commandcode/report` Remote; the API keys never leave the Host.
 */
function UsageCard({ t, usage, apiKeyConfigured, removingIds, removableIds, canManage, onRefresh, onRemoveAccount }: {
  t: Translate<SettingsCommandCodeKey>
  usage: UsagePageState
  apiKeyConfigured: boolean
  /** Ids of accounts staged for removal (hidden from the carousel). */
  removingIds: string[]
  /**
   * Ids of accounts the settings document can actually remove (the stored
   * extra accounts' refs). Composition-only accounts (literal-key slots with
   * positional `account-N` ids) are NOT removable from the page — the
   * settings document cannot name them — so they get no remove button.
   */
  removableIds: string[]
  /** Whether the page accepts writes (the remove affordance follows it). */
  canManage: boolean
  onRefresh(): void
  onRemoveAccount(id: string): void
}) {
  // First paint with a configured key fetches automatically; later fetches
  // are explicit (refresh button) or follow a landed save.
  useEffect(() => {
    if (apiKeyConfigured && usage.status === 'idle') onRefresh()
  }, [apiKeyConfigured, usage.status, onRefresh])

  const loading = usage.status === 'loading'
  const report = usage.report
  // Locally remembered removals: the usage controller keeps the old report
  // until the post-save refresh lands, and removedRefs clears at save-land —
  // without this the just-removed account would pop back in for one refresh
  // round-trip. Cleared when a fresh report arrives (fetchedAt changes).
  const [locallyRemoved, setLocallyRemoved] = useState<readonly string[]>([])
  useEffect(() => {
    setLocallyRemoved([])
  }, [usage.fetchedAt])
  const hidden = new Set([...removingIds, ...locallyRemoved])
  const seenIds = new Set<string>()
  const entries = (report?.accounts ?? []).filter((entry) => {
    if (hidden.has(entry.id)) return false
    // Hand-edited settings can name the same credential ref twice; dedupe so
    // the tab strip never carries duplicate keys/selections.
    if (seenIds.has(entry.id)) return false
    seenIds.add(entry.id)
    return true
  })
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  // The selected tab: the explicit choice while it still exists, else the
  // serving (active) account, else the first entry.
  const selected = entries.find((entry) => entry.id === selectedId)
    ?? entries.find((entry) => entry.active)
    ?? entries[0]
  const removeSelected = canManage && selected !== undefined && removableIds.includes(selected.id)
    ? () => {
        const id = selected.id
        setLocallyRemoved((prev) => [...prev, id])
        onRemoveAccount(id)
      }
    : undefined

  return (
    <div className="cc-usageCard" aria-label={t('usageTitle')}>
      <div className="cc-usageHead">
        <h3 className="cc-usageTitle">{t('usageTitle')}</h3>
        <span className="cc-usageMetaSpacer" />
        <button type="button" className="cc-usageRefresh" disabled={loading || !apiKeyConfigured} onClick={onRefresh}>
          {loading ? t('usageRefreshing') : t('usageRefresh')}
        </button>
      </div>

      {!apiKeyConfigured ? <p className="cc-usageHint">{t('usageNoKey')}</p> : null}
      {apiKeyConfigured && report === undefined && loading ? <p className="cc-usageHint">{t('usageLoading')}</p> : null}
      {usage.status === 'error' ? (
        <p className="cc-usageError" role="status">
          <span>{t('usageError')}{usage.error !== undefined && usage.error !== '' ? ` — ${usage.error}` : ''}</span>
        </p>
      ) : null}

      {entries.length > 1 ? (
        <div className="cc-tabs" role="tablist" aria-label={t('accountsTitle')}>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={selected?.id === entry.id}
              className={selected?.id === entry.id ? 'cc-tab cc-tabActive' : 'cc-tab'}
              onClick={() => setSelectedId(entry.id)}
            >
              <AccountTabDot entry={entry} />
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      {selected !== undefined ? (
        <AccountReport
          key={selected.id}
          entry={selected}
          fetchedAt={usage.fetchedAt}
          t={t}
          onRemove={removeSelected}
        />
      ) : null}
    </div>
  )
}

/**
 * One extra account row: label, key, configured badge. Saved accounts are
 * removed from the usage card above; a NOT-YET-SAVED addition never appears
 * there (the usage report is Host-side), so it keeps its own remove button —
 * otherwise the only way to undo a mistaken Add would be discarding every
 * other staged edit.
 */
function AccountRow({ account, disabled, t, onLabel, onKey, onToggleClear, onRemove }: {
  account: AccountItemState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onLabel(text: string): void
  onKey(text: string): void
  onToggleClear(): void
  onRemove(): void
}) {
  const locked = !account.writable
  const [keyVisible, setKeyVisible] = useState(false)
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor={`cc-account-label-${account.id}`}>{t('accountLabel')}</label>
        <span className="cc-badges">
          {account.added ? <span className="cc-badge">{t('unsaved')}</span> : null}
          <span className={account.configured ? 'cc-badge' : 'cc-badgeMuted'}>
            {account.configured ? t('apiKeySet') : t('apiKeyUnset')}
          </span>
          {account.clearStaged ? <span className="cc-badge cc-badgeWarn">{t('usageKeyClearStaged')}</span> : null}
          {account.configured && !account.clearStaged ? (
            <button type="button" className="cc-reset" disabled={disabled} onClick={onToggleClear}>
              {t('usageKeyClear')}
            </button>
          ) : null}
          {account.clearStaged ? (
            <button type="button" className="cc-reset" disabled={disabled} onClick={onToggleClear}>
              {t('usageUndoKeyClear')}
            </button>
          ) : null}
          <button
            type="button"
            className="cc-reset"
            disabled={disabled}
            onClick={() => setKeyVisible((value) => !value)}
          >
            {keyVisible ? t('hide') : t('show')}
          </button>
          {account.added ? (
            <button type="button" className="cc-reset" disabled={disabled} onClick={onRemove}>{t('accountRemove')}</button>
          ) : null}
        </span>
      </div>
      <input
        id={`cc-account-label-${account.id}`}
        className="cc-input"
        type="text"
        value={account.label}
        disabled={disabled}
        onChange={(event) => onLabel(event.target.value)}
      />
      <input
        id={`cc-account-key-${account.id}`}
        className="cc-input"
        type={keyVisible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('accountKey')}
        value={account.keyText}
        disabled={disabled || locked}
        onChange={(event) => onKey(event.target.value)}
      />
      <p className="cc-hint">{locked ? t('apiKeyLocked') : t('accountKeyHint')}</p>
    </div>
  )
}

/** The multi-account card: the active-account selector + extra accounts in rotation order + add button. */
function AccountsCard({ t, state, disabled, onAdd, onRemove, onLabel, onKey, onToggleClear, onActive, onActiveReset }: {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  disabled: boolean
  onAdd(): void
  onRemove(id: string): void
  onLabel(id: string, text: string): void
  onKey(id: string, text: string): void
  onToggleClear(id: string): void
  onActive(text: string): void
  onActiveReset(): void
}) {
  const active = state.activeAccount
  return (
    <div className="cc-card" aria-label={t('accountsTitle')}>
      <div className="cc-field">
        <div className="cc-fieldHead">
          <label className="cc-label">{t('accountsTitle')}</label>
          <span className="cc-badges">
            <button type="button" className="cc-reset" disabled={disabled} onClick={onAdd}>{t('accountAdd')}</button>
          </span>
        </div>
        <p className="cc-hint">{t('accountsHint')}</p>
      </div>
      <div className="cc-field">
        <div className="cc-fieldHead">
          <label className="cc-label" htmlFor="cc-active-account">{t('activeAccount')}</label>
          <span className="cc-badges">
            {active.overridden ? <span className="cc-badge">{t('overridden')}</span> : null}
            <button type="button" className="cc-reset" disabled={disabled} onClick={onActiveReset}>{t('reset')}</button>
          </span>
        </div>
        <select
          id="cc-active-account"
          className="cc-input"
          value={active.text}
          disabled={disabled}
          onChange={(event) => onActive(event.target.value)}
        >
          <option value="">{t('activeAccountAuto')}</option>
          <option value="default">{t('accountDefault')}</option>
          {state.accounts.filter((account) => !account.added).map((account) => (
            <option key={account.id} value={account.ref}>{account.label}</option>
          ))}
        </select>
        <p className="cc-hint">{t('activeAccountHint')}</p>
      </div>
      {state.accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          disabled={disabled}
          t={t}
          onLabel={(text) => onLabel(account.id, text)}
          onKey={(text) => onKey(account.id, text)}
          onToggleClear={() => onToggleClear(account.id)}
          onRemove={() => onRemove(account.id)}
        />
      ))}
    </div>
  )
}

/** One model → account routing rule row. */
function RuleRow({ rule, accounts, catalog, disabled, t, onModels, onAccount, onRemove }: {
  rule: RuleItemState
  accounts: AccountItemState[]
  catalog: CatalogModelOption[]
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onModels(ids: string[]): void
  onAccount(text: string): void
  onRemove(): void
}) {
  const targets = [
    { value: 'default', label: t('accountDefault') },
    ...accounts.filter((account) => !account.added).map((account) => ({ value: account.ref, label: account.label })),
  ]
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor={`cc-rule-model-${rule.id}`}>{t('ruleModel')}</label>
        <span className="cc-badges">
          {rule.added ? <span className="cc-badge">{t('unsaved')}</span> : null}
          <button type="button" className="cc-reset" disabled={disabled} onClick={onRemove}>{t('ruleRemove')}</button>
        </span>
      </div>
      <ModelMultiSelect
        id={`cc-rule-model-${rule.id}`}
        selected={rule.models}
        catalog={catalog}
        disabled={disabled}
        t={t}
        onSelect={onModels}
      />
      <select
        id={`cc-rule-account-${rule.id}`}
        className="cc-input"
        value={rule.account}
        disabled={disabled}
        onChange={(event) => onAccount(event.target.value)}
      >
        {targets.map((target) => (
          <option key={target.value} value={target.value}>{target.label}</option>
        ))}
      </select>
      <p className="cc-hint">{t('ruleHint')}</p>
    </div>
  )
}

/**
 * A checkbox multi-select dropdown for routing-rule models. The trigger shows
 * the selection count; the anchored Menu lists every catalog model with a
 * checkbox, toggled by clicking the row. Selected ids the catalog no longer
 * carries still render so a saved rule never silently loses a selection.
 */
function ModelMultiSelect({ id, selected, catalog, disabled, t, onSelect }: {
  id: string
  selected: string[]
  catalog: CatalogModelOption[]
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onSelect(ids: string[]): void
}) {
  const [open, setOpen] = useState(false)
  // The catalog is sorted for picking; append any selected ids the catalog no
  // longer carries (removed upstream) so the current rule stays visible.
  const options = [
    ...catalog.map((model) => ({ value: model.id, label: model.name })),
    ...selected
      .filter((id) => !catalog.some((model) => model.id === id))
      .map((id) => ({ value: id, label: id })),
  ]
  const selectedSet = new Set(selected)
  const items: MenuEntry[] = options.map((option) => ({
    id: option.value,
    label: (
      <span className="cc-checkRow">
        <input
          type="checkbox"
          className="cc-check"
          checked={selectedSet.has(option.value)}
          readOnly
          tabIndex={-1}
        />
        <span className="cc-checkName">{option.label}</span>
      </span>
    ),
  }))
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={(modelId) => {
        // Toggle one model in the selection.
        onSelect(selectedSet.has(modelId)
          ? selected.filter((value) => value !== modelId)
          : [...selected, modelId])
      }}
      selectedIds={selected}
      items={items}
      portal
      anchor={
        <button
          id={id}
          type="button"
          className="cc-input cc-ruleTrigger"
          disabled={disabled || catalog.length === 0}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="cc-ruleTriggerText">
            {selected.length === 0 ? t('ruleModelPick') : t('ruleModelCount', { count: selected.length })}
          </span>
          <span className="cc-ruleCaret" aria-hidden="true" />
        </button>
      }
    />
  )
}

/** The model → account routing card: rules in list order (first match wins). */
function RulesCard({ t, state, disabled, onAdd, onRemove, onModels, onAccount }: {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  disabled: boolean
  onAdd(): void
  onRemove(id: string): void
  onModels(id: string, ids: string[]): void
  onAccount(id: string, text: string): void
}) {
  return (
    <div className="cc-card" aria-label={t('rulesTitle')}>
      <div className="cc-field">
        <div className="cc-fieldHead">
          <label className="cc-label">{t('rulesTitle')}</label>
          <span className="cc-badges">
            <button type="button" className="cc-reset" disabled={disabled} onClick={onAdd}>{t('ruleAdd')}</button>
          </span>
        </div>
        <p className="cc-hint">{t('rulesHint')}</p>
        {state.catalogFailed ? <p className="cc-invalid">{t('rulesCatalogFailed')}</p> : null}
      </div>
      {state.rules.map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          accounts={state.accounts}
          catalog={state.catalogModels}
          disabled={disabled}
          t={t}
          onModels={(ids) => onModels(rule.id, ids)}
          onAccount={(text) => onAccount(rule.id, text)}
          onRemove={() => onRemove(rule.id)}
        />
      ))}
      {state.rules.length === 0 ? <p className="cc-hint">{t('rulesEmpty')}</p> : null}
    </div>
  )
}

/**
 * Show the "Saved ✓" affordance for a short window after each accepted save.
 * The controller only counts saves (`savedCount`); the flash timing lives
 * here so the state machine stays timer-free.
 */
function useSavedFlash(tick: number): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (tick === 0) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 2500)
    return () => clearTimeout(timer)
  }, [tick])
  return visible
}

/**
 * The update hint: one throttled npm-registry check per page open (the
 * throttle and all failure handling live in ./update.ts). Resolves to the
 * newest published version when it is newer than this build, else undefined —
 * every failure mode degrades to no hint at all.
 */
function usePluginUpdate(): string | undefined {
  const [available, setAvailable] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void checkForUpdate({
      currentVersion: PLUGIN_VERSION,
      now: Date.now(),
      store: localStorageUpdateStore(),
    }).then((version) => {
      if (!cancelled) setAvailable(version)
      // A rejected checkForUpdate would be a bug (it catches internally);
      // swallow it regardless — the footer must never break the page.
    }, () => {})
    return () => {
      cancelled = true
    }
  }, [])
  return available
}

/** The settings page body: connection facts for the Command Code provider. */
export function CommandCodeSettingsPage(props: CommandCodeSettingsProps) {
  const { t } = props
  const state = props.useCommandCodeSettings((snapshot) => snapshot)
  const usage = props.useCommandCodeUsage((snapshot) => snapshot)
  const login = props.useCommandCodeLogin((snapshot) => snapshot)
  const disabled = !state.writable
  const keyLocked = !state.apiKeyWritable
  const savedVisible = useSavedFlash(state.savedCount)
  const updateVersion = usePluginUpdate()
  return (
    <section className="cc-section" aria-label={t('title')}>
      <h2 className="cc-title">{t('title')}</h2>
      <p className="cc-intro">{t('intro')}</p>
      {!state.writable ? <p className="cc-readOnly" role="status">{t('readOnly')}</p> : null}
      <UsageCard
        t={t}
        usage={usage}
        apiKeyConfigured={state.anyAccountConfigured}
        removingIds={state.accountsRemoving}
        removableIds={state.accounts.map((account) => account.id)}
        canManage={state.writable}
        onRefresh={props.refreshUsage}
        onRemoveAccount={props.removeAccount}
      />
      <AccountsCard
        t={t}
        state={state}
        disabled={disabled}
        onAdd={props.addAccount}
        onRemove={props.removeAccount}
        onLabel={props.editAccountLabel}
        onKey={props.editAccountKey}
        onToggleClear={(id) => props.toggleKeyClear(id)}
        onActive={(text) => props.edit('activeAccount', text)}
        onActiveReset={() => props.resetField('activeAccount')}
      />
      <RulesCard
        t={t}
        state={state}
        disabled={disabled}
        onAdd={props.addRule}
        onRemove={props.removeRule}
        onModels={props.editRuleModels}
        onAccount={props.editRuleAccount}
      />
      <div className="cc-card">
        <SecretKeyField
          label={t('apiKey')}
          hint={keyLocked ? t('apiKeyLocked') : t('apiKeyHint')}
          state={state.apiKey}
          disabled={disabled || keyLocked}
          configured={state.apiKeyConfigured}
          configuredLabel={t('apiKeySet')}
          unconfiguredLabel={t('apiKeyUnset')}
          clearStaged={state.apiKeyClearStaged}
          showLabel={t('show')}
          hideLabel={t('hide')}
          clearLabel={t('usageKeyClear')}
          clearStagedLabel={t('usageKeyClearStaged')}
          undoClearLabel={t('usageUndoKeyClear')}
          onEdit={(text) => props.edit('apiKey', text)}
          onToggleClear={() => props.toggleKeyClear('default')}
        />
        <LoginPanel
          state={login}
          disabled={disabled || keyLocked}
          t={t}
          onBegin={props.beginLogin}
          onCancel={props.cancelLogin}
        />
      </div>
      <AdvancedSection
        state={state}
        disabled={disabled}
        t={t}
        onEdit={props.edit}
        onReset={props.resetField}
      />
      <div className="cc-footer">
        {state.failed ? <p className="cc-failed" role="status">{t('saveFailed')}</p> : null}
        {savedVisible ? <p className="cc-saved" role="status">{t('saved')}</p> : null}
        <Button variant="ghost" size="sm" disabled={!state.dirty || state.saving} onClick={props.discard}>
          {t('discard')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!state.dirty || state.invalid || state.saving}
          onClick={props.save}
        >
          {t(state.saving ? 'saving' : 'save')}
        </Button>
      </div>
      <p className="cc-version">
        Command Code Provider v{PLUGIN_VERSION}
        {updateVersion !== undefined ? (
          <>
            {' · '}
            <a
              className="cc-versionLink"
              href={PLUGIN_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              title={t('updateHint')}
            >
              v{updateVersion} {t('updateAvailable')}
            </a>
          </>
        ) : null}
      </p>
    </section>
  )
}
