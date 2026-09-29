# Commands and release procedure

Use the release procedure only when the user has explicitly requested a release. The authorization boundaries in the root `AGENTS.md` still apply.

## Commands

```sh
npm install             # devDeps incl. tsdown, tsx, typescript
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/**/*.test.ts
npm run test:install    # pack + install in a fresh pnpm 10.34.5 generation
npm run test:engine     # install the newest declared-compatible dsh and prove the bundle links there
npm run build           # tsdown -> lib/ (also runs via `prepare` on publish/git install)
npm pack --dry-run      # verify publish contents (must include lib/, cordis.patch.yml, README*, CHANGELOG, LICENSE)
```

## Release procedure

1. Edit `CHANGELOG.md` (Keep a Changelog format) for the new version.
2. `npm version patch|minor|major --no-git-tag-version` — bump without auto-tag.
3. `npm run typecheck && npm test && npm run build`.
4. `npm run test:engine` — installs the newest release `package.json` declares compatible and proves
   the built bundle LINKS and evaluates there. A stale local peer set cannot make this check
   (issue #43), so do not skip it when a peer range or an engine version moved.
5. Commit, then `npm publish` (requires the maintainer's 2FA OTP; the maintainer runs it, not the agent).
6. Tag and push: `git tag v<version> && git push && git push --tags`.
7. **Create a GitHub Release** for the tag (`gh release create v<version> --title "v<version>" --notes-file <file>`). The release notes must be **bilingual**: Simplified Chinese first (a `## 中文` section), then a `---` divider and the English translation of the same notes. **Style: short and user-facing** — one or two sentences per entry saying WHAT was added, changed, or fixed and what it means for the user; NEVER how (no file names, no internal function/mechanism names, no implementation or debugging narrative — the CHANGELOG carries the technical detail, the release notes are a summary of it). Releases — not tags or pushes — are what star followers see in their activity feed and get notified about; skipping this step makes the release invisible to users who starred the repo.
