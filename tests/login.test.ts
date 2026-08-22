/**
 * Browser-login flow tests (node:test, zero deps). Run with `npm test`.
 *
 * These drive a REAL loopback server end to end (the flow binds 127.0.0.1 and
 * the tests POST to it with global fetch), pinning the CLI-mirrored contract:
 * POST-only /callback, state-token equality, JSON responses, whoami
 * validation before storage, and every failure mode landing in a stable
 * `reason` the page can copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'

import {
  CommandCodeLoginFlow,
  buildCommandAuthUrl,
  studioBaseForApiBase,
  validateCommandApiKey,
  type CommandCodeLoginCredentials,
  type CommandCodeLoginStatus,
} from '../src/login.ts'

/** A whoami stub scripted per call, recording the Authorization header. */
function makeWhoami(impl: (apiKey: string) => ResponseInit & { body?: unknown } | 'throw'): {
  fetchImpl: typeof fetch
  keys: string[]
} {
  const keys: string[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
    keys.push(auth.replace(/^Bearer /, ''))
    const script = impl(auth.replace(/^Bearer /, ''))
    if (script === 'throw') throw new Error('network down')
    return { status: script.status ?? 200, ok: (script.status ?? 200) >= 200 && (script.status ?? 200) < 300, json: async () => script.body } as Response
  }) as typeof fetch
  return { fetchImpl, keys }
}

interface FlowHarness {
  flow: CommandCodeLoginFlow
  stored: CommandCodeLoginCredentials[]
  whoamiKeys: string[]
  dispose(): void
}

function makeFlow(overrides?: {
  timeoutMs?: number
  storeKey?: (credentials: CommandCodeLoginCredentials) => Promise<void>
  whoami?: (apiKey: string) => ResponseInit & { body?: unknown } | 'throw'
  startPort?: number
  maxPortAttempts?: number
}): FlowHarness {
  const stored: CommandCodeLoginCredentials[] = []
  const whoami = makeWhoami(overrides?.whoami ?? (() => ({ status: 200, body: { user: { id: 'u1' } } })))
  const flow = new CommandCodeLoginFlow({
    timeoutMs: overrides?.timeoutMs,
    startPort: overrides?.startPort,
    maxPortAttempts: overrides?.maxPortAttempts,
    fetchImpl: whoami.fetchImpl,
    storeKey: overrides?.storeKey ?? (async (credentials) => void stored.push(credentials)),
  })
  return {
    flow,
    stored,
    whoamiKeys: whoami.keys,
    dispose: () => flow.dispose(),
  }
}

/** Resolve when the flow's status matches, polling via onChange. */
function waitFor(
  flow: CommandCodeLoginFlow,
  predicate: (status: CommandCodeLoginStatus) => boolean,
  boundMs = 2_000,
): Promise<CommandCodeLoginStatus> {
  return new Promise((resolve, reject) => {
    const finish = (status: CommandCodeLoginStatus) => {
      clearTimeout(timer)
      off()
      resolve(status)
    }
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for state; last: ${JSON.stringify(flow.status())}`))
    }, boundMs)
    const off = flow.onChange(() => {
      if (predicate(flow.status())) finish(flow.status())
    })
    if (predicate(flow.status())) finish(flow.status())
  })
}

/** The callback URL an authUrl points at, with its port and state. */
function parseAuthUrl(authUrl: string): { callbackUrl: string; port: number; state: string } {
  const url = new URL(authUrl)
  const callback = url.searchParams.get('callback')
  assert.ok(callback !== null, 'authUrl carries the callback parameter')
  const callbackUrl = new URL(callback)
  return {
    callbackUrl: callbackUrl.toString(),
    port: Number(callbackUrl.port),
    state: url.searchParams.get('state') ?? '',
  }
}

function credentials(state: string, apiKey = 'cc_sk_test_key'): CommandCodeLoginCredentials {
  return { apiKey, state, userId: 'u1', userName: 'mars-sea', keyName: 'cli' }
}

test('studio base mapping pairs each API base with the CLI-matching studio', () => {
  assert.equal(studioBaseForApiBase('https://api.commandcode.ai'), 'https://commandcode.ai')
  assert.equal(studioBaseForApiBase('https://staging-api.commandcode.ai'), 'https://staging.commandcode.ai')
  assert.equal(studioBaseForApiBase('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(studioBaseForApiBase('https://elsewhere.example'), 'https://commandcode.ai')
})

test('buildCommandAuthUrl carries the loopback callback and state', () => {
  const url = buildCommandAuthUrl({ studioBase: 'https://commandcode.ai', port: 5959, state: 'abc' })
  assert.ok(url.startsWith('https://commandcode.ai/studio/auth/cli?callback='))
  assert.equal(new URL(url).searchParams.get('callback'), 'http://localhost:5959/callback')
  assert.equal(new URL(url).searchParams.get('state'), 'abc')
})

test('validateCommandApiKey mirrors the CLI verdicts', async () => {
  const ok = (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof fetch
  const unauthorized = (async () => ({ status: 401, ok: false })) as unknown as typeof fetch
  const boom = (async () => {
    throw new Error('down')
  }) as unknown as typeof fetch
  const serverError = (async () => ({ status: 500, ok: false })) as unknown as typeof fetch
  assert.deepEqual(await validateCommandApiKey(ok, 'https://api.commandcode.ai', 'k'), { valid: true })
  assert.deepEqual(await validateCommandApiKey(unauthorized, 'https://api.commandcode.ai', 'k'), { valid: false, error: 'invalid_key' })
  assert.deepEqual(await validateCommandApiKey(serverError, 'https://api.commandcode.ai', 'k'), { valid: false, error: 'server_error' })
  assert.deepEqual(await validateCommandApiKey(boom, 'https://api.commandcode.ai', 'k'), { valid: false, error: 'network_error' })
})

test('happy path: callback credentials validate, store, and report success', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    assert.equal(waiting.state, 'waiting')
    const { callbackUrl, state } = parseAuthUrl(waiting.authUrl ?? '')
    assert.ok(state.length > 20, 'the state token is 32 random bytes base64url')

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials(state)),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true })

    const status = await waitFor(harness.flow, (s) => s.state !== 'waiting')
    assert.equal(status.state, 'success')
    assert.equal(status.userName, 'mars-sea')
    assert.equal(harness.stored.length, 1)
    assert.equal(harness.stored[0]?.apiKey, 'cc_sk_test_key')
    assert.deepEqual(harness.whoamiKeys, ['cc_sk_test_key'])
    // The server stopped listening after the attempt settled.
    await assert.rejects(fetch(callbackUrl, { method: 'POST', body: '{}' }))
  } finally {
    harness.dispose()
  }
})

test('a stale state token is rejected but does not kill the live attempt', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl } = parseAuthUrl(waiting.authUrl ?? '')
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials('forged-state')),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { success: false, error: 'Invalid state token' })
    assert.equal(harness.flow.status().state, 'waiting')
    assert.equal(harness.stored.length, 0)
  } finally {
    harness.dispose()
  }
})

test('the callback endpoint mirrors the CLI method and path rules', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl } = parseAuthUrl(waiting.authUrl ?? '')
    const base = new URL(callbackUrl)

    const options = await fetch(callbackUrl, { method: 'OPTIONS', headers: { Origin: 'https://commandcode.ai' } })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), 'https://commandcode.ai')

    const wrongPath = await fetch(new URL('/other', base).toString(), { method: 'POST' })
    assert.equal(wrongPath.status, 404)

    const wrongMethod = await fetch(callbackUrl)
    assert.equal(wrongMethod.status, 405)

    const badJson = await fetch(callbackUrl, { method: 'POST', body: '{nope' })
    assert.equal(badJson.status, 400)

    const missingFields = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'k' }) })
    assert.equal(missingFields.status, 400)
    assert.equal(harness.flow.status().state, 'waiting')
  } finally {
    harness.dispose()
  }
})

test('a foreign origin gets no CORS echo', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl } = parseAuthUrl(waiting.authUrl ?? '')
    const response = await fetch(callbackUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    })
    const echoed = response.headers.get('access-control-allow-origin')
    assert.ok(echoed === null || echoed === '', 'unallowlisted origins must not be echoed')
  } finally {
    harness.dispose()
  }
})

test('a denied authorization fails the attempt with reason denied', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl, state } = parseAuthUrl(waiting.authUrl ?? '')
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'access_denied', state, error_description: 'user clicked deny' }),
    })
    const status = await waitFor(harness.flow, (s) => s.state === 'failed')
    assert.equal(status.reason, 'denied')
    assert.equal(harness.stored.length, 0)
  } finally {
    harness.dispose()
  }
})

test('an invalid delivered key fails validation and is never stored', async () => {
  const harness = makeFlow({ whoami: () => ({ status: 401 }) })
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl, state } = parseAuthUrl(waiting.authUrl ?? '')
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials(state)),
    })
    const status = await waitFor(harness.flow, (s) => s.state === 'failed')
    assert.equal(status.reason, 'invalid-key')
    assert.equal(harness.stored.length, 0)
  } finally {
    harness.dispose()
  }
})

test('an unreachable validation API fails with reason network', async () => {
  const harness = makeFlow({ whoami: () => 'throw' })
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl, state } = parseAuthUrl(waiting.authUrl ?? '')
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials(state)),
    })
    const status = await waitFor(harness.flow, (s) => s.state === 'failed')
    assert.equal(status.reason, 'network')
    assert.equal(harness.stored.length, 0)
  } finally {
    harness.dispose()
  }
})

test('a rejecting storage seam fails with reason unavailable', async () => {
  const harness = makeFlow({
    storeKey: async () => {
      throw new Error('credentials service unavailable')
    },
  })
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl, state } = parseAuthUrl(waiting.authUrl ?? '')
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials(state)),
    })
    const status = await waitFor(harness.flow, (s) => s.state === 'failed')
    assert.equal(status.reason, 'unavailable')
    assert.match(status.message ?? '', /credentials service unavailable/)
  } finally {
    harness.dispose()
  }
})

test('the attempt times out when no callback arrives', async () => {
  const harness = makeFlow({ timeoutMs: 40 })
  try {
    await harness.flow.begin()
    const status = await waitFor(harness.flow, (s) => s.state === 'failed', 2_000)
    assert.equal(status.reason, 'timeout')
  } finally {
    harness.dispose()
  }
})

test('cancel stops the attempt and closes the callback server', async () => {
  const harness = makeFlow()
  try {
    const waiting = await harness.flow.begin()
    const { callbackUrl } = parseAuthUrl(waiting.authUrl ?? '')
    harness.flow.cancel()
    assert.equal(harness.flow.status().state, 'failed')
    assert.equal(harness.flow.status().reason, 'cancelled')
    await assert.rejects(fetch(callbackUrl, { method: 'POST', body: '{}' }))
  } finally {
    harness.dispose()
  }
})

test('dispose during a waiting attempt ends it cancelled', async () => {
  const harness = makeFlow()
  try {
    await harness.flow.begin()
    harness.dispose()
    assert.equal(harness.flow.status().reason, 'cancelled')
  } finally {
    harness.dispose()
  }
})

test('begin while waiting rejoins the live attempt', async () => {
  const harness = makeFlow()
  try {
    const first = await harness.flow.begin()
    const second = await harness.flow.begin()
    assert.equal(first.authUrl, second.authUrl)
  } finally {
    harness.dispose()
  }
})

test('a terminal state makes the next begin start fresh', async () => {
  const harness = makeFlow({ timeoutMs: 30 })
  try {
    await harness.flow.begin()
    await waitFor(harness.flow, (s) => s.state === 'failed')
    const second = await harness.flow.begin()
    assert.equal(second.state, 'waiting')
    assert.notEqual(second.authUrl, undefined)
  } finally {
    harness.dispose()
  }
})

test('begin rejects when no candidate port is free', async () => {
  // Occupy a real port, then aim the flow at exactly that one.
  const occupant = createNetServer()
  await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve))
  const address = occupant.address()
  assert.ok(address !== null && typeof address === 'object')
  const busyPort = address.port
  const harness = makeFlow({ startPort: busyPort, maxPortAttempts: 1 })
  try {
    await assert.rejects(harness.flow.begin(), /No available port found/)
  } finally {
    harness.dispose()
    await new Promise<void>((resolve) => occupant.close(() => resolve()))
  }
})
