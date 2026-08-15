# dsh-commandcode-provider

[English](./README.md) | **简体中文**

[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

非官方 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 LLM provider 插件，用于 **Command Code**，移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT 协议）。它注册了一个 `commandcode` 模型 provider，将请求转换为 Command Code 的 Provider API（`POST /alpha/generate`，由 pi 插件逆向工程，对应 `command-code@1.26.0`）。

> 这是一个社区集成。你需要自己的 Command Code 账号、API key 或订阅，并遵守 Command Code 的服务条款。本项目与 Command Code, Inc. 无关。

## 功能一览

- **插件包**：可通过 `dsh plugin add` 安装到任意 dsh 配置（npm 包，带 `dsh.bundle` 层）。
- **`commandcode` provider 路由**：注册在 `llm` 服务上，可在模型选择器中选择，并带 **实时模型目录**（从 `GET {apiBase}/provider/v1/models` 拉取，缓存于 `~/.commandcode/models-cache.json`）。
- **Models 页面卡片**（"Command Code"）带 API key 输入框——凭据通过 dsh 凭据服务存储，与 DeepSeek 卡片一致。
- **API key 解析顺序**：`config.apiKey` → 凭据引用 `apiKeyEnv`（Web Models 页面写入，默认 `COMMANDCODE_API_KEY`）→ 启动环境变量 → 官方 Command Code CLI 认证文件（`~/.commandcode/auth.json`，由 `command-code login` 写入）。
- **推理强度（reasoning-effort）支持**：针对 Command Code 目录中标为推理模型的模型（如 `claude-opus-5`、`gpt-5.5`、`deepseek/deepseek-v4-pro` 等），通过 `KNOWN_EFFORTS` 实现，与官方 command-code@1.26.0 内置目录一致。
- **支持视觉模型的图片输入**：官方注册表中带 Vision 能力的模型（如 `claude-sonnet-5`、`gpt-5.4`、`google/gemini-3.5-flash` 等）可接收附加图片——通过 dsh 附件服务解析字节，并以官方 Command Code wire 格式发送。纯文本模型（如 `deepseek/deepseek-v4-flash`、`zai-org/GLM-5.3`）会明确拒绝图片而非静默丢弃。

## 获取 API key

Command Code 的 API key 永不过期。最简单的途径是官方 CLI（Node.js 22+）：

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux；Windows 原生版：cmdc login
```

`cmd login` 会打开浏览器进行认证；成功后 key 写入 `~/.commandcode/auth.json`——本插件会自动读取（最后兜底）。也可以直接在浏览器创建 API key（[Command Code Studio](https://commandcode.ai/studio/auth/cli)）并粘贴到 Models 页面的卡片中，或者 `export COMMANDCODE_API_KEY="user_..."`。

## 安装

### 从 npm 安装（推荐）

插件发布在 npm 上，包名 **`@mars-sea/dsh-commandcode-provider`**（npm 上裸名 `dsh-commandcode-provider` 已被无关包占用）：

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### 从 GitHub 安装

```sh
# 推荐：锁定发布 tag（可读、不可变）
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.8
# 或按完整 commit SHA 锁定任意提交
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>
```

`#<ref>` 后缀用于将源码锁定到**某一个精确版本**（pnpm 的 git 依赖语法：可以是 tag、分支或 commit SHA）。不加 `#` 则跟随默认分支，后续的 push 会悄悄改变你装到的内容——请固定 tag 或 commit，并审计你要运行的代码。

git 安装会拉取**源码**，因此包的 `prepare` 脚本会在安装后构建 `lib/`。pnpm ≥10 默认会阻止该脚本——先运行 `add`，然后把 pnpm 打印的**确切包 key** 复制到 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@mars-sea/dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>': true
```

然后重新运行 `add`。只允许信任其源码的包（并固定 commit）。

### 从本地检出安装

```sh
npm install
npm run build                          # git/压缩包安装通过 `prepare` 自动执行
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

本地路径安装会按原样链接检出目录，因此修改 `src/` 后需重新运行 `npm run build` 并重启应用。

### 安装做了什么

`dsh plugin add` 会将包链接到配置目录（pnpm 按**真实包名**记录依赖并链接 `node_modules`，即 `@mars-sea/dsh-commandcode-provider`），把同名包名追加到配置的 `dsh.profile.bundles`，并激活 `cordis.patch.yml` 层，其中插入：

```yaml
- insert:
    - id: llm-commandcode
      name: "@mars-sea/dsh-commandcode-provider"
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

patch 行里的 `name` 必须是**带引号的完整包名**：loader 会把它当作模块从 profile 的 `node_modules` 导入，而 pnpm 只会链接带 scope 的名字。写成裸名 `dsh-commandcode-provider` 会报 `ERR_MODULE_NOT_FOUND` 并在启动时崩溃；不引号的 `@mars-sea/...` 也会导致 YAML 解析失败（见[故障排查](#故障排查)）。

验证合成后的层，然后（重新）启动 Web 应用：

```sh
dsh --profile web --dump-config          # 会显示 "# == @mars-sea/dsh-commandcode-provider" 层
dsh web                                  # 或重启你正在运行的实例
```

## 更新

bundle 的 patch 层在每次启动时都从**已安装的包**读取，所以更新包本身就会带入修复后的 patch 行——**不需要**手工改 `cordis.patch.yml`（除非你把它的内容复制到了自己 profile 的层里）。

按安装方式选择更新命令：

```sh
# 从 npm 安装（推荐）：总是升到最新发布版本
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider

# 从 GitHub 按 tag 安装：指向新 tag
# （无需先卸载——pnpm 会就地替换固定的版本，下次启动时 bundle 层会从新安装的包重新读取）
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.8

# 从本地检出安装：拉取新代码、重新构建、重启
git -C /path/to/dsh-commandcode-provider pull
npm run build --prefix /path/to/dsh-commandcode-provider
dsh web
```

然后重启 Web 应用（`dsh web`，或重启服务）。用 `dsh --profile web --dump-config` 验证运行的版本——层里应显示 `name: '@mars-sea/dsh-commandcode-provider'`。

> **从 ≤0.1.6 升级**（或手改坏的 profile）：安装包自带的 patch 层现在已经带着修正后的带引号 `name`。如果你之前**手工复制**过旧的 patch 行到你 profile 自己的 `cordis.patch.yml`，那份拷贝会覆盖 bundle 层——请手动改成 `name: "@mars-sea/dsh-commandcode-provider"`（见[故障排查](#故障排查)），或删掉它让 bundle 层生效。

> **想卸载而不是升级**（例如正卡在 0.1.7 之前坏掉的 tag，想干净重来）：`dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider`（用 **scoped 名**——pnpm 按真实包名记录依赖，裸名 `dsh-commandcode-provider` 对不上）。这会移除依赖及其配置层；你在 dsh 凭据库和 `~/.commandcode/auth.json` 里的 API key 不受影响。然后用上面的 npm 或 GitHub 命令安装当前版本。

## 验证是否生效

重启后，在 Web UI 中：**设置 → Models** 会显示 **Command Code** 卡片；模型选择器会在 **commandcode** 下列出实时目录（撰写本文时有 54 个模型）。发送一条消息，选择你套餐中包含的模型——默认的 `deepseek/deepseek-v4-flash` 适用于入门级套餐；开放权重模型（DeepSeek/Qwen/Kimi/MiniMax）通常都可用，而前沿模型（Claude/GPT/Gemini/Grok）可能需要 Pro/Max 套餐或按需计费（见 FAQ）。

## 用量面板

插件注册了一个 `/commandcode` 斜杠命令（需要 dsh 的 `commands` 服务，标准 web profile 自带），直接从官方账户端点显示你的 Command Code 账户状态：

```text
/commandcode        （或 /commandcode status）
```

输出示例（结构化文本 + Unicode 条形图）：

```text
📊 Command Code 用量 (mars-sea)

── 请求 ──────────────────────────────
  💬 请求    992 次 / 失败 0  成功率 100%
  💰 花费    $1.4446  ($1.44 credits)
  🔤 Token   205.3M 入 / 808.8K 出

── 信用 ──────────────────────────────
  💳 月额度  $8.54   (已购 $0.00 / 赠送 $0.00)
     └ ██████████  100%

── 窗口用量 ──────────────────────────
  ⏱ 5 小时  $0.18 / $3.00
     └ █░░░░░░░░░  重置 8/15/2026, 2:39:36 PM
  📅 每周    $1.46 / $6.00
     └ ██░░░░░░░░  重置 8/21/2026, 7:10:57 PM
```

每个端点独立降级：某个端点临时失败（如 credits 端点）不会影响其他数据，并会在末尾内联提示失败。

## 配置

Command Code 卡片接收你的 API key（存储在 `$DSH_HOME/.credentials.yaml`；没有 key 也可以浏览模型目录）。高级选项位于 `$DSH_HOME/settings.yaml` 的 `llm-commandcode` 一节（按请求覆盖 bundle 默认值，无需重启）：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # 每次请求解析的凭据引用
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # 上报给 API（项目 slug、配置块）
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # 等待首个响应字节的最长时间（默认 60s）
  streamIdleTimeoutMs: 120000      # 流停顿超过该时长即视为死连接（默认 120s）
```

组合入口配置（`cordis.patch.yml` / 你 profile 的 `cordis.patch.yml`）接受相同的键；那里的字面量 `apiKey` 优先于凭据引用。

## 故障排查

- **`Command Code API request to .../alpha/generate failed`，且每次会话都在重试（看到"重试延迟"）** ——这是**传输层失败**：`fetch()` 根本没拿到 HTTP 响应（不是 401/403/429，那些会显示 "API error"）。dsh 的重试策略会重试 `TRANSPORT` 两次（指数退避），所以 UI 里会先出现重试行，最终才失败。0.1.8 起失败原因会显示**真实根因**（例如 `fetch failed: connect ECONNREFUSED`、`ENOTFOUND`、`CERT_HAS_EXPIRED`、`The operation was aborted due to timeout`）。常见原因：
  - **你的网络需要代理**。Node 的 `fetch`（undici）**不读取** `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，所以浏览器/curl 走系统代理能通，而 dsh 进程直连失败。需要给 dsh 配置 undici 代理（例如 `NODE_OPTIONS=--import undici` + dispatcher，或网络层路由），或把 `api.commandcode.ai` 加入白名单。
  - **连接被中途重置/限速**（防火墙、GFW 类干扰、Wi-Fi 不稳）。错误消息会点名（`socket hang up`、`ECONNRESET`、`UND_ERR_SOCKET`）。
  - **TLS 被中间人替换**（企业 MITM）——错误链里出现 `CERT_HAS_EXPIRED`/`DEPTH_ZERO_SELF_SIGNED_CERT`。
  - 也可能是瞬时抖动，重试能恢复；如果每轮都失败，那是环境问题而非 API 问题（健康网络下 models 端点和 generate 端点都能正常响应）。
- **长回答生成到一半中断** ——0.1.8 起，adapter 会在 `requestTimeoutMs`（默认 60s）内拿不到响应时中止请求，并在流停顿超过 `streamIdleTimeoutMs`（默认 120s）时判定为死连接，不再无限挂起。这两种失败都以 `TIMEOUT` 呈现并附带停顿时长；如果你的网络慢但稳定，可以在 `llm-commandcode` 设置里调大这两个值。
- **Web 应用启动即崩溃，报 `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-commandcode-provider'`** ——patch 行的 `name` 写成了裸包名，但 loader 会把它当作模块从 profile 的 `node_modules` 导入，而 pnpm 只会链接带 scope 的名字 `@mars-sea/dsh-commandcode-provider`。0.1.7 之前的 bundle 自带的就是这行错误配置；手工复制旧的 `cordis.patch.yml` 示例（或缓存层）也会踩中。修复方法：把你 profile 的 `cordis.patch.yml` 中该行改成 `name: "@mars-sea/dsh-commandcode-provider"` ——注意**必须加引号**：不引号的 `@` 开头标量会导致 YAML 解析失败（0.1.7 就带了这处回归，0.1.8 已加引号）——然后重启。
- **`MODEL_NOT_IN_PLAN` (403)** ——所选模型不在你的 Command Code 套餐内。选择一个开放权重模型（如 `deepseek/deepseek-v4-flash`）或升级套餐。错误信息会指明模型并附官方文档链接。
- **`MISSING_CREDENTIAL`** ——任何地方都没有 key。通过 Models 页面卡片存储一个、`export COMMANDCODE_API_KEY`、设置 `config.apiKey`，或运行 `command-code login`。没有 key 时路由保持注册、目录保持可浏览。
- **Models 页面卡片显示"未配置"但请求可用** ——key 来自 `~/.commandcode/auth.json`（`cmd login` 兜底），而不是 dsh 凭据存储。把它粘贴到卡片一次即可让卡片显示为已配置；两者可以共存。
- **推理模型在短请求下不返回可见文本** ——推理模型（如 `deepseek/deepseek-v4-*`）会先消耗输出 token 进行推理；`maxTokens` 较小时可能在出现可见文本前就用完。这属于正常现象。
- **git 安装时 `dsh plugin add` 报 `allowBuilds` 错误** ——把 pnpm 打印的确切包 key（含 commit hash）复制到 `pnpm-workspace.yaml` 并重新运行（见[从 GitHub 安装](#从-github-安装)）。

## 注意事项与限制

- **图片输入按模型能力限制**：只有官方 Command Code 注册表标记为 Vision 的模型接受图片（见 `src/adapter.ts` 中的 `KNOWN_IMAGE_MODELS` 快照，与[官方模型注册表](https://commandcode.ai/docs/reference/cli/models)同步）。模型选择器会为每个 Command Code 模型标注 *"Supports image input"* / *"Text only"*，切换前即可看出能力。向纯文本模型发送图片会抛出 `UNSUPPORTED_CONTENT`。官方 CLI 对纯文本模型会回退到客户端 *VISION* 副调用转文字；本适配器**不**复现该交互功能——请改用支持 Vision 的模型。图片输入还需要 dsh 的**附件服务**（`ctx.attachments`）；缺失时携带图片的请求会抛出 `UNSUPPORTED_CONTENT`。
- **在含图片的会话里切换到纯文本模型会被 dsh 自身拒绝**——这是 harness 层的守卫（`dsh-host-apiproxy` 的 `selectModel` 处理器）：当会话历史或待处理输入已包含图片、而目标模型未声明 `image` 输入时，会返回 `model-unavailable`。该拒绝是刻意设计，无法从插件侧放宽（适配器提供的模型行正是让守卫生效的输入——纯文本模型如实上报 `inputModalities: ['text']`）。本 bundle **能**做的是让提示更友好：它的客户端插件会包装 `session.selectModel`，把这条拒绝改写为「当前会话已包含图片，而模型 `<model>` 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。」（错误码与 details 原样透传，按 `error.code` 分支的调用方不受影响）。要继续使用图片，请选择选择器中标注 *"Supports image input"* 的模型，或先清空会话中的图片；也可安装图片路由 bundle（如 `@deepseek-ai/dsh-llm-image-routing`）把图片轮透明路由到视觉回退模型。
- **不支持 `stop` 序列**：线上格式没有 stop 字段；携带它的请求会抛出 `UNSUPPORTED_OPTION`。
- 推理块**不会**重放到后续轮次（与官方 CLI 一致：先前的私有推理不得泄漏）。
- 只有带配对工具结果的工具调用会被重放到对话中。
- 模型目录端点是公开的；对 `/alpha/generate` 的请求需要上述 key。

## 权限与隐私

本插件完全在你的 dsh profile 和你的 Command Code 账号内运行。它触及的内容：

- **本地文件**
  - 仅在**最后兜底**时读取 `~/.commandcode/auth.json`（官方 CLI 登录文件）。
  - 读写 `~/.commandcode/models-cache.json`（模型目录缓存）。
  - 通过标准凭据 seam 从 dsh 凭据库（`$DSH_HOME/.credentials.yaml`）读取 API key——key 永不记录日志，也只会发送给 Command Code API。
- **网络**
  - `GET {apiBase}/provider/v1/models` —— 公开模型目录（无需 key）。
  - `POST {apiBase}/alpha/generate` —— 模型请求本身，使用你的 key 认证。
  - 请求体包含你配置的 `workingDir`（项目路径，默认进程 cwd），作为 Command Code 的 `config.workingDir` 发送。
- **无遥测**：无分析、无追踪、无第三方端点。唯一的对外主机是 Command Code API（默认 `api.commandcode.ai`，可通过 `apiBase` 配置）。

## 关闭 / 卸载

- **禁用**（不删除）：编辑你 profile 的 `cordis.patch.yml`，注释掉（或移除）`llm-commandcode` 行，或对其设置 `disabled: true`，然后重启 web 应用。
- **完全卸载**：

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  这会移除 bundle 依赖及其配置层。你在 dsh 凭据库和 `~/.commandcode/auth.json` 中的 API key 不会被改动（如需撤销访问权限，可手动删除）。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

## 社区与反馈

- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="GitHub" /> [GitHub 仓库](https://github.com/Mars-Sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/github/111827" width="16" alt="Releases" /> [GitHub Releases](https://github.com/Mars-Sea/dsh-commandcode-provider/releases)
- <img src="https://cdn.simpleicons.org/npm/111827" width="16" alt="npm" /> [npm 包](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
- <img src="https://cdn.simpleicons.org/discourse/111827" width="16" alt="Linux.do" /> [Linux.do 社区](https://linux.do/)

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。部分内容移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。
