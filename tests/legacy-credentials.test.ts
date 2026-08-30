/** Legacy credential adapter tests. */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { adaptLegacyCredentials, type LegacyCredentialsApi } from '../src/client/legacy-credentials.ts'

function legacyApi(store: Map<string, string>): LegacyCredentialsApi {
  return {
    describe: async ({ refs }) => ({
      result: {
        ok: true,
        value: {
          credentials: Object.fromEntries(refs.map(ref => [ref, {
            configured: store.has(ref),
            writable: true,
          }])),
        },
      },
    }),
    set: async ({ ref, value }) => {
      store.set(ref, value)
      return { result: { ok: true, value: {} } }
    },
    unset: async ({ ref }) => {
      store.delete(ref)
      return { result: { ok: true, value: {} } }
    },
  }
}

test('returns undefined when the legacy credentials face is absent', () => {
  assert.equal(adaptLegacyCredentials(undefined), undefined)
})

test('normalizes legacy describe, set, and unset envelopes', async () => {
  const store = new Map<string, string>()
  const adapted = adaptLegacyCredentials(legacyApi(store))
  assert.ok(adapted !== undefined)

  assert.deepEqual(await adapted.credentials.describe(['COMMANDCODE_API_KEY']), {
    ok: true,
    value: { COMMANDCODE_API_KEY: { configured: false, writable: true } },
  })
  assert.deepEqual(await adapted.credentials.set('COMMANDCODE_API_KEY', 'sk-test'), {
    ok: true,
    value: undefined,
  })
  assert.equal(store.get('COMMANDCODE_API_KEY'), 'sk-test')
  assert.deepEqual(await adapted.credentials.unset('COMMANDCODE_API_KEY'), {
    ok: true,
    value: undefined,
  })
  assert.equal(store.has('COMMANDCODE_API_KEY'), false)
})

test('preserves legacy business failures', async () => {
  const failure: LegacyCredentialsApi = {
    describe: async () => ({ result: { ok: false, error: { message: 'describe refused' } } }),
    set: async () => ({ result: { ok: false, error: { message: 'set refused' } } }),
    unset: async () => ({ result: { ok: false, error: { message: 'unset refused' } } }),
  }
  const adapted = adaptLegacyCredentials(failure)
  assert.ok(adapted !== undefined)

  assert.deepEqual(await adapted.credentials.describe(['COMMANDCODE_API_KEY']), {
    ok: false,
    error: { message: 'describe refused' },
  })
  assert.deepEqual(await adapted.credentials.set('COMMANDCODE_API_KEY', 'sk-test'), {
    ok: false,
    error: { message: 'set refused' },
  })
  assert.deepEqual(await adapted.credentials.unset('COMMANDCODE_API_KEY'), {
    ok: false,
    error: { message: 'unset refused' },
  })
})
