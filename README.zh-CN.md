# dsh-commandcode-provider

[English](./README.md) | **简体中文**

[![CI](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-commandcode-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-@mars--sea%2Fdsh--commandcode--provider-blue.svg)](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider)
<a href="https://linux.do"><img src="https://ld.xh.do/ld-badge.svg" alt="linux.do" width="150"></a>

非官方 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 LLM provider 插件，用于 **Command Code**，移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT 协议）。它注册了一个 `commandcode` 模型 provider，将请求转换为 Command Code 的 Provider API（`POST /alpha/generate`，由 pi 插件逆向工程，对应 `command-code@1.15.1`）。

> 这是一个社区集成。你需要自己的 Command Code 账号、API key 或订阅，并遵守 Command Code 的服务条款。本项目与 Command Code, Inc. 无关。

## 功能一览

- **插件包**：可通过 `dsh plugin add` 安装到任意 dsh 配置（npm 包，带 `dsh.bundle` 层）。
- **`commandcode` provider 路由**：注册在 `llm` 服务上，可在模型选择器中选择，并带 **实时模型目录**（从 `GET {apiBase}/provider/v1/models` 拉取，缓存于 `~/.commandcode/models-cache.json`）。
- **Models 页面卡片**（"Command Code"）带 API key 输入框——凭据通过 dsh 凭据服务存储，与 DeepSeek 卡片一致。
- **API key 解析顺序**：`config.apiKey` → 凭据引用 `apiKeyEnv`（Web Models 页面写入，默认 `COMMANDCODE_API_KEY`）→ 启动环境变量 → 官方 Command Code CLI 认证文件（`~/.commandcode/auth.json`，由 `command-code login` 写入）。
- **推理强度（reasoning-effort）支持**：针对 Command Code 目录中标为推理模型的模型（如 `claude-opus-5`、`gpt-5.5`、`deepseek/deepseek-v4-pro` 等），通过 `KNOWN_EFFORTS` 实现，与 pi 插件对 `command-code@1.15.1` 的快照一致。

## 获取 API key

Command Code 的 API key 永不过期。最简单的途径是官方 CLI（Node.js 22+）：

```sh
npm i -g command-code@latest
cmd login        # macOS/Linux；Windows 原生版：cmdc login
```

`cmd login` 会打开浏览器进行认证；成功后 key 写入 `~/.commandcode/auth.json`——本插件会自动读取（最后兜底）。也可以直接在浏览器创建 API key（[Command Code Studio](https://commandcode.ai/studio/auth/cli)）并粘贴到 Models 页面的卡片中，或者 `export COMMANDCODE_API_KEY="user_..."`。

## 安装

### 从 GitHub 安装（推荐）

```sh
# 推荐：锁定发布 tag（可读、不可变）
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#v0.1.1
# 或按完整 commit SHA 锁定任意提交
dsh plugin --profile web add github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>
```

`#<ref>` 后缀用于将源码锁定到**某一个精确版本**（pnpm 的 git 依赖语法：可以是 tag、分支或 commit SHA）。不加 `#` 则跟随默认分支，后续的 push 会悄悄改变你装到的内容——请固定 tag 或 commit，并审计你要运行的代码。

git 安装会拉取**源码**，因此包的 `prepare` 脚本会在安装后构建 `lib/`。pnpm ≥10 默认会阻止该脚本——先运行 `add`，然后把 pnpm 打印的**确切包 key** 复制到 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  'dsh-commandcode-provider@github:Mars-Sea/dsh-commandcode-provider#<完整-commit-sha>': true
```

然后重新运行 `add`。只允许信任其源码的包（并固定 commit）。

### 从 npm 安装

发布为 **`@mars-sea/dsh-commandcode-provider`**（npm 上裸名 `dsh-commandcode-provider` 已被无关包占用）：

```sh
dsh plugin --profile web add @mars-sea/dsh-commandcode-provider
```

### 从本地检出安装

```sh
npm install
npm run build                          # git/压缩包安装通过 `prepare` 自动执行
dsh plugin --profile web add /path/to/dsh-commandcode-provider
```

本地路径安装会按原样链接检出目录，因此修改 `src/` 后需重新运行 `npm run build` 并重启应用。

### 安装做了什么

`dsh plugin add` 会将包链接到配置目录，把 `dsh-commandcode-provider` 追加到配置的 `dsh.profile.bundles`，并激活 `cordis.patch.yml` 层，其中插入：

```yaml
- insert:
    - id: llm-commandcode
      name: dsh-commandcode-provider
      config:
        apiKeyEnv: COMMANDCODE_API_KEY
```

验证合成后的层，然后（重新）启动 Web 应用：

```sh
dsh --profile web --dump-config          # 会显示 "# == dsh-commandcode-provider" 层
dsh web                                  # 或重启你正在运行的实例
```

## 验证是否生效

重启后，在 Web UI 中：**设置 → Models** 会显示 **Command Code** 卡片；模型选择器会在 **commandcode** 下列出实时目录（撰写本文时有 54 个模型）。发送一条消息，选择你套餐中包含的模型——默认的 `deepseek/deepseek-v4-flash` 适用于入门级套餐；开放权重模型（DeepSeek/Qwen/Kimi/MiniMax）通常都可用，而前沿模型（Claude/GPT/Gemini/Grok）可能需要 Pro/Max 套餐或按需计费（见 FAQ）。

## 配置

Command Code 卡片接收你的 API key（存储在 `$DSH_HOME/.credentials.yaml`；没有 key 也可以浏览模型目录）。高级选项位于 `$DSH_HOME/settings.yaml` 的 `llm-commandcode` 一节（按请求覆盖 bundle 默认值，无需重启）：

```yaml
llm-commandcode:
  apiKeyEnv: COMMANDCODE_API_KEY   # 每次请求解析的凭据引用
  apiBase: https://api.commandcode.ai
  workingDir: /path/to/project     # 上报给 API（项目 slug、配置块）
  modelsCachePath: ~/.commandcode/models-cache.json
```

组合入口配置（`cordis.patch.yml` / 你 profile 的 `cordis.patch.yml`）接受相同的键；那里的字面量 `apiKey` 优先于凭据引用。

## 故障排查

- **`MODEL_NOT_IN_PLAN` (403)** ——所选模型不在你的 Command Code 套餐内。选择一个开放权重模型（如 `deepseek/deepseek-v4-flash`）或升级套餐。错误信息会指明模型并附官方文档链接。
- **`MISSING_CREDENTIAL`** ——任何地方都没有 key。通过 Models 页面卡片存储一个、`export COMMANDCODE_API_KEY`、设置 `config.apiKey`，或运行 `command-code login`。没有 key 时路由保持注册、目录保持可浏览。
- **Models 页面卡片显示"未配置"但请求可用** ——key 来自 `~/.commandcode/auth.json`（`cmd login` 兜底），而不是 dsh 凭据存储。把它粘贴到卡片一次即可让卡片显示为已配置；两者可以共存。
- **推理模型在短请求下不返回可见文本** ——推理模型（如 `deepseek/deepseek-v4-*`）会先消耗输出 token 进行推理；`maxTokens` 较小时可能在出现可见文本前就用完。这属于正常现象。
- **git 安装时 `dsh plugin add` 报 `allowBuilds` 错误** ——把 pnpm 打印的确切包 key（含 commit hash）复制到 `pnpm-workspace.yaml` 并重新运行（见[从 GitHub 安装（推荐）](#从-github-安装推荐)）。

## 注意事项与限制

- **目前仅支持文本**：图片输入会抛出 `UNSUPPORTED_CONTENT`（接入附件服务以解析图片字节是后续工作）。有意不声明 pi 插件的 `MODEL_INPUT_MODALITIES` 表。
- **不支持 `stop` 序列**：线上格式没有 stop 字段；携带它的请求会抛出 `UNSUPPORTED_OPTION`。
- 推理块**不会**重放到后续轮次（与官方 CLI 一致：先前的私有推理不得泄漏）。
- 只有带配对工具结果的工具调用会被重放到对话中。
- 模型目录端点是公开的；对 `/alpha/generate` 的请求需要上述 key。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown -> lib/
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。部分内容移植自 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。
