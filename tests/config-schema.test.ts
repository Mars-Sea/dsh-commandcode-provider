/**
 * Config-schema credential contract (node:test, zero deps). Run with `npm test`.
 *
 * The settings page writes the API key through the credentials seam, but a
 * composition config (`cordis.patch.yml`) or a hand-edited `settings.yaml` may
 * set a literal `apiKey` — a settings value, so the schema must mark it
 * `role('secret')`, which the harness strips from every descriptor it serves
 * (`settings.describe()` runs with `redactSecrets: true`).
 *
 * A schema without the role parses and resolves exactly the same way, so this
 * pins the DECLARATION, not the parse result.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactSecrets } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

import { Config, resolveAdapterOptions } from '../src/index.ts'
import { unwrapVolatileConfig } from '../src/config-volatile.ts'

test('literal API keys are declared secret and stripped from a settings descriptor', () => {
  const value = {
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    apiKey: 'sk-literal-SECRET-123',
    accounts: [{ label: 'second', apiKeyEnv: 'COMMANDCODE_API_KEY_2', apiKey: 'sk-second-SECRET-456' }],
  }
  // `redactSecrets` declares its schema parameter as `z<never>` because it only
  // walks the declared `role('secret')` positions; the plugin's own schema is
  // `z<Config>`, so the call states that widening explicitly at this boundary
  // rather than loosening the assertion the test exists to make.
  const redacted = redactSecrets(Config as z<never>, value) as {
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
  // Reported per path, so the page can show "set" without the value. Array
  // segments are stringified — the harness spells them as keys.
  assert.deepEqual(
    redacted.secrets.map((secret) => secret.path.map(String)),
    [['apiKey'], ['accounts', '0', 'apiKey']],
  )
})

test('a literal API key still configures the route from a composition config', () => {
  // Redaction is descriptor-facing only: the resolved runtime config keeps the
  // literal, which is how the composition path serves requests. The parse turns
  // every MARKED field into a live reference, so the route resolves through the
  // same unwrap `apply()` performs per read.
  const parsed = Config({ apiKey: 'sk-literal-123' })
  const config = unwrapVolatileConfig(parsed)
  assert.equal(config.apiKey, 'sk-literal-123')
  assert.equal(resolveAdapterOptions(config).apiKeyEnv, 'COMMANDCODE_API_KEY')
  // A write lands on the next read without re-parsing.
  assert.equal(unwrapVolatileConfig(parsed).apiKeyEnv, 'COMMANDCODE_API_KEY')
})

test('cache-aware image offload is explicitly opt-in and resolves per config read', () => {
  assert.equal(resolveAdapterOptions(unwrapVolatileConfig(Config({}))).offloadSeenImagesForCache, false)
  assert.equal(resolveAdapterOptions(unwrapVolatileConfig(Config({ offloadSeenImagesForCache: true }))).offloadSeenImagesForCache, true)
})

test('上下文配置只接受边界内整数，程序化调用另行清洗非法值', () => {
  for (const value of [1, 32_768, 10_000_000]) {
    const config = unwrapVolatileConfig(Config({ contextWindow: value, contextWindowOverrides: { model: value } }))
    assert.equal(config.contextWindow, value)
    assert.deepEqual(config.contextWindowOverrides, { model: value })
  }
  for (const value of [0, 10_000_001, 32_768.5]) {
    assert.throws(() => Config({ contextWindow: value }))
    assert.throws(() => Config({ contextWindowOverrides: { model: value } }))
  }
  const resolved = resolveAdapterOptions({ contextWindow: 32_768.5, contextWindowOverrides: { invalid: 64_000.5, valid: 32_768 } })
  assert.equal(resolved.contextWindow, undefined)
  assert.deepEqual(resolved.contextWindowOverrides, { valid: 32_768 })
})

test('输出预算接受 0（省略哨兵）到网关上限，越界与非整数被拒绝', () => {
  // 0 is the sentinel the issue #74 report asked for, not a small budget, so
  // it must survive the schema rather than be treated like a missing value.
  for (const value of [0, 1, 64_000, 131_072]) {
    assert.equal(unwrapVolatileConfig(Config({ maxOutputTokens: value })).maxOutputTokens, value)
  }
  for (const value of [-1, 131_073, 64_000.5]) {
    assert.throws(() => Config({ maxOutputTokens: value }))
  }
})

test('程序化构造越过配置校验时，非法输出预算回落到「未设置」', () => {
  // A connection built by hand never passes through Schemastery, so the resolve
  // step re-judges: a budget the gateway would refuse becomes "unset" (the
  // derived default), not a request that fails upstream.
  for (const value of [-1, 131_073, 64_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveAdapterOptions({ maxOutputTokens: value }).maxOutputTokens, undefined)
  }
  assert.equal(resolveAdapterOptions({ maxOutputTokens: 0 }).maxOutputTokens, 0)
  assert.equal(resolveAdapterOptions({ maxOutputTokens: 64_000 }).maxOutputTokens, 64_000)
  assert.equal(resolveAdapterOptions({}).maxOutputTokens, undefined)
})

test('自定义模型名称走 volatile 配置，程序化构造另行清洗（issue #121）', () => {
  const config = unwrapVolatileConfig(Config({ modelNames: { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' } }))
  assert.deepEqual(config.modelNames, { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' })
  // 默认空表：解析结果里根本没有这个字段，显示名沿用目录名 + (CC)。
  assert.equal(resolveAdapterOptions(unwrapVolatileConfig(Config({}))).modelNames, undefined)
  const dirty = {
    modelNames: { good: '  Name  ', blank: '   ', number: 42, '': 'blank id' },
  } as unknown as Config
  assert.deepEqual(resolveAdapterOptions(dirty).modelNames, { good: 'Name' })
})
