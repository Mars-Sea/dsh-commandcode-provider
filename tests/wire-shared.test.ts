/**
 * Cross-generation strict-codec contract (node:test; issue #49).
 *
 * The Typert protocol changed the strict result codec's shape INSIDE the same
 * `mode: 'strict'` tag, and the two engine generations read opposite members
 * while ignoring the other:
 *
 * - Released engines (`0.1.2-rc.1` … `0.1.6-alpha.1`, every published version)
 *   validate `typeof codec.schema.parse === 'function'` and then run
 *   `codec.schema.parse(value)`.
 * - master after `e459e3263` validates `typeof codec.create === 'function'`
 *   and then runs `codec.create().parse(value)`.
 *
 * `makeRemoteDescriptor()` therefore carries BOTH members, and these tests
 * drive the two real validators — transcribed from each generation's
 * `dsh-typert-registry` — over every descriptor the plugin ships, so neither
 * half of the fix can be dropped by a later "simplification": keeping only
 * `create` takes the settings page down on every install that exists today
 * (the mistake issue #49 proposed), and keeping only `schema` takes it down on
 * master. The negative controls at the end pin exactly that.
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

/** The shared shape both generations' validators are handed. */
type ResultCodec = InvocationDescriptor['result']

/** The member the newer generation reads, invisible to the local typings. */
type LazyFactory = { create?: () => TypertSchema }

/**
 * The released generation's registration check, transcribed from
 * `dsh-typert-registry` ≤ `0.1.6-alpha.1`. Its exact code is
 * `typeof codec.schema.parse !== 'function'`, so an absent `schema` fails the
 * check by throwing a `TypeError` rather than its own message — either way the
 * registration is refused, which is what this asserts.
 */
function assertReleasedEngineAccepts(codec: ResultCodec, subject: string): void {
  if (codec.mode === 'src-json') return
  assert.equal(
    typeof (codec as { schema?: TypertSchema }).schema?.parse,
    'function',
    `${subject}: released engines refuse a strict codec with no codec.schema.parse`,
  )
}

/** master's registration check, transcribed from `e459e3263`. */
function assertMasterEngineAccepts(codec: ResultCodec, subject: string): void {
  if (codec.mode === 'src-json') return
  assert.equal(
    typeof (codec as LazyFactory).create,
    'function',
    `${subject}: engines after e459e3263 refuse a strict codec with no create() factory`,
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

test('every shipped descriptor satisfies both engine generations', () => {
  const ids = new Set(SHIPPED_DESCRIPTORS.map(descriptor => descriptor.id))
  assert.equal(ids.size, 6, `expected the six commandcode endpoints, saw ${[...ids].join(', ')}`)
  for (const [index, descriptor] of SHIPPED_DESCRIPTORS.entries()) {
    const subject = `${descriptor.id} result`
    assert.equal(descriptor.result.mode, 'strict')
    assertReleasedEngineAccepts(descriptor.result, `${subject} (descriptor ${index})`)
    assertMasterEngineAccepts(descriptor.result, `${subject} (descriptor ${index})`)
    for (const parameter of descriptor.parameters) {
      const field = `${descriptor.id} parameter ${parameter.name}`
      assert.equal(parameter.codec.mode, 'strict', `${field}: the client Remote refuses src-json parameters`)
      assertReleasedEngineAccepts(parameter.codec, field)
      assertMasterEngineAccepts(parameter.codec, field)
    }
  }
})

test('create() materializes the declared schema itself, not a second validator', () => {
  for (const descriptor of SHIPPED_DESCRIPTORS) {
    const codec = descriptor.result
    if (codec.mode === 'src-json') continue
    const schema = (codec as { schema: TypertSchema }).schema
    const materialize = (codec as LazyFactory).create
    assert.equal(typeof materialize, 'function')
    const materialized = materialize!()
    assert.equal(materialized, schema, `${descriptor.id}: create() must return the same schema object`)
    assert.equal(materialized.parse, schema.parse, `${descriptor.id}: both generations must run one parser`)
  }
})

test('the descriptor factory carries both members for any schema', () => {
  const descriptor = makeRemoteDescriptor<string>('commandcode/probe', 'probe', 'probe#Result', fakeSchema)
  assert.deepEqual(descriptor.parameters, [])
  assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  assertReleasedEngineAccepts(descriptor.result, 'probe result')
  assertMasterEngineAccepts(descriptor.result, 'probe result')
  const materialize = (descriptor.result as LazyFactory).create!
  assert.equal(materialize().parse('42'), '42')
})

test('either generation rejects a codec that carries only the other member', () => {
  // The released generation refuses a `create`-only codec (issue #49's patch).
  const lazyOnly: ResultCodec = {
    mode: 'strict',
    typeSymbol: 'probe#Result',
    create: () => fakeSchema,
  } as unknown as ResultCodec
  assert.throws(() => assertReleasedEngineAccepts(lazyOnly, 'probe result'))

  // master refuses the `schema`-only codec every shipped release needs.
  const schemaOnly: ResultCodec = { mode: 'strict', typeSymbol: 'probe#Result', schema: fakeSchema }
  assert.throws(() => assertMasterEngineAccepts(schemaOnly, 'probe result'))

  // Both members: accepted by both generations.
  assertReleasedEngineAccepts(makeRemoteDescriptor('commandcode/probe', 'probe', 'probe#Result', fakeSchema).result, 'probe result')
  assertMasterEngineAccepts(makeRemoteDescriptor('commandcode/probe', 'probe', 'probe#Result', fakeSchema).result, 'probe result')
})
