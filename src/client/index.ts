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
import { CommandCodeLoginController, type LoginPageState, type LoginRemote } from './login.ts'
import { USAGE_REMOTE_CONTRIBUTION } from '../usage-wire.ts'
import { LOGIN_REMOTE_CONTRIBUTION } from '../login-wire.ts'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CommandCodeSettingsPage } from './section.tsx'
import { CommandCodeProviderCard } from './card.tsx'
import { zh, en } from './locales.ts'

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
.cc-usageWindowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
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
/* The update hint rides the footer version line: warning-tinted (with a
 * muted fallback for themes without the alias), quiet until hovered. */
.cc-versionLink{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
/* The login panel rides the connection card as one more field row; the
 * authorization link is the only branded element on it. */
.cc-loginLink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;line-height:1.5}
.cc-loginLink:hover{text-decoration:underline;text-underline-position:under}
.cc-loginBusy{color:var(--dsw-alias-label-tertiary)}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-label-error)}
.cc-saved{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;font-weight:500;line-height:1.5}
.cc-badgeWarn{background:var(--dsw-alias-state-warning-secondary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
`

/** Inject the page stylesheet once (idempotent per tag). */
function injectPageCss(): void {
  if (typeof document === 'undefined') return
  const id = '@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css'
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@mars-sea/dsh-commandcode-provider'
  tag.dataset.pluginCss = id
  tag.textContent = PAGE_CSS
  document.head.appendChild(tag)
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
    // The wrapper is reached from a non-React path that has no `t` in scope;
    // it reads the active client locale at call time, so a language switch
    // immediately applies to the next selectModel failure. On legacy builds
    // it wraps `connection.api.sessions`; 0.1.2 replaced that façade with
    // `remote.session`, so the helper safely skips this UX-only rewrite there
    // instead of preventing the whole plugin from activating.
    installFriendlyImageError(connection, () => ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en')
  }

  // The "Command Code" settings page: register the section once the
  // `settings.section` declaration is on the ledger (ui-settings-general
  // owns the shell; registration order relative to it is not constrained —
  // `slots.inject` waits for the declaration).
  ctx.effect(() => ctx.locale.register('settings.commandcode', { zh, en }), 'dsh-commandcode-provider: page copy')

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
  const controller = new CommandCodeSettingsController(scope, api, hostDescription)
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
  const contribution: TypertRemoteContribution = {
    package: USAGE_REMOTE_CONTRIBUTION.package,
    descriptors: [...USAGE_REMOTE_CONTRIBUTION.descriptors, ...LOGIN_REMOTE_CONTRIBUTION.descriptors],
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
  }
  const usageController = new CommandCodeUsageController(usageRemote)
  ctx.effect(() => () => usageController.dispose(), 'dsh-commandcode-provider: usage controller')
  const usageStore = createSnapshotStore<UsagePageState>(usageController.state())
  usageController.subscribe(() => usageStore.set(usageController.state()))

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
    editRuleModel: (id: string, text: string) => controller.editRuleModel(id, text),
    editRuleAccount: (id: string, text: string) => controller.editRuleAccount(id, text),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commandcode',
    order: 12,
    label: () => ctx.locale.bind('settings.commandcode')('nav'),
    locale: 'settings.commandcode',
    inject: injected,
  }, CommandCodeSettingsPage))

  // The Models-page provider card (dsh 0.1.2-alpha.2): a keyed slot the
  // Models section dispatches with `entryKey = settingsNs` on every provider
  // card of an adapter family. Registering under `llm-commandcode` renders
  // the card's extension area on every Command Code row — including the
  // first-run setup posture, exactly where a user without a key lands.
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
      beginLogin: () => void loginController.begin(),
      cancelLogin: () => void loginController.cancel(),
    }),
  }, CommandCodeProviderCard))
}

export const inject: readonly string[] = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
]
