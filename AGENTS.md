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
src/capabilities.ts   Static capability snapshot (model efforts/vision/thinking,
                      plan tiers, subscription plans, deals, peak pricing) +
                      its read helpers — the sync-only surface for upstream
                      CLI/doc updates; imported by src/adapter.ts and re-exported
                      from src/index.ts.
src/accounts.ts       CommandCodeAccountPool — multi-account slots, per-key
                      rotation state (429/401 marks), window-probe revival.
src/image-request.ts  Request-image target: the long-edge/byte budget one
                      request asks the attachment service to encode to,
                      written in BOTH attachment generations' vocabulary
                      (<=0.1.5 reads maxPixels, >=0.1.6 reads width/height).
src/image-tokens.ts   Per-family visual-token estimates (Anthropic, OpenAI,
                      Gemini, DeepSeek, plus a conservative fallback) behind
                      the adapter's `imageRequestPricing`.
src/transport-retry.ts  The bounded retry budget for `TRANSPORT` failures: the
                      per-agent failure count, its reset, and the bilingual
                      diagnosis a capped turn ends with (issue #39's second
                      report — the route policy's 1000-attempt cadence is for
                      failures the provider ASKS to have retried, not for a
                      connection that cannot be established).
src/index.ts          Plugin entry: Config schema, credential resolution,
                      settings namespace, route + directory registration,
                      /commandcode command wiring, usage-Remote wiring.
src/commands.ts       The /commandcode usage dashboard command.
src/command-locales.ts  zh/en copy for the /commandcode command (Host-side
                      plain constants, no ctx.locale).
src/usage-wire.ts     Shared `commandcode/report` Remote contract: hand-rolled
                      strict result schema + the one descriptor object both
                      halves register (dependency-free; the client inlines it).
src/usage-remote.ts   Host half of the usage Remote: `commandcodeUsage`
                      service + `typert` registry contribution (optional inject).
src/wire-shared.ts    Shared boundary-validation + Remote-descriptor plumbing
                      for the hand-rolled Typert wire contracts (dependency-free;
                      imported by the wire files so the client can inline it).
src/client/index.ts   Browser client entry: registers the "Command Code"
                      settings page (settings.section, id `commandcode`), the
                      Models-page provider card
                      (settings.models.provider-card, key `llm-commandcode`), the
                      plans & quota panel's `main` cell + gated
                      `sidebar.footer.action` card, and the composer
                      `conversation.composer.dock` session-cost entry.
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
src/client/page-styles.ts  The settings-page stylesheet + its `data-plugin-css` id
                      (`PAGE_CSS_ID`). Its own module (rather than a literal in
                      `index.ts`) so `tests/styles.test.ts` can audit the rules
                      without importing the React tree.
src/client/panel.ts    Plans & quota panel view model + the shared background
                      auto-refresh loop (React-free).
src/client/panel-view.tsx  Sidebar footer card + center dashboard components.
src/client/panel-copy.ts   Bilingual (zh/en) panel copy + the `panel.commandcode`
                      locale namespace the panel slots bind their `t` seat to.
src/client/panel-slots.ts  SlotMap merge for `main` + `sidebar.footer.action`.
src/client/panel-styles.ts  The panel stylesheet + its `data-plugin-css` id (the
                      idempotence key `injectPanelCss` selects on).
src/client/prices.ts   Price-table controller over `commandcode/prices` (cached,
                      bounded transient retries, manual retry, rebind reload).
src/client/session-cost.ts  Session-cost calculation + copy (React-free).
src/client/session-cost-view.tsx  The dock entry that feeds the injected cost.
src/client/session-cost-display.ts  DOM injection into the harness's token-usage
                      pill and usage dialog (browser only).
src/client/session-cost-slots.ts  SlotMap merge for `conversation.composer.dock`.
src/cost-facts.ts      JSON-only billing facts shared by the Host projection and
                      the browser readout (groups, peak/hour rule, pricing key).
src/cost-projection.ts  Durable `commandCodeCost` session projection: folds each
                      request's model, attempt time and prompt band so the
                      readout prices history instead of cumulative totals.
src/client/version.ts  Plugin version for the settings-page footer (package.json import, inlined at build).
src/client/update.ts   Update hint: throttled npm-registry `latest` check +
                       tolerant semver compare (React-free, storage/fetch/time
                       seams); the page footer links to releases when newer.
src/model-prices.ts    Vendored per-token price table (input/output/cache-read/
                      cache-write, peak overrides) + the catalog-id → pricing-slug
                      join, served to the browser through `commandcode/prices`.
                      Generated rows; see the dsh-commandcode-upstream skill.
src/login.ts           Host half of the browser login: loopback callback
                       server mirroring `command-code login` (POST /callback,
                       state token, whoami validation) → storeKey seam.
src/login-wire.ts      Login Remote contract: `commandcode/login*` endpoints'
                       descriptors + strict status parser (dependency-free).
src/web-search.ts      CommandCode web-search provider over `ctx.web` (registered
                       only when the profile mounts the web seam; reuses the
                       plugin's apiBase + credential chain for `/alpha/web-search`).
src/tui-settings.ts    dsh-TUI settings section over the optional
                       `tuiSettingsSections` seam: declares the Command Code
                       page (`apiKey` secret field, apiBase, plan filter, a
                       per-model checkbox list under plan-tier groups, active
                       account, language) with local structural types, so no
                       dependency on the terminal front door (issue #28).
src/client/locales.ts   zh/en copy + LocaleNamespaceMap augmentation.
src/client/login.ts   Login-panel controller (Remote poll lifecycle; React-free
                      so node tests can drive it).
src/client/login-row.tsx  Shared login row rendered by both the settings page
                      and the Models-page provider card.
src/client/snapshot-store.ts  Vendored getSnapshot/subscribe/set triple (avoids a
                      version-specific module-table request).
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
tests/wire-shared.test.ts cross-generation strict-codec contract: both engine
                      generations' real validators run over every shipped
                      descriptor, plus negative controls for a single-member
                      codec (issue #49).
tests/usage-client.test.ts account-card controller tests.
tests/login.test.ts   browser-login flow integration tests (real loopback
                      server driven with fetch; every failure reason).
tests/login-wire.test.ts login descriptor uniformity + status parser.
tests/login-client.test.ts login-panel controller poll lifecycle.
tests/client-boot.test.ts client-boot integration tests (real apply() against a
                      DSH 0.1.2 client assembly; settings page + provider card).
tests/panel.test.ts   plans & quota projection + auto-refresh loop tests.
tests/styles.test.ts  injected-stylesheet containment tests: both stylesheets are
                      parsed and audited (every selector compound is ours or a
                      documented sidebar anchor), then matched against the real
                      foreign class stems — the ask-user-question dialog's button
                      row must not be reached, the sidebar's still must (issue #48).
tests/model-prices.test.ts  price table ↔ catalog join tests (fails when a
                      catalog model has no price).
tests/image-tokens.test.ts  vision-token rules (each formula against its
                      published examples), family dispatch, and the
                      request-image target math.
tests/session-cost.test.ts  session-cost calculation tests (peak/off-peak, a
                      missing rate, the invisible-when-unpriceable rules).
tests/session-cost-display.test.ts  DOM-injection tests for the pill and the
                      usage dialog, driven through the real class and its
                      `doc`/`observe` seams against a fake DOM (confirmation,
                      self-heal, hide/restore, disposal).
tests/cost-projection.test.ts  durable cost-fact fold tests against the real
                      projection registry (v1/v2 settlements, retries, history
                      restore, tier boundaries, free/unpriced subtotals).
tests/prices-client.test.ts  price-table controller tests (cache, bounded
                      transient retries, a Host without the endpoint).
tests/package.test.ts package-metadata contract (Harness peers start at rc.1,
                      no dsh-client-runtime).
tests/config-schema.test.ts Config credential contract: literal apiKey fields
                      carry role('secret') and are stripped by redactSecrets.
tests/web-search.test.ts web-search provider tests (wire body, result mapping,
                      failure taxonomy, selection-field rewrite).
tests/tui-settings.test.ts dsh-TUI settings-section tests (declared fields,
                      secret-ref safety, unset-reachable options, effective
                      boolean defaults, registration lifecycle).
scripts/verify-isolated-install.mjs  pnpm 10 marketplace-generation tarball install smoke.
scripts/verify-engine-load.mjs  Engine-load smoke: stages the published surface against a
                      real dsh engine and imports it there, so a bundle that cannot link
                      against the engine it will run on fails before publishing (issue #43).
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
  (e.g. `@deepseek-ai/dsh-client-ui-primitives`). The 0.1.2 Web shell
  seeds `@deepseek-ai/dsh-client-store`; this client keeps the smaller local
  `getSnapshot`/`subscribe`/`set` subset in `src/client/snapshot-store.ts`, so
  it issues no extra module-table request. The settings page binds the
  `llm-commandcode` namespace through `ctx.settingsScope` and writes the API
  key through `ctx.remote.credentials` under the `COMMANDCODE_API_KEY`
  reference — never through the settings section, so the key literal cannot
  leak into a settings document. The retained legacy credential adapter is
  defensive only; the published peer contract starts at 0.1.2-rc.1.
  `tests/settings.test.ts` and `tests/legacy-credentials.test.ts` pin these
  internal faces. The panel and session-cost slots have PER-SLOT version floors,
  not one shared one (see the panel bullet below): the composer dock and the
  sidebar foot have existed since 0.1.1-rc.2, the keyed `main` seat arrives in
  0.1.5-alpha.2, and `layout.selectPanel` in 0.1.5-rc.1. Never restate that as
  "the panel needs 0.1.5" — that is true of the `main` seat only, and the
  sidebar seat exists everywhere, which is why the footer registration is gated
  on the layout seam instead of on a slot declaration.
- **Isolated package install**: pnpm 10 auto-installs the package's DSH peers
  when a desktop marketplace prepares a fresh generation. Keep
  `@deepseek-ai/dsh-invariants` as an explicit peer matching
  the other Harness packages; otherwise pnpm reaches it only through
  `dsh-llm`, rewrites the prerelease range to an unsatisfiable stable range,
  and aborts with `ERR_PNPM_NO_MATCHING_VERSION`. Do not move it to
  `dependencies`: the active profile owns Harness packages. Run
  `npm run test:install` after changing DSH peer metadata.
- **The Harness peer range is an exact-version disjunction, and that is
  load-bearing.** Semver admits a prerelease only inside the same
  `major.minor.patch` tuple as the comparator, so `^0.1.2-rc.1` resolves to
  `0.1.2-rc.1` and NOTHING else — never `0.1.5-rc.2`, never `0.1.6-alpha.1`. A
  caret therefore pinned every peer to an engine four releases old, so a fresh
  generation installed a second, stale copy of the Harness beside the running
  engine instead of pairing with it; worse, it made `npm test` structurally blind
  to engine drift, because this checkout's own peers ARE that stale copy and a
  `link:`-installed profile resolves the plugin's imports from there. The one
  supported range is written VERBATIM in `peerDependencies`, `devDependencies`,
  `dsh.compatibility.dsh` and `engines.dsh`, and `tests/package.test.ts` fails if
  those four drift apart or if the range stops admitting a release that
  `dsh.compatibility.dshReleases` calls compatible. Add a new release to the
  range AND to `dshReleases` together, and only once `npm run test:engine`
  passes against it.
- **`npm run test:engine` is the only check that can see a bundle which cannot
  load on its engine** (issue #43): it resolves the newest release the manifest
  declares compatible (or `--engine <dir>`, or `$DSH_ENGINE`), copies this
  checkout's PUBLISHED surface into a tree whose peers ARE that engine's, and
  imports the bundle there. A `link:` install cannot substitute for it — the
  plugin's own module directory shadows the engine's, which is exactly how a
  removed export (`offloadRequestImagesWithPolicy` in 0.1.6) shipped green. It
  also audits every static named import against the engine's exports, the client
  bundle's `require()` calls against the platform seed table, the request-image
  policy generation the engine exposes, and — by instantiating the staged
  adapter — the image pricing that engine's token meter will ask for, on both
  payload shapes it has shipped. Run it before publishing and whenever a peer
  range or an engine version changes.
- **Models-page provider card (`settings.models.provider-card`)**: a keyed
  SlotMap seat ui-settings-models declares in dsh 0.1.2 (rc.1) — it
  dispatches with `entryKey = settingsNs` on every provider card of an adapter
  family. The client entry registers a cell with `key: 'llm-commandcode'`
  (the directory row's settings namespace), carrying its own inject face
  (store hooks + actions) because the declaring entry is ui-settings-models',
  not ours; the `t` seat comes from the registration's own `locale`
  namespace. The card (src/client/card.tsx) is the row's configuration panel
  driven by the OFFICIAL 编辑 toggle: closed it renders nothing (the row looks
  like any other provider row); open, it hides the official editor shell —
  for `llm-commandcode` the page's `layoutOf` returns "unknown", so that shell
  is only the settings.yaml hint over a permanently disabled apply — and shows
  the real controls (key status + route badges, paste field, sign-in,
  discard/save) wired to the SHARED settings controller (the authoritative
  credential fact is `apiKeyConfigured`; the owner's `keyConfigured` is
  fallback only). The shell is found as an immediate sibling of the renderer's
  stable `data-slot="settings.models.provider-card"` outlet wrapper (after it
  in a row, before it in the setup/add cards) by its CSS-module `editor` class
  stem — no hashed class is hardcoded — via a MutationObserver on the parent;
  if dsh restructures, detection fails benign and the stock shell reappears.
  The SlotMap merge for the two seats lives in card.tsx and must stay
  structurally identical to upstream's declaration (compile-time duplicate
  merge would fail once a peer ships it). On dsh builds without the slot the
  declaration never exists and `slots.inject` never fires — the registration
  silently does not happen; do not "harden" that into an error.
- **Wire protocol** (reverse-engineered, command-code@1.28.4; re-verified unchanged against 1.54.0):
  - `POST {apiBase}/alpha/generate` — CLI transport body `{ config, memory, taste, skills, params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`. Used for Go-plan accounts (the only plan without Provider API access) and as the fallback when `/provider/v1/chat/completions` returns `upgrade_required`. Historical reasoning IS replayed here as a `{ type: 'reasoning', text }` part of the assistant content array, in content order — the official CLI's `toWireMessages` converts every `thinking` block that way (command-code@1.54.0), and the provider rejects a DeepSeek thinking-mode tool loop whose assistant tool calls arrive without their reasoning (`The reasoning_content in the thinking mode must be passed back to the API.`, issue #34). Do not "restore" the old drop-reasoning behavior: it was ported from the pi plugin and is no longer upstream's shape.
  - `POST {apiBase}/provider/v1/chat/completions` — documented OpenAI-format transport with a flat body `{ model, messages, tools?, max_tokens, temperature, stream, reasoning_effort? }`. Used for accounts with Provider API access; historical reasoning is replayed as `reasoning_content`.
  - **Every tool's root schema is normalized to `type: 'object'`** by `toolParametersSchema()` before either body is built (issue #35). The gateway validates the root of each function schema and rejects the entire request otherwise (`Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"', got 'type: null'`). The harness's own `defineTool` always declares that root, so the failing schema comes from a tool registered outside it — a third-party plugin's or MCP bridge's hand-written schema (a type-less `{ properties, required }`), an empty `{}`, or a generator's root `$ref`. A schema that already declares an object root passes through untouched; a type-less object-shaped one gains the type; a root `$ref` is inlined from its local `$defs`/`definitions`; an `allOf`/`anyOf`/`oneOf` root is flattened (branch properties unioned, `required` kept only where every alternative demands it); anything else degrades to a permissive free-form object, since a refused request helps no one. Only the root is touched and every path returns a copy (the harness may deep-freeze tool schemas), and the walk is depth-bounded so a self-referential JS schema cannot spin. `toolParametersSchema()` is applied at both call sites, so the CLI `input_schema` and the OpenAI `function.parameters` cannot drift apart.
  - Image parts use the official CLI wire shape on `/alpha/generate`: `{ type: 'image', source: { type: 'base64', media_type, data } }`; OpenAI `/provider/v1/chat/completions` uses `{ type: 'image_url', image_url: { url: 'data:...' } }`.
  - CLI stream: SSE-ish JSONL events `text-delta | reasoning-start/delta/end | tool-call | tool-result | finish | error`.
  - OpenAI stream: standard SSE chunks with `delta.reasoning` / `delta.reasoning_content` / `delta.reasoning_details` / `delta.content` / `delta.tool_calls`, a `finish_reason`, and optional `usage`. **The thinking field is per model FAMILY, not global, and the gateway does not normalize the spelling** (measured live against the whole catalog, 2026-09-16): DeepSeek answers with the scalar `delta.reasoning` PLUS an OpenRouter-shaped `delta.reasoning_details` array (`[{ type: 'reasoning.text', text, format, index }]`, chunked one array per delta with `index: 0`), GLM/Qwen/Kimi answer with the DeepSeek-native `delta.reasoning_content`, and OpenAI/Gemini answer with neither. All three spellings are read, in that order, so no family's thinking is dropped. `reasoningDetailsText()` reads each array entry's `text` member rather than filtering on `type === 'reasoning.text'`: the sibling shapes in that protocol carry `summary` or an encrypted blob instead of `text`, so a plain read already ignores them, while a type filter would silently drop a text-bearing variant added later — and losing thinking is exactly what this exists to prevent. The array branch is a forward guard rather than a live path today (DeepSeek always sends the scalar alongside it); `tests/adapter.test.ts` pins it, including that the encrypted/summary entries contribute nothing and that the block still closes before the text block opens.
  - Catalog: `GET {apiBase}/provider/v1/models` → `{ object: 'list', data: [{ id, name, context_length }] }`.
  - Web search: `POST {apiBase}/alpha/web-search` — body `{ query, numResults, allowedDomains?, blockedDomains? }` → `{ results: [{ title, url, snippet }] }`; same `Authorization: Bearer <key>` + `x-command-code-version` as generate.
  - Defaults: `apiBase = https://api.commandcode.ai`, `COMMAND_CODE_CLI_VERSION = '1.54.0'`.
  - **Request image budget (issue #37)**: the gateway caps a whole request body at a measured ~50.17 MB (undocumented — their Error Codes page has no 413). Both transports inline every historical image as base64 and the harness never reclaims history, so a long session (a vision self-check loop reading back dozens of screenshots) used to cross the cap once and then fail EVERY later request on this route with HTTP 413, while the same conversation worked on another provider. `stream()` therefore builds both bodies from a PROJECTED history, never the raw one. WHICH projection depends on the engine, and both generations are reached through ONE namespace import probed at runtime — never a static named import, because 0.1.6 removed `offloadRequestImagesWithPolicy` while 0.1.2–0.1.5 lack its replacements, and a static import of an absent export is an ESM link-time failure that takes the whole plugin down (issue #43). On ≤0.1.5, `withImageBudget()`/`projectRequestImages()` wrap core's `offloadRequestImagesWithPolicy` + `offloadedImageText` (the mechanism both shipped adapters used to use) with `representation: 'base64'` — the encoded form is what has to fit — so the oldest images past the budget become model-visible placeholders in place and the newest keep their pixels. `REQUEST_IMAGE_BUDGETS` is a two-rung ladder: rung 0 is the standing budget (32 MiB base64 / 60 images, 16 MiB / 30 removal quanta), rung 1 (8 MiB / 12) is applied ONLY after the gateway actually answered 413, because the cap also covers text and tool bytes and cannot be budgeted exactly from here. On ≤0.1.5 the 413 retry is pre-stream and account-independent (the same key resends the rebuilt body; a 413 never rotates), and it is bounded and non-looping: a stricter rung applies to the CURRENT projection (never the raw history — that would reintroduce already-evicted images) and returns the same options object when it evicts nothing more, which is the "do not resend" signal. On ≥0.1.6 the offload set is a DURABLE session fact instead: `withSurfaceOffload()` renders the surface's `offloaded` marks through `projectOffloadedImages` (so an evicted image can never be re-sent as pixels) and an over-budget history FAILS with `IMAGE_OFFLOAD_REQUIRED` + the count from `requiredImageOffload`, which the default `dsh-compaction-image-offload` plugin records as one `image/offload` event and retries — the omission then survives restore and fork, and the token meter stops counting evicted images as context. That code stays outside `providerRetryPolicy()`'s whitelist: the surface mutation has to happen before any resend can help. The 413 rung becomes another offload request through the same channel, so those extra omissions are recorded too, and a rung with nothing left to offload falls through to the 413 diagnosis rather than asking for an offload that cannot happen. A tool-result image evicted this way surfaces as the tool message's own placeholder text, so no carrier user message is emitted for it. `generateHttpError` maps 413 to a bilingual `PROVIDER_HTTP_ERROR` (NOT retryable by dsh-llm-retry — a byte-identical resend cannot succeed) whose message names the undocumented cap and the only user lever left. Pinned by the "Request image budget (issue #37)" tests in `tests/adapter.test.ts` (no-op under budget, count and byte eviction, tool-result eviction, OpenAI parity, the 413 retry ladder, and the bounded failure that never resends an image-free body) plus the "durable contract (issue #43)" tests, which drive the ≥0.1.6 branch through the injectable `imageOffload` seam. The count's second carrier, `failure.offloadImages`, is invisible on the 0.1.2 peers (they predate the field) and is pinned by `npm run test:engine` against a real engine instead. Two further pieces of the same budget: the bytes that travel are the attachment service's REQUEST VERSION, not the stored original (`readImageRequest()` against the target in `src/image-request.ts` — a 1568-px long edge, inside the Anthropic ceiling and the OpenAI/Gemini high-detail band, and at most 1 MiB encoded), while the budget itself still accounts the DECLARED normalized size, which is what makes it conservative rather than exact; and the token meter prices every occurrence through `imageRequestPricing` (`src/image-tokens.ts`), charging the family's published visual-token rule at that same request target, zero vision tokens plus the placeholder text for an occurrence the surface offloaded or a route that takes text only, and the most expensive known rule for a family we cannot tell apart (under-reporting context is what walks a session into its own window).
- **API key resolution order** (in `src/index.ts`): `config.apiKey` → credential ref `apiKeyEnv` (default `COMMANDCODE_API_KEY`, via the dsh credentials seam) → launch environment → official CLI auth file `~/.commandcode/auth.json`. **pi/OMP auth files are intentionally NOT scanned** — keep it that way.
- **Multi-account rotation** (`src/accounts.ts` + the adapter's connect loop): the top-level key forms the `default` slot; `Config.accounts` (`[{ label, apiKeyEnv | apiKey }]`) adds more, in rotation order. Rotation is **passive**: a key is marked only on a real pre-stream rejection (429 → `unknown` cooldown, 401 → `disabled`), and the adapter's `rotateApiKey` hook re-sends the same request with the next account's key (safe: nothing streamed, the body is account-independent, `threadId` random per request — mid-stream failures NEVER rotate). When every account is marked, the pool probes `/alpha/billing/credits` per key (`probeFiveHourWindow`) to revive reset windows, else throws `RATE_LIMIT` naming the earliest `resetAt` (all-401 → `INVALID_CREDENTIAL`). State is keyed by API key, not slot — shared credentials share one mark. **Manual selection**: `Config.activeAccount` (a slot id) pins the serving account via the pool's `preferredId` seam + `selectActiveAccount()` (shared with the usage view's active badge); a pinned-but-exhausted or unknown id falls back to rotation order. **Model routing**: `Config.modelAccountRules` (`[{ models: string[], account }]`) lists catalog model ids per account slot; the request's model reaches key resolution (`resolveApiKey(connection, model)`), the pool's `modelAccountRules` seam re-reads rules per resolution, and `matchModelRule()`/`selectAccountForModel()` serve the routed account before preferred/rotation — an unusable routed account falls back, so the router is a hint, never a hard gate. The rules editor's model list comes from a Host-side `commandcode/models` Remote (the FULL adapter catalog via `listModels(…, { unfiltered: true })`, sorted), so the browser never calls the Command Code API; `SettingsPageApi.models` is optional, so legacy transports degrade to the empty-catalog state. Extra-account slot ids are the credential reference itself (`COMMANDCODE_API_KEY_2`, …) so a stored selection survives list reorders/removals; only literal-only composition entries keep positional `account-N` ids. The settings page edits `activeAccount` through the generic section-field machinery (a `<select>` bound to a text field) and `modelAccountRules` through its own rules card (staged rows like `accounts`, one `modelAccountRules` write). The picker's billing-access cache is per key. The usage Remote result is `CommandCodeAccountsReport` (`{ accounts: [...] }`); host and client ship in one bundle, so wire-shape changes need no migration — only synced edits in `src/usage-wire.ts`, `src/usage-remote.ts`, `src/client/usage.ts`, and `src/commands.ts`. **`report.credits` distinguishes "reported" from "zero", and that distinction is load-bearing**: `monthlyReported` is optional-tri-state (`undefined` = a pre-field Host, read as "assume reported"; explicit `false` = the endpoint omitted the balance, which the panel renders as `—` and never as a consumed quota), and `fiveHour`/`weekly` are OPTIONAL members that are absent when the endpoint reported no such window — a present window with `cap: 0` means uncapped spend and keeps its row, an absent one keeps no row at all. Reading an absent balance as `0` is what turned a transient `/alpha/billing/credits` failure into a confident "100% used, quota exhausted"; the official CLI gates its own meter on the credits payload being present (`hasCreditsInfo`) and computes no depletion percentage without it. The wire schema validates a PRESENT `monthlyReported` as a boolean, so a malformed frame is rejected rather than coerced.
- **Web search (`src/web-search.ts` + the optional `web` seam)**: the model-facing `web_search` tool (from `@deepseek-ai/dsh-tool-web`) is served by a `CommandCodeSearchProvider` registered as `commandcode` on `ctx.web` — same `Authorization: Bearer <key>` + `x-command-code-version` chain, same `apiBase`, so DSH's web search needs NO separate key/endpoint config (unlike `dsh-web-search-deepseek`, which needs its own Anthropic-compatible base). It POSTs `{ query, numResults, allowedDomains?, blockedDomains? }` to `/alpha/web-search` and maps `{ title, url, snippet }` → `WebSearchSource`. Registration rides `ctx.inject(['web'], ...)` exactly like `commands`/`typert`: the provider is registered only when the profile mounts the web service, and the fiber never activates otherwise (this stays an LLM-provider-only plugin without web). The pool's `resolveKey()` (rotation + auth-file revived) is reused, so search benefits from the same multi-account selection; the search endpoint is account-independent so no mid-flight rotation happens. **Selection**: whether the `commandcode` provider WINS over the shipped `deepseek-official` (or a sibling search plugin's pin, e.g. modsearch's `searchProvider: modsearch`) is `Config.webSearch` (default on). The web seam has NO public runtime selector, so the plugin writes its private `searchProviderId` field (read per call by `web.search()`) via `applyCommandCodeSearchSelection()` in `src/web-search.ts` — applied at boot AND on every settings change (the `installSection` `onChange` hook), and restored on fiber unload. The tracked `CommandCodeSearchSelection` remembers the displaced backend id, so toggle-off (and unload) hands the selection back to it — it NEVER forces the factory default, because that is what silenced sibling plugins with Command Code search off (issue #26); a fresh boot straight into `webSearch: false` leaves the field untouched. Re-enables keep the original `displaced` (the field holds our own id then, which must not overwrite the memory), and a field already reading `commandcode` at first touch means "nothing to restore". That write depends on the runtime shape (a plain writable property, not `#private`); the durable alternative is the boot-time `searchProvider: commandcode` cordis patch. The legacy `selectCommandCodeSearchProvider()` stays exported for compatibility but always restores the factory default on disable — new code must not use it. `dsh-web` is a `^0.1.2-rc.1` peer (kept external in tsdown); `tests/web-search.test.ts` pins the wire body, header, result mapping, the `WEB_ABORTED`/`WEB_PROVIDER_CREDENTIAL_MISSING`/`WEB_PROVIDER_ERROR` taxonomy, the selection-field handoff (sibling-pin restore, re-enable memory, unload path via the real host `apply()`), and the legacy rewrite.
- **StreamChunk contract** (dsh-llm): each block starts with `block-start`, deltas by `index`, ends with `block-end`; `usage` before `finish`; nothing after `finish`. Tool-call `arguments` are raw JSON strings. Historical reasoning blocks are replayed on BOTH transports for tool-loop continuity — as a `{ type: 'reasoning', text }` assistant part on `/alpha/generate` (the official CLI's shape) and as `reasoning_content` on `/provider/v1/chat/completions` (see the wire-protocol bullet; issue #34). Only tool calls with a paired tool result are replayed on both transports. **Tool-result images** (`read_image` returns text + a nested `image` block): neither wire can hold an image inside a tool result — the CLI's `tool-result.output` is text-only (the official CLI's own `toV2ToolOutput` filters out everything but text) and Chat Completions forbids non-text `role: 'tool'` content — so `toolResultMedia()` splits each result and both converters emit the bytes in a user message immediately after the tool message, led by the `Attached image(s) from tool result:` note (the shape `@deepseek-ai/dsh-llm-deepseek` uses). Deduplicated by attachment id per result; an image-only result gets a `(image returned; see the attached image)` tool text instead of an empty string; a result without a paired call drops its images with the result. Never flatten a tool result with `blockText` alone again — that is issue #30. The `hasImageContent` gate (model Vision capability + attachment seam) already recurses into tool results, so these images ride the same `readImage` resolver user attachments use.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 → `RATE_LIMIT`; **pre-stream 5xx → `SERVER` and 408 → `TIMEOUT`** (`httpErrorCode()`, so a gateway blip — e.g. Cloudflare's 520 "Upstream model provider is temporarily unavailable" — reaches the retry whitelist instead of failing the turn); other HTTP → `PROVIDER_HTTP_ERROR` (403 body's `error.code`, e.g. `MODEL_NOT_IN_PLAN`, is parsed into the message). **A context-window rejection → `CONTEXT_WINDOW_EXCEEDED`** (the harness's own code: `isContextWindowExceededError` plus the official CLI's `truncated` pattern, matched against the provider's `error.code`/`type`/`message`). It is deliberately OUTSIDE the retry whitelist because `dsh-compaction-basic`'s `agent/request-error` hook compacts the session and retries the reduced surface for that code — resending the byte-identical oversized request is exactly the old bug where a long session retried forever (issue #39). `streamErrorToLlmError()` is the ONE in-band classifier for both transports (the CLI's `error` event and the Provider API chunk's `error` member, which was silently ignored before); it reads the wording before the status, so a `statusCode: 500` carrying "prompt is too long" still takes the overflow path, while only client-side pre-stream statuses (`status < 500`) are inspected for the wording, so an HTML 5xx page cannot mention its way into a compaction. Never route a transient status onto a code outside `providerRetryPolicy()`'s whitelist: dsh-llm-retry matches the code only, never the status. Unsupported options (`stop`) and image input throw `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` rather than silently dropping.
- **`TRANSPORT` carries its own bounded budget, and the route policy cannot express it** (`src/transport-retry.ts` + the `agent/request-error` listener in `src/index.ts`; issue #39's second report). `providerRetryPolicy()` is captured once per route, so every code in its whitelist shares one window: 1000 attempts, waits doubling to 15 minutes. That shape is right for `RATE_LIMIT`/`SERVER` — an exhausted 5-hour window is a failure that ASKS to be waited out — and wrong for a connection that cannot be established. The reporter's second event at ~710k tokens was undici's own `Connect Timeout Error ... timeout: 10000ms` (its default connect timeout; `requestTimeoutMs` is 60 s and the connect phase never runs against the body upload) plus a `read ECONNRESET` on `/alpha/generate`; on the shared cadence the wait before attempt 11 alone is 512 s, so a 10-second TCP timeout produced an ~8-minute stall (`模型请求重试已取消（11/1000）· 482s` is that 512 s countdown, 30 s in). The listener therefore consumes `TRANSPORT` against a per-agent budget (`Config.transportMaxRetries`, default 5, 0–50) and THROWS when it is spent — throwing out of the waterfall is the only way to stop dsh-llm-retry, whose own policy would answer `TRANSPORT` with another retry. Order is load-bearing: the cancellation check runs BEFORE the budget, or a user's own stop would spend a slot a live failure needs. The reset point is `step/start` (`transportResetAction()` in the module states it once, and a test pins it) — one step IS one model request, so the cap stays per-logical-request and the next step of the same turn gets its own grace. `agent/status` → `idle` is NOT the reset: the loop's `setPhase` emits it only on a status CHANGE and a turn's steps share one `running` phase, so it never fires between them — resetting only there made the budget per-TURN, which is the bug the first version of this shipped with. `assistant/attempt` is wrong for the opposite reason: the loop appends it for the FAILED attempt before dispatching `agent/request-error`, so resetting on it restores the very loop this exists to stop. `turn/end` drops the session → agent mapping the reset needs. The `10s` connect timeout is undici's and reachability is not the plugin's to fix: measured against the live endpoint, a 1/8/30 MB body all returned the provider's own 401 in 1.9/2.7/5.7 s, so the "long context" correlation in the report is not a size rejection. `tests/transport-retry.test.ts` pins the budget, per-agent isolation, the cancellation ordering and the message.
- **The Claude family is Messages-only, so it takes the CLI transport — and that decision must NOT be cached** (`MESSAGES_ONLY_MODELS`/`requiresMessagesEndpoint()` in `src/capabilities.ts`, the first lines of `resolveProtocol()` in `src/adapter.ts`; issue #46). The Provider API serves the whole Claude family only through `/provider/v1/messages` (Anthropic Messages shape): posted to `/provider/v1/chat/completions`, all eight catalog Claude ids answer `400 Model "<id>" must be called via /provider/v1/messages (Anthropic Messages shape)`. Measured 2026-09-16 by posting all 69 catalog models to that endpoint — exactly those eight refused, and every one of them is routed normally by `/alpha/generate` (a lower-plan key gets the ordinary `MODEL_NOT_IN_PLAN` 403 there, never a routing error), which is why the adapter carries NO Messages transport. The bug this fixes is a routing one: the pre-stream fallback only recognised the Go-plan `upgrade_required` 403, so the 400 surfaced as `PROVIDER_HTTP_ERROR` — and because the non-Go tiers are exactly the ones `resolveProtocol()` sends to the Provider API, the accounts ENTITLED to Claude (Pro for Sonnet, Provider/Max for Opus) were the ones that could never use it. `resolveProtocol(apiKey, model)` now returns `'cli'` for these models on any tier AND under a forced `'openai'` preference, since that option is documented as "prefer the Provider API, still fall back" rather than a hard gate. **The call to `rememberProtocol()` is deliberately absent on that path**: `protocolCache` is keyed by API key ALONE, so remembering it would pin the whole ACCOUNT to the CLI transport and drag DeepSeek, GLM and Qwen — all correctly served by the Provider API — along with it until the entry expired. `tests/adapter.test.ts` pins the route, the `claude-*` prefix rule that covers a model shipping after this release, and that a Claude request followed by a DeepSeek one still lands on the Provider API.
- **Inbound `Message` fields are PRODUCER-supplied, so the tool-result test reads them defensively** (`isToolResultMessage()` in `src/adapter.ts` — one predicate behind all four sites of both converters; issue #47). `Message.source` is declared required by dsh-llm, but nothing validates it at runtime: it is filled in by whoever assembles the history, and every adapter shipped before this one ignored it outright (`dsh-llm-deepseek` never reads the field). A third-party plugin that builds its own history can therefore omit it and run correctly everywhere else — dsh-mneme's memory pipeline did — so the unguarded `message.source.kind` this used to do made the adapter the first to crash on such a message, with `TypeError: Cannot read properties of undefined (reading 'kind')` thrown during serialization (0–8 ms in, before any request was sent, naming neither the message nor the producer). The predicate has two rules. A PRESENT tag is authoritative — `kind: 'user'`/`'model'`/`'plugin'` means "not a tool result" whatever the content looks like, because the tag answers *who produced this*. An ABSENT tag falls back to the content shape: a `user` message whose first block is a `tool-result` IS a tool result by the harness's own definition (`ToolResultMessage` is exactly that shape with a `ToolMessageSource`). That fallback is not politeness — `pairedToolCalls()` counts a `tool-result` block from ANY message, so classifying an untagged tool result as a plain user message would drop it at emission while its call still counted as paired, leaving an assistant `tool_calls` entry unanswered on the wire, which the gateway rejects. Never reintroduce a bare `message.source.kind`, and never "simplify" the fallback away: `tests/adapter.test.ts` pins all three cases (untagged user message, untagged tool result, authoritative tag) on both transports.
- **Adapter is cordis-free** by design: `src/adapter.ts` takes a per-request `options()` thunk + `resolveApiKey()` from the plugin entry, so settings changes reach the next request without re-registration. It also accepts an injectable `fetchImpl` for tests.
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
  settings page's Advanced toggle): `CommandCodeFooterEntry` gates its own
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
  token count each row must be showing. `buildSessionCostView()` owns every
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
  **Version floors are PER SLOT, and getting this wrong ships a dead button.**
  Measured across 0.1.1-rc.2 … 0.1.5-rc.2: `sidebar.footer.action` and
  `conversation.composer.dock` are declared AND rendered in every one of those
  releases; the keyed `main` seat arrives in 0.1.5-alpha.2 and
  `layout.selectPanel` in 0.1.5-rc.1. So "the panel needs 0.1.5" is true of the
  `main` seat ONLY — on an older engine the sidebar seat still exists, so an
  ungated `slots.inject` there would render a card that silently does nothing
  when clicked. The footer registration is therefore gated on
  `ctx.inject(['layout'], …)` plus a `typeof selectPanel === 'function'` check
  (`src/client/index.ts`), and the dashboard cell needs no gate because
  registering against an undeclared slot is a no-op by construction. The DOM
  anchors (`[data-composer-stats]`, `[data-session-stats-usage]`) are the one
  genuinely 0.1.5-alpha.1 marker. `tests/client-boot.test.ts` pins all of this by
  modelling the declaration set and the layout seam separately.
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
  fold instead replaced on `(turn, step)` alone and never handled that event
  (`dsh-client-connection`'s fixture projection is exactly that rule). On those
  engines the two folds therefore disagree by the retried attempt's tokens, and
  because the client requires per-bucket EQUALITY against `tokenUsage`
  (`src/client/session-cost.ts`), a session that retried there loses the readout
  entirely rather than showing a wrong figure. Retries are routine on this route
  (429 plus the near-unbounded retry policy) and 0.1.2-rc.1/0.1.3 are declared
  compatible in `package.json`, so this is a real gap, not a theoretical one.
  Closing it means recording which fold rule wrote a group (or versioning the
  projection per engine generation). Until then, do NOT "fix" the equality gate
  by loosening it: that gate is what keeps a mismatched fold from being priced.
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
  CROSS-CHECKS each rewritten row against the page's own rendered table,
  and rewrites only the `MODEL_PRICE_ROWS` literal. `--check` reports drift
  without writing (exit 1 on drift, exit 2 when the page could not be read, so a
  network failure never reads as "up to date"). The cross-check is the point: a
  row can be internally consistent and still be the wrong row, which is exactly
  how `deepseek-v4-flash-vision-exp` shipped ~47% high. Two documented upstream
  inconsistencies to leave alone rather than "fix" in the table: the four GPT
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
- **The strict result codec carries BOTH Typert generations' members** (`makeRemoteDescriptor()` in `src/wire-shared.ts`; issue #49). The protocol swapped the strict branch's shape inside the SAME `mode: 'strict'` tag: every RELEASED engine (`0.1.2-rc.1` … `0.1.6-alpha.1`, all 21 published versions) declares `schema: TypertSchema`, refuses registration with `strict codec has no parse() method` unless `codec.schema.parse` is a function, and validates with `codec.schema.parse(value)`; master after `e459e3263` (`perf(typert): materialize generated schemas on first use`) replaced that member with the lazy factory `create: () => TypertSchema`, refuses with `strict codec has no create() factory` unless `typeof codec.create === 'function'`, and validates with `codec.create().parse(value)`. Neither validator inspects the member it does not know, so ONE codec object carries `schema` AND `create: () => schema` (the same hand-rolled validator, never a second copy) and both generations accept it with no runtime probe. **Carrying only one member is the bug, in either direction**: the issue's proposed `-schema, +create` fixes unreleased master by breaking every install that exists today, and dropping `create` again would break master. That is why the two members live in one local `StrictResultCodec` interface rather than the protocol typings — no published `@deepseek-ai/dsh-typert-protocol` carries `create` yet, and the older generation's excess-property check would reject an inline literal — and the assignment to `InvocationDescriptor` needs no cast in either direction. All 6 endpoints (`report`/`models`/`prices`/`loginBegin`/`loginStatus`/`loginCancel`) come from that one factory, and the helper is INLINED into both `lib/index.js` and `lib/client.js`, so a fix is dead until the bundle is rebuilt and force-added. `tests/wire-shared.test.ts` drives both generations' real validators — transcribed from each `dsh-typert-registry` — over every descriptor gathered from the contributions, with negative controls pinning that a single-member codec fails the other generation; `npm run test:engine` cannot see any of this, because `scripts/verify-engine-load.mjs` registers no Remotes at all.
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
  10 KB body cap, state-token equality, `{success}` JSON responses); three
  deliberate hardenings over the CLI — CORS origins are echoed **only when
  allowlisted** (the CLI falls back to the first origin), `Connection: close`,
  and the denial branch (`{"error":…}`) checks the state token **before** it
  ends the attempt, exactly where the CLI checks it. That last one is
  load-bearing: a denial is terminal and a `text/plain` POST rides as a CORS
  simple request (the browser sends it whatever the origin allowlist says), so
  without the check any open page could cancel a login in progress. Attempt
  ownership (`attemptSeq` + `ownsAttempt()`) is the other non-obvious rule:
  the delivered key is validated over an await, and a cancel or a new `begin()`
  during that window must win — no key write and no status publish from an
  attempt that no longer owns the flow. `begin()` likewise retires a `waiting`
  status whose server is gone (the callback was consumed, the port is closed)
  instead of handing back a dead authUrl. The
  three endpoints ride the SAME `commandcodeUsage` service and one combined
  contribution (one Host registration, one Client mount); the namespace-level
  `TypertRemoteNamespaceMap.commandcode` augmentation lives ONLY in
  `src/client/usage.ts` (interface merging forbids duplicate members). A
  literal composition `apiKey` still outranks the stored credential; a
  remote-Host setup (browser ≠ Host machine) falls back to manual paste by
  design.
- **Literal API keys are `role('secret')`** (`Config.apiKey` and
  `Config.accounts[].apiKey`): the settings page writes keys through the
  credentials seam, so the literal path exists only for composition configs —
  but that path IS a settings value, and the harness strips a secret role from
  every descriptor it serves (`settings.describe()` runs with
  `redactSecrets: true`). Dropping the role leaks the key to the browser
  verbatim (another machine on a remote Host). Pinned by
  `tests/config-schema.test.ts` against the real `redactSecrets`.
- **dsh-TUI settings section (`src/tui-settings.ts` + the optional
  `tuiSettingsSections` seam)**: a TUI-only user has NO other way to enter the
  API key — dsh-TUI's `/provider` wizard manages its own `llm-pi-ai` routes
  exclusively, and `/settings` renders only sections a plugin DECLARES (it
  never reads `settings.installSection`). So the plugin declares a Command Code
  page over `ctx.inject(['tuiSettingsSections'], …)`, exactly like
  `commands`/`web`/`typert`; without dsh-TUI the fiber never activates and the
  plugin stays an LLM-provider-only bundle. Four rules are load-bearing.
  (1) **No dependency on the terminal front door**: the seam's types are
  re-declared locally, because the plugin must not import
  `@deepseek-harness-tui/dsh-tui`. Every read is defensive (missing service,
  non-object, missing `register` → no section) and the read goes through the
  REFLECTIVE `ctx.get('tuiSettingsSections')`, never a bare property access —
  cordis throws `cannot get property … without inject` for an undeclared
  service, which would take the plugin's boot down on every non-TUI profile.
  (2) **The key field is a `secret` field**, so dsh-TUI writes the draft
  through the credentials seam under the declared ref and never into a
  settings document; the ref must stay out of the host-reserved namespace
  (`DEEPSEEK_API_KEY`/`DEEPSEEK_*`/`DSH_*` — dsh-TUI silently DROPS a field
  with a reserved ref, which would leave a page with no key input at all), and
  a secret field has no `format`/`parse` (the host never seeds a draft from
  the document).
  (3) **Unset must stay reachable**: dsh-TUI's `select` kind can only land on
  a declared option, so `activeAccount` and `lang` are `text` + `options` (the
  host's own preset-plus-custom shape) with an `auto` sentinel whose `parse`
  emits `{ kind: 'clear' }`. `filterModelsByPlan` likewise FORMATS its
  effective default (`true` when unset) instead of the raw `undefined`, since
  a raw boolean format would render "(empty)" on a fresh install.
  (4) **Registration is a declaration, not a binding**: the host renders a
  fixed field list, so anything frozen into it (the credential ref, the
  account-slot option list) is refreshed by re-registering from the
  `installSection` `onChange` hook — withdraw first, then declare, and only
  when `sectionSignature()` actually moved, or every ordinary settings write
  would churn the screen's section list. A rejecting host is contained with a
  warning (a shadow-mode capability policy, a future contract change) and stays
  retryable, never fatal. Pinned by `tests/tui-settings.test.ts`.
- **Client-side staging survives a failed save** (`src/client/settings.ts`):
  writes run in order and stop at the first failure, so reconcile must keep
  every draft the failed write did not land. A label draft is dropped only when
  the stored label proves it landed; a rule draft only when the stored rules
  fingerprint changed (the rules write landed, positional ids shifted, and a
  kept draft would land on the wrong row) — `ruleFingerprint()`. Treating
  "absent from the stored section" as "already applied" silently reverted typed
  labels and rule edits with `dirty` false, i.e. no retry. `writeAccounts()`
  additionally rebuilds the stored list rather than the page's rows: the
  settings layer replaces the whole `accounts` array, so a rebuilt list deletes
  every composition entry the page cannot name (literal-key entries have no
  row) and strips their literal keys.
- **`catalogIsReady` gates the stale-model cleanup** (`src/client/model-select.ts`):
  an empty catalog — before the first fetch lands, or after a failure — makes
  every selected id look retired, so the one-click cleanup would empty the
  allowlist. Require a non-empty catalog and no failure; the explicit "show
  all" action stays available without one.
- **Static capability snapshots** (all in `src/capabilities.ts`, synced from official sources — see the `dsh-commandcode-upstream` skill for the exact extraction procedures; `src/adapter.ts` imports them and keeps only stable wire/runtime logic):
  - `KNOWN_EFFORTS` — model → selectable reasoning-effort levels. Authoritative source is the CLI bundle's commandcode-provider model table (`command-code/dist/cli.mjs`; minified table/variable names change per release — locate it by the `reasoningEfforts` feature, see the skill), **not** the docs page (whose `Reasoning` flag means "thinks", not "has effort levels").
  - `KNOWN_IMAGE_MODELS` — Vision-capable models, synced from [commandcode.ai/docs/reference/cli/models](https://commandcode.ai/docs/reference/cli/models); note catalog IDs can differ from doc IDs (e.g. `claude-haiku-4-5-20251001` vs doc's `claude-haiku-4-5`).
  - `KNOWN_THINKING_MODELS` — models with `reasoning:!0` but no effort levels in the commandcode-provider table (they think automatically). Not displayed in the picker.
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`), synced from the plan pages ([go](https://commandcode.ai/docs/plans/go) ⊂ [goat](https://commandcode.ai/docs/plans/goat) ⊂ [pro](https://commandcode.ai/docs/plans/pro) ⊂ provider/max). Strict superset chain; every catalog ID covered exactly once (re-verified unchanged at command-code@1.54.0, 2026-09-15 — no tier moved, and the public catalog still serves its 69 models with `gpt-6-astra` a CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.53.1, 2026-09-12 — no tier moved; 44/50/63/70 as of 2026-09-10, command-code@1.53.0 — 1.53.0 added `deepseek/deepseek-v4.1-flash` on Go; 1.52.0 added the free `inclusionai/ling-3.0-flash-sante:free` on Go; re-verified unchanged from 1.49.0, which added `gpt-6-astra` on Provider/Max; 1.48.0 added `max` effort to Muse Spark 1.3; 46/52/65/71 as of 2026-09-04, command-code@1.47.0 — 1.41.0 added `Qwen/Qwen3.8-Max-0902` on Go, 1.42.0 added `meituan/LongCat-2.0:free` on Go, 1.43.0 added `google/gemini-3.8-flash` on GOAT, 1.44.0 added `meta/muse-spark-1.3` on GOAT + its Contributor sibling on Go; 43/47/60/66 at command-code@1.40.1 — `claude-fable-5-1` joined Provider/Max after 1.40.0 shipped it on the Provider API (the alpha.5 note that it was Anthropic-OAuth-only was wrong); 43/46/59/64 at 1.40.1 before that fix; `deepseek/deepseek-v4-flash-fast` joined Go in 1.39.0; 1.39.2 retired `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` and the upstream catalog renamed `tencent/Hy3` to `tencent/hy3-paid` (the hidden free variant); `inclusionai/ling-3.0-flash-free` was removed when its free promo ended 2026-08-03; 40/44/57/62 at 1.37.0 — `tencent/hy4-preview` joined Go (routed through OpenRouter); 39/43/56/61 as of 2026-08-27, command-code@1.36.0 — `Qwen/Qwen3.8-Flash` + `z-ai/glm-5.3-flash` joined Go and `stealth/ox-alpha` left when its preview ended in 1.34.0; 38/40/53/60 as of 2026-08-26, command-code@1.33.0 — the `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` promo variants joined Go; 36/40/53/58 at 1.32.2 when `deepseek/deepseek-v4-flash-vision-exp` joined Go in 1.32.0; 35/39/52/57 at 1.31.0 when `stealth/ox-alpha` joined Go; 34/38/51/56 at 1.28.4).
  - `KNOWN_SUBSCRIPTION_PLANS` — subscription `planId` prefix → `{ name, monthlyCredits, tierWeight }` for the account's own plan (from `/alpha/billing/subscriptions`), synced from the CLI bundle's plan maps (minified variable names change per release — locate them by the `"individual-go"` key; `tierWeight` is plugin-added for the picker filter). `subscriptionPlanInfo()` mirrors the CLI's `getPlanInfo` longest-prefix matching. Distinct from `KNOWN_PLANS` (model → minimum tier).
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`. **Expiry-aware**: `dealLabel()` hides a deal once `Date.now()` passes its `expiresAt`, so an un-updated plugin never shows a lapsed discount.
  - `KNOWN_PEAK_PRICING` — catalog IDs with hourly (peak/off-peak) pricing, synced from the pricing page's **embedded model JSON `timeOfDay` blocks** (never the rendered row text — see the skill). Exactly four models as of 2026-09-10: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp`, `deepseek/deepseek-v4.1-flash` (added in command-code@1.53.0 at $0.15/$0.60 off-peak, $0.30/$1.20 peak, same schedule); `deepseek/deepseek-v4-flash-fast` is flat-priced ($0.28/$0.56/$0.07) and must stay out. Peak windows live in `PEAK_HOUR_RANGES` (UTC, end-exclusive) and apply **Monday–Friday only** — the official rule charges Saturday/Sunday completely off-peak for all 24 hours — so `peakPricingState()`/`peakPricingLabel()` map the current UTC **weekday+hour** to `Peak`/`Half` (35 peak hours per week, 7 per weekday, 0 on weekends).
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal · peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce "Text only" or "Supports image input".
  - The picker list is **sorted free models first, then by plan tier, then name** (`compareByPlan()` in `src/capabilities.ts`; free = `KNOWN_DEALS` `free: true` via `isFreeModel()`, tier weights in `PLAN_ORDER`): FREE → Go → GOAT → Pro → Provider/Max, alphabetical within each group, unknown plans last. Keep this order when changing `listModels()`. `formatContext()` renders sub-1K windows raw (never `"0K"`).
  - The picker also **hides models above the account's subscription tier** (`modelVisibleInPlan()`, on by default via `filterModelsByPlan`): the billing facts mirror the CLI's `createBilling` flow — whoami → orgId, then `/alpha/billing/subscriptions` (planId, honored only for `active`/`trialing`/`past_due` statuses) and `/alpha/billing/credits` (on-demand balances; its `credits.planId` is the fallback when subscriptions fails) — cached for `BILLING_ACCESS_TTL_MS`. The filter **fails open** everywhere (endpoint failure, unknown plan, unknown model) and is **bypassed by any positive on-demand balance** (`purchasedCredits + freeCredits > 0`) — mirroring the CLI's `evaluateModelAccess`. The catalog itself is never filtered; `resolveModel` still serves every model and the server remains the final gate.
  - The picker also supports a **visible-model allowlist** (`Config.visibleModels: string[]`, the settings page's Visible models card): a non-empty list narrows `listModels()` to those catalog ids AFTER the plan filter; empty/unset shows everything. It never gates named requests (`resolveModel` still serves every model). The allowlist is staged through `visibleModelsDraft` in `src/client/settings.ts` (same draft/dirty/plan/write/reconcile shape as the rules card, one `visibleModels` write) and cleaned of non-strings/blanks at both ends (`storedVisibleModels()` + `resolveAdapterOptions`). `listModels(provider, { unfiltered: true })` skips BOTH filters so the `commandcode/models` Remote always serves the full catalog to the page editors; the adapter override stays signature-compatible with the base (`_provider` only) via the optional second param. `tests/adapter.test.ts` pins the narrowing + unfiltered paths; `tests/settings.test.ts` pins the controller staging.
  - **`Config.modelVisibility: Record<string, boolean>`** is the terminal page's per-model override layer over that array: an id present decides its own model (`true` listed, `false` hidden), an id absent keeps following `visibleModels` exactly as before, and the plan filter still applies on top. It exists because of a hard dsh-TUI constraint, not a preference: the seam's only control for a per-model list is a `boolean` field, and the host keys a staged draft by the field's PATH (`fieldKey` in its `settingsEditor.ts`) — so N checkboxes sharing the `visibleModels` path share ONE draft, every one of them parses it in `save()`, all N write ops address the same path, and **only the last field's op survives**. That silently rewrote the allowlist from the last catalog model instead of the row the user toggled (found by driving the real `SettingsForm` over the section). A map gives every checkbox a path of its own. The TUI stages an override only when it DISAGREES with the array (otherwise a `clear`), so toggling back to the inherited state leaves no residue; `readModelVisibility()` drops non-boolean entries, so a hand-edited document falls back to the array instead of hiding a model. `tests/tui-settings.test.ts` pins the unique-path invariant (a regression test for that bug) and the override semantics; `tests/adapter.test.ts` pins the resolution order.
  - The settings page's model editors share one dropdown (`ModelMultiSelect` in `src/client/section.tsx` over React-free helpers in `src/client/model-select.ts`, pinned by `tests/model-select.test.ts`): a search box filters by id/display-name substring (blank = all), entries group under plan-tier headings, stale selections (retired upstream) render flagged with a one-click cleanup on the Visible models card (never auto-dropped — an empty catalog from a fetch failure must not wipe the list). Tier headings ride the `commandcode/models` Remote per entry (`CommandCodeCatalogModel.tier`, stamped Host-side from `KNOWN_PLANS`; optional on the wire for older Hosts, shaped defensively in `refreshCatalog()`), because the client bundle cannot import `src/capabilities.ts` — when upstream adds a plan tier, extend BOTH the Host snapshot and the vendored `TIER_HEADINGS` in `model-select.ts`. The client-bundle constraint (platform/seed modules only, see the tsdown `external` list) is why the tier travels on the wire instead of an import.
- **Retry**: `providerRetryPolicy()` pins a near-unbounded transient-only policy (`mode: 'normal'`, `maxRetries: 1000`, whitelist `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`) — opencode-style persistence that still fails fast on permanent errors (`INVALID_CREDENTIAL` etc. are not retryable); waits double from 500 ms and cap at 15 min (`RETRY_MAX_DELAY_MS` in accounts.ts, ±10% jitter); executed by dsh-llm-retry (active in every default profile via dsh-base) at agent-step boundaries. Smart waits ride `providerRetryAfterMs` on the thrown `LlmError`: a 429's `Retry-After` header is parsed and attached, and the rotation pool's all-exhausted `RATE_LIMIT` attaches the wait until the earliest known window reset — both **capped at `RETRY_MAX_DELAY_MS`**, because in normal mode the executor abandons (not falls back on) a retry whose attached wait exceeds the cap. Captured once at route registration, so any future config knob for it would apply on profile restart.

## Commands

```sh
npm install             # devDeps incl. tsdown, tsx, typescript
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/**/*.test.ts
npm run test:install    # pack + install in a fresh pnpm 10.34.5 generation
npm run test:engine     # install the newest declared-compatible dsh and prove the bundle links there
npm run build           # tsdown -> lib/ (also runs via `prepare` on publish/git install)
npm pack --dry-run      # verify publish contents (must include lib/, cordis.patch.yml, README*, CHANGELOG, LICENSE)
```

## Release procedure

1. Edit `CHANGELOG.md` (Keep a Changelog format) for the new version.
2. `npm version patch|minor|major --no-git-tag-version` — bump without auto-tag.
3. `npm run typecheck && npm test && npm run build`.
4. `npm run test:engine` — installs the newest release `package.json` declares compatible and proves
   the built bundle LINKS and evaluates there. A stale local peer set cannot make this check
   (issue #43), so do not skip it when a peer range or an engine version moved.
5. Commit, then `npm publish` (requires the maintainer's 2FA OTP; the maintainer runs it, not the agent).
6. Tag and push: `git tag v<version> && git push && git push --tags`.
7. **Create a GitHub Release** for the tag (`gh release create v<version> --title "v<version>" --notes-file <file>`). The release notes must be **bilingual**: Simplified Chinese first (a `## 中文` section), then a `---` divider and the English translation of the same notes. **Style: short and user-facing** — one or two sentences per entry saying WHAT was added, changed, or fixed and what it means for the user; NEVER how (no file names, no internal function/mechanism names, no implementation or debugging narrative — the CHANGELOG carries the technical detail, the release notes are a summary of it). Releases — not tags or pushes — are what star followers see in their activity feed and get notified about; skipping this step makes the release invisible to users who starred the repo.

## Rules

- Keep changes focused; the ported wire logic is pinned by tests — update `tests/adapter.test.ts` when you change behavior.
- Do not commit, tag, push, or publish unless explicitly asked.
- Do not reintroduce pi/OMP auth-file scanning.
- Public API (exports from `src/index.ts`) is used by dsh's loader/registry — preserve `name`, `inject`, `Config`, `apply` and the `dsh.bundle` manifest shape.
