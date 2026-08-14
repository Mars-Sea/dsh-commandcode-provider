# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-14

### Added

- Command Code LLM adapter for DeepSeek Harness, ported from pi-commandcode-provider@0.5.1 (MIT).
- `commandcode` provider route with a live model catalog (`GET /provider/v1/models`, ~54 models) and per-model reasoning-effort metadata (`KNOWN_EFFORTS`, command-code@1.15.1 snapshot).
- Models-page card ("Command Code") with an API-key field, backed by the dsh credential seam and the `llm-commandcode` settings namespace.
- API-key resolution: `config.apiKey` → credential reference `apiKeyEnv` (default `COMMANDCODE_API_KEY`) → launching environment → official CLI auth file (`~/.commandcode/auth.json`). pi/OMP auth files are not scanned.
- Installable dsh bundle (`dsh.bundle` manifest + `cordis.patch.yml` layer), supporting local-path, GitHub, and npm installs.
- `StreamChunk` protocol compliance: block assembly, usage-before-finish, tool-call replay for paired calls only, `LlmError` with stable codes, `attributionHeaders()` on all provider HTTP requests, `options.signal` honored.

### Known limitations

- Text-only input (image input throws `UNSUPPORTED_CONTENT`); no `stop` sequences; reasoning blocks are not replayed into later turns.
