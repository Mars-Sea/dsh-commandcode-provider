/** readableErrorText() compatibility tests (issue #74). */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readableErrorText } from '../src/client/error-text.ts'

test('reads message off a real Error', () => {
  assert.equal(readableErrorText(new Error('boom')), 'boom')
})

test('reads message off a plain object (a prototype-losing RPC rejection)', () => {
  assert.equal(readableErrorText({ message: 'settings remote unavailable' }), 'settings remote unavailable')
})

test('returns a string thrown as-is', () => {
  assert.equal(readableErrorText('plain string throw'), 'plain string throw')
})

test('never degrades to [object Object] for a message-less plain object', () => {
  const text = readableErrorText({ code: 'TRANSPORT', retryable: true })
  assert.doesNotMatch(text, /\[object Object\]/)
  assert.match(text, /TRANSPORT/)
})

test('falls back to the tag string for a value JSON.stringify cannot serialize', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(readableErrorText(circular), '[object Object]')
})

test('ignores an empty message field and falls through to a JSON dump', () => {
  const text = readableErrorText({ message: '', code: 'EMPTY' })
  assert.match(text, /EMPTY/)
})

test('handles non-object primitives', () => {
  assert.equal(readableErrorText(undefined), 'undefined')
  assert.equal(readableErrorText(null), 'null')
  assert.equal(readableErrorText(404), '404')
})
