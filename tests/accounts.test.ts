/**
 * Multi-account pool tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the rotation state machine: which account serves, how 429/401
 * marks behave, the window-probe revival path, and the exact errors thrown
 * when no account can serve.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { CommandCodeAccountPool, accountUsable, matchModelRule, selectAccountForModel } from '../src/accounts.ts'
import type { CommandCodeAccountSlot, CommandCodeModelAccountRule, AccountWindowProbe, ResolvedAccount } from '../src/accounts.ts'

/** The implicit first account, as the plugin entry builds it. */
function defaultSlot(over: Partial<CommandCodeAccountSlot> = {}): CommandCodeAccountSlot {
  return {
    id: 'default',
    label: 'Default',
    ref: credentialRef('COMMANDCODE_API_KEY'),
    allowAuthFile: true,
    ...over,
  }
}

/** One extra account slot, as the plugin entry builds it. */
function extraSlot(n: number, over: Partial<CommandCodeAccountSlot> = {}): CommandCodeAccountSlot {
  return {
    id: `account-${n}`,
    label: `Account ${n}`,
    ref: credentialRef(`COMMANDCODE_API_KEY_${n}`),
    allowAuthFile: false,
    ...over,
  }
}

interface PoolFixture {
  slots?: CommandCodeAccountSlot[]
  /** Credential-reference name -> resolved key. */
  keys?: Record<string, string | undefined>
  /** The official CLI auth-file key. */
  authFile?: string | undefined
  /** API key -> window probe result. */
  probes?: Record<string, AccountWindowProbe | undefined>
  /** The manually preferred slot id. */
  preferredId?: string
  /** Model → account routing rules. */
  rules?: CommandCodeModelAccountRule[]
  /** The pool's clock (the explicit-probe throttle); defaults to `Date.now`. */
  now?: () => number
}

/** A pool whose seams each test scripts; probe calls are recorded. */
function makePool(fixture: PoolFixture): { pool: CommandCodeAccountPool; probeCalls: string[] } {
  const probeCalls: string[] = []
  const pool = new CommandCodeAccountPool({
    slots: () => fixture.slots ?? [defaultSlot()],
    resolveRef: async (ref) => fixture.keys?.[String(ref)],
    authFileKey: () => fixture.authFile,
    probeWindow: async (apiKey) => {
      probeCalls.push(apiKey)
      return fixture.probes?.[apiKey]
    },
    preferredId: () => fixture.preferredId,
    modelAccountRules: () => fixture.rules ?? [],
    ...(fixture.now === undefined ? {} : { now: fixture.now }),
  })
  return { pool, probeCalls }
}

test('hands out the default account key', async () => {
  const { pool } = makePool({ keys: { COMMANDCODE_API_KEY: 'key-1' } })
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-1')
  assert.equal(resolved?.slot.id, 'default')
})

test('a literal key wins over the credential reference and the auth file', async () => {
  const { pool } = makePool({
    slots: [defaultSlot({ literal: 'literal-key' })],
    keys: { COMMANDCODE_API_KEY: 'ref-key' },
    authFile: 'file-key',
  })
  assert.equal((await pool.resolveKey())?.key, 'literal-key')
})

test('the auth file backs the default slot only', async () => {
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: {},
    authFile: 'file-key',
  })
  // The default slot falls back to the auth file; the extra resolves nothing.
  assert.equal((await pool.resolveKey())?.key, 'file-key')
  const accounts = await pool.resolvedAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.slot.id, 'default')
})

test('rotates past a rate-limited key to the next account', async () => {
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
  })
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  pool.markRejected('key-1', 'rate-limit')
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-2')
  assert.equal(resolved?.slot.id, 'account-2')
})

test('rotates past a disabled (401) key', async () => {
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
  })
  pool.markRejected('key-1', 'invalid-credential')
  assert.equal((await pool.resolveKey())?.key, 'key-2')
})

test('deduplicates slots resolving to the same key', async () => {
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2, { ref: credentialRef('COMMANDCODE_API_KEY') })],
    keys: { COMMANDCODE_API_KEY: 'key-1' },
  })
  const accounts = await pool.resolvedAccounts()
  assert.equal(accounts.length, 1)
  // Marking the shared key exhausts every slot that resolves to it.
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error,
  )
  // Bilingual: English first, then the Chinese reading (the harness UI
  // renders the message verbatim in its retry chrome).
  assert.match(error.message, /exhausted/)
  assert.match(error.message, /已用尽全部/)
})

test('revives an account whose window probe reports no longer exceeded', async () => {
  const { pool, probeCalls } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
    probes: { 'key-1': { exceeded: false, resetAt: 0 }, 'key-2': { exceeded: true, resetAt: Date.now() + 3_600_000 } },
  })
  pool.markRejected('key-1', 'rate-limit')
  pool.markRejected('key-2', 'rate-limit')
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-1')
  assert.deepEqual(probeCalls.sort(), ['key-1', 'key-2'])
  // The revived key's mark is cleared: the next resolution skips probing.
  probeCalls.length = 0
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.equal(probeCalls.length, 0)
})

test('throws RATE_LIMIT naming the earliest reset when every window is exceeded', async () => {
  const reset1 = Date.now() + 2 * 3_600_000
  const reset2 = Date.now() + 3_600_000
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
    probes: {
      'key-1': { exceeded: true, resetAt: reset1 },
      'key-2': { exceeded: true, resetAt: reset2 },
    },
  })
  pool.markRejected('key-1', 'rate-limit')
  pool.markRejected('key-2', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.match(error.message, /all 2 Command Code account/)
  // The earliest reset (key-2's) is the one named.
  assert.ok(error.message.includes(new Date(reset2).toLocaleString()))
})

test('a cooldown account becomes usable again once its reset time passes', async () => {
  const past = Date.now() - 60_000
  const { pool } = makePool({
    slots: [defaultSlot()],
    keys: { COMMANDCODE_API_KEY: 'key-1' },
    probes: { 'key-1': { exceeded: true, resetAt: past } },
  })
  pool.markRejected('key-1', 'rate-limit')
  // The probe stamps a cooldown whose reset already passed: usable again.
  assert.equal((await pool.resolveKey())?.key, 'key-1')
})

test('a failed probe keeps the mark and reports no reset time', async () => {
  const { pool } = makePool({
    slots: [defaultSlot()],
    keys: { COMMANDCODE_API_KEY: 'key-1' },
    probes: { 'key-1': undefined },
  })
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.doesNotMatch(error.message, /resets at/)
})

test('a throwing probe counts as unknown and still throws RATE_LIMIT', async () => {
  const pool = new CommandCodeAccountPool({
    slots: () => [defaultSlot()],
    resolveRef: async () => 'key-1',
    authFileKey: () => undefined,
    probeWindow: async () => { throw new Error('probe transport blew up') },
    preferredId: () => undefined,
    modelAccountRules: () => [],
  })
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'RATE_LIMIT')
})

test('throws INVALID_CREDENTIAL when every account was rejected with 401', async () => {
  const { pool, probeCalls } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
  })
  pool.markRejected('key-1', 'invalid-credential')
  pool.markRejected('key-2', 'invalid-credential')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'INVALID_CREDENTIAL')
  // Disabled keys are never probed.
  assert.equal(probeCalls.length, 0)
})

test('returns undefined when no account resolves any key', async () => {
  const { pool } = makePool({ slots: [defaultSlot(), extraSlot(2)], keys: {} })
  assert.equal(await pool.resolveKey(), undefined)
})

test('accountUsable maps every rotation state', () => {
  assert.equal(accountUsable(undefined), true)
  assert.equal(accountUsable({ kind: 'unknown', reason: 'rate limited (429)', until: 0 }), false)
  assert.equal(accountUsable({ kind: 'disabled', reason: 'invalid API key (401)', until: 0 }), false)
  assert.equal(accountUsable({ kind: 'cooldown', reason: 'x', until: Date.now() + 60_000 }), false)
  assert.equal(accountUsable({ kind: 'cooldown', reason: 'x', until: Date.now() - 60_000 }), true)
  assert.equal(accountUsable({ kind: 'cooldown', reason: 'x', until: 0 }), false)
})

// ---------------------------------------------------------------------------
// Manual (preferred) account selection
// ---------------------------------------------------------------------------

const TWO_ACCOUNTS = {
  slots: [defaultSlot(), extraSlot(2)],
  keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2' },
}

test('the preferred account serves while usable', async () => {
  const { pool } = makePool({ ...TWO_ACCOUNTS, preferredId: 'account-2' })
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-2')
  assert.equal(resolved?.slot.id, 'account-2')
})

test('an exhausted preferred account falls back to the first usable slot', async () => {
  const { pool } = makePool({ ...TWO_ACCOUNTS, preferredId: 'account-2' })
  pool.markRejected('key-2', 'rate-limit')
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-1')
  assert.equal(resolved?.slot.id, 'default')
})

test('a revived preferred account serves again', async () => {
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-1': { exceeded: true, resetAt: Date.now() + 3_600_000 }, 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  pool.markRejected('key-1', 'rate-limit')
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-2')
  assert.equal(resolved?.slot.id, 'account-2')
})

test('an unknown preferred id falls back to rotation order', async () => {
  const { pool } = makePool({ ...TWO_ACCOUNTS, preferredId: 'no-such-account' })
  assert.equal((await pool.resolveKey())?.key, 'key-1')
})

test('the all-exhausted RATE_LIMIT carries the wait until the earliest reset', async () => {
  // dsh-llm-retry reads providerRetryAfterMs and waits exactly that long (at
  // or below the policy's maxDelayMs), so the retry policy sleeps through the
  // window instead of polling at its backoff cadence.
  const resetAt = Date.now() + 60_000
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    probes: {
      'key-1': { exceeded: true, resetAt },
      'key-2': { exceeded: true, resetAt: resetAt + 30_000 },
    },
  })
  pool.markRejected('key-1', 'rate-limit')
  pool.markRejected('key-2', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as LlmError,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  const wait = error.failure.providerRetryAfterMs ?? 0
  assert.ok(wait >= 59_000 && wait <= 60_000, `expected ~60s wait, got ${wait}`)
})

test('a reset further out than the retry cap is not attached', async () => {
  // In normal mode the executor ABANDONs a retry whose attached wait exceeds
  // backoff.maxDelayMs instead of falling back to local backoff — a 2-hour
  // reset must ride the capped local cadence (and the probe revival), not
  // kill the retry.
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    probes: {
      'key-1': { exceeded: true, resetAt: Date.now() + 7_200_000 },
      'key-2': { exceeded: true, resetAt: Date.now() + 7_230_000 },
    },
  })
  pool.markRejected('key-1', 'rate-limit')
  pool.markRejected('key-2', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as LlmError,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, undefined)
})

test('the probe pass never re-offers a tried (just-rejected) key', async () => {
  // Single account, 429 arrives exactly as its window resets: the probe would
  // revive the same key, but the rotation path marks it tried so the adapter is
  // not offered an already-used key. The NEXT plain resolution picks the
  // revived key up.
  const { pool, probeCalls } = makePool({
    keys: { COMMANDCODE_API_KEY: 'key-1' },
    probes: { 'key-1': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey({ tried: ['key-1'] }).then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(probeCalls.length, 0) // a tried key is not even probed
  // A later request (nothing tried yet) probes, revives, and serves it.
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-1'])
})

test('describeAccounts reports slots sharing one credential individually', async () => {
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2, { ref: credentialRef('COMMANDCODE_API_KEY') })],
    keys: { COMMANDCODE_API_KEY: 'key-1' },
  })
  // The serving path dedups…
  assert.equal((await pool.resolvedAccounts()).length, 1)
  // …but the usage view sees both slots as configured.
  const described = await pool.describeAccounts()
  assert.equal(described.length, 2)
  assert.ok(described.every((account) => account.key === 'key-1'))
})

// ---------------------------------------------------------------------------
// Model → account routing rules
// ---------------------------------------------------------------------------

test('matchModelRule matches a listed model id', () => {
  const rule = matchModelRule('deepseek/deepseek-v4-pro', [
    { models: ['deepseek/deepseek-v4-pro'], account: 'default' },
  ])
  assert.equal(rule?.account, 'default')
})

test('matchModelRule matches any listed model, first rule wins', () => {
  const rules = [
    { models: ['deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-pro'], account: 'COMMANDCODE_API_KEY_2' },
    { models: ['deepseek/deepseek-v4-flash-vision-exp'], account: 'default' },
  ]
  assert.equal(matchModelRule('deepseek/deepseek-v4-pro', rules)?.account, 'COMMANDCODE_API_KEY_2')
  assert.equal(matchModelRule('deepseek/deepseek-v4-flash-vision-exp', rules)?.account, 'COMMANDCODE_API_KEY_2')
  // A non-listed model gets no rule.
  assert.equal(matchModelRule('tencent/hy4-preview', rules), undefined)
})

test('matchModelRule ignores empty model lists and returns undefined without rules', () => {
  assert.equal(matchModelRule('anything', undefined), undefined)
  assert.equal(matchModelRule('anything', []), undefined)
  assert.equal(matchModelRule('anything', [{ models: [], account: 'default' }]), undefined)
})

test('selectAccountForModel picks the routed account when usable', () => {
  const accounts: ResolvedAccount[] = [
    { slot: defaultSlot(), key: 'key-1', state: undefined },
    { slot: extraSlot(2), key: 'key-2', state: undefined },
  ]
  const picked = selectAccountForModel(accounts, 'deepseek/deepseek-v4-pro', [
    { models: ['deepseek/deepseek-v4-pro'], account: 'account-2' },
  ])
  assert.equal(picked?.slot.id, 'account-2')
})

test('selectAccountForModel ignores a routed account that is not usable', () => {
  const accounts: ResolvedAccount[] = [
    { slot: defaultSlot(), key: 'key-1', state: undefined },
    { slot: extraSlot(2), key: 'key-2', state: { kind: 'disabled', reason: '401', until: 0 } },
  ]
  const picked = selectAccountForModel(accounts, 'deepseek/deepseek-v4-pro', [
    { models: ['deepseek/deepseek-v4-pro'], account: 'account-2' },
  ])
  assert.equal(picked, undefined)
})

test('resolveKey routes by model before the preferred/rotation selection', async () => {
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'default',
    rules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'account-2' }],
  })
  // Without a model the preferred account serves…
  assert.equal((await pool.resolveKey())?.slot.id, 'default')
  // …with a matching model the routed account serves instead.
  const routed = await pool.resolveKey({ model: 'deepseek/deepseek-v4-pro' })
  assert.equal(routed?.slot.id, 'account-2')
  assert.equal(routed?.key, 'key-2')
})

test('resolveKey falls back to rotation when the routed account is exhausted', async () => {
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    rules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'account-2' }],
  })
  pool.markRejected('key-2', 'rate-limit')
  // The routed account is marked; the fallback serves the first usable account.
  const routed = await pool.resolveKey({ model: 'deepseek/deepseek-v4-pro' })
  assert.equal(routed?.slot.id, 'default')
  assert.equal(routed?.key, 'key-1')
})

test('resolveKey routes through the rotation hook after a rejection', async () => {
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    rules: [{ models: ['deepseek/deepseek-v4-pro'], account: 'default' }],
  })
  // First request for the model uses the routed default account.
  assert.equal((await pool.resolveKey({ model: 'deepseek/deepseek-v4-pro' }))?.key, 'key-1')
  // It is rejected; the next resolution for the same model excludes it and
  // serves the fallback account.
  pool.markRejected('key-1', 'rate-limit')
  const next = await pool.resolveKey({ model: 'deepseek/deepseek-v4-pro', tried: ['key-1'] })
  assert.equal(next?.key, 'key-2')
})

// ---------------------------------------------------------------------------
// Walking the pool within one request (issue #51's follow-up)
// ---------------------------------------------------------------------------

test('a request can walk the whole pool through the tried set', async () => {
  // An account-scoped rejection that marks nothing (no credits, a model
  // outside the account's plan) must still let the request reach the accounts
  // behind it: without the tried set the pool re-offers the same key on every
  // attempt and a four-account pool behaves like a one-account pool.
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2), extraSlot(3)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-2', COMMANDCODE_API_KEY_3: 'key-3' },
  })
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.equal((await pool.resolveKey({ tried: ['key-1'] }))?.key, 'key-2')
  assert.equal((await pool.resolveKey({ tried: ['key-1', 'key-2'] }))?.key, 'key-3')
  // Every account tried and none marked: the caller's own rejection is the
  // honest answer, never a synthetic "all accounts exhausted".
  assert.equal(await pool.resolveKey({ tried: ['key-1', 'key-2', 'key-3'] }), undefined)
})

test('an all-tried, all-marked pool still names the earliest reset', async () => {
  const resetAt = Date.now() + 60_000
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    probes: {
      'key-1': { exceeded: true, resetAt },
      'key-2': { exceeded: true, resetAt: resetAt + 30_000 },
    },
  })
  // The provider's own reset time rides the rejection body, so the mark is a
  // cooldown that expires by itself instead of an open-ended "unknown".
  pool.markRejected('key-1', 'rate-limit', resetAt)
  pool.markRejected('key-2', 'rate-limit', resetAt + 30_000)
  const error = await pool.resolveKey({ tried: ['key-1', 'key-2'] }).then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as LlmError,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.match(error.message, /earliest window resets/)
  const wait = error.failure.providerRetryAfterMs ?? 0
  assert.ok(wait > 0 && wait <= 60_000, `expected a wait until the reset, got ${wait}`)
})

test('a tried account that is merely unmarked keeps the caller’s own rejection', async () => {
  // The pool's diagnosis must not speak for a rejection it did not make. An
  // `unavailable` rejection (no credits, a model outside this account's plan)
  // marks nothing, so the account it came from is still USABLE — and when that
  // was the only account the request could reach, "every configured account was
  // rejected with 401" is a lie that sends the user hunting for a key that
  // already works. Same rule as the no-account-left branch: return undefined.
  const { pool } = makePool({ ...TWO_ACCOUNTS })
  pool.markRejected('key-2', 'invalid-credential')
  assert.equal(await pool.resolveKey({ tried: ['key-1'] }), undefined)
})

test('an exhausted remainder does not turn a tried-unmarked account into a rate limit', async () => {
  // The same rule with the other mark: key-2 sits in a cooldown while key-1 —
  // the account the request already used and got a plan rejection from — is
  // fine. Synthesizing RATE_LIMIT here would hand dsh-llm-retry the reset of an
  // account the request will not use, turning a PERMANENT failure into a wait
  // of up to the policy's 15-minute ceiling.
  const { pool } = makePool({
    ...TWO_ACCOUNTS,
    probes: { 'key-2': { exceeded: true, resetAt: Date.now() + 900_000 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  assert.equal(await pool.resolveKey({ tried: ['key-1'] }), undefined)
})

test('a diagnosis that loses its second resolution still describes the pool', async () => {
  // resolvedAccounts() runs the host's async seams twice per resolution, so the
  // second pass can come back empty (a transient credential-store miss, not a
  // configuration change). The diagnosis must still name the accounts the pool
  // HAS: "every configured account (0) was rejected with 401" names neither an
  // account nor a real cause.
  let resolutions = 0
  const pool = new CommandCodeAccountPool({
    slots: () => [defaultSlot()],
    resolveRef: async () => (++resolutions === 1 ? 'key-1' : undefined),
    authFileKey: () => undefined,
    probeWindow: async () => ({ exceeded: true, resetAt: Date.now() + 600_000 }),
  })
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey().then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as LlmError,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.match(error.message, /all 1 Command Code account/)
  assert.doesNotMatch(error.message, /\(0\)/)
})

test('a rate-limit mark carrying an already-passed reset stays probe-eligible', async () => {
  // A stale `reset` (or none at all) must not become a cooldown that never
  // expires: it stays an `unknown` mark, which is exactly what the pinned
  // account's revival probe exists to re-check.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit', Date.now() - 1000)
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, ['key-2'])
})

test('a probe that publishes no reset time leaves the mark probe-eligible', async () => {
  // `cooldown` with `until: 0` reads as "never usable again" to
  // `accountUsable`, which would take the account out of service for the whole
  // process. An unknown reset keeps the `unknown` mark instead.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: true, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  // The pinned account is probed, still exceeded, and no reset is published.
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-2'])
  const marked = (await pool.resolvedAccounts()).find((account) => account.key === 'key-2')
  assert.equal(marked?.state?.kind, 'unknown', 'no never-expiring cooldown is stamped')
})

// ---------------------------------------------------------------------------
// Explicit-selection revival (issue #51)
// ---------------------------------------------------------------------------

test('a pinned account whose window cleared serves again right after the 429', async () => {
  // Issue #51: the pin was demoted until dsh restarted. A 429 marks the key
  // `unknown` — usable again only through a window probe — and the only probe
  // pass was the all-marked one, which never runs while another account can
  // serve. So one 429 moved every later request to `default`, and re-selecting
  // the account in settings could not help: the mark lives on the key, not on
  // the selection. Now the pinned account is probed before the fallback takes
  // over, and a cleared window puts the user's own choice back immediately.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-2')
  assert.equal(resolved?.slot.id, 'account-2')
  // The probe answered the question for good: the mark is gone, so the next
  // resolution costs no API call.
  assert.deepEqual(probeCalls, ['key-2'])
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, ['key-2'])
})

test('a probe that confirms exhaustion stamps the reset, and the pin returns by the clock', async () => {
  const resetAt = Date.now() + 30
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: true, resetAt } },
  })
  pool.markRejected('key-2', 'rate-limit')
  // Genuinely exhausted: the fallback serves, and the mark now carries the
  // provider's own reset time instead of staying unknown forever.
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  await new Promise((resolve) => setTimeout(resolve, 120))
  // Past the reset the cooldown expires on its own — no second probe.
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, ['key-2'])
})

test('a failed probe keeps the pin marked and is retried at most once per interval', async () => {
  // A probe endpoint that is down must not turn every request into an extra
  // billing call: the attempt is throttled and the mark stands.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': undefined },
  })
  pool.markRejected('key-2', 'rate-limit')
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-2'])
})

test('a revived pin does not buy an immediate second probe when it is rejected again', async () => {
  // The probe and the chat endpoint do not answer the same question: the probe
  // reads `windowLimits`, while a spend cap or a model-level limit arrives as a
  // `RATE_LIMITED` rejection the probe cannot see. So "probe says open → revive
  // → 429 again" is a real loop, and dropping the throttle stamp on the revival
  // made it cost one billing GET plus one doomed upstream attempt per request,
  // forever. The stamp now survives the revival: the interval still bounds the
  // retries, and a revival that was right costs nothing (a serving account is
  // never probed at all).
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, ['key-2'])

  pool.markRejected('key-2', 'rate-limit') // the provider rejects it again
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-2'], 'the interval still bounds the retry')
})

test('the probe interval lets the pin be re-probed once it has elapsed', async () => {
  // The other half of the throttle, and the reason the pool takes a clock: if
  // the comparison never came true, a pinned account could never come back and
  // every test above would still be green.
  let clock = 1_000_000
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: true, resetAt: 0 } },
    now: () => clock,
  })
  pool.markRejected('key-2', 'rate-limit')
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-2'])

  clock += 60_000
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, ['key-2', 'key-2'], 'past the interval the pin is re-checked')
})

test('the just-rejected key is not re-probed within the same request rotation', async () => {
  // The rotation hook resolves with `tried` — every key this request already
  // burned, the just-rejected one included. Probing a key it just heard a 429
  // from answers nothing new and would cost a request on every rotation.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  assert.equal((await pool.resolveKey({ tried: ['key-2'] }))?.key, 'key-1')
  assert.deepEqual(probeCalls, [])
})

test('a 401-marked pin is never probed: an invalid key stays invalid', async () => {
  // Only a rate-limit mark is re-checked. A 401 clears when the stored
  // credential changes, never by a window probe.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'invalid-credential')
  assert.equal((await pool.resolveKey())?.key, 'key-1')
  assert.deepEqual(probeCalls, [])
})

test('a usable explicit account costs no probe at all', async () => {
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'account-2',
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, [])
})

test('an ordinary rotation mark is not probed while another account can serve', async () => {
  // Nothing was explicitly asked for: an un-pinned marked account still waits
  // for the all-marked pass, exactly as before, so the steady state keeps
  // costing zero extra API calls.
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    probes: { 'key-1': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-1', 'rate-limit')
  assert.equal((await pool.resolveKey())?.key, 'key-2')
  assert.deepEqual(probeCalls, [])
})

test('a model-routed account is revived the same way, ahead of the pin', async () => {
  // Routing outranks the manual pin for the selection; it is also the explicit
  // target for the revival, so a rule's account comes back when its window
  // clears even though another pin is set.
  const model = 'deepseek/deepseek-v4-pro'
  const { pool, probeCalls } = makePool({
    ...TWO_ACCOUNTS,
    preferredId: 'default',
    rules: [{ models: [model], account: 'account-2' }],
    probes: { 'key-2': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-2', 'rate-limit')
  const routed = await pool.resolveKey({ model })
  assert.equal(routed?.slot.id, 'account-2')
  assert.equal(routed?.key, 'key-2')
  assert.deepEqual(probeCalls, ['key-2'])
})

// ---------------------------------------------------------------------------
// Credential normalization (marks must land on the key the adapter reports)
// ---------------------------------------------------------------------------

test('a key with surrounding whitespace is normalized before it is handed out', async () => {
  // The adapter sends every key through the harness's `assertUsableApiKey()`,
  // which trims it, and reports that trimmed form back as the rejected key.
  // Handing out the raw value would file every 429/401 mark under a string no
  // later lookup can find: rotation would re-offer the same account and the
  // marks would never show.
  const { pool } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: '  key-1\n', COMMANDCODE_API_KEY_2: 'key-2' },
  })
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'key-1')

  pool.markRejected('key-1', 'rate-limit')
  const next = await pool.resolveKey({ tried: ['key-1'] })
  assert.equal(next?.key, 'key-2', 'the marked account is skipped')
})

test('a whitespace-padded credential still shares one mark across slots', async () => {
  // Two slots resolving to the same credential (modulo whitespace) must share
  // one rotation state, exactly as two identical strings do.
  const { pool, probeCalls } = makePool({
    slots: [defaultSlot(), extraSlot(2)],
    keys: { COMMANDCODE_API_KEY: 'key-1', COMMANDCODE_API_KEY_2: 'key-1 ' },
    probes: { 'key-1': { exceeded: true, resetAt: Date.now() + 60_000 } },
  })
  const accounts = await pool.resolvedAccounts()
  assert.equal(accounts.length, 1, 'deduplicated by the normalized key')
  assert.equal(accounts[0]?.key, 'key-1')

  pool.markRejected('key-1', 'rate-limit')
  await assert.rejects(
    () => pool.resolveKey(),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )
  // The probe pass saw the normalized key, not the padded source value.
  assert.deepEqual(probeCalls, ['key-1'])
})

test('a credential that is blank after trimming counts as missing', async () => {
  const { pool } = makePool({ keys: { COMMANDCODE_API_KEY: '   \n' } })
  assert.deepEqual(await pool.resolvedAccounts(), [])
  assert.equal(await pool.resolveKey(), undefined)
})

test('a padded auth-file key is normalized too', async () => {
  const { pool } = makePool({ authFile: ' file-key\n' })
  const resolved = await pool.resolveKey()
  assert.equal(resolved?.key, 'file-key')
})
