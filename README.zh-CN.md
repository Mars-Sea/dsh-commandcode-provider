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

## 快速上手

| | |
|---|---|
| 已验证引擎 | dsh `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.2` |
| Node.js | **`>=24.9`** —— 0.16.0 起从 22 提高，见[需要 Node.js 24.9 或更高版本](#需要-nodejs-249-或更高版本) |
| 安装 —— 网页端 | `dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest` |
| 安装 —— 终端端 | `dsh plugin --profile dsh-tui add @mars-sea/dsh-commandcode-provider@latest` |
| 配置文件 | `$DSH_HOME/settings.yaml` → `llm-commandcode:` |
| API key 环境变量 | `COMMANDCODE_API_KEY` |
| 用量面板 | `/commandcode` |

## 功能一览

- **插件包**：一条 `dsh plugin add` 命令安装 `commandcode` provider 路由，带实时模型目录。
- **设置页**：账户列表（密钥、网页登录、实时额度、专用模型）、模型显示、隐私开关与连接参数。
- **目录带标注**：模型选择器里标注套餐档位、折扣/`FREE` 徽章、峰谷时段、图片支持与上下文长度，免费模型置顶。
- **多账户轮换**：一个账户用量打满后自动切换到下一个；可固定优先账户，也可把模型指派给专用账户。
- **浏览器内登录获取 key**：一键发起官方授权流程，完成后密钥自动写入本机凭据服务。
- **套餐与配额面板**：可选的侧边栏卡片，显示当前服务账号的套餐、5 小时 / 每周两个配额窗口、余额与重置时间。
- **会话费用估算**：在输入框下方的 token 计数旁显示估算金额（`≈`），按持久化历史逐次请求计价。
- **模型分析**：按最近会话或日期查看词元、估算成本、响应速度与失败/重试。[统计口径](docs/模型成本与性能分析.md)。
- **联网搜索**：dsh 的 `web_search` 工具由 Command Code 承载（`/alpha/web-search`），复用聊天同一个 key 与端点。
- **零数据保留**：可选的 ZDR 路由（`x-cmd-zdr: 1`），默认关闭。
- **上下文与输出上限**：可全局或按模型覆盖宿主计量的上下文窗口，也可限制或省略单轮 `max_tokens`。
- **推理强度与图片**：支持推理强度的模型在选择器中可选档位；Vision 模型支持发送图片。
- **终端界面**：同一次安装即可服务 [dsh-TUI](#终端界面dsh-tui) 配置，终端里有自己的 `/settings` → Command Code 页面。

## 界面截图

**模型选择器** —— 套餐档位、折扣/FREE、峰谷时段、Image 与上下文标注：

<img src="assets/screenshots/model-picker.png" alt="带套餐、折扣、图片与上下文标注的模型选择器" width="320">

**用量面板** —— `/commandcode` 的分账户报告：

<img src="assets/screenshots/usage-dashboard.png" alt="用量面板" width="520">

**设置页** —— 带实时额度的账户列表、模型显示、隐私开关与连接参数：

<img src="assets/screenshots/settings-page.png" alt="Command Code 设置页面（含账户用量卡片）" width="640">

## 安装

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest
```

本构建准入 **dsh `>=0.2.1-rc.2 <0.2.2-0`** —— `0.2.1` 通道中 `0.2.1-rc.2` 及以后的每个 RC —— **以及 `>=0.2.2-alpha.2 <0.2.3-0`**，即 `0.2.2` 通道从当前 alpha 起的每个版本。`0.2.1-rc.5` 是 npm `latest` 与 `next` 指向的版本，`0.2.2-alpha.2` 挂在 `alpha`；这五个版本都跑过完整引擎矩阵（`npm run test:engine`、`npm run test:install`）。两个通道中更晚的版本无需更新插件即可准入，但在 `dsh.compatibility.dshReleases` 补上记录之前不算已验证。`0.2.3` 及以后被刻意排除 —— 两个区间上界分别写成 `<0.2.2-0` 与 `<0.2.3-0` 正是为了这一点。使用 `0.2.0-rc.2`、`0.2.1-alpha.5` 或更早版本的配置需先升级引擎，再安装本构建。兼容性细节 —— `engines.dsh` 准入规则、按引擎配对的包版本、验证证据 —— 见[引擎兼容](docs/agent-reference/engine-compatibility.md)。

### 需要 Node.js 24.9 或更高版本

**Node.js 下界已在 0.16.0 从 22 提到 24.9。如果你在用 Node 22 或 23，请先升级 Node，再更新本插件。**

dsh `0.2.2-alpha.2` 自己声明 `engines.node >=24.9.0`，而本插件准入这个引擎，所以整包的 Node 下界必须跟着抬到同一水位：一个声称支持某引擎的插件，不该能被装到一个那个引擎根本起不来的 Node 上。实际影响：

- 在 Node 22/23 上安装或更新本插件时，`npm` 会报 `EBADENGINE`。这是警告而非硬失败 —— 除非你的 npm 设了 `engine-strict=true`。
- `0.2.2` 的引擎在 Node 22/23 上确实跑不起来，被准入却启动失败正是这条下界要挡的情况。
- `0.2.1` 的 RC 引擎仍能在 Node 22 上运行，但 `engines.node` 是整包唯一的下界，所以对它们同样生效。这是在一个构建里同时准入两个通道的代价。

执行 `nvm install 24 && nvm use 24`（或换用任意 Node 24.9+ 发行版）即可解决。Node 24 是当前 LTS 线。

**更早的 dsh 版本**已不再支持：覆盖 dsh 0.1.7 的最后一个插件版本是 `0.11.17`，0.1.2–0.1.6 线的最后一个版本是 `0.11.11`，0.5.0 时代 Harness 线的最后一个版本是 `0.9.1` —— 三者都按精确版本安装，且都不再维护。

> **pnpm 11 会拦下刚发布的新版本。** 它的 `minimumReleaseAge` 默认为 1440 分钟，发布不足一天的版本会被跳过，`@latest` 解析到**上一个**版本 —— 而且是静默的，命令照样以成功退出。想装 24 小时内发布的版本，必须写精确版本号：`@mars-sea/dsh-commandcode-provider@0.11.15`。这一点对每个 profile 都成立，包括下面的终端界面。

**更新** —— 用与安装时相同的 tag，然后重启 Web 应用。每个 profile 各自更新 —— 终端界面有独立的插件列表：

```sh
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider@latest
dsh plugin --profile dsh-tui update @mars-sea/dsh-commandcode-provider@latest
```

## 获取 API key 并验证

最简单的途径是官方 CLI（Node.js 22+）：

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux；Windows 原生版：cmdc login
```

也可以不装 CLI，直接在 **设置 → Command Code** 点击「登录 Command Code」：浏览器会打开 commandcode.ai 授权页（与 `cmd login` 相同的流程），完成后密钥自动写入本机凭据服务。还可以在 [Keys 设置页](https://commandcode.ai/mars-sea/settings/keys) 创建 key 后手动粘贴，或 `export COMMANDCODE_API_KEY="user_..."`。

> 登录流程依赖 Host 与浏览器在同一台机器（回环回调）。Host 在远程机器上时请使用手动粘贴；若组合配置里写了字面量 `apiKey`，它仍优先于登录写入的凭据。

**验证方式**：重启后，在 **设置 → Command Code** 填入 API key 并保存。**设置 → Models** 出现 **Command Code** 卡片，模型选择器在 **commandcode** 下列出实时目录。选择套餐内包含的模型发送消息即可。

## 终端界面（dsh-TUI）

**每个 dsh profile 有独立的插件列表**，所以上面那条 Web 安装命令不会装到终端里 —— 还要把插件装进 `dsh-tui` profile，并写死精确版本号（新版本发布后的 24 小时内，只写包名或 `@latest` 会被静默解析到上一个版本，结果就是全新的终端安装既没有 `/settings` → Command Code 页面，也看不到任何 `commandcode` 模型）：

```sh
dsh plugin --profile dsh-tui add @mars-sea/dsh-commandcode-provider@latest
```

之后在模型选择器里选，或者直接指定：

```text
/model commandcode/deepseek/deepseek-v4.1-flash
```

`/model` 会列出所有已注册的 provider，Command Code 的实时目录连同套餐/优惠/上下文标注一起出现；`/commandcode` 用量面板在终端里同样可用。

**填写 API key。** 终端没有网页版 Models 页面，所以插件会在终端设置页里声明自己的页面 —— **`/settings` → Command Code** —— 包含 API key、API 地址、隐藏套餐外模型、当前账号和命令语言。key 字段是只写的：它只显示"是否已配置"，输入的内容写进凭据库，不会写进任何 settings 文档。同一页面还把整个模型目录列成勾选框，按套餐档位分组、免费模型排在最前；默认全部勾选 —— 未设置白名单就等于"显示全部模型"，选择会以「单模型覆盖」的形式保存在网页端编辑的 `visibleModels` 列表旁边，两个界面可以混用。

也可以在终端外配置 key。凭据解析先命中者生效，顺序如下：

- 组合配置里写死的字面量 `apiKey` 最优先，写了就一直用它。
- 否则按凭据引用解析（`apiKeyEnv`，默认 `COMMANDCODE_API_KEY`）。在 **Web、桌面端、SDK、ACP 等挂载了凭据服务的 profile** 里由凭据服务统一解析：**0.2.1-alpha.3 起已保存的凭据优先于启动环境变量**；更早的版本顺序相反，那时环境变量优先。
- **headless（无头）profile 有意不挂载凭据服务**，因此只有启动环境变量、项目 `.env`、`$DSH_HOME/.env` 生效 —— **在页面上保存过的 key 不会到达 headless 运行**，请为这类运行导出变量或写 `.env`。
- 最后兜底是官方 CLI 写入的 `~/.commandcode/auth.json`。

```sh
export COMMANDCODE_API_KEY="user_..."   # 启动环境变量
cmd login                               # 写入 ~/.commandcode/auth.json
```

**把 Command Code 设为默认模型。** dsh-TUI 写死了自己的 agent 路由，它的 `agent-default-model` 设置不会覆盖它。请在自己的 profile patch（`$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`）里覆盖 `agent-loop` 行：

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

## 用量面板

插件注册了 `/commandcode` 斜杠命令，显示各账户的用量状态：

```text
/commandcode        （或 /commandcode status）
```

命令的文案跟随 shell 的语言设置：在 `llm-commandcode` 插件配置里显式写 `lang: 'en' | 'zh'` 优先；否则读 `LC_ALL`/`LANG`；再否则回退到 `zh`。web 设置页是独立表面，跟随浏览器自身的语言偏好。

## 多账户轮换

有多个 Command Code 订阅时，插件可以在一个账户达到用量限额后**自动切换到下一个账户**：

- **配置**：在 **设置 → Command Code** 的「账户」卡片点击「添加账户」，然后选择「网页登录」（在浏览器授权后自动保存 key；登录未完成不会留下空账户）或「粘贴密钥」。添加、重命名、更换或清除密钥、移除、固定等账户操作**立即生效**，无需点击页面底部的「保存」；「保存」只作用于页面上的其他设置。顶层 key 始终是第一顺位的 `default` 账户。
- **手动切换**：在账户行的「⋯」菜单中选择「固定使用此账户」即可指定优先账户；所选账户耗尽时自动回落到其他账户，窗口重置后自动恢复。「取消固定」回到自动轮换。
- **专用模型**：展开某个账户，从实时模型目录**多选**它的「专用模型」。请求这些模型且该账户可用时使用该账户；账户耗尽或密钥失效时自动回落到常规轮换。一个模型同一时间只属于一个账户，给另一个账户选择它会自动移过去（仍保存为 `modelAccountRules`）。
- **只显示常用模型**：在「模型与上下文」卡片的「可见模型」中勾选要保留的模型，模型选择器只列出这些；不勾选则显示全部（默认行为不变）。

每个账户行直接显示套餐、状态以及 5 小时 / 每周额度条，展开可查看完整报告，也可运行 `/commandcode`。刷新到某个窗口已用满时，该账户同时退出自动选择，直到窗口重置。等价的 YAML 见[配置](#配置)一节。

## 配置

**设置 → Command Code** 把选项分为：**账户**（密钥、网页登录、实时额度、固定账户、专用模型）、**模型与上下文**（隐藏套餐外模型、可见模型、上下文长度、输出上限）、**隐私与安全**（零数据保留）、**集成与显示**（联网搜索、侧边栏额度卡片）、**高级设置**（API 地址、超时、传输重试、图片卸载）。同一组选项也位于 `$DSH_HOME/settings.yaml`，修改即刻生效，无需重启：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY        # 第一顺位（default）账户
  activeAccount: COMMANDCODE_API_KEY_2   # 可选：手动指定当前账户
  accounts:                              # 可选：之后的轮换顺序
    - label: Go #2
      apiKeyEnv: COMMANDCODE_API_KEY_2
  modelAccountRules:                     # 可选：按模型路由到账户（第一条命中生效）
    - models:                            # 目录模型 id（可多选）
        - deepseek/deepseek-v4-pro
      account: COMMANDCODE_API_KEY_2
  visibleModels:                         # 可选：只在选择器中显示这些模型；不填显示全部
    - deepseek/deepseek-v4-pro
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project           # 可选
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 300000              # 默认 300s（与官方 CLI 一致）
  streamIdleTimeoutMs: 300000           # 默认 300s
  # offloadSeenImagesForCache: true     # 可选：模型回复后不再重发旧图片
  showSidebarQuota: true                 # 可选：侧边栏套餐与配额卡片（默认关闭）
  zdr: true                              # 可选：只经由零数据保留上游（默认关闭）
  # contextWindow: 131072                # 可选：对所有模型的自定义上下文长度
  # contextWindowOverrides:              # 可选：按模型的上下文长度；优先于 contextWindow
  #   deepseek/deepseek-v4-pro: 65536
  # maxOutputTokens: 65536               # 可选：单轮输出上限；0 = 不发送 max_tokens
```

### 上下文、输出与图片调节

| 配置项 | 作用 |
|---|---|
| `contextWindow`、`contextWindowOverrides` | 替换模型目录里的 `context_length` —— 宿主据此计量上下文并触发压缩（issue #86）。目录值偏大时会话会撞上 `context_length_exceeded`，偏小时又会过早压缩，用它把窗口调成模型真实容量。取值必须是 1 – 10 000 000 的整数 token，接受 `32K`/`1M` 简写。 |
| `maxOutputTokens` | 单轮 `max_tokens` 上限。插件每次请求本来就带 `max_tokens`，取「模型公布上限、运行时学到的上限、网关上限 131 072」三者最小 —— 被动硬限制，到点平台直接切断，模型收不到任何提示。填正整数只能**收紧**；填 `0` 则**不发送**该字段，这是「长回答写到一半被切断」的解法（`0` 只对 CLI 与 OpenAI 两条传输生效，Claude 走的 Anthropic Messages 端点必填该字段）。留空表示**清除**该配置，不是写入 0。 |
| `offloadSeenImagesForCache` | 在 CLI 传输上，即使此前所有请求消息逐字节一致，新图片也可能让服务端报告的缓存命中量退回第一张历史图片处。开启后，同一模型看过图片并回复后，旧图会被替换成稳定文字占位，后续文本更容易保持缓存。它只能缓解费用上涨，未修复 Command Code 服务端的多模态缓存行为；模型如需重新查看已 offload 的图片，必须重新读取原文件。默认关闭。[实测证据](docs/issue-64-cache-review.md)。 |

## 联网搜索

当你的 dsh 部署加载了 web 能力（`@deepseek-ai/dsh-web` + `@deepseek-ai/dsh-tool-web`）时，模型所用的 `web_search` 工具会由本插件的 `commandcode` 搜索 provider 承载 —— 它用**与聊天相同的 API key 与 base URL** 调用 Command Code Provider API 的 `/alpha/web-search` 端点，无需另外配置搜索 key、端点或模型。

**默认开启。** 插件的 **设置 → Command Code** 页里有一个「用 Command Code 承载联网搜索」开关（`webSearch`），开启时插件会自动把 `commandcode` 选为当前搜索后端；关闭则把选择权交还给之前的后端（比如 modsearch 等其他搜索插件可继续工作 —— 不会被强制回退到 dsh 自带的 DeepSeek 搜索）。该开关在**下一次搜索时生效**，无需重启。

- 该 provider 仅在 web 服务存在时以 `commandcode` 注册进 `ctx.web`；没有它，本插件仍是纯聊天插件。
- 若官方「网页搜索」设置里已显式选择其他后端，那个显式选择优先：插件让 `commandcode` 保持已注册但未被选中，并把这一状态报出来，而不是覆盖对方。只有在没人 pin 该字段时才接管，并记住被顶掉的后端，在关闭开关或卸载插件时恢复。若想更稳妥地固定，可设置 `searchProvider: commandcode`（或 `$DSH_WEB_SEARCH_PROVIDER=commandcode`）。
- dsh 工具的 `numResults` 会被收敛到 Command Code 的取值范围（1–10，默认 5）；结果映射为 dsh 的 `WebSearchSource` 结构（`url`/`title`/`snippet`）。

> 这里直接使用 Command Code Provider API（与官方 CLI 内置的 `web_search` 相同），因此与 DeepSeek 原生搜索后端不同。

## 零数据保留（ZDR）

Command Code 可以让请求只经由「不留存提示词与回复、也不用于训练」的上游 —— 官方 CLI 的开关是 `CMD_ZDR=1`，Provider API 上则是在请求头发 `x-cmd-zdr: 1`（[官方文档](https://commandcode.ai/docs/resources/zdr)）。

**默认关闭。** 在「隐私与安全」卡片里打开「零数据保留（ZDR）」（`zdr`），或写进 profile 配置。

- 开启后，**每次聊天请求**都会带上 ZDR 请求头。没有可用 ZDR 上游的模型，服务端返回 `422 cmd_zdr_no_providers`；插件不会去掉请求头重试。
- 万一仍被拒绝（名单过期，或那一刻没有空闲的 ZDR 上游容量），错误信息会说明原因并给出关闭 ZDR 的办法，而不是抛出一个光秃秃的 HTTP 422。
- **ZDR 通常更贵**：容量有限，按各上游实价透传计费，且每次请求落在哪个上游可能不同。会话费用读数仍按常规目录价估算；真实单价见 Command Code Studio 的用量页。

## 注意事项与限制

- **图片输入按模型能力限制**：仅 Vision 模型接受图片，纯文本模型会直接拒绝；含图片的会话切换到纯文本模型会被 dsh 拒绝。适配器按实际发送的目标上报图片尺寸（长边 1568、编码后上限 1 MiB）；服务端对单次请求体也有上限（约 50 MB，官方未公开），超出预算的最旧图片会被替换成一段标明附件的"图片已省略"文字，仍被判为过大的请求会先以更小的图片预算重试一次。
- **不支持 `stop` 序列**：携带它的请求会报错。
- **两条传输都会重放历史推理内容**，使工具调用循环保留思维链：`/provider/v1/chat/completions` 以 `reasoning_content` 回传，`/alpha/generate` 则在重建的 assistant 轮次里带上 `reasoning` 块。两种传输都只重放带配对工具结果的工具调用。
- **工具参数 schema 会被归一化**到服务端要求的对象根上，因此未声明对象根的工具（第三方插件手写的 schema、MCP 服务自己的 `inputSchema`、生成的根 `$ref`）不再会让整个回合以 `schema must be a JSON Schema of 'type: "object"'` 失败。
- 模型目录无需 key 即可浏览；对话请求需要 key。

## 权限与隐私

本插件只在本地与你的 Command Code 账号之间通信：本地仅读写凭据存储与模型缓存文件（兜底读取 `~/.commandcode/auth.json`）；网络仅访问 Command Code API。无遥测。打开**零数据保留**（同样默认关闭）后，聊天请求必须经由 ZDR 上游；没有可用 ZDR 上游的模型会报错，不会按常规方式继续发送。

## 关闭 / 卸载

- **禁用**（不删除）：编辑你 profile 的 `cordis.patch.yml`，注释掉（或移除）`llm-commandcode` 行，或设置 `disabled: true`，然后重启。
- **完全卸载**：`dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider`。你在 dsh 凭据库和 `~/.commandcode/auth.json` 中的 API key 不会被改动。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

在 profile 里试用本地构建：`dsh plugin --profile web add /path/to/dsh-commandcode-provider`。修改 `src/` 后需重新运行 `npm run build` 并重启应用。

发布包提供插件根入口、`/client` 网页入口、`/locale/*.json` 语言包及 `/package.json` 元数据。源码只保存在仓库中；未发布的 `./src/*` 不再列入导出声明。`npm run test:pack` 根据实际打包文件核对入口。

## 参考文档

本 README 背后的工程细节在 [`docs/agent-reference/`](docs/agent-reference/) 下：

- [适配器与线上协议](docs/agent-reference/adapter-protocol.md) —— 传输、流式、图片、工具调用、推理重放、输出预算、ZDR 请求头
- [账号与重试](docs/agent-reference/accounts-and-retry.md) —— 凭据解析、账户轮换、限流、联网搜索的选择规则
- [客户端与设置](docs/agent-reference/client-and-settings.md) —— 设置页、网页登录、终端设置、模型选择
- [用量与成本](docs/agent-reference/usage-and-cost.md) —— 会话费用读数、价格快照、压缩计费
- [引擎兼容](docs/agent-reference/engine-compatibility.md) —— 支持的 dsh 版本、peer 范围、`engines.dsh` 准入
- [模型目录](docs/agent-reference/model-catalog.md) —— 目录同步、套餐档位、推理档位、优惠、ZDR 例外集

## 社区与反馈

[GitHub 仓库](https://github.com/Mars-Sea/dsh-commandcode-provider) · [GitHub Releases](https://github.com/Mars-Sea/dsh-commandcode-provider/releases) · [npm 包](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider) · [Linux.do 社区](https://linux.do/)

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。部分内容移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。
