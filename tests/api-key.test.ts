import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey } from '../src/api-key.ts'

test('API key compatibility check trims a usable key', () => {
  assert.equal(assertUsableApiKey('  cc_test_key  ', 'llm-commandcode', 'COMMANDCODE_API_KEY'), 'cc_test_key')
})

for (const [name, key, message] of [
  ['blank', ' \t\n ', /is blank/],
  ['illegal header characters', 'cc_private\nvalue', /characters no HTTP header can carry/],
] as const) {
  test(`API key compatibility check rejects ${name} without exposing the credential`, () => {
    let caught: unknown
    try {
      assertUsableApiKey(key, 'llm-commandcode', 'COMMANDCODE_API_KEY')
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof LlmError, 'the rejection is an LlmError')
    assert.equal(caught.code, INVALID_CREDENTIAL_CODE)
    assert.match(caught.message, message)
    assert.match(caught.message, /COMMANDCODE_API_KEY/)
    assert.doesNotMatch(caught.message, /cc_private|value/)
  })
}
