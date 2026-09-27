/**
 * Client-boot integration tests (node:test). Run with `npm test`.
 *
 * These drive the *real* `apply()` from `src/client/index.ts` against a Cordis
 * context mirroring the dsh 0.1.7-rc.2 client assembly, and assert that every
 * browser surface registers: the settings page (`settings.section`, id
 * `commandcode`), the Models-page provider card
 * (`settings.models.provider-card`, key `llm-commandcode`), the panel's `main`
 * cell + `sidebar.footer.action` row, and the composer dock entry.
 *
 * Registration is gated on `remote.credentials` — the harness exposes
 * credentials as a Typert Remote namespace and the plugin parks on
 * `ctx.inject(['remote.credentials'], …)`, the suspicion raised in issue #15.
 * These tests prove the opposite for the real assembly, and then carry the
 * `remote.settings` scope path end to end (directory read, invalidation
 * re-read, a save over the path-op wire, the degraded profile).
 */

import { register } from 'node:module'

// Present *.module.css as empty modules BEFORE the React tree is imported.
// (Static imports hoist above this call, so `apply` must be loaded dynamically.)
register(new URL('./_css-module-loader.mjs', import.meta.url).href)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
// `apply`/`inject` pull in the React tree, which imports `*.module.css`; static
// imports hoist above the `register()` above, so this must stay dynamic.
const { apply, inject } = await import('../src/client/index.ts')

// Helpers

/**
 * Boot the real plugin `apply()` on a fresh Cordis root provisioned with the
 * dsh 0.1.7-rc.2 client service set: `remote` (carrying the `credentials` +
 * `commandcode` namespaces and the `settings` directory the plugin's own scope
 * reads), `slots`, `locale`, and — when `mountLayout` is set — `layout`.
 *
 * There is deliberately NO `settingsScope` service: 0.1.7 removed it. The
 * settings transport is modelled where it really lives — the `remote.settings`
 * namespace — so the boot exercises the same wire the browser uses.
 *
 * @param options `mountCredentials` gates the `remote.credentials` namespace
 *   (false models a profile that mounts no such contribution);
 *   `mountLayout` the `layout` service, whose `selectPanel` is what makes the
 *   sidebar card openable; `mountSettings` the settings directory;
 *   `declaredSlots` the seats the engine declares; `immediateUsageMount`
 *   whether `remote.commandcode` lands on the same tick as `$mount`.
 * @returns the registered slot surfaces, keyed by `id` (settings.section,
 *   panel entries) or `key` (provider-card), after boot settles. Every
 *   registration per key is kept, in registration order.
 */
async function boot(
  {
    mountCredentials = true,
    mountLayout = true,
    // The core contribution's `remote.settings` namespace is on every real
    // profile (api-remotes mounts it with `immediately: true`); `false` models
    // the degraded profile the scope must survive without gating the plugin.
    mountSettings = true,
    // The slots the engine declares; the default is the full dsh 0.1.7-rc.2 set.
    // A narrower set models a client assembly that declares fewer seats (a
    // composition difference, not an engine version).
    declaredSlots = new Set([
      'settings.section',
      'settings.models.provider-card',
      'main',
      'sidebar.footer.action',
      'conversation.composer.dock',
    ]),
    // `false` defers `remote.commandcode` by a macrotask, as the real gateway
    // does — the window a surface can lose a report race in.
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
   * other read answers `cannot get property "remote.<ns>" without inject`. A
   * fake hanging each namespace off a plain object would let the plugin read
   * `ctx.remote.<ns>` without declaring the inject — which is how the 0.1.7
   * settings page shipped read-only.
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

  // The api-gateway `ClientRemoteService` stand-in: a real Service (so nested
  // namespace resolution behaves like the engine's) reporting the `$mount`
  // contribution installer and `$on` forwarded-event face the plugin reads.
  class FakeRemoteService extends Service {
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
      // The plugin's own report/models/prices/login namespace. Not pre-mounted
      // in the deferred variant: there it must NOT exist until the plugin's own
      // `$mount` installs it, which is the whole point of that model.
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
  // The settings transport: the core contribution's `remote.settings` namespace,
  // NOT the ≤0.1.6 `settingsScope` wrapper service — 0.1.7 removed that one. One
  // in-memory namespace row stands in for the Host: `describe()` answers the
  // directory, `mutate()` applies the path ops and answers the fresh ROW.
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

  // Keyed by slot id/key, but ACCUMULATING: the panel registers one `main` cell
  // and one `sidebar.footer.action` row under the same id, so a last-write-wins
  // map would hide one of them. Each entry keeps the registration's `inject`
  // factory, which is how the card's click path is driven below.
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
  // tests exist to pin.
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
  // macrotask queue, so flush a few timer rounds before asserting (cordis wakes
  // a parked inject fiber on a TIMER TICK, not on `setImmediate`, so the rounds
  // are timer rounds).
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

  return { registered, selectedPanels, localeNamespaces, settingsCalls, settingsRow, fireRemoteEvent, commandCodeCalls }
}

// Client boot

test('app registers the settings page and Models provider card when remote.credentials is mounted', async () => {
  const { registered } = await boot()

  assert.equal(registered.has('commandcode'), true, 'settings.section id commandcode should register')
  assert.equal(
    registered.get('commandcode')![0]!.name,
    'settings.section',
    'the registered surface should be the settings section',
  )

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
  const { registered } = await boot({ mountCredentials: false })

  assert.deepEqual([...registered.keys()], [], 'no surface should register without remote.credentials')
})

test('the sidebar card is withheld when the layout cannot open the panel', async () => {
  // The regression this pins: `sidebar.footer.action` RENDERS on every release
  // that declares it, so `slots.inject` fires and an ungated card would register
  // — and then do nothing when clicked, because `layout.selectPanel` may never
  // arrive. A visible button that silently ignores a click is worse than none.
  // `mountLayout: false` still seats the `main` cell (that registration is
  // gated by the slot declaration, not by the service).
  const { registered } = await boot({ mountLayout: false })
  assert.deepEqual(
    (registered.get('commandcode-panel') ?? []).map((entry) => entry.name),
    ['main'],
    'no layout means no card to open a panel with',
  )

  // A layout that mounts the service but declares no keyed `main` seat still
  // gets the CARD: the seat exists and the layout can select panels, but the
  // cell it points at never registers. The composer readout needs only the dock
  // slot and is independent of that seam.
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
  // The id the card selects must be the one the `main` cell registered under,
  // or `selectPanel` would throw and the click would be a dead end.
  assert.deepEqual(selectedPanels, ['commandcode-panel'])
})

test('the dashboard has an exit: close returns to the conversation', async () => {
  // Issue #41: the dashboard replaces the Conversation in the center column and
  // the sidebar card only re-selects it, so without this action the panel is a
  // one-way door. `null` is layout's "show the Conversation" selection.
  const { registered, selectedPanels } = await boot()
  const cell = registered.get('commandcode-panel')?.find((entry) => entry.name === 'main')
  assert.ok(cell?.inject, 'the main cell carries its inject face')
  const face = cell.inject() as { close: () => void }
  face.close()
  assert.deepEqual(selectedPanels, [null])
})

test('close() with no layout mounted is a no-op, never a throw', async () => {
  // The footer card is gated on the layout service, but `close()` is reachable
  // from the dashboard cell whether or not that service is still live.
  const { registered, selectedPanels } = await boot({ mountLayout: false })
  const cell = registered.get('commandcode-panel')?.find((entry) => entry.name === 'main')
  assert.ok(cell?.inject, 'the main cell carries its inject face')
  const face = cell.inject() as { close: () => void }
  face.close()
  assert.deepEqual(selectedPanels, [])
})

test('both panel seats bind the panel locale namespace, which is registered', async () => {
  // The panel follows the harness language through a `t` seat, and a seat only
  // exists when the registration declares the namespace — a missing declaration
  // silently leaves the surfaces English.
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
  // removed `settingsScope` service) and derived the row for both surfaces.
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
  //    back in — what the controller reads as "the write landed".
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
  // `remote.commandcode` namespace lands (`$mount` is a wire round-trip, and
  // the quota card's first paint always does). That answer is the synthetic
  // "remote is not mounted" failure, stored as `status: 'error'` — and
  // `shouldRefresh` only fires from `idle`, so without a refresh from the mount
  // callback the stale error would sit until the panel's two-minute tick.
  const { commandCodeCalls } = await boot({ immediateUsageMount: false })
  // The deferred namespace lands on a macrotask; the plugin's inject callback
  // fires then and issues exactly that refresh.
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(commandCodeCalls.report >= 1, 'the mount callback must re-read the usage report')
})

test('a profile without the settings transport still registers every surface', async () => {
  // `remote.settings` is mounted by the core contribution on every real
  // profile, but the plugin must degrade rather than gate: the scope stays
  // unavailable and every registration is unaffected.
  const { registered, settingsCalls } = await boot({ mountSettings: false })
  assert.equal(registered.has('commandcode'), true, 'the settings page registers without the transport')
  assert.equal(registered.has('llm-commandcode'), true, 'the provider card registers too')
  assert.equal((registered.get('commandcode-panel') ?? []).length, 2, 'the panel surfaces are unaffected')
  assert.equal(settingsCalls.describe, 0, 'there is no directory to read')
})

test('the client apply gates only on the services every surface needs', () => {
  // `settingsScope` must NOT return to this list: 0.1.7's settings rewrite
  // removed that wrapper service, so gating on it would silently disable every
  // client surface. The scope speaks `remote.settings` directly and degrades on
  // its own. `connection` is gone too — nothing reads that service any more,
  // and a gate on it would park the whole bundle.
  assert.deepEqual(inject, ['slots', 'locale', 'remote'])
})
