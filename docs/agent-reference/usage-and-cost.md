# Usage, prices, and session cost

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **官方账期汇总**：`getUsage()` 先读取账号组织，再按同一 `orgId`（组织标识）并行读取余额和订阅，最后以订阅原始 `currentPeriodStart`（账期起点）作为 `since`（统计起点）读取汇总。订阅失败时汇总独立降级，不补本地自然月。严格远端可选保留汇总 `periodStart` 与订阅 `currentPeriodStart`；只有两者相等且截止日有效时，设置页和额度面板展示完整官方账期；否则额度面板提示周期未确认，设置页退回订阅截止日。请求数采用 `totalCount`（请求总数），成功和失败另列。官网三条 `/internal/usage*` 明细接口用浏览器登录会话；2026-10-14 同一真实账号的既有密钥查询全部返回 401，未新增浏览器凭据读取。接口盘点、验证与边界见[官方账期用量](../官方账期用量.md)。

模型历史分析（问题 #79）：`src/analytics.ts` 按逐请求时间与上下文折叠，不使用已合并的会话费用桶；`src/analytics-history.ts` 可选绑定 `sessionQuery.listSessions/readSession`，包含关闭会话、排除分支继承用量，每次限 500 会话和 200000 事件。`src/analytics-wire.ts` 提供双方共享严格远端，浏览器只收到汇总数字与能力；设置页和既有面板均可打开，不依赖额度卡片开关、不轮询历史。试算固定原词元与时间，不能推断换模型后的缓存、输出或质量。成本按当前价，不是账单或积分；只有完整且全部计价的至少一天日期范围才折算 30 天成本。全部接口、文档盘点与验证边界见 [实现说明](../模型成本与性能分析.md)。

- **账号报告来源**：一次报告固定入口捕获的连接、账号列表与固定账号，窗口探测与所有账号的用量请求使用同一网关。先完成账号池共享恢复，再读取健康标记，避免已恢复账号继续展示探测前的旧状态；不同网关的同一密钥不共享健康或探测节流。
- **账号响应诊断（问题 #76）**：收到成功状态后分别读取正文、解析 JSON 和校验顶层对象；`failures` 详情区分读取超时／中断、解析失败与结构不符，整组失败仍沿用 `invalid-response`（响应不可用），不扩展严格远端枚举。诊断只保留白名单异常名称、错误码和内容类型／编码，不保存正文、原异常消息或任意响应头。响应头仅是线索，不能据此强制再次解压已解码的正文。设置页、用量面板和命令提示均不再把所有失败归因于代理或解压；真实问题根因仍待反馈者环境验证。见[问题 #76 修复说明](../issue-76-response-review.md)。
- **传输失败的目标与原因（问题 #111）**：网络层失败在原文后追加中文原因与目标 `scheme://host:port`，由 `src/transport-failure.ts` 从 fetch 的 `error.cause`（含 AggregateError 子项）取错误码映射，原始码入括号（`ECONNREFUSED` →「连接被拒绝（ECONNREFUSED）」；未知码回显「网络错误（<code>）」；无码不猜）。目标只保留协议、主机与端口，路径与查询丢弃，反代前缀或凭据不会因此回显。HTTP 状态失败（有响应）不重复附目标。

- **Plans & quota panel + composer session cost (ported from PR #36)**: two
  client surfaces using Host usage and durable request-cost facts. (1) The sidebar footer
  card (`sidebar.footer.action`, order 1 — directly above Settings) and the
  dashboard it opens in the layout's keyed `main` slot both render one
  projection, `buildPanelView()` in `src/client/panel.ts`: plan, the 5-hour and
  weekly windows with their own spend/limits, monthly credits derived the CLI's
  way (`limit - remaining`), and the purchased/free balances. The projections
  fetch nothing themselves: both read the usage controller's snapshot, and
  `startPanelAutoRefresh()` is a refcounted 2-minute tick that calls
  `usage.refresh()` while mounted. The Host report determines configuration,
  including composition literals and CLI-auth fallback; browser credential
  references must never gate this read. Unreported credit fields stay dashes.
  **The sidebar card is OPT-IN** (`Config.showSidebarQuota`, default false, the
  settings page's Integrations & display toggle): `CommandCodeFooterEntry` gates its own
  RENDER on the controller's STORED fact (`SettingsPageState.sidebarQuota`,
  `sectionValue('showSidebarQuota') === true` — never the form's staged draft,
  which would outlive a discarded edit) and starts no auto-refresh while
  hidden. The entry stays REGISTERED, so a landed save shows/hides the card
  live with no slot-ledger churn, while a fresh install renders no card, no
  rail icon and runs no poll. The dashboard `main` cell is unaffected, so with
  the card hidden it simply has no trigger. Never move that gate into
  `slots.inject`: a registration-time switch cannot follow a settings change
  without a re-register dance.
  **The dashboard must stay escapable** (issue #41): the `main` cell occupies
  the center column in place of the Conversation and `open()` is the only other
  panel selection this plugin makes, so `panelFace` also carries `close()` —
  wired to the dashboard header's `×` button (an icon-sized control whose
  accessible name and tooltip carry the words) — as
  `ctx.layout.selectPanel(null)` ("show the Conversation", current Session
  untouched), falling back to the reserved `conversation` main key on a layout
  whose `selectPanel` predates that `null` form. Both calls go through the same
  reflective `ctx.get('layout')` seam and are contained; never let the panel
  become a one-way door.
  (2) The composer readout (`conversation.composer.dock`, id
  `commandcode-session-cost` — never the shipped `stats` id, which would REPLACE
  the harness's token/cache-hit/throughput cell) renders NO surface of its own:
  `src/client/session-cost-display.ts` injects the amount into the shipped pill
  and a price per row into the shipped usage dialog, matched POSITIONALLY (the
  labels are the `chat` locale's, so they are never read) and confirmed by the
  token count each row must be showing. **The pill's scope is the OUTLET, and
  its row marker is a PREFERENCE.** `data-composer-stats` is NOT present on
  0.2.1-alpha.1 — upstream deleted it a second time (the first was
  0.1.6-alpha.2), this time by splitting the single `StatsPills` component into
  two independent dock entries (`activity` at order 0, `usage` at order 1) so
  each pill lost the shared row wrapper that attribute named. So `STATS_ROOT` no
  longer narrows anything and the lookup takes its dock-outlet fallback
  (`[data-slot="conversation.composer.dock"]`, a `display:contents` div holding
  exactly that slot's entries: the shipped `activity`/`usage` cells and ours).
  That fallback stays correct because both pills keep `aria-haspopup="dialog"`
  on their trigger button and `data-session-stats-usage` remains unique to the
  token dialog, so "last trigger wins" still selects the usage pill.
  The fallback
  is the outlet and NEVER the outlet's parent, because the parent is the
  composer footer, which also holds the `ContextMeter`, whose
  trigger is itself a `button[aria-haspopup="dialog"]` rendered AFTER the dock:
  a parent-scoped "last trigger wins" would append the cost to the context ring
  instead of the token pill. The DIALOG's document-level lookup keeps the
  one-composer assumption in check — a second composer (an embedded Conversation
  in the sidebar, so a second composer (its own session, dock and dialog) can be
  live and open at once, and a portaled dialog carries no id or `aria-controls`
  tying it back to its trigger. `resolveDialog()` therefore decorates only while
  the document holds EXACTLY ONE `[data-session-stats-usage]`; ambiguity is
  answered by declining, the same rule the shape check already follows one level
  down. `tests/session-cost-display.test.ts` fences all of it: the unmarked
  0.1.6-alpha.2 row, an outlet whose footer sibling is a `ContextMeter` that must
  NOT be the host, and two open dialogs that must both stay unpriced until only
  one remains. That suite's earlier form built its own marked row and treated a
  missing anchor as an acceptable no-op, which is exactly why the alpha.2
  deletion could go dark with every check green. `buildSessionCostView()` owns every
  number and string: it prices only `commandcode` sessions, never invents a
  cache-write rate the pricing page omits (those tokens are reported as
  unpriced and the total stays a floor), and returns `undefined` — no pill at
  all — for no usage, no table, an unknown model, all-zero buckets, or a session
  whose EVERY billed token is unpriced (the guard is "unpriced tokens and no
  priced spend", never "the total rounds to zero": a real sub-cent session keeps
  its `<$0.0001` bound). The dialog row for cache-write tokens is hidden only
  when their rate is missing; when it is published the row stays, because its
  cost is already inside the total and hiding it makes the rows unable to
  explain the figure above them. **Locale split, do not blur it**: the PANEL
  follows the harness language (both panel registrations declare
  `locale: PANEL_LOCALE_NS` = `panel.commandcode`, registered in `apply` from
  `PANEL_COPY_ZH`/`PANEL_COPY_EN`, and the bound `t` seat is passed into
  `buildPanelView({ …, t })` — every label, status word and the footer tooltip
  is composed through it, so a translator that only reached `view.text` would
  leave half the surface English; a language switch mints a new `t` identity,
  which is what re-renders the memoized surfaces). The COMPOSER session-cost
  readout stays English by construction (`SESSION_COST_COPY`) rather than
  through `ctx.locale`; that is a deliberate, documented limitation, and
  `tests/panel.test.ts` pins the panel's zh/en resolution plus dictionary
  key parity.
  **The footer card is gated on the `layout` SERVICE, not on a slot.** An
  ungated `slots.inject` would render a card that silently does nothing when
  clicked on a profile whose `main` declaration exists but whose layout never
  mounted (a headless client), so the registration rides
  `ctx.inject(['layout'], …)` (`src/client/index.ts`); the dashboard cell needs
  no gate because registering against an undeclared slot is a no-op by
  construction. `tests/client-boot.test.ts` pins this by modelling the
  declaration set and the layout service separately.
  The three slot declarations are re-stated locally
  (`panel-slots.ts`, `session-cost-slots.ts`) and must stay structurally
  identical to upstream's, exactly like the Models-card merge in `card.tsx`.
  **The injected stylesheets are GLOBAL CSS, so containment is a contract**
  (issue #48): every rule in `page-styles.ts` / `panel-styles.ts` is qualified
  by one of our own `cc-`/`ccp-` classes, and the ONE foreign selector — the
  rule that forces the sidebar's footer-action container into a column so this
  full-width card and ui-cordis's chip stack instead of overflowing a row — is
  ANCHORED to the sidebar's own `footArea` stem. That anchor is load-bearing,
  not decoration: `footerActions` is declared by
  `@deepseek-ai/dsh-client-ui-user-questions` as well (the ask-user-question
  dialog's button row, `Mbwy4a_footerActions`), so the unanchored
  `[class*="_footerActions"]` this started as reached into that dialog and
  stacked its side-by-side buttons on every page. `footArea` belongs to
  dsh-client-ui-sidebar alone (audited across every client bundle of the
  0.1.6-alpha.1 engine, together with our own class names, which collide with
  no engine class). `tests/styles.test.ts` enforces it in two layers — a
  structural audit (every selector compound is ours, or descends from one of
  ours, or is a documented anchor, and the shared stem may only appear beside
  its region anchor) and a simulation against the real foreign class stems (the
  dialog's row is not matched, the sidebar's still is) — so a new rule that
  reaches outside our markup fails the suite instead of shipping.
- **Durable session cost facts** (`src/cost-projection.ts`): optional reflective
  `sessionProjections` registration folds `request/header` model selection and
  `step/start` / `llm/retry-started` timestamps alongside v1 usage chunks and v2
  assistant message/attempt stream settlements. Samples replace within an
  attempt; retries add. Rate-equivalent requests aggregate into bounded groups,
  using all prompt token buckets for each request's context tier. The pricing
  fingerprint versions checkpoints and guards the client table; schema/fold
  changes must bump the fingerprint seed. Restoring/forking uses the Host log,
  not browser memory. Match all buckets against `tokenUsage` before decorating.
  Never price cumulative usage with `modelSelection.lastUsed` or current time.
  Missing projection means hidden cost; missing rates/other-provider usage
  produce a labeled subtotal. Published-rate estimates are not provider invoices.
  **KNOWN LIMITATION — one fold rule cannot serve both log generations.** The
  replacement semantics here are the 0.1.5 token-meter's (`llm/retry-started`
  closes the replacement slot, so a retried attempt ADDS). The 0.1.2/0.1.3-era
  fold instead replaced on `(turn, step)` alone and never handled that event.
  A transport that folds that way therefore disagrees with the Host projection by
  the retried attempt's tokens, and because the client requires per-bucket
  EQUALITY against `tokenUsage` (`src/client/session-cost.ts`), a session that
  retried there loses the readout entirely rather than showing a wrong figure.
  Retries are routine on this route (confirmed 429 windows can wait for recovery;
  other transient failures have bounded budgets),
  so this is a real gap, not a theoretical one. Closing it means recording which
  fold rule wrote a group. Until then, do NOT "fix" the equality gate by
  loosening it: that gate is what keeps a mismatched fold from being priced.
- **Settings usage card availability** (`usageCardState()` in
  `src/client/usage.ts`): the card's auto-fetch, refresh button and "no key"
  hint derive from the HOST report's `entry.configured`, never from a browser
  credential reference. A composition literal (`Config.apiKey`) is a stripped
  secret and the official CLI auth file is not in the credentials store, so both
  are invisible to the browser while the Host happily serves requests with them
  — `state.anyAccountConfigured` must not gate this card or the post-save
  refresh trigger (`src/client/index.ts`). `shouldRefresh` is true only in
  `status === 'idle'`, so a failed fetch never becomes an automatic request
  loop, and the button stays enabled for a manual retry.
- **Per-model allowance (same rows, different unit)**: each price row also
  carries the page's `planAllowanceUsd` as `allowance: { go?, goat, pro }` — dollars
  per MONTH, not per million tokens, so it never enters the price table.
  `modelAllowanceFor(catalogId)` resolves it through the same slug rules the
  prices use. 2026-10-09 复核 command-code@1.79.2 与官网：Haiku 5.5 的 Pro 月额度
  $20 → $30（GOAT 保持 $20）；Kimi K3 的 GOAT／Pro 月额度 $60／$70 → $20／$30。
  Sonnet 5.5 缓存读取单价 $0.20 → $0.10/百万词元，其余费率不变。定价页与 GOAT／Pro 页交叉确认。
  零额度仍显示零；缺失额度不补邻档数字，套餐额度不授予 Provider API 权限。
  同步脚本遇到未知字段、无效额度或双来源不一致时拒绝生成和写入。
  `allowanceTierForWeight()` maps a subscription tier
  weight onto those three brackets and answers `undefined` for Provider / Max
  / Ultra rather than a neighbouring tier's figure. The Host picks the bracket
  from the POOL's highest plan (`adapter.allowanceTier()`, matching what
  `modelVisibleForAnyAccount` already answers) and the settings page's model
  dropdowns show it beside the name as `$20/mo`. It is NOT extra credit: every
  allowance draws on the same monthly pool, which is why the badge carries that
  caveat as a tooltip. Deals are already baked into these figures — MiniMax M3's
  `$47 / $57` is its 2× promotion folded in, and the pricing page says so in
  prose, which is what `tests/model-prices.test.ts` checks the snapshot against.
- **Price table Remote (`commandcode/prices`)**: `src/model-prices.ts` vendors
  the official per-token rates and serves them Host-side over the SAME
  `commandcodeUsage` service and one combined contribution (report + catalog +
  prices + login). Rows are keyed by CATALOG id wherever the two namespaces
  reconcile (the page drops vendor prefixes and sometimes inserts a hyphen —
  `priceSlugCandidates()` generates the plausible slugs and takes the first hit),
  and a row no catalog model claims is still served under its slug; free models
  are served explicitly at zero with `free: true`. The peak windows travel WITH
  the table (`peakHours`), so the browser prices against this snapshot's schedule
  instead of restating it; the model-independent half of that rule is
  `isPeakPricingHour()` in `capabilities.ts`, which `peakPricingState()` now
  delegates to. `CommandCodePricesController` (`src/client/prices.ts`) is a
  cache with three bounded transient retries (1/2/4 seconds), and both the namespace member and `UsageRemote.prices` are
  OPTIONAL because the Host and bundle can be a cross-version pair — a Host
  without the endpoint lands in a permanent "no prices" state instead of
  throwing. `tests/model-prices.test.ts` fails whenever a catalog model has no
  price row (free models are exempt, since they are served explicitly at zero),
  which is the visible decision point when upstream adds a model.
  **Syncing the table is a script, not a hand edit**: `node
  scripts/sync-model-prices.mjs` re-reads the page's embedded model JSON, asserts
  it still duplicates its base rates into `offPeak` and that peak ≥ off-peak,
  carries every `contextTiers` band including its inclusive input-token bound,
  CROSS-CHECKS each rewritten row against the page's own rendered table, copies
  the pricing table's pre-discount `listRates` for every row carrying a `deal`,
  and rewrites only the `MODEL_PRICE_ROWS` literal. `--check` reports drift
  without writing (exit 1 on drift, exit 2 when the page could not be read, so a
  network failure never reads as "up to date"). The cross-check is the point: a
  row can be internally consistent and still be the wrong row, which is exactly
  how `deepseek-v4-flash-vision-exp` shipped ~47% high.
  **价格交叉校验逐模型覆盖。** `renderedRates()` 仍以名称格
  (`flex min-w-0 items-center gap-2 px-4 py-3`) 分段，使用开发依赖 `parse5`
  解析 HTML（网页标记）后取名称和价格文本，处理嵌套标签、注释及字符实体；
  不执行脚本，也不把提取文本用作 HTML。上下文列与三个价格列按位置读取，
  不用缓存写或后续列补齐缺失价格。重复名称、缺失或不可解析的模型行会阻止
  快照生成，不能用总行数门槛证明每一行已校验。It used to
  split on `<tr>`/`<td>`: after the model table became a `<div>` grid, that
  parser matched only the six plan cards (Go/GOAT/Pro/Max 10×/Max 20×/Team Pro)
  and checked no model row at all — measured and fixed 2026-09-29. The
  struck-through `<s>` figures a discounted row renders are compared against the
  table JSON's `listRates`, so the pre-discount copy is verified by an
  independent rendering of it rather than by itself. 删除线按真正的 `<s>`
  元素识别，不能把 `<span>` 当成原价。`Free`（免费）行只在嵌入价格全部为零时
  通过；`—`（未公开价格）保留明确状态并拒绝生成无法验证的数值快照。
  校验失败退出 2，既有价格表不被覆盖。
  **Only the page's literal `listRates` is usable as a pre-discount figure** —
  its `discountPercent` is a marketing number that does not divide out (MiMo
  V2.5's "98% off" prices its three buckets at 5.7×, 14.3× and 57× of list), so
  a context tier is scaled by that row's own per-bucket ratios and skipped — with
  a printed warning — when those disagree. A deal with no literal `listRates`
  needs no fallback at all: the page is saying the unit price does not change
  (Qwen 3.7 Max's `2x-usage` doubles the allowance, it does not discount a
  token). Two documented upstream inconsistencies to leave alone rather than "fix" in the table: the four GPT
  rows publish a literal `cacheWriteCost: 0` in the JSON while the rendered
  column shows `—` (the table stays faithful to the machine-readable source),
  and the Mon–Fri rule is restated in the browser because only the WINDOWS
  travel with the table. The live copies are `isPeakPricingHour()` in
  `capabilities.ts` (Host picker labels) and `peakHour()` in `cost-facts.ts`
  (the readout's path, imported by the client bundle) — a weekday-rule change
  is a two-place edit across those two. `isPeakHour()` in
  `src/client/session-cost.ts` is a leftover third copy that nothing calls:
  only `tests/session-cost.test.ts` references it, and it is dead-code-eliminated
  out of `lib/client.js`. Delete it (and that one test) rather than re-wiring it.
- **Usage Remote (`commandcode/report`)**: the settings page's account card
  fetches the usage report Host-side through the Typert Gateway — the browser
  never holds the API key. Host: `src/usage-remote.ts` registers a
  `commandcodeUsage` service + strict descriptor on the `typert` registry.
  Client: `src/client/index.ts` mounts the shared contribution
  (`src/usage-wire.ts`) on `ctx.remote`, then resolves the `remote.commandcode`
  namespace via a **dynamic `ctx.inject(['remote.commandcode'], ...)`** — cordis
  only serves a fiber the services it declares in `inject` (a bare
  `ctx.remote.commandcode` access throws `cannot get property ... without
  inject`), and a static inject would deadlock because the namespace service
  exists only after our own mount. Keep that pattern when touching the mount.
- **The strict result codec carries the lazy `create()` factory** (`makeRemoteDescriptor()` in
  `src/wire-shared.ts`; issue #49). The Typert protocol's strict branch is `{ mode: 'strict', typeSymbol,
  create: () => TypertSchema }`: the registry refuses registration with `typert: <subject> strict codec has
  no create() factory` unless `typeof codec.create === 'function'`, and the Gateway validates with
  `codec.create().parse(value)`. There is NO `schema` member — one used to ride along for the pre-0.1.7
  engines, and dropping it is what the single-engine peer range bought. All 6 endpoints
  (`report`/`models`/`prices`/`loginBegin`/`loginStatus`/`loginCancel`) come from that one factory, and the
  helper is INLINED into both `lib/index.js` and `lib/client.js`, so a change is dead until the bundle is
  rebuilt. `tests/wire-shared.test.ts` drives a transcription of the registry's check over every descriptor
  gathered from the contributions, with a negative control pinning that a `schema`-only codec is refused;
  `npm run test:engine` cannot see any of this, because `scripts/verify-engine-load.mjs` registers no
  Remotes at all.
