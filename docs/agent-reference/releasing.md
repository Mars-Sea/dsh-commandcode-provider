# Commands and release procedure

Use the release procedure only when the user has explicitly requested a release. The authorization boundaries in the root `AGENTS.md` still apply.

## Commands

```sh
npm install             # devDeps incl. tsdown, tsx, typescript
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/**/*.test.ts
npm run test:install    # per-engine matrix: one fresh pnpm 10.34.5 generation per declared dsh version
npm run test:engine     # install EVERY declared-compatible dsh in turn and prove the bundle links there
npm run build           # tsdown -> lib/ (also runs via `prepare` on publish/git install)
npm run test:pack       # verify all declared entries against actual packed files
npm pack --dry-run --ignore-scripts # verify publish contents (must include lib/, cordis.patch.yml, README*, CHANGELOG, LICENSE)
```

## Release procedure

1. Edit `CHANGELOG.md` (Keep a Changelog format) for the new version.
2. `npm version patch|minor|major --no-git-tag-version` — bump without auto-tag.
3. `npm run typecheck && npm test && npm run build`.
4. `npm run test:engine` — installs EVERY release `package.json` declares compatible, one after another,
   and proves the built bundle LINKS and evaluates on each. A stale local peer set cannot make this check
   (issue #43), so do not skip it when a peer range or an engine version moved, and do not narrow it to a
   single `--version` and call the range verified.
5. Commit, then `npm publish` (requires the maintainer's 2FA OTP; the maintainer runs it, not the agent).
6. Tag and push: `git tag v<version> && git push && git push --tags`.
7. **Create a GitHub Release** for the tag (`gh release create v<version> --title "v<version>" --notes-file <file>`). The release notes must be **bilingual**: Simplified Chinese first (a `## 中文` section), then a `---` divider and the English translation of the same notes. **Style: short and user-facing** — one or two sentences per entry saying WHAT was added, changed, or fixed and what it means for the user; NEVER how (no file names, no internal function/mechanism names, no implementation or debugging narrative — the CHANGELOG carries the technical detail, the release notes are a summary of it). Releases — not tags or pushes — are what star followers see in their activity feed and get notified about; skipping this step makes the release invisible to users who starred the repo.

## 持续集成门槛

2026-09-30 起，合并检查在类型、测试、构建和生成文件一致性之后，运行真实宿主加载
（`test:engine`）及隔离安装（`test:install`）；打包入口检查 `test:pack` 读取真实发布文件列表，校验条件和通配导出；不再声明缺失的源码子路径。
打包使用 `--ignore-scripts`，防止准备脚本
在一致性检查之后再次改写产物。这些检查需要 npm 网络，但不需要账户凭据或付费请求。
本地通过不能代替 GitHub 上的实际执行结果。
