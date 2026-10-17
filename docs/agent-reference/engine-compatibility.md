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
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`,
  `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit` (read out of the 0.2.1-alpha.4 engine, and
  re-read at every Harness peer bump: the list is unchanged from 0.2.1-alpha.3,
  0.2.1-alpha.2, 0.2.1-alpha.1, 0.2.0-rc.2 and
  0.1.7-rc.2; `zod` and `@tanstack/react-virtual` were already seeded but
  missing from this list until the alpha.4 audit) — so
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
  `dsh-client-ui-primitives` (verified on 0.2.1-alpha.1, 0.2.1-alpha.2, 0.2.1-alpha.3 and 0.2.1-alpha.4) declares NO dependencies at all, so
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
  both), and `0.2.1-alpha.2` pairs exactly the same two versions.
  `0.2.1-alpha.3` moves them to `cordis ~4.0.5-alpha.2` and
  `schemastery ~3.18.5-alpha.2`, which the declared `~4.0.5-alpha.1` /
  `~3.18.5-alpha.1` branches already admit (a tilde on `4.0.5-alpha.1` accepts
  `4.0.5-alpha.2`), so both declared ranges stay unchanged. `0.2.1-alpha.4`
  pairs **exactly the same two versions** — npm publishes no
  `dsh-0-2-1-alpha-4` dist-tag for either package because nothing moved — so
  both declared ranges stay unchanged there too, and the tilde pairing must
  still be re-read (not assumed) at every engine bump. `0.2.1-rc.2` pairs the
  first STABLE versions of both, `cordis ~4.0.5` and `schemastery ~3.18.5`
  (the alpha suffix is gone); the same tilde branches already admit them
  (`4.0.5 > 4.0.5-alpha.1` and `< 4.1.0`, likewise for `3.18.5`), so both
  declared ranges stay unchanged a third time. The lock file's six
  Cordis/Schemastery entries did move from `-alpha.2` to the stable versions:
  the development tree follows the engine pairing even when the declared range
  would tolerate the older prerelease. Leaving this
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
- **兼容范围：已验证的 RC 版本（最新 + 上一稳定）与一个 alpha 版本，向下兼容。**
  用户于 2026-10-11 确认维护一个 RC（候选发布版）与一个 alpha（早期测试版）；
  2026-10-18 用户进一步要求「本次兼容也要向下兼容」，因此不再按同通道替换删掉
  上一稳定 RC，而是保留三个已验证引擎：`0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-alpha.4`。
  核对事实：`0.2.0-rc.2` 是 npm `latest`（官方默认安装版本，仍覆盖大量用户，
  本轮为其补跑完整矩阵）；`0.2.1-rc.2` 是 0.2.1 线的候选发布版（npm `next`，
  2026-10-17 发布，标签 SHA `687f282e8625c6b8d11ff58211a90524be2e4317`）；
  `0.2.1-alpha.4` 是上一轮已验证的官方 alpha（2026-10-15 发布，标签 SHA
  `86a402200d95fecef4529d969836f1fe13c6cb0d`，其前身 `0.2.1-alpha.3` 的标签 SHA 为
  `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`）。npm `alpha` 标签此后已到
  `0.2.1-alpha.5`，该版本**尚未纳入验证**，待下一轮升级审计。
  **新增分支的准入规则**：必须先在该引擎上跑完整的 `test:engine`（链接、静态具名
  导入、种子审计、准入判定、设置契约、22 个流终态场景、网关与历史服务）与
  `test:install` 隔离安装，才能写进四处声明与 `dshReleases`；
  已退出当前兼容范围的是 `0.2.1-alpha.1` 至 `0.2.1-alpha.3`，其配置需升级引擎
  （或继续使用插件 0.13.4）。
  `@deepseek-ai/dsh-*` 的 `peerDependencies`、`devDependencies`、
  `dsh.compatibility.dsh`、`engines.dsh` 及锁文件同批同步，
  `dsh.compatibility.dshReleases` 只记录这三个版本。
  每个分支必须为裸版本号，不能用 `^`、`~` 或 `>=` 放行未验证的相邻版本。
  `tests/package.test.ts` 约束通道构成（至少一条 RC、恰好一条 alpha）与声明一致性；
  它不联网判断哪个版本最新，该事实由升级审计核对。两个配套的 Cordis、Schemastery
  范围仍按引擎配对维护。
  **自 `0.2.1-alpha.4` 起，宿主判定插件兼容性时只读 `engines.dsh`**
  （`apps/.../boot/app-boot/src/plugin-compatibility.ts` 的
  `unmetRequirements`）：只要包自带 `engines.dsh` 字符串，`@deepseek-ai/dsh*`
  的 `peerDependencies` 就**完全不参与**判定，只有缺少该字段时才回落到 peer
  规则；`engines.dsh` 写成 `workspace:` 一律判不兼容，`engines` 非对象或
  `engines.dsh` 非字符串会让清单不可读而被拒绝。四种声明因此必须逐字相同，
  而 `engines.dsh` 是唯一真正被宿主动的那一处：判定不通过时插件行被禁用、
  bundle 层被**静默跳过**（只有 stderr 一行 `skipping profile bundle`）、
  `dsh plugin add` 在 pnpm 之前直接拒绝。上游同批把拒绝记录
  `IncompatiblePlugin`／`PluginCompatibility` 的 `peers` 字段更名为
  `requirements`（按 engines 规则判时键为 `engines.dsh`）；本插件不读这两个
  结构，故只需同步文档。每条保留分支都须通过 `npm run test:engine` 与
  `npm run test:install`，后者覆盖不到准入判定，故 `test:engine` 增加
  `checkEngineAdmission` 直接调用该引擎自己的 `evaluatePluginCompatibility`。
  决策见[《决策记录》第八章第6、12条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。
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
  Since the alpha.4 audit it ALSO calls that engine's own
  `evaluatePluginCompatibility` on the published manifest
  (`checkEngineAdmission`), because none of the checks above can see the host's
  admission verdict: every one of them stages the bundle into the engine's peer
  tree, while since `0.2.1-alpha.4` that verdict reads `engines.dsh` alone and
  ignores the dsh peers. All-green here plus a refused install is precisely how
  the alpha.4 upgrade would otherwise have shipped broken. The rc.2 audit
  reused exactly that evidence path: before the declaration changed, this
  script on a real `0.2.1-rc.2` reported only
  `the host compatibility preflight REJECTS this plugin:
  {"engines.dsh":"0.2.0-rc.2 || 0.2.1-alpha.4"}` while every other check
  (link, named imports, seed audit, settings contract, 22 stream scenarios,
  gateway and history service) was already green — which is what proved the
  runtime change was limited to the web-search selection field.
  Being the only check with the engine's own peer tree, it is also where the
  Config schema is proven to drive that engine's settings forms (every field
  marked volatile, parsing to a live reference). Run it before publishing and
  whenever a peer range or an engine version changes.

## 一、账号开通的宿主验证

1. `npm run test:engine` 除加载发布包外，还使用真实 DSH 注册表与网关打开 `enrollmentWatch`，通过网关开始合成手动账号，取消流并确认写入收束后的账号及凭据补偿。设置与凭据使用内存替身；不读真实凭据、不访问真实上游。
2. 当前验证覆盖发布产物、严格描述符、网关接收器和流取消信号。浏览器 WebSocket（网页套接字）物理断连、真实 Studio（登录网站）授权及操作系统强杀仍需实际环境验证，不得由本地绿色检查推定。

## 二、流响应的宿主验证

1. `npm run test:engine` 使用真实 DSH 的 `LlmRuntime`（模型运行时）及 `BlockAssembler`（响应块装配器），对每个已声明引擎（`0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-alpha.4`）各跑一遍：加载发布产物并交付合成响应。22 个场景覆盖三协议成功、正文截断、纯思考达到上限、工具断流、正文及工具取消、最终标记后多余内容，以及 OpenAI 尾部错误；确认唯一终态、失败关联标识、最终用量和中断工具快照。
2. 宿主源码在失败或取消终态走请求错误分支，不进入工具执行；验证没有运行完整代理工具链。适配器本地锁和待读释放由回归测试覆盖；真实提供商异常、收费记录及远端连接实际关闭时间尚未实测。

3. 问题 #88 的标题用途通过两个已声明引擎的真实 `LlmRuntime`（模型运行时）传递到发布产物：CLI（命令行协议）与 OpenAI（开放接口协议）均发送 `off`（关闭思考），保留 64 词元预算并交付标题正文。提供商响应为合成数据；本轮 987 项本地测试、类型检查、构建及双引擎验证通过，不代表真实提供商标题质量或完整标题生成插件已验收。

## 三、测试夹具的引擎感知适配

1. `scripts/verify-engine-load.mjs` 的夹具（fixture，测试夹具）自 alpha.3 起按引擎能力探测装配，因为该版本引入两处必需项：`TypertGatewayService`（Typert 网关服务）的 `static inject` 新增 `remoteAccess`，缺这个服务网关就装配不起来（该服务由 alpha.3 新引入的包 `@deepseek-ai/dsh-api-remote-access` 提供，alpha.2 上不存在该包）；`InvokeRemoteRequest.peer` 由可选变必需，远端调用必须自带 Peer（对端）。
2. 适配方式是**探测**而不是按版本硬编码分支：先探测式加载 `@deepseek-ai/dsh-api-remote-access`（缺失即旧款引擎，跳过该注入），再探测式构造 owner Peer（alpha.2 的 `dsh-client-connection` 只有 `OperatorPeer`、没有 `Peer`，因此旧款返回 `undefined`，调用处据此决定要不要携带）。同一份夹具因此同时适配旧款与新款的已声明引擎。
3. **区分「运行时零改动」与「夹具适配」**：本轮 alpha.2 → alpha.3 的破坏性变化只落在测试采集脚本上，插件 `src/` 与 `lib/` 运行时未改一行即可工作；夹具的引擎感知改动只是让这套检查能在新引擎上走到被测代码，不代表插件运行时依赖了 alpha.3 的新接口。审计证据：`npm run typecheck`、948 项测试、`npm run build`、`npm run test:engine`（双引擎矩阵）与 `npm run test:install` 全部通过。
4. **alpha.4 轮次相反：夹具零改动，破坏点恰在本脚本的盲区。**`0.2.1-alpha.3` → `0.2.1-alpha.4` 中，本插件直接依赖的 14 个包 `src/` 逐字节未变（唯一有源码变化的 `@deepseek-ai/dsh-api-remotes` 是纯增量：新增 plugin-market 远端贡献，且该导入在发布产物里已被内联），Web 静态种子表与四个在用插槽的名字、owner props、outlet 渲染调用全部未变，因此既有夹具**一行未改**即全绿。真正的破坏落在宿主准入判定上（见本章前文）：`engines.dsh` 成为唯一判据后，旧声明在新引擎上会让 `test:engine` 全绿而真实安装、行加载与 bundle 装配三条路径全部被拒。处置一是替换 alpha 通道，二是补 `checkEngineAdmission`。红绿对照可复现：`--engine <alpha.4 安装树>` 通过，`--version 0.2.1-alpha.3` 被拒（该版已退出兼容范围）。

5. **rc.2 轮次：一处声明、一处代码，其余零改动。**`0.2.1-alpha.4` → `0.2.1-rc.2`（699 个变更路径、
   357 份包清单）中，插件直接导入的 17 个包只有 `@deepseek-ai/dsh-web` 的 `WebRuntime` 有实质变化：
   私有 `searchProviderId` 字段被删，选择改由构造注入的易变配置引用 `config.searchProvider` 承载
   （`z.string().volatile()`，`search()` 每次调用 `get()`）。旧写入给不存在的属性赋值不会抛错，因此
   失败是**静默**的——toggle 打开后搜索仍走原后端，关闭后无法恢复。`src/web-search.ts` 新增
   `selectionField()` 形状解析：有 `config` 自属性时用 cosmokit 的跨副本写协议
   `Symbol.for('cosmokit.volatile.write')` 替换引用值，否则沿用旧字段；引用不可写时保持
   「注册但未选中」。准入判定仍是 `engines.dsh` 唯一判据（`packages/boot/` 本轮零源码改动），
   所以声明必须同批更新。Web 静态种子表、五个在用插槽、`ui-slots` 与 `ui-settings-models` 全部零变化，
   夹具无需改动。验证：先在不改声明的 rc.2 上复现唯一失败项（准入），改声明后
   `test:engine` 在三个引擎（`0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-alpha.4`）上全绿——
   向下兼容是在用户要求后补入 `0.2.0-rc.2` 并重新跑完整矩阵的结果，不是口头声明。

## 四、自定义上下文长度的宿主验证

1. `checkContextWindowBudget()` 在每个已声明引擎上通过发布产物与真实 `LlmRuntime` 验证三协议的 12 个场景：调大、调小、保留公布输出上限、程序化小数回落；同时核对模型元数据、默认及显式请求的实际输出数和成功终态。全局与按模型小数均须由真实配置结构拒绝。
2. 网络响应与凭据仍为合成依赖；此检查不证明真实模型容量或浏览器交互质量。

