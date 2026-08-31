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
function makeApi(init: { configured?: boolean; writable?: boolean; store?: Map<string, string>; failSet?: boolean; failUnset?: boolean; models?: SettingsPageApi['models'] }) {
  const store = init.store ?? new Map<string, string>()
  const configured = init.configured ?? store.has(DEFAULT_API_KEY_REF)
  const writable = init.writable ?? true
  const credential = { configured, writable }
  const credentials = {
    describe: async (refs: string[]) => {
      const credentialsMap: Record<string, { configured: boolean; writable: boolean }> = {}
      for (const ref of refs) {
        credentialsMap[ref] = {
          configured: store.has(ref),
          writable,
        }
      }
      return { ok: true as const, value: credentialsMap }
    },
    set: async (ref: string, value: string) => {
      if (init.failSet === true) return { ok: false as const, error: { message: 'write refused' } }
      store.set(ref, value)
      return { ok: true as const, value: undefined }
    },
    unset: async (ref: string) => {
      if (init.failUnset === true) return { ok: false as const, error: { message: 'unset refused' } }
      store.delete(ref)
      return { ok: true as const, value: undefined }
    },
  }
  return { credential, credentials, store, models: init.models }
}/** Build a controller wired to a fresh scope + api. */
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

/** Let the constructor's fire-and-forget describeAll settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
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
  assert.equal(state.requestTimeoutMs.invalidReason, 'format')
  assert.equal(state.invalid, true)
  assert.equal(state.dirty, true)
})

test('an out-of-range numeric draft names the violated bound', () => {
  const { controller } = makeController()
  controller.edit('requestTimeoutMs', '0')
  let state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, true)
  assert.equal(state.requestTimeoutMs.invalidReason, 'tooSmall')
  controller.edit('requestTimeoutMs', '99999999999')
  state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, true)
  assert.equal(state.requestTimeoutMs.invalidReason, 'tooLarge')
  // The inclusive upper bound itself stays valid.
  controller.edit('requestTimeoutMs', '2147483647')
  state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, false)
  assert.equal(state.requestTimeoutMs.invalidReason, undefined)
})

test('an accepted save bumps savedCount for the footer flash', async () => {
  const store = new Map<string, string>()
  const api = makeApi({ store })
  const { controller } = makeController({ api })
  const before = controller.state().savedCount
  assert.equal(before, 0)
  controller.edit('apiKey', 'sk-abc123')
  await controller.save()
  assert.equal(controller.state().savedCount, before + 1)
  // A failed save must not count as saved.
  const failingApi = makeApi({ store, failSet: true })
  const scope2 = makeScope({})
  const failing = makeController({ scope: scope2, api: failingApi }).controller
  failing.edit('apiKey', 'sk-refused')
  await failing.save()
  assert.equal(failing.state().failed, true)
  assert.equal(failing.state().savedCount, 0)
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
// Boolean field (filterModelsByPlan toggle)
// ---------------------------------------------------------------------------

test('save() writes a boolean toggle as a real boolean', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  assert.equal(controller.state().filterModelsByPlan.text, '')
  controller.edit('filterModelsByPlan', 'false')
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.filterModelsByPlan, false)
  assert.equal(controller.state().filterModelsByPlan.text, 'false')
})

test('resetField() on a boolean toggle clears it back to the inherited default', async () => {
  const scope = makeScope({
    value: { filterModelsByPlan: false },
    user: { filterModelsByPlan: false },
  })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().filterModelsByPlan.text, 'false')
  controller.resetField('filterModelsByPlan')
  await controller.save()
  assert.equal(scope.state.user?.filterModelsByPlan, undefined)
  assert.equal(controller.state().filterModelsByPlan.text, '')
})

test('an unrecognized boolean draft blocks save', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.edit('filterModelsByPlan', 'yes')
  assert.equal(controller.state().invalid, true)
  await controller.save()
  assert.equal(scope.state.value.filterModelsByPlan, undefined)
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

// ---------------------------------------------------------------------------
// Multi-account management
// ---------------------------------------------------------------------------

test('starts with no extra accounts and stays clean', () => {
  const { controller } = makeController()
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().dirty, false)
})

test('addAccount stages a new account with a free credential reference', async () => {
  const scope = makeScope({
    value: { accounts: [{ label: 'Go #2', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
    user: { accounts: [{ label: 'Go #2', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
  })
  const { controller } = makeController({ scope })
  controller.addAccount()
  const accounts = controller.state().accounts
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0]?.ref, 'COMMANDCODE_API_KEY_2')
  assert.equal(accounts[0]?.label, 'Go #2')
  assert.equal(accounts[0]?.added, false)
  // The staged addition takes the first free ref and is marked unsaved.
  assert.equal(accounts[1]?.ref, 'COMMANDCODE_API_KEY_3')
  assert.equal(accounts[1]?.added, true)
  assert.equal(controller.state().dirty, true)
})

test('saving an added account writes the key through credentials and the list through the scope', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  controller.addAccount()
  controller.editAccountLabel('COMMANDCODE_API_KEY_2', 'Go #2')
  controller.editAccountKey('COMMANDCODE_API_KEY_2', 'sk-second')
  await controller.save()

  // The key literal went to the credentials domain, never the settings doc.
  assert.equal(api.store.get('COMMANDCODE_API_KEY_2'), 'sk-second')
  const stored = scope.state.value.accounts as Array<Record<string, unknown>>
  assert.deepEqual(stored, [{ label: 'Go #2', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }])
  assert.ok(!('apiKey' in stored[0]!))
  // After the landed save the staging cleared and the account shows configured.
  const account = controller.state().accounts[0]
  assert.equal(account?.added, false)
  assert.equal(account?.configured, true)
  assert.equal(controller.state().dirty, false)
})

test('a blank key draft keeps the stored key but still saves label edits', async () => {
  const scope = makeScope({
    value: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
    user: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
  })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-kept']]) })
  const { controller } = makeController({ scope, api })
  controller.editAccountLabel('COMMANDCODE_API_KEY_2', 'Go #2')
  await controller.save()
  assert.equal(api.store.get('COMMANDCODE_API_KEY_2'), 'sk-kept')
  const stored = scope.state.value.accounts as Array<Record<string, unknown>>
  assert.equal(stored[0]?.label, 'Go #2')
})

test('removeAccount stages removal of a stored account and save persists it', async () => {
  const scope = makeScope({
    value: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
    user: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
  })
  const { controller } = makeController({ scope })
  controller.removeAccount('COMMANDCODE_API_KEY_2')
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(scope.state.value.accounts, [])
  assert.equal(controller.state().dirty, false)
})

test('removing an unsaved addition drops it without touching the scope', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.addAccount()
  controller.removeAccount('COMMANDCODE_API_KEY_2')
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().dirty, false)
})

test('discard clears staged account edits', () => {
  const { controller } = makeController()
  controller.addAccount()
  controller.editAccountKey('COMMANDCODE_API_KEY_2', 'sk-draft')
  controller.discard()
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().dirty, false)
})

test('extra account credential state comes from the credentials domain', async () => {
  const scope = makeScope({
    value: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
  })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-stored']]) })
  const { controller } = makeController({ scope, api })
  // describeAll() ran from the constructor; wait for it to land.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const account = controller.state().accounts[0]
  assert.equal(account?.configured, true)
  assert.equal(account?.writable, true)
})

test('activeAccount stages through the generic field machinery and saves to the section', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  assert.equal(controller.state().activeAccount.text, '')
  controller.edit('activeAccount', 'COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().activeAccount.text, 'COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().activeAccount.overridden, true)
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.activeAccount, 'COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().dirty, false)
  // Selecting "auto" ('') on a stored value stages a clear; save unsets it.
  controller.edit('activeAccount', '')
  await controller.save()
  assert.equal('activeAccount' in scope.state.value, false)
})

test('removing the pinned active account also stages the selection clear', async () => {
  const scope = makeScope({
    value: {
      accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }],
      activeAccount: 'COMMANDCODE_API_KEY_2',
    },
    user: {
      accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }],
      activeAccount: 'COMMANDCODE_API_KEY_2',
    },
  })
  const { controller } = makeController({ scope })
  controller.removeAccount('COMMANDCODE_API_KEY_2')
  // The removal stages the activeAccount clear; one save persists both.
  await controller.save()
  assert.deepEqual(scope.state.value.accounts, [])
  assert.equal('activeAccount' in scope.state.value, false)
})

test('a failed key write aborts the save before the accounts list lands', async () => {
  const scope = makeScope({})
  const store = new Map<string, string>()
  const api = {
    credentials: {
      describe: async (refs: string[]) => ({
        ok: true as const,
        value: Object.fromEntries(refs.map((ref) => [ref, { configured: store.has(ref), writable: true }])),
      }),
      // The credentials domain rejects every write.
      set: async () => ({ ok: false as const, error: { message: 'read-only' } }),
    },
  }
  const { controller } = makeController({ scope, api: api as unknown as ReturnType<typeof makeApi> })
  controller.addAccount()
  controller.editAccountKey('COMMANDCODE_API_KEY_2', 'sk-second')
  await controller.save()

  assert.equal(controller.state().failed, true)
  // The accounts list write never ran (short-circuit at the failed key write),
  // so nothing partial landed…
  assert.equal('accounts' in scope.state.value, false)
  // …and the staged addition survives exactly once for the retry — no
  // stored-plus-staged duplication.
  assert.equal(controller.state().accounts.length, 1)
  assert.equal(controller.state().accounts[0]?.added, true)
})

test('staged removals surface in accountsRemoving until the save lands', async () => {
  const scope = makeScope({
    value: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
    user: { accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] },
  })
  const { controller } = makeController({ scope })
  assert.deepEqual(controller.state().accountsRemoving, [])
  controller.removeAccount('COMMANDCODE_API_KEY_2')
  // Staged: hidden from the accounts list, visible to the usage card.
  assert.deepEqual(controller.state().accounts, [])
  assert.deepEqual(controller.state().accountsRemoving, ['COMMANDCODE_API_KEY_2'])
  await controller.save()
  assert.deepEqual(controller.state().accountsRemoving, [])
})

// ---------------------------------------------------------------------------
// Clearing a stored (bad) key — the credentials.unset path
// ---------------------------------------------------------------------------

test('a staged default-key clear unsets the credential on save', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-expired']])
  const api = makeApi({ store })
  const { controller } = makeController({ api })
  await flush()
  assert.equal(controller.state().apiKeyConfigured, true)
  controller.toggleKeyClear('default')
  assert.equal(controller.state().apiKeyClearStaged, true)
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(store.has(DEFAULT_API_KEY_REF), false)
  assert.equal(controller.state().apiKeyConfigured, false)
  assert.equal(controller.state().apiKeyClearStaged, false)
  assert.equal(controller.state().savedCount, 1)
})

test('toggleKeyClear toggles, and typing a replacement cancels the staged clear', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-old']])
  const api = makeApi({ store })
  const { controller } = makeController({ api })
  await flush()
  controller.toggleKeyClear('default')
  assert.equal(controller.state().apiKeyClearStaged, true)
  controller.toggleKeyClear('default')
  assert.equal(controller.state().apiKeyClearStaged, false)
  // Staging again, then typing a replacement: the clear must be dropped so
  // the typed key is what lands.
  controller.toggleKeyClear('default')
  controller.edit('apiKey', 'sk-new')
  assert.equal(controller.state().apiKeyClearStaged, false)
  await controller.save()
  assert.equal(store.get(DEFAULT_API_KEY_REF), 'sk-new')
})

test('staging a clear on an unconfigured key is a no-op', async () => {
  const api = makeApi({ store: new Map() })
  const { controller } = makeController({ api })
  controller.toggleKeyClear('default')
  assert.equal(controller.state().apiKeyClearStaged, false)
  assert.equal(controller.state().dirty, false)
})

test('an extra account key can be cleared through its reference', async () => {
  const store = new Map<string, string>([['COMMANDCODE_API_KEY_2', 'sk-bad']])
  const api = makeApi({ store })
  const scope = makeScope({ value: { accounts: [{ label: 'Go #2', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }] } })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(controller.state().accounts[0]?.configured, true)
  controller.toggleKeyClear('COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().accounts[0]?.clearStaged, true)
  await controller.save()
  assert.equal(store.has('COMMANDCODE_API_KEY_2'), false)
  assert.equal(controller.state().accounts[0]?.configured, false)
  assert.equal(controller.state().accounts[0]?.clearStaged, false)
})

test('a failed unset keeps the staged clear and reports the failure', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-expired']])
  const api = makeApi({ store, failUnset: true })
  const { controller } = makeController({ api })
  await flush()
  controller.toggleKeyClear('default')
  await controller.save()
  assert.equal(controller.state().failed, true)
  // The clear did not land; it stays staged so a retry re-attempts it.
  assert.equal(controller.state().apiKeyClearStaged, true)
  assert.equal(store.has(DEFAULT_API_KEY_REF), true)
  assert.equal(controller.state().savedCount, 0)
})

// ---------------------------------------------------------------------------
// Model → account routing rules
// ---------------------------------------------------------------------------

test('starts with the stored routing rules and stays clean', () => {
  const scope = makeScope({
    value: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'COMMANDCODE_API_KEY_2' }] },
    user: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'COMMANDCODE_API_KEY_2' }] },
  })
  const { controller } = makeController({ scope })
  const rules = controller.state().rules
  assert.equal(rules.length, 1)
  assert.deepEqual(rules[0]?.models, ['deepseek/deepseek-v4-pro'])
  assert.equal(rules[0]?.account, 'COMMANDCODE_API_KEY_2')
  assert.equal(rules[0]?.added, false)
  assert.equal(controller.state().dirty, false)
})

test('addRule stages a new rule with the default account target', () => {
  const { controller } = makeController()
  controller.addRule()
  const rules = controller.state().rules
  assert.equal(rules.length, 1)
  assert.equal(rules[0]?.added, true)
  assert.deepEqual(rules[0]?.models, [])
  assert.equal(rules[0]?.account, 'default')
  assert.equal(controller.state().dirty, true)
})

test('saving a staged rule writes modelAccountRules through the scope', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.addRule()
  controller.editRuleModels('new-0', ['deepseek/deepseek-v4-pro'])
  controller.editRuleAccount('new-0', 'COMMANDCODE_API_KEY_2')
  await controller.save()
  assert.deepEqual(scope.state.value.modelAccountRules, [
    { models: ['deepseek/deepseek-v4-pro'], account: 'COMMANDCODE_API_KEY_2' },
  ])
  assert.equal(controller.state().dirty, false)
})

test('editing a stored rule is dirty until saved', async () => {
  const scope = makeScope({
    value: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }] },
    user: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }] },
  })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().dirty, false)
  controller.editRuleModels('rule-0', ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp'])
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(scope.state.value.modelAccountRules, [
    { models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp'], account: 'default' },
  ])
  assert.equal(controller.state().dirty, false)
})

test('removing a stored rule persists the shorter list', async () => {
  const scope = makeScope({
    value: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }] },
    user: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }] },
  })
  const { controller } = makeController({ scope })
  controller.removeRule('rule-0')
  assert.deepEqual(controller.state().rules, [])
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(scope.state.value.modelAccountRules, [])
  assert.equal(controller.state().dirty, false)
})

test('discard clears staged rule edits', () => {
  const { controller } = makeController()
  controller.addRule()
  controller.editRuleModels('new-0', ['deepseek/deepseek-v4-pro'])
  controller.discard()
  assert.deepEqual(controller.state().rules, [])
  assert.equal(controller.state().dirty, false)
})

test('loads the model catalog through the api models seam', async () => {
  const api = makeApi({
    models: async () => ({
      ok: true as const,
      value: { models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    }),
  })
  const { controller } = makeController({ api })
  await flush()
  assert.deepEqual(controller.state().catalogModels, [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])
  assert.equal(controller.state().catalogFailed, false)
})

test('a failed catalog fetch marks catalogFailed without breaking the page', async () => {
  const api = makeApi({
    models: async () => ({ ok: false as const, error: { message: 'remote down' } }),
  })
  const { controller } = makeController({ api })
  await flush()
  assert.equal(controller.state().catalogFailed, true)
  assert.deepEqual(controller.state().catalogModels, [])
})

test('refreshCatalog recovers after the Remote mount lands', async () => {
  // The controller is constructed before the Remote mount; the first fetch
  // fails (not mounted). Once the mount lands, refreshCatalog() re-fetches
  // and clears the failure flag — the rule editor must recover without a
  // page reload.
  let mounted = false
  const api = makeApi({
    models: async () => mounted
      ? { ok: true as const, value: { models: [{ id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview' }] } }
      : { ok: false as const, error: { message: 'commandcode/models remote is not mounted' } },
  })
  const { controller } = makeController({ api })
  await flush()
  assert.equal(controller.state().catalogFailed, true)
  assert.deepEqual(controller.state().catalogModels, [])
  // The mount lands; the client entry calls refreshCatalog().
  mounted = true
  controller.refreshCatalog()
  await flush()
  assert.equal(controller.state().catalogFailed, false)
  assert.deepEqual(controller.state().catalogModels, [{ id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview' }])
})
