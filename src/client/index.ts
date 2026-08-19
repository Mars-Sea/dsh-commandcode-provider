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
 *    (the `COMMANDCODE_API_KEY` reference the plugin resolves) and the
 *    connection facts through the `llm-commandcode` settings namespace, so a
 *    saved key or endpoint reaches the very next request.
 *
 * 2. The friendly-error wrapper for the harness's image-session gate — see
 *    `./sessions.ts`. The wrapper is deliberately narrow: only the
 *    `model-unavailable` code is rewritten, only when the message matches the
 *    image-session gate, and only the message text changes.
 *
 * The wire types are spelled structurally in `./sessions.ts` (not imported
 * from `@deepseek-ai/dsh-host-apiproxy`) so this client bundle does not drag
 * an extra peer dependency into the package; the shapes are stable and the
 * client build inlines them anyway.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports that pull in the client-service augmentations
// (`slots`/`remote`/`locale` on Context) and the `settings.section` SlotMap
// entry (`settingsScope` arrives through dsh-client-ui-settings).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installFriendlyImageError } from './sessions.ts'
import { CommandCodeSettingsController, COMMANDCODE_NS, type SettingsPageState } from './settings.ts'
import { CommandCodeUsageController, type UsagePageState, type UsageRemote } from './usage.ts'
import { USAGE_REMOTE_CONTRIBUTION } from '../usage-wire.ts'
import { CommandCodeSettingsPage } from './section.tsx'
import { zh, en } from './locales.ts'

export { isImageSessionRejection, withFriendlyImageError } from './sessions.ts'
import type { ConnectionLike } from './sessions.ts'

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
.cc-inputInvalid{border-color:var(--dsw-alias-label-error)}
.cc-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
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
.cc-accountReport{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;flex-direction:column;gap:12px;display:flex}
.cc-accountReport:first-of-type{border-top:none;padding-top:0}
.cc-usageMetaSpacer{flex:1}
.cc-usageUpdated{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usagePartial{color:var(--dsw-alias-label-error);margin:0;font-size:11px;line-height:1.5}
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

/**
 * Client plugin body. Gates on the services the settings page needs
 * (`slots`, `locale`, `connection`, `remote`, `settingsScope`) plus the
 * `connection` used by the friendly-error wrapper — the same inject list the
 * harness's own settings-surface plugins declare.
 */
export function apply(ctx: Context): void {
  injectPageCss()

  // Friendly image-gate error wrapper (unchanged behaviour).
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection !== undefined) {
    installFriendlyImageError(connection)
  }

  // The "Command Code" settings page: register the section once the
  // `settings.section` declaration is on the ledger (ui-settings-general
  // owns the shell; registration order relative to it is not constrained —
  // `slots.inject` waits for the declaration).
  ctx.effect(() => ctx.locale.register('settings.commandcode', { zh, en }), 'dsh-commandcode-provider: page copy')

  const api = ctx.get('connection').api
  const hostDescription = ctx.get('connection').hostDescription
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: COMMANDCODE_NS })
  const controller = new CommandCodeSettingsController(scope, { credentials: api.credentials }, hostDescription)
  ctx.effect(() => () => controller.dispose(), 'dsh-commandcode-provider: settings controller')
  const store = createSnapshotStore<SettingsPageState>(controller.state())
  controller.subscribe(() => store.set(controller.state()))

  // The account-usage card: mount the shared Remote contribution, then resolve
  // the `remote.commandcode` namespace through a scoped inject. Cordis only
  // serves services a fiber declares in `inject`, and the namespace service
  // exists only after the mount — a static inject would deadlock the plugin
  // (the mounter would wait for its own mount), so the inject is registered
  // dynamically once the mount lands. A Host half that predates the Remote
  // fails the call instead, and the card renders its error branch.
  let usageNamespace: (typeof ctx.remote)['commandcode'] | undefined
  let usageMountError: string | undefined
  ctx.effect(() => {
    let cancelled = false
    let unmount: (() => Promise<void>) | undefined
    void ctx.remote.$mount(USAGE_REMOTE_CONTRIBUTION).then((dispose) => {
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

  const injected = () => ({
    hooks: { commandCodeSettings: store, commandCodeUsage: usageStore },
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
    addAccount: () => controller.addAccount(),
    removeAccount: (id: string) => controller.removeAccount(id),
    editAccountLabel: (id: string, text: string) => controller.editAccountLabel(id, text),
    editAccountKey: (id: string, text: string) => controller.editAccountKey(id, text),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commandcode',
    order: 12,
    label: () => ctx.locale.bind('settings.commandcode')('nav'),
    locale: 'settings.commandcode',
    inject: injected,
  }, CommandCodeSettingsPage))
}

export const inject: readonly string[] = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
]
