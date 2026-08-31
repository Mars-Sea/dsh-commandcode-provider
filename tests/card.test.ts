/**
 * Models-page provider-card tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the "Command Code" card rendered inside the harness Models page
 * through the `settings.models.provider-card` keyed slot (dsh 0.1.2-alpha.2):
 *
 *   - the card's posture logic (`cardMode`): which body renders for the
 *     registration / not-ready / not-configured / configured states;
 *   - the credential fact: the card reports the SHARED controller's
 *     `apiKeyConfigured` (same controller the dedicated settings page uses),
 *     with the owner's `keyConfigured` only as a fallback;
 *   - the save path: a pasted key lands under the plugin's credential
 *     reference through the same controller save the settings page uses
 *     (the key literal never rides a settings write);
 *   - the login affordance mirrors the settings page's phase copy.
 *
 * The React component itself is exercised through the mode function plus the
 * controller wiring, mirroring how tests/client.test.ts drives React-free
 * controllers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CommandCodeSettingsController,
  DEFAULT_API_KEY_REF,
  type SettingsPageApi,
} from '../src/client/settings.ts'
import { CommandCodeLoginController } from '../src/client/login.ts'
import { cardMode, type CommandCodeCardProps, type ProviderCardOwnerProps } from '../src/client/card.tsx'
import type { SettingsPageState } from '../src/client/settings.ts'
import type { LoginPageState } from '../src/client/login.ts'
import type { CommandCodeLoginFailureReason } from '../src/login-wire.ts'

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/settings.test.ts)
// ---------------------------------------------------------------------------

function makeScope(init: {
  status?: 'ready' | 'unavailable'
  writable?: boolean
  value?: Record<string, unknown>
}) {
  const state = {
    status: init.status ?? 'ready',
    value: init.value ?? {},
    user: undefined,
    base: undefined,
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
      for (const fn of listeners) fn()
    },
  }
}

function makeApi(init: { store?: Map<string, string> }) {
  const store = init.store ?? new Map<string, string>()
  const credentials = {
    describe: async (refs: string[]) => {
      const map: Record<string, { configured: boolean; writable: boolean }> = {}
      for (const ref of refs) {
        map[ref] = { configured: store.has(ref), writable: true }
      }
      return { ok: true as const, value: map }
    },
    set: async (ref: string, value: string) => {
      store.set(ref, value)
      return { ok: true as const, value: undefined }
    },
    unset: async (ref: string) => {
      store.delete(ref)
      return { ok: true as const, value: undefined }
    },
  }
  return { credentials, store }
}

/** The narrow login-remote face the login controller accepts. */
function makeLoginRemote(outcomes: Array<'success' | 'failed'> = []) {
  let calls = 0
  return {
    async loginBegin() {
      const outcome = outcomes[calls] ?? 'success'
      calls += 1
      return outcome === 'success'
        ? { ok: true as const, value: { state: 'waiting' as const, authUrl: 'https://studio.example/auth' } }
        : { ok: false as const, error: { message: 'timed out' } }
    },
    async loginStatus() {
      return { ok: true as const, value: { state: 'waiting' as const } }
    },
    async loginCancel() {
      return { ok: true as const, value: { state: 'idle' as const } }
    },
  }
}

type LoginRemote = ReturnType<typeof makeLoginRemote>

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A card props face wired to real controllers (the component's injected face). */
function makeCardProps(opts?: {
  store?: Map<string, string>
  value?: Record<string, unknown>
  withController?: boolean
}) {
  const store = opts?.store
  const api = makeApi({ store })
  const scope = makeScope({ value: opts?.value })
  const controller = new CommandCodeSettingsController(
    scope,
    api as unknown as SettingsPageApi,
  )
  const remote = makeLoginRemote()
  const loginController = new CommandCodeLoginController(() => remote)
  let settingsSnapshot: SettingsPageState = controller.state()
  let loginSnapshot: LoginPageState = loginController.state()
  controller.subscribe(() => { settingsSnapshot = controller.state() })
  loginController.subscribe(() => { loginSnapshot = loginController.state() })
  const props: CommandCodeCardProps & ProviderCardOwnerProps = {
    provider: {
      provider: 'commandcode',
      displayName: 'Command Code',
      settingsNs: 'llm-commandcode',
      settingsPath: [],
      active: true,
    },
    configured: true,
    keyConfigured: false,
    t: ((key: string) => key) as unknown as CommandCodeCardProps['t'],
    useCommandCodeSettings: opts?.withController === false
      ? undefined as unknown as CommandCodeCardProps['useCommandCodeSettings']
      : <T,>(selector: (state: SettingsPageState) => T) => selector(settingsSnapshot),
    useCommandCodeLogin: <T,>(selector: (state: LoginPageState) => T) => selector(loginSnapshot),
    edit: (field, text) => controller.edit(field, text),
    save: () => void controller.save(),
    beginLogin: () => void loginController.begin(),
    cancelLogin: () => void loginController.cancel(),
  }
  return { props, controller, loginController, api, scope }
}

// ---------------------------------------------------------------------------
// cardMode: the card's posture
// ---------------------------------------------------------------------------

test('cardMode falls back to the registration posture without a controller face', () => {
  const { props } = makeCardProps({ withController: false })
  const mode = cardMode(props)
  assert.equal(mode.kind, 'registration')
})

test('cardMode is live and reports the controller credential fact', async () => {
  const { props } = makeCardProps()
  await flush()
  const mode = cardMode(props)
  assert.equal(mode.kind, 'live')
  assert.equal(mode.kind !== 'registration' ? mode.ready : false, true)
  // No stored key: the card's authoritative fact says unconfigured even
  // though the Models page join has not confirmed anything either.
  assert.equal(mode.kind !== 'registration' ? mode.controllerConfigured : false, false)
})

test('cardMode reports configured from the controller once a key is stored', async () => {
  const { props } = makeCardProps({ store: new Map([[DEFAULT_API_KEY_REF, 'sk-live']]) })
  await flush()
  const mode = cardMode(props)
  assert.equal(mode.kind !== 'registration' ? mode.controllerConfigured : false, true)
})

// ---------------------------------------------------------------------------
// Save path: a pasted key lands under the plugin's credential reference
// ---------------------------------------------------------------------------

test('saving a pasted key from the card writes the credential reference', async () => {
  const store = new Map<string, string>()
  const { props, controller, api } = makeCardProps({ store })
  await flush()
  props.edit('apiKey', 'sk-card-paste')
  // The card's save button only calls the same controller save; run it to
  // settle (the props.save wrapper is fire-and-forget by contract).
  await controller.save()
  await flush()
  assert.equal(api.store.get(DEFAULT_API_KEY_REF), 'sk-card-paste')
  assert.equal(controller.state().apiKeyConfigured, true)
})

test('the card save never writes the key into the settings namespace', async () => {
  const { props, controller, scope } = makeCardProps()
  await flush()
  props.edit('apiKey', 'sk-secret')
  await controller.save()
  await flush()
  const section = scope.state.value as Record<string, unknown>
  assert.equal(section.apiKey, undefined)
  assert.equal(section.apiKeyEnv, undefined)
})

// ---------------------------------------------------------------------------
// Login affordance: mirrors the settings page's phases
// ---------------------------------------------------------------------------

test('the card login controller reports success phases like the settings page', async () => {
  const { loginController } = makeCardProps()
  await loginController.begin()
  await flush()
  const state = loginController.state()
  assert.equal(state.phase === 'success' || state.phase === 'waiting' || state.phase === 'starting', true)
  // Release the poll loop's timer so the test process can exit.
  loginController.dispose()
})

test('a begin rejection lands on unavailable, the paste fallback posture', async () => {
  const store = new Map<string, string>()
  const api = makeApi({ store })
  const scope = makeScope({})
  const controller = new CommandCodeSettingsController(scope, api as unknown as SettingsPageApi)
  const remote = makeLoginRemote(['failed'])
  const loginController = new CommandCodeLoginController(() => remote)
  await loginController.begin()
  await flush()
  // A begin call that fails at the transport reads as `unavailable` — the
  // Host half cannot be reached — which the card renders with the
  // manual-paste hint, exactly like the settings page's panel.
  assert.equal(loginController.state().phase, 'unavailable')
  assert.ok(loginController.state().message)
  loginController.dispose()
  // Keep the settings controller referenced: the card always mounts both.
  assert.ok(controller)
})

test('a Host-reported failed status carries the same failure reasons', async () => {
  const remote = {
    async loginBegin() {
      return { ok: true as const, value: { state: 'failed' as const, reason: 'timeout' as const, message: 'no callback' } }
    },
    async loginStatus() {
      return { ok: true as const, value: { state: 'idle' as const } }
    },
    async loginCancel() {
      return { ok: true as const, value: { state: 'idle' as const } }
    },
  }
  const loginController = new CommandCodeLoginController(() => remote)
  await loginController.begin()
  await flush()
  assert.equal(loginController.state().phase, 'failed')
  assert.equal(loginController.state().reason, 'timeout')
  loginController.dispose()
})
