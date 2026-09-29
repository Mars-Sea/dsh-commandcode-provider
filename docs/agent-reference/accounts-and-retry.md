# Accounts, web search, and retry

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **API key resolution order** (in `src/index.ts`): `config.apiKey` → credential ref `apiKeyEnv` (default
  `COMMANDCODE_API_KEY`, via the dsh credentials seam) → launch environment → official CLI auth file
  `~/.commandcode/auth.json`. **pi/OMP auth files are intentionally NOT scanned** — keep it that way.
- **Multi-account rotation** (`src/accounts.ts` + the adapter's connect loop): the top-level key forms the
  `default` slot; `Config.accounts` (`[{ label, apiKeyEnv | apiKey }]`) adds more, in rotation order.
  Rotation is **passive**: a key is marked only on a real pre-stream rejection (429 → `unknown`/`cooldown`
  carrying a `window` or `throttle` cause, 401 → `disabled`), and the adapter's `rotateApiKey` hook re-sends
  the same request with the next account's key (safe: nothing streamed, the body is account-independent,
  `threadId` preserves a valid UUID session identity, deterministically maps prefixed DSH session IDs to
  UUIDv5, and uses a random fallback only when no session ID is supplied — mid-stream failures NEVER
  rotate). When every account is marked, the pool probes `/alpha/billing/credits` per key
  (`probeWindowLimits`, which reads BOTH windows the endpoint publishes — the five-hour and the weekly one)
  to revive reset windows, else throws `RATE_LIMIT` naming the earliest `resetAt` (all-401 →
  `INVALID_CREDENTIAL`). State is keyed by API key, not slot — shared credentials share one mark. **Manual
  selection**: `Config.activeAccount` (a slot id) pins the serving account via the pool's `preferredId` seam
  + `selectActiveAccount()` (shared with the usage view's active badge); a pinned-but-exhausted or unknown
  id falls back to rotation order. **Model routing**: `Config.modelAccountRules` (`[{ models: string[],
  account }]`) lists catalog model ids per account slot; the request's model reaches key resolution
  (`resolveApiKey(connection, model)`), the pool's `modelAccountRules` seam re-reads rules per resolution,
  and `matchModelRule()`/`selectAccountForModel()` serve the routed account before preferred/rotation — an
  unusable routed account falls back, so the router is a hint, never a hard gate. **A fallback is never
  permanent, and that is a separate mechanism from the all-marked pass** (issue #51): a 429 marks the key
  `unknown`, which `accountUsable()` refuses until a probe clears it, while the all-marked probe pass runs
  only once NOTHING can serve — so a single 429 against the account the user explicitly chose demoted every
  later request to `default` for the lifetime of the process, and re-selecting that account in settings
  could not help, because the mark lives on the resolved key rather than on the selection (only a restart
  dropped the in-memory state, which is the "重启 dsh 才能换回来" in the report). `resolveKey()` therefore
  re-checks the explicit account — the manual pin, or a rule's routed slot — before serving the fallback:
  its window is probed at most once per `EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS` (60 s, which bounds a probe
  endpoint that keeps failing — the throttle's stamp SURVIVES a revival, because a probe that clears a
  window the chat endpoint still rejects would otherwise buy a second probe on the very next request: one
  billing GET plus one doomed upstream attempt each time), a window that is no longer exceeded drops the
  mark and puts the user's own choice back on that very request, and an exceeded one is stamped as a
  `cooldown` carrying the provider's own `resetAt`, after which the account returns by the clock with no
  further probe. Three gates keep the steady state free: only an `unknown` mark is probed (a `cooldown`
  already expires by itself, and a `disabled`/401 key clears only when the stored credential changes), every
  key this request already used is out of play (the rotation hook resolves with `tried`, and the pool's
  probe pass skips them too), and an account nobody explicitly asked for is still never probed while another
  one can serve. The probe's second effect is visible in the usage card: a pinned 429 now shows a real
  cooldown end instead of an open-ended "rate limited". **A rejection the pool cannot act on must not trap
  the turn either** (issue #51's follow-up report: 《切到一个不可用账号后就报 400，还挺频繁》). Three verified gaps produced
  it. Only 429/401 rotated, while the provider's account-scoped rejections are wider — the official CLI's
  own classifier (command-code@1.56.0: `parseWindowLimitError`, `isInsufficientCreditsRequestError`,
  `parseSpendCapError` and the terminal-marker list `["premium_credits_exhausted", "model_not_in_plan",
  "insufficient credits"]`) accepts the code `RATE_LIMITED` on ANY status (a 5xx that proxies the provider's
  own limit body included — the classifier reads the code BEFORE its status guard, and only a code-less
  5xx/408 keeps the retry cadence for every account), `400 Insufficient credits`, the codes
  `INSUFFICIENT_CREDITS`, `USAGE_EXCEEDED`, `PREMIUM_CREDITS_EXHAUSTED` and `MODEL_NOT_IN_PLAN` (underscored
  and spaced spellings both count, and a code-only body is enough), all of which the adapter reported as a
  permanent `PROVIDER_HTTP_ERROR`. Those four structured codes are matched on EVERY status
  (`ACCOUNT_UNAVAILABLE_CODES`), exactly like `RATE_LIMITED`: only the PROSE scan is confined to 4xx, so a
  5xx that proxies a credits/plan body rotates past the account instead of being retried as `SERVER`.
  Rotating could not have saved them anyway: the pool was asked to exclude only the just-rejected key and
  answered with the first *usable* account — the same key whenever the rejection marked nothing — so the
  adapter's tried guard ended the loop and the accounts behind it were never reached. And the revival probe
  read only `windowLimits.fiveHour`, so an account whose WEEKLY quota was spent while its five-hour window
  was open came back on every all-marked pass. `classifyAccountRejection()` therefore applies the CLI's
  rules and yields exactly four reasons, split by EVIDENCE — what the pool may claim — rather than by what
  it does: `rate-limit` (a usage window the provider NAMED: a 429 or the code, marked as a cooldown when the
  body's `error.rateLimit.reset`, in seconds, or its `resets at <ISO>` wording names the real reset — and
  only while that instant lies within `MAX_TRUSTED_RESET_MS` (30 days), because a bogus magnitude would
  otherwise pin a `cooldown` no probe ever revisits AND throw `RangeError` out of the `toISOString()` in the
  diagnosis; a dropped reset degrades the mark to `unknown`, which the probe pass re-checks — else as an
  `unknown` mark whose window the next all-marked pass probes) and `throttled` (a 429 or bare `RATE_LIMITED`
  that named NO window — `readWindowLimitEvidence()` mirrors the CLI's
  `parseWindowLimitError`/`resolveWindowLabel`, which calls a rejection a window limit only for
  `error.rateLimit.window ∈ fiveHour|weekly|daily` or the "usage limit for your plan" wording). Both rotate
  and both mark the key; only a `window` mark lets `allAccountsUnusable()` report "all N account(s) have
  exhausted their usage window" (naming the earliest reset, or saying the provider published none), while a
  pool marked only by throttles answers "all N account(s) are rate limited (429) — the provider did not
  report an exhausted usage window; retrying" with no window claim and no invented wait. That split is issue
  #54: a bare 429 marked the key, the billing probe never confirmed a spent window, and the pool told the
  reporter its window was exhausted while the account card showed 5-hour 2% and weekly 10%. `markRejected()`
  ignores a reset on a throttle mark on purpose, keeping it `unknown` so a probe can still discover a real
  window limit behind it (and upgrade the mark's `cause` to `window` when it does). `invalid-credential`
  (401, marked) and `unavailable` (no credits, or a model outside this account's plan — rotated past but
  deliberately NOT marked, because the fact is about the model or the balance rather than the key, either
  can change without the key changing, and a `:free` model is still served by a credits-empty account)
  complete the four. The whole `tried` set rides the hook so one request can walk a four-account pool, and a
  pool that cannot serve answers with its own all-exhausted diagnosis (earliest reset + the retry wait)
  rather than the last raw rejection — but only when every account it could consider is MARKED. An account
  that was tried and left UNMARKED always wins instead: `resolveKey()` returns undefined so the caller's own
  rejection is surfaced as itself — in the all-tried branch AND in the branch that merely ran out of untried
  accounts — because calling a credits rejection 'all windows exhausted' would be a lie that also
  under-counts the pool and hands dsh-llm-retry a wait it cannot act on (a permanent refusal retried after
  ~15 minutes). The diagnosis is built from the pool's FULL account list, never from the tried-filtered
  subset, so its count and its earliest reset describe what the user configured; and an unroutable window
  limit that names its own reset ends the turn as a retryable `RATE_LIMIT` (a plain 429 keeps the
  `Retry-After` mapping). A non-account-scoped 4xx (an invalid tool schema, a context overflow) still fails
  fast on the first attempt instead of multiplying the load across accounts. The dedicated-models picker's
  list comes from a Host-side `commandcode/models` Remote (the FULL adapter catalog via `listModels(…, {
  unfiltered: true })`, sorted), so the browser never calls the Command Code API; `SettingsPageApi.models`
  is optional, so legacy transports degrade to the empty-catalog state. Extra-account slot ids are the
  credential reference itself (`COMMANDCODE_API_KEY_2`, …) so a stored selection survives list
  reorders/removals; only literal-only composition entries keep positional `account-N` ids. **Account
  management on the settings page is IMMEDIATE, not staged**: `createAccount` / `renameAccount` /
  `removeAccount` / `setAccountKey` / `clearAccountKey` / `setActiveAccount` / `setAccountModels` on the
  controller each commit at once through one serial queue (`runAccountOp`, refused when the scope is not
  writable), so no page Save is involved and no staged account state can go stale. Two orderings are
  load-bearing: `createAccount` writes the key BEFORE the row and unsets the key again if the row write
  fails (a keyless-yet-keyed ref must never linger, because `nextAccountRef()` would hand it to the next
  account), and `removeAccount` refuses to drop a row whose stored key it could not unset, then drops that
  account's dedicated models and a pin naming it. Browser sign-in for a new account stores a KEYLESS row
  first — the Host's `loginCredentialRef` refuses a ref the stored `accounts` do not name — and the page
  removes that row again if the sign-in fails or is cancelled. The page shows `modelAccountRules` as
  per-account **dedicated models**: `accountModelMap()` folds the stored rules first-match-wins (exactly
  what the runtime would serve), and `setAccountModels` moves each chosen model out of every other account
  and writes one rule per account, so the stored list carries no shadowed entries. The config shape is
  unchanged. `workingDir` stays a valid Config field but is no longer on the page (and not a page field, so
  a save never touches it). The picker's billing-access cache is per key. The usage Remote result is
  `CommandCodeAccountsReport` (`{ accounts: [...] }`); host and client ship in one bundle, so wire-shape
  changes need no migration — only synced edits in `src/usage-wire.ts`, `src/usage-remote.ts`,
  `src/client/usage.ts`, and `src/commands.ts`. **A blocked usage report names the CAUSE, not just a
  verdict.** `classifyTotalFailure()` returns `network` whenever all four account endpoints threw without a
  status, and that one word covered five unrelated causes — a real outage, the account endpoints' own
  timeout, a key no HTTP header can carry (a paste artifact: `fetch` throws a `TypeError` BEFORE any I/O,
  once per endpoint), and an unparseable `apiBase` — so the card told users to check a connection that was
  fine. Three rules keep it honest: (1) the account path runs the harness's `assertUsableApiKey` in
  `accountHeaders()`, exactly like chat, and `getUsage()` answers `blocked: 'invalid-key'` with the
  credential message instead of four phantom transport failures (a MISSING credential still propagates); (2)
  the four endpoints get `connection.requestTimeoutMs` (the SAME budget as a chat call, default 300 s) rather
  than `MODELS_TIMEOUT_MS`, because a hidden 10 s cap made every account query time out on a slow link while
  chat kept working — the catalog/picker reads keep the short fail-open cap; (3) both surfaces RENDER
  `report.failures` (the settings card as `.cc-usageBlockedDetail`, the panel as `failure.detail`), since
  the endpoint messages are the only place the cause is named. Pinned by `tests/adapter.test.ts` (an
  unheaderable key never reaches `fetch` and reports `invalid-key`; the request budget is proven by a stub
  that waits on the request's own abort signal) and `tests/panel.test.ts`. **`report.credits` distinguishes
  "reported" from "zero", and that distinction is load-bearing**: `monthlyReported` is optional-tri-state
  (`undefined` = a pre-field Host, read as "assume reported"; explicit `false` = the endpoint omitted the
  balance, which the panel renders as `—` and never as a consumed quota), and `fiveHour`/`weekly` are
  OPTIONAL members that are absent when the endpoint reported no such window — a present window with `cap:
  0` means uncapped spend and keeps its row, an absent one keeps no row at all. Reading an absent balance as
  `0` is what turned a transient `/alpha/billing/credits` failure into a confident "100% used, quota
  exhausted"; the official CLI gates its own meter on the credits payload being present (`hasCreditsInfo`)
  and computes no depletion percentage without it. The wire schema validates a PRESENT `monthlyReported` as
  a boolean, so a malformed frame is rejected rather than coerced.
- **Web search (`src/web-search.ts` + the optional `web` seam)**: the model-facing `web_search` tool (from
  `@deepseek-ai/dsh-tool-web`) is served by a `CommandCodeSearchProvider` registered as `commandcode` on
  `ctx.web` — same `Authorization: Bearer <key>` + `x-command-code-version` chain, same `apiBase`, so DSH's
  web search needs NO separate key/endpoint config (unlike `dsh-web-search-deepseek`, which needs its own
  Anthropic-compatible base). It POSTs `{ query, numResults, allowedDomains?, blockedDomains? }` to
  `/alpha/web-search` and maps `{ title, url, snippet }` → `WebSearchSource`. Registration rides
  `ctx.inject(['web'], ...)` exactly like `commands`/`typert`: the provider is registered only when the
  profile mounts the web service, and the fiber never activates otherwise (this stays an LLM-provider-only
  plugin without web). The pool's `resolveKey()` (rotation + auth-file revived) is reused, so search
  benefits from the same multi-account selection; the search endpoint is account-independent so no
  mid-flight rotation happens. **Selection**: whether the `commandcode` provider WINS over the shipped
  `deepseek-official` (or a sibling search plugin's pin, e.g. modsearch's `searchProvider: modsearch`) is
  `Config.webSearch` (default on). The web seam has NO public runtime selector, so the plugin writes its
  private `searchProviderId` field (read per call by `web.search()`) via `applyCommandCodeSearchSelection()`
  in `src/web-search.ts` — applied at boot AND on every settings change (the `loader/volatile-update`
  listener — see the settings bullet), and restored on fiber unload. The tracked
  `CommandCodeSearchSelection` remembers the displaced backend id, so toggle-off (and unload) hands the
  selection back to it — it NEVER forces the factory default, because that is what silenced sibling plugins
  with Command Code search off (issue #26); a fresh boot straight into `webSearch: false` leaves the field
  untouched. Re-enables keep the original `displaced` (the field holds our own id then, which must not
  overwrite the memory), and a field already reading `commandcode` at first touch is recorded as
  `preexisting` so the later disable touches NOTHING — assigning the empty `displaced` back would clear the
  user's own `searchProvider: commandcode` pin (or `$DSH_WEB_SEARCH_PROVIDER`), hand the selection to
  dsh-web's auto-select, and make every search throw `WEB_PROVIDER_AMBIGUOUS` as soon as a second provider
  is usable. An `undefined` `displaced` with `preexisting: false` is the OTHER case — the field was unset
  when we took over — and is restored as `undefined`, or the toggle would leave Command Code serving. That
  write depends on the runtime shape (a plain writable property, not `#private`); the durable alternative is
  the boot-time `searchProvider: commandcode` cordis patch. The deprecated
  `selectCommandCodeSearchProvider()` (which forced the factory default on disable) was DELETED with the
  rest of the generation bridge — `applyCommandCodeSearchSelection()` is the only entry point. `dsh-web` is
  a `^0.2.0-rc.2` peer (kept external in tsdown); `tests/web-search.test.ts` pins the wire body, header,
  result mapping, the `WEB_ABORTED`/`WEB_PROVIDER_CREDENTIAL_MISSING`/`WEB_PROVIDER_ERROR` taxonomy, and the
  selection-field handoff (sibling-pin restore, re-enable memory, toggle-off through the real host `apply()`
  + `loader/volatile-update`).
- **`TRANSPORT` carries its own bounded budget, and the route policy cannot express it**
  (`src/transport-retry.ts` + the `agent/request-error` listener in `src/index.ts`; issue #39's second
  report). `providerRetryPolicy()` is captured once per route, so every code in its whitelist shares one
  window: 1000 attempts, waits doubling to 15 minutes. That shape is right for `RATE_LIMIT`/`SERVER` — an
  exhausted 5-hour window is a failure that ASKS to be waited out — and wrong for a connection that cannot
  be established. The reporter's second event at ~710k tokens was undici's own `Connect Timeout Error ...
  timeout: 10000ms` (its default connect timeout; `requestTimeoutMs` is 300 s and the connect phase never
  runs against the body upload) plus a `read ECONNRESET` on `/alpha/generate`; on the shared cadence the
  wait before attempt 11 alone is 512 s, so a 10-second TCP timeout produced an ~8-minute stall
  (`模型请求重试已取消（11/1000）· 482s` is that 512 s countdown, 30 s in). The listener therefore consumes `TRANSPORT`
  against a per-agent budget (`Config.transportMaxRetries`, default 5, 0–50) and THROWS when it is spent —
  throwing out of the waterfall is the only way to stop dsh-llm-retry, whose own policy would answer
  `TRANSPORT` with another retry. Order is load-bearing: the cancellation check runs BEFORE the budget, or a
  user's own stop would spend a slot a live failure needs. The reset point is `step/start`
  (`transportResetAction()` in the module states it once, and a test pins it) — one step IS one model
  request, so the cap stays per-logical-request and the next step of the same turn gets its own grace.
  `agent/status` → `idle` is NOT the reset: the loop's `setPhase` emits it only on a status CHANGE and a
  turn's steps share one `running` phase, so it never fires between them — resetting only there made the
  budget per-TURN, which is the bug the first version of this shipped with. `assistant/attempt` is wrong for
  the opposite reason: the loop appends it for the FAILED attempt before dispatching `agent/request-error`,
  so resetting on it restores the very loop this exists to stop. `turn/end` drops the session → agent
  mapping the reset needs. The `10s` connect timeout is undici's and reachability is not the plugin's to
  fix: measured against the live endpoint, a 1/8/30 MB body all returned the provider's own 401 in
  1.9/2.7/5.7 s, so the "long context" correlation in the report is not a size rejection.
  `tests/transport-retry.test.ts` pins the budget, per-agent isolation, the cancellation ordering and the
  message.
- **Retry**: `providerRetryPolicy()` pins a near-unbounded transient-only policy (`mode: 'normal'`,
  `maxRetries: 1000`, whitelist `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`) —
  opencode-style persistence that still fails fast on permanent errors (`INVALID_CREDENTIAL` etc. are not
  retryable); waits double from 500 ms and cap at 15 min (`RETRY_MAX_DELAY_MS` in accounts.ts, ±10% jitter);
  executed by dsh-llm-retry (active in every default profile via dsh-base) at agent-step boundaries. Smart
  waits ride `providerRetryAfterMs` on the thrown `LlmError`: a 429's `Retry-After` header is parsed and
  attached, and the rotation pool's all-exhausted `RATE_LIMIT` attaches the wait until the earliest known
  window reset — both **capped at `RETRY_MAX_DELAY_MS`**, because in normal mode the executor abandons (not
  falls back on) a retry whose attached wait exceeds the cap. Captured once at route registration, so any
  future config knob for it would apply on profile restart.
