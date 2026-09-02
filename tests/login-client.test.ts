/**
 * Login-panel controller tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the settings page's login fetch/poll lifecycle: begin → waiting
 * (with the Studio URL) → terminal, transport failures degrading to
 * `unavailable`, cancel, superseded loops from a fresh begin, and dispose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CommandCodeLoginController,
  loginFailureCopy,
  loginHint,
  type LoginCallResult,
  type LoginPageState,
  type LoginRemote,
} from '../src/client/login.ts'
import type { CommandCodeLoginFailureReason, CommandCodeLoginStatus } from '../src/login-wire.ts'

const POLL_MS = 5

/** A scripted Remote whose call results are queued per endpoint. */
function makeRemote(script: {
  begin?: Array<LoginCallResult | Error>
  status?: Array<LoginCallResult>
  cancel?: LoginCallResult
} = {}): LoginRemote & { calls: string[] } {
  const calls: string[] = []
  const shift = <T>(queue: Array<T> | undefined, label: string): T => {
    calls.push(label)
    const queue_ = queue ?? []
    if (queue_.length === 0) throw new Error(`no scripted ${label} response`)
    return queue_.shift() as T
  }
  return {
    get calls() {
      return [...calls]
    },
    loginBegin: async () => {
      const item = shift(script.begin, 'begin')
      if (item instanceof Error) throw item
      return item
    },
    loginStatus: async () => shift(script.status, 'status'),
    loginCancel: async () => {
      const item = script.cancel ?? { ok: true as const, value: { state: 'idle' } satisfies CommandCodeLoginStatus }
      calls.push('cancel')
      if (item instanceof Error) throw item
      return item
    },
  }
}

/** Resolve once the controller's projected phase matches. */
function waitForPhase(
  controller: CommandCodeLoginController,
  phase: string,
  boundMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for phase ${phase}; at ${controller.state().phase}`))
    }, boundMs)
    const check = () => {
      if (controller.state().phase === phase) {
        clearTimeout(timer)
        off()
        resolve()
      }
    }
    const off = controller.subscribe(check)
    check()
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a fresh begin walks starting → waiting with the Studio URL', async () => {
  let statusResult: LoginCallResult = { ok: true, value: { state: 'waiting', authUrl: 'https://commandcode.ai/studio/auth/cli?callback=x' } }
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'https://commandcode.ai/studio/auth/cli?callback=x' } }],
  })
  let polls = 0
  remote.loginStatus = async () => {
    polls += 1
    await sleep(1)
    return statusResult
  }
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    assert.equal(controller.state().authUrl, 'https://commandcode.ai/studio/auth/cli?callback=x')
    assert.equal(remote.calls[0], 'begin')

    // The terminal success lands through polling; polling then stops.
    statusResult = { ok: true, value: { state: 'success', userName: 'mars-sea', keyName: 'cli' } }
    await waitForPhase(controller, 'success')
    assert.equal(controller.state().userName, 'mars-sea')
    const pollsAtSuccess = polls
    await sleep(POLL_MS * 4)
    assert.ok(polls > pollsAtSuccess - 1 && polls < pollsAtSuccess + 2, `polling stops at a terminal state (polls=${polls})`)
    await sleep(POLL_MS * 4)
    assert.equal(polls, pollsAtSuccess + (polls > pollsAtSuccess ? 1 : 0), 'no further polls after the terminal state settles')
  } finally {
    controller.dispose()
  }
})

test('begin is a no-op while an attempt is live', async () => {
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
    status: [],
  })
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    await controller.begin()
    assert.equal(remote.calls.filter((call) => call === 'begin').length, 1)
  } finally {
    controller.dispose()
  }
})

test('a rejected begin lands in unavailable with the gateway message', async () => {
  const remote = makeRemote({
    begin: [{ ok: false, error: { message: 'no free port' } }],
  })
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    await controller.begin()
    const state = controller.state()
    assert.equal(state.phase, 'unavailable')
    assert.equal(state.message, 'no free port')
  } finally {
    controller.dispose()
  }
})

test('a thrown begin reads as unavailable too', async () => {
  const remote = makeRemote({ begin: [new Error('remote not mounted')] })
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    await controller.begin()
    assert.equal(controller.state().phase, 'unavailable')
  } finally {
    controller.dispose()
  }
})

test('a missing remote goes straight to unavailable', async () => {
  const controller = new CommandCodeLoginController(() => undefined, POLL_MS)
  try {
    await controller.begin()
    assert.equal(controller.state().phase, 'unavailable')
    assert.match(controller.state().message ?? '', /not mounted/)
  } finally {
    controller.dispose()
  }
})

test('cancel ends a waiting attempt', async () => {
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
    status: [],
    cancel: { ok: true, value: { state: 'failed', reason: 'cancelled' } },
  })
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    await controller.cancel()
    assert.equal(controller.state().phase, 'failed')
    assert.equal(controller.state().reason, 'cancelled')
  } finally {
    controller.dispose()
  }
})

test('a failed status carries reason and message', async () => {
  let statusResult: LoginCallResult = { ok: true, value: { state: 'waiting' } }
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
  })
  remote.loginStatus = async () => {
    await sleep(1)
    return statusResult
  }
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    statusResult = { ok: true, value: { state: 'failed', reason: 'invalid-key', message: 'whoami rejected' } }
    await waitForPhase(controller, 'failed')
    assert.equal(controller.state().reason, 'invalid-key')
    assert.equal(controller.state().message, 'whoami rejected')
  } finally {
    controller.dispose()
  }
})

test('an idle status mid-poll means the attempt is gone', async () => {
  let statusResult: LoginCallResult = { ok: true, value: { state: 'waiting', authUrl: 'u' } }
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
  })
  remote.loginStatus = async () => {
    await sleep(1)
    return statusResult
  }
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    statusResult = { ok: true, value: { state: 'idle' } }
    await waitForPhase(controller, 'failed')
    assert.equal(controller.state().reason, 'cancelled')
  } finally {
    controller.dispose()
  }
})

test('a terminal state lets the next begin start a fresh, polling loop', async () => {
  let statusResult: LoginCallResult = { ok: true, value: { state: 'waiting', authUrl: 'old' } }
  const remote = makeRemote({
    begin: [
      { ok: true, value: { state: 'waiting', authUrl: 'first' } },
      { ok: true, value: { state: 'waiting', authUrl: 'second' } },
    ],
  })
  remote.loginStatus = async () => {
    await sleep(1)
    return statusResult
  }
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  try {
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    // The first attempt fails through its poll loop; the loop then stops.
    statusResult = { ok: true, value: { state: 'failed', reason: 'timeout', message: 'stale' } }
    await waitForPhase(controller, 'failed')
    assert.equal(controller.state().reason, 'timeout')
    // A fresh begin restarts cleanly and its own poll loop drives the outcome.
    void controller.begin()
    await waitForPhase(controller, 'waiting')
    assert.equal(controller.state().authUrl, 'second')
    statusResult = { ok: true, value: { state: 'success', userName: 'again' } }
    await waitForPhase(controller, 'success')
    assert.equal(controller.state().userName, 'again')
  } finally {
    controller.dispose()
  }
})

test('dispose stops polling and detaches listeners', async () => {
  const remote = makeRemote({
    begin: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
    status: [{ ok: true, value: { state: 'waiting', authUrl: 'u' } }],
  })
  const controller = new CommandCodeLoginController(() => remote, POLL_MS)
  void controller.begin()
  await waitForPhase(controller, 'waiting')
  const calls = remote.calls.length
  controller.dispose()
  await sleep(POLL_MS * 5)
  assert.ok(remote.calls.length <= calls + 1, 'polling stops after dispose')
})

// ---------------------------------------------------------------------------
// loginHint / loginFailureCopy (the shared login-row hint state machine)
// ---------------------------------------------------------------------------

/** A translate stub that echoes its key, so composed text is predictable. */
const echoT = ((key: string) => key) as (key: string) => string

function hintFor(phase: LoginPageState['phase'], extra: Partial<LoginPageState> = {}) {
  return loginHint({ phase, authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: undefined, ...extra }, echoT)
}

test('loginHint renders every phase with the matching class', () => {
  assert.deepEqual(hintFor('idle'), { text: 'loginHintIdle', className: 'cc-hint', title: undefined })
  assert.deepEqual(hintFor('starting'), { text: 'loginStarting', className: 'cc-hint', title: undefined })
  assert.deepEqual(hintFor('waiting'), { text: 'loginWaiting', className: 'cc-hint', title: undefined })
})

test('loginHint composes the success line with user and key name', () => {
  assert.deepEqual(
    hintFor('success', { userName: 'mars-sea' }),
    { text: 'loginSuccess mars-sea', className: 'cc-loginDone', title: undefined },
  )
  assert.deepEqual(
    hintFor('success', { userName: 'mars-sea', keyName: 'cli' }),
    { text: 'loginSuccess mars-sea · cli', className: 'cc-loginDone', title: undefined },
  )
})

test('loginFailureCopy maps every documented reason', () => {
  const reasons: Array<[CommandCodeLoginFailureReason, string]> = [
    ['denied', 'loginDenied'],
    ['timeout', 'loginTimeout'],
    ['invalid-key', 'loginInvalidKey'],
    ['network', 'loginNetwork'],
    ['unavailable', 'loginStoreFailed'],
    ['cancelled', 'loginCancelled'],
  ]
  for (const [reason, key] of reasons) {
    assert.equal(loginFailureCopy(reason, echoT), key)
  }
  assert.equal(loginFailureCopy(undefined, echoT), 'loginFailedGeneric')
  assert.equal(loginFailureCopy('error', echoT), 'loginFailedGeneric')
})

test('loginHint failed carries the secondary message as title', () => {
  assert.deepEqual(
    hintFor('failed', { reason: 'timeout', message: 'too slow' }),
    { text: 'loginTimeout', className: 'cc-loginError', title: 'too slow' },
  )
  assert.deepEqual(
    hintFor('failed', { reason: 'timeout' }),
    { text: 'loginTimeout', className: 'cc-loginError', title: undefined },
  )
})

test('loginHint unavailable appends the message to the hint text', () => {
  assert.deepEqual(
    hintFor('unavailable', { message: 'remote missing' }),
    { text: 'loginUnavailable remote missing', className: 'cc-loginError', title: undefined },
  )
  assert.deepEqual(
    hintFor('unavailable'),
    { text: 'loginUnavailable', className: 'cc-loginError', title: undefined },
  )
})
