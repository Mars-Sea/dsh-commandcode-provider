/**
 * Locale copy for the "Command Code" settings page, and the declaration that
 * merges the page's namespace into the framework's `LocaleNamespaceMap` so
 * `ctx.locale.register` / `ctx.slots.register(..., { locale })` are typed.
 *
 * zh is the source of truth for the key set (repo convention); en must carry
 * the exact same keys — a mismatch is a compile error at the register site.
 *
 * 账号开通的状态文案也收在这里：宿主与浏览器侧控制器只产出语义键
 * （`EnrollmentMessageKey`），界面语言只有这一侧知道，文案因此只有一个来源。
 */
import type { EnrollmentMessageKey } from '../enrollment-wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.commandcode': SettingsCommandCodeKey
  }
}

/** Dictionary keys of the Command Code settings page. */
export type SettingsCommandCodeKey =
  | 'openAnalytics'
  | 'nav'
  | 'title'
  | 'intro'
  | 'apiKey'
  | 'apiKeyHint'
  | 'apiKeySet'
  | 'apiKeyUnset'
  | 'apiKeyLocked'
  | 'apiBase'
  | 'requestTimeoutMs'
  | 'requestTimeoutMsHint'
  | 'streamIdleTimeoutMs'
  | 'streamIdleTimeoutMsHint'
  | 'transportMaxRetries'
  | 'transportMaxRetriesHint'
  | 'offloadSeenImagesForCache'
  | 'offloadSeenImagesForCacheHint'
  | 'advancedSettings'
  | 'advancedSettingsHint'
  | 'groupOverriddenOne'
  | 'groupOverriddenMany'
  | 'groupInvalid'
  | 'saveLocate'
  | 'accountsSummaryOne'
  | 'accountsSummaryMany'
  | 'accountsSummaryIssues'
  | 'visibleModelsSummary'
  | 'visibleModelsSummaryAll'
  | 'zdrSummaryOn'
  | 'zdrSummaryOff'
  | 'webSearchSummaryOn'
  | 'webSearchSummaryOff'
  | 'filterModelsByPlan'
  | 'filterModelsByPlanHint'
  | 'webSearch'
  | 'webSearchHint'
  | 'showSidebarQuota'
  | 'showSidebarQuotaHint'
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
  | 'contextWindow'
  | 'contextWindowHint'
  | 'contextOverridesTitle'
  | 'contextOverridesHint'
  | 'contextOverrideAdd'
  | 'contextOverrideRemove'
  | 'contextOverrideModel'
  | 'contextOverrideValue'
  | 'contextOverrideNoCatalog'
  | 'contextWindowTooSmall'
  | 'contextWindowTooLarge'
  | 'contextWindowInvalid'
  | 'maxOutputTokens'
  | 'maxOutputTokensHint'
  | 'maxOutputTokensTooSmall'
  | 'maxOutputTokensTooLarge'
  | 'maxOutputTokensInvalid'
  | 'overridden'
  | 'reset'
  | 'unitSeconds'
  | 'unitTokens'
  | 'unitRetries'
  | 'placeholderCatalog'
  | 'placeholderAuto'
  | 'invalidNumber'
  | 'numberTooSmall'
  | 'numberTooLarge'
  | 'durationTooSmall'
  | 'durationTooLarge'
  | 'durationInvalid'
  | 'readOnly'
  | 'save'
  | 'saving'
  | 'saved'
  | 'saveFailed'
  | 'writeConflict'
  | 'writeConfigUnconfirmed'
  | 'writeConfigFailedDetail'
  | 'writeConfigRetryable'
  | 'writeConfigSaved'
  | 'writeKeyNotIssued'
  | 'writeKeyUnconfirmed'
  | 'writeKeyConfirmed'
  | 'writeTargetBefore'
  | 'writeTargetAfter'
  | 'writeClosed'
  | 'writeCleanupPending'
  | 'writeRefreshFailed'
  | 'writeRefreshRetry'
  | 'writeStateUnknown'
  | 'writeCredentialRefNote'
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
  | 'usageCompleted'
  | 'usageBillingPeriod'
  | 'usageSuccessRate'
  | 'usageCost'
  | 'usageTokens'
  | 'usageTokensIn'
  | 'usageTokensOut'
  | 'usagePurchased'
  | 'usageFree'
  | 'usageFiveHour'
  | 'usageWeekly'
  | 'usageMonthlyLeft'
  | 'usageMonthlyDepleted'
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
  | 'accountAddCancel'
  | 'accountAddStart'
  | 'accountAddMethod'
  | 'accountAddLinkHint'
  | 'accountAddOpenLink'
  | 'accountNamePlaceholder'
  | 'accountNameN'
  | 'accountNameSaveRetry'
  | 'accountNameAcceptExisting'
  | 'accountKeyPlaceholder'
  | 'accountOpFailed'
  | 'accountCleanupPending'
  | 'accountCleanupRetry'
  | 'accountEnrollmentCleanupRetry'
  | 'accountRefSeparator'
  | 'accountModels'
  | 'accountModelsHint'
  | 'accountModelOwner'
  | 'modelPick'
  | 'modelCount'
  | 'modelAllowance'
  | 'modelAllowanceTitle'
  | 'modelCatalogFailed'
  | 'modelsTitle'
  | 'privacyTitle'
  | 'integrationsTitle'
  // 服务状态行：官方状态页的公开探测数据，见 `./service-status.ts`。
  | 'serviceStatusTitle'
  | 'serviceStatusHint'
  | 'serviceStatusChecking'
  | 'serviceStatusUp'
  | 'serviceStatusDegraded'
  | 'serviceStatusDown'
  | 'serviceStatusUnknown'
  | 'serviceStatusOfficial'
  | 'serviceStatusLocal'
  | 'serviceStatusUptime'
  | 'serviceStatusBadgeLocalHttp'
  | 'serviceStatusBadgeLocalTimeout'
  | 'serviceStatusBadgeLocalUnreachable'
  | 'serviceStatusUptimeWeek'
  | 'serviceStatusUptimeMonth'
  | 'serviceStatusResponseWeek'
  | 'serviceStatusUpdatedJustNow'
  | 'serviceStatusUpdatedMinutes'
  | 'serviceStatusUpdatedHours'
  | 'serviceStatusUpdatedDays'
  | 'serviceStatusUpdatedUnknown'
  | 'serviceStatusLag'
  | 'serviceStatusLocalChecking'
  | 'serviceStatusLocalOk'
  | 'serviceStatusLocalHttp'
  | 'serviceStatusLocalTimeout'
  | 'serviceStatusLocalUnreachable'
  | 'serviceStatusLocalUnavailable'
  | 'serviceStatusStale'
  | 'serviceStatusUnavailable'
  | 'serviceStatusOpen'
  // 账号开通状态的语义键：宿主与浏览器侧控制器共同产出，见 `EnrollmentMessageKey`。
  | EnrollmentMessageKey

export const zh: Record<SettingsCommandCodeKey, string> = {
  openAnalytics: '查看模型用量、成本与性能分析',
  nav: 'Command Code',
  title: 'Command Code',
  intro: '账户操作立即生效；其余改动点底部「保存」。密钥仅存于本机凭据服务，不回显。',
  apiKey: 'API 密钥',
  apiKeyHint: '在 commandcode.ai 控制台创建。留空保存不会覆盖已存储的密钥。',
  apiKeySet: '已配置',
  apiKeyUnset: '未配置',
  apiKeyLocked: '密钥由只读来源提供',
  apiBase: 'API 地址',
  requestTimeoutMs: '请求超时',
  requestTimeoutMsHint: '等待首个字节的超时，默认 300 秒；Provider API 要等上游模型吐出第一个 token 才返回，上游慢时可调高。',
  streamIdleTimeoutMs: '流空闲超时',
  streamIdleTimeoutMsHint: '生成流停滞多久视为断连，默认 300 秒（长思考模型可能静默数分钟）。',
  transportMaxRetries: '网络失败重试次数',
  transportMaxRetriesHint: '连接失败时自动重试的次数，默认 5 次（约 15 秒）；填 0 不重试，限流与 5xx 的重试不受影响。',
  offloadSeenImagesForCache: '已看过的图片不再重复发送',
  offloadSeenImagesForCacheHint: '仅 CLI 传输。模型回复过的旧图片改用文字占位，减少新增图片时的缓存回退；重看需重新读取或附加。',
  advancedSettings: '高级设置',
  advancedSettingsHint: 'API 地址和网络参数，一般无需修改。',
  groupOverriddenOne: '已自定义 1 项',
  groupOverriddenMany: '已自定义 {count} 项',
  // 分组头的摘要徽标：收起时不展开也能看出该组现状（决策记录第十章第4条）。
  groupInvalid: '有未填好的数字',
  saveLocate: '定位',
  accountsSummaryOne: '1 个账户',
  accountsSummaryMany: '{count} 个账户',
  accountsSummaryIssues: '{count} 个异常',
  visibleModelsSummary: '白名单 {count} 个',
  visibleModelsSummaryAll: '显示全部模型',
  zdrSummaryOn: 'ZDR 开启',
  zdrSummaryOff: 'ZDR 关闭',
  webSearchSummaryOn: '联网搜索开启',
  webSearchSummaryOff: '联网搜索关闭',
  filterModelsByPlan: '隐藏套餐外模型',
  filterModelsByPlanHint: '只显示套餐内模型；按需余额账户仍显示全部。',
  webSearch: '用 Command Code 承载联网搜索',
  webSearchHint: '用同一密钥承载 dsh 的 web_search；「网页搜索」里已指定其他后端时本开关不生效。',
  showSidebarQuota: '在侧边栏显示额度卡片',
  showSidebarQuotaHint: '在侧边栏底部显示套餐与额度卡片，点击打开完整仪表盘；关闭时不在后台刷新用量。',
  zdr: '零数据保留（ZDR）',
  zdrHint: '仅使用不留存、不训练的上游；可用模型可能更少且价格通常更高。',
  accountsTitle: '账户',
  accountsHint: '可以添加多个账户：当前账户达到用量限额或密钥失效时，请求会自动切换到下一个。',
  accountAdd: '添加账户',
  accountDefault: '默认账户',
  modelSearchPlaceholder: '搜索模型…',
  modelSearchEmpty: '没有匹配的模型。',
  modelStale: '已下架',
  modelAllowance: '${amount}/月',
  modelAllowanceTitle: '该模型每月可用的额度（美元）。套餐内所有模型共用同一个月度额度池，这不是额外赠送的额度。',
  visibleModelsTitle: '模型白名单',
  visibleModelsHint: '只列出勾选的模型，都不勾选＝显示全部。网页与终端共用。',
  visibleModelsPick: '选择要保留的模型…',
  visibleModelsCount: '已选 {count} 个模型',
  visibleModelsShowAll: '显示全部',
  visibleModelsStaleHint: '有 {count} 个已选模型在目录中找不到了（可能已下架），不影响其他模型；可清理或保留。',
  visibleModelsCleanStale: '清理失效（{count}）',
  contextWindow: '自定义上下文长度',
  contextWindowHint: '覆盖目录公布的上下文窗口，影响上下文计量与自动压缩；留空跟随目录，支持 32K、1M。',
  contextOverridesTitle: '按模型覆盖',
  contextOverridesHint: '为单个模型设置上下文长度，优先于上面的全局值；只能选白名单中的模型。',
  contextOverrideAdd: '添加模型',
  contextOverrideRemove: '移除该模型的上下文覆盖',
  contextOverrideModel: '模型',
  contextOverrideValue: '上下文长度',
  contextOverrideNoCatalog: '模型目录尚未加载，暂时无法添加按模型覆盖。',
  contextWindowTooSmall: '上下文长度不能小于 1',
  contextWindowTooLarge: '上下文长度不能大于 10,000,000',
  contextWindowInvalid: '请输入有效的整数 token 数',
  maxOutputTokens: '单轮输出上限',
  maxOutputTokensHint: '留空按模型推导；0＝不发送该字段（仅 CLI 与 OpenAI，Claude 的 Messages 端点必填）。上限 131072，支持 64K。',
  maxOutputTokensTooSmall: '输出上限不能小于 0（0 表示不发送该字段）',
  maxOutputTokensTooLarge: '输出上限不能大于 131072（网关上限）',
  maxOutputTokensInvalid: '请输入 0 或有效的整数 token 数',
  overridden: '已自定义',
  reset: '重置',
  // 数字输入框右侧的单位后缀；标签里不再重复单位。
  unitSeconds: '秒',
  unitTokens: 'tokens',
  unitRetries: '次',
  // 空输入框里的占位：说明留空时实际用的是什么。
  placeholderCatalog: '跟随目录',
  placeholderAuto: '自动',
  invalidNumber: '无效数字',
  numberTooSmall: '重试次数不能小于 0',
  numberTooLarge: '重试次数不能大于 50',
  durationTooSmall: '不能小于 0.001 秒（1 毫秒）',
  durationTooLarge: '不能大于 3600 秒',
  durationInvalid: '请输入秒数，最多保留三位小数',
  readOnly: '当前配置为只读。',
  save: '保存',
  saving: '保存中',
  saved: '设置已保存',
  saveFailed: '保存失败，请重试。',
  writeConflict: '待提交字段已被其他操作修改，配置未写入；请核对后再保存。',
  writeConfigUnconfirmed: '配置提交未获确认，请核对宿主状态后重试。',
  writeConfigFailedDetail: '宿主返回：{error}',
  writeConfigRetryable: '这条原因看起来是临时的（配置档案被占用或等待写入锁超时），稍后重试通常能成功。',
  writeConfigSaved: '配置已保存。',
  writeKeyNotIssued: '密钥操作尚未发出；请核对后重试。',
  writeKeyUnconfirmed: '密钥操作未获确认；请核对后手动重试。',
  writeKeyConfirmed: '原引用的密钥操作已获确认。',
  writeTargetBefore: '默认密钥引用已变化，本次密钥操作未发出；请核对当前目标。',
  writeTargetAfter: '原引用的密钥操作已发出，默认引用随后变化；请核对两个引用。',
  writeClosed: '客户端已销毁，未发出的操作已停止；已确认的修改保留。',
  writeCleanupPending: '账号修改已确认，清理记录尚未收束，请重试清理。',
  writeRefreshFailed: '密钥状态刷新失败；已获确认的写入仍有效。',
  writeRefreshRetry: '仅刷新密钥状态',
  writeStateUnknown: '密钥状态尚未确认',
  writeCredentialRefNote: '（原引用：{ref}）',
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
  usageCompleted: '成功',
  usageBillingPeriod: '官方账期用量',
  usageTokens: 'Token',
  usageTokensIn: '入',
  usageTokensOut: '出',
  usagePurchased: '已购',
  usageFree: '赠送',
  usageFiveHour: '5 小时窗口',
  usageWeekly: '每周窗口',
  usageMonthlyLeft: '月额度剩余',
  usageMonthlyDepleted: '月额度已用完，已购与赠送余额将无法使用。',
  usageExceeded: '已超限',
  usageReset: '重置于',
  usagePartial: '部分端点数据不可用',
  usageKeyInvalid: 'API 密钥无效或已过期',
  usageKeyInvalidHint: '服务端拒绝了全部请求（401）。请检查该账户配置的密钥，或到 commandcode.ai 控制台重新生成。',
  usageServiceUnavailable: 'Command Code 服务暂时不可用',
  usageServiceUnavailableHint: '服务端返回了错误（5xx），稍后点击刷新重试。',
  usageNetworkError: '无法连接 Command Code 服务',
  usageNetworkHint: '所有请求都没有到达服务端。每条失败记录都会列出它尝试的地址，请核对其中的主机与端口是否和 API 地址设置一致，并检查网络连接。',
  usageInvalidResponse: 'Command Code 响应无法读取',
  usageInvalidResponseHint: '已收到响应，但正文读取或解析失败。下方详情可区分读取超时、中断与格式异常；可先点击刷新重试。',
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
  loginWaiting: '等待在浏览器中完成授权；若页面未自动打开，请点击授权链接。',
  loginOpenLink: '打开授权页面',
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
  accountsRotationHint: '当前账户达到限额或密钥失效时，请求会按列表顺序切换到下一个可用账户。',
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
  accountAddCancel: '取消开通',
  accountAddStart: '开始登录',
  accountAddMethod: '添加方式',
  accountAddLinkHint: '若登录页面未自动打开，请点击下方链接。',
  accountAddOpenLink: '打开浏览器登录',
  accountNamePlaceholder: '备注名（可选，网页登录时默认使用账户名）',
  accountNameN: '账户 {n}',
  accountNameSaveRetry: '重试保存名称',
  accountNameAcceptExisting: '接受已有名称',
  accountKeyPlaceholder: '粘贴 API 密钥',
  accountOpFailed: '账户操作未能完成，请重试。',
  accountCleanupPending: '账户已移除，但有密钥尚未清理。可重试，不影响其他账户。',
  accountCleanupRetry: '重试清理密钥',
  accountEnrollmentCleanupRetry: '重试清理',
  accountRefSeparator: '：',
  accountModels: '专用模型',
  accountModelsHint: '选中即专属：优先此账户处理，不可用时自动切换',
  accountModelOwner: '属于 {name}',
  modelPick: '选择模型…',
  modelCount: '已选 {count} 个模型',
  modelCatalogFailed: '模型目录获取失败，暂时无法选择模型；已保存的设置仍会生效。',
  modelsTitle: '模型与上下文',
  privacyTitle: '隐私与安全',
  integrationsTitle: '集成与显示',
  serviceStatusTitle: '服务状态',
  serviceStatusHint: '官方数据来自状态页的公开记录，仅在状态变化或每日汇总时发布；本机连通由宿主刚探测。',
  serviceStatusChecking: '正在检查…',
  serviceStatusUp: '服务正常',
  serviceStatusDegraded: '部分降级',
  serviceStatusDown: '服务中断',
  serviceStatusUnknown: '状态未知',
  // 服务状态行分「官方」「本机」两行；分组头徽标在本机连不上时改报本机。
  serviceStatusOfficial: '官方',
  serviceStatusLocal: '本机',
  serviceStatusUptime: '可用率 {value}',
  serviceStatusBadgeLocalHttp: '本机连接异常',
  serviceStatusBadgeLocalTimeout: '本机连接超时',
  serviceStatusBadgeLocalUnreachable: '本机无法连接',
  serviceStatusUptimeWeek: '7 天 {value}',
  serviceStatusUptimeMonth: '30 天 {value}',
  serviceStatusResponseWeek: '平均响应 {value}',
  serviceStatusUpdatedJustNow: '刚刚更新',
  serviceStatusUpdatedMinutes: '{count} 分钟前更新',
  serviceStatusUpdatedHours: '{count} 小时前更新',
  serviceStatusUpdatedDays: '{count} 天前更新',
  serviceStatusUpdatedUnknown: '更新时间未知',
  serviceStatusLag: '官方数据仅在状态变化或每日汇总时发布，可能滞后数小时。',
  serviceStatusLocalChecking: '正在探测…',
  serviceStatusLocalOk: '连通正常 · {latency} ms',
  serviceStatusLocalHttp: '连接异常（HTTP {status}）',
  serviceStatusLocalTimeout: '连接超时',
  serviceStatusLocalUnreachable: '无法连接',
  serviceStatusLocalUnavailable: '未知（宿主未提供探测）',
  serviceStatusStale: '无法获取状态数据，以下为上次成功获取的结果。',
  serviceStatusUnavailable: '无法获取状态数据。',
  serviceStatusOpen: '打开状态页',
  enrollmentCreating: '正在创建账号',
  enrollmentWaiting: '等待浏览器登录',
  enrollmentWriting: '正在保存凭据',
  enrollmentNaming: '账号已登录，正在保存名称',
  enrollmentNameFailed: '账号已登录，名称保存失败，请重试或接受已有名称',
  enrollmentFinished: '账号开通完成',
  enrollmentCancelling: '正在等待写入结束并清理',
  enrollmentCancelled: '已取消',
  enrollmentCancelledCleaned: '已取消并清理',
  enrollmentFailed: '账号开通失败，未创建账号',
  enrollmentFailedCleaned: '开通失败，已清理临时账号',
  enrollmentCleanupPending: '收尾未完成，请重试',
  enrollmentCleanupFailed: '清理未完成，请重试',
  enrollmentRecordNaming: '已登录账号等待确认名称',
  enrollmentRecordCleanup: '账号开通收尾未完成，请重试',
  enrollmentBeginFailed: '账号开通请求失败，请检查连接后重试',
  enrollmentCancelUnconfirmed: '取消请求未确认，重新连接后请检查未完成记录',
  enrollmentNameRequestFailed: '名称保存失败，请重试或接受已有名称',
  enrollmentCleanupRequestFailed: '收尾请求失败，请检查连接后重试',
  enrollmentDisconnected: '开通连接已断开，宿主正在收尾；重连后请检查未完成记录',
  enrollmentHostUnavailable: '宿主无法完成账号开通，请检查连接与写入权限',
  enrollmentStatusUnavailable: '开通状态暂不可用，正在等待重新连接',
}

export const en: Record<SettingsCommandCodeKey, string> = {
  openAnalytics: 'View model usage, cost and performance',
  nav: 'Command Code',
  title: 'Command Code',
  intro: 'Account actions apply immediately; other changes need Save below. The key stays in the local credential service and is never echoed.',
  apiKey: 'API key',
  apiKeyHint: 'Create one in the commandcode.ai console. Saving with this field'
    + ' blank keeps the stored key.',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured',
  apiKeyLocked: 'Key provided by a read-only source',
  apiBase: 'API base URL',
  requestTimeoutMs: 'Request timeout',
  requestTimeoutMsHint: 'Wait for the first response byte; default 300 s. The Provider API route answers only after the upstream’s first token, so raise it for a slow upstream.',
  streamIdleTimeoutMs: 'Stream idle timeout',
  streamIdleTimeoutMsHint: 'How long a stalled stream counts as dead; default 300 s (long-thinking models can go quiet for minutes).',
  transportMaxRetries: 'Transport retries',
  transportMaxRetriesHint: 'Automatic retries after a failed connection; default 5 (~15 s in all). 0 disables them; rate limits and 5xx keep their own retries.',
  offloadSeenImagesForCache: 'Stop replaying images already seen',
  offloadSeenImagesForCacheHint: 'CLI transport only. Images the model already answered become text placeholders, so a new image no longer rolls back the cache; to see one again, reread or reattach it.',
  advancedSettings: 'Advanced',
  advancedSettingsHint: 'API base URL and network limits; usually leave as-is.',
  groupOverriddenOne: '1 customized',
  groupOverriddenMany: '{count} customized',
  groupInvalid: 'Needs a fix',
  saveLocate: 'Show',
  accountsSummaryOne: '1 account',
  accountsSummaryMany: '{count} accounts',
  accountsSummaryIssues: '{count} need attention',
  visibleModelsSummary: '{count} allowlisted',
  visibleModelsSummaryAll: 'All models shown',
  zdrSummaryOn: 'ZDR on',
  zdrSummaryOff: 'ZDR off',
  webSearchSummaryOn: 'Web search on',
  webSearchSummaryOff: 'Web search off',
  filterModelsByPlan: 'Hide out-of-plan models',
  filterModelsByPlanHint: 'Show only models in your plan; on-demand credit accounts still see the full catalog.',
  webSearch: 'Serve dsh web search with Command Code',
  webSearchHint: 'Use the same key for dsh web search. No effect while the Web search settings pin another backend.',
  showSidebarQuota: 'Show the quota card in the sidebar',
  showSidebarQuotaHint: 'Show a plan and quota card at the bottom of the sidebar that opens the full dashboard; while off, nothing refreshes in the background.',
  zdr: 'Zero data retention (ZDR)',
  zdrHint: 'Use only upstreams that retain no data and do not train on requests; availability and pricing may differ.',
  accountsTitle: 'Accounts',
  accountsHint: 'Add more accounts and requests switch to the next one when the current account hits its usage limit or its key stops working.',
  accountAdd: 'Add account',
  accountDefault: 'Default account',
  modelSearchPlaceholder: 'Search models…',
  modelSearchEmpty: 'No matching models.',
  modelStale: 'Retired',
  modelAllowance: '${amount}/mo',
  modelAllowanceTitle: 'Monthly usage this model can draw, in USD. Every model shares one monthly pool — this is not extra credit on top of the plan.',
  visibleModelsTitle: 'Model allowlist',
  visibleModelsHint: 'Only checked models are listed; none checked shows all. Web and terminal share this.',
  visibleModelsPick: 'Select models to keep…',
  visibleModelsCount: '{count} model(s) selected',
  visibleModelsShowAll: 'Show all',
  visibleModelsStaleHint: '{count} selected model(s) are no longer in the catalog (possibly retired);'
    + ' other models are unaffected. Clean them up or keep them.',
  visibleModelsCleanStale: 'Clean stale ({count})',
  contextWindow: 'Custom context length',
  contextWindowHint: 'Overrides the catalog’s context window; the context meter and auto-compaction follow it. Empty follows the catalog; 32K or 1M accepted.',
  contextOverridesTitle: 'Per-model overrides',
  contextOverridesHint: 'Set one model’s context length; it wins over the global value above. Only allowlisted models can be picked.',
  contextOverrideAdd: 'Add model',
  contextOverrideRemove: 'Remove this model’s context override',
  contextOverrideModel: 'Model',
  contextOverrideValue: 'Context length',
  contextOverrideNoCatalog: 'The model catalog has not loaded yet; per-model overrides cannot be added right now.',
  contextWindowTooSmall: 'Context length must be at least 1',
  contextWindowTooLarge: 'Context length must not exceed 10,000,000',
  contextWindowInvalid: 'Enter a valid whole-token count',
  maxOutputTokens: 'Output limit per turn',
  maxOutputTokensHint: 'Empty derives it from the model. 0 omits the field (CLI and OpenAI only; Claude’s Messages endpoint requires it). Capped at 131,072; 64K accepted.',
  maxOutputTokensTooSmall: 'Output limit must be at least 0 (0 omits the field)',
  maxOutputTokensTooLarge: 'Output limit must not exceed 131,072 (the gateway cap)',
  maxOutputTokensInvalid: 'Enter 0 or a valid whole-token count',
  overridden: 'Customized',
  reset: 'Reset',
  unitSeconds: 's',
  unitTokens: 'tokens',
  unitRetries: 'times',
  placeholderCatalog: 'Catalog',
  placeholderAuto: 'Auto',
  invalidNumber: 'Invalid number',
  numberTooSmall: 'Retries must be at least 0',
  numberTooLarge: 'Retries must not exceed 50',
  durationTooSmall: 'Must be at least 0.001 seconds (1 ms)',
  durationTooLarge: 'Must not exceed 3600 seconds',
  durationInvalid: 'Enter seconds with at most three decimal places',
  readOnly: 'Settings are read-only.',
  save: 'Save',
  saving: 'Saving',
  saved: 'Settings saved',
  saveFailed: 'Save failed, please retry.',
  writeConflict: 'Pending fields were modified by another operation; the configuration was not written. Please review and save again.',
  writeConfigUnconfirmed: 'The configuration submission was not confirmed. Please check the host state and retry.',
  writeConfigFailedDetail: 'The host reported: {error}',
  writeConfigRetryable: 'That reason looks transient (a busy profile or a lock timeout); retrying usually works.',
  writeConfigSaved: 'Configuration saved.',
  writeKeyNotIssued: 'The key operation has not been issued; please review and retry.',
  writeKeyUnconfirmed: 'The key operation was not confirmed; please review and retry manually.',
  writeKeyConfirmed: 'The key operation on the original reference has been confirmed.',
  writeTargetBefore: 'The default key reference has changed; this key operation was not issued. Please check the current target.',
  writeTargetAfter: 'The key operation on the original reference was issued, then the default reference changed. Please check both references.',
  writeClosed: 'The client has been destroyed; unissued operations were stopped. Confirmed changes are kept.',
  writeCleanupPending: 'The account change was confirmed, but cleanup records are still pending. Please retry cleanup.',
  writeRefreshFailed: 'Key status refresh failed; confirmed writes remain valid.',
  writeRefreshRetry: 'Refresh key status only',
  writeStateUnknown: 'Key status not yet confirmed',
  writeCredentialRefNote: '(original ref: {ref})',
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
  usageCompleted: 'Completed',
  usageBillingPeriod: 'Official billing-period usage',
  usageTokens: 'Tokens',
  usageTokensIn: 'in',
  usageTokensOut: 'out',
  usagePurchased: 'Purchased',
  usageFree: 'Free',
  usageFiveHour: '5-hour window',
  usageWeekly: 'Weekly window',
  usageMonthlyLeft: 'Monthly left',
  usageMonthlyDepleted: 'Monthly credit is used up; purchased and free credit can no longer be spent.',
  usageExceeded: 'Exceeded',
  usageReset: 'Resets',
  usagePartial: 'Some endpoint data unavailable',
  usageKeyInvalid: 'API key invalid or expired',
  usageKeyInvalidHint: 'The server rejects every request (401). Check the key configured for this account, or generate a new one in the commandcode.ai console.',
  usageServiceUnavailable: 'The Command Code service is temporarily unavailable',
  usageServiceUnavailableHint: 'The server returned errors (5xx); try Refresh again later.',
  usageNetworkError: 'Could not reach the Command Code service',
  usageNetworkHint: 'No request reached the server. Each failed attempt lists the address it tried — compare its host and port with the API base setting, and check the network connection.',
  usageInvalidResponse: 'Could not read the Command Code response',
  usageInvalidResponseHint: 'Responses arrived, but reading or parsing their bodies failed. Details below distinguish timeouts, interrupted reads, and invalid formats. Try Refresh again.',
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
  loginWaiting: 'Waiting for authorization in your browser. If the page did not open automatically, use the authorization link.',
  loginOpenLink: 'Open the authorization page',
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
  accountsRotationHint: 'When the current account hits its limit or its key stops working, requests switch to the next usable account in list order.',
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
  accountAddCancel: 'Cancel setup',
  accountAddStart: 'Start sign-in',
  accountAddMethod: 'Method',
  accountAddLinkHint: 'If the sign-in page did not open automatically, use the link below.',
  accountAddOpenLink: 'Open the sign-in page',
  accountNamePlaceholder: 'Name (optional; sign-in uses the account name)',
  accountNameN: 'Account {n}',
  accountNameSaveRetry: 'Retry saving the name',
  accountNameAcceptExisting: 'Accept the existing name',
  accountKeyPlaceholder: 'Paste an API key',
  accountOpFailed: 'The account change did not complete. Try again.',
  accountCleanupPending: 'The account was removed, but credential cleanup is still pending. Retry without affecting other accounts.',
  accountCleanupRetry: 'Retry credential cleanup',
  accountEnrollmentCleanupRetry: 'Retry cleanup',
  accountRefSeparator: ': ',
  accountModels: 'Dedicated models',
  accountModelsHint: 'Selected models are dedicated to this account and still switch when unavailable',
  accountModelOwner: 'on {name}',
  modelPick: 'Choose models…',
  modelCount: '{count} models selected',
  modelCatalogFailed: 'The model catalog could not be loaded; saved settings still apply.',
  modelsTitle: 'Models & context',
  privacyTitle: 'Privacy & security',
  integrationsTitle: 'Integrations & display',
  serviceStatusTitle: 'Service status',
  serviceStatusHint: 'Published data comes from the official status page and is only written on a status change or the daily summary; local connectivity is probed by the host just now.',
  serviceStatusChecking: 'Checking…',
  serviceStatusUp: 'Operational',
  serviceStatusDegraded: 'Degraded performance',
  serviceStatusDown: 'Service outage',
  serviceStatusUnknown: 'Status unknown',
  serviceStatusOfficial: 'Official',
  serviceStatusLocal: 'This device',
  serviceStatusUptime: 'uptime {value}',
  serviceStatusBadgeLocalHttp: 'Connection error here',
  serviceStatusBadgeLocalTimeout: 'Timing out here',
  serviceStatusBadgeLocalUnreachable: 'Unreachable here',
  serviceStatusUptimeWeek: '7d {value}',
  serviceStatusUptimeMonth: '30d {value}',
  serviceStatusResponseWeek: 'avg {value}',
  serviceStatusUpdatedJustNow: 'updated just now',
  serviceStatusUpdatedMinutes: 'updated {count} min ago',
  serviceStatusUpdatedHours: 'updated {count} h ago',
  serviceStatusUpdatedDays: 'updated {count} d ago',
  serviceStatusUpdatedUnknown: 'update time unknown',
  serviceStatusLag: 'Official data is only published on a status change or the daily summary, so it may lag by hours.',
  serviceStatusLocalChecking: 'Probing…',
  serviceStatusLocalOk: 'Reachable · {latency} ms',
  serviceStatusLocalHttp: 'Error (HTTP {status})',
  serviceStatusLocalTimeout: 'Timed out',
  serviceStatusLocalUnreachable: 'Unreachable',
  serviceStatusLocalUnavailable: 'Unknown (host provides no probe)',
  serviceStatusStale: 'Status data unavailable; showing the last known result.',
  serviceStatusUnavailable: 'Status data unavailable.',
  serviceStatusOpen: 'Open status page',
  enrollmentCreating: 'Creating the account',
  enrollmentWaiting: 'Waiting for the browser sign-in',
  enrollmentWriting: 'Saving the credential',
  enrollmentNaming: 'Signed in. Saving the name',
  enrollmentNameFailed: 'Signed in, but saving the name failed. Retry, or accept the existing name.',
  enrollmentFinished: 'Account setup complete',
  enrollmentCancelling: 'Waiting for the write to finish, then cleaning up',
  enrollmentCancelled: 'Cancelled',
  enrollmentCancelledCleaned: 'Cancelled and cleaned up',
  enrollmentFailed: 'Account setup failed. No account was created.',
  enrollmentFailedCleaned: 'Setup failed; the temporary account was cleaned up.',
  enrollmentCleanupPending: 'Cleanup is not finished. Please retry.',
  enrollmentCleanupFailed: 'Cleanup failed. Please retry.',
  enrollmentRecordNaming: 'Signed-in account waiting for its name to be confirmed',
  enrollmentRecordCleanup: 'Account setup was not finished. Please retry.',
  enrollmentBeginFailed: 'The account setup request failed. Check the connection and retry.',
  enrollmentCancelUnconfirmed: 'The cancel request was not confirmed. After reconnecting, check for unfinished records.',
  enrollmentNameRequestFailed: 'Saving the name failed. Retry, or accept the existing name.',
  enrollmentCleanupRequestFailed: 'The cleanup request failed. Check the connection and retry.',
  enrollmentDisconnected: 'The setup connection dropped; the host is finishing up. After reconnecting, check for unfinished records.',
  enrollmentHostUnavailable: 'The host could not complete the account setup. Check the connection and write permissions.',
  enrollmentStatusUnavailable: 'Setup status is unavailable; waiting to reconnect.',
}

/** 同一确认结果在设置页和模型卡使用相同措辞，不从 configured 推断写入结果。 */
export function settingsWriteNotice(
  result: import('./settings-write.ts').SettingsWriteResult | undefined,
  t: (key: SettingsCommandCodeKey) => string,
): string {
  if (!result) return ''
  let key: SettingsCommandCodeKey | undefined
  if (result.issue === 'closed') key = 'writeClosed'
  else if (result.issue === 'target-changed') key = result.credential === 'not-issued' ? 'writeTargetBefore' : 'writeTargetAfter'
  else if (result.issue === 'cleanup-pending') key = 'writeCleanupPending'
  else if (result.config === 'conflict') key = 'writeConflict'
  else if (result.config === 'unconfirmed') key = 'writeConfigUnconfirmed'
  else if (result.credential === 'unconfirmed') key = 'writeKeyUnconfirmed'
  else if (result.credential === 'not-issued') key = 'writeKeyNotIssued'
  const messages = key ? [t(key)] : []
  if (result.configError !== undefined && result.configError !== '') {
    // The fixed copy can only say "not confirmed"; the Host's own words are the
    // only part the user can act on. A wait for `package.json.lock` that timed
    // out, an authorization refusal and a rejected value must be tellable
    // apart on the page. Long reasons are clipped so the notice stays a notice.
    const reason = result.configError.length > 200 ? `${result.configError.slice(0, 200)}…` : result.configError
    messages.push(t('writeConfigFailedDetail').replace('{error}', reason))
    if (configErrorLooksTransient(result.configError)) messages.push(t('writeConfigRetryable'))
  }
  if (result.issue === 'target-changed' && result.credentialRef) {
    messages.push(t(result.credential === 'confirmed' ? 'writeKeyConfirmed' : 'writeKeyUnconfirmed'))
    messages.push(t('writeCredentialRefNote').replace('{ref}', result.credentialRef))
  }
  if (key && result.config === 'confirmed' && result.issue !== 'cleanup-pending') messages.unshift(t('writeConfigSaved'))
  if (result.refreshFailed) messages.push(t('writeRefreshFailed'))
  return messages.join(' ')
}

/**
 * 宿主拒绝写入的原因是否值得立刻重试。
 *
 * 设置写入是“再试一次可能就好了”和“再试一百次也一样”的分界线：配置文件被
 * 别的进程持有的锁挡住（`atomic-write: timed out waiting for the writer lock
 * at …`）、宿主报告 `PROFILE_BUSY`、EBUSY/EAGAIN 这类都是前者；权限拒绝、
 * 结构校验失败是后者。判错的代价只是多一句提示，但少这一句用户只能盲试。
 */
function configErrorLooksTransient(message: string): boolean {
  return /PROFILE_BUSY|EAGAIN|EBUSY|ETIMEDOUT|EAI_AGAIN|writer lock|timed out|timeout|temporarily unavailable|busy/i
    .test(message)
}
