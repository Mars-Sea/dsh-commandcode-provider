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
  | 'overridden'
  | 'reset'
  | 'invalidNumber'
  | 'readOnly'
  | 'unsaved'
  | 'save'
  | 'saving'
  | 'saveFailed'
  | 'discard'
  | 'cancel'
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
  | 'usageUpdated'
  | 'usagePeriodEnd'
  | 'usageActive'
  | 'usageCooldown'
  | 'usageInvalidKey'
  | 'usageUnconfigured'

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
  overridden: '已覆盖',
  reset: '重置',
  invalidNumber: '无效数字',
  readOnly: '当前配置为只读。',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中',
  saveFailed: '保存失败，请重试。',
  discard: '放弃',
  cancel: '取消',
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
  usageUpdated: '更新于',
  usagePeriodEnd: '账期截止',
  usageActive: '当前使用',
  usageCooldown: '限额冷却中',
  usageInvalidKey: '密钥无效',
  usageUnconfigured: '该账户尚未配置 API 密钥。',
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
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'Invalid number',
  readOnly: 'Settings are read-only.',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving',
  saveFailed: 'Save failed, please retry.',
  discard: 'Discard',
  cancel: 'Cancel',
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
  usageUpdated: 'Updated',
  usagePeriodEnd: 'Period ends',
  usageActive: 'Active',
  usageCooldown: 'Cooling down',
  usageInvalidKey: 'Invalid key',
  usageUnconfigured: 'No API key configured for this account yet.',
}
