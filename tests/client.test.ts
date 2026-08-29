/**
 * Client-half unit tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the friendly-error rewrite for the harness's image-session
 * `model-unavailable` rejection on `session.selectModel`, so the browser
 * wrapper cannot silently regress to showing the raw English message.
 *
 * The wire shape mirrors `AbstractApiClient.callUnary` in
 * dsh-client-connection: every selectModel call resolves to the full envelope
 * `{ rpcId, result: { ok, error? } }` — the error lives under `result.result`,
 * NOT at the top level. Tests assert against that real shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installFriendlyImageError, withFriendlyImageError, isImageSessionRejection } from '../src/client/sessions.ts'
import { PLUGIN_VERSION } from '../src/client/version.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The harness rejection we rewrite, in the real envelope shape. */
function imageGateError(model: string) {
  return {
    rpcId: 'rpc-1',
    result: {
      ok: false as const,
      error: {
        code: 'model-unavailable',
        message: `Model "${model}" does not accept image input, but this session already contains images; select an image-capable model.`,
        details: { provider: 'commandcode', model },
      },
    },
  }
}

/** A sessions face whose selectModel returns the given result. */
function sessionsReturning(result: unknown) {
  return {
    selectModel: async () => result,
  }
}

// ---------------------------------------------------------------------------
// isImageSessionRejection
// ---------------------------------------------------------------------------

test('isImageSessionRejection() matches the harness image-session gate', () => {
  assert.equal(isImageSessionRejection(imageGateError('deepseek/deepseek-v4-flash') as never), true)
})

test('isImageSessionRejection() ignores other failures', () => {
  assert.equal(
    isImageSessionRejection({
      rpcId: 'rpc-1',
      result: { ok: true, value: { selected: {} } },
    } as never),
    false,
  )
  assert.equal(
    isImageSessionRejection({
      rpcId: 'rpc-1',
      result: {
        ok: false as const,
        error: { code: 'model-unavailable', message: 'some other unavailability', details: { provider: 'commandcode', model: 'x' } },
      },
    } as never),
    false,
  )
  assert.equal(
    isImageSessionRejection({
      rpcId: 'rpc-1',
      result: {
        ok: false as const,
        error: { code: 'session-not-found', message: 'nope', details: { sessionId: 's' } },
      },
    } as never),
    false,
  )
})

// ---------------------------------------------------------------------------
// withFriendlyImageError
// ---------------------------------------------------------------------------

test('withFriendlyImageError() rewrites the image-gate message with the model name in zh', async () => {
  const sessions = sessionsReturning(imageGateError('deepseek/deepseek-v4-flash'))
  const wrapped = withFriendlyImageError(sessions as never, () => 'zh')
  const result = await wrapped.selectModel({ sessionId: 's', provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(result.result.ok, false)
  assert.equal(result.result.error.code, 'model-unavailable')
  assert.equal(result.result.error.details.model, 'deepseek/deepseek-v4-flash')
  assert.match(result.result.error.message, /当前会话已包含图片/)
  assert.match(result.result.error.message, /deepseek\/deepseek-v4-flash/)
  assert.match(result.result.error.message, /不支持图片输入/)
})

test('withFriendlyImageError() rewrites the image-gate message with the model name in en', async () => {
  const sessions = sessionsReturning(imageGateError('deepseek/deepseek-v4-flash'))
  const wrapped = withFriendlyImageError(sessions as never, () => 'en')
  const result = await wrapped.selectModel({ sessionId: 's', provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(result.result.ok, false)
  assert.equal(result.result.error.code, 'model-unavailable')
  assert.equal(result.result.error.details.model, 'deepseek/deepseek-v4-flash')
  assert.match(result.result.error.message, /session already contains images/i)
  assert.match(result.result.error.message, /deepseek\/deepseek-v4-flash/)
  assert.match(result.result.error.message, /does not accept image input/i)
})

test('withFriendlyImageError() passes through non-image failures unchanged', async () => {
  const original = {
    rpcId: 'rpc-1',
    result: {
      ok: false as const,
      error: { code: 'model-unavailable', message: 'plan limit', details: { provider: 'commandcode', model: 'x' } },
    },
  }
  const wrapped = withFriendlyImageError(sessionsReturning(original) as never, () => 'zh')
  const result = await wrapped.selectModel({ sessionId: 's', provider: 'commandcode', model: 'x' })
  assert.deepEqual(result, original)
})

test('withFriendlyImageError() preserves success results', async () => {
  const original = {
    rpcId: 'rpc-1',
    result: { ok: true as const, value: { selected: { provider: 'commandcode', model: 'claude-sonnet-5' } } },
  }
  const wrapped = withFriendlyImageError(sessionsReturning(original) as never, () => 'zh')
  const result = await wrapped.selectModel({ sessionId: 's', provider: 'commandcode', model: 'claude-sonnet-5' })
  assert.deepEqual(result, original)
})

test('installFriendlyImageError() skips the 0.1.2 connection shape without throwing', () => {
  // dsh 0.1.2 replaces the legacy `connection.api.sessions` façade with a
  // transport/generation handle; selectModel now lives on `remote.session`.
  // The optional copy-rewrite must not keep this plugin fiber pending or fail.
  assert.equal(installFriendlyImageError({} as never, () => 'zh'), false)
  assert.equal(installFriendlyImageError({ api: {} } as never, () => 'zh'), false)
})

test('installFriendlyImageError() still wraps a legacy connection sessions face', async () => {
  const connection = { api: { sessions: sessionsReturning(imageGateError('x')) } }
  assert.equal(installFriendlyImageError(connection as never, () => 'en'), true)
  const result = await connection.api.sessions.selectModel({ sessionId: 's', provider: 'commandcode', model: 'x' })
  assert.equal(result.result.ok, false)
  assert.match(result.result.error.message, /session already contains images/i)
})

// ---------------------------------------------------------------------------
// PLUGIN_VERSION (settings-page footer)
// ---------------------------------------------------------------------------

test('PLUGIN_VERSION mirrors the published package version', () => {
  // The settings-page footer renders this string; it must track package.json
  // (the build inlines the JSON import) and stay semver-shaped — a broken
  // build-time inlining would surface here as undefined or a placeholder.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(PLUGIN_VERSION, pkg.version)
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/)
})
