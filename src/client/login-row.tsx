/**
 * The shared login row: one field row that starts the Host-side browser
 * login, links to the Studio authorization page while the attempt is live,
 * and reports the outcome — rendered by BOTH the settings page (`section.tsx`)
 * and the Models-page provider card (`card.tsx`) so the two surfaces share
 * one component and one hint state machine.
 *
 * The hint copy/class logic lives in the JSX-free `./login.ts`
 * (`loginHint`/`loginFailureCopy`) so node tests can drive every phase; this
 * file only renders it.
 *
 * @module dsh-commandcode-provider/client/login-row
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsCommandCodeKey } from './locales.ts'
import { loginHint } from './login.ts'
import type { LoginPageState } from './login.ts'

/** One login row's props (same face both surfaces supply). */
export interface LoginRowProps {
  state: LoginPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onBegin(): void
  onCancel(): void
}

/** The sign-in alternative to pasting a key (settings page + Models card). */
export function LoginRow({ state, disabled, t, onBegin, onCancel }: LoginRowProps) {
  const busy = state.phase === 'starting' || state.phase === 'waiting'
  const hint = loginHint(state, t)
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <span className="cc-label">{t('loginTitle')}</span>
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
      <p className={hint.className} title={hint.title}>{hint.text}</p>
    </div>
  )
}