# 问题 #124：OpenAI 占位 choice 用量丢失

- 问题：https://github.com/Mars-Sea/dsh-commandcode-provider/issues/124
- 验证日期：2026-11-12（Asia/Shanghai）
- 修复前基线：`6cfff97` 的已跟踪构建产物；本地回归测试先在修改解析器之前执行。

## 测试边界

用户确认通过公开 `CommandCodeAdapter.stream()` 接口观察行为，并补充真实网关验证。

回归测试只在 HTTP 边界注入分包 SSE 响应，使用真实适配器完成读取、装配、用量映射与结束交付，不调用私有解析函数。它验证宿主能收到什么，不验证浏览器统计区的实际渲染。

## 复现与修复计划

1. 按 issue 的原始用量形状构造响应：正文、`finish_reason: "stop"`、占位 choice 加 usage、`[DONE]`，每次读取分别提供一个网络包。
2. 断言公开接口应在成功结束前交付一份完整用量。先运行此测试：原解析器只交付 finish，缺少 usage，退出码 1。
3. 将 OpenAI 事件级 usage 的提取放到错误检查之后、choices 分支之前，删除空 choices 分支和结束原因分支内的重复提取。只调整该协议的解析，不修改用量映射、外层累计策略或重试行为。
4. 再运行同一测试，确认通过；逐项增加兼容场景检查，随后进行完整验证。

外层已有「只保存最后一份累计读数，终止前交付一次」的契约，因此不需要新增去重状态，也不能对多帧累计读数求和。`usage: null` 仍被忽略。

## 保留的回归测试

见 [适配器测试](../tests/adapter.test.ts)，新增 3 项：

| 场景 | 预期行为 |
| --- | --- |
| issue 中的 `finish_reason: null` 占位 choice 尾帧 | 交付 input 32、output 37、reasoning 25、total 69，随后仅一个 finish |
| 省略 finish_reason，之后收到 usage 为 null，最后正常 EOF | 保留 input 10、output 5、cache read 90，空占位不覆盖，成功结束 |
| 正文、结束帧与占位尾帧都带累计用量 | 正文仍为 `ok`；只交付最后的 input 10、output 5、cache read 90、total 105，不相加 |

定向运行：

```sh
node --import tsx --test --test-name-pattern='问题 #124' tests/adapter.test.ts
```

## 真实网关对照

使用 DSH 已有托管凭据，不输出或持久化密钥。默认凭据访问 OpenAI 端点返回 403 套餐／权限拒绝；使用另一个已有凭据后取得有效响应。请求固定为：

- 端点：`https://api.commandcode.ai/provider/v1/chat/completions`
- 模型：`deepseek/deepseek-v4.1-flash`
- 输出预算：64；思考档位：`off`
- 提示：`Reply with the single word: hi`

修复前基线适配器发出一次成功的真实生成，HTTP 200。在 HTTP 边界复制这份响应，将同一响应回放给修复后的公开适配器接口；对照回放不再发起生成。两侧使用相同的真实服务端数据，避免重新生成造成用量和响应形状差异。

真实 usage 帧中的 choices 是 `[{ "finish_reason": null, "index": 0, "delta": {} }]`，用量为 prompt 11、completion 2、total 13、reasoning 0、cached 0。

| 观察项 | 修复前 | 修复后（同一真实响应回放） |
| --- | --- | --- |
| 对外 usage 块数量 | 0 | 1 |
| 输入／输出／总量 | 缺失 | 11／2／13 |
| 正文 | 正常 | 与修复前一致 |
| 最后交付的块 | finish | finish |

## 验证结果与边界

- 新增回归：3/3 通过；首项已确认修复前失败、修复后通过。
- `npm test`：1239/1239 通过，0 失败、0 跳过。
- `npm run typecheck`：退出码 0。
- `npm run build`：退出码 0；生成的 `lib/index.js` 包含本次修复。
- `git diff --check`：退出码 0。
- 工作区原有改动保留，未提交、未发布，未修改运行中的 profile。

真实验证只有一个成功生成样本，未重复统计报告中的约 81% 丢失比例；该样本关闭了思考且缓存读数为 0，非零思考和缓存命中映射由合成回归覆盖。没有在浏览器里走完整会话，不能据此宣称 token pill、tok/s、上下文环的显示已端到端验收。没有变更引擎兼容范围或发布元数据，本次未重跑多引擎安装矩阵。
