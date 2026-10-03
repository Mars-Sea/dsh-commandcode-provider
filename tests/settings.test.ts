/**
 * Settings-page controller tests (node:test, zero runtime deps). Run with
 * `npm test`.
 *
 * The write path is the contract: the API key goes through the credentials
 * domain under the plugin's own reference (never the settings namespace, so
 * the literal cannot leak into a settings document), connection facts go
 * through the `llm-commandcode` scope, and the Host stays the single fact
 * source：配置与凭据分别确认，描述只刷新存在性，不能验证密钥内容。
 *
 * It does import `../src/adapter.ts` for one constant: the timeout fields are
 * edited in seconds while the Host stores milliseconds, and the only thing
 * that keeps the settings copy honest is a test that reads the real default.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  accountModelMap,
  CommandCodeSettingsController,
  DEFAULT_API_KEY_REF,
  MAX_TIMEOUT_SECONDS,
  type SettingsPageApi,
} from '../src/client/settings.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/adapter.ts'
import { en, zh, settingsWriteNotice } from '../src/client/locales.ts'
import type { SettingsPathOp } from '../src/client/settings-scope.ts'
import { modelIsVisible } from '../src/model-visibility.ts'

// Helpers

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
    async mutate(ops: readonly SettingsPathOp[], revision?: number) {
      if (revision !== undefined && revision !== state.revision) return 'conflict' as const
      const value = { ...state.value }
      const user = { ...(state.user ?? {}) }
      for (const op of ops) {
        const field = op.path[0]!
        if (op.op === 'set') { value[field] = op.value; user[field] = op.value }
        else { delete user[field]; if (init.base && Object.hasOwn(init.base, field)) value[field] = init.base[field]; else delete value[field] }
      }
      state.value = value
      state.user = user
      state.revision += 1
      for (const fn of listeners) fn()
      return 'accepted' as const
    },
  }
}

/** The catalog Remote as a fixture may state it: untyped, so a case may carry malformed entries. */
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
}

/** Build a controller wired to a fresh scope + api. */
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

// State projection

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
  // Shown in whole seconds even though the stored unit is milliseconds.
  assert.equal(state.requestTimeoutMs.text, '30')
  assert.equal(state.requestTimeoutMs.overridden, false)
})

// Staging

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
  controller.edit('requestTimeoutMs', String(MAX_TIMEOUT_SECONDS))
  state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, false)
  assert.equal(state.requestTimeoutMs.invalidReason, undefined)
  controller.edit('requestTimeoutMs', String(MAX_TIMEOUT_SECONDS + 1))
  state = controller.state()
  assert.equal(state.requestTimeoutMs.invalid, true)
  assert.equal(state.requestTimeoutMs.invalidReason, 'tooLarge')
})

test('the timeout fields are edited in seconds with millisecond precision', () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  // Typing 45 seconds must persist 45 000 ms, never 45: the Host schema and
  // every existing profile speak milliseconds, and a silent unit change here
  // would turn a 45 s budget into a 45 ms one.
  controller.edit('requestTimeoutMs', '45')
  controller.edit('streamIdleTimeoutMs', '600')
  const drafts = controller.state()
  assert.equal(drafts.requestTimeoutMs.text, '45')
  assert.equal(drafts.streamIdleTimeoutMs.text, '600')
  assert.equal(drafts.requestTimeoutMs.invalid, false)
  controller.edit('requestTimeoutMs', '1.5')
  assert.equal(controller.state().requestTimeoutMs.invalid, false)
  controller.edit('requestTimeoutMs', '1.0001')
  assert.equal(controller.state().requestTimeoutMs.invalidReason, 'format')
  controller.edit('requestTimeoutMs', 'abc')
  assert.equal(controller.state().requestTimeoutMs.invalidReason, 'format')
})

test('已有小数秒精确显示与保存，毫秒单位不改变', async () => {
  const scope = makeScope({ value: { requestTimeoutMs: 1500, streamIdleTimeoutMs: 1 } })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().requestTimeoutMs.text, '1.5')
  assert.equal(controller.state().streamIdleTimeoutMs.text, '0.001')
  controller.edit('requestTimeoutMs', '1.001')
  controller.edit('streamIdleTimeoutMs', '0.001')
  await controller.save()
  assert.equal(scope.state.value.requestTimeoutMs, 1001)
  assert.equal(scope.state.value.streamIdleTimeoutMs, 1)
  assert.equal(controller.state().requestTimeoutMs.text, '1.001')
})

test('a stored value outside the editable range still displays its true number', () => {
  // A profile hand-edited to a wait longer than MAX_TIMEOUT_SECONDS must not be
  // silently clamped on screen: the user has to see what the profile really
  // says, even though re-typing it here is refused.
  const scope = makeScope({ value: { requestTimeoutMs: 5_000_000 } })
  const { controller } = makeController({ scope })
  assert.equal(controller.state().requestTimeoutMs.text, '5000')
})

test('the settings copy states the shipped default, in seconds', () => {
  // Guards the one drift this change invites: DEFAULT_REQUEST_TIMEOUT_MS is
  // milliseconds, the hint is the user's unit, and nothing else connects them.
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS % 1000, 0, 'the default must land on a whole second')
  const seconds = String(DEFAULT_REQUEST_TIMEOUT_MS / 1000)
  assert.ok(zh.requestTimeoutMsHint.includes(seconds), 'zh hint names the real default')
  assert.ok(en.requestTimeoutMsHint.includes(`${seconds} s`), 'en hint names the real default')
  for (const [name, text] of [
    ['zh', zh.requestTimeoutMs],
    ['en', en.requestTimeoutMs],
  ] as const) {
    assert.ok(text.includes('秒') || text.includes('second'), `${name} label names the unit as seconds`)
    assert.equal(text.includes('毫秒') || text.includes('(ms)'), false, `${name} label drops milliseconds`)
  }
  assert.equal(zh.streamIdleTimeoutMsHint.includes(seconds), true)
  assert.equal(en.streamIdleTimeoutMsHint.includes(`${seconds} s`), true)
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

test('保存期间同字段及新增字段草稿保留，下一次保存才提交', async () => {
  const scope = makeScope({})
  const mutate = scope.mutate.bind(scope)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  scope.mutate = async (ops, revision) => { if (first) { first = false; await gate }; return mutate(ops, revision) }
  const { controller } = makeController({ scope })
  controller.edit('requestTimeoutMs', '10')
  const save = controller.save()
  controller.edit('requestTimeoutMs', '20')
  controller.edit('streamIdleTimeoutMs', '25')
  release()
  await save
  assert.equal(scope.state.value.requestTimeoutMs, 10_000)
  assert.equal(controller.state().requestTimeoutMs.text, '20')
  assert.equal(controller.state().streamIdleTimeoutMs.text, '25')
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.equal(scope.state.value.requestTimeoutMs, 20_000)
  assert.equal(scope.state.value.streamIdleTimeoutMs, 25_000)
  assert.equal(controller.state().dirty, false)
})

test('保存开始冻结模型选择，网络等待期间的新选择不会提前提交或被清除', async () => {
  const scope = makeScope({})
  const mutate = scope.mutate.bind(scope)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  scope.mutate = async (ops, revision) => { await gate; return mutate(ops, revision) }
  const { controller } = makeController({ scope })
  controller.edit('requestTimeoutMs', '10')
  controller.editVisibleModels(['model-a'])
  const save = controller.save()
  controller.editVisibleModels(['model-b'])
  release()
  await save
  assert.deepEqual(scope.state.value.visibleModels, ['model-a'])
  assert.deepEqual(controller.state().visibleModels, ['model-b'])
  assert.equal(controller.state().dirty, true)
})

// Save: API key via credentials domain

test('save() writes a staged API key through credentials.set, never the settings scope', async () => {
  const store = new Map<string, string>()
  const api = makeApi({ store })
  const scope = makeScope({})
  const { controller } = makeController({ scope, api })
  controller.edit('apiKey', 'sk-abc123')
  assert.equal(store.has(DEFAULT_API_KEY_REF), false)
  await controller.save()
  assert.equal(store.get(DEFAULT_API_KEY_REF), 'sk-abc123')
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

// Save: connection facts through the settings namespace

test('save() writes connection fields through the settings scope', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  controller.edit('apiBase', 'https://new.example.com')
  controller.edit('requestTimeoutMs', '45')
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
  assert.equal(scope.state.value.apiBase, 'https://api.commandcode.ai')
  assert.equal(scope.state.user?.apiBase, undefined)
})

// Boolean field (filterModelsByPlan toggle)

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
  // upstream serves a request and what it costs, so nobody gets it by accident.
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

test('cache-aware image offload is staged, saved, and reset as an opt-in boolean', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  assert.equal(controller.state().offloadSeenImagesForCache.text, '')
  controller.edit('offloadSeenImagesForCache', 'true')
  await controller.save()
  assert.equal(scope.state.value.offloadSeenImagesForCache, true)
  controller.resetField('offloadSeenImagesForCache')
  await controller.save()
  assert.equal(scope.state.user?.offloadSeenImagesForCache, undefined)
})

test('save() writes the sidebar quota toggle as a real boolean, off when unset', async () => {
  const scope = makeScope({})
  const { controller } = makeController({ scope })
  // Unset means hidden: the sidebar quota card is opt-in (the Host schema
  // defaults `showSidebarQuota` to false).
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
  // edit can neither show nor hide the card.
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

// Failure handling

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

// Lifecycle

test('dispose() releases external subscriptions and stops publishing', async () => {
  const { controller, scope } = makeController()
  let published = 0
  controller.subscribe(() => { published += 1 })
  controller.dispose()
  // A scope update after disposal must not reach subscribers.
  await scope.set('apiBase', 'https://elsewhere.example')
  assert.equal(published, 0)
})

// Immediate account management

const TWO_ACCOUNTS = [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2' }]

test('starts with no extra accounts and stays clean', () => {
  const { controller } = makeController()
  assert.deepEqual(controller.state().accounts, [])
  assert.equal(controller.state().activeAccount, '')
  assert.deepEqual(controller.state().accountModels, {})
  assert.equal(controller.state().accountBusy, false)
  assert.equal(controller.state().dirty, false)
})

test('renameAccount rewrites only that entry', async () => {
  const accounts = [...TWO_ACCOUNTS, { label: 'third', apiKeyEnv: 'COMMANDCODE_API_KEY_3' }]
  const scope = makeScope({ value: { accounts }, user: { accounts } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.renameAccount('COMMANDCODE_API_KEY_3', '  Go #3 '), true)
  assert.deepEqual(scope.state.value.accounts, [...TWO_ACCOUNTS, { label: 'Go #3', apiKeyEnv: 'COMMANDCODE_API_KEY_3' }])
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

test('a refused key removal preserves a durable cleanup task after removing the account', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'sk-second']]), failUnset: true })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.removeAccount('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(scope.state.value.accounts, [])
  assert.deepEqual(controller.state().pendingCredentialCleanup, ['COMMANDCODE_API_KEY_2'])
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), true)
  assert.equal(controller.state().accountFailed, 'remove')
})

test('账户配置原子提交失败时保留账户绑定固定账户与密钥', async () => {
  const value = { accounts: TWO_ACCOUNTS, activeAccount: 'COMMANDCODE_API_KEY_2', modelAccountRules: [{ models: ['m'], account: 'COMMANDCODE_API_KEY_2' }] }
  const scope = makeScope({ value, user: value })
  scope.mutate = async () => { throw new Error('测试版本冲突') }
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'test-key']]) })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.removeAccount('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(scope.state.value, value)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), true)
})

test('凭据清理失败后刷新页面仍能重试，已移除配置不会再次删除', async () => {
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const options = { store: new Map([['COMMANDCODE_API_KEY_2', 'test-key']]), failUnset: true }
  const api = makeApi(options)
  const first = makeController({ scope, api }).controller
  await flush()
  assert.equal(await first.removeAccount('COMMANDCODE_API_KEY_2'), false)
  first.dispose()
  options.failUnset = false
  const second = makeController({ scope, api }).controller
  await flush()
  assert.deepEqual(second.state().pendingCredentialCleanup, ['COMMANDCODE_API_KEY_2'])
  assert.equal(await second.retryCredentialCleanup('COMMANDCODE_API_KEY_2'), true)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(second.state().pendingCredentialCleanup, [])
  second.dispose()
})

test('清理重试保护同名重建账户和继承账户的共享密钥', async () => {
  for (const inherited of [false, true]) {
    const scope = makeScope({
      value: { accounts: inherited ? [] : TWO_ACCOUNTS, credentialCleanupRefs: ['COMMANDCODE_API_KEY_2'] },
      ...(inherited ? { base: { accounts: TWO_ACCOUNTS } } : {}),
    })
    const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'test-key']]) })
    const { controller } = makeController({ scope, api })
    await flush()
    assert.equal(await controller.retryCredentialCleanup('COMMANDCODE_API_KEY_2'), true)
    assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), true)
    assert.deepEqual(scope.state.value.accounts, inherited ? [] : TWO_ACCOUNTS)
    assert.deepEqual(controller.state().pendingCredentialCleanup, [])
    controller.dispose()
  }
})

test('清理无法确认凭据状态时保留队列，不把未知当作已删除', async () => {
  const scope = makeScope({ value: { accounts: [], credentialCleanupRefs: ['COMMANDCODE_API_KEY_2'] } })
  const api = makeApi({ store: new Map([['COMMANDCODE_API_KEY_2', 'test-key']]) })
  api.credentials.describe = async () => { throw new Error('测试连接失败') }
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(await controller.retryCredentialCleanup('COMMANDCODE_API_KEY_2'), false)
  assert.equal(api.store.has('COMMANDCODE_API_KEY_2'), true)
  assert.deepEqual(controller.state().pendingCredentialCleanup, ['COMMANDCODE_API_KEY_2'])
  api.credentials.describe = async () => ({ ok: true, value: {} })
  assert.equal(await controller.retryCredentialCleanup('COMMANDCODE_API_KEY_2'), false)
  assert.deepEqual(controller.state().pendingCredentialCleanup, ['COMMANDCODE_API_KEY_2'])
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
  const scope = makeScope({ value: { accounts: TWO_ACCOUNTS } })
  const realMutate = scope.mutate.bind(scope)
  const order: string[] = []
  scope.mutate = async (ops, revision) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(ops[0]!.path[0]!)
    return realMutate(ops, revision)
  }
  const { controller } = makeController({ scope })
  const first = controller.renameAccount('COMMANDCODE_API_KEY_2', 'one')
  assert.equal(controller.state().accountBusy, true)
  const second = controller.renameAccount('COMMANDCODE_API_KEY_2', 'two')
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.deepEqual((scope.state.value.accounts as Array<{ label: string }>).map((entry) => entry.label), ['two'])
  assert.deepEqual(order, ['accounts', 'accounts'])
  assert.equal(controller.state().accountBusy, false)
})

test('account operations refuse a read-only scope', async () => {
  const scope = makeScope({ writable: false })
  const { controller } = makeController({ scope })
  assert.equal(await controller.renameAccount('COMMANDCODE_API_KEY_2', 'x'), false)
  assert.equal(await controller.setActiveAccount('default'), false)
  assert.equal('accounts' in scope.state.value, false)
})

test('a landed accounts write preserves entries the page cannot name', async () => {
  // A composition-config entry may carry a literal `apiKey` (or a shape this
  // page has no row for). The settings layer replaces the whole `accounts`
  // array, so rebuilding it from the page's rows would drop every such entry.
  const scope = makeScope({
    value: {
      accounts: [
        { label: 'env-account', apiKeyEnv: 'COMMANDCODE_API_KEY_2' },
        { label: 'literal-account', apiKey: 'sk-literal-compose' },
      ],
    },
  })
  const { controller } = makeController({ scope })
  // The literal entry has no row, but an unrelated write that rewrites the
  // accounts list must not drop it.
  assert.deepEqual(controller.state().accounts.map((account) => account.label), ['env-account'])
  assert.equal(await controller.renameAccount('COMMANDCODE_API_KEY_2', 'renamed'), true)
  const stored = scope.state.value.accounts as Array<Record<string, unknown>>
  assert.deepEqual(stored.map((entry) => entry.label), ['renamed', 'literal-account'])
  assert.equal(stored[1]!.apiKey, 'sk-literal-compose')
  assert.equal(stored[1]!.apiKeyEnv, undefined)
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

// Dedicated models (stored as modelAccountRules)

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

// Model catalog

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
  // The controller is constructed before the Remote mount, so the first fetch
  // fails; once the mount lands `refreshCatalog()` must recover without a reload.
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

// Visible-model allowlist

test('网页读取终端覆盖后的有效选择，保存时以一次提交统一两个字段', async () => {
  const scope = makeScope({ value: {
    visibleModels: ['a', 'old'], modelVisibility: { a: false, b: true, hidden: false },
  } })
  const api = makeApi({ models: async () => ({ ok: true, value: { models: [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
  ] } }) })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.deepEqual(controller.state().visibleModels, ['old', 'b'])
  assert.equal(controller.state().visibleModelsAll, false)
  let commits = 0
  const mutate = scope.mutate.bind(scope)
  scope.mutate = async (ops, revision) => { commits++; assert.equal(ops.length, 2); return mutate(ops, revision) }
  controller.editVisibleModels(['a', 'c'])
  await controller.save()
  assert.equal(commits, 1)
  assert.equal(controller.state().failed, false)
  assert.deepEqual(controller.state().visibleModels, ['a', 'c'])
  for (const id of ['a', 'b', 'c', 'old', 'hidden', 'future']) {
    assert.equal(modelIsVisible(id, scope.state.value.visibleModels as string[], scope.state.value.modelVisibility), ['a', 'c'].includes(id))
  }
  await scope.set('modelVisibility', { ...(scope.state.value.modelVisibility as object), b: true })
  assert.deepEqual(controller.state().visibleModels, ['a', 'c', 'b'])
})

test('显示全部覆盖继承的隐藏开关，目录失败保留旧模型且能识别全部隐藏', async () => {
  const scope = makeScope({
    base: { modelVisibility: { inherited: false } },
    value: { modelVisibility: { inherited: false, old: true } },
  })
  const { controller } = makeController({ scope, api: makeApi({ models: async () => ({ ok: false }) }) })
  await flush()
  assert.deepEqual(controller.state().visibleModels, ['old'])
  assert.equal(controller.state().visibleModelsAll, false)
  controller.clearVisibleModels()
  await controller.save()
  assert.equal(controller.state().visibleModelsAll, true)
  assert.deepEqual(scope.state.value.modelVisibility, { inherited: true, old: true })
  assert.equal(modelIsVisible('future', [], scope.state.value.modelVisibility), true)
  await scope.set('modelVisibility', { inherited: false, old: false })
  assert.deepEqual(controller.state().visibleModels, [])
  assert.equal(controller.state().visibleModelsAll, false)
})

test('目录加载后显示全部实际勾选全部，保存冲突保留模型草稿', async () => {
  const scope = makeScope({})
  const api = makeApi({ models: async () => ({ ok: true, value: { models: [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
  ] } }) })
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(controller.state().visibleModelsAll, true)
  assert.deepEqual(controller.state().visibleModels, ['a', 'b'])
  scope.mutate = async () => { throw new Error('revision conflict') }
  controller.editVisibleModels(['a'])
  await controller.save()
  assert.equal(controller.state().failed, true)
  assert.equal(controller.state().dirty, true)
  assert.deepEqual(controller.state().visibleModels, ['a'])
  assert.equal(scope.state.value.visibleModels, undefined)
  assert.equal(scope.state.value.modelVisibility, undefined)
})

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

test('the request-timeout hint says when the Provider API route needs a bigger budget', () => {
  // The knob has always been in the Advanced card, so the gap was never the
  // field — it was that the hint only named the default. A user hitting issue
  // #67's timeout had no way to learn that raising it is the documented remedy,
  // because the error used to send them to their proxy instead. The default is
  // the official CLI's own: its transport sets no timeout and inherits undici's
  // 300 s, measured at 301.0 s.
  for (const [name, text] of [
    ['zh', zh.requestTimeoutMsHint],
    ['en', en.requestTimeoutMsHint],
  ] as const) {
    assert.match(text, /300 s|300 秒/, `${name} hint states the default in seconds`)
    assert.match(text, /Provider API/, `${name} hint names the route that withholds headers`)
  }
  assert.match(zh.requestTimeoutMsHint, /上游模型吐出第一个 token/, 'zh ties the knob to upstream speed')
  assert.match(en.requestTimeoutMsHint, /slow upstream/, 'en ties the knob to upstream speed')
  // The measured cause is upstream speed, never prompt size: on one account the
  // same route took 117 s for a 200 k prompt and 30 s for a 1.2 M one.
  assert.doesNotMatch(zh.requestTimeoutMsHint, /请求体很大|大上下文/, 'zh does not blame prompt size')
  assert.doesNotMatch(en.requestTimeoutMsHint, /request body is large|large-context/, 'en does not blame prompt size')
})

/** 可控异步门：在真实控制器入口制造竞争，不依赖固定等待时长。 */
function writeGate() {
  let release!: () => void
  let markStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { gate, started, release, markStarted }
}

test('一次保存的普通字段与模型选择仅提交一次配置变更', async () => {
  const scope = makeScope({})
  const mutate = scope.mutate.bind(scope)
  const calls: SettingsPathOp[][] = []
  scope.mutate = async (ops, revision) => { calls.push([...ops]); return mutate(ops, revision) }
  const { controller } = makeController({ scope })
  controller.edit('requestTimeoutMs', '2')
  controller.edit('webSearch', 'false')
  controller.editVisibleModels(['m'])
  await controller.save()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.map(op => op.path[0]), ['requestTimeoutMs', 'webSearch', 'visibleModels', 'modelVisibility'])
  controller.dispose()
})

test('保存与清除共用队列，清除成功后较早保存不能再写回密钥', async () => {
  const api = makeApi({})
  const set = api.credentials.set
  const barrier = writeGate()
  api.credentials.set = async (ref, value) => { barrier.markStarted(); await barrier.gate; return set(ref, value) }
  let cleared = false
  const unset = api.credentials.unset
  api.credentials.unset = async ref => { cleared = true; return unset(ref) }
  const { controller } = makeController({ api })
  controller.edit('apiKey', 'synthetic-key')
  const save = controller.save()
  await barrier.started
  const clear = controller.clearAccountKey('default')
  try { await flush(); assert.equal(cleared, false, '清除应等待之前的保存') }
  finally { barrier.release(); await save; await clear; controller.dispose() }
  assert.equal(api.store.has(DEFAULT_API_KEY_REF), false)
})

test('取消继承固定账号必须实际恢复自动轮换', async () => {
  const scope = makeScope({ base: { activeAccount: 'inherited' }, value: { activeAccount: 'inherited' } })
  const { controller } = makeController({ scope })
  assert.equal(await controller.setActiveAccount(''), true)
  assert.equal(controller.state().activeAccount, '')
  assert.equal(scope.state.user?.activeAccount, '')
  controller.dispose()
})

test('配置整批拒绝时不写密钥、不清理任何提交草稿', async () => {
  const scope = makeScope({})
  scope.mutate = async () => { throw new Error('配置版本冲突') }
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  controller.edit('requestTimeoutMs', '2')
  controller.edit('apiKey', 'synthetic-key')
  await controller.save()
  assert.equal(scope.state.value.requestTimeoutMs, undefined)
  assert.equal(api.store.has(DEFAULT_API_KEY_REF), false)
  assert.equal(controller.state().dirty, true)
  controller.dispose()
})

test('插件销毁后不接受新的凭据修改', async () => {
  const api = makeApi({})
  const { controller } = makeController({ api })
  controller.dispose()
  assert.equal(await controller.setAccountKey('default', 'synthetic-key'), false)
  assert.equal(api.store.size, 0)
})

test('写入已确认但状态刷新失败时不误报写入失败、不保留旧密钥草稿', async () => {
  const api = makeApi({})
  const { controller } = makeController({ api })
  await flush()
  api.credentials.describe = async () => { throw new Error('合成读取失败') }
  controller.edit('apiKey', 'synthetic-key')
  await controller.save()
  assert.equal(api.store.has(DEFAULT_API_KEY_REF), true)
  assert.equal(controller.state().failed, false)
  assert.equal(controller.state().apiKey.text, '')
  assert.equal(controller.state().savedCount, 1)
  controller.dispose()
})

test('密钥失败仅保留密钥与等待期间的新草稿，配置确认不回滚', async () => {
  const scope = makeScope({ user: { requestTimeoutMs: 1_000 }, value: { requestTimeoutMs: 1_000 } })
  const api = makeApi({})
  const barrier = writeGate()
  api.credentials.set = async () => { barrier.markStarted(); await barrier.gate; return { ok: false, error: { message: '合成拒绝' } } }
  const { controller } = makeController({ scope, api })
  controller.edit('requestTimeoutMs', '2')
  controller.editVisibleModels(['m'])
  controller.edit('apiKey', 'synthetic-key')
  const save = controller.save()
  await barrier.started
  controller.resetField('requestTimeoutMs')
  controller.edit('webSearch', 'false')
  controller.editVisibleModels(['new'])
  barrier.release()
  await save
  const state = controller.state()
  assert.equal(state.saveResult?.config, 'confirmed')
  assert.equal(state.saveResult?.credential, 'unconfirmed')
  assert.equal(scope.state.value.requestTimeoutMs, 2_000)
  assert.deepEqual(scope.state.value.visibleModels, ['m'])
  assert.equal(state.requestTimeoutMs.clear, true)
  assert.equal(state.webSearch.text, 'false')
  assert.deepEqual(state.visibleModels, ['new'])
  assert.equal(state.apiKey.text, 'synthetic-key')
  assert.equal(state.savedCount, 0)
  assert.match(settingsWriteNotice(state.saveResult, key => zh[key]), /配置已保存.*密钥操作未获确认/)
  controller.dispose()
})

test('部分失败只清理提交时已确认的配置草稿，放弃后新密钥不被迟到完成清除', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const barrier = writeGate()
  api.credentials.set = async () => { barrier.markStarted(); await barrier.gate; return { ok: false, error: { message: '合成拒绝' } } }
  const { controller } = makeController({ scope, api })
  controller.edit('requestTimeoutMs', '2')
  controller.edit('apiKey', 'old-synthetic')
  const save = controller.save()
  await barrier.started
  barrier.release()
  await save
  assert.equal(controller.state().requestTimeoutMs.overridden, true)
  assert.equal(controller.state().requestTimeoutMs.clear, false)
  controller.resetField('requestTimeoutMs')
  assert.equal(controller.state().requestTimeoutMs.clear, true)
  // 若旧草稿仍留在内部，第二次保存会错误地重放它；重置必须正常取消覆盖。
  controller.resetField('apiKey')
  await controller.save()
  assert.equal(scope.state.user?.requestTimeoutMs, undefined)
  const set = makeApi({}).credentials.set
  api.credentials.set = async (ref, value) => { await barrier.gate; return set(ref, value) }
  controller.edit('apiKey', 'submitted-synthetic')
  const next = controller.save()
  controller.discard()
  controller.edit('apiKey', 'new-synthetic')
  await next
  assert.equal(controller.state().apiKey.text, 'new-synthetic')
  controller.dispose()
})

test('排队保存拒绝相关字段外部改动，整批保留且不写密钥', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const barrier = writeGate()
  const set = api.credentials.set
  api.credentials.set = async (ref, value) => { barrier.markStarted(); await barrier.gate; return set(ref, value) }
  const { controller } = makeController({ scope, api })
  const first = controller.setAccountKey('extra', 'synthetic-extra')
  await barrier.started
  controller.edit('requestTimeoutMs', '2')
  controller.edit('webSearch', 'false')
  controller.edit('apiKey', 'synthetic-default')
  const save = controller.save()
  await scope.set('requestTimeoutMs', 3_000)
  barrier.release()
  await first
  await save
  assert.equal(controller.state().saveResult?.config, 'conflict')
  assert.equal(controller.state().saveResult?.credential, 'not-issued')
  assert.equal(scope.state.value.requestTimeoutMs, 3_000)
  assert.equal(scope.state.value.webSearch, undefined)
  assert.equal(api.store.has(DEFAULT_API_KEY_REF), false)
  assert.equal(controller.state().requestTimeoutMs.text, '2')
  assert.equal(controller.state().webSearch.text, 'false')
  controller.dispose()
})

test('排队保存允许无关字段变更，使用最新版本保留外部值与点击时输入', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const barrier = writeGate()
  const set = api.credentials.set
  api.credentials.set = async (ref, value) => { barrier.markStarted(); await barrier.gate; return set(ref, value) }
  const { controller } = makeController({ scope, api })
  const first = controller.setAccountKey('extra', 'synthetic-extra')
  await barrier.started
  controller.edit('requestTimeoutMs', '2')
  const save = controller.save()
  controller.edit('requestTimeoutMs', '4')
  await scope.mutate([{ op: 'set', path: ['webSearch'], value: false }], 1)
  barrier.release()
  await first
  await save
  assert.equal(controller.state().saveResult?.config, 'confirmed')
  assert.equal(scope.state.value.requestTimeoutMs, 2_000)
  assert.equal(scope.state.value.webSearch, false)
  assert.equal(controller.state().requestTimeoutMs.text, '4')
  controller.dispose()
})

for (const operation of ['save', 'replace', 'clear'] as const) {
  test(`默认密钥${operation}发出前引用改变，停止而不自动改写新引用`, async () => {
    const scope = makeScope({ value: { apiKeyEnv: 'OLD' } })
    const api = makeApi({ store: new Map([['OLD', 'existing-synthetic']]) })
    const barrier = writeGate()
    const set = api.credentials.set
    const issued: string[] = []
    api.credentials.set = async (ref, value) => { issued.push(ref); barrier.markStarted(); await barrier.gate; return set(ref, value) }
    const unset = api.credentials.unset
    api.credentials.unset = async ref => { issued.push(ref); return unset(ref) }
    const { controller } = makeController({ scope, api })
    const first = controller.setAccountKey('extra', 'synthetic-extra')
    await barrier.started
    controller.edit('apiKey', 'synthetic-new')
    controller.edit('requestTimeoutMs', '2')
    const next = operation === 'save' ? controller.save() : operation === 'replace'
      ? controller.setAccountKey('default', 'synthetic-new') : controller.clearAccountKey('default')
    await scope.set('apiKeyEnv', 'NEW')
    barrier.release()
    await first
    await next
    const outcome = operation === 'save' ? controller.state().saveResult : controller.state().accountResult
    assert.equal(outcome?.issue, 'target-changed')
    assert.equal(outcome?.credential, 'not-issued')
    assert.deepEqual(issued, ['extra'])
    assert.equal(api.store.get('OLD'), 'existing-synthetic')
    assert.equal(api.store.has('NEW'), false)
    assert.equal(controller.state().apiKey.text, 'synthetic-new')
    if (operation === 'save') assert.equal(outcome?.config, 'confirmed')
    controller.dispose()
  })
}

test('密钥已发出后引用改变，保留原引用确认与草稿，不补偿或重写', async () => {
  const scope = makeScope({ value: { apiKeyEnv: 'OLD' } })
  const api = makeApi({})
  const barrier = writeGate()
  const set = api.credentials.set
  const issued: string[] = []
  api.credentials.set = async (ref, value) => { issued.push(ref); barrier.markStarted(); await barrier.gate; return set(ref, value) }
  const { controller } = makeController({ scope, api })
  controller.edit('apiKey', 'synthetic-key')
  const save = controller.save()
  await barrier.started
  await scope.set('apiKeyEnv', 'NEW')
  barrier.release()
  await save
  const state = controller.state()
  assert.equal(state.saveResult?.credential, 'confirmed')
  assert.equal(state.saveResult?.credentialRef, 'OLD')
  assert.equal(state.saveResult?.issue, 'target-changed')
  assert.equal(state.apiKey.text, 'synthetic-key')
  assert.equal(state.apiKeyConfigured, false)
  assert.equal(state.savedCount, 0)
  assert.deepEqual(issued, ['OLD'])
  assert.equal(api.store.get('OLD'), 'synthetic-key')
  assert.equal(api.store.has('NEW'), false)
  assert.match(settingsWriteNotice(state.saveResult, key => zh[key]), /原引用：OLD/)
  controller.dispose()
})

test('销毁立即停止排队任务，已发凭据自然确认而不开始后续配置', async () => {
  const scope = makeScope({})
  const api = makeApi({})
  const barrier = writeGate()
  const set = api.credentials.set
  api.credentials.set = async (ref, value) => { barrier.markStarted(); await barrier.gate; return set(ref, value) }
  const { controller } = makeController({ scope, api })
  const first = controller.setAccountKey('extra', 'synthetic-extra')
  await barrier.started
  controller.edit('requestTimeoutMs', '2')
  const save = controller.save()
  const clear = controller.clearAccountKey('extra')
  controller.dispose()
  assert.equal((await save)?.issue, 'closed', '未开始任务不等待正在执行的网络请求')
  assert.equal(await clear, false)
  assert.equal(api.store.size, 0)
  barrier.release()
  assert.equal(await first, false)
  assert.equal(api.store.has('extra'), true, '不能声称已经撤回已发调用')
  assert.equal(scope.state.value.requestTimeoutMs, undefined)
})

test('配置已发后销毁，保留已确认配置但不进入密钥阶段', async () => {
  const scope = makeScope({})
  const mutate = scope.mutate.bind(scope)
  const barrier = writeGate()
  scope.mutate = async (ops, revision) => { barrier.markStarted(); await barrier.gate; return mutate(ops, revision) }
  const api = makeApi({})
  const { controller } = makeController({ scope, api })
  controller.edit('requestTimeoutMs', '2')
  controller.edit('apiKey', 'synthetic-key')
  const save = controller.save()
  await barrier.started
  controller.dispose()
  barrier.release()
  const outcome = await save
  assert.equal(outcome?.config, 'confirmed')
  assert.equal(outcome?.issue, 'closed')
  assert.equal(outcome?.credential, 'not-issued')
  assert.equal(scope.state.value.requestTimeoutMs, 2_000)
  assert.equal(api.store.size, 0)
})

test('确认后刷新失败的重试只读事实，不重复写密钥，保留等待期间的新草稿', async () => {
  const api = makeApi({})
  const { controller } = makeController({ api })
  await flush()
  const describe = api.credentials.describe
  const set = api.credentials.set
  let writes = 0
  api.credentials.set = async (ref, value) => { writes++; return set(ref, value) }
  api.credentials.describe = async () => { throw new Error('合成断连') }
  controller.edit('apiKey', 'synthetic-key')
  await controller.save()
  assert.equal(controller.state().apiKeyConfigured, true)
  assert.equal(controller.state().saveResult?.refreshFailed, true)
  controller.edit('apiKey', 'new-synthetic-key')
  api.credentials.describe = describe
  await controller.refreshCredentials()
  assert.equal(writes, 1)
  assert.equal(controller.state().apiKey.text, 'new-synthetic-key')
  assert.equal(controller.state().credentialRefreshFailed, false)
  controller.dispose()
})

test('旧描述迟到不能覆盖随后已确认的密钥存在性', async () => {
  const api = makeApi({})
  const { controller } = makeController({ api })
  await flush()
  const describe = api.credentials.describe
  const barrier = writeGate()
  let first = true
  api.credentials.describe = async refs => {
    const facts = await describe(refs)
    if (first) { first = false; barrier.markStarted(); await barrier.gate }
    return facts
  }
  const oldRead = controller.refreshCredentials()
  await barrier.started
  assert.equal(await controller.setAccountKey('default', 'synthetic-key'), true)
  assert.equal(controller.state().apiKeyConfigured, true)
  barrier.release()
  await oldRead
  assert.equal(controller.state().apiKeyConfigured, true)
  assert.equal(controller.state().credentialRefreshFailed, false)
  controller.dispose()
})

test('描述缺少引用不能当成不存在或覆盖最后已确认状态', async () => {
  const api = makeApi({})
  const { controller } = makeController({ api })
  await flush()
  assert.equal(await controller.setAccountKey('default', 'synthetic-key'), true)
  api.credentials.describe = async () => ({ ok: true, value: {} })
  await controller.refreshCredentials()
  assert.equal(controller.state().apiKeyConfigured, true)
  assert.equal(controller.state().credentialRefreshFailed, true)
  controller.dispose()
})


test('首次事实读取失败显示未知，明确确认后才解释配置存在性', async () => {
  const scope = makeScope({ value: { accounts: [{ apiKeyEnv: 'extra', label: '合成账号' }] } })
  const api = makeApi({})
  const describe = api.credentials.describe
  api.credentials.describe = async () => { throw new Error('合成首次读取失败') }
  const { controller } = makeController({ scope, api })
  await flush()
  assert.equal(controller.state().apiKeyKnown, false)
  assert.equal(controller.state().accounts[0]?.credentialKnown, false)
  assert.equal(controller.state().credentialRefreshFailed, true)
  api.credentials.describe = describe
  await controller.refreshCredentials()
  assert.equal(controller.state().apiKeyKnown, true)
  assert.equal(controller.state().apiKeyConfigured, false)
  assert.equal(controller.state().accounts[0]?.credentialKnown, true)
  controller.dispose()
})
