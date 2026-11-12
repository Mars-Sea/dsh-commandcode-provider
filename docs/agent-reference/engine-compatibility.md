# Harness compatibility and installation

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **2026-11-12 补齐 `0.2.2-rc.2` 目标验证并登记兼容。** npm `next` 已更新到 rc.2（`latest` 仍 rc.1、`alpha` 仍 alpha.3），本机 `web` 引擎包也已为 rc.2。直接以 `--engine /Users/mars-sea/.nvm/versions/node/v24.22.3/lib/node_modules/@deepseek-ai/dsh` 检查实际安装树，退出码 0，新增三协议错误事实及原有全部引擎契约通过；目标单版本隔离安装退出码 0。全套 rc.2 依赖的隔离 `tsc --noEmit` 首次发现 6 处类型错误（此前只核对错误码变化，未覆盖整个目标类型图）：图标插槽补充声明缺少 `owner: { size: number; active: boolean }`、辅助请求用途默认注册表在纯适配器类型环境中为空。现已把插槽补充声明与官方形状对齐，适配器用 `Omit<GenerateOptions, 'purpose'> & { purpose?: string }` 转发调用用途，标题夹具按适配器入参类型校验；旧 `0.2.1-rc.3` 开发依赖与全套 rc.2 依赖类型检查均退出码 0。这两项是完整目标类型检查暴露的既有假设，不是本轮新增运行时分支。补入 `dshReleases['0.2.2-rc.2']='compatible'`，记录与矩阵为八条；本地完整测试 **1239/1239**、构建、完整八引擎矩阵和隔离安装均退出码 0，矩阵各 **8/8**，见[对接说明](../对接说明.md#四验证证据与边界)。兼容范围、peer、开发依赖、vendor 配对、Node 下界与插件版本不变；锁文件未序列化 `dsh` 记录且依赖声明未变，无需重解依赖。源差异仍为下条记录的 rc.1 `66491b05` → rc.2 `ddac9676`。核对安装版迁移指南后，附件错误、Session 批量追加、DeepSeek 搜索计费与桌面拖动区域无需额外插件迁移；`BundleInfo.updatable` 改为 `update` 属宿主接口，插件不读取该字段，文档口径已补充。未接入搜索元数据、凭据掩码、新代码块插槽等可选能力；尚未做浏览器、macOS Desktop 浮层交互或真实提供商生成验证。不提交、不发布。

- **2026-11-11 预适配 `0.2.2-rc.2`（历史阶段；次日补齐验证见上）。** 官方 GitHub prerelease 于北京时间 19:33 发布：基线 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）→ `dsh-v0.2.2-rc.2`（`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`），采集退出码 0，4,769 个路径／395 份清单，错误为空。rc.2 的 `LlmError` 构造参数收窄为内置错误码，新增 `fromFailure()` 承载服务商自定义码；插件新增 `src/llm-error.ts` 按方法存在性分派，覆盖共享错误分类、流响应请求号补全、模型目录错误与账号池的 `THROTTLED` 分支，保持所有原错误码、重试预算及持久化失败事实。设置源码、Web 选择易变字段、费用投影运行契约、六类既用插槽和 Web seed 表未发现必改；Menu 删除 `getAnchorRect`，插件未使用，CSS anchor 定位尚待浏览器验证。`addition-only` 工具投影修复由宿主完成，插件仍发送完整声明，不宣告 `in-history`。Cordis `4.1.0`／Schemastery `3.19.0` 未变，现有区间已准入 rc.2，**无需改 peer、开发依赖、锁文件或 Node 下界**。本地 `typecheck` 0，1236 项测试全通过；源码提取的错误类型隔离对照为修改前 8 处失败、修改后 0（不是完整目标类型检查）。构建退出码 0；新增的 `test:engine` 三协议错误事实探针在原七引擎各通过，完整引擎矩阵与隔离安装均退出码 0、**7/7**，见[对接说明](../对接说明.md#四验证证据与边界)。**当时验证缺口（已于 2026-11-12 补齐）**：官方 npm 的 `latest`／`next` 仍为 rc.1，rc.2 安装返回 `ETARGET`／`E404`，故 `dshReleases` 仍为七条，不能把本轮称为 rc.2 已验证兼容。`title`／`description` 搜索提供方元数据、`masked` 预览、新代码块插槽均不在本次兼容适配范围。未做真实账号生成、浏览器和目标隔离安装；证据在 `/tmp/dsh-release-audit-20261111-rc2/`，不随发布包分发。

- **2026-11-05 准入 `0.2.2-rc.1`（同通道，无运行代码改动）。** npm `next` 于 `2026-11-04T09:20:32Z` 发布 `0.2.2-rc.1`（`latest` 仍 `0.2.1-rc.5`、`alpha` 仍 `0.2.2-alpha.3`）；GitHub 轻量 tag `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，基线 `dsh-v0.2.2-alpha.3` 为 `05b1cae8`）为 prerelease，published `2026-11-04T13:07:14Z`，发布说明的对比区间是 `rc.5 → rc.1`。**源码 delta 只有清单文件**：387 个变更路径、387 份包清单**全部是 `package.json`、源文件 0 个**，采集错误为空；378 个 `@deepseek-ai/dsh-*` 包升到 rc.1，9 个 vendor 包换稳定号（`cordis 4.0.6-alpha.2 → 4.1.0`、`schemastery 3.18.6-alpha.2 → 3.19.0`、`cosmokit 1.8.7-alpha.2 → 1.9.0`、`loader`／`include`／`hmr`／`group`／`logger-console → 1.1.0`、`timer 1.1.8-alpha.2 → 1.2.0`），npm 产物逐文件比对显示这些 vendor **除 `package.json` 外完全相同**（代码本来就一样，只是换号）。**插件导入面零变化**：16 个宿主包源码变化 0 文件，已发布 `lib/` 与 `.d.ts` 除版本行外相同；五个既用插槽声明与 `packages/client/web/src/seed.ts` 在两个 tag 间 sha256 一致，`lib/client.js` 的 3 个 `require()` 仍全在预置模块表内。**声明**：区间本就放行 rc.1（semver 实测 `satisfies('0.2.2-rc.1', '>=0.2.2-alpha.2 <0.2.3-0') = true`），`engines.dsh`、`dsh.compatibility.dsh` 与 `engines.node` 均不改；rc.1 的宿主包把 `@deepseek-ai/cordis` 的 peer 声明与 `@deepseek-ai/schemastery` 的依赖声明换成 `~4.1.0`／`~3.19.0`，现行声明对这两个版本 `satisfies=false` 且 `semver.intersects` 为空（隔离安装仿真：npm `ERESOLVE` 失败、pnpm 带 peer 警告通过），故给两个 vendor 声明各追加 `|| ~4.1.0` / `|| ~3.19.0`（peer 与 `devDependencies` 各一处，共 4 行），`package-lock.json` 同批同步；**用 `~` 而不是精确值**，因为上游自身声明就是 `~4.1.0`／`~3.19.0`，精确值会拒绝上游允许的 4.1.x／3.19.x 补丁版本，写成 caret 又会放行 4.2.x／3.20.x 未验证邻居；旧 `~4.0.5`、`4.0.6-alpha.1`、`4.0.6-alpha.2` 与 `~3.18.5`、`3.18.6-alpha.1`、`3.18.6-alpha.2` 分支全部保留——`0.2.1` 的 RC、alpha.2、alpha.3 仍在记录里，补分支后它们仍解析 `4.0.5`／`4.0.6-alpha.2` 旧配对（隔离安装锁文件实测）。`dsh.compatibility.dshReleases` 补入 `0.2.2-rc.1`（**七条**），`tests/package.test.ts` 的清单断言 6 → 7。**发布说明的新能力在基线里已存在**：对比区间是 `rc.5 → rc.1`，所列 0.2.2 能力（移动端适配、引用插入、Markdown 导出、插件更新与回滚、`apply_patch`、变更请求与工作树、Session API、PTC 改造、统一右键菜单、`settings.section.icon` 等）在 alpha.3 已存在，本轮 delta 内没有新能力缺口；与插件相关的只有既有的设置页导航图标，v0.17.0 已接入。**迁移项**：release notes 的迁移提示逐条核对后插件均未触及——Session Projection 异步注册属 deprecated 兼容路径，插件仍用同步 `ctx.effect(() => register(...))`，本轮实测可用，是否迁移单独立项；`tools.resolve`／`executable` 与提示词组装、`tools.mode`／`DSH_TOOLS_MODE`、`agent/request` 改路由、`dsh-official-bundles` 导入、SDK／PTC／SSH 协议升级插件都不使用。**验证**：`node scripts/verify-engine-load.mjs --version 0.2.2-rc.1` 退出码 0（宿主准入 preflight、静态具名导入审计、client `require()` 与预置模块表、Config volatile、工具历史、费用投影、三协议 22 场景、上下文 12 场景），末行 `engine-load smoke passed against dsh 0.2.2-rc.1`；补记录后 `test:engine` 与 `test:install` 覆盖 **7/7**，末行分别为 `engine-load smoke passed on all 7 declared-compatible engines (0.2.1-rc.2, 0.2.1-rc.3, 0.2.1-rc.4, 0.2.1-rc.5, 0.2.2-alpha.2, 0.2.2-alpha.3, 0.2.2-rc.1)` 与 `engine matrix verified: 0.2.1-rc.2, …, 0.2.2-rc.1`，退出码均为 0。**证据边界**：引擎加载级与隔离安装级验证通过不等于完整运行验证；未做真实账号登录、付费生成与浏览器渲染；16 个宿主包运行时 diff 未逐行通读（按已发布产物比对，插槽与预置表按 sha256）；证据在 `/tmp/dsh-release-audit-20261105-rc1`（含两棵浅克隆树）与 `/tmp/dsh-release-audit-20261105-evidence`，不随插件发布。完整清单见[对接说明](../对接说明.md)第一章第 8 条。


- **2026-11-03 准入 `0.2.2-alpha.3`（同通道，无运行代码改动；用户拍板「全部落地」）。** npm `alpha` 于 `2026-11-03T07:56:48Z` 发布 `0.2.2-alpha.3`（`latest`／`next` 仍 `0.2.1-rc.5`），GitHub tag `dsh-v0.2.2-alpha.3`（`05b1cae8`，基线 `dsh-v0.2.2-alpha.2` 为 `f3803c96`）与发布说明齐备。源码 delta 采集到 **2315 个变更路径、387 份包清单，采集错误为空**。**插件导入的 16 个宿主包只有 4 个源文件变化，均非破坏**：`dsh-llm/src/types.ts` 的 `GenerateOptions` 加 `Purpose` 泛型（`abstract stream` 签名逐字未变）、`dsh-settings/src/index.ts` 的 `configure()` 内部改读 `owner.ctx.fiber`、`dsh-session-projection/src/index.ts` 新增 `onEventChanged` 与「释放后保留最后 cell」语义（插件用同步 `ctx.effect` 注册且不读 `stateOf`）、`dsh-commands/src/builtin.ts` 新增第一方命令身份（精确名优先，与 `commandcode`／`llm-commandcode` 无冲突）；`dsh-web`／`dsh-attachment`／`dsh-typert-protocol`／`dsh-api-remotes` 等源码零改动。**vendor 配对升到 `cordis 4.0.6-alpha.2`／`schemastery 3.18.6-alpha.2`**：cordis 自身有 4 类对第三方插件的破坏性变化（`fiber.store` 移除、`fiber._config` 移除且 `fiber.config` 变为原始输入、`internal/update`／`internal/config` 改签名、`LoggerLevel` 数值互换），插件逐符号 grep 零使用；schemastery／cosmokit 源码零改动，volatile 链路完整；`include` 重写要求 insert 行有显式 id，插件 bundle 行已是 `llm-commandcode`。**客户端面零必改**：五个既用插槽与 owner props、`ConfigForms` 契约、Web 预置模块表、`Menu`／`StateDot`／`Button`／`Switch`／`locale.register` 全部未变；新增的 `settings.section.icon`、`contextMenu.*` 等可选插槽与插件 id 无冲突；三处行为 delta（窄屏 `selectPanel` 收起抽屉、`main` 外包 `.mainPanel`、Menu 定位重写与 dock 最小高度）不破坏插件。**声明**：区间本就放行 alpha.3（准入函数未变），只把 vendor 精确析取追加 `|| 4.0.6-alpha.2` / `|| 3.18.6-alpha.2`（原第二分支是精确等值，semver 实测 `satisfies=false`；`alpha.1` 分支必须保留）并补 `dshReleases` 记录。**验证**：`verify-engine-load --version 0.2.2-alpha.3` 退出码 0、`typecheck` 0、`npm test` 全绿（0 失败）；补记录后 `test:engine` 与 `test:install` 覆盖 6/6 引擎。**未采纳**：设置页导航图标、右键菜单扩展、插件安装失败诊断（均属可选能力）。**真实宿主复核（2026-11-03 21:00）**：本机宿主已切到 `0.2.2-alpha.3`，`verify-engine-load --engine <全局 dsh 安装>`（直指运行中的引擎）退出码 0，且同一宿主上本会话以真实账号经 `commandcode` 路由完成 123 次生成（升级后）。**证据边界**：浏览器渲染与设置页/导航图标视觉未验证；`0.2.1` 各 RC 的 vendor 配对按 `~4.0.5` 分支推断；证据在 `/tmp/dsh-release-audit-20261103-alpha3`，不随插件发布。完整清单见[对接说明](../对接说明.md)第一章第 7 条与[《决策记录》第八章第 18 条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。

- **2026-10-30 核验并准入 `0.2.1-rc.5`（同通道，无代码改动）**：npm `latest`／`next` 从 `0.2.1-rc.4` 前进到 `0.2.1-rc.5`（`0.2.2-alpha.2` 仍是 `alpha`），GitHub tag `dsh-v0.2.1-rc.5`（`b830ec95`，基线 `dsh-v0.2.1-rc.4` 为 `504a01a9`）与发布说明齐备，发布说明只有一条社区改进「优化对话中思考内容的展示」。源码 delta 采集到 **368 个变更路径、349 份包清单，采集错误为空**：349 份包清单**只有版本号**变化，依赖与 peer 区间零变化，`cordis 4.0.5`／`schemastery 3.18.5` 配对不变；19 个非清单文件全部集中在推理展示——`client/ui-chat` 新增 `reasoning-text.ts`（剥掉 `<signature>` 前缀）、`ReasoningBodyOwnerProps` 新增 `rawText`（`text` 改为显示文本）并更新 slot 文档与测试，`experimental/client-ui-cot-translation` 跟随适配，`extensions/cordis-client-runner` 的 slot 目录只更新行号与文案，另有一条 Web e2e 测试与新增的推理 Body Slot 升级指南。**唯一破坏面**是 `conversation.chat.reasoning.body` 单占插槽的 owner props；插件不使用该插槽（只声明 `settings.section`、`settings.models.provider-card`、`main`、`sidebar.footer.action`、`conversation.composer.dock`，五个在 rc.5 的 slot 目录里都在）。插件导入的 16 个宿主包只有版本号变化，`ui-primitives` 的 `Switch` 样式与签名未变（0.16.1 的开关修复不受影响）。**验证**：`node scripts/verify-engine-load.mjs --version 0.2.1-rc.5` 通过（准入 preflight、`lib/index.js` 静态导入审计、`lib/client.js` 的 `require()` 与 Web 预置模块表核对、Config volatile、工具历史、enrollment、费用投影、模型运行时 22+12 个场景、图片卸载契约）；`dshReleases` 补入 rc.5 后 `test:engine` 与 `test:install` 均 **5/5**。**证据边界**：引擎加载级验证通过不等于完整运行验证；未做真实账号登录、付费生成与浏览器渲染；证据在 `/tmp/dsh-release-audit-20261030-rc5`（不随插件发布）。

- **2026-10-28 适配 `0.2.2-alpha.2`：并行准入 `0.2.2` 通道，Node 下界抬到 `24.9`（本轮，用户拍板 1A／2A／3B）**：npm `alpha` 发布 `0.2.2-alpha.2`（`2026-10-27T19:10:28Z`；`next` 仍 `0.2.1-rc.4`），GitHub tag `dsh-v0.2.2-alpha.2`（`f3803c96`）与发布说明随后出现，源码 delta 可采（7275 个变更路径、388 份包清单，采集错误为空）。**声明**：`engines.dsh`、`dsh.compatibility.dsh` 与 34 个 `@deepseek-ai/dsh-*` peer／开发依赖改为 `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`；`cordis`／`schemastery` 用精确析取 `~4.0.5 || 4.0.6-alpha.1` / `~3.18.5 || 3.18.6-alpha.1`；`engines.node` 由 `>=22` 抬到 `>=24.9`；`dshReleases` 补入 `0.2.2-alpha.2`（四条记录，两个矩阵均 4/4）；CI 三个 workflow 的 Node 升到 `24.9.0`（`publish.yml` 已单独固定 `npm@11.21.0`，发布链不受影响）。**为什么两个分支**：`0.2.1` 的预发布是 `-rc.N`、`0.2.2` 的是 `-alpha.N`，序列不相交，一个区间表达不了；上界推到 `0.3.0-0` 会连两代之间的空档一起放行。**为什么配对用精确版本**：`~4.0.6-alpha.1` 会放行 `4.0.6-alpha.2` 这类没有引擎配对的版本。**为什么 Node 必须抬**：`@deepseek-ai/dsh@0.2.2-alpha.2` 自己声明 `engines.node >=24.9.0`，插件准入它就不能让整包下界低于该引擎能启动的水位；代价是 Node 22/23 用户失去支持，即使在跑仍兼容 Node 22 的 `0.2.1` RC 引擎（`engines.node` 是整包唯一下界，无法按引擎分支）。升级说明见两份 README 的独立小节与 `CHANGELOG.md`。**运行契约**：插件导入的 16 个宿主包无破坏性变化（`LlmModelInfo.badge`／`llm/models-updated`、`WebSearchProvider.ready?()`／`searchReady()`／`fetchReady()`、`WebSource.summary`、`MessageSourceMap`／`PrincipalMap` 新成员均为加性；`TypertResourceDeclaration` 联合类型化但插件不使用）；`sessionProjections.register()` 运行时值改为可调用的 thenable，同步 `ctx.effect` 写法保留兼容、`stateOf` 才弃用，插件的 `installCostProjection` 属前者且不读 `stateOf`，**代码零改动**；唯一需适配的是 `session/created` 通知前会话只读，`scripts/verify-engine-load.mjs` 的分析历史夹具改用 `enter()` + `announce()`，并新增费用投影探针补上该路径的真实引擎覆盖。**未采纳**：`badge`／`llm/models-updated` 接入选择器、`ready()` 与 `summary`（均需单独拍板）。**官方迁移提示逐条核对（2026-10-28 复查）**：release notes 的 6 条插件迁移项全部未触及——同步投影注册（官方保留兼容）、Cordis Timer（插件用自己的原生 `setTimeout` 包装）、`agent/request` 改路由（插件只监听 `agent/request-error`）、`tools.resolve`／`executable`（不注册工具）、`tools.mode`／`DSH_TOOLS_MODE`（不读取）、`app-boot` 导入（不导入）。「未声明容量默认 1M/128K」只影响 `llm-pi-ai` provider，插件经 `resolveModel` 显式宣告容量；`compaction-basic` 的缺少 context 硬错误在两版相同。**类型层面补验**：另建隔离树装 alpha.2 全部宿主包，对 `src`／`tests`／`tsdown.config.ts` 跑 `tsc --noEmit` **退出码 0**——`import type` 的漂移不会被 `test:engine` 发现，这条补上了该盲区。**证据边界**：`dsh-agent` 运行时 diff 未逐行审阅；`primitives`／`client-locale` 只核对插件所用符号；`dsh-settings` 与新 cordis 的成套性是从源码读出的推断，未做混搭实测；未做真实账号登录、付费生成与浏览器渲染。完整清单与理由见[对接说明](../对接说明.md)第一章第 5 条与[《决策记录》第八章第 17 条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。

- **2026-10-27 rc.4 产物级核验（上一轮）**：npm `next` 于 `2026-10-26T15:28:13Z` 从 `0.2.1-rc.3` 前进到 `0.2.1-rc.4`（`latest` 仍 `0.2.1-rc.2`）；GitHub 侧没有 `dsh-v0.2.1-rc.4` 的 tag/release（均 404）、`master` 最后推送停在 10-23（rc.3）、产物内构建哈希 `ec17a2c` 在公开仓库查不到——官方没有发布说明，因此无法采集源码 delta，只能做 npm 产物级比对。**235 个双版本包逐文件哈希比对**：228 个仅有 `package.json` 版本号变化；实质变化 4 处且都与插件无关——`dsh-mcp-client` 在服务器未声明 `resources` 能力时直接返回空列表（`dsh-mcp-resources` 文档同步）、`dsh-client-ui-conversation` 的 View 标签提示框改为按字符宽度估算且仅溢出时显示（移除「更多会话视图 · {name}」）文案、`dsh-llm-deepseek-account` 的一条日志级别（`console.info` → `console.error`）；另有 3 个包仅构建元数据变化（`dsh-client-modules`、`dsh-client-ui-sidebar`、`dsh-client-ui-settings-account`）。插件导入的宿主包（`llm`／`settings`／`credentials`／`client-ui-settings`／`client-ui-primitives`／`client-ui-slots`／`client-ui-renderer`／`client-locale`／`web`／`typert`／`api-remotes`／`attachment`／`commands`／`timeout`／`launch-environment`／`app-boot`）与五个既用插槽声明均零变化。**`dsh.compatibility.dshReleases` 补入 `0.2.1-rc.4`**：矩阵来源变为 3 个引擎（`0.2.1-rc.2`／`rc.3`／`rc.4`），`test:engine` 与 `test:install` 均 3/3 通过。**证据边界**：无公开源码与发布说明，结论来自 npm 产物；未做真实账号登录、付费生成与浏览器渲染。**后续（2026-10-28）**：GitHub 补发了 `dsh-v0.2.1-rc.4` 的 tag（`504a01a9`）与 release 说明（内容仅一条「修复 ACP 模式下诊断输出混入 stdout」，与插件无关），源码 delta 已可采：**369 个变更路径、349 份包清单、采集错误为空，插件导入的 16 个宿主包非测试源码零变更**（只有 `package.json` 版本号变化），与上述产物级结论一致。

- **2026-10-24 rc.3 升级核验（上一轮）**：本地 dsh 升到 `0.2.1-rc.3` 后插件被宿主禁用、bundle 静默跳过、安装被拒——根因是 `engines.dsh` 仍停在 `0.2.0-rc.2 || 0.2.1-rc.2`，而自 `0.2.1-alpha.4` 起准入只读该字段。**同批把声明形态从「裸版本析取」换成「同通道区间」**（用户 2026-10-24 拍板）：`engines.dsh`、`dsh.compatibility.dsh` 与 15 个 peer／19 个开发依赖统一为 `>=0.2.1-rc.2 <0.2.2-0` —— 同 `0.2.1` 通道 `0.2.1-rc.2` 及以后的每个 RC（含未来的 `rc.4`）直接准入，下一个 minor 的预发布（`0.2.2-rc.*`）与正式版都被排除。**上界必须写 `<0.2.2-0`**：按 semver 优先级 `0.2.2-rc.1 < 0.2.2`，写成 `<0.2.2` 反而会放行下一个 minor 的 RC（node semver 实测），`~0.2.1-rc.2` 等价于 `>=0.2.1-rc.2 <0.3.0`，同样错。`dsh.compatibility.dshReleases` 保持**两条实测记录** `0.2.1-rc.2` 与 `0.2.1-rc.3`（2026-10-27 补入 `rc.4` 后为三条，见上一条）：准入由区间负责，记录只列跑过完整引擎矩阵的版本，并充当 `test:engine`／`test:install` 的矩阵来源。**rc.3 相对 rc.2 零破坏**：采集 646 个变更路径、349 份包清单、采集错误为空；宿主准入语义（`packages/boot/app-boot/src/plugin-compatibility.ts`）与 Web 预置模块表（`packages/client/web/src/seed.ts`）逐字相同；插件导入的宿主包（`llm`／`settings`／`credentials`／`web`／`typert`／`api`／`boot`／`attachment`／`session-projection`／`timeout`／`launch-environment`）源码零变更（只有版本号与 README 改动）；五个既用插槽全部保留——rc.3 只**新增** `sidebar.panellist.actions`、`conversation.session.header.views.actions`、`sidebar.right.tab.guide.actions` 三个 list 类插槽（由官方 `ui-entry-customization` 注册），与插件无冲突；`dsh-client-ui-primitives` 导出符号集合逐个相同。**同批删除旧引擎形状**：`0.2.0-rc.2` 已退出 npm `latest`（2026-10-24 实测 `latest=0.2.1-rc.2`、`next=0.2.1-rc.3`、`alpha=0.2.1-alpha.5`），区间下界之上不再有 pre-rc.2 引擎，`src/web-search.ts` 的 `legacySearchField` 实例字段分派与 `tests/web-search.test.ts` 的四个旧形状用例一并删除，只留易变引用路径与「没有可写选择面时不抛错」的降级契约测试。**Cordis/Schemastery 收敛为单分支 `~4.0.5` / `~3.18.5`**：rc.2 与 rc.3 的 vendor 实测都是这两个正式版，两引擎配对相同（判据见下文「写法随支持矩阵走」）。决策见[《决策记录》第八章第16条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。**证据边界（历史表述）**：区间允许 `0.2.1-rc.4` 在不更新插件的情况下准入，当时它未经 `test:engine`／`test:install`、`dshReleases` 也无记录（读作 unknown）——这是「信任同 minor 的 RC 向后兼容」的明确取舍；2026-10-27 已补入记录并通过 3/3 矩阵（见上一条）。`0.2.2` 的正式版发布后仍需新一轮声明。

- **2026-10-18 兼容声明反转（历史轮次，已被 2026-10-24 的范围化替代；结论仍解释当时的析取式）**：矩阵由上一轮的单一 `0.2.1-rc.2` 改回**两个已验证引擎 `0.2.0-rc.2 || 0.2.1-rc.2`**——`dsh.compatibility.dshReleases` 两条记录（**两条都是 RC，没有 alpha 通道**），`dsh.compatibility.dsh`、`engines.dsh` 与 15 个 peer／19 个开发依赖同为裸版本析取式；`@deepseek-ai/cordis`／`@deepseek-ai/schemastery` 按多引擎规则恢复为按引擎配对的析取式 `~4.0.4 || ~4.0.5`／`~3.18.4 || ~3.18.5`（判据见下文「写法随支持矩阵走」）。**判据**：官方 npm `latest` 至今仍是 `0.2.0-rc.2`（2026-10-18 复核，`0.2.1-rc.2` 在 `next`），而宿主准入只读 `engines.dsh`，只声明 rc.2 会让走默认安装路径的用户被拒（下文的三条后果）。**同一轮补上旧引擎的写入形状**：`createCommandCodeSearchSelection()` 按每次观察到的形状分派——rc.2 走官方易变写入面（settings 写入、不夺取他人显式选择、写回校验），pre-rc.2（含 `0.2.0-rc.2`）直写实例自有字段 `searchProviderId`（仅内存、无设置面），细节见[账号与重试](accounts-and-retry.md)的网页搜索段。`tests/package.test.ts` 的断言回到「恰好两条且逐字等于 `{0.2.0-rc.2, 0.2.1-rc.2}`」；`test:engine` 与 `test:install` 矩阵回到 2 个引擎、逐引擎各跑一遍。决策、判据与 PR #93 评审结论见[《决策记录》第八章第14条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。下文 rc.2 及更早的记录属于历史证据。**已修（2026-10-18）**：`.agents/skills/dsh-release-upgrade/` 已同步双引擎——`SKILL.md` 的维护策略改为「官方默认安装版本（npm `latest`）必须可用 + 通道最新，不保留 alpha 通道」，`scripts/collect.py` 的隐式 baseline 从「必须恰好一条 `dshReleases`」改为取其中 semver 最大者并在 stderr 打印选用值（空记录仍退出 2）。

- **2026-10-17 rc.2 升级核验（历史轮次；其单引擎收敛已被本轮反转替代，破坏点与逐包结论仍然有效）**：当轮把支持矩阵收敛为**单一引擎 `0.2.1-rc.2`**——`dsh.compatibility.dshReleases` 只剩 1 条，`dsh.compatibility.dsh`、`engines.dsh` 与 15 个 peer／19 个开发依赖的 `@deepseek-ai/dsh-*` 全部是裸版本 `0.2.1-rc.2`；Cordis 与 Schemastery 随之收紧为 `~4.0.5` / `~3.18.5`（rc.2 配对的正式版，node semver 实测 `maxSatisfying` 命中）。**唯一的运行代码破坏点**是 `@deepseek-ai/dsh-web`（网页能力缝）的选择契约：`WebRuntimeConfig.searchProvider`／`fetchProvider` 改为 `Volatile`（易变引用）、构造函数 `config` 由可选变必填、插件此前直写的私有字段 `searchProviderId` 被整体删除。插件改按 rc.2 官方易变写入路径修复（写入 profile 的易变字段，由 loader 原地提交、不重挂载条目），细节与冲突边界见[账号与重试](accounts-and-retry.md)的网页搜索段、[对接说明](../对接说明.md)第二章。其余 16 个直接依赖包与 9 个 vendor 包源码零差异（`cordis` 4.0.4 → 4.0.5、`schemastery` 3.18.4 → 3.18.5 逐文件 diff 仅版本行），Web（网页）预置模块表、五个既用插槽与准入规则均未变。rc.2 首发两个官方包（`dsh-web-deepseek-api`、`dsh-client-ui-deepseek-model-label-1017`）与本插件无行 id／插槽冲突；其中 `conversation.input.model.label` 是 `single`（单占）类插槽且官方已占用，**不得**重复注册。本轮验证证据与尚缺边界见[对接说明](../对接说明.md)第四章。下文 alpha.5 及更早的记录属于历史证据，不能当作本轮新增变化。

- **2026-10-17 alpha.5 升级核验（历史轮次，已被 rc.2 轮次取代）**：当轮支持的矩阵是 `0.2.0-rc.2 || 0.2.1-alpha.5`。19 个直接 DSH 依赖源码及发布契约除版本串外未变，Web（网页）预置模块、五个既用插槽与准入规则均未变；当轮 Cordis/Schemastery 配 `4.0.5-alpha.2` / `3.18.5-alpha.2`，双通道范围可覆盖（rc.2 轮次收紧为 `~4.0.5` / `~3.18.5`，本轮沿用未改）。当轮插件运行源码与测试夹具无需改动，类型检查、1009 项测试、构建、双引擎、双版本隔离安装和隔离锁文件检查均通过；浏览器与真实提供商未实测。下文 alpha.3/alpha.4 的诊断同属历史证据，不能当作本轮新增变化。

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
  `@deepseek-ai/dsh-client-ui-dockkit` (re-read out of the 0.2.1-rc.2 engine, and
  re-read at every Harness peer bump: the list is unchanged from 0.2.1-alpha.5, 0.2.1-alpha.4, 0.2.1-alpha.3,
  0.2.1-alpha.2, 0.2.1-alpha.1, 0.2.0-rc.2 and
  0.1.7-rc.2, and re-read again on `0.2.1-rc.3`: byte-identical; `zod` and `@tanstack/react-virtual` were already seeded but
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
  both declared ranges stay unchanged there too, and `0.2.1-alpha.5` again pairs
  the same two prereleases; the tilde pairing must
  still be re-read (not assumed) at every engine bump. **`0.2.1-rc.2` is the
  first engine whose batch carries the STABLE pair — `cordis 4.0.5` and
  `schemastery 3.18.5` (npm `latest` for both; no `dsh-0-2-1-rc-*` dist-tag
  exists, so the rc batch published no separate prerelease) — and the rc.2 round
  tightened the declared ranges to that one branch each: `~4.0.5` / `~3.18.5`,
  which fits a SINGLE-engine matrix. The old disjunction also admitted
  `4.0.5-alpha.2` / `3.18.5-alpha.2`, which matches no supported engine; the lock
  file already resolved both to the stable pair, so tightening changed no
  installed version. **The OLDER engine paired differently**:
  （历史）`@deepseek-ai/dsh-web@0.2.0-rc.2` peers `cordis ~4.0.4` and depends on
  `schemastery ~3.18.4`, so one branch could not cover that engine's own pairing —
  the 2026-10-18 matrix therefore used the paired disjunction
  `~4.0.4 || ~4.0.5` / `~3.18.4 || ~3.18.5`
  ([《决策记录》第八章第14条](../决策记录.md#八dsh-引擎兼容范围与验证边界)); that engine and
  both `~4.0.4` / `~3.18.4` branches left the matrix on 2026-10-24.
  These two names are not read by the host admission verdict
  （见下），差异只在 pnpm 解析层生效。**范围写窄不是无害的**：Leaving this
  plugin's previous `^4.0.2` / `~3.18.4` in place is an
  immediate `ERESOLVE`, not a silent mismatch: `dsh-agent@0.2.1-alpha.1` demands
  `cordis ~4.0.5-alpha.1` and `dsh-settings@0.2.1-alpha.1` demands
  `schemastery ~3.18.5-alpha.1`. A caret is doubly wrong here — it neither
  admits the `-alpha.1` prerelease nor excludes the neighbour.
  `react ^18.2.0` is unchanged by the bump and stays as it is.
  **写法随支持矩阵走：配对相同时用单分支，配对不同才写析取。**
  2026-10-24 轮次的矩阵是区间 `>=0.2.1-rc.2 <0.2.2-0`，rc.2 与 rc.3 的 vendor 配对实测
  都是 `cordis 4.0.5` / `schemastery 3.18.5`，配对相同，因此收敛为单分支
  `~4.0.5` / `~3.18.5`。上一轮的析取式 `~4.0.4 || ~4.0.5` / `~3.18.4 || ~3.18.5`
  是因为当时还要覆盖 `0.2.0-rc.2` 的 `~4.0.4` / `~3.18.4` 配对；该引擎已退出
  npm `latest` 并落在区间之外，`~4.0.4` / `~3.18.4` 分支随之退出。
  双通道时代的 `~4.0.4 || ~4.0.5-alpha.1` / `~3.18.4 || ~3.18.5-alpha.1` 属历史写法
  （`-alpha` 分支随正式版配对退出）。
  无论几个分支，都不可写成 `^`（会放行 `4.2.x` / `3.20.x` 这些未验证邻居）。
  **稳定配对写 `~`、预发布配对写精确值**：`0.2.2-rc.1`（2026-11-05）配 `cordis 4.1.0`／
  `schemastery 3.19.0`，上游自身就把 `cordis` 的 peer 声明为 `~4.1.0`、把 `schemastery` 依赖声明为 `~3.19.0`，因此追加
  `~4.1.0`／`~3.19.0` 分支（与上游同形；写精确 `4.1.0` 会拒绝上游允许的 4.1.x 补丁版本）；
  `0.2.2-alpha.2`／`0.2.2-alpha.3` 这类预发布配对不同，仍用精确值，避免放行没有引擎配对的号。
  注意这两个名字**不**匹配 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 前缀，宿主 `evaluatePluginCompatibility` 根本不检查它们
  ——判定层只看 dsh 包，这两个只在 pnpm 解析层起作用：范围写窄到解析不到引擎
  配对的版本不会让安装被"拒绝准入"，却会在 profile 里解析出冲突副本或装错版本，
  所以它们必须与所声明引擎的实际配对逐字一致，并在每次引擎升级时重新核对，
  而不是沿用上一轮的写法。
  Note that npm's peer resolver reads the EXISTING `node_modules` tree, so a
  bump that should resolve cleanly still reports `ERESOLVE` against stale rc-era
  packages until the tree is rebuilt; `rm -rf node_modules` before judging a
  genuine conflict.
- **兼容范围按「同通道区间」声明，2026-10-24 轮次为 `>=0.2.1-rc.2 <0.2.2-0`（2026-10-28 起为双通道并列分支，见上文）。** 用户于
  2026-10-11 确认维护一个 RC（候选发布版）与一个 alpha（早期测试版）两条通道；
  2026-10-17 的 rc.2 发布使 RC 通道首次走到 npm `next` 上的正式 rc，当轮曾把矩阵
  **收敛为单引擎 `0.2.1-rc.2`**（[《决策记录》第八章第13条 (a)](../决策记录.md#八dsh-引擎兼容范围与验证边界)）；
  2026-10-18 反转为**两引擎向下兼容**（析取式 `0.2.0-rc.2 || 0.2.1-rc.2`，第14条）；
  2026-10-24 用户拍板**把形态换成同通道区间**（第15条）：`engines.dsh` 与 `dsh.compatibility.dsh`
  都是 `>=0.2.1-rc.2 <0.2.2-0`，全部 `@deepseek-ai/dsh-*` peer／开发依赖同为该区间。
  **判据**：官方 npm `latest` 已从 `0.2.0-rc.2` 移到 `0.2.1-rc.2`（2026-10-24 实测，
  `next` 为 `0.2.1-rc.3`），且用户要求「同 `0.2.1` 通道 rc.2 以上都支持、`0.2.2` 的 RC 不支持」。
  **上界必须是 `<0.2.2-0` 而不是 `<0.2.2`**：按 semver 优先级 `0.2.2-rc.1 < 0.2.2`，写成后者会
  放行下一条版本线的 RC；`~0.2.1-rc.2` 等价于 `>=0.2.1-rc.2 <0.3.0`，同样错（node semver 实测）。
  **写法已于 2026-10-28 扩展为两个并列分支**（`0.2.1` 的 `-rc.N` 线与 `0.2.2` 的 `-alpha.N` 线，
  见[《决策记录》第八章第 17 条](../决策记录.md#八dsh-引擎兼容范围与验证边界)），本节以下描述的是
  单分支时期的形态，作为历史证据保留。
  `dsh.compatibility.dshReleases` 在 2026-10-24 轮次保留**三条实测记录**
  `{"0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.4"}`，此后随每轮核验增补：`0.2.1-rc.5`（2026-10-30）、
  `0.2.2-alpha.2`（2026-10-28 放开 `0.2.2` 通道）、`0.2.2-alpha.3`（2026-11-03）与
  `0.2.2-rc.1`（2026-11-05）与 `0.2.2-rc.2`（2026-11-12），**现为八条**。
  准入由区间负责，记录只列跑过完整引擎矩阵的版本，并充当 `test:engine`／`test:install` 的矩阵来源。
  **alpha 通道与 `0.2.0-rc.2` 都不保留**：前者自 `0.2.1-alpha.5` 之后没有新版本，后者已退出
  npm `latest` 并落在区间下界之下；`0.2.1-rc.1`、`0.2.1-alpha.*` 与 `0.2.0-rc.*` 的配置需升级引擎。
  基线 `dsh-v0.2.1-rc.2` 标签 SHA `687f282e8625c6b8d11ff58211a90524be2e4317`，目标
  `dsh-v0.2.1-rc.3` 标签 SHA `1f81c047fc48fa190a683e469daa699857e9afe8`。
  `@deepseek-ai/dsh-*` 的 `peerDependencies`、`devDependencies`、`dsh.compatibility.dsh`、
  `engines.dsh` 及锁文件同批同步。
  `tests/package.test.ts` 约束区间形状（逐分支校验 `>=<RC> <下一 patch>-0`）、下界、
  「每条记录都落在某分支内且不早于该分支下界」，并逐字钉住记录清单（2026-10-24 时为两条；
  2026-10-28 起改为逐分支校验，现为八条）；它不联网判断哪个版本最新，该事实由升级审计核对。
  两个配套的 Cordis、Schemastery 范围按已登记引擎的配对写成析取（稳定配对用 `~`、预发布配对用精确值）
  `~4.0.5 || 4.0.6-alpha.1 || 4.0.6-alpha.2 || ~4.1.0` / `~3.18.5 || 3.18.6-alpha.1 || 3.18.6-alpha.2 || ~3.19.0`
  （2026-10-24 单分支 `~4.0.5` / `~3.18.5` 只覆盖当时的 RC 配对；2026-11-05 补入 rc.1 的 `~4.1.0`／`~3.19.0`，见上一条）。
  **自 `0.2.1-alpha.4` 起，宿主判定插件兼容性时只读 `engines.dsh`**
  （`packages/boot/app-boot/src/plugin-compatibility.ts` 的
  `unmetRequirements`）：只要包自带 `engines.dsh` 字符串，`@deepseek-ai/dsh*`
  的 `peerDependencies` 就**完全不参与**判定，只有缺少该字段时才回落到 peer 规则；
  `engines.dsh` 写成 `workspace:` 一律判不兼容，`engines` 非对象或 `engines.dsh`
  非字符串会让清单不可读而被拒绝。四种声明因此必须逐字相同，而 `engines.dsh` 是唯一
  真正被宿主动的那一处：判定不通过时插件行被禁用、bundle 层被**静默跳过**（只有 stderr
  一行 `skipping profile bundle`）、`dsh plugin add` 在 pnpm 之前直接拒绝——2026-10-24 的
  故障正是这一条。上游同批把拒绝记录 `IncompatiblePlugin`／`PluginCompatibility` 的
  `peers` 字段更名为 `requirements`（按 engines 规则判时键为 `engines.dsh`）；本插件不读
  这两个结构，故只需同步文档。每条记录都须通过 `npm run test:engine` 与
  `npm run test:install`，后者覆盖不到准入判定，故 `test:engine` 增加
  `checkEngineAdmission` 直接调用该引擎自己的 `evaluatePluginCompatibility`；
  矩阵下这两项对**每条记录**各跑一遍（红绿对照的判据不变：兼容范围内的版本必须被接受，
  范围外的版本必须被拒）。
  决策见[《决策记录》第八章第6、12、13、14、16条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。
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
  the alpha.4 upgrade would otherwise have shipped broken.
  Being the only check with the engine's own peer tree, it is also where the
  Config schema is proven to drive that engine's settings forms (every field
  marked volatile, parsing to a live reference). Run it before publishing and
  whenever a peer range or an engine version changes.

## 一、账号开通的宿主验证

1. `npm run test:engine` 除加载发布包外，还使用真实 DSH 注册表与网关打开 `enrollmentWatch`，通过网关开始合成手动账号，取消流并确认写入收束后的账号及凭据补偿。设置与凭据使用内存替身；不读真实凭据、不访问真实上游。
2. 当前验证覆盖发布产物、严格描述符、网关接收器和流取消信号。浏览器 WebSocket（网页套接字）物理断连、真实 Studio（登录网站）授权及操作系统强杀仍需实际环境验证，不得由本地绿色检查推定。

## 二、流响应的宿主验证

1. `npm run test:engine` 使用真实 DSH 的 `LlmRuntime`（模型运行时）及 `BlockAssembler`（响应块装配器），对每条已验证记录（本轮为 `0.2.1-rc.2` 与 `0.2.1-rc.3`）各跑一遍：加载发布产物并交付合成响应。22 个场景覆盖三协议成功、正文截断、纯思考达到上限、工具断流、正文及工具取消、最终标记后多余内容，以及 OpenAI 尾部错误；确认唯一终态、失败关联标识、最终用量和中断工具快照。
2. 宿主源码在失败或取消终态走请求错误分支，不进入工具执行；验证没有运行完整代理工具链。适配器本地锁和待读释放由回归测试覆盖；真实提供商异常、收费记录及远端连接实际关闭时间尚未实测。

3. 问题 #88 的标题用途通过两个已声明引擎的真实 `LlmRuntime`（模型运行时）传递到发布产物：CLI（命令行协议）与 OpenAI（开放接口协议）均发送 `off`（关闭思考），保留 64 词元预算并交付标题正文。提供商响应为合成数据；本轮 987 项本地测试、类型检查、构建及双引擎验证通过，不代表真实提供商标题质量或完整标题生成插件已验收。

## 三、测试夹具的引擎感知适配

1. `scripts/verify-engine-load.mjs` 的夹具（fixture，测试夹具）自 alpha.3 起按引擎能力探测装配，因为该版本引入两处必需项：`TypertGatewayService`（Typert 网关服务）的 `static inject` 新增 `remoteAccess`，缺这个服务网关就装配不起来（该服务由 alpha.3 新引入的包 `@deepseek-ai/dsh-api-remote-access` 提供，alpha.2 上不存在该包）；`InvokeRemoteRequest.peer` 由可选变必需，远端调用必须自带 Peer（对端）。
2. 适配方式是**探测**而不是按版本硬编码分支：先探测式加载 `@deepseek-ai/dsh-api-remote-access`（缺失即旧款引擎，跳过该注入），再探测式构造 owner Peer（alpha.2 的 `dsh-client-connection` 只有 `OperatorPeer`、没有 `Peer`，因此旧款返回 `undefined`，调用处据此决定要不要携带）。同一份夹具因此同时适配旧款与新款的已声明引擎。
3. **区分「运行时零改动」与「夹具适配」**：本轮 alpha.2 → alpha.3 的破坏性变化只落在测试采集脚本上，插件 `src/` 与 `lib/` 运行时未改一行即可工作；夹具的引擎感知改动只是让这套检查能在新引擎上走到被测代码，不代表插件运行时依赖了 alpha.3 的新接口。审计证据：`npm run typecheck`、948 项测试、`npm run build`、`npm run test:engine`（双引擎矩阵）与 `npm run test:install` 全部通过。
4. **alpha.4 轮次相反：夹具零改动，破坏点恰在本脚本的盲区。**`0.2.1-alpha.3` → `0.2.1-alpha.4` 中，本插件直接依赖的 14 个包 `src/` 逐字节未变（唯一有源码变化的 `@deepseek-ai/dsh-api-remotes` 是纯增量：新增 plugin-market 远端贡献，且该导入在发布产物里已被内联），Web 静态种子表与四个在用插槽的名字、owner props、outlet 渲染调用全部未变，因此既有夹具**一行未改**即全绿。真正的破坏落在宿主准入判定上（见本章前文）：`engines.dsh` 成为唯一判据后，旧声明在新引擎上会让 `test:engine` 全绿而真实安装、行加载与 bundle 装配三条路径全部被拒。处置一是替换 alpha 通道，二是补 `checkEngineAdmission`。红绿对照可复现：`--engine <alpha.4 安装树>` 通过，`--version 0.2.1-alpha.3` 被拒（该版已退出兼容范围）。

5. **rc.2 轮次：破坏点回到插件自己的可选接缝，引擎夹具无必须改动。**`0.2.0-rc.2` → `0.2.1-rc.2` 中，直接依赖的 19 个包只有 `@deepseek-ai/dsh-web` 存在源码级破坏（搜索／抓取的选择契约改为易变引用 `Volatile`，并删除插件此前直写的私有字段 `searchProviderId`／`fetchProviderId`），其余 16 个包与 9 个 vendor 包源码零差异，引擎夹具依赖的 Web 预置模块表、五个既用插槽声明、远端注入契约与宿主准入规则全部未变。因此本轮的适配落在插件自身的网页搜索选择路径（`src/web-search.ts` 及配套测试夹具）而非 `scripts/verify-engine-load.mjs`——该路径当轮同时支持 rc.2 的易变引用与 pre-rc.2（含 `0.2.0-rc.2`）的实例字段两种形状（**该双形状分派已于 2026-10-24 删除**，见本轮记录）；运行期验证对两个引擎各跑一遍，结论见[对接说明](../对接说明.md)第四章。rc.2 首发两个官方包（`dsh-web-deepseek-api`、`dsh-client-ui-deepseek-model-label-1017`）与本插件无行 id／插槽冲突，其中 `single`（单占）类插槽 `conversation.input.model.label` 已由官方占用，插件不得注册。


## 四、自定义上下文长度的宿主验证

1. `checkContextWindowBudget()` 在每个已声明引擎上通过发布产物与真实 `LlmRuntime` 验证三协议的 12 个场景：调大、调小、保留公布输出上限、程序化小数回落；同时核对模型元数据、默认及显式请求的实际输出数和成功终态。全局与按模型小数均须由真实配置结构拒绝。
2. 网络响应与凭据仍为合成依赖；此检查不证明真实模型容量或浏览器交互质量。

