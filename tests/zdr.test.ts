/**
 * Zero-data-retention capability snapshot tests (node:test, zero deps).
 *
 * The snapshot is informational: `x-cmd-zdr: 1` is sent on EVERY request when
 * ZDR is enabled, never omitted based on this table — the provider REFUSES an
 * unsupported request (422 `cmd_zdr_no_providers`) rather than serving it from a
 * retaining provider. The table mirrors the CLI's own exclusion set, so this
 * file pins the list: a sync that moves membership must be a deliberate diff.
 * Run with `npm test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_NON_ZDR_MODELS,
  supportsZeroDataRetention,
} from '../src/capabilities.ts'

test('the ZDR exception list is the CLI registry exclusion set (command-code@1.72.1)', () => {
  // Verbatim from `dist/cli.mjs` 1.72.1: `modelSupportsZdr(id) = !wD.has(id)`
  // unioned with the sibling route table's `br` set, cross-checked against the
  // public catalog. A sync that moves membership must be a deliberate diff.
  assert.deepEqual([...KNOWN_NON_ZDR_MODELS].sort(), [
    'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.8-Max-0902',
    'deepseek/deepseek-v4.1-flash-fast',
    'meituan/LongCat-2.0',
    'meta/muse-spark-1.1',
    'meta/muse-spark-1.2',
    'meta/muse-spark-1.2-contributor',
    'meta/muse-spark-1.3',
    'meta/muse-spark-1.3-contributor',
    'minimax/minimax-m3-free',
    'poolside/laguna-s-2.1-free',
    'sakana/fugu-ultra',
    'stealth/pixel-canary',
    'stealth/space-bunny-alpha',
    'stepfun/Step-3.7-Flash',
    'stepfun/Step-5-Preview',
    'xai/grok-4.5',
    'xai/grok-4.6',
    'xiaomi/mimo-v2.6-flash',
    'xiaomi/mimo-v2.6-pro',
    'xiaomi/mimo-v2.6-pro-ultraspeed',
    'z-ai/glm-5.3-flashx',
    'zai-org/GLM-5.2-Fast',
  ])
})

test('supportsZeroDataRetention answers false for every listed model and true otherwise', () => {
  for (const id of KNOWN_NON_ZDR_MODELS) {
    assert.equal(supportsZeroDataRetention(id), false, `${id} has no ZDR upstream`)
  }
  // One per family served through the Provider API, plus unseen ids: the table
  // only shrinks the answer for listed ids, and the header rides either way.
  for (const id of [
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-flash',
    'claude-opus-5',
    'claude-sonnet-5',
    'gpt-5.6-luna',
    'google/gemini-3.8-flash',
    'Qwen/Qwen3.8-Omni-Flash',
    'moonshotai/Kimi-K3',
    'z-ai/glm-5.3-flash',
    'zai-org/GLM-5',
    'MiniMaxAI/MiniMax-M2.5',
    'a-model-from-the-future',
  ]) {
    assert.equal(supportsZeroDataRetention(id), true, `${id} is ZDR-covered`)
  }
})
