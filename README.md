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
- **Models-page key card** — the **Settings → Models → Command Code** card carries the key status, a paste field, and the sign-in button inline.
- **In-browser sign-in for keys** — start the official authorization flow (the same one `cmd login` runs) from the settings page; the approved key lands in the local credential service automatically. Manual paste remains the fallback.
- **Multi-account rotation** — when one account hits its usage limit, requests switch to the next account automatically. See [Account rotation](#account-rotation).
- **Flexible API key setup** — via the settings page, an environment variable, or the official CLI login file.
- **Model-picker annotations** — minimum plan, active deal or `FREE` badge, peak/off-peak state, image support, and context window; free models listed first.
- **Plan-aware picker** — models above your subscription tier are hidden by default (toggleable).
- **Reasoning-effort support** — models with selectable reasoning effort levels expose them in the picker.
- **Image input** — Vision-capable models accept images.

See [Screenshots](#screenshots) below for what the UI looks like.

## Install

Pick the release line that matches your DeepSeek Harness version:

- **dsh 0.1.2-alpha.2 or later** (the current alpha line) — use the matching alpha plugin release. Install explicitly with the `alpha` tag:

  ```sh
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@alpha
  ```

- **Older dsh releases** (the 0.5.0 line and earlier, which use the rc-era Host/browser APIs) — the 0.9.1 plugin keeps working there and stays on the `latest` tag:

  ```sh
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest
  ```

> The `alpha` tag never moves `latest`: a plain `@latest` install always gets the newest stable release for older Harness versions, and upgrading to the alpha line is always an explicit opt-in.

Fresh pnpm 10 marketplace generations are supported directly. Do not add a separate `@deepseek-ai/dsh-invariants` dependency; the plugin declares it as a Host peer so the active dsh profile remains the owner of Harness packages.

## Updating

Update with the same tag you installed with:

```sh
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@alpha      # dsh 0.1.2-alpha.2+
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@latest     # older dsh (0.5.0 line)
```

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
```

## Configure

**Settings → Command Code** covers the API key, API base URL, working directory, and request/stream timeouts; once a key is saved, a live **Account usage** card appears at the top of the page.

The same options live in `$DSH_HOME/settings.yaml` (changes apply immediately, no restart):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # optional
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # default 60s
  streamIdleTimeoutMs: 300000      # default 300s
```

## Notes & limitations

- **Image input is model-gated** — only Vision models accept images; text-only models refuse them.
- Switching to a text-only model in an image-bearing session is rejected by dsh — pick a model marked *`Image`* or remove the images first.
- **No `stop` sequences** — requests carrying one fail.
- Reasoning blocks are not replayed into later turns; only tool calls with a paired tool result are replayed.
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
