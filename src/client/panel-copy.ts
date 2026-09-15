/**
 * Bilingual copy for the Command Code **plans & quota panel** (the sidebar
 * footer card and the center-column dashboard it opens).
 *
 * The panel follows the harness's active language: `PANEL_LOCALE_NS` is a
 * registered locale namespace (`ctx.locale.register`), both panel slot
 * registrations declare it, and the renderer hands the component a `t` seat
 * whose identity changes on a language switch (so a memoized panel re-renders).
 * {@link buildPanelView} takes that translator as an input and builds every
 * string through it — the projection stays React-free and testable, and no
 * component carries copy of its own.
 *
 * The settings page keeps its own `settings.commandcode` namespace (see
 * `./locales.ts`); the two never mix.
 *
 * @module dsh-commandcode-provider/client/panel-copy
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the plans & quota panel (footer card + dashboard). */
    'panel.commandcode': PanelKey
  }
}

/**
 * The plans & quota panel key set. `zh` is the source of truth for the key set
 * (repo convention); en must carry the exact same keys — a mismatch is a
 * compile error at the register site.
 */
export type PanelKey =
  /** Footer card title and panel heading. */
  | 'nav'
  /** Panel sub-heading under the title. */
  | 'subtitle'
  /** Refresh button / in-flight label. */
  | 'refresh'
  | 'refreshing'
  /** Dashboard exit: the button's accessible name and its tooltip. */
  | 'close'
  | 'closeHint'
  /** First-paint fetch. */
  | 'loading'
  /** No credential at all: how to get one. */
  | 'noKey'
  | 'noKeyHint'
  /** Report section headings. */
  | 'plan'
  | 'credits'
  | 'limits'
  | 'usage'
  /** Monthly credit state and its tiles. */
  | 'monthly'
  | 'monthlyLimit'
  | 'monthlyUsed'
  | 'remaining'
  | 'purchased'
  | 'free'
  /** Usage-window rows (long labels in the dashboard, short in the footer). */
  | 'fiveHour'
  | 'weekly'
  | 'fiveHourShort'
  | 'weeklyShort'
  | 'windowUnlimited'
  | 'exceeded'
  | 'exhausted'
  | 'resets'
  /** Usage tiles. */
  | 'requests'
  | 'failed'
  | 'successRate'
  | 'spend'
  | 'tokens'
  | 'tokensIn'
  | 'tokensOut'
  /** Meta line. */
  | 'periodEnds'
  | 'updated'
  | 'partial'
  /** Rotation state on an account. */
  | 'active'
  | 'coolingDown'
  | 'invalidKey'
  /** Footer-card plan fallbacks. */
  | 'unconfigured'
  | 'unavailable'
  /** Whole-report failures (mirrors the settings card's blocked taxonomy). */
  | 'errorInvalidKey'
  | 'errorInvalidKeyHint'
  | 'errorServiceUnavailable'
  | 'errorServiceUnavailableHint'
  | 'errorNetwork'
  | 'errorNetworkHint'
  /** A fetch that failed for any other reason. */
  | 'errorGeneric'

/** The locale namespace both panel slots bind their `t` seat to. */
export const PANEL_LOCALE_NS = 'panel.commandcode'

/** A panel translator: one key in, one localized string out. */
export type PanelTranslator = (key: PanelKey) => string

/** The panel's Simplified Chinese string table (the key-set source of truth). */
export const PANEL_COPY_ZH: Record<PanelKey, string> = {
  nav: 'Command Code',
  subtitle: '套餐、额度与配额窗口',
  refresh: '刷新',
  refreshing: '刷新中…',
  close: '关闭',
  closeHint: '返回会话',
  loading: '正在获取账户用量…',
  noKey: '尚未配置 API 密钥',
  noKeyHint: '在 设置 → Command Code 中粘贴密钥或登录后，点击刷新。',
  plan: '套餐',
  credits: '额度',
  limits: '配额窗口',
  usage: '用量',
  monthly: '月额度',
  monthlyLimit: '月额度上限',
  monthlyUsed: '本月已用',
  remaining: '剩余',
  purchased: '已购',
  free: '赠送',
  fiveHour: '5 小时窗口',
  weekly: '每周窗口',
  fiveHourShort: '5 小时',
  weeklyShort: '每周',
  windowUnlimited: '不限',
  exceeded: '已超限',
  exhausted: '已用尽',
  resets: '重置于',
  requests: '请求',
  failed: '失败',
  successRate: '成功率',
  spend: '花费',
  tokens: 'Token',
  tokensIn: '入',
  tokensOut: '出',
  periodEnds: '账期截止',
  updated: '更新于',
  partial: '部分端点数据不可用',
  active: '当前使用',
  coolingDown: '限额冷却中',
  invalidKey: '密钥无效',
  unconfigured: '未配置',
  unavailable: '无数据',
  errorInvalidKey: 'API 密钥无效或已过期',
  errorInvalidKeyHint: '服务端拒绝了全部请求（401）。请检查该账户的密钥，或到 commandcode.ai 控制台重新生成。',
  errorServiceUnavailable: 'Command Code 服务暂时不可用',
  errorServiceUnavailableHint: '服务端返回错误（5xx），请稍后点击刷新重试。',
  errorNetwork: '无法连接 Command Code 服务',
  errorNetworkHint: '所有请求都没有到达服务端。请检查网络连接或 API 地址设置。',
  errorGeneric: '用量获取失败',
}

/** The panel's English string table (must mirror {@link PANEL_COPY_ZH}). */
export const PANEL_COPY_EN: Record<PanelKey, string> = {
  nav: 'Command Code',
  subtitle: 'Plans, credits and quota windows',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  close: 'Close',
  closeHint: 'Back to the conversation',
  loading: 'Loading account usage…',
  noKey: 'No API key configured',
  noKeyHint: 'Paste a key — or sign in — under Settings → Command Code, then refresh.',
  plan: 'Plan',
  credits: 'Credits',
  limits: 'Quota windows',
  usage: 'Usage',
  monthly: 'Monthly',
  monthlyLimit: 'Monthly limit',
  monthlyUsed: 'Monthly used',
  remaining: 'Remaining',
  purchased: 'Purchased',
  free: 'Free',
  fiveHour: '5-hour window',
  weekly: 'Weekly window',
  fiveHourShort: '5-hour',
  weeklyShort: 'Weekly',
  windowUnlimited: 'unlimited',
  exceeded: 'Exceeded',
  exhausted: 'Used up',
  resets: 'Resets',
  requests: 'Requests',
  failed: 'failed',
  successRate: 'Success rate',
  spend: 'Spend',
  tokens: 'Tokens',
  tokensIn: 'in',
  tokensOut: 'out',
  periodEnds: 'Period ends',
  updated: 'Updated',
  partial: 'Some endpoint data unavailable',
  active: 'Active',
  coolingDown: 'Cooling down',
  invalidKey: 'Invalid key',
  unconfigured: 'Not configured',
  unavailable: 'No data',
  errorInvalidKey: 'API key invalid or expired',
  errorInvalidKeyHint: 'The server rejected every request (401). Check the key for this account, or generate a new one in the commandcode.ai console.',
  errorServiceUnavailable: 'The Command Code service is temporarily unavailable',
  errorServiceUnavailableHint: 'The server returned errors (5xx). Try Refresh again in a moment.',
  errorNetwork: 'Could not reach the Command Code service',
  errorNetworkHint: 'No request reached the server. Check your network connection or the API base setting.',
  errorGeneric: 'Could not fetch account usage',
}

/** Every panel key, in the English table's declaration order. */
export const PANEL_KEYS: readonly PanelKey[] = Object.keys(PANEL_COPY_EN) as PanelKey[]

/**
 * The English translator. Used as the fallback when no locale seat is
 * available (a defensive path: every supported engine supplies one) and as the
 * default in tests that only assert the projection's figures.
 */
export function panelTextEN(key: PanelKey): string {
  return PANEL_COPY_EN[key] ?? key
}
