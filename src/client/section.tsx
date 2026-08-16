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

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsCommandCodeKey } from './locales.ts'
import type { SettingsPageState, StagedField } from './settings.ts'

/** Props composed by the slot registration: locale seat + injected face. */
export interface CommandCodeSettingsProps {
  t: Translate<SettingsCommandCodeKey>
  useCommandCodeSettings<T>(selector: (state: SettingsPageState) => T): T
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
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

/** The settings page body: connection facts for the Command Code provider. */
export function CommandCodeSettingsPage(props: CommandCodeSettingsProps) {
  const { t } = props
  const state = props.useCommandCodeSettings((snapshot) => snapshot)
  const disabled = !state.writable
  const keyLocked = !state.apiKeyWritable
  return (
    <section className="cc-section" aria-label={t('title')}>
      <h2 className="cc-title">{t('title')}</h2>
      <p className="cc-intro">{t('intro')}</p>
      {!state.writable ? <p className="cc-readOnly" role="status">{t('readOnly')}</p> : null}
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
