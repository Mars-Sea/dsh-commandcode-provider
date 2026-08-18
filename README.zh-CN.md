# dsh-commandcode-provider

[English](./README.md) | **简体中文**

[![Awesome](https://awesome.re/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![GitHub Repo stars](https://img.shields.io/github/stars/Mars-Sea/dsh-commandcode-provider?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/stargazers)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Mars-Sea/dsh-commandcode-provider/pulls)
[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)

非官方 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 LLM provider 插件，用于 **Command Code**，移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT 协议）。它注册了一个 `commandcode` provider，将请求转换为 Command Code 的 Provider API（`POST /alpha/generate`，由 pi 插件逆向工程，对应 `command-code@1.27.1`）。

> 这是一个社区集成。你需要自己的 Command Code 账号、API key 或订阅，并遵守 Command Code 的服务条款。本项目与 Command Code, Inc. 无关。

## 功能一览

- **插件包**：可通过 `dsh plugin add` 安装到任意 dsh 配置，并提供 **`commandcode` provider 路由**，带实时模型目录（`GET {apiBase}/provider/v1/models`，缓存于 `~/.commandcode/models-cache.json`）。
- **专属"Command Code"设置页**（设置 → **Command Code**），带 **API key 输入框**、连接参数（API 地址、工作目录、请求/流超时）、**实时「账户用量」卡片**（统计、额度、窗口进度条、订阅套餐徽章）以及**「隐藏套餐外模型」开关**。密钥通过 dsh 凭据服务存储；连接参数写入 `llm-commandcode` 设置段，对下一次请求即刻生效，无需重启。
- **API key 解析顺序**：`config.apiKey` → 凭据引用 `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`）→ 启动环境变量 → 官方 CLI 认证文件（`~/.commandcode/auth.json`，由 `command-code login` 写入）。
- **模型选择器标注**：每个模型显示包含它的**最低套餐**（`KNOWN_PLANS`）、**活动折扣**或 `FREE` 徽章（`KNOWN_DEALS`，到期自动隐藏已失效折扣）、峰谷定价模型的**当前时段状态**（`Peak`/`Half`，按当前 UTC 小时动态判断）、Vision 模型的 **`Image`** 标记，以及**上下文长度**（`1M` / `256K` / `262K`）——例如 *"Go · 50% off · Image · 1M"*、*"Go · Half · 1M"*。列表**按套餐排序**（Go → GOAT → Pro → Provider/Max），你当前套餐能用的模型总是排在最前。
- **按套餐过滤选择器**：选择器会**直接隐藏超出你订阅套餐的模型**（根据账户账单状态实时判断）。全程失败开放——账单接口不可用、套餐未知，或账户持有按需余额（官方 CLI 视为解锁全部模型）时都显示完整目录——服务端仍是最终闸门。在设置页关闭「隐藏套餐外模型」开关（或在 `llm-commandcode` 设置段中设 `filterModelsByPlan: false`）可始终列出全部模型。
- **推理强度（reasoning-effort）支持**：针对官方目录标为推理模型的模型（`KNOWN_EFFORTS`，与 `command-code@1.27.1` 一致）；没有可选档位但仍支持思考的模型会自动思考，与官方 CLI 行为完全一致。
- **支持视觉模型的图片输入**（通过 dsh 附件服务、以官方 wire 格式发送）；纯文本模型会明确拒绝图片（`UNSUPPORTED_CONTENT`）而非静默丢弃。

<img src="assets/screenshots/model-picker.png" alt="带套餐、折扣、图片与上下文标注的模型选择器" width="250">

## 获取 API key

Command Code 的 API key 永不过期。最简单的途径是官方 CLI（Node.js 22+）：

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux；Windows 原生版：cmdc login
```

`cmd login` 会打开浏览器认证；成功后 key 写入 `~/.commandcode/auth.json`——本插件会自动读取（最后兜底）。也可以直接在浏览器创建 key（[Command Code Studio](https://commandcode.ai/studio/auth/cli)）并粘贴到 **设置 → Command Code**，或 `export COMMANDCODE_API_KEY="user_..."`。

## 安装

### 从 npm 安装（推荐）

npm 上裸名 `dsh-commandcode-provider` 已被无关包占用，因此本插件以 **`@mars-sea/dsh-commandcode-provider`** 发布：

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### 从 GitHub 安装

```sh
# 推荐：锁定发布 tag（可读、不可变）
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.2.2
# 或按完整 commit SHA 锁定任意提交
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>
```

`#<ref>` 后缀把源码锁定到**某一个精确版本**（pnpm 的 git 依赖语法）。不加 `#` 则跟随默认分支，后续 push 会悄悄改变你装到的内容。

git 安装会拉取**源码**，因此包的 `prepare` 脚本会在安装后构建 `lib/`。pnpm ≥10 默认阻止该脚本——先运行 `add`，再把 pnpm 打印的**确切包 key** 复制到 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@mars-sea/dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>': true
```

然后重新运行 `add`。

### 从本地检出安装

```sh
npm install
npm run build                          # git/压缩包安装通过 `prepare` 自动执行
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

修改 `src/` 后需重新运行 `npm run build` 并重启应用。

### 安装做了什么

`dsh plugin add` 会把包链接到配置目录（pnpm 按**真实包名** `@mars-sea/dsh-commandcode-provider` 记录），追加到 `dsh.profile.bundles`，并激活 `cordis.patch.yml` 层：

```yaml
- insert:
    - id: llm-commandcode
      name: "@mars-sea/dsh-commandcode-provider"
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

patch 里的 `name` 必须是**带引号的完整包名**——loader 会把它当作模块从 profile 的 `node_modules` 导入，而 pnpm 只会链接带 scope 的名字。写成裸名会报 `ERR_MODULE_NOT_FOUND` 并在启动时崩溃；不引号的 `@mars-sea/...` 会导致 YAML 解析失败（见[故障排查](#故障排查)）。

验证合成后的层，然后（重新）启动 Web 应用：

```sh
dsh --profile web --dump-config          # 会显示 "# == @mars-sea/dsh-commandcode-provider" 层
dsh web                                  # 或重启你正在运行的实例
```

## 更新

patch 层在每次启动时都从**已安装的包**读取，更新包本身就会带入修复后的行——**不需要**手工改 `cordis.patch.yml`（除非你把它的内容复制到了自己 profile 的层里）。

```sh
# npm：总是升到最新发布版本
dsh plugin --profile web update @mars-sea/dsh-commandcode-provider

# GitHub（按 tag）：指向新 tag——无需先卸载，pnpm 会就地替换
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.2.2

# 本地检出：拉取、重新构建、重启
git -C /path/to/dsh-commandcode-provider pull
npm run build --prefix /path/to/dsh-commandcode-provider
dsh web
```

然后重启 Web 应用。用 `dsh --profile web --dump-config` 验证——层里应显示 `name: '@mars-sea/dsh-commandcode-provider'`。

> **`update` 提示 "Already up to date" 但版本没变（pnpm ≥ 11）？** pnpm 11 的 `minimumReleaseAge` 供应链策略可能拒绝刚发布的新版本。请改用显式版本：`dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@0.2.2`（或在 profile 目录里 `pnpm config set minimumReleaseAge 0 --location project`）。

> **从 ≤0.1.6 升级**（或手改坏的 profile）：如果你之前**手工复制**过旧的 patch 行到你 profile 自己的 `cordis.patch.yml`，那份拷贝会覆盖 bundle 层——请改成 `name: "@mars-sea/dsh-commandcode-provider"` 或删掉它（见[故障排查](#故障排查)）。

> **想卸载而不是升级**：`dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider`（用 **scoped** 名——pnpm 按真实包名记录依赖）。你在 dsh 凭据库和 `~/.commandcode/auth.json` 里的 API key 不受影响。

## 验证是否生效

重启后：**设置 → Command Code** 显示专属页面——填入 API key 并点击**保存**（徽章变为"已配置"即表示 Host 已存储）。**设置 → Models** 会显示 **Command Code** 卡片；模型选择器会在 **commandcode** 下列出实时目录。发送消息并选择你套餐中包含的模型——`deepseek/deepseek-v4-flash` 适用于入门级套餐，开放权重模型（DeepSeek/Qwen/Kimi/MiniMax）通常都可用，而前沿模型（Claude/GPT/Gemini/Grok）可能需要 Pro/Max 套餐或按需计费。

## 用量面板

插件注册了一个 `/commandcode` 斜杠命令（需要 dsh 的 `commands` 服务，标准 web profile 自带），从官方账户端点显示你的账户状态：

```text
/commandcode        （或 /commandcode status）
```

![用量面板](assets/screenshots/usage-dashboard.png)

每个端点独立降级——某个端点临时失败不会影响其他数据，并会在末尾内联提示失败。

## 配置

**设置 → Command Code** 是主要配置入口：**API key** 输入框（通过凭据服务存储在 `$DSH_HOME/.credentials.yaml`，只写不回显，并显示是否已配置），以及 **API 地址**、**工作目录**、**请求/流超时**字段，全部写入 `llm-commandcode` 设置段。没有 key 也可以浏览模型目录。**工作目录可选**——留空即可，占位符会显示它实际使用的进程 cwd。

配置好 key 后，页面顶部会显示实时**「账户用量」卡片**——与 `/commandcode` 相同的账户、花费、额度与窗口限制信息，外加订阅套餐徽章和账期截止——数据在宿主端获取（key 不会离开宿主），并以原生 UI 渲染：

<img src="assets/screenshots/settings-page.png" alt="Command Code 设置页面（含账户用量卡片）" width="640">

同一组选项也位于 `$DSH_HOME/settings.yaml`（按请求覆盖，无需重启）：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # 每次请求解析的凭据引用
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # 上报给 API（项目 slug、配置块）
  modelsCachePath: ~/.commandcode/models-cache.json
  requestTimeoutMs: 60000          # 等待首个响应字节的最长时间（默认 60s）
  streamIdleTimeoutMs: 300000      # 流停顿超过该时长即视为死连接（默认 300s——刻意放宽，避免切断长思考模型）
```

组合入口配置（`cordis.patch.yml`）接受相同的键；那里的字面量 `apiKey` 优先于凭据引用。

## 故障排查

- **`Command Code API request to .../alpha/generate failed`，且不停重试** ——这是**传输层失败**：`fetch()` 根本没拿到 HTTP 响应（401/403/429 会显示 "API error"）。0.1.8 起错误消息会点名**真实根因**（`ECONNREFUSED`、`ENOTFOUND`、`CERT_HAS_EXPIRED`、`socket hang up` 等）。常见原因：**需要代理**（Node 的 `fetch`/undici 不读取 `HTTP_PROXY`/`HTTPS_PROXY`——配置 dispatcher 或把 `api.commandcode.ai` 加入白名单）、**连接被中途重置/限速**（防火墙、GFW 类干扰、Wi-Fi 不稳）、**TLS 被中间人替换**（企业 MITM），或只是重试能恢复的瞬时抖动。
- **长回答生成到一半中断** ——0.1.8 起，adapter 会在 `requestTimeoutMs`（60s）内拿不到首字节时中止，并在流停顿超过 `streamIdleTimeoutMs`（默认 300s）时判为死连接。两者都以 `TIMEOUT` 呈现并附带停顿时长；网络慢但稳定可调大这两个值。
- **推理模型思考较久时"反复重连"** ——流空闲看门狗原默认 120s，比前沿推理模型（xhigh/max effort）的静默思考期还短——它们可以数分钟不吐 token，而官方 CLI 根本不设空闲上限。0.2.3 起默认改为 **300s**；若极长思考仍触发误判，在 `llm-commandcode` 配置段或设置页调大 `streamIdleTimeoutMs`。
- **启动崩溃：`ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-commandcode-provider'`** ——patch 行的 `name` 是裸名，但 pnpm 只链接带 scope 的名字。改成 `name: "@mars-sea/dsh-commandcode-provider"`——注意**必须加引号**（不引号的 `@` 开头标量会导致 YAML 解析失败）——然后重启。
- **`MODEL_NOT_IN_PLAN` (403)** ——所选模型不在你的套餐内。选一个开放权重模型或升级套餐；错误会指明模型并附官方文档链接。
- **`MISSING_CREDENTIAL`** ——任何地方都没有 key。在设置页存一个、`export COMMANDCODE_API_KEY`、设置 `config.apiKey`，或运行 `command-code login`。没有 key 时路由与目录仍可浏览。
- **Models 卡片显示"未配置"但请求可用** ——key 来自 `~/.commandcode/auth.json`（`cmd login` 兜底），而非凭据存储。把它粘贴到卡片一次即可；两者可共存。
- **推理模型在短请求下不返回可见文本** ——它先消耗输出 token 做推理；`maxTokens` 较小时可能在可见文本前就用完。属正常现象。
- **git 安装时 `dsh plugin add` 报 `allowBuilds` 错误** ——把 pnpm 打印的确切包 key 复制到 `pnpm-workspace.yaml` 并重新运行（见[从 GitHub 安装](#从-github-安装)）。

## 注意事项与限制

- **图片输入按模型能力限制**：只有官方注册表标记为 Vision 的模型接受图片（见 `src/adapter.ts` 的 `KNOWN_IMAGE_MODELS`）。纯文本模型会抛 `UNSUPPORTED_CONTENT`；官方 CLI 对纯文本模型的客户端 *VISION* 副调用在此**不复现**——请改用支持 Vision 的模型。图片输入还需要 dsh 的**附件服务**。
- **在含图片的会话里切换到纯文本模型会被 dsh 自身拒绝**——这是 harness 层的守卫（`dsh-host-apiproxy` 的 `selectModel`），无法从插件侧放宽。本 bundle 通过客户端插件让提示更友好：把拒绝改写为「当前会话已包含图片，而模型 `<model>` 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。」（错误码与 details 原样透传）。选择带 *`Image`* 标记的模型、先移除图片，或安装图片路由 bundle（如 `@deepseek-ai/dsh-llm-image-routing`）。
- **不支持 `stop` 序列**（线上格式没有该字段）：携带它的请求会抛 `UNSUPPORTED_OPTION`。
- 推理块**不会**重放到后续轮次（与官方 CLI 一致）；只有带配对工具结果的工具调用会被重放。
- 模型目录端点是公开的；`/alpha/generate` 需要你的 key。

## 权限与隐私

本插件完全在你的 dsh profile 和你的 Command Code 账号内运行。**本地文件**：仅在最后兜底时读取 `~/.commandcode/auth.json`；读写 `~/.commandcode/models-cache.json`；通过标准凭据 seam 从 `$DSH_HOME/.credentials.yaml` 读取 key（永不记录日志）。**网络**：`GET {apiBase}/provider/v1/models`（公开目录）与 `POST {apiBase}/alpha/generate`（你的请求，已认证），请求体包含你配置的 `workingDir`。**无遥测**——唯一的对外主机是 Command Code API（默认 `api.commandcode.ai`，可通过 `apiBase` 配置）。

## 关闭 / 卸载

- **禁用**（不删除）：编辑你 profile 的 `cordis.patch.yml`，注释掉（或移除）`llm-commandcode` 行，或设置 `disabled: true`，然后重启。
- **完全卸载**：

  ```sh
  dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
  ```

  这会移除 bundle 依赖及其配置层；你在 dsh 凭据库和 `~/.commandcode/auth.json` 中的 API key 不会被改动。

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
