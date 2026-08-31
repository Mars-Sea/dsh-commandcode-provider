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
  | 'advancedSettings'
  | 'advancedSettingsHint'
  | 'advancedOverriddenOne'
  | 'advancedOverriddenMany'
  | 'advancedInvalid'
  | 'filterModelsByPlan'
  | 'filterModelsByPlanHint'
  | 'accountsTitle'
  | 'accountsHint'
  | 'accountAdd'
  | 'accountRemove'
  | 'accountLabel'
  | 'accountKey'
  | 'accountKeyHint'
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
  | 'cardEdit'
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
  advancedSettings: '高级设置',
  advancedSettingsHint: 'API 地址、工作目录、超时与模型过滤等不常修改的选项。',
  advancedOverriddenOne: '已自定义 1 项',
  advancedOverriddenMany: '已自定义 {count} 项',
  advancedInvalid: '高级设置中有未填好的数字，请展开修正后再保存。',
  filterModelsByPlan: '隐藏套餐外模型',
  filterModelsByPlanHint: '开启后，模型选择器只列出当前套餐可用的模型；账户持有按需余额时会显示全部。',
  accountsTitle: '多账户轮换',
  accountsHint: '当前账户达到用量限额（429）或密钥失效（401）时，请求自动切换到下一个账户；全部耗尽时会提示最早的重置时间。',
  accountAdd: '添加账户',
  accountRemove: '移除',
  accountLabel: '账户备注名',
  accountKey: 'API 密钥',
  accountKeyHint: '该账户的 API 密钥。留空保存不会覆盖已存储的密钥。',
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
  cardEdit: '编辑',
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
  advancedSettings: 'Advanced',
  advancedSettingsHint: 'Rarely touched options: API base URL, working directory, timeouts, and model filtering.',
  advancedOverriddenOne: '1 customized',
  advancedOverriddenMany: '{count} customized',
  advancedInvalid: 'A number in Advanced settings is not ready to save; expand to fix it.',
  filterModelsByPlan: 'Hide out-of-plan models',
  filterModelsByPlanHint: 'When on, the model picker lists only models your subscription'
    + ' includes; any on-demand credit balance shows the full catalog.',
  accountsTitle: 'Account rotation',
  accountsHint: 'When the active account hits its usage limit (429) or its key'
    + ' fails (401), requests switch to the next account; when every account is'
    + ' exhausted the error names the earliest window reset.',
  accountAdd: 'Add account',
  accountRemove: 'Remove',
  accountLabel: 'Account label',
  accountKey: 'API key',
  accountKeyHint: 'This account’s API key. Saving with the field blank keeps the stored key.',
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
  cardEdit: 'Edit',
  cardLoadingHint: 'Loading the Command Code configuration…',
  cardRegistrationHint: 'This card is contributed by the Command Code plugin; a newer DeepSeek Harness is needed to show the full controls.',
}
