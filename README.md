# dsh-commandcode-provider

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
[![linux.do](https://linux.do/uploads/default/original/2X/8/8e6e2c0e0f8e0e0e0e0e0e0e0e0e0e0e0e0e0e0e.svg)](https://linux.do)

Unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin for **Command Code**, ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT). It registers a `commandcode` model provider whose requests are translated to Command Code's Provider API (`POST /alpha/generate`, reverse-engineered by the pi plugin, `command-code@1.15.1`).

> This is a community integration. You need your own Command Code account and API key or subscription, and Command Code's terms apply. This project is not affiliated with Command Code, Inc.

## What you get

- A **plugin bundle** installable into any dsh profile with `dsh plugin add` (npm package with a `dsh.bundle` layer).
- A **`commandcode` provider route** registered on the `llm` service, selectable in the model picker, with the **live model catalog** fetched from `GET {apiBase}/provider/v1/models` (cached at `~/.commandcode/models-cache.json`).
- A **Models-page card** ("Command Code") with an API-key field — credentials are stored through the dsh credentials service, same as the DeepSeek card.
- **API key resolution** in this order: `config.apiKey` → credential reference `apiKeyEnv` (the web Models page writes it, default `COMMANDCODE_API_KEY`) → the launching environment → the official Command Code CLI auth file (`~/.commandcode/auth.json`, written by `command-code login`).
- **Reasoning-effort support** for the models Command Code's catalog marks as such (e.g. `claude-opus-5`, `gpt-5.5`, `deepseek/deepseek-v4-pro`, …) via `KNOWN_EFFORTS`, matching the pi plugin's snapshot of `command-code@1.15.1`.

## Getting an API key

Command Code API keys never expire. The easiest path is the official CLI (Node.js 22+):

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux; native Windows: cmdc login
```

`cmd login` opens a browser to authenticate; on success the key is written to `~/.commandcode/auth.json` — this plugin picks it up automatically (last-resort fallback). Alternatively create an API key in the browser ([Command Code Studio](https://commandcode.ai/studio/auth/cli)) and paste it into the Models page card, or `export COMMANDCODE_API_KEY="user_..."`.

## Install

### From GitHub (recommended)

```sh
# Pin a release tag (recommended — readable and immutable)
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.1
# Or pin any exact commit by its SHA
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>
```

The `#<ref>` suffix pins the source to one exact revision (pnpm git-dependency syntax: a tag, branch, or commit SHA). Without it the install tracks the default branch, so a later push can silently change what you get — pin a tag or commit and audit the code you run.

A git install fetches **sources**, so the package's `prepare` script builds `lib/` after install. pnpm ≥10 blocks that script by default — run the `add`, then copy the **exact package key pnpm prints** into `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  'dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<full-commit-sha>': true
```

and re-run the `add`. Only allow packages whose source you trust (and pin a commit).

### From npm

Published as **`@mars-sea/dsh-commandcode-provider`** (the bare name `dsh-commandcode-provider` is taken on the npm registry by an unrelated package):

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### From a local checkout

```sh
npm install
npm run build                          # git-installed/tarball installs do this via `prepare` automatically
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

A local path install links the checkout as-is, so after changing `src/` re-run `npm run build` and restart the app.

### What the install does

`dsh plugin add` links the package into the profile, appends `dsh-commandcode-provider` to the profile's `dsh.profile.bundles`, and activates the `cordis.patch.yml` layer, which inserts:

```yaml
- insert:
    - id: llm-commandcode
      name: dsh-commandcode-provider
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

Verify the composed layer, then (re)start the web app:

```sh
dsh --profile web --dump-config          # shows a "# == dsh-commandcode-provider" layer
dsh web                                  # or restart your running instance
```

## Verify it works

After restart, in the web UI: **Settings → Models** shows a **Command Code** card; the model picker lists the live catalog under **commandcode** (54 models at the time of writing). Send a message with a model your plan includes — the default `deepseek/deepseek-v4-flash` works on entry-level plans; open-weight models (DeepSeek/Qwen/Kimi/MiniMax) generally do, while frontier models (Claude/GPT/Gemini/Grok) may require Pro/Max plans or on-demand usage (see FAQ).

## Configure

The Command Code card takes your API key (stored in `$DSH_HOME/.credentials.yaml`; the model catalog is browsable without one). Advanced knobs live in the `llm-commandcode` section of `$DSH_HOME/settings.yaml` (overrides the bundle defaults per request, no restart needed):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference resolved per request
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # reported to the API (project slug, config block)
  modelsCachePath: ~/.commandcode/models-cache.json
```

The composition-entry config (`cordis.patch.yml` / your profile `cordis.patch.yml`) accepts the same keys; a literal `apiKey` there takes precedence over the credential reference.

## Troubleshooting

- **`MODEL_NOT_IN_PLAN` (403)** — the selected model is not in your Command Code plan. Pick an open-weight model (e.g. `deepseek/deepseek-v4-flash`) or upgrade. The error names the model and links the official docs.
- **`MISSING_CREDENTIAL`** — no key anywhere. Store one via the Models page card, export `COMMANDCODE_API_KEY`, set `config.apiKey`, or run `command-code login`. The route stays registered and the catalog stays browsable without a key.
- **The Models page card shows "not configured" but requests work** — the key came from `~/.commandcode/auth.json` (the `cmd login` fallback), not the dsh credential store. Paste it into the card once to make the card show as configured; both coexist fine.
- **A reasoning model returns no visible text on short requests** — reasoning models (e.g. `deepseek/deepseek-v4-*`) consume output tokens on reasoning first; a small `maxTokens` can be exhausted before any visible text. This is normal.
- **`allowBuilds` errors on `dsh plugin add` from git** — copy the exact package key pnpm printed (with the commit hash) into `pnpm-workspace.yaml` and re-run (see [Install](#from-github-recommended)).

## Notes & limitations

- **Text-only for now**: image input throws `UNSUPPORTED_CONTENT` (wiring the attachment service to resolve image bytes is future work). The pi plugin's `MODEL_INPUT_MODALITIES` table is intentionally not claimed.
- **No `stop` sequences**: the wire format has no stop field; requests carrying one throw `UNSUPPORTED_OPTION`.
- Reasoning blocks are **not replayed** into later turns (matches the official CLI: prior private reasoning must not leak).
- Only tool calls with a paired tool result are replayed into the conversation.
- The model catalog endpoint is public; requests to `/alpha/generate` require the key above.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

## License

MIT — see [LICENSE](./LICENSE). Portions ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).
