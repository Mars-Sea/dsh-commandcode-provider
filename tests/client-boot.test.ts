/**
 * Client-boot integration tests (node:test). Run with `npm test`.
 *
 * These drive the *real* `apply()` from `src/client/index.ts` against a Cordis
 * context that mirrors the dsh 0.1.7-rc.1 client assembly, and assert that both
 * browser UI surfaces register:
 *
 *   - the "Command Code" settings page (`settings.section`, id `commandcode`),
 *   - the Models-page provider card (`settings.models.provider-card`,
 *     key `llm-commandcode`).
 *
 * The registration is gated by `remote.credentials`: the harness exposes
 * credentials through a Typert Remote namespace, and the plugin waits on
 * `ctx.inject(['remote.credentials'], ...)` before mounting the surfaces. This
 * is exactly the suspicion raised in GitHub issue #15 (that a build "does not
 * mount a `credentials` remote namespace", so the surfaces never register).
 * These tests prove the opposite for the real assembly: mounting the
 * `credentials` remote contribution lets both surfaces register.
 *
 * Because `src/client/index.ts` statically imports the React component tree
 * (which imports `*.module.css` from `@deepseek-ai/dsh-client-ui-primitives`),
 * the CSS-module loader is registered first and the module is imported
 * dynamically. The boot helper under test is otherwise the authentic `apply`.
 */

import { register } from 'node:module'

// Present *.module.css as empty modules BEFORE the React tree is imported.
// (Static imports hoist above this call, so `apply` must be loaded dynamically.)
register(new URL('./_css-module-loader.mjs', import.meta.url).href)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
// `apply`/`inject` pull the React component tree in (via `section.tsx` /
// `card.tsx`), which imports `*.module.css` from dsh-client-ui-primitives.
// Static imports hoist above the `register()` call above, so load this one
// dynamically — only then is the CSS-module loader in effect.
const { apply, inject } = await import('../src/client/index.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Boot the real plugin `apply()` on a fresh Cordis root provisioned with the
 * dsh 0.1.7-rc.1 client service set: `remote` (reporting `$host.isLoopback`,
 * carrying the `credentials` + `commandcode` namespaces and the `settings`
 * directory the plugin's own scope reads), `slots`, `locale`, and — when
 * `mountLayout` is set — `layout`.
 *
 * There is deliberately NO `settingsScope` service here: 0.1.7 removed it, and
 * the plugin must not depend on it any more (the exported `inject` list is
 * pinned separately). The settings transport is modelled where it really lives —
 * the `remote.settings` namespace — so the boot exercises the same wire the
 * browser uses.
 *
 * @param options - whether to mount the `credentials` remote namespace. When
 *   `false`, the plugin must not register any surface (it parks on the
 *   `inject(['remote.credentials'])` gate). `mountLayout` controls the
 *   `layout` service, whose `selectPanel` is what makes the sidebar card
 *   openable. `mountSettings` controls the settings directory.
 * @returns the registered slot surfaces, keyed by `id` (settings.section,
 *   panel entries) or `key` (provider-card), after boot settles. Every
 *   registration per key is kept, in registration order.
 */
async function boot(
  {
    mountCredentials = true,
    mountLayout = true,
    // Whether the core contribution's `remote.settings` namespace is mounted.
    // It is on every real profile (api-remotes mounts it with
    // `immediately: true`), and `false` models the degraded profile the scope
    // must survive without gating the plugin.
    mountSettings = true,
    // The slots the engine declares. The default is the full dsh 0.1.7-rc.1
    // set; a narrower set models a client assembly that declares fewer seats
    // (a composition difference, not an engine version).
    declaredSlots = new Set([
      'settings.section',
      'settings.models.provider-card',
      'main',
      'sidebar.footer.action',
      'conversation.composer.dock',
    ]),
    // Whether the plugin's own `remote.commandcode` namespace mounts on the
    // same tick as `$mount` resolves. `false` defers it by a macrotask, which
    // is what the real gateway does (the contribution is installed over the
    // wire, so the namespace can land one round-trip after the plugin asks for
    // it) — and the window a surface can lose a report race in.
    immediateUsageMount = true,
  }: {
    mountCredentials?: boolean
    mountLayout?: boolean
    mountSettings?: boolean
    declaredSlots?: Set<string>
    immediateUsageMount?: boolean
  } = {},
) {
  const ctx = new Context()
  const selectedPanels: Array<string | null> = []
  /** Listeners the plugin registered through the forwarded-event face. */
  const remoteListeners = new Map<string, Set<() => void>>()
  const fireRemoteEvent = (event: string): void => {
    for (const listener of remoteListeners.get(event) ?? []) listener()
  }
  /** Calls the plugin's own Remote namespace received, by method. */
  const commandCodeCalls = { report: 0, models: 0, prices: 0, loginStatus: 0 }

  /**
   * Mount one Remote namespace exactly as api-gateway does: a Cordis `Service`
   * named `remote.<ns>`, constructed inside its own child fiber.
   *
   * That shape is load-bearing, not cosmetic. A Cordis context resolves a
   * nested service name ONLY on an `inject(['remote.<ns>'])`-scoped read; any
   * other read is answered with `cannot get property "remote.<ns>" without
   * inject`. A fake that instead hangs each namespace off a plain object would
   * let the plugin read `ctx.remote.<ns>` without declaring the inject — which
   * is exactly how the 0.1.7 settings page shipped read-only: the
   * throw was swallowed by the read's own try/catch, no describe ever left the
   * browser, and every control rendered disabled.
   */
  const mountNamespace = async (namespace: string, implementation: Record<string, unknown> = {}): Promise<void> => {
    await ctx.plugin({
      name: `remote.${namespace}`,
      apply(c: Context) {
        new (class extends Service {
          constructor(owner: Context) {
            super(owner, `remote.${namespace}`)
            Object.assign(this, implementation)
          }
        })(c)
      },
    })
  }

  // The api-gateway `ClientRemoteService` stand-in. It is a real Service (so
  // nested namespace resolution behaves like the engine's) reporting the facts
  // the plugin reads off `remote` itself: `$host.isLoopback` (the settings
  // scope's persistence rule), `$mount` (the contribution installer) and `$on`
  // (the forwarded-event face).
  class FakeRemoteService extends Service {
    // The real gateway reports whether this page is loopback; the settings
    // scope takes Host persistence from it (a remote page stays process-local,
    // exactly as both generations of ui-settings decide).
    $host = { isLoopback: true }

    constructor(owner: Context) {
      super(owner, 'remote')
    }

    async $mount(contribution: { package: string; descriptors: Array<{ namespace: string; method: string }> }) {
      const groups = new Map<string, string[]>()
      for (const descriptor of contribution.descriptors) {
        const group = groups.get(descriptor.namespace) ?? []
        group.push(descriptor.method)
        groups.set(descriptor.namespace, group)
      }
      for (const [ns, methods] of groups) {
        const implementation: Record<string, unknown> = {}
        for (const method of methods) {
          implementation[method] = async (..._args: unknown[]) => {
            if (ns === 'commandcode' && method in commandCodeCalls) {
              commandCodeCalls[method as keyof typeof commandCodeCalls] += 1
            }
            return { ok: true, value: ns === 'commandcode' && method === 'report' ? { accounts: [] } : undefined }
          }
        }
        // A deferred namespace lands one macrotask after `$mount` resolves,
        // which is the window the plugin's mount callback must survive.
        if (ns === 'commandcode' && !immediateUsageMount) {
          setTimeout(() => { void mountNamespace(ns, implementation).catch(() => undefined) }, 0)
          continue
        }
        await mountNamespace(ns, implementation)
      }
      return async () => {}
    }

    $on(event: string, listener: () => void) {
      const listeners = remoteListeners.get(event) ?? new Set<() => void>()
      listeners.add(listener)
      remoteListeners.set(event, listeners)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  const clientRemote = new FakeRemoteService(ctx)

  await clientRemote.$mount({
    package: 'boot',
    descriptors: [
      // The credentials namespace (dsh-api-settings-controller in alpha2).
      ...(mountCredentials ? [{ namespace: 'credentials', method: 'describe' }] : []),
      // The plugin's own report/models/prices/login namespace (mounted below).
      // Not pre-mounted in the deferred variant: there the namespace must NOT
      // exist until the plugin's own `$mount` installs it, which is the whole
      // point of that model.
      ...(immediateUsageMount ? [{ namespace: 'commandcode', method: 'report' }] : []),
    ],
  })

  const localeNamespaces: string[] = []
  ctx.provide('locale', {
    register: (ns: string) => {
      localeNamespaces.push(ns)
      return () => {}
    },
    bind: (ns: string) => (key: string) => `${ns}:${key}`,
    getLocale: () => ({ active: 'en' }),
  })
  // The settings transport: the core contribution's `remote.settings`
  // namespace (mounted by api-remotes with `immediately: true`, and listed in
  // this package's `dsh.client.inject`), NOT the ≤0.1.6 `settingsScope`
  // wrapper service — 0.1.7 removed that service, and the plugin's own scope
  // speaks this wire directly. One in-memory namespace row stands in for the
  // Host: `describe()` answers the directory, `mutate()` applies the path ops
  // and answers the fresh ROW, exactly like `SettingsNamespaceView`.
  const settingsRow = {
    ns: 'llm-commandcode',
    value: { apiKeyEnv: 'COMMANDCODE_API_KEY', apiBase: 'https://from-host.example' } as Record<string, unknown>,
    user: {} as Record<string, unknown>,
    revision: 1,
  }
  const settingsCalls = {
    describe: 0,
    mutate: [] as Array<{ ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[]; revision: number | undefined }>,
  }
  const settingsRowView = () => ({
    ...settingsRow,
    value: { ...settingsRow.value },
    user: { ...settingsRow.user },
  })
  if (mountSettings) {
    await mountNamespace('settings', {
      async describe() {
        settingsCalls.describe += 1
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [settingsRowView()] } }
      },
      async mutate(
        ns: string,
        ops: Array<{ op: string; path: readonly string[]; value?: unknown }>,
        revision?: number,
      ) {
        settingsCalls.mutate.push({ ns, ops, revision })
        for (const op of ops) {
          const [field] = op.path
          if (field === undefined) continue
          if (op.op === 'set') {
            settingsRow.value[field] = op.value
            settingsRow.user[field] = op.value
          } else {
            delete settingsRow.value[field]
            delete settingsRow.user[field]
          }
        }
        settingsRow.revision += 1
        return { ok: true, value: settingsRowView() }
      },
    })
  }

  // ui-layout's selection seam.
  if (mountLayout) {
    ctx.provide('layout', {
      selectPanel: (id: string | null) => {
        // The real controller throws on a non-null key the `main` registry does
        // not hold; `null` is the "show the Conversation" selection and never
        // throws.
        if (id !== null && !declaredSlots.has('main')) {
          throw new Error(`layout.selectPanel: main panel "${id}" is not registered`)
        }
        selectedPanels.push(id)
      },
    })
  }

  // Keyed by slot id/key, but ACCUMULATING: the panel registers one `main`
  // cell and one `sidebar.footer.action` row under the same id, so a
  // last-write-wins map would hide the other registration. Each entry keeps the
  // registration's `inject` factory so a test can build the face the component
  // receives — which is how the card's click path is driven below.
  const registered = new Map<string, Array<{ name: string; id?: string; key?: string; locale?: string; inject?: () => object }>>()
  const record = (options: { name: string; id?: string; key?: string; locale?: string; inject?: () => object }): void => {
    const key = options.id ?? options.key ?? options.name
    const entries = registered.get(key) ?? []
    entries.push(options)
    registered.set(key, entries)
  }
  // The real `slots.inject` runs its callback ONLY while the named declaration
  // is live, so a slot the engine does not declare never registers. A stub that
  // fires for every name would hide exactly the cross-version behavior these
  // tests exist to pin — and would let a registration through for `main` on an
  // engine whose layout has no such slot.
  ctx.provide('slots', {
    inject(name: string, fn: () => void) {
      if (declaredSlots.has(name)) fn()
    },
    register(options: { id?: string; key?: string; name: string; locale?: string; inject?: () => object }, _component: unknown) {
      record(options)
      return () => {}
    },
  })

  await ctx.plugin({
    name: 'plugin',
    inject,
    apply(c: Context) {
      return apply(c)
    },
  })
  // The `inject(['remote.credentials'])` gate, the plugin's own async remote
  // mount, and the controller's fire-and-forget describe all settle on the
  // macrotask queue (cordis wakes a parked inject fiber on a timer tick, not on
  // a `setImmediate`), so flush a few timer rounds before asserting.
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

  return { registered, selectedPanels, localeNamespaces, settingsCalls, settingsRow, fireRemoteEvent, commandCodeCalls }
}

// ---------------------------------------------------------------------------
// Client boot
// ---------------------------------------------------------------------------

test('app registers the settings page and Models provider card when remote.credentials is mounted', async () => {
  const { registered } = await boot()

  // The "Command Code" settings page: a `settings.section` entry id `commandcode`.
  assert.equal(registered.has('commandcode'), true, 'settings.section id commandcode should register')
  assert.equal(
    registered.get('commandcode')![0]!.name,
    'settings.section',
    'the registered surface should be the settings section',
  )

  // The Models-page provider card for the `commandcode` adapter family.
  assert.equal(registered.has('llm-commandcode'), true, 'settings.models.provider-card key llm-commandcode should register')
  assert.equal(
    registered.get('llm-commandcode')![0]!.name,
    'settings.models.provider-card',
    'the registered surface should be the provider card',
  )
})

test('the same apply() also seats the sidebar panel and the composer cost readout', async () => {
  const { registered } = await boot()

  // The plans & quota panel: one keyed `main` cell (the dashboard) and one
  // `sidebar.footer.action` row (the card that opens it), sharing one id so
  // `layout.selectPanel('commandcode-panel')` resolves the cell the card means.
  const panel = registered.get('commandcode-panel') ?? []
  assert.deepEqual(
    panel.map((entry) => entry.name).sort(),
    ['main', 'sidebar.footer.action'],
    'the panel id must occupy both the layout cell and the sidebar row',
  )
  assert.equal(panel.find((entry) => entry.name === 'main')?.key, 'commandcode-panel')

  // The session-cost entry exists for its SEATS: it renders nothing itself and
  // must NOT take the shipped `stats` cell's id, which would replace the
  // harness's own token/cache-hit/throughput readout instead of decorating it.
  const dock = registered.get('commandcode-session-cost') ?? []
  assert.equal(dock.length, 1)
  assert.equal(dock[0]?.name, 'conversation.composer.dock')
  assert.equal(registered.has('stats'), false, 'the shipped stats cell must keep its seat')

  // Every registration above is keyed by its own slot, so the shipped
  // settings/provider surfaces are still registered alongside them.
  assert.equal(registered.get('commandcode')![0]!.name, 'settings.section')
  assert.equal(registered.get('llm-commandcode')![0]!.name, 'settings.models.provider-card')
})

test('app registers no surface when remote.credentials is absent (the gate holds)', async () => {
  // Without the credentials namespace the plugin parks on
  // `inject(['remote.credentials'])` and must not register either surface.
  const { registered } = await boot({ mountCredentials: false })

  assert.deepEqual([...registered.keys()], [], 'no surface should register without remote.credentials')
})

test('the sidebar card is withheld when the layout cannot open the panel', async () => {
  // The regression this pins, measured against 0.1.1-rc.2 … 0.1.5-rc.2:
  // `sidebar.footer.action` exists and RENDERS in every one of those releases,
  // so `slots.inject` fires and an ungated card would register — and then do
  // nothing at all when clicked, because `layout.selectPanel` only arrives in
  // 0.1.5-rc.1. A visible button that silently ignores a click is worse than no
  // button, so the registration is gated on that seam.
  // `mountLayout: false` still seats the `main` cell, because that registration
  // is independent of the layout service (the slot declaration is what gates
  // it). What must NOT happen is the sidebar card: without a layout there is no
  // way to open the panel it points at.
  const { registered } = await boot({ mountLayout: false })
  assert.deepEqual(
    (registered.get('commandcode-panel') ?? []).map((entry) => entry.name),
    ['main'],
    'no layout means no card to open a panel with',
  )

  // A layout that mounts the service but declares no keyed `main` seat still
  // gets the CARD: the seat for it exists and the layout can select panels, but
  // the cell it points at never registers. The composer readout is independent
  // of that seam — it needs the dock slot — and the shipped surfaces are
  // untouched either way.
  const noMain = await boot({
    declaredSlots: new Set(['settings.section', 'settings.models.provider-card', 'sidebar.footer.action', 'conversation.composer.dock']),
  })
  assert.deepEqual(
    (noMain.registered.get('commandcode-panel') ?? []).map((entry) => entry.name),
    ['sidebar.footer.action'],
    'a layout without a keyed main seat gets no dashboard cell',
  )
  assert.equal(noMain.registered.has('commandcode-session-cost'), true)
  assert.equal(noMain.registered.get('commandcode')![0]!.name, 'settings.section')
  assert.equal(noMain.registered.get('llm-commandcode')![0]!.name, 'settings.models.provider-card')
})

test('the footer card reads the sidebar-quota toggle through its inject face', async () => {
  // The card gates its own render on `showSidebarQuota`, so the settings
  // snapshot must reach it through the same inject face that carries `open()`.
  // Without this seat the component could not tell hidden from shown.
  const { registered } = await boot()
  const footer = registered.get('commandcode-panel')?.find((entry) => entry.name === 'sidebar.footer.action')
  assert.ok(footer?.inject, 'the footer row carries its inject face')
  const face = footer.inject() as { hooks?: { commandCodeSettings?: unknown } }
  assert.ok(face.hooks?.commandCodeSettings, 'the card needs the settings snapshot to gate itself')
})

test('the footer card opens the panel cell it shares an id with', async () => {
  const { registered, selectedPanels } = await boot()

  // Registration alone opens nothing: the card must not select a panel as a
  // side effect of being mounted.
  assert.deepEqual(selectedPanels, [], 'registration must not open anything')

  const footer = registered.get('commandcode-panel')?.find((entry) => entry.name === 'sidebar.footer.action')
  assert.ok(footer?.inject, 'the footer row carries its inject face')
  const face = footer.inject() as { open: () => void }
  face.open()
  // The id the card selects must be the id the `main` cell registered under,
  // or `selectPanel` would throw and the click would be a dead end.
  assert.deepEqual(selectedPanels, ['commandcode-panel'])
})

test('the dashboard has an exit: close returns to the conversation', async () => {
  // Issue #41: the dashboard replaces the Conversation in the center column and
  // the sidebar card only re-selects it, so without this action the panel is a
  // one-way door. `null` is layout's "show the Conversation" selection — the
  // current Session is untouched.
  const { registered, selectedPanels } = await boot()
  const cell = registered.get('commandcode-panel')?.find((entry) => entry.name === 'main')
  assert.ok(cell?.inject, 'the main cell carries its inject face')
  const face = cell.inject() as { close: () => void }
  face.close()
  assert.deepEqual(selectedPanels, [null])
})

test('close() with no layout mounted is a no-op, never a throw', async () => {
  // The footer card is gated on the layout service, but `close()` is reachable
  // from the dashboard cell whether or not that service is still live — a
  // layout that unmounted after the cell registered must not make the exit
  // button throw.
  const { registered, selectedPanels } = await boot({ mountLayout: false })
  const cell = registered.get('commandcode-panel')?.find((entry) => entry.name === 'main')
  assert.ok(cell?.inject, 'the main cell carries its inject face')
  const face = cell.inject() as { close: () => void }
  face.close()
  assert.deepEqual(selectedPanels, [])
})

test('both panel seats bind the panel locale namespace, which is registered', async () => {
  // The panel follows the harness language through a `t` seat, and a seat only
  // exists when the registration declares the namespace — a missing
  // declaration silently leaves the surfaces English, which is exactly the bug
  // this pins. The namespace itself must be registered or the renderer throws
  // when it tries to build the seat.
  const { registered, localeNamespaces } = await boot()
  assert.deepEqual(localeNamespaces, ['settings.commandcode', 'panel.commandcode'])
  const panel = registered.get('commandcode-panel') ?? []
  assert.deepEqual(
    panel.map((entry) => [entry.name, entry.locale]),
    [['main', 'panel.commandcode'], ['sidebar.footer.action', 'panel.commandcode']],
  )
})

test('the settings page converges on the Host row and saves through the settings wire', async () => {
  const { registered, settingsCalls, settingsRow, fireRemoteEvent } = await boot()
  const card = registered.get('llm-commandcode')?.find((entry) => entry.name === 'settings.models.provider-card')
  assert.ok(card?.inject, 'the provider card carries its inject face')
  const face = card.inject() as {
    hooks: {
      commandCodeSettings: {
        getSnapshot: () => { apiBase: { text: string }; dirty: boolean; failed: boolean }
      }
    }
    edit: (field: string, text: string) => void
    save: () => void
  }
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // 1. The boot scope read the directory over `remote.settings` (never the
  // removed `settingsScope` service) and derived the namespace row into the
  // controller both surfaces share.
  assert.ok(settingsCalls.describe >= 1, 'the client scope read the settings directory at boot')
  assert.equal(face.hooks.commandCodeSettings.getSnapshot().apiBase.text, 'https://from-host.example')

  // 2. A forwarded invalidation re-reads the Host and re-derives the row.
  const describes = settingsCalls.describe
  settingsRow.value.apiBase = 'https://changed-elsewhere.example'
  fireRemoteEvent('settings/document-updated')
  await settle()
  assert.equal(settingsCalls.describe, describes + 1, 'one invalidation, one re-read')
  assert.equal(face.hooks.commandCodeSettings.getSnapshot().apiBase.text, 'https://changed-elsewhere.example')

  // 3. A save rides the revision-fenced path-op wire and folds the answered ROW
  //    back in — which is exactly what the controller reads as "the write
  //    landed" (`userLayer()[field] === value`), so `failed` must stay false.
  face.edit('apiBase', 'https://saved.example')
  face.save()
  await settle()
  const [write] = settingsCalls.mutate
  assert.ok(write, 'the save issued one mutate')
  assert.equal(write.ns, 'llm-commandcode')
  assert.deepEqual(write.ops, [{ op: 'set', path: ['apiBase'], value: 'https://saved.example' }])
  assert.equal(write.revision, 1, 'the write fences with the revision it read')
  const settled = face.hooks.commandCodeSettings.getSnapshot()
  assert.equal(settled.failed, false, 'a folded write marks the save landed')
  assert.equal(settled.dirty, false, 'the staged draft was accepted')
  assert.equal(settled.apiBase.text, 'https://saved.example')
})

test('a namespace that mounts late still gets the usage report re-read', async () => {
  // The race this pins: a surface can ask for the report BEFORE the plugin's
  // `remote.commandcode` namespace lands (the quota card's first paint does,
  // deterministically, because `$mount` is a wire round-trip). That answer is
  // the synthetic "remote is not mounted" failure, and the usage controller
  // stores it as `status: 'error'` — its `shouldRefresh` only fires from
  // `idle`, so without a refresh from the mount callback the stale error would
  // sit on the page until the panel's two-minute tick.
  const { commandCodeCalls } = await boot({ immediateUsageMount: false })
  // The deferred namespace lands on a macrotask; the plugin's inject callback
  // fires then and issues exactly that refresh.
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(commandCodeCalls.report >= 1, 'the mount callback must re-read the usage report')
})

test('a profile without the settings transport still registers every surface', async () => {
  // `remote.settings` is mounted by the core contribution on every real
  // profile, but the plugin must degrade rather than gate: the scope stays
  // unavailable and the page/panel/card registrations are unaffected.
  const { registered, settingsCalls } = await boot({ mountSettings: false })
  assert.equal(registered.has('commandcode'), true, 'the settings page registers without the transport')
  assert.equal(registered.has('llm-commandcode'), true, 'the provider card registers too')
  assert.equal((registered.get('commandcode-panel') ?? []).length, 2, 'the panel surfaces are unaffected')
  assert.equal(settingsCalls.describe, 0, 'there is no directory to read')
})

test('the client apply gates only on the services every surface needs', () => {
  // `settingsScope` must NOT return to this list: the 0.1.7 settings rewrite
  // removed that wrapper service entirely, so gating on it would silently
  // disable every client surface (settings page, provider card, usage card,
  // panel, session cost). The settings scope speaks `remote.settings` directly
  // and degrades on its own instead of gating the plugin. `connection` is gone
  // too: nothing reads that service any more (the pre-0.1.2 ApiProxy credential
  // face it carried is out of support), and a gate on it would park the whole
  // bundle on a service some profiles never mount.
  assert.deepEqual(inject, ['slots', 'locale', 'remote'])
})
