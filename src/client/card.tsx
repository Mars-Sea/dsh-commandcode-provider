/**
 * The Command Code configuration panel inside the harness Models settings page
 * (browser half). Rendered through the `settings.models.provider-card` keyed
 * slot available in dsh 0.1.2-alpha.2, registered with
 * `entryKey = 'llm-commandcode'` (the plugin's settings namespace, the key the
 * Models page dispatches for every Command Code provider row).
 *
 * The official Models page opens one editor card per provider row through its
 * own 编辑 button. For a namespace the page does not curate a layout for
 * (`llm-commandcode`), that editor is a bare shell — a pointer to
 * `settings.yaml` above a permanently disabled apply button. This panel takes
 * its place: the slot outlet renders right beside the official editor inside
 * the same row card, so the component watches the outlet's siblings and, while
 * the official editor is open, hides the useless shell and shows the real
 * controls in its slot — the credential/route badges, the API-key field,
 * official sign-in, and the discard/save footer. Closed, it renders nothing
 * and the row looks exactly like any other provider row.
 *
 * The slot's owner props (`configured`, `keyConfigured`) mirror what the
 * Models page already knows; the authoritative credential facts still come
 * from this plugin's `CommandCodeSettingsController` shared with the dedicated
 * settings page, so the two surfaces can never disagree about whether a key
 * is stored.
 *
 * A controller-less render (panel mounted before the section registered its
 * inject face — the composition runs one apply) degrades to the stateless
 * registration notice inside the opened panel.
 *
 * Styles ride the page stylesheet the client entry injects once (`cc-`
 * prefixed classes); the card adds no CSS of its own.
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsCommandCodeKey } from './locales.ts'
import type { SettingsPageState, StagedField } from './settings.ts'
import type { LoginPageState } from './login.ts'
import type { CommandCodeLoginFailureReason } from '../login-wire.ts'

/**
 * The Models-page extension slots, merged into the SlotMap with the exact
 * declarations dsh 0.1.2-alpha.2's ui-settings-models ships. The merge must
 * stay structurally identical to upstream's (kind/scope/owner), or a future
 * dsh carrying its own declaration would fail the duplicate-merge check at
 * compile time.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One provider card's adapter extension area, keyed by the row's settingsNs. */
    'settings.models.provider-card': { kind: 'keyed'; scope: 'root'; owner: ProviderCardExtrasOwnerProps }
    /** Ordered extension area after the provider rows and the add controls. */
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: ModelsFooterOwnerProps }
  }
}

/** The provider directory row as the Models page dispatches it. */
export interface ProviderDirectoryRow {
  /** The provider route id (`commandcode` for this plugin). */
  readonly provider: string
  /** The row's display name. */
  readonly displayName: string
  /** The settings namespace the row configures (the slot's dispatch key). */
  readonly settingsNs: string
  /** The settings path the row's profile lives at. */
  readonly settingsPath: readonly string[]
  /** Whether the provider route is live. */
  readonly active: boolean
  /** Whether the adapter declares the route as shipped. */
  readonly declared?: boolean
}

/** Owner share of one provider-card extension occurrence (upstream's shape). */
export interface ProviderCardExtrasOwnerProps {
  /** The card's directory row. */
  readonly provider: ProviderDirectoryRow
  /** Whether any layer configures this provider (its profile resolves). */
  readonly configured: boolean
  /** The row's referenced api-key credential, confirmed configured by the page's join. */
  readonly keyConfigured: boolean
}

/** Owner share of the footer area (the section supplies nothing). */
export interface ModelsFooterOwnerProps {
  /** Marker field: footer owner props are intentionally empty. */
  children?: never
}

/** Owner props the Models page supplies at its dispatch sites. */
export type ProviderCardOwnerProps = ProviderCardExtrasOwnerProps

/**
 * The slot whose outlet anchors this panel inside the Models row — the
 * renderer's own `data-slot` attribute value, stable across builds (unlike
 * CSS-module class hashes).
 */
export const CARD_SLOT_KEY = 'settings.models.provider-card'

/** The DOM facts the sibling lookup reads (satisfied by real Elements). */
export interface SlotWrapperSiblings {
  previousElementSibling: { className: string } | null
  nextElementSibling: { className: string } | null
}

/**
 * Find the official editor card among the slot outlet's siblings, or null
 * while it is closed. The Models page renders the editor as an immediate
 * sibling of the outlet wrapper — after it in a provider row (the target of
 * the row's 编辑 toggle), before it in the first-run setup card and the
 * add-provider card, where it is always open. The editor is the only such
 * sibling whose CSS module class carries the `editor` stem
 * (`<hash>_editor`); the row header and the add card's provider select
 * never do, so the lookup needs no hash knowledge.
 */
export function adjacentEditorCard(wrapper: SlotWrapperSiblings | null): { className: string } | null {
  if (wrapper === null) return null
  for (const sibling of [wrapper.previousElementSibling, wrapper.nextElementSibling]) {
    if (sibling !== null && typeof sibling.className === 'string' && sibling.className.includes('editor')) {
      return sibling
    }
  }
  return null
}

/** The closed-panel style: the outlet stays mounted as the detection anchor. */
const HIDDEN_STYLE = { display: 'none' } as const

/** Injected face the card's slot registration supplies. */
export interface CommandCodeCardProps {
  t: Translate<SettingsCommandCodeKey>
  useCommandCodeSettings<T>(selector: (state: SettingsPageState) => T): T
  useCommandCodeLogin<T>(selector: (state: LoginPageState) => T): T
  edit(field: string, text: string): void
  save(): void
  discard(): void
  beginLogin(): void
  cancelLogin(): void
}

/** The card's two postures. */
type CardMode =
  | { kind: 'registration' }
  | { kind: 'live'; ready: boolean; controllerConfigured: boolean; writable: boolean; apiKeyWritable: boolean }

/** Decide the card's posture from the injected face and the owner facts. */
export function cardMode(props: CommandCodeCardProps & ProviderCardOwnerProps): CardMode {
  if (props.useCommandCodeSettings === undefined) return { kind: 'registration' }
  const snapshot = props.useCommandCodeSettings((state) => state)
  return {
    kind: 'live',
    ready: snapshot.available,
    controllerConfigured: snapshot.apiKeyConfigured,
    writable: snapshot.writable,
    apiKeyWritable: snapshot.apiKeyWritable,
  }
}

/** Status badge for the credential state (green when configured). */
function StatusBadge({ ok, okLabel, pendingLabel }: {
  ok: boolean
  okLabel: string
  pendingLabel: string
}) {
  return <span className={ok ? 'cc-badge' : 'cc-badgeMuted'}>{ok ? okLabel : pendingLabel}</span>
}

/**
 * The per-reason copy for a failed login attempt (mirrors the settings
 * page's LoginPanel; the same reasons can surface from this card).
 */
function loginFailureCopy(reason: CommandCodeLoginFailureReason | undefined, t: Translate<SettingsCommandCodeKey>): string {
  if (reason === 'denied') return t('loginDenied')
  if (reason === 'timeout') return t('loginTimeout')
  if (reason === 'invalid-key') return t('loginInvalidKey')
  if (reason === 'network') return t('loginNetwork')
  if (reason === 'unavailable') return t('loginStoreFailed')
  if (reason === 'cancelled') return t('loginCancelled')
  return t('loginFailedGeneric')
}

/** The sign-in affordance row for the not-configured card (see LoginPanel). */
function CardLoginRow({ state, disabled, t, onBegin, onCancel }: {
  state: LoginPageState
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onBegin(): void
  onCancel(): void
}) {
  const busy = state.phase === 'starting' || state.phase === 'waiting'
  let hint = t('loginHintIdle')
  let hintClass = 'cc-hint'
  if (state.phase === 'starting' || state.phase === 'waiting') hint = t(state.phase === 'starting' ? 'loginStarting' : 'loginWaiting')
  else if (state.phase === 'success') {
    const keyName = state.keyName !== undefined && state.keyName !== '' ? ` · ${state.keyName}` : ''
    hint = `${t('loginSuccess')} ${state.userName ?? ''}${keyName}`.trim()
    hintClass = 'cc-loginDone'
  } else if (state.phase === 'failed') {
    hint = loginFailureCopy(state.reason, t)
    hintClass = 'cc-loginError'
  } else if (state.phase === 'unavailable') {
    hint = `${t('loginUnavailable')} ${state.message ?? ''}`.trim()
    hintClass = 'cc-loginError'
  }
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
      <p className={hintClass}>{hint}</p>
    </div>
  )
}

/** Compact key field for the not-configured card. */
function CardKeyField({ state, disabled, t, onEdit }: {
  state: StagedField
  disabled: boolean
  t: Translate<SettingsCommandCodeKey>
  onEdit(text: string): void
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="cc-field">
      <div className="cc-fieldHead">
        <label className="cc-label" htmlFor="cc-card-api-key">{t('apiKey')}</label>
        <span className="cc-badges">
          <button type="button" className="cc-reset" disabled={disabled} onClick={() => setVisible((value) => !value)}>
            {visible ? t('hide') : t('show')}
          </button>
        </span>
      </div>
      <input
        id="cc-card-api-key"
        className="cc-input"
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={state.text}
        disabled={disabled}
        onChange={(event) => onEdit(event.target.value)}
      />
      <p className="cc-hint">{t('apiKeyHint')}</p>
    </div>
  )
}

/**
 * The slot component body. Dispatched on every Command Code provider card of
 * the Models page (saved row, first-run setup posture, and add-provider
 * draft).
 *
 * Closed (the official 编辑 toggle off) the panel renders nothing: the row
 * head the Models page owns already names the provider and shows the
 * credential dot, so a page full of providers stays compact. Opening the
 * official editor mounts the editor shell as the outlet's sibling; the panel
 * watches for it, hides the shell (it carries only the settings.yaml hint and
 * a disabled apply for this namespace), and shows the real controls — badges,
 * API-key field, sign-in, discard/save.
 */
export function CommandCodeProviderCard(props: CommandCodeCardProps & ProviderCardOwnerProps) {
  const { t } = props
  const mode = cardMode(props)
  const state = props.useCommandCodeSettings !== undefined
    ? props.useCommandCodeSettings((snapshot) => snapshot)
    : undefined
  const login = props.useCommandCodeLogin !== undefined
    ? props.useCommandCodeLogin((snapshot) => snapshot)
    : undefined
  const dirty = state?.dirty ?? false
  const saving = state?.saving ?? false
  const invalid = state?.invalid ?? false
  const failed = state?.failed ?? false
  const savingBlocked = !dirty || invalid
  const configured = mode.kind === 'live' && mode.ready ? mode.controllerConfigured : props.keyConfigured
  const disabled = mode.kind === 'live' && (!mode.writable || (state !== undefined && !mode.apiKeyWritable))
  const showBody = mode.kind === 'live' && mode.ready && state !== undefined
  // The official editor's open state lives in the Models page's own component
  // state and never reaches this slot's props; the outlet wrapper is the
  // stable neighbor, so watch its siblings for the editor's mount/unmount.
  // The outlet stays mounted either way — it is the observation anchor — so
  // the closed panel hides its own root instead of unmounting.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof MutationObserver === 'undefined') return
    const wrapper = root.closest(`[data-slot="${CARD_SLOT_KEY}"]`) ?? root.parentElement
    if (wrapper === null) return
    const row = wrapper.parentElement
    if (row === null) return
    let hiddenEditor: HTMLElement | null = null
    const sync = () => {
      const editor = adjacentEditorCard(wrapper) as HTMLElement | null
      setEditorOpen(editor !== null)
      if (editor !== null) {
        // React pins no inline style on the editor shell, so this survives
        // the shell's own re-renders; a shell that unmounts and remounts is
        // re-hidden by the next observation.
        editor.style.display = 'none'
        hiddenEditor = editor
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(row, { childList: true })
    return () => {
      observer.disconnect()
      // If the shell outlives the panel (plugin reload), give it back: the
      // settings.yaml hint is the honest fallback face again.
      if (hiddenEditor !== null) hiddenEditor.style.display = ''
    }
  }, [])
  return (
    <div
      ref={rootRef}
      className="cc-providerCard"
      data-cc-models-card="true"
      style={editorOpen ? undefined : HIDDEN_STYLE}
    >
      {editorOpen && mode.kind === 'registration' ? <p className="cc-hint">{t('cardRegistrationHint')}</p> : null}
      {editorOpen && mode.kind === 'live' && !mode.ready ? <p className="cc-hint">{t('cardLoadingHint')}</p> : null}
      {editorOpen && showBody ? (
        <>
          <div className="cc-field">
            <div className="cc-fieldHead">
              <span className="cc-label">{t('cardTitle')}</span>
              <span className="cc-badges">
                <StatusBadge ok={configured} okLabel={t('apiKeySet')} pendingLabel={t('apiKeyUnset')} />
                {props.provider.active ? <span className="cc-badge">{t('cardRouteActive')}</span> : null}
              </span>
            </div>
          </div>
          <CardKeyField
            state={state.apiKey}
            disabled={disabled}
            t={t}
            onEdit={(text) => props.edit('apiKey', text)}
          />
          {login !== undefined ? (
            <CardLoginRow
              state={login}
              disabled={disabled}
              t={t}
              onBegin={props.beginLogin}
              onCancel={props.cancelLogin}
            />
          ) : null}
          <div className="cc-footer">
            {failed ? <p className="cc-failed" role="status">{t('saveFailed')}</p> : null}
            <button
              type="button"
              className="cc-reset"
              disabled={!dirty || saving}
              onClick={props.discard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="cc-reset"
              disabled={savingBlocked || saving}
              onClick={props.save}
            >
              {t(saving ? 'saving' : 'save')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
