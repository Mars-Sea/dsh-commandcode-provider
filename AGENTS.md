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
                      conversion, SSE/JSONL stream parsing, catalog + cache.
src/index.ts          Plugin entry: Config schema, credential resolution,
                      settings namespace, route + directory registration,
                      /commandcode command wiring.
src/commands.ts       The /commandcode usage dashboard command.
src/client/index.ts   Browser client entry: registers the "Command Code"
                      settings page (settings.section, id `commandcode`) and
                      installs the friendly image-gate error wrapper.
src/client/settings.ts  Settings-page controller (scope + credentials + staged
                      form; React-free so node tests can drive it).
src/client/section.tsx  The settings page React component.
src/client/sessions.ts  selectModel friendly-error wrapper (React-free).
src/client/locales.ts   zh/en copy + LocaleNamespaceMap augmentation.
tests/adapter.test.ts Core adapter unit tests (node:test + tsx).
tests/commands.test.ts getUsage + command tests (stubbed fetch, no network).
tests/client.test.ts  sessions-wrapper tests.
tests/settings.test.ts settings-page controller tests.
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
  and host-shipped client bundles resolvable from the loader's module table
  (e.g. `@deepseek-ai/dsh-client-runtime/client`). The settings page binds the
  `llm-commandcode` namespace through `ctx.settingsScope` and writes the API
  key through `connection.api.credentials` under the `COMMANDCODE_API_KEY`
  reference — never through the settings section, so the key literal cannot
  leak into a settings document. `tests/settings.test.ts` pins this contract.
- **Wire protocol** (reverse-engineered, command-code@1.26.0):
  - `POST {apiBase}/alpha/generate` — body `{ config, memory, taste, skills, params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`.
  - Image parts use the official CLI wire shape: `{ type: 'image', source: { type: 'base64', media_type, data } }` (NOT pi's `data:` data-URI form).
  - Stream: SSE-ish JSONL events `text-delta | reasoning-start/delta/end | tool-call | tool-result | finish | error`.
  - Catalog: `GET {apiBase}/provider/v1/models` → `{ object: 'list', data: [{ id, name, context_length }] }`.
  - Defaults: `apiBase = https://api.commandcode.ai`, `COMMAND_CODE_CLI_VERSION = '1.26.0'`.
- **API key resolution order** (in `src/index.ts`): `config.apiKey` → credential ref `apiKeyEnv` (default `COMMANDCODE_API_KEY`, via the dsh credentials seam) → launch environment → official CLI auth file `~/.commandcode/auth.json`. **pi/OMP auth files are intentionally NOT scanned** — keep it that way.
- **StreamChunk contract** (dsh-llm): each block starts with `block-start`, deltas by `index`, ends with `block-end`; `usage` before `finish`; nothing after `finish`. Tool-call `arguments` are raw JSON strings. Reasoning blocks are intentionally NOT replayed into later turns (matches the CLI; private reasoning must not leak). Only tool calls with a paired tool result are replayed.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 → `RATE_LIMIT`; other HTTP → `PROVIDER_HTTP_ERROR` (403 body's `error.code`, e.g. `MODEL_NOT_IN_PLAN`, is parsed into the message). Unsupported options (`stop`) and image input throw `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` rather than silently dropping.
- **Adapter is cordis-free** by design: `src/adapter.ts` takes a per-request `options()` thunk + `resolveApiKey()` from the plugin entry, so settings changes reach the next request without re-registration. It also accepts an injectable `fetchImpl` for tests.
- **Static capability snapshots** (all in `src/adapter.ts`, all synced from official sources — see the `dsh-commandcode-upstream` skill for the exact extraction procedures):
  - `KNOWN_EFFORTS` — model → selectable reasoning-effort levels. Authoritative source is the CLI bundle's `ZA` model table (`command-code/dist/cli.mjs`), **not** the docs page (whose `Reasoning` flag means "thinks", not "has effort levels").
  - `KNOWN_IMAGE_MODELS` — Vision-capable models, synced from [commandcode.ai/docs/reference/cli/models](https://commandcode.ai/docs/reference/cli/models); note catalog IDs can differ from doc IDs (e.g. `claude-haiku-4-5-20251001` vs doc's `claude-haiku-4-5`).
  - `KNOWN_THINKING_MODELS` — models with `reasoning:!0` but no effort levels in the `ZA` table (they think automatically). Not displayed in the picker.
  - `KNOWN_PLANS` — catalog ID → minimum plan tier (`go`/`goat`/`pro`/`provider`), synced from the plan pages ([go](https://commandcode.ai/docs/plans/go) ⊂ [goat](https://commandcode.ai/docs/plans/goat) ⊂ [pro](https://commandcode.ai/docs/plans/pro) ⊂ provider/max). Strict superset chain; every catalog ID covered exactly once (33/36/50/55 as of 2026-08).
  - `KNOWN_DEALS` — catalog ID → `{ label, expiresAt?, free? }` from the pricing page's `#deals`. **Expiry-aware**: `dealLabel()` hides a deal once `Date.now()` passes its `expiresAt`, so an un-updated plugin never shows a lapsed discount.
  - `KNOWN_PEAK_PRICING` — catalog IDs with hourly (peak/off-peak) pricing, synced from the pricing page's model rows. Peak windows live in `PEAK_HOUR_RANGES` (UTC, end-exclusive); `peakPricingLabel()` maps the **current** UTC hour to `Peak`/`Half`.
  - The picker `description` is composed by `capabilityDescription()`: plan tier · active deal · peak/off-peak state (`Peak`/`Half`, hourly-priced models only) · `Image` (Vision only) · context (`formatContext()`: `1M`/`256K`/`262K`). Text-only models show no capability marker. Do not reintroduce "Text only" or "Supports image input".
  - The picker list is **sorted by plan tier then name** (`compareByPlan()` in `src/adapter.ts`, weights in `PLAN_ORDER`): Go → GOAT → Pro → Provider/Max, alphabetical within each tier, unknown plans last. Keep this order when changing `listModels()`.
- **Retry**: `providerRetryPolicy()` returns the dsh default policy (retries `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`), executed by dsh-llm-retry at agent-step boundaries.

## Commands

```sh
npm install             # devDeps incl. tsdown, tsx, typescript
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/**/*.test.ts
npm run build           # tsdown -> lib/ (also runs via `prepare` on publish/git install)
npm pack --dry-run      # verify publish contents (must include lib/, cordis.patch.yml, README*, CHANGELOG, LICENSE)
```

## Release procedure

1. Edit `CHANGELOG.md` (Keep a Changelog format) for the new version.
2. `npm version patch|minor|major --no-git-tag-version` — bump without auto-tag.
3. `npm run typecheck && npm test && npm run build`.
4. Commit, then `npm publish` (requires the maintainer's 2FA OTP; the maintainer runs it, not the agent).
5. Tag and push: `git tag v<version> && git push && git push --tags`.
6. **Create a GitHub Release** for the tag (`gh release create v<version> --title "v<version>" --notes "<notes from CHANGELOG>"`). Releases — not tags or pushes — are what star followers see in their activity feed and get notified about; skipping this step makes the release invisible to users who starred the repo.

## Rules

- Keep changes focused; the ported wire logic is pinned by tests — update `tests/adapter.test.ts` when you change behavior.
- Do not commit, tag, push, or publish unless explicitly asked.
- Do not reintroduce pi/OMP auth-file scanning.
- Public API (exports from `src/index.ts`) is used by dsh's loader/registry — preserve `name`, `inject`, `Config`, `apply` and the `dsh.bundle` manifest shape.
