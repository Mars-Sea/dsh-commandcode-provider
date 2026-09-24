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
  | 'commandGuardLevel'
  | 'commandGuardLevelHint'
  | 'commandGuardLevelHigh'
  | 'commandGuardLevelMedium'
  | 'commandGuardLevelLow'
  | 'zdr'
  | 'zdrHint'
  | 'accountsTitle'
  | 'accountsHint'
  | 'accountAdd'
  | 'accountDefault'
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
  | 'save'
  | 'saving'
  | 'saved'
  | 'saveFailed'
  | 'unsavedChanges'
  | 'saveInvalid'
  | 'discard'
  | 'cancel'
  | 'show'
  | 'hide'
  | 'usageRefresh'
  | 'usageRefreshing'
  | 'usageLoading'
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
  | 'usageMonthlyLeft'
  | 'usageExceeded'
  | 'usageReset'
  | 'usagePartial'
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
  | 'accountsRotationHint'
  | 'accountModeAuto'
  | 'accountModePinned'
  | 'accountStatusPinned'
  | 'accountActions'
  | 'accountActionPin'
  | 'accountActionUnpin'
  | 'accountActionLogin'
  | 'accountActionKey'
  | 'accountActionRename'
  | 'accountActionClearKey'
  | 'accountActionRemove'
  | 'accountRemoveConfirm'
  | 'accountClearKeyConfirm'
  | 'accountConfirmRemove'
  | 'accountConfirmClear'
  | 'accountApply'
  | 'accountNoKeyHint'
  | 'accountAddHint'
  | 'accountAddLogin'
  | 'accountAddPaste'
  | 'accountAddConfirm'
  | 'accountNamePlaceholder'
  | 'accountNameN'
  | 'accountKeyPlaceholder'
  | 'accountOpFailed'
  | 'accountModels'
  | 'accountModelsHint'
  | 'accountModelOwner'
  | 'modelPick'
  | 'modelCount'
  | 'modelCatalogFailed'
  | 'modelsTitle'
  | 'privacyTitle'
  | 'integrationsTitle'

export const zh: Record<SettingsCommandCodeKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  intro: '账户操作立即生效；其余设置修改后点击底部「保存」。API 密钥仅保存在本机凭据服务中，不会回显。',
  apiKey: 'API 密钥',
  apiKeyHint: '在 commandcode.ai 控制台创建。留空保存不会覆盖已存储的密钥。',
  apiKeySet: '已配置',
  apiKeyUnset: '未配置',
  apiKeyLocked: '密钥由只读来源提供',
  apiBase: 'API 地址',
  apiBaseHint: '默认 https://api.commandcode.ai，一般无需修改。',
  requestTimeoutMs: '请求超时（毫秒）',
  requestTimeoutMsHint: '等待响应首个字节的超时；默认 60000。',
  streamIdleTimeoutMs: '流空闲超时（毫秒）',
  streamIdleTimeoutMsHint: '生成流停滞多久视为断连；默认 300000（长思考模型可静默数分钟，默认值刻意放宽）。',
  transportMaxRetries: '网络失败重试次数',
  transportMaxRetriesHint: '连接失败时自动重试几次，默认 5（各次等待 0.5+1+2+4+8 秒，合计约 15 秒）。'
    + '超过后直接报错，不再按指数退避长时间等待；填 0 表示不重试。限流、5xx 等由服务端要求重试的失败不受此项影响。',
  advancedSettings: '高级设置',
  advancedSettingsHint: 'API 地址和网络参数，一般无需修改。',
  advancedOverriddenOne: '已自定义 1 项',
  advancedOverriddenMany: '已自定义 {count} 项',
  advancedInvalid: '高级设置中有未填好的数字，请展开修正后再保存。',
  filterModelsByPlan: '隐藏套餐外模型',
  filterModelsByPlanHint: '只显示套餐内模型；按需余额账户仍显示全部。',
  webSearch: '用 Command Code 承载联网搜索',
  webSearchHint: '使用同一密钥承载 dsh 的 web_search；关闭后恢复原搜索后端。',
  showSidebarQuota: '在侧边栏显示额度卡片',
  showSidebarQuotaHint: '在侧边栏底部显示套餐与额度卡片，点击可打开完整仪表盘。默认关闭，关闭时不会为它后台刷新用量。',
  commandGuard: 'AI 命令安全预判',
  commandGuardHint: '命令确认弹窗前，先由 typesafe/jev 判断它是否安全；沙箱提权还会额外判断范围与必要性。三项都足够确定才自动放行，其余照常弹窗。默认关闭。',
  commandGuardLevel: '自动放行阈值',
  commandGuardLevelHint: '阈值越高，需要越确定才放行，弹窗越多。高 = 0.95，中 = 0.9（默认），低 = 0.8。判定超过 3 秒未返回会照常弹窗。',
  commandGuardLevelHigh: '高',
  commandGuardLevelMedium: '中',
  commandGuardLevelLow: '低',
  zdr: '零数据保留（ZDR）',
  zdrHint: '仅使用不留存、不训练的上游；可用模型可能更少且价格通常更高。',
  accountsTitle: '账户',
  accountsHint: '账户操作立即生效，无需保存。可以添加多个账户：当前账户达到用量限额或密钥失效时，请求会自动切换到下一个。',
  accountAdd: '添加账户',
  accountDefault: '默认账户',
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
  save: '保存',
  saving: '保存中',
  saved: '设置已保存',
  saveFailed: '保存失败，请重试。',
  unsavedChanges: '有未保存的更改',
  saveInvalid: '有字段填写不正确，修正后才能保存',
  discard: '放弃',
  cancel: '取消',
  show: '显示',
  hide: '隐藏',
  usageRefresh: '刷新',
  usageRefreshing: '刷新中…',
  usageLoading: '正在获取账户用量…',
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
  usageMonthlyLeft: '月额度剩余',
  usageExceeded: '已超限',
  usageReset: '重置于',
  usagePartial: '部分端点数据不可用',
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
  loginHintIdle: '也可通过网页授权自动获取并保存密钥。',
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
  cardRegistrationHint: '此卡片由 Command Code 插件提供，正在等待设置页装配，稍后即可显示完整内容。',
  accountsRotationHint: '账户操作立即生效。当前账户达到用量限额或密钥失效时，请求会按列表顺序自动切换到下一个可用账户。',
  accountModeAuto: '使用方式：自动切换（按列表顺序）',
  accountModePinned: '使用方式：固定使用「{name}」，不可用时仍会自动切换',
  accountStatusPinned: '已固定',
  accountActions: '账户操作',
  accountActionPin: '固定使用此账户',
  accountActionUnpin: '恢复自动切换',
  accountActionLogin: '网页登录获取新密钥',
  accountActionKey: '粘贴新密钥',
  accountActionRename: '重命名',
  accountActionClearKey: '删除密钥',
  accountActionRemove: '移除账户',
  accountRemoveConfirm: '移除「{name}」？它保存的密钥和专用模型设置会一起删除。',
  accountClearKeyConfirm: '删除默认账户保存的密钥？之后会回退到环境变量或官方 CLI 的登录信息。',
  accountConfirmRemove: '移除',
  accountConfirmClear: '删除',
  accountApply: '确定',
  accountNoKeyHint: '还没有密钥：通过网页登录自动获取，或粘贴在 commandcode.ai 控制台创建的 API 密钥。',
  accountAddHint: '网页登录会打开 Command Code 授权页，授权完成后账户自动添加；也可以直接粘贴 API 密钥。',
  accountAddLogin: '网页登录',
  accountAddPaste: '粘贴密钥',
  accountAddConfirm: '添加',
  accountNamePlaceholder: '备注名（可选，网页登录时默认使用账户名）',
  accountNameN: '账户 {n}',
  accountKeyPlaceholder: '粘贴 API 密钥',
  accountOpFailed: '账户操作未能完成，请重试。',
  accountModels: '专用模型',
  accountModelsHint: '选中的模型优先由此账户处理，此账户不可用时仍会自动切换。一个模型只属于一个账户，选中会把它从其他账户移过来。',
  accountModelOwner: '属于 {name}',
  modelPick: '选择模型…',
  modelCount: '已选 {count} 个模型',
  modelCatalogFailed: '模型目录获取失败，暂时无法选择模型；已保存的设置仍会生效。',
  modelsTitle: '模型',
  privacyTitle: '隐私与安全',
  integrationsTitle: '集成与显示',
}

export const en: Record<SettingsCommandCodeKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  intro: 'Account actions apply immediately; other settings are written by Save at the bottom. The API key stays in the local credential service and is never echoed.',
  apiKey: 'API key',
  apiKeyHint: 'Create one in the commandcode.ai console. Saving with this field'
    + ' blank keeps the stored key.',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured',
  apiKeyLocked: 'Key provided by a read-only source',
  apiBase: 'API base URL',
  apiBaseHint: 'Defaults to https://api.commandcode.ai; usually leave as-is.',
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
  advancedSettingsHint: 'API base URL and network limits; usually leave as-is.',
  advancedOverriddenOne: '1 customized',
  advancedOverriddenMany: '{count} customized',
  advancedInvalid: 'A number in Advanced settings is not ready to save; expand to fix it.',
  filterModelsByPlan: 'Hide out-of-plan models',
  filterModelsByPlanHint: 'Show only models in your plan; on-demand credit accounts still see the full catalog.',
  webSearch: 'Serve dsh web search with Command Code',
  webSearchHint: 'Use the same key for dsh web search; turning it off restores the previous backend.',
  showSidebarQuota: 'Show the quota card in the sidebar',
  showSidebarQuotaHint: 'Show a plan and quota card at the bottom of the sidebar that opens the full dashboard. Off by default; while off, no background usage refresh runs for it.',
  commandGuard: 'AI command guard',
  commandGuardHint: 'Before a shell command asks for approval, typesafe/jev judges whether'
    + ' it is safe. A sandbox escalation also needs separate scope and necessity'
    + ' verdicts; all three must be confident enough to skip the prompt.'
    + ' Off by default.',
  commandGuardLevel: 'Auto-approve threshold',
  commandGuardLevelHint: 'A higher threshold needs more confidence to skip the prompt, so you'
    + ' see more prompts. High = 0.95, Medium = 0.9 (default), Low = 0.8. A judgement'
    + ' that takes longer than 3 seconds shows the normal prompt.',
  commandGuardLevelHigh: 'High',
  commandGuardLevelMedium: 'Medium',
  commandGuardLevelLow: 'Low',
  zdr: 'Zero data retention (ZDR)',
  zdrHint: 'Use only upstreams that retain no data and do not train on requests; availability and pricing may differ.',
  accountsTitle: 'Accounts',
  accountsHint: 'Account actions apply immediately, no save needed. Add more accounts and requests switch to the next one when the current account hits its usage limit or its key stops working.',
  accountAdd: 'Add account',
  accountDefault: 'Default account',
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
  save: 'Save',
  saving: 'Saving',
  saved: 'Settings saved',
  saveFailed: 'Save failed, please retry.',
  unsavedChanges: 'You have unsaved changes',
  saveInvalid: 'Fix the highlighted field before saving',
  discard: 'Discard',
  cancel: 'Cancel',
  show: 'Show',
  hide: 'Hide',
  usageRefresh: 'Refresh',
  usageRefreshing: 'Refreshing…',
  usageLoading: 'Fetching account usage…',
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
  usageMonthlyLeft: 'Monthly left',
  usageExceeded: 'Exceeded',
  usageReset: 'Resets',
  usagePartial: 'Some endpoint data unavailable',
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
  loginHintIdle: 'Alternatively, sign in to fetch and store a key automatically.',
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
  cardRegistrationHint: 'This card is contributed by the Command Code plugin and is waiting for the settings page to finish assembling.',
  accountsRotationHint: 'Account actions apply immediately. When the current account hits its usage limit or its key stops working, requests switch to the next usable account in list order.',
  accountModeAuto: 'Mode: switch automatically (list order)',
  accountModePinned: 'Mode: pinned to "{name}", still switching when it is unavailable',
  accountStatusPinned: 'Pinned',
  accountActions: 'Account actions',
  accountActionPin: 'Pin this account',
  accountActionUnpin: 'Switch automatically',
  accountActionLogin: 'Sign in for a new key',
  accountActionKey: 'Paste a new key',
  accountActionRename: 'Rename',
  accountActionClearKey: 'Delete key',
  accountActionRemove: 'Remove account',
  accountRemoveConfirm: 'Remove "{name}"? Its stored key and dedicated models are deleted with it.',
  accountClearKeyConfirm: 'Delete the default account\'s stored key? The provider then falls back to the environment or the official CLI sign-in.',
  accountConfirmRemove: 'Remove',
  accountConfirmClear: 'Delete',
  accountApply: 'Apply',
  accountNoKeyHint: 'No key yet: sign in through the browser, or paste an API key created in the commandcode.ai console.',
  accountAddHint: 'Sign-in opens the Command Code authorization page and adds the account once you approve; you can also paste an API key.',
  accountAddLogin: 'Sign in',
  accountAddPaste: 'Paste key',
  accountAddConfirm: 'Add',
  accountNamePlaceholder: 'Name (optional; sign-in uses the account name)',
  accountNameN: 'Account {n}',
  accountKeyPlaceholder: 'Paste an API key',
  accountOpFailed: 'The account change did not complete. Try again.',
  accountModels: 'Dedicated models',
  accountModelsHint: 'These models prefer this account and still switch when it is unavailable. A model belongs to one account; selecting it here moves it from any other.',
  accountModelOwner: 'on {name}',
  modelPick: 'Choose models…',
  modelCount: '{count} models selected',
  modelCatalogFailed: 'The model catalog could not be loaded; saved settings still apply.',
  modelsTitle: 'Models',
  privacyTitle: 'Privacy & security',
  integrationsTitle: 'Integrations & display',
}
