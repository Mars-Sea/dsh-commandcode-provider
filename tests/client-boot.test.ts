/**
 * Client-boot integration tests (node:test). Run with `npm test`.
 *
 * These drive the *real* `apply()` from `src/client/index.ts` against a Cordis
 * context that mirrors the DSH 0.1.2 (rc.1) client assembly, and assert that
 * both browser UI surfaces register:
 *
 *   - the "Command Code" settings page (`settings.section`, id `commandcode`),
 *   - the Models-page provider card (`settings.models.provider-card`,
 *     key `llm-commandcode`).
 *
 * The registration is gated by `remote.credentials`: DSH 0.1.2 (rc.1) exposes
 * credentials through a Typert Remote namespace, and the plugin waits on
 * `ctx.inject(['remote.credentials'], ...)` before mounting the surfaces. This
 * is exactly the suspicion raised in GitHub issue #15 (that alpha2 "does not
 * mount a `credentials` remote namespace", so the surfaces never register).
 * These tests prove the opposite for the real alpha2 assembly: mounting the
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

import { Context } from '@deepseek-ai/cordis'
// `apply`/`inject` pull the React component tree in (via `section.tsx` /
// `card.tsx`), which imports `*.module.css` from dsh-client-ui-primitives.
// Static imports hoist above the `register()` call above, so load this one
// dynamically — only then is the CSS-module loader in effect.
const { apply, inject } = await import('../src/client/index.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A bound settings scope whose value/user layers we control directly. */
function makeScope() {
  const state = {
    status: 'ready' as const,
    value: {} as Record<string, unknown>,
    user: undefined as Record<string, unknown> | undefined,
    base: undefined as Record<string, unknown> | undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async set(field: string, value: unknown) {
      state.value = { ...state.value, [field]: value }
      state.user = { ...(state.user ?? {}), [field]: value }
      for (const fn of listeners) fn()
    },
    async unset(field: string) {
      const next = { ...state.value }
      delete next[field]
      state.value = next
      for (const fn of listeners) fn()
    },
  }
}

/**
 * Boot the real plugin `apply()` on a fresh Cordis root provisioned with the
 * DSH 0.1.2 (rc.1) service set: `remote` (mounting the `credentials` and
 * `commandcode` namespaces), `slots`, `locale`, `settingsScope`, `connection`,
 * and — when `mountLayout` is set — `layout`.
 *
 * @param options - whether to mount the `credentials` remote namespace. When
 *   `false`, the plugin must not register any surface (it parks on the
 *   `inject(['remote.credentials'])` gate). `mountLayout` controls the
 *   `layout` service, whose `selectPanel` is what makes the sidebar card
 *   openable; `layoutSelectPanel` optionally omits that method to model a
 *   pre-0.1.5 layout.
 * @returns the registered slot surfaces, keyed by `id` (settings.section,
 *   panel entries) or `key` (provider-card), after boot settles. Every
 *   registration per key is kept, in registration order.
 */
async function boot(
  {
    mountCredentials = true,
    mountLayout = true,
    layoutSelectPanel = true,
    // The slots the engine declares. The default is the 0.1.5 set; a pre-0.1.5
    // engine declares the composer dock and the sidebar foot (both since
    // 0.1.1-rc.2) but has no keyed `main` — the centre column is `conversation`
    // — so passing that set is how the version boundary is exercised. The
    // settings seats have been declared since 0.1.2 and are always present.
    declaredSlots = new Set([
      'settings.section',
      'settings.models.provider-card',
      'main',
      'sidebar.footer.action',
      'conversation.composer.dock',
    ]),
  }: {
    mountCredentials?: boolean
    mountLayout?: boolean
    layoutSelectPanel?: boolean
    declaredSlots?: Set<string>
  } = {},
) {
  const ctx = new Context()
  const selectedPanels: string[] = []

  // A faithful stand-in for the api-gateway `ClientRemoteService`: mounting a
  // contribution installs each namespace as a Cordis `remote.<ns>` service, so
  // `inject(['remote.credentials'])` resolves exactly as it does in alpha2.
  const clientRemote = {
    async $mount(contribution: { package: string; descriptors: Array<{ namespace: string; method: string }> }) {
      const groups = new Map<string, Array<{ method: string }>>()
      for (const descriptor of contribution.descriptors) {
        const group = groups.get(descriptor.namespace) ?? []
        group.push(descriptor)
        groups.set(descriptor.namespace, group)
      }
      for (const [ns, descriptors] of groups) {
        await ctx.plugin({
          name: `remote.${ns}`,
          apply(c: Context) {
            const service: Record<string, unknown> = {}
            for (const descriptor of descriptors) {
              service[descriptor.method] = async (..._args: unknown[]) => ({ ok: true, value: undefined })
            }
            c.provide(`remote.${ns}`, service)
          },
        })
      }
      return async () => {}
    },
    $on(_event: string, _listener: () => void) {
      return () => {}
    },
  }
  ctx.provide('remote', clientRemote)

  await clientRemote.$mount({
    package: 'boot',
    descriptors: [
      // The credentials namespace (dsh-api-settings-controller in alpha2).
      ...(mountCredentials ? [{ namespace: 'credentials', method: 'describe' }] : []),
      // The plugin's own report/models/prices/login namespace (mounted below).
      { namespace: 'commandcode', method: 'report' },
    ],
  })

  ctx.provide('connection', {})
  ctx.provide('locale', {
    register: () => () => {},
    bind: (ns: string) => (key: string) => `${ns}:${key}`,
    getLocale: () => ({ active: 'en' }),
  })
  ctx.provide('settingsScope', { bind: () => makeScope() })

  // ui-layout's selection seam. Present from 0.1.5-rc.1; `layoutSelectPanel:
  // false` models the 0.1.2/0.1.3/0.1.5-alpha.1 layouts, which provide the
  // service but no way to select a panel.
  if (mountLayout) {
    ctx.provide('layout', layoutSelectPanel
      ? { selectPanel: (id: string) => selectedPanels.push(id) }
      : {})
  }

  // Keyed by slot id/key, but ACCUMULATING: the panel registers one `main`
  // cell and one `sidebar.footer.action` row under the same id, so a
  // last-write-wins map would hide the other registration. Each entry keeps the
  // registration's `inject` factory so a test can build the face the component
  // receives — which is how the card's click path is driven below.
  const registered = new Map<string, Array<{ name: string; id?: string; key?: string; inject?: () => object }>>()
  const record = (options: { name: string; id?: string; key?: string; inject?: () => object }): void => {
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
    register(options: { id?: string; key?: string; name: string; inject?: () => object }, _component: unknown) {
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

  return { registered, selectedPanels }
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

test('app registers no surface when remote.credentials is absent (the alpha2 gate holds)', async () => {
  // Without the credentials namespace the plugin parks on
  // `inject(['remote.credentials'])` and must not register either surface —
  // the legacy `connection.api.credentials` adapter also stays inactive here.
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

  // The same for a 0.1.2-style layout that mounts the service without the
  // method (0.1.2-rc.1, 0.1.3-alpha.2, 0.1.5-alpha.1). This is the version
  // boundary the plugin's own docs used to get wrong: the sidebar seat exists
  // and renders there, so an ungated card would be a visible dead button.
  const older = await boot({ layoutSelectPanel: false })
  assert.deepEqual(
    (older.registered.get('commandcode-panel') ?? []).map((entry) => entry.name),
    ['main'],
    'a layout without selectPanel must not get the card',
  )

  // And a pre-0.1.5 engine declares no keyed `main` at all, so the dashboard
  // cell cannot seat there. The CARD still does — that seat exists and the
  // layout can select panels — but it points at a cell that never registered,
  // which is exactly why the version floor has to be stated per slot: "the
  // panel needs 0.1.5" is true of the `main` seat, not of the sidebar seat.
  //
  // This is a synthetic mix on purpose. In the real releases `selectPanel` and
  // `main` arrive together in the 0.1.5 line (`main` in alpha.2, `selectPanel`
  // in rc.1), and `selectPanel` is absent in everything a user can install
  // before it — so the gate above is what keeps the card off those engines.
  const preMain = await boot({
    declaredSlots: new Set(['settings.section', 'settings.models.provider-card', 'sidebar.footer.action', 'conversation.composer.dock']),
  })
  assert.deepEqual(
    (preMain.registered.get('commandcode-panel') ?? []).map((entry) => entry.name),
    ['sidebar.footer.action'],
    'a pre-0.1.5 layout has no keyed main cell to seat',
  )

  // The composer readout is independent of that seam: it needs the dock slot,
  // which every supported release declares, so it still registers.
  assert.equal(older.registered.has('commandcode-session-cost'), true)
  assert.equal(preMain.registered.has('commandcode-session-cost'), true)
  // ...and the shipped surfaces are untouched either way.
  assert.equal(older.registered.get('commandcode')![0]!.name, 'settings.section')
  assert.equal(older.registered.get('llm-commandcode')![0]!.name, 'settings.models.provider-card')
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

test('the client apply takes exactly the alpha2 service identities', () => {
  assert.deepEqual(inject, ['slots', 'locale', 'connection', 'remote', 'settingsScope'])
})
