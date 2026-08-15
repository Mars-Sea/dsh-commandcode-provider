# dsh-commandcode-provider

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

Unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin for **Command Code**, ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT). It registers a `commandcode` model provider whose requests are translated to Command Code's Provider API (`POST /alpha/generate`, reverse-engineered by the pi plugin, `command-code@1.26.0`).

> This is a community integration. You need your own Command Code account and API key or subscription, and Command Code's terms apply. This project is not affiliated with Command Code, Inc.

## What you get

- A **plugin bundle** installable into any dsh profile with `dsh plugin add` (npm package with a `dsh.bundle` layer).
- A **`commandcode` provider route** registered on the `llm` service, selectable in the model picker, with the **live model catalog** fetched from `GET {apiBase}/provider/v1/models` (cached at `~/.commandcode/models-cache.json`).
- A **Models-page card** ("Command Code") with an API-key field — credentials are stored through the dsh credentials service, same as the DeepSeek card.
- **API key resolution** in this order: `config.apiKey` → credential reference `apiKeyEnv` (the web Models page writes it, default `COMMANDCODE_API_KEY`) → the launching environment → the official Command Code CLI auth file (`~/.commandcode/auth.json`, written by `command-code login`).
- **Reasoning-effort support** for the models Command Code's catalog marks as such (e.g. `claude-opus-5`, `gpt-5.5`, `deepseek/deepseek-v4-pro`, `moonshotai/Kimi-K2.5`, …) via `KNOWN_EFFORTS`, matching the official command-code@1.26.0 bundled model table. Reasoning models without selectable effort levels (e.g. `MiniMaxAI/MiniMax-M3`, `moonshotai/Kimi-K3`) still think — Command Code drives their reasoning depth automatically, exactly like the official CLI.
- **Plan-tier annotation in the model picker**: every Command Code model is tagged with the minimum plan that includes it (`KNOWN_PLANS`, synced from the [official plan pages](https://commandcode.ai/docs/plans/go)) — **Go** (33 models), **GOAT** (+3), **Pro** (+14), or **Provider/Max** (+5: Claude Opus/Fable, Fugu Ultra). The picker's `description` leads with the plan label, e.g. *"Go · 50% off · Image · 1M"*, *"Pro · Image · 1M"*, so you know which plan a model needs before switching — no more 403 `MODEL_NOT_IN_PLAN` surprises. **The list itself is sorted by plan tier** (`compareByPlan()`): Go models first, then GOAT, Pro, Provider/Max, alphabetical within each tier — the models your plan can actually use lead the picker.
- **Deal and free-model annotations**: active discounts (`75% off`, `50% off`, `98% off`, `99% off`) and the `FREE` badge (Laguna S 2.1) show next to the plan tier (`KNOWN_DEALS`, synced from the [official pricing page](https://commandcode.ai/docs/resources/pricing-limits#deals)). **Expiry-aware**: each deal records its official end date and is hidden the moment it passes — an un-updated plugin never shows a lapsed discount as if it were live (only Gemini 3.7 Flash's 50% off is time-limited, through December 31, 2026; the rest are permanent).
- **Image + context markers**: the picker shows `Image` for Vision-capable models and the context window in human form (`1M`, `256K`, `262K`); text-only models show neither — plan tier plus context is enough.
- **Image input for Vision-capable models**: models the official registry lists with Vision (e.g. `claude-sonnet-5`, `gpt-5.4`, `google/gemini-3.5-flash`, …) accept attached images, resolved through the dsh attachment service and sent in the official Command Code wire format. Text-only models (e.g. `deepseek/deepseek-v4-flash`, `zai-org/GLM-5.3`) refuse images loudly rather than silently dropping them.

## Getting an API key

Command Code API keys never expire. The easiest path is the official CLI (Node.js 22+):

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux; native Windows: cmdc login
```

`cmd login` opens a browser to authenticate; on success the key is written to `~/.commandcode/auth.json` — this plugin picks it up automatically (last-resort fallback). Alternatively create an API key in the browser ([Command Code Studio](https://commandcode.ai/studio/auth/cli)) and paste it into the Models page card, or `export COMMANDCODE_API_KEY="user_..."`.

## Install

### From npm (recommended)

The plugin is published to the npm registry as **`@mars-sea/dsh-commandcode-provider`** (the bare name `dsh-commandcode-provider` is taken by an unrelated package):

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### From GitHub

```sh
# Pin a release tag (recommended — readable and immutable)
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.8
# Or pin any exact commit by its SHA
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>
```

The `#<ref>` suffix pins the source to one exact revision (pnpm git-dependency syntax: a tag, branch, or commit SHA). Without it the install tracks the default branch, so a later push can silently change what you get — pin a tag or commit and audit the code you run.

A git install fetches **sources**, so the package's `prepare` script builds `lib/` after install. pnpm ≥10 blocks that script by default — run the `add`, then copy the **exact package key pnpm prints** into `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@mars-sea/dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>': true
```

and re-run the `add`. Only allow packages whose source you trust (and pin a commit).

### From a local checkout

```sh
npm install
npm run build                          # git-installed/tarball installs do this via `prepare` automatically
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

A local path install links the checkout as-is, so after changing `src/` re-run `npm run build` and restart the app.

### What the install does

`dsh plugin add` links the package into the profile (pnpm records dependencies and links `node_modules` by the **true package name**, i.e. `@mars-sea/dsh-commandcode-provider`), appends that same name to the profile's `dsh.profile.bundles`, and activates the `cordis.patch.yml` layer, which inserts:

```yaml
- insert:
    - id: llm-commandcode
      name: "@mars-sea/dsh-commandcode-provider"
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

The `name` in the patch row must be the **full package specifier, quoted**: the loader imports it as a module and resolves it from the profile's `node_modules`, where pnpm only ever links the scoped name. A bare `dsh-commandcode-provider` fails with `ERR_MODULE_NOT_FOUND` and crashes the app on boot, and an unquoted `@mars-sea/...` fails YAML parsing (see [Troubleshooting](#troubleshooting)).

Verify the composed layer, then (re)start the web app:

```sh
dsh --profile web --dump-config          # shows a "# == @mars-sea/dsh-commandcode-provider" layer
dsh web                                  # or restart your running instance
```

## Updating

The bundle's patch layer is read from the **installed package** at every boot, so updating the package brings in the fixed patch row automatically — you do not need to hand-edit `cordis.patch.yml` unless you copied its contents into your own profile layer.

Update according to how you installed it:

```sh
# From npm (recommended): always the latest published release
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider

# From GitHub pinned to a tag: point at the new tag
# (no need to uninstall first — pnpm swaps the pinned revision in place,
# and the bundle layer is re-read from the installed package on next boot)
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.9

# From a local checkout: pull the new code, rebuild, restart
git -C /path/to/dsh-commandcode-provider pull
npm run build --prefix /path/to/dsh-commandcode-provider
dsh web
```

Then restart the web app (`dsh web`, or restart the service). Verify the running version with `dsh --profile web --dump-config` — the layer should show `name: '@mars-sea/dsh-commandcode-provider'`.

> **`update` says "Already up to date" but the version did not move (pnpm ≥ 11)?** pnpm 11's `minimumReleaseAge` supply-chain policy can refuse to update to a freshly published version and report "Already up to date" even though a newer release exists. Pin the exact version instead:
>
> ```sh
> dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.1.9
> ```
>
> `add` with an explicit version installs it (and moves your spec to `^0.1.9`). If you trust your registry you can also disable the gate with `pnpm config set minimumReleaseAge 0 --location project` inside the profile directory (or delete the `minimumReleaseAgeExclude` entry pnpm wrote into `pnpm-workspace.yaml`).

> **Upgrading from ≤0.1.6** (or a broken hand-edited profile): the installed package's patch layer now carries the corrected, quoted `name`. If you previously *copied* the old patch row into your profile's own `cordis.patch.yml`, that copy still wins over the bundle layer — fix it manually to `name: "@mars-sea/dsh-commandcode-provider"` (see [Troubleshooting](#troubleshooting)) or remove it and let the bundle layer apply.

> **To uninstall instead of upgrading** (e.g. you are on a broken pre-0.1.7 tag and want to start clean): `dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider` (the scoped name — pnpm records the dependency under its real package name, so the bare `dsh-commandcode-provider` form does not match). This removes the dependency and its layer; your API key in the dsh credential store and `~/.commandcode/auth.json` are left untouched. Then install the current version with the npm or GitHub command above.

## Verify it works

After restart, in the web UI: **Settings → Models** shows a **Command Code** card; the model picker lists the live catalog under **commandcode** (54 models at the time of writing). Send a message with a model your plan includes — the default `deepseek/deepseek-v4-flash` works on entry-level plans; open-weight models (DeepSeek/Qwen/Kimi/MiniMax) generally do, while frontier models (Claude/GPT/Gemini/Grok) may require Pro/Max plans or on-demand usage (see FAQ).

## Usage dashboard

The plugin registers a `/commandcode` slash command (requires the dsh `commands` service, present in the standard web profile) that shows your Command Code account state straight from the official account endpoints:

```text
/commandcode        (or /commandcode status)
```

Example output (structured text with Unicode bar charts):

```text
📊 Command Code 用量 (mars-sea)

── 请求 ──────────────────────────────
  💬 请求    992 次 / 失败 0  成功率 100%
  💰 花费    $1.4446  ($1.44 credits)
  🔤 Token   205.3M 入 / 808.8K 出

── 信用 ──────────────────────────────
  💳 月额度  $8.54   (已购 $0.00 / 赠送 $0.00)
     └ ██████████  100%

── 窗口用量 ──────────────────────────
  ⏱ 5 小时  $0.18 / $3.00
     └ █░░░░░░░░░  重置 8/15/2026, 2:39:36 PM
  📅 每周    $1.46 / $6.00
     └ ██░░░░░░░░  重置 8/21/2026, 7:10:57 PM
```

Each endpoint degrades independently: a temporary failure of one (e.g. the credits endpoint) leaves the rest visible and notes the failure inline.

## Configure

The Command Code card takes your API key (stored in `$DSH_HOME/.credentials.yaml`; the model catalog is browsable without one). Advanced knobs live in the `llm-commandcode` section of `$DSH_HOME/settings.yaml` (overrides the bundle defaults per request, no restart needed):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference resolved per request
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # reported to the API (project slug, config block)
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # max wait for the first response byte (default 60s)
  streamIdleTimeoutMs: 120000      # stream stall before treated as a dead connection (default 120s)
```

The composition-entry config (`cordis.patch.yml` / your profile `cordis.patch.yml`) accepts the same keys; a literal `apiKey` there takes precedence over the credential reference.

## Troubleshooting

- **`Command Code API request to .../alpha/generate failed` and the turn keeps retrying (`重试延迟` / "Retry delay")** — this is a **transport-layer failure**: `fetch()` never received an HTTP response (not a 401/403/429, which would say "API error"). Since dsh's retry policy retries `TRANSPORT` twice with backoff, you'll see retry rows in the UI before the turn finally fails. Since 0.1.8 the failure reason shows the **real root cause** (e.g. `fetch failed: connect ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, `The operation was aborted due to timeout`). Common causes:
  - **A proxy is required in your network.** Node's `fetch` (undici) does **not** read `HTTP_PROXY`/`HTTPS_PROXY` environment variables, so a browser/curl that goes through a system proxy works while dsh fails. Run dsh with the proxy configured for undici (e.g. `NODE_OPTIONS=--import undici` with a dispatcher, or a network-level route), or whitelist `api.commandcode.ai`.
  - **The connection is being reset/throttled mid-request** (firewall, GFW-style interference, unstable Wi-Fi). The error message will name it (`socket hang up`, `ECONNRESET`, `UND_ERR_SOCKET`).
  - **TLS interception** (corporate MITM) — `CERT_HAS_EXPIRED`/`DEPTH_ZERO_SELF_SIGNED_CERT` in the chain.
  - A transient blip that a retry recovers from; if it persists every turn, it's environmental, not the API (the models endpoint and generate endpoint respond normally from healthy networks).
- **A long generation stops mid-stream** — since 0.1.8 the adapter aborts a request that gets no response within `requestTimeoutMs` (60s default) and a stream that stalls past `streamIdleTimeoutMs` (120s default) instead of hanging forever. Both failures surface as `TIMEOUT` with the stall duration; tune the knobs in the `llm-commandcode` settings if your network is slow but stable.
- **The web app crashes on boot with `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-commandcode-provider'`** — the patch row's `name` is the bare package name, but the loader imports it as a module from the profile's `node_modules`, where pnpm only links the scoped name `@mars-sea/dsh-commandcode-provider`. Pre-0.1.7 bundles shipped this wrong row, and the bug also bites when an old `cordis.patch.yml` example (or a cached profile layer) is copied by hand. Fix the row in your profile's `cordis.patch.yml` (or re-add the plugin) so it reads `name: "@mars-sea/dsh-commandcode-provider"` — note the **quotes**: an unquoted `@`-prefixed scalar fails YAML parsing (0.1.7 shipped that regression; 0.1.8 quotes it) — then restart.
- **`MODEL_NOT_IN_PLAN` (403)** — the selected model is not in your Command Code plan. Pick an open-weight model (e.g. `deepseek/deepseek-v4-flash`) or upgrade. The error names the model and links the official docs.
- **`MISSING_CREDENTIAL`** — no key anywhere. Store one via the Models page card, export `COMMANDCODE_API_KEY`, set `config.apiKey`, or run `command-code login`. The route stays registered and the catalog stays browsable without a key.
- **The Models page card shows "not configured" but requests work** — the key came from `~/.commandcode/auth.json` (the `cmd login` fallback), not the dsh credential store. Paste it into the card once to make the card show as configured; both coexist fine.
- **A reasoning model returns no visible text on short requests** — reasoning models (e.g. `deepseek/deepseek-v4-*`) consume output tokens on reasoning first; a small `maxTokens` can be exhausted before any visible text. This is normal.
- **`allowBuilds` errors on `dsh plugin add` from git** — copy the exact package key pnpm printed (with the commit hash) into `pnpm-workspace.yaml` and re-run (see [Install](#from-github)).

## Notes & limitations

- **Image input is model-gated**: only models the official Command Code registry lists with Vision accept images (see the `KNOWN_IMAGE_MODELS` snapshot in `src/adapter.ts`, synced from the [official model registry](https://commandcode.ai/docs/reference/cli/models)). The model picker marks Vision-capable models with *`Image`* (e.g. *"Go · 50% off · Image · 1M"*); text-only models carry no marker, so the capability is visible before you switch. Sending an image to a text-only model throws `UNSUPPORTED_CONTENT`. Command Code's own CLI falls back to a client-side *VISION* side-call for text-only models; this adapter does **not** reproduce that interactive feature — switch to a Vision-capable model instead. Image input also requires the dsh **attachment service** (`ctx.attachments`); without it, requests carrying images throw `UNSUPPORTED_CONTENT`.
- **Switching to a text-only model in an image-bearing session is rejected by dsh itself** — a harness-level guard (`dsh-host-apiproxy`'s `selectModel` handler) refuses `model-unavailable` when the session history or the pending input already contains images and the target model does not declare `image` input. The rejection is intentional and cannot be relaxed from the plugin side (the picker rows this adapter provides are the input that makes the guard work — a text-only model correctly reports `inputModalities: ['text']`). What this bundle **does** do is make the message friendlier: its client half wraps `session.selectModel` and rewrites that rejection to `当前会话已包含图片，而模型 <model> 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。` (the error code and details pass through unchanged, so any caller switching on `error.code` keeps working). To keep using images, select a model the picker marks *`Image`*, or remove the images from the session first; alternatively an image-routing bundle (e.g. `@deepseek-ai/dsh-llm-image-routing`) can transparently route image turns to a vision fallback.
- **No `stop` sequences**: the wire format has no stop field; requests carrying one throw `UNSUPPORTED_OPTION`.
- Reasoning blocks are **not replayed** into later turns (matches the official CLI: prior private reasoning must not leak).
- Only tool calls with a paired tool result are replayed into the conversation.
- The model catalog endpoint is public; requests to `/alpha/generate` require the key above.

## Permissions & privacy

This plugin operates entirely within your dsh profile and your Command Code account. What it touches:

- **Local files**
  - Reads `~/.commandcode/auth.json` (the official CLI login) **only** as a last-resort key fallback.
  - Reads/writes `~/.commandcode/models-cache.json` (model catalog cache).
  - Reads your API key from the dsh credential store (`$DSH_HOME/.credentials.yaml`) via the standard credential seam — the key is never logged or sent anywhere but the Command Code API.
- **Network**
  - `GET {apiBase}/provider/v1/models` — public model catalog (no key required).
  - `POST {apiBase}/alpha/generate` — the model requests themselves, authenticated with your key.
  - The request body includes the `workingDir` (project path) you configure (defaults to the process cwd), sent as Command Code's `config.workingDir`.
- **No telemetry**: no analytics, no tracking, no third-party endpoints. The only outbound hosts are the Command Code API (`api.commandcode.ai` by default, configurable via `apiBase`).

## Disabling / uninstalling

- **Disable** the provider without removing it: edit your profile's `cordis.patch.yml` and comment out (or remove) the `llm-commandcode` row, or set `disabled: true` on it, then restart the web app.
- **Uninstall** completely:

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  This removes the bundle dependency and its layer. Your API key in the dsh credential store and `~/.commandcode/auth.json` are left untouched (you can remove them manually if you want to revoke access).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

## Community & feedback

- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="GitHub" /> [GitHub Repository](https://github.com/Mars-Sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="Releases" /> [GitHub Releases](https://github.com/Mars-Sea/dsh-commandcode-provider/releases)
- <img src="https://cdn.simpleicons.org/npm/111827" width="16" alt="npm" /> [npm Package](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/discourse/111827" width="16" alt="Linux.do" /> [Linux.do 社区](https://linux.do/)

## License

MIT — see [LICENSE](./LICENSE). Portions ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).
