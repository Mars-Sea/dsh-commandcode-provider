An unofficial [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) LLM provider plugin that adds **Command Code** as a `commandcode` route, with the live model catalog.

## What it adds

- **Live model catalog** — plan tier, deal / `FREE` badge, peak and off-peak windows, image support and context window in the model picker; free models first.
- **Multi-account rotation** — an exhausted account hands over to the next one; pin a preferred account or route models to dedicated ones.
- **Settings page** — accounts (keys, browser sign-in, live quota, dedicated models), model visibility, privacy switches and connection options.
- **Plans & quota panel** — optional sidebar card with the serving account's plan, 5-hour and weekly windows, balances and reset times.
- **Session cost estimate and model analysis** — an estimate (`≈`) beside the composer token counter, and a per-account usage report from `/commandcode`.
- **Web search and zero data retention** — the `web_search` tool is served by Command Code; optional ZDR routing (`x-cmd-zdr: 1`), off by default.

## Getting started

1. Install: `dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest`
2. Get an API key: click **Sign in to Command Code** on the settings page for the official authorization flow, paste a key created on the [Keys page](https://commandcode.ai/mars-sea/settings/keys), or `export COMMANDCODE_API_KEY="user_..."`.
3. Configure accounts and model visibility under **Settings → Command Code**; `/model` lists the annotated Command Code catalog.

## Notes

- You need your own Command Code account, API key or subscription, and must follow its terms of service. This project is not affiliated with Command Code, Inc.
- Requires Node.js **24.9+** and dsh `>=0.2.1-rc.2 <0.2.2-0` or `>=0.2.2-alpha.2 <0.2.3-0`.
- The plugin talks only to your Command Code account; no telemetry.
