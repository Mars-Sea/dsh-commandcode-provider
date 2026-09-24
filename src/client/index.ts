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
 * 2. The Models-page provider card (settings.models.provider-card) — see
 *    `./card.tsx`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from './snapshot-store.ts'
// Type-only imports that pull in the client-service augmentations
// (`slots`/`remote`/`locale` on Context) and the `settings.section` SlotMap
// entry (declared through dsh-client-ui-settings).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSettingsScope, type SettingsRemoteNamespace, type SettingsScopeContext } from './settings-scope.ts'
import { CommandCodeSettingsController, COMMANDCODE_NS, type SettingsPageState } from './settings.ts'
import type { SettingsPageApi } from './settings.ts'
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
import { PAGE_CSS, PAGE_CSS_ID } from './page-styles.ts'
import { PANEL_CSS, PANEL_CSS_ID } from './panel-styles.ts'
// Type-only: pulls in the SlotMap merge for the composer dock
// (`./session-cost-slots.ts`). The sidebar-foot / center-column merge rides the
// `./panel-view.tsx` value import above, which imports `./panel-slots.ts`.
import type {} from './session-cost-slots.ts'
import { zh, en } from './locales.ts'
import { PANEL_COPY_EN, PANEL_COPY_ZH, PANEL_LOCALE_NS } from './panel-copy.ts'



/** Inject the page stylesheet once (idempotent per tag). */
function injectPageCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${PAGE_CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@mars-sea/dsh-commandcode-provider'
  tag.dataset.pluginCss = PAGE_CSS_ID
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
  tag.dataset.plugin = '@mars-sea/dsh-commandcode-provider'
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
 * brand is applied at the call site instead of importing the package.
 */
const PANEL_ID = 'commandcode-panel'

/**
 * The composer figure's entry id in `conversation.composer.dock`. Its own id,
 * not the shipped `stats` cell's: reusing `stats` would REPLACE the tokens /
 * cache-hit / throughput readout rather than inject into it, and that readout
 * is the harness's to format (see `./session-cost-display.ts`).
 */
const SESSION_COST_ID = 'commandcode-session-cost'

/**
 * The one shot of the `layout` service this plugin needs, declared
 * structurally for the same reason as {@link PANEL_ID}: importing the package
 * would make the browser resolve a client module this bundle never calls.
 * Reached through the reflective `ctx.get('layout')`, never a bare `ctx.layout`
 * property — cordis throws `cannot get property … without inject` for an
 * undeclared service, and declaring `layout` statically would park the whole
 * client fiber (settings page included) on a service some profiles never mount.
 */
interface LayoutSelectionSeam {
  /** `null` shows the Conversation again; a string selects that registered `main` key. */
  selectPanel(id: string | null): void
}

/**
 * Client plugin body. Gates on `slots`, `locale` and `remote` — never on
 * `settingsScope`, whose wrapper service the 0.1.7 settings rewrite removed
 * (the settings scope here speaks the `remote.settings` wire directly). The
 * page mounts once `remote.credentials` appears.
 */
export function apply(ctx: Context): void {
  injectPageCss()

  // The "Command Code" settings page: register the section once the
  // `settings.section` declaration is on the ledger (ui-settings-general
  // owns the shell; registration order relative to it is not constrained —
  // `slots.inject` waits for the declaration).
  ctx.effect(() => ctx.locale.register('settings.commandcode', { zh, en }), 'dsh-commandcode-provider: page copy')

  // The plans & quota panel's copy is a namespace of its own: the panel is not
  // part of the settings page, but it follows the SAME active language (both
  // panel registrations declare it below, which is what binds their `t` seat).
  ctx.effect(
    () => ctx.locale.register(PANEL_LOCALE_NS, { zh: PANEL_COPY_ZH, en: PANEL_COPY_EN }),
    'dsh-commandcode-provider: panel copy',
  )

  // Credentials reach the browser as a Typert Remote namespace. The inject is
  // the activation gate for every surface below, so a profile whose Host serves
  // no credentials namespace simply never mounts the page.
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    const credentials = (remoteCtx.remote as unknown as {
      credentials: SettingsPageApi['credentials']
    }).credentials
    applyClientSurfaces(remoteCtx, { credentials })
  })
}

/** Mount the one shared UI implementation. */
function applyClientSurfaces(
  ctx: Context,
  api: SettingsPageApi,
): void {
  // The settings scope: this plugin's own binding of the `llm-commandcode`
  // namespace over `remote.settings` (see `./settings-scope.ts`). The harness
  // used to provide a `settingsScope` service to bind here, but that wrapper
  // existed only through 0.1.6 and was removed with the 0.1.7 settings
  // rewrite — while the describe/mutate wire underneath spans every
  // supported release, so one implementation now serves all of them.
  //
  // The namespace object is captured from an INJECT-SCOPED context, never read
  // off `ctx.remote`: `remote.settings` is a Cordis service nested under
  // `remote`, and cordis answers a read through a context that does not declare
  // it with `Error: cannot get property "remote.settings" without inject`. That
  // throw lands inside the scope's own `try`/`catch` (so nothing is logged),
  // leaving the mirror unanswered, the scope on its initial `writable: false`
  // snapshot, and the page read-only with every control disabled — the 0.1.7
  // settings-page report. The resolver below hands the scope the very object
  // the inject resolved; `refresh()` re-reads once it lands, and a profile whose
  // Host serves no settings namespace simply never resolves it, where the page
  // keeps rendering its degraded state instead of crashing.
  let settingsNamespace: SettingsRemoteNamespace | undefined
  const scope = createSettingsScope<Record<string, unknown>>(
    ctx as unknown as SettingsScopeContext,
    COMMANDCODE_NS,
    () => settingsNamespace,
  )
  ctx.effect(() => () => { void scope.dispose() }, 'dsh-commandcode-provider: settings scope')
  ctx.inject(['remote.settings'], (settingsCtx) => {
    settingsNamespace = (settingsCtx.remote as unknown as {
      settings: SettingsRemoteNamespace
    }).settings
    // The first read raced this inject and answered "not mounted"; re-read now
    // that the namespace is here (and again whenever it re-mounts).
    scope.refresh()
    settingsCtx.effect(() => () => {
      settingsNamespace = undefined
    }, 'dsh-commandcode-provider: settings namespace')
  })
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
  // (one mount carries every endpoint this plugin serves — report, catalog,
  // price table, and login — so the Client's bookkeeping stays 1:1 with the
  // Host's single registry registration), then resolve the
  // `remote.commandcode` namespace through a scoped inject. Cordis only serves
  // services a fiber declares in `inject`, and the namespace service exists
  // only after the mount — a static inject would deadlock the plugin (the
  // mounter would wait for its own mount), so the inject is registered
  // dynamically once the mount lands. A Host half that predates the Remote
  // fails the calls instead, and the surfaces render their error branches.
  let usageNamespace: (typeof ctx.remote)['commandcode'] | undefined
  let usageMountError: string | undefined
  // Declared here, constructed below once the Remote seam exists: the mount
  // effect underneath calls `ensure()` from its inject callback, which cordis
  // runs synchronously while the mount promise settles — before the
  // controller's own `const` below would have been initialized.
  let pricesController: CommandCodePricesController | undefined
  // The same hazard for the usage controller, whose `const` is just as far
  // below: the inject callback needs a way to ask for a report without
  // touching that binding before it is initialized (a `const` read in its
  // temporal dead zone THROWS, so `?.` would not save it).
  let refreshUsage: (() => void) | undefined
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
        // is its only trigger: `ensure()` is idempotent, so a readout already on
        // screen simply starts pricing when the table lands, and asking earlier
        // could only fail (the namespace did not exist yet).
        pricesController?.reload()
        // ...and the usage report. A surface can (and on a boot with the quota
        // card on, always does) ask for it BEFORE this mount lands: the answer
        // then is the synthetic "remote is not mounted" failure, which the
        // controller stores as `status: 'error'` — and its `shouldRefresh` only
        // fires from `idle`, so nothing would ever retry it (`usage.ts`). The
        // namespace is live here, so re-read now and replace that stale answer.
        refreshUsage?.()
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
      const call = namespace.prices
      // A Host half older than the price table mounts no such descriptor, so
      // the namespace member is genuinely missing. Report it as a failure the
      // readout treats as permanent rather than throwing.
      if (typeof call !== 'function') {
        return { ok: false, error: { message: 'the Host serves no commandcode/prices endpoint', permanent: true } }
      }
      return call.call(namespace)
    },
  }
  // Wire the catalog Remote into the settings controller's models seam so the
  // model editors can fetch the catalog once the mount lands.
  modelsRemote = () => usageRemote.models()
  const usageController = new CommandCodeUsageController(usageRemote)
  refreshUsage = () => void usageController.refresh()
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
    loginBegin: async (targetRef?: string) => {
      if (usageNamespace === undefined) {
        return { ok: false, error: { message: usageMountError ?? 'commandcode remote is not mounted' } }
      }
      return usageNamespace.loginBegin(targetRef)
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

  const refreshUsageOn = (ok: boolean): boolean => {
    if (ok) void usageController.refresh()
    return ok
  }
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
    beginLogin: (targetRef?: string) => void loginController.begin(targetRef),
    cancelLogin: () => void loginController.cancel(),
    // Account operations commit immediately. The ones that change which keys
    // exist refetch the usage report so the account rows follow.
    createAccount: (input: { label: string; key?: string }) => controller.createAccount(input).then((ref) => {
      if (ref !== undefined && input.key) void usageController.refresh()
      return ref
    }),
    renameAccount: (ref: string, label: string) => controller.renameAccount(ref, label),
    removeAccount: (ref: string) => controller.removeAccount(ref).then(refreshUsageOn),
    setAccountKey: (target: string, key: string) => controller.setAccountKey(target, key).then(refreshUsageOn),
    clearAccountKey: (target: string) => controller.clearAccountKey(target).then(refreshUsageOn),
    setActiveAccount: (id: string) => controller.setActiveAccount(id).then(refreshUsageOn),
    setAccountModels: (target: string, ids: string[]) => controller.setAccountModels(target, ids),
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
  // While the official 编辑 toggle is open, the panel hides the official
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
  // carrying live quota needs no re-registration — that dance exists only
  // because the shell caches a panellist entry's label), and it selects the
  // panel itself through the `open` action below.
  //
  // Both registrations declare the panel's own `locale` namespace
  // (`panel.commandcode`, registered in `apply` above), which is what binds the
  // `t` seat the components feed into `buildPanelView` — so the panel follows
  // the harness's active language and a switch re-renders it (the renderer
  // mints a fresh `t` per revision, and its identity is the invalidation).
  //
  // The footer card opens the panel through `layout.selectPanel`, so it is
  // gated on the `layout` SERVICE rather than only on its slot: a profile whose
  // `main` declaration exists but whose layout never mounted (a headless client)
  // would otherwise register a card that renders and does nothing when clicked
  // — a dead button.
  //
  // The dashboard cell itself needs no such gate: registering a cell for a
  // declaration that never arrives is a no-op by construction (the callback only
  // runs while the declaration is live). Only the always-declared footer seat
  // needed an explicit guard.
  //
  // Shape notes:
  //   * The stylesheet gets its own `ctx.effect` rather than riding an `inject`
  //     callback's return value, so the tag's lifetime is the plugin fiber's and
  //     is unaffected by a slot declaration collapsing and re-declaring.
  //   * Each registration is guarded so a failure in one surface cannot abort
  //     `applyClientSurfaces` and take the OTHER surfaces down with it —
  //     `slots.inject` rethrows a callback failure synchronously once the
  //     declaration exists. The renderer contains a *render* crash by abdicating
  //     the entry with no visible error, so a failure that leaves nothing on
  //     screen must at least be loud in the console.
  const panelFace = (): PanelInjected => ({
    hooks: { commandCodeUsage: usageStore, commandCodeSettings: store },
    refresh: () => { pricesController?.ensure(); void usageController.refresh() },
    // The Host resolves every credential source, including CLI auth and literals.
    // A browser credential-reference lookup cannot determine availability.
    startAutoRefresh: () => startPanelAutoRefresh(usageController, () => true),
    // `layout` is read reflectively AT CLICK TIME, never captured at setup:
    // ui-layout is not a dependency of this bundle (its types are not imported
    // and its client module is never resolved), so a static `inject` would park
    // the whole client fiber — settings page included — on a service another
    // profile may never mount. The footer registration is gated on that same
    // seam, so by the time this runs the method exists; the guard stays as the
    // last line of defence against a layout that renames it.
    open: () => {
      const layout = ctx.get('layout') as LayoutSelectionSeam | undefined
      layout?.selectPanel(PANEL_ID)
    },
    // The dashboard's way out (issue #41). It occupies the center column in
    // place of the Conversation, and `open()` above is the ONLY other panel
    // selection this plugin makes — so without an exit the panel is a one-way
    // door: clicking the sidebar card just re-selects it. `selectPanel(null)`
    // is layout's "show the Conversation" selection and leaves the current
    // Session untouched.
    close: () => {
      const layout = ctx.get('layout') as LayoutSelectionSeam | undefined
      layout?.selectPanel(null)
    },
  })

  ctx.effect(() => injectPanelCss(), 'dsh-commandcode-provider: panel styles')

  try {
    ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: PANEL_LOCALE_NS, inject: panelFace },
      CommandCodePanel,
    ))
  } catch (error: unknown) {
    console.error('[dsh-commandcode-provider] could not register the plans & quota panel:', error)
  }

  // The footer card is registered only where the layout can actually open the
  // panel behind it. `ctx.inject(['layout'], …)` runs its body when that service
  // is live and re-runs it if the service is replaced, mirroring how the Remote
  // namespace is mounted — so a profile without ui-layout (the TUI, a headless
  // client) never registers the card. Without this gate the card would render
  // and silently do nothing on click, which is worse than not being there.
  ctx.inject(['layout'], (layoutCtx) => {
    try {
      layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register(
        // `order` is the only control over position inside a list slot, and the
        // renderer sorts ascending. ui-cordis's footer chip registers at the
        // default 0, so 1 sorts after it — but any sibling passing an order ≥ 1
        // lands between this card and Settings, so "directly above Settings" is
        // a preference, not a guarantee.
        { name: 'sidebar.footer.action', id: PANEL_ID, order: 1, locale: PANEL_LOCALE_NS, inject: panelFace },
        CommandCodeFooterEntry,
      ))
    } catch (error: unknown) {
      console.error('[dsh-commandcode-provider] could not register the sidebar footer card:', error)
    }
  })

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
  'remote',
]
