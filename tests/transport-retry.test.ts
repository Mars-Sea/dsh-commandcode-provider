/**
 * Transport-retry budget tests (issue #39, second report).
 *
 * The route policy is near-unbounded by design (`maxRetries: 1000`), which is
 * right for the failures a provider ASKS to have retried and wrong for a
 * connection that cannot be established. These pin the budget that stops it —
 * (a) only `TRANSPORT` is ever consumed and (b) exhaustion SURFACES the
 * failure instead of answering the waterfall with another retry.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TRANSPORT_MAX_RETRIES,
  MAX_TRANSPORT_MAX_RETRIES,
  TRANSPORT_FAILURE_CODE,
  absorbTransportFailure,
  resetTransportFailures,
  transportBudgetMessage,
  transportResetAction,
} from '../src/transport-retry.ts'

/** Minimally-shaped stand-ins for the harness's agent and waterfall contract. */
interface FakeAgent { readonly id: string }
type Decision = { kind: 'retry' } | undefined

/**
 * The plugin's listener, reduced to its decision logic. Kept structurally
 * parallel to the real one in `src/index.ts` — the cancellation check comes
 * BEFORE the budget, so an aborted turn neither retries nor spends a slot.
 */
function respond(agent: FakeAgent, code: string, signal: AbortSignal, maxRetries: number): Decision {
  if (signal.aborted) return undefined
  const decision = absorbTransportFailure(agent, code, maxRetries)
  if (decision === 'ignored') return undefined
  if (decision === 'retry') return { kind: 'retry' }
  throw new Error(transportBudgetMessage('Command Code API request failed: fetch failed', maxRetries))
}

const live = (): AbortSignal => new AbortController().signal

test('a non-transport code is never consumed by the budget', () => {
  const agent: FakeAgent = { id: 'main' }
  // Codes the route policy retries on its own window plus the ones that must
  // stay terminal: none may spend (or be stopped by) this budget.
  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_CREDENTIAL']) {
    assert.equal(absorbTransportFailure(agent, code, 0), 'ignored', `${code} must be ignored`)
  }
})

test('transport failures are absorbed while the budget has room, then exhausted', () => {
  const agent: FakeAgent = { id: 'main' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 3), 'retry', `attempt ${attempt}`)
  }
  // The 4th failure is past a budget of 3, and stays exhausted: repeated
  // failures must never render as "retry" again, or the cap would not hold.
  assert.equal(absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 3), 'exhausted')
  assert.equal(absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 3), 'exhausted')
})

test('a zero budget surfaces the first transport failure', () => {
  assert.equal(absorbTransportFailure({ id: 'main' }, TRANSPORT_FAILURE_CODE, 0), 'exhausted')
})

test('the budget is per agent', () => {
  const first: FakeAgent = { id: 'first' }
  const second: FakeAgent = { id: 'second' }
  absorbTransportFailure(first, TRANSPORT_FAILURE_CODE, 1)
  assert.equal(absorbTransportFailure(first, TRANSPORT_FAILURE_CODE, 1), 'exhausted')
  // A second agent still has its own budget: one conversation's outage must
  // not disable another's retries.
  assert.equal(absorbTransportFailure(second, TRANSPORT_FAILURE_CODE, 1), 'retry')
})

test('a reset restores the budget', () => {
  const agent: FakeAgent = { id: 'main' }
  absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 1)
  assert.equal(absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 1), 'exhausted')
  resetTransportFailures(agent)
  // `agent/status` → idle (and the user's own resend) land here.
  assert.equal(absorbTransportFailure(agent, TRANSPORT_FAILURE_CODE, 1), 'retry')
})

test('only a new step resets the budget, and only turn/end forgets the mapping', () => {
  // `agent/status` → `idle` is NOT a reset: `setPhase` emits it only on a status
  // CHANGE and a turn's steps share one `running` phase. Every other event —
  // including `assistant/attempt`, appended BEFORE `agent/request-error` — must
  // leave the budget alone, or the cap would refill on every failure.
  assert.equal(transportResetAction('step/start'), 'reset')
  assert.equal(transportResetAction('turn/end'), 'forget')
  for (const type of ['assistant/attempt', 'assistant/message', 'step/end', 'turn/start', 'llm/retry']) {
    assert.equal(transportResetAction(type), 'none', `${type} must not touch the budget`)
  }
})

test('the listener retries within budget and throws once it is spent', () => {
  const agent: FakeAgent = { id: 'main' }
  const signal = live()
  const decisions: Decision[] = []
  for (let attempt = 0; attempt < DEFAULT_TRANSPORT_MAX_RETRIES; attempt += 1) {
    decisions.push(respond(agent, TRANSPORT_FAILURE_CODE, signal, DEFAULT_TRANSPORT_MAX_RETRIES))
  }
  assert.deepEqual(decisions, Array.from({ length: DEFAULT_TRANSPORT_MAX_RETRIES }, () => ({ kind: 'retry' })))
  // Spent: throwing is the ONLY way to stop `dsh-llm-retry`, and it happens on
  // the next failure rather than after the 1000-attempt budget.
  assert.throws(
    () => respond(agent, TRANSPORT_FAILURE_CODE, signal, DEFAULT_TRANSPORT_MAX_RETRIES),
    /still failed after 5 automatic retries/,
  )
})

test('a cancelled turn is never retried and never spends the budget', () => {
  const agent: FakeAgent = { id: 'main' }
  const controller = new AbortController()
  controller.abort()
  assert.equal(respond(agent, TRANSPORT_FAILURE_CODE, controller.signal, 1), undefined)
  // The cancellation did not consume the single slot.
  assert.deepEqual(respond(agent, TRANSPORT_FAILURE_CODE, live(), 1), { kind: 'retry' })
})

test('the Host schema bound is the ceiling the module exports', async () => {
  // The client bundle cannot import this node-side module, so the settings page
  // mirrors the bound as a literal: one below this rejects a value the Host
  // accepts, one above lets a draft through the Host then refuses.
  const { Config } = await import('../src/index.ts')
  const field = (Config as unknown as { dict: Record<string, { meta?: { min?: number; max?: number } }> })
    .dict.transportMaxRetries
  assert.equal(field?.meta?.min, 0)
  assert.equal(field?.meta?.max, MAX_TRANSPORT_MAX_RETRIES)
})

test('the capped failure names the budget, the proxy check, and is bilingual', () => {
  const message = transportBudgetMessage('Command Code API request to https://api.commandcode.ai failed: fetch failed', 5)
  // The provider's own failure text survives: this replaces the retry chrome,
  // not the diagnosis.
  assert.match(message, /fetch failed/)
  assert.match(message, /5 automatic retries/)
  // Two facts a reporter needs: this is connectivity and not a context/size
  // rejection, and DSH reads the proxy from the environment only.
  assert.match(message, /HTTPS_PROXY/)
  assert.match(message, /not a context-window or request-size rejection/)
  assert.match(message, /已停止重试/)
  assert.match(message, /系统代理\/PAC/)
})
