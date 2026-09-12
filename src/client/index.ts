/**
 * Browser half of the dsh-commandcode-provider bundle.
 *
 * Two responsibilities:
 *
 * 1. A "Command Code" settings page (a `settings.section` entry at the same
 *    nav level as General / Models / Plugins). The Models page renders an
 *    unknown-adapter-family card for the `commandcode` provider and disables
 *    its submit, so the API key cannot be configured there; this page is the
 *    dedicated surface. It writes the API key through the credentials domain
 *    (the `COMMANDCODE_API_KEY` reference the plugin resolves via
 *    `ctx.remote.credentials`) and the connection facts through the
 *    `llm-commandcode` settings namespace, so a saved key or endpoint reaches
 *    the very next request.
 *
 * 2. The Models-page provider card (settings.models.provider-card) and the
 *    friendly image-gate error wrapper — see `./card.tsx` / `./sessions.ts`.
 *    The wrapper is deliberately narrow: only the `model-unavailable` code is
 *    rewritten, only when the message matches the image-session gate, and only
 *    the message text changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from './snapshot-store.ts'
// Type-only imports that pull in the client-service augmentations
// (`slots`/`remote`/`locale` on Context) and the `settings.section` SlotMap
// entry (`settingsScope` arrives through dsh-client-ui-settings).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installFriendlyImageError } from './sessions.ts'
import type { ConnectionLike } from './sessions.ts'
import { CommandCodeSettingsController, COMMANDCODE_NS, type SettingsPageState } from './settings.ts'
import type { HostDescriptionSource, SettingsPageApi } from './settings.ts'
import { adaptLegacyCredentials, type LegacyCredentialsApi } from './legacy-credentials.ts'
import { CommandCodeUsageController, type UsagePageState, type UsageRemote } from './usage.ts'
import { CommandCodePricesController, type SessionCostPricesState } from './prices.ts'
import { CommandCodeLoginController, type LoginPageState, type LoginRemote } from './login.ts'
import { USAGE_REMOTE_CONTRIBUTION, MODELS_REMOTE_CONTRIBUTION, PRICES_REMOTE_CONTRIBUTION } from '../usage-wire.ts'
import { LOGIN_REMOTE_CONTRIBUTION } from '../login-wire.ts'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CommandCodeSettingsPage } from './section.tsx'
import { CommandCodeProviderCard } from './card.tsx'
import { CommandCodePanel, CommandCodeFooterEntry } from './panel-view.tsx'
import type { PanelInjected } from './panel-view.tsx'
import { CommandCodeSessionCost } from './session-cost-view.tsx'
import type { SessionCostInjected } from './session-cost-view.tsx'
import { startPanelAutoRefresh } from './panel.ts'
import { PANEL_CSS, PANEL_CSS_ID } from './panel-styles.ts'
// Type-only: pulls in the SlotMap merge for the composer dock (the readout's
// home) so the registration below typechecks against the real contract.
import type {} from './session-cost-slots.ts'
import { commandCodeCopy } from './locales.ts'

export { isImageSessionRejection, withFriendlyImageError } from './sessions.ts'

/** CSS for the settings page, injected once (harness bundle convention). */
const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.cc-title{margin:0;font-size:18px;font-weight:600}
.cc-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}
.cc-readOnly{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:4px 16px}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-reset:disabled{cursor:default;opacity:.5}
.cc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* The routing-rule model multi-select: a button trigger that opens an
 * anchored Menu of checkbox rows. The trigger mirrors .cc-input sizing so it
 * sits flush with the sibling account select. */
.cc-ruleTrigger{align-items:center;gap:8px;display:flex;width:100%;text-align:left;cursor:pointer}
.cc-ruleTrigger:disabled{cursor:default}
.cc-ruleTriggerText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-ruleCaret{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:6px;height:6px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg)}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
.cc-check{appearance:none;flex-shrink:0;width:15px;height:15px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:2px;left:5px;width:3px;height:7px;border:solid #fff;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The model multi-select search box: stacked under the trigger while the
 * dropdown is open, same input sizing so the pair reads as one control. The
 * box lives inside the Menu anchor (which renders inside the Menu's root
 * span), so focusing/typing it never trips the Menu's outside-click close. */
.cc-modelSelectAnchor{flex-direction:column;gap:6px;display:flex;width:100%}
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
/* Selects need their own treatment to sit flush with the text inputs:
 * the UA stylesheet renders <select> border-box (34px total vs the inputs'
 * 36px) and forces its own menulist text metrics, so drop the native
 * chrome entirely (appearance:none), restore content-box so the outer box
 * matches the inputs again, and draw the chevron ourselves. Longhand
 * background-* only — the shorthand would reset .cc-input's background. */
select.cc-input{appearance:none;-webkit-appearance:none;-moz-appearance:none;box-sizing:content-box;padding-right:32px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23888f98' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
.cc-inputInvalid{border-color:var(--dsw-alias-label-error)}
.cc-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
/* The Advanced card: its header row is one full-width toggle button; the
 * chevron is two borders on a rotated square (no icon dependency). */
.cc-advancedHead{align-items:center;gap:8px;display:flex;width:100%;padding:12px 0;background:0 0;border:none;cursor:pointer;font:inherit;text-align:left}
.cc-advancedHead:hover .cc-advancedTitle{color:var(--dsw-alias-label-primary)}
.cc-advancedTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.cc-advancedSpacer{flex:1}
.cc-chevron{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:8px;height:8px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg);transition:transform .15s ease}
.cc-chevronUp{transform:rotate(-135deg);margin-bottom:-3px}
.cc-advancedBody{flex-direction:column;display:flex}
.cc-advancedBody>.cc-field:first-of-type{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-toggleRow{align-items:center;gap:8px;cursor:pointer;display:flex}
.cc-toggleRow:has(.cc-toggle:disabled){cursor:default}
.cc-toggle{appearance:none;flex-shrink:0;background:var(--dsw-alias-border-l2);border-radius:999px;width:30px;height:18px;margin:0;cursor:pointer;position:relative;transition:background .15s ease}
.cc-toggle:checked{background:var(--dsw-alias-brand-primary)}
.cc-toggle::after{content:'';background:#fff;border-radius:50%;width:14px;height:14px;position:absolute;top:2px;left:2px;transition:left .15s ease}
.cc-toggle:checked::after{left:14px}
.cc-toggle:disabled{cursor:default;opacity:.5}
.cc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.cc-usageCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;flex-direction:column;gap:12px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usagePlan{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.cc-usagePlanStatus{white-space:nowrap;color:var(--dsw-alias-label-error);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usageRefresh{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-usageRefresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-usageRefresh:disabled{cursor:default;opacity:.5}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-usageError{align-items:center;gap:8px;color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;display:flex}
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex}
.cc-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.cc-usageStatSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageWindows{flex-direction:column;gap:16px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;font-weight:500;line-height:1.5}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:1.5}
.cc-usageExceeded{color:var(--dsw-alias-label-error);font-size:11px;font-weight:500;line-height:1.5}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:6px}
.cc-usageBarFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.cc-usageBarFillWarn{background:var(--dsw-alias-label-error)}
@media (prefers-reduced-motion:reduce){.cc-chevron,.cc-toggle,.cc-toggle::after,.cc-usageBarFill{transition:none}}.cc-usageWindowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usageMeta{align-items:center;gap:8px;display:flex}
.cc-accountReport{flex-direction:column;gap:12px;display:flex}
.cc-tabs{flex-wrap:wrap;gap:6px;display:flex}
.cc-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.cc-tab:hover:not(.cc-tabActive){color:var(--dsw-alias-label-primary)}
.cc-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-tabDotOk{background:var(--dsw-alias-brand-primary);border-radius:50%;width:6px;height:6px}
.cc-tabDotWarn{background:#d97706;border-radius:50%;width:6px;height:6px}
.cc-tabDotError{background:var(--dsw-alias-label-error);border-radius:50%;width:6px;height:6px}
.cc-usageMetaSpacer{flex:1}
.cc-usageUpdated{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usagePartial{color:var(--dsw-alias-label-error);margin:0;font-size:11px;line-height:1.5}
.cc-usageBlocked{border:1px solid var(--dsw-alias-label-error);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.cc-usageBlockedTitle{color:var(--dsw-alias-label-error);margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageBlockedHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}
.cc-version{margin:4px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
/* The Models-page provider panel root: unstyled by design — the row card the
 * Models page owns supplies the surface, the panel only stacks its controls. */
.cc-providerCard{flex-direction:column;display:flex}
/* The update hint rides the footer version line: warning-tinted (with a
 * muted fallback for themes without the alias), quiet until hovered. */
.cc-versionLink{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
/* The login panel rides the connection card as one more field row; the
 * authorization link is the only branded element on it. */
.cc-loginLink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;line-height:1.5}
.cc-loginLink:hover{text-decoration:underline;text-underline-position:under}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-label-error)}
.cc-saved{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;font-weight:500;line-height:1.5}
.cc-badgeWarn{background:var(--dsw-alias-state-warning-secondary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
`

/** Inject the page stylesheet once (idempotent per tag). */
function injectPageCss(): void {
  if (typeof document === 'undefined') return
  const id = '@xer-on/dsh-commandcode-provider/CommandCodeSettingsPage.module.css'
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xer-on/dsh-commandcode-provider'
  tag.dataset.pluginCss = id
  tag.textContent = PAGE_CSS
  document.head.appendChild(tag)
}

/**
 * Install the plans & quota panel's stylesheet and return its disposer, for
 * `ctx.effect` to own. Keyed by its own `data-plugin-css` id, so the injection
 * is idempotent even if a second surface asks for it later.
 */
function injectPanelCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${PANEL_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xer-on/dsh-commandcode-provider'
  tag.dataset.pluginCss = PANEL_CSS_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/**
 * Plans & quota panel id. It is the layout's `MainPanelId`: one string shared
 * by the `sidebar.footer.action` card and the `main` slot cell, so the card
 * selects this panel and nothing else. `dsh-client-ui-layout` is not a
 * dependency of this bundle (its type is only a brand over `string`), so the
 * brand is applied at the two call sites instead of importing the package.
 */
const PANEL_ID = 'commandcode-panel'

/**
 * The composer figure's entry id in `conversation.composer.dock`. Its own id,
 * not the shipped `stats` cell's: reusing `stats` would REPLACE the tokens /
 * cache-hit / throughput readout rather than inject into it, and that readout is
 * the harness's to format (see `./session-cost-display.ts`).
 */
const SESSION_COST_ID = 'commandcode-session-cost'

/**
 * The one shot of the `layout` service this plugin needs, declared structurally
 * for the same reason as {@link PANEL_ID}: importing the package would make the
 * browser resolve a client module this bundle never calls. Reached through the
 * reflective `ctx.get('layout')`, never a bare `ctx.layout` property — cordis
 * throws `cannot get property … without inject` for an undeclared service, and
 * declaring `layout` statically would park the whole client fiber on a service
 * some profiles never mount.
 */
interface LayoutSelectionSeam {
  selectPanel(id: string): void
}

/** Connection fields retained by pre-0.1.2 clients and absent from the current transport handle. */
interface LegacyConnectionLike extends ConnectionLike {
  api?: ConnectionLike['api'] & { credentials?: LegacyCredentialsApi }
  hostDescription?: HostDescriptionSource
}

/**
 * Client plugin body. Gates on the services shared by both client generations
 * (`slots`, `locale`, `connection`, `remote`, `settingsScope`). Current clients
 * mount the page after `remote.credentials` appears; legacy clients mount it
 * from the connection ApiProxy credential face.
 */
export function apply(ctx: Context): void {
  injectPageCss()

  const connection = ctx.get('connection') as LegacyConnectionLike | undefined
  if (connection !== undefined) {
    // The wrapper is reached from a non-React path that has no `t` in scope,
    // so it reads the plugin's own English copy. On legacy builds it wraps
    // `connection.api.sessions`; 0.1.2 replaced that façade with
    // `remote.session`, so the helper safely skips this UX-only rewrite there
    // instead of preventing the whole plugin from activating.
    installFriendlyImageError(connection)
  }

  // The "Command Code" settings page: register the section once the
  // `settings.section` declaration is on the ledger (ui-settings-general
  // owns the shell; registration order relative to it is not constrained —
  // `slots.inject` waits for the declaration).
  ctx.effect(() => ctx.locale.register('settings.commandcode', 'en', commandCodeCopy), 'dsh-commandcode-provider: page copy')

  const legacyApi = adaptLegacyCredentials(connection?.api?.credentials)
  if (legacyApi !== undefined) {
    applyClientSurfaces(ctx, legacyApi, connection?.hostDescription)
    return
  }

  // DSH 0.1.2 exposes credentials through a Typert Remote namespace. Keep it
  // optional at the root so a legacy client without `remote.credentials` can
  // still activate through the ApiProxy branch above.
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    const credentials = (remoteCtx.remote as unknown as {
      credentials: SettingsPageApi['credentials']
    }).credentials
    applyClientSurfaces(remoteCtx, { credentials })
  })
}

/** Mount the one shared UI implementation over either credential transport. */
function applyClientSurfaces(
  ctx: Context,
  api: SettingsPageApi,
  hostDescription?: HostDescriptionSource,
): void {
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: COMMANDCODE_NS })
  // The model catalog for the settings page's model editors (the
  // routing-rule editor and the visible-models filter) is served by the
  // `commandcode/models` Remote below; the controller reads it through this
  // mutable seam so the Remote mount (which happens after the controller is
  // constructed) still reaches the catalog fetch. Unset until the mount
  // lands — the controller degrades to the empty-catalog state meanwhile.
  let modelsRemote: NonNullable<SettingsPageApi['models']> | undefined
  const controller = new CommandCodeSettingsController(
    scope,
    { ...api, models: () => modelsRemote?.() ?? Promise.resolve({ ok: false, error: { message: 'commandcode/models remote is not mounted' } }) },
    hostDescription,
  )
  ctx.effect(() => () => controller.dispose(), 'dsh-commandcode-provider: settings controller')
  const store = createSnapshotStore<SettingsPageState>(controller.state())
  controller.subscribe(() => store.set(controller.state()))
  ctx.effect(
    () => (ctx.remote as unknown as {
      $on(event: 'credentials/reference-updated', listener: (ref: string) => void): () => void
    }).$on('credentials/reference-updated', () => { controller.refreshCredentials() }),
    'dsh-commandcode-provider: credential invalidations',
  )

  // The account-usage card + login panel: mount the shared Remote contribution
  // (one mount carries every endpoint this plugin serves — report and login —
  // so the Client's bookkeeping stays 1:1 with the Host's single registry
  // registration), then resolve the `remote.commandcode` namespace through a
  // scoped inject. Cordis only serves services a fiber declares in `inject`,
  // and the namespace service exists only after the mount — a static inject
  // would deadlock the plugin (the mounter would wait for its own mount), so
  // the inject is registered dynamically once the mount lands. A Host half
  // that predates the Remote fails the calls instead, and the surfaces render
  // their error branches.
  let usageNamespace: (typeof ctx.remote)['commandcode'] | undefined
  let usageMountError: string | undefined
  // Declared here, constructed below once the Remote seam exists: the mount
  // effect underneath is the price table's only trigger, and it runs after this
  // function's body either way.
  let pricesController: CommandCodePricesController | undefined
  const contribution: TypertRemoteContribution = {
    package: USAGE_REMOTE_CONTRIBUTION.package,
    descriptors: [
      ...USAGE_REMOTE_CONTRIBUTION.descriptors,
      ...MODELS_REMOTE_CONTRIBUTION.descriptors,
      ...PRICES_REMOTE_CONTRIBUTION.descriptors,
      ...LOGIN_REMOTE_CONTRIBUTION.descriptors,
    ],
  }
  ctx.effect(() => {
    let cancelled = false
    let unmount: (() => Promise<void>) | undefined
    void ctx.remote.$mount(contribution).then((dispose: () => Promise<void>) => {
      if (cancelled) {
        void dispose()
        return
      }
      unmount = dispose
      ctx.inject(['remote.commandcode'], (namespaceCtx) => {
        usageNamespace = namespaceCtx.remote.commandcode
        // The catalog Remote is live now; (re)fetch it for the model editors.
        controller.refreshCatalog()
        // ...and the price table, which the composer's cost readout needs. This
        // is the only trigger: it is idempotent, so a readout already on screen
        // simply starts pricing when the table lands, and the request is issued
        // after the namespace exists (asking earlier could only fail).
        pricesController?.ensure()
        namespaceCtx.effect(() => () => {
          usageNamespace = undefined
        }, 'dsh-commandcode-provider: usage namespace')
      })
    }, (error: unknown) => {
      // A mount failure (e.g. a harness without the Remote mount) leaves the
      // namespace unset; keep the reason so the card can surface it.
      usageMountError = error instanceof Error ? error.message : String(error)
    })
    return () => {
      cancelled = true
      usageNamespace = undefined
      if (unmount !== undefined) void unmount()
    }
  }, 'dsh-commandcode-provider: usage remote')
  const usageRemote: UsageRemote = {
    report: async () => {
      const namespace = usageNamespace
      if (namespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode/report remote is not mounted' } }
      }
      return namespace.report()
    },
    models: async () => {
      const namespace = usageNamespace
      if (namespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode/models remote is not mounted' } }
      }
      return namespace.models()
    },
    prices: async () => {
      const namespace = usageNamespace
      if (namespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode/prices remote is not mounted' } }
      }
      return namespace.prices()
    },
  }
  // Wire the catalog Remote into the settings controller's models seam so the
  // model editors can fetch the catalog once the mount lands.
  modelsRemote = () => usageRemote.models()
  const usageController = new CommandCodeUsageController(usageRemote)
  ctx.effect(() => () => usageController.dispose(), 'dsh-commandcode-provider: usage controller')
  const usageStore = createSnapshotStore<UsagePageState>(usageController.state())
  usageController.subscribe(() => usageStore.set(usageController.state()))

  // The composer's session-cost readout prices a session from a static table,
  // so its controller is a one-shot cache rather than a poll: it fetches once
  // the namespace is live and never again.
  pricesController = new CommandCodePricesController(usageRemote)
  ctx.effect(() => () => pricesController?.dispose(), 'dsh-commandcode-provider: price table')
  const pricesStore = createSnapshotStore<SessionCostPricesState>(pricesController.state())
  pricesController.subscribe(() => pricesStore.set(pricesController.state()))

  // The login panel: same namespace, three endpoints; the key never crosses
  // to the browser — the Host validates and stores it through the credentials
  // seam, and a landed login re-reads the credential badges + usage card.
  const loginRemote: LoginRemote = {
    loginBegin: async () => {
      if (usageNamespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode remote is not mounted' } }
      }
      return usageNamespace.loginBegin()
    },
    loginStatus: async () => {
      if (usageNamespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode remote is not mounted' } }
      }
      return usageNamespace.loginStatus()
    },
    loginCancel: async () => {
      if (usageNamespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode remote is not mounted' } }
      }
      return usageNamespace.loginCancel()
    },
  }
  const loginController = new CommandCodeLoginController(() => loginRemote)
  ctx.effect(() => () => loginController.dispose(), 'dsh-commandcode-provider: login controller')
  const loginStore = createSnapshotStore<LoginPageState>(loginController.state())
  let lastLoginPhase = loginController.state().phase
  loginController.subscribe(() => {
    const phase = loginController.state().phase
    // A landed login stored the key Host-side behind the page's back; the
    // badges must follow and the account card can finally fetch.
    if (phase === 'success' && lastLoginPhase !== 'success') {
      controller.refreshCredentials()
      void usageController.refresh()
    }
    lastLoginPhase = phase
    loginStore.set(loginController.state())
  })

  const injected = () => ({
    hooks: { commandCodeSettings: store, commandCodeUsage: usageStore, commandCodeLogin: loginStore },
    edit: (field: string, text: string) => controller.edit(field, text),
    resetField: (field: string) => controller.resetField(field),
    // A landed save can change the key or endpoint the usage endpoints read,
    // so the account card refetches; a failed save keeps the old data.
    save: () => void controller.save().then(() => {
      const settled = controller.state()
      if (!settled.failed && settled.anyAccountConfigured) void usageController.refresh()
    }),
    discard: () => controller.discard(),
    refreshUsage: () => void usageController.refresh(),
    beginLogin: () => void loginController.begin(),
    cancelLogin: () => void loginController.cancel(),
    addAccount: () => controller.addAccount(),
    removeAccount: (id: string) => controller.removeAccount(id),
    editAccountLabel: (id: string, text: string) => controller.editAccountLabel(id, text),
    editAccountKey: (id: string, text: string) => controller.editAccountKey(id, text),
    toggleKeyClear: (id: string) => controller.toggleKeyClear(id),
    addRule: () => controller.addRule(),
    removeRule: (id: string) => controller.removeRule(id),
    editRuleModels: (id: string, ids: string[]) => controller.editRuleModels(id, ids),
    editRuleAccount: (id: string, text: string) => controller.editRuleAccount(id, text),
    editVisibleModels: (ids: string[]) => controller.editVisibleModels(ids),
    clearVisibleModels: () => controller.clearVisibleModels(),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commandcode',
    order: 12,
    label: () => ctx.locale.bind('settings.commandcode')('nav'),
    locale: 'settings.commandcode',
    inject: injected,
  }, CommandCodeSettingsPage))

  // The Models-page provider panel (dsh 0.1.2, rc.1): a keyed slot the
  // Models section dispatches with `entryKey = settingsNs` on every provider
  // card of an adapter family. Registering under `llm-commandcode` mounts the
  // panel beside the official editor on every Command Code row — including
  // the first-run setup posture, exactly where a user without a key lands.
  // While the official Edit toggle is open, the panel hides the official
  // editor shell (for this namespace it holds only the settings.yaml hint
  // over a disabled apply) and shows the real controls; see card.tsx.
  // The registration carries its own inject face (store hooks + actions)
  // because the declaring entry is ui-settings-models', not ours; the `t`
  // seat comes from the registration's own `locale` namespace.
  //
  // On dsh builds without this slot the declaration never exists and
  // `slots.inject` never fires its callback — the registration silently
  // does not happen, and nothing else about the plugin changes.
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-commandcode',
    locale: 'settings.commandcode',
    inject: () => ({
      hooks: { commandCodeSettings: store, commandCodeLogin: loginStore },
      edit: (field: string, text: string) => controller.edit(field, text),
      save: () => void controller.save().then(() => {
        const settled = controller.state()
        if (!settled.failed && settled.anyAccountConfigured) void usageController.refresh()
      }),
      discard: () => controller.discard(),
      beginLogin: () => void loginController.begin(),
      cancelLogin: () => void loginController.cancel(),
    }),
  }, CommandCodeProviderCard))

  // The plans & quota panel: a footer card pinned at the bottom of the
  // sidebar, on top of the Settings seat, that opens a dashboard in the
  // center column.
  //
  // Two registrations, one navigation entry. `sidebar.footer.action` is the
  // list the sidebar shell renders in its foot area directly above the
  // Settings seat (`footArea` = `footerActions` then `settingsArea`), which is
  // what puts this card at the bottom of the column rather than at the top
  // with the global panel icons of `sidebar.panellist`. The layout's keyed
  // `main` slot holds the panel the card opens — `ctx.layout.selectPanel(id)`
  // resolves the id against that registry and throws when no cell occupies it,
  // so BOTH are required, and BOTH need the `inject` face below (an entry
  // without one receives none of the panel's data; see the `hooks` → `useX`
  // rule in panel-view.tsx).
  //
  // Unlike a `sidebar.panellist` row, the shell renders NO chrome around a
  // footer action: our component is the button, it owns the label (so a title
  // carrying live quota needs no re-registration — that dance existed only
  // because the shell caches a panellist entry's label), and it selects the
  // panel itself through the `open` action below.
  //
  // Neither registration declares a `locale` namespace: the panel is English by
  // construction, from `./panel-copy.ts`, not by locale lookup.
  //
  // Shape notes:
  //   * The stylesheet gets its own `ctx.effect` rather than riding an `inject`
  //     callback's return value, so the tag's lifetime is the plugin fiber's and
  //     is unaffected by a slot declaration collapsing and re-declaring.
  //   * Each registration is guarded so a failure in one surface cannot abort
  //     `applyClientSurfaces` and take the OTHER surfaces down with it —
  //     `slots.inject` rethrows a callback failure synchronously once the
  //     declaration exists. The renderer contains a *render* crash by abdicating
  //     the entry with no visible error (that is how an earlier revision of this
  //     panel shipped an invisible row), so a failure that leaves nothing on
  //     screen must at least be loud in the console.
  const panelFace = (): PanelInjected => ({
    hooks: { commandCodeUsage: usageStore, commandCodeSettings: store },
    refresh: () => void usageController.refresh(),
    // The credential gate rides the live settings snapshot, so a key saved on
    // the settings page reaches the next tick without re-registration.
    startAutoRefresh: () => startPanelAutoRefresh(usageController, () => controller.state().anyAccountConfigured),
    // `layout` is read reflectively AT CLICK TIME, never captured at setup:
    // ui-layout is not a dependency of this bundle (its types are not imported
    // and its client module is never resolved), so a static `inject` would park
    // the whole client fiber — settings page included — on a service another
    // profile may never mount. By the time a click is possible the footer slot
    // itself is on screen, and ui-sidebar only activates with `layout` present,
    // so the read always lands; the guard covers the impossible case anyway.
    open: () => {
      const layout = ctx.get('layout') as LayoutSelectionSeam | undefined
      if (typeof layout?.selectPanel === 'function') layout.selectPanel(PANEL_ID)
    },
  })

  ctx.effect(() => injectPanelCss(), 'dsh-commandcode-provider: panel styles')

  try {
    ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: panelFace },
      CommandCodePanel,
    ))
  } catch (error: unknown) {
    console.error('[dsh-commandcode-provider] could not register the plans & quota panel:', error)
  }

  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      // `order` is the only control over position inside a list slot, and the
      // renderer sorts ascending. ui-cordis's footer chip registers at the
      // default 0, so 1 makes this card the LAST action — the one directly on
      // top of the Settings seat — regardless of which plugin's fiber mounts
      // first.
      { name: 'sidebar.footer.action', id: PANEL_ID, order: 1, inject: panelFace },
      CommandCodeFooterEntry,
    ))
  } catch (error: unknown) {
    console.error('[dsh-commandcode-provider] could not register the sidebar footer card:', error)
  }

  // The composer's session-cost figure: an entry in the dock below the input
  // that renders NO surface of its own. The cost is injected into the harness's
  // own token-usage UI — the amount as the last item of the shipped pill's text
  // run, the breakdown as rows inside the usage dialog that pill opens (see
  // `./session-cost-display.ts`).
  //
  // The entry exists for its SEATS, not for a surface: `useProjection` is a
  // standard prop the composer hands every dock occupant, so this registration
  // is the only way to read the session's token accounting. Its id must stay
  // distinct from the shipped `stats` cell's, because registering under an
  // existing id REPLACES that cell rather than extending it.
  //
  // It carries only the price-table hook: the token buckets and the model
  // selection arrive from the composer itself as standard dock props
  // (`useProjection`), which the owner supplies to every occupant.
  //
  // No `locale` namespace and no `t` seat: the figure is English by
  // construction, from `./session-cost.ts`.
  const sessionCostFace = (): SessionCostInjected => ({
    hooks: { commandCodePrices: pricesStore },
  })

  try {
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
      // No `order`: the entry renders nothing, so its position among the dock's
      // rows cannot matter — the sort only ever decides what a reader sees.
      { name: 'conversation.composer.dock', id: SESSION_COST_ID, inject: sessionCostFace },
      CommandCodeSessionCost,
    ))
  } catch (error: unknown) {
    console.error('[dsh-commandcode-provider] could not register the composer session-cost readout:', error)
  }
}

export const inject: readonly string[] = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
]
