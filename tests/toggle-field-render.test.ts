/**
 * ToggleField 渲染测试（node:test + react-test-renderer），钉住 issue #108 的改法：
 * 布尔设置行用宿主的 `Switch` 原语，而不是 `appearance:none` 的 checkbox 再画伪元素。
 *
 * 锁定三件事：控件是 `role="switch"` 的按钮且页面里不再有 checkbox；勾选态取自暂存
 * 文本（空串回落到 `defaultChecked`）；点击暂存 `'true'`／`'false'` 字符串。
 * 运行环境同 `accounts-card-render.test.ts`：先注册 `_css-module-loader.mjs`（primitives
 * 换成 `_primitives-stub.mjs`），再动态 import 组件。
 */

import { register } from 'node:module'

register(new URL('./_css-module-loader.mjs', import.meta.url).href)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { SettingsCommandCodeKey } from '../src/client/locales.ts'
import type { StagedField } from '../src/client/settings.ts'

const { ToggleField } = await import('../src/client/section.tsx')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t = ((key: string) => key) as unknown as Translate<SettingsCommandCodeKey>

function staged(text: string): StagedField {
  return { text, clear: false, overridden: text !== '', invalid: false, invalidReason: undefined }
}

function renderField(text: string, defaultChecked: boolean, edits: string[], disabled = false): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(createElement(ToggleField, {
      id: 'cc-zdr',
      label: '零数据保留',
      hint: '说明',
      state: staged(text),
      disabled,
      defaultChecked,
      onEdit: (next: string) => { edits.push(next) },
      onReset: () => {},
      t,
    }))
  })
  assert.ok(renderer)
  return renderer
}

test('ToggleField renders the platform switch, not a checkbox', () => {
  const renderer = renderField('', false, [])
  const switches = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'switch')
  assert.equal(switches.length, 1)
  assert.equal(switches[0]?.props['aria-label'], '零数据保留', 'the row label is the switch\'s accessible name')
  assert.equal(switches[0]?.props.className, 'cc-switch')
  assert.equal(renderer.root.findAll((node) => node.type === 'input').length, 0)
})

test('ToggleField: an unset draft shows the default, a staged one shows its own value', () => {
  const read = (text: string, fallback: boolean): unknown =>
    renderField(text, fallback, []).root.find((node) => node.props.role === 'switch').props['aria-checked']
  assert.equal(read('', true), true)
  assert.equal(read('', false), false)
  assert.equal(read('false', true), false)
  assert.equal(read('true', false), true)
})

test('ToggleField stages the flipped boolean as text, and a locked switch stays disabled', () => {
  const edits: string[] = []
  const on = renderField('', true, edits)
  act(() => { on.root.find((node) => node.props.role === 'switch').props.onClick() })
  const off = renderField('false', true, edits)
  act(() => { off.root.find((node) => node.props.role === 'switch').props.onClick() })
  assert.deepEqual(edits, ['false', 'true'])
  const locked = renderField('', true, [], true)
  assert.equal(locked.root.find((node) => node.props.role === 'switch').props.disabled, true)
})
