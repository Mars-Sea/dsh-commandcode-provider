# dsh-commandcode-provider

**English** | [简体中文](./README.zh-CN.md)

[![Awesome](https://awesome.re/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![GitHub Repo stars](https://img.shields.io/github/stars/Mars-Sea/dsh-commandcode-provider?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/stargazers)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/pulls)
[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

Unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin for **Command Code**, ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT). It registers a `commandcode` provider whose requests are translated to Command Code's Provider API (`POST /alpha/generate`, reverse-engineered by the pi plugin, `command-code@1.28.1`).

> This is a community integration. You need your own Command Code account and API key or subscription, and Command Code's terms apply. This project is not affiliated with Command Code, Inc.

## What you get

- **Plugin bundle** installable into any dsh profile with `dsh plugin add`, plus a **`commandcode` provider route** with a live catalog (`GET {apiBase}/provider/v1/models`, cached at `~/.commandcode/models-cache.json`).
- **Dedicated "Command Code" settings page** (Settings → **Command Code**) with an **API-key field**, connection knobs (API base, working directory, request/stream timeouts), a **live "Account usage" card** (stats, credits, window-limit bars, subscription plan badge) and a **Hide out-of-plan models** toggle. The key is stored through the dsh credentials service; connection fields land in the `llm-commandcode` section and apply to the very next request, no restart.
- **Multi-account rotation**: when one account's usage window (e.g. the Go plan's 5-hour limit) is exhausted, requests **seamlessly switch to the next account** — passive switching on 429/401, invisible to the model (the request body is account-independent and `threadId` is random per request); when every account is exhausted the error names **the earliest window reset**. The settings page's **Account rotation** card adds/labels/removes accounts, and `/commandcode` plus the usage card report per-account state. See [Account rotation](#account-rotation).
- **API key resolution order**: `config.apiKey` → credential ref `apiKeyEnv` (default `COMMANDCODE_API_KEY`) → launch environment → the official CLI auth file (`~/.commandcode/auth.json`, from `command-code login`).
- **Model-picker annotations**: every model shows the **minimum plan** that includes it (`KNOWN_PLANS`), an **active deal** or `FREE` badge (`KNOWN_DEALS`, expiry-aware so lapsed discounts hide themselves), the **current peak/off-peak state** (`Peak`/`Half`) for time-of-day-priced models, an **`Image`** marker for Vision models, and the **context window** (`1M` / `256K` / `262K`) — e.g. *"Go · 50% off · Image · 1M"*, *"Go · Half · 1M"*. The list is **sorted by plan tier** (Go → GOAT → Pro → Provider/Max), so the models your plan can use lead the picker.
- **Plan-aware picker filtering**: the picker **hides models above your subscription tier** outright (resolved live from your account's billing state). It fails open — an unreachable billing endpoint, an unknown plan, or a positive on-demand credit balance (which the official CLI treats as unlocking every model) all keep the full catalog visible — and the server stays the final gate. Set **Hide out-of-plan models** off on the settings page (or `filterModelsByPlan: false` in the `llm-commandcode` settings section) to always list every model.
- **Reasoning-effort support** for models the official catalog marks as such (`KNOWN_EFFORTS`, matching `command-code@1.28.1`); reasoning models without effort levels still think automatically, exactly like the official CLI.
- **Image input for Vision-capable models** (sent in the official wire format via the dsh attachment service); text-only models refuse images loudly (`UNSUPPORTED_CONTENT`) rather than dropping them.

<img src="assets/screenshots/model-picker.png" alt="Model picker with plan, deal, image and context annotations" width="250">

## Getting an API key

Command Code API keys never expire. The easiest path is the official CLI (Node.js 22+):

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux; native Windows: cmdc login
```

`cmd login` opens a browser to authenticate; the key is written to `~/.commandcode/auth.json` — picked up automatically as a last-resort fallback. Alternatively create a key in the browser ([Command Code Studio](https://commandcode.ai/studio/auth/cli)) and paste it into **Settings → Command Code**, or `export COMMANDCODE_API_KEY="user_..."`.

## Install

### From npm (recommended)

The bare name `dsh-commandcode-provider` is taken by an unrelated package, so this plugin is published as **`@mars-sea/dsh-commandcode-provider`**:

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### From GitHub

```sh
# Pin a release tag (recommended — readable and immutable)
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.2.2
# Or pin any exact commit by its SHA
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>
```

The `#<ref>` suffix pins one exact revision (pnpm git-dependency syntax). Without it the install tracks the default branch, so a later push can silently change what you get.

A git install fetches **sources**, so the package's `prepare` script builds `lib/` after install. pnpm ≥10 blocks that script by default — run the `add`, then copy the **exact package key pnpm prints** into `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@mars-sea/dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>': true
```

and re-run the `add`.

### From a local checkout

```sh
npm install
npm run build                          # git/tarball installs do this via `prepare` automatically
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

After changing `src/`, re-run `npm run build` and restart the app.

### What the install does

`dsh plugin add` links the package into the profile (pnpm records it under the **true package name** `@mars-sea/dsh-commandcode-provider`), appends that name to `dsh.profile.bundles`, and activates the `cordis.patch.yml` layer:

```yaml
- insert:
    - id: llm-commandcode
      name: "@mars-sea/dsh-commandcode-provider"
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

The patch `name` must be the **full package specifier, quoted** — the loader imports it as a module from the profile's `node_modules`, where pnpm only links the scoped name. A bare name fails with `ERR_MODULE_NOT_FOUND` and crashes the app on boot; an unquoted `@mars-sea/...` fails YAML parsing (see [Troubleshooting](#troubleshooting)).

Verify the composed layer, then (re)start the web app:

```sh
dsh --profile web --dump-config          # shows a "# == @mars-sea/dsh-commandcode-provider" layer
dsh web                                  # or restart your running instance
```

## Updating

The patch layer is read from the **installed package** at every boot, so updating the package brings the fixed row automatically — no need to hand-edit `cordis.patch.yml` unless you copied it into your own profile layer.

```sh
# npm: always the latest published release
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider

# GitHub (pinned): point at the new tag — no uninstall needed, pnpm swaps it in place
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.2.2

# local checkout: pull, rebuild, restart
git -C /path/to/dsh-commandcode-provider pull
npm run build --prefix /path/to/dsh-commandcode-provider
dsh web
```

Then restart the web app. Verify with `dsh --profile web --dump-config` — the layer should show `name: '@mars-sea/dsh-commandcode-provider'`.

> **`update` says "Already up to date" but the version did not move (pnpm ≥ 11)?** pnpm 11's `minimumReleaseAge` supply-chain policy can refuse a freshly published version. Pin the exact version instead: `dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.2.2` (or `pnpm config set minimumReleaseAge 0 --location project` inside the profile directory).

> **Upgrading from ≤0.1.6** (or a broken hand-edited profile): if you *copied* the old patch row into your profile's own `cordis.patch.yml`, that copy still wins over the bundle layer — fix it to `name: "@mars-sea/dsh-commandcode-provider"` or remove it (see [Troubleshooting](#troubleshooting)).

> **To uninstall instead**: `dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider` (the **scoped** name — pnpm records the dependency under its real name). Your API key in the dsh credential store and `~/.commandcode/auth.json` are left untouched.

## Verify it works

After restart: **Settings → Command Code** shows the dedicated page — enter your API key and click **Save** (the badge flips to 已配置/Configured once the Host holds it). **Settings → Models** shows a **Command Code** card; the model picker lists the live catalog under **commandcode**. Send a message with a model your plan includes — `deepseek/deepseek-v4-flash` works on entry-level plans, and open-weight models (DeepSeek/Qwen/Kimi/MiniMax) generally do, while frontier models (Claude/GPT/Gemini/Grok) may require Pro/Max plans or on-demand usage.

## Usage dashboard

The plugin registers a `/commandcode` slash command (requires the dsh `commands` service, present in the standard web profile) showing your account state from the official account endpoints:

```text
/commandcode        (or /commandcode status)
```

![Usage dashboard](assets/screenshots/usage-dashboard.png)

Each endpoint degrades independently — a temporary failure of one leaves the rest visible and notes the failure inline.

## Account rotation

With several Command Code subscriptions, the plugin **switches to the next account automatically** when one hits its usage limit:

- **Passive switching, zero extra cost**: rotation happens only when a request is actually rejected pre-stream — a 429 (window exhausted) marks the account exhausted, a 401 marks its key disabled, and the adapter immediately re-sends the same request with the next account's key (the request body is account-independent and `threadId` is random per request, so the switch is invisible to the model).
- **Precise revival**: once every account is marked, the plugin probes each key's real five-hour window via `/alpha/billing/credits` — accounts whose window already reset come back immediately; if all are still exhausted the request fails with a `RATE_LIMIT` error naming **the earliest reset time** (all-401 throws `INVALID_CREDENTIAL`).
- **Configuration surface**: the **Account rotation** card at Settings → **Command Code** — **Add account**, then give each a label and API key (every key is stored through the credentials service under its own reference `COMMANDCODE_API_KEY_2`, …, write-only like the default key). The top-level key always serves first as the `default` account.
- **Manual switching**: the **Active account** dropdown on the same card pins the preferred account (persisted as the `activeAccount` setting) — effective on the next request after saving. If the pinned account is exhausted, requests still rotate to another usable account, and once its window resets the pinned account serves again.
- **Per-account reporting**: the settings page's **Account usage** card renders one section per account with **Active / Cooling down / Invalid key** badges; `/commandcode` prints one dashboard section per account.

The equivalent YAML (`$DSH_HOME/settings.yaml` or composition config):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY        # first (default) account
  activeAccount: COMMANDCODE_API_KEY_2   # optional: pin the active account (`default` or an account's credential ref)
  accounts:                              # rotation order after it
    - label: Go #2
      apiKeyEnv: COMMANDCODE_API_KEY_2
    - label: Go #3
      apiKeyEnv: COMMANDCODE_API_KEY_3
```

Each account may also carry a literal `apiKey` in composition config (winning over its `apiKeyEnv`); key literals are never stored in the settings document.

## Configure

**Settings → Command Code** is the primary surface: an **API-key** field (stored in `$DSH_HOME/.credentials.yaml` via the credentials service; write-only, reports whether a key is set), plus **API base URL**, **working directory**, and **request/stream timeout** fields, all written to the `llm-commandcode` section. The catalog is browsable without a key. The **working directory** is optional — leave it blank and the placeholder shows the process cwd it resolves to.

Once a key is configured, the page header shows a live **Account usage** card — the same account, spend, credit, and window-limit facts as `/commandcode`, plus your subscription plan badge and billing period end — fetched Host-side (the key never leaves it) and rendered natively:

<img src="assets/screenshots/settings-page.png" alt="Command Code settings page with the account usage card" width="640">

The same knobs live in `$DSH_HOME/settings.yaml` (per-request overrides, no restart):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference resolved per request
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # reported to the API (project slug, config block)
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # max wait for the first response byte (default 60s)
  streamIdleTimeoutMs: 300000      # stream stall before treated as dead (default 300s — generous, so long-thinking models are not cut off)
```

The composition-entry config (`cordis.patch.yml`) accepts the same keys; a literal `apiKey` there takes precedence over the credential reference.

## Troubleshooting

- **`Command Code API request to .../alpha/generate failed` with retries** — a **transport-layer failure**: `fetch()` never got an HTTP response (a 401/403/429 would say "API error"). Since 0.1.8 the message names the real root cause (`ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, `socket hang up`, …). Common causes: **a required proxy** (Node's `fetch`/undici ignores `HTTP_PROXY`/`HTTPS_PROXY` — configure a dispatcher or whitelist `api.commandcode.ai`), **connection reset/throttled** (firewall, GFW-style interference, unstable Wi-Fi), **TLS interception** (corporate MITM), or a transient blip retry recovers from.
- **A long generation stops mid-stream** — since 0.1.8 the adapter aborts after `requestTimeoutMs` (60s) with no first byte, and treats a stream stalling past `streamIdleTimeoutMs` (300s by default) as dead. Both surface as `TIMEOUT` with the stall duration; tune the knobs for slow-but-stable networks.
- **"Reconnects" when a reasoning model thinks for a long time** — the stream idle watchdog used to default to 120s, which is shorter than a frontier reasoning model's silent thinking phase (xhigh/max effort can stay quiet for minutes, and the official CLI sets no idle cap at all). Since 0.2.3 the default is **300s**; if you still hit spurious timeouts on very long thinking, raise `streamIdleTimeoutMs` in the `llm-commandcode` section or on the settings page.
- **Boot crash: `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-commandcode-provider'`** — the patch row's `name` is the bare name, but pnpm only links the scoped name. Fix the row to `name: "@mars-sea/dsh-commandcode-provider"` — note the **quotes** (an unquoted `@`-prefixed scalar fails YAML parsing) — then restart.
- **`MODEL_NOT_IN_PLAN` (403)** — the model isn't in your plan. Pick an open-weight model or upgrade; the error names the model and links the docs.
- **`MISSING_CREDENTIAL`** — no key anywhere. Store one via the settings page, `export COMMANDCODE_API_KEY`, set `config.apiKey`, or run `command-code login`. The route and catalog stay browsable without a key.
- **Models card shows "not configured" but requests work** — the key came from `~/.commandcode/auth.json` (the `cmd login` fallback), not the credential store. Paste it into the card once; both coexist fine.
- **A reasoning model returns no visible text on short requests** — it consumes output tokens on reasoning first; a small `maxTokens` can be exhausted before visible text. Normal.
- **`allowBuilds` errors on `dsh plugin add` from git** — copy the exact package key pnpm printed into `pnpm-workspace.yaml` and re-run (see [Install](#from-github)).

## Notes & limitations

- **Image input is model-gated**: only models the official registry lists with Vision accept images (see `KNOWN_IMAGE_MODELS` in `src/adapter.ts`). Text-only models throw `UNSUPPORTED_CONTENT`; Command Code's own CLI's client-side *VISION* fallback is **not** reproduced here — switch to a Vision model instead. Image input also requires the dsh **attachment service**.
- **Switching to a text-only model in an image-bearing session is rejected by dsh itself** — a harness-level guard (`dsh-host-apiproxy`'s `selectModel`) refuses `model-unavailable` and cannot be relaxed from the plugin side. This bundle makes the message friendlier via its client half: it rewrites the rejection to *"当前会话已包含图片，而模型 \<model\> 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。"* (the error code and details pass through unchanged). Select a model the picker marks *`Image`*, remove the images first, or use an image-routing bundle (e.g. `@deepseek-ai/dsh-llm-image-routing`).
- **No `stop` sequences** (the wire format has none): requests carrying one throw `UNSUPPORTED_OPTION`.
- Reasoning blocks are **not replayed** into later turns (matches the official CLI); only tool calls with a paired tool result are replayed.
- The catalog endpoint is public; `/alpha/generate` requires your key.

## Permissions & privacy

This plugin operates entirely within your dsh profile and your Command Code account. **Local files**: reads `~/.commandcode/auth.json` only as a last-resort key fallback; reads/writes `~/.commandcode/models-cache.json`; reads your key from `$DSH_HOME/.credentials.yaml` via the standard credential seam (never logged). **Network**: `GET {apiBase}/provider/v1/models` (public catalog) and `POST {apiBase}/alpha/generate` (your requests, authenticated), the body including your configured `workingDir`. **No telemetry** — the only outbound host is the Command Code API (`api.commandcode.ai` by default, configurable via `apiBase`).

## Disabling / uninstalling

- **Disable** without removing: edit your profile's `cordis.patch.yml` and comment out (or remove) the `llm-commandcode` row, or set `disabled: true`, then restart.
- **Uninstall** completely:

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  This removes the bundle dependency and its layer; your API key in the dsh credential store and `~/.commandcode/auth.json` are left untouched.

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
