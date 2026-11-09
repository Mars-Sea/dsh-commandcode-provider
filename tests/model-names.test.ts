/**
 * 自定义模型名称（issue #121）的共享纯规则：清洗与有效显示名解析。
 * 与 tests/context-window.test.ts 同形，node:test + 零依赖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { effectiveModelName, readModelNames } from '../src/model-names.ts'

test('readModelNames keeps non-blank string entries and trims the value', () => {
  assert.deepEqual(
    readModelNames({ 'deepseek/deepseek-v4.1-flash': '  DeepSeek V4.1 Flash  ', 'xai/grok-4.7': 'Grok' }),
    { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'xai/grok-4.7': 'Grok' },
  )
})

test('readModelNames drops bad entries and reads an empty map as unset', () => {
  assert.equal(readModelNames(undefined), undefined)
  assert.equal(readModelNames(null), undefined)
  assert.equal(readModelNames([]), undefined)
  assert.equal(readModelNames('names'), undefined)
  assert.equal(readModelNames({}), undefined)
  assert.equal(readModelNames({ '': 'blank id', whitespace: '   ', number: 42, nested: { a: 1 } }), undefined)
  assert.deepEqual(readModelNames({ '': 'blank id', good: 'Name', bad: 42 }), { good: 'Name' })
  // Returns a fresh object; the caller's config is never mutated.
  const source = { m: ' Name ' }
  assert.notStrictEqual(readModelNames(source), source)
  assert.deepEqual(source, { m: ' Name ' })
})

test('effectiveModelName defaults to the catalog name plus (CC)', () => {
  assert.equal(effectiveModelName('DeepSeek V4.1 Flash (latest)', 'deepseek/deepseek-v4.1-flash', undefined), 'DeepSeek V4.1 Flash (latest) (CC)')
  assert.equal(effectiveModelName('Claude Sonnet 5.5', 'claude-sonnet-5-5', {}), 'Claude Sonnet 5.5 (CC)')
})

test('effectiveModelName lets a custom name win, including one without suffixes', () => {
  const options = { modelNames: { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' } }
  assert.equal(effectiveModelName('DeepSeek V4.1 Flash (latest)', 'deepseek/deepseek-v4.1-flash', options), 'DeepSeek V4.1 Flash')
  // A model without an entry keeps the default.
  assert.equal(effectiveModelName('Claude Sonnet 5.5', 'claude-sonnet-5-5', options), 'Claude Sonnet 5.5 (CC)')
})

test('effectiveModelName falls back to the bare id for an unknown catalog model', () => {
  assert.equal(effectiveModelName(undefined, 'custom/model', undefined), 'custom/model')
  assert.equal(effectiveModelName(undefined, 'custom/model', { modelNames: { 'custom/model': 'My model' } }), 'My model')
})

test('effectiveModelName re-judges programmatic values that bypass the cleaner', () => {
  const options = { modelNames: { m: '   ' as unknown as string, n: 42 as unknown as string, p: '  Named  ' } }
  assert.equal(effectiveModelName('Catalog', 'm', options), 'Catalog (CC)')
  assert.equal(effectiveModelName('Catalog', 'n', options), 'Catalog (CC)')
  assert.equal(effectiveModelName('Catalog', 'p', options), 'Named')
})
