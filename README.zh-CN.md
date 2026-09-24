# dsh-commandcode-provider

[English](./README.md) | **简体中文**

[![Awesome](https://awesome.re/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![GitHub Repo stars](https://img.shields.io/github/stars/Mars-Sea/dsh-commandcode-provider?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/stargazers)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/pulls)
[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

非官方 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 LLM provider 插件，用于 **Command Code**，移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT 协议）。

> 这是一个社区集成。你需要自己的 Command Code 账号、API key 或订阅，并遵守 Command Code 的服务条款。本项目与 Command Code, Inc. 无关。

## 功能一览

- **插件包**：一条 `dsh plugin add` 命令安装到任意 dsh 配置，注册 `commandcode` provider 路由，带实时模型目录。
- **专属设置页**：统一的账户列表（密钥、网页登录、实时额度、专用模型）、模型显示、隐私开关与连接参数。
- **终端界面同样可用**：同一次安装即可服务 [dsh-TUI](#终端界面dsh-tui) 配置，终端里有自己的 **`/settings` → Command Code** 页面来填 key 和调模型。
- **Models 页快捷卡片**：**设置 → Models → Command Code** 卡片内直接显示 key 状态、粘贴输入框和登录按钮。
- **浏览器内登录获取 key**：设置页一键发起官方授权（与 `cmd login` 同一流程），完成后密钥自动写入本机凭据服务，无需手动创建或粘贴；不可用时随时退回手动粘贴。
- **多账户轮换**：一个账户用量打满后，请求自动切换到下一个账户。详见[多账户轮换](#多账户轮换)。
- **key 配置灵活**：设置页填写、环境变量或官方 CLI 登录文件均可。
- **模型选择器标注**：每个模型标注最低套餐、折扣/FREE 徽章、峰谷时段、图片支持与上下文长度，免费模型置顶。
- **按套餐过滤**：默认隐藏超出订阅套餐的模型，可一键关闭；「模型白名单」可进一步只保留常用模型。
- **推理强度支持**：支持推理强度的模型可在选择器中选择档位。
- **图片输入**：Vision 模型支持发送图片。
- **套餐与配额面板**：可选的 Command Code 卡片位于侧边栏底部（Settings 正上方），显示当前服务账号的套餐与 5 小时 / 每周两个配额窗口；点击后在中间栏打开面板，包含计费周期、两个窗口的进度条与重置时间、月度额度消耗，以及已购买 / 赠送余额。面板右上角的 **×** 按钮可随时把中间栏交还给会话（不会切换当前会话）。**默认关闭**——在 **设置 → Command Code → 集成与显示** 中打开「在侧边栏显示额度卡片」即可显示，同一开关也能随时隐藏（隐藏时左侧不渲染任何内容，也不会为其后台刷新用量）。面板文案跟随 Harness 显示语言（中文 / English）。
- **会话费用估算**：在输入框下方的 token 计数旁及用量对话框中显示估算金额（`≈`），根据持久化历史中每次请求的模型、请求时间和上下文阶梯分别计价。切换模型或稍后查看不会重新定价之前的请求。混合供应商或缺少费率时显示已定价部分的小计（`≥`）；缺少历史事实或完全无法定价时不显示金额。结果基于插件内的价格快照，不等同于供应商账单。同样固定为英文。
- **联网搜索**：dsh 的 `web_search` 工具由 Command Code Provider API（`/alpha/web-search`）承载，复用聊天同一个 key 与端点，无需单独配置搜索 key 或地址。详见[联网搜索](#联网搜索)。

## 安装

本版本**只支持 dsh 0.1.7-rc.1**：插件的 peer 范围就是这一个版本，兼容性记录里也只列它。

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest
```

- **更早的 dsh 版本。** 0.1.2–0.1.6 线已不再支持：那些引擎早于 0.1.7 的设置重写、`RequestMessage` 消息封装和持久化图片卸载契约，用来桥接两代引擎的兼容代码已经删除。覆盖它们的最后一个插件版本是 0.11.11；0.5.0 时代 Harness 线的最后一个版本是 0.9.1。两者都按精确版本安装，且都不再维护：

  ```sh
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.11.11   # dsh 0.1.2–0.1.6
  dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.9.1     # dsh 0.5.0 线
  ```

**pnpm 11 会拦下刚发布的新版本。** 它的 `minimumReleaseAge` 默认为 1440 分钟，发布不足一天的版本会被跳过，`@latest` 解析到**上一个**版本 —— 而且是静默的，命令照样以成功退出。想装 24 小时内发布的版本，必须写精确版本号：

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.11.13
```

这一点对每个 profile 都成立，包括下面的终端界面。

插件可直接在 pnpm 10 的全新插件市场 generation 中安装。不要另行添加 `@deepseek-ai/dsh-invariants` dependency；插件已将其声明为 Host peer，Harness 包仍由当前 dsh profile 统一管理。

## 更新

用与安装时相同的 tag 更新：

```sh
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@latest     # dsh 0.1.7-rc.1
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@0.9.1      # 更早的 dsh（0.5.0 线，不再维护）
```

每个 profile 各自更新 —— 终端界面有独立的插件列表（见下文）：

```sh
dsh plugin --profile dsh-tui update @mars-sea/dsh-commandcode-provider@0.11.13
```

要更新到发布不足 24 小时的版本，和上面的安装一样写精确版本号；pnpm 11 的年龄门禁会把 `@latest` 解析成上一个版本。

然后重启 Web 应用。

## 获取 API key

最简单的途径是官方 CLI（Node.js 22+）：

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux；Windows 原生版：cmdc login
```

也可以不装 CLI，直接在 **设置 → Command Code** 点击「登录 Command Code」：浏览器会打开 commandcode.ai 授权页（与 `cmd login` 相同的流程），完成后密钥自动写入本机凭据服务。还可以在 [Keys 设置页](https://commandcode.ai/mars-sea/settings/keys) 创建 key 后手动粘贴，或 `export COMMANDCODE_API_KEY="user_..."`。

> 登录流程依赖 Host 与浏览器在同一台机器（回环回调）。Host 在远程机器上时请使用手动粘贴；若组合配置里写了字面量 `apiKey`，它仍优先于登录写入的凭据。

## 验证是否生效

重启后，在 **设置 → Command Code** 填入 API key 并保存；**设置 → Models** 出现 **Command Code** 卡片，模型选择器在 **commandcode** 下列出实时目录。选择套餐内包含的模型发送消息即可。

## 终端界面（dsh-TUI）

插件同样支持终端前端。**每个 dsh profile 有独立的插件列表**，所以上面那条 Web 安装命令不会装到终端里 —— 还要把插件装进 `dsh-tui` profile：

```sh
dsh plugin --profile dsh-tui add @mars-sea/dsh-commandcode-provider@0.11.13
```

这里请写精确版本号。新版本发布后的 24 小时内，只写包名（或 `@latest`）会被静默解析到上一个版本 —— 安装命令照样成功，但 profile 里拿到的是旧版本，结果就是全新的终端安装里既没有 **`/settings` → Command Code** 页面，也看不到任何 `commandcode` 模型。

之后在模型选择器里选，或者直接指定：

```text
/model commandcode/deepseek/deepseek-v4.1-flash
```

`/model` 会列出所有已注册的 provider，Command Code 的实时目录连同套餐/优惠/上下文标注一起出现，`/commandcode` 用量面板在终端里同样可用。

**填写 API key。** 终端没有网页版 Models 页面，所以插件会在终端设置页里声明自己的页面 —— **`/settings` → Command Code** —— 包含 API key、API 地址、隐藏套餐外模型、当前账号和命令语言。key 字段是只写的：它只显示"是否已配置"，输入的内容写进凭据库，不会写进任何 settings 文档。只用终端的用户只需要访问这一个页面。

**选择模型。** 同一页面把整个模型目录列成勾选框，按套餐档位分组（Go → GOAT → Pro → Provider），免费模型排在最前，不需要手打任何模型 id。默认全部勾选——未设置白名单就等于"显示全部模型"；把不想在选择器里看到的取消勾选即可。选择会以「单模型覆盖」的形式保存在网页端编辑的 `visibleModels` 列表旁边，两个界面可以混用，手写的 `visibleModels` 也照常生效。

也可以在终端外配置 key，以下三种方式按优先级生效：

```sh
export COMMANDCODE_API_KEY="user_..."   # 启动环境变量
cmd login                               # 写入 ~/.commandcode/auth.json
```

**把 Command Code 设为默认模型。** dsh-TUI 写死了自己的 agent 路由，它的 `agent-default-model` 设置不会覆盖它。要让每个会话默认走 Command Code，请在自己的 profile patch（`$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`）里覆盖 `agent-loop` 行：

```yaml
- id: agent-loop
  inject: [tuiStartup]
  config:
    agents:
      - id: main
        provider: commandcode
        model: deepseek/deepseek-v4.1-flash
        reasoningEffort: max
        cwd: !!js process.cwd()
```

**引擎版本要求。** 插件只针对一个引擎维护：**dsh 0.1.7-rc.1**。它的 `@deepseek-ai/dsh-*` peer 范围是 `^0.1.7-rc.1`（按 semver，这只会解析到 0.1.7-rc.1），`dsh.compatibility.dshReleases` 也只记录这一个版本。在更早的引擎上，设置页、消息封装或请求图片预算总有一处对不上——请改装支持你所用引擎的最后一个版本，而不是硬装这一个。

## 用量面板

插件注册了 `/commandcode` 斜杠命令，显示各账户的用量状态：

```text
/commandcode        （或 /commandcode status）
```

命令的文案跟随 shell 的语言设置：在 `llm-commandcode` 插件配置里显式写 `lang: 'en' | 'zh'` 优先；否则读 `LC_ALL`/`LANG`；再否则回退到 `zh`。web 设置页是独立表面，跟随浏览器自身的语言偏好。

## 多账户轮换

有多个 Command Code 订阅时，插件可以在一个账户达到用量限额后**自动切换到下一个账户**：

- **配置**：在 **设置 → Command Code** 的「账户」卡片点击「添加账户」，可填写备注名，然后选择「网页登录」（在浏览器授权后自动保存 key；登录未完成不会留下空账户）或「粘贴密钥」。添加、重命名、更换或清除密钥、移除、固定等账户操作**立即生效**，无需点击页面底部的「保存」；「保存」只作用于页面上的其他设置。顶层 key 始终是第一顺位的 `default` 账户。
- **手动切换**：在账户行的「⋯」菜单中选择「固定使用此账户」即可指定优先账户；所选账户耗尽时自动回落到其他账户，窗口重置后自动恢复。「取消固定」回到自动轮换。
- **专用模型**：展开某个账户，从实时模型目录**多选**它的「专用模型」。请求这些模型且该账户可用时使用该账户；账户耗尽或密钥失效时自动回落到常规轮换。一个模型同一时间只属于一个账户，给另一个账户选择它会自动移过去（仍保存为 `modelAccountRules`）。
- **只显示常用模型**：在「模型」卡片的「可见模型」中勾选要保留的模型，模型选择器只列出这些；不勾选则显示全部（默认行为不变）。
- **状态展示**：每个账户行直接显示套餐、状态以及 5 小时 / 每周额度条，展开可查看完整报告；`/commandcode` 同样按账户显示状态。

等价的 YAML（`$DSH_HOME/settings.yaml` 或组合配置）：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY        # 第一顺位（default）账户
  activeAccount: COMMANDCODE_API_KEY_2   # 可选：手动指定当前账户（default 或某账户的凭据引用）
  accounts:                              # 之后的轮换顺序
    - label: Go #2
      apiKeyEnv: COMMANDCODE_API_KEY_2
    - label: Go #3
      apiKeyEnv: COMMANDCODE_API_KEY_3
  modelAccountRules:                     # 可选：按模型路由到账户（第一条命中生效）
    - models:                            # 目录模型 id（可多选）
        - deepseek/deepseek-v4-pro
        - deepseek/deepseek-v4-flash-vision-exp
      account: COMMANDCODE_API_KEY_2
    - models:
        - tencent/hy4-preview
      account: default
  visibleModels:                       # 可选：只在选择器中显示这些模型（目录模型 id），不填显示全部
    - deepseek/deepseek-v4-pro
    - tencent/hy4-preview
```

## 配置

**设置 → Command Code** 分为：**账户**（密钥、网页登录、实时额度、固定账户、专用模型）、**模型**（隐藏套餐外模型、可见模型）、**隐私与安全**（零数据保留 ZDR 与 AI 命令安全预判，均默认关闭，见下）、**集成与显示**（用 Command Code 承载联网搜索、在侧边栏显示额度卡片，默认关闭），以及默认折叠的**高级设置**（API 地址、请求/流超时、传输重试次数）。工作目录已不在页面上显示，配置中的 `workingDir` 仍然有效。

同一组选项也位于 `$DSH_HOME/settings.yaml`（修改即刻生效，无需重启）：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # 凭据引用
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # 可选
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # 默认 60s
  streamIdleTimeoutMs: 300000      # 默认 300s
  showSidebarQuota: true           # 可选：在侧边栏显示套餐与配额卡片（默认关闭）
  commandGuard: true               # 可选：让决策模型自动放行安全的 shell 命令（默认关闭）
  commandGuardLevel: medium        # 可选：自动放行阈值，high（0.95）| medium（0.9，默认）| low（0.8）
  zdr: true                        # 可选：请求只经由零数据保留上游（默认关闭）
```

## 联网搜索

当你的 dsh 部署加载了 web 能力（`@deepseek-ai/dsh-web` + `@deepseek-ai/dsh-tool-web`）时，模型所用的 `web_search` 工具会由本插件的 `commandcode` 搜索 provider 承载——它用**与聊天相同的 API key 与 base URL** 调用 Command Code Provider API 的 `/alpha/web-search` 端点。你无需另外配置搜索 key、端点或模型。

**默认开启。** 插件的 **设置 → Command Code** 页里有一个「用 Command Code 承载联网搜索」开关（`webSearch`，默认开）。开启时插件会自动把 `commandcode` 选为当前搜索后端；关闭则把选择权交还给之前的后端（比如 modsearch 等其他搜索插件可继续工作——不会被强制回退到 dsh 自带的 DeepSeek 搜索）。该开关在**下一次搜索时生效**，无需重启。

- 该 provider 仅在 web 服务存在时以 `commandcode` 注册进 `ctx.web`；没有它，本插件仍是纯聊天插件。
- 开关通过启动时与每次设置变更时在 web 接缝里选中 `commandcode` 来实现，同时记住被顶掉的后端；关闭开关（或卸载插件）时会恢复那个后端。若你想更稳妥地固定，可设置 `searchProvider: commandcode`（或 `$DSH_WEB_SEARCH_PROVIDER=commandcode`）；即使本插件的运行时选中不可用，该配置仍然生效。
- dsh 工具的 `numResults` 会被收敛到 Command Code 的取值范围（1–10，默认 5）；结果映射为 dsh 的 `WebSearchSource` 结构（`url`/`title`/`snippet`）。

> 这里直接使用 Command Code Provider API（与官方 CLI 内置的 `web_search` 相同），因此与 DeepSeek 原生搜索后端不同。

## AI 命令安全预判

当 dsh 准备就某条 shell 命令（`bash`/`pwsh`）征求你同意时——无论是权限预设、`PreToolUse` 钩子还是沙箱提权——本插件可以先让 Command Code 的决策模型 `typesafe/jev` 判断这条命令是否安全到无需询问。判断为「安全」且把握足够高时，直接放行这一次调用；其余情况一律照旧询问你。

**默认关闭。** 在「隐私与安全」卡片里打开「用 AI 预判命令是否安全」（`commandGuard`），或写进 profile 配置。它的行为边界：

- 它只会看到 dsh **本来就要询问你**的命令——不会放宽任何权限策略，也不会替「从不询问」（policy 为 `never`）的会话作答。
- 普通审批只问一个 `safe` 问题；带有 `sandboxPermissions` 的沙箱提权会额外问 `escalation_scope` 与 `escalation_necessity`。只有主安全概率以及这两个提权概率都不低于所选「自动放行阈值」（`commandGuardLevel`：高 0.95、中 0.9（默认）、低 0.8；阈值越高弹窗越多）时才跳过弹窗；因此像 `go test ./...` 需要访问工作区外构建缓存的场景，只要 JEV 确认提权范围狭窄且必要，就能由 AI 放行，不必每次打扰用户。
- 任一概率不足、提权范围过宽或没有必要、超时（固定 3 秒）、限流、缺 key、返回体读不懂、命令超过 6000 字符，或命中内置危险名单（`sudo`、`rm -rf /`、`git push`、发布/上传类命令、把下载内容管进 shell 等），全部回到普通弹窗。
- 送往 Command Code 判断的内容包括**命令原文**、模型自己写的一行描述、工作目录、请求的 sandbox 模式与询问原因；使用与聊天相同的 API key 与 base URL。
- 该决策模型**没有零数据保留（ZDR）上游**，因此本功能与「只走 ZDR」的合规要求不兼容；如果你在意这一点，请保持关闭。
- 该端点 2026-09-24 前免费，之后按输入 $0.042/1M tokens 计费（输出免费）——单次判断只有几百 tokens；同一 agent 中命令和审批场景都相同时，10 分钟内复用上一次结论。

每次 AI 决策都会在 Host 侧写日志——普通放行是 `llm-commandcode: command guard auto-approved a bash call (safe probability 0.97, model): <命令>`；沙箱提权还会附带 `sandbox scope` 与 `necessity` 概率；其余是 `… delegated a bash call: <原因> — <命令>`——并进入会话自身的审批审计（`approval/asked` / `approval/decided`），所以任何一次放行都能追溯到产生它的判断。日志打到 Host 控制台（运行 `dsh web` 的终端，或桌面端日志），不进浏览器。

## 零数据保留（ZDR）

Command Code 可以让请求只经由「不留存提示词与回复、也不用于训练」的上游——官方 CLI 的开关是 `CMD_ZDR=1`，Provider API 上则是在请求头发 `x-cmd-zdr: 1`（[官方文档](https://commandcode.ai/docs/resources/zdr)）。

**默认关闭。** 在「隐私与安全」卡片里打开「零数据保留（ZDR）」（`zdr`），或写进 profile 配置。本插件的实现方式：

- 开启后，**每次聊天请求**都会带上 ZDR 请求头。插件仍维护官方 CLI 的例外名单（`KNOWN_NON_ZDR_MODELS`，约 20 个模型，例如 `xai/grok-4.5`、`stepfun/Step-3.7-Flash`、`meta/muse-spark-1.3`）供查询。没有可用 ZDR 上游时，服务端返回 `422 cmd_zdr_no_providers`；插件不会去掉请求头重试。
- 万一仍被拒绝（名单过期，或那一刻没有空闲的 ZDR 上游容量），错误信息会说明原因并给出关闭 ZDR 的办法，而不是抛出一个光秃秃的 HTTP 422。
- **ZDR 通常更贵**：容量有限，按各上游实价透传计费，且每次请求落在哪个上游可能不同。会话费用读数仍按常规目录价估算；真实单价见 Command Code Studio 的用量页。
- **AI 命令安全预判**背后的决策模型没有 ZDR 上游，因此即使打开 `zdr`，它的请求也永远不带该请求头——两个功能互不影响。
- 各套餐均可使用；ZDR 请求按套餐的默认额度（而非提升额度）计量。

## 注意事项与限制

- **图片输入按模型能力限制**：仅 Vision 模型接受图片，纯文本模型会直接拒绝。
- 含图片的会话切换到纯文本模型会被 dsh 拒绝——请改选带 *`Image`* 标记的模型，或先移除图片。
- **图片很多的长会话不会中途失效**：服务端对单次请求体有大小上限（约 50 MB，官方未公开），会话累积大量截图后，原本会在此后每一次请求都失败。现在超出预算的最旧图片会被替换成一段标明附件的"图片已省略"文字，较新的图片照常发送；若请求仍被判为过大，会先以更小的图片预算重试一次，再报错。
- **不支持 `stop` 序列**：携带它的请求会报错。
- 在旧版 `/alpha/generate` 传输中，推理块不会重放到后续轮次；在 `/provider/v1/chat/completions` 传输中，历史推理会以 `reasoning_content` 回传，以便工具调用循环保留思维链。两种传输都只重放带配对工具结果的工具调用。
- 模型目录无需 key 即可浏览；对话请求需要 key。

## 权限与隐私

本插件只在本地与你的 Command Code 账号之间通信：本地仅读写凭据存储与模型缓存文件（兜底读取 `~/.commandcode/auth.json`）；网络仅访问 Command Code API。无遥测。唯一的可选例外是 **AI 命令安全预判**（默认关闭），它会把待判断的命令文本发送出去——见上文。打开**零数据保留**（同样默认关闭）后，聊天请求必须经由 ZDR 上游；没有可用 ZDR 上游的模型会报错，不会按常规方式继续发送。

## 关闭 / 卸载

- **禁用**（不删除）：编辑你 profile 的 `cordis.patch.yml`，注释掉（或移除）`llm-commandcode` 行，或设置 `disabled: true`，然后重启。
- **完全卸载**：

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  你在 dsh 凭据库和 `~/.commandcode/auth.json` 中的 API key 不会被改动。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

在 profile 里试用本地构建：

```sh
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

修改 `src/` 后需重新运行 `npm run build` 并重启应用。

## 社区与反馈

- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="GitHub" /> [GitHub 仓库](https://github.com/Mars-Sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="Releases" /> [GitHub Releases](https://github.com/Mars-Sea/dsh-commandcode-provider/releases)
- <img src="https://cdn.simpleicons.org/npm/111827" width="16" alt="npm" /> [npm 包](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/discourse/111827" width="16" alt="Linux.do" /> [Linux.do 社区](https://linux.do/)

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。部分内容移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。

## 界面截图

**模型选择器** —— 套餐档位、折扣/FREE、峰谷时段、Image 与上下文标注：

<img src="assets/screenshots/model-picker.png" alt="带套餐、折扣、图片与上下文标注的模型选择器" width="320">

**用量面板** —— `/commandcode` 的分账户报告：

<img src="assets/screenshots/usage-dashboard.png" alt="用量面板" width="520">

**设置页** —— 带实时额度的账户列表、模型显示、隐私开关与连接参数：

<img src="assets/screenshots/settings-page.png" alt="Command Code 设置页面（含账户用量卡片）" width="640">
