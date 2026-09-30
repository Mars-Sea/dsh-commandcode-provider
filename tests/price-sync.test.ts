import { test } from 'node:test'
import assert from 'node:assert/strict'

// 直接调用脚本实际使用的候选生成入口，导入不会联网或改写项目文件。
const scriptUrl = new URL('../scripts/sync-model-prices.mjs', import.meta.url).href
const { buildPriceSnapshot } = await import(scriptUrl)
const source = 'const MODEL_PRICE_ROWS: readonly ModelPriceRow[] = [\n  { id: "old", rates: [1, 2, 0.5], allowance: { goat: 20, pro: 30 } },\n]\n'
const row = { id: 'model', name: 'Model', inputCost: 1, outputCost: 2, cacheReadCost: 0.5 }
const rendered = new Map([['model', { rates: [1, 2, 0.5] }]])

test('价格同步遇到新套餐维度时拒绝生成删额度的候选', () => {
  assert.throws(() => buildPriceSnapshot([
    { ...row, planAllowanceUsd: { go: 10, goat: 20, pro: 30, future: 40 } },
  ], rendered, new Map(), source), /拒绝生成或写入快照/)
})

test('Go 额度保留零值，旧来源缺失时不借用其他套餐额度', () => {
  const result = buildPriceSnapshot([
    { ...row, planAllowanceUsd: { go: 0, goat: 20, pro: 30 } },
  ], rendered, new Map(), source)
  assert.match(result.next, /allowance: \{ go: 0, goat: 20, pro: 30 \}/)
  const old = buildPriceSnapshot([
    { ...row, planAllowanceUsd: { goat: 20, pro: 30 } },
  ], rendered, new Map(), source)
  assert.doesNotMatch(old.next, /go:/)
  for (const go of [-1, Infinity, NaN, '6']) {
    assert.throws(() => buildPriceSnapshot([
      { ...row, planAllowanceUsd: { go, goat: 20, pro: 30 } },
    ], rendered, new Map(), source), /not numeric/)
  }
})

test('价格同步对额度类型错误和双来源价格冲突都阻止覆盖', () => {
  assert.throws(() => buildPriceSnapshot([
    { ...row, planAllowanceUsd: { goat: '20', pro: 30 } },
  ], rendered, new Map(), source), /not numeric/)
  assert.throws(() => buildPriceSnapshot([row], new Map([['model', { rates: [9, 2, 0.5] }]]), new Map(), source), /rendered table/)
})

test('通过校验的价格候选保留额度和手写内容', () => {
  const result = buildPriceSnapshot([
    { ...row, planAllowanceUsd: { goat: 20, pro: 30 } },
  ], rendered, new Map(), `// 手写说明\n${source}// 其他定义\n`)
  assert.equal(result.rowCount, 1)
  assert.match(result.next, /allowance: \{ goat: 20, pro: 30 \}/)
  assert.match(result.next, /^\/\/ 手写说明/)
  assert.match(result.next, /\/\/ 其他定义\n$/)
})
