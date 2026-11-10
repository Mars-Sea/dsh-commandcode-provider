/**
 * Model selector badge tests (node:test, zero deps). Run with `npm test`.
 *
 * A badge is the short Tag DSH's model selector draws beside a model name
 * (`LlmModelInfo.badge`); the plugin derives it from the vendored deal
 * snapshot, so these cases pin the two things that could silently regress:
 * WHICH models get a badge (active deals only, on the same expiry clock as the
 * description marker) and WHAT it says (localized text with an English
 * fallback for labels the translation table does not know).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KNOWN_DEALS, dealBadgeText, modelBadge } from '../src/capabilities.ts'

test('a free promo advertises a localized FREE badge', () => {
  // `stealth/crouton-alpha` is a permanent free row in the snapshot (the free
  // Beam 1.0 row was retired on 2026-11-10 and the free Laguna S 2.1 row on
  // 2026-11-06; both left `KNOWN_DEALS`).
  assert.deepEqual(modelBadge('stealth/crouton-alpha'), {
    text: { en: 'FREE', zh: '免费' },
    tone: 'success',
  })
})

test('a percentage-off deal advertises the discount, not FREE', () => {
  // MiniMax M3 carries the only percentage-off label the pricing page uses.
  assert.deepEqual(modelBadge('MiniMaxAI/MiniMax-M3'), {
    text: { en: '50% off', zh: '5折' },
    tone: 'success',
  })
})

test('a lapsed deal advertises nothing, on the same clock as the description', () => {
  // The snapshot no longer carries a dated promo (the Ling 3.1 Flash 1019 free
  // row left `KNOWN_DEALS` when its `2026-11-03T16:00Z` window ended), so the
  // expiry clock is pinned with a synthetic row; the badge must disappear
  // exactly when `dealLabel` stops returning the label.
  const id = 'test/dated-promo'
  const expiry = Date.parse('2026-11-03T16:00:00Z')
  Object.assign(KNOWN_DEALS, { [id]: { label: 'FREE', free: true, expiresAt: '2026-11-03T16:00:00Z' } })
  try {
    assert.ok(modelBadge(id, expiry - 1) !== undefined, 'one millisecond before the end is live')
    assert.equal(modelBadge(id, expiry), undefined, 'the end instant itself is over')
    assert.equal(modelBadge(id, expiry + 86_400_000), undefined)
  } finally {
    delete (KNOWN_DEALS as Record<string, unknown>)[id]
  }
})

test('a model with no deal advertises nothing', () => {
  assert.equal(modelBadge('deepseek/deepseek-v4-pro'), undefined)
  // Unknown ids (a catalog row newer than the snapshot) are not an error.
  assert.equal(modelBadge('some-future-model'), undefined)
})

test('an unmapped deal label falls back to its English literal', () => {
  // A future upstream label the translation table does not know still renders
  // rather than dropping the badge; only the Chinese translation is missing.
  assert.equal(dealBadgeText('2× usage'), '2× usage')
  assert.equal(dealBadgeText('70% off'), '70% off')
})
