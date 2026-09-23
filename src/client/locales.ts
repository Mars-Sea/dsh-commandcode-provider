/**
 * Locale copy for the "Command Code" settings page, and the declaration that
 * merges the page's namespace into the framework's `LocaleNamespaceMap` so
 * `ctx.locale.register` / `ctx.slots.register(..., { locale })` are typed.
 *
 * zh is the source of truth for the key set (repo convention); en must carry
 * the exact same keys — a mismatch is a compile error at the register site.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the Command Code settings page. */
    'settings.commandcode': SettingsCommandCodeKey
  }
}

/** Dictionary keys of the Command Code settings page. */
export type SettingsCommandCodeKey =
  | 'nav'
  | 'title'
  | 'intro'
  | 'apiKey'
  | 'apiKeyHint'
  | 'apiKeySet'
  | 'apiKeyUnset'
  | 'apiKeyLocked'
  | 'apiBase'
  | 'apiBaseHint'
  | 'workingDir'
  | 'workingDirHint'
  | 'requestTimeoutMs'
  | 'requestTimeoutMsHint'
  | 'streamIdleTimeoutMs'
  | 'streamIdleTimeoutMsHint'
  | 'transportMaxRetries'
  | 'transportMaxRetriesHint'
  | 'advancedSettings'
  | 'advancedSettingsHint'
  | 'advancedOverriddenOne'
  | 'advancedOverriddenMany'
  | 'advancedInvalid'
  | 'filterModelsByPlan'
  | 'filterModelsByPlanHint'
  | 'webSearch'
  | 'webSearchHint'
  | 'showSidebarQuota'
  | 'showSidebarQuotaHint'
  | 'commandGuard'
  | 'commandGuardHint'
  | 'commandGuardThreshold'
  | 'commandGuardThresholdHint'
  | 'commandGuardTimeoutMs'
  | 'commandGuardTimeoutMsHint'
  | 'zdr'
  | 'zdrHint'
  | 'accountsTitle'
  | 'accountsHint'
  | 'accountAdd'
  | 'accountRemove'
  | 'accountLabel'
  | 'accountKey'
  | 'accountKeyHint'
  | 'accountLoginAfterSave'
  | 'accountDefault'
  | 'activeAccount'
  | 'activeAccountAuto'
  | 'activeAccountHint'
  | 'rulesTitle'
  | 'rulesHint'
  | 'rulesEmpty'
  | 'rulesCatalogFailed'
  | 'ruleAdd'
  | 'ruleRemove'
  | 'ruleModel'
  | 'ruleModelPick'
  | 'ruleModelCount'
  | 'ruleAccount'
  | 'ruleHint'
  | 'modelSearchPlaceholder'
  | 'modelSearchEmpty'
  | 'modelStale'
  | 'visibleModelsTitle'
  | 'visibleModelsHint'
  | 'visibleModelsPick'
  | 'visibleModelsCount'
  | 'visibleModelsShowAll'
  | 'visibleModelsStaleHint'
  | 'visibleModelsCleanStale'
  | 'overridden'
  | 'reset'
  | 'invalidNumber'
  | 'numberTooSmall'
  | 'numberTooLarge'
  | 'readOnly'
  | 'unsaved'
  | 'save'
  | 'saving'
  | 'saved'
  | 'saveFailed'
  | 'discard'
  | 'cancel'
  | 'show'
  | 'hide'
  | 'usageTitle'
  | 'usageRefresh'
  | 'usageRefreshing'
  | 'usageLoading'
  | 'usageNoKey'
  | 'usageError'
  | 'usageRequests'
  | 'usageFailed'
  | 'usageSuccessRate'
  | 'usageCost'
  | 'usageTokens'
  | 'usageTokensIn'
  | 'usageTokensOut'
  | 'usageMonthly'
  | 'usagePurchased'
  | 'usageFree'
  | 'usageFiveHour'
  | 'usageWeekly'
  | 'usageExceeded'
  | 'usageReset'
  | 'usagePartial'
  | 'usageKeyClear'
  | 'usageKeyClearStaged'
  | 'usageUndoKeyClear'
  | 'usageKeyInvalid'
  | 'usageKeyInvalidHint'
  | 'usageServiceUnavailable'
  | 'usageServiceUnavailableHint'
  | 'usageNetworkError'
  | 'usageNetworkHint'
  | 'usageInvalidResponse'
  | 'usageInvalidResponseHint'
  | 'usageUpdated'
  | 'usagePeriodEnd'
  | 'usageActive'
  | 'usageCooldown'
  | 'usageInvalidKey'
  | 'usageUnconfigured'
  | 'updateAvailable'
  | 'updateHint'
  | 'loginTitle'
  | 'loginHintIdle'
  | 'loginSaveBefore'
  | 'loginButton'
  | 'loginStarting'
  | 'loginWaiting'
  | 'loginOpenLink'
  | 'loginCancel'
  | 'loginSuccess'
  | 'loginUnavailable'
  | 'loginDenied'
  | 'loginTimeout'
  | 'loginInvalidKey'
  | 'loginNetwork'
  | 'loginStoreFailed'
  | 'loginCancelled'
  | 'loginFailedGeneric'
  | 'cardTitle'
  | 'cardRouteActive'
  | 'cardLoadingHint'
  | 'cardRegistrationHint'

export const zh: Record<SettingsCommandCodeKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  intro:
    '配置 Command Code Provider 连接。API 密钥仅保存在本机凭据服务中，不会回显；'
    + '其他字段写入用户设置，下次请求即生效。',
  apiKey: 'API 密钥',
  apiKeyHint: '在 commandcode.ai 控制台创建。留空保存不会覆盖已存储的密钥。',
  apiKeySet: '已配置',
  apiKeyUnset: '未配置',
  apiKeyLocked: '密钥由只读来源提供',
  apiBase: 'API 地址',
  apiBaseHint: '默认 https://api.commandcode.ai，一般无需修改。',
  workingDir: '工作目录',
  workingDirHint: '可选。留空时使用占位符显示的进程工作目录；仅在需要固定路径时填写。',
  requestTimeoutMs: '请求超时（毫秒）',
  requestTimeoutMsHint: '等待响应首个字节的超时；默认 60000。',
  streamIdleTimeoutMs: '流空闲超时（毫秒）',
  streamIdleTimeoutMsHint: '生成流停滞多久视为断连；默认 300000（长思考模型可静默数分钟，默认值刻意放宽）。',
  transportMaxRetries: '网络失败重试次数',
  transportMaxRetriesHint: '连接失败时自动重试几次，默认 5（各次等待 0.5+1+2+4+8 秒，合计约 15 秒）。'
    + '超过后直接报错，不再按指数退避长时间等待；填 0 表示不重试。限流、5xx 等由服务端要求重试的失败不受此项影响。',
  advancedSettings: '高级设置',
  advancedSettingsHint: 'API 地址、工作目录、超时、模型过滤、联网搜索与侧边栏额度卡片等不常修改的选项。',
  advancedOverriddenOne: '已自定义 1 项',
  advancedOverriddenMany: '已自定义 {count} 项',
  advancedInvalid: '高级设置中有未填好的数字，请展开修正后再保存。',
  filterModelsByPlan: '隐藏套餐外模型',
  filterModelsByPlanHint: '开启后，模型选择器只列出当前套餐可用的模型；账户持有按需余额时会显示全部。',
  webSearch: '用 Command Code 承载联网搜索',
  webSearchHint: '开启后，dsh 的 web_search 工具由 Command Code 承担（复用同一个 API key 与地址），并优先于其他搜索后端；关闭则把选择权交还给之前的后端（如 modsearch），而不是强制回退到 DeepSeek 搜索。',
  showSidebarQuota: '在侧边栏显示额度卡片',
  showSidebarQuotaHint: '开启后，侧边栏底部（Settings 上方）显示 Command Code 套餐与配额卡片，点击可在中间栏打开完整仪表盘。默认关闭：左侧不显示任何额度信息，也不会为其后台刷新用量。保存后立即生效。',
  commandGuard: 'AI 命令安全预判',
  commandGuardHint: '命令确认弹窗前，先由 typesafe/jev 判断它是否安全：安全就自动放行，其余照常弹窗。默认关闭。',
  commandGuardThreshold: '自动放行阈值（0.5–1）',
  commandGuardThresholdHint: 'typesafe/jev 判定"安全"的概率达到该值即放行，默认 0.9。',
  commandGuardTimeoutMs: '判定超时（毫秒，200–10000）',
  commandGuardTimeoutMsHint: 'typesafe/jev 超过该时间未返回就照常弹窗，默认 1500。',
  zdr: '零数据保留（ZDR）',
  zdrHint:
    '开启后，请求只经由不留存提示词与回复、也不用于训练的上游（等价于 CLI 的 CMD_ZDR=1）。'
    + '没有可用 ZDR 上游的模型会返回错误，请换用其他模型或关闭此开关。'
    + 'ZDR 容量按上游实价透传，通常更贵；费用读数仍按常规目录价估算。默认关闭。',
  accountsTitle: '多账户轮换',
  accountsHint: '当前账户达到用量限额（429）或密钥失效（401）时，请求自动切换到下一个账户；全部耗尽时会提示最早的重置时间。',
  accountAdd: '添加账户',
  accountRemove: '移除',
  accountLabel: '账户备注名',
  accountKey: 'API 密钥',
  accountKeyHint: '该账户的 API 密钥。留空保存不会覆盖已存储的密钥。',
  accountLoginAfterSave: '先点击页面底部的「保存」，再点击该账户的「登录 Command Code」通过网页获取密钥。',
  accountDefault: '默认账户',
  activeAccount: '当前使用账户',
  activeAccountAuto: '自动（第一个可用账户）',
  activeAccountHint: '手动指定优先使用的账户，保存后下次请求即生效；所选账户耗尽时仍会自动切换到其他可用账户。',
  rulesTitle: '按模型切换账户',
  rulesHint: '选择模型并路由到某个账户（可多选）。命中规则的模型且该账户可用时优先使用；账户耗尽或密钥失效时仍自动回落到其他账户。规则按列表顺序匹配，第一条命中生效。',
  rulesEmpty: '尚未配置规则。',
  rulesCatalogFailed: '模型目录获取失败，暂时无法选择模型；已保存的规则仍会生效。',
  ruleAdd: '添加规则',
  ruleRemove: '移除',
  ruleModel: '模型',
  ruleModelPick: '选择模型…',
  ruleModelCount: '已选 {count} 个模型',
  ruleAccount: '目标账户',
  ruleHint: '从下拉列表勾选要路由的模型（可多选），再选择目标账户。',
  modelSearchPlaceholder: '搜索模型…',
  modelSearchEmpty: '没有匹配的模型。',
  modelStale: '已下架',
  visibleModelsTitle: '模型白名单',
  visibleModelsHint:
    '勾选要保留的模型，模型选择器就只列出这些；一个都不勾选时则显示全部模型。'
    + '保存后，下次打开模型选择器生效。',
  visibleModelsPick: '选择要保留的模型…',
  visibleModelsCount: '已选 {count} 个模型',
  visibleModelsShowAll: '显示全部',
  visibleModelsStaleHint: '有 {count} 个已选模型在目录中找不到了（可能已下架），不影响其他模型；可清理或保留。',
  visibleModelsCleanStale: '清理失效（{count}）',
  overridden: '已覆盖',
  reset: '重置',
  invalidNumber: '无效数字',
  numberTooSmall: '不能小于 1（毫秒）',
  numberTooLarge: '超出允许上限（2147483647 毫秒）',
  readOnly: '当前配置为只读。',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中',
  saved: '已保存 ✓',
  saveFailed: '保存失败，请重试。',
  discard: '放弃',
  cancel: '取消',
  show: '显示',
  hide: '隐藏',
  usageTitle: '账户用量',
  usageRefresh: '刷新',
  usageRefreshing: '刷新中…',
  usageLoading: '正在获取账户用量…',
  usageNoKey: '配置 API 密钥后，这里会显示账户的用量与额度状态。',
  usageError: '用量获取失败',
  usageRequests: '请求',
  usageFailed: '失败',
  usageSuccessRate: '成功率',
  usageCost: '花费',
  usageTokens: 'Token',
  usageTokensIn: '入',
  usageTokensOut: '出',
  usageMonthly: '月额度',
  usagePurchased: '已购',
  usageFree: '赠送',
  usageFiveHour: '5 小时窗口',
  usageWeekly: '每周窗口',
  usageExceeded: '已超限',
  usageReset: '重置于',
  usagePartial: '部分端点数据不可用',
  usageKeyClear: '清除已存密钥',
  usageKeyClearStaged: '将清除（保存后生效）',
  usageUndoKeyClear: '撤销清除',
  usageKeyInvalid: 'API 密钥无效或已过期',
  usageKeyInvalidHint: '服务端拒绝了全部请求（401）。请检查该账户配置的密钥，或到 commandcode.ai 控制台重新生成。',
  usageServiceUnavailable: 'Command Code 服务暂时不可用',
  usageServiceUnavailableHint: '服务端返回了错误（5xx），稍后点击刷新重试。',
  usageNetworkError: '无法连接 Command Code 服务',
  usageNetworkHint: '所有请求都没有到达服务端。请检查网络连接或 API 地址设置。',
  usageInvalidResponse: 'Command Code 响应无法读取',
  usageInvalidResponseHint: '请求已收到响应，但内容无法解析。请检查宿主的 HTTP 代理或响应解压配置。',
  usageUpdated: '更新于',
  usagePeriodEnd: '账期截止',
  usageActive: '当前使用',
  usageCooldown: '限额冷却中',
  usageInvalidKey: '密钥无效',
  usageUnconfigured: '该账户尚未配置 API 密钥。',
  updateAvailable: '可更新',
  updateHint: '已发布新版本，点击查看发布说明；更新插件后刷新本页，提示会自动消失。',
  loginTitle: '通过官方登录获取密钥',
  loginHintIdle: '不想手动创建密钥？点击登录后浏览器会打开 commandcode.ai 授权页，完成后密钥自动写入本机凭据服务，下次请求即生效。',
  loginSaveBefore: '请先保存本页更改，再通过网页登录此账户。',
  loginButton: '登录 Command Code',
  loginStarting: '正在启动本地回调服务…',
  loginWaiting: '等待在浏览器中完成授权…',
  loginOpenLink: '打开授权页面 ↗',
  loginCancel: '取消登录',
  loginSuccess: '已登录为',
  loginUnavailable: '此环境暂不支持登录流程，请手动粘贴密钥。',
  loginDenied: '授权被拒绝。可重试，或手动粘贴密钥。',
  loginTimeout: '等待超时：未在窗口期内收到授权回调，请重试。',
  loginInvalidKey: '获取到的密钥未通过校验（401），请重试或手动粘贴。',
  loginNetwork: '无法连接 Command Code 服务校验密钥，请检查网络后重试。',
  loginStoreFailed: '密钥无法写入本机凭据服务，请手动粘贴。',
  loginCancelled: '登录已取消。',
  loginFailedGeneric: '登录失败，请重试或手动粘贴密钥。',
  cardTitle: 'Command Code',
  cardRouteActive: '已启用',
  cardLoadingHint: '正在读取 Command Code 配置…',
  cardRegistrationHint: '此卡片随 Command Code 插件注册，需要较新版本的 DeepSeek Harness 才会显示完整内容。',
}

export const en: Record<SettingsCommandCodeKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  intro:
    'Configure the Command Code Provider connection. The API key is stored only'
    + ' in the local credential service and never echoed; other fields are written'
    + ' to user settings and take effect on the next request.',
  apiKey: 'API key',
  apiKeyHint: 'Create one in the commandcode.ai console. Saving with this field'
    + ' blank keeps the stored key.',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured',
  apiKeyLocked: 'Key provided by a read-only source',
  apiBase: 'API base URL',
  apiBaseHint: 'Defaults to https://api.commandcode.ai; usually leave as-is.',
  workingDir: 'Working directory',
  workingDirHint: 'Optional. Leave blank to use the process cwd shown as the'
    + ' placeholder; fill in only to pin a specific path.',
  requestTimeoutMs: 'Request timeout (ms)',
  requestTimeoutMsHint: 'Time to wait for the first response byte; default 60000.',
  streamIdleTimeoutMs: 'Stream idle timeout (ms)',
  streamIdleTimeoutMsHint: 'How long a stalled stream is treated as dead; default 300000'
    + ' (deliberately generous — long-thinking models can stay silent for minutes).',
  transportMaxRetries: 'Transport retries',
  transportMaxRetriesHint: 'How many times a failed connection is retried automatically; default 5'
    + ' (waits of 0.5+1+2+4+8s, ~15s in total). After that the failure is reported instead of waiting'
    + ' on the exponential backoff. 0 disables the retries. Rate limits and 5xx answers keep their'
    + ' own, longer retry window.',
  advancedSettings: 'Advanced',
  advancedSettingsHint: 'Rarely touched options: API base URL, working directory, timeouts, model filtering, web search, and the sidebar quota card.',
  advancedOverriddenOne: '1 customized',
  advancedOverriddenMany: '{count} customized',
  advancedInvalid: 'A number in Advanced settings is not ready to save; expand to fix it.',
  filterModelsByPlan: 'Hide out-of-plan models',
  filterModelsByPlanHint: 'When on, the model picker lists only models your subscription'
    + ' includes; any on-demand credit balance shows the full catalog.',
  webSearch: 'Serve dsh web search with Command Code',
  webSearchHint: 'When on, the model-facing web_search tool is backed by Command Code'
    + ' (same API key and base URL as chat), winning over other search backends.'
    + ' Off hands the selection back to the previous backend (e.g. modsearch)'
    + ' instead of forcing the shipped DeepSeek search.',
  showSidebarQuota: 'Show the quota card in the sidebar',
  showSidebarQuotaHint: 'When on, a Command Code plan & quota card sits at the bottom of the'
    + ' sidebar (above Settings) and opens the full dashboard in the centre column.'
    + ' Off by default: nothing is shown on the left, and no background usage poll'
    + ' runs for it. Applies on save.',
  commandGuard: 'AI command guard',
  commandGuardHint: 'Before a shell command asks for approval, typesafe/jev judges whether'
    + ' it is safe: safe commands run without a prompt, everything else asks as usual.'
    + ' Off by default.',
  commandGuardThreshold: 'Auto-approve threshold (0.5–1)',
  commandGuardThresholdHint: 'Approve when typesafe/jev rates the command "safe" at least'
    + ' this likely; default 0.9.',
  commandGuardTimeoutMs: 'Judgement timeout (ms, 200–10000)',
  commandGuardTimeoutMsHint: 'If typesafe/jev does not answer in time, the normal prompt'
    + ' appears; default 1500.',
  zdr: 'Zero data retention (ZDR)',
  zdrHint:
    'Serve requests only through upstreams that keep no prompts or completions'
    + ' and never train on them (the same opt-in as the CLI\'s CMD_ZDR=1). A few'
    + ' models have no ZDR upstream; requests for those models fail rather than'
    + ' losing ZDR protection. ZDR capacity is billed'
    + ' at the upstream\'s pass-through rates and usually costs more; the cost'
    + ' readout keeps quoting the ordinary catalog rates. Off by default.',
  accountsTitle: 'Account rotation',
  accountsHint: 'When the active account hits its usage limit (429) or its key'
    + ' fails (401), requests switch to the next account; when every account is'
    + ' exhausted the error names the earliest window reset.',
  accountAdd: 'Add account',
  accountRemove: 'Remove',
  accountLabel: 'Account label',
  accountKey: 'API key',
  accountKeyHint: 'This account’s API key. Saving with the field blank keeps the stored key.',
  accountLoginAfterSave: 'Use Save at the bottom of the page, then sign in to this account in your browser to obtain a key.',
  accountDefault: 'Default account',
  activeAccount: 'Active account',
  activeAccountAuto: 'Auto (first usable account)',
  activeAccountHint: 'Pin the preferred account; applies to the next request after saving.'
    + ' If the selected account is exhausted, requests still rotate to another usable account.',
  rulesTitle: 'Route models to accounts',
  rulesHint: 'Pick models (multi-select) and route them to an account. When the'
    + ' request’s model is in a rule and that account is usable, it serves;'
    + ' an exhausted or invalid routed account falls back to the normal rotation.'
    + ' Rules match in list order — the first hit wins.',
  rulesEmpty: 'No rules yet.',
  rulesCatalogFailed: 'Could not load the model catalog — selecting models is unavailable; saved rules still apply.',
  ruleAdd: 'Add rule',
  ruleRemove: 'Remove',
  ruleModel: 'Models',
  ruleModelPick: 'Select models…',
  ruleModelCount: '{count} model(s) selected',
  ruleAccount: 'Target account',
  ruleHint: 'Check the models to route from the dropdown (multi-select), then pick the target account.',
  modelSearchPlaceholder: 'Search models…',
  modelSearchEmpty: 'No matching models.',
  modelStale: 'Retired',
  visibleModelsTitle: 'Model allowlist',
  visibleModelsHint:
    'Check the models you want to keep, and model pickers will list only those. '
    + 'If nothing is checked, every model is shown. After saving, the change '
    + 'applies the next time you open a model picker.',
  visibleModelsPick: 'Select models to keep…',
  visibleModelsCount: '{count} model(s) selected',
  visibleModelsShowAll: 'Show all',
  visibleModelsStaleHint: '{count} selected model(s) are no longer in the catalog (possibly retired);'
    + ' other models are unaffected. Clean them up or keep them.',
  visibleModelsCleanStale: 'Clean stale ({count})',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'Invalid number',
  numberTooSmall: 'Must be at least 1 (ms)',
  numberTooLarge: 'Above the allowed maximum (2147483647 ms)',
  readOnly: 'Settings are read-only.',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving',
  saved: 'Saved ✓',
  saveFailed: 'Save failed, please retry.',
  discard: 'Discard',
  cancel: 'Cancel',
  show: 'Show',
  hide: 'Hide',
  usageTitle: 'Account usage',
  usageRefresh: 'Refresh',
  usageRefreshing: 'Refreshing…',
  usageLoading: 'Fetching account usage…',
  usageNoKey: 'Configure an API key to see this account’s usage and credit state here.',
  usageError: 'Could not fetch usage',
  usageRequests: 'Requests',
  usageFailed: 'failed',
  usageSuccessRate: 'Success rate',
  usageCost: 'Spend',
  usageTokens: 'Tokens',
  usageTokensIn: 'in',
  usageTokensOut: 'out',
  usageMonthly: 'Monthly',
  usagePurchased: 'Purchased',
  usageFree: 'Free',
  usageFiveHour: '5-hour window',
  usageWeekly: 'Weekly window',
  usageExceeded: 'Exceeded',
  usageReset: 'Resets',
  usagePartial: 'Some endpoint data unavailable',
  usageKeyClear: 'Clear stored key',
  usageKeyClearStaged: 'Will be cleared on save',
  usageUndoKeyClear: 'Undo clear',
  usageKeyInvalid: 'API key invalid or expired',
  usageKeyInvalidHint: 'The server rejects every request (401). Check the key configured for this account, or generate a new one in the commandcode.ai console.',
  usageServiceUnavailable: 'The Command Code service is temporarily unavailable',
  usageServiceUnavailableHint: 'The server returned errors (5xx); try Refresh again later.',
  usageNetworkError: 'Could not reach the Command Code service',
  usageNetworkHint: 'No request reached the server. Check your network connection or the API base setting.',
  usageInvalidResponse: 'Could not read the Command Code response',
  usageInvalidResponseHint: 'The requests received responses, but their bodies could not be parsed. Check the host HTTP proxy or response decoding.',
  usageUpdated: 'Updated',
  usagePeriodEnd: 'Period ends',
  usageActive: 'Active',
  usageCooldown: 'Cooling down',
  usageInvalidKey: 'Invalid key',
  usageUnconfigured: 'No API key configured for this account yet.',
  updateAvailable: 'update available',
  updateHint: 'A newer version has been published; click for release notes. The notice disappears once the plugin is updated.',
  loginTitle: 'Sign in to fetch a key',
  loginHintIdle: 'Rather not create a key by hand? Sign in and your browser opens the commandcode.ai authorization page; the approved key is stored in the local credential service and applies to the next request.',
  loginSaveBefore: 'Save page changes before signing in to this account.',
  loginButton: 'Sign in to Command Code',
  loginStarting: 'Starting the local callback server…',
  loginWaiting: 'Waiting for authorization in your browser…',
  loginOpenLink: 'Open the authorization page ↗',
  loginCancel: 'Cancel sign-in',
  loginSuccess: 'Signed in as',
  loginUnavailable: 'Sign-in is unavailable in this environment; paste the API key instead.',
  loginDenied: 'Authorization was denied. Try again or paste the key manually.',
  loginTimeout: 'Timed out waiting for the authorization callback; try again.',
  loginInvalidKey: 'The delivered key failed validation (401). Try again or paste it manually.',
  loginNetwork: 'Could not reach the Command Code service to validate the key; check your network and retry.',
  loginStoreFailed: 'The key could not be stored in the local credential service; paste it manually.',
  loginCancelled: 'Sign-in cancelled.',
  loginFailedGeneric: 'Sign-in failed; try again or paste the key manually.',
  cardTitle: 'Command Code',
  cardRouteActive: 'Active',
  cardLoadingHint: 'Loading the Command Code configuration…',
  cardRegistrationHint: 'This card is contributed by the Command Code plugin; a newer DeepSeek Harness is needed to show the full controls.',
}
