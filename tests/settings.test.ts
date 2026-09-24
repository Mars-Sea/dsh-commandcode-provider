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
  type SettingsPageApi,
} from '../src/client/settings.ts'
import {
  COMMAND_GUARD_DEFAULT_THRESHOLD,
  COMMAND_GUARD_MAX_THRESHOLD,
  COMMAND_GUARD_MAX_TIMEOUT_MS,
  COMMAND_GUARD_MIN_THRESHOLD,
  COMMAND_GUARD_MIN_TIMEOUT_MS,
} from '../src/command-guard.ts'

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

/**
 * The catalog Remote call as a fixture may state it. The Host's payload comes
 * from outside the type system and `refreshCatalog()` parses it defensively, so
 * a case may deliberately carry malformed entries.
 */
type ModelsStub = () => Promise<{
  ok: boolean
  value?: { models: readonly unknown[] }
  error?: { message: string }
}>

/** The credentials-domain slice the page writes through. */
function makeApi(init: { configured?: boolean; writable?: boolean; store?: Map<string, string>; failSet?: boolean; failUnset?: boolean; models?: ModelsStub }) {
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
}) {
  const scope = opts?.scope ?? makeScope({})
  const api = opts?.api ?? makeApi({})
  const controller = new CommandCodeSettingsController(
    scope,
    api as unknown as SettingsPageApi,
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

test('save() writes the webSearch toggle as a real boolean', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  assert.equal(controller.state().webSearch.text, '')
  controller.edit('webSearch', 'false')
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.webSearch, false)
  assert.equal(controller.state().webSearch.text, 'false')
})

test('resetField() on webSearch clears it back to the inherited default', async () => {
  const scope = makeScope({
    value: { webSearch: true },
    user: { webSearch: true },
  })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().webSearch.text, 'true')
  controller.resetField('webSearch')
  await controller.save()
  assert.equal(scope.state.user?.webSearch, undefined)
  assert.equal(controller.state().webSearch.text, '')
})

test('save() writes the zdr toggle as a real boolean, off when unset', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  // Unset is the fresh-install shape, and unset means off: ZDR changes which
  // upstream serves a request and usually what it costs, so nobody gets it by
  // accident (the Host schema defaults it to false).
  assert.equal(controller.state().zdr.text, '')
  controller.edit('zdr', 'true')
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.zdr, true)
  assert.equal(controller.state().zdr.text, 'true')
})

test('resetField() on zdr clears it back to the inherited default', async () => {
  const scope = makeScope({
    value: { zdr: true },
    user: { zdr: true },
  })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().zdr.text, 'true')
  assert.equal(controller.state().zdr.overridden, true)
  controller.resetField('zdr')
  await controller.save()
  assert.equal(scope.state.user?.zdr, undefined)
  assert.equal(controller.state().zdr.text, '')
})

test('save() writes the sidebar quota toggle as a real boolean, off when unset', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  // Unset is the fresh-install shape, and unset means hidden (the sidebar
  // quota card is opt-in; the Host schema defaults it to false).
  assert.equal(controller.state().showSidebarQuota.text, '')
  controller.edit('showSidebarQuota', 'true')
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.showSidebarQuota, true)
  assert.equal(controller.state().showSidebarQuota.text, 'true')
})

test('the sidebar card follows the SAVED toggle, never the staged draft', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  // The panel surface reads `sidebarQuota` (the stored fact), so an unsaved
  // edit cannot show or hide the card: the staging outlives a discarded edit,
  // and a card driven by it would survive until the client reloaded.
  assert.equal(controller.state().sidebarQuota, false)
  controller.edit('showSidebarQuota', 'true')
  assert.equal(controller.state().showSidebarQuota.text, 'true')
  assert.equal(controller.state().sidebarQuota, false, 'a staged edit must not show the card')
  await controller.save()
  assert.equal(controller.state().sidebarQuota, true, 'a landed save flips the card without a reload')
  controller.edit('showSidebarQuota', 'false')
  assert.equal(controller.state().sidebarQuota, true, 'staging it off must not hide the card either')
  await controller.save()
  assert.equal(controller.state().sidebarQuota, false)
})

test('resetField() on showSidebarQuota clears it back to the inherited default', async () => {
  const scope = makeScope({
    value: { showSidebarQuota: true },
    user: { showSidebarQuota: true },
  })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().showSidebarQuota.text, 'true')
  assert.equal(controller.state().sidebarQuota, true)
  controller.resetField('showSidebarQuota')
  await controller.save()
  assert.equal(scope.state.user?.showSidebarQuota, undefined)
  assert.equal(controller.state().showSidebarQuota.text, '')
  assert.equal(controller.state().sidebarQuota, false)
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
  api.credentials.set = async () => ({ ok: false as const, error: { message: 'rejected' } })
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

test('dispose() releases external subscriptions and stops publishing', async () => {
  const { controller, scope } = makeController()
  let published = 0
  controller.subscribe(() => { published += 1 })
  controller.dispose()
  // A scope update after disposal must not reach subscribers: every external
  // subscription was released with the controller.
  await scope.set('apiBase', 'https://elsewhere.example')
  assert.equal(published, 0)
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

test('addAccount derives new refs from a renamed apiKeyEnv prefix', async () => {
  const scope = makeScope({ value: { apiKeyEnv: 'MY_CUSTOM_REF' } })
  const { controller } = makeController({ scope })
  controller.addAccount()
  const accounts = controller.state().accounts
  assert.equal(accounts[0]?.ref, 'MY_CUSTOM_REF_2')
  assert.equal(accounts[0]?.label, 'Account 2')
  assert.equal(accounts[0]?.added, true)
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

test('a partially landed save does not duplicate a staged rule on retry', async () => {
  // Add rule R; the rules write lands but a later write fails. The retry
  // must not persist R twice — reconcile drops the landed addition.
  const scope = makeScope({})
  const realSet = scope.set.bind(scope)
  let failNext = false
  scope.set = async (field: string, value: unknown) => {
    if (failNext && field === 'visibleModels') throw new Error('later write refused')
    return realSet(field, value)
  }
  const { controller } = makeController({ scope })
  controller.addRule()
  controller.editRuleModels('new-0', ['deepseek/deepseek-v4-pro'])
  controller.editVisibleModels(['deepseek/deepseek-v4-pro'])
  failNext = true
  await controller.save()
  assert.equal(controller.state().failed, true)
  const rules = scope.state.value.modelAccountRules as Array<{ models: string[] }>
  assert.equal(rules.length, 1)
  // Retry with the later write fixed: still exactly one rule.
  failNext = false
  await controller.save()
  assert.equal(controller.state().failed, false)
  assert.equal((scope.state.value.modelAccountRules as unknown[]).length, 1)
  assert.equal(controller.state().dirty, false)
})

test('a staged removal still filters its row after stored ids shift', async () => {
  // Remove rule-1 (of two), then a failed save lands an unrelated change
  // that shifts positional ids. Reconcile is content-based, so the removal
  // still addresses the snapshotted row — not the shifted id.
  const scope = makeScope({
    value: {
      modelAccountRules: [
        { models: ['a-model'], account: 'default' },
        { models: ['b-model'], account: 'default' },
      ],
    },
    user: {
      modelAccountRules: [
        { models: ['a-model'], account: 'default' },
        { models: ['b-model'], account: 'default' },
      ],
    },
  })
  const { controller } = makeController({ scope })
  controller.removeRule('rule-1')
  assert.deepEqual(controller.state().rules.map((rule) => rule.models), [['a-model']])
  await controller.save()
  assert.deepEqual(scope.state.value.modelAccountRules, [{ models: ['a-model'], account: 'default' }])
})

test('loads the model catalog through the api models seam', async () => {
  const api = makeApi({
    models: async () => ({
      ok: true as const,
      value: { models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'go' }] },
    }),
  })
  const { controller } = makeController({ api })
  await flush()
  assert.deepEqual(controller.state().catalogModels, [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'go' }])
  assert.equal(controller.state().catalogFailed, false)
})

test('the catalog keeps entries without a tier (older Hosts) and drops malformed ones', async () => {
  const api = makeApi({
    models: async () => ({
      ok: true as const,
      value: {
        models: [
          { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview', tier: 'goat' },
          { id: 42, name: 'Broken' },
          null,
        ],
      },
    }),
  })
  const { controller } = makeController({ api })
  await flush()
  assert.deepEqual(controller.state().catalogModels, [
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview', tier: 'goat' },
  ])
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

// ---------------------------------------------------------------------------
// Visible-model allowlist
// ---------------------------------------------------------------------------

test('starts with the stored visible models and stays clean', () => {
  const scope = makeScope({
    value: { visibleModels: ['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'] },
    user: { visibleModels: ['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'] },
  })
  const { controller } = makeController({ scope })
  assert.deepEqual(controller.state().visibleModels, ['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'])
  assert.equal(controller.state().dirty, false)
})

test('stored visible models ignore non-string and blank entries', () => {
  const scope = makeScope({
    value: { visibleModels: ['deepseek/deepseek-v4-pro', '', 42] },
  })
  const { controller } = makeController({ scope })
  assert.deepEqual(controller.state().visibleModels, ['deepseek/deepseek-v4-pro'])
  assert.equal(controller.state().dirty, false)
})

test('staging the same selection as stored is not dirty', () => {
  const scope = makeScope({
    value: { visibleModels: ['deepseek/deepseek-v4-pro'] },
    user: { visibleModels: ['deepseek/deepseek-v4-pro'] },
  })
  const { controller } = makeController({ scope })
  controller.editVisibleModels(['deepseek/deepseek-v4-pro'])
  assert.equal(controller.state().dirty, false)
})

test('saving a staged allowlist writes visibleModels through the scope', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.editVisibleModels(['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'])
  assert.deepEqual(controller.state().visibleModels, ['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'])
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(scope.state.value.visibleModels, ['deepseek/deepseek-v4-pro', 'tencent/hy4-preview'])
  assert.equal(controller.state().dirty, false)
})

test('clearVisibleModels stages show-all and persists the empty list', async () => {
  const scope = makeScope({
    value: { visibleModels: ['deepseek/deepseek-v4-pro'] },
    user: { visibleModels: ['deepseek/deepseek-v4-pro'] },
  })
  const { controller } = makeController({ scope })
  controller.clearVisibleModels()
  assert.deepEqual(controller.state().visibleModels, [])
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(scope.state.value.visibleModels, [])
  assert.equal(controller.state().dirty, false)
})

test('discard clears a staged visible-model selection', () => {
  const { controller } = makeController()
  controller.editVisibleModels(['deepseek/deepseek-v4-pro'])
  assert.equal(controller.state().dirty, true)
  controller.discard()
  assert.deepEqual(controller.state().visibleModels, [])
  assert.equal(controller.state().dirty, false)
})

// ---------------------------------------------------------------------------
// Accounts write fidelity (composition entries this page cannot name)
// ---------------------------------------------------------------------------

test('a landed accounts write preserves entries the page cannot name', async () => {
  // A composition-config entry may carry a literal `apiKey` (or a shape this
  // page has no row for). The settings layer replaces the whole `accounts`
  // array, so rebuilding the list from the page's rows would silently delete
  // every such entry — and strip the literal key from the entries it keeps.
  const scope = makeScope({
    value: {
      accounts: [
        { label: 'env-account', apiKeyEnv: 'COMMANDCODE_API_KEY_2' },
        { label: 'literal-account', apiKey: 'sk-literal-compose' },
      ],
    },
  })
  const { controller } = makeController({ scope })
  // The literal entry has no row (nothing to address it by)…
  assert.deepEqual(controller.state().accounts.map((account) => account.label), ['env-account'])
  // …but an unrelated save that rewrites the accounts list must not drop it.
  controller.addAccount()
  const added = controller.state().accounts.at(-1)!.ref
  controller.editAccountKey(added, 'sk-third')
  await controller.save()

  const stored = scope.state.value.accounts as Array<Record<string, unknown>>
  assert.deepEqual(
    stored.map((entry) => entry.label),
    ['env-account', 'literal-account', added === 'COMMANDCODE_API_KEY_3' ? 'Account 3' : stored[2]!.label],
  )
  assert.equal(stored[1]!.apiKey, 'sk-literal-compose')
  assert.equal(stored[1]!.apiKeyEnv, undefined)
  // The managed entry keeps its reference and gains the staged key's ref.
  assert.equal(stored[2]!.apiKeyEnv, added)
})

test('a label draft survives a save that failed before the accounts write', async () => {
  // Failure order 1: the key write is refused, so the accounts list (which
  // carries the label) never lands. Treating "not stored" as "already
  // applied" silently reverted the typed label and persisted the generated
  // name on the retry.
  const scope = makeScope({})
  const api = makeApi({ failSet: true })
  const { controller } = makeController({ scope, api: api as unknown as ReturnType<typeof makeApi> })
  controller.addAccount()
  controller.editAccountLabel('COMMANDCODE_API_KEY_2', 'Go #2')
  controller.editAccountKey('COMMANDCODE_API_KEY_2', 'sk-second')
  await controller.save()

  assert.equal(controller.state().failed, true)
  assert.equal(controller.state().accounts[0]?.label, 'Go #2')

  // Retry with the key write fixed: the label the user typed is what lands.
  api.credentials.set = async (ref: string, value: string) => {
    api.store.set(ref, value)
    return { ok: true as const, value: undefined }
  }
  await controller.save()
  assert.equal(controller.state().failed, false)
  assert.equal(
    (scope.state.value.accounts as Array<{ label: string }>)[0]?.label,
    'Go #2',
  )
})

test('a label draft survives a failed accounts write itself', async () => {
  const scope = makeScope({})
  const realSet = scope.set.bind(scope)
  scope.set = async (field: string, value: unknown) => {
    if (field === 'accounts') throw new Error('accounts write refused')
    return realSet(field, value)
  }
  const { controller } = makeController({ scope })
  controller.addAccount()
  controller.editAccountLabel('COMMANDCODE_API_KEY_2', 'Go #2')
  controller.editAccountKey('COMMANDCODE_API_KEY_2', 'sk-second')
  await controller.save()

  assert.equal(controller.state().failed, true)
  assert.equal(controller.state().accounts[0]?.label, 'Go #2')
  assert.equal(controller.state().dirty, true, 'the retry stays available')
})

// ---------------------------------------------------------------------------
// Routing-rule drafts on a failed save
// ---------------------------------------------------------------------------

test('a rule draft survives a save that failed before the rules write', async () => {
  // Writes run in order and stop at the first failure, so a failure BEFORE the
  // rules write leaves every positional id untouched: the draft still
  // addresses its row and clearing it would revert the edit with dirty=false
  // (no retry). Dropping is only correct once the rules write actually landed.
  const scope = makeScope({
    value: { modelAccountRules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }] },
  })
  const api = makeApi({ failSet: true })
  const { controller } = makeController({ scope, api: api as unknown as ReturnType<typeof makeApi> })
  const id = controller.state().rules[0]!.id
  controller.editRuleModels(id, ['deepseek/deepseek-v4-pro', 'claude-sonnet-5'])
  controller.editAccountKey(DEFAULT_API_KEY_REF, 'sk-typed')
  await controller.save()

  assert.equal(controller.state().failed, true)
  assert.deepEqual(
    controller.state().rules[0]?.models,
    ['deepseek/deepseek-v4-pro', 'claude-sonnet-5'],
  )
  assert.equal(controller.state().dirty, true, 'the retry stays available')
})

test('a rule draft is dropped when the rules write landed and ids shifted', async () => {
  // The pre-existing behavior, kept: once the rules write lands, positional
  // ids shift. A kept draft would then be applied to whichever row now holds
  // that id — here the appended rule N — so the page would show the wrong
  // models on the wrong row. Dropping the draft is what keeps the retry honest.
  const scope = makeScope({
    value: {
      modelAccountRules: [
        { models: ['a-model'], account: 'default' },
        { models: ['b-model'], account: 'default' },
      ],
    },
  })
  const realSet = scope.set.bind(scope)
  let failNext = false
  scope.set = async (field: string, value: unknown) => {
    if (failNext && field === 'visibleModels') throw new Error('later write refused')
    return realSet(field, value)
  }
  const { controller } = makeController({ scope })
  // Remove the first rule and edit the second (pre-save id `rule-1`), then add
  // N: the landed write leaves [B(edited), N] at ids rule-0 / rule-1.
  controller.removeRule('rule-0')
  controller.editRuleModels('rule-1', ['b-model', 'b-extra'])
  controller.addRule()
  controller.editRuleModels('new-0', ['n-model'])
  controller.editVisibleModels(['a-model'])
  failNext = true
  await controller.save()

  assert.equal(controller.state().failed, true)
  // The rules write landed with the edit applied…
  const stored = scope.state.value.modelAccountRules as Array<{ models: string[] }>
  assert.deepEqual(stored, [
    { models: ['b-model', 'b-extra'], account: 'default' },
    { models: ['n-model'], account: 'default' },
  ])
  // …and the draft that addressed the pre-save id is gone, so the appended
  // rule shows its OWN models instead of inheriting the stale draft.
  assert.deepEqual(controller.state().rules.map((rule) => rule.models), [
    ['b-model', 'b-extra'],
    ['n-model'],
  ])
})

test('the command-guard fields stage like their neighbours and mirror the Host bounds', () => {
  const { controller } = makeController()
  const state = controller.state()

  // A toggle with no stored value reads as unset, not as "off": the page shows
  // the default (off) and only a save writes the field.
  assert.equal(state.commandGuard.text, '')
  assert.equal(state.commandGuard.overridden, false)
  controller.edit('commandGuard', 'true')
  assert.equal(controller.state().commandGuard.text, 'true')

  // The numeric bounds are mirrored into the client bundle from
  // `src/command-guard.ts` (which this bundle cannot import at runtime), so a
  // draft can never be saved in a shape the Host schema rejects.
  controller.edit('commandGuardThreshold', String(COMMAND_GUARD_MIN_THRESHOLD))
  assert.equal(controller.state().commandGuardThreshold.invalid, false)
  controller.edit('commandGuardThreshold', String(COMMAND_GUARD_MAX_THRESHOLD))
  assert.equal(controller.state().commandGuardThreshold.invalid, false)
  controller.edit('commandGuardThreshold', String(COMMAND_GUARD_MIN_THRESHOLD - 0.01))
  assert.equal(controller.state().commandGuardThreshold.invalidReason, 'tooSmall')
  controller.edit('commandGuardThreshold', String(COMMAND_GUARD_MAX_THRESHOLD + 0.01))
  assert.equal(controller.state().commandGuardThreshold.invalidReason, 'tooLarge')
  // The default is inside the bounds the client enforces.
  assert.ok(COMMAND_GUARD_DEFAULT_THRESHOLD >= COMMAND_GUARD_MIN_THRESHOLD)
  assert.ok(COMMAND_GUARD_DEFAULT_THRESHOLD <= COMMAND_GUARD_MAX_THRESHOLD)

  controller.edit('commandGuardTimeoutMs', String(COMMAND_GUARD_MIN_TIMEOUT_MS))
  assert.equal(controller.state().commandGuardTimeoutMs.invalid, false)
  controller.edit('commandGuardTimeoutMs', String(COMMAND_GUARD_MAX_TIMEOUT_MS))
  assert.equal(controller.state().commandGuardTimeoutMs.invalid, false)
  controller.edit('commandGuardTimeoutMs', String(COMMAND_GUARD_MIN_TIMEOUT_MS - 1))
  assert.equal(controller.state().commandGuardTimeoutMs.invalidReason, 'tooSmall')
  controller.edit('commandGuardTimeoutMs', String(COMMAND_GUARD_MAX_TIMEOUT_MS + 1))
  assert.equal(controller.state().commandGuardTimeoutMs.invalidReason, 'tooLarge')
})
