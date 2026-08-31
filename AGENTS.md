# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is

An unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin that connects the `commandcode` model provider to the Command Code Provider API. Ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).

- **Provider route**: `commandcode` (registered on the dsh `llm` service).
- **Plugin name**: `llm-commandcode`; package `@mars-sea/dsh-commandcode-provider`.
- **Distributed as**: a dsh *bundle* (npm package with a `dsh.bundle` manifest + `cordis.patch.yml` layer), installable via `dsh plugin --profile <name> add <pkg|github:...|path>`.

## Repository layout

```
src/adapter.ts        CommandCodeAdapter (LlmAdapter) — wire protocol, message
                      conversion, SSE/JSONL stream parsing, catalog + cache,
                      pre-stream account rotation loop.
src/accounts.ts       CommandCodeAccountPool — multi-account slots, per-key
                      rotation state (429/401 marks), window-probe revival.
src/index.ts          Plugin entry: Config schema, credential resolution,
                      settings namespace, route + directory registration,
                      /commandcode command wiring, usage-Remote wiring.
src/commands.ts       The /commandcode usage dashboard command.
src/usage-wire.ts     Shared `commandcode/report` Remote contract: hand-rolled
                      strict result schema + the one descriptor object both
                      halves register (dependency-free; the client inlines it).
src/usage-remote.ts   Host half of the usage Remote: `commandcodeUsage`
                      service + `typert` registry contribution (optional inject).
src/client/index.ts   Browser client entry: registers the "Command Code"
                      settings page (settings.section, id `commandcode`) and
                      the Models-page provider card
                      (settings.models.provider-card, key `llm-commandcode`).
src/client/settings.ts  Settings-page controller (scope + credentials + staged
                      form; React-free so node tests can drive it).
src/client/legacy-credentials.ts  Pre-0.1.2 ApiProxy-to-current credential face adapter.
src/client/usage.ts   Account-card controller (Remote fetch lifecycle +
                      formatting; React-free) + the TypertRemoteMap merge
                      declaration for `commandcode/report`.
src/client/section.tsx  The settings page React component (settings form +
                      account-usage card).
src/client/card.tsx   The Models-page provider card (keyed-slot component +
                      the SlotMap merge for `settings.models.provider-card` /
                      `settings.models.footer` mirroring upstream 0.1.2).
src/client/sessions.ts  selectModel friendly-error wrapper (React-free).
src/client/version.ts  Plugin version for the settings-page footer (package.json import, inlined at build).
src/client/update.ts   Update hint: throttled npm-registry `latest` check +
                       tolerant semver compare (React-free, storage/fetch/time
                       seams); the page footer links to releases when newer.
src/login.ts           Host half of the browser login: loopback callback
                       server mirroring `command-code login` (POST /callback,
                       state token, whoami validation) → storeKey seam.
src/login-wire.ts      Login Remote contract: `commandcode/login*` endpoints'
                       descriptors + strict status parser (dependency-free).
src/client/locales.ts   zh/en copy + LocaleNamespaceMap augmentation.
tests/adapter.test.ts Core adapter unit tests (node:test + tsx).
tests/accounts.test.ts Account-pool rotation tests.
tests/commands.test.ts getUsage + command tests (stubbed fetch, no network).
tests/settings.test.ts settings-page controller tests.
tests/card.test.ts    Models-page provider-card tests (posture logic, key
                      write path, login affordance parity).
tests/legacy-credentials.test.ts  Legacy credential-envelope adapter tests.
tests/snapshot-store.test.ts  Snapshot-store notification and disposal tests.
tests/update.test.ts  update-hint tests (semver compare, payload parse,
                      throttle cache, failure semantics).
tests/usage-wire.test.ts usage-Remote schema + descriptor tests.
tests/usage-client.test.ts account-card controller tests.
tests/login.test.ts   browser-login flow integration tests (real loopback
                      server driven with fetch; every failure reason).
tests/login-wire.test.ts login descriptor uniformity + status parser.
tests/login-client.test.ts login-panel controller poll lifecycle.
scripts/verify-isolated-install.mjs  pnpm 10 marketplace-generation tarball install smoke.
cordis.patch.yml      Bundle patch layer (inserts the llm-commandcode row).
tsdown.config.ts      Build config (tsdown -> lib/, ESM, .d.ts + client.js).
```

## Key facts an agent must know

- **Client bundle**: the package's `dsh.client` declaration (`platform: web`,
  `inject: [...]`) makes the host serve `lib/client.js` as a client module.
  The bundle may only `require` platform/seed modules (`react`,
  `react/jsx-runtime`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-schema-form`, `@deepseek-ai/dsh-client-ui-attachment`)
  and host-shipped platform modules resolvable from the loader's module table
  (e.g. `@deepseek-ai/dsh-client-ui-primitives`). The 0.1.2-alpha.2 Web shell
  seeds `@deepseek-ai/dsh-client-store`; this client keeps the smaller local
  `getSnapshot`/`subscribe`/`set` subset in `src/client/snapshot-store.ts`, so
  it issues no extra module-table request. The settings page binds the
  `llm-commandcode` namespace through `ctx.settingsScope` and writes the API
  key through `ctx.remote.credentials` under the `COMMANDCODE_API_KEY`
  reference — never through the settings section, so the key literal cannot
  leak into a settings document. The retained legacy credential adapter is
  defensive only; the published peer contract starts at 0.1.2-alpha.2.
  `tests/settings.test.ts` and `tests/legacy-credentials.test.ts` pin these
  internal faces.
- **Isolated package install**: pnpm 10 auto-installs the package's DSH peers
  when a desktop marketplace prepares a fresh generation. Keep
  `@deepseek-ai/dsh-invariants` as an explicit `^0.1.2-alpha.2` peer matching
  the other Harness packages; otherwise pnpm reaches it only through
  `dsh-llm`, rewrites the prerelease range to an unsatisfiable stable range,
  and aborts with `ERR_PNPM_NO_MATCHING_VERSION`. Do not move it to
  `dependencies`: the active profile owns Harness packages. Run
  `npm run test:install` after changing DSH peer metadata.
- **Models-page provider card (`settings.models.provider-card`)**: a keyed
  SlotMap seat ui-settings-models declares in dsh 0.1.2-alpha.2 — it
  dispatches with `entryKey = settingsNs` on every provider card of an adapter
  family. The client entry registers a cell with `key: 'llm-commandcode'`
  (the directory row's settings namespace), carrying its own inject face
  (store hooks + actions) because the declaring entry is ui-settings-models',
  not ours; the `t` seat comes from the registration's own `locale`
  namespace. The card (src/client/card.tsx) shows key status + paste field +
  sign-in when unconfigured, a "configured" pointer to the dedicated page
  when set; the authoritative credential fact is the SHARED settings
  controller's `apiKeyConfigured` (the owner's `keyConfigured` is fallback
  only). The SlotMap merge for the two seats lives in card.tsx and must stay
  structurally identical to upstream's declaration (compile-time duplicate
  merge would fail once a peer ships it). On dsh builds without the slot the
  declaration never exists and `slots.inject` never fires — the registration
  silently does not happen; do not "harden" that into an error.
- **Wire protocol** (reverse-engineered, command-code@1.28.4; re-verified unchanged against 1.37.0):
  - `POST {apiBase}/alpha/generate` — body `{ config, memory, taste, skills, params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`.
  - Image parts use the official CLI wire shape: `{ type: 'image', source: { type: 'base64', media_type, data } }` (NOT pi's `data:` data-URI form).
  - Stream: SSE-ish JSONL events `text-delta | reasoning-start/delta/end | tool-call | tool-result | finish | error`.
  - Catalog: `GET {apiBase}/provider/v1/models` → `{ object: 'list', data: [{ id, name, context_length }] }`.
  - Defaults: `apiBase = https://api.commandcode.ai`, `COMMAND_CODE_CLI_VERSION = '1.37.0'`.
- **API key resolution order** (in `src/index.ts`): `config.apiKey` → credential ref `apiKeyEnv` (default `COMMANDCODE_API_KEY`, via the dsh credentials seam) → launch environment → official CLI auth file `~/.commandcode/auth.json`. **pi/OMP auth files are intentionally NOT scanned** — keep it that way.
- **Multi-account rotation** (`src/accounts.ts` + the adapter's connect loop): the top-level key forms the `default` slot; `Config.accounts` (`[{ label, apiKeyEnv | apiKey }]`) adds more, in rotation order. Rotation is **passive**: a key is marked only on a real pre-stream rejection (429 → `unknown` cooldown, 401 → `disabled`), and the adapter's `rotateApiKey` hook re-sends the same request with the next account's key (safe: nothing streamed, the body is account-independent, `threadId` random per request — mid-stream failures NEVER rotate). When every account is marked, the pool probes `/alpha/billing/credits` per key (`probeFiveHourWindow`) to revive reset windows, else throws `RATE_LIMIT` naming the earliest `resetAt` (all-401 → `INVALID_CREDENTIAL`). State is keyed by API key, not slot — shared credentials share one mark. **Manual selection**: `Config.activeAccount` (a slot id) pins the serving account via the pool's `preferredId` seam + `selectActiveAccount()` (shared with the usage view's active badge); a pinned-but-exhausted or unknown id falls back to rotation order. Extra-account slot ids are the credential reference itself (`COMMANDCODE_API_KEY_2`, …) so a stored selection survives list reorders/removals; only literal-only composition entries keep positional `account-N` ids. The settings page edits `activeAccount` through the generic section-field machinery (a `<select>` bound to a text field). The picker's billing-access cache is per key. The usage Remote result is `CommandCodeAccountsReport` (`{ accounts: [...] }`); host and client ship in one bundle, so wire-shape changes need no migration — only synced edits in `src/usage-wire.ts`, `src/usage-remote.ts`, `src/client/usage.ts`, and `src/commands.ts`.
- **StreamChunk contract** (dsh-llm): each block starts with `block-start`, deltas by `index`, ends with `block-end`; `usage` before `finish`; nothing after `finish`. Tool-call `arguments` are raw JSON strings. Reasoning blocks are intentionally NOT replayed into later turns (matches the CLI; private reasoning must not leak). Only tool calls with a paired tool result are replayed.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 → `RATE_LIMIT`; other HTTP → `PROVIDER_HTTP_ERROR` (403 body's `error.code`, e.g. `MODEL_NOT_IN_PLAN`, is parsed into the message). Unsupported options (`stop`) and image input throw `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` rather than silently dropping.
- **Adapter is cordis-free** by design: `src/adapter.ts` takes a per-request `options()` thunk + `resolveApiKey()` from the plugin entry, so settings changes reach the next request without re-registration. It also accepts an injectable `fetchImpl` for tests.
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
- **Browser login (`commandcode/loginBegin|loginStatus|loginCancel`)**: the
  settings page's key field can start the official `command-code login` flow
  instead of pasting a key — reverse-engineered from the CLI bundle's
  `createAuthFlowController`/`createAuthServer` (command-code@1.32.1): bind
  `127.0.0.1` from port 5959 upward, open
  `{studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state=…`,
  receive a **POST JSON body** `{apiKey,state,userId,userName,keyName}` from
  the Studio page (no OAuth code exchange), validate via `/alpha/whoami`,
  then store through the credentials seam under the default slot's ref. The
  loopback server mirrors the CLI contract exactly (POST-only `/callback`,
  10 KB body cap, state-token equality, `{success}` JSON responses); two
  deliberate hardenings — CORS origins are echoed **only when allowlisted**
  (the CLI falls back to the first origin), and `Connection: close`. The
  three endpoints ride the SAME `commandcodeUsage` service and one combined
  contribution (one Host registration, one Client mount); the namespace-level
  `TypertRemoteNamespaceMap.commandcode` augmentation lives ONLY in
  `src/client/usage.ts` (interface merging forbids duplicate members). A
  literal composition `apiKey` still outranks the stored credential; a
  remote-Host setup (browser ≠ Host machine) falls back to manual paste by
  design.
- **Static capability snapshots** (all in `src/adapter.ts`, all synced from official sources — see the `dsh-commandcode-upstream` skill for the exact extraction procedures):
  - `KNOWN_EFFORTS` — model → selectable reasoning-effort levels. Authoritative source is the CLI bundle's `ZA` model table (`command-code/dist/cli.mjs`), **not** the docs page (whose `Reasoning` flag means "thinks", not "has effort levels").
  - `KNOWN_IMAGE_MODELS` — Vision-capable models, synced from [commandcode.ai/docs/reference/cli/models](https://commandcode.ai/docs/reference/cli/models); note catalog IDs can differ from doc IDs (e.g. `claude-haiku-4-5-20251001` vs doc's `claude-haiku-4-5`).
  - `KNOWN_THINKING_MODELS` — models with `reasoning:!0` but no effort levels in the `ZA` table (they think automatically). Not displayed in the picker.
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`), synced from the plan pages ([go](https://commandcode.ai/docs/plans/go) ⊂ [goat](https://commandcode.ai/docs/plans/goat) ⊂ [pro](https://commandcode.ai/docs/plans/pro) ⊂ provider/max). Strict superset chain; every catalog ID covered exactly once (40/44/57/62 as of 2026-08-28, command-code@1.37.0 — `tencent/hy4-preview` joined Go (routed through OpenRouter); 39/43/56/61 as of 2026-08-27, command-code@1.36.0 — `Qwen/Qwen3.8-Flash` + `z-ai/glm-5.3-flash` joined Go and `stealth/ox-alpha` left when its preview ended in 1.34.0; 38/40/53/60 as of 2026-08-26, command-code@1.33.0 — the `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` promo variants joined Go; 36/40/53/58 at 1.32.2 when `deepseek/deepseek-v4-flash-vision-exp` joined Go in 1.32.0; 35/39/52/57 at 1.31.0 when `stealth/ox-alpha` joined Go; 34/38/51/56 at 1.28.4).
  - `KNOWN_SUBSCRIPTION_PLANS` — subscription `planId` prefix → `{ name, monthlyCredits, tierWeight }` for the account's own plan (from `/alpha/billing/subscriptions`), synced from the CLI bundle's plan maps (`Nn`/`$n`; `tierWeight` is plugin-added for the picker filter). `subscriptionPlanInfo()` mirrors the CLI's `getPlanInfo` longest-prefix matching. Distinct from `KNOWN_PLANS` (model → minimum tier).
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`. **Expiry-aware**: `dealLabel()` hides a deal once `Date.now()` passes its `expiresAt`, so an un-updated plugin never shows a lapsed discount.
  - `KNOWN_PEAK_PRICING` — catalog IDs with hourly (peak/off-peak) pricing, synced from the pricing page's model rows. Peak windows live in `PEAK_HOUR_RANGES` (UTC, end-exclusive); `peakPricingLabel()` maps the **current** UTC hour to `Peak`/`Half`.
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal · peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce "Text only" or "Supports image input".
  - The picker list is **sorted free models first, then by plan tier, then name** (`compareByPlan()` in `src/adapter.ts`; free = `KNOWN_DEALS` `free: true` via `isFreeModel()`, tier weights in `PLAN_ORDER`): FREE → Go → GOAT → Pro → Provider/Max, alphabetical within each group, unknown plans last. Keep this order when changing `listModels()`.
  - The picker also **hides models above the account's subscription tier** (`modelVisibleInPlan()`, on by default via `filterModelsByPlan`): the billing facts mirror the CLI's `createBilling` flow — whoami → orgId, then `/alpha/billing/subscriptions` (planId, honored only for `active`/`trialing`/`past_due` statuses) and `/alpha/billing/credits` (on-demand balances; its `credits.planId` is the fallback when subscriptions fails) — cached for `BILLING_ACCESS_TTL_MS`. The filter **fails open** everywhere (endpoint failure, unknown plan, unknown model) and is **bypassed by any positive on-demand balance** (`purchasedCredits + freeCredits > 0`) — mirroring the CLI's `evaluateModelAccess`. The catalog itself is never filtered; `resolveModel` still serves every model and the server remains the final gate.
- **Retry**: `providerRetryPolicy()` pins a near-unbounded transient-only policy (`mode: 'normal'`, `maxRetries: 1000`, whitelist `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`) — opencode-style persistence that still fails fast on permanent errors (`INVALID_CREDENTIAL` etc. are not retryable); waits double from 500 ms and cap at 15 min (`RETRY_MAX_DELAY_MS` in accounts.ts, ±10% jitter); executed by dsh-llm-retry (active in every default profile via dsh-base) at agent-step boundaries. Smart waits ride `providerRetryAfterMs` on the thrown `LlmError`: a 429's `Retry-After` header is parsed and attached, and the rotation pool's all-exhausted `RATE_LIMIT` attaches the wait until the earliest known window reset — both **capped at `RETRY_MAX_DELAY_MS`**, because in normal mode the executor abandons (not falls back on) a retry whose attached wait exceeds the cap. Captured once at route registration, so any future config knob for it would apply on profile restart.

## Commands

```sh
npm install             # devDeps incl. tsdown, tsx, typescript
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/**/*.test.ts
npm run test:install    # pack + install in a fresh pnpm 10.34.5 generation
npm run build           # tsdown -> lib/ (also runs via `prepare` on publish/git install)
npm pack --dry-run      # verify publish contents (must include lib/, cordis.patch.yml, README*, CHANGELOG, LICENSE)
```

## Release procedure

1. Edit `CHANGELOG.md` (Keep a Changelog format) for the new version.
2. `npm version patch|minor|major --no-git-tag-version` — bump without auto-tag.
3. `npm run typecheck && npm test && npm run build`.
4. Commit, then `npm publish` (requires the maintainer's 2FA OTP; the maintainer runs it, not the agent).
5. Tag and push: `git tag v<version> && git push && git push --tags`.
6. **Create a GitHub Release** for the tag (`gh release create v<version> --title "v<version>" --notes-file <file>`). The release notes must be **bilingual**: Simplified Chinese first (a `## 中文` section), then a `---` divider and the English translation of the same notes. **Style: short and user-facing** — one or two sentences per entry saying WHAT was added, changed, or fixed and what it means for the user; NEVER how (no file names, no internal function/mechanism names, no implementation or debugging narrative — the CHANGELOG carries the technical detail, the release notes are a summary of it). Releases — not tags or pushes — are what star followers see in their activity feed and get notified about; skipping this step makes the release invisible to users who starred the repo.

## Rules

- Keep changes focused; the ported wire logic is pinned by tests — update `tests/adapter.test.ts` when you change behavior.
- Do not commit, tag, push, or publish unless explicitly asked.
- Do not reintroduce pi/OMP auth-file scanning.
- Public API (exports from `src/index.ts`) is used by dsh's loader/registry — preserve `name`, `inject`, `Config`, `apply` and the `dsh.bundle` manifest shape.
