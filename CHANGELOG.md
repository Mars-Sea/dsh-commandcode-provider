# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
