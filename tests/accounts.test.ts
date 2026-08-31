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
import type { CommandCodeAccountSlot, CommandCodeModelAccountRule, FiveHourWindowProbe } from '../src/accounts.ts'

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
  probes?: Record<string, FiveHourWindowProbe | undefined>
  /** The manually preferred slot id. */
  preferredId?: string
  /** Model → account routing rules. */
  rules?: CommandCodeModelAccountRule[]
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

test('the probe pass never re-offers the excluded (just-rejected) key', async () => {
  // Single account, 429 arrives exactly as its window resets: the probe would
  // revive the same key, but the rotation path excludes it so the adapter is
  // not offered an already-tried key. The NEXT plain resolution picks the
  // revived key up.
  const { pool, probeCalls } = makePool({
    keys: { COMMANDCODE_API_KEY: 'key-1' },
    probes: { 'key-1': { exceeded: false, resetAt: 0 } },
  })
  pool.markRejected('key-1', 'rate-limit')
  const error = await pool.resolveKey({ exclude: 'key-1' }).then(
    () => assert.fail('expected resolveKey to throw'),
    (caught: unknown) => caught as Error & { code?: string },
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(probeCalls.length, 0) // the excluded key is not even probed
  // A later request (no exclusion) probes, revives, and serves it.
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
  const accounts = [
    { slot: defaultSlot(), key: 'key-1', state: undefined },
    { slot: extraSlot(2), key: 'key-2', state: undefined },
  ]
  const picked = selectAccountForModel(accounts, 'deepseek/deepseek-v4-pro', [
    { models: ['deepseek/deepseek-v4-pro'], account: 'account-2' },
  ])
  assert.equal(picked?.slot.id, 'account-2')
})

test('selectAccountForModel ignores a routed account that is not usable', () => {
  const accounts = [
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
  const next = await pool.resolveKey({ model: 'deepseek/deepseek-v4-pro', exclude: 'key-1' })
  assert.equal(next?.key, 'key-2')
})
