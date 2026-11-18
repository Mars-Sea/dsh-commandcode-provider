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
// The rendered page receives a `t` that echoes keys, so copy is asserted against
// the locale tables themselves.
const { zh: zhCopy, en: enCopy } = await import('../src/client/locales.ts') as {
  zh: Record<string, string>
  en: Record<string, string>
}
import { PAGE_CSS } from '../src/client/page-styles.ts'
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
    webFetch: stagedField(),
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

test('账户头部右侧固定为「快速操作 → 折叠箭头 → ⋯」，箭头仍然能折叠', () => {
  // 2026-11-15 用户反馈：带「恢复自动切换」的卡片把箭头挤到左边，两张卡的头
  // 对不齐（第一张是 箭头⋯，第二张是 箭头恢复自动切换⋯）。现在箭头永远紧挨
  // ⋯，快速操作排在它左边；箭头仍是折叠入口，语义由名称按钮承担，箭头本身
  // 对屏幕阅读器隐藏、不进 Tab 序。
  const selected = 'work'
  const props = makeProps([])
  props.state = makeState({
    activeAccount: selected,
    accounts: [{ id: selected, ref: `credential:${selected}`, label: '工作', configured: true, credentialKnown: true, writable: true }],
  })
  props.usage = {
    status: 'ready', error: undefined, fetchedAt: 1,
    report: { accounts: [
      { ...makeReport().accounts[0]!, active: false },
      { id: selected, label: '工作', configured: true, active: true, mark: '', cooldownUntil: 0, report: { failures: [] } },
    ] },
  }
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(AccountsCard, props)) })
  const details = (id: string) => root.root.findAll((node) => node.props.id === `cc-account-${id}-details`)

  const heads = root.root.findAll((node) => node.props.className === 'cc-accountHead')
  assert.equal(heads.length, 2)
  const order = (head: (typeof heads)[number]): string[] => head.findAllByType('button').map((button) => {
    if (button.props.className === 'cc-accountToggle') return 'toggle'
    if (button.props['aria-haspopup'] === 'menu') return 'menu'
    if (button.props['aria-hidden'] === 'true') return 'chevron'
    return textOf(button.props.children)
  })

  // 第二张卡被固定：快速操作在箭头左边，箭头永远紧挨 ⋯。
  assert.deepEqual(order(heads[1]!), ['toggle', 'accountActionUnpin', 'chevron', 'menu'])
  // 没有快速操作的卡片顺序不变。
  assert.deepEqual(order(heads[0]!), ['toggle', 'chevron', 'menu'])

  const chevron = heads[1]!.findAllByType('button').find((button) => button.props['aria-hidden'] === 'true')
  assert.ok(chevron, '折叠箭头必须留在头部')
  assert.equal(chevron.props.tabIndex, -1, '重复的折叠入口不进 Tab 序')
  assert.equal(details(selected).length, 0, '默认折叠')
  act(() => { chevron.props.onClick({}) })
  assert.equal(details(selected).length, 1, '点箭头必须真的展开详情')
  const rotated = root.root.findAll((node) => typeof node.type === 'string' && node.props.className === 'cc-chevronOpen')
  assert.equal(rotated.length, 1, '展开后箭头要转过来，折叠态才和展开态分得开')

  act(() => { root.unmount() })
})

/** 设置页夹具：状态由调用方持有，`update()` 前后要读到最新的一份。 */
function makePageProps(current: () => SettingsPageState): ComponentProps<typeof CommandCodeSettingsPage> {
  const usageReady: UsagePageState = { status: 'ready', report: makeReport(), error: undefined, fetchedAt: 1 }
  return {
    t: ((key: string) => key) as unknown as Translate<SettingsCommandCodeKey>,
    useCommandCodeSettings: <T,>(sel: (s: SettingsPageState) => T) => sel(current()),
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
}

test('方案 A 设置页直接复用 SettingsValueField、SegmentedControl 与按需底栏，不挂载顶部重复仪表盘', () => {
  let state = makeState()
  const pageProps = makePageProps(() => state)
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(CommandCodeSettingsPage, pageProps)) })

  // 集成／高级两组的暂存文本字段仍由宿主的 SettingsValueField 原语承载。
  const fieldIds = root.root
    .findAll((node) => typeof node.props['data-cc-settings-field'] === 'string')
    .map((node) => node.props['data-cc-settings-field'] as string)
  // 两个模型默认值（上下文长度、输出上限）改走行式 `SettingsRowField`，
  // 宿主原语只剩集成与高级两组里的四个文本字段。
  assert.deepEqual(fieldIds, [
    'cc-api-base',
    'cc-request-timeout',
    'cc-stream-idle-timeout',
    'cc-transport-max-retries',
  ])

  // 账户分组体铺满整栏（2026-11-15 用户反馈）：只放宽账户这一组，
  // 其余分组继续缩进在分组标题的 22px 栏内。
  const bodies = root.root
    .findAll((node) => typeof node.props.id === 'string' && /^cc-group-.+-body$/.test(node.props.id))
    .map((node) => ({ id: node.props.id as string, className: String(node.props.className) }))
  assert.ok(bodies.length >= 4, '四个分组各自渲染一个分组体')
  assert.deepEqual(
    bodies.filter((body) => body.className.includes('cc-accountGroupBody')).map((body) => body.id),
    ['cc-group-accounts-body'],
    '只有账户分组体去掉缩进，模型、集成、高级三组保持原样',
  )

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

/**
 * 「网页获取」开关（2026-11-16 用户要求）：与「联网搜索」并排、文案结构一致。
 *
 * 这条用例钉住的是「设置页真的渲染了这个开关」——`settings.ts` 的
 * `SECTION_FIELDS` 是白名单，漏加字段不会报错，只会让开关静默消失。
 */
test('集成分组渲染「网页获取」开关，与「联网搜索」并排且默认开启', () => {
  let state = makeState()
  const pageProps = makePageProps(() => state)
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(CommandCodeSettingsPage, pageProps)) })

  const ids = [...new Set(root.root
    .findAll((node) => typeof node.props.id === 'string' && /^cc-(web-search|web-fetch)$/.test(node.props.id))
    .map((node) => node.props.id as string))]
  assert.deepEqual(ids, ['cc-web-search', 'cc-web-fetch'], '两个开关并排出现，搜索在前')

  // 未暂存时按默认值（开启）渲染：分组角标给出「开启」文案而不是空。
  const text = JSON.stringify(root.toJSON())
  assert.match(text, /webSearchSummaryOn/)
  assert.match(text, /webFetchSummaryOn/)

  // 提示文案（2026-11-16 用户拍板）：保留「无法访问内网和本机地址」这条能力边界，
  // 但不提费用 —— 内置提供方的描述同样不谈钱。这里渲染用 key 代替文案，所以断言
  // 落在 locale 表本身。
  const zhHint = zhCopy['webFetchHint'] ?? ''
  const enHint = enCopy['webFetchHint'] ?? ''
  assert.match(zhHint, /无法访问内网和本机地址/, '中文提示保留内网说明')
  assert.match(enHint, /Cannot reach intranet or local addresses/, '英文提示保留内网说明')
  assert.doesNotMatch(`${zhHint} ${enHint}`, /费用|收费|计费|charge|cost|bill/i, '提示里不出现费用字样')

  // 草稿置为关闭：角标随之翻成关闭文案。
  state = makeState({ webFetch: { ...stagedField(), text: 'false', overridden: true } })
  act(() => { root.update(createElement(CommandCodeSettingsPage, pageProps)) })
  const flipped = JSON.stringify(root.toJSON())
  assert.match(flipped, /webFetchSummaryOff/)

  act(() => { root.unmount() })
})

/**
 * 账户分组的排版两条铁律（2026-11-15 用户反馈）：
 *   1. 账户卡片和「添加账户／用量分析」那一行跟上方的分组行同宽（去掉分组体的
 *      22px 缩进），但下面三个分组不动；
 *   2. 「添加账户」不再是紧贴最后一张卡片的一行，间距与卡片之间一致（8px）。
 *
 * 这两条只有「组件挂上 cc-accountGroupBody」+「样式表里的规则排在默认缩进之后」
 * 同时成立才生效：任何一半丢掉都不会报错，只会静默回到旧版排版。
 */
test('账户分组体铺满整栏，并与上方卡片保持同一 8px 间距', () => {
  const rule = /\.cc-accountGroupBody\{([^}]*)\}/.exec(PAGE_CSS)
  assert.ok(rule, '样式表必须提供铺满整栏的账户分组体规则')
  assert.match(rule[1]!, /(?:^|;)padding-left:0(?:;|$)/, '铺满整栏靠去掉分组体默认的 22px 缩进')
  assert.match(rule[1]!, /(?:^|;)gap:8px(?:;|$)/, '卡片与下方操作行之间留出和卡片间距一致的 8px')
  assert.ok(
    PAGE_CSS.indexOf('.cc-accountGroupBody{') > PAGE_CSS.indexOf('.cc-groupBody{'),
    '同特异性下后者胜出：这条规则必须排在 .cc-groupBody 之后，否则 22px 缩进会盖回来',
  )
})

/**
 * 模型与上下文分组的排版（2026-11-15 画板 ModelsSection.dc.html 落地）：
 *   1. 三块：可见性行 → 默认预算字段 → 两张每模型表，块间靠 `.cc-block` 的 24px；
 *   2. 每张表一行表头：标题 + 条目数 + 右端「添加模型」；空列表下面是说明，不是只剩标题；
 *   3. 行内的「重置」落在控制列（紧挨被重置的开关），标签行不再挂「已自定义」胶囊。
 */
test('模型分组的排版：三块结构、表头带条目数与添加、行内重置落在控制列', () => {
  const overridden = { text: 'false', clear: false, overridden: true, invalid: false, invalidReason: undefined }
  const state = makeState({ filterModelsByPlan: overridden })
  let root!: ReactTestRenderer
  act(() => { root = create(createElement(CommandCodeSettingsPage, makePageProps(() => state))) })

  const blocks = root.root
    .findAll((node) => typeof node.props.className === 'string' && node.props.className.startsWith('cc-block'))
    .map((node) => node.props.className as string)
  assert.deepEqual(blocks, ['cc-block cc-blockRows', 'cc-block cc-list', 'cc-block cc-list'], '三块按渲染顺序出现')

  // 默认预算的两个字段是真正的行：标签和输入框在同一行、输入框走行式宽度。
  const rowInputs = root.root.findAll((node) => node.type === 'input' && String(node.props.className).includes('cc-fieldRowInput'))
  assert.deepEqual(rowInputs.map((node) => node.props.id), ['cc-context-window', 'cc-max-output-tokens'])
  for (const input of rowInputs) {
    const row = root.root.findAll((node) => node.props.className === 'cc-row').find((candidate) =>
      candidate.findAll((child) => child.props.id === input.props.id).length > 0)
    assert.ok(row, `${String(input.props.id)} 必须在行里，而不是标签在上、输入在下`)
    assert.equal(row.findAll((child) => child.type === 'label' && child.props.htmlFor === input.props.id).length, 1)
  }

  const heads = root.root.findAll((node) => node.props.className === 'cc-listHead')
  assert.equal(heads.length, 2, '两张每模型表各有一个表头行')
  assert.match(textOf(heads[0]!.props.children), /contextOverridesTitle.*listCountMany.*contextOverrideAdd/)
  assert.match(textOf(heads[1]!.props.children), /modelNamesTitle.*listCountMany.*modelNamesAdd/)
  const hints = root.root.findAll((node) => node.props.className === 'cc-listHint').map((node) => textOf(node.props.children))
  assert.deepEqual(hints, ['contextOverrideEmpty', 'modelNamesEmpty'], '空列表要说清「空＝跟随默认」')

  const controlRows = root.root.findAll((node) => node.props.className === 'cc-rowControl')
  const filterRow = controlRows.find((row) =>
    row.findAll((node) => node.type === 'button' && node.props.className === 'cc-resetLink').length === 1)
  assert.ok(filterRow, '重置必须落在控制列里，和开关同一格')
  assert.equal(
    root.root.findAll((node) => node.props['data-tone'] === 'neutral' && textOf(node.props.children) === 'overridden').length,
    0,
    '标签行不再挂「已自定义」胶囊：状态由重置按钮本身表达',
  )

  act(() => { root.unmount() })
})
