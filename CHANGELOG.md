# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Reading several images in one turn no longer makes the conversation unusable** ([#33](https://github.com/Mars-Sea/dsh-commandcode-provider/pull/33)). When one assistant turn issued parallel tool calls whose results each carried an image (two `read_image` calls, say), both transports emitted each image carrier as a user message directly after its own tool result, so a user message sat between the two tool messages. The gateway requires an assistant's tool blocks to be answered consecutively and rejected the request with HTTP 400 (`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`); because that history is replayed on every later turn, the conversation could not continue on this provider at all — a retry did not help and only switching provider or model worked. The carriers are now buffered and flushed once the whole tool group has been emitted, so parallel results stay adjacent (`assistant → tool → tool → user → user`) on both the CLI and the Provider API transport. A single-call turn keeps the shape from [#30](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/30).

## [0.10.5] - 2026-09-11

### Added
- **The terminal settings page lists every model as a checkbox.** The TUI's model allowlist was a text field expecting comma-separated catalog ids typed from memory; it now renders the whole catalog under plan-tier headings (Go → GOAT → Pro → Provider), free models first, each row carrying its plan/deal/context summary as the footer hint. Everything reads as checked until something is excluded, matching the adapter's "an unset allowlist shows every model" rule, and a model this build does not recognize (retired upstream, or added after this release) still gets a row of its own instead of becoming impossible to switch from the terminal.
- **`Config.modelVisibility`, a per-model override layer beside `visibleModels`.** The TUI cannot add an id to the array it edits, so each checkbox records `modelVisibility.<id>` (true listed / false hidden) instead; an id absent from the map keeps following `visibleModels`, and the subscription-tier filter still applies on top. A hand-edited document carrying a non-boolean entry falls back to the array rather than hiding the model.

### Fixed
- **The terminal model checkboxes now save the model you toggled.** dsh-TUI keys a staged edit by the field's PATH, so the whole list of checkboxes sharing one `visibleModels` path shared one draft: each of them parsed that same draft on save, every write op addressed the same path, and only the last field's op survived — silently replacing the allowlist with what the last catalog model's row evaluated to instead of the row the user had switched. Each checkbox now addresses a path of its own, and a toggle writes only when it disagrees with the inherited state, so switching a model back leaves no residue in the document.

### Changed
- **Per-release compatibility now covers dsh `0.1.5-rc.2`.** `dsh.compatibility.dshReleases` declares it `compatible` alongside `0.1.2-rc.1`, `0.1.3-alpha.1`, `0.1.3-alpha.2`, `0.1.5-alpha.1` and `0.1.5-rc.1`, so the DSH STORE can list the plugin for the current Harness release. Verified on a dsh-TUI profile running that engine: the `/settings` → Command Code page, the model checkbox list, and the picker's catalog all behave as they do on 0.1.5-rc.1. An older release keeps its own record rather than being replaced, so a user who has not moved to the newest engine still sees the listing.

### Documentation
- **The install and update instructions now say which profile receives the plugin and how to escape pnpm's release-age gate** (both READMEs). A `dsh-tui` profile owns its own plugin list, so the web install does not reach the terminal: the terminal UI needs its own `dsh plugin --profile dsh-tui add`, and it now shows an exact version because a bare package name — or `@latest` — is silently resolved to the previous release for the first 24 hours after a publish (pnpm 11's `minimumReleaseAge`) and the install still exits successfully, which is how a fresh terminal install can end up with no Command Code settings page and no `commandcode` models at all.

## [0.10.4] - 2026-09-11

### Added
- **A Command Code page in the dsh-TUI settings screen** ([#28](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/28)). The terminal front door now lists Command Code under `/settings`, with the API key, the API base, the out-of-plan model filter, the model allowlist, the active account, and the command language. The key is a write-only credential field: the literal goes to the credential store and never into a settings document, and the field shows only whether one is configured. Until now a TUI-only user had no way to enter a key at all — dsh-TUI's own `/provider` wizard manages its `llm-pi-ai` routes exclusively, and the web Models page was the only surface that could write it. The page appears only on a profile that mounts dsh-TUI; everywhere else the plugin stays a plain LLM-provider bundle. Every model list and account choice reads live settings, so a change lands on the next request with no restart.

### Changed
- **Per-release compatibility now covers dsh `0.1.5-rc.1`.** `dsh.compatibility.dshReleases` declares it `compatible` alongside `0.1.2-rc.1`, `0.1.3-alpha.1`, `0.1.3-alpha.2` and `0.1.5-alpha.1`, so the DSH STORE can list the plugin for the current Harness release. Verified on both surfaces: the web profile runs the plugin on this engine (settings page, Models-page card, chat and the `/commandcode` dashboard), and a dsh-TUI 0.10.0 profile selects and serves Command Code there. An older release keeps its own record rather than being replaced, so a user who has not moved to the newest engine still sees the listing.

### Security
- **A literal API key in the composition config no longer rides a settings response.** The `apiKey` fields (top-level and per extra account) are now declared `role('secret')`, so the harness strips them from every settings descriptor it serves. The settings page was already writing keys through the credentials seam — which is what keeps them out of a settings document — but a key written by hand into `cordis.patch.yml` or `settings.yaml` was returned to the browser verbatim, including on a remote-Host setup where that means another machine.
- **A web page can no longer cancel a login in progress.** The loopback callback's denial branch now checks the login's state token before it ends the attempt, matching the official CLI. A denial is terminal, and the browser sends a `text/plain` POST as a CORS simple request regardless of the origin allowlist, so any open page could previously kill the attempt (and show "authorization denied") by blindly posting `{"error":"access_denied"}` to the loopback port. A denial that carries the real token still ends the attempt, as the Studio's own flow does.

### Fixed
- **Cancelling a login now really cancels it.** The key delivered by the callback is validated against `/alpha/whoami` before it is stored, and cancelling during that check was ignored: the credential was written anyway and the state flipped back to success while the page (which had already stopped polling) kept showing "cancelled". The completion now re-checks that it still owns the attempt — before writing the key and before publishing any status — so a cancel or a newly started attempt wins.
- **"Sign in" after a completed callback starts a fresh attempt.** Once the callback is consumed the loopback server is closed, but the status still read `waiting`, so the next sign-in handed back the previous attempt's URL — a link to a dead port. A `waiting` status whose server is gone is now retired instead of reused.
- **Saving the settings page no longer deletes account entries it cannot show.** The accounts list is written whole, and the page rebuilt it from the rows it displays — so a composition-config entry carrying a literal `apiKey` (which has no row) was silently deleted by any save, and the literal key of the entries it could show was stripped. The write now starts from the stored list and only rewrites the rows the page manages, so unknown entries and literal keys survive.
- **A failed save no longer throws away what you typed.** Two staged edits were cleared even when the failing write never ran: an account's label reverted to the generated name (and was then persisted that way on the retry), and a routing-rule edit was silently reverted with the page left clean — no dirty marker and no way to retry. Both are now kept until the stored section proves the write landed. Rule drafts are still dropped once the rules write itself lands, because the positional row ids shift and a kept draft would be applied to the wrong row.
- **The "clean up stale models" button no longer empties the allowlist while the catalog is missing.** Before the first catalog fetch lands — and after a failure — the catalog is empty, so every selected model looked retired and one click cleared the whole list. The cleanup, and its hint, are now shown only when a catalog is actually in hand; the explicit "show all" action remains available.
- **Whitespace around a stored API key no longer breaks multi-account rotation.** The account pool marked a rejected key exactly as it was stored, while the request path trims it (a key from the credentials seam, a `.env` line, or a shell export picks up surrounding whitespace), so a 429/401 mark landed on a string nothing looked up again: the same account was offered again, the account card showed no mark, and the usage endpoints failed while chat kept working. Keys are now normalized once, where a slot's key enters the pool.
- **Images returned by a tool are no longer invisible to Vision models** ([#30](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/30)). When the agent read a local image with `read_image` (an absolute path in the prompt) instead of receiving it as an attachment or pasted image, the request replayed only the tool's metadata text — the nested `image` block inside the tool result was flattened away, so the model answered that it could see no pixels. Both transports now carry the image's bytes in a user message right after the tool message, introduced by an `Attached image(s) from tool result:` note: the image stays outside the tool result, where neither `/alpha/generate`'s text-only tool output nor Chat Completions' `role: 'tool'` content could hold it. A tool result that repeats one attachment sends it once, an image-only result no longer produces an empty tool message, and text-only tool results are byte-for-byte unchanged.
- **Test coverage for the above**, plus the previously unpinned paths they exposed: account writes preserving composition entries, label/rule drafts across every failure order, the login callback's authentication and attempt ownership, credential normalization in the pool, and the catalog-readiness gate (each verified by reverting its fix and watching the new test fail).

## [0.10.3] - 2026-09-10

### Changed

- **Synced with the official command-code@1.53.0 CLI** (2026-09-10: "Add new deepseek/deepseek-v4.1-flash model"). `COMMAND_CODE_CLI_VERSION` is now `1.53.0`. The only catalog change is the new DeepSeek V4.1 Flash (Go-tier, Vision, 1M context, selectable `low` / `high` / `max` reasoning efforts, same hourly schedule as the other DeepSeek models: $0.15/$0.60 off-peak, $0.30/$1.20 peak, 01–04 & 06–10 UTC Mon–Fri). Wire protocol, endpoints, subscription plan maps, every other plan tier, and every deal are unchanged; `gpt-6-astra` remains a CLI/pricing/docs-only model (absent from the public Provider catalog, as before) and was deliberately kept.
- **DeepSeek V4.1 Flash is now selectable** — a Go-tier Vision model (1M context) with the `Peak`/`Half` hourly marker and the `Image` badge in the picker.
- **Synced with the official command-code@1.52.0 CLI** (2026-09-10). `COMMAND_CODE_CLI_VERSION` is now `1.52.0`. Upstream moved 1.51.3 → 1.52.0 the same day; the CLI changelog page still stops at 1.51.0, so the snapshot was read from the bundled model table. The only catalog change is the new free `inclusionai/ling-3.0-flash-sante:free` (Ling 3.0 Flash Sante, 262K context, text-only, automatic reasoning, 100 requests/day). Wire protocol, endpoints, effort map, subscription plan maps, peak/off-peak membership and schedule, and every other deal are unchanged; `gpt-6-astra` remains a CLI/pricing/docs-only model (absent from the public Provider catalog, as before) and was deliberately kept.
- **Ling 3.0 Flash Sante is now selectable** — a free Go-tier model on every plan (262K context, text-only, reasons automatically), shown with the `FREE` badge at the top of the picker. It succeeds the retired `inclusionai/ling-3.0-flash-free` promo.
- **Synced with the official command-code@1.51.3 CLI** (2026-09-09). `COMMAND_CODE_CLI_VERSION` is now `1.51.3`. Upstream moved 1.50.0 → 1.50.1 (CLI-local changes only: stable process title, UNIX-socket idle/working/blocked status) → 1.51.0 (briefly added DeepSeek V4.1 Flash Beta behind a 2026-09-10 expiry gate) → 1.51.2 (removed the beta model from the bundle entirely, so no snapshot entry is needed) → 1.51.3 (see below). Re-verified against the official sources: wire protocol (both the `/alpha/generate` CLI transport and the `/provider/v1/chat/completions` Provider transport), endpoints, auth flow, model catalog, plan tiers, subscription plan maps, and deals are all identical to 1.50.0; the peak/off-peak *hours* are unchanged, but the same page now also restricts them to weekdays — see Fixed. There is no CLI changelog entry for 1.51.1–1.51.3 yet, so the 1.51.3 snapshot was read from the bundled model table.
- **MiniMax M3 now offers selectable reasoning effort** (`low` / `medium` / `high`). The official 1.51.3 bundle gave the model effort levels where it previously let Command Code choose the depth automatically, so the picker's effort selector now lists them (its hidden free sibling gained the same set in the bundle).
- **The "Visible models" card is now "Model allowlist".** The label and hint on the settings page (zh/en) and in both READMEs say what the card does — checked models are the only ones the picker lists, and checking nothing shows everything — instead of relying on the word "visible". The stored `visibleModels` config key is unchanged, so existing allowlists keep working with no migration.
- **Per-release compatibility now covers dsh `0.1.5-alpha.1`.** `dsh.compatibility.dshReleases` declares it `compatible` alongside `0.1.2-rc.1`, `0.1.3-alpha.1` and `0.1.3-alpha.2`, so the DSH STORE can list the plugin for the current Harness release.
- **The build config uses the current tsdown option shape** (`outExtensions` and `deps.neverBundle` instead of the removed `outExtension` / `external`). The external set is byte-for-byte the same list as before, so the published `lib/` output is unchanged in behavior; the change only silences the deprecated-option path on current tsdown.

### Fixed

- **The usage report no longer prints a raw success-rate float.** `/commandcode` and the settings page's Account usage card rendered the upstream value verbatim, so a rate of `99.965552876334` showed up as a wall of digits. Both the Host command and the browser card now round to at most two decimals and trim trailing zeros — `99.97`, `100`, `97.6` — through one shared formatting rule on each side.
- **DeepSeek peak/off-peak pricing now follows the official weekday rule.** Peak rates (01:00–04:00 and 06:00–10:00 UTC, full price) apply **Monday to Friday only** — Saturday and Sunday are charged completely off-peak for all 24 hours. The picker previously derived `Peak`/`Half` from the UTC hour alone, so it showed `Peak` on weekend mornings when the model actually billed at half price. Peak hours are now 35 per week (7 per weekday, 0 on weekends).
- **DeepSeek V4 Flash Fast no longer shows a bogus `Peak`/`Half` marker.** Its official pricing row is flat ($0.28/$0.56/$0.07) with no `timeOfDay` block, so it is not billed by the hour; the picker now shows just `Go · 1M`. The hourly-priced set is DeepSeek V4 Pro, V4 Flash, V4 Flash Vision (exp), and — from command-code@1.53.0 — V4.1 Flash. The upstream snapshot procedure was tightened to read the pricing page's embedded model JSON instead of the rendered rows, whose annotations sit one row off when flattened to text.

## [0.10.2] - 2026-09-08

### Added

- **Searchable model-editor dropdowns with tier grouping and stale-id cleanup.** The routing-rule editor and the Visible models filter share one dropdown: a search box filters the 60+ model catalog by id/display-name substring, entries group under plan-tier headings (FREE → Go → GOAT → Pro → Provider/Max, mirroring the picker order), and selected models retired upstream render flagged instead of silently vanishing — the Visible models card offers a one-click cleanup that never auto-drops (an empty catalog from a fetch failure must not wipe the list).

### Fixed

- **Turning the web-search toggle off no longer silences other search plugins** ([#26](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/26)). Disabling `webSearch` used to force the web seam back to the factory `deepseek-official` backend, so a sibling search plugin (e.g. modsearch) stayed dead even with Command Code search off. The plugin now remembers the backend it displaced when taking over and hands the selection back to it on toggle-off — and on unload, so disabling the plugin no longer leaves a stale `commandcode` pin that fails every search with `WEB_PROVIDER_CONFIGURED_MISSING`.
- **DSH STORE relisting.** Declare per-release compatibility for the latest DSH versions (`dsh.compatibility.dshReleases`: 0.1.2-rc.1, 0.1.3-alpha.1, 0.1.3-alpha.2 all `compatible`) so the catalog can restore the listing, and vendor the built runtime files (`lib/index.js`, `lib/index.d.ts`, `lib/client.js`) in git so the store review resolves the package entry points from the fixed commit.
- **A partially landed settings save no longer duplicates routing rules on retry.** When the rules write landed but a later write failed, the retry re-persisted staged additions a second time. Staged removals are now matched by row content (stored ids shift after any write), landed additions are dropped from staging, and the write dedupes by content — mirroring the existing account-staging behavior. A throwing settings write also counts as a failed (not dropped) save.
- **A stream whose final event lacks its trailing newline no longer emits a duplicate `finish`.**
- **Corrupt billing facts fail open.** A non-finite plan-tier weight no longer hides models, and sub-1K context windows render raw instead of `"0K"`.
- **The loopback login's body cap is now measured in wire bytes** (multibyte bodies previously passed ~1.5–2× the limit), and over-limit requests never process their partial body.
- **The zh `/commandcode` command no longer shows English for empty/error states.**

### Changed

- **The usage report fetches faster.** `getUsage()` still reads whoami first (the subscriptions query needs its org id) but now fetches usage/credits/subscriptions in parallel instead of serially, and the four endpoint parsers plus the total-failure classifier are module-level functions.
- **`stream()` internals are now module-level.** The CLI/OpenAI body builders, the pre-stream connect attempt, the block assembler, and both transport event handlers take explicit parameters instead of closing over `stream()` locals — same wire behavior, pinned by the existing 80+ adapter tests. (The two message converters stay separate: their wire shapes are irreconcilable by design.)
- **The settings page's model catalog is now unfiltered.** The `commandcode/models` Remote serves the full catalog instead of the plan-filtered picker list, so a routing rule can target a model the picker hides (e.g. route a GOAT-only model to the GOAT account from a Go-plan view). The visible-models filter shares the same full-catalog candidate list. Each entry also carries its plan-tier key so the editor dropdowns can group under tier headings.

## [0.10.1] - 2026-09-07

### Added

- **Support the Command Code Provider Chat Completions API** ([#22](https://github.com/Mars-Sea/dsh-commandcode-provider/pull/22)). Accounts with Provider API access now use the documented `POST /provider/v1/chat/completions` transport (a flat OpenAI-compatible request body) instead of the legacy CLI transport. Historical reasoning is replayed as `reasoning_content` for tool-loop continuity, and OpenAI SSE chunks (`reasoning` / `reasoning_content` / `content` / `tool_calls` / `usage`) are parsed into stream output. The legacy `POST /alpha/generate` transport is unchanged (including its no-reasoning-replay behavior) and remains the route for Go-plan accounts plus the automatic fallback when the Provider API answers `upgrade_required`.

### Fixed

- **Switching to Command Code mid-session no longer fails with `input[N].call_id must be <= 64`** ([#23](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/23)). Tool-call ids issued by another provider can exceed the Command Code gateway's 64-character limit and were replayed verbatim, so the stream was rejected once such history existed. Overlong paired ids are now remapped to short per-request aliases (`cc-1`, `cc-2`, …) on both transports, with each call and its result resolving through the same map so the pair stays correlated; ids within the limit still pass through unchanged.

### Changed

- **Synced with the official command-code@1.50.0 CLI** (2026-09-06: re-verified with no snapshot changes). `COMMAND_CODE_CLI_VERSION` is now `1.50.0`. Re-verified against the official sources: wire protocol (both the `/alpha/generate` CLI transport and the `/provider/v1/chat/completions` Provider transport), endpoints, auth flow, model catalog, subscription plan maps, deals, and peak/off-peak windows are all identical to 1.49.1.

## [0.10.0] - 2026-09-04

> **First stable release for the dsh 0.1.2 line.** This release requires **dsh 0.1.2-rc.1 or later** and is published on the `latest` npm tag. It graduates the 0.10.0-alpha.x line (command-code syncs up to 1.47.0) to stable. The previous stable line — 0.9.1 for older Harness releases (the 0.5.0 era) — is no longer under active maintenance; it stays on npm for existing users but receives no further updates.

### Changed

- **Raised the minimum supported DeepSeek Harness version to 0.1.2-rc.1.** Every Harness peer and development package now starts at the rc.1 line — the version `@latest` installs today. Source APIs, the Remote wire, and the Web slot surfaces are unchanged between alpha.2 and rc.1, so this is a metadata-only bump with no code changes.

## [0.10.0-alpha.8] - 2026-09-04

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Changed

- **Synced with the official command-code@1.47.0 CLI** (2026-09-04: marked Grok 4.6 vision-capable). `COMMAND_CODE_CLI_VERSION` is now `1.47.0`. Grok 4.6 now shows the `Image` capability marker in the picker.

## [0.10.0-alpha.7] - 2026-09-04

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Added

- **Muse Spark family now offers selectable reasoning efforts.** The official command-code@1.45.0 added `low`/`medium`/`high`/`xhigh` effort levels for all Muse Spark variants (1.1, 1.2, 1.2 Contributor, 1.3, 1.3 Contributor). The picker now shows a reasoning-effort selector for these models; they are no longer listed as auto-thinking models.

### Changed

- **Synced with the official command-code@1.46.0 CLI** (2026-09-03: 1.45.0 added Muse Spark reasoning levels, 1.46.0 added browser sign-in and `read_file` document support). `COMMAND_CODE_CLI_VERSION` is now `1.46.0`. Re-verified against the official sources: wire protocol, endpoints, auth flow, model catalog, subscription plan maps, deals, and peak/off-peak windows are all identical to 1.44.0.

## [0.10.0-alpha.6] - 2026-09-03

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Added

- **Synced with the official command-code@1.44.0 CLI** (2026-09-02: 1.41.0 added Qwen 3.8 Max 0902, 1.42.0 added the free LongCat 2.0, 1.43.0 added Gemini 3.8 Flash, and 1.44.0 added Meta Muse Spark 1.3 + Contributor). `COMMAND_CODE_CLI_VERSION` is now `1.44.0`, and the model picker knows the five new models: Qwen 3.8 Max 0902 and LongCat 2.0 show under the Go tier, Gemini 3.8 Flash and Muse Spark 1.3 under GOAT, and Muse Spark 1.3 Contributor under Go. LongCat 2.0 also shows a `FREE` badge (100% off while it lasts, like Laguna S 2.1). Gemini 3.8 Flash, Qwen 3.8 Max 0902 and both Muse Spark 1.3 variants are Vision-capable and appear with the `Image` marker; LongCat 2.0 is text-only.

### Fixed

- **Claude Fable 5.1 (`claude-fable-5-1`) is now correctly marked as a Provider/Max model.** The model, added upstream in command-code@1.40.0, was mis-synced in 0.10.0-alpha.5 as an Anthropic OAuth-only model outside the Provider API — but it IS served by the Provider API (it shows up in the live model catalog), and because it had no `KNOWN_PLANS` entry the picker's plan filter failed open and listed it for **every** subscription plan. It is now mapped to the Provider/Max tier (matching its official availability matrix and the CLI's plan-access map), so Go/GOAT/Pro accounts no longer see it in the picker; `resolveModel` still serves it and the server remains the final gate (`403 MODEL_NOT_IN_PLAN`). The snapshot now also carries its selectable reasoning efforts (`low`/`medium`/`high`/`xhigh`/`max`, same as `claude-fable-5`) and its Vision capability (official registry: "Text input, Vision, Reasoning").

## [0.10.0-alpha.5] - 2026-09-02

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Changed

- **Kimi K3 now offers selectable reasoning efforts (`low`/`high`/`max`).** The model gained official effort levels in command-code@1.39.3 ("Add low, high, and max reasoning effort support for Kimi K3"), so the picker can now offer a reasoning-effort selector for it; it is no longer listed as an auto-thinking model.
- **Synced with the official command-code@1.40.1 CLI** (2026-09-02: 1.39.3 added Kimi K3 effort levels, 1.40.0 added Fable 5.1, and 1.40.1 is a ZDR feature-model filter). `COMMAND_CODE_CLI_VERSION` is now `1.40.1`. Re-verified against the official sources with no other changes: wire protocol, endpoints, auth flow, model catalog, subscription plan maps, deals, and peak/off-peak windows are all identical to 1.39.2. (Fable 5.1's plan-tier mapping was corrected in a follow-up — see [0.10.0-alpha.6].)

## [0.10.0-alpha.4] - 2026-09-01

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Added

- **Command Code web search through the dsh `web_search` tool.** When the profile mounts the web stack (`@deepseek-ai/dsh-web` + `@deepseek-ai/dsh-tool-web`), this plugin now registers a `commandcode` search provider on `ctx.web` that calls the Command Code Provider API's `/alpha/web-search` endpoint. It reuses the **same API key and base URL as chat**, so dsh's web search needs no separate search key, endpoint, or model configuration — the existing `COMMANDCODE_API_KEY` (or the CLI auth file) works as-is. Results map to the dsh `WebSearchSource` shape; `numResults` clamps to the Command Code range (1–10, default 5). The provider is registered only when the web service is present, so this remains a chat-only plugin in profiles without it.
- **A "Serve dsh web search with Command Code" toggle in the settings page (`webSearch`, default on).** The Command Code settings page now lets you choose whether the model-facing `web_search` tool is backed by Command Code or by dsh's shipped DeepSeek search. The toggle writes the web seam's selected search provider at boot and on every settings change, so it takes effect on the next search — no restart, no hand-editing `cordis.patch.yml`. Turning it off falls back to the DeepSeek backend.

## [0.10.0-alpha.3] - 2026-09-01

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Added

- **New model: DeepSeek V4 Flash Fast (`deepseek/deepseek-v4-flash-fast`, command-code@1.39.0).** A Go-tier 1M-context low-latency DeepSeek V4 Flash deployment: it appears in the picker under the Go tier with `1M` markers, offers selectable reasoning efforts (`low`/`high`/`max`), and carries time-of-day (peak/off-peak) pricing like the rest of the DeepSeek V4 family. It is text-input only, so it stays outside the Vision whitelist.

### Changed

- **Synced with the official command-code@1.39.2 CLI** (2026-09-01: 1.39.0 added DeepSeek V4 Flash Fast; 1.39.1 dropped `medium` effort for it; 1.39.2 retired the MiniMax free models). `COMMAND_CODE_CLI_VERSION` is now `1.39.2`.
- **The MiniMax M3 / M2.7 FREE promo variants were retired** from the official CLI in command-code@1.39.2 ("Retire MiniMax free models"): the browser hides them from the picker and the pricing page no longer lists them as free. The plugin removes their `FREE`/`free: true` entries rather than letting them lapse on their old 2026-09-05 expiry, so users no longer see a retired discount. The paid MiniMax M3 / M2.7 rows keep their own rates.

## [0.10.0-alpha.2] - 2026-08-31

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Added

- **Route models to accounts (`modelAccountRules`).** A new settings card (and matching `Config.modelAccountRules` YAML) routes catalog models — picked via **multi-select from the live model catalog** (fetched Host-side through a new `commandcode/models` Remote) — to an account slot. Requests whose model is in a rule serve from that account while it is usable, falling back to the normal rotation when the routed account is exhausted or invalid. First matching rule wins. Pairs naturally with the existing multi-account rotation — e.g. keep cheap Go-tier models on the Go account and route GOAT-only models to the GOAT account.

### Changed

- **The Models page now configures Command Code entirely through the official 编辑 button.** The plugin card no longer adds its own header, badges, and edit toggle under the row: with the editor closed the row looks like any other provider, and opening 编辑 replaces the old "其余字段在 settings.yaml 中" placeholder (which offered nothing but a disabled apply button) with the real controls — key/route status, the API-key field, official sign-in, and discard/save.
- **Synced with the official command-code@1.38.2 CLI** (2026-08-28: 1.38.0 added "Let custom agents pin a reasoning effort next to their model" + "Add reasoning effort support for Tencent Hy4 Preview"; 1.38.1/1.38.2 are same-day hotfixes). `COMMAND_CODE_CLI_VERSION` is now `1.38.2`.
- **Tencent Hy4 Preview now offers selectable reasoning efforts (`low`/`medium`/`high`).** The model gained official effort levels in command-code@1.38.0, so the picker can now offer a reasoning-effort selector for it; it is no longer listed as an auto-thinking model.
- **Gemini 3.7 Flash's 50% off deal was retired** from the official pricing page's `#deals` section; the snapshot no longer advertises it, so the picker shows the model at full price.
- **Closed two catalog-coverage gaps**: the hidden free variant `tencent/Hy3` and the deprecated `inclusionai/ling-3.0-flash-free` (its free promo ended 2026-08-03) are now in the Go tier snapshot. Plan tiers read 42/46/59/64.

## [0.10.0-alpha.1] - 2026-09-01

> **Alpha channel for dsh 0.1.2-alpha.2.** This release requires **dsh 0.1.2-alpha.2 or later** and is published under the `alpha` npm tag, so `@latest` stays on 0.9.1 for older Harness releases. Install it explicitly with `@alpha`.

### Changed

- **Raised the minimum supported DeepSeek Harness version to 0.1.2-alpha.2.** Every Harness peer and development package now starts at the alpha.2 line; earlier RC/alpha builds use incompatible Host and browser APIs and are no longer advertised as supported.
- **Adapted the provider to the 0.1.2-alpha.2 Host and browser contracts.** Tool-call IDs use `ToolCallId`, settings register through the optional `SettingsProvider` service, credential operations use Typert Remotes, and the browser client consumes the current settings/models surfaces without the removed `dsh-client-runtime` package.

### Fixed

- **Restored fresh plugin-marketplace installs under pnpm 10.** The package declares `@deepseek-ai/dsh-invariants` as an explicit alpha.2 Host peer instead of bundling a second Harness core package; a pnpm 10.34.5 tarball-install smoke test pins the isolated-generation path.
- **Kept the Web client enabled on alpha.2.** The client no longer requests the removed `dsh-client-runtime/client` module, while its React, slot, store, and primitive dependencies match the official alpha.2 platform module table; settings and Models pages therefore remain available instead of disabling the entire client bundle.
- **Isolated snapshot subscriber failures.** The client-local `getSnapshot`/`subscribe`/`set` store now continues notifying remaining UI consumers when one subscriber throws.
- **Prevented the friendly image-session error wrapper from blocking alpha.2 client startup.** Alpha.2 no longer exposes `connection.api.sessions`, so the optional copy rewrite safely skips itself when that legacy façade is absent.

## [0.9.1] - 2026-08-28

### Added

- **New model: Tencent Hy4 Preview (`tencent/hy4-preview`, command-code@1.37.0).** A Go-tier 1M-context reasoning model routed through OpenRouter: it appears in the picker under the Go tier with `1M` markers, is tracked as an auto-thinking model (reasons automatically with no selectable effort levels), and lives outside the Vision whitelist — text input only.

### Changed

- **Synced with the official command-code@1.37.0 CLI** (upstream's only change was the new model above). `COMMAND_CODE_CLI_VERSION` is now `1.37.0`. Plan tiers now read 40/44/57/62 (Go / cumulative-through-Goat / cumulative-through-Pro / cumulative-through-Provider): the new model enters Go. Re-verified against the official sources with no other changes: wire protocol, endpoints, auth flow, reasoning-effort map, subscription plan maps (`individual-*`), image registry, deals, and peak/off-peak windows are all identical; Tencent Hy4 Preview is not hourly-priced.

## [0.9.0] - 2026-08-28

### Added

- **Bilingual (`zh` / `en`) copy for the Host-side `/commandcode` command and the friendly image-gate error rewrite.** All user-facing strings the command prints (title, blocked-state headline, plan/usage/credit/window sections, mark labels, account badges, partial-failure footer, error text) and the model's `does not accept image input` message rewrite are now resolved through a shared `commandcodeCommand` dictionary. The Host command's locale comes from the new `Config.lang` setting (explicit override, with `LC_ALL`/`LANG` fallback, defaulting to `'zh'` to match the existing single-language behavior); the image-gate wrapper reads the client's active locale at call time (`ctx.locale.getLocale().active`), so a language switch in the settings UI applies to the next selectModel failure immediately. The two surfaces are independent by design — they live on different processes and have no shared locale seam, so each follows the most natural signal for its own runtime.

### Changed

- **`withFriendlyImageError(sessions, getLocale)` now takes a `getLocale` thunk** (previously had no locale parameter). Existing call sites are updated; programmatic consumers can pass `() => 'zh'` (the prior hardcoded language) for unchanged behavior. The `installFriendlyImageError(connection, getLocale)` helper mirrors the new signature.
- **`commandDefinition(deps)` and `applyCommands(ctx, deps)` accept an optional `getLocale?: () => LocaleId` dep.** The plugin entry wires it from `Config.lang` and the shell's `LC_ALL`/`LANG`; programmatic setups that don't supply it keep rendering with the default `'zh'` (the prior hardcoded language).

## [0.8.4] - 2026-08-27

### Added

- **New model: Qwen 3.8 Flash (`Qwen/Qwen3.8-Flash`, command-code@1.36.0).** A Go-tier 1M-context Vision reasoning model with `low`/`medium`/`xhigh` effort levels, rounding out the Qwen 3.8 family alongside the existing Max and 27B variants.
- **New model: GLM-5.3 Flash (`z-ai/glm-5.3-flash`, command-code@1.35.0).** A Go-tier 1M-context Vision reasoning model with `low`/`high`/`max` effort levels, added to the catalog as the official replacement when the Ox Alpha preview ended.

### Removed

- **The Ox Alpha preview is over (`stealth/ox-alpha`, command-code@1.34.0).** The model is gone from the catalog, the picker, and the FREE deal list; accounts that were using it should switch to GLM-5.3 Flash (same effort set, Vision-capable, free on every plan).

### Changed

- **Synced with the official command-code@1.36.0 CLI.** `COMMAND_CODE_CLI_VERSION` is now `1.36.0`. Plan tiers now read 39/43/56/61 (Go / cumulative-through-Goat / cumulative-through-Pro / cumulative-through-Provider): the two new Go models enter Go, and `stealth/ox-alpha` leaves every tier. Re-verified against the official sources with no other changes: wire protocol, endpoints, auth flow, `KNOWN_SUBSCRIPTION_PLANS` (the `individual-*` plan map and its monthly-credit totals are identical to 1.33.0), `KNOWN_PEAK_PRICING` (DeepSeek V4 Pro/Flash/Vision, 01–04 and 06–10 UTC), and every other deal on the pricing page.

## [0.8.3] - 2026-08-26

### Fixed

- **Qwen 3.8 Max no longer shows the hourly-pricing (`Peak`/`Half`) marker.** The official pricing page's hover annotation for the three hourly-billed DeepSeek models had been misattributed to this neighboring row; Qwen 3.8 Max is not billed by the hour. Everything else is identical to 0.8.2.

## [0.8.2] - 2026-08-26

### Added

- **New free models: MiniMax M3 Free (`minimax/minimax-m3-free`) and MiniMax M2.7 Free (`minimax/minimax-m2.7-free`, command-code@1.33.0).** Command Code's own free variants of the paid M3/M2.7, free through September 5, 2026 — they appear at the top of the picker with `FREE` markers and drop the badge automatically once the promo ends. M3 Free is a Go-tier 1M-context model with image input (it reasons automatically); M2.7 Free is a text-only 197K model.

### Changed

- **The model picker's group header now reads "Command Code"** instead of the lowercase route id (`commandcode`), matching the name shown on the settings page.
- **Synced with the official command-code@1.33.0 CLI** (upstream's only change was adding the two free models above). `COMMAND_CODE_CLI_VERSION` is now `1.33.0`. Re-verified against the official sources with no other changes: wire protocol, endpoints, auth flow, reasoning-effort maps, subscription plans, and peak windows are all identical; plan tiers gained only the two new Go-tier variants.

## [0.8.1] - 2026-08-25

### Changed

- **Synced with the official command-code@1.32.2 CLI** (upstream shipped two CLI-internal fixes — BYOK model-picker improvements and a session fix for malformed tool results — neither touching the Provider API). `COMMAND_CODE_CLI_VERSION` is now `1.32.2`. Re-verified against the official sources with no changes: wire protocol, endpoints, auth flow, the live model catalog (58 models), reasoning-effort maps, plan tiers, subscription plans, deals, and peak windows are all identical.

## [0.8.0] - 2026-08-22

### Added

- **The settings page can now sign you in instead of asking for a pasted key.** A "Sign in to Command Code" action on the key field starts the same authorization flow the official `command-code login` CLI command performs: your browser opens the commandcode.ai approval page, and once approved the delivered API key is validated against the Provider API and stored in the local credential service under the plugin's default reference — the very next request uses it, no restart, and the key itself never crosses into the browser. The attempt is single-flight with a 2-minute window, cancellable, state-token-checked, and every failure (denied, timeout, invalid key, unreachable validation, unwritable store, remote Host without a loopback) lands in a distinct message that points back at manual paste.
- **The settings page now tells you when a plugin update is available.** Opening the "Command Code" page quietly asks npm (at most once a day, cached in the browser) for the latest published version; when it is newer than the running build, the footer version line gains a small warning-tinted "vX.Y.Z update available" link to that release's notes on GitHub. The check degrades silently — an unreachable network or registry simply shows nothing, a failed attempt never retries more than once per day, and any previously learned version keeps its hint alive.

## [0.7.1] - 2026-08-22

### Fixed

- **The active-account dropdown now aligns with the other settings fields.** The browser draws native `<select>` controls with its own box model and internal text metrics, so the picker under "Active account" rendered two pixels shorter than every input on the page, with its value sitting at a slightly different height. It now matches the inputs exactly (same height, same text position) and carries a custom chevron that stays legible in both themes.
- **The usage card's two timestamps share one line.** The billing period end ("Period ends …") and the fetch time ("Updated …") used to occupy two stacked rows; the fetch time now sits on the same row, pushed to the right edge, so the account card ends one line shorter.
- **README: the documented update command is now `dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@latest`** (the `plugin` command forwards to pnpm, whose `update` verb is what refreshes an installed plugin).

## [0.7.0] - 2026-08-22

### Added

- **New model: DeepSeek V4 Flash Vision (exp) (`deepseek/deepseek-v4-flash-vision-exp`, command-code@1.32.0).** An experimental Go-tier vision reasoning model with a 1M context: it appears in the picker under the Go tier with `Image` · `1M` markers, is whitelisted as vision-capable, offers `high`/`max` effort levels, and shares V4 Flash's peak/off-peak hourly pricing — the picker's `Peak`/`Half` marker reflects the current UTC hour.

### Changed

- **Ox Alpha now has selectable reasoning-effort levels** (`low` / `high` / `max`, command-code@1.32.1) — the picker offers an effort selector for it instead of letting Command Code choose the depth silently. It accordingly left the auto-thinking set.
- **Synced with the official command-code@1.32.1 CLI** (upstream moved 1.31.0 → 1.32.0 → 1.32.1; both releases only added model capabilities and touch nothing in the Provider API). `COMMAND_CODE_CLI_VERSION` is now `1.32.1`. Re-verified against the official sources with no other changes: wire protocol, endpoints, auth flow, subscription plan maps, deals, and peak windows are identical; plan tiers gained only the new Vision model above.
- **The remaining network and timeout errors are now bilingual (English + 中文).** The connect timeout, connection failure, mid-stream drop, stream idle watchdog, and empty-response errors — the ones that repeat in the retry chrome during transient network trouble — now carry both readings in one string, each with an actionable hint (check the network/proxy; long-thinking models can raise the stream idle timeout). Like the 0.6.2 credential and rate-limit messages, the English reading leads and the Chinese reading follows.

## [0.6.2] - 2026-08-21

### Added

- **Stored API keys can now be cleared, not just replaced.** A "Clear stored key" action on the default key and on every account stages a removal (with a visible "will be cleared on save" badge and an undo); saving unsets the credential through the Host's `credentials.unset`, so the account reports unconfigured again and falls back to its other key sources. Previously a bad key could only be overwritten, never removed.

### Changed

- **Free models now lead the model picker.** Models whose deals mark them free (currently Ox Alpha and Laguna S 2.1) sort ahead of every paid tier — they cost no credits and work on any account, so they make the best defaults. The rest of the order is unchanged: Go → GOAT → Pro → Provider/Max, alphabetical within each tier.

### Fixed

- **An invalid or expired API key no longer hides behind "Some endpoint data unavailable".** When every account endpoint rejects with 401 (wrong/expired key), the usage card now shows a prominent "API key invalid or expired" banner with an actionable hint instead of the generic partial-data note; a total 5xx or network outage gets their own distinct banners too. The `/commandcode` command surfaces the same cause up front. Partial failures keep the existing degraded view.
- **Retry and credential failure messages are now bilingual (English + 中文).** The harness UI renders these messages verbatim inside its retry/turn-error chrome, so the "all accounts exhausted" rate-limit error, the all-401 credential error, and the single-account 401 error now carry both readings in one string — no more parsing an English-only wall of text to learn when your window resets.

## [0.6.1] - 2026-08-22

### Added

- **New model: Ox Alpha (`stealth/ox-alpha`, command-code@1.31.0).** A free 1M-context reasoning model with vision input, included on every plan: it appears in the picker under the Go tier with `FREE` · `Image` · `1M` markers, is whitelisted as vision-capable and auto-thinking (it reasons automatically with no selectable effort levels), and carries a `FREE` deal while the stealth preview lasts.
- **The settings page now shows the plugin version** as a muted footer line ("Command Code Provider v0.6.1"), read from package.json at build time so it always matches the published release.
- **Settings-page input polish:** a brief "Saved ✓" confirmation flashes after each accepted save (failures already showed an error); the two millisecond timeout fields now validate their range while typing with specific messages ("must be at least 1" / "above the allowed maximum") instead of a generic save-time failure; and the API-key fields (default + every account) gained a Show/Hide toggle so a pasted key can be spot-checked.

### Changed

- **Retries are now persistent (opencode-style) instead of two attempts.** Transient failures — rate limits, server errors, timeouts, transport drops, empty responses — retry up to 1000 times at the agent-step boundary, with waits doubling from 500 ms and capping at 15 minutes (±10% jitter). Permanent failures (an invalid key, unsupported content, plan rejections) still fail fast on the first attempt. Waits are smart: a 429's `Retry-After` header and the rotation pool's earliest known window-reset time are honored verbatim up to the 15-minute cap, so when every account's usage window is exhausted the session sleeps through the window and recovers in place instead of dying after two quick tries.
- **Synced with the official command-code@1.31.0 CLI** (upstream moved 1.28.4 → 1.29.0 → 1.30.0 → 1.30.1 → 1.31.0; the intermediate releases shipped BYOK provider support, model-traffic routing, and CLI UI fixes — none touch the Provider API). `COMMAND_CODE_CLI_VERSION` is now `1.31.0`. The only snapshot change across those releases is the new Ox Alpha model above; wire protocol, endpoints, effort map, plan maps, deals, and peak pricing are all unchanged.
- **Verified compatibility with DeepSeek Harness 0.1.0-rc.7 / 0.1.0-rc.8 / 0.1.1-rc.1**, including rc.8's reworked client boot protocol: the client bundle now declares its module-graph dependency (`dsh.client.external`), so client-module load order no longer relies on the platform seed table. The supported peer range widened to `^0.1.0-rc.6 || ^0.1.1-rc.1`, so 0.1.1 hosts install without unmet-peer-dependency warnings.

## [0.6.0] - 2026-08-19

### Changed

- **Synced with the official command-code@1.28.4 CLI** (upstream moved 1.28.1 → 1.28.4: 1.28.2 raised the Qwen 3.8 27B usage allowance on GOAT and Pro, 1.28.3 fixed a CLI UI overlay issue; 1.28.4 is not on the changelog page yet). `COMMAND_CODE_CLI_VERSION` is now `1.28.4`. No snapshot or wire changes: the 1.28.4 bundle's effort map, plan maps, ZA model table, endpoints, request fields, and stream event types are all identical to 1.28.1, and the live catalog still lists the same 56 models.
- **The settings page's account-usage card is now a carousel.** With several accounts configured, a tab strip (account label + status dot) switches between per-account reports instead of stacking them, so the page no longer grows with each account; the selector defaults to the currently serving account. Each account's report carries its own **remove** button (staged like every other edit, persisted on save) — offered only for accounts the settings document actually owns (the default account and composition-only literal-key accounts are not removable from the page), and the per-row remove buttons in the account-management card below were removed (unsaved additions keep theirs, since they never appear in the Host-side usage report). Accounts staged for removal disappear from the carousel immediately and stay hidden across the post-save refresh.

## [0.5.0] - 2026-08-19

### Added

- **Multi-account rotation: when one Command Code account exhausts its usage window, requests seamlessly continue on the next account.** A new account pool (`src/accounts.ts`) resolves every configured account's key per request — the top-level `apiKey`/`apiKeyEnv` (plus the CLI auth file) forms the `default` account, and a new `accounts` config/settings list (`[{ label, apiKeyEnv }]`, or `apiKey` literals in composition config) adds more. Rotation is **passive** — zero extra API calls in the steady state: a key is marked only when a request using it is actually rejected pre-stream (429 → exhausted, 401 → disabled), and the adapter retries the same request with the next account's key inside `stream()` (the request body is account-independent and `threadId` is random per request, so the switch is invisible to the model). When every account is marked, the pool probes each key's real five-hour window via `/alpha/billing/credits` (reviving accounts whose window already reset) and otherwise throws a `RATE_LIMIT` error naming **the earliest window reset time**; all-401 throws `INVALID_CREDENTIAL`. Rotation state is keyed by API key, so two slots sharing one credential share one mark.
- **The settings page gained an "Account rotation" card** (Settings → **Command Code**) to add, label, key, and remove extra accounts — keys are written through the credentials domain under per-account references (`COMMANDCODE_API_KEY_2`, …) exactly like the default key, never through the settings document.
- **Manual account switching**: a new **Active account** selector on the same card (persisted as the `activeAccount` setting — `default`, or an extra account's credential reference) pins which account serves, effective on the next request after saving. The pinned account serves whenever it is usable; if it is exhausted (or the id is unknown), requests fall back to the first usable account, and automatic rotation still applies. Extra-account slot ids are now the credential reference itself, so a stored selection survives account-list reorders and removals.
- **Per-account usage everywhere.** The `commandcode/report` Remote result is now `{ accounts: [...] }` (wire schema + descriptor updated; host and client ship in the same bundle), the settings page's account card renders one section per account with **Active / Cooling down / Invalid key** badges, and the `/commandcode` command prints one dashboard section per account with `✅ 当前使用` / `⏳ 限额冷却中` markers. The picker's plan-tier billing cache is now per account as well.

### Changed

- **Synced with the official command-code@1.28.1 CLI** (upstream moved 1.27.1 → 1.27.2 → 1.28.0 → 1.28.1). `COMMAND_CODE_CLI_VERSION` is now `1.28.1`. The only user-visible upstream change is **Qwen 3.8 27B** (added in 1.28.0; 1.28.1 gave it selectable effort levels): it is a Go-tier Vision model with a 262K context, so `KNOWN_PLANS` maps `Qwen/Qwen3.8-27B` to `go`, `KNOWN_IMAGE_MODELS` whitelists it (per the official registry's Vision flag), and `KNOWN_EFFORTS` maps it to `['low', 'medium', 'xhigh']` (per the 1.28.1 bundle's effort map). Re-verified every other snapshot against the official sources with no changes: `KNOWN_THINKING_MODELS` (the new model has efforts, so it is not in the auto-think set), `KNOWN_SUBSCRIPTION_PLANS` (`Nn`/`$n` maps untouched), `KNOWN_DEALS` (same five deals, same terms), and `KNOWN_PEAK_PRICING` (DeepSeek V4 Pro/Flash, 01–04 & 06–10 UTC). Wire protocol, endpoints, headers, and auth flow are byte-identical between the 1.27.1 and 1.28.1 bundles (marker-level diff: same endpoint/request-field/event counts; the ZA model table gained only the new model).

### Fixed

- **Review hardening** (post-implementation review fixes): a failed settings save now stops at the first failed write and reconciles account staging with what actually landed, so a retry can never persist duplicate accounts; the usage card is gated on **any** configured account (not just the default), so a keys-only-on-extra-accounts setup can fetch usage; rotated keys go through the same `assertUsableApiKey` normalization as the first key, keeping the pool's mark identity identical to the wire identity; the probe-revival pass excludes the just-rejected key so a same-request revival cannot re-offer a tried key; a cooldown without a known reset time renders as "cooling down" instead of looking healthy; slots sharing one credential are reported as configured in both usage views; removing the pinned active account also clears the selection; and the pool's dead `activeSlotId()` accessor was removed.

## [0.4.2] - 2026-08-18

### Fixed

- **Tool results now round-trip the real tool name, fixing multi-turn tool calls on Google Gemini models ([#5](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/5)).** `messagesToCC()` hard-coded `toolName: ''` on replayed `tool-result` messages; Anthropic/OpenAI-style backends tolerate that (they correlate by `tool_call_id`), but Gemini's `functionResponse` requires a non-empty function name, so every multi-turn tool call on Gemini-family models failed mid-stream with `[Google] Tool message must have either name or tool_call_id`. The adapter now collects each paired tool call's `toolCallId → toolName` in the same pass that computes pairing and writes the real name onto the result, falling back to `'unknown'` — mirroring the official CLI's `tool_use_id -> toolName` map (`?? "unknown"`). Thanks to @seva324 for the precise root-cause report and patch. The replay tests now assert the carried name (they previously only checked the tool message existed, which is how this slipped through), plus a new fallback case.

## [0.4.1] - 2026-08-18

### Changed

- **Synced with the official command-code@1.27.1 CLI** (upstream moved from 1.26.0 → 1.27.0 → 1.27.1). `COMMAND_CODE_CLI_VERSION` is now `1.27.1`, sent as `x-command-code-version` on every request. The only user-visible upstream change is **GPT-5.6 Sol** (added in command-code@1.27.0, "50% off in GOAT and above"): it is a GOAT-tier model, so `KNOWN_PLANS` now maps `gpt-5.6-sol` to `goat` (was `pro`) — GOAT accounts will now see it in the picker instead of having it filtered out. Re-verified every other snapshot against the official sources with no changes: `KNOWN_EFFORTS` (identical to the 1.27.1 `ZA` table), `KNOWN_IMAGE_MODELS` (the docs registry's Vision set is unchanged and includes Sol), `KNOWN_THINKING_MODELS`, `KNOWN_SUBSCRIPTION_PLANS` (the `Nn`/`$n` plan maps are untouched), `KNOWN_DEALS` (the pricing page lists no Sol deal — its "50% off" is not a `KNOWN_DEALS` entry), and `KNOWN_PEAK_PRICING` (DeepSeek V4 Pro/Flash, 01–04 & 06–10 UTC). Wire protocol, endpoints, and auth flow are unchanged in the 1.27.x bundle.

## [0.4.0] - 2026-08-17

### Added

- **The settings page now shows a live "Account usage" card** (Settings → **Command Code**) with the same facts the `/commandcode` command prints — account name, request totals with success rate, spend, token in/out, monthly/purchased/free credits, and the 5-hour and weekly window limits as progress bars with reset times and exceeded markers. The report is produced Host-side (the browser never holds the API key) and crosses to the page through a new Typert Remote endpoint `commandcode/report`: the Host half registers a `commandcodeUsage` service plus a strict invocation descriptor on the `typert` registry (riding an optional inject, so profiles without the web stack are unaffected), and the client half mounts the shared contribution on `ctx.remote` (resolving the `remote.commandcode` namespace through a dynamic scoped inject, since cordis only serves a fiber the services it declares and the namespace exists only after the mount) and renders the result as a native card — stat tiles and CSS progress bars, not markdown. The card fetches automatically once a key is configured, refetches after a landed save (the key or endpoint may have changed), and offers a manual refresh; a failure (no key, unreachable host, or an older Host half) renders an inline error with the card's previous data retained. The shared wire contract (`src/usage-wire.ts`) — a hand-rolled strict result schema plus the single descriptor object both halves register — is covered by new tests in `tests/usage-wire.test.ts`, and the fetch-lifecycle controller by `tests/usage-client.test.ts`.
- **The usage report now includes the account's subscription plan**, fetched from `/alpha/billing/subscriptions` (org-scoped like the official CLI, with the `credits.planId` fallback the CLI also uses) and shown as a plan badge (Go / GOAT / Pro / Max / Provider / Ultra / Teams Pro) in the card header — plus the billing period end in the card footer and a `📦 套餐` line in the `/commandcode` command output. Plan ids resolve through a new `KNOWN_SUBSCRIPTION_PLANS` snapshot + `subscriptionPlanInfo()` (longest-prefix matching, mirroring the CLI's `getPlanInfo`), synced from the CLI bundle's plan table; a non-`active` subscription status surfaces as a badge next to the plan name.
- **The model picker now hides models above the account's subscription tier.** `listModels()` filters the catalog through `modelVisibleInPlan()` using billing facts from one cached `/alpha/billing/credits` call (`credits.planId` + balances, 5-minute TTL). The filter mirrors the official CLI's access model — **any positive on-demand credit balance unlocks every model** — and fails open at every uncertainty (billing endpoint down, unknown plan, unmapped model), so a stale plugin never hides a usable model; the server remains the final gate (`403 MODEL_NOT_IN_PLAN`). The catalog itself is never filtered (`resolveModel` still serves every model), and a new **"Hide out-of-plan models" toggle on the settings page** (the `filterModelsByPlan` section field) restores the full list.

## [0.3.0] - 2026-08-17

### Added

- **The model picker now shows DeepSeek's time-of-day pricing state as a compact `Peak`/`Half` marker.** Since 2026-08-16 16:00 UTC, DeepSeek V4 Pro and V4 Flash cost full price during peak hours (01:00–04:00 and 06:00–10:00 UTC, 7h/day) and half price off-peak (the other 17h/day) — the official pricing page retired the old 75%-off deal in favor of this hourly pricing. `capabilityDescription()` now reads the current UTC hour and appends `Peak` (full price) or `Half` (off-peak, half price) for models in the new `KNOWN_PEAK_PRICING` snapshot, e.g. `Go · Half · 1M` at 17:00 UTC. The English noun markers match the picker's existing style (`Go`, `Image`, `FREE`), and since they appear only on time-of-day priced models they double as a "priced by the hour" signal. New `peakPricingState()`/`peakPricingLabel()` helpers are exported and covered by boundary-hour unit tests. The lapsed 75%-off entry was removed from `KNOWN_DEALS` (expired deals are dropped once the official page retires them).

### Fixed

- **`projectSlugFromPath` no longer exhibits quadratic matching on adversarial paths (CodeQL `js/polynomial-redos`, alert #1).** The old trim step `/^-+|-+$/g` was ambiguous: on input like `a<200k dashes>b` the unanchored `-+$` alternation retried every start position, taking ~14.5s where a linear trim takes ~0ms. The trailing trim now uses the negative lookbehind `(?<!-)-+$` (the fix CodeQL documents), so only one start position is ever tried. The `x-project-slug` header is derived from the user-configurable working directory, so this was reachable from user input. A regression test pins the linear behavior.

## [0.2.4] - 2026-08-16

### Fixed

- **`requestTimeoutMs` no longer aborts a healthy generate body mid-stream.** `AbortSignal.timeout(requestTimeoutMs)` was passed straight into `fetch()`, so Fetch cancelled the SSE body after the connection budget even when events were still flowing — long reasoning/generation then failed as `TRANSPORT` (`failed while reading: aborted due to timeout`) and triggered harness retries. The adapter now clears the connect deadline once response headers arrive; after that only the caller `AbortSignal` and `streamIdleTimeoutMs` may abort the stream.

## [0.2.3] - 2026-08-16

### Changed

- **`streamIdleTimeoutMs` default raised from 120s to 300s.** The stream idle watchdog used to kill a generation that produced no events for 120s, but frontier reasoning models (xhigh/max effort) can legitimately stay silent for minutes while thinking — the official CLI sets no idle cap at all. An aggressive cap turned long thinking into a spurious `TIMEOUT`, which dsh-llm-retry then retried, surfacing to users as "stuck, then reconnecting". The new 300s default keeps the dead-connection protection (a truly stalled socket still fails instead of hanging) without cutting off legitimate long thinking. Tune `streamIdleTimeoutMs` in the `llm-commandcode` settings section or on the settings page for your workload.

### Fixed

- **In-band stream `error` events are now classified like the official CLI, so transient server-side drops get retried instead of failing the turn.** The adapter previously threw every stream `error` event as `PROVIDER_STREAM_ERROR`, which is outside the harness default retryable set — a server blip that the official CLI recovers from (e.g. "Upstream stream ended before terminal chunk") failed the whole turn. Now the adapter mirrors command-code's `readStreamErrorEvent`/`isStreamErrorRetryable`: an error that is explicitly non-retryable, carries a terminal marker (`premium_credits_exhausted`, `model_not_in_plan`, `insufficient credits`), or reports a non-retryable HTTP status stays `PROVIDER_STREAM_ERROR`; everything else is thrown as `SERVER`, which the default retry policy retries.

## [0.2.2] - 2026-08-16

### Added

- **A dedicated "Command Code" settings page** (Settings → **Command Code**, a top-level nav entry at the same level as General / Models / Plugins) where you can configure the provider **entirely from the web UI**: an **API-key field** (write-only, stored through the dsh credentials service under the `COMMANDCODE_API_KEY` reference the plugin resolves, with a configured/unconfigured badge) plus the **API base URL**, **working directory**, and **request/stream timeouts** (written to the `llm-commandcode` settings namespace, effective on the next request — no restart). The browser half registers a `settings.section` entry (`id: commandcode`) from the bundle's client plugin; the controller is covered by new unit tests in `tests/settings.test.ts`.
- **The working-directory field is now genuinely optional in the settings page**: the page reads the Host process cwd (`host.describe().cwd`) and shows it as the field's placeholder, so a blank field visibly resolves to the process working directory — nothing to configure unless you want to pin a specific path. The page hints this in both languages.

### Fixed

- **The API key could not actually be configured from the Models page for this provider.** The Models page renders an unknown-adapter-family card for `commandcode` and disables its editor (submit is blocked when `layout === 'unknown'`), so the card's key field could not save. The new dedicated settings page is the working surface for the key (and the connection knobs); the Models card remains as a status/reflection of the provider.

## [0.2.1] - 2026-08-16

### Fixed

- **`KNOWN_EFFORTS` advertised reasoning-effort levels for ten models that carry none in the official command-code@1.26.0 model table.** The 0.2.0 snapshot added `claude-haiku-4-5-20251001`, `moonshotai/Kimi-K2.5`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `MiniMaxAI/MiniMax-M2.5`, `xiaomi/mimo-v2.5`, `xiaomi/mimo-v2.5-pro`, `tencent/Hy3`, `tencent/hy3-paid`, and `meta/muse-spark-1.2-contributor` with effort arrays, but the CLI's authoritative `ZA` table (dist/cli.mjs) defines **no `reasoningEfforts`** for any of them — the picker was offering a selector the Provider API won't honor, and the adapter would send `reasoning_effort` for models that don't support it. The snapshot is now exactly the 26 models the `ZA` table marks with efforts (re-verified 2026-08-16 against command-code@1.26.0).
- **`KNOWN_THINKING_MODELS` included three non-reasoning models and missed three reasoning ones.** `zai-org/GLM-5`, `zai-org/GLM-5.1`, and `zai-org/GLM-5.2-Fast` are `reasoning:false` in the `ZA` table and "Text input"-only in the official registry — they were wrongly labeled as thinking automatically. Conversely `moonshotai/Kimi-K2.7-Code-Highspeed`, `tencent/hy3-paid`, and `meta/muse-spark-1.2-contributor` are `reasoning:!0` without effort levels and now belong. (The set is a data snapshot only — it is not surfaced in the picker's compact description.)
- **DeepSeek V4 Pro's 75%-off deal is time-limited, not permanent.** The official pricing page retires it on **2026-08-16 16:00 UTC** when DeepSeek replaces the flat rate with peak/off-peak pricing. `KNOWN_DEALS['deepseek/deepseek-v4-pro']` now carries `expiresAt: '2026-08-16T15:59:59.999Z'`, so the picker stops showing the discount the moment it lapses — even in an un-updated plugin.

## [0.2.0] - 2026-08-16

### Fixed

- **`KNOWN_EFFORTS` was missing ten models that the official command-code@1.26.0 model table defines reasoning-effort levels for** (`claude-haiku-4-5-20251001`, `moonshotai/Kimi-K2.5`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `MiniMaxAI/MiniMax-M2.5`, `xiaomi/mimo-v2.5`, `xiaomi/mimo-v2.5-pro`, `tencent/hy3-paid`, `tencent/Hy3`, `meta/muse-spark-1.2-contributor`). These models previously showed no reasoning-effort selector in the harness even though the official CLI exposes one; they now do. The snapshot was re-verified against the CLI's authoritative `ZA` model table (dist/cli.mjs) rather than the docs page alone.

### Added

- **`KNOWN_THINKING_MODELS`** — models the official registry marks `Reasoning` but for which the CLI defines no selectable effort levels (e.g. `MiniMaxAI/MiniMax-M3`, `moonshotai/Kimi-K3`, `Qwen/Qwen3.7-Max`, `thinkingmachines/inkling`). The model picker now labels these "Supports thinking (auto)" instead of the misleading "Text only", so a reasoning-capable model is no longer mistaken for a text-only one. Selectable efforts remain exclusively driven by `KNOWN_EFFORTS`, matching the official CLI (which omits `reasoning_effort` for these models too).
- **Plan-tier annotation in the model picker** (`KNOWN_PLANS` in `src/adapter.ts`, synced from the [official plan pages](https://commandcode.ai/docs/plans/go)) — every catalog model is tagged with the minimum plan that includes it, per the official plan model lists: **Go** (33 models), **GOAT** (+3), **Pro** (+14), and **Provider/Max** (+5, the Claude Opus/Fable and Fugu Ultra tier). The picker's `description` leads with the plan label — e.g. `Go · 50% off · Image · 1M`, `Pro · Image · 1M` — so "which plan do I need to actually use this model?" is answerable at a glance instead of only after a 403 `MODEL_NOT_IN_PLAN` on the first request. New `KNOWN_PLANS`, `PLAN_LABELS`, `planLabel()`, and `capabilityDescription()` exports.
- **Deal and free-model annotations** (`KNOWN_DEALS` in `src/adapter.ts`, synced from the [official pricing page](https://commandcode.ai/docs/resources/pricing-limits#deals)) — the picker now shows active discounts (`75% off`, `50% off`, `98% off`, `99% off`) and the `FREE` badge (Laguna S 2.1) next to the plan tier. **Expiry-aware**: each deal records its official end date; `dealLabel()` hides a deal the moment `Date.now()` passes that date, so an un-updated plugin never shows a lapsed discount as if it were still live (only Gemini 3.7 Flash's 50% off is time-limited — through December 31, 2026; the rest are permanent).
- **Compact Image + context-window markers** — the picker now shows `Image` for Vision-capable models (the verbose *"Supports image input"* is gone) and the context window in human form (`1M`, `256K`, `262K`) via `formatContext()`. Text-only models show no capability marker at all — plan tier (and deal, if any) plus context is enough.
- **`capabilityDescription()` is now compact**: `Go · 50% off · Image · 1M`, `Provider · 1M`, `Go · FREE · 256K` — plan tier first, then active deal, then `Image`, then context. Text-only models simply omit the Image marker.
- **The model picker sorts by plan tier, then name** (`compareByPlan()` in `src/adapter.ts`) — Go models lead the list, then GOAT, Pro, and Provider/Max last, alphabetically within each tier (new `PLAN_ORDER` weights + `compareByPlan()` exports). A Go-plan user sees the models they can actually use at the top instead of hunting through a flat alphabetical catalog; unknown/untracked models sort last.

## [0.1.9] - 2026-08-15

### Added

- **Image input for Vision-capable models.** Models the official Command Code registry lists with Vision (see `KNOWN_IMAGE_MODELS` in `src/adapter.ts`, synced from the [official model registry](https://commandcode.ai/docs/reference/cli/models)) now accept attached images: bytes resolve through the dsh attachment service (`ctx.attachments`) and are sent in the official CLI wire shape `{ type: 'image', source: { type: 'base64', media_type, data } }`. Text-only models (e.g. `deepseek/deepseek-v4-flash`) refuse images loudly (`UNSUPPORTED_CONTENT`) rather than silently dropping them; a request carrying images also requires the attachment service. The `CommandCodeAdapterDeps` seam gains an optional `resolveAttachments` resolver (used lazily, only when a request actually has images).
- **The model picker now shows each Command Code model's image capability** (`listModels`/`resolveModel` return a `description`: *"Supports image input"* / *"Text only"*), so switching in an image-bearing session is informed instead of surprising.
- **A client half for the bundle** (`dsh.client` + `exports["./client"]` → `lib/client.js`): it wraps the shared `session.selectModel` face and rewrites the harness's image-session `model-unavailable` rejection into a clear, actionable message — `当前会话已包含图片，而模型 <model> 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。` — while passing the error code and details through unchanged. The rejection itself is a deliberate `dsh-host-apiproxy` guard that cannot be relaxed from the plugin side; this makes it friendlier. Both READMEs document the behavior.

## [0.1.8] - 2026-08-15

### Fixed

- **The 0.1.7 scoped-name fix crashed on boot with a YAML parse error.** 0.1.7 rewrote the patch row's `name` to `@mars-sea/dsh-commandcode-provider` but left it unquoted; a YAML scalar starting with `@` is an indicator and fails to parse (`YAMLException: bad indentation of a mapping entry`), so `dsh --dump-config` and every boot died. The value is now quoted: `name: "@mars-sea/dsh-commandcode-provider"` (verified against dsh's own js-yaml and a real profile boot).
- **Transport failures now surface the real root cause.** The `TRANSPORT` error from a failed `fetch` (DNS, refused/reset connection, TLS, proxy, timeout) previously reported only the generic wrapper — `Command Code API request to .../alpha/generate failed` — while the actionable detail sat unused on `error.cause`. The web UI renders only the error message (not the cause chain), so users hit a wall of retry rows ("重试延迟"/"Retry delay") with no way to diagnose. The message now appends `errorChain(cause)`, so the failure reason names e.g. `connect ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, or the timeout abort.
- **A stalled connection no longer hangs the turn.** `requestTimeoutMs` (default 60s) bounds the wait for the first response byte via `AbortSignal.timeout`, and `streamIdleTimeoutMs` (default 120s) treats a stream with no events as a dead connection — both fail as `TIMEOUT` with the duration instead of hanging until the OS socket timeout (which can be minutes). Configurable per profile in the `llm-commandcode` settings section.

### Changed

- `CommandCodeConnectionOptions` gains `requestTimeoutMs` and `streamIdleTimeoutMs`; both are optional in the `Config` schema and default to 60s/120s. New `DEFAULT_REQUEST_TIMEOUT_MS` / `DEFAULT_STREAM_IDLE_TIMEOUT_MS` exports.
- Both READMEs document the new knobs and the transport-failure troubleshooting entry (notably: Node's fetch ignores `HTTP_PROXY`/`HTTPS_PROXY`, so proxy-dependent networks fail here while the browser works).
- Both READMEs gain an **Updating** section: since the bundle patch layer is read from the installed package at boot, updating the package fixes the patch row automatically; the section covers npm/git/local update commands and the ≤0.1.6 hand-copied-patch caveat.
- Both READMEs restructure the install docs: **npm is now the recommended install path** (one command, always the latest published release), GitHub moves below it, and the uninstall command is documented (use the scoped name `@mars-sea/dsh-commandcode-provider`, since pnpm records dependencies under the real package name).

## [0.1.7] - 2026-08-15

### Fixed

- **Boot-crashing patch row for every install path** (`cordis.patch.yml`): the layer's `name` was the bare `dsh-commandcode-provider`, but the loader imports it as a module from the profile's `node_modules`, where pnpm only links the true scoped name `@mars-sea/dsh-commandcode-provider`. Any install (npm, GitHub, local path — all of which link the scoped name) failed at load with `ERR_MODULE_NOT_FOUND` and took the web app into a `Restart=on-failure` crash loop. The row now reads `name: @mars-sea/dsh-commandcode-provider`. Existing profiles that copied the old row (or an old README example) into their own `cordis.patch.yml` must update it the same way (see the Troubleshooting entry).

### Changed

- Both READMEs document the scoped `name` requirement, show the corrected `--dump-config` layer heading (`# == @mars-sea/dsh-commandcode-provider`), and use the scoped name in the `allowBuilds` example and the `remove` command.

## [0.1.6] - 2026-08-15

### Added

- **Security Scans workflow** (`.github/workflows/security.yml`): `npm audit` (fails on ≥ high severity), CodeQL analysis (`javascript-typescript`, action v4), and a gitleaks secrets scan (official `gitleaks/gitleaks-action@v3`, full history via `fetch-depth: 0`).
- **Chinese README** (`README.zh-CN.md`): full translation of the English README with a language switcher in both directions; shipped in the npm package (`files` list).

### Changed

- CI actions upgraded ahead of the Node 20 runner deprecation: `actions/checkout` → v6 (Node 24 runtime); `github/codeql-action` → v4 (v3 deprecated Dec 2026).
- Install examples in both READMEs now pin the `v0.1.6` release tag.

## [0.1.5] - 2026-08-15

### Added

- **Usage dashboard**: `CommandCodeAdapter.getUsage()` queries the official Command Code account endpoints (`/alpha/whoami`, `/alpha/usage/summary`, `/alpha/billing/credits`) that the official CLI uses. Each endpoint degrades independently.
- **`/commandcode` slash command** (requires the dsh `commands` service; degrades silently when absent) shows account, request counts, cost, tokens, credit balance, and 5-hour/weekly window limits. Verified against a live account.
- Unit tests for `getUsage()` and the command (`tests/commands.test.ts`, stubbed fetch, 6 cases).

### Changed

- `@deepseek-ai/dsh-commands` added back to peerDependencies (optional at runtime for the command).

## [0.1.4] - 2026-08-14

### Changed

- `COMMAND_CODE_CLI_VERSION` bumped from `1.24.0` to `1.26.0` (current official CLI version).
- `KNOWN_EFFORTS` refreshed against the official command-code@1.26.0 bundled catalog: adds `zai-org/GLM-5.3` (`low/high/max`). All previously listed models verified unchanged.

## [0.1.3] - 2026-08-14

### Changed

- `COMMAND_CODE_CLI_VERSION` bumped from `1.15.1` to `1.24.0` (the current official CLI version; the version header is now taken from the official command-code package rather than the older pi-plugin snapshot).
- `KNOWN_EFFORTS` refreshed against the official command-code@1.24.0 bundled catalog (`dist/cli.mjs`): adds `google/gemini-3.7-flash` (`low/medium/high`) and `xai/grok-4.6` (`low/medium/high/xhigh`). All previously listed models verified unchanged.

## [0.1.2] - 2026-08-14

### Fixed

- Network-level transport failures now throw `LlmError` with code `TRANSPORT` instead of leaking undici's bare `TypeError: fetch failed` (whose raw detail, e.g. `UNKNOWN`, previously surfaced as the whole error). Both the generate request and a mid-stream read are wrapped, with the original error chained as `cause` so `errorChain` renders the full diagnosis. Caller aborts propagate unchanged (not relabeled). This lets dsh's retry policy recognize and retry transient network failures (dsh-llm-retry retries `TRANSPORT`).

## [0.1.1] - 2026-08-14

### Added

- Core unit tests (`tests/adapter.test.ts`, node:test, zero extra runtime deps): message conversion, SSE/JSONL stream parsing, catalog parsing, HTTP-error mapping, reasoning-effort exposure. `npm test`; CI runs it.
- `fetchImpl` injection on the adapter for testability (defaults to the global `fetch`).
- `providerRetryPolicy()`: declares the default retry policy (retries `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`), so metered Command Code 429s and transient 5xx are retried at the agent-step boundary by dsh-llm-retry.

### Changed

- HTTP error mapping: a 401 now throws `INVALID_CREDENTIAL` (config problem, not retryable) instead of `PROVIDER_HTTP_ERROR`; 403/429 responses are parsed for the machine-readable `error.code` and included in the message.

## [0.1.0] - 2026-08-14

### Added

- Command Code LLM adapter for DeepSeek Harness, ported from pi-commandcode-provider@0.5.1 (MIT).
- `commandcode` provider route with a live model catalog (`GET /provider/v1/models`, ~54 models) and per-model reasoning-effort metadata (`KNOWN_EFFORTS`, command-code@1.15.1 snapshot).
- Models-page card ("Command Code") with an API-key field, backed by the dsh credential seam and the `llm-commandcode` settings namespace.
- API-key resolution: `config.apiKey` → credential reference `apiKeyEnv` (default `COMMANDCODE_API_KEY`) → launching environment → official CLI auth file (`~/.commandcode/auth.json`).
- Installable dsh bundle (`dsh.bundle` manifest + `cordis.patch.yml` layer), supporting local-path, GitHub, and npm installs.
- `StreamChunk` protocol compliance: block assembly, usage-before-finish, tool-call replay for paired calls only, `LlmError` with stable codes, `attributionHeaders()` on all provider HTTP requests, `options.signal` honored.

### Known limitations

- Text-only input (image input throws `UNSUPPORTED_CONTENT`); no `stop` sequences; reasoning blocks are not replayed into later turns.
