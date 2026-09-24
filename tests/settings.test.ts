/**
 * Settings-page controller tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the "Command Code" settings page's write path: the API key is
 * written through the credentials domain under the reference the plugin
 * resolves (never through the settings namespace, so the literal cannot leak
 * into a settings document), while connection facts (`apiBase`, timeouts)
 * are written through the `llm-commandcode` namespace scope. The
 * Host stays the single fact source — every write is read back from the
 * scope before the state is republished.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  accountModelMap,
  COMMAND_GUARD_DEFAULT_LEVEL_CHOICE,
  COMMAND_GUARD_LEVEL_CHOICES,
  CommandCodeSettingsController,
  DEFAULT_API_KEY_REF,
  type SettingsPageApi,
} from '../src/client/settings.ts'
import {
  COMMAND_GUARD_DEFAULT_LEVEL,
  COMMAND_GUARD_LEVELS,
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
    value: { apiBase: 'https://a.com' },
    user: { apiBase: 'https://a.com' },
  })
  const { controller } = makeController({ scope })
  controller.edit('apiBase', '')
  await controller.save()
  assert.equal(scope.state.value.apiBase, undefined)
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
// Immediate account management
// ---------------------------------------------------------------------------

const TWO_ACCOUNTS = [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }]

test('starts with no extra accounts and stays clean', () => {
  const { controller } = makeController()
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().activeAccount, '')
  assert.deepEqual(controller.state().accountModels, {})
  assert.equal(controller.state().accountBusy, false)
  assert.equal(controller.state().dirty, false)
})

test('createAccount with a key stores the key, then the row, without a page save', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS }, user: { accounts: TWO_ACCOUNTS } })
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  const ref = await controller.createAccount({ label: 'Go #3', key: ' sk-third ' })

  assert.equal(ref, 'COMMANDCODE_API_KEY_3')
  // The key literal went to the credentials domain, never the settings doc.
  assert.equal(api.store.get('COMMANDCODE_API_KEY_3'), 'sk-third')
  assert.deepEqual(scope.state.value.accounts, [...TWO_ACCOUNTS, { label: 'Go #3', apiKeyEnv: 'COMMANDCODE_API_KEY_3' }])
  await flush()
  const account = controller.state().accounts[1]
  assert.equal(account?.configured, true)
  assert.equal(controller.state().dirty, false, 'account operations never stage')
  assert.equal(controller.state().accountFailed, undefined)
})

test('createAccount without a key stores a keyless row a browser sign-in can target', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  const ref = await controller.createAccount({ label: 'Pending' })
  assert.equal(ref, 'COMMANDCODE_API_KEY_2')
  assert.equal(api.store.size, 0)
  assert.deepEqual(scope.state.value.accounts, [{ label: 'Pending', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }])
  await flush()
  assert.equal(controller.state().accounts[0]?.configured, false)
})

test('createAccount derives new refs from a renamed apiKeyEnv prefix', async () => {
  const scope = makeScope({ value: { apiKeyEnv: 'MY_CUSTOM_REF' } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.createAccount({ label: 'x' }), 'MY_CUSTOM_REF_2')
})

test('a refused key write stores no row', async () => {
  const scope = makeScope({})
  const api = makeApi({ failSet: true })
  const { controller } = makeController({ scope, api })
  const ref = await controller.createAccount({ label: 'Go #2', key: 'sk-second' })
  assert.equal(ref, undefined)
  assert.equal('accounts' in scope.state.value, false)
  assert.equal(controller.state().accountFailed, 'create')
})

test('a refused list write rolls the new key back', async () => {
  const scope = makeScope({})
  scope.set = async (field: string) => {
    throw new Error(`${field} write refused`)
  }
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  const ref = await controller.createAccount({ label: 'Go #2', key: 'sk-second' })
  assert.equal(ref, undefined)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), false, 'no orphaned key under the unused ref')
  assert.equal(controller.state().accountFailed, 'create')
})

test('renameAccount rewrites only that entry', async () => {
  const accounts = [...TWO_ACCOUNTS, { label: 'third', apiKeyEnv: 'COMMANDCODE_API_KEY_3' }]
  const scope = makeScope({ value: { accounts }, user: { accounts } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.renameAccount('COMMANDCODE_API_KEY_3', '  Go #3 '), true)
  assert.deepEqual(scope.state.value.accounts, [...TWO_ACCOUNTS, { label: 'Go #3', apiKeyEnv: 'COMMANDCODE_API_KEY_3' }])
  // A blank name is refused rather than stored.
  assert.equal(await controller.renameAccount('COMMANDCODE_API_KEY_3', '   '), false)
  assert.equal(controller.state().accountFailed, 'rename')
})

test('removeAccount drops the key, the row, its dedicated models and a pin naming it', async () => {
  const stored = {
    accounts: TWO_ACCOUNTS,
    activeAccount: 'COMMANDCODE_API_KEY_2',
    modelAccountRules: [
      { models: ['a-model'], account: 'COMMANDCODE_API_KEY_2' },
      { models: ['b-model'], account: 'default' },
    ],
  }
  const scope = makeScope({ value: stored, user: stored })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-second']]) })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.removeAccount('COMMANDCODE_API_KEY_2'), true)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(scope.state.value.accounts, [])
  assert.deepEqual(scope.state.value.modelAccountRules, [{ models: ['b-model'], account: 'default' }])
  assert.equal('activeAccount' in scope.state.value, false)
  assert.equal(controller.state().activeAccount, '')
})

test('a refused key removal keeps the row, so the stored key never outlives its account', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-second']]), failUnset: true })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.removeAccount('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(scope.state.value.accounts, TWO_ACCOUNTS)
  assert.equal(controller.state().accountFailed, 'remove')
})

test('setAccountKey and clearAccountKey address the default slot through its reference', async () => {
  const scope = makeScope({ value: { apiKeyEnv: 'MY_CUSTOM_REF' } })
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  assert.equal(await controller.setAccountKey('default', ' sk-new '), true)
  assert.equal(api.store.get('MY_CUSTOM_REF'), 'sk-new')
  assert.equal(api.store.has(DEFAULT_API_KEY_REF), false)
  await flush()
  assert.equal(controller.state().apiKeyConfigured, true)
  assert.equal(await controller.clearAccountKey('default'), true)
  assert.equal(api.store.has('MY_CUSTOM_REF'), false)
  await flush()
  assert.equal(controller.state().apiKeyConfigured, false)
  assert.equal(controller.state().dirty, false)
})

test('an extra account key is replaced and cleared through its own reference', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-bad']]) })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.setAccountKey('COMMANDCODE_API_KEY_2', 'sk-good'), true)
  assert.equal(api.store.get('COMMANDCODE_API_KEY_2'), 'sk-good')
  assert.equal(await controller.clearAccountKey('COMMANDCODE_API_KEY_2'), true)
  await flush()
  assert.equal(controller.state().accounts[0]?.configured, false)
  // A blank key is refused, not written as an empty credential.
  assert.equal(await controller.setAccountKey('COMMANDCODE_API_KEY_2', '  '), false)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), false)
})

test('a failed key removal is reported and keeps the key', async () => {
  const store = new Map<string, string>([[DEFAULT_API_KEY_REF, 'sk-expired']])
  const api = makeApi({ store, failUnset: true })
  const { controller } = makeController({ api })
  await flush()
  assert.equal(await controller.clearAccountKey('default'), false)
  assert.equal(controller.state().accountFailed, 'key')
  assert.equal(store.has(DEFAULT_API_KEY_REF), true)
})

test('setActiveAccount pins and unpins immediately', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.setActiveAccount('COMMANDCODE_API_KEY_2'), true)
  assert.equal(scope.state.value.activeAccount, 'COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().activeAccount, 'COMMANDCODE_API_KEY_2')
  assert.equal(controller.state().dirty, false)
  assert.equal(await controller.setActiveAccount(''), true)
  assert.equal('activeAccount' in scope.state.value, false)
})

test('account operations run one at a time, in call order', async () => {
  const scope = makeScope({})
  const realSet = scope.set.bind(scope)
  const order: string[] = []
  scope.set = async (field: string, value: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(field)
    return realSet(field, value)
  }
  const { controller } = makeController({ scope })
  const first = controller.createAccount({ label: 'one' })
  assert.equal(controller.state().accountBusy, true)
  const second = controller.createAccount({ label: 'two' })
  assert.deepEqual(await Promise.all([first, second]), ['COMMANDCODE_API_KEY_2', 'COMMANDCODE_API_KEY_3'])
  // The second op saw the first's row, so neither overwrote the other.
  assert.deepEqual((scope.state.value.accounts as Array<{ label: string }>).map((entry) => entry.label), ['one', 'two'])
  assert.deepEqual(order, ['accounts', 'accounts'])
  assert.equal(controller.state().accountBusy, false)
})

test('account operations refuse a read-only scope', async () => {
  const scope = makeScope({ writable: false })
  const { controller } = makeController({ scope })
  assert.equal(await controller.createAccount({ label: 'x' }), undefined)
  assert.equal(await controller.setActiveAccount('default'), false)
  assert.equal('accounts' in scope.state.value, false)
})

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
  // …but an unrelated write that rewrites the accounts list must not drop it.
  const added = await controller.createAccount({ label: 'third', key: 'sk-third' })
  const stored = scope.state.value.accounts as Array<Record<string, unknown>>
  assert.deepEqual(stored.map((entry) => entry.label), ['env-account', 'literal-account', 'third'])
  assert.equal(stored[1]!.apiKey, 'sk-literal-compose')
  assert.equal(stored[1]!.apiKeyEnv, undefined)
  assert.equal(stored[2]!.apiKeyEnv, added)
})

test('the stored working directory is no longer a page field, and survives saves', async () => {
  const scope = makeScope({ value: { workingDir: '/tmp/x' }, user: { workingDir: '/tmp/x' } })
  const { controller } = makeController({ scope })
  assert.equal('workingDir' in controller.state(), false)
  assert.throws(() => controller.edit('workingDir', '/elsewhere'))
  controller.edit('apiBase', 'https://new.example.com')
  await controller.save()
  assert.equal(scope.state.value.workingDir, '/tmp/x')
})

// ---------------------------------------------------------------------------
// Dedicated models (stored as modelAccountRules)
// ---------------------------------------------------------------------------

test('accountModelMap folds rules first-match-wins, so a model sits under the account that serves it', () => {
  const map = accountModelMap([
    { models: ['a', 'b'], account: 'default' },
    { models: ['b', 'c'], account: 'COMMANDCODE_API_KEY_2' },
    { models: ['d'], account: 'default' },
  ])
  assert.deepEqual(Object.fromEntries(map), {
    default: ['a', 'b', 'd'],
    COMMANDCODE_API_KEY_2: ['c'],
  })
})

test('the stored rules project into per-account dedicated models', () => {
  const rules = [{ models: ['deepseek/deepseek-v4-pro'], account: 'COMMANDCODE_API_KEY_2' }]
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS, modelAccountRules: rules } })
  const { controller } = makeController({ scope })
  assert.deepEqual(controller.state().accountModels, { COMMANDCODE_API_KEY_2: ['deepseek/deepseek-v4-pro'] })
  assert.equal(controller.state().dirty, false)
})

test('setAccountModels writes one rule per account, immediately', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.setAccountModels('COMMANDCODE_API_KEY_2', ['a-model', 'b-model', 'a-model']), true)
  assert.deepEqual(scope.state.value.modelAccountRules, [
    { models: ['a-model', 'b-model'], account: 'COMMANDCODE_API_KEY_2' },
  ])
  assert.equal(controller.state().dirty, false)
})

test('setAccountModels moves a model out of the account that held it', async () => {
  const scope = makeScope({
    value: {
      accounts: TWO_ACCOUNTS,
      modelAccountRules: [{ models: ['a-model', 'b-model'], account: 'default' }],
    },
  })
  const { controller } = makeController({ scope })
  await controller.setAccountModels('COMMANDCODE_API_KEY_2', ['b-model'])
  assert.deepEqual(scope.state.value.modelAccountRules, [
    { models: ['a-model'], account: 'default' },
    { models: ['b-model'], account: 'COMMANDCODE_API_KEY_2' },
  ])
  // Emptying an account's list drops its rule rather than storing `models: []`.
  await controller.setAccountModels('default', [])
  assert.deepEqual(scope.state.value.modelAccountRules, [
    { models: ['b-model'], account: 'COMMANDCODE_API_KEY_2' },
  ])
})

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

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

test('the command-guard fields stage like their neighbours and mirror the Host levels', () => {
  const { controller } = makeController()
  const state = controller.state()

  // A toggle with no stored value reads as unset, not as "off": the page shows
  // the default (off) and only a save writes the field.
  assert.equal(state.commandGuard.text, '')
  assert.equal(state.commandGuard.overridden, false)
  controller.edit('commandGuard', 'true')
  assert.equal(controller.state().commandGuard.text, 'true')

  // The level choices are mirrored into the client bundle from
  // `src/command-guard.ts` (which this bundle cannot import at runtime), so a
  // draft can never be saved in a shape the Host schema rejects.
  assert.deepEqual([...COMMAND_GUARD_LEVEL_CHOICES], [...COMMAND_GUARD_LEVELS])
  assert.equal(COMMAND_GUARD_DEFAULT_LEVEL_CHOICE, COMMAND_GUARD_DEFAULT_LEVEL)
  assert.equal(state.commandGuardLevel.text, '')
  for (const level of COMMAND_GUARD_LEVELS) {
    controller.edit('commandGuardLevel', level)
    assert.equal(controller.state().commandGuardLevel.invalid, false)
  }
  controller.edit('commandGuardLevel', '0.9')
  assert.equal(controller.state().commandGuardLevel.invalid, true)
  // The decision budget is fixed on the Host, so it is not a page field.
  assert.equal('commandGuardTimeoutMs' in controller.state(), false)
  assert.equal('commandGuardThreshold' in controller.state(), false)
})

test('saving a guard level writes the level string', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.edit('commandGuardLevel', 'high')
  await controller.save()
  assert.equal(scope.state.value.commandGuardLevel, 'high')
  controller.resetField('commandGuardLevel')
  await controller.save()
  assert.equal('commandGuardLevel' in scope.state.value, false)
})
