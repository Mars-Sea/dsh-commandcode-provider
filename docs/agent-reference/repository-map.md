# Repository map

Use this inventory only when locating an unfamiliar part of the repository. All paths are relative to the repository root.

## What this is

An unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin that connects the `commandcode` model provider to the Command Code Provider API. Ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).

- **Provider route**: `commandcode` (registered on the dsh `llm` service).
- **Plugin name**: `llm-commandcode`; package `@mars-sea/dsh-commandcode-provider`.
- **Distributed as**: a dsh *bundle* (npm package with a `dsh.bundle` manifest + `cordis.patch.yml` layer), installable via `dsh plugin --profile <name> add <pkg|github:...|path>`.

## Repository layout

```
src/adapter.ts        CommandCodeAdapter (LlmAdapter) — wire protocol (three
                      transports: the private CLI protocol, OpenAI Chat
                      Completions, and Anthropic Messages), message
                      conversion, SSE/JSONL stream parsing, catalog + cache
                      (incl. `supported_endpoints`), pre-stream account
                      rotation loop.
src/capabilities.ts   Static capability snapshot (model efforts/vision/thinking,
                      plan tiers, subscription plans, deals, peak pricing) +
                      its read helpers — the sync-only surface for upstream
                      CLI/doc updates; imported by src/adapter.ts and re-exported
                      from src/index.ts. Also holds the Messages-route model set
                      and the per-model output ceilings the catalog omits.
src/accounts.ts       CommandCodeAccountPool — multi-account slots, per-key
                      rotation state (429/401 marks), window-probe revival.
src/image-request.ts  Request-image target: the long-edge/byte budget one
                      request asks the attachment service to encode to
                      (`{ width, height, maxBytes }`), plus the local
                      `longEdgeDimensions()` that guards degenerate input.
src/image-tokens.ts   Per-family visual-token estimates (Anthropic, OpenAI,
                      Gemini, DeepSeek, plus a conservative fallback) behind
                      the adapter's `imageRequestPricing`.
src/transport-retry.ts  The bounded retry budget for `TRANSPORT` failures: the
                      per-agent failure count, its reset, and the bilingual
                      diagnosis a capped turn ends with (issue #39's second
                      report). Confirmed usage windows keep the route's long
                      retry cadence; transport errors use their own budget.
src/transient-retry.ts  Three-retry budget for ordinary transient failures;
                      confirmed usage windows and transport errors are separate.
src/request-timing.ts  Opt-in numeric phase and first-content timing summary
                      (`DSH_COMMANDCODE_TIMING`), without request contents.
src/stream-trace.ts   The opt-in raw-stream trace (`DSH_COMMANDCODE_TRACE`),
                      and the reason it exists: a stream this route cuts
                      mid-generation used to be reported as a finished turn,
                      so the evidence had to be recoverable from the wire.
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
src/client/usage.ts   Account-card controller (Remote fetch lifecycle +
                      formatting; React-free) + the TypertRemoteMap merge
                      declaration for `commandcode/report`.
src/client/section.tsx  The settings page React component: the unified
                      account list (immediate operations, inline quota,
                      per-account dedicated models) over the staged form
                      (Models, Privacy & security, Integrations & display,
                      Advanced).
src/client/card.tsx   The Models-page provider card (keyed-slot component +
                      the SlotMap merge for `settings.models.provider-card` /
                      `settings.models.footer`, mirroring upstream).
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
src/client/snapshot-store.ts  Vendored getSnapshot/subscribe/set triple (~30
                      lines; keeps a fourth require() target and a client-only
                      peer out of the bundle).
src/config-volatile.ts  The volatile-config helpers: `markVolatile()` /
                      `markVolatileFields()` (apply schemastery's
                      `.volatile()`; `apiKey` stays unmarked) and
                      `unwrapVolatileConfig()` (reads the frozen `{ get() }`
                      reference every marked field parses to, fresh per call,
                      so `apply()` and the adapter always see plain values).
src/client/settings-scope.ts  Self-contained `SettingsScope` over the
                      `remote.settings` wire (describe mirror + revision-fenced
                      mutate queue). The harness's own `settingsScope`
                      wrapper service was removed by the 0.1.7 settings
                      rewrite, so this IS the client half — there is no
                      engine-side replacement to switch to.
                      The namespace arrives through a resolver fed by
                      `ctx.inject(['remote.settings'], …)` — never read off
                      `ctx.remote`, which cordis refuses for a nested service.
icon.svg               Plugin-manager icon (package.json `icon`, dsh 0.1.7+).
locale/en.json         Plugin-manager localized title/description dictionaries
locale/zh.json         (`locale/*.json`, `meta.{title,description}`; en.json is
                      the anchor file the reader requires). Pure metadata —
                      older engines ignore both.
tests/adapter.test.ts Core adapter unit tests (node:test + tsx), including the
                      Anthropic Messages transport: adaptive thinking, effort
                      mapping, tool-schema root, `input_json_delta` assembly,
                      usage mapping, per-block thinking-signature replay, native
                      tool-result images, the three rejection shapes, and
                      `supported_endpoints` routing.
tests/accounts.test.ts Account-pool rotation tests.
tests/commands.test.ts getUsage + command tests (stubbed fetch, no network).
tests/settings.test.ts settings-page controller tests.
tests/settings-scope.test.ts the `remote.settings` scope lifecycle: derive,
                      revision-fenced writes, rejection recovery, queue
                      serialization, memory persistence, disposal, and the
                      inject-captured namespace handshake (the fake `remote`
                      throws the engine's own nested-service error, so a
                      direct read can never pass).
tests/volatile-config.test.ts the volatile helpers: `.volatile()` marking,
                      reference detection, per-call unwrap freshness.
tests/card.test.ts    Models-page provider-card tests (posture logic, key
                      write path, login affordance parity).
tests/snapshot-store.test.ts  Snapshot-store notification and disposal tests.
tests/update.test.ts  update-hint tests (semver compare, payload parse,
                      throttle cache, failure semantics).
tests/usage-wire.test.ts usage-Remote schema + descriptor tests.
tests/wire-shared.test.ts strict-codec contract: the registry's `create()`
                      check transcribed and run over every shipped descriptor,
                      plus a negative control for a `schema`-only codec
                      (issue #49).
tests/usage-client.test.ts account-card controller tests.
tests/login.test.ts   browser-login flow integration tests (real loopback
                      server driven with fetch; every failure reason).
tests/login-wire.test.ts login descriptor uniformity + status parser.
tests/login-client.test.ts login-panel controller poll lifecycle.
tests/client-boot.test.ts client-boot integration tests (real apply() against a
                      dsh 0.2.0-rc.2-shaped client assembly; settings page +
                      provider card, and the `remote.settings` scope path end to
                      end: directory read, invalidation re-read, a save over the
                      path-op wire, and the degraded profile without the
                      transport).
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
tests/package.test.ts package-metadata contract (one Harness peer range, one
                      dshReleases record, no dsh-client-runtime).
tests/config-schema.test.ts Config credential contract: literal apiKey fields
                      carry role('secret') and are stripped by redactSecrets.
tests/web-search.test.ts web-search provider tests (wire body, result mapping,
                      failure taxonomy, selection-field rewrite).
tests/tui-settings.test.ts dsh-TUI settings-section tests (declared fields,
                      secret-ref safety, unset-reachable options, effective
                      boolean defaults, registration lifecycle).
tests/transport-retry.test.ts  TRANSPORT budget: counts, per-agent isolation,
                      the reset point, the cancellation ordering, the message.
tests/stream-trace.test.ts  the raw-stream trace: switch resolution, JSONL
                      shape, the byte cap, degradation on an unwritable path,
                      and the adapter wiring on both a finished and a cut
                      stream.
scripts/probe-stream.mjs  One-shot LIVE probe with the trace on: drives the
                      adapter without the harness, so a cut here is the
                      provider's and a clean finish means the cut is above it.
scripts/verify-messages-live.mjs  LIVE end-to-end run of the plugin's OWN
                      Messages transport (not a hand-written fetch): routing,
                      stream assembly, tool loop, images, native tool-result
                      media, thinking-signature replay. This is the check that
                      catches what unit tests cannot — it found the `temperature`
                      rejection that failed every real request while the suite
                      was green. `VERIFY_DRY_RUN=1` sends nothing.
scripts/probe-messages-contract.mjs  LIVE `/provider/v1/messages` request-shape
                      probes that the gateway rejects early (routing, tool-schema
                      root, `max_tokens` ceiling, bare-prose validation), so
                      most of the contract costs no output tokens.
scripts/probe-messages-stream.mjs     LIVE Messages success-path probes: the
                      event sequence, tool-call fragment assembly, images, and
                      tool-result media. Needs a Claude-entitled key.
scripts/probe-messages-thinking-trigger.mjs  LIVE hunting for the request shape
                      that makes the model emit a thinking block, then the
                      replay matrix that proves a signature is required and
                      omission is accepted. Also covers the `output_config.effort`
                      value domain and whether `tool_use.id` length is bounded
                      (it is not; only the two sides must agree). Needs a
                      Claude-entitled key.
scripts/sync-output-limits.mjs  Regenerates `MODEL_OUTPUT_TOKEN_LIMITS` in
                       `src/capabilities.ts` from models.dev. Command Code calls
                       these models through their vendor's own API, so the
                       vendor's published `max_tokens` ceiling is what it
                       records — 74 of 84 ids, falling back to a `:free`/`-free`
                       variant and then to unanimity across providers. The 10
                       no vendor publishes are learned at runtime from the
                       endpoint's own refusal (issue #71). `--check` reports an
                       unreachable catalog distinctly from real drift.
scripts/verify-isolated-install.mjs  pnpm 10 marketplace-generation tarball install smoke.
scripts/verify-engine-load.mjs  Engine-load smoke: stages the published surface against a
                      real dsh engine and imports it there, so a bundle that cannot link
                      against the engine it will run on fails before publishing (issue #43).
cordis.patch.yml      Bundle patch layer (inserts the llm-commandcode row).
tsdown.config.ts      Build config (tsdown -> lib/, ESM, .d.ts + client.js).
```
