/**
 * Zero-data-retention capability snapshot tests (node:test, zero deps).
 *
 * The plugin keeps an informational per-model snapshot of ZDR coverage. It
 * never uses the table to omit `x-cmd-zdr: 1` when ZDR is enabled: the provider
 * REFUSES an unsupported request (422 `cmd_zdr_no_providers`) rather than
 * serving it from a retaining provider. The table is the CLI's exclusion set (`modelSupportsZdr` in
 * command-code@1.64.0's dist/cli.mjs), so this file pins both the list — a sync
 * that moves membership must be a deliberate diff — and the helper's two
 * directions. Run with `npm test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_NON_ZDR_MODELS,
  supportsZeroDataRetention,
} from '../src/capabilities.ts'

test('the ZDR exception list is the CLI registry exclusion set (command-code@1.64.0)', () => {
  // Verbatim from `dist/cli.mjs`: `modelSupportsZdr(id) = !iD.has(canonicalId)`
  // (20 entries) unioned with the sibling route table's `br` set (the same 19
  // plus nothing), cross-checked against the public catalog — every entry but
  // the CLI-hidden `minimax/minimax-m3-free` is served by
  // `/provider/v1/models` today.
  assert.deepEqual([...KNOWN_NON_ZDR_MODELS].sort(), [
    'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.8-Max-0902',
    'meituan/LongCat-2.0',
    'meta/muse-spark-1.1',
    'meta/muse-spark-1.2',
    'meta/muse-spark-1.2-contributor',
    'meta/muse-spark-1.3',
    'meta/muse-spark-1.3-contributor',
    'minimax/minimax-m3-free',
    'poolside/laguna-s-2.1-free',
    'sakana/fugu-ultra',
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
  // One per family the plugin serves through the Provider API, plus the current
  // catalog's newest arrivals (the table only shrinks the answer for listed
  // ids — an id it has never seen follows the CLI and is treated as covered.
  // The adapter still sends the header regardless of this informational set.
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
