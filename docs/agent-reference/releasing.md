# 检查命令与发布流程

实际发版、提交、创建标签、推送和创建 GitHub Release（发布记录）均须得到用户明确授权；
配置工作流不等于授权发布版本。保留工作区中与发布配置无关的改动。

## 一、检查命令

```sh
npm install                        # 安装开发依赖
# 校验锁文件与 package.json 同步：在隔离目录运行，不触碰本地 node_modules
tmp=$(mktemp -d) && cp package.json package-lock.json "$tmp"/ && (cd "$tmp" && npm ci --dry-run --ignore-scripts)
npm run typecheck                  # 类型检查
npm test                           # 全量测试
npm run build                      # 生成实际发布的 lib/ 文件
npm run test:engine                # 逐个验证全部声明兼容的 DSH 引擎能加载插件
npm run test:install               # 逐个验证兼容引擎的隔离安装
npm run test:pack                  # 核对真实发布包中的全部导出入口
npm run test:update                # 隔离 home 验证插件更新资格（见下文「插件更新资格」）
npm pack --dry-run --ignore-scripts # 查看实际发布文件清单
```

锁文件校验必须通过：本地 `npm install` 成功不能证明 `package-lock.json` 与 `package.json` 同步，
平台可选依赖条目缺失时只有 `npm ci` 会以 `EUSAGE` 报出。重建锁文件后若发现平台分支缺失，
按上一版锁文件的 `resolved`（解析地址）与 `integrity`（完整性摘要）精准补回、**不重新解析依赖**；
理由与判据见[《决策记录》第八章第 11 条](../决策记录.md#八dsh-引擎兼容范围与验证边界)。

## 二、可信发布配置

1. 本项目采用 GitHub Actions（自动化工作流）手动触发，通过
   OIDC（开放身份连接）进行 Trusted Publishing（可信发布），不保存 npm 发布令牌。
   工作流为 [publish.yml](../../.github/workflows/publish.yml)，须先进入默认分支 `main`。
2. 在 npm 包 `@mars-sea/dsh-commandcode-provider` 的 Settings（设置）→
   Trusted Publisher（可信发布者）中选择 GitHub Actions，填写以下绑定。

   | npm 字段 | 配置值 |
   | --- | --- |
   | Organization or user（组织或用户） | `Mars-Sea` |
   | Repository（仓库） | `dsh-commandcode-provider` |
   | Workflow filename（工作流文件名） | `publish.yml`，只填文件名 |
   | Environment name（环境名称） | 留空，工作流未使用发布环境 |
   | Allowed actions（允许操作） | 允许 `npm publish` 直接发布 |

3. 也可由维护者使用命令行配置；管理可信发布绑定需要一次交互式双因素认证，
   后续工作流发布不需要逐次输入验证码。先查看已有绑定，避免重复配置或移除其他绑定。

   ```sh
   npm trust list '@mars-sea/dsh-commandcode-provider'
   npm trust github '@mars-sea/dsh-commandcode-provider' --repo=Mars-Sea/dsh-commandcode-provider --file=publish.yml --allow-publish
   ```

4. 工作流使用 GitHub 托管运行器、Node.js `22.22.0` 与 npm `11.21.0`，
   给发布任务开放 `id-token: write`，关闭依赖缓存。npm 官方最低要求为 Node.js `22.14.0`
   与 npm `11.5.1`；管理绑定的 `npm trust` 命令要求 npm `11.15.0` 及以上。
5. **新绑定须在两天内完成首次成功发布，否则失效。**在工作流准备就绪且即将发版时创建绑定；
   只检查、打包或 `npm publish --dry-run` 均不能验证真实 OIDC 发布权限。
   本次配置不自动调整包的其他认证设置或撤销已有令牌。
6. 官方依据：[可信发布说明](https://docs.npmjs.com/trusted-publishers/)、
   [`npm trust` 命令](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
7. **首次实际发布已验证（2026-10-14，`0.13.1`）**：[发布工作流](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/runs/38568422035)
   通过全部检查并实际上传，npm `latest` 指向 `0.13.1`，绑定由 Pending validation（待首次发布验证）
   变为 Valid（有效），发布未要求人工输入验证码。注册表已提供来源证明，包摘要、工作流及发版提交匹配；
   原先的两天期限适用于新建且未验证的绑定，本项目当前绑定已完成验证。
8. **命令行走完整流程已验证（2026-10-16，`0.13.4`）**：由 `gh workflow run publish.yml -f tag=v0.13.4 -f dist_tag=latest -f publish=true`
   触发（[运行记录](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/runs/38838339286)），
   工作流依次通过输入校验、`npm ci`、类型检查、测试、构建、已提交产物一致性、双引擎加载、
   隔离安装、发布入口检查与「版本尚未发布」校验后实际上传，`npm latest` 由 `0.13.3` 前移到 `0.13.4`，
   并发布来源证明到透明度日志。命令行触发要求 `gh` 具备 `workflow` 权限；
   本机 `~/.npm` 不可写会让 npm 因写日志失败而整体报 `EPERM`，用 `npm_config_cache=<可写目录>` 即可绕开
   （`npm ci --dry-run` 不受影响，因为它在临时目录内不写全局日志）。

## 三、手动发布版本

1. 获得本次发版授权后，更新 `CHANGELOG.md`，使用
   `npm version patch|minor|major --no-git-tag-version` 更新版本，不自动创建标签。
2. 运行第一章的检查。`test:engine` 必须验证所有声明兼容的 DSH 版本；不能只验证某一个版本
   就声称整个范围通过。若兼容范围变化，同时运行 `test:install`。
3. 提交经确认的发布内容，推送 `main`，创建并推送 `v<版本号>` 标签。
   标签须指向已合入 `main` 的提交，版本须与该提交的 `package.json` 一致。
   手动可信发布必须先推送标签，再从 GitHub 发布到 npm。
4. 打开 GitHub 仓库的 Actions（工作流）→「npm 可信发布」→ Run workflow（运行工作流），
   运行分支选择 `main`，填写以下参数。

   | 工作流参数 | 用法 |
   | --- | --- |
   | `tag`（版本标签） | 已推送的完整标签，例如 `v0.13.1` |
   | `dist_tag`（npm 分发标签） | 正式版用 `latest`；预发布版明确选择 `next`、`beta` 等，禁止覆盖 `latest` |
   | `publish`（实际发布） | 默认关闭，仅检查并打包；确认实际发版时开启 |

5. 工作流重新执行类型、测试、构建、产物一致性、真实宿主加载、隔离安装及发布入口检查。
   通过后生成发布包；实际发布时先确认版本尚不存在，再通过可信发布上传同一包。
   发布时不重新执行 `prepare`，避免检查后的构建产物被改写。
   GitHub 对公开仓库的公开包自动生成 Provenance（来源证明）。
6. 确认 GitHub 工作流成功、npm 对应版本及分发标签正确，再创建 GitHub Release（发布记录）。
   发布说明须简短、面向用户、双语：先 `## 中文`，再 `---` 分隔线与对应英文译文。
   每条用一两句话说明变化与用户收益，不写文件名、内部机制或调试过程。
   技术细节保留在 `CHANGELOG.md`；不能用仅推送标签代替发布记录。
7. **核对新版本能被 dsh 插件更新读到。** 宿主 `pluginManager.listVersions` / `updateBundle`
   用 `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh`
   判定目标版本；缺 `dsh.bundle` 或 `engines.dsh` 不接纳当前引擎时，更新停在 `check`
   且 profile 不变。发版后在能访问注册表的机器上核对（`<版本>` 换成实际版本号）：

   ```sh
   npm view @mars-sea/dsh-commandcode-provider@<版本> version engines.dsh dsh.bundle.patch --json
   npm view @mars-sea/dsh-commandcode-provider dist-tags --json
   ```

   前者字段必须齐全且 `engines.dsh` 覆盖用户当前 dsh，后者确认 `dist-tags` 的 `latest`
   （或本次预发布对应的 tag）已指向新版本。这些字段由 `tests/package.test.ts` 的更新资格
   断言在提交前守住；本步骤验证的是**已上传的注册表副本**，不是工作区清单。

## 四、验证边界

1. 合并工作流 [ci.yml](../../.github/workflows/ci.yml) 保持原有检查门槛。
   新增发布工作流不会因推送分支或标签自动发版；必须手动触发并开启 `publish`。
2. 本地工作流语法、输入拦截和打包检查通过，只能证明本地配置与检查可运行；
   未上传到 GitHub、未完成 npm 绑定、未成功执行真实发布时，不能报告可信发布已经验证。
3. 工作流首次「仅检查」可使用已有的发布标签；实际发布必须使用尚未发布的新版本。
   完整检查需要 npm 网络，但不需要账户凭据或付费模型请求；只有真实上传使用 OIDC。
4. `npm run test:update`（[scripts/verify-plugin-update.mjs](../../scripts/verify-plugin-update.mjs)）验证的是
   **资格链路**，不是运行中的 Host 调用：它用 `DSH_HOME` 指向独立目录、从官方 web 模板建干净 profile、
   从 npm 装一个较旧的已发布版本，复现 `updateRefusal()` 的资格判定，并跑与
   `listVersions()` / `updateBundle()` 的 check 完全相同的 `pnpm view` 查询（引擎兼容性复用宿主的
   `evaluatePluginCompatibility()`）。它**不**挂载完整 Loader 树与 HMR，因此不证明 Web 插件页的
   「版本」区块渲染、也不证明真实的 `check → remove → install → restore` 执行。要拿这两层证据，
   用 `--home <dir>` 保留实例、按脚本打印的命令在独立端口启动 GUI，人工点「更新」后用
   `--home <dir> --verify-result` 断言 profile 已 `saveExact` 到目标版本。开发用的 `web` profile
   以 `link:` 安装，宿主明确不显示版本区块，不能用它验证更新。
