# Harness compatibility and installation

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **网关事实宿主回归**：`scripts/verify-engine-load.mjs` 使用真实插件入口、DSH 易变配置引用与更新函数、账号池及用量接收者，验证凭据等待和轮换期间切网关后旧调用及探测仍使用原地址，新调用使用新账号配置，用量报告只读取入口捕获的来源并展示恢复后的标记。网络响应和凭据为合成依赖，不证明真实网关或凭据持久化行为。

- **Isolated package install**: pnpm 10 auto-installs the package's DSH peers
  when a desktop marketplace prepares a fresh generation. Every Harness peer
  stays an explicit declaration matching the other Harness packages; otherwise
  pnpm reaches it only through `dsh-llm`, rewrites the prerelease range to an
  unsatisfiable stable range, and aborts with `ERR_PNPM_NO_MATCHING_VERSION`.
  Do not move them to
  `dependencies`: the active profile owns Harness packages. Run
  `npm run test:install` after changing DSH peer metadata; its assertion reads
  the declared `@deepseek-ai/dsh-llm` peer out of `package.json` rather than
  hardcoding it, so a peer that disappears upstream fails the check instead of
  silently passing on a stale expectation.
  **`@deepseek-ai/dsh-invariants` used to be one of these declarations and is
  gone since `0.2.1-alpha.1`**: upstream deleted the package outright (its
  `packages/runtime-diagnostics/invariants` tree no longer exists and npm never
  published a `0.2.1-alpha.1` of it, so copying the engine version across would
  404). This plugin never imported it, so the declaration is simply removed
  rather than replaced — see `scripts/verify-isolated-install.mjs`.
  **Client-only UI
  peers the Web frontend already seeds are the ONE exception, and they must stay
  optional AND stay in `devDependencies`** (PR #52). The shipped
  `dsh-web-frontend` hands every client bundle a `staticModules` table —
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit` (read out of the 0.2.1-alpha.2 engine, and
  re-read at every Harness peer bump: the list is unchanged from 0.2.1-alpha.1,
  0.2.0-rc.2 and
  0.1.7-rc.2) — so
  the three `require()` targets `lib/client.js` carries resolve in the webview
  with no installed copy, which is why `react`,
  `@deepseek-ai/dsh-client-ui-primitives` and
  `@deepseek-ai/dsh-client-ui-slots` are the only peers carrying
  `peerDependenciesMeta.optional: true`. That marking is not cosmetic: an older
  Desktop release validates the entire peer closure of every active plugin
  (`apps/desktop/src/profile-packages.ts`, which honours exactly this field) and
  its runtime tree ships host packages only, so a non-optional client-only peer
  is a hard startup failure there (`desktop profile: … requires missing …`);
  note that current DSH master no longer performs that walk, so the fix unblocks
  the released Desktop builds rather than the newest one. Every OTHER peer stays
  required — a `dsh.client` row is resolved and served by the Host, and a
  harness peer a fresh generation does not install is a bundle that cannot load.
  The second half is the trap the marking opens: **npm and pnpm auto-install only
  NON-optional peers**, so each optional name must also be a `devDependency` or
  the authortime tree silently loses it — `tests/client-boot.test.ts` imports
  the React component tree, so an absent `react` is a red `npm test`, and
  `dsh-client-ui-primitives` (verified on 0.2.1-alpha.1 and 0.2.1-alpha.2) declares NO dependencies at all, so
  nothing else would pull it in. Note that the same package's npm entry point
  imports `clsx`, `katex` and the shiki/mdast stack without declaring them
  (the ENGINE's own tree does not install them either): it is a seed module,
  resolvable only through a bundler, which is why `tests/_css-module-loader.mjs`
  serves a two-component stub for it and `tsc` still typechecks every call site
  against the package's `.d.ts`. `tests/package.test.ts` pins the exact
  optional set, that every optional name is a declared peer, and that it stays a
  development package.
- **`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` move WITH the engine,
  not independently.** Both are declared by every upstream Harness package as
  `workspace:~`, so publishing an engine rewrites them to the `~<version>` that
  shipped alongside it: `0.2.1-alpha.1` pairs `cordis ~4.0.5-alpha.1` and
  `schemastery ~3.18.5-alpha.1` (npm carries a `dsh-0-2-1-alpha-1` dist-tag for
  both), and `0.2.1-alpha.2` pairs exactly the same two versions. Leaving this
  plugin's previous `^4.0.2` / `~3.18.4` in place is an
  immediate `ERESOLVE`, not a silent mismatch: `dsh-agent@0.2.1-alpha.1` demands
  `cordis ~4.0.5-alpha.1` and `dsh-settings@0.2.1-alpha.1` demands
  `schemastery ~3.18.5-alpha.1`. A caret is doubly wrong here — it neither
  admits the `-alpha.1` prerelease nor excludes the neighbour.
  `react ^18.2.0` is unchanged by the bump and stays as it is.
  **多个引擎并存后，这两个包同样按配对写成析取**：`cordis` 为
  `~4.0.4 || ~4.0.5-alpha.1`，`schemastery` 为 `~3.18.4 || ~3.18.5-alpha.1`，
  每个分支与对应引擎同批发布。注意这两个名字**不**匹配 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 前缀，宿主 `evaluatePluginCompatibility` 根本不检查它们
  ——判定层只看 dsh 包，这两个只在 pnpm 解析层起作用：只写单引擎版本不会让安装被
  拒绝，却会在另一个引擎的 profile 里解析出冲突副本，所以两边必须同时覆盖。
  Note that npm's peer resolver reads the EXISTING `node_modules` tree, so a
  bump that should resolve cleanly still reports `ERESOLVE` against stale rc-era
  packages until the tree is rebuilt; `rm -rf node_modules` before judging a
  genuine conflict.
- **The Harness peer range names exactly the VERIFIED releases — no more, no
  fewer — and that is load-bearing.** 现行写法是三个精确版本的析取
  `0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2`。原 `^0.2.1-alpha.1` 会放行相邻预发布版及稳定
  补丁版，并不等于只支持已验证的版本。That exactness is the point: every branch
  is a bare version the release process actually ran `npm run test:engine`
  against, and a range that quietly admitted a neighbour is how a broken pairing
  stayed invisible (issue #43). A caret once pinned every peer to an engine four
  releases old, so a fresh generation installed a second, stale copy of the
  Harness beside the running engine instead of pairing with it; worse, it made
  `npm test` structurally blind to engine drift, because a `link:`-installed
  profile resolves the plugin's imports from the checkout rather than from the
  engine. 为什么要写成多个分支：`@deepseek-ai/dsh` 的 npm `latest` 一直停在
  `0.2.0-rc.2`（`alpha` 通道现在是 `0.2.1-alpha.2`，`0.2.1-alpha.1` 是它上一版），官方桌面端放出的也是 rc 版本，
  而宿主 `dsh-app-boot` 的 `evaluatePluginCompatibility` 会拿运行中的 dsh 版本逐条
  比对插件的每个 `@deepseek-ai/dsh*` peer，不匹配即抛
  `ManagementFailure('incompatible-version')` 拒绝安装——单个精确版本因此把绝大多数
  用户挡在门外（issue #77／#78）。析取写法是唯一同时满足两边的表达：它接纳三个已验证
  引擎，且**不**放行任何相邻版本（0.2.0-rc.1、0.2.1-alpha.3、0.2.1-rc.1、0.2.1、
  0.3.0-alpha.1 全部被拒）。已声明的引擎不随新版发布而移除：`0.2.1-alpha.1` 通过了矩阵验证，
  钉在它上面的 profile 不该因为上游又发了一个 alpha 就被挡在门外——只有确认无法继续适配时才从范围里删除。The supported range is written VERBATIM in
  `peerDependencies`, `devDependencies`, `dsh.compatibility.dsh` and `engines.dsh`,
  and `tests/package.test.ts` fails if those four drift apart, if any branch stops
  being a bare version, or if the branch set stops matching
  `dsh.compatibility.dshReleases` exactly. Move the range and those records
  together, and only once `npm run test:engine` passes against EVERY engine in the
  set — 脚本默认就是矩阵，逐个引擎跑完整套件，只验证其中一个等于把另一个
  「已声明兼容」的引擎放行却无人验证。
- **`npm run test:engine` is the only check that can see a bundle which cannot
  load on its engine** (issue #43): by default it resolves EVERY release the
  manifest declares compatible, installs each one and checks them in turn
  (`--engine <dir>` or `$DSH_ENGINE` narrows it to a single tree), copies this
  checkout's PUBLISHED surface into a tree whose peers ARE that engine's, and
  imports the bundle there. A `link:` install cannot substitute for it — the
  plugin's own module directory shadows the engine's, which is exactly how a
  removed export (`offloadRequestImagesWithPolicy` in 0.1.6) shipped green. It
  also audits every static named import against the engine's exports, the client
  bundle's `require()` calls against the platform seed table, the durable
  request-image offload contract the engine exports, and — by instantiating the
  staged adapter — the image pricing that engine's token meter will ask for.
  Being the only check with the engine's own peer tree, it is also where the
  Config schema is proven to drive that engine's settings forms (every field
  marked volatile, parsing to a live reference). Run it before publishing and
  whenever a peer range or an engine version changes.

## 一、账号开通的宿主验证

1. `npm run test:engine` 除加载发布包外，还使用真实 DSH 注册表与网关打开 `enrollmentWatch`，通过网关开始合成手动账号，取消流并确认写入收束后的账号及凭据补偿。设置与凭据使用内存替身；不读真实凭据、不访问真实上游。
2. 当前验证覆盖发布产物、严格描述符、网关接收器和流取消信号。浏览器 WebSocket（网页套接字）物理断连、真实 Studio（登录网站）授权及操作系统强杀仍需实际环境验证，不得由本地绿色检查推定。

## 二、流响应的宿主验证

1. `npm run test:engine` 使用真实 DSH 的 `LlmRuntime`（模型运行时）及 `BlockAssembler`（响应块装配器），对每个已声明引擎（`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`）各跑一遍：加载发布产物并交付合成响应。22 个场景覆盖三协议成功、正文截断、纯思考达到上限、工具断流、正文及工具取消、最终标记后多余内容，以及 OpenAI 尾部错误；确认唯一终态、失败关联标识、最终用量和中断工具快照。
2. 宿主源码在失败或取消终态走请求错误分支，不进入工具执行；验证没有运行完整代理工具链。适配器本地锁和待读释放由回归测试覆盖；真实提供商异常、收费记录及远端连接实际关闭时间尚未实测。
