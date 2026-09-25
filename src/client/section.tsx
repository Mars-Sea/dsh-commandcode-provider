/**
 * React component for the "Command Code" settings page (browser half).
 *
 * Renders as a `settings.section` entry — a page at the same settings-nav
 * level as General / Models / Plugins. The shell supplies the nav row and
 * renders this body inside the content column. All copy comes from the
 * `settings.commandcode` locale namespace; all state comes from the
 * `CommandCodeSettingsController` injected by the slot registration.
 *
 * Layout, top to bottom:
 *   1. Accounts — one card per account with its status, quota, actions and
 *      dedicated models. Every account operation commits immediately.
 *   2. Models — the plan filter and the visible-model allowlist.
 *   3. Privacy & security — zero data retention and the command guard.
 *   4. Integrations & display — web search and the sidebar quota card.
 *   5. Advanced (collapsed) — API base and the network limits.
 * Sections 2–5 are flat groups of rows (title and description left, control
 * right, as on the harness's own settings pages), a staged form written by
 * the floating save bar.
 *
 * Styles are injected once by the client entry (see src/client/index.ts) and
 * class-prefixed `cc-` to stay local.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeCredits } from '../adapter.ts'
import type { CommandCodeAccountUsage, CommandCodeUsageReport } from '../usage-wire.ts'
import type { SettingsCommandCodeKey } from './locales.ts'
import type { CatalogModelOption, SettingsPageState, StagedField } from './settings.ts'
import { COMMAND_GUARD_DEFAULT_LEVEL_CHOICE } from './settings.ts'
import type { LoginPageState } from './login.ts'
import { loginHint, loginStateForTarget } from './login.ts'
import { buildModelSelectOptions, catalogIsReady, groupModelSelectOptions, staleModelIds, tierHeadingFor, toggleModelSelection } from './model-select.ts'
import type { UsagePageState } from './usage.ts'
import { usageCardState, formatMoney, formatMoneyExact, formatResetAt, formatSuccessRate, formatTokensCompact, windowRatio } from './usage.ts'
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
  beginLogin(targetRef?: string): void
  cancelLogin(): void
  createAccount(input: { label: string; key?: string }): Promise<string | undefined>
  renameAccount(ref: string, label: string): Promise<boolean>
  removeAccount(ref: string): Promise<boolean>
  setAccountKey(target: string, key: string): Promise<boolean>
  clearAccountKey(target: string): Promise<boolean>
  setActiveAccount(id: string): Promise<boolean>
  setAccountModels(target: string, ids: string[]): Promise<boolean>
  editVisibleModels(ids: string[]): void
  clearVisibleModels(): void
}

/** The section fields folded into the collapsible Advanced card. */
type AdvancedField = 'apiBase' | 'requestTimeoutMs' | 'streamIdleTimeoutMs' | 'transportMaxRetries'
const ADVANCED_FIELDS: readonly AdvancedField[] = [
  'apiBase',
  'requestTimeoutMs',
  'streamIdleTimeoutMs',
  'transportMaxRetries',
]

/** The "customized" tag and reset link a staged field shows once it differs from the default. */
function FieldOverride({ label, state, disabled, t, onReset }: {
  label: string
  state: StagedField
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onReset(): void
}) {
  if (!state.overridden && !state.clear) return null
  return (
    <button type="button" className="cc-linkButton" disabled={disabled} onClick={onReset} aria-label={`${label} — ${t('reset')}`}>
      {t('reset')}
    </button>
  )
}

/**
 * One settings row, laid out like the harness's own General page: the title
 * and description on the left, the control on the right, a hairline between
 * rows.
 */
function SettingRow({ title, titleFor, titleId, tag, description, error, control, className }: {
  title: string
  /** Makes the title a `<label>` for this control id. */
  titleFor?: string
  titleId?: string
  tag?: ReactNode
  description?: ReactNode
  /** Replaces the description while set. */
  error?: string | undefined
  control?: ReactNode
  className?: string
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

/** The tag a row title carries while its field overrides the default. */
function OverrideTag({ state, t }: { state: StagedField; t: Translate<SettingsCommandCodeKey> }) {
  return state.overridden ? <span className="cc-badge">{t('overridden')}</span> : null
}

/** One text/number field row. */
function Field({
  id,
  label,
  hint,
  state,
  disabled,
  numeric,
  wide,
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
  /** A wider input for URLs. */
  wide?: boolean
  placeholder?: string | undefined
  onEdit(text: string): void
  onReset(): void
  t: Translate<SettingsCommandCodeKey>
}) {
  return (
    <SettingRow
      title={label}
      titleFor={id}
      tag={<OverrideTag state={state} t={t} />}
      description={hint}
      error={state.invalid ? invalidCopy(state.invalidReason, t) : undefined}
      control={
        <>
          <FieldOverride label={label} state={state} disabled={disabled} t={t} onReset={onReset} />
          <input
            id={id}
            className={`cc-input ${wide ? 'cc-rowInputWide' : 'cc-rowInput'}${state.invalid ? ' cc-inputInvalid' : ''}`}
            type="text"
            inputMode={numeric ? 'numeric' : undefined}
            aria-invalid={state.invalid || undefined}
            value={state.text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => onEdit(event.target.value)}
          />
        </>
      }
    />
  )
}

/** The per-field error copy for a staged draft's failure reason. */
function invalidCopy(reason: StagedField['invalidReason'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'tooSmall') return t('numberTooSmall')
  if (reason === 'tooLarge') return t('numberTooLarge')
  return t('invalidNumber')
}

/**
 * One boolean field row rendered as a switch. The staged text is `'true'` /
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
    <SettingRow
      title={label}
      titleFor={id}
      tag={<OverrideTag state={state} t={t} />}
      description={hint}
      control={
        <>
          <FieldOverride label={label} state={state} disabled={disabled} t={t} onReset={onReset} />
          <input
            id={id}
            className="cc-toggle"
            type="checkbox"
            role="switch"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onEdit(event.target.checked ? 'true' : 'false')}
          />
        </>
      }
    />
  )
}

/**
 * One fixed-choice field rendered as a segmented control. The staged text is
 * one of `options`' values or `''` (unset → `defaultValue`); picking the
 * default while unset stages nothing new.
 */
function SegmentedField({
  label,
  hint,
  state,
  disabled,
  options,
  defaultValue,
  className,
  onEdit,
  onReset,
  t,
}: {
  label: string
  hint: string
  state: StagedField
  disabled: boolean
  options: ReadonlyArray<{ value: string; label: string }>
  defaultValue: string
  className?: string
  onEdit(text: string): void
  onReset(): void
  t: Translate<SettingsCommandCodeKey>
}) {
  const current = state.text === '' ? defaultValue : state.text
  const index = Math.max(0, options.findIndex((option) => option.value === current))
  return (
    <SettingRow
      title={label}
      tag={<OverrideTag state={state} t={t} />}
      description={hint}
      {...(className === undefined ? {} : { className })}
      control={
        <>
          <FieldOverride label={label} state={state} disabled={disabled} t={t} onReset={onReset} />
          {/* The indicator is placed arithmetically from the count and the
              picked index (the platform SegmentedControl's technique), so it
              can slide without measuring the DOM. */}
          <div
            className="cc-segmented"
            role="radiogroup"
            aria-label={label}
            style={{ '--cc-segment-count': options.length, '--cc-segment-index': index } as CSSProperties}
          >
            <span className="cc-segmentIndicator" aria-hidden="true" />
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={current === option.value}
                className="cc-segment"
                disabled={disabled}
                onClick={() => {
                  if (current !== option.value) onEdit(option.value)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      }
    />
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
  limit,
  t,
}: {
  label: string
  limit: NonNullable<CommandCodeCredits['fiveHour']>
  t: Translate<SettingsCommandCodeKey>
}) {
  const { used, cap, exceeded, resetAt } = limit
  const ratio = windowRatio(used, cap)
  const reset = formatResetAt(resetAt)
  return (
    <div className="cc-usageWindow">
      <div className="cc-usageWindowHead">
        <span className="cc-usageWindowLabel">{label}</span>
        {exceeded ? <span className="cc-usageExceeded">{t('usageExceeded')}</span> : null}
        <span className="cc-usageWindowValue">{cap > 0 ? `${formatMoney(used)} / ${formatMoney(cap)}` : formatMoney(used)}</span>
      </div>
      <div className="cc-usageBar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <div className={exceeded ? 'cc-usageBarFill cc-usageBarFillWarn' : 'cc-usageBarFill'} style={{ width: `${ratio * 100}%` }} />
      </div>
      {reset !== '' ? <p className="cc-usageWindowReset">{t('usageReset')} {reset}</p> : null}
    </div>
  )
}

/**
 * One pool account's facts (identity, totals, credits, window limits)
 * rendered inside an account row's details.
 */
function AccountReport({ entry, fetchedAt, t, summaryOnly = false, headless = false }: {
  entry: CommandCodeAccountUsage
  /**
   * When the shared usage snapshot was fetched — shares the account's bottom
   * meta row with the billing period end so the two timestamps occupy one
   * line (period/partial facts left, fetch freshness right).
   */
  fetchedAt?: number | undefined
  t: Translate<SettingsCommandCodeKey>
  /** Collapsed card mode: identity, errors and quota windows without the stat grids. */
  summaryOnly?: boolean
  /** Omit the identity header (the account row already shows it). */
  headless?: boolean
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
      {!headless ? (
        <div className="cc-usageHead">
          <h4 className="cc-usageTitle">{entry.label}</h4>
          {accountName !== '' ? <span className="cc-usageAccount">{accountName}</span> : null}
          {planName !== '' ? <span className="cc-usagePlan">{planName}</span> : null}
        </div>
      ) : null}
      {planStatus !== '' ? <p className="cc-usagePlanStatus">{planStatus}</p> : null}

      {!entry.configured ? <p className="cc-usageHint">{t('usageUnconfigured')}</p> : null}

      {report.blocked !== undefined ? (
        <div className="cc-usageBlocked" role="alert">
          <p className="cc-usageBlockedTitle">{blockedTitle(report.blocked, t)}</p>
          <p className="cc-usageBlockedHint">{blockedHint(report.blocked, t)}</p>
          {/* Keep the per-endpoint failures visible alongside the summary:
              they carry the actual status or transport error for diagnosis. */}
          {report.failures.length > 0 ? (
            <p className="cc-usageBlockedDetail" title={report.failures.join('; ')}>
              {report.failures.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {!summaryOnly && report.usage !== undefined ? (
        <div className="cc-usageStats cc-usageStatsActivity">
          <UsageStat
            label={t('usageRequests')}
            value={String(report.usage.completedCount)}
            sub={`${t('usageFailed')} ${report.usage.failedCount}`}
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

      {!summaryOnly && credits !== undefined ? (
        <div className="cc-usageStats cc-usageStatsBalance">
          <UsageStat label={t('usageMonthly')} value={credits.monthlyReported === false ? '—' : formatMoney(credits.monthlyCredits)} />
          <UsageStat label={t('usagePurchased')} value={credits.purchasedReported === false ? '—' : formatMoney(credits.purchasedCredits)} />
          <UsageStat label={t('usageFree')} value={credits.freeReported === false ? '—' : formatMoney(credits.freeCredits)} />
        </div>
      ) : null}

      {credits?.fiveHour !== undefined || credits?.weekly !== undefined ? (
        <div className="cc-usageWindows">
          {credits.fiveHour !== undefined ? (
            <UsageWindow label={t('usageFiveHour')} limit={credits.fiveHour} t={t} />
          ) : null}
          {credits.weekly !== undefined ? (
            <UsageWindow label={t('usageWeekly')} limit={credits.weekly} t={t} />
          ) : null}
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
  if (reason === 'invalid-response') return t('usageInvalidResponse')
  return t('usageNetworkError')
}

/** The actionable hint under a blocked report's headline. */
function blockedHint(reason: CommandCodeUsageReport['blocked'], t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'invalid-key') return t('usageKeyInvalidHint')
  if (reason === 'service-unavailable') return t('usageServiceUnavailableHint')
  if (reason === 'invalid-response') return t('usageInvalidResponseHint')
  return t('usageNetworkHint')
}

/**
 * A checkbox multi-select dropdown for picking catalog models (the
 * routing-rule rows and the visible-models filter share it). The trigger
 * shows the selection count; the Menu lists every catalog model with a
 * checkbox, toggled by clicking the row. A search box under the trigger
 * (inside the Menu anchor, so focusing it never trips the outside-click
 * close) filters the list by id/display-name substring, and items group
 * under plan-tier headings in picker order. Selected ids the catalog no
 * longer carries still render — flagged stale — so a saved selection never
 * silently loses an entry, and the VisibleModelsCard offers a one-click
 * cleanup.
 *
 * With `deferCommit` the toggles collect in a local draft that is handed to
 * `onSelect` once, when the menu closes: the per-account picker writes
 * immediately, and one write per click would be a burst of document writes.
 */
function ModelMultiSelect({ id, selected: committed, catalog, disabled, deferCommit = false, ownerOf, t, onSelect }: {
  id: string
  selected: string[]
  catalog: CatalogModelOption[]
  disabled: boolean
  deferCommit?: boolean
  /** Names the other account a model currently belongs to, if any. */
  ownerOf?: (modelId: string) => string | undefined
  t: Translate<SettingsCommandCodeKey>
  onSelect(ids: string[]): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string[] | undefined>(undefined)
  const selected = draft ?? committed
  // The search box must not inherit a stale query from a previous open.
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
  // Tier headings come from the catalog entries themselves (the Host stamps
  // each entry's plan-tier key on the Remote); rebuild only when the catalog
  // changes.
  const tiers = useMemo(
    () => Object.fromEntries(
      catalog.flatMap((model) => model.tier === undefined ? [] : [[model.id, model.tier] as const]),
    ),
    [catalog],
  )
  // The catalog is sorted for picking; append any selected ids the catalog no
  // longer carries (removed upstream) so the current selection stays visible.
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
          {option.stale ? <span className="cc-badge">{t('modelStale')}</span> : null}
          {!selected.includes(option.value) && ownerOf?.(option.value) !== undefined ? (
            <span className="cc-badgeMuted">{t('accountModelOwner', { name: ownerOf(option.value)! })}</span>
          ) : null}
        </span>
      ),
    })),
  ])
  // The search box lives INSIDE the Menu anchor (which renders in place
  // inside the Menu's root span): a pointerdown there counts as "inside",
  // so focusing/typing never trips the Menu's outside-click close. A box
  // rendered as a sibling would close the Menu on the first click.
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
            <span className="cc-selectorCaret" aria-hidden="true" />
          </button>
          {open ? (
            <input
              type="search"
              className="cc-input cc-modelSearch"
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

/** The visible-model filter row: an allowlist over the catalog. Empty = show all. */
function VisibleModelsRow({ t, state, disabled, onSelect, onClear }: {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  disabled: boolean
  onSelect(ids: string[]): void
  onClear(): void
}) {
  const count = state.visibleModels.length
  const pickT: Translate<SettingsCommandCodeKey> = (key, params) => {
    if (key === 'modelPick') return t('visibleModelsPick')
    if (key === 'modelCount') return t('visibleModelsCount', params)
    return t(key, params)
  }
  // Selected ids the live catalog no longer carries (retired upstream):
  // kept, flagged stale in the dropdown, removable in one click. Never
  // auto-dropped — an empty catalog (fetch failure) must not wipe the list.
  // "Stale" is only meaningful against a catalog we actually hold, so both the
  // cleanup button and its hint are gated on catalogIsReady: before the first
  // fetch lands (and after a failure) the empty catalog makes every selection
  // look retired, turning the one-click cleanup into a button that silently
  // empties the allowlist. The explicit "show all" entry stays available
  // either way — clearing the list is then the user's stated intent rather
  // than an inference from missing data.
  const readiness = { catalogIds: state.catalogModels.map((model) => model.id), catalogFailed: state.catalogFailed }
  const staleIds = staleModelIds(state.visibleModels, readiness)
  const catalogReady = catalogIsReady(readiness)
  return (
    <SettingRow
      title={t('visibleModelsTitle')}
      titleFor="cc-visible-models"
      description={
        <>
          <p>{t('visibleModelsHint')}</p>
          {staleIds.length > 0 && catalogReady ? <p>{t('visibleModelsStaleHint', { count: staleIds.length })}</p> : null}
        </>
      }
      error={state.catalogFailed ? t('modelCatalogFailed') : undefined}
      control={
        <>
          {catalogReady && staleIds.length > 0 ? (
            <button
              type="button"
              className="cc-linkButton"
              disabled={disabled}
              onClick={() => onSelect(state.visibleModels.filter((id) => !staleIds.includes(id)))}
            >
              {t('visibleModelsCleanStale', { count: staleIds.length })}
            </button>
          ) : null}
          {count > 0 ? (
            <button type="button" className="cc-linkButton" disabled={disabled} onClick={onClear}>
              {t('visibleModelsShowAll')}
            </button>
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
 * One titled group of rows. No card surface: like the harness's own settings
 * pages, a group is a heading over hairline-separated rows.
 */
function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="cc-group" aria-label={title}>
      <div className="cc-groupHead">
        <h3 className="cc-groupTitle">{title}</h3>
        {action}
      </div>
      <div className="cc-rows">{children}</div>
    </section>
  )
}

/** The staged-field callbacks every form card shares. */
interface FormCardProps {
  state: SettingsPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onEdit(field: string, text: string): void
  onReset(field: string): void
}

/**
 * Models: the plan filter and the allowlist sit together because both decide
 * what the model picker lists (the allowlist applies after the plan filter).
 */
function ModelsCard({ state, disabled, t, onEdit, onReset, onSelect, onClear }: FormCardProps & {
  onSelect(ids: string[]): void
  onClear(): void
}) {
  return (
    <SettingsGroup title={t('modelsTitle')}>
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
      <VisibleModelsRow t={t} state={state} disabled={disabled} onSelect={onSelect} onClear={onClear} />
    </SettingsGroup>
  )
}

/**
 * Privacy & security: the two opt-ins that change where data goes. ZDR
 * restricts which upstream serves a request; the command guard sends command
 * text to a decision model with no ZDR upstream and can skip an approval the
 * user would otherwise have seen, so both start off.
 */
function PrivacyCard({ state, disabled, t, onEdit, onReset }: FormCardProps) {
  // Keep a customized level visible even after the staged guard switch is
  // turned off, otherwise a pending edit would disappear from the page while
  // still participating in Save.
  const showGuardLevel = state.commandGuard.text === 'true'
    || state.commandGuardLevel.overridden
    || state.commandGuardLevel.clear
  return (
    <SettingsGroup title={t('privacyTitle')}>
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
        id="cc-command-guard"
        label={t('commandGuard')}
        hint={t('commandGuardHint')}
        state={state.commandGuard}
        disabled={disabled}
        defaultChecked={false}
        onEdit={(text) => onEdit('commandGuard', text)}
        onReset={() => onReset('commandGuard')}
        t={t}
      />
      {showGuardLevel ? (
          <SegmentedField
            className="cc-rowNested"
            label={t('commandGuardLevel')}
            hint={t('commandGuardLevelHint')}
            state={state.commandGuardLevel}
            disabled={disabled}
            options={[
              { value: 'high', label: t('commandGuardLevelHigh') },
              { value: 'medium', label: t('commandGuardLevelMedium') },
              { value: 'low', label: t('commandGuardLevelLow') },
            ]}
            defaultValue={COMMAND_GUARD_DEFAULT_LEVEL_CHOICE}
            onEdit={(text) => onEdit('commandGuardLevel', text)}
            onReset={() => onReset('commandGuardLevel')}
            t={t}
          />
      ) : null}
    </SettingsGroup>
  )
}

/** Integrations & display: surfaces outside chat that reuse this provider. */
function IntegrationsCard({ state, disabled, t, onEdit, onReset }: FormCardProps) {
  return (
    <SettingsGroup title={t('integrationsTitle')}>
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
      {/* Opt-in, and off by default: the sidebar quota card is a display
          surface, so an unset document shows nothing on the left. */}
      <ToggleField
        id="cc-show-sidebar-quota"
        label={t('showSidebarQuota')}
        hint={t('showSidebarQuotaHint')}
        state={state.showSidebarQuota}
        disabled={disabled}
        defaultChecked={false}
        onEdit={(text) => onEdit('showSidebarQuota', text)}
        onReset={() => onReset('showSidebarQuota')}
        t={t}
      />
    </SettingsGroup>
  )
}

/**
 * The collapsed "Advanced" card: the API base and the network limits. Starts
 * collapsed on every visit; while collapsed, a badge names the customized
 * count and an invalid number (which blocks save) is surfaced on the header.
 */
function AdvancedSection({ state, disabled, t, onEdit, onReset }: FormCardProps) {
  const [expanded, setExpanded] = useState(false)
  const overridden = ADVANCED_FIELDS.filter((field) => state[field].overridden).length
  const invalid = ADVANCED_FIELDS.some((field) => state[field].invalid)
  return (
    <section className="cc-group" aria-label={t('advancedSettings')}>
      <button
        type="button"
        className="cc-groupHead cc-disclosure"
        aria-expanded={expanded}
        aria-controls="cc-advanced-body"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="cc-groupTitle">{t('advancedSettings')}</span>
        {overridden > 0 ? (
          <span className="cc-badge">
            {overridden === 1 ? t('advancedOverriddenOne') : t('advancedOverriddenMany', { count: overridden })}
          </span>
        ) : null}
        {!expanded && invalid ? (
          <span className="cc-badge cc-badgeWarn">{t('advancedInvalid')}</span>
        ) : null}
        <span className="cc-spacer" />
        <span className={expanded ? 'cc-chevron cc-chevronUp' : 'cc-chevron'} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id="cc-advanced-body" className="cc-rows">
          <p className="cc-groupDesc">{t('advancedSettingsHint')}</p>
          <Field
            id="cc-api-base"
            label={t('apiBase')}
            hint={t('apiBaseHint')}
            state={state.apiBase}
            disabled={disabled}
            wide
            onEdit={(text) => onEdit('apiBase', text)}
            onReset={() => onReset('apiBase')}
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
          <Field
            id="cc-transport-max-retries"
            label={t('transportMaxRetries')}
            hint={t('transportMaxRetriesHint')}
            state={state.transportMaxRetries}
            disabled={disabled}
            numeric
            onEdit={(text) => onEdit('transportMaxRetries', text)}
            onReset={() => onReset('transportMaxRetries')}
            t={t}
          />
        </div>
      ) : null}
      {expanded && invalid ? (
        <p className="cc-rowError" role="status">{t('advancedInvalid')}</p>
      ) : null}
    </section>
  )
}

/** One row of the unified account list: a stored account merged with its usage entry. */
interface AccountRowModel {
  /** Slot id: `default` or the extra account's credential reference. */
  id: string
  label: string
  /** Credential reference for extra accounts; undefined for the default slot. */
  ref: string | undefined
  isDefault: boolean
  /** Whether this page can manage the row (false for literal-only composition entries). */
  managed: boolean
  /** Whether a key resolves for this account (stored credential or a Host-side source). */
  configured: boolean
  /** Whether a stored credential exists this page could delete. */
  storedKey: boolean
  keyWritable: boolean
  usage: CommandCodeAccountUsage | undefined
}

/**
 * Merge the controller's accounts with the usage report. The default slot is
 * always first; report entries this page cannot manage (literal keys from the
 * composition config) still render, read-only, so the list names every
 * account the pool rotates through.
 */
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
      keyWritable: false,
      usage: entry,
    })
  }
  return rows
}

/** The row's status dot: error for a rejected key, warning while cooling down. */
function statusDotClass(row: AccountRowModel): string {
  const entry = row.usage
  if (!row.configured || entry?.mark === 'invalid-credential') return 'cc-tabDot cc-tabDotError'
  if (entry !== undefined && (entry.mark !== '' || entry.cooldownUntil > 0)) return 'cc-tabDot cc-tabDotWarn'
  return 'cc-tabDot cc-tabDotOk'
}

/** One compact quota meter for a row's summary line. */
function MiniMeter({ label, limit }: { label: string; limit: NonNullable<CommandCodeCredits['fiveHour']> }) {
  const ratio = windowRatio(limit.used, limit.cap)
  const percent = limit.cap > 0 ? `${Math.round(ratio * 100)}%` : formatMoney(limit.used)
  return (
    <span className="cc-miniMeter" title={limit.cap > 0 ? `${formatMoney(limit.used)} / ${formatMoney(limit.cap)}` : undefined}>
      <span className="cc-miniMeterLabel">{label}</span>
      <span className="cc-miniMeterTrack" aria-hidden="true">
        <span className={limit.exceeded ? 'cc-miniMeterFill cc-usageBarFillWarn' : 'cc-miniMeterFill'} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="cc-miniMeterValue">{percent}</span>
    </span>
  )
}

/**
 * The monthly credit balance for a row's summary line: the billing endpoint's
 * `monthlyCredits` is what is LEFT, shown as the amount alone.
 */
function MonthlyBalance({ label, remaining }: { label: string; remaining: number }) {
  return (
    <span className="cc-miniMeter">
      <span className="cc-miniMeterLabel">{label}</span>
      <span className="cc-miniMeterValue">{formatMoney(Math.max(0, remaining))}</span>
    </span>
  )
}

/** A single-input inline form (paste key, rename) with confirm/cancel. */
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
      <input
        id={id}
        className="cc-input"
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
          <button type="button" className="cc-reset" onClick={() => setVisible((shown) => !shown)}>
            {visible ? t('hide') : t('show')}
          </button>
        ) : null}
        <span className="cc-spacer" />
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" type="submit" disabled={!ready || disabled}>{confirmLabel}</Button>
      </div>
    </form>
  )
}

/** A destructive confirmation bar shown in place of a menu action. */
function ConfirmBar({ text, confirmLabel, disabled, t, onConfirm, onCancel }: {
  text: string
  confirmLabel: string
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onConfirm(): void
  onCancel(): void
}) {
  return (
    <div className="cc-confirmBar" role="alertdialog" aria-label={text}>
      <p className="cc-confirmText">{text}</p>
      <div className="cc-inlineActions">
        <span className="cc-spacer" />
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="outline" size="sm" className="cc-dangerButton" disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  )
}

type RowMode = 'key' | 'rename' | 'remove' | 'clearKey' | undefined

/** One account row: identity, status, quota summary, actions and expandable details. */
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
  // Only an explicit `false` means the balance was omitted (an older Host
  // never sends the flag and always sent a real number).
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

  return (
    <div className={row.usage?.active ? 'cc-accountItem cc-accountItemActive' : 'cc-accountItem'}>
      <div className="cc-accountHead">
        <button
          type="button"
          className="cc-accountToggle"
          aria-expanded={expanded}
          aria-controls={`cc-account-${row.id}-details`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={statusDotClass(row)} aria-hidden="true" />
          <span className="cc-accountName">{row.label}</span>
          {accountName !== '' && accountName !== row.label ? <span className="cc-usageAccount">{accountName}</span> : null}
          {planName !== '' ? <span className="cc-usagePlan">{planName}</span> : null}
          {entry?.active && multi ? <span className="cc-badge">{t('usageActive')}</span> : null}
          {pinned ? <span className="cc-badge">{t('accountStatusPinned')}</span> : null}
          {!row.configured ? <span className="cc-badgeMuted">{t('apiKeyUnset')}</span> : null}
          {entry?.mark === 'invalid-credential' ? <span className="cc-usagePlanStatus">{t('usageInvalidKey')}</span> : null}
          {entry !== undefined && entry.mark !== 'invalid-credential' && (entry.cooldownUntil > 0 || entry.mark === 'rate-limit') ? (
            <span className="cc-usagePlanStatus">
              {t('usageCooldown')}{entry.cooldownUntil > 0 ? ` ${formatResetAt(entry.cooldownUntil)}` : ''}
            </span>
          ) : null}
          <span className="cc-spacer" />
          <span className={expanded ? 'cc-chevron cc-chevronUp' : 'cc-chevron'} aria-hidden="true" />
        </button>
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
                <span className="cc-kebab" aria-hidden="true" />
              </button>
            }
          />
        ) : null}
      </div>

      {credits !== undefined && (credits.fiveHour !== undefined || credits.weekly !== undefined || monthlyReported) ? (
        <div className="cc-accountMeters">
          {credits.fiveHour !== undefined ? <MiniMeter label={t('usageFiveHour')} limit={credits.fiveHour} /> : null}
          {credits.weekly !== undefined ? <MiniMeter label={t('usageWeekly')} limit={credits.weekly} /> : null}
          {monthlyReported ? (
            <MonthlyBalance label={t('usageMonthlyLeft')} remaining={credits.monthlyCredits} />
          ) : null}
        </div>
      ) : null}

      {!row.configured && row.managed && mode === undefined && !showLogin ? (
        <div className="cc-accountSetup">
          <p className="cc-hint">{row.keyWritable ? t('accountNoKeyHint') : t('apiKeyLocked')}</p>
          {keyActions ? (
            <div className="cc-inlineActions">
              <Button variant="primary" size="sm" disabled={loginBusy || busyElsewhere} onClick={() => actions.beginLogin(loginTarget)}>
                {t('accountAddLogin')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('key')}>{t('accountAddPaste')}</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {showLogin ? <LoginStatus state={loginState} t={t} onCancel={actions.cancelLogin} /> : null}

      {mode === 'key' ? (
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
      ) : null}
      {mode === 'rename' && row.ref !== undefined ? (
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
      ) : null}
      {mode === 'remove' && row.ref !== undefined ? (
        <ConfirmBar
          text={t('accountRemoveConfirm', { name: row.label })}
          confirmLabel={t('accountConfirmRemove')}
          disabled={disabled || state.accountBusy}
          t={t}
          onCancel={() => setMode(undefined)}
          onConfirm={() => {
            void actions.remove(row.ref!).then((ok) => {
              if (ok) setMode(undefined)
            })
          }}
        />
      ) : null}
      {mode === 'clearKey' ? (
        <ConfirmBar
          text={t('accountClearKeyConfirm')}
          confirmLabel={t('accountConfirmClear')}
          disabled={disabled || state.accountBusy}
          t={t}
          onCancel={() => setMode(undefined)}
          onConfirm={() => {
            void actions.clearKey(row.id).then((ok) => {
              if (ok) setMode(undefined)
            })
          }}
        />
      ) : null}

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
              description={t('accountModelsHint')}
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

/** The live status of one browser sign-in: link while waiting, outcome after. */
function LoginStatus({ state, t, onCancel }: {
  state: LoginPageState
  t: Translate<SettingsCommandCodeKey>
  onCancel(): void
}) {
  const hint = loginHint(state, t)
  const busy = state.phase === 'starting' || state.phase === 'waiting'
  return (
    <div className="cc-loginStatus" role="status">
      <p className={hint.className} title={hint.title}>{hint.text}</p>
      {state.authUrl !== undefined ? (
        <a className="cc-loginLink" href={state.authUrl} target="_blank" rel="noreferrer">{t('loginOpenLink')}</a>
      ) : null}
      {busy ? <button type="button" className="cc-reset" onClick={onCancel}>{t('loginCancel')}</button> : null}
    </div>
  )
}

/** The immediate account operations the list and its rows call. */
interface AccountActions {
  create(input: { label: string; key?: string }): Promise<string | undefined>
  rename(ref: string, label: string): Promise<boolean>
  remove(ref: string): Promise<boolean>
  setKey(target: string, key: string): Promise<boolean>
  clearKey(target: string): Promise<boolean>
  setActive(id: string): Promise<boolean>
  setModels(target: string, ids: string[]): Promise<boolean>
  beginLogin(targetRef?: string): void
  cancelLogin(): void
}

/**
 * The add-account panel. Both paths store the account at once: pasting a key
 * writes key then row; browser sign-in stores a keyless row first (the Host
 * only signs in to a reference the stored list names) and drops it again if
 * the sign-in does not complete, so a failed attempt leaves no empty account.
 */
function AddAccountPanel({ state, login, disabled, t, actions, pendingRef, setPendingRef, onClose }: {
  state: SettingsPageState
  login: LoginPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  actions: AccountActions
  /** The account stored for an in-flight sign-in; its row stays hidden until the sign-in lands. */
  pendingRef: string | undefined
  setPendingRef(ref: string | undefined): void
  onClose(): void
}) {
  const [label, setLabel] = useState('')
  const [pasting, setPasting] = useState(false)
  const [loginFailure, setLoginFailure] = useState<string | undefined>(undefined)
  const fallbackName = t('accountNameN', { n: state.accounts.length + 2 })
  const pending = pendingRef === undefined ? undefined : loginStateForTarget(login, pendingRef).visible
  const busy = state.accountBusy || pending?.phase === 'starting' || pending?.phase === 'waiting'
  const loginBusyElsewhere = login.phase === 'starting' || login.phase === 'waiting'

  useEffect(() => {
    if (pendingRef === undefined || login.targetRef !== pendingRef) return
    if (login.phase === 'success') {
      const named = label.trim() === '' && login.userName !== undefined && login.userName !== ''
      setPendingRef(undefined)
      void (named ? actions.rename(pendingRef, login.userName!) : Promise.resolve(true)).then(onClose)
      return
    }
    if (login.phase === 'failed' || login.phase === 'unavailable') {
      setLoginFailure(loginHint(login, t).text)
      setPendingRef(undefined)
      void actions.remove(pendingRef)
    }
  }, [login, pendingRef, setPendingRef, label, actions, onClose, t])

  const startLogin = async () => {
    setLoginFailure(undefined)
    const ref = await actions.create({ label: label.trim() === '' ? fallbackName : label })
    if (ref === undefined) return
    setPendingRef(ref)
    actions.beginLogin(ref)
  }

  return (
    <div className="cc-addPanel" aria-label={t('accountAdd')}>
      <span className="cc-panelTitle">{t('accountAdd')}</span>
      <input
        className="cc-input"
        type="text"
        aria-label={t('accountNamePlaceholder')}
        placeholder={t('accountNamePlaceholder')}
        value={label}
        disabled={disabled || busy}
        onChange={(event) => setLabel(event.target.value)}
      />
      {pending !== undefined && pending.phase !== 'idle' ? (
        <LoginStatus state={pending} t={t} onCancel={actions.cancelLogin} />
      ) : null}
      {loginFailure !== undefined ? <p className="cc-loginError">{loginFailure}</p> : null}
      {pasting ? (
        <InlineInput
          id="cc-add-account-key"
          label={t('accountKeyPlaceholder')}
          secret
          placeholder={t('accountKeyPlaceholder')}
          confirmLabel={t('accountAddConfirm')}
          disabled={disabled || busy}
          t={t}
          onCancel={() => setPasting(false)}
          onSubmit={(key) => {
            void actions.create({ label: label.trim() === '' ? fallbackName : label, key }).then((ref) => {
              if (ref !== undefined) onClose()
            })
          }}
        />
      ) : (
        <>
          <p className="cc-hint">{t('accountAddHint')}</p>
          <div className="cc-inlineActions">
            <Button variant="primary" size="sm" disabled={disabled || busy || loginBusyElsewhere} onClick={() => void startLogin()}>
              {t('accountAddLogin')}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => setPasting(true)}>
              {t('accountAddPaste')}
            </Button>
            <span className="cc-spacer" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The unified account card: every account the pool rotates through, one row
 * each, with its status and quota inline. Replaces the former split between
 * a credentials card, a usage card and a routing-rules card, so one account's
 * facts no longer have to be cross-read across three surfaces.
 */
function AccountsCard({ t, state, usage, login, disabled, actions, onRefresh }: {
  t: Translate<SettingsCommandCodeKey>
  state: SettingsPageState
  usage: UsagePageState
  login: LoginPageState
  disabled: boolean
  actions: AccountActions
  onRefresh(): void
}) {
  const [adding, setAdding] = useState(false)
  const [pendingRef, setPendingRef] = useState<string | undefined>(undefined)
  const closeAdd = useCallback(() => setAdding(false), [])
  const { loading, shouldRefresh } = usageCardState(usage)
  // Ask the Host on first paint: CLI auth and composition keys are not
  // represented by browser credential references.
  useEffect(() => {
    if (shouldRefresh) onRefresh()
  }, [shouldRefresh, onRefresh])
  const rows = accountRows(state, usage, t).filter((row) => row.ref === undefined || row.ref !== pendingRef)
  const multi = rows.length > 1
  const pinnedRow = rows.find((row) => row.id === state.activeAccount)
  return (
    <section className="cc-group" aria-label={t('accountsTitle')}>
      <div className="cc-groupHead">
        <h3 className="cc-groupTitle">{t('accountsTitle')}</h3>
        <span className="cc-spacer" />
        <button type="button" className="cc-linkButton" disabled={loading} onClick={onRefresh}>
          {loading ? t('usageRefreshing') : t('usageRefresh')}
        </button>
      </div>
      <p className="cc-groupDesc">{multi ? t('accountsRotationHint') : t('accountsHint')}</p>
      {multi ? (
        <div className="cc-accountMode">
          <span>{pinnedRow !== undefined ? t('accountModePinned', { name: pinnedRow.label }) : t('accountModeAuto')}</span>
          {pinnedRow !== undefined ? (
            <button type="button" className="cc-reset" disabled={disabled || state.accountBusy} onClick={() => void actions.setActive('')}>
              {t('accountActionUnpin')}
            </button>
          ) : null}
        </div>
      ) : null}
      {usage.status === 'error' ? (
        <p className="cc-rowError" role="status">
          {t('usageError')}{usage.error !== undefined && usage.error !== '' ? ` — ${usage.error}` : ''}
        </p>
      ) : null}
      {state.accountFailed !== undefined ? <p className="cc-rowError" role="status">{t('accountOpFailed')}</p> : null}
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
          login={login}
          disabled={disabled}
          t={t}
          actions={actions}
          pendingRef={pendingRef}
          setPendingRef={setPendingRef}
          onClose={closeAdd}
        />
      ) : (
        <button type="button" className="cc-addButton" disabled={disabled} onClick={() => setAdding(true)}>
          <span className="cc-addGlyph" aria-hidden="true" />
          {t('accountAdd')}
        </button>
      )}
    </section>
  )
}

/**
 * Show the save bar's "saved" confirmation for a short window after each accepted save.
 * The controller only counts saves (`savedCount`); the flash timing lives
 * here so the state machine stays timer-free.
 */
function useSavedFlash(tick: number): boolean {
  const [visible, setVisible] = useState(false)
  // The count lives in the shared controller and outlives this component, so
  // a remount (switching settings pages, reopening settings) sees a non-zero
  // count it did not witness. Only a save landing while mounted may flash.
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

type SaveBarTone = 'pending' | 'error' | 'success'

interface SaveBarView {
  visible: boolean
  tone: SaveBarTone
  message: string
  /** Whether Discard/Save apply (hidden while only the saved confirmation shows). */
  actions: boolean
}

/**
 * What the save bar says. It exists only while there is something to act on
 * or to confirm: pending edits, a save in flight, a failure, or the brief
 * confirmation after a save landed. Account operations never reach it, they
 * commit on their own.
 */
function saveBarView(state: SettingsPageState, savedVisible: boolean, t: Translate<SettingsCommandCodeKey>): SaveBarView {
  if (state.failed) return { visible: true, tone: 'error', message: t('saveFailed'), actions: state.dirty }
  if (state.dirty || state.saving) {
    return state.invalid
      ? { visible: true, tone: 'error', message: t('saveInvalid'), actions: true }
      : { visible: true, tone: 'pending', message: t('unsavedChanges'), actions: true }
  }
  if (savedVisible) return { visible: true, tone: 'success', message: t('saved'), actions: false }
  return { visible: false, tone: 'success', message: '', actions: false }
}

/** The save bar's leading status mark: a soft dot while pending, a glyph once there is an outcome. */
function SaveBarIcon({ tone }: { tone: SaveBarTone }) {
  if (tone === 'pending') return <span className="cc-saveBarIcon" aria-hidden="true"><span className="cc-saveBarPulse" /></span>
  return (
    <span className="cc-saveBarIcon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.5" />
        {tone === 'success' ? <path d="M5.2 8.2l1.9 1.9 3.7-3.9" /> : <path d="M8 4.8v3.6M8 11.1v.1" />}
      </svg>
    </span>
  )
}

/**
 * The floating save bar: pinned to the bottom of the settings scrollport and
 * slid out of view when there is nothing to save. It stays mounted so it can
 * animate out, and keeps showing its last message while it does (the state
 * that hid it has no message of its own).
 */
function SaveBar({ view, state, t, onDiscard, onSave }: {
  view: SaveBarView
  state: SettingsPageState
  t: Translate<SettingsCommandCodeKey>
  onDiscard(): void
  onSave(): void
}) {
  const last = useRef(view)
  if (view.visible) last.current = view
  const shown = view.visible ? view : last.current
  return (
    <div className="cc-saveBarDock">
      <div
        className={`cc-saveBar cc-saveBar-${shown.tone}${view.visible ? ' cc-saveBarShown' : ''}`}
        role="region"
        aria-label={t('save')}
        aria-hidden={!view.visible}
      >
        <SaveBarIcon tone={shown.tone} />
        <p className="cc-saveBarText" role="status" aria-live="polite" title={shown.message}>{shown.message}</p>
        {shown.actions ? (
          <div className="cc-saveBarActions">
            {/* Own buttons rather than the primitives: they are sized to sit
                concentrically inside the bar (see .cc-saveBar). */}
            <button
              type="button"
              className="cc-saveBarButton cc-saveBarGhost"
              disabled={!view.visible || !state.dirty || state.saving}
              onClick={onDiscard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="cc-saveBarButton cc-saveBarPrimary"
              disabled={!view.visible || !state.dirty || state.invalid || state.saving}
              onClick={onSave}
            >
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The settings page body: accounts, then the staged provider settings. */
export function CommandCodeSettingsPage(props: CommandCodeSettingsProps) {
  const { t } = props
  const state = props.useCommandCodeSettings((snapshot) => snapshot)
  const usage = props.useCommandCodeUsage((snapshot) => snapshot)
  const login = props.useCommandCodeLogin((snapshot) => snapshot)
  const disabled = !state.writable
  const savedVisible = useSavedFlash(state.savedCount)
  const updateVersion = usePluginUpdate()
  // One stable object: the add panel's effect depends on it, and a fresh
  // object per render would re-run that effect on every store notification.
  const {
    createAccount, renameAccount, removeAccount, setAccountKey, clearAccountKey,
    setActiveAccount, setAccountModels, beginLogin, cancelLogin,
  } = props
  const actions = useMemo<AccountActions>(() => ({
    create: createAccount,
    rename: renameAccount,
    remove: removeAccount,
    setKey: setAccountKey,
    clearKey: clearAccountKey,
    setActive: setActiveAccount,
    setModels: setAccountModels,
    beginLogin,
    cancelLogin,
  }), [createAccount, renameAccount, removeAccount, setAccountKey, clearAccountKey, setActiveAccount, setAccountModels, beginLogin, cancelLogin])
  const bar = saveBarView(state, savedVisible, t)
  const form = { state, disabled, t, onEdit: props.edit, onReset: props.resetField }
  return (
    <section className={bar.visible ? 'cc-section cc-sectionWithBar' : 'cc-section'} aria-label={t('title')}>
      <h2 className="cc-title">{t('title')}</h2>
      <p className="cc-intro">{t('intro')}</p>
      {!state.writable ? <p className="cc-readOnly" role="status">{t('readOnly')}</p> : null}
      <AccountsCard
        t={t}
        state={state}
        usage={usage}
        login={login}
        disabled={disabled}
        actions={actions}
        onRefresh={props.refreshUsage}
      />
      <ModelsCard {...form} onSelect={props.editVisibleModels} onClear={props.clearVisibleModels} />
      <PrivacyCard {...form} />
      <IntegrationsCard {...form} />
      <AdvancedSection {...form} />
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
      <SaveBar view={bar} state={state} t={t} onDiscard={props.discard} onSave={props.save} />
    </section>
  )
}
