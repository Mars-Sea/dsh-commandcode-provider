/**
 * Model-select helper tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the data shaping behind the settings page's model-editor
 * dropdowns (the routing-rule editor and the visible-models filter):
 * search filtering, stale-id detection, tier grouping, and selection
 * toggling. The React dropdown itself (`ModelMultiSelect` in section.tsx)
 * is a thin view over these helpers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildModelSelectOptions,
  catalogIsReady,
  groupModelSelectOptions,
  matchesModelQuery,
  staleModelIds,
  tierHeadingFor,
  toggleModelSelection,
} from '../src/client/model-select.ts'

const CATALOG = [
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview' },
  { id: 'some-future-model', name: 'Some Future Model' },
]

// ---------------------------------------------------------------------------
// matchesModelQuery
// ---------------------------------------------------------------------------

test('a blank query matches everything', () => {
  for (const query of ['', '   ']) {
    assert.equal(matchesModelQuery(CATALOG[0]!, query), true)
  }
})

test('matching is a case-insensitive substring over id and name', () => {
  assert.equal(matchesModelQuery(CATALOG[0]!, 'deepseek'), true)
  assert.equal(matchesModelQuery(CATALOG[0]!, 'DEEPSEEK'), true)
  assert.equal(matchesModelQuery(CATALOG[0]!, 'V4 Pro'), true)
  assert.equal(matchesModelQuery(CATALOG[0]!, 'v4 pro'), true)
  assert.equal(matchesModelQuery(CATALOG[0]!, 'hy4'), false)
  assert.equal(matchesModelQuery(CATALOG[1]!, 'hy4'), true)
})

// ---------------------------------------------------------------------------
// buildModelSelectOptions
// ---------------------------------------------------------------------------

test('builds one live row per catalog model in catalog order', () => {
  const options = buildModelSelectOptions(CATALOG, [])
  assert.deepEqual(options, [
    { value: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', stale: false },
    { value: 'tencent/hy4-preview', label: 'Tencent Hy4 Preview', stale: false },
    { value: 'some-future-model', label: 'Some Future Model', stale: false },
  ])
})

test('appends selected ids the catalog no longer carries as stale', () => {
  const options = buildModelSelectOptions(CATALOG, ['deepseek/deepseek-v4-pro', 'retired/model'])
  assert.deepEqual(options, [
    { value: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', stale: false },
    { value: 'tencent/hy4-preview', label: 'Tencent Hy4 Preview', stale: false },
    { value: 'some-future-model', label: 'Some Future Model', stale: false },
    { value: 'retired/model', label: 'retired/model', stale: true },
  ])
})

test('dedupes repeated selected ids and drops blanks', () => {
  const options = buildModelSelectOptions(CATALOG, ['retired/model', 'retired/model', ''])
  assert.deepEqual(options.map((option) => option.value), [
    'deepseek/deepseek-v4-pro',
    'tencent/hy4-preview',
    'some-future-model',
    'retired/model',
  ])
})

test('a query narrows catalog rows to id/name matches', () => {
  const options = buildModelSelectOptions(CATALOG, [], 'hy4')
  assert.deepEqual(options.map((option) => option.value), ['tencent/hy4-preview'])
})

test('a query keeps a matching stale row but hides unrelated stale rows', () => {
  const options = buildModelSelectOptions(CATALOG, ['retired/model', 'old/hy4-thing'], 'hy4')
  assert.deepEqual(options.map((option) => option.value), ['tencent/hy4-preview', 'old/hy4-thing'])
})

test('a query with no matches yields no rows', () => {
  assert.deepEqual(buildModelSelectOptions(CATALOG, [], 'no-such-model'), [])
})

// ---------------------------------------------------------------------------
// groupModelSelectOptions
// ---------------------------------------------------------------------------

const TIER_OF = (id: string): string | undefined => {
  if (id === 'deepseek/deepseek-v4-pro' || id === 'some-future-model') return 'Go'
  if (id === 'tencent/hy4-preview') return 'GOAT'
  return undefined
}

test('groups live rows under tier headings, merging repeats', () => {
  const groups = groupModelSelectOptions(buildModelSelectOptions(CATALOG, []), TIER_OF)
  assert.deepEqual(groups.map((group) => group.heading), ['Go', 'GOAT'])
  assert.deepEqual(groups[0]!.options.map((option) => option.value), ['deepseek/deepseek-v4-pro', 'some-future-model'])
  assert.deepEqual(groups[1]!.options.map((option) => option.value), ['tencent/hy4-preview'])
})

test('unmapped models collect in an unheaded group', () => {
  const catalog = [...CATALOG, { id: 'unknown/model', name: 'Unknown Model' }]
  const groups = groupModelSelectOptions(buildModelSelectOptions(catalog, []), TIER_OF)
  assert.equal(groups[groups.length - 1]!.heading, undefined)
  assert.deepEqual(groups[groups.length - 1]!.options.map((option) => option.value), ['unknown/model'])
})

test('stale rows collect in a trailing unheaded group', () => {
  const options = buildModelSelectOptions(CATALOG, ['retired/model'])
  const groups = groupModelSelectOptions(options, TIER_OF)
  const last = groups[groups.length - 1]!
  assert.equal(last.heading, undefined)
  assert.deepEqual(last.options, [{ value: 'retired/model', label: 'retired/model', stale: true }])
})

test('stale and unmapped rows share one trailing unheaded group', () => {
  const catalog = [...CATALOG, { id: 'unknown/model', name: 'Unknown Model' }]
  const options = buildModelSelectOptions(catalog, ['retired/model'])
  const groups = groupModelSelectOptions(options, TIER_OF)
  assert.deepEqual(groups.map((group) => group.heading), ['Go', 'GOAT', undefined])
  assert.deepEqual(groups[groups.length - 1]!.options.map((option) => option.value), [
    'unknown/model',
    'retired/model',
  ])
})

test('an empty option list yields no groups', () => {
  assert.deepEqual(groupModelSelectOptions([], TIER_OF), [])
})

// ---------------------------------------------------------------------------
// toggleModelSelection
// ---------------------------------------------------------------------------

test('toggling an absent id appends it', () => {
  assert.deepEqual(toggleModelSelection(['a'], 'b'), ['a', 'b'])
})

test('toggling a present id removes it', () => {
  assert.deepEqual(toggleModelSelection(['a', 'b'], 'a'), ['b'])
})

// ---------------------------------------------------------------------------
// tierHeadingFor
// ---------------------------------------------------------------------------

test('maps known-plan ids to tier headings', () => {
  const knownPlans = { 'deepseek/deepseek-v4-pro': 'go', 'tencent/hy4-preview': 'goat' }
  assert.equal(tierHeadingFor('deepseek/deepseek-v4-pro', knownPlans), 'Go')
  assert.equal(tierHeadingFor('tencent/hy4-preview', knownPlans), 'GOAT')
})

test('returns undefined for unmapped ids', () => {
  assert.equal(tierHeadingFor('some-future-model', {}), undefined)
})

test('falls back to the raw tier key for a future tier', () => {
  assert.equal(tierHeadingFor('x/new-model', { 'x/new-model': 'ultra' }), 'ultra')
})

// ---------------------------------------------------------------------------
// Stale-selection cleanup (only against a catalog we actually hold)
// ---------------------------------------------------------------------------

test('catalogIsReady is false while the catalog is empty or failed', () => {
  // Both states make every selected id look retired, which is what turned the
  // one-click stale cleanup into a button that silently emptied the allowlist.
  assert.equal(catalogIsReady({ catalogIds: [], catalogFailed: false }), false)
  assert.equal(catalogIsReady({ catalogIds: [], catalogFailed: true }), false)
  assert.equal(catalogIsReady({ catalogIds: ['m1'], catalogFailed: true }), false)
  assert.equal(catalogIsReady({ catalogIds: ['m1'], catalogFailed: false }), true)
})

test('staleModelIds reports unlisted selections in selection order', () => {
  const readiness = { catalogIds: ['a', 'b'], catalogFailed: false }
  assert.deepEqual(staleModelIds(['b', 'gone-1', 'a', 'gone-2'], readiness), ['gone-1', 'gone-2'])
  assert.deepEqual(staleModelIds(['a'], readiness), [])
})

test('an empty selection is never stale', () => {
  // The state that made the old cleanup dangerous: nothing selected must not
  // read as "everything is stale".
  assert.deepEqual(staleModelIds([], { catalogIds: [], catalogFailed: false }), [])
})
