非官方 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 LLM provider 插件，把 **Command Code** 接入 dsh：一条 `dsh plugin add` 即可获得 `commandcode` 路由与实时模型目录。

## 提供什么

- **实时模型目录** —— 模型选择器里标注套餐档位、折扣 / `FREE` 徽章、峰谷时段、图片支持与上下文长度，免费模型置顶。
- **多账户轮换** —— 一个账户用量打满后自动切到下一个；可固定优先账户，也可把模型指派给专用账户。
- **设置页** —— 账户（密钥、网页登录、实时额度、专用模型）、模型显示、隐私开关与连接参数。
- **套餐与配额面板** —— 可选的侧边栏卡片，显示当前服务账号的套餐、5 小时 / 每周两个配额窗口、余额与重置时间。
- **会话费用估算与模型分析** —— 输入框 token 计数旁显示估算金额（`≈`），`/commandcode` 查看分账户用量报告。
- **联网搜索与零数据保留** —— `web_search` 工具由 Command Code 承载；可选 ZDR 路由（`x-cmd-zdr: 1`），默认关闭。

## 开始使用

1. 安装：`dsh plugin --profile web add @mars-sea/dsh-commandcode-provider@latest`
2. 准备 API key：在设置页点「登录 Command Code」走官方授权流程，或粘贴在 [Keys 设置页](https://commandcode.ai/mars-sea/settings/keys) 创建的 key，或 `export COMMANDCODE_API_KEY="user_..."`。
3. 在 **设置 → Command Code** 里配置账户与模型显示；`/model` 会列出带标注的 Command Code 目录。

## 注意

- 需要自己的 Command Code 账号、API key 或订阅，并遵守其服务条款。本项目与 Command Code, Inc. 无关。
- 需要 Node.js **24.9+**，以及 dsh `>=0.2.1-rc.2 <0.2.2-0` 或 `>=0.2.2-alpha.2 <0.2.3-0`。
- 插件只在本地与你的 Command Code 账号之间通信，无遥测。
