# dsh-commandcode-provider

**English** | [简体中文](./README.zh-CN.md)

[![Awesome](https://awesome.re/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![GitHub Repo stars](https://img.shields.io/github/stars/Mars-Sea/dsh-commandcode-provider?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/stargazers)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/pulls)
[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

Unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin for **Command Code**, ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).

> This is a community integration. You need your own Command Code account and API key or subscription, and Command Code's terms apply. This project is not affiliated with Command Code, Inc.

## What you get

- **Plugin bundle** — install into any dsh profile with `dsh plugin add`; registers a `commandcode` provider route with a live model catalog.
- **Dedicated settings page** — API key, connection options, a live account-usage card, and a "Hide out-of-plan models" toggle.
- **Works in the terminal too** — the same install serves a [dsh-TUI](#terminal-ui-dsh-tui) profile, with its own **`/settings` → Command Code** page for the API key and the model controls.
- **Models-page key card** — the **Settings → Models → Command Code** card carries the key status, a paste field, and the sign-in button inline.
- **In-browser sign-in for keys** — start the official authorization flow (the same one `cmd login` runs) from the settings page; the approved key lands in the local credential service automatically. Manual paste remains the fallback.
- **Multi-account rotation** — when one account hits its usage limit, requests switch to the next account automatically. See [Account rotation](#account-rotation).
- **Flexible API key setup** — via the settings page, an environment variable, or the official CLI login file.
- **Model-picker annotations** — minimum plan, active deal or `FREE` badge, peak/off-peak state, image support, and context window; free models listed first.
- **Plan-aware picker** — models above your subscription tier are hidden by default (toggleable); an optional **Model allowlist** keeps only your favorites in the picker.
- **Reasoning-effort support** — models with selectable reasoning effort levels expose them in the picker.
- **Image input** — Vision-capable models accept images.
- **Plans & quota panel** — an optional Command Code card at the bottom of the sidebar (directly above Settings) shows the serving account's plan and its 5-hour and weekly windows; clicking it opens a dashboard with the billing period, both windows as progress bars with reset times, monthly credit consumption, and the purchased/free balances. The dashboard's **×** button hands the center column back to your conversation (the current session is untouched). **Off by default** — turn on *"Show the quota card in the sidebar"* under **Settings → Command Code → Advanced** to show it, and the same switch hides it again (a hidden card draws nothing at all and runs no background usage poll); the change lands as soon as you save. The panel follows your harness language (中文 / English) and needs dsh 0.1.5 (rc.1) or newer.
- **Session cost estimate** — published-rate estimates (`≈`) beside the composer token counter and in its usage dialog, using each request's model, request time and context tier from durable session history. Model switches and viewing the session later do not reprice earlier requests. Mixed-provider or unpriced usage shows a labeled subtotal (`≥`); missing history or wholly unpriceable usage stays hidden. These are estimates from the installed price snapshot, not provider invoices. Also English on every harness language.
- **Web search** — the dsh `web_search` tool is backed by the Command Code Provider API (`/alpha/web-search`) with the same key/endpoint as chat, so no separate search key or base URL is needed. See [Web search](#web-search).

See [Screenshots](#screenshots) below for what the UI looks like.

## Install

Pick the release line that matches your DeepSeek Harness version:

- **dsh 0.1.2-rc.1 or later** (the current 0.1.2 line — what `@latest` installs today):

  ```sh
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest
  ```

- **Older dsh releases** (the 0.5.0 line and earlier, which use the rc-era Host/browser APIs) — the last plugin version supporting them is 0.9.1, installed by exact version. That line is no longer under active maintenance:

  ```sh
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.9.1
  ```

> The `latest` tag points at the current 0.1.2-line plugin release. Users on the old 0.5.0-era Harness line must pin `@0.9.1` explicitly.

**pnpm 11 holds back new releases.** Its `minimumReleaseAge` defaults to 1440 minutes, so a version published less than a day ago is skipped and `@latest` resolves to the *previous* release — silently, with a success exit code. To install a release from the last 24 hours, name it exactly:

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.11.9
```

The same applies to every profile you install into, including the terminal UI below.

Fresh pnpm 10 marketplace generations are supported directly. Do not add a separate `@deepseek-ai/dsh-invariants` dependency; the plugin declares it as a Host peer so the active dsh profile remains the owner of Harness packages.

## Updating

Update with the same tag you installed with:

```sh
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@latest     # dsh 0.1.2-rc.1+
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@0.9.1      # older dsh (0.5.0 line, unmaintained)
```

Each profile updates separately — the terminal UI owns its own plugin list (see below):

```sh
dsh plugin --profile dsh-tui update @mars-sea/dsh-commandcode-provider@0.11.9
```

To move to a version published less than 24 hours ago, name it exactly as in Install above; pnpm 11's age gate resolves `@latest` to the previous release instead.

Then restart the web app.

## Getting an API key

The easiest path is the official CLI (Node.js 22+):

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux; native Windows: cmdc login
```

Or skip the CLI: click **Sign in to Command Code** under **Settings → Command Code** — your browser opens the commandcode.ai authorization page (the same flow `cmd login` uses) and the key is stored in the local credential service when you approve. You can still create a key on the [Keys settings page](https://commandcode.ai/mars-sea/settings/keys) and paste it into **Settings → Command Code**, or `export COMMANDCODE_API_KEY="user_..."`.

> The sign-in flow needs the Host and your browser on the same machine (loopback callback). With a remote Host, paste the key manually; a literal composition-level `apiKey`, if set, still takes precedence over a signed-in credential.

## Verify it works

After restart, enter your API key in **Settings → Command Code** and save; **Settings → Models** shows a **Command Code** card, and the model picker lists the live catalog under **commandcode**. Send a message with a model your plan includes.

## Terminal UI (dsh-TUI)

The plugin also works under a terminal front door. **Each dsh profile owns its own plugin list**, so the web install above does not reach the terminal — add the plugin to the `dsh-tui` profile as well:

```sh
dsh plugin --profile dsh-tui add @mars-sea/dsh-commandcode-provider@0.11.9
```

Pin the exact version here. For the first 24 hours after a release, a bare package name (or `@latest`) is silently resolved to the previous one: the install succeeds, but the profile gets the older build — which is how a fresh terminal install ends up with no **`/settings` → Command Code** page and no `commandcode` models at all.

Then pick the provider in the model selector, or name it directly:

```text
/model commandcode/deepseek/deepseek-v4.1-flash
```

`/model` lists every registered provider, with Command Code's live catalog and its plan/deal/context annotations. The `/commandcode` usage dashboard works there too.

**Entering the key.** The TUI has no web Models page, so the plugin declares its own page in the TUI settings screen — **`/settings` → Command Code** — with the API key, the API base, the out-of-plan model filter, the active account, and the command language. The key field is write-only: it shows whether a key is configured and writes what you type to the credential store, never to a settings document. The same page is the only place a TUI-only user needs to visit.

**Picking models.** That page lists the whole catalog as checkboxes, grouped by plan tier (Go → GOAT → Pro → Provider) with the free models first, so nothing has to be typed from memory. Everything starts checked, because an unset allowlist means "show every model" — uncheck the ones you do not want in the picker. The choice is stored as per-model overrides next to the `visibleModels` list the web page edits, so both surfaces can be used interchangeably and a plain `visibleModels` written by hand still works.

Alternatively, set the key outside the TUI — any of these work, in this order of precedence:

```sh
export COMMANDCODE_API_KEY="user_..."   # launching environment
cmd login                               # writes ~/.commandcode/auth.json
```

**Making Command Code the default.** dsh-TUI pins its own agent route, and its `agent-default-model` setting does not override it. To start every session on Command Code, override the `agent-loop` row in your profile patch (`$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`):

```yaml
- id: agent-loop
  inject: [tuiStartup]
  config:
    agents:
      - id: main
        provider: commandcode
        model: deepseek/deepseek-v4.1-flash
        reasoningEffort: max
        cwd: !!js process.cwd()
```

**Engine version.** The plugin needs a dsh engine that exports `ToolCallId` from `@deepseek-ai/dsh-llm` — **dsh 0.1.2-alpha.3 or later**. That includes the engine dsh-TUI recommends (0.1.2-rc.1) and every later release, but *not* the oldest engines its peer range nominally allows: on dsh 0.1.0-rc.6 or 0.1.1-rc.2 the plugin's module import fails and the TUI will not start. Upgrade the engine, or use the web profile.

## Usage dashboard

The plugin registers a `/commandcode` slash command showing per-account usage:

```text
/commandcode        (or /commandcode status)
```

The command's user-facing copy follows the shell's locale: explicit `lang: 'en' | 'zh'` in the `llm-commandcode` plugin config wins, otherwise `LC_ALL`/`LANG` is read, otherwise it falls back to `zh`. The web settings page is independent — it follows the browser's language preference on its own.

## Account rotation

With several Command Code subscriptions, the plugin **switches to the next account automatically** when one hits its usage limit:

- **Setup** — use the **Account rotation** card at Settings → **Command Code** to add accounts with a label and API key; the top-level key always serves first as the `default` account.
- **Manual switching** — the **Active account** dropdown pins a preferred account; if it is exhausted, requests fall back to other accounts and return once its window resets.
- **Route models to accounts** — the **Route models to accounts** card picks catalog models (multi-select, fetched from the live catalog) and routes them to an account. A request whose model is in a rule serves from that account while it is usable; an exhausted or invalid routed account falls back to the normal rotation. Rules match in list order — the first hit wins.
- **Show only favorite models** — the **Model allowlist** card keeps only the checked models in the model picker; unchecked shows all (the default).
- **Status** — the **Account usage** card and `/commandcode` report per-account state.

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
  modelAccountRules:                     # optional: route models to accounts (first match wins)
    - models:                            # catalog model ids (multi-select)
        - deepseek/deepseek-v4-pro
        - deepseek/deepseek-v4-flash-vision-exp
      account: COMMANDCODE_API_KEY_2
    - models:
        - tencent/hy4-preview
      account: default
  visibleModels:                       # optional: show only these models in pickers (catalog model ids); unset shows all
    - deepseek/deepseek-v4-pro
    - tencent/hy4-preview
```

## Configure

**Settings → Command Code** covers the API key, API base URL, working directory, and request/stream timeouts; once a key is saved, a live **Account usage** card appears at the top of the page. The **Advanced** card holds the toggles — hide out-of-plan models, serve web search with Command Code, and show the quota card in the sidebar (off by default).

The same options live in `$DSH_HOME/settings.yaml` (changes apply immediately, no restart):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # optional
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # default 60s
  streamIdleTimeoutMs: 300000      # default 300s
  showSidebarQuota: true           # optional: show the plans & quota card in the sidebar (default off)
```

## Web search

When your deployment's dsh shell mounts the web capability (`@deepseek-ai/dsh-web` + `@deepseek-ai/dsh-tool-web`), the model's `web_search` tool is served by this plugin's `commandcode` search provider — it calls the Command Code Provider API's `/alpha/web-search` endpoint with the **same API key and base URL** as chat. You do not configure a separate search key, endpoint, or model.

**On by default.** The plugin's **Settings → Command Code** page has a *"Serve dsh web search with Command Code"* toggle (`webSearch`, default on). When on, the plugin selects `commandcode` as the active search backend automatically; turn it off to hand the selection back to whichever backend was there before (a sibling search plugin such as modsearch keeps working — it is never forced back to dsh's shipped DeepSeek search). The toggle takes effect on the next search — no restart needed.

- The provider registers as `commandcode` on `ctx.web` only when the web service is present; without it this stays a chat-only plugin.
- The toggle works by selecting `commandcode` in the web seam at boot and on every settings change, remembering the backend it displaced; turning the toggle off (or unloading the plugin) restores that backend. If you'd rather pin it durably, set `searchProvider: commandcode` (or `$DSH_WEB_SEARCH_PROVIDER=commandcode`); that remains effective even if this plugin's runtime selection is unavailable.
- `numResults` from the dsh tool is clamped to the Command Code range (1–10, default 5); results map to the dsh `WebSearchSource` shape (`url`/`title`/`snippet`).

> This reuses the Command Code Provider API directly (like the official CLI's built-in `web_search`), so it is distinct from a DeepSeek-native search backend.

## Notes & limitations

- **Image input is model-gated** — only Vision models accept images; text-only models refuse them.
- Switching to a text-only model in an image-bearing session is rejected by dsh — pick a model marked *`Image`* or remove the images first.
- **Long image-heavy sessions keep working** — the provider caps the size of a single request (around 50 MB, and it is undocumented), so a session that accumulates many screenshots would otherwise start failing every request once it grew past that. The oldest images beyond the budget are replaced by a short "image omitted" note that names the attachment, the newest ones are sent as usual, and a request the provider still rejects as too large is retried once with a much smaller image budget before failing.
- **No `stop` sequences** — requests carrying one fail.
- Historical reasoning is replayed on both transports so a tool-calling loop keeps its chain of thought: `/provider/v1/chat/completions` passes it back as `reasoning_content`, and `/alpha/generate` carries it as a `reasoning` block inside the rebuilt assistant turn (the shape the official CLI sends) — a DeepSeek thinking-mode tool loop is rejected without it. Only tool calls with a paired tool result are replayed on either transport.
- Every tool's parameter schema is normalized to the object root the provider requires, so a tool declared without one (a third-party plugin's hand-written schema, an MCP server's own `inputSchema`, a generated root `$ref`) no longer fails the whole turn with `schema must be a JSON Schema of 'type: "object"'`.
- The model catalog is browsable without a key; chat requests need one.

## Permissions & privacy

The plugin only communicates between your local dsh profile and your Command Code account: locally it touches only the credential store and the models cache (plus `~/.commandcode/auth.json` as a last-resort fallback); on the network it calls only the Command Code API. No telemetry.

## Disabling / uninstalling

- **Disable** without removing: edit your profile's `cordis.patch.yml` and comment out (or remove) the `llm-commandcode` row, or set `disabled: true`, then restart.
- **Uninstall** completely:

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  Your API key in the dsh credential store and `~/.commandcode/auth.json` are left untouched.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

To try a local build in a profile:

```sh
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

After changing `src/`, re-run `npm run build` and restart the app.

## Community & feedback

- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="GitHub" /> [GitHub Repository](https://github.com/Mars-Sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="Releases" /> [GitHub Releases](https://github.com/Mars-Sea/dsh-commandcode-provider/releases)
- <img src="https://cdn.simpleicons.org/npm/111827" width="16" alt="npm" /> [npm Package](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/discourse/111827" width="16" alt="Linux.do" /> [Linux.do 社区](https://linux.do/)

## License

MIT — see [LICENSE](./LICENSE). Portions ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).

## Screenshots

**Model picker** — plan tier, deal/FREE, peak/off-peak, Image and context annotations:

<img src="assets/screenshots/model-picker.png" alt="Model picker with plan, deal, image and context annotations" width="320">

**Usage dashboard** — `/commandcode` per-account report:

<img src="assets/screenshots/usage-dashboard.png" alt="Usage dashboard" width="520">

**Settings page** — API key, connection knobs, account rotation and the live account-usage card:

<img src="assets/screenshots/settings-page.png" alt="Command Code settings page with the account usage card" width="640">
