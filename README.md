# dsh-commandcode-provider

Unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin for **Command Code**, ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT). It registers a `commandcode` model provider whose requests are translated to Command Code's Provider API (`POST /alpha/generate`, reverse-engineered by the pi plugin, `command-code@1.15.1`).

> This is a community integration. You need your own Command Code account and API key or subscription, and Command Code's terms apply. This project is not affiliated with Command Code, Inc.

## What you get

- A **plugin bundle** installable into any dsh profile with `dsh plugin add` (npm package with a `dsh.bundle` layer).
- A **`commandcode` provider route** registered on the `llm` service, selectable in the model picker, with the **live model catalog** fetched from `GET {apiBase}/provider/v1/models` (cached at `~/.commandcode/models-cache.json`).
- A **Models-page card** ("Command Code") with an API-key field — credentials are stored through the dsh credentials service, same as the DeepSeek card.
- **API key resolution** in this order: `config.apiKey` → credential reference `apiKeyEnv` (the web Models page writes it, default `COMMANDCODE_API_KEY`) → the launching environment → the official Command Code CLI auth file (`~/.commandcode/auth.json`, written by `command-code login`). pi/OMP auth files are deliberately **not** scanned.
- **Reasoning-effort support** for the models Command Code's catalog marks as such (e.g. `claude-opus-5`, `gpt-5.5`, `deepseek/deepseek-v4-pro`, …) via `KNOWN_EFFORTS`, matching the pi plugin's snapshot of `command-code@1.15.1`.

## Install

From the directory containing this package (or with a path to it / a git URL / a published tarball):

```sh
# 1. Build first (local path installs link the checkout as-is; `prepare` runs
#    automatically for git/tarball installs).
npm install
npm run build

# 2. Install into your profile (the `web` profile is what `dsh web` boots).
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

That links the package into the profile, appends `dsh-commandcode-provider` to the profile's `dsh.profile.bundles`, and activates the `cordis.patch.yml` layer, which inserts:

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

### From a git host

`dsh plugin --profile web add github:you/dsh-commandcode-provider#<sha>` fetches **sources**, so the package's `prepare` script builds `lib/` after install. pnpm ≥10 blocks that script by default; allow it once in `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-commandcode-provider: true
```

then re-run the `add`. Only allow packages whose source you trust (and pin a commit).

## Configure

Open **Settings → Models**: the Command Code card takes your API key (stored in `$DSH_HOME/.credentials.yaml`). The model picker then lists the live Command Code catalog under **commandcode**.

Advanced knobs live in the `llm-commandcode` section of `$DSH_HOME/settings.yaml` (overrides the bundle defaults per request, no restart needed):

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference resolved per request
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # reported to the API (project slug, config block)
  modelsCachePath: ~/.commandcode/models-cache.json
```

The composition-entry config (`cordis.patch.yml` / your profile `cordis.patch.yml`) accepts the same keys; a literal `apiKey` there takes precedence over the credential reference.

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
