/**
 * Settings-page controller tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the "Command Code" settings page's write path: the API key is
 * written through the credentials domain under the reference the plugin
 * resolves (never through the settings namespace, so the literal cannot leak
 * into a settings document), while connection facts (`apiBase`, `workingDir`,
 * timeouts) are written through the `llm-commandcode` namespace scope. The
 * Host stays the single fact source — every write is read back from the
 * scope before the state is republished.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CommandCodeSettingsController,
  DEFAULT_API_KEY_REF,
  COMMANDCODE_NS,
  type SettingsPageApi,
  type SettingsPageState,
} from '../src/client/settings.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A scope whose value/user layers we control directly (mirrors the wire shape). */
function makeScope(init: {
  status?: 'ready' | 'unavailable'
  writable?: boolean
  value?: Record<string, unknown>
  user?: Record<string, unknown>
  base?: Record<string, unknown>
}) {
  const state = {
    status: init.status ?? 'ready',
    value: init.value ?? {},
    user: init.user,
    base: init.base,
    revision: 1,
    writable: init.writable ?? true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  return {
    state,
    getSnapshot() {
      return state
    },
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
      const user = { ...(state.user ?? {}) }
      delete user[field]
      state.user = user
      for (const fn of listeners) fn()
    },
  }
}

type Scope = ReturnType<typeof makeScope>

/** The credentials-domain slice the page writes through. */
function makeApi(init: { configured?: boolean; writable?: boolean; store?: Map<string, string> }) {
  const store = init.store ?? new Map<string, string>()
  const configured = init.configured ?? store.has(DEFAULT_API_KEY_REF)
  const writable = init.writable ?? true
  const credential = { configured, writable }
  const credentials = {
    describe: async ({ refs }: { refs: string[] }) => {
      const credentialsMap: Record<string, { configured: boolean; writable: boolean }> = {}
      for (const ref of refs) {
        credentialsMap[ref] = {
          configured: store.has(ref),
          writable,
        }
      }
      return { result: { ok: true as const, value: { credentials: credentialsMap } } }
    },
    set: async ({ ref, value }: { ref: string; value: string }) => {
      store.set(ref, value)
      return { result: { ok: true as const, value: {} } }
    },
  }
  return { credential, credentials, store }
}

/** Build a controller wired to a fresh scope + api. */
function makeController(opts?: {
  scope?: ReturnType<typeof makeScope>
  api?: ReturnType<typeof makeApi>
  hostDescription?: { cwd?: string } | undefined
}) {
  const scope = opts?.scope ?? makeScope({})
  const api = opts?.api ?? makeApi({})
  const hostDescription = opts?.hostDescription === undefined
    ? undefined
    : {
        getSnapshot: () => opts.hostDescription,
        subscribe: () => () => {},
      }
  const controller = new CommandCodeSettingsController(
    scope,
    api as unknown as SettingsPageApi,
    hostDescription,
  )
  return { controller, scope, api }
}

// ---------------------------------------------------------------------------
// State projection
// ---------------------------------------------------------------------------

test('reports the API key as unconfigured when no credential is stored', () => {
  const { controller } = makeController()
  const state = controller.state()
  assert.equal(state.available, true)
  assert.equal(state.apiKeyConfigured, false)
  assert.equal(state.apiKeyWritable, true)
})

test('reports the API key as configured when a credential is stored', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-test']])
  const api = makeApi({ store })
  const { controller } = makeController({ api })
  await new Promise((resolve) => setImmediate(resolve))
  const state = controller.state()
  assert.equal(state.apiKeyConfigured, true)
})

test('addresses the renamed apiKeyEnv reference from the settings section', async () => {
  const store = new Map<string, string>([['MY_CUSTOM_REF', 'sk-renamed']])
  const api = makeApi({ store })
  const scope = makeScope({ value: { apiKeyEnv: 'MY_CUSTOM_REF' } })
  const { controller } = makeController({ scope, api })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.state().apiKeyConfigured, true)
  // A staged key must land under the section's ref, not the default.
  controller.edit('apiKey', 'sk-new')
  await controller.save()
  assert.equal(store.get('MY_CUSTOM_REF'), 'sk-new')
  assert.equal(store.has(DEFAULT_API_KEY_REF), false)
})

test('mirrors section values into the field drafts', () => {
  const scope = makeScope({
    value: { apiBase: 'https://example.com', requestTimeoutMs: 30_000 },
    user: { apiBase: 'https://example.com' },
  })
  const { controller } = makeController({ scope })
  const state = controller.state()
  assert.equal(state.apiBase.text, 'https://example.com')
  assert.equal(state.apiBase.overridden, true)
  assert.equal(state.requestTimeoutMs.text, '30000')
  assert.equal(state.requestTimeoutMs.overridden, false)
})

test('exposes the Host cwd as the workingDir default placeholder', () => {
  const { controller } = makeController({ hostDescription: { cwd: '/home/me/proj' } })
  const state = controller.state()
  assert.equal(state.defaultWorkingDir, '/home/me/proj')
})

test('has no workingDir default when the Host description is absent', () => {
  const { controller } = makeController()
  assert.equal(controller.state().defaultWorkingDir, undefined)
})

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

test('edit() stages a draft and marks the page dirty', () => {
  const { controller } = makeController()
  controller.edit('apiBase', 'https://new.example.com')
  const state = controller.state()
  assert.equal(state.apiBase.text, 'https://new.example.com')
  assert.equal(state.dirty, true)
})

test('editing back to the stored value is not dirty', () => {
  const scope = makeScope({ value: { apiBase: 'https://example.com' } })
  const { controller } = makeController({ scope })
  controller.edit('apiBase', 'https://example.com')
  const state = controller.state()
  assert.equal(state.dirty, false)
})

test('an invalid numeric draft blocks save', () => {
  const { controller } = makeController()
  controller.edit('requestTimeoutMs', 'abc')
  const state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, true)
  assert.equal(state.invalid, true)
  assert.equal(state.dirty, true)
})

test('discard() drops every staged edit', () => {
  const scope = makeScope({ value: { apiBase: 'https://example.com' } })
  const { controller } = makeController({ scope })
  controller.edit('apiBase', 'https://new.example.com')
  controller.discard()
  const state = controller.state()
  assert.equal(state.apiBase.text, 'https://example.com')
  assert.equal(state.dirty, false)
})

// ---------------------------------------------------------------------------
// Save: API key via credentials domain
// ---------------------------------------------------------------------------

test('save() writes a staged API key through credentials.set, never the settings scope', async () => {
  const store = new Map<string, string>()
  const api = makeApi({ store })
  const scope = makeScope({})
  const { controller } = makeController({ scope, api })
  controller.edit('apiKey', 'sk-abc123')
  assert.equal(store.has(DEFAULT_API_KEY_REF), false)
  await controller.save()
  assert.equal(store.get(DEFAULT_API_KEY_REF), 'sk-abc123')
  // The key must not land in the settings document.
  assert.equal(scope.state.value.apiKey, undefined)
  // The save re-reads the credential so the badge flips.
  const state = controller.state()
  assert.equal(state.apiKeyConfigured, true)
  assert.equal(state.dirty, false)
})

test('save() with a blank API key draft keeps the stored key', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-keep']])
  const api = makeApi({ store })
  const { controller } = makeController({ api })
  controller.edit('apiKey', '   ')
  await controller.save()
  assert.equal(store.get(DEFAULT_API_KEY_REF), 'sk-keep')
})

// ---------------------------------------------------------------------------
// Save: connection facts through the settings namespace
// ---------------------------------------------------------------------------

test('save() writes connection fields through the settings scope', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.edit('apiBase', 'https://new.example.com')
  controller.edit('requestTimeoutMs', '45000')
  await controller.save()
  assert.equal(scope.state.value.apiBase, 'https://new.example.com')
  assert.equal(scope.state.value.requestTimeoutMs, 45_000)
  const state = controller.state()
  assert.equal(state.dirty, false)
})

test('save() clears a field when its draft is emptied', async () => {
  const scope = makeScope({
    value: { workingDir: '/tmp/x', apiBase: 'https://a.com' },
    user: { workingDir: '/tmp/x' },
  })
  const { controller } = makeController({ scope })
  controller.edit('workingDir', '')
  await controller.save()
  assert.equal(scope.state.value.workingDir, undefined)
})

test('resetField() stages a clear back to the inherited value', async () => {
  const scope = makeScope({
    value: { apiBase: 'https://user.example.com' },
    base: { apiBase: 'https://api.commandcode.ai' },
    user: { apiBase: 'https://user.example.com' },
  })
  const { controller } = makeController({ scope })
  controller.resetField('apiBase')
  const state = controller.state()
  assert.equal(state.apiBase.text, 'https://api.commandcode.ai')
  assert.equal(state.dirty, true)
  await controller.save()
  assert.equal(scope.state.value.apiBase, undefined)
  assert.equal(scope.state.user?.apiBase, undefined)
})

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('save() reports failure when a credentials write rejects and keeps drafts', async () => {
  const api = makeApi({})
  api.credentials.set = async () => {
    throw new Error('boom')
  }
  const { controller } = makeController({ api })
  controller.edit('apiKey', 'sk-bad')
  await controller.save()
  const state = controller.state()
  assert.equal(state.failed, true)
  assert.equal(state.dirty, true)
  assert.equal(state.apiKey.text, 'sk-bad')
})

test('a credentials.set that returns not-ok reports failure', async () => {
  const api = makeApi({})
  api.credentials.set = async () => ({ result: { ok: false as const, error: { message: 'rejected' } } })
  const { controller } = makeController({ api })
  controller.edit('apiKey', 'sk-bad')
  await controller.save()
  assert.equal(controller.state().failed, true)
})

test('save() refuses when a numeric draft is invalid', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.edit('requestTimeoutMs', 'nope')
  await controller.save()
  assert.equal(scope.state.value.requestTimeoutMs, undefined)
  assert.equal(controller.state().failed, false)
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('dispose() releases external subscriptions and stops publishing', () => {
  let hostListener: (() => void) | undefined
  let hostSubscribed = false
  const host = {
    cwd: '/home/me/proj',
    getSnapshot: () => ({ cwd: host.cwd }),
    subscribe(fn: () => void) {
      hostSubscribed = true
      hostListener = fn
      return () => {
        hostSubscribed = false
        hostListener = undefined
      }
    },
  }
  const scope = makeScope({})
  const api = makeApi({})
  const controller = new CommandCodeSettingsController(scope, api as unknown as SettingsPageApi, host)
  assert.equal(controller.state().defaultWorkingDir, '/home/me/proj')
  assert.equal(hostSubscribed, true)

  controller.dispose()
  // The host subscription was released, so an external cwd change no longer
  // reaches the controller.
  assert.equal(hostSubscribed, false)
  host.cwd = '/elsewhere'
  hostListener?.()
  assert.equal(controller.state().defaultWorkingDir, '/home/me/proj')
})
