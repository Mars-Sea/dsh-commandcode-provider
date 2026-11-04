---
name: dsh-release-upgrade
description: Audit and upgrade this plugin against an official DeepSeek Harness (dsh) release. Use when a new dsh tag/release is published, when peer ranges or dsh compatibility records need changing, or when a release may affect plugin services, client slots, settings, tools, or the LLM adapter. This skill is for DSH itself; use dsh-commandcode-upstream for Command Code CLI/catalog changes.
---

# DSH release upgrade audit

Use this skill for an **official DeepSeek Harness release**, not for the Command Code provider's own CLI/catalog. The target is usually a GitHub tag such as `dsh-v0.2.2-alpha.3`; the baseline is the newest verified record this repository still declares — currently `dsh.compatibility.dshReleases` holds six records: `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.2` and `0.2.2-alpha.3`, so the baseline depends on the target's channel (`0.2.1-rc.5` for the RC line, `0.2.2-alpha.3` for the alpha line) — read out of this repository's `package.json`.

## Scope and safety

- A check is read-only with respect to plugin files. The collector only clones public source into the requested output directory and reads public GitHub release metadata.
- Do not edit plugin files, change peer ranges, publish, or commit until the evidence has been reviewed and the user has authorized the update. Once authorized, keep the channel-range rule below.
- Never treat a successful clone or a local `node_modules` test as proof of engine compatibility. The real proof is `npm run test:engine` against the target engine.
- Do not run authenticated generation, paid probes, or credential-file scans as part of this skill.

## Collect the release delta

From the repository root:

```sh
python3 .agents/skills/dsh-release-upgrade/scripts/collect.py \
  --baseline dsh-v0.2.1-rc.3 \
  --target 'dsh-v<new-version>' \
  --out /tmp/dsh-release-audit-YYYYMMDD-XXXX
```

Always pass `--baseline <tag>` naming a release the current `package.json` still declares. Choose it by the channel the current declarations show — RC replaces RC, alpha replaces alpha — and when several releases are declared, compare against the newest verified one. Naming it explicitly keeps the comparison auditable; the collector's implicit baseline is the semver-newest `dshReleases` record, prints the choice to stderr, and refuses an empty record. When the previously verified release is no longer declared (for example a channel was dropped), collect a second delta from that last verified tag to isolate what this round actually changed. Add `--repo https://github.com/deepseek-ai/deepseek-harness` only when auditing a fork or mirror.

The output contains:

- `release.json` and `manifest.json`: target release metadata, tag SHAs, request URL, and collection errors;
- `changed-files.txt` and `diff.txt`: the complete public source delta;
- `package-delta.json`: changed published package manifests, versions, dependencies, and peer ranges;
- `imports.json`: package specifiers imported by this plugin's `src/` files;
- `report.txt`: changed packages and high-risk paths grouped for review;
- `source-baseline/` and `source-target/`: shallow public checkouts for manual inspection.

If the script exits 2 or records an error, the evidence is incomplete. Do not report “no breaking changes”; fix collection or obtain the missing source/tag first.

## Review checklist

1. **Engine identity and packaging.** Compare the target's `@deepseek-ai/dsh-*` package versions with every peer and development range, `dsh.compatibility.dsh`, `engines.dsh`, and the `dshReleases` records. **The maintenance policy is now a CHANNEL RANGE, not an enumerated version list** (decided 2026-10-24, record 16 in the decision log): `engines.dsh` declares `>=<oldest supported RC of the channel> <next minor>-0`, so every later RC of that channel is admitted without a plugin release while the next minor — its prereleases included — is refused. The declaration today is `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0` (two parallel branches added 2026-10-28 for the `0.2.2` alpha line, record 17). **The upper bound MUST carry `-0`**: semver orders `0.2.2-rc.1 < 0.2.2`, so `<0.2.2` would admit the next minor's RC, and `~0.2.1-rc.2` equals `>=0.2.1-rc.2 <0.3.0`; both were measured wrong with node semver. `dsh.compatibility.dshReleases` is a SEPARATE, narrower list: only releases that actually passed the full `test:engine`/`test:install` matrix (today the six releases listed above). Admission is decided by the range; the records are evidence and are the matrix source for both scripts. When a new release of the SAME channel appears, add its record only after verifying it — never widen the range into a new minor, never enumerate historical branches back in. When the next minor ships a release the user accepts, re-baseline: move the lower bound to that minor's first supported RC, the upper bound to the following minor's `-0`, and drop the records that no longer satisfy the range. Update all four declarations plus the lock together. Keep `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` paired with the retained engines — one `~` branch per shared pairing, an exact branch per differing prerelease pairing, never a caret, and never a `~` prerelease branch (`~4.0.5-alpha.1`) — it admits prereleases such as `4.0.5-alpha.2` that no retained engine pairs with. Today: the `0.2.1` RCs pair `4.0.5`/`3.18.5`, `0.2.2-alpha.2` pairs `4.0.6-alpha.1`/`3.18.6-alpha.1`, `0.2.2-alpha.3` pairs `4.0.6-alpha.2`/`3.18.6-alpha.2`, so the declarations are `~4.0.5 || 4.0.6-alpha.1 || 4.0.6-alpha.2` and `~3.18.5 || 3.18.6-alpha.1 || 3.18.6-alpha.2` (record 18). Never drop a branch for a release that is still in `dshReleases`; never use `includePrerelease:true` to judge peer satisfaction — npm/pnpm resolve peers with the default semantics. Keep `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-slots`, and `react` optional only while they are the client-seeded modules, and keep each optional peer in `devDependencies`.
2. **Host API/link surface.** Review changed files under `packages/llm/llm`, `packages/settings`, `packages/credentials`, `packages/commands`, `packages/web`, `packages/interaction`, `packages/tools`, and `packages/typert`. Compare every static named import in `lib/index.js` with the target engine's exports. `npm run test:engine` is mandatory after any peer bump because a missing named export is an ESM link-time failure.
3. **Client graph and slots.** Compare `src/client/index.ts`, `tsdown.config.ts`, the `dsh.client` manifest block, and the target Web shell's seed table. Check `settings.section`, `settings.models.provider-card`, `main`, `sidebar.footer.action`, and `conversation.composer.dock` declarations. The manifest `dsh.client.inject` list is a module graph, not the exported Cordis service list. The browser plugin's exported `inject` is intentionally only `slots`, `locale`, and `remote`; never add nested `remote.settings`, `remote.credentials`, or `remote.commandcode` services to it. Capture nested Remote namespaces through their own inject-scoped contexts.
4. **Settings.** Verify the rc.2 `SettingsForms`/`loader/volatile-update` contract: every Config field except the composition-only `apiKey` secret must be volatile, a settings write must be able to reach the running fiber, and the settings entry id must remain `llm-commandcode` so the one-time settings import cannot strand a section.
5. **LLM adapter and tools.** Diff `GenerateOptions`, `RequestMessage`, `ContentBlock`, `LlmError`, and model capability types. Exercise real engine constructors in `npm run test:engine`; a structural fake is insufficient. If the target adds dynamic tool updates, only advertise `toolUpdate` when the adapter can honor the selected mode. `addition-only` is valid when every request sends the complete active tool list and the adapter can safely ignore or encode `tool-addition` developer messages; do not claim `in-history` unless removal/update blocks are actually represented on the provider wire.
6. **Approval.** This plugin no longer answers approval requests — the opt-in AI command guard and its System One decision endpoint were removed, so the `approval` seam is not injected at all. Diff `approval/request` / `tools/pre-execute` only to confirm the plugin still stays out of that path, and confirm no reintroduced auto-approval answerer sneaks back in without an explicit, documented decision.
7. **Optional seams and persistence.** Recheck web-search registration/selection, TUI settings' structural seam, cost/session projections, image-offload contract, and any newly introduced schedule/account services. Optional features must not become hard client/host gates merely because the new engine ships them. **A selection or other mutable field that became a `Volatile` config reference must be written through the settings path** (the loader commits it in place), not by assigning an instance field: `0.2.1-rc.2` deleted `WebRuntime`'s private `searchProviderId`/`fetchProviderId`, and the previous field write kept succeeding while selecting nothing. On an engine that still carries that private field (`0.2.0-rc.2` and the 0.2.1 alphas) the instance field IS the seam, so the selector resolves the shape per observation and one build serves both — keep that dispatch when adding engines. Check `Volatile`-typed fields on every optional service, and remember that a shipped settings card may write the same field, so a runtime selector has to coordinate with that writer rather than assume it owns the value. A newly added adapter hook (for example `imageRequestTarget`) ships a default implementation; overriding it is required only when the adapter's own projection differs from that default.
8. **Build and published surface.** Run, in order: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:engine`, and `npm run test:install` when peer metadata changed. Inspect the built client `require()` calls against the target Web shell's static seed table.

## Applying an authorized update

- Verify the official npm dist-tags and GitHub release records. Update the range lower bound (only when the user accepts a new minor or the oldest supported RC moves), the `dshReleases` records, and the package lock together. Run the engine and isolated-install matrices over the retained release set — **every** retained release, never just one of them; local checks must use a development tree admitted by the new range. Keep Cordis and Schemastery paired with their engine release rather than guessing versions from the channel name.
- Adapt only changes proven necessary by the collected source delta and tests. Preserve the existing plugin architecture and security boundaries; do not add a second settings implementation, a new credential path, or a hard dependency for an optional service.
- Add focused tests for every changed contract. For a new engine capability, prefer a real `test:engine` fixture over a fake-only test.
- Update both READMEs and `CHANGELOG.md` when the supported engine or user-visible behavior changes. Bump the plugin version only as part of the authorized release work; do not publish automatically.
- Re-run the collector after the edit when a future DSH release is the next comparison baseline. The skill is intentionally repeatable: a new invocation with a new target is the whole upgrade audit.

## Reporting

The final report must include: baseline→target tags and SHAs, changed official packages, breaking API/type/event/slot findings, implemented changes, tests run with exit codes, features deliberately not adopted and why, and any evidence still missing. Distinguish “no observed break” from “fully proven compatible”.
