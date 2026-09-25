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
                      request asks the attachment service to encode to
                      (`{ width, height, maxBytes }`), plus the local
                      `longEdgeDimensions()` that guards degenerate input.
src/image-tokens.ts   Per-family visual-token estimates (Anthropic, OpenAI,
                      Gemini, DeepSeek, plus a conservative fallback) behind
                      the adapter's `imageRequestPricing`.
src/transport-retry.ts  The bounded retry budget for `TRANSPORT` failures: the
                      per-agent failure count, its reset, and the bilingual
                      diagnosis a capped turn ends with (issue #39's second
                      report — the route policy's 1000-attempt cadence is for
                      failures the provider ASKS to have retried, not for a
                      connection that cannot be established).
src/stream-trace.ts   The opt-in raw-stream trace (`DSH_COMMANDCODE_TRACE`),
                      and the reason it exists: a stream this route cuts
                      mid-generation used to be reported as a finished turn,
                      so the evidence had to be recoverable from the wire.
src/systemone.ts      Host-side client for the System One decision endpoint
                      (`POST /provider/v1/systemone`, model `typesafe/jev`):
                      typed questions in, probabilities out, strict answer
                      parsing, and the failure taxonomy callers fail closed on.
                      NOT a chat route — the model is absent from
                      `/provider/v1/models` and must never be listed as one.
src/command-guard.ts  The AI command guard: an answerer on the harness's
                      `approval/request` waterfall that grants `allowed-once`
                      only on a confident "safe" verdict (and, for sandbox
                      escalations, explicit scope and necessity verdicts), plus
                      the hard denylist, the thresholds, the execution/decision
                      caches and the transparent `tools/pre-execute` observer
                      that supplies the command the approval payload omits.
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
tests/adapter.test.ts Core adapter unit tests (node:test + tsx).
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
                      dsh 0.1.7-rc.2-shaped client assembly; settings page +
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
tests/systemone.test.ts  the decision endpoint contract: request body, headers,
                      strict per-type answer parsing, and the failure taxonomy
                      (HTTP, network, timeout, caller abort, unreadable body).
tests/command-guard.test.ts  the guard's fail-closed ladder (disabled, unknown
                      call, non-shell tool, oversized or denylisted command,
                      failed decision, missing verdict, low probability), the
                      denylist families and the ordinary commands they must
                      leave alone, memo reuse, and the listener wiring
                      (`tools/pre-execute` transparent, `approval/request`
                      prepended).
scripts/check-command-guard.mjs  Offline explainer for the command guard:
                      prints which denylist rule (if any) would refuse to judge
                      a command, or that it would go to the decision model, and
                      with no arguments prints the whole denylist. Imports the
                      real module, so the answer cannot drift from the plugin.
scripts/probe-stream.mjs  One-shot LIVE probe with the trace on: drives the
                      adapter without the harness, so a cut here is the
                      provider's and a clean finish means the cut is above it.
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
  (e.g. `@deepseek-ai/dsh-client-ui-primitives`). The 0.1.7 Web shell
  seeds `@deepseek-ai/dsh-client-store`; this client keeps the smaller local
  `getSnapshot`/`subscribe`/`set` subset in `src/client/snapshot-store.ts`
  instead — ~30 lines, versus a fourth `require()` target and a client-only peer
  for the engine's `set()` semantics (dev-mode deep freeze, forced
  replacement). The settings page binds the
  `llm-commandcode` namespace through THIS PLUGIN'S OWN scope over
  `remote.settings` (`src/client/settings-scope.ts`) — the harness's
  `ctx.settingsScope` wrapper was removed by the
  0.1.7 settings rewrite and has no replacement, so this IS the client half;
  `settingsScope` must never reappear in the exported
  client `inject` list, because it is a service 0.1.7 does not provide and gating
  on it would gate EVERY surface (page, card, usage card, panel, session cost)
  into silence.
  The scope degrades on its own instead: no `remote.settings` → status
  `unavailable`, page renders its empty state. It writes the API
  key through `ctx.remote.credentials` under the `COMMANDCODE_API_KEY`
  reference — never through the settings section, so the key literal cannot
  leak into a settings document.
  `tests/settings.test.ts`, `tests/settings-scope.test.ts` and
  `tests/client-boot.test.ts` pin these
  internal faces. The exported client `inject` list is exactly
  `slots`, `locale`, `remote`: `connection` was dropped with the pre-0.1.2
  ApiProxy credential path it existed for, and a gate on a service some profiles
  never mount parks the whole bundle.
- **dsh 0.1.7's settings rewrite is the only settings world this plugin knows** (`src/config-volatile.ts`, the `ctx.inject(['settings'], …)` block in `src/index.ts`): 0.1.7 REPLACED the settings.yaml document with schema-derived profile Config forms (`SettingsProvider` → `SettingsForms`; `installSection` and the `settingsScope` client service are both gone), and its `settings.describe()` projects each entry through `volatileForm()` — a form contains ONLY schema nodes carrying `meta.volatile`, and a form edit whose path does not lie beneath a marked node is REFUSED. Six consequences are load-bearing:
  (1) **Every Config field except the top-level `apiKey` secret is marked via `markVolatileFields()`** — an unmarked field would be invisible to AND unwritable from the settings page. The mark is UNCONDITIONAL: `.volatile()` is a schemastery 3.18.3 feature and the one supported engine pins `~3.18.4`, so the method is always present (that is why `@deepseek-ai/schemastery` is a peer at `~3.18.4`, not `^3.18.2` — a profile resolving 3.18.2 would mark nothing and render a blank settings form). `apiKey` stays unmarked on purpose: no settings surface writes it (page and TUI both write keys through the credentials seam), so a config-file edit to it reloading the fiber is correct for a secret literal.
  (2) **`apply()` receives frozen `{ get() }` references for every marked field**, so `current()` is `unwrapVolatileConfig(config)` — a FRESH unwrap per read, because a reference's identity is stable while its value changes. The loader wraps EVERY marked node, unset fields included, so a parsed config always yields a new object per read; there is deliberately NO identity-keyed memo over it (the one that used to exist could never hit, and a cached plain snapshot would go stale on the next settings write). Only top-level fields are marked, so one unwrap level is complete. Everything downstream keeps reading a plain `Config`.
  (3) **Volatile writes commit in place — no remount — and notify the owning fiber** with `loader/volatile-update` (paths already committed). The listener re-runs the two facts that are NOT re-derived from `current()` per use: the web-search selection (a written private field, see the web-search bullet) and the dsh-TUI section re-registration (its option lists are frozen into the declaration). It is typed structurally because the event comes from `cordis-plugin-loader`, which is not a peer of this bundle.
  (4) **The Host registration is one call**: `configure({ auto: false }, ctx.fiber)` as an effect on the settings child, which declares that we ship our own page (so SettingsForms publishes no auto-generated form for this entry). There is no capability branch and no local service seam: `import type {} from '@deepseek-ai/dsh-settings'` augments `Context` with the real `SettingsForms`, so the call typechecks against the engine it will run on.
  (5) **The one-time 0.1.7 settings.yaml import needs no cooperation from us** — the engine looks the section up BY PROFILE ENTRY ID, and our section id and entry id are the SAME string (`llm-commandcode`). Never rename one without the other: a mismatch strands existing users' non-secret settings in `settings.yaml.imported` (logged, not applied). Pinned by `tests/volatile-config.test.ts` (the helpers), `tests/settings-scope.test.ts` (the client scope), `tests/package.test.ts` (four-way range sync + the single `dshReleases` record) and `npm run test:engine`.
  (6) **On the browser side the namespace object must be captured from an INJECT-SCOPED context — never read off `ctx.remote`** (`createSettingsScope(ctx, ns, resolveRemote)` in `src/client/settings-scope.ts`, wired by the `ctx.inject(['remote.settings'], …)` block in `src/client/index.ts`; the 0.1.7 settings-page report: 《所有的按钮和开关都无法点击，下拉选择模型也无法使用》). `remote.settings` is a Cordis service NESTED under the `remote` service (api-gateway registers one `Service` per contribution namespace under the name `remote.<ns>`), and cordis answers a read from a fiber that does not declare that name in its inject list with `Error: cannot get property "remote.settings" without inject`. Our plugin declares only `remote`, so the old direct read threw — inside the mirror's own `try`/`catch`, which is why NOTHING was logged and no `settings/describe` ever left the browser. The consequences are the whole reported symptom: the mirror never leaves `idle`, `RemoteSettingsScope` keeps its INITIAL snapshot (`status: 'loading'`, `writable: false`, `value: undefined`), and since `disabled = !state.writable` the page renders its read-only banner with every input, switch and select disabled, while the boolean toggles fall back to their hardcoded `defaultChecked` (which is why a reader may see "correct-looking" switches over empty text fields). The same rule governs every other namespace this plugin reads: `remote.credentials` and `remote.commandcode` were already resolved through their own inject callbacks (`(remoteCtx) => remoteCtx.remote.<ns>`), and `$host` / `$on` / `$mount` are plain members of the declared `remote` service, so those stay direct reads. A namespace that never mounts leaves the pending inject idle and the page keeps its degraded state — do NOT "fix" this by adding `remote.settings` to the exported client `inject` list, which would gate every surface (page, card, usage card, panel, session cost) on a service a profile may not serve. Two recovery rules ride the same wiring and are equally load-bearing. (a) The mount callback re-reads the USAGE report (`refreshUsage?.()` — a seam declared before the effect, because the inject callback can run before the controller's own `const` and a temporal-dead-zone read would THROW): a surface that asked before the namespace landed (the quota card's first paint does, every boot) stored the synthetic "remote is not mounted" failure as `status: 'error'`, and `shouldRefresh` only fires from `idle`, so nothing else would ever retry it. (b) `SettingsDescribeMirror` retries a FIRST describe failure on a bounded 1/2/4 s ladder (`SETTINGS_DESCRIBE_RETRY_MS`, injectable timer): with nothing ever held the scope keeps its initial `loading`/`writable: false` snapshot, which the settings page renders as a fully disabled form behind a "read-only" banner, and the forwarded invalidations need a live Host to fire — so a Host that was still starting up left the page dead until a reload. A failure with a HELD view schedules nothing (the page is already showing the last good document). Pinned by `tests/settings-scope.test.ts` (its fake context's `settings` getter THROWS the engine's exact error, plus the unmounted → mount + `refresh()` handshake, the retry ladder, and its disposal) and by `tests/client-boot.test.ts`, whose `remote` is a real `Service` and whose namespaces mount as `remote.<ns>` child-fiber services (one boot defers `commandcode` by a macrotask and asserts the mount callback re-read the report) — so a regression fails the boot suite, not just the browser.
- **Isolated package install**: pnpm 10 auto-installs the package's DSH peers
  when a desktop marketplace prepares a fresh generation. Keep
  `@deepseek-ai/dsh-invariants` as an explicit peer matching
  the other Harness packages; otherwise pnpm reaches it only through
  `dsh-llm`, rewrites the prerelease range to an unsatisfiable stable range,
  and aborts with `ERR_PNPM_NO_MATCHING_VERSION`. Do not move it to
  `dependencies`: the active profile owns Harness packages. Run
  `npm run test:install` after changing DSH peer metadata. **Client-only UI
  peers the Web frontend already seeds are the ONE exception, and they must stay
  optional AND stay in `devDependencies`** (PR #52). The shipped
  `dsh-web-frontend` hands every client bundle a `staticModules` table —
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit` (read out of the 0.1.7-rc.2 engine) — so
  the three `require()` targets `lib/client.js` carries resolve in the webview
  with no installed copy, which is why `react`,
  `@deepseek-ai/dsh-client-ui-primitives` and
  `@deepseek-ai/dsh-client-ui-slots` are the only peers carrying
  `peerDependenciesMeta.optional: true`. That marking is not cosmetic: an older
  Desktop release validates the entire peer closure of every active plugin
  (`apps/desktop/src/profile-packages.ts`, which honours exactly this field) and
  its runtime tree ships host packages only, so a non-optional client-only peer
  is a hard startup failure there (`desktop profile: … requires missing …`);
  note that current DSH master no longer performs that walk, so the fix unblocks
  the released Desktop builds rather than the newest one. Every OTHER peer stays
  required — a `dsh.client` row is resolved and served by the Host, and a
  harness peer a fresh generation does not install is a bundle that cannot load.
  The second half is the trap the marking opens: **npm and pnpm auto-install only
  NON-optional peers**, so each optional name must also be a `devDependency` or
  the authortime tree silently loses it — `tests/client-boot.test.ts` imports
  the React component tree, so an absent `react` is a red `npm test`, and
  `dsh-client-ui-primitives@0.1.7-rc.2` declares NO dependencies at all, so
  nothing else would pull it in. Note that the same package's npm entry point
  imports `clsx`, `katex` and the shiki/mdast stack without declaring them
  (the ENGINE's own tree does not install them either): it is a seed module,
  resolvable only through a bundler, which is why `tests/_css-module-loader.mjs`
  serves a two-component stub for it and `tsc` still typechecks every call site
  against the package's `.d.ts`. `tests/package.test.ts` pins the exact
  optional set, that every optional name is a declared peer, and that it stays a
  development package.
- **The Harness peer range names exactly ONE release, and that is
  load-bearing.** Semver admits a prerelease only inside the same
  `major.minor.patch` tuple as the comparator, so `^0.1.7-rc.2` resolves to
  `0.1.7-rc.2` and NOTHING else. That exactness is the point: this bundle is
  maintained against one engine, and a range that quietly admitted a neighbour
  is how a broken pairing stayed invisible (issue #43). A caret once pinned every
  peer to an engine four releases old, so a fresh generation installed a second,
  stale copy of the Harness beside the running engine instead of pairing with it;
  worse, it made `npm test` structurally blind to engine drift, because a
  `link:`-installed profile resolves the plugin's imports from the checkout
  rather than from the engine. The one
  supported range is written VERBATIM in `peerDependencies`, `devDependencies`,
  `dsh.compatibility.dsh` and `engines.dsh`, and `tests/package.test.ts` fails if
  those four drift apart, if the range stops admitting a release that
  `dsh.compatibility.dshReleases` calls compatible, or if `dshReleases` grows a
  second record. Move the range and that single record together, and only once
  `npm run test:engine` passes against the new engine.
- **`npm run test:engine` is the only check that can see a bundle which cannot
  load on its engine** (issue #43): it resolves the newest release the manifest
  declares compatible (or `--engine <dir>`, or `$DSH_ENGINE`), copies this
  checkout's PUBLISHED surface into a tree whose peers ARE that engine's, and
  imports the bundle there. A `link:` install cannot substitute for it — the
  plugin's own module directory shadows the engine's, which is exactly how a
  removed export (`offloadRequestImagesWithPolicy` in 0.1.6) shipped green. It
  also audits every static named import against the engine's exports, the client
  bundle's `require()` calls against the platform seed table, the durable
  request-image offload contract the engine exports, and — by instantiating the
  staged adapter — the image pricing that engine's token meter will ask for.
  Being the only check with the engine's own peer tree, it is also where the
  Config schema is proven to drive that engine's settings forms (every field
  marked volatile, parsing to a live reference). Run it before publishing and
  whenever a peer range or an engine version changes.
- **Models-page provider card (`settings.models.provider-card`)**: a keyed
  SlotMap seat ui-settings-models declares — it
  dispatches with `entryKey = settingsNs` on every provider card of an adapter
  family. The client entry registers a cell with `key: 'llm-commandcode'`
  (the directory row's settings namespace), carrying its own inject face
  (store hooks + actions) because the declaring entry is ui-settings-models',
  not ours; the `t` seat comes from the registration's own `locale`
  namespace. The card (src/client/card.tsx) is the row's configuration panel
  driven by the OFFICIAL 编辑 toggle: closed it renders nothing (the row looks
  like any other provider row); open, it hides the official editor shell —
  for `llm-commandcode` the page's `layoutOf` returns "unknown", so that shell
  carries only a config hint over a permanently disabled apply — and shows
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
- **Zero data retention (`Config.zdr`, default off)**: `connectGenerate()` sends `x-cmd-zdr: 1` on BOTH chat transports for EVERY request when enabled. The provider refuses a model without an available ZDR upstream with `422 cmd_zdr_no_providers`; `generateHttpError()` diagnoses it bilingually. NEVER omit the header based on `KNOWN_NON_ZDR_MODELS` or retry without it: that would silently lose the privacy guarantee. The snapshot in `src/capabilities.ts` is informational and may lag provider coverage or capacity. The `typesafe/jev` decision endpoint has no ZDR upstream and is a separately documented opt-in. `tests/adapter.test.ts` checks both transports, off by default, unsupported models retaining the header, and 422 diagnosis.
- **Wire protocol** (reverse-engineered, command-code@1.28.4; re-verified through 1.65.2):
  - `POST {apiBase}/alpha/generate` — CLI transport body `{ config, memory, taste, skills, params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`. Used for Go-plan accounts (the only plan without Provider API access) and as the fallback when `/provider/v1/chat/completions` returns `upgrade_required`. Historical reasoning IS replayed here as a `{ type: 'reasoning', text }` part of the assistant content array, in content order — the official CLI's `toWireMessages` converts every `thinking` block that way (command-code@1.54.0), and the provider rejects a DeepSeek thinking-mode tool loop whose assistant tool calls arrive without their reasoning (`The reasoning_content in the thinking mode must be passed back to the API.`, issue #34). Do not "restore" the old drop-reasoning behavior: it was ported from the pi plugin and is no longer upstream's shape.
  - `POST {apiBase}/provider/v1/chat/completions` — documented OpenAI-format transport with a flat body `{ model, messages, tools?, max_tokens, temperature, stream, reasoning_effort? }`. Used for accounts with Provider API access; historical reasoning is replayed as `reasoning_content`.
  - **Every tool's root schema is normalized to `type: 'object'`** by `toolParametersSchema()` before either body is built (issue #35). The gateway validates the root of each function schema and rejects the entire request otherwise (`Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"', got 'type: null'`). The harness's own `defineTool` always declares that root, so the failing schema comes from a tool registered outside it — a third-party plugin's or MCP bridge's hand-written schema (a type-less `{ properties, required }`), an empty `{}`, or a generator's root `$ref`. A schema that already declares an object root passes through untouched; a type-less object-shaped one gains the type; a root `$ref` is inlined from its local `$defs`/`definitions`; an `allOf`/`anyOf`/`oneOf` root is flattened (branch properties unioned, `required` kept only where every alternative demands it); anything else degrades to a permissive free-form object, since a refused request helps no one. Only the root is touched and every path returns a copy (the harness may deep-freeze tool schemas), and the walk is depth-bounded so a self-referential JS schema cannot spin. `toolParametersSchema()` is applied at both call sites, so the CLI `input_schema` and the OpenAI `function.parameters` cannot drift apart.
  - Image parts use the official CLI wire shape on `/alpha/generate`: `{ type: 'image', source: { type: 'base64', media_type, data } }`; OpenAI `/provider/v1/chat/completions` uses `{ type: 'image_url', image_url: { url: 'data:...' } }`.
  - CLI stream: SSE-ish JSONL events `text-delta | reasoning-start/delta/end | tool-call | tool-result | cache-write-tokens | finish | error`. command-code@1.65.2 added the standalone `cache-write-tokens` reading; the official CLI keeps the last finite non-negative value and uses it only when `finish.totalUsage.inputTokenDetails.cacheWriteTokens` is zero/missing. `handleCliEvent()` mirrors that fallback, including the standalone-event case, so cache writes are not silently dropped from token/cost accounting.
  - OpenAI stream: standard SSE chunks with `delta.reasoning` / `delta.reasoning_content` / `delta.reasoning_details` / `delta.content` / `delta.tool_calls`, a `finish_reason`, and optional `usage`. **The thinking field is per model FAMILY, not global, and the gateway does not normalize the spelling** (measured live against the whole catalog, 2026-09-16): DeepSeek answers with the scalar `delta.reasoning` PLUS an OpenRouter-shaped `delta.reasoning_details` array (`[{ type: 'reasoning.text', text, format, index }]`, chunked one array per delta with `index: 0`), GLM/Qwen/Kimi answer with the DeepSeek-native `delta.reasoning_content`, and the OpenAI family answers with the scalar `delta.reasoning` PLUS a `reasoning_details` entry `{ type: 'reasoning.summary', summary, format: 'openai-responses-v1' }` (measured 2026-09-18 on gpt-5.6-luna, 6/6 interleaved rounds: the scalar and the array's `summary` carried the identical text every round, ~367 vs ~371 chars, so the two endpoints differ in wording only — Gemini was not re-measured and keeps its earlier "neither" reading). All three spellings are read, in that order, so no family's thinking is dropped. `reasoningDetailsText()` reads each entry's own text members — `text` first, then `summary` — rather than filtering on `type`: BOTH array vocabularies are live (`reasoning.text` for DeepSeek, `reasoning.summary` for the OpenAI family), so a `type` filter would drop one family and reading only `text` would drop the other. Per entry `text` wins, but an EMPTY `text` must not shadow a populated `summary` (the Responses wire emits `text: ''` placeholders), so that fallback tests for non-empty rather than merely present; encrypted-blob entries carry neither member and contribute nothing, and no entry carries both members, so a summary is never counted twice. The array branch is a forward guard rather than the live path for ANY family — every family that sends the array also sends a scalar alongside it — and it now covers both array vocabularies, which is what makes the guard real for the OpenAI family instead of nominal; `tests/adapter.test.ts` pins the array-only path for both vocabularies, the empty-`text` fallback, that a scalar beside an array is never double-counted, that encrypted-blob entries contribute nothing, and that the block still closes before the text block opens.
  - Catalog: `GET {apiBase}/provider/v1/models` → `{ object: 'list', data: [{ id, name, context_length, supported_endpoints }] }`. The `supported_endpoints` member is new as of command-code@1.55.0/1.56.0 and is the authoritative per-model route list (64 × `['/chat/completions','/responses']`, 9 Claude ids × `['/messages']` (`claude-opus-5-5` is the ninth), and 8 × `['/chat/completions']` as of the 2026-09-25 public catalog); this adapter ignores it and keeps the `claude-*` prefix rule in `requiresMessagesEndpoint()`, which agrees with it today.
  - Provider API endpoints (docs, 2026-09-25): `/provider/v1/chat/completions`, `/provider/v1/responses` (OpenAI + open models; added in command-code@1.55.0), `/provider/v1/messages` (Claude family only), `/provider/v1/models`, and `/provider/v1/systemone` (System One decisions, model `typesafe/jev` — new in the docs and in the CLI bundle at command-code@1.64.0 and still present, with the same call site, in the 1.65.2 bundle; it is NOT a chat route, the model is absent from `/provider/v1/models`, and only `src/systemone.ts`'s own request path reaches it). This adapter's two chat transports stay the first plus `/alpha/generate`; neither is deprecated.
  - Web search: `POST {apiBase}/alpha/web-search` — body `{ query, numResults, allowedDomains?, blockedDomains? }` → `{ results: [{ title, url, snippet }] }`; same `Authorization: Bearer <key>` + `x-command-code-version` as generate.
  - Defaults: `apiBase = https://api.commandcode.ai`, `COMMAND_CODE_CLI_VERSION = '1.65.2'`.
  - **Request image budget (issue #37)**: the gateway caps a whole request body at a measured ~50.17 MB (undocumented — their Error Codes page has no 413). Both transports inline every historical image as base64 and the harness never reclaims history, so a long session (a vision self-check loop reading back dozens of screenshots) used to cross the cap once and then fail EVERY later request on this route with HTTP 413, while the same conversation worked on another provider. `stream()` therefore builds both bodies from a PROJECTED history, never the raw one, and the offload set is a DURABLE session fact: `withSurfaceOffload()` renders the surface's `offloaded` marks through the engine's `projectOffloadedImages` (so an evicted image can never be re-sent as pixels) and an over-budget history FAILS with `IMAGE_OFFLOAD_REQUIRED` + the count from `requiredImageOffload`, which the default `dsh-compaction-image-offload` plugin records as one `image/offload` event and retries — the omission then survives restore and fork, and the token meter stops counting evicted images as context. Those three symbols are STATIC imports of `@deepseek-ai/dsh-llm` (they are the reason the peer range is pinned so tightly: a named import of an absent export is a link-time failure that takes the whole plugin down, issue #43). `REQUEST_IMAGE_BUDGETS` is a two-rung ladder: rung 0 is the standing budget (32 MiB base64 / 60 images, 16 MiB / 30 removal quanta), rung 1 (8 MiB / 12) is asked for ONLY after the gateway actually answered 413, because the cap also covers text and tool bytes and cannot be budgeted exactly from here. That code stays outside `providerRetryPolicy()`'s whitelist: the surface mutation has to happen before any resend can help. The 413 rung becomes another offload request through the same channel, so those extra omissions are recorded too, and a rung with nothing left to offload falls through to the 413 diagnosis rather than asking for an offload that cannot happen — which is also what keeps the branch from ever resending a body. A tool-result image evicted this way surfaces as the tool message's own placeholder text, so no carrier user message is emitted for it. `generateHttpError` maps 413 to a bilingual `PROVIDER_HTTP_ERROR` (NOT retryable by dsh-llm-retry — a byte-identical resend cannot succeed) whose message names the undocumented cap and the only user lever left. Pinned by the "Request image budget (issue #37)" tests in `tests/adapter.test.ts` (no-op under budget, the count and byte rungs, tool-result images counting, OpenAI parity, and the 413 that never resends an image-free body) plus the "durable contract (issue #43)" tests, which drive the offload request through the injectable `imageOffload` seam. The count's second carrier, `failure.offloadImages`, is what `dsh-compaction-image-offload` reads back, and is pinned by `npm run test:engine` against a real engine. Two further pieces of the same budget: the bytes that travel are the attachment service's REQUEST VERSION, not the stored original (`readImageRequest()` against the target in `src/image-request.ts` — a 1568-px long edge, inside the Anthropic ceiling and the OpenAI/Gemini high-detail band, and at most 1 MiB encoded), while the budget itself still accounts the DECLARED normalized size, which is what makes it conservative rather than exact; and the token meter prices every occurrence through `imageRequestPricing` (`src/image-tokens.ts`), charging the family's published visual-token rule at that same request target, zero vision tokens plus the placeholder text for an occurrence the surface offloaded or a route that takes text only, and the most expensive known rule for a family we cannot tell apart (under-reporting context is what walks a session into its own window).
- **API key resolution order** (in `src/index.ts`): `config.apiKey` → credential ref `apiKeyEnv` (default `COMMANDCODE_API_KEY`, via the dsh credentials seam) → launch environment → official CLI auth file `~/.commandcode/auth.json`. **pi/OMP auth files are intentionally NOT scanned** — keep it that way.
- **Multi-account rotation** (`src/accounts.ts` + the adapter's connect loop): the top-level key forms the `default` slot; `Config.accounts` (`[{ label, apiKeyEnv | apiKey }]`) adds more, in rotation order. Rotation is **passive**: a key is marked only on a real pre-stream rejection (429 → `unknown`/`cooldown` carrying a `window` or `throttle` cause, 401 → `disabled`), and the adapter's `rotateApiKey` hook re-sends the same request with the next account's key (safe: nothing streamed, the body is account-independent, `threadId` random per request — mid-stream failures NEVER rotate). When every account is marked, the pool probes `/alpha/billing/credits` per key (`probeWindowLimits`, which reads BOTH windows the endpoint publishes — the five-hour and the weekly one) to revive reset windows, else throws `RATE_LIMIT` naming the earliest `resetAt` (all-401 → `INVALID_CREDENTIAL`). State is keyed by API key, not slot — shared credentials share one mark. **Manual selection**: `Config.activeAccount` (a slot id) pins the serving account via the pool's `preferredId` seam + `selectActiveAccount()` (shared with the usage view's active badge); a pinned-but-exhausted or unknown id falls back to rotation order. **Model routing**: `Config.modelAccountRules` (`[{ models: string[], account }]`) lists catalog model ids per account slot; the request's model reaches key resolution (`resolveApiKey(connection, model)`), the pool's `modelAccountRules` seam re-reads rules per resolution, and `matchModelRule()`/`selectAccountForModel()` serve the routed account before preferred/rotation — an unusable routed account falls back, so the router is a hint, never a hard gate. **A fallback is never permanent, and that is a separate mechanism from the all-marked pass** (issue #51): a 429 marks the key `unknown`, which `accountUsable()` refuses until a probe clears it, while the all-marked probe pass runs only once NOTHING can serve — so a single 429 against the account the user explicitly chose demoted every later request to `default` for the lifetime of the process, and re-selecting that account in settings could not help, because the mark lives on the resolved key rather than on the selection (only a restart dropped the in-memory state, which is the "重启 dsh 才能换回来" in the report). `resolveKey()` therefore re-checks the explicit account — the manual pin, or a rule's routed slot — before serving the fallback: its window is probed at most once per `EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS` (60 s, which bounds a probe endpoint that keeps failing — the throttle's stamp SURVIVES a revival, because a probe that clears a window the chat endpoint still rejects would otherwise buy a second probe on the very next request: one billing GET plus one doomed upstream attempt each time), a window that is no longer exceeded drops the mark and puts the user's own choice back on that very request, and an exceeded one is stamped as a `cooldown` carrying the provider's own `resetAt`, after which the account returns by the clock with no further probe. Three gates keep the steady state free: only an `unknown` mark is probed (a `cooldown` already expires by itself, and a `disabled`/401 key clears only when the stored credential changes), every key this request already used is out of play (the rotation hook resolves with `tried`, and the pool's probe pass skips them too), and an account nobody explicitly asked for is still never probed while another one can serve. The probe's second effect is visible in the usage card: a pinned 429 now shows a real cooldown end instead of an open-ended "rate limited". **A rejection the pool cannot act on must not trap the turn either** (issue #51's follow-up report: 《切到一个不可用账号后就报 400，还挺频繁》). Three verified gaps produced it. Only 429/401 rotated, while the provider's account-scoped rejections are wider — the official CLI's own classifier (command-code@1.56.0: `parseWindowLimitError`, `isInsufficientCreditsRequestError`, `parseSpendCapError` and the terminal-marker list `["premium_credits_exhausted", "model_not_in_plan", "insufficient credits"]`) accepts the code `RATE_LIMITED` on ANY status (a 5xx that proxies the provider's own limit body included — the classifier reads the code BEFORE its status guard, and only a code-less 5xx/408 keeps the retry cadence for every account), `400 Insufficient credits`, the codes `INSUFFICIENT_CREDITS`, `USAGE_EXCEEDED`, `PREMIUM_CREDITS_EXHAUSTED` and `MODEL_NOT_IN_PLAN` (underscored and spaced spellings both count, and a code-only body is enough), all of which the adapter reported as a permanent `PROVIDER_HTTP_ERROR`. Those four structured codes are matched on EVERY status (`ACCOUNT_UNAVAILABLE_CODES`), exactly like `RATE_LIMITED`: only the PROSE scan is confined to 4xx, so a 5xx that proxies a credits/plan body rotates past the account instead of being retried as `SERVER`. Rotating could not have saved them anyway: the pool was asked to exclude only the just-rejected key and answered with the first *usable* account — the same key whenever the rejection marked nothing — so the adapter's tried guard ended the loop and the accounts behind it were never reached. And the revival probe read only `windowLimits.fiveHour`, so an account whose WEEKLY quota was spent while its five-hour window was open came back on every all-marked pass. `classifyAccountRejection()` therefore applies the CLI's rules and yields exactly four reasons, split by EVIDENCE — what the pool may claim — rather than by what it does: `rate-limit` (a usage window the provider NAMED: a 429 or the code, marked as a cooldown when the body's `error.rateLimit.reset`, in seconds, or its `resets at <ISO>` wording names the real reset — and only while that instant lies within `MAX_TRUSTED_RESET_MS` (30 days), because a bogus magnitude would otherwise pin a `cooldown` no probe ever revisits AND throw `RangeError` out of the `toISOString()` in the diagnosis; a dropped reset degrades the mark to `unknown`, which the probe pass re-checks — else as an `unknown` mark whose window the next all-marked pass probes) and `throttled` (a 429 or bare `RATE_LIMITED` that named NO window — `readWindowLimitEvidence()` mirrors the CLI's `parseWindowLimitError`/`resolveWindowLabel`, which calls a rejection a window limit only for `error.rateLimit.window ∈ fiveHour|weekly|daily` or the "usage limit for your plan" wording). Both rotate and both mark the key; only a `window` mark lets `allAccountsUnusable()` report "all N account(s) have exhausted their usage window" (naming the earliest reset, or saying the provider published none), while a pool marked only by throttles answers "all N account(s) are rate limited (429) — the provider did not report an exhausted usage window; retrying" with no window claim and no invented wait. That split is issue #54: a bare 429 marked the key, the billing probe never confirmed a spent window, and the pool told the reporter its window was exhausted while the account card showed 5-hour 2% and weekly 10%. `markRejected()` ignores a reset on a throttle mark on purpose, keeping it `unknown` so a probe can still discover a real window limit behind it (and upgrade the mark's `cause` to `window` when it does). `invalid-credential` (401, marked) and `unavailable` (no credits, or a model outside this account's plan — rotated past but deliberately NOT marked, because the fact is about the model or the balance rather than the key, either can change without the key changing, and a `:free` model is still served by a credits-empty account) complete the four. The whole `tried` set rides the hook so one request can walk a four-account pool, and a pool that cannot serve answers with its own all-exhausted diagnosis (earliest reset + the retry wait) rather than the last raw rejection — but only when every account it could consider is MARKED. An account that was tried and left UNMARKED always wins instead: `resolveKey()` returns undefined so the caller's own rejection is surfaced as itself — in the all-tried branch AND in the branch that merely ran out of untried accounts — because calling a credits rejection 'all windows exhausted' would be a lie that also under-counts the pool and hands dsh-llm-retry a wait it cannot act on (a permanent refusal retried after ~15 minutes). The diagnosis is built from the pool's FULL account list, never from the tried-filtered subset, so its count and its earliest reset describe what the user configured; and an unroutable window limit that names its own reset ends the turn as a retryable `RATE_LIMIT` (a plain 429 keeps the `Retry-After` mapping). A non-account-scoped 4xx (an invalid tool schema, a context overflow) still fails fast on the first attempt instead of multiplying the load across accounts. The dedicated-models picker's list comes from a Host-side `commandcode/models` Remote (the FULL adapter catalog via `listModels(…, { unfiltered: true })`, sorted), so the browser never calls the Command Code API; `SettingsPageApi.models` is optional, so legacy transports degrade to the empty-catalog state. Extra-account slot ids are the credential reference itself (`COMMANDCODE_API_KEY_2`, …) so a stored selection survives list reorders/removals; only literal-only composition entries keep positional `account-N` ids. **Account management on the settings page is IMMEDIATE, not staged**: `createAccount` / `renameAccount` / `removeAccount` / `setAccountKey` / `clearAccountKey` / `setActiveAccount` / `setAccountModels` on the controller each commit at once through one serial queue (`runAccountOp`, refused when the scope is not writable), so no page Save is involved and no staged account state can go stale. Two orderings are load-bearing: `createAccount` writes the key BEFORE the row and unsets the key again if the row write fails (a keyless-yet-keyed ref must never linger, because `nextAccountRef()` would hand it to the next account), and `removeAccount` refuses to drop a row whose stored key it could not unset, then drops that account's dedicated models and a pin naming it. Browser sign-in for a new account stores a KEYLESS row first — the Host's `loginCredentialRef` refuses a ref the stored `accounts` do not name — and the page removes that row again if the sign-in fails or is cancelled. The page shows `modelAccountRules` as per-account **dedicated models**: `accountModelMap()` folds the stored rules first-match-wins (exactly what the runtime would serve), and `setAccountModels` moves each chosen model out of every other account and writes one rule per account, so the stored list carries no shadowed entries. The config shape is unchanged. `workingDir` stays a valid Config field but is no longer on the page (and not a page field, so a save never touches it). The picker's billing-access cache is per key. The usage Remote result is `CommandCodeAccountsReport` (`{ accounts: [...] }`); host and client ship in one bundle, so wire-shape changes need no migration — only synced edits in `src/usage-wire.ts`, `src/usage-remote.ts`, `src/client/usage.ts`, and `src/commands.ts`. **A blocked usage report names the CAUSE, not just a verdict.** `classifyTotalFailure()` returns `network` whenever all four account endpoints threw without a status, and that one word covered five unrelated causes — a real outage, the account endpoints' own timeout, a key no HTTP header can carry (a paste artifact: `fetch` throws a `TypeError` BEFORE any I/O, once per endpoint), and an unparseable `apiBase` — so the card told users to check a connection that was fine. Three rules keep it honest: (1) the account path runs the harness's `assertUsableApiKey` in `accountHeaders()`, exactly like chat, and `getUsage()` answers `blocked: 'invalid-key'` with the credential message instead of four phantom transport failures (a MISSING credential still propagates); (2) the four endpoints get `connection.requestTimeoutMs` (the SAME budget as a chat call, default 60 s) rather than `MODELS_TIMEOUT_MS`, because a hidden 10 s cap made every account query time out on a slow link while chat kept working — the catalog/picker reads keep the short fail-open cap; (3) both surfaces RENDER `report.failures` (the settings card as `.cc-usageBlockedDetail`, the panel as `failure.detail`), since the endpoint messages are the only place the cause is named. Pinned by `tests/adapter.test.ts` (an unheaderable key never reaches `fetch` and reports `invalid-key`; the request budget is proven by a stub that waits on the request's own abort signal) and `tests/panel.test.ts`. **`report.credits` distinguishes "reported" from "zero", and that distinction is load-bearing**: `monthlyReported` is optional-tri-state (`undefined` = a pre-field Host, read as "assume reported"; explicit `false` = the endpoint omitted the balance, which the panel renders as `—` and never as a consumed quota), and `fiveHour`/`weekly` are OPTIONAL members that are absent when the endpoint reported no such window — a present window with `cap: 0` means uncapped spend and keeps its row, an absent one keeps no row at all. Reading an absent balance as `0` is what turned a transient `/alpha/billing/credits` failure into a confident "100% used, quota exhausted"; the official CLI gates its own meter on the credits payload being present (`hasCreditsInfo`) and computes no depletion percentage without it. The wire schema validates a PRESENT `monthlyReported` as a boolean, so a malformed frame is rejected rather than coerced.
- **Web search (`src/web-search.ts` + the optional `web` seam)**: the model-facing `web_search` tool (from `@deepseek-ai/dsh-tool-web`) is served by a `CommandCodeSearchProvider` registered as `commandcode` on `ctx.web` — same `Authorization: Bearer <key>` + `x-command-code-version` chain, same `apiBase`, so DSH's web search needs NO separate key/endpoint config (unlike `dsh-web-search-deepseek`, which needs its own Anthropic-compatible base). It POSTs `{ query, numResults, allowedDomains?, blockedDomains? }` to `/alpha/web-search` and maps `{ title, url, snippet }` → `WebSearchSource`. Registration rides `ctx.inject(['web'], ...)` exactly like `commands`/`typert`: the provider is registered only when the profile mounts the web service, and the fiber never activates otherwise (this stays an LLM-provider-only plugin without web). The pool's `resolveKey()` (rotation + auth-file revived) is reused, so search benefits from the same multi-account selection; the search endpoint is account-independent so no mid-flight rotation happens. **Selection**: whether the `commandcode` provider WINS over the shipped `deepseek-official` (or a sibling search plugin's pin, e.g. modsearch's `searchProvider: modsearch`) is `Config.webSearch` (default on). The web seam has NO public runtime selector, so the plugin writes its private `searchProviderId` field (read per call by `web.search()`) via `applyCommandCodeSearchSelection()` in `src/web-search.ts` — applied at boot AND on every settings change (the `loader/volatile-update` listener — see the settings bullet), and restored on fiber unload. The tracked `CommandCodeSearchSelection` remembers the displaced backend id, so toggle-off (and unload) hands the selection back to it — it NEVER forces the factory default, because that is what silenced sibling plugins with Command Code search off (issue #26); a fresh boot straight into `webSearch: false` leaves the field untouched. Re-enables keep the original `displaced` (the field holds our own id then, which must not overwrite the memory), and a field already reading `commandcode` at first touch is recorded as `preexisting` so the later disable touches NOTHING — assigning the empty `displaced` back would clear the user's own `searchProvider: commandcode` pin (or `$DSH_WEB_SEARCH_PROVIDER`), hand the selection to dsh-web's auto-select, and make every search throw `WEB_PROVIDER_AMBIGUOUS` as soon as a second provider is usable. An `undefined` `displaced` with `preexisting: false` is the OTHER case — the field was unset when we took over — and is restored as `undefined`, or the toggle would leave Command Code serving. That write depends on the runtime shape (a plain writable property, not `#private`); the durable alternative is the boot-time `searchProvider: commandcode` cordis patch. The deprecated `selectCommandCodeSearchProvider()` (which forced the factory default on disable) was DELETED with the rest of the generation bridge — `applyCommandCodeSearchSelection()` is the only entry point. `dsh-web` is a `^0.1.7-rc.2` peer (kept external in tsdown); `tests/web-search.test.ts` pins the wire body, header, result mapping, the `WEB_ABORTED`/`WEB_PROVIDER_CREDENTIAL_MISSING`/`WEB_PROVIDER_ERROR` taxonomy, and the selection-field handoff (sibling-pin restore, re-enable memory, toggle-off through the real host `apply()` + `loader/volatile-update`).
- **AI command guard (`src/command-guard.ts` + `src/systemone.ts`)**: opt-in `Config.commandGuard` registers a prepended answerer on `approval/request` and a transparent observer on `tools/pre-execute`. A normal shell approval asks one `safe` `typesafe/jev` question; a call carrying `sandboxPermissions` also asks `escalation_scope` and `escalation_necessity`, and all three probabilities must reach the configured threshold before `allowed-once` is granted. All failures, missing answers, broad/unsupported escalations and low-confidence decisions delegate to the next answerer. The execution fact is matched to the SAME agent as the approval request. A verdict memo is scoped per agent and keyed by the complete decision context (tool, command, description, workdir, sandbox permissions, approval reason), and escalation memos retain both extra probabilities; requests without agent identity are not memoized. The decision budget is a FIXED 3000 ms (`COMMAND_GUARD_TIMEOUT_MS`, not a Config field: a timeout only falls back to the prompt, so there is nothing to tune) and includes credential resolution, even when the account pool stalls. The only tuning knob is `Config.commandGuardLevel` (`high` 0.95 / `medium` 0.9, the default / `low` 0.8 via `COMMAND_GUARD_LEVEL_THRESHOLDS`); the old numeric `commandGuardThreshold` and `commandGuardTimeoutMs` fields were removed, and a stored value for either is ignored (schemastery keeps unknown keys without validating them). The level list is mirrored in `src/client/settings.ts` (`COMMAND_GUARD_LEVEL_CHOICES`) and the TUI section's options; `tests/settings.test.ts` pins the client mirror against the Host constant. The endpoint has no ZDR-capable upstream and the opt-in sends command text to Command Code. `tests/command-guard.test.ts` and `tests/systemone.test.ts` cover the fail-closed paths, escalation gates and deadline.
- **StreamChunk contract** (dsh-llm): each block starts with `block-start`, deltas by `index`, ends with `block-end`; `usage` before `finish`; nothing after `finish`. Tool-call `arguments` are raw JSON strings. Historical reasoning blocks are replayed on BOTH transports for tool-loop continuity — as a `{ type: 'reasoning', text }` assistant part on `/alpha/generate` (the official CLI's shape) and as `reasoning_content` on `/provider/v1/chat/completions` (see the wire-protocol bullet; issue #34). Only tool calls with a paired tool result are replayed on both transports. **Tool-result images** (`read_image` returns text + a nested `image` block): neither wire can hold an image inside a tool result — the CLI's `tool-result.output` is text-only (the official CLI's own `toV2ToolOutput` filters out everything but text) and Chat Completions forbids non-text `role: 'tool'` content — so `toolResultMedia()` splits each result and both converters emit the bytes in a user message immediately after the tool message, led by the `Attached image(s) from tool result:` note (the shape `@deepseek-ai/dsh-llm-deepseek` uses). Deduplicated by attachment id per result; an image-only result gets a `(image returned; see the attached image)` tool text instead of an empty string; a result without a paired call drops its images with the result. Never flatten a tool result with `blockText` alone again — that is issue #30. The `hasImageContent` gate (model Vision capability + attachment seam) already recurses into tool results, so these images ride the same `readImage` resolver user attachments use.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 → `RATE_LIMIT`; **pre-stream 5xx → `SERVER` and 408 → `TIMEOUT`** (`httpErrorCode()`, so a gateway blip — e.g. Cloudflare's 520 "Upstream model provider is temporarily unavailable" — reaches the retry whitelist instead of failing the turn); other HTTP → `PROVIDER_HTTP_ERROR` (403 body's `error.code`, e.g. `MODEL_NOT_IN_PLAN`, is parsed into the message). **A context-window rejection → `CONTEXT_WINDOW_EXCEEDED`** (the harness's own code: `isContextWindowExceededError` plus the official CLI's `truncated` pattern, matched against the provider's `error.code`/`type`/`message`). It is deliberately OUTSIDE the retry whitelist because `dsh-compaction-basic`'s `agent/request-error` hook compacts the session and retries the reduced surface for that code — resending the byte-identical oversized request is exactly the old bug where a long session retried forever (issue #39). `streamErrorToLlmError()` is the ONE in-band classifier for both transports (the CLI's `error` event and the Provider API chunk's `error` member, which was silently ignored before); it reads the wording before the status, so a `statusCode: 500` carrying "prompt is too long" still takes the overflow path, while only client-side pre-stream statuses (`status < 500`) are inspected for the wording, so an HTML 5xx page cannot mention its way into a compaction. A terminal marker (`insufficient credits` / `model not in plan` / `premium credits exhausted`, underscored or spaced — the separator is normalized, like the pre-stream classifier) and an explicit `isRetryable: false` OUTRANK a retryable status, so a 5xx carrying one stays non-retryable `PROVIDER_STREAM_ERROR` instead of entering the 1000-attempt cadence. Never route a transient status onto a code outside `providerRetryPolicy()`'s whitelist: dsh-llm-retry matches the code only, never the status. Unsupported options (`stop`) and image input throw `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` rather than silently dropping.
- **Stream termination must distinguish an answer, an empty completion, and a cut** (`CommandCodeAdapter.stream()`, `src/stream-trace.ts`). A terminal CLI `finish` or OpenAI `finish_reason` is necessary but not sufficient for success: reasoning alone, empty text, whitespace, and `tool_calls: []` are not an answer. Hold the success `finish` until validation; DSH 0.1.7 converts an adapter throw into an error finish, so throwing after publishing success creates two terminal events. A terminal response with no text/tools maps to retryable `EMPTY_RESPONSE`, except a length/max-token finish maps to non-retryable `OUTPUT_TOKEN_LIMIT` and explicit content filtering remains non-retryable. Preserve received usage on failures; report the actual finish reason, request budget, output tokens and reasoning tokens (unknown when absent). A length finish proves a limit, not that every token was spent reasoning. Without any terminal event, preserve `EMPTY_RESPONSE` when no content arrived and `STREAM_CLOSED` after text/tool fragments; never execute a buffered tool call from a cut stream. `STREAM_CLOSED` and `OUTPUT_TOKEN_LIMIT` stay outside the retry whitelist. Thus an old silent stop cannot be attributed to a particular branch without its wire trace. `DSH_COMMANDCODE_TRACE=<path>` (`=1` selects `$TMPDIR/dsh-commandcode-stream.jsonl`; `0`/`false`/`no`/`off` are OFF rather than file names, which is what an explicit disable used to look like — it wrote the conversation to `./false`) records raw response chunks and terminal diagnostics; payload logging stops at 4 MiB but reserves bounded `end`/`stream-close` records so long reasoning cannot hide the outcome. Traces contain conversation output; they do not record request credentials or headers. Tests cover both transports, limit aliases, missing usage, valid text/tools, EOF, and a failure before any success finish. `scripts/probe-stream.mjs` tests a separate request; its result is not evidence for a prior session.
- **`TRANSPORT` carries its own bounded budget, and the route policy cannot express it** (`src/transport-retry.ts` + the `agent/request-error` listener in `src/index.ts`; issue #39's second report). `providerRetryPolicy()` is captured once per route, so every code in its whitelist shares one window: 1000 attempts, waits doubling to 15 minutes. That shape is right for `RATE_LIMIT`/`SERVER` — an exhausted 5-hour window is a failure that ASKS to be waited out — and wrong for a connection that cannot be established. The reporter's second event at ~710k tokens was undici's own `Connect Timeout Error ... timeout: 10000ms` (its default connect timeout; `requestTimeoutMs` is 60 s and the connect phase never runs against the body upload) plus a `read ECONNRESET` on `/alpha/generate`; on the shared cadence the wait before attempt 11 alone is 512 s, so a 10-second TCP timeout produced an ~8-minute stall (`模型请求重试已取消（11/1000）· 482s` is that 512 s countdown, 30 s in). The listener therefore consumes `TRANSPORT` against a per-agent budget (`Config.transportMaxRetries`, default 5, 0–50) and THROWS when it is spent — throwing out of the waterfall is the only way to stop dsh-llm-retry, whose own policy would answer `TRANSPORT` with another retry. Order is load-bearing: the cancellation check runs BEFORE the budget, or a user's own stop would spend a slot a live failure needs. The reset point is `step/start` (`transportResetAction()` in the module states it once, and a test pins it) — one step IS one model request, so the cap stays per-logical-request and the next step of the same turn gets its own grace. `agent/status` → `idle` is NOT the reset: the loop's `setPhase` emits it only on a status CHANGE and a turn's steps share one `running` phase, so it never fires between them — resetting only there made the budget per-TURN, which is the bug the first version of this shipped with. `assistant/attempt` is wrong for the opposite reason: the loop appends it for the FAILED attempt before dispatching `agent/request-error`, so resetting on it restores the very loop this exists to stop. `turn/end` drops the session → agent mapping the reset needs. The `10s` connect timeout is undici's and reachability is not the plugin's to fix: measured against the live endpoint, a 1/8/30 MB body all returned the provider's own 401 in 1.9/2.7/5.7 s, so the "long context" correlation in the report is not a size rejection. `tests/transport-retry.test.ts` pins the budget, per-agent isolation, the cancellation ordering and the message.
- **The Claude family is Messages-only, so it takes the CLI transport — and that decision must NOT be cached** (`MESSAGES_ONLY_MODELS`/`requiresMessagesEndpoint()` in `src/capabilities.ts`, the first lines of `resolveProtocol()` in `src/adapter.ts`; issue #46). The Provider API serves the whole Claude family only through `/provider/v1/messages` (Anthropic Messages shape): posted to `/provider/v1/chat/completions`, all eight catalog Claude ids answer `400 Model "<id>" must be called via /provider/v1/messages (Anthropic Messages shape)`. Measured 2026-09-16 by posting all 69 catalog models to that endpoint — exactly those eight refused, and every one of them is routed normally by `/alpha/generate` (a lower-plan key gets the ordinary `MODEL_NOT_IN_PLAN` 403 there, never a routing error), which is why the adapter carries NO Messages transport. The bug this fixes is a routing one: the pre-stream fallback only recognised the Go-plan `upgrade_required` 403, so the 400 surfaced as `PROVIDER_HTTP_ERROR` — and because the non-Go tiers are exactly the ones `resolveProtocol()` sends to the Provider API, the accounts ENTITLED to Claude (Pro for Sonnet, Provider/Max for Opus) were the ones that could never use it. `resolveProtocol(apiKey, model)` now returns `'cli'` for these models on any tier AND under a forced `'openai'` preference, since that option is documented as "prefer the Provider API, still fall back" rather than a hard gate. **The call to `rememberProtocol()` is deliberately absent on that path**: `protocolCache` is keyed by API key ALONE, so remembering it would pin the whole ACCOUNT to the CLI transport and drag DeepSeek, GLM and Qwen — all correctly served by the Provider API — along with it until the entry expired. `tests/adapter.test.ts` pins the route, the `claude-*` prefix rule that covers a model shipping after this release, and that a Claude request followed by a DeepSeek one still lands on the Provider API.
- **Tool-result history has two supported envelopes** (`toolResultOf()` in `src/adapter.ts`). Through 0.1.6 the Harness emits a `role: 'user'` message with a first `tool-result` block; 0.1.7 emits `role: 'tool'`, message-level `toolCallId`/`isError`, and raw text/image blocks. Pairing AND both serializers must consume the same normalized view. Dropping modern results also drops their paired assistant calls, so every model loses completed work and can repeat a tool or stop after a statement of intent. Keep errors, image carriers, parallel-result grouping and long-id aliases intact across both envelopes. In the LEGACY envelope a present non-tool `source.kind` excludes the message; absent source falls back to the first block (issue #47). Such an excluded result must not count as paired. Do not read `message.source.kind` without the optional guard. Unit tests cover both generations and mixed histories; `npm run test:engine` captures both transports using the target engine's actual message constructors, because the development peers alone cannot expose this contract drift.
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
  its row marker is a PREFERENCE.** `data-composer-stats` IS present on
  0.1.7-rc.2, but it has already been deleted once upstream while the row's
  markup stayed otherwise identical, so `STATS_ROOT` narrows the lookup when it
  is there and the lookup falls back to the dock outlet
  (`[data-slot="conversation.composer.dock"]`, a `display:contents` div holding
  exactly that slot's entries: the shipped `stats` cell and ours). The fallback
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
  Retries are routine on this route (429 plus the near-unbounded retry policy),
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
- **The strict result codec carries the lazy `create()` factory** (`makeRemoteDescriptor()` in `src/wire-shared.ts`; issue #49). The Typert protocol's strict branch is `{ mode: 'strict', typeSymbol, create: () => TypertSchema }`: the registry refuses registration with `typert: <subject> strict codec has no create() factory` unless `typeof codec.create === 'function'`, and the Gateway validates with `codec.create().parse(value)`. There is NO `schema` member — one used to ride along for the pre-0.1.7 engines, and dropping it is what the single-engine peer range bought. All 6 endpoints (`report`/`models`/`prices`/`loginBegin`/`loginStatus`/`loginCancel`) come from that one factory, and the helper is INLINED into both `lib/index.js` and `lib/client.js`, so a change is dead until the bundle is rebuilt. `tests/wire-shared.test.ts` drives a transcription of the registry's check over every descriptor gathered from the contributions, with a negative control pinning that a `schema`-only codec is refused; `npm run test:engine` cannot see any of this, because `scripts/verify-engine-load.mjs` registers no Remotes at all.
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
  instead of handing back a dead authUrl, and it is SINGLE-FLIGHT across the
  bind: a second concurrent `begin()` (two GUI tabs, or a Sign-in that follows
  a cancel arriving before the status says `waiting`) joins the in-flight
  `starting` promise instead of binding its own loopback server — only the LAST
  bound server is reachable by `teardown()`, so the loser used to listen (and
  answer `/callback`) for the life of the process, and ten of those exhausted
  the port window. A `cancel()` in that window sets `cancelPending`, which
  `startAttempt()` observes after the bind and answers by closing the fresh
  server and publishing `failed/cancelled` rather than a live authUrl nobody
  wants. The
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
  exclusively, and `/settings` renders only sections a plugin DECLARES. So the
  plugin declares a Command Code
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
  settings-change hook (the `loader/volatile-update` listener — see the
  settings bullet) — withdraw first, then declare, and only
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
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`), synced from the plan pages ([go](https://commandcode.ai/docs/plans/go) ⊂ [goat](https://commandcode.ai/docs/plans/goat) ⊂ [pro](https://commandcode.ai/docs/plans/pro) ⊂ provider/max). Strict superset chain; every catalog ID covered exactly once (re-verified at command-code@1.65.2, 2026-09-25 — the public catalog still serves 81 models and no plan tier moves; its current route mix is 64 × chat/completions + responses, 9 Claude ids × messages, 8 × chat/completions, still agreeing with the `claude-*` routing rule. The 1.65.0 release added `stealth/space-bunny-alpha` on Go, taking the map to 51/58/71/81; 1.65.2 changes only Step 3.5 Flash's context metadata and the cache-write stream event). Historical verifications: re-verified at command-code@1.64.0, 2026-09-23 — the 1.62.0 → 1.64.0 train (1.63.0 and 1.64.0, neither with a changelog entry yet) is additive again: exactly three models join the map and no tier moves — `claude-opus-5-5` on Provider/Max, `gpt-6-sol` on Pro, `gpt-6-luna` on Go, taking it from 49/57/70/77 to 50/58/71/80; the public catalog serves 80 models (77 + those three), its route mix 63 × chat/completions + responses, 9 Claude ids × messages, 8 × chat/completions, agreeing with the `claude-*` routing rule; re-verified at command-code@1.62.0, 2026-09-22 — the 1.58.1–1.62.0 train is purely additive: exactly five models join the map and no tier moves, `xai/grok-4.7` and `xiaomi/mimo-v2.6-pro-ultraspeed` on GOAT and `stepfun/Step-5-Preview`, `xiaomi/mimo-v2.6-flash` and `xiaomi/mimo-v2.6-pro` on Go, taking it from 46/52/65/72 to 49/57/70/77; the public catalog serves 77 models (72 + those five) with `gpt-6-astra` still a CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.58.0, 2026-09-20 — the CLI's only registry change is Meituan's LongCat 2.0 promotion, so the map stays 46/52/65/72 and no tier moved, the public catalog still serves its 71 models with `gpt-6-astra` a CLI/pricing/docs-only model as before, and this is the release that catches up with the backend: it adds the paid `meituan/LongCat-2.0` and marks the retired `:free` sibling `hidden`; re-verified at command-code@1.57.0, 2026-09-19 — one model added on Go, `z-ai/glm-5.3-flashx`, taking the map to 46/52/65/72, and the same check caught the backend ending Meituan's LongCat 2.0 promo: the catalog renamed `meituan/LongCat-2.0:free` to the paid `meituan/LongCat-2.0`, which keeps the Go slot while the then-current command-code@1.57.0 CLI registry still carried the retired id, one release behind (1.58.0 followed it); no tier moved, and the public catalog now serves 71 models with `gpt-6-astra` still a CLI/pricing/docs-only model as before; re-verified at command-code@1.56.0, 2026-09-18 — one model added on Go, `Qwen/Qwen3.8-Omni-Flash`, taking the map to 45/51/64/71; no tier moved, and the public catalog served 70 models with `gpt-6-astra` still a CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.54.0, 2026-09-15 — no tier moved, and the public catalog still serves its 69 models with `gpt-6-astra` a CLI/pricing/docs-only model as before; re-verified unchanged at command-code@1.53.1, 2026-09-12 — no tier moved; 44/50/63/70 as of 2026-09-10, command-code@1.53.0 — 1.53.0 added `deepseek/deepseek-v4.1-flash` on Go; 1.52.0 added the free `inclusionai/ling-3.0-flash-sante:free` on Go; re-verified unchanged from 1.49.0, which added `gpt-6-astra` on Provider/Max; 1.48.0 added `max` effort to Muse Spark 1.3; 46/52/65/71 as of 2026-09-04, command-code@1.47.0 — 1.41.0 added `Qwen/Qwen3.8-Max-0902` on Go, 1.42.0 added `meituan/LongCat-2.0:free` on Go, 1.43.0 added `google/gemini-3.8-flash` on GOAT, 1.44.0 added `meta/muse-spark-1.3` on GOAT + its Contributor sibling on Go; 43/47/60/66 at command-code@1.40.1 — `claude-fable-5-1` joined Provider/Max after 1.40.0 shipped it on the Provider API (the alpha.5 note that it was Anthropic-OAuth-only was wrong); 43/46/59/64 at 1.40.1 before that fix; `deepseek/deepseek-v4-flash-fast` joined Go in 1.39.0; 1.39.2 retired `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` and the upstream catalog renamed `tencent/Hy3` to `tencent/hy3-paid` (the hidden free variant); `inclusionai/ling-3.0-flash-free` was removed when its free promo ended 2026-08-03; 40/44/57/62 at 1.37.0 — `tencent/hy4-preview` joined Go (routed through OpenRouter); 39/43/56/61 as of 2026-08-27, command-code@1.36.0 — `Qwen/Qwen3.8-Flash` + `z-ai/glm-5.3-flash` joined Go and `stealth/ox-alpha` left when its preview ended in 1.34.0; 38/40/53/60 as of 2026-08-26, command-code@1.33.0 — the `minimax/minimax-m3-free` + `minimax/minimax-m2.7-free` promo variants joined Go; 36/40/53/58 at 1.32.2 when `deepseek/deepseek-v4-flash-vision-exp` joined Go in 1.32.0; 35/39/52/57 at 1.31.0 when `stealth/ox-alpha` joined Go; 34/38/51/56 at 1.28.4).
  - `KNOWN_SUBSCRIPTION_PLANS` — subscription `planId` prefix → `{ name, monthlyCredits, tierWeight }` for the account's own plan (from `/alpha/billing/subscriptions`), synced from the CLI bundle's plan maps (minified variable names change per release — locate them by the `"individual-go"` key; `tierWeight` is plugin-added for the picker filter). `subscriptionPlanInfo()` mirrors the CLI's `getPlanInfo` longest-prefix matching. Distinct from `KNOWN_PLANS` (model → minimum tier).
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`. **Expiry-aware**: `dealLabel()` hides a deal once `Date.now()` passes its `expiresAt`, so an un-updated plugin never shows a lapsed discount.
  - `KNOWN_PEAK_PRICING` — catalog IDs with hourly (peak/off-peak) pricing, synced from the pricing page's **embedded model JSON `timeOfDay` blocks** (never the rendered row text — see the skill). Exactly four models as of 2026-09-10: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp`, `deepseek/deepseek-v4.1-flash` (added in command-code@1.53.0 at $0.15/$0.60 off-peak, $0.30/$1.20 peak, same schedule); `deepseek/deepseek-v4-flash-fast` is flat-priced ($0.28/$0.56/$0.07) and must stay out. Peak windows live in `PEAK_HOUR_RANGES` (UTC, end-exclusive) and apply **Monday–Friday only** — the official rule charges Saturday/Sunday completely off-peak for all 24 hours — so `peakPricingState()`/`peakPricingLabel()` map the current UTC **weekday+hour** to `Peak`/`Half` (35 peak hours per week, 7 per weekday, 0 on weekends).
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal · peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce "Text only" or "Supports image input".
  - The picker list is **sorted free models first, then by plan tier, then name** (`compareByPlan()` in `src/capabilities.ts`; free = `KNOWN_DEALS` `free: true` via `isFreeModel()`, tier weights in `PLAN_ORDER`): FREE → Go → GOAT → Pro → Provider/Max, alphabetical within each group, unknown plans last. Keep this order when changing `listModels()`. `formatContext()` renders sub-1K windows raw (never `"0K"`).
  - The picker also **hides models above the account's subscription tier** (`modelVisibleInPlan()`, on by default via `filterModelsByPlan`): the billing facts mirror the CLI's `createBilling` flow — whoami → orgId, then `/alpha/billing/subscriptions` (planId, honored only for `active`/`trialing`/`past_due` statuses) and `/alpha/billing/credits` (on-demand balances; its `credits.planId` is the fallback when subscriptions fails) — cached for `BILLING_ACCESS_TTL_MS`. The filter **fails open** everywhere (endpoint failure, unknown plan, unknown model) and is **bypassed by any positive on-demand balance** (`purchasedCredits + freeCredits > 0`) — mirroring the CLI's `evaluateModelAccess`. The catalog itself is never filtered; `resolveModel` still serves every model and the server remains the final gate. **With a pool, the question is asked of EVERY account** (`modelVisibleForAnyAccount()`, fed by the optional `resolveAccountKeys` seam the plugin entry implements from `pool.resolvedAccounts()`): a model is hidden only when no account can run it, because the POOL serves a request and not whichever account rotation happens to be on. Keying the filter on the serving account made the picker's contents change as accounts rotated (issue #51's follow-up: 《卡片会切换》) and hid models the user's other accounts could run — a model no request could ever reach. The union is only coherent together with the entitlement rotation in the connect loop (a model offered because SOME account includes it is served by that account after at most one rejected attempt), and it costs three requests per account per TTL, cached per key exactly like the single-account path (an unknown account counts as 'may include it', the same fail-open rule, and a host without the seam falls back to the serving key).
  - The picker also supports a **visible-model allowlist** (`Config.visibleModels: string[]`, the settings page's Visible models card): a non-empty list narrows `listModels()` to those catalog ids AFTER the plan filter; empty/unset shows everything. It never gates named requests (`resolveModel` still serves every model). The allowlist is staged through `visibleModelsDraft` in `src/client/settings.ts` (its own draft/dirty/plan/write/reconcile path, one `visibleModels` write) and cleaned of non-strings/blanks at both ends (`storedVisibleModels()` + `resolveAdapterOptions`). `listModels(provider, { unfiltered: true })` skips BOTH filters so the `commandcode/models` Remote always serves the full catalog to the page editors; the adapter override stays signature-compatible with the base (`_provider` only) via the optional second param. `tests/adapter.test.ts` pins the narrowing + unfiltered paths; `tests/settings.test.ts` pins the controller staging.
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
