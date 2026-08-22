/**
 * Login wire contract tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the three login Remote descriptors (endpoint names, service,
 * namespace, strict result schema) and the boundary validator both halves
 * share, so a shape drift fails here instead of rendering garbage.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LOGIN_BEGIN_ENDPOINT,
  LOGIN_CANCEL_ENDPOINT,
  LOGIN_DESCRIPTORS,
  LOGIN_HOST_CONTRIBUTION,
  LOGIN_REMOTE_CONTRIBUTION,
  LOGIN_STATUS_ENDPOINT,
  parseLoginStatus,
} from '../src/login-wire.ts'
import { USAGE_REMOTE_PACKAGE } from '../src/usage-wire.ts'

test('the three login descriptors target the usage service under one namespace', () => {
  assert.deepEqual(
    LOGIN_DESCRIPTORS.map((descriptor) => descriptor.id),
    [
      `${USAGE_REMOTE_PACKAGE}#${LOGIN_BEGIN_ENDPOINT}`,
      `${USAGE_REMOTE_PACKAGE}#${LOGIN_STATUS_ENDPOINT}`,
      `${USAGE_REMOTE_PACKAGE}#${LOGIN_CANCEL_ENDPOINT}`,
    ],
  )
  for (const descriptor of LOGIN_DESCRIPTORS) {
    assert.equal(descriptor.service, 'commandcodeUsage')
    assert.equal(descriptor.namespace, 'commandcode')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.result.mode, 'strict')
    assert.deepEqual(descriptor.parameters, [])
  }
})

test('host and client contributions carry the same descriptor list', () => {
  assert.equal(LOGIN_HOST_CONTRIBUTION.package, USAGE_REMOTE_PACKAGE)
  assert.equal(LOGIN_HOST_CONTRIBUTION.face, 'host')
  assert.equal(LOGIN_REMOTE_CONTRIBUTION.package, USAGE_REMOTE_PACKAGE)
  assert.deepEqual(LOGIN_REMOTE_CONTRIBUTION.descriptors, [...LOGIN_DESCRIPTORS])
})

test('parseLoginStatus accepts every documented state face', () => {
  assert.deepEqual(parseLoginStatus({ state: 'idle' }), { state: 'idle' })
  assert.deepEqual(
    parseLoginStatus({ state: 'waiting', authUrl: 'https://commandcode.ai/studio/auth/cli?x=1' }),
    { state: 'waiting', authUrl: 'https://commandcode.ai/studio/auth/cli?x=1' },
  )
  assert.deepEqual(
    parseLoginStatus({ state: 'success', userName: 'mars-sea', keyName: 'cli' }),
    { state: 'success', userName: 'mars-sea', keyName: 'cli' },
  )
  const failed = parseLoginStatus({ state: 'failed', reason: 'timeout', message: 'too slow' })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.reason, 'timeout')
  assert.equal(failed.message, 'too slow')
  // Unknown extra fields are dropped at the boundary.
  assert.deepEqual(parseLoginStatus({ state: 'idle', rogue: true }), { state: 'idle' })
})

test('parseLoginStatus rejects malformed frames', () => {
  assert.throws(() => parseLoginStatus(null))
  assert.throws(() => parseLoginStatus('idle'))
  assert.throws(() => parseLoginStatus({}))
  assert.throws(() => parseLoginStatus({ state: 'running' }))
  assert.throws(() => parseLoginStatus({ state: 'waiting', authUrl: 42 }))
  assert.throws(() => parseLoginStatus({ state: 'success', userName: 7 }))
  assert.throws(() => parseLoginStatus({ state: 'failed', reason: 'exploded' }))
  assert.throws(() => parseLoginStatus({ state: 'failed', message: [] }))
})
