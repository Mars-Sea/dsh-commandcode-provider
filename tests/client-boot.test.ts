/**
 * Client-boot integration tests (node:test). Run with `npm test`.
 *
 * These drive the *real* `apply()` from `src/client/index.ts` against a Cordis
 * context that mirrors the DSH 0.1.2-alpha.2 client assembly, and assert that
 * both browser UI surfaces register:
 *
 *   - the "Command Code" settings page (`settings.section`, id `commandcode`),
 *   - the Models-page provider card (`settings.models.provider-card`,
 *     key `llm-commandcode`).
 *
 * The registration is gated by `remote.credentials`: DSH 0.1.2-alpha.2 exposes
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
 * DSH 0.1.2-alpha.2 service set: `remote` (mounting the `credentials` and
 * `commandcode` namespaces), `slots`, `locale`, `settingsScope`, `connection`.
 *
 * @param options - whether to mount the `credentials` remote namespace. When
 *   `false`, the plugin must not register any surface (it parks on the
 *   `inject(['remote.credentials'])` gate).
 * @returns the registered slot surfaces, keyed by `id` (settings.section) or
 *   `key` (provider-card), after boot settles.
 */
async function boot({ mountCredentials = true }: { mountCredentials?: boolean } = {}) {
  const ctx = new Context()

  // A faithful stand-in for the api-gateway `ClientRemoteService`: mounting a
  // contribution installs each namespace as a Cordis `remote.<ns>` service, so
  // `inject(['remote.credentials'])` resolves exactly as it does in alpha2.
  ctx.provide('remote', {
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
  })

  await ctx.get<{ $mount: (c: { package: string; descriptors: Array<{ namespace: string; method: string }> }) => Promise<() => void> }>('remote')!.$mount({
    package: 'boot',
    descriptors: [
      // The credentials namespace (dsh-api-settings-controller in alpha2).
      ...(mountCredentials ? [{ namespace: 'credentials', method: 'describe' }] : []),
      // The plugin's own report/models/login namespace (mounted below).
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

  const registered = new Map<string, { name: string }>()
  ctx.provide('slots', {
    inject(name: string, fn: () => void) {
      fn()
    },
    register(options: { id?: string; key?: string; name: string }, _component: unknown) {
      registered.set(options.id ?? options.key!, options)
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

  return registered
}

// ---------------------------------------------------------------------------
// Client boot
// ---------------------------------------------------------------------------

test('app registers the settings page and Models provider card when remote.credentials is mounted', async () => {
  const registered = await boot()

  // The "Command Code" settings page: a `settings.section` entry id `commandcode`.
  assert.equal(registered.has('commandcode'), true, 'settings.section id commandcode should register')
  assert.equal(
    registered.get('commandcode')!.name,
    'settings.section',
    'the registered surface should be the settings section',
  )

  // The Models-page provider card for the `commandcode` adapter family.
  assert.equal(registered.has('llm-commandcode'), true, 'settings.models.provider-card key llm-commandcode should register')
  assert.equal(
    registered.get('llm-commandcode')!.name,
    'settings.models.provider-card',
    'the registered surface should be the provider card',
  )
})

test('app registers no surface when remote.credentials is absent (the alpha2 gate holds)', async () => {
  // Without the credentials namespace the plugin parks on
  // `inject(['remote.credentials'])` and must not register either surface —
  // the legacy `connection.api.credentials` adapter also stays inactive here.
  const registered = await boot({ mountCredentials: false })

  assert.deepEqual([...registered.keys()], [], 'no surface should register without remote.credentials')
})

test('the client apply takes exactly the alpha2 service identities', () => {
  assert.deepEqual(inject, ['slots', 'locale', 'connection', 'remote', 'settingsScope'])
})
