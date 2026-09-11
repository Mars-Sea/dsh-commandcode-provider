/**
 * Config-schema credential contract (node:test, zero deps). Run with `npm test`.
 *
 * The settings page writes the API key through the credentials seam, so the key
 * literal never enters a settings document on the normal path. A composition
 * config (`cordis.patch.yml`) or a hand-edited `settings.yaml` may still set a
 * literal `apiKey`, and that path IS a settings value — so the schema must mark
 * it `role('secret')`. The harness redacts those roles from every descriptor it
 * serves (`settings.describe()` runs with `redactSecrets: true`), which is what
 * keeps the literal out of the browser on a remote-Host setup.
 *
 * A schema without the role parses and resolves exactly the same way — the
 * literal just rides back to the client — so this file pins the DECLARATION,
 * not the parse result.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactSecrets } from '@deepseek-ai/dsh-settings'

import { Config, resolveAdapterOptions } from '../src/index.ts'

test('literal API keys are declared secret and stripped from a settings descriptor', () => {
  const value = {
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    apiKey: 'sk-literal-SECRET-123',
    accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2', apiKey: 'sk-second-SECRET-456' }],
  }
  const redacted = redactSecrets(Config, value) as {
    value: Record<string, unknown>
    secrets: Array<{ path: readonly (string | number)[] }>
  }

  // The literals never reach the caller…
  assert.equal(redacted.value.apiKey, undefined)
  const accounts = redacted.value.accounts as Array<Record<string, unknown>>
  assert.equal(accounts[0]?.apiKey, undefined)
  // …while the reference (not a secret) and the rest of the profile survive.
  assert.equal(redacted.value.apiKeyEnv, 'COMMANDCODE_API_KEY')
  assert.equal(accounts[0]?.apiKeyEnv, 'COMMANDCODE_API_KEY_2')
  assert.equal(accounts[0]?.label, 'second')
  // Reported per path, so the page can show "set" without the value.
  // (Array segments are stringified — the harness spells them as keys.)
  assert.deepEqual(
    redacted.secrets.map((secret) => secret.path.map(String)),
    [['apiKey'], ['accounts', '0', 'apiKey']],
  )
})

test('a literal API key still configures the route from a composition config', () => {
  // Redaction is a descriptor-facing concern only: the resolved runtime config
  // keeps the literal, which is how the composition path serves requests.
  const config = Config({ apiKey: 'sk-literal-123' })
  assert.equal(config.apiKey, 'sk-literal-123')
  assert.equal(resolveAdapterOptions(config).apiKeyEnv, 'COMMANDCODE_API_KEY')
})
