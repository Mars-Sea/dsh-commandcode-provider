/**
 * React component for the "Command Code" settings page (browser half).
 *
 * Variant A (native DSH alignment): renders as a `settings.section` entry with
 * the same typography, flat `0.5px` group dividers, `20px` entity cards and
 * `16px` inline module panels as DSH's own `ModelsSection` and
 * `PluginInventorySettingsTab`. Standard UI atoms — `Button`, `Switch`, `Tag`,
 * `StateDot`, `SegmentedControl`, `SettingsValueField`, `Input`, `Menu`,
 * `Modal`, and the `Icon*Outline*` glyph set — come directly from the seeded
 * `@deepseek-ai/dsh-client-ui-primitives` package rather than local copies.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconChevronDownOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGaugeOutlineRegular,
  IconInfoOutlineRegular,
  IconPlusOutlineMedium,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconSearchOutlineRegular,
  IconShieldOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Input,
  Menu,
  Modal,
  SegmentedControl,
  SettingsValueField,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeCredits } from '../adapter.ts'
import type { CommandCodeAccountUsage, CommandCodeUsageReport } from '../usage-wire.ts'
import { settingsWriteNotice, type SettingsCommandCodeKey } from './locales.ts'
import type { CatalogModelOption, SettingsPageState, StagedField } from './settings.ts'
import type { AccountEnrollmentController, EnrollmentPageState } from './enrollment.ts'
import type { LoginPageState } from './login.ts'
import { loginHint, loginStateForTarget } from './login.ts'
import {
  allowlistedModels,
  buildModelSelectOptions,
  catalogIsReady,
  groupModelSelectOptions,
  staleModelIds,
  tierHeadingFor,
  toggleModelSelection,
} from './model-select.ts'
import type { UsagePageState } from './usage.ts'
import { USAGE_AUTO_RETRY_LIMIT, USAGE_AUTO_RETRY_MS, usageCardState } from './usage.ts'
import {
  compactCountTitle,
  formatCompactCount,
  formatMoney,
  formatMoneyExact,
  formatResetAtShort,
  formatSuccessRate,
  formatTokensCompact,
  formatUsageBillingPeriod,
  windowRatio,
} from '../display-format.ts'
import { PLUGIN_RELEASES_URL, PLUGIN_VERSION } from './version.ts'
import { checkForUpdate, localStorageUpdateStore } from './update.ts'
import {
  STATUS_PAGE_URL,
  checkServiceStatus,
  localStorageServiceStatusStore,
  readCachedServiceStatus,
  runServiceProbeWithRetry,
  serviceStatusView,
} from './service-status.ts'
import type { ServiceProbe, ServiceStatusSnapshot, ServiceStatusView, ServiceTone } from './service-status.ts'
import type { CommandCodeProbeResult } from '../service-probe-wire.ts'
import { expandGroups, localStorageFoldStore, type FoldGroup, type FoldState } from './group-fold.ts'

type NoticeTone = 'neutral' | 'success' | 'warn' | 'error'
type NoticeIconKind = 'info' | 'check' | 'warn' | 'error' | 'lock'
const NOTICE_DEFAULT_ICON: Record<NoticeTone, NoticeIconKind> = {
  neutral: 'info',
  success: 'check',
  warn: 'warn',
  error: 'error',
}
const NOTICE_CLASS: Record<NoticeTone, string> = {
  neutral: 'cc-notice',
  success: 'cc-notice cc-noticeSuccess',
  warn: 'cc-notice cc-noticeWarn',
  error: 'cc-notice cc-noticeError',
}

function NoticeGlyph({ kind }: { kind: NoticeIconKind }) {
  if (kind === 'check') return <IconCheckCircleOutlineRegular size={16} />
  if (kind === 'warn') return <IconWarningTriangleOutlineRegular size={16} />
  if (kind === 'error') return <IconWarningOutlineRegular size={16} />
  if (kind === 'lock') return <IconShieldOutlineRegular size={16} />
  return <IconInfoOutlineRegular size={16} />
}

/**
 * Quiet module-platform callout for inline status, warnings and recovery actions,
 * using DSH product icons instead of custom SVG paths.
 */
function Notice({ tone = 'neutral', icon, title, actions, role = 'status', label, children }: {
  tone?: NoticeTone
  icon?: NoticeIconKind
  title?: string
  actions?: ReactNode
  role?: 'status' | 'alert'
  label?: string
  children?: ReactNode
}) {
  return (
    <div className={NOTICE_CLASS[tone]} role={role} aria-label={label}>
      <span className="cc-noticeIcon" aria-hidden="true">
        <NoticeGlyph kind={icon ?? NOTICE_DEFAULT_ICON[tone]} />
      </span>
      <div className="cc-noticeBody">
        {title !== undefined ? <p className="cc-noticeTitle">{title}</p> : null}
        {children}
        {actions !== undefined ? <div className="cc-noticeActions">{actions}</div> : null}
      </div>
    </div>
  )
}

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
  refreshUsageAuto(): void
  openAnalytics?(): void
  refreshCredentials(): void
  beginLogin(targetRef?: string): void
  cancelLogin(): void
  createEnrollment(): AccountEnrollmentController
  probeService(): Promise<
    | { ok: true; value: CommandCodeProbeResult }
    | { ok: false; error: { message: string } }
  >
  renameAccount(ref: string, label: string): Promise<boolean>
  removeAccount(ref: string): Promise<boolean>
  retryCredentialCleanup(ref: string): Promise<boolean>
  setAccountKey(target: string, key: string): Promise<boolean>
  clearAccountKey(target: string): Promise<boolean>
  setActiveAccount(id: string): Promise<boolean>
  setAccountModels(target: string, ids: string[]): Promise<boolean>
  editVisibleModels(ids: string[]): void
  clearVisibleModels(): void
  editContextWindowOverrides(next: Record<string, string>): void
  editModelNames(next: Record<string, string>): void
}

/** Host-side defaults shown as placeholders when a field is empty. */
export const FIELD_DEFAULTS = {
  apiBase: 'https://api.commandcode.ai',
  requestTimeoutSeconds: '300',
  streamIdleTimeoutSeconds: '300',
  transportMaxRetries: '5',
} as const

type AdvancedField = 'apiBase' | 'requestTimeoutMs' | 'streamIdleTimeoutMs' | 'transportMaxRetries' | 'offloadSeenImagesForCache'
const ADVANCED_FIELDS: readonly AdvancedField[] = [
  'apiBase',
  'requestTimeoutMs',
  'streamIdleTimeoutMs',
  'transportMaxRetries',
  'offloadSeenImagesForCache',
]

type ModelsField = 'filterModelsByPlan' | 'contextWindow' | 'maxOutputTokens'
const MODELS_FIELDS: readonly ModelsField[] = ['filterModelsByPlan', 'contextWindow', 'maxOutputTokens']

export function advancedGroupInvalid(state: Pick<SettingsPageState, AdvancedField>): boolean {
  return ADVANCED_FIELDS.some((field) => state[field].invalid)
}

export function modelsGroupInvalid(
  state: Pick<SettingsPageState, ModelsField | 'contextWindowOverrides'>,
): boolean {
  return MODELS_FIELDS.some((field) => state[field].invalid)
    || state.contextWindowOverrides.some((row) => row.invalid)
}

export function invalidGroups(state: Pick<SettingsPageState, AdvancedField | ModelsField | 'contextWindowOverrides'>): FoldGroup[] {
  const groups: FoldGroup[] = []
  if (modelsGroupInvalid(state)) groups.push('models')
  if (advancedGroupInvalid(state)) groups.push('advanced')
  return groups
}

export function modelsOverriddenCount(state: Pick<SettingsPageState, ModelsField | 'contextWindowOverrides' | 'modelNames'>): number {
  return MODELS_FIELDS.filter((field) => state[field].overridden).length
    + state.contextWindowOverrides.length + state.modelNames.length
}

export function advancedOverriddenCount(state: Pick<SettingsPageState, AdvancedField>): number {
  return ADVANCED_FIELDS.filter((field) => state[field].overridden).length
}

export function stagedSwitch(field: StagedField, defaultValue: boolean): boolean {
  return field.text === '' ? defaultValue : field.text === 'true'
}

export function accountIssues(entries: readonly (Pick<CommandCodeAccountUsage, 'mark' | 'cooldownUntil'> | undefined)[]): { count: number; severe: boolean } {
  let count = 0
  let severe = false
  for (const entry of entries) {
    if (entry === undefined) continue
    if (entry.mark === 'invalid-credential') {
      count += 1
      severe = true
    } else if (entry.mark !== '' || entry.cooldownUntil > 0) {
      count += 1
    }
  }
  return { count, severe }
}

/** One horizontal setting row (GeneralSection / WebSearchCard geometry). */
function SettingRow({ title, titleFor, titleId, tag, description, error, control, className }: {
  title: string
  titleFor?: string
  titleId?: string
  tag?: ReactNode
  description?: ReactNode
  error?: string | undefined
  control?: ReactNode
  className?: string | undefined
}) {
  return (
    <div className={className === undefined ? 'cc-row' : `cc-row ${className}`}>
      <div className="cc-rowText">
        <div className="cc-rowTitleLine">
          {titleFor !== undefined
            ? <label className="cc-rowTitle" id={titleId} htmlFor={titleFor}>{title}</label>
            : <span className="cc-rowTitle" id={titleId}>{title}</span>}
          {tag}
        </div>
        {error !== undefined ? <p className="cc-rowError">{error}</p> : null}
        {error === undefined && description !== undefined ? <div className="cc-rowDesc">{description}</div> : null}
      </div>
      {control !== undefined ? <div className="cc-rowControl">{control}</div> : null}
    </div>
  )
}

/**
 * Overridden marker for non-text rows (`ToggleField`), matching `SettingsValueField`'s
 * `Tag` + quiet `reset` button pair so every overridden row reads identically.
 */
function OverrideTag({ label, state, disabled, t, onReset }: {
  label: string
  state: StagedField
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onReset(): void
}) {
  if (!state.overridden && !state.clear) return null
  return (
    <span className="cc-overrideTag">
      {state.overridden ? <Tag tone="neutral">{t('overridden')}</Tag> : null}
      <button
        type="button"
        className="cc-resetLink"
        disabled={disabled}
        onClick={onReset}
        aria-label={`${label} — ${t('reset')}`}
      >
        {t('reset')}
      </button>
    </span>
  )
}

function invalidCopy(
  reason: StagedField['invalidReason'],
  t: Translate<SettingsCommandCodeKey>,
  mode: 'number' | 'duration' | 'context' | 'output' = 'number',
): string {
  if (mode === 'duration') {
    if (reason === 'tooSmall') return t('durationTooSmall')
    if (reason === 'tooLarge') return t('durationTooLarge')
    return t('durationInvalid')
  }
  if (mode === 'context') {
    if (reason === 'tooSmall') return t('contextWindowTooSmall')
    if (reason === 'tooLarge') return t('contextWindowTooLarge')
    return t('contextWindowInvalid')
  }
  if (mode === 'output') {
    if (reason === 'tooSmall') return t('maxOutputTokensTooSmall')
    if (reason === 'tooLarge') return t('maxOutputTokensTooLarge')
    return t('maxOutputTokensInvalid')
  }
  if (reason === 'tooSmall') return t('numberTooSmall')
  if (reason === 'tooLarge') return t('numberTooLarge')
  return t('invalidNumber')
}

/** Boolean setting row backed by the platform `Switch` primitive (issue #108). */
export function ToggleField({
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
  hint?: string
  state: StagedField
  disabled: boolean
  defaultChecked: boolean
  onEdit(text: string): void
  onReset(): void
  t: Translate<SettingsCommandCodeKey>
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = `${id}-help`
  const checked = state.text === '' ? defaultChecked : state.text === 'true'
  return (
    <SettingRow
      title={label}
      titleId={id}
      tag={
        <>
          {hint !== undefined && hint !== '' ? (
            <button
              type="button"
              className="cc-helpButton"
              aria-label={label}
              aria-expanded={helpOpen}
              aria-controls={helpId}
              onClick={() => setHelpOpen((open) => !open)}
            >
              <IconInfoOutlineRegular size={12} />
            </button>
          ) : null}
          {/* The marker and its reset describe the field, so they sit with the
              label; the control column then holds exactly one thing. */}
          <OverrideTag label={label} state={state} disabled={disabled} t={t} onReset={onReset} />
        </>
      }
      description={helpOpen && hint !== undefined && hint !== '' ? <p id={helpId}>{hint}</p> : undefined}
      control={
        <Switch
          className="cc-switch"
          checked={checked}
          label={label}
          disabled={disabled}
          onChange={(next) => onEdit(next ? 'true' : 'false')}
        />
      }
    />
  )
}

/** Borderless stat cell in the concentric quota surface's telemetry strip. */
function UsageStat({ label, value, sub, title }: { label: string; value: string; sub?: string | undefined; title?: string | undefined }) {
  return (
    <div className="cc-usageStat" title={title}>
      <span className="cc-usageStatLabel">{label}</span>
      <span className="cc-usageStatValue">{value}</span>
      {sub !== undefined && sub !== '' ? <span className="cc-usageStatSub">{sub}</span> : null}
    </div>
  )
}

/** GPU-composited `translateX` window-limit progress bar. */
function UsageWindow({
  label,
  limit,
  t,
}: {
  label: string
  limit: NonNullable<CommandCodeCredits['fiveHour']>
  t: Translate<SettingsCommandCodeKey>
}) {
  const { used, cap, exceeded, resetAt } = limit
  const ratio = windowRatio(used, cap)
  const reset = formatResetAtShort(resetAt)
  return (
    <div className="cc-usageWindow">
      <div className="cc-usageWindowHead">
        <span className="cc-usageWindowLabel">{label}</span>
        {exceeded ? <span className="cc-usageExceeded">{t('usageExceeded')}</span> : null}
        <span className="cc-usageWindowValue">{cap > 0 ? `${formatMoney(used)} / ${formatMoney(cap)}` : formatMoney(used)}</span>
      </div>
      <div className="cc-usageBar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <div className={exceeded ? 'cc-usageBarFill cc-usageBarFillWarn' : 'cc-usageBarFill'} style={{ transform: `translateX(${(ratio - 1) * 100}%)` }} />
      </div>
      {reset !== '' ? <p className="cc-usageWindowReset">{t('usageReset')} {reset}</p> : null}
    </div>
  )
}

export function balanceLabelText(
  report: Pick<CommandCodeUsageReport, 'credits' | 'plan' | 'usage'>,
  t: Translate<SettingsCommandCodeKey>,
): string {
  const plan = report.plan
  const usagePeriod = formatUsageBillingPeriod(report.usage?.periodStart, plan?.currentPeriodStart, plan?.currentPeriodEnd)
  const periodText = usagePeriod !== ''
    ? usagePeriod
    : plan !== undefined && plan.currentPeriodEnd > 0
      ? `${t('usagePeriodEnd')} ${new Date(plan.currentPeriodEnd).toLocaleDateString()}`
      : ''
  if (report.credits !== undefined) return periodText !== '' ? `${t('usageMonthlyLeft')} · ${periodText}` : t('usageMonthlyLeft')
  return usagePeriod !== '' ? `${t('usageBillingPeriod')} ${usagePeriod}` : periodText
}

/**
 * One pool account's expanded facts inside one concentric `R10` `.cc-usageSurface`
 * (balance + window meters + hairline telemetry strip — zero nested bordered boxes).
 */
function AccountReport({ entry, fetchedAt, t, headless = false }: {
  entry: CommandCodeAccountUsage
  fetchedAt?: number | undefined
  t: Translate<SettingsCommandCodeKey>
  headless?: boolean
}) {
  const report = entry.report
  const account = report.account
  const accountName = account === undefined ? '' : account.userName || account.name
  const credits = report.credits
  const plan = report.plan
  const planName = plan?.name ?? ''
  const planStatus = plan !== undefined && plan.status !== '' && plan.status !== 'active' ? plan.status : ''
  const showPartial = report.failures.length > 0 && report.blocked === undefined
  const label = balanceLabelText(report, t)
  const updatedText = fetchedAt === undefined
    ? ''
    : `${t('usageUpdated')} ${new Date(fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  const monthlyKnown = credits !== undefined && credits.monthlyReported !== false
  const depleted = credits !== undefined && monthlyKnown && credits.monthlyCredits <= 0
  const hasBalance = label !== '' || updatedText !== ''
  const hasWindows = credits?.fiveHour !== undefined || credits?.weekly !== undefined
  const hasStats = report.usage !== undefined

  return (
    <div className="cc-accountReport">
      {!headless ? (
        <div className="cc-usageHead">
          <h4 className="cc-usageTitle">{entry.label}</h4>
          {accountName !== '' ? <span className="cc-usageAccount">{accountName}</span> : null}
          {planName !== '' ? <Tag tone="neutral">{planName}</Tag> : null}
        </div>
      ) : null}
      {planStatus !== '' ? <p className="cc-usagePlanStatus">{planStatus}</p> : null}

      {!entry.configured ? <p className="cc-usageHint">{t('usageUnconfigured')}</p> : null}

      {report.blocked !== undefined ? (
        <Notice tone="error" role="alert" title={blockedTitle(report.blocked, t)}>
          <p>{blockedHint(report.blocked, t)}</p>
          {report.failures.length > 0 ? (
            <p className="cc-noticeDetail" title={report.failures.join('; ')}>
              {report.failures.join(' · ')}
            </p>
          ) : null}
        </Notice>
      ) : null}

      {hasBalance || hasWindows || hasStats ? (
        <div className="cc-usageSurface">
          {hasBalance ? (
            <div className={depleted ? 'cc-balance cc-balanceEmpty' : 'cc-balance'}>
              <div className="cc-balanceRow">
                <span className="cc-balanceLabel">{label}</span>
                {updatedText !== '' ? <span className="cc-balanceLabel">{updatedText}</span> : null}
              </div>
              {credits !== undefined ? (
                <div className="cc-balanceRow">
                  <span className="cc-balanceValue">{monthlyKnown ? formatMoney(Math.max(0, credits.monthlyCredits)) : '—'}</span>
                  <span className="cc-balanceSub">
                    {`${t('usagePurchased')} ${credits.purchasedReported === false ? '—' : formatMoney(credits.purchasedCredits)} · ${t('usageFree')} ${credits.freeReported === false ? '—' : formatMoney(credits.freeCredits)}`}
                  </span>
                </div>
              ) : null}
              {depleted ? <p className="cc-balanceNote" role="status">{t('usageMonthlyDepleted')}</p> : null}
            </div>
          ) : null}

          {hasWindows && credits !== undefined ? (
            <div className="cc-usageWindows">
              {credits.fiveHour !== undefined ? (
                <UsageWindow label={t('usageFiveHour')} limit={credits.fiveHour} t={t} />
              ) : null}
              {credits.weekly !== undefined ? (
                <UsageWindow label={t('usageWeekly')} limit={credits.weekly} t={t} />
              ) : null}
            </div>
          ) : null}

          {report.usage !== undefined ? (
            <div className="cc-usageStatsStrip">
              <UsageStat
                label={t('usageRequests')}
                value={formatCompactCount(report.usage.totalCount)}
                sub={`${t('usageFailed')} ${formatCompactCount(report.usage.failedCount)}`}
                title={compactCountTitle([
                  [t('usageRequests'), report.usage.totalCount],
                  [t('usageCompleted'), report.usage.completedCount],
                  [t('usageFailed'), report.usage.failedCount],
                ] as const)}
              />
              <UsageStat label={t('usageSuccessRate')} value={`${formatSuccessRate(report.usage.successRate)}%`} />
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
        </div>
      ) : null}

      {showPartial ? (
        <p className="cc-usagePartial" title={report.failures.join('; ')}>{t('usagePartial')}</p>
      ) : null}
    </div>
  )
}

function blockedTitle(reason: CommandCodeUsageReport['blocked'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'invalid-key') return t('usageKeyInvalid')
  if (reason === 'service-unavailable') return t('usageServiceUnavailable')
  if (reason === 'invalid-response') return t('usageInvalidResponse')
  return t('usageNetworkError')
}

function blockedHint(reason: CommandCodeUsageReport['blocked'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'invalid-key') return t('usageKeyInvalidHint')
  if (reason === 'service-unavailable') return t('usageServiceUnavailableHint')
  if (reason === 'invalid-response') return t('usageInvalidResponseHint')
  return t('usageNetworkHint')
}

/**
 * Checkbox multi-select dropdown over `Menu` + `Input` + `Tag` primitives.
 */
function ModelMultiSelect({ id, selected: committed, catalog, disabled, deferCommit = false, ownerOf, t, onSelect }: {
  id: string
  selected: string[]
  catalog: CatalogModelOption[]
  disabled: boolean
  deferCommit?: boolean
  ownerOf?: (modelId: string) => string | undefined
  t: Translate<SettingsCommandCodeKey>
  onSelect(ids: string[]): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string[] | undefined>(undefined)
  const selected = draft ?? committed
  useEffect(() => {
    if (open) setQuery('')
  }, [open])
  const close = () => {
    setOpen(false)
    if (draft !== undefined) {
      setDraft(undefined)
      const changed = draft.length !== committed.length || draft.some((modelId) => !committed.includes(modelId))
      if (changed) onSelect(draft)
    }
  }
  const tiers = useMemo(
    () => Object.fromEntries(
      catalog.flatMap((model) => model.tier === undefined ? [] : [[model.id, model.tier] as const]),
    ),
    [catalog],
  )
  const options = buildModelSelectOptions(catalog, selected, query)
  const groups = groupModelSelectOptions(options, (modelId) => tierHeadingFor(modelId, tiers))
  const items: MenuEntry[] = groups.flatMap((group) => [
    ...(group.heading === undefined
      ? []
      : [{ type: 'label' as const, id: `cc-tier-${group.heading}`, text: group.heading }]),
    ...group.options.map((option) => ({
      id: option.value,
      label: (
        <span className="cc-checkRow">
          <input
            type="checkbox"
            className="cc-check"
            checked={selected.includes(option.value)}
            readOnly
            tabIndex={-1}
          />
          <span className="cc-checkName">{option.label}</span>
          {option.stale ? <Tag tone="warning">{t('modelStale')}</Tag> : null}
          {option.allowance !== undefined ? (
            <span title={t('modelAllowanceTitle')}>
              <Tag tone="outline">{t('modelAllowance', { amount: option.allowance })}</Tag>
            </span>
          ) : null}
          {!selected.includes(option.value) && ownerOf?.(option.value) !== undefined ? (
            <Tag tone="outline">{t('accountModelOwner', { name: ownerOf(option.value)! })}</Tag>
          ) : null}
        </span>
      ),
    })),
  ])
  return (
    <Menu
      open={open}
      onClose={close}
      onSelect={(modelId) => {
        const next = toggleModelSelection(selected, modelId)
        if (deferCommit) setDraft(next)
        else onSelect(next)
      }}
      selectedIds={selected}
      items={items}
      footer={options.length === 0 ? [{
        type: 'label' as const,
        id: 'cc-model-search-empty',
        text: t('modelSearchEmpty'),
      }] : []}
      portal
      anchor={
        <span className="cc-modelSelectAnchor">
          <button
            id={id}
            type="button"
            className="cc-selector"
            disabled={disabled || catalog.length === 0}
            onClick={() => (open ? close() : setOpen(true))}
          >
            <span className="cc-selectorText">
              {selected.length === 0 ? t('modelPick') : t('modelCount', { count: selected.length })}
            </span>
            <IconChevronDownOutlineRegular size={12} className="cc-selectorChevron" />
          </button>
          {open ? (
            <Input
              type="search"
              className="cc-modelSearch"
              icon={<IconSearchOutlineRegular size={14} />}
              placeholder={t('modelSearchPlaceholder')}
              aria-label={t('modelSearchPlaceholder')}
              value={query}
              disabled={disabled}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
        </span>
      }
    />
  )
}

/** Visible-model allowlist row. */
function VisibleModelsRow({ t, state, disabled, onSelect, onClear }: {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  disabled: boolean
  onSelect(ids: string[]): void
  onClear(): void
}) {
  const count = state.visibleModels.length
  const pickT: Translate<SettingsCommandCodeKey> = (key, params) => {
    if (key === 'modelPick' || key === 'modelCount') {
      return state.visibleModelsAll ? t('visibleModelsShowAll') : t('visibleModelsCount', { count })
    }
    return t(key, params)
  }
  const readiness = { catalogIds: state.catalogModels.map((model) => model.id), catalogFailed: state.catalogFailed }
  const staleIds = staleModelIds(state.visibleModels, readiness)
  const catalogReady = catalogIsReady(readiness)
  return (
    <SettingRow
      title={t('visibleModelsTitle')}
      titleFor="cc-visible-models"
      tag={!state.visibleModelsAll ? <Tag tone="outline">{t('overridden')}</Tag> : undefined}
      description={
        staleIds.length > 0 && catalogReady ? <p>{t('visibleModelsStaleHint', { count: staleIds.length })}</p> : undefined
      }
      error={state.catalogFailed ? t('modelCatalogFailed') : undefined}
      control={
        <>
          {catalogReady && staleIds.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="cc-press"
              disabled={disabled}
              onClick={() => onSelect(state.visibleModels.filter((id) => !staleIds.includes(id)))}
            >
              {t('visibleModelsCleanStale', { count: staleIds.length })}
            </Button>
          ) : null}
          {!state.visibleModelsAll ? (
            <Button variant="ghost" size="sm" className="cc-press" disabled={disabled} onClick={onClear}>
              {t('visibleModelsShowAll')}
            </Button>
          ) : null}
          <ModelMultiSelect
            id="cc-visible-models"
            selected={state.visibleModels}
            catalog={state.catalogModels}
            disabled={disabled}
            t={pickT}
            onSelect={onSelect}
          />
        </>
      }
    />
  )
}

/**
 * Native flat group (`PluginInventorySettingsTab.group` geometry): `0.5px`
 * hairline divider between groups, instant `hidden` toggle, `160ms` chevron.
 */
function FoldableGroup({ id, title, expanded, onToggle, badges, action, children }: {
  id: FoldGroup
  title: string
  expanded: boolean
  onToggle(): void
  badges?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const titleId = `cc-group-${id}-title`
  const bodyId = `cc-group-${id}-body`
  return (
    <section className="cc-group" aria-labelledby={titleId}>
      <div className="cc-groupHead">
        <h3 className="cc-groupHeading">
          <button type="button" className="cc-disclosure" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
            <IconChevronDownOutlineRegular
              size={14}
              className={expanded ? 'cc-foldChevron' : 'cc-foldChevron cc-foldChevronClosed'}
            />
            <span id={titleId} className="cc-groupTitle">{title}</span>
            {badges}
          </button>
        </h3>
        {action}
      </div>
      <div id={bodyId} className="cc-groupBody" hidden={!expanded}>
        {children}
      </div>
    </section>
  )
}

function GroupSummary({ parts }: { parts: readonly (string | undefined)[] }) {
  const text = parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
  return text === '' ? null : <span className="cc-groupSummary">{text}</span>
}

function overriddenText(count: number, t: Translate<SettingsCommandCodeKey>): string | undefined {
  if (count === 0) return undefined
  return count === 1 ? t('groupOverriddenOne') : t('groupOverriddenMany', { count })
}

function InvalidBadge({ show, t }: { show: boolean; t: Translate<SettingsCommandCodeKey> }) {
  return show ? <Tag tone="danger">{t('groupInvalid')}</Tag> : null
}

interface FormCardProps {
  state: SettingsPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onEdit(field: string, text: string): void
  onReset(field: string): void
}

export interface FoldProps {
  expanded: boolean
  onToggle(): void
}

/** Models & context group: switches, allowlist, 2-col `SettingsValueField`s, and `ModelsSection.modelEntry` overrides. */
function ModelsCard({ state, disabled, t, onEdit, onReset, onSelect, onClear, onOverrides, onNames, expanded, onToggle }: FormCardProps & FoldProps & {
  onSelect(ids: string[]): void
  onClear(): void
  onOverrides(next: Record<string, string>): void
  onNames(next: Record<string, string>): void
}) {
  return (
    <FoldableGroup
      id="models"
      title={t('modelsTitle')}
      expanded={expanded}
      onToggle={onToggle}
      badges={
        <>
          <GroupSummary
            parts={[
              state.visibleModelsAll ? t('visibleModelsSummaryAll') : t('visibleModelsSummary', { count: state.visibleModels.length }),
              overriddenText(modelsOverriddenCount(state), t),
            ]}
          />
          <InvalidBadge show={!expanded && modelsGroupInvalid(state)} t={t} />
        </>
      }
    >
      <div className="cc-rows">
        <ToggleField
          id="cc-filter-models-by-plan"
          label={t('filterModelsByPlan')}
          state={state.filterModelsByPlan}
          disabled={disabled}
          defaultChecked
          onEdit={(text) => onEdit('filterModelsByPlan', text)}
          onReset={() => onReset('filterModelsByPlan')}
          t={t}
        />
        <VisibleModelsRow t={t} state={state} disabled={disabled} onSelect={onSelect} onClear={onClear} />
      </div>
      <ContextCard
        state={state}
        disabled={disabled}
        t={t}
        onEdit={onEdit}
        onReset={onReset}
        onOverrides={onOverrides}
      />
      <ModelNamesCard state={state} disabled={disabled} t={t} onNames={onNames} />
    </FoldableGroup>
  )
}

/**
 * Global context & output fields (reusing `SettingsValueField` in a 2-column
 * `SubagentLimitsFields` grid) plus concentric `R14 → R10` per-model rows.
 */
function ContextCard({ state, disabled, t, onEdit, onReset, onOverrides }: FormCardProps & {
  onOverrides(next: Record<string, string>): void
}) {
  const rows = state.contextWindowOverrides
  const used = new Set(rows.map((row) => row.model))
  const available = allowlistedModels(state.catalogModels, state.visibleModels, state.visibleModelsAll)
    .filter((model) => !used.has(model.id))
  const asMap = (): Record<string, string> => Object.fromEntries(rows.map((row) => [row.model, row.text]))
  const setText = (model: string, text: string) => onOverrides({ ...asMap(), [model]: text })
  const setModel = (from: string, to: string) => {
    if (to === '' || to === from || used.has(to)) return
    const next: Record<string, string> = {}
    for (const row of rows) next[row.model === from ? to : row.model] = row.text
    onOverrides(next)
  }
  const removeRow = (model: string) => {
    const next = asMap()
    delete next[model]
    onOverrides(next)
  }
  const addRow = () => {
    const model = available[0]
    if (model === undefined) return
    onOverrides({ ...asMap(), [model.id]: '' })
  }
  const labelOf = (model: string): string => {
    const entry = state.catalogModels.find((candidate) => candidate.id === model)
    return entry === undefined ? `${model} · ${t('modelStale')}` : `${entry.name} (${model})`
  }
  return (
    <>
      <div className="cc-fieldGrid2">
        <div className="cc-fieldCell cc-numField">
          <SettingsValueField
            id="cc-context-window"
            label={t('contextWindow')}
            help={{ label: t('contextWindow'), content: <p>{t('contextWindowHint')}</p> }}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={invalidCopy(state.contextWindow.invalidReason, t, 'context')}
            disabled={disabled}
            placeholder={t('placeholderCatalog')}
            {...state.contextWindow}
            onEdit={(text) => onEdit('contextWindow', text)}
            onReset={() => onReset('contextWindow')}
          />
        </div>
        <div className="cc-fieldCell cc-numField">
          <SettingsValueField
            id="cc-max-output-tokens"
            label={t('maxOutputTokens')}
            help={{ label: t('maxOutputTokens'), content: <p>{t('maxOutputTokensHint')}</p> }}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={invalidCopy(state.maxOutputTokens.invalidReason, t, 'output')}
            disabled={disabled}
            placeholder={t('placeholderAuto')}
            {...state.maxOutputTokens}
            onEdit={(text) => onEdit('maxOutputTokens', text)}
            onReset={() => onReset('maxOutputTokens')}
          />
        </div>
      </div>

      <div className="cc-overrideBlock">
        <div className="cc-row">
          <div className="cc-rowText">
            <div className="cc-rowTitleLine">
              <span className="cc-rowTitle">{t('contextOverridesTitle')}</span>
              {rows.length > 0 ? <Tag tone="neutral">{rows.length}</Tag> : null}
            </div>
          </div>
          <div className="cc-rowControl">
            <Button
              variant="ghost"
              size="sm"
              className="cc-press"
              icon={<IconPlusOutlineRegular size={13} />}
              disabled={disabled || available.length === 0}
              onClick={addRow}
            >
              {t('contextOverrideAdd')}
            </Button>
          </div>
        </div>
        {state.catalogFailed ? <p className="cc-groupDesc">{t('contextOverrideNoCatalog')}</p> : null}
        {rows.length > 0 ? (
          <div className="cc-overrideList">
            <div className="cc-overrideCols">
              <span>{t('contextOverrideModel')}</span>
              <span className="cc-overrideColRight">{t('contextOverrideValue')}</span>
              <span aria-hidden="true" />
            </div>
            {rows.map((row) => (
              <div className="cc-modelEntry" key={row.model}>
                <span className="cc-contextSelect">
                  <select
                    className="cc-fieldInput cc-contextModel"
                    value={row.model}
                    aria-label={t('contextOverrideModel')}
                    disabled={disabled}
                    onChange={(event) => setModel(row.model, event.target.value)}
                  >
                    <option value={row.model}>{labelOf(row.model)}</option>
                    {available.map((model) => (
                      <option key={model.id} value={model.id}>{labelOf(model.id)}</option>
                    ))}
                  </select>
                  <IconChevronDownOutlineRegular size={12} className="cc-contextCaret" />
                </span>
                <input
                  className={row.invalid ? 'cc-fieldInput cc-fieldInputNum cc-fieldInputInvalid' : 'cc-fieldInput cc-fieldInputNum'}
                  type="text"
                  aria-label={t('contextOverrideValue')}
                  aria-invalid={row.invalid || undefined}
                  placeholder={t('unitTokens')}
                  value={row.text}
                  disabled={disabled}
                  onChange={(event) => setText(row.model, event.target.value)}
                />
                <button
                  type="button"
                  className="cc-iconButton cc-iconButtonDanger"
                  aria-label={t('contextOverrideRemove')}
                  disabled={disabled}
                  onClick={() => removeRow(row.model)}
                >
                  <IconTrashOutlineRegular size={14} />
                </button>
                {row.invalid ? <p className="cc-rowError cc-contextError">{invalidCopy(row.invalidReason, t, 'context')}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
}

/** Per-model custom display names (issue #121), sharing the concentric `cc-modelEntry` row shape. */
function ModelNamesCard({ state, disabled, t, onNames }: Pick<FormCardProps, 'state' | 'disabled' | 't'> & {
  onNames(next: Record<string, string>): void
}) {
  const rows = state.modelNames
  const used = new Set(rows.map((row) => row.model))
  const available = allowlistedModels(state.catalogModels, state.visibleModels, state.visibleModelsAll)
    .filter((model) => !used.has(model.id))
  const asMap = (): Record<string, string> => Object.fromEntries(rows.map((row) => [row.model, row.text]))
  const setText = (model: string, text: string) => onNames({ ...asMap(), [model]: text })
  const setModel = (from: string, to: string) => {
    if (to === '' || to === from || used.has(to)) return
    const next: Record<string, string> = {}
    for (const row of rows) next[row.model === from ? to : row.model] = row.text
    onNames(next)
  }
  const removeRow = (model: string) => {
    const next = asMap()
    delete next[model]
    onNames(next)
  }
  const addRow = () => {
    const model = available[0]
    if (model === undefined) return
    onNames({ ...asMap(), [model.id]: '' })
  }
  const labelOf = (model: string): string => {
    const entry = state.catalogModels.find((candidate) => candidate.id === model)
    return entry === undefined ? `${model} · ${t('modelStale')}` : `${entry.name} (${model})`
  }
  return (
    <div className="cc-overrideBlock">
      <div className="cc-row">
        <div className="cc-rowText">
          <div className="cc-rowTitleLine">
            <span className="cc-rowTitle">{t('modelNamesTitle')}</span>
            {rows.length > 0 ? <Tag tone="neutral">{rows.length}</Tag> : null}
          </div>
        </div>
        <div className="cc-rowControl">
          <Button
            variant="ghost"
            size="sm"
            className="cc-press"
            icon={<IconPlusOutlineRegular size={13} />}
            disabled={disabled || available.length === 0}
            onClick={addRow}
          >
            {t('modelNamesAdd')}
          </Button>
        </div>
      </div>
      {state.catalogFailed ? <p className="cc-groupDesc">{t('modelNamesNoCatalog')}</p> : null}
      {rows.length > 0 ? (
        <div className="cc-overrideList">
          <div className="cc-overrideCols cc-overrideColsName">
            <span>{t('modelNamesModel')}</span>
            <span>{t('modelNamesValue')}</span>
            <span aria-hidden="true" />
          </div>
          {rows.map((row) => (
            <div className="cc-modelEntry cc-modelEntryName" key={row.model}>
              <span className="cc-contextSelect">
                <select
                  className="cc-fieldInput cc-contextModel"
                  value={row.model}
                  aria-label={t('modelNamesModel')}
                  disabled={disabled}
                  onChange={(event) => setModel(row.model, event.target.value)}
                >
                  <option value={row.model}>{labelOf(row.model)}</option>
                  {available.map((model) => (
                    <option key={model.id} value={model.id}>{labelOf(model.id)}</option>
                  ))}
                </select>
                <IconChevronDownOutlineRegular size={12} className="cc-contextCaret" />
              </span>
              <input
                className="cc-fieldInput"
                type="text"
                aria-label={t('modelNamesValue')}
                value={row.text}
                disabled={disabled}
                onChange={(event) => setText(row.model, event.target.value)}
              />
              <button
                type="button"
                className="cc-iconButton cc-iconButtonDanger"
                aria-label={t('modelNamesRemove')}
                disabled={disabled}
                onClick={() => removeRow(row.model)}
              >
                <IconTrashOutlineRegular size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Service status row: official Upptime record + live Host probe. */
function ServiceStatusRow({ view, t, onRetry }: {
  view: ServiceStatusView
  t: Translate<SettingsCommandCodeKey>
  onRetry: () => void
}) {
  return (
    <SettingRow
      title={t('serviceStatusTitle')}
      tag={
        <a className="cc-statusLink cc-statusTitleLink" href={STATUS_PAGE_URL} target="_blank" rel="noreferrer">
          {view.linkLabel}
          <IconRightUpOutlineRegular size={12} />
        </a>
      }
      description={
        <>
          <div className="cc-statusLines">
            <span className="cc-statusKey">{t('serviceStatusOfficial')}</span>
            <span className="cc-statusValue">
              <StateDot state={toneDot(view.officialTone)} size={8} />
              <span className="cc-statusVerdict" title={view.hiddenDetail}>{view.label}</span>
              {view.detailParts.length > 0 || view.updated !== undefined ? (
                <span className="cc-statusMeta">
                  {[...view.detailParts, ...(view.updated !== undefined ? [view.updated] : [])].map((part, index, parts) => {
                    const last = index === parts.length - 1
                    const isAge = view.updated !== undefined && last
                    return (
                      <span key={index}>
                        <span className="cc-statusPart" title={isAge ? view.lag ?? view.hint : undefined}>
                          {last ? part : `${part}\u00a0·`}
                        </span>
                        {last ? null : ' '}
                      </span>
                    )
                  })}
                </span>
              ) : null}
            </span>
            <span className="cc-statusKey">{t('serviceStatusLocal')}</span>
            <span className="cc-statusValue">
              <StateDot state={localDotState(view)} size={8} />
              <span className={view.localTone === 'warn' ? 'cc-statusVerdict cc-statusBad' : 'cc-statusVerdict'}>{view.local}</span>
              {view.localTone === 'warn' ? (
                <button type="button" className="cc-statusRetry" onClick={onRetry}>
                  <IconRefreshOutlineRegular size={12} />
                  {t('serviceStatusLocalRetry')}
                </button>
              ) : null}
            </span>
          </div>
          {view.notice !== undefined ? <p className="cc-statusNotice">{view.notice}</p> : null}
        </>
      }
    />
  )
}

function ServiceStatusBadge({ view }: { view: ServiceStatusView }) {
  return (
    <span className="cc-statusBadge" title={view.hint}>
      <StateDot state={toneDot(view.badge.tone)} />
      <span className={view.badge.tone === 'warn' || view.badge.tone === 'error' ? 'cc-statusLabel cc-statusBad' : 'cc-statusLabel'}>{view.badge.label}</span>
    </span>
  )
}

function toneDot(tone: ServiceTone): StateDotState {
  return tone === 'ok' ? 'done'
    : tone === 'warn' ? 'warning'
      : tone === 'error' ? 'error'
        : tone === 'checking' ? 'ongoing'
          : 'idle'
}

function localDotState(view: ServiceStatusView): StateDotState {
  if (view.localTone === 'ok') return 'done'
  if (view.localTone === 'warn') return 'warning'
  return view.localChecking ? 'ongoing' : 'idle'
}

/**
 * Features, privacy & status (Variant A unified group): Service status + ZDR +
 * Web search + Sidebar quota card in one cohesive flat section.
 */
function IntegrationsCard({ state, disabled, t, onEdit, onReset, expanded, onToggle, status, probe, onRetryProbe }: FormCardProps & FoldProps & {
  status: ServiceStatusSnapshot | undefined
  probe: ServiceProbe
  onRetryProbe: () => void
}) {
  const view = serviceStatusView(status, probe, t, Date.now())
  return (
    <FoldableGroup
      id="integrations"
      title={t('integrationsTitle')}
      expanded={expanded}
      onToggle={onToggle}
      badges={
        <>
          <ServiceStatusBadge view={view} />
          <GroupSummary
            parts={[
              stagedSwitch(state.zdr, false) ? t('zdrSummaryOn') : t('zdrSummaryOff'),
              stagedSwitch(state.webSearch, true) ? t('webSearchSummaryOn') : t('webSearchSummaryOff'),
            ]}
          />
        </>
      }
    >
      <div className="cc-rows">
        <ServiceStatusRow view={view} t={t} onRetry={onRetryProbe} />
        <ToggleField
          id="cc-zdr"
          label={t('zdr')}
          hint={t('zdrHint')}
          state={state.zdr}
          disabled={disabled}
          defaultChecked={false}
          onEdit={(text) => onEdit('zdr', text)}
          onReset={() => onReset('zdr')}
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
        <ToggleField
          id="cc-show-sidebar-quota"
          label={t('showSidebarQuota')}
          state={state.showSidebarQuota}
          disabled={disabled}
          defaultChecked={false}
          onEdit={(text) => onEdit('showSidebarQuota', text)}
          onReset={() => onReset('showSidebarQuota')}
          t={t}
        />
      </div>
    </FoldableGroup>
  )
}

/**
 * Advanced group: full-width monospace `apiBase` `SettingsValueField` (never
 * truncates reverse-proxy URLs) over a 3-column `tabular-nums` limits row.
 */
function AdvancedSection({ state, disabled, t, onEdit, onReset, expanded, onToggle }: FormCardProps & FoldProps) {
  return (
    <FoldableGroup
      id="advanced"
      title={t('advancedSettings')}
      expanded={expanded}
      onToggle={onToggle}
      badges={
        <>
          <GroupSummary parts={[overriddenText(advancedOverriddenCount(state), t)]} />
          <InvalidBadge show={!expanded && advancedGroupInvalid(state)} t={t} />
        </>
      }
    >
      <div className="cc-monoField">
        <SettingsValueField
          id="cc-api-base"
          label={t('apiBase')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          disabled={disabled}
          placeholder={FIELD_DEFAULTS.apiBase}
          {...state.apiBase}
          onEdit={(text) => onEdit('apiBase', text)}
          onReset={() => onReset('apiBase')}
        />
      </div>
      <div className="cc-fieldGrid3">
        <div className="cc-fieldCell cc-numField">
          <SettingsValueField
            id="cc-request-timeout"
            label={`${t('requestTimeoutMs')} (${t('unitSeconds')})`}
            help={{ label: t('requestTimeoutMs'), content: <p>{t('requestTimeoutMsHint')}</p> }}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={invalidCopy(state.requestTimeoutMs.invalidReason, t, 'duration')}
            disabled={disabled}
            placeholder={FIELD_DEFAULTS.requestTimeoutSeconds}
            {...state.requestTimeoutMs}
            onEdit={(text) => onEdit('requestTimeoutMs', text)}
            onReset={() => onReset('requestTimeoutMs')}
          />
        </div>
        <div className="cc-fieldCell cc-numField">
          <SettingsValueField
            id="cc-stream-idle-timeout"
            label={`${t('streamIdleTimeoutMs')} (${t('unitSeconds')})`}
            help={{ label: t('streamIdleTimeoutMs'), content: <p>{t('streamIdleTimeoutMsHint')}</p> }}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={invalidCopy(state.streamIdleTimeoutMs.invalidReason, t, 'duration')}
            disabled={disabled}
            placeholder={FIELD_DEFAULTS.streamIdleTimeoutSeconds}
            {...state.streamIdleTimeoutMs}
            onEdit={(text) => onEdit('streamIdleTimeoutMs', text)}
            onReset={() => onReset('streamIdleTimeoutMs')}
          />
        </div>
        <div className="cc-fieldCell cc-numField">
          <SettingsValueField
            id="cc-transport-max-retries"
            label={`${t('transportMaxRetries')} (${t('unitRetries')})`}
            help={{ label: t('transportMaxRetries'), content: <p>{t('transportMaxRetriesHint')}</p> }}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={invalidCopy(state.transportMaxRetries.invalidReason, t, 'number')}
            numeric
            disabled={disabled}
            placeholder={FIELD_DEFAULTS.transportMaxRetries}
            {...state.transportMaxRetries}
            onEdit={(text) => onEdit('transportMaxRetries', text)}
            onReset={() => onReset('transportMaxRetries')}
          />
        </div>
      </div>
      <div className="cc-rows">
        <ToggleField
          id="cc-offload-seen-images-for-cache"
          label={t('offloadSeenImagesForCache')}
          hint={t('offloadSeenImagesForCacheHint')}
          state={state.offloadSeenImagesForCache}
          disabled={disabled}
          defaultChecked={false}
          onEdit={(text) => onEdit('offloadSeenImagesForCache', text)}
          onReset={() => onReset('offloadSeenImagesForCache')}
          t={t}
        />
      </div>
    </FoldableGroup>
  )
}

interface AccountRowModel {
  id: string
  label: string
  ref: string | undefined
  isDefault: boolean
  managed: boolean
  configured: boolean
  storedKey: boolean
  credentialKnown: boolean
  keyWritable: boolean
  usage: CommandCodeAccountUsage | undefined
}

function accountRows(state: SettingsPageState, usage: UsagePageState, t: Translate<SettingsCommandCodeKey>): AccountRowModel[] {
  const report = new Map((usage.report?.accounts ?? []).map((entry) => [entry.id, entry]))
  const defaultUsage = report.get('default')
  const rows: AccountRowModel[] = [{
    id: 'default',
    label: t('accountDefault'),
    ref: undefined,
    isDefault: true,
    managed: true,
    configured: state.apiKeyConfigured || defaultUsage?.configured === true,
    storedKey: state.apiKeyConfigured,
    credentialKnown: state.apiKeyKnown || typeof defaultUsage?.configured === 'boolean',
    keyWritable: state.apiKeyWritable,
    usage: defaultUsage,
  }]
  for (const account of state.accounts) {
    const entry = report.get(account.id)
    rows.push({
      id: account.id,
      label: account.label,
      ref: account.ref,
      isDefault: false,
      managed: true,
      configured: account.configured || entry?.configured === true,
      storedKey: account.configured,
      credentialKnown: account.credentialKnown || typeof entry?.configured === 'boolean',
      keyWritable: account.writable,
      usage: entry,
    })
  }
  const known = new Set(rows.map((row) => row.id))
  for (const entry of usage.report?.accounts ?? []) {
    if (known.has(entry.id)) continue
    known.add(entry.id)
    rows.push({
      id: entry.id,
      label: entry.label,
      ref: undefined,
      isDefault: false,
      managed: false,
      configured: entry.configured,
      storedKey: false,
      credentialKnown: true,
      keyWritable: false,
      usage: entry,
    })
  }
  return rows
}

/** Semantic `StateDot` state for an account row; undefined on quiet standby rows. */
function accountDotState(row: AccountRowModel): StateDotState | undefined {
  const entry = row.usage
  if (entry?.mark === 'invalid-credential') return 'error'
  if (entry !== undefined && (entry.mark !== '' || entry.cooldownUntil > 0)) return 'warning'
  if (row.configured && entry?.active === true) return 'done'
  return undefined
}

function statusDotTitle(row: AccountRowModel, t: Translate<SettingsCommandCodeKey>): string | undefined {
  const entry = row.usage
  if (entry?.mark === 'invalid-credential') return t('usageInvalidKey')
  if (entry !== undefined && (entry.mark !== '' || entry.cooldownUntil > 0)) return t('usageCooldown')
  if (!row.credentialKnown) return t('writeStateUnknown')
  if (!row.configured) return t('apiKeyUnset')
  return entry?.active === true ? t('usageActive') : undefined
}

function MiniMeter({ label, limit }: { label: string; limit: NonNullable<CommandCodeCredits['fiveHour']> }) {
  const ratio = windowRatio(limit.used, limit.cap)
  const percent = limit.cap > 0 ? `${Math.round(ratio * 100)}%` : formatMoney(limit.used)
  return (
    <span className="cc-miniMeter" title={limit.cap > 0 ? `${formatMoney(limit.used)} / ${formatMoney(limit.cap)}` : undefined}>
      <span className="cc-miniMeterLabel">{label}</span>
      <span className="cc-miniMeterTrack" aria-hidden="true">
        <span className={limit.exceeded ? 'cc-miniMeterFill cc-usageBarFillWarn' : 'cc-miniMeterFill'} style={{ transform: `translateX(${(ratio - 1) * 100}%)` }} />
      </span>
      <span className="cc-miniMeterValue">{percent}</span>
    </span>
  )
}

function MonthlyBalance({ label, remaining }: { label: string; remaining: number }) {
  return (
    <span className="cc-miniMeterPlain">
      <span className="cc-miniMeterLabel">{label}</span>
      <span className="cc-miniMeterValue">{formatMoney(Math.max(0, remaining))}</span>
    </span>
  )
}

/** Single-input inline form over `Input` + `Button` primitives. */
function InlineInput({ id, label, secret, initial, placeholder, confirmLabel, disabled, t, onSubmit, onCancel }: {
  id: string
  label: string
  secret?: boolean
  initial?: string
  placeholder?: string
  confirmLabel: string
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onSubmit(value: string): void
  onCancel(): void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [visible, setVisible] = useState(false)
  const ready = value.trim() !== ''
  return (
    <form
      className="cc-inlineForm"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready && !disabled) onSubmit(value)
      }}
    >
      <Input
        id={id}
        className="cc-panelInput"
        type={secret && !visible ? 'password' : 'text'}
        aria-label={label}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      <div className="cc-inlineActions">
        {secret && value !== '' ? (
          <Button variant="ghost" size="sm" className="cc-press" type="button" onClick={() => setVisible((shown) => !shown)}>
            {visible ? t('hide') : t('show')}
          </Button>
        ) : null}
        <span className="cc-spacer" />
        <Button variant="outline" size="sm" className="cc-press" type="button" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" className="cc-press" type="submit" disabled={!ready || disabled}>{confirmLabel}</Button>
      </div>
    </form>
  )
}

type RowMode = 'key' | 'rename' | 'remove' | 'clearKey' | undefined

/** Entity account card (`ModelsSection.rowCard` `R20` + concentric `R10` details + `Modal` confirm). */
function AccountItem({ row, rows, state, usage, login, disabled, pinned, t, actions }: {
  row: AccountRowModel
  rows: readonly AccountRowModel[]
  state: SettingsPageState
  usage: UsagePageState
  login: LoginPageState
  disabled: boolean
  pinned: boolean
  t: Translate<SettingsCommandCodeKey>
  actions: AccountActions
}) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<RowMode>(undefined)
  const entry = row.usage
  const report = entry?.report
  const accountName = report?.account === undefined ? '' : report.account.userName || report.account.name
  const planName = report?.plan?.name ?? ''
  const credits = report?.credits
  const monthlyReported = credits !== undefined && credits.monthlyReported !== false
  const multi = rows.length > 1
  const loginTarget = row.ref
  const { visible: loginState, busyElsewhere } = loginStateForTarget(login, loginTarget)
  const loginBusy = loginState.phase === 'starting' || loginState.phase === 'waiting'
  const showLogin = loginState.phase !== 'idle'
  const locked = disabled || !row.managed
  const keyActions = !locked && row.keyWritable

  const items: MenuEntry[] = []
  if (row.managed && multi) {
    items.push(pinned
      ? { id: 'unpin', label: t('accountActionUnpin'), disabled: locked }
      : { id: 'pin', label: t('accountActionPin'), disabled: locked || !row.configured })
  }
  if (row.managed) {
    if (items.length > 0) items.push({ type: 'separator', id: 'sep-key' })
    items.push(
      { id: 'login', label: t('accountActionLogin'), disabled: !keyActions || loginBusy || busyElsewhere },
      { id: 'key', label: t('accountActionKey'), disabled: !keyActions },
    )
    if (!row.isDefault) items.push({ id: 'rename', label: t('accountActionRename'), disabled: locked })
    if (row.isDefault && row.storedKey) {
      items.push(
        { type: 'separator', id: 'sep-danger' },
        { id: 'clearKey', label: t('accountActionClearKey'), disabled: !keyActions, danger: true },
      )
    }
    if (!row.isDefault) {
      items.push(
        { type: 'separator', id: 'sep-danger' },
        { id: 'remove', label: t('accountActionRemove'), disabled: locked, danger: true },
      )
    }
  }

  const onAction = (id: string) => {
    setMenuOpen(false)
    if (id === 'pin') void actions.setActive(row.id)
    else if (id === 'unpin') void actions.setActive('')
    else if (id === 'login') actions.beginLogin(loginTarget)
    else if (id === 'key' || id === 'rename' || id === 'remove' || id === 'clearKey') setMode(id)
  }

  const models = state.accountModels[row.id] ?? []
  const ownerOf = (modelId: string): string | undefined => {
    for (const [account, list] of Object.entries(state.accountModels)) {
      if (account === row.id || !list.includes(modelId)) continue
      return rows.find((candidate) => candidate.id === account)?.label ?? account
    }
    return undefined
  }

  const dot = accountDotState(row)
  const itemClass = entry?.mark === 'invalid-credential'
    ? 'cc-accountItem cc-accountItemInvalid'
    : entry?.active
      ? 'cc-accountItem cc-accountItemActive'
      : 'cc-accountItem'

  return (
    <div className={itemClass}>
      <div className="cc-accountHead">
        <button
          type="button"
          className="cc-accountToggle"
          aria-expanded={expanded}
          aria-controls={`cc-account-${row.id}-details`}
          onClick={() => setExpanded((value) => !value)}
        >
          {dot !== undefined ? (
            <span title={statusDotTitle(row, t)} style={{ display: 'inline-flex' }}>
              <StateDot state={dot} />
            </span>
          ) : (
            <span className="cc-dotSpacer" aria-hidden="true" />
          )}
          <span className="cc-accountName">{row.label}</span>
          <span className="cc-accountTags">
            {accountName !== '' && accountName !== row.label ? <span className="cc-usageAccount">{accountName}</span> : null}
            {planName !== '' ? <Tag tone="neutral">{planName}</Tag> : null}
            {entry?.active && multi ? <Tag tone="success">{t('usageActive')}</Tag> : null}
            {pinned ? <Tag tone="solid">{t('accountStatusPinned')}</Tag> : null}
            {!row.credentialKnown || !row.configured ? <Tag tone="outline">{t(row.credentialKnown ? 'apiKeyUnset' : 'writeStateUnknown')}</Tag> : null}
            {entry?.mark === 'invalid-credential' ? <Tag tone="danger">{t('usageInvalidKey')}</Tag> : null}
            {entry !== undefined && entry.mark !== 'invalid-credential' && (entry.cooldownUntil > 0 || entry.mark === 'rate-limit') ? (
              <Tag tone="warning">
                {t('usageCooldown')}{entry.cooldownUntil > 0 ? ` ${formatResetAtShort(entry.cooldownUntil)}` : ''}
              </Tag>
            ) : null}
          </span>
          <IconChevronDownOutlineRegular
            size={14}
            className={expanded ? 'cc-accountChevron cc-chevronOpen' : 'cc-accountChevron'}
          />
        </button>
        {/* Unpinning is a settings write, so it stays reachable even for a
            composition account the page cannot rename or remove. It reads as
            quiet text rather than a second outlined button, so the header keeps
            one visual weight and one right edge. */}
        {multi && pinned ? (
          <Button
            variant="ghost"
            size="sm"
            className="cc-press cc-unpin"
            disabled={disabled || state.accountBusy}
            onClick={() => void actions.setActive('')}
          >
            {t('accountActionUnpin')}
          </Button>
        ) : null}
        {items.length > 0 ? (
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            onSelect={onAction}
            items={items}
            align="end"
            portal
            anchor={
              <button
                type="button"
                className="cc-iconButton"
                aria-label={`${row.label} — ${t('accountActions')}`}
                title={t('accountActions')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <IconEllipsisOutlineRegular size={16} />
              </button>
            }
          />
        ) : null}
      </div>

      {!expanded && credits !== undefined && (credits.fiveHour !== undefined || credits.weekly !== undefined || monthlyReported) ? (
        <div className="cc-accountMeters">
          {credits.fiveHour !== undefined ? <MiniMeter label={t('usageFiveHour')} limit={credits.fiveHour} /> : null}
          {credits.weekly !== undefined ? <MiniMeter label={t('usageWeekly')} limit={credits.weekly} /> : null}
          {monthlyReported ? (
            <MonthlyBalance label={t('usageMonthlyLeft')} remaining={credits.monthlyCredits} />
          ) : null}
        </div>
      ) : null}

      {row.credentialKnown && !row.configured && row.managed && mode === undefined && !showLogin ? (
        <Notice
          icon={row.keyWritable ? 'info' : 'lock'}
          actions={keyActions ? (
            <>
              <Button variant="primary" size="sm" className="cc-press" disabled={loginBusy || busyElsewhere} onClick={() => actions.beginLogin(loginTarget)}>
                {t('accountAddLogin')}
              </Button>
              <Button variant="outline" size="sm" className="cc-press" onClick={() => setMode('key')}>{t('accountAddPaste')}</Button>
            </>
          ) : undefined}
        >
          <p>{row.keyWritable ? t('accountNoKeyHint') : t('apiKeyLocked')}</p>
        </Notice>
      ) : null}

      {showLogin ? <LoginStatus state={loginState} t={t} onCancel={actions.cancelLogin} /> : null}

      {mode === 'key' ? (
        <div className="cc-panel">
          <InlineInput
            id={`cc-account-${row.id}-key`}
            label={t('accountKeyPlaceholder')}
            secret
            placeholder={t('accountKeyPlaceholder')}
            confirmLabel={t('accountApply')}
            disabled={disabled || state.accountBusy}
            t={t}
            onCancel={() => setMode(undefined)}
            onSubmit={(value) => {
              void actions.setKey(row.id, value).then((ok) => {
                if (ok) setMode(undefined)
              })
            }}
          />
        </div>
      ) : null}
      {mode === 'rename' && row.ref !== undefined ? (
        <div className="cc-panel">
          <InlineInput
            id={`cc-account-${row.id}-rename`}
            label={t('accountActionRename')}
            initial={row.label}
            confirmLabel={t('accountApply')}
            disabled={disabled || state.accountBusy}
            t={t}
            onCancel={() => setMode(undefined)}
            onSubmit={(value) => {
              void actions.rename(row.ref!, value).then((ok) => {
                if (ok) setMode(undefined)
              })
            }}
          />
        </div>
      ) : null}

      {/* Centered native Modal for destructive confirmations (replaces custom inline ConfirmBar). */}
      <Modal
        open={mode === 'remove' && row.ref !== undefined}
        onClose={() => setMode(undefined)}
        title={t('accountActionRemove')}
        closeLabel={t('cancel')}
        description={t('accountRemoveConfirm', { name: row.label })}
        footer={
          <div className="cc-modalActions">
            <Button variant="outline" size="md" className="cc-press" onClick={() => setMode(undefined)}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              size="md"
              className="cc-press cc-dangerButton"
              disabled={disabled || state.accountBusy}
              onClick={() => {
                if (row.ref === undefined) return
                void actions.remove(row.ref).then((ok) => {
                  if (ok) setMode(undefined)
                })
              }}
            >
              {t('accountConfirmRemove')}
            </Button>
          </div>
        }
      />
      <Modal
        open={mode === 'clearKey'}
        onClose={() => setMode(undefined)}
        title={t('accountActionClearKey')}
        closeLabel={t('cancel')}
        description={t('accountClearKeyConfirm')}
        footer={
          <div className="cc-modalActions">
            <Button variant="outline" size="md" className="cc-press" onClick={() => setMode(undefined)}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              size="md"
              className="cc-press cc-dangerButton"
              disabled={disabled || state.accountBusy}
              onClick={() => {
                void actions.clearKey(row.id).then((ok) => {
                  if (ok) setMode(undefined)
                })
              }}
            >
              {t('accountConfirmClear')}
            </Button>
          </div>
        }
      />

      {expanded ? (
        <div id={`cc-account-${row.id}-details`} className="cc-accountDetails">
          {entry !== undefined ? (
            <AccountReport entry={entry} fetchedAt={usage.fetchedAt} t={t} headless />
          ) : (
            <p className="cc-usageHint">{usage.status === 'loading' ? t('usageLoading') : t('usageUnconfigured')}</p>
          )}
          {multi && row.managed ? (
            <SettingRow
              className="cc-rowFlush"
              title={t('accountModels')}
              titleFor={`cc-account-${row.id}-models`}
              error={state.catalogFailed ? t('modelCatalogFailed') : undefined}
              control={
                <ModelMultiSelect
                  id={`cc-account-${row.id}-models`}
                  selected={models}
                  catalog={state.catalogModels}
                  disabled={disabled || state.accountBusy}
                  deferCommit
                  ownerOf={ownerOf}
                  t={t}
                  onSelect={(ids) => void actions.setModels(row.id, ids)}
                />
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function LoginStatus({ state, t, onCancel }: {
  state: LoginPageState
  t: Translate<SettingsCommandCodeKey>
  onCancel(): void
}) {
  const hint = loginHint(state, t)
  const busy = state.phase === 'starting' || state.phase === 'waiting'
  const tone: NoticeTone = hint.className === 'cc-loginError' ? 'error' : hint.className === 'cc-loginDone' ? 'success' : 'neutral'
  const link = state.authUrl !== undefined ? (
    <a className="cc-loginLink" href={state.authUrl} target="_blank" rel="noreferrer">
      {t('loginOpenLink')}
      <IconRightUpOutlineRegular size={12} />
    </a>
  ) : null
  return (
    <Notice
      tone={tone}
      actions={link !== null || busy ? <>{link}{busy ? <Button variant="ghost" size="sm" className="cc-press" onClick={onCancel}>{t('loginCancel')}</Button> : null}</> : undefined}
    >
      <p title={hint.title}>{hint.text}</p>
    </Notice>
  )
}

interface AccountActions {
  refreshCredentials(): void
  cleanup(ref: string): Promise<boolean>
  rename(ref: string, label: string): Promise<boolean>
  remove(ref: string): Promise<boolean>
  setKey(target: string, key: string): Promise<boolean>
  clearKey(target: string): Promise<boolean>
  setActive(id: string): Promise<boolean>
  setModels(target: string, ids: string[]): Promise<boolean>
  beginLogin(targetRef?: string): void
  cancelLogin(): void
}

export type AddAccountMode = 'browser' | 'paste'
const ENROLLMENT_BUSY_PHASES: readonly string[] = ['creating', 'waiting', 'writing', 'cancelling']

export function addAccountPanelView({ phase, mode, keyReady, disabled }: {
  phase: string | undefined
  mode: AddAccountMode
  keyReady: boolean
  disabled: boolean
}): { actions: 'naming' | 'cancelSetup' | 'start'; locked: boolean; canSubmit: boolean } {
  if (phase === 'naming') return { actions: 'naming', locked: true, canSubmit: false }
  if (phase !== undefined && ENROLLMENT_BUSY_PHASES.includes(phase)) return { actions: 'cancelSetup', locked: true, canSubmit: false }
  return { actions: 'start', locked: disabled, canSubmit: !disabled && (mode === 'browser' || keyReady) }
}

/**
 * Add-account inline panel (`ModelsSection.addCard` surface) powered by the
 * platform `SegmentedControl`, `Input` and `Button` primitives.
 */
function AddAccountPanel({ state, disabled, t, enrollment, snapshot, onClose }: {
  state: SettingsPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  enrollment: AccountEnrollmentController
  snapshot: EnrollmentPageState
  onClose(): void
}) {
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<AddAccountMode>('browser')
  const [key, setKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const active = snapshot.active
  const view = addAccountPanelView({ phase: active?.phase, mode, keyReady: key.trim() !== '', disabled })
  const fallbackName = t('accountNameN', { n: state.accounts.length + 2 })
  useEffect(() => { if (active?.phase === 'finished') onClose() }, [active?.phase, onClose])
  const start = () => enrollment.begin({
    mode: mode === 'browser' ? 'browser' : 'manual',
    label: label.trim() || fallbackName,
    automaticName: label.trim() === '',
    ...(mode === 'browser' ? {} : { key }),
  })
  const close = () => { enrollment.cancel(); onClose() }
  const pick = (next: AddAccountMode) => {
    setMode(next)
    if (next === 'browser') {
      setKey('')
      setKeyVisible(false)
    }
  }
  const waitingLink = active?.authUrl && active.phase === 'waiting' ? active.authUrl : undefined
  const modeOptions = useMemo(() => [
    { value: 'browser' as const, label: t('accountAddLogin') },
    { value: 'paste' as const, label: t('accountAddPaste') },
  ], [t])

  return (
    <form
      className="cc-panel"
      aria-label={t('accountAdd')}
      onSubmit={(event) => {
        event.preventDefault()
        if (view.canSubmit) void start()
      }}
    >
      <div className="cc-panelHead">
        <span className="cc-panelTitle">{t('accountAdd')}</span>
        <SegmentedControl
          id="cc-add-account-mode"
          value={mode}
          options={modeOptions}
          onChange={pick}
          label={t('accountAddMethod')}
          disabled={view.locked}
        />
      </div>
      <Input
        className="cc-panelInput"
        type="text"
        aria-label={t('accountNamePlaceholder')}
        placeholder={t('accountNamePlaceholder')}
        value={label}
        disabled={view.locked}
        onChange={(event) => setLabel(event.target.value)}
      />
      {mode === 'paste' ? (
        <div className="cc-keyField">
          <Input
            id="cc-add-account-key"
            className="cc-panelInput"
            type={keyVisible ? 'text' : 'password'}
            aria-label={t('accountKeyPlaceholder')}
            placeholder={t('accountKeyPlaceholder')}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            value={key}
            disabled={view.locked}
            onChange={(event) => setKey(event.target.value)}
          />
          {key !== '' ? (
            <Button variant="ghost" size="sm" className="cc-press" disabled={view.locked} onClick={() => setKeyVisible((shown) => !shown)}>
              {keyVisible ? t('hide') : t('show')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {active ? (
        <Notice
          actions={waitingLink !== undefined ? (
            <a className="cc-loginLink" href={waitingLink} target="_blank" rel="noreferrer">
              {t('accountAddOpenLink')}
              <IconRightUpOutlineRegular size={12} />
            </a>
          ) : undefined}
        >
          <p>{t(active.messageKey)}</p>
          {waitingLink !== undefined ? <p>{t('accountAddLinkHint')}</p> : null}
        </Notice>
      ) : null}
      {snapshot.error ? <Notice tone="error"><p>{t(snapshot.error)}</p></Notice> : null}
      <div className="cc-panelActions">
        {view.actions === 'naming' && active !== undefined ? (
          <>
            <Button variant="ghost" size="md" className="cc-press" onClick={close}>{t('cancel')}</Button>
            <Button variant="outline" size="md" className="cc-press" disabled={disabled} onClick={() => void enrollment.name()}>{t('accountNameAcceptExisting')}</Button>
            <Button variant="primary" size="md" className="cc-press" disabled={disabled} onClick={() => void enrollment.name(active.suggestedName || label || fallbackName)}>{t('accountNameSaveRetry')}</Button>
          </>
        ) : view.actions === 'cancelSetup' ? (
          <Button variant="outline" size="md" className="cc-press" onClick={close}>{t('accountAddCancel')}</Button>
        ) : (
          <>
            <Button variant="outline" size="md" className="cc-press" onClick={close}>{t('cancel')}</Button>
            <Button variant="primary" size="md" className="cc-press" type="submit" disabled={!view.canSubmit}>
              {mode === 'browser' ? t('accountAddStart') : t('accountAddConfirm')}
            </Button>
          </>
        )}
      </div>
    </form>
  )
}

export function AccountsCard({ t, state, usage, login, disabled, actions, onRefresh, onRefreshAuto, openAnalytics, createEnrollment, expanded, onToggle }: FoldProps & {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  usage: UsagePageState
  login: LoginPageState
  disabled: boolean
  actions: AccountActions
  onRefresh(): void
  onRefreshAuto(): void
  openAnalytics?: (() => void) | undefined
  createEnrollment(): AccountEnrollmentController
}) {
  const [adding, setAdding] = useState(false)
  const [enrollment] = useState(createEnrollment)
  const snapshot = useSyncExternalStore(enrollment.store.subscribe, enrollment.store.getSnapshot)
  useEffect(() => { enrollment.activate(); return () => enrollment.dispose() }, [enrollment])
  const closeAdd = useCallback(() => setAdding(false), [])
  const { loading, shouldRefresh } = usageCardState(usage)
  const refreshAuto = useRef(onRefreshAuto)
  useEffect(() => { refreshAuto.current = onRefreshAuto })
  const autoAttempts = useRef(0)
  useEffect(() => {
    if (!shouldRefresh) {
      autoAttempts.current = 0
      return
    }
    if (autoAttempts.current >= USAGE_AUTO_RETRY_LIMIT) return
    autoAttempts.current += 1
    refreshAuto.current()
    const timer = setInterval(() => {
      if (autoAttempts.current >= USAGE_AUTO_RETRY_LIMIT) {
        clearInterval(timer)
        return
      }
      autoAttempts.current += 1
      refreshAuto.current()
    }, USAGE_AUTO_RETRY_MS)
    return () => clearInterval(timer)
  }, [shouldRefresh])
  const rows = accountRows(state, usage, t).filter((row) => row.ref === undefined || !state.accountEnrollmentRefs.includes(row.ref))
  const multi = rows.length > 1
  const pinnedRow = rows.find((row) => row.id === state.activeAccount)
  const issues = accountIssues(rows.map((row) => row.usage))
  return (
    <FoldableGroup
      id="accounts"
      title={t('accountsTitle')}
      expanded={expanded}
      onToggle={onToggle}
      badges={
        <>
          <GroupSummary
            parts={[
              rows.length === 1 ? t('accountsSummaryOne') : t('accountsSummaryMany', { count: rows.length }),
              multi
                ? (pinnedRow !== undefined ? t('accountModePinned', { name: pinnedRow.label }) : t('accountModeAuto'))
                : undefined,
            ]}
          />
          {issues.count > 0 ? (
            <Tag tone={issues.severe ? 'danger' : 'warning'}>
              {t('accountsSummaryIssues', { count: issues.count })}
            </Tag>
          ) : null}
        </>
      }
      action={
        <Button
          variant="ghost"
          size="sm"
          className="cc-press"
          icon={<IconRefreshOutlineRegular size={14} />}
          disabled={loading}
          onClick={() => { onRefresh(); void enrollment.refresh() }}
        >
          {loading ? t('usageRefreshing') : t('usageRefresh')}
        </Button>
      }
    >
      {(() => {
        const writeNotice = settingsWriteNotice(state.accountResult, t)
        const notices: ReactNode[] = []
        if (usage.status === 'error') {
          notices.push(
            <Notice key="usage" tone="error">
              <p>{t('usageError')}{usage.error !== undefined && usage.error !== '' ? ` — ${usage.error}` : ''}</p>
            </Notice>,
          )
        }
        if (writeNotice || state.accountFailed !== undefined) {
          notices.push(<Notice key="op" tone="error"><p>{writeNotice || t('accountOpFailed')}</p></Notice>)
        }
        if (state.credentialRefreshFailed || state.accountResult?.refreshFailed || state.saveResult?.refreshFailed) {
          notices.push(
            <Notice key="refresh" tone="warn" actions={<Button variant="outline" size="sm" className="cc-press" onClick={actions.refreshCredentials}>{t('writeRefreshRetry')}</Button>}>
              <p>{t('writeRefreshFailed')}</p>
            </Notice>,
          )
        }
        if (!adding && snapshot.error) {
          notices.push(<Notice key="enroll" tone="error"><p>{t(snapshot.error)}</p></Notice>)
        }
        if (state.pendingCredentialCleanup.length > 0) {
          notices.push(
            <Notice
              key="cleanup"
              tone="warn"
              actions={
                <Button variant="outline" size="sm" className="cc-press" disabled={disabled || state.accountBusy}
                  onClick={() => { for (const ref of state.pendingCredentialCleanup) void actions.cleanup(ref) }}>
                  {t('accountCleanupRetry')}
                </Button>
              }
            >
              <p>{t('accountCleanupPending')}</p>
            </Notice>,
          )
        }
        for (const record of snapshot.pending.filter((candidate) => candidate.id !== snapshot.active?.id)) {
          notices.push(
            <Notice
              key={record.id}
              tone="warn"
              actions={
                <>
                  {record.phase === 'naming' && record.suggestedName ? (
                    <Button variant="outline" size="sm" className="cc-press" disabled={disabled} onClick={() => void enrollment.recover(record, record.suggestedName)}>{t('accountNameSaveRetry')}</Button>
                  ) : null}
                  <Button variant="outline" size="sm" className="cc-press" disabled={disabled} onClick={() => void enrollment.recover(record)}>
                    {record.phase === 'naming' ? t('accountNameAcceptExisting') : t('accountEnrollmentCleanupRetry')}
                  </Button>
                </>
              }
            >
              <p>{record.ref}{t('accountRefSeparator')}{t(record.messageKey)}</p>
            </Notice>,
          )
        }
        if (snapshot.active?.phase === 'cleanup-needed') {
          notices.push(
            <Notice
              key="active-cleanup"
              tone="warn"
              actions={<Button variant="outline" size="sm" className="cc-press" disabled={disabled} onClick={() => void enrollment.recover(snapshot.active!)}>{t('accountEnrollmentCleanupRetry')}</Button>}
            >
              <p>{t(snapshot.active.messageKey)}</p>
            </Notice>,
          )
        }
        return notices.length > 0 ? <div className="cc-notices">{notices}</div> : null
      })()}
      <div className="cc-accountList">
        {rows.map((row) => (
          <AccountItem
            key={row.id}
            row={row}
            rows={rows}
            state={state}
            usage={usage}
            login={login}
            disabled={disabled}
            pinned={state.activeAccount === row.id}
            t={t}
            actions={actions}
          />
        ))}
      </div>
      {adding ? (
        <AddAccountPanel
          state={state}
          disabled={disabled}
          t={t}
          enrollment={enrollment}
          snapshot={snapshot}
          onClose={closeAdd}
        />
      ) : null}
      {!adding || openAnalytics ? (
        <div className="cc-accountActions">
          {!adding ? (
            <button
              type="button"
              className="cc-addButton"
              disabled={disabled}
              onClick={() => { enrollment.reset(); setAdding(true) }}
            >
              <IconPlusOutlineMedium size={14} />
              <span>{t('accountAdd')}</span>
            </button>
          ) : <span className="cc-spacer" />}
          {openAnalytics ? (
            <Button
              variant="outline"
              size="md"
              className="cc-press cc-analyticsEntry"
              icon={<IconGaugeOutlineRegular size={15} />}
              onClick={openAnalytics}
            >
              <span className="cc-analyticsEntryText">{t('openAnalytics')}</span>
              <IconRightUpOutlineRegular size={13} />
            </Button>
          ) : null}
        </div>
      ) : null}
    </FoldableGroup>
  )
}

function useSavedFlash(tick: number): boolean {
  const [visible, setVisible] = useState(false)
  const seen = useRef(tick)
  useEffect(() => {
    if (tick === seen.current) return
    seen.current = tick
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 2500)
    return () => clearTimeout(timer)
  }, [tick])
  return visible
}

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
    }, () => {})
    return () => {
      cancelled = true
    }
  }, [])
  return available
}

function useServiceStatus(probeService: CommandCodeSettingsProps['probeService']): {
  snapshot: ServiceStatusSnapshot | undefined
  probe: ServiceProbe
  retry: () => void
} {
  const [snapshot, setSnapshot] = useState<ServiceStatusSnapshot | undefined>(
    () => readCachedServiceStatus(localStorageServiceStatusStore()),
  )
  const [probe, setProbe] = useState<ServiceProbe>({ kind: 'checking' })
  const probeRef = useRef(probeService)
  probeRef.current = probeService
  const cancelled = useRef(false)
  const runProbe = useCallback(() => {
    setProbe({ kind: 'checking' })
    void runServiceProbeWithRetry(() => probeRef.current()).then((next) => {
      if (!cancelled.current) setProbe(next)
    })
  }, [])
  useEffect(() => {
    cancelled.current = false
    runProbe()
    return () => {
      cancelled.current = true
    }
  }, [runProbe])
  useEffect(() => {
    let cancelledSnapshot = false
    void checkServiceStatus({ store: localStorageServiceStatusStore() }).then((next) => {
      if (!cancelledSnapshot) setSnapshot(next)
    }, () => {})
    return () => {
      cancelledSnapshot = true
    }
  }, [])
  return { snapshot, probe, retry: runProbe }
}

function useGroupFold(): [FoldState, (next: FoldState) => void] {
  const [store] = useState(localStorageFoldStore)
  const [fold, setFoldState] = useState<FoldState>(() => store.read())
  const setFold = useCallback((next: FoldState) => {
    setFoldState(next)
    store.write(next)
  }, [store])
  return [fold, setFold]
}

type SaveBarTone = 'pending' | 'error' | 'success'

interface SaveBarView {
  visible: boolean
  tone: SaveBarTone
  message: string
  actions: boolean
}

function saveBarView(state: SettingsPageState, savedVisible: boolean, t: Translate<SettingsCommandCodeKey>): SaveBarView {
  const notice = settingsWriteNotice(state.saveResult, t)
  if (notice) return { visible: true, tone: state.failed ? 'error' : 'pending', message: notice, actions: state.dirty || state.failed }
  if (state.failed) return { visible: true, tone: 'error', message: t('saveFailed'), actions: state.dirty || state.failed }
  if (state.dirty || state.saving) {
    return state.invalid
      ? { visible: true, tone: 'error', message: t('saveInvalid'), actions: true }
      : { visible: true, tone: 'pending', message: t('unsavedChanges'), actions: true }
  }
  if (savedVisible) return { visible: true, tone: 'success', message: t('saved'), actions: false }
  return { visible: false, tone: 'success', message: '', actions: false }
}

/**
 * Native `SettingsForm`-aligned sticky footer bar using `StateDot` and `Button`
 * (`md`: H36/R12) instead of a custom floating capsule bar.
 */
function SaveFooter({ view, state, t, onDiscard, onSave, onLocate }: {
  view: SaveBarView
  state: SettingsPageState
  t: Translate<SettingsCommandCodeKey>
  onDiscard(): void
  onSave(): void
  onLocate(): void
}) {
  if (!view.visible) return null
  const dotState: StateDotState = state.saving
    ? 'ongoing'
    : view.tone === 'error'
      ? 'error'
      : view.tone === 'success'
        ? 'done'
        : 'warning'
  return (
    <div className="cc-saveFooter" role="region" aria-label={t('save')}>
      <span className="cc-saveStatus">
        <StateDot state={dotState} />
        <p className={view.tone === 'error' ? 'cc-saveText cc-saveTextError' : 'cc-saveText'} role="status" aria-live="polite" title={view.message}>
          {view.message}
        </p>
      </span>
      {view.actions ? (
        <div className="cc-saveActions">
          {state.invalid ? (
            <Button variant="ghost" size="md" className="cc-press" onClick={onLocate}>
              {t('saveLocate')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="md"
            className="cc-press"
            disabled={(!state.dirty && !state.failed) || state.saving}
            onClick={onDiscard}
          >
            {t('discard')}
          </Button>
          <Button
            variant="primary"
            size="md"
            className="cc-press"
            disabled={!state.dirty || state.invalid || state.saving}
            onClick={onSave}
          >
            {t(state.saving ? 'saving' : 'save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** The settings page body (Variant A): native header + 4 flat groups + sticky `SettingsForm` footer. */
export function CommandCodeSettingsPage(props: CommandCodeSettingsProps) {
  const { t } = props
  const state = props.useCommandCodeSettings((snapshot) => snapshot)
  const usage = props.useCommandCodeUsage((snapshot) => snapshot)
  const login = props.useCommandCodeLogin((snapshot) => snapshot)
  const disabled = !state.writable
  const savedVisible = useSavedFlash(state.savedCount)
  const updateVersion = usePluginUpdate()
  const {
    renameAccount, removeAccount, retryCredentialCleanup, setAccountKey, clearAccountKey,
    setActiveAccount, setAccountModels, beginLogin, cancelLogin, refreshCredentials,
  } = props
  const actions = useMemo<AccountActions>(() => ({
    rename: renameAccount,
    remove: removeAccount,
    cleanup: retryCredentialCleanup,
    refreshCredentials,
    setKey: setAccountKey,
    clearKey: clearAccountKey,
    setActive: setActiveAccount,
    setModels: setAccountModels,
    beginLogin,
    cancelLogin,
  }), [renameAccount, removeAccount, retryCredentialCleanup, setAccountKey, clearAccountKey, setActiveAccount, setAccountModels, beginLogin, cancelLogin, refreshCredentials])
  const bar = saveBarView(state, savedVisible, t)
  const form = { state, disabled, t, onEdit: props.edit, onReset: props.resetField }
  const status = useServiceStatus(props.probeService)
  const [fold, setFold] = useGroupFold()
  const foldProps = (group: FoldGroup) => ({ expanded: fold[group], onToggle: () => setFold({ ...fold, [group]: !fold[group] }) })
  const sectionRef = useRef<HTMLElement>(null)
  const [locateTick, setLocateTick] = useState(0)
  useEffect(() => {
    if (locateTick === 0) return
    const target = sectionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (target === null || target === undefined) return
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
  }, [locateTick])
  const locate = () => {
    setFold(expandGroups(fold, invalidGroups(state)))
    setLocateTick((tick) => tick + 1)
  }
  return (
    <section ref={sectionRef} className="cc-section" aria-label={t('title')}>
      <div className="cc-header">
        <div className="cc-titleRow">
          <h2 className="cc-title">{t('title')}</h2>
          {updateVersion !== undefined ? (
            <a
              className="cc-versionLink"
              href={PLUGIN_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              title={t('updateHint')}
            >
              <Tag tone="warning">v{updateVersion} {t('updateAvailable')}</Tag>
            </a>
          ) : (
            <Tag tone="neutral">v{PLUGIN_VERSION}</Tag>
          )}
        </div>
      </div>
      {!state.writable ? <Notice icon="lock"><p>{t('readOnly')}</p></Notice> : null}
      <AccountsCard
        t={t}
        state={state}
        usage={usage}
        login={login}
        disabled={disabled}
        actions={actions}
        onRefresh={props.refreshUsage}
        onRefreshAuto={props.refreshUsageAuto}
        openAnalytics={props.openAnalytics}
        createEnrollment={props.createEnrollment}
        {...foldProps('accounts')}
      />
      <ModelsCard
        {...form}
        {...foldProps('models')}
        onSelect={props.editVisibleModels}
        onClear={props.clearVisibleModels}
        onOverrides={props.editContextWindowOverrides}
        onNames={props.editModelNames}
      />
      <IntegrationsCard {...form} {...foldProps('integrations')} status={status.snapshot} probe={status.probe} onRetryProbe={status.retry} />
      <AdvancedSection {...form} {...foldProps('advanced')} />
      <SaveFooter view={bar} state={state} t={t} onDiscard={props.discard} onSave={props.save} onLocate={locate} />
    </section>
  )
}
