# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
