# AGENTS.md

Instructions for AI coding agents working in this repository. Read the references relevant to the task,
including more than one when work spans subsystems; do not load the whole reference set by default. Confirm
mutable facts against current source, tests, and upstream evidence.

## Project

This is the unofficial `@mars-sea/dsh-commandcode-provider` bundle for DeepSeek Harness. It registers the
`commandcode` LLM route through `llm-commandcode` and ships `lib/`, `dsh.bundle` metadata, and
`cordis.patch.yml`. The detailed [repository map](docs/agent-reference/repository-map.md) is available when
you need to locate an unfamiliar module.

## Boundaries for every task

- Preserve unrelated tracked and untracked worktree changes. Keep changes focused on the request.
- Do not commit, tag, push, publish, or create a GitHub Release unless the user explicitly asks. The
  [release procedure](docs/agent-reference/releasing.md) applies only after that authorization.
- Do not reintroduce pi/OMP auth-file scanning. Preserve the API-key resolution order documented under
  [accounts and retry](docs/agent-reference/accounts-and-retry.md); keep literal keys secret and out of
  settings documents and diagnostics.
- Preserve the public exports from `src/index.ts` (`name`, `inject`, `Config`, `apply`) and the `dsh.bundle`
  manifest shape used by the Harness loader.
- Treat version counts, upstream behavior, and historical diagnoses in reference documents as evidence to
  verify against current source, tests, and upstream facts when relevant.

## Read the relevant reference

- Adapter, transport, streaming, image, tool-call, and error changes: [adapter and wire
  contracts](docs/agent-reference/adapter-protocol.md). The CLI `/alpha/generate` and OpenAI
  `/provider/v1/chat/completions` paths have different wire shapes; check both when a change can affect
  both.
- Credential rotation, web search, rate limits, and retry changes: [accounts and
  retry](docs/agent-reference/accounts-and-retry.md).
- Browser client, settings forms, login, TUI settings, and model selection changes: [client and
  settings](docs/agent-reference/client-and-settings.md).
- Usage Remote, price readout, and session-cost changes: [usage and
  cost](docs/agent-reference/usage-and-cost.md).
- Harness peer, package, settings-runtime, or bundle compatibility changes: [engine
  compatibility](docs/agent-reference/engine-compatibility.md).
- Catalog, plan tier, effort, deals, or peak-pricing updates: [model
  catalog](docs/agent-reference/model-catalog.md) and, when installed locally, the
  `dsh-commandcode-upstream` skill in `.agents/skills/`. For a DSH release upgrade, use the tracked
  `dsh-release-upgrade` skill, and record the result in the [DSH integration
  note](docs/对接说明.md) (four-category difference table plus verification boundaries).
- Publishing a version: [commands and release procedure](docs/agent-reference/releasing.md).

## Verification

- For source changes, run the affected tests, `npm run typecheck`, and `npm run build`; run `npm test` when
  changes cross modules or before a release. Update `tests/adapter.test.ts` when adapter behavior changes.
  Check generated `lib/` output when the published bundle changes.
- Run `npm run test:engine` when a Harness peer range, engine version, or engine-facing contract changes,
  and before publishing. Run `npm run test:install` after DSH peer metadata changes.
- For documentation-only changes, check links, references, and instruction consistency; a full code test
  suite is unnecessary unless the documentation change exposes a code-contract concern.
- Report tests that could not run and distinguish local checks from authenticated, deployed, or
  live-provider validation.
