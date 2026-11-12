/**
 * AccountsCard 首屏读取接线的真实渲染测试（node:test + react-test-renderer）。
 *
 * 为什么需要真的渲染：`refreshUsageAuto()` 存在性测试只能证明注入面提供了入口，
 * 证明不了「账户卡片首屏真的走它」。17b2b5d 修过一次「提交说明说走 auto、实现
 * 却停在显式」的错，且没有任何行为测试能发现回退——把组件改回 `onRefresh()` 时
 * 全量测试仍然全绿。这里用真实 React 树钉住两条线：
 *   1. 首屏 effect 必须调用 `onRefreshAuto()`（可被 5 秒窗口合并）；
 *   2. 刷新按钮必须调用 `onRefresh()`（用户点的，永远重新读取）。
 *
 * 运行环境说明：`section.tsx` 会导入宿主的 UI primitives 与 `*.module.css`，
 * 两者在 node 下都不可直接解析，所以先注册 `_css-module-loader.mjs`（它把 CSS
 * 映射为空模块、把 primitives 换成最小替身），再动态 import 组件——静态 import
 * 会提升到 `register()` 调用之前。
 */

import { register } from 'node:module'

register(new URL('./_css-module-loader.mjs', import.meta.url).href)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { SettingsCommandCodeKey } from '../src/client/locales.ts'
import type { SettingsPageState, StagedField } from '../src/client/settings.ts'
import { USAGE_AUTO_RETRY_LIMIT, USAGE_AUTO_RETRY_MS, type UsagePageState } from '../src/client/usage.ts'
import type { CommandCodeAccountsReport } from '../src/usage-wire.ts'
import type { LoginPageState } from '../src/client/login.ts'
import type { AccountEnrollmentController } from '../src/client/enrollment.ts'

const { AccountsCard, CommandCodeSettingsPage } = await import('../src/client/section.tsx')

// React 18 的 act 环境标记：不设置会为 effect 打印 "not wrapped in act" 警告。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function stagedField(): StagedField {
  return { text: '', clear: false, overridden: false, invalid: false, invalidReason: undefined }
}

/** 完整的 SettingsPageState；本用例只关心读取接线，其余字段取空值。 */
function makeState(overrides: Partial<SettingsPageState> = {}): SettingsPageState {
  return {
    available: true,
    writable: true,
    apiKeyConfigured: false,
    apiKeyKnown: true,
    anyAccountConfigured: false,
    apiKeyWritable: true,
    apiKey: stagedField(),
    apiBase: stagedField(),
    requestTimeoutMs: stagedField(),
    streamIdleTimeoutMs: stagedField(),
    transportMaxRetries: stagedField(),
    offloadSeenImagesForCache: stagedField(),
    filterModelsByPlan: stagedField(),
    webSearch: stagedField(),
    showSidebarQuota: stagedField(),
    zdr: stagedField(),
    sidebarQuota: false,
    activeAccount: '',
    accounts: [],
    accountModels: {},
    accountBusy: false,
    accountFailed: undefined,
    pendingCredentialCleanup: [],
    accountEnrollmentRefs: [],
    visibleModels: [],
    visibleModelsAll: true,
    contextWindow: stagedField(),
    maxOutputTokens: stagedField(),
    contextWindowOverrides: [],
    modelNames: [],
    catalogModels: [],
    catalogFailed: false,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    savedCount: 0,
    saveResult: undefined,
    accountResult: undefined,
    credentialRefreshFailed: false,
    ...overrides,
  }
}

const usageIdle: UsagePageState = { status: 'idle', report: undefined, error: undefined, fetchedAt: undefined }
const loginIdle: LoginPageState = {
  phase: 'idle',
  authUrl: undefined,
  userName: undefined,
  keyName: undefined,
  reason: undefined,
  message: undefined,
}

/** 账户卡会接上的动作面；异步操作一律立即成功。 */
const actions = {
  refreshCredentials: () => {},
  cleanup: async () => true,
  rename: async () => true,
  remove: async () => true,
  setKey: async () => true,
  clearKey: async () => true,
  setActive: async () => true,
  setModels: async () => true,
  beginLogin: () => {},
  cancelLogin: () => {},
}

/** 开通控制器在首屏只被 activate/dispose；给一个不会联网的最小替身。 */
const ENROLLMENT_SNAPSHOT = { active: undefined, pending: [] as const, error: undefined }
const enrollment = {
  store: {
    subscribe: () => () => {},
    // React 要求 getSnapshot 返回稳定引用，否则会反复重渲染。
    getSnapshot: () => ENROLLMENT_SNAPSHOT,
  },
  activate: () => {},
  dispose: () => {},
  refresh: async () => {},
} as unknown as AccountEnrollmentController

type CardProps = ComponentProps<typeof AccountsCard>

function makeProps(calls: string[]): CardProps {
  return {
    t: ((key: string) => key) as unknown as Translate<SettingsCommandCodeKey>,
    state: makeState(),
    usage: usageIdle,
    login: loginIdle,
    disabled: false,
    actions,
    onRefresh: () => { calls.push('explicit') },
    onRefreshAuto: () => { calls.push('auto') },
    createEnrollment: () => enrollment,
    expanded: true,
    onToggle: () => {},
  } as unknown as CardProps
}

/** 递归取出一棵 React children 里的纯文本（图标是元素，不能 JSON 序列化）。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: unknown } }).props.children)
  }
  return ''
}

/** 找到标题为「刷新」的按钮（`t` 在这里返回 key 本身）。 */
function refreshButton(root: ReactTestRenderer) {
  const button = root.root.findAllByType('button').find((node) =>
    textOf(node.props.children).includes('usageRefresh'))
  assert.ok(button, '账户卡必须有刷新按钮')
  return button
}

test('账户卡片首屏只调用自动路径，不调用显式路径', () => {
  const calls: string[] = []
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(AccountsCard, makeProps(calls))) })
  assert.deepEqual(calls, ['auto'], '首屏不是用户点的，必须走可合并的 auto 路径')
  act(() => { root.unmount() })
})

test('账户卡片的刷新按钮走显式路径，不调用自动路径', () => {
  const calls: string[] = []
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(AccountsCard, makeProps(calls))) })
  // 首屏那次是 auto；只看按钮点击，先把记录清空。
  calls.length = 0
  act(() => { refreshButton(root).props.onClick({}) })
  assert.deepEqual(calls, ['explicit'], '用户点刷新必须走显式路径，永远重新读取')
  act(() => { root.unmount() })
})

/** 一份最小的可用报告；`failures` 非空即「读到了但有的端点没读到」。 */
function makeReport(failures: string[] = []): CommandCodeAccountsReport {
  return {
    accounts: [{
      id: 'default',
      label: 'Default',
      configured: true,
      active: true,
      mark: '',
      cooldownUntil: 0,
      report: { failures },
    }],
  }
}

test('错误状态首屏会复检，并按 30 秒节奏继续重试', (t) => {
  // 旧行为是只在 idle 时读一次：一次失败就永久挂在卡片上（用户读作「经常出错」）。
  // 现在 error 也算待复检，节奏由 USAGE_AUTO_RETRY_MS 约束、由 controller 的冷却窗兜底。
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  let root!: ReactTestRenderer
  const props = makeProps(calls)
  props.usage = { status: 'error', report: undefined, error: 'boom', fetchedAt: undefined }
  act(() => { root = create(createElement(AccountsCard, props)) })
  assert.deepEqual(calls, ['auto'], '错误状态首屏就要重新读取，而不是继续显示旧错误')
  act(() => { t.mock.timers.tick(USAGE_AUTO_RETRY_MS) })
  assert.deepEqual(calls, ['auto', 'auto'], '间隔到点再试一次')
  act(() => { root.unmount() })
})

test('部分端点失败的报告同样会进入复检循环', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  let root!: ReactTestRenderer
  const props = makeProps(calls)
  props.usage = { status: 'ready', report: makeReport(['/alpha/usage/summary: HTTP 503']), error: undefined, fetchedAt: 1 }
  act(() => { root = create(createElement(AccountsCard, props)) })
  assert.deepEqual(calls, ['auto'], '不完整的报告值得再要一次')
  act(() => { t.mock.timers.tick(USAGE_AUTO_RETRY_MS) })
  assert.deepEqual(calls, ['auto', 'auto'])
  act(() => { root.unmount() })
})

test('干净的报告不会启动复检循环，也不会额外请求', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  let root!: ReactTestRenderer
  const props = makeProps(calls)
  props.usage = { status: 'ready', report: makeReport(), error: undefined, fetchedAt: 1 }
  act(() => { root = create(createElement(AccountsCard, props)) })
  assert.deepEqual(calls, [], '数据完整时不该再请求')
  act(() => { t.mock.timers.tick(USAGE_AUTO_RETRY_MS * 3) })
  assert.deepEqual(calls, [], '没有待修的事就没有循环')
  act(() => { root.unmount() })
})

test('复检预算耗尽后停下，把决定权交回用户', (t) => {
  // 循环为抖动而设，不为永久性拒绝而设：失效密钥每 30 秒打一轮（每轮四次上游调用）
  // 没有意义。上限在卡片层，侧边栏面板的 2 分钟 tick 不受影响。
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  let root!: ReactTestRenderer
  const props = makeProps(calls)
  props.usage = { status: 'error', report: undefined, error: 'boom', fetchedAt: undefined }
  act(() => { root = create(createElement(AccountsCard, props)) })
  act(() => { t.mock.timers.tick(USAGE_AUTO_RETRY_MS * (USAGE_AUTO_RETRY_LIMIT + 3)) })
  assert.equal(calls.length, USAGE_AUTO_RETRY_LIMIT, '预算耗尽后不再安排自动请求')
  act(() => { root.unmount() })
})

for (const mode of ['writable', 'read-only', 'busy'] as const) {
  test(`组合配置账户的取消固定入口保留并遵守写入状态：${mode}`, t => {
    const selected = 'composition-account'
    const calls: string[] = []
    const props = makeProps([])
    props.state = makeState({ activeAccount: selected, writable: mode !== 'read-only', accountBusy: mode === 'busy' })
    props.disabled = mode === 'read-only'
    props.usage = {
      status: 'ready', error: undefined, fetchedAt: 1,
      report: { accounts: [
        { ...makeReport().accounts[0]!, active: false },
        { id: selected, label: 'Composition account', configured: true, active: true, mark: '', cooldownUntil: 0, report: { failures: [] } },
      ] },
    }
    props.actions = { ...actions, setActive: async (id: string) => { calls.push(id); return true } }
    let root!: ReactTestRenderer
    act(() => { root = create(createElement(AccountsCard, props)) })
    t.after(() => { act(() => { root.unmount() }) })
    const unpin = root.root.findAllByType('button').find(node => textOf(node.props.children) === 'accountActionUnpin')
    assert.ok(unpin, '凭据只读不应隐藏清除 activeAccount 的配置操作')
    assert.equal(unpin.props.disabled, mode !== 'writable')
    if (mode === 'writable') act(() => { unpin.props.onClick() })
    assert.deepEqual(calls, mode === 'writable' ? [''] : [])
  })
}

test('方案 A 设置页直接复用 SettingsValueField、SegmentedControl 与按需底栏，不挂载顶部重复仪表盘', () => {
  let state = makeState()
  const usageReady: UsagePageState = { status: 'ready', report: makeReport(), error: undefined, fetchedAt: 1 }
  const pageProps: ComponentProps<typeof CommandCodeSettingsPage> = {
    t: ((key: string) => key) as unknown as Translate<SettingsCommandCodeKey>,
    useCommandCodeSettings: <T,>(sel: (s: SettingsPageState) => T) => sel(state),
    useCommandCodeUsage: <T,>(sel: (s: UsagePageState) => T) => sel(usageReady),
    useCommandCodeLogin: <T,>(sel: (s: LoginPageState) => T) => sel(loginIdle),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    refreshUsage: () => {},
    refreshUsageAuto: () => {},
    refreshCredentials: () => {},
    beginLogin: () => {},
    cancelLogin: () => {},
    createEnrollment: () => ({ ...enrollment, reset: () => {} } as unknown as AccountEnrollmentController),
    probeService: async () => ({ ok: true as const, value: { outcome: 'ok' as const, status: 401, latencyMs: 120, checkedAt: 1 } }),
    renameAccount: async () => true,
    removeAccount: async () => true,
    retryCredentialCleanup: async () => true,
    setAccountKey: async () => true,
    clearAccountKey: async () => true,
    setActiveAccount: async () => true,
    setAccountModels: async () => true,
    editVisibleModels: () => {},
    clearVisibleModels: () => {},
    editContextWindowOverrides: () => {},
    editModelNames: () => {},
  }

  let root!: ReactTestRenderer
  act(() => { root = create(createElement(CommandCodeSettingsPage, pageProps)) })

  // 全部 6 个暂存数值/文本字段均由宿主的 SettingsValueField 原语承载。
  const fieldIds = root.root
    .findAll((node) => typeof node.props['data-cc-settings-field'] === 'string')
    .map((node) => node.props['data-cc-settings-field'] as string)
  assert.deepEqual(fieldIds, [
    'cc-context-window',
    'cc-max-output-tokens',
    'cc-api-base',
    'cc-request-timeout',
    'cc-stream-idle-timeout',
    'cc-transport-max-retries',
  ])

  // 无未保存改动时不渲染底部保存栏，也没有旧版顶部 StatusStrip。
  assert.equal(root.root.findAll((node) => node.props.className === 'cc-saveFooter').length, 0)
  assert.equal(root.root.findAll((node) => node.props.className === 'cc-statusStrip').length, 0)

  // 点击添加账户按钮后，方式切换由宿主的 SegmentedControl (role="tablist") 承载。
  const addBtn = root.root.find((node) => node.type === 'button' && node.props.className === 'cc-addButton')
  act(() => { addBtn.props.onClick() })
  assert.equal(root.root.findAll((node) => node.props.role === 'tablist').length, 1)

  // 草稿进入 dirty 状态后，底部 SettingsForm 风格保存栏按需挂载。
  state = makeState({ dirty: true })
  act(() => { root.update(createElement(CommandCodeSettingsPage, pageProps)) })
  assert.equal(root.root.findAll((node) => node.props.className === 'cc-saveFooter').length, 1)

  act(() => { root.unmount() })
})
