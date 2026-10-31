/**
 * Static capability snapshot for the Command Code provider: model →
 * reasoning-effort levels, vision/thinking flags, model → minimum plan tier,
 * subscription-plan labels, deals, and hourly (peak/off-peak) pricing.
 *
 * Everything here is synced from official sources — the command-code CLI
 * bundle's model table (`dist/cli.mjs`, re-verified at command-code@1.88.2), the
 * live model catalog (`GET /provider/v1/models?view=client`, the authority for
 * capability fields since 1.82.4), and the official plan/pricing/model docs; see
 * the dsh-commandcode-upstream skill for the extraction procedures. The
 * 2026-10-21 sync moved the CLI from 1.84.0 to 1.86.1 and picked up the Ornith
 * 1.5 122B launch pair in the catalog, the ZDR exclusion-set prune and the
 * MiniMax M3.1 Flash promo extension; the follow-up check later that day moved
 * the pinned constant to 1.86.3 (request header only). The 2026-10-22 check
 * moved it to 1.87.1 (one output-limit row: `thinkingmachines/inkling-small`),
 * and the 2026-10-23 check to 1.87.3 with every snapshot unchanged apart from
 * the four retired catalog rows. The 2026-10-24 check moves it to 1.88.0 — a
 * silent artifact-only release — and picks up the one row that did move in the
 * catalog: Kimi K3.1 Pro (`moonshotai/Kimi-K3.1-Pro`, 1M context, text + image,
 * efforts `low/high/max`, Go tier, `$2/$10/$0.2`). The 1.88.0 artifact does not
 * name that row yet; the default catalog, `?view=client`, the models docs page
 * and the pricing page all do, so the capability fields come from the catalog
 * as usual. The 2026-10-27 check finds the CLI still at 1.88.0 and one more
 * catalog-only addition, GPT-6.1 Terra (`gpt-6.1-terra`): 1.05M context, text +
 * image, the same five-level effort set, Pro tier, `$1/$5` up to a 272K context
 * step and `$2/$7.5` beyond. The 2026-10-28 check moves the constant to 1.88.1,
 * whose registry now names both catalog-only rows (Kimi K3.1 Pro and GPT-6.1
 * Terra) with efforts and context identical to this snapshot, so no table
 * changes. The 2026-10-31 check moves it to 1.88.2 — the npm package's own
 * CHANGELOG names its sole change as a launch-crash fix after a fresh install
 * or update — and again leaves every table here identical; that round's only
 * data change is two per-model allowances in ./model-prices.ts. Keeping the
 * snapshot in its own module
 * confines those frequent sync diffs here: src/adapter.ts holds only the stable
 * wire/runtime logic. The read helpers live here too, for the same reason.
 *
 * Ported from pi-commandcode-provider (MIT); originally part of src/adapter.ts
 * and split out so upstream syncs stay reviewable.
 */

import { peakHour } from './cost-facts.ts'
import { PLAN_LABELS, PLAN_ORDER } from './plan-tiers.ts'
export { PLAN_LABELS, PLAN_ORDER } from './plan-tiers.ts'

export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // Re-verified against the authoritative command-code@1.88.2 model table. From
  // 1.82.4 the CLI no longer keeps this map bundled: `getSupportedEfforts()`
  // resolves it through the model catalog (`reasoningEfforts`), served live at
  // `GET /provider/v1/models?view=client` and falling back to an embedded
  // snapshot. The embedded snapshot is a bootstrap only — it was one refresh
  // stale within two days of release (99 of the live catalog's 100 models, and
  // missing the three newest; 1.82.5 folded exactly those three in), so a sync
  // must read the live catalog, not the artifact: exactly these models carry
  // selectable efforts. Models marked 'reasoning:!0' without efforts
  // (e.g. Tencent Hy3, GLM-5/5.1/5.2-Fast)
  // think automatically and are absent here - the CLI omits
  // 'reasoning_effort' for them, so the picker must not offer a selector. Do
  // NOT add entries from the OAuth provider tables (anthropic/openai) - only
  // the Provider-API table is authoritative for this plugin's route.
  //
  // `off` is NOT a strength: it is the DeepSeek family's "do not think" level
  // (command-code@1.73.3), and the official CLI sends it verbatim as
  // `reasoning_effort:"off"` rather than omitting the field. Its presence here
  // is what makes the adapter treat `off` as a real choice for these models
  // instead of the host's "no effort requested" signal - see the lookup in
  // `stream()`. No other family lists it: the Messages transport's
  // `output_config.effort` has no such value, so `off` stays dropped there.
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-0902': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  // command-code@1.56.0; same effort set as its Qwen 3.8 siblings.
  'Qwen/Qwen3.8-Omni-Flash': ['low', 'medium', 'xhigh'],
  // command-code@1.82.4; the GOAT-tier sibling of `Qwen/Qwen3.8-Max` with the
  // same three selectable levels. It is also the only model the 1.82.2 -> 1.82.4
  // train added to the artifact's own effort table.
  'Qwen/Qwen3.8-Max-Prime': ['low', 'medium', 'xhigh'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.68.0; the five-level set shared with the rest of the Sonnet /
  // Opus family. It takes the "recommended" slot from `claude-sonnet-5`.
  'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.39.1 dropped `medium`; the 1.39.2 table ships these three.
  // Still a three-level set at 1.74.3: unlike its V4 siblings, this one never
  // gained `off`, so thinking cannot be switched off on this variant.
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  // command-code@1.53.0.
  'deepseek/deepseek-v4.1-flash': ['off', 'low', 'high', 'max'],
  // command-code@1.67.0; the same four-level set as its `deepseek-v4.1-flash`
  // sibling, whose throughput-focused variant this is.
  'deepseek/deepseek-v4.1-flash-fast': ['off', 'low', 'high', 'max'],
  // command-code@1.73.3 added `off` ("Allow disabling thinking for DeepSeek
  // models") to the DeepSeek V4 line and the 4.1 pair above - but NOT to
  // `deepseek-v4-flash-fast`, which the 1.74.3 table still ships at three.
  'deepseek/deepseek-v4-flash': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-pro': ['off', 'high', 'max'],
  // command-code@1.82.0 ("Gemini Argon") and the only registry addition in the
  // 1.81.0 -> 1.82.1 train. Three selectable levels, the same set the Gemini
  // Flash family carries.
  'google/gemini-4-argon': ['low', 'medium', 'high'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.39.3; it previously reasoned automatically with no levels.
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  // 2026-10-24 (catalog-only sync): the 1.88.0 artifact does not name Kimi K3.1
  // Pro (1.88.2 does, with the same levels), and `?view=client` serves
  // `reasoningEfforts:["low","high","max"]` and the pricing page carries
  // `caps.reasoning: true`. Same three-level set as its K3 predecessor; do not
  // inherit future levels from it without re-checking.
  'moonshotai/Kimi-K3.1-Pro': ['low', 'high', 'max'],
  // command-code@1.43.0.
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  // 2026-10-16, first seen at the 1.84.0 sync: the live `?view=client` catalog
  // serves five levels for Reflection's free Beam preview, and it is the only
  // row this map gained in that train. Catalog-only evidence — the 1.84.0
  // artifact registry does not name the model at all (see KNOWN_NON_ZDR_MODELS).
  'reflection/beam:free': ['low', 'medium', 'high', 'xhigh', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  // command-code@1.60.0; same three-level set as its Step 3.x Flash siblings,
  // which still reason automatically with no levels and stay out of this map.
  'stepfun/Step-5-Preview': ['low', 'medium', 'high'],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  // command-code@1.59.0; same four-level set as Grok 4.6. 1.61.0 put it on a
  // 40% off launch deal (see KNOWN_DEALS).
  'xai/grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  // command-code@1.57.0; same effort set as its `z-ai/glm-5.3-flash` sibling.
  'z-ai/glm-5.3-flashx': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  // Muse Spark family: selectable levels in command-code@1.45.0, `max` added to
  // 1.3 in 1.48.0 (1.3-contributor keeps the four-level set).
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  // command-code@1.80.0 ("Add Muse Wonder"): the Muse family's newest member and
  // the only registry addition in the 1.79.2 -> 1.81.0 train. It carries the
  // same four-level set as Muse Spark 1.1/1.2 (no `max`).
  'meta/muse-wonder-1.0': ['low', 'medium', 'high', 'xhigh'],
  // 2026-10-15; the open-weight Muse Spark. Vision-capable, Go-tier and
  // served only by the live catalog - it postdates the 1.82.4 artifact's own
  // embedded snapshot, so it cannot be read out of `dist/cli.mjs`.
  'meta/muse-spark-open': ['low', 'medium', 'high'],
  // 2026-10-14; open vision-language reasoning model, Go tier.
  'nvidia/nemotron-3.5-super-vl': ['low', 'medium', 'high'],
  // command-code@1.49.0; the full five-level set.
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.64.0: Claude Opus 5.5 and the GPT-6 Sol / Luna pair, the only
  // registry additions in the 1.62.0 -> 1.64.0 train; all three reason with the
  // same five-level set as `gpt-6-astra`.
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.51.3; it previously reasoned automatically with no levels
  // and lived in KNOWN_THINKING_MODELS. The hidden
  // `minimax/minimax-m3-free` sibling gained the same set in the bundle.
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
  // 2026-10-20 (catalog-only sync; the 1.86.1 artifact folded the pair in on
  // 2026-10-21): MiniMax M3.1 Flash carries the full five-level set, unlike its
  // three-level M3 sibling. It came from the live `?view=client` catalog — the
  // same catalog-side evidence `reflection/beam:free` arrived on. The `:free`
  // twin left this map on 2026-10-23: its dated promo lapsed
  // (`2026-10-22T10:45Z`), the row went `hidden` in `?view=client`, and it left
  // the default catalog view, the pricing page and the models docs page — the
  // same retirement path `inclusionai/ling-3.1-flash:free` took.
  'minimax/minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  // `stealth/space-bunny-alpha` (command-code@1.65.0, `max` added by 1.73.4)
  // was RETIRED by command-code@1.74.3: the artifact drops its own four-level
  // effort list and ships the row as `hidden` instead, the official Desktop
  // changelog for 2026-10-06 says "Remove Space Bunny Alpha from the model
  // picker", and the model is gone from `/provider/v1/models` as well as the
  // pricing page.
  // `stealth/pixel-canary` (the second stealth preview, `xhigh` instead of
  // `high`) was RETIRED by command-code@1.73.1: the CLI hides it behind
  // `isPixelCanaryEnded()` (past 2026-10-01T06:00:00Z) and it is gone from
  // `/provider/v1/models` and the pricing page.
  // command-code@1.77.0 closed both out here as well: neither carries an effort
  // list any more, both sit in the CLI's non-selectable set (its
  // `listSelectableModelIds()` filters them out), and both left the ZDR
  // exclusion set — so no table in this file names either one any more.
  // command-code@1.71.0. Max-and-above availability (see KNOWN_PLANS), Vision
  // per the official registry and inputModalities:["text","image"], and the
  // same five-level set as its `gpt-6-astra` / `gpt-6-sol` predecessors.
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  // 2026-10-27 (catalog-only sync): `?view=client` serves
  // `reasoningEfforts:["low","medium","high","xhigh","max"]` and the pricing
  // page carries `caps.reasoning: true`; the 1.88.0 artifact does not name the
  // row (1.88.2 does, with the same levels). Same five-level set as its
  // `gpt-6.1-sol` predecessor; do not inherit future levels without
  // re-checking the catalog.
  'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  // command-code@1.82.2. The paid graduation of the `ling-3.1-flash:free`
  // promo this table used to carry: that row is retired in the same release
  // (the CLI ships it `hidden`, it lost its effort list, and it is gone from
  // both `/provider/v1/models` and the pricing page), so it is named nowhere in
  // this file any more. Three selectable levels, text-only input, Go tier —
  // like its `mistral-large-4` neighbour, and unlike the free stealth previews.
  'inclusionai/ling-3.1-flash': ['low', 'medium', 'high'],
  // command-code@1.75.0 ("Add Mistral Large 4") — the only model the 1.74.3 ->
  // 1.77.0 train added. A three-level set; Vision per the official registry and
  // the CLI's inputModalities:["text","image"] (see `KNOWN_IMAGE_MODELS`), and
  // Go-tier availability (see `KNOWN_PLANS`).
  'mistral/mistral-large-4': ['low', 'medium', 'high'],
  // command-code@1.78.0 ("Add Claude Haiku 5.5 (Pro and above)") and 1.79.0
  // ("Add Glyph Cluster as a free model, 100 requests a day") are the only
  // registry additions in the 1.77.0 -> 1.79.1 train. Both carry selectable
  // efforts, so neither belongs in KNOWN_THINKING_MODELS; Claude Haiku 5.5 takes
  // the Claude family's five-level set, while the free Glyph Cluster preview
  // stops at four and offers no `max`.
  'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'stealth/glyph-cluster:free': ['low', 'medium', 'high', 'xhigh'],
  // `stealth/cat-jam:free` — the free stealth preview added on 2026-10-15 with
  // the full five-level set — left every model table on 2026-10-20: the live
  // catalog (both views), the pricing page and the models docs page stopped
  // serving the row, so there is no selectable model left to describe. The
  // 1.84.0 artifact still named it in its ZDR exclusion set, which kept one
  // entry in `KNOWN_NON_ZDR_MODELS` until the 1.86.1 artifact dropped it as
  // well; that table no longer carries the id (decision record, chapter 7
  // item 13).
}

/**
 * Models whose Capabilities include Vision, per the official Command Code
 * model registry (`https://commandcode.ai/docs/reference/cli/models`, generated
 * from the same registry as `cmd --list-models` / the `/model` picker).
 *
 * The Provider API does not expose modality metadata, so this snapshot is the
 * source of truth for image-input gating. Command Code's own CLI falls back to
 * a client-side VISION side-call for text-only models; this adapter does not
 * reproduce that interactive feature, so images sent to a model outside this
 * list are refused loudly (`UNSUPPORTED_CONTENT`) instead of being dropped or
 * sent to a model that cannot read them.
 *
 * Keep in sync with the official registry when new models ship (see the
 * dsh-commandcode-upstream skill).
 */
export const KNOWN_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Max',
  // command-code@1.41.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  'Qwen/Qwen3.8-Max-0902',
  // command-code@1.56.0; Vision per the official registry and inputModalities.
  'Qwen/Qwen3.8-Omni-Flash',
  // command-code@1.82.4; inputModalities:["text","image"] in both the artifact's
  // embedded catalog and the live `?view=client` catalog.
  'Qwen/Qwen3.8-Max-Prime',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  // command-code@1.78.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  'claude-haiku-5-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
  // command-code@1.64.0; Vision per the official registry and inputModalities.
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  // command-code@1.68.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  'claude-sonnet-5-5',
  'deepseek/deepseek-v4-flash-vision-exp',
  // command-code@1.53.0; Vision per the official registry and inputModalities.
  'deepseek/deepseek-v4.1-flash',
  // command-code@1.67.0; Vision per the official registry and inputModalities.
  'deepseek/deepseek-v4.1-flash-fast',
  // command-code@1.82.0; Vision per the official registry, the CLI's
  // inputModalities:["text","image"] and the docs page's "Text input, Vision,
  // Reasoning" capability label.
  'google/gemini-4-argon',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  // command-code@1.43.0; Vision per the official registry and inputModalities.
  'google/gemini-3.8-flash',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  // command-code@1.49.0; Vision per the official registry and inputModalities.
  'gpt-6-astra',
  // command-code@1.64.0 added the GPT-6 Sol / Luna pair; Vision per the
  // official registry and inputModalities.
  'gpt-6-luna',
  'gpt-6-sol',
  // command-code@1.71.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"] — unlike the text-only Ling free models.
  'gpt-6.1-sol',
  // 2026-10-27 (catalog-only sync): inputModalities:["text","image"] in the live
  // `?view=client` catalog; the pricing page (`caps.vision: true`) and the
  // models docs page both mark the row Vision.
  'gpt-6.1-terra',
  // command-code@1.44.0 added Muse Spark 1.3 and its Contributor sibling; both
  // are Vision per the official registry and inputModalities.
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.3-contributor',
  // command-code@1.80.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image","file"] — the only model in this catalog
  // that also declares the `file` modality.
  'meta/muse-wonder-1.0',
  // 2026-10-15; inputModalities:["text","image"] in the live catalog.
  'meta/muse-spark-open',
  // 2026-10-14; inputModalities:["text","image"], and the only Nemotron row
  // in this catalog that carries vision.
  'nvidia/nemotron-3.5-super-vl',
  // command-code@1.75.0; Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  'mistral/mistral-large-4',
  // 2026-10-20 (catalog-only sync): inputModalities:["text","image"] in the
  // live `?view=client` catalog, and the models docs page labels the row
  // Vision. The `:free` twin left this map with the other snapshots on
  // 2026-10-23 (promo lapsed, row hidden).
  'minimax/minimax-m3.1-flash',
  'moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K3',
  // 2026-10-24 (catalog-only sync): inputModalities:["text","image"] in the live
  // `?view=client` catalog, and both the pricing page (`caps.vision: true`) and
  // the models docs page mark the row Vision.
  'moonshotai/Kimi-K3.1-Pro',
  // 2026-10-21 (command-code@1.86.1 sync): inputModalities:["text","image"] in
  // the live `?view=client` catalog and `caps.vision: true` on both the pricing
  // page and the models docs page. The `:free` twin left this map on 2026-10-23
  // with the other snapshots (promo lapsed, row hidden).
  'ornith/ornith-1.5-122b',
  'sakana/fugu-ultra',
  // command-code@1.65.0; Vision per the official registry and inputModalities.
  'stepfun/Step-3.7-Flash',
  // command-code@1.60.0; Vision per the official registry and inputModalities.
  'stepfun/Step-5-Preview',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'xai/grok-4.5',
  // command-code@1.47.0 marked Grok 4.6 vision-capable (text-only in 1.46.0).
  'xai/grok-4.6',
  // command-code@1.59.0; Vision per the official registry and inputModalities.
  'xai/grok-4.7',
  // `xiaomi/mimo-v2.5` left this map on 2026-10-23: MiMo V2.6 took over its
  // rates, the row went `hidden` in `?view=client`, and the default catalog
  // view, the pricing page and the models docs page stopped serving it.
  // command-code@1.62.0 added the MiMo V2.6 family (Flash, Pro, Pro
  // UltraSpeed); all three are Vision. None carries a reasoning flag in any
  // source, so no effort or automatic-reasoning entry belongs beside these.
  'xiaomi/mimo-v2.6-flash',
  'xiaomi/mimo-v2.6-pro',
  'xiaomi/mimo-v2.6-pro-ultraspeed',
  'z-ai/glm-5.3-flash',
  // command-code@1.57.0; Vision per the official registry and inputModalities.
  'z-ai/glm-5.3-flashx',
])

/**
 * Models WITHOUT a zero-data-retention upstream. Through command-code@1.82.2
 * the CLI's own registry answered this: `modelSupportsZdr(id)` was exactly
 * `!nonZdrSet.has(canonicalize(id))`, and `knownModelSupportsZdr` carried the
 * membership in the sibling route table — the UNION of both was this set, and
 * the two anchors disagreed by one id (`meituan/LongCat-2.0:free`, which 1.74.1
 * dropped from the first anchor while the canonical helper kept it).
 * command-code@1.82.4 removes that disagreement by making the verdict a catalog
 * lookup — `resolveKnownCatalogModel({model,catalog})?.zdr ?? false` — so this
 * set is now the live catalog's `zdr:false` membership and nothing more. The
 * official docs (commandcode.ai/docs/resources/
 * zdr) put coverage in prose — "99% of our models have ZDR-capable upstreams … only
 * a small handful of models are affected" — so the CLI's exclusion list is
 * the only per-model evidence there is; a ZDR request naming one of these
 * fails with HTTP 422 `cmd_zdr_no_providers` instead of routing through a
 * provider that retains.
 *
 * Why a NEGATIVE set, and why "not listed" answers TRUE: 99% of the catalog is
 * covered, so the maintained difference is the exception list. This helper is
 * informational; the adapter sends the ZDR header for EVERY request when the
 * switch is on — the provider remains the routing authority and refuses an
 * unsupported model rather than silently dropping the privacy guarantee.
 *
 * `minimax/minimax-m3-free` is the one entry the public catalog's default view
 * (`/provider/v1/models`) does not serve through the picker (it is CLI/pricing-visible
 * and hidden from the picker); it stays listed because the CLI carries it and a Go-plan
 * request can still name it. At the 1.84.0 sync both this row and
 * `stealth/cat-jam:free` were also served by the `?view=client` catalog, which
 * is where the 1.82.4 verdict came from; the catalog stopped serving cat-jam on
 * 2026-10-20, and the artifact followed at 1.86.1 (see the prune note below).
 *
 * command-code@1.82.4 moved the authority for this verdict: `knownModelSupportsZdr`
 * no longer negates a bundled Set, it returns `resolveKnownCatalogModel({model,
 * catalog})?.zdr ?? false`, so an id the catalog does not carry (or carries with
 * `zdr:false`) is NOT covered. That inverts the default this helper was built on
 * ("not listed" answered TRUE); the snapshot keeps its negative-set shape because
 * 99% of the catalog is still covered, but membership is now read from the
 * `?view=client` catalog and confirmed against the canonical helper set.
 *
 * Keep in sync via the dsh-commandcode-upstream skill: the CLI's registry data
 * (its `zdr:{only:[…]}` provider routes and the per-provider `zdr`/`noTraining`
 * flags) is upstream-internal routing, not a per-model contract, so this table
 * is the snapshot of the exclusion set and nothing more. It is a rare change:
 * 20 members held across 1.62.0 → 1.64.0, 1.65.0 and 1.66.0 each added exactly
 * one (the two stealth-preview models), 1.67.0 added one
 * (`deepseek/deepseek-v4.1-flash-fast`), 1.68.0 changed nothing, and 1.74.1
 * removed one (`meituan/LongCat-2.0`). The 1.74.2/1.74.3 pair changed nothing
 * here either (22 members as of 2026-10-06); 1.77.0 dropped the two retired
 * stealth previews, back to 20 members as of 2026-10-07, and 1.79.0 added the
 * free `stealth/glyph-cluster:free` preview — 21 members as of 2026-10-08.
 *
 * 1.77.0 also settled the two retired stealth previews (see `KNOWN_EFFORTS`):
 * 1.74.3 still named both in the ZDR anchors, so they stayed listed here on
 * purpose — an id a stale session named still got a truthful answer. The 1.77.0
 * artifact names neither in its exclusion set and filters both out of
 * `listSelectableModelIds()`, so they are pruned along with the rest of the
 * tables and `supportsZeroDataRetention` now answers TRUE for them, matching
 * what the current CLI says.
 *
 * 1.82.4 then reversed 1.74.1's removal of `meituan/LongCat-2.0:free` and added
 * the `stealth/cat-jam:free` preview, taking this set to 24 members. The 1.84.0
 * sync (2026-10-16) moves it to 25 with no verdict flip: LongCat's exclusion
 * followed its rename to the paid id, and the free `reflection/beam:free`
 * preview joined on catalog evidence alone. The authoritative membership is the
 * UNION of the artifact's exclusion set and the catalog's `zdr:false` list —
 * neither source alone is complete, which is why this set is not simply "what
 * the CLI says".
 *
 * The 2026-10-20 catalog-only sync changed no membership: `stealth/cat-jam:free`
 * left both catalog views (its `zdr:false` verdict is no longer served), but the
 * 1.84.0 artifact's exclusion set still named it and this set is the union, so
 * membership stayed at 25. The MiniMax M3.1 Flash launch pair is ZDR-covered
 * (`zdr:true` on both ids) and joins no set.
 *
 * 2026-10-21 (command-code@1.86.1 sync) prunes the set 25 -> 18, and for the
 * first time the two sources agree exactly: the 1.86.1 artifact's
 * `modelSupportsZdr` set and the live catalog's `zdr:false` rows are the same 18
 * ids (`knownModelSupportsZdr` is gone from the artifact). +3: `claude-fable-5`,
 * `claude-fable-5-1` and `tencent/hy4-preview`. -10: the nine models the catalog
 * flipped to `zdr:true` (Muse Spark 1.1 / 1.2 / 1.3, Muse Wonder 1.0, Grok 4.5 /
 * 4.6, MiMo V2.6 Flash / Pro, GLM-5.2 Fast) plus `stealth/cat-jam:free`, which
 * no source serves any more. Cat-jam is removed by explicit decision (see the
 * decision record, chapter 7 item 13): keeping a retired id in the negative set
 * is defense for stale sessions, not evidence, and the 1.86.1 artifact itself
 * dropped it. A verdict flip here is positive evidence, never "listed before,
 * absent now".
 */
export const KNOWN_NON_ZDR_MODELS: ReadonlySet<string> = new Set([
  'MiniMaxAI/MiniMax-M3',
  'Qwen/Qwen3.8-Max-0902',
  // 2026-10-21 (command-code@1.86.1 sync). New to the exclusion set: the 1.84.0
  // artifact did not name either Fable id, while the 1.86.1 artifact and the
  // live catalog both serve `zdr:false` for them.
  'claude-fable-5',
  'claude-fable-5-1',
  // command-code@1.67.0. The 1.67.0 artifact lists it in BOTH anchor sets, so
  // the CLI's own ZDR predicate excludes it. Unlike the retired stealth
  // previews, the pricing page carries no ZDR note for this row — the artifact
  // is the evidence, and the sibling `deepseek-v4.1-flash` stays ZDR-covered.
  'deepseek/deepseek-v4.1-flash-fast',
  // 2026-10-16 (1.84.0 sync). LongCat's verdict followed the id, not the other
  // way round: the catalog now serves `zdr:false` for the paid
  // `meituan/LongCat-2.0` and `zdr:true` for the `:free` row that 1.82.4 had
  // listed. Both sources agree — the artifact's exclusion set names the paid id
  // too — so this is a plain rename with a positive counter-example for the old
  // alias, never a removal on missing evidence.
  'meituan/LongCat-2.0',
  // 2026-10-21 (command-code@1.86.1 sync). The two Contributor siblings are the
  // only Muse rows still excluded: the catalog flipped 1.1 / 1.2 / 1.3 and
  // Muse Wonder 1.0 to `zdr:true`, and the artifact dropped them too.
  'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3-contributor',
  'minimax/minimax-m3-free',
  'poolside/laguna-s-2.1-free',
  // 2026-10-16 (1.84.0 sync). Catalog-only evidence: `?view=client` serves
  // `zdr:false` for Reflection's free Beam preview while the 1.84.0 artifact's
  // exclusion set never names it (that gap was the audit's single error). This
  // snapshot is the UNION of both sources, so the catalog verdict alone admits
  // it — the same path `stealth/cat-jam:free` took at 1.82.4. At the 1.86.1
  // sync the two sources agree on it.
  'reflection/beam:free',
  'sakana/fugu-ultra',
  // command-code@1.79.0. The free Glyph Cluster preview is the ONE entry here
  // whose exclusion the official pricing page states in prose rather than
  // leaving to the artifact: its tip reads "Free while the preview lasts. Up to
  // 100 requests a day. Not routed under ZDR." The CLI's own exclusion set
  // carries the same membership.
  'stealth/glyph-cluster:free',
  'stepfun/Step-3.7-Flash',
  'stepfun/Step-5-Preview',
  // 2026-10-21 (command-code@1.86.1 sync). New to the exclusion set: the catalog
  // serves `zdr:false` and the 1.86.1 artifact agrees.
  'tencent/hy4-preview',
  'xiaomi/mimo-v2.6-pro-ultraspeed',
  'z-ai/glm-5.3-flashx',
])

/**
 * Whether the CLI snapshot lists a ZDR-capable upstream for `modelId`. This is
 * informational, never a reason to omit the header when ZDR is enabled: the
 * provider may add coverage or lack capacity after this snapshot was taken.
 */
export function supportsZeroDataRetention(modelId: string): boolean {
  return !KNOWN_NON_ZDR_MODELS.has(modelId)
}

/**
 * Models the official CLI's model table marks `reasoning:!0` but defines no
 * selectable `reasoning_effort` levels — they think automatically, with
 * Command Code driving the depth. `KNOWN_EFFORTS` (which mirrors the CLI's
 * effort map exactly) stays the sole source for selectable effort levels, and
 * this snapshot is not surfaced in the picker's compact description — it exists
 * for programmatic consumers.
 *
 * Source: the bundled model table (dist/cli.mjs), cross-checked with
 * https://commandcode.ai/docs/reference/cli/models. Keep in sync via the
 * dsh-commandcode-upstream skill; a model that GAINS selectable efforts leaves
 * this set for `KNOWN_EFFORTS` (Tencent Hy4 Preview, Kimi K3, the Muse Spark
 * family and MiniMax M3 all took that path).
 */
export const KNOWN_THINKING_MODELS: ReadonlySet<string> = new Set([
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Flash',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  // command-code@1.65.2 corrected Step 3.5 Flash's registry context from
  // 1,000,000 to 262,144 tokens; the public catalog already served 262,144.
  // Reasoning and the absence of selectable efforts are unchanged.
  'stepfun/Step-3.5-Flash',
  'stepfun/Step-3.7-Flash',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'poolside/laguna-s-2.1-free',
  // LongCat 2.0 (command-code@1.42.0, Meituan's trillion-parameter coding
  // model, 1M context) is text-only with automatic reasoning. The free promo
  // ended 2026-09-19 and the backend catalog renamed it from
  // `meituan/LongCat-2.0:free` to the paid `meituan/LongCat-2.0`. The rename is
  // billing-only, so the new id keeps this entry: the pricing page still
  // carries `caps.reasoning: true` with no efforts, and command-code@1.58.0 —
  // the CLI release that retired the free tier — carries the new id with
  // `reasoning:!0` and no `reasoningEfforts`, one release after the backend
  // rename the 1.57.0 sync recorded here.
  'meituan/LongCat-2.0',
  // 2026-10-21 (command-code@1.86.1 sync): Ornith 1.5 122B carries
  // `reasoning: true` with no `reasoningEfforts` in the artifact registry and in
  // the live catalog, so it thinks automatically and gets no selector. The
  // `:free` twin — the same capability under a dated promo id — left this map on
  // 2026-10-23 when that promo lapsed and the row went hidden.
  'ornith/ornith-1.5-122b',
])

/**
 * Catalog models the Provider API serves ONLY through `/provider/v1/messages`
 * (Anthropic Messages shape). Every other model in the catalog answers on
 * `/provider/v1/chat/completions`.
 *
 * Measured 2026-09-16 (command-code@1.54.0, 69 models posted to
 * `/provider/v1/chat/completions`): exactly the then-entire Claude family
 * refused with HTTP 400 `Model "<id>" must be called via
 * /provider/v1/messages (Anthropic Messages shape)`, and every one of them is
 * routed normally by `/alpha/generate`.
 *
 * Re-measured 2026-09-29 against the 84-model catalog: the same ten
 * `claude-*` ids are the only ones carrying `supported_endpoints:
 * ["/messages"]`, and posting a non-Claude model to the endpoint answers 400
 * `Model "<id>" is not supported on this endpoint. Use
 * /provider/v1/chat/completions for OpenAI and OSS models.` The adapter routes
 * on that field when the catalog supplies it, so this set is the FALLBACK for
 * a cached or hand-built catalog, not the primary source — see
 * `requiresMessagesEndpoint()`.
 *
 * Note what this list is NOT: it is not a plan gate. `claude-sonnet-5` is
 * Pro-tier and `claude-opus-4-8` Provider-tier, so the accounts entitled to
 * these models are exactly the non-Go ones, which `resolveProtocol()` sends to
 * the Provider API by default — picking any Claude model there failed every
 * request before this snapshot existed.
 *
 * `requiresMessagesEndpoint()` additionally treats any `claude-*` id as
 * Messages-only, so a Claude model added upstream is still routed correctly
 * by an un-updated plugin instead of hard-failing with the 400 above. The
 * worst case of that rule going stale the other way (upstream teaching
 * `/provider/v1/chat/completions` to serve Claude) is one model riding a
 * transport it already works on.
 *
 * Keep in sync when models ship (see the dsh-commandcode-upstream skill).
 */
export const MESSAGES_ONLY_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
])

/** True when the Provider API will only serve `modelId` via `/provider/v1/messages`. */
export function requiresMessagesEndpoint(modelId: string): boolean {
  return MESSAGES_ONLY_MODELS.has(modelId) || modelId.startsWith('claude-')
}

/**
 * Per-model output ceilings, which `/provider/v1/models` does NOT publish (it
 * carries `context_length` and `supported_endpoints` only) while every endpoint
 * refuses a larger `max_tokens` per model. Sending the context window as the
 * output budget is what produced issue #71: `claude-sonnet-5-5` has a
 * 1 000 000-token window and a 128 000-token ceiling, the adapter derived
 * 131072, and the endpoint refused every request of a fresh process.
 *
 * **Generated — do not hand-edit.** `scripts/sync-output-limits.mjs` rewrites
 * this literal from models.dev; run it after a catalog sync, and use its
 * `--check` in CI. Command Code resells these models through their VENDOR's own
 * API, so the vendor's published ceiling is the value recorded: 76 of the 89
 * catalog ids as of 2026-10-15. Each row carries a comment naming the entry it
 * came from.
 *
 * No row needs a hand-recorded pin as of 2026-10-16: the one that did
 * (`inclusionai/ling-3.0-flash-sante:free`, pinned at 32768 because it had lost
 * both its vendor row and its unanimous third-party vote) left the live catalog
 * with the 1.82.4 catalog migration, so the script's `MANUAL_CEILINGS` map is
 * now empty and every remaining row resolves from a vendor row or a unanimous
 * third-party vote. (`gpt-6.1-sol` (128000) never needed a pin — OpenAI's own row
 * carries it and every other provider carrying the id agrees.) All are still
 * correctable — a stricter gateway costs one refused request, and
 * `streamRequest()` remembers what the endpoint said.
 *
 * The 13 unlisted models are ones no vendor publishes and the aggregators
 * disagree about. They are NOT a gap: a refusal states the ceiling in full, and
 * `streamRequest()` reads it off, retries once and remembers it for the model
 * (issue #71). A vendor figure the gateway turns out to be stricter than costs
 * one round trip; a conservative guess costs half of every answer, forever —
 * which is why the unlisted path defers to the endpoint rather than to a
 * fallback here.
 *
 * An unlisted Messages-route model still falls back to
 * {@link DEFAULT_MESSAGES_MAX_TOKENS} before any request is made, so a ceiling
 * is never absent when the body is built.
 */
export const MODEL_OUTPUT_TOKEN_LIMITS: ReadonlyMap<string, number> = new Map([
  // anthropic
  ['claude-fable-5', 128000],
  // anthropic
  ['claude-fable-5-1', 128000],
  // anthropic
  ['claude-haiku-4-5-20251001', 64000],
  // anthropic
  ['claude-haiku-5-5', 128000],
  // anthropic
  ['claude-opus-4-7', 128000],
  // anthropic
  ['claude-opus-4-8', 128000],
  // anthropic
  ['claude-opus-5', 128000],
  // anthropic
  ['claude-opus-5-5', 128000],
  // anthropic
  ['claude-sonnet-4-6', 128000],
  // anthropic
  ['claude-sonnet-5', 128000],
  // anthropic
  ['claude-sonnet-5-5', 128000],
  // deepseek
  ['deepseek/deepseek-v4-flash', 393216],
  // 1 provider(s), unanimous
  ['deepseek/deepseek-v4-flash-fast', 384000],
  // deepseek
  ['deepseek/deepseek-v4-flash-vision-exp', 393216],
  // deepseek
  ['deepseek/deepseek-v4-pro', 393216],
  // google
  ['google/gemini-3.1-flash-lite', 65536],
  // google
  ['google/gemini-3.5-flash', 65536],
  // google
  ['google/gemini-3.5-flash-lite', 65536],
  // google
  ['google/gemini-3.6-flash', 65536],
  // google
  ['google/gemini-3.7-flash', 65536],
  // google
  ['google/gemini-3.8-flash', 65536],
  // google
  ['google/gemini-4-argon', 32768],
  // openai
  ['gpt-5.3-codex', 128000],
  // openai
  ['gpt-5.4', 128000],
  // openai
  ['gpt-5.4-mini', 128000],
  // openai
  ['gpt-5.5', 128000],
  // openai
  ['gpt-5.6-luna', 128000],
  // openai
  ['gpt-5.6-sol', 128000],
  // openai
  ['gpt-5.6-terra', 128000],
  // openai
  ['gpt-6-astra', 128000],
  // openai
  ['gpt-6-luna', 128000],
  // openai
  ['gpt-6-sol', 128000],
  // openai
  ['gpt-6.1-sol', 128000],
  // 1 provider(s), unanimous
  ['meituan/LongCat-2.0', 131072],
  // meta
  ['meta/muse-spark-1.1', 131072],
  // meta
  ['meta/muse-spark-1.2', 131072],
  // meta
  ['meta/muse-spark-1.2-contributor', 131072],
  // meta
  ['meta/muse-spark-1.3', 131072],
  // meta
  ['meta/muse-spark-1.3-contributor', 131072],
  // meta
  ['meta/muse-wonder-1.0', 131072],
  // minimax
  ['minimax/minimax-m3.1-flash', 524288],
  // minimax
  ['MiniMaxAI/MiniMax-M2.5', 131072],
  // minimax
  ['MiniMaxAI/MiniMax-M2.7', 131072],
  // minimax
  ['MiniMaxAI/MiniMax-M3', 524288],
  // 8 provider(s), unanimous
  ['mistral/mistral-large-4', 262144],
  // moonshotai
  ['moonshotai/Kimi-K2.6', 262144],
  // moonshotai
  ['moonshotai/Kimi-K2.7-Code', 262144],
  // moonshotai
  ['moonshotai/Kimi-K2.7-Code-Highspeed', 262144],
  // moonshotai
  ['moonshotai/Kimi-K3', 1048576],
  // nvidia
  ['nvidia/nemotron-3-ultra-550b-a55b', 65536],
  // poolside
  ['poolside/laguna-s-2.1-free', 32768],
  // alibaba
  ['Qwen/Qwen3.6-Max-Preview', 65536],
  // alibaba
  ['Qwen/Qwen3.6-Plus', 65536],
  // alibaba
  ['Qwen/Qwen3.7-Flash', 131072],
  // alibaba
  ['Qwen/Qwen3.7-Max', 131072],
  // alibaba
  ['Qwen/Qwen3.7-Plus', 131072],
  // alibaba
  ['Qwen/Qwen3.8-Flash', 131072],
  // alibaba
  ['Qwen/Qwen3.8-Max', 131072],
  // 1 provider(s), unanimous
  ['Qwen/Qwen3.8-Max-0902', 131072],
  // alibaba
  ['Qwen/Qwen3.8-Omni-Flash', 131072],
  // sakana
  ['sakana/fugu-ultra', 1000000],
  // stepfun
  ['stepfun/Step-3.5-Flash', 256000],
  // stepfun
  ['stepfun/Step-3.7-Flash', 256000],
  // stepfun
  ['stepfun/Step-5-Preview', 65536],
  // 1 provider(s), unanimous
  ['tencent/hy3-paid', 128000],
  // thinkingmachines
  ['thinkingmachines/inkling', 65536],
  // thinkingmachines
  ['thinkingmachines/inkling-small', 65536],
  // xai
  ['xai/grok-4.5', 500000],
  // xai
  ['xai/grok-4.6', 500000],
  // xai
  ['xai/grok-4.7', 500000],
  // xiaomi
  ['xiaomi/mimo-v2.6-flash', 131072],
  // xiaomi
  ['xiaomi/mimo-v2.6-pro', 131072],
  // xiaomi
  ['xiaomi/mimo-v2.6-pro-ultraspeed', 131072],
  // zai
  ['z-ai/glm-5.3-flash', 131072],
  // zai
  ['z-ai/glm-5.3-flashx', 131072],
  // zai
  ['zai-org/GLM-5', 131072],
  // zai
  ['zai-org/GLM-5.1', 131072],
  // zai
  ['zai-org/GLM-5.2', 131072],
  // zai
  ['zai-org/GLM-5.3', 131072],
])

/**
 * Output ceiling for a Messages-route model that {@link MODEL_OUTPUT_TOKEN_LIMITS}
 * does not carry — today only models no vendor publishes yet. Deliberately
 * conservative: a 400 on `max_tokens` is a wasted round trip on every request,
 * whereas a lower ceiling only shortens an answer, and the endpoint states the
 * real one the first time it refuses, at which point the runtime overrides this
 * anyway (issue #71).
 *
 * 64 000 is not arbitrary: it is `claude-haiku-4-5-20251001`'s actual ceiling,
 * the lowest in the Claude family. A Claude model added to the catalog before
 * its row exists here therefore answers at a size the family really supports,
 * and is corrected upward on its first rejection rather than clamped here
 * forever.
 */
export const DEFAULT_MESSAGES_MAX_TOKENS = 64_000

/**
 * The minimum subscription plan a model is included in, per the official plan
 * pages (`/docs/plans/go`, `/docs/plans/goat`, `/docs/plans/pro`,
 * `/docs/plans/max` and `/docs/resources/pricing-limits`). Each plan's model
 * list is a superset of the one below it: Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max.
 * Models absent from every plan list (Claude Opus/Fable, Fugu Ultra) are
 * Provider-tier. Re-verified at command-code@1.88.2 (2026-10-31) against the
 * live `?view=client` catalog: 106 ids, still a strict superset chain. Mistral
 * Large 4 (1.75.0) was the only addition at the 1.77.0 check; the 1.78.0/1.79.0 pair
 * added Claude Haiku 5.5 at Pro and the free Glyph Cluster preview at Go.
 * 1.79.2 lowers Haiku 5.5's minimum plan to GOAT; 1.80.0 adds Muse Wonder at
 * Max; 1.82.0 adds Gemini 4 Argon at Pro and nothing else moves. The 1.82.4
 * train adds Qwen 3.8 Max Prime at GOAT plus Muse Spark Open, Nemotron 3.5
 * Super VL and the free Cat Jam preview at Go, and drops Ling 3.0 Flash Sante,
 * which left the live catalog. Every other
 * tier is unchanged. The 1.86.1 sync (2026-10-21) adds only the Ornith 1.5 122B
 * launch pair at Go; the 1.87.1 check (2026-10-22) adds no model and moves no
 * tier, the 2026-10-24 check adds only Kimi K3.1 Pro at Go, and the 2026-10-27
 * check adds only GPT-6.1 Terra at Pro.
 * The only removals since 1.49.0 are the two retired stealth previews (Pixel
 * Canary at 1.73.1, Space Bunny Alpha at 1.74.3), Ling 3.0 Flash Sante
 * (2026-10-16) and the retired Cat Jam preview (2026-10-20). Per-entry tags
 * below name the releases that added or moved each row.
 *
 * The Provider API exposes no plan metadata, so this snapshot is the source of
 * truth for the picker's plan annotation — it answers "which plan do I need to
 * actually use this model?" at a glance. Plan labels use the official tier
 * names (`Go`, `GOAT`, `Pro`, `Provider`), with `Max` implying Provider.
 *
 * Keep in sync with the official plan pages when they change (see the
 * dsh-commandcode-upstream skill).
 */
export const KNOWN_PLANS: Readonly<Record<string, string>> = {
  // --- Go (57 paid + 4 free) ---
  'MiniMaxAI/MiniMax-M2.5': 'go',
  'MiniMaxAI/MiniMax-M2.7': 'go',
  'MiniMaxAI/MiniMax-M3': 'go',
  'Qwen/Qwen3.6-Max-Preview': 'go',
  'Qwen/Qwen3.6-Plus': 'go',
  'Qwen/Qwen3.7-Flash': 'go',
  'Qwen/Qwen3.7-Max': 'go',
  'Qwen/Qwen3.7-Plus': 'go',
  'Qwen/Qwen3.8-27B': 'go',
  'Qwen/Qwen3.8-Flash': 'go',
  'Qwen/Qwen3.8-Max': 'go',
  // command-code@1.41.0; listed on the Go plan page.
  'Qwen/Qwen3.8-Max-0902': 'go',
  // command-code@1.82.4; individual-go is false and individual-goat true — the
  // one new model in this train that lands on GOAT rather than Go.
  'Qwen/Qwen3.8-Max-Prime': 'goat',
  // command-code@1.56.0; the pricing page's embedded availability grants every
  // tier (individual-go through teams-pro) — the "all":true shape shared by the
  // Qwen 3.8 family and the stealth-preview models below.
  'Qwen/Qwen3.8-Omni-Flash': 'go',
  // command-code@1.39.0; Go-tier like the rest of the DeepSeek V4 family.
  'deepseek/deepseek-v4-flash-fast': 'go',
  // command-code@1.53.0; every plan including Go.
  'deepseek/deepseek-v4.1-flash': 'go',
  // command-code@1.67.0; individual-go true, so Go-tier like the rest of the
  // DeepSeek V4 family.
  'deepseek/deepseek-v4.1-flash-fast': 'go',
  'deepseek/deepseek-v4-flash': 'go',
  'deepseek/deepseek-v4-flash-vision-exp': 'go',
  'deepseek/deepseek-v4-pro': 'go',
  'gpt-5.6-luna': 'go',  // command-code@1.64.0; the opensource-category GPT-6, on every plan including
  // Go, unlike its premium-category siblings Sol (Pro) and Astra (Provider/Max).
  'gpt-6-luna': 'go',
  // command-code@1.42.0 added the free LongCat 2.0 on every plan; that promo
  // ended 2026-09-19 and the catalog renamed the id to the paid
  // `meituan/LongCat-2.0` ($0.30/$1.20/$0.006), which keeps this slot. The CLI
  // followed in command-code@1.58.0, marking the retired `:free` sibling
  // `hidden`, so its registry now agrees with the catalog this map is keyed by.
  'meituan/LongCat-2.0': 'go',
  // command-code@1.82.2; the paid successor of the retired
  // `ling-3.1-flash:free` promo. The pricing page's embedded availability
  // grants every tier (individual-go through teams-pro) — the "all":true shape
  // shared with its `ling-3.0-flash-sante:free` predecessor.
  'inclusionai/ling-3.1-flash': 'go',
  // command-code@1.44.0; on every plan including Go, like its 1.2 Contributor
  // sibling.
  'meta/muse-spark-1.2-contributor': 'go',
  'meta/muse-spark-1.3-contributor': 'go',
  // 2026-10-15; individual-go true (Go and every higher tier), the same
  // "all":true availability shape as its Muse siblings.
  'meta/muse-spark-open': 'go',
  // command-code@1.75.0; the pricing page's embedded availability grants every
  // tier (individual-go through teams-pro) — the "all":true shape shared by the
  // Qwen 3.8 family above.
  'mistral/mistral-large-4': 'go',
  // 2026-10-20 (catalog-only sync): MiniMax M3.1 Flash is Go-tier —
  // `minimumPlan: "individual-go"` in the live `?view=client` catalog and every
  // tier true in the pricing page's embedded availability. The `:free` twin left
  // this map on 2026-10-23 (promo lapsed, row hidden).
  'minimax/minimax-m3.1-flash': 'go',

  'moonshotai/Kimi-K2.5': 'go',
  'moonshotai/Kimi-K2.6': 'go',
  'moonshotai/Kimi-K2.7-Code': 'go',
  'moonshotai/Kimi-K2.7-Code-Highspeed': 'go',
  'moonshotai/Kimi-K3': 'go',
  // 2026-10-24 (catalog-only sync): `minimumPlan: "individual-go"` in the live
  // `?view=client` catalog and every tier true in the pricing page's embedded
  // availability (`"all": true`); the go/goat/pro plan pages all list the row.
  'moonshotai/Kimi-K3.1-Pro': 'go',
  'nvidia/nemotron-3-ultra-550b-a55b': 'go',
  // 2026-10-14; individual-go true, the "all":true shape shared by the rest of
  // the open-weight Nemotron family.
  'nvidia/nemotron-3.5-super-vl': 'go',
  // 2026-10-21 (command-code@1.86.1 sync): Ornith 1.5 122B is a Go-tier
  // open-weight MoE — `minimumPlan: "individual-go"` in the live catalog and
  // every tier true in the pricing page's embedded availability. The `:free`
  // twin left this map on 2026-10-23 (promo lapsed, row hidden).
  'ornith/ornith-1.5-122b': 'go',
  'poolside/laguna-s-2.1-free': 'go',
  // 2026-10-16, first seen at the 1.84.0 sync: the free Beam preview was the one
  // new id the DEFAULT catalog view served then (93 ids). This map tracks that
  // view: the `hidden:true` rows of `?view=client` do not belong here, unlike
  // `KNOWN_NON_ZDR_MODELS`, whose membership is the catalog/artifact union (see
  // the decision record, chapter 7). The 2026-10-20 catalog-only sync took the
  // view to 94 ids — the MiniMax M3.1 Flash pair joined and
  // `stealth/cat-jam:free` left — the 1.86.1 sync took it to 96 with the Ornith
  // 1.5 122B pair, and the 2026-10-23 sync takes it to 92: both `:free` twins
  // lapsed and the MiMo V2.5 pair went hidden, so those four ids left this map
  // and `?view=client` now hides twelve rows. The 2026-10-24 check adds Kimi
  // K3.1 Pro and takes it to 93 while `?view=client` goes to 105 (the same
  // twelve hidden rows).
  'reflection/beam:free': 'go',
  'stepfun/Step-3.5-Flash': 'go',
  'stepfun/Step-3.7-Flash': 'go',
  // command-code@1.60.0; every tier, and listed by the Go/GOAT/Pro/Max plan
  // pages alike — the superset chain this map encodes.
  'stepfun/Step-5-Preview': 'go',
  // `stealth/cat-jam:free` left this map on 2026-10-20 with the rest of the
  // model tables: both catalog views, the pricing page and the models docs page
  // stopped serving it. The 1.86.1 artifact dropped it from its ZDR exclusion
  // set as well, so `KNOWN_NON_ZDR_MODELS` no longer carries it either (see the
  // decision record, chapter 7 item 13).
  // command-code@1.79.0 ("Add Glyph Cluster as a free model, 100 requests a
  // day"); the pricing page's embedded availability grants every tier
  // (individual-go through teams-pro) — the "all":true shape shared by the Ling
  // free models above. Its zero-credit deal (see KNOWN_DEALS) also makes it lead
  // the picker.
  'stealth/glyph-cluster:free': 'go',
  'tencent/hy3-paid': 'go',
  'tencent/hy4-preview': 'go',
  'thinkingmachines/inkling': 'go',
  'thinkingmachines/inkling-small': 'go',
  'xai/grok-4.5': 'go',
  // `xiaomi/mimo-v2.5` and `xiaomi/mimo-v2.5-pro` left this map on 2026-10-23:
  // MiMo V2.6 took over their rates, both rows went `hidden` in `?view=client`,
  // and this map tracks the default view.
  // command-code@1.62.0 added the MiMo V2.6 family; these two are on every tier
  // (the Go plan page lists both), while the Pro UltraSpeed sibling is GOAT —
  // individual-go is what separates them.
  'xiaomi/mimo-v2.6-flash': 'go',
  'xiaomi/mimo-v2.6-pro': 'go',
  'z-ai/glm-5.3-flash': 'go',
  // command-code@1.57.0; the "all":true shape shared with its
  // `z-ai/glm-5.3-flash` sibling.
  'z-ai/glm-5.3-flashx': 'go',
  'zai-org/GLM-5': 'go',
  'zai-org/GLM-5.1': 'go',
  'zai-org/GLM-5.2': 'go',
  'zai-org/GLM-5.2-Fast': 'go',
  'zai-org/GLM-5.3': 'go',
  // --- GOAT (10 more) ---
  // command-code@1.79.2 lowers the 1.78.0 Pro gate to GOAT: individual-go
  // remains false, individual-goat and all higher tiers are true.
  'claude-haiku-5-5': 'goat',
  // command-code@1.68.0; individual-go false, individual-goat true — "Available
  // on GOAT and above", one tier ABOVE its `claude-sonnet-5` predecessor, which
  // sits in the Pro block below.
  'claude-sonnet-5-5': 'goat',
  'google/gemini-3.7-flash': 'goat',
  // command-code@1.43.0; "Available on GOAT and above", like the rest of the
  // Gemini Flash family.
  'google/gemini-3.8-flash': 'goat',
  'gpt-5.6-sol': 'goat',
  'meta/muse-spark-1.2': 'goat',
  // command-code@1.44.0; "Available on GOAT and above", like the 1.2/1.1 models.
  'meta/muse-spark-1.3': 'goat',
  'xai/grok-4.6': 'goat',
  // command-code@1.59.0; "Available on GOAT and above" (individual-go false).
  'xai/grok-4.7': 'goat',
  // command-code@1.62.0; GOAT and above, the same split as its Grok 4.7
  // sibling. Its two cheaper V2.6 siblings are Go, above.
  'xiaomi/mimo-v2.6-pro-ultraspeed': 'goat',
  // --- Pro (16 more) ---
  'claude-haiku-4-5-20251001': 'pro',
  'claude-sonnet-4-6': 'pro',
  'claude-sonnet-5': 'pro',
  // command-code@1.82.0; individual-go / go-v1 / goat all false, Pro and every
  // higher tier true — one tier above the Gemini Flash family above it.
  'google/gemini-4-argon': 'pro',
  'google/gemini-3.1-flash-lite': 'pro',
  'google/gemini-3.5-flash': 'pro',
  'google/gemini-3.5-flash-lite': 'pro',
  'google/gemini-3.6-flash': 'pro',
  'gpt-5.3-codex': 'pro',
  'gpt-5.4': 'pro',
  'gpt-5.4-mini': 'pro',
  'gpt-5.5': 'pro',
  'gpt-5.6-terra': 'pro',
  // command-code@1.64.0; Pro and above (individual-go/goat false).
  'gpt-6-sol': 'pro',
  // 2026-10-27 (catalog-only sync): `minimumPlan: "individual-pro"` in the live
  // `?view=client` catalog; the pricing page's embedded availability sets
  // individual-go / go-v1 / goat false and Pro and above true.
  'gpt-6.1-terra': 'pro',
  'meta/muse-spark-1.1': 'pro',
  // --- Provider (8) ---
  // command-code@1.40.0; Provider/Max exactly like its `claude-fable-5`
  // predecessor — individual-provider/max/ultra and teams-pro only.
  'claude-fable-5-1': 'provider',
  'claude-fable-5': 'provider',
  'claude-opus-4-7': 'provider',
  'claude-opus-4-8': 'provider',
  // command-code@1.64.0; Provider API only (go/goat/pro/pro-v1 all false), and
  // the catalog serves it with supported_endpoints ['/messages'] — the Claude
  // route, which the adapter's `claude-*` prefix rule already sends down the
  // CLI transport.
  'claude-opus-5-5': 'provider',
  'claude-opus-5': 'provider',
  // command-code@1.49.0; on Max.
  'gpt-6-astra': 'provider',
  'sakana/fugu-ultra': 'provider',
  // --- Max (2) ---
  // command-code@1.71.0; the FIRST Max-only model in this catalog and the only
  // one whose minimum plan is `max`: the embedded availability sets every lower
  // tier false (individual-go / go-v1 / goat / pro / pro-v1 / provider all
  // false) and only individual-max, individual-ultra and teams-pro true.
  // `PLAN_ORDER` already carries `max` above `provider`, so the picker sorts it
  // last without a change there (plan-tiers.ts).
  'gpt-6.1-sol': 'max',
  // command-code@1.80.0; the same Max-and-above availability as `gpt-6.1-sol`
  // (every lower tier false, only individual-max / individual-ultra /
  // teams-pro true) and the note "Available on Max and above."
  'meta/muse-wonder-1.0': 'max',
}

/**
 * Whether a model is free (requests cost no credits), per the pricing page's
 * deals (`KNOWN_DEALS` `free: true`). Free models lead the picker regardless
 * of tier — they are usable by every account, so they are the best default
 * candidates.
 */
export function isFreeModel(modelId: string): boolean {
  return KNOWN_DEALS[modelId]?.free === true
}

/**
 * Comparator for the model picker: free models first (zero credit cost, usable
 * by every account), then by plan tier (lowest first), then by model name,
 * then by id as a tiebreak. Models with no known plan sort last.
 */
export function compareByPlan(
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  const freeDelta = Number(isFreeModel(b.id)) - Number(isFreeModel(a.id))
  if (freeDelta !== 0) return freeDelta
  const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ''] ?? Number.MAX_SAFE_INTEGER
  if (pa !== pb) return pa - pb
  const nameDiff = a.name.localeCompare(b.name)
  if (nameDiff !== 0) return nameDiff
  return a.id.localeCompare(b.id)
}

/**
 * Subscription plan table, synced from the official CLI bundle's plan maps
 * (located by the `"individual-go"` key in `dist/cli.mjs`, re-verified unchanged
 * through command-code@1.73.0): subscription `planId` prefix → display name and
 * the plan's monthly credit total. This is the account's own subscription
 * (from `/alpha/billing/subscriptions`) — distinct from {@link KNOWN_PLANS},
 * which maps catalog models to their minimum tier.
 *
 * `tierWeight` is plugin-added (not from the CLI maps): the plan's rank on
 * the {@link PLAN_ORDER} scale, used by the picker's plan filter
 * ({@link modelVisibleInPlan}) to hide models above the account's tier.
 */
export const KNOWN_SUBSCRIPTION_PLANS: Readonly<Record<string, { name: string; monthlyCredits: number; tierWeight: number }>> = {
  'individual-go': { name: 'Go', monthlyCredits: 10, tierWeight: 0 },
  // command-code@1.69.0 ("Go plan moves to per-model credits") added this second
  // Go row to the CLI's plan maps. Same display name and monthly total, so
  // `tierWeight` stays 0 alongside `individual-go` — exactly how the pre-existing
  // `individual-pro-v1` sits at Pro's weight 2. Resolution is longest-prefix
  // match (see below), so the explicit `-v1` suffix still wins over the base.
  'individual-go-v1': { name: 'Go', monthlyCredits: 10, tierWeight: 0 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70, tierWeight: 1 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30, tierWeight: 2 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80, tierWeight: 2 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15, tierWeight: 3 },
  'individual-max': { name: 'Max', monthlyCredits: 150, tierWeight: 4 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300, tierWeight: 4 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40, tierWeight: 2 },
}

/** Plan-id prefixes, longest first — the CLI's prefix-match order. */
const SUBSCRIPTION_PLAN_PREFIXES = Object.keys(KNOWN_SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length)

/**
 * Resolve a subscription `planId` (e.g. `individual-pro-v1`) to its display
 * name and monthly credit total, mirroring the CLI's `getPlanInfo`:
 * normalize (lowercase, `_` → `-`), then longest-prefix match so
 * `individual-pro-v1` wins over `individual-pro`. Unknown ids return
 * `undefined`.
 */
export function subscriptionPlanInfo(planId: string): { name: string; monthlyCredits: number; tierWeight: number } | undefined {
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  const prefix = SUBSCRIPTION_PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate))
  return prefix === undefined ? undefined : KNOWN_SUBSCRIPTION_PLANS[prefix]
}

/**
 * The billing facts the picker's plan filter needs, fetched by mirroring the
 * CLI's `createBilling` flow (whoami → orgId, then `/alpha/billing/subscriptions`
 * for the plan id and `/alpha/billing/credits` for the on-demand balances).
 */
export interface CommandCodeBillingAccess {
  /** Account plan tier weight on the {@link PLAN_ORDER} scale; undefined when the plan is unknown. */
  tierWeight: number | undefined
  /**
   * Purchased + free on-demand credit balance. The official access model
   * (`evaluateModelAccess` in the CLI) allows every model when the account
   * holds any on-demand credits — the plan gate only applies at zero balance.
   */
  onDemandCredits: number
}

/**
 * Whether the picker lists `modelId` for an account with the given billing
 * access. Fails open at every uncertainty: no billing data, an unknown plan,
 * a non-finite weight (corrupt billing fact), or a model outside
 * {@link KNOWN_PLANS} all keep the model visible — the server remains the
 * final gate (`403 MODEL_NOT_IN_PLAN`).
 */
export function modelVisibleInPlan(modelId: string, access: CommandCodeBillingAccess | undefined): boolean {
  if (access === undefined) return true
  if (access.onDemandCredits > 0) return true
  if (access.tierWeight === undefined || !Number.isFinite(access.tierWeight)) return true
  const tier = KNOWN_PLANS[modelId]
  if (tier === undefined) return true
  const weight = PLAN_ORDER[tier]
  if (weight === undefined) return true
  return weight <= access.tierWeight
}

/**
 * Whether the picker lists `modelId` for a whole POOL of accounts: true when
 * at least one of them includes it. The picker's plan filter is asked this
 * rather than {@link modelVisibleInPlan} for a single account because the pool
 * — not any one account — is what serves a request: keying the list on
 * whichever account rotation happened to reach made models appear and vanish
 * as accounts rotated, and hid models the user's other accounts could run.
 *
 * An account whose facts are unknown counts as "may include it" (the same
 * fail-open rule `modelVisibleInPlan` applies one level down), and an empty
 * pool is "show everything": hiding a model somebody can run is the one
 * failure this filter must never cause.
 */
export function modelVisibleForAnyAccount(
  modelId: string,
  accounts: readonly (CommandCodeBillingAccess | undefined)[] | undefined,
): boolean {
  if (accounts === undefined || accounts.length === 0) return true
  return accounts.some((access) => modelVisibleInPlan(modelId, access))
}

/**
 * Active pricing deals per the official pricing page
 * (`/docs/resources/pricing-limits#deals`). Each entry records the model's
 * promotional label and — critically — when it expires, so the picker never
 * shows a stale discount after the plugin's snapshot has gone out of date.
 *
 * - `expiresAt` is an ISO timestamp. When it is in the past (checked at
 *   render time against `Date.now()`), the deal label is hidden until the
 *   snapshot is refreshed from the official page. `undefined` means
 *   "no expiry" (permanent).
 * - `free` marks models whose requests cost no credits, shown as a `FREE`
 *   badge; it degrades to a plain discount once the deal lapses.
 *
 * A deal whose promo ENDS is removed here rather than left to lapse on
 * `expiresAt`: the pricing page drops the entry, so a lapsed row would badge a
 * model the catalog now serves at full price (Grok 4.7 reverts to $2.00 in /
 * $6.00 out after its 2026-09-27 window).
 *
 * Keep in sync with the official pricing page when deals change (see the
 * dsh-commandcode-upstream skill).
 */
export interface KnownDeal {
  /** Promotional label, e.g. "50% off" or "2× usage". */
  label: string
  /** Deal end date (ISO). `undefined` = permanent / no expiry. */
  expiresAt?: string
  /** Model is free (requests cost no credits). */
  free?: boolean
}

export const KNOWN_DEALS: Readonly<Record<string, KnownDeal>> = {
  'MiniMaxAI/MiniMax-M3': { label: '50% off' },
  // `minimax/minimax-m3.1-flash:free` (the 2026-10-20 dated launch promo, 100%
  // off through `2026-10-22T10:45Z`) left this map on 2026-10-23: the promo
  // lapsed, the row went `hidden` in `?view=client`, and it is gone from the
  // default catalog view, the pricing page and the models docs page — the same
  // retirement path `inclusionai/ling-3.1-flash:free` took. A dated promo only
  // needs its badge while the row is still served.
  // `xiaomi/mimo-v2.5` (98% off) and `xiaomi/mimo-v2.5-pro` (99% off) left this
  // map on the same check: MiMo V2.6 took over their rates as regular ones, both
  // rows went `hidden`, and the pricing page dropped the whole Xiaomi
  // collaboration block, so there is no deal left to display.
  'poolside/laguna-s-2.1-free': { label: 'FREE', free: true },
  // 2026-10-16 (1.84.0 sync); the third live free preview in this map.
  // "Free while capacity lasts", no daily request limit, and — unlike its Glyph
  // Cluster sibling — the page states outright that it is "Not routed under
  // ZDR", which matches the catalog verdict in `KNOWN_NON_ZDR_MODELS`. The page
  // publishes it at a literal zero, so it gets no row in the vendored price
  // table either.
  'reflection/beam:free': { label: 'FREE', free: true },
  // `stealth/cat-jam:free` (`FREE`, the 2026-10-15 stealth preview) left this
  // map on 2026-10-20: the live catalog (both views), the pricing page and the
  // models docs page stopped serving the row, so there is no deal to display.
  // It stays in `KNOWN_NON_ZDR_MODELS` on artifact evidence alone — see the
  // decision record, chapter 7 item 13.
  // `inclusionai/ling-3.1-flash:free` (command-code@1.70.0, 100% off "Free
  // while it lasts", the `ling-3.0-flash-sante:free` successor) left this map
  // on 2026-10-15: command-code@1.82.2 ships the row as `hidden`, drops its
  // selectable efforts, and the model is gone from both
  // `/provider/v1/models` and the pricing page — the same retirement path
  // `meituan/LongCat-2.0:free` and `stealth/space-bunny-alpha` took. Its paid
  // graduation `inclusionai/ling-3.1-flash` is priced normally and carries no
  // deal.
  // `inclusionai/ling-3.0-flash-sante:free` followed it out on 2026-10-16 with
  // the 1.82.4 catalog migration: it had already left the live catalog and the
  // pricing page, and it is absent from the 1.82.4 artifact's embedded snapshot
  // as well, so no official source names it any more.
  // command-code@1.79.0 ("Add Glyph Cluster as a free model, 100 requests a
  // day"): 100% off "Free while the preview lasts", the same 100-requests-a-day
  // cap as its Ling predecessors and likewise no published end date, so no
  // `expiresAt`. The pricing page publishes it at a literal zero, which
  // `modelPriceTable()` serves from this deal, so it gets no row in the vendored
  // price table either. Unlike those free models it is NOT ZDR-routed — the
  // page's own tip says so outright (see `KNOWN_NON_ZDR_MODELS`).
  'stealth/glyph-cluster:free': { label: 'FREE', free: true },
  // `ornith/ornith-1.5-122b:free` (the 2026-10-21 dated launch promo, 100% off
  // "until 11:00 PM PT on October 21" = `2026-10-22T06:00Z`) left this map on
  // 2026-10-23 for the same reason as its MiniMax sibling: the promo lapsed, the
  // row went `hidden` in `?view=client`, and the default catalog view, the
  // pricing page and the models docs page stopped serving it. The paid id stays
  // listed at $0.16/$0.64/$0.02 and carries no deal.
  // `stealth/space-bunny-alpha` (command-code@1.65.0, 100% off "Free while the
  // stealth preview lasts", auto-applied, no published end date) left this map
  // on 2026-10-06: command-code@1.74.3 hides the model, the catalog and the
  // pricing page dropped it, and the official Desktop changelog says "Remove
  // Space Bunny Alpha from the model picker". Its twin Pixel Canary left the
  // same way when command-code@1.73.1 retired it.
}

/**
 * Models with time-of-day (peak/off-peak) pricing, per the official pricing
 * page (`/docs/resources/pricing-limits`). Since 2026-08-16 16:00 UTC, DeepSeek
 * charges by the hour: peak hours are 01:00–04:00 and 06:00–10:00 UTC (7h per
 * weekday, full price) **Monday to Friday only**; the other 17 hours of a
 * weekday and every hour of Saturday/Sunday (UTC) are off-peak at half price.
 * Exactly five models carry the page's `timeOfDay` block (the five rows below).
 * The picker shows the *current* state as a compact label (`Peak`/`Half`)
 * matching the English noun style of the other markers (`Image`, `FREE`), so a
 * developer can tell at a glance whether calling the model right now is cheap
 * or expensive.
 *
 * Extraction caution: the rendered HTML rows are a trap. Each annotation div
 * sits inside its OWN row's container, immediately before the NEXT row starts,
 * so flattening the page to text makes every annotation look like it belongs
 * to the model printed after it — that is how `deepseek/deepseek-v4-flash-fast`
 * was wrongly added here (its row is flat-priced at $0.28/$0.56/$0.07 and has
 * no `timeOfDay` block). Trust the embedded JSON's `timeOfDay` membership and
 * the 2× price relation, never the flat-text neighbor. A rate that is
 * internally consistent can still be the wrong row (the V4 Flash Vision (exp)
 * variant is priced from the page's own `timeOfDay` block, not from 2× its own
 * off-peak figures), which is why the vendored price table
 * (`./model-prices.ts`) is synced from the page and not hand-kept.
 *
 * Keep in sync with the official pricing page when the model set, the peak
 * windows, or the weekday rule change (see the dsh-commandcode-upstream skill).
 */
export const KNOWN_PEAK_PRICING: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  // command-code@1.53.0; the same `timeOfDay` block as the other three
  // (off-peak $0.15/$0.60, peak $0.30/$1.20, 01–04 & 06–10 UTC Mon–Fri).
  'deepseek/deepseek-v4.1-flash',
  // command-code@1.67.0; the same 01–04 & 06–10 UTC Mon–Fri windows and the same
  // 2026-08-16T16:00Z effective date, at its own rates (off-peak
  // $0.16/$0.58/$0.016, peak $0.32/$1.16/$0.032) — note these are NOT 2× the
  // sibling's, so this row must come from its own `timeOfDay` block.
  'deepseek/deepseek-v4.1-flash-fast',
])

/**
 * Peak hours (UTC, hour-of-day range end-exclusive): 01–03 and 06–09.
 * Weekday-only — see `peakPricingState()`; weekends are fully off-peak.
 *
 * Exported because the vendored price table (`./model-prices.ts`) ships these
 * windows to the browser with the table itself: the composer prices a session
 * against the very schedule this snapshot knows rather than restating it, so
 * there is one place to update when the windows move.
 */
export const PEAK_HOUR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
]

/**
 * Whether `now` (defaults to `Date.now()`) falls inside a peak-pricing window,
 * ignoring which model is asking. Peak rates apply Monday–Friday (UTC) only,
 * so a weekend timestamp is off-peak even inside {@link PEAK_HOUR_RANGES}.
 *
 * Model-independent on purpose: `peakPricingState()` adds the membership test
 * on top for the picker's label, while the price table selects peak rates from
 * a row's own `peak` block — so a model whose catalog id spelling differs from
 * the one in {@link KNOWN_PEAK_PRICING} still gets the right half of the day.
 */
export function isPeakPricingHour(now: number = Date.now()): boolean {
  return peakHour(now, PEAK_HOUR_RANGES)
}

/**
 * As {@link isPeakPricingHour}, plus the {@link KNOWN_PEAK_PRICING} membership
 * test; `undefined` for models outside the snapshot.
 */
export function peakPricingState(
  modelId: string,
  now: number = Date.now(),
): 'peak' | 'off-peak' | undefined {
  if (!KNOWN_PEAK_PRICING.has(modelId)) return undefined
  return isPeakPricingHour(now) ? 'peak' : 'off-peak'
}

/**
 * Compact label for the current peak/off-peak state: `Peak` (full price) or
 * `Half` (off-peak, half price). These English nouns match the picker's other
 * markers (`Go`, `Image`, `FREE`), and since they appear only on time-of-day
 * priced models they double as a "priced by the hour" signal. Returns undefined
 * for models without time-of-day pricing.
 */
export function peakPricingLabel(
  modelId: string,
  now: number = Date.now(),
): string | undefined {
  const state = peakPricingState(modelId, now)
  if (state === undefined) return undefined
  return state === 'peak' ? 'Peak' : 'Half'
}

/**
 * Official display label for a model's minimum plan, or undefined for models
 * outside the snapshot (e.g. future catalog additions).
 */
export function planLabel(modelId: string): string | undefined {
  const plan = KNOWN_PLANS[modelId]
  return plan === undefined ? undefined : PLAN_LABELS[plan]
}

/**
 * The active deal label for a model, or undefined when the model has no deal
 * or the deal has expired. Expiry is judged against `now` (defaults to
 * `Date.now()`), so a snapshot that has gone stale stops showing its discount
 * the moment the official end date passes — the user never believes a lapsed
 * deal is still live. Permanent deals (no `expiresAt`) never lapse.
 */
export function dealLabel(modelId: string, now: number = Date.now()): string | undefined {
  const deal = KNOWN_DEALS[modelId]
  if (deal === undefined) return undefined
  if (deal.expiresAt !== undefined && now >= Date.parse(deal.expiresAt)) return undefined
  return deal.label
}

/**
 * Compact human-readable context window, e.g. `1_000_000 -> "1M"`,
 * `256_000 -> "256K"`, `262_144 -> "262K"` (floor to the nearest K).
 * Returns undefined for unknown/absent sizes; values under 1K render raw.
 */
export function formatContext(contextWindow: number | undefined): string | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined
  }
  if (contextWindow >= 1_000_000) {
    const m = contextWindow / 1_000_000
    // Round to one decimal only when it adds information: 1_048_576 -> "1M",
    // 1_050_000 -> "1.1M".
    const rounded = Math.round(m * 10) / 10
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`
  }
  if (contextWindow < 1_000) return String(Math.floor(contextWindow))
  return `${Math.floor(contextWindow / 1_000)}K`
}

/**
 * Compact one-line summary for the model picker: plan tier, then any active
 * deal (discount or FREE), then the current peak/off-peak state (`Peak`/`Half`)
 * for time-of-day-priced models, then `Image` for Vision-capable models, then
 * the context window. Text-only models simply omit the Image marker — "Text
 * only" adds nothing the picker needs to show.
 */
export function capabilityDescription(
  modelId: string,
  contextWindow?: number,
  now: number = Date.now(),
): string {
  const parts: string[] = []
  const plan = planLabel(modelId)
  if (plan !== undefined) parts.push(plan)
  const deal = dealLabel(modelId, now)
  if (deal !== undefined) parts.push(deal)
  const peak = peakPricingLabel(modelId, now)
  if (peak !== undefined) parts.push(peak)
  if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push('Image')
  const ctx = formatContext(contextWindow)
  if (ctx !== undefined) parts.push(ctx)
  return parts.join(' · ')
}
