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
 * save/discard footer. Styles are injected once by the client entry
 * (see src/client/index.ts) and class-prefixed `cc-` to stay local.
 */

import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeCredits } from '../adapter.ts'
import type { SettingsCommandCodeKey } from './locales.ts'
import type { SettingsPageState, StagedField } from './settings.ts'
import type { UsagePageState } from './usage.ts'
import { formatMoney, formatMoneyExact, formatResetAt, formatTokensCompact, windowRatio } from './usage.ts'

/** Props composed by the slot registration: locale seat + injected face. */
export interface CommandCodeSettingsProps {
  t: Translate<SettingsCommandCodeKey>
  useCommandCodeSettings<T>(selector: (state: SettingsPageState) => T): T
  useCommandCodeUsage<T>(selector: (state: UsagePageState) => T): T
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  refreshUsage(): void
}

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
        {state.invalid ? t('invalidNumber') : hint}
      </p>
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

/** The API-key control: write-only, reports configured state, never echoes the key. */
function SecretKeyField({
  label,
  hint,
  state,
  disabled,
  configured,
  configuredLabel,
  unconfiguredLabel,
  onEdit,
}: {
  label: string
  hint: string
  state: StagedField
  disabled: boolean
  configured: boolean
  configuredLabel: string
  unconfiguredLabel: string
  onEdit(text: string): void
}) {
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor="cc-api-key">{label}</label>
        <span className="cc-badges">
          <span className={configured ? 'cc-badge' : 'cc-badgeMuted'}>
            {configured ? configuredLabel : unconfiguredLabel}
          </span>
        </span>
      </div>
      <input
        id="cc-api-key"
        className="cc-input"
        type="password"
        autoComplete="off"
        value={state.text}
        disabled={disabled}
        onChange={(event) => onEdit(event.target.value)}
      />
      <p className="cc-hint">{hint}</p>
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

/**
 * The account-usage card: the `/commandcode` dashboard's facts (account,
 * totals, credits, window limits) rendered as a native settings card. Data
 * arrives through the `commandcode/report` Remote; the API key never leaves
 * the Host.
 */
function UsageCard({ t, usage, apiKeyConfigured, onRefresh }: {
  t: Translate<SettingsCommandCodeKey>
  usage: UsagePageState
  apiKeyConfigured: boolean
  onRefresh(): void
}) {
  // First paint with a configured key fetches automatically; later fetches
  // are explicit (refresh button) or follow a landed save.
  useEffect(() => {
    if (apiKeyConfigured && usage.status === 'idle') onRefresh()
  }, [apiKeyConfigured, usage.status, onRefresh])

  const loading = usage.status === 'loading'
  const report = usage.report
  const account = report?.account
  const accountName = account === undefined ? '' : account.userName || account.name
  const credits = report?.credits
  const plan = report?.plan
  const planName = plan?.name ?? ''
  const planStatus = plan !== undefined && plan.status !== '' && plan.status !== 'active' ? plan.status : ''

  return (
    <div className="cc-usageCard" aria-label={t('usageTitle')}>
      <div className="cc-usageHead">
        <h3 className="cc-usageTitle">{t('usageTitle')}</h3>
        {accountName !== '' ? <span className="cc-usageAccount">{accountName}</span> : null}
        {planName !== '' ? <span className="cc-usagePlan">{planName}</span> : null}
        {planStatus !== '' ? <span className="cc-usagePlanStatus">{planStatus}</span> : null}
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

      {report?.usage !== undefined ? (
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

      {report !== undefined ? (
        <div className="cc-usageMeta">
          {plan !== undefined && plan.currentPeriodEnd > 0 ? (
            <p className="cc-usageUpdated">{t('usagePeriodEnd')} {new Date(plan.currentPeriodEnd).toLocaleDateString()}</p>
          ) : null}
          {usage.fetchedAt !== undefined ? (
            <p className="cc-usageUpdated">{t('usageUpdated')} {new Date(usage.fetchedAt).toLocaleTimeString()}</p>
          ) : null}
          <span className="cc-usageMetaSpacer" />
          {report.failures.length > 0 ? <p className="cc-usagePartial" title={report.failures.join('; ')}>{t('usagePartial')}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/** The settings page body: connection facts for the Command Code provider. */
export function CommandCodeSettingsPage(props: CommandCodeSettingsProps) {
  const { t } = props
  const state = props.useCommandCodeSettings((snapshot) => snapshot)
  const usage = props.useCommandCodeUsage((snapshot) => snapshot)
  const disabled = !state.writable
  const keyLocked = !state.apiKeyWritable
  return (
    <section className="cc-section" aria-label={t('title')}>
      <h2 className="cc-title">{t('title')}</h2>
      <p className="cc-intro">{t('intro')}</p>
      {!state.writable ? <p className="cc-readOnly" role="status">{t('readOnly')}</p> : null}
      <UsageCard
        t={t}
        usage={usage}
        apiKeyConfigured={state.apiKeyConfigured}
        onRefresh={props.refreshUsage}
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
          onEdit={(text) => props.edit('apiKey', text)}
        />
        <Field
          id="cc-api-base"
          label={t('apiBase')}
          hint={t('apiBaseHint')}
          state={state.apiBase}
          disabled={disabled}
          onEdit={(text) => props.edit('apiBase', text)}
          onReset={() => props.resetField('apiBase')}
          t={t}
        />
        <Field
          id="cc-working-dir"
          label={t('workingDir')}
          hint={t('workingDirHint')}
          state={state.workingDir}
          disabled={disabled}
          placeholder={state.defaultWorkingDir}
          onEdit={(text) => props.edit('workingDir', text)}
          onReset={() => props.resetField('workingDir')}
          t={t}
        />
        <Field
          id="cc-request-timeout"
          label={t('requestTimeoutMs')}
          hint={t('requestTimeoutMsHint')}
          state={state.requestTimeoutMs}
          disabled={disabled}
          numeric
          onEdit={(text) => props.edit('requestTimeoutMs', text)}
          onReset={() => props.resetField('requestTimeoutMs')}
          t={t}
        />
        <Field
          id="cc-stream-idle-timeout"
          label={t('streamIdleTimeoutMs')}
          hint={t('streamIdleTimeoutMsHint')}
          state={state.streamIdleTimeoutMs}
          disabled={disabled}
          numeric
          onEdit={(text) => props.edit('streamIdleTimeoutMs', text)}
          onReset={() => props.resetField('streamIdleTimeoutMs')}
          t={t}
        />
        <ToggleField
          id="cc-filter-models-by-plan"
          label={t('filterModelsByPlan')}
          hint={t('filterModelsByPlanHint')}
          state={state.filterModelsByPlan}
          disabled={disabled}
          defaultChecked
          onEdit={(text) => props.edit('filterModelsByPlan', text)}
          onReset={() => props.resetField('filterModelsByPlan')}
          t={t}
        />
      </div>
      <div className="cc-footer">
        {state.failed ? <p className="cc-failed" role="status">{t('saveFailed')}</p> : null}
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
    </section>
  )
}
