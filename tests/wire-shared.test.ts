/**
 * Strict-codec contract: every Remote descriptor this plugin ships must
 * register on dsh 0.1.7-rc.1 (node:test; issue #49).
 *
 * The Typert protocol carries a strict result codec as a LAZY schema factory —
 * `{ mode: 'strict', typeSymbol, create: () => TypertSchema }` — and both the
 * registry and the Gateway read exactly that member: registration refuses a
 * codec without `create` (`typert: <subject> strict codec has no create()
 * factory`), and the Gateway validates with `codec.create().parse(value)`.
 *
 * These tests drive the REAL shipped descriptors through a transcription of
 * that registration check and through `makeRemoteDescriptor()`, so the shape
 * cannot drift out from under the wire contract.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRemoteDescriptor } from '../src/wire-shared.ts'
import {
  MODELS_REMOTE_CONTRIBUTION,
  PRICES_REMOTE_CONTRIBUTION,
  USAGE_HOST_CONTRIBUTION,
  USAGE_REMOTE_CONTRIBUTION,
} from '../src/usage-wire.ts'
import { LOGIN_HOST_CONTRIBUTION, LOGIN_REMOTE_CONTRIBUTION } from '../src/login-wire.ts'
import type { InvocationDescriptor, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** The shared shape the engine's validators are handed. */
type ResultCodec = InvocationDescriptor['result']

/**
 * The registry's registration check, transcribed from `dsh-typert-registry`.
 * Its exact code is `typeof codec.create !== 'function'` → throw.
 */
function assertEngineAccepts(codec: ResultCodec, subject: string): void {
  if (codec.mode === 'src-json') return
  assert.equal(
    typeof codec.create,
    'function',
    `${subject}: the registry refuses a strict codec with no create() factory`,
  )
}

/** One trivial schema standing in for a hand-rolled result validator. */
const fakeSchema: TypertSchema<string> = { parse: (value: unknown) => String(value) }

/**
 * Every descriptor the plugin crosses the Gateway with, gathered from the
 * contributions themselves rather than a hand-written list: a new endpoint
 * added to a host or client contribution is covered the moment it exists.
 */
const SHIPPED_DESCRIPTORS: readonly InvocationDescriptor[] = [
  ...USAGE_HOST_CONTRIBUTION.invocations,
  ...USAGE_REMOTE_CONTRIBUTION.descriptors,
  ...MODELS_REMOTE_CONTRIBUTION.descriptors,
  ...PRICES_REMOTE_CONTRIBUTION.descriptors,
  ...LOGIN_HOST_CONTRIBUTION.invocations,
  ...LOGIN_REMOTE_CONTRIBUTION.descriptors,
]

test('every shipped descriptor registers on the supported engine', () => {
  const ids = new Set(SHIPPED_DESCRIPTORS.map(descriptor => descriptor.id))
  assert.equal(ids.size, 6, `expected the six commandcode endpoints, saw ${[...ids].join(', ')}`)
  for (const [index, descriptor] of SHIPPED_DESCRIPTORS.entries()) {
    const subject = `${descriptor.id} result`
    assert.equal(descriptor.result.mode, 'strict')
    assertEngineAccepts(descriptor.result, `${subject} (descriptor ${index})`)
    for (const parameter of descriptor.parameters) {
      const field = `${descriptor.id} parameter ${parameter.name}`
      assert.equal(parameter.codec.mode, 'strict', `${field}: the client Remote refuses src-json parameters`)
      assertEngineAccepts(parameter.codec, field)
    }
  }
})

test('create() materializes the declared schema itself, not a second validator', () => {
  for (const descriptor of SHIPPED_DESCRIPTORS) {
    const codec = descriptor.result
    if (codec.mode === 'src-json') continue
    const materialized = codec.create()
    assert.equal(typeof materialized.parse, 'function', `${descriptor.id}: create() must answer a parsing schema`)
  }
})

test('the descriptor factory carries the create() factory for any schema', () => {
  const descriptor = makeRemoteDescriptor<string>('commandcode/probe', 'probe', 'probe#Result', fakeSchema)
  assert.deepEqual(descriptor.parameters, [])
  assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  assertEngineAccepts(descriptor.result, 'probe result')
  assert.equal(descriptor.result.mode === 'strict' ? descriptor.result.create().parse('42') : undefined, '42')
})

test('a codec without create() is refused', () => {
  const schemaOnly: ResultCodec = { mode: 'strict', typeSymbol: 'probe#Result', schema: fakeSchema } as unknown as ResultCodec
  assert.throws(() => assertEngineAccepts(schemaOnly, 'probe result'))
  assertEngineAccepts(makeRemoteDescriptor('commandcode/probe', 'probe', 'probe#Result', fakeSchema).result, 'probe result')
})
