/**
 * Settings-page fold tests (node:test, zero deps). Run with `npm test`.
 *
 * Issue #94 put the Models & context group behind its own heading, collapsed by
 * default, like the Advanced card. Folding is only safe while a blocked save
 * stays explained: the group's rows are off screen once it folds, so the
 * heading has to carry the warning itself. These cases pin the judgement behind
 * that warning — both staged numbers the group owns and its per-model context
 * rows — for the Models group and for Advanced, whose rows have the same
 * problem and whose behaviour the reporter asked to match.
 *
 * The React tree is not rendered here (`react-dom` is not a dependency): the
 * decision is a pure function over the page state, so it is tested directly,
 * like the other React-free controller tests in this directory.
 */

import { register } from 'node:module'

// `section.tsx` renders UI primitives whose npm entry cannot be resolved by
// node alone; the loader hook stands them in. Registered before the dynamic
// import below, since static imports would hoist above this call.
register(new URL('./_css-module-loader.mjs', import.meta.url).href)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SettingsPageState, StagedField } from '../src/client/settings.ts'
import type { CommandCodeUsageReport } from '../src/adapter.ts'
import { zh } from '../src/client/locales.ts'

const {
  accountIssues,
  addAccountPanelView,
  advancedOverriddenCount,
  balanceLabelText,
  contextGroupInvalid,
  contextOverriddenCount,
  invalidGroups,
  modelsOverriddenCount,
  stagedSwitch,
} = await import('../src/client/section.tsx')

/** One staged field draft; only `invalid` matters to the group judgements. */
function staged(invalid: boolean): StagedField {
  return {
    text: '',
    clear: false,
    overridden: false,
    invalid,
    invalidReason: invalid ? 'format' : undefined,
  }
}

/** 模型显示配置: the plan switch plus the custom display-name rows. */
function displayState(over: {
  filterModelsByPlan?: boolean
  names?: number
}): Pick<SettingsPageState, 'filterModelsByPlan' | 'modelNames'> {
  return {
    filterModelsByPlan: staged(over.filterModelsByPlan ?? false),
    modelNames: Array.from({ length: over.names ?? 0 }, (_, index) => ({
      model: `vendor/model-${index}`,
      text: `Name ${index}`,
    })),
  }
}

/** 上下文配置: the two numeric drafts plus the dedicated per-model rows. */
function contextState(over: {
  contextWindow?: boolean
  maxOutputTokens?: boolean
  rows?: readonly boolean[]
}): Pick<SettingsPageState, 'contextWindow' | 'maxOutputTokens' | 'contextWindowOverrides'> {
  return {
    contextWindow: staged(over.contextWindow ?? false),
    maxOutputTokens: staged(over.maxOutputTokens ?? false),
    contextWindowOverrides: (over.rows ?? []).map((invalid, index) => ({
      model: `vendor/model-${index}`,
      text: '256K',
      invalid,
      invalidReason: invalid ? 'tooSmall' as const : undefined,
    })),
  }
}

/** A fully valid Advanced card; each case flips exactly one draft. */
const VALID_ADVANCED = {
  zdr: staged(false),
  webSearch: staged(false),
  showSidebarQuota: staged(false),
  offloadSeenImagesForCache: staged(false),
}

test('contextGroupInvalid: nothing staged → no heading warning', () => {
  assert.equal(contextGroupInvalid(contextState({ rows: [false, false] })), false)
})

test('contextGroupInvalid: a bad custom context length warns', () => {
  assert.equal(contextGroupInvalid(contextState({ contextWindow: true })), true)
})

test('contextGroupInvalid: a bad output limit warns', () => {
  assert.equal(contextGroupInvalid(contextState({ maxOutputTokens: true })), true)
})

test('contextGroupInvalid: one bad dedicated context row warns', () => {
  // The rows are the group's third owner and the easiest one to forget: their
  // drafts are validated per row, not through a StagedField on the page state.
  assert.equal(contextGroupInvalid(contextState({ rows: [false, true, false] })), true)
})

// ---- Heading summaries and the save bar's locate target (决策记录第十章第4条) ----

/** A staged draft with only the fields the summaries read. */
function draft(over: Partial<StagedField>): StagedField {
  return { ...staged(false), ...over }
}

test('invalidGroups: nothing invalid → nothing to open', () => {
  assert.deepEqual(
    invalidGroups({ ...displayState({}), ...contextState({}), ...VALID_ADVANCED }),
    [],
  )
})

test('invalidGroups: only the context group can hold a bad numeric draft', () => {
  const state = {
    ...displayState({ filterModelsByPlan: true }),
    ...contextState({ rows: [true] }),
    ...VALID_ADVANCED,
    zdr: staged(true),
  }
  assert.deepEqual(invalidGroups(state), ['context'])
})

test('modelsOverriddenCount: customized display fields plus one per name row', () => {
  const state = { ...displayState({ names: 2 }), filterModelsByPlan: draft({ overridden: true }) }
  assert.equal(modelsOverriddenCount(state), 3)
})

test('contextOverriddenCount: customized numeric fields plus one per dedicated row', () => {
  const state = {
    ...contextState({ rows: [false, false] }),
    contextWindow: draft({ overridden: true }),
    maxOutputTokens: draft({ overridden: true }),
  }
  assert.equal(contextOverriddenCount(state), 4)
})

test('advancedOverriddenCount: counts only the customized drafts', () => {
  assert.equal(advancedOverriddenCount(VALID_ADVANCED), 0)
  assert.equal(advancedOverriddenCount({ ...VALID_ADVANCED, zdr: draft({ overridden: true }) }), 1)
})

test('stagedSwitch: an unset draft reads as the default, otherwise the staged text', () => {
  assert.equal(stagedSwitch(draft({ text: '' }), true), true)
  assert.equal(stagedSwitch(draft({ text: '' }), false), false)
  assert.equal(stagedSwitch(draft({ text: 'true' }), false), true)
  assert.equal(stagedSwitch(draft({ text: 'false' }), true), false)
})

test('accountIssues: matches the row dots — a rejected key is severe, a cooldown or mark is a warning', () => {
  assert.deepEqual(accountIssues([undefined, { mark: '', cooldownUntil: 0 }]), { count: 0, severe: false })
  assert.deepEqual(accountIssues([{ mark: '', cooldownUntil: 1 }, { mark: 'rate-limit', cooldownUntil: 0 }]), { count: 2, severe: false })
  assert.deepEqual(accountIssues([{ mark: 'invalid-credential', cooldownUntil: 0 }, { mark: '', cooldownUntil: 0 }]), { count: 1, severe: true })
})


// ---- Add-account panel action row ----

test('addAccountPanelView: idle sign-in offers cancel + start, ready at once', () => {
  assert.deepEqual(
    addAccountPanelView({ phase: undefined, mode: 'browser', keyReady: false, disabled: false }),
    { actions: 'start', locked: false, canSubmit: true },
  )
})

test('addAccountPanelView: idle paste mode needs a key before Add', () => {
  assert.equal(addAccountPanelView({ phase: undefined, mode: 'paste', keyReady: false, disabled: false }).canSubmit, false)
  assert.equal(addAccountPanelView({ phase: undefined, mode: 'paste', keyReady: true, disabled: false }).canSubmit, true)
})

test('addAccountPanelView: a read-only page locks the panel and never submits', () => {
  assert.deepEqual(
    addAccountPanelView({ phase: undefined, mode: 'browser', keyReady: false, disabled: true }),
    { actions: 'start', locked: true, canSubmit: false },
  )
})

test('addAccountPanelView: an enrollment in flight only offers cancel setup', () => {
  for (const phase of ['creating', 'waiting', 'writing', 'cancelling']) {
    assert.deepEqual(
      addAccountPanelView({ phase, mode: 'paste', keyReady: true, disabled: false }),
      { actions: 'cancelSetup', locked: true, canSubmit: false },
      phase,
    )
  }
})

test('addAccountPanelView: a failed name save switches to the naming actions', () => {
  assert.deepEqual(
    addAccountPanelView({ phase: 'naming', mode: 'browser', keyReady: false, disabled: false }),
    { actions: 'naming', locked: true, canSubmit: false },
  )
})

test('addAccountPanelView: a settled enrollment returns the panel to idle', () => {
  // finished closes the panel; failed / cancelled / cleanup-needed leave it
  // open for another attempt, with the error or recovery shown elsewhere.
  for (const phase of ['finished', 'failed', 'cancelled', 'cleanup-needed']) {
    assert.equal(addAccountPanelView({ phase, mode: 'browser', keyReady: false, disabled: false }).actions, 'start', phase)
  }
})

// 账户卡片余额标签行：账期只在「月额度剩余」旁出现一次，取代原独立的
// 「官方账期用量」行与底部重复的「账期截止」。
test('balance label carries the billing period once, falling back to the plan end', () => {
  const t = ((key: keyof typeof zh) => zh[key]) as Parameters<typeof balanceLabelText>[1]
  const start = Date.UTC(2026, 9, 15)
  const end = Date.UTC(2026, 10, 15)
  const range = `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}`
  const endDate = new Date(end).toLocaleDateString()
  const credits = { monthlyCredits: 46.92, purchasedCredits: 0, freeCredits: 0 } as NonNullable<CommandCodeUsageReport['credits']>
  const plan = { planId: 'p', name: 'GOAT', status: 'active', monthlyCredits: 70, currentPeriodStart: start, currentPeriodEnd: end } as NonNullable<CommandCodeUsageReport['plan']>
  const usage = { periodStart: start } as NonNullable<CommandCodeUsageReport['usage']>

  // 起点对齐：完整区间。
  assert.equal(balanceLabelText({ credits, plan, usage }, t), `月额度剩余 · ${range}`)
  // 起点对不上或用量汇总缺失：退回订阅截止日，不再显示「统计周期未确认」。
  assert.equal(balanceLabelText({ credits, plan, usage: { periodStart: start + 1 } as NonNullable<CommandCodeUsageReport['usage']> }, t), `月额度剩余 · 账期截止 ${endDate}`)
  assert.equal(balanceLabelText({ credits, plan }, t), `月额度剩余 · 账期截止 ${endDate}`)
  // 没有订阅：只剩标签本身。
  assert.equal(balanceLabelText({ credits, usage }, t), '月额度剩余')
  // 余额没取到：区间前补「官方账期用量」，截止日照旧，都没有则为空（整行不画）。
  assert.equal(balanceLabelText({ plan, usage }, t), `官方账期用量 ${range}`)
  assert.equal(balanceLabelText({ plan }, t), `账期截止 ${endDate}`)
  assert.equal(balanceLabelText({}, t), '')
})

test('requested Chinese labels stay pinned to the settings redesign', () => {
  assert.equal(zh.openAnalytics, '用量分析')
  assert.equal(zh.accountAdd, '添加账户')
  assert.equal(zh.accountModels, '模型绑定')
  assert.equal(zh.accountModelsHint, '当使用所选模型时自动切换到当前账户')
  assert.equal(zh.modelsTitle, '模型显示配置')
  assert.equal(zh.contextTitle, '上下文配置')
  assert.equal(zh.visibleModelsTitle, '自定义显示范围')
  assert.equal(zh.modelNamesTitle, '自定义显示名称')
  assert.equal(zh.contextOverridesTitle, '专属上下文长度')
  assert.equal(zh.contextOverrideAdd, '添加')
  assert.equal(zh.modelNamesAdd, '添加')
  assert.equal(zh.advancedSettings, '高级设置')
  assert.equal('integrationsTitle' in zh, false, '集成与显示 group is gone, not just hidden')
})
