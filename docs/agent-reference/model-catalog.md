# Model capabilities and upstream snapshots

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **Static capability snapshots** (all in `src/capabilities.ts`, synced from official sources — see the
  `dsh-commandcode-upstream` skill for the exact extraction procedures; `src/adapter.ts` imports them and
  keeps only stable wire/runtime logic):

  **Latest sync (2026-10-21, CLI 1.84.0 → 1.86.1):** the default catalog view went 94 → 96 ids and
  `?view=client` 102 → 104. Added Ornith 1.5 122B (`ornith/ornith-1.5-122b` + `:free`): 262,144 context,
  text + image, automatic reasoning (no effort levels), Go tier, ZDR covered, paid `$0.16/$0.64/$0.02`,
  free twin 100% off until `2026-10-22T06:00Z`. The MiniMax M3.1 Flash free deal was extended one day
  (`2026-10-21T10:45Z` → `2026-10-22T10:45Z`). `stealth/cat-jam:free` had already left the model tables on
  2026-10-20 and also left `KNOWN_NON_ZDR_MODELS` at this sync (the 1.86.1 artifact dropped it; explicit
  user decision — [decision record](../决策记录.md#七上游快照同步边界) chapter 7 item 14). The ZDR exception
  set went 25 → 18: the artifact's `modelSupportsZdr` set now matches the catalog's `zdr:false` rows
  id-for-id — +3 (`claude-fable-5`, `claude-fable-5-1`, `tencent/hy4-preview`), −10 (nine models flipped to
  `zdr:true` plus cat-jam). Counts: efforts 66 → 66, plans 94 → 96, image 72 → 74, deals 7 → 8, ZDR 25 → 18;
  vendored price rows 93 → 94, output-limit rows 80 → 81. The CLI artifact's only new endpoint is
  `/alpha/artifacts` (its own artifact publishing, unused by this plugin); headers, provider endpoints and
  the `mode`/`permissionMode` enums are byte-identical, and the official changelog has no entry for
  1.85.0–1.86.1 (static artifact comparison only — chapter 7 item 14).

  **Follow-up check (2026-10-21, CLI 1.86.1 → 1.86.3):** the pinned constant moved for the
  `x-command-code-version` header only. Both patch releases are silent upstream (no changelog entry) and
  leave every snapshot here untouched: the registry, effort map, subscription plans and ZDR exception set
  are identical, the live catalog still serves 96 / 104 ids with `catalogVersion` `2a2c334e…`, and the only
  artifact additions are CLI-local (`distrustCompromisedRoots` and the experimental taste/learn UI).

  **Follow-up check (2026-10-22, CLI 1.86.3 → 1.87.1):** npm `latest` reached `1.87.0`
  (10-21T18:02Z) and `1.87.1` (10-21T23:26Z); both are silent upstream (the changelog's newest CLI
  entry is still `1.84.0`), so the conclusion is artifact-level again: endpoints (64), custom headers
  (5), the `/alpha/generate` call sites, the registry, effort map, subscription tables and ZDR
  exception set are identical, and every addition is CLI-local (`/btw` mid-turn side questions,
  disk-full write protection, and the permission-mode rename `standard` → `default` plus a new
  `dont-ask`). The live catalog moved `catalogVersion` from `2a2c334e…` to `501a4bf9…` while still
  serving 96 / 104 ids, and every capability field is unchanged, so no model table here moved (plans
  96, efforts 66, image 74, thinking 17, deals 8, ZDR 18). Two data tables did move: vendored price
  rows stay 94 but two monthly allowances drop (`deepseek-v4.1-flash` GOAT $100 → $80 / Pro $110 →
  $90; `mistral-large-4` $10/$40/$50 → $6/$20/$30), and the output-limit table gains one row
  (`thinkingmachines/inkling-small` 65,536; 81 → 82). The four pricing-alias `incomplete` errors are
  the same known MiniMax M3.1 Flash / Ornith pair as the previous two rounds.

  **Follow-up check (2026-10-23, CLI 1.87.1 → 1.87.3):** npm `latest` reached `1.87.2` (10-22T20:43Z)
  and `1.87.3` (10-22T21:30Z). Unlike the previous silent rounds these two DO carry official changelog
  entries — 1.87.2: `cmd acp` mod options, invalid reasoning-effort tolerance, the process-name re-set,
  real provider errors mid-stream; 1.87.3: Claude Code permission-mode aliases and a BYOK package
  refresh — and each is CLI-local. The artifact diff keeps endpoints (64), custom headers (5), the
  `/alpha/generate` call sites, `promptCache`, `reasoning_effort`, the registry, effort map,
  subscription tables and ZDR exception set identical (audit `cliDiff` empty in all four categories).
  The server catalog moved `catalogVersion` `501a4bf9…` → `02bfc7ac…`: the default view went 96 → 92
  while `?view=client` stays 104, because four rows went `hidden` — both dated free twins lapsed
  (`ornith/ornith-1.5-122b:free` `2026-10-22T06:00Z`, `minimax/minimax-m3.1-flash:free`
  `2026-10-22T10:45Z`) and the MiMo V2.5 pair retired (`xiaomi/mimo-v2.5`, `xiaomi/mimo-v2.5-pro`;
  MiMo V2.6 carries their promotional rate as the regular one, so this is a like-for-like replacement,
  not a temporary hide). The models docs page, the pricing page and the go/goat/pro/max plan pages drop
  the same rows plus the Xiaomi collaboration block; the ZDR page and What's New are unchanged. The
  other 88 survivors keep every capability field. Snapshot cleanup: plans 96 → 92, efforts 66 → 65,
  image 74 → 71, thinking 17 → 16, deals 8 → 4, vendored price rows 94 → 92, output-limit rows
  82 → 79; ZDR stays 18.

  **Follow-up check (2026-10-24, CLI 1.87.3 → 1.88.0):** npm `latest` reached `1.88.0`
  (10-24T02:55Z) with no changelog entry yet (the newest CLI entry is still `1.87.3`), so the
  conclusion is artifact-level: the endpoint set, custom headers, the `/alpha/generate` call site,
  `promptCache`, `reasoning_effort`, `max_tokens`, the registry fields, effort map, subscription
  tables and ZDR exception set are identical (audit `cliDiff` empty for efforts / subscriptions /
  zdrExceptions), and the only registry change is `hidden: true` on `xiaomi/mimo-v2.5` and
  `xiaomi/mimo-v2.5-pro`. The server catalog moved `catalogVersion` `02bfc7ac…` → `f41a48ed…`:
  the default view went 92 → 93 and `?view=client` 104 → 105 with exactly one added row,
  `moonshotai/Kimi-K3.1-Pro` (1,048,576 context, text + image, efforts `low`/`high`/`max`, Go
  tier, `$2/$10/$0.2`, allowance Go `$6` / GOAT `$20` / Pro `$30`, no deal, no peak schedule, no
  context tiers, ZDR covered). The models docs page, the pricing page and the go/goat/pro plan
  pages all list it, while the `1.88.0` artifact registry does not name it yet — the audit reports
  that as an `incomplete` error (`absent from CLI registry`), and the capability fields come from
  `?view=client` as usual. Snapshots: plans 92 → 93, efforts 65 → 66, image 71 → 72, vendored
  price rows 92 → 93; ZDR stays 18, output-limit rows stay 79, deals stay 4, thinking stays 16.

  **Follow-up check (2026-10-27, CLI stays 1.88.0):** npm `latest` and the official changelog still
  name no new CLI release (the newest entry is still `1.87.3`). The server catalog moved
  `catalogVersion` `f41a48ed…` → `7f405e24…`: the default view went 93 → 94 and `?view=client`
  105 → 106 with exactly one added row, `gpt-6.1-terra` (GPT-6.1 Terra) — 1,050,000 context,
  text + image, efforts `low`/`medium`/`high`/`xhigh`/`max`, Pro tier, `$1/$5` up to a 272K context
  step and `$2/$7.5` beyond (cache read `$0.05`/`$0.1`, cache write `$1.25`/`$2.5`), allowance
  Go `$6` / GOAT `$20` / Pro `$20`, ZDR covered, no deal, no peak schedule, no published output
  limit. The models docs page and the pricing page both list it; the `1.88.0` artifact registry
  does not name it yet — the audit reports `absent from CLI registry` as an `incomplete` error, and
  the capability fields come from `?view=client` as usual. Snapshots: plans 93 → 94, efforts
  66 → 67, image 72 → 73, vendored price rows 93 → 94; ZDR stays 18, output-limit rows stay 79,
  deals stay 4, thinking stays 16.

  **Follow-up check (2026-10-28, CLI 1.88.0 → 1.88.1):** npm `latest` reached `1.88.1`
  (10-27T23:06Z) with no changelog entry (the newest CLI entry is still `1.88.0`), so the conclusion
  is artifact-level: endpoint paths, custom headers, environment variables and `commandcode.ai`
  URLs form identical string sets (105 each), the `promptCache` / `reasoning_effort` /
  `max_tokens` / `cache_control` literal counts match, the `/alpha/generate` call site is identical
  once minified identifiers are masked, and subscriptions and the ZDR exception set (18) are
  unchanged. The registry now names `gpt-6.1-terra` and `moonshotai/Kimi-K3.1-Pro` — the two
  catalog-only rows above — with efforts and context equal to the snapshot, so the audit's
  `absent from CLI registry` error for them is gone. The catalog did not move (`?view=client`
  `catalogVersion` still `7f405e24…`, default 94 / client 106). The audit stays `incomplete` until the
  two known pricing aliases (`minimax/minimax-m3.1-flash` → `minimax-m3.1-flash`,
  `ornith/ornith-1.5-122b` → `ornith-1.5-122b`) are supplied via `--aliases`; with them it is
  `review-required` with no errors and an empty `candidateDiffs`. No snapshot table changed.

  **Follow-up check (2026-10-31, CLI 1.88.1 → 1.88.2):** npm `latest` reached `1.88.2`
  (10-29T02:05Z). The CLI does keep a release log after all — inside the npm package's own
  `CHANGELOG.md`, while the website changelog covers only the Desktop app — and its sole 1.88.2
  entry is "no longer crashes on launch after a fresh install or update". Artifact comparison:
  the tarball's 80 files change only in `CHANGELOG.md`, `dist/cli.mjs`, `package.json` (version)
  and the VSIX, with dependencies untouched; endpoint paths (193), custom headers (13) and
  environment variables (48) are identical sets, the `/alpha/generate` call site is identical
  once minified identifiers are masked, the `promptCache` / `reasoning_effort` / `max_tokens` /
  `cache_control` literal counts match, and `cliDiff` (registry, efforts, subscriptions, ZDR
  exceptions) is empty. The catalog did not move (`?view=client` `catalogVersion` still
  `7f405e24…`, default 94 / client 106). Every capability table is unchanged; the round's only
  data change is two allowances in `src/model-prices.ts`: `deepseek-v4.1-flash` and
  `glm-5.3-flash` both go GOAT `$80` → `$100` / Pro `$90` → `$110` (Go `$10` unchanged), while
  per-token rates and peak windows stay put. The audit reused the two verified pricing aliases
  and stayed `review-required` with no errors and an empty `candidateDiffs`.

  - `KNOWN_EFFORTS` — model → selectable reasoning-effort levels. Authoritative source is the live
    `?view=client` catalog's `reasoningEfforts` (since command-code@1.82.4 the CLI no longer keeps this map
    bundled — `getSupportedEfforts()` resolves it through the catalog, whose embedded bootstrap snapshot
    expires within days), and it is **not** the docs page (whose `Reasoning` flag means "thinks", not "has
    effort levels"). The artifact's registry rows remain a cross-check when it carries the model; a row that
    only the catalog serves (e.g. `reflection/beam:free`, the MiniMax M3.1 Flash pair) is legitimate
    catalog-side evidence, reported as an audit `incomplete` error because the released artifact predates it.
  - `KNOWN_IMAGE_MODELS` — Vision-capable models, synced from
    [commandcode.ai/docs/reference/cli/models](https://commandcode.ai/docs/reference/cli/models); note
    catalog IDs can differ from doc IDs (e.g. `claude-haiku-4-5-20251001` vs doc's `claude-haiku-4-5`).
  - `KNOWN_THINKING_MODELS` — models with `reasoning:!0` but no effort levels in the commandcode-provider table (they think automatically). Not displayed in the picker.
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`/`max`), synced from the
    pricing page's embedded per-model `availability` map — the same source the per-plan pages render, and
    more precise than reading the rendered tables, since it names each tier explicitly. **The plan pages
    themselves are NOT a reliable source since the 2026-09-30 reformat**: `/docs/plans/go|goat|pro` now emit
    a rendered `minPlanName` instead of an availability map, `/docs/plans/max` dropped its table entirely,
    and `/docs/plans/provider` became the Provider API reference. Strict superset chain; every catalog ID
    covered exactly once (re-verified at command-code@1.82.2, 2026-10-15 — the public catalog serves 90
    models: `stealth/pixel-canary` left it when 1.73.1 retired that stealth preview, `stealth/space-bunny-alpha`
    followed when 1.74.3 hid it, `mistral/mistral-large-4` joined in 1.75.0, the 1.78.0/1.79.0 pair added
    `claude-haiku-5-5` on Pro and the free `stealth/glyph-cluster:free` on Go, 1.80.0 added
    `meta/muse-wonder-1.0` on Max, 1.82.0 added `google/gemini-4-argon` on Pro, and 1.82.2 swapped the
    free `inclusionai/ling-3.1-flash:free` promo for its paid graduation `inclusionai/ling-3.1-flash` in the
    same Go slot. The retired previews above are
    Pixel Canary and Space Bunny Alpha; Glyph Cluster remains active.
    `gpt-6.1-sol` (1.71.0) was the first **`max`** member: every lower tier false, only
    `individual-max`/`individual-ultra`/`teams-pro` true; `meta/muse-wonder-1.0` (1.80.0) is the second.
    `inclusionai/ling-3.1-flash` (1.82.2; the paid graduation of the 1.70.0 free promo) is `go`.
    1.79.2 将 Haiku 5.5 的最低套餐从 Pro 下调至 GOAT，其他模型分层不变；累计可见数由
    54/63/78/86/87 变为 54/64/78/86/87，严格递增链仍成立。GOAT 套餐页明确列出 Haiku 5.5
    的 $20 月额度，Pro 页为 $30；公开目录没有新增或删除。
    1.80.0（"Add Muse Wonder"）新增 `meta/muse-wonder-1.0`，最低套餐为 Max（"Available on Max and
    above."，Go／GOAT／Pro／Provider 全部 false，仅 `individual-max`／`individual-ultra`／`teams-pro`
    为 true）；累计可见数由 54/64/78/86/87 变为 54/64/78/86/88。1.80.0 → 1.81.0 未移动任何模型分层、
    effort 档位或 ZDR 例外成员（1.81.0 的公开变更日志与包内 CHANGELOG 均未发布，结论来自产物级静态比对）。
    1.82.0（"Gemini Argon"）新增 `google/gemini-4-argon`，最低套餐为 **Pro**（`individual-go`／
    `individual-go-v1`／`individual-goat` 为 false，Pro 及以上全为 true），是 Gemini 家族首个高于 Flash
    系列分层的成员；累计可见数由 54/64/78/86/88 变为 **54/64/79/87/89**。1.81.0 → 1.82.1 未移动任何
    既有模型的分层或 effort 档位，ZDR 例外成员不变（`1.82.1` 无官方日志条目，结论同样来自产物级静态比对）。
    1.82.2（该版同样没有官方日志条目，结论来自产物级静态比对）是一次「免费转付费」换位，不新增可见模型：
    `inclusionai/ling-3.1-flash:free` 退役——CLI 把该行标为 `hidden` 并剥掉它的 effort 档位，公开目录
    （`/provider/v1/models`）与定价页双双下架——同一 Go 档位由付费的 `inclusionai/ling-3.1-flash`
    （$0.3/$0.9/$0.06，无 Vision）接管，因此累计可见数保持 54/64/79/87/89。同轮定价页新增
    `Qwen/Qwen3.8-Max-Prime`（GOAT 档、100 万上下文、Vision、$4/$12/$0.5/$5），但 **CLI 1.82.2 注册表里
    没有这个 id**（全产物搜索 `prime` 只命中会话分享函数与提示词示例）；按「能力标记必须与实际 wire 行为
    一致」，本轮**不录入任何快照族**，只在本文件记录，等 CLI 注册后再同步。
    At command-code@1.77.0 (2026-10-07) the catalog served 85 and read 53/62/76/84/85, unchanged from
    the 1.74.1 check on 2026-10-03; at
    command-code@1.73.0 (2026-10-01) it served 86 and read 54/63/77/85/86.
    The tiers the ladder now carries are `individual-{go,go-v1,goat,pro,pro-v1,provider,max,ultra}`; the
    `-v1` keys are **billing variants of their base plan** (1.69.0 moved Go to per-model credits), so a
    model served on only one of a pair still belongs to that plan, and an *absent* key means "unknown",
    never "unavailable" — conflating those two fabricates a tier. Historical verifications: re-verified at
    command-code@1.68.0, 2026-09-29 — the public catalog then served 84 models and no plan tier moved; its
    at command-code@1.66.0, 2026-09-27 — the catalog then served 82 models and no plan tier moved; its route
    mix was 65 × chat/completions + responses, 9 Claude ids × messages, 8 × chat/completions; the 1.65.0
    release added `stealth/space-bunny-alpha` on Go, 1.65.2 changed only Step 3.5 Flash's context metadata
    and the cache-write stream event, 1.65.3–1.65.5 changed no registry row at all, and 1.66.0 added
    `stealth/pixel-canary` on Go, taking the map to 52/60/74/82; re-verified at command-code@1.64.0,
    2026-09-23 — the 1.62.0 →
    1.64.0 train (1.63.0 and 1.64.0, neither with a changelog entry yet) is additive again: exactly three
    models join the map and no tier moves — `claude-opus-5-5` on Provider/Max, `gpt-6-sol` on Pro,
    `gpt-6-luna` on Go, taking it from 49/57/70/77 to 50/58/71/80; the public catalog serves 80 models (77 +
    those three), its route mix 63 × chat/completions + responses, 9 Claude ids × messages, 8 ×
    chat/completions, agreeing with the `claude-*` routing rule; re-verified at command-code@1.62.0,
    2026-09-22 — the 1.58.1–1.62.0 train is purely additive: exactly five models join the map and no tier
    moves, `xai/grok-4.7` and `xiaomi/mimo-v2.6-pro-ultraspeed` on GOAT and `stepfun/Step-5-Preview`,
    `xiaomi/mimo-v2.6-flash` and `xiaomi/mimo-v2.6-pro` on Go, taking it from 46/52/65/72 to 49/57/70/77;
    the public catalog serves 77 models (72 + those five) with `gpt-6-astra` still a CLI/pricing/docs-only
    model as before; re-verified unchanged at command-code@1.58.0, 2026-09-20 — the CLI's only registry
    change is Meituan's LongCat 2.0 promotion, so the map stays 46/52/65/72 and no tier moved, the public
    catalog still serves its 71 models with `gpt-6-astra` a CLI/pricing/docs-only model as before, and this
    is the release that catches up with the backend: it adds the paid `meituan/LongCat-2.0` and marks the
    retired `:free` sibling `hidden`; re-verified at command-code@1.57.0, 2026-09-19 — one model added on
    Go, `z-ai/glm-5.3-flashx`, taking the map to 46/52/65/72, and the same check caught the backend ending
    Meituan's LongCat 2.0 promo: the catalog renamed `meituan/LongCat-2.0:free` to the paid
    `meituan/LongCat-2.0`, which keeps the Go slot while the then-current command-code@1.57.0 CLI registry
    still carried the retired id, one release behind (1.58.0 followed it); no tier moved, and the public
    catalog now serves 71 models with `gpt-6-astra` still a CLI/pricing/docs-only model as before;
    re-verified at command-code@1.56.0, 2026-09-18 — one model added on Go, `Qwen/Qwen3.8-Omni-Flash`,
    taking the map to 45/51/64/71; no tier moved, and the public catalog served 70 models with `gpt-6-astra`
    still a CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.54.0, 2026-09-15
    — no tier moved, and the public catalog still serves its 69 models with `gpt-6-astra` a
    CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.53.1, 2026-09-12 — no
    tier moved; 44/50/63/70 as of 2026-09-10, command-code@1.53.0 — 1.53.0 added
    `deepseek/deepseek-v4.1-flash` on Go; 1.52.0 added the free `inclusionai/ling-3.0-flash-sante:free` on
    Go; re-verified unchanged from 1.49.0, which added `gpt-6-astra` on Provider/Max; 1.48.0 added `max`
    effort to Muse Spark 1.3; 46/52/65/71 as of 2026-09-04, command-code@1.47.0 — 1.41.0 added
    `Qwen/Qwen3.8-Max-0902` on Go, 1.42.0 added `meituan/LongCat-2.0:free` on Go, 1.43.0 added
    `google/gemini-3.8-flash` on GOAT, 1.44.0 added `meta/muse-spark-1.3` on GOAT + its Contributor sibling
    on Go; 43/47/60/66 at command-code@1.40.1 — `claude-fable-5-1` joined Provider/Max after 1.40.0 shipped
    it on the Provider API (the alpha.5 note that it was Anthropic-OAuth-only was wrong); 43/46/59/64 at
    1.40.1 before that fix; `deepseek/deepseek-v4-flash-fast` joined Go in 1.39.0; 1.39.2 retired
    `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` and the upstream catalog renamed `tencent/Hy3`
    to `tencent/hy3-paid` (the hidden free variant); `inclusionai/ling-3.0-flash-free` was removed when its
    free promo ended 2026-08-03; 40/44/57/62 at 1.37.0 — `tencent/hy4-preview` joined Go (routed through
    OpenRouter); 39/43/56/61 as of 2026-08-27, command-code@1.36.0 — `Qwen/Qwen3.8-Flash` +
    `z-ai/glm-5.3-flash` joined Go and `stealth/ox-alpha` left when its preview ended in 1.34.0; 38/40/53/60
    as of 2026-08-26, command-code@1.33.0 — the `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free`
    promo variants joined Go; 36/40/53/58 at 1.32.2 when `deepseek/deepseek-v4-flash-vision-exp` joined Go
    in 1.32.0; 35/39/52/57 at 1.31.0 when `stealth/ox-alpha` joined Go; 34/38/51/56 at 1.28.4).
  - `KNOWN_SUBSCRIPTION_PLANS` — subscription `planId` prefix → `{ name, monthlyCredits, tierWeight }` for
    the account's own plan (from `/alpha/billing/subscriptions`), synced from the CLI bundle's plan maps
    (minified variable names change per release — locate them by the `"individual-go"` key; `tierWeight` is
    plugin-added for the picker filter). `subscriptionPlanInfo()` mirrors the CLI's `getPlanInfo`
    longest-prefix matching. Distinct from `KNOWN_PLANS` (model → minimum tier).
  - Per-model monthly allowance — catalog ID → `{ go?, goat, pro }` USD per MONTH, from the pricing page's
    `planAllowanceUsd`. It lives in `src/model-prices.ts` beside the price rows (same JSON record, same
    slug resolution) and is read through `modelAllowanceFor()`; 2026-09-30 已按官网支持 Go、GOAT、Pro。
    零值展示为零，旧来源缺少 Go 时不猜测；额度与 Provider API 权限独立。
    同步入口遇到未知维度、无效额度或交叉校验失败会阻止生成与写入，保留旧快照。
    `ling-3.1-flash`（1.82.2 新增行）的定价记录另带一个**尚未生效**的 `planBudgetSteps`：
    `2026-10-15T12:30:00Z`（北京时间 20:30）起 GOAT／Pro 由 $20／$30 上调至 $100／$110，Go 保持 $6。
    生成器只写页面**当前**值，因此该时刻之后重跑 `--check` 会报额度漂移——这是预期行为，不是缺陷。
    See [usage and cost](usage-and-cost.md) for how the settings page picks the
    bracket from the account pool.
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`.
    **Expiry-aware, badge AND dollars**: `dealLabel()` hides a deal once `Date.now()` passes its
    `expiresAt`, so an un-updated plugin never shows a lapsed discount — and `modelPriceTable(now)` falls
    the row back to its pre-discount `listRates` on that same instant, so the composer cannot price a
    session at a rate the provider has stopped charging. A deal with no `expiresAt` never lapses and keeps
    its promotional rates forever (MiniMax M3; the two MiMo V2.5 rows that shared the rule left the
    catalog on 2026-10-23). The first dated FREE row arrived on
    2026-10-20 (`minimax/minimax-m3.1-flash:free`, ends `2026-10-21T10:45Z`): `dealLabel()` drops the badge
    at that instant while the `:free` id stays zero-priced by id suffix — `isFreeModel()` deliberately does
    not read the clock (a free SKU normally leaves the catalog when its window closes). Both dated FREE
    rows took exactly that path on 2026-10-23: `minimax/minimax-m3.1-flash:free` and
    `ornith/ornith-1.5-122b:free` went `hidden` and left the default catalog view, the pricing page and
    the models docs page, so the badge map no longer carries either.
  - `KNOWN_PEAK_PRICING` — catalog IDs with hourly (peak/off-peak) pricing, synced from the pricing page's
    **embedded model JSON `timeOfDay` blocks** (never the rendered row text — see the skill). Exactly five
    models as of 2026-09-29: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`,
    `deepseek/deepseek-v4-flash-vision-exp`, `deepseek/deepseek-v4.1-flash` (added in command-code@1.53.0 at
    $0.15/$0.60 off-peak, $0.30/$1.20 peak, same schedule) and `deepseek/deepseek-v4.1-flash-fast`
    (command-code@1.67.0; the same 01–04 & 06–10 UTC Mon–Fri windows and the same 2026-08-16T16:00Z
    effective date, but its own $0.16/$0.58/$0.016 off-peak and $0.32/$1.16/$0.032 peak — deliberately NOT
    2× its sibling's rates, so only that row's own `timeOfDay` block is the evidence);
    `deepseek/deepseek-v4-flash-fast` is flat-priced
    ($0.28/$0.56/$0.07) and must stay out. Peak windows live in `PEAK_HOUR_RANGES` (UTC, end-exclusive) and
    apply **Monday–Friday only** — the official rule charges Saturday/Sunday completely off-peak for all 24
    hours — so `peakPricingState()`/`peakPricingLabel()` map the current UTC **weekday+hour** to
    `Peak`/`Half` (35 peak hours per week, 7 per weekday, 0 on weekends).
  - `MODEL_OUTPUT_TOKEN_LIMITS` — catalog ID → the `max_tokens` ceiling the endpoint will accept, which
    `/provider/v1/models` does not publish (it carries `context_length` and `supported_endpoints` only).
    **Generated by `scripts/sync-output-limits.mjs` from models.dev — do not hand-edit the table**
    **itself** (for the one deliberate exception see the `MANUAL_CEILINGS` note below); run it, and use `--check` in CI. Command Code resells these models through their **vendor's own API**, so the vendor's
    published ceiling is what gets recorded. Resolution order: the vendor's own catalog entry (matched on
    the normalized id tail — Command Code namespaces the id, the vendor does not), the same entry with a
    `free` suffix dropped (both spellings occur: `inclusionai/ling-3.0-flash-sante:free` and
    `poolside/laguna-s-2.1-free`), then unanimity across every provider carrying the id.
    **Re-verified at command-code@1.82.2 (2026-10-15): 76 of 89 ids are recorded, 13 left to the runtime.**
    Each row carries a comment naming its source entry, and the ten `claude-*` ids resolve to Anthropic's
    128 000 (except `claude-haiku-4-5-20251001` at 64 000, which is what `DEFAULT_MESSAGES_MAX_TOKENS`
    already guessed for the whole family — now confirmed rather than assumed). `google/gemini-4-argon`
    (1.82.0) resolved from models.dev's own `google` row at 32 768.
    The 13 unlisted ids are ones models.dev either lacks entirely or files inconsistently across providers
    (`Qwen/Qwen3.8-27B`, `Qwen/Qwen3.8-Max-0902`, `deepseek/deepseek-v4.1-flash`,
    `deepseek/deepseek-v4.1-flash-fast`, `deepseek/deepseek-v4-flash-fast`, `inclusionai/ling-3.1-flash`,
    `mistral/mistral-large-4`,
    `moonshotai/Kimi-K2.5`, `stealth/glyph-cluster:free`, `tencent/hy3-paid`, `tencent/hy4-preview`,
    `thinkingmachines/inkling-small`, `zai-org/GLM-5.2-Fast`),
    and they are served by the runtime instead: `streamRequest()` reads the ceiling off the endpoint's own
    refusal, retries once, and keeps it (issue #71). **That path is also what corrects a vendor figure the
    gateway turns out to be stricter than**, which is why an over-generous entry is tolerable and a
    conservative guess is not — a wrong-high ceiling costs one round trip, a wrong-low one halves every
    answer for as long as the table stands. Runtime-learned and catalog-published ceilings are keyed by
    `apiBase` plus model id; the vendor snapshot is the only gateway-independent fallback. A live catalog
    refresh replaces that gateway's published values, including removal of fields no longer present.
    Two arrivals are worth naming because neither came from a vendor lookup alone. `gpt-6.1-sol` is
    128 000 from OpenAI's own row, corroborated by all seven other providers carrying it.
    `inclusionai/ling-3.0-flash-sante:free` has **no vendor row and lost its unanimous third-party vote**
    (vercel files 32 000 against three providers at 32 768) — 32 768 is the Ling family's established
    ceiling, the figure every other provider carrying a Ling row publishes — so it is recorded in the
    script's **`MANUAL_CEILINGS`** map rather than left to start at `DEFAULT_MESSAGES_MAX_TOKENS`. Its
    `ling-3.1-flash:free` successor carried the same hand-recorded 32 768 until command-code@1.82.2 retired
    that promo; the paid `ling-3.1-flash` files three conflicting provider values, so it is deliberately
    left to runtime learning instead of being pinned to a guess. That map is the sanctioned way to hand-record a ceiling a
    rewrite would otherwise drop: keyed by id, each entry names the evidence it rests on, and it is
    consulted *before* the vendor lookup so `--check` stays clean. Use it only for a documented
    inference resting on uniform family-wide data — never to paper over a split vote, which is what the
    "learn it at runtime" path exists for.
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal ·
    peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context
    (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce
    "Text only" or "Supports image input".
  - **自定义上下文长度（issue #86）**：`resolveModel()` 与 `listModels()` 宣告的窗口是
    `effectiveContextWindow(catalog, model, connection)`——`contextWindowOverrides`（按模型）→
    `contextWindow`（全局）→ 目录 `context_length`——选择器标注与宿主的 `context.contextWindow`
    用同一个值；`defaultMaxTokens` 与实际请求都经 `catalogModelMaxTokens()` 按有效窗口重新推导，
    不能复用已经受旧目录窗口限制的 `entry.maxTokens`。公布输出上限取本次独立目录记录的
    `publishedMaxTokens`，缺失时取模型快照或协议默认上限，再取同网关更低学习上限及
    `DEFAULT_GENERATE_MAX_TOKENS`；显式请求值还会进一步取小。等待凭据、轮换和重试不会转读
    并发刷新后的目录。无目录条目的未知模型保持无 `context` 宣告及原有预算行为。
    自定义值必须为边界内整数：配置校验拒绝坏值，`src/context-window.ts` 与设置页共用清洗；
    适配器对绕过配置校验的程序化值仍二次判定，按有效全局值、目录依次回落。
  - The picker list is **sorted free models first, then by plan tier, then name** (`compareByPlan()` in
    `src/capabilities.ts`; free = `KNOWN_DEALS` `free: true` via `isFreeModel()`, tier weights in
    `PLAN_ORDER`): FREE → Go → GOAT → Pro → Provider → Max, alphabetical within each group, unknown plans
    last. Keep this order when changing `listModels()`. `formatContext()` renders sub-1K windows raw (never
    `"0K"`).
  - The picker also **hides models above the account's subscription tier** (`modelVisibleInPlan()`, on by
    default via `filterModelsByPlan`): the billing facts mirror the CLI's `createBilling` flow — whoami →
    orgId, then `/alpha/billing/subscriptions` (planId, honored only for `active`/`trialing`/`past_due`
    statuses) and `/alpha/billing/credits` (on-demand balances; its `credits.planId` is the fallback when
    subscriptions fails) — cached for `BILLING_ACCESS_TTL_MS`. The filter **fails open** everywhere
    (endpoint failure, unknown plan, unknown model) and is **bypassed by any positive on-demand balance**
    (`purchasedCredits + freeCredits > 0`) — mirroring the CLI's `evaluateModelAccess`. The catalog itself
    is never filtered; `resolveModel` still serves every model and the server remains the final gate. **With
    a pool, the question is asked of EVERY account** (`modelVisibleForAnyAccount()`, fed by the optional
    `resolveAccountKeys` seam the plugin entry implements from `pool.resolvedAccounts()`): a model is hidden
    only when no account can run it, because the POOL serves a request and not whichever account rotation
    happens to be on. Keying the filter on the serving account made the picker's contents change as accounts
    rotated (issue #51's follow-up: 《卡片会切换》) and hid models the user's other accounts could run — a model no
    request could ever reach. The union is only coherent together with the entitlement rotation in the
    connect loop (a model offered because SOME account includes it is served by that account after at most
    one rejected attempt), and it costs three requests per account per TTL, cached per key exactly like the
    single-account path (an unknown account counts as 'may include it', the same fail-open rule, and a host
    without the seam falls back to the serving key).
  - **Reading the catalog never blocks on the network once this process has FETCHED it.** `listModels()` asks
    `GatewayFacts.loaded()` for rows this process successfully fetched; only a source that never completed a
    network refresh awaits `refresh()`. A warm source refreshes in the background for the NEXT open. The
    source matters, not just "rows in memory": `snapshot()` loads the on-disk cache into the SAME state for
    the generation path, and that disk copy carries no age check — serving it as a first paint would draw a
    catalog of unknown vintage. An empty row set (a failed refresh inside its retry window) is not warm data
    either; it falls back to `refresh()` instead of painting an empty picker. `resolveModel()` and `stream()`
    still await a real refresh — they must not route on a guess.
  - **The picker and the usage card share the account endpoints.** `getUsage()` and `fetchBillingAccess()`
    both read `/alpha/whoami`, then credits + subscriptions in parallel, for the same key. Successful
    responses are memoized per `[apiBase, key, exact URL]` for `ACCOUNT_FACTS_TTL_MS` (30 s), so whichever
    surface asked last pays for the duplicate. Only successes are shared — a failed endpoint must be retried
    rather than replayed, or the report's `failures` and `classifyTotalFailure` verdict would describe a
    request this process never made. `/alpha/usage/summary` is deliberately NOT shared (`share: false`): its
    numbers are what the card displays next to a read timestamp, so replaying an earlier answer would
    misreport both. The two URL shapes differ (`orgId` is added by `getUsage()`'s scoped path), so a `credits`
    read is only ever reused by the surface asking with the identical query.
  - The picker also supports a **visible-model allowlist** (`Config.visibleModels: string[]`, the settings
    page's Visible models card): a non-empty list narrows `listModels()` to those catalog ids AFTER the plan
    filter; empty/unset shows everything. It never gates named requests (`resolveModel` still serves every
    model). The allowlist is staged through `visibleModelsDraft` in `src/client/settings.ts` (its own
    draft/dirty/plan/write/reconcile path, one atomic `visibleModels` + `modelVisibility` mutation) and cleaned of non-strings/blanks at
    both ends (`storedAllowlist()` + `resolveAdapterOptions`). 网页按目录、白名单与逐模型开关
    投影实际选择，保存覆盖当前、用户层与基础层的已知开关；显示全部不保留旧隐藏项。
    目录缺失或失败保留旧选择；版本冲突保留草稿。 `listModels(provider, { unfiltered: true
    })` skips BOTH filters so the `commandcode/models` Remote always serves the full catalog to the page
    editors; the adapter override stays signature-compatible with the base (`_provider` only) via the
    optional second param. `tests/adapter.test.ts` pins the narrowing + unfiltered paths;
    `tests/settings.test.ts` pins the controller staging.
  - **`Config.modelVisibility: Record<string, boolean>`** is the terminal page's per-model override layer
    over that array: an id present decides its own model (`true` listed, `false` hidden), an id absent keeps
    following `visibleModels` exactly as before, and the plan filter still applies on top. It exists because
    of a hard dsh-TUI constraint, not a preference: the seam's only control for a per-model list is a
    `boolean` field, and the host keys a staged draft by the field's PATH (`fieldKey` in its
    `settingsEditor.ts`) — so N checkboxes sharing the `visibleModels` path share ONE draft, every one of
    them parses it in `save()`, all N write ops address the same path, and **only the last field's op
    survives**. That silently rewrote the allowlist from the last catalog model instead of the row the user
    toggled (found by driving the real `SettingsForm` over the section). A map gives every checkbox a path
    of its own. 终端保存显式布尔值，避免清除用户层后重新继承相反开关；
    网页和适配器共用 `modelIsVisible()`，终端保留每个模型的独立路径。`readModelVisibility()` drops non-boolean
    entries, so a hand-edited document falls back to the array instead of hiding a model.
    `tests/tui-settings.test.ts` pins the unique-path invariant (a regression test for that bug) and the
    override semantics; `tests/adapter.test.ts` pins the resolution order.
  - The settings page's model editors share one dropdown (`ModelMultiSelect` in `src/client/section.tsx`
    over React-free helpers in `src/client/model-select.ts`, pinned by `tests/model-select.test.ts`): a
    search box filters by id/display-name substring (blank = all), entries group under plan-tier headings,
    stale selections (retired upstream) render flagged with a one-click cleanup on the Visible models card
    (never auto-dropped — an empty catalog from a fetch failure must not wipe the list). Tier headings ride
    the `commandcode/models` Remote per entry (`CommandCodeCatalogModel.tier`, stamped Host-side from
    `KNOWN_PLANS`; optional on the wire for older Hosts, shaped defensively in `refreshCatalog()`), because
    the client bundle cannot import `src/capabilities.ts` — when upstream adds a plan tier, extend BOTH the
    Host snapshot and the vendored `TIER_HEADINGS` in `model-select.ts`. The client-bundle constraint
    (platform/seed modules only, see the tsdown `external` list) is why the tier travels on the wire instead
    of an import.
