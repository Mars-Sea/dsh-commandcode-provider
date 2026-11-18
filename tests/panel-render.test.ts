import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { PanelComponentProps } from '../src/client/panel-view.tsx'
import type { SettingsPageState } from '../src/client/settings.ts'
import { panelTextEN } from '../src/client/panel-copy.ts'

register(new URL('./_css-module-loader.mjs', import.meta.url).href)
const { CommandCodePanel } = await import('../src/client/panel-view.tsx')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function props(close: () => void): PanelComponentProps {
  return {
    useCommandCodeUsage: select => select({ status: 'idle', report: undefined, error: undefined, fetchedAt: undefined }),
    useCommandCodeSettings: select => select({ anyAccountConfigured: false } as SettingsPageState),
    useCommandCodePanelMode: select => select('analysis'),
    useCommandCodeAnalytics: select => select({ status: 'ready' }),
    refreshAnalytics: () => {},
    refresh: () => {},
    close,
    startAutoRefresh: () => () => {},
    open: () => {},
  }
}

function closePanel(panel: ReactTestRenderer) {
  const button = panel.root.findAllByType('button').find(node => node.props.className === 'ccp-close')
  assert.ok(button)
  assert.equal(button.props['aria-label'], panelTextEN('close'))
  act(() => { button.props.onClick() })
}

test('用量分析和返回按钮在宿主未提供浮层定位 Hook 时仍能渲染', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  let closed = 0
  let panel!: ReactTestRenderer
  await act(async () => { panel = create(createElement(CommandCodePanel, props(() => { closed++ }))) })
  assert.ok(panel.root.findByProps({ className: 'ccp-analysis' }))
  assert.equal(panel.root.findAllByType('button').some(node => node.props.className?.startsWith('ccp-statusPill')), true)
  closePanel(panel)
  assert.equal(closed, 1)
  act(() => { panel.unmount() })
})

test('用量面板渲染失败时仍显示提示并可返回会话', t => {
  t.mock.method(console, 'error', () => {})
  let closed = 0
  let panel!: ReactTestRenderer
  const failing = { ...props(() => { closed++ }), useCommandCodeAnalytics: () => { throw new Error('synthetic render failure') } }
  act(() => { panel = create(createElement(CommandCodePanel, failing)) })
  assert.deepEqual(panel.root.findByProps({ role: 'alert' }).children, [panelTextEN('panelRenderFailed')])
  closePanel(panel)
  assert.equal(closed, 1)
  act(() => { panel.unmount() })
})
