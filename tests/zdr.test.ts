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

test('the ZDR exception list is the live catalog zdr verdict (command-code@1.89.3)', () => {
  // command-code@1.82.4 moved the authority for this verdict out of the CLI
  // artifact: `knownModelSupportsZdr` no longer negates a bundled Set, it reads
  // `resolveKnownCatalogModel({model,catalog})?.zdr ?? false`. So this list is
  // now the live catalog's `zdr:false` membership, read from
  // `GET /provider/v1/models?view=client`, cross-checked against the artifact's
  // canonical helper set. A sync that moves membership must be a deliberate diff.
  //
  // History: 1.74.1 dropped `meituan/LongCat-2.0:free` from the anchor that the
  // old extractor read while the canonical helper `modelSupportsZdr2` kept it,
  // so the two anchor sets disagreed by exactly that one id (22 vs 23) for eight
  // releases; 1.82.4 ends the disagreement and serves `zdr:false` for the row,
  // which is why it is listed again here. Both retired stealth previews (Pixel
  // Canary, retired 2026-10-01; Space Bunny Alpha, retired 2026-10-06) left the
  // list in 1.77.0. 1.79.0 added the free `stealth/glyph-cluster:free` preview —
  // the one entry the pricing page itself flags "Not routed under ZDR" — and
  // 1.80.0 added `meta/muse-wonder-1.0`, bringing the set to 22. 1.82.4 then
  // adds `stealth/cat-jam:free` (the second live stealth preview), for 24
  // members: LongCat + cat-jam with nothing removed.
  //
  // 1.84.0 re-keys LongCat instead of widening coverage, so the set grew by a
  // net one and 25 was the membership pinned here. The catalog flipped the
  // `:free` row the other way — it served `zdr:true` for
  // `meituan/LongCat-2.0:free` — while the paid `meituan/LongCat-2.0` id, the
  // one a request can still name, took that slot with `zdr:false`.
  //
  // 1.84.0 also added `reflection/beam:free`, a catalog-only row: the artifact's
  // embedded model snapshot did not carry it, so `?view=client` was the sole
  // evidence for its `zdr:false` verdict — the same position `stealth/cat-jam:free`
  // was in at 1.82.4.
  //
  // 2026-10-20 catalog-only sync: `stealth/cat-jam:free` left both catalog views
  // (and the pricing/docs pages), so its `zdr:false` verdict was no longer
  // served; the 1.84.0 artifact's exclusion set still named it and this table is
  // the UNION of both sources, so membership stayed at 25. The MiniMax M3.1
  // Flash launch pair is `zdr:true` on both ids and joined no set.
  //
  // 2026-10-21 (command-code@1.86.1 sync) prunes the set 25 -> 18, and for the
  // first time the two sources agree EXACTLY: the artifact's `modelSupportsZdr`
  // set and the catalog's `zdr:false` rows are the same 18 ids
  // (`knownModelSupportsZdr` is gone from the artifact). +3: `claude-fable-5`,
  // `claude-fable-5-1`, `tencent/hy4-preview`. -10: the nine the catalog flipped
  // to `zdr:true` (Muse Spark 1.1/1.2/1.3, Muse Wonder 1.0, Grok 4.5/4.6, MiMo
  // V2.6 Flash/Pro, GLM-5.2 Fast) plus `stealth/cat-jam:free`, which no source
  // serves any more — removed by explicit decision (decision record, chapter 7
  // item 13), not by inferring coverage from its absence.
  //
  // 2026-11-04 (catalog-only sync) adds `stealth/crouton-alpha` from the pricing
  // page and `?view=client` alone, because the 1.88.2 artifact predates the row.
  // The 1.88.3 artifact's exclusion set now names it too, so the artifact and
  // the catalog carry the same 19 ids — the first exact match since 1.86.1
  // (18 -> 19, Crouton being the only addition).
  //
  // 2026-11-06 (command-code@1.88.4) retires the free Laguna S 2.1 picker row,
  // but membership is unchanged: both sources still serve `zdr:false` for the
  // id, and retirement alone is not coverage evidence, so it stays (19 == 19).
  //
  // 2026-11-10 (catalog-only sync) adds `claude-fable-5-2` (19 -> 20): the
  // 1.88.5 artifact named it nowhere while `?view=client` served `zdr:false`,
  // so the union admitted the catalog verdict alone (the 1.89.0 registry now
  // agrees). The free Beam row retired the same day still stays in the set —
  // both sources still serve its `zdr:false` — exactly like the retired free
  // Laguna row.
  //
  // 2026-11-13 (catalog-only sync) adds `thinkingmachines/inkling-2-small:free`
  // (20 -> 21) on the same catalog-only shape, and the pricing page states it in
  // prose too ("Not routed under ZDR"). `stealth/crouton-alpha` RETIRED the same
  // day (hidden in `?view=client`, gone from every public page) but STAYS: both
  // sources still serve its `zdr:false`, and retirement alone is not coverage
  // evidence.
  //
  // 2026-11-16 (command-code@1.89.1 sync) changes no membership: the artifact's
  // `modelSupportsZdr` set is now 21 ids and equals the catalog's `zdr:false`
  // rows exactly, so both now name `claude-fable-5-2` and
  // `thinkingmachines/inkling-2-small:free` — the two rows that entered on
  // catalog-only evidence above. Every id below is served `zdr:false` by both
  // sources; the retired rows (Beam, Laguna, Crouton, the free MiniMax twin)
  // keep their membership on the same rule.
  //
  // The later 2026-11-16 catalog advance (`catalogVersion 846b2b17…`) adds
  // `tencent/hy4-flash` on `?view=client` alone — the 1.89.1 artifact still has
  // no registry row for it — taking this list to 22 by the same union rule that
  // admitted Fable 5.2 and Inkling 2 Small before the artifact caught up. The
  // other new row, `Qwen/Qwen4-Max`, is served `zdr:true` and stays off this list.
  //
  // 2026-11-17 (command-code@1.89.2 sync) adds `recursive/flint-v1.0:free`
  // (22 -> 23): the 1.89.2 artifact's `modelSupportsZdr` set and `?view=client`
  // both serve `zdr:false`, and the pricing page names it in prose ("Not routed
  // under ZDR"). The same release registers the two 11-16 catalog-first rows in
  // the artifact, so this list is now artifact-confirmed end to end.
  //
  // 2026-11-18 (command-code@1.89.3 sync) takes the set 23 -> 21, the first
  // REMOVAL since the 1.86.1 prune: `tencent/hy4-preview` (an exception since
  // 1.86.1) and `tencent/hy4-flash` (admitted catalog-first on 2026-11-16) both
  // flip to `zdr:true` in `?view=client` AND leave the artifact's negated set in
  // the same release. Two agreeing sources, so this is coverage, not a verdict
  // that merely vanished from one artifact. The newly launched paid
  // `tencent/hy4` is `zdr:true` too and joins nothing.
  assert.deepEqual([...KNOWN_NON_ZDR_MODELS].sort(), [
    'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.8-Max-0902',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-fable-5-2',
    'deepseek/deepseek-v4.1-flash-fast',
    'meituan/LongCat-2.0',
    'meta/muse-spark-1.2-contributor',
    'meta/muse-spark-1.3-contributor',
    'minimax/minimax-m3-free',
    'poolside/laguna-s-2.1-free',
    'recursive/flint-v1.0:free',
    'reflection/beam:free',
    'sakana/fugu-ultra',
    'stealth/crouton-alpha',
    'stealth/glyph-cluster:free',
    'stepfun/Step-3.7-Flash',
    'stepfun/Step-5-Preview',
    'thinkingmachines/inkling-2-small:free',
    'xiaomi/mimo-v2.6-pro-ultraspeed',
    'z-ai/glm-5.3-flashx',
  ])
})

test('supportsZeroDataRetention answers false for every listed model and true otherwise', () => {
  for (const id of KNOWN_NON_ZDR_MODELS) {
    assert.equal(supportsZeroDataRetention(id), false, `${id} has no ZDR upstream`)
  }
  // One per family served through the Provider API, plus unseen ids: the table
  // only shrinks the answer for listed ids, and the header rides either way.
  // `meituan/LongCat-2.0` left this group in 1.84.0: the live catalog serves
  // `zdr:false` for the paid id, so it now sits in the exception set above —
  // exactly the reverse of 1.82.4, when the `:free` row held that slot and this
  // id was still ZDR covered. Both retired stealth previews stay here on
  // purpose: they left the CLI's exclusion sets in 1.77.0, so the snapshot
  // still answers true for them. The nine ids the 1.86.1 sync released from the
  // exception set (Muse Spark 1.1/1.2/1.3, Muse Wonder, Grok 4.5/4.6, MiMo V2.6
  // Flash/Pro, GLM-5.2 Fast) are ZDR-covered now and are pinned below.
  for (const id of [
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-flash',
    'stealth/pixel-canary',
    'stealth/space-bunny-alpha',
    'claude-opus-5',
    'claude-sonnet-5',
    'gpt-5.6-luna',
    'google/gemini-3.8-flash',
    'Qwen/Qwen3.8-Omni-Flash',
    'moonshotai/Kimi-K3',
    'z-ai/glm-5.3-flash',
    'zai-org/GLM-5',
    'zai-org/GLM-5.2-Fast',
    'meta/muse-spark-1.1',
    'meta/muse-spark-1.2',
    'meta/muse-spark-1.3',
    'meta/muse-wonder-1.0',
    'xai/grok-4.5',
    'xai/grok-4.6',
    'xiaomi/mimo-v2.6-flash',
    'xiaomi/mimo-v2.6-pro',
    // 2026-11-18 (1.89.3 sync): the whole Hy4 family is ZDR-covered now — the
    // Preview row that had been an exception since 1.86.1, the Flash row that
    // spent two days on the list, and the paid flagship joining on launch.
    'tencent/hy4',
    'tencent/hy4-flash',
    'tencent/hy4-preview',
    'MiniMaxAI/MiniMax-M2.5',
    'a-model-from-the-future',
  ]) {
    assert.equal(supportsZeroDataRetention(id), true, `${id} is ZDR-covered`)
  }
})
