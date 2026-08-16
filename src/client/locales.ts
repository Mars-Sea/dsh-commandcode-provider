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
}
