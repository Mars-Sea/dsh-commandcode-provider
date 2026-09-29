# Model capabilities and upstream snapshots

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **Static capability snapshots** (all in `src/capabilities.ts`, synced from official sources — see the
  `dsh-commandcode-upstream` skill for the exact extraction procedures; `src/adapter.ts` imports them and
  keeps only stable wire/runtime logic):
  - `KNOWN_EFFORTS` — model → selectable reasoning-effort levels. Authoritative source is the CLI bundle's
    commandcode-provider model table (`command-code/dist/cli.mjs`; minified table/variable names change per
    release — locate it by the `reasoningEfforts` feature, see the skill), **not** the docs page (whose
    `Reasoning` flag means "thinks", not "has effort levels").
  - `KNOWN_IMAGE_MODELS` — Vision-capable models, synced from
    [commandcode.ai/docs/reference/cli/models](https://commandcode.ai/docs/reference/cli/models); note
    catalog IDs can differ from doc IDs (e.g. `claude-haiku-4-5-20251001` vs doc's `claude-haiku-4-5`).
  - `KNOWN_THINKING_MODELS` — models with `reasoning:!0` but no effort levels in the commandcode-provider table (they think automatically). Not displayed in the picker.
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`), synced from the plan
    pages ([go](https://commandcode.ai/docs/plans/go) ⊂ [goat](https://commandcode.ai/docs/plans/goat) ⊂
    [pro](https://commandcode.ai/docs/plans/pro) ⊂ provider/max). Strict superset chain; every catalog ID
    covered exactly once (re-verified at command-code@1.68.0, 2026-09-29 — the public catalog now serves 84
    models and no plan tier moves; its route mix is 66 × chat/completions + responses, 10 Claude ids ×
    messages, 8 × chat/completions, still agreeing with the `claude-*` routing rule. 1.67.0 adds
    `deepseek/deepseek-v4.1-flash-fast` on Go and 1.68.0 adds `claude-sonnet-5-5` on GOAT, taking the map to
    53/62/76/84 — additions only, so the superset chain still holds; neither release touched a routing rule,
    a subscription map or the ZDR anchors beyond the new row). Historical verifications: re-verified
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
  - Per-model monthly allowance — catalog ID → `{ goat, pro }` USD per MONTH, from the pricing page's
    `planAllowanceUsd`. It lives in `src/model-prices.ts` beside the price rows (same JSON record, same
    slug resolution) and is read through `modelAllowanceFor()`; the page publishes it for **GOAT and Pro
    only**, so `allowanceTierForWeight()` answers `undefined` for Go / Provider / Max / Ultra instead of a
    neighbouring tier's figure. See [usage and cost](usage-and-cost.md) for how the settings page picks the
    bracket from the account pool.
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`.
    **Expiry-aware, badge AND dollars**: `dealLabel()` hides a deal once `Date.now()` passes its
    `expiresAt`, so an un-updated plugin never shows a lapsed discount — and `modelPriceTable(now)` falls
    the row back to its pre-discount `listRates` on that same instant, so the composer cannot price a
    session at a rate the provider has stopped charging. A deal with no `expiresAt` never lapses and keeps
    its promotional rates forever (the two MiMo rows, MiniMax M3).
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
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal ·
    peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context
    (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce
    "Text only" or "Supports image input".
  - The picker list is **sorted free models first, then by plan tier, then name** (`compareByPlan()` in
    `src/capabilities.ts`; free = `KNOWN_DEALS` `free: true` via `isFreeModel()`, tier weights in
    `PLAN_ORDER`): FREE → Go → GOAT → Pro → Provider/Max, alphabetical within each group, unknown plans
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
  - The picker also supports a **visible-model allowlist** (`Config.visibleModels: string[]`, the settings
    page's Visible models card): a non-empty list narrows `listModels()` to those catalog ids AFTER the plan
    filter; empty/unset shows everything. It never gates named requests (`resolveModel` still serves every
    model). The allowlist is staged through `visibleModelsDraft` in `src/client/settings.ts` (its own
    draft/dirty/plan/write/reconcile path, one `visibleModels` write) and cleaned of non-strings/blanks at
    both ends (`storedVisibleModels()` + `resolveAdapterOptions`). `listModels(provider, { unfiltered: true
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
    of its own. The TUI stages an override only when it DISAGREES with the array (otherwise a `clear`), so
    toggling back to the inherited state leaves no residue; `readModelVisibility()` drops non-boolean
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
