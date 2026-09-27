/**
 * zh/en copy for the Host-side `/commandcode` usage command, as plain
 * constants: the command runs on the Host and has no access to the client's
 * `ctx.locale`, so the active locale is resolved by `pickCommandLocale()` and
 * the dictionaries are read by direct lookup. Distinct from
 * `./client/locales.ts` (the settings-page `settings.commandcode` namespace).
 *
 * zh is the source of truth for the key set; `en` must carry exactly the same
 * keys, which the `Record` type makes a compile error.
 */

/** Active locale id for the `/commandcode` command. */
export type LocaleId = 'zh' | 'en'

/** Dictionary keys used by the `/commandcode` command. */
export type CommandCodeCommandKey =
  | 'title'                   // top heading of a single-account report
  | 'accountTitle'            // per-account heading in the multi-account view
  | 'accountSeparator'        // rule between accounts in the multi-account view
  | 'unconfigured'            // one-account row when the slot has no key
  | 'blockedInvalidKey'       // top-of-report block when the whole account is 401
  | 'blockedServiceUnavailable' // 5xx
  | 'blockedInvalidResponse'  // received an unreadable response body
  | 'blockedNetwork'          // network unreachable
  | 'activeBadge'
  | 'invalidCredentialBadge'
  | 'cooldownBadge'
  | 'rateLimitBadge'
  | 'planLine'
  | 'planPeriodSuffix'
  | 'usageHeader'
  | 'requestsLine'
  | 'costLine'
  | 'tokensLine'
  | 'creditsHeader'
  | 'monthlyLine'
  | 'barLine'
  | 'windowsHeader'
  | 'fiveHourLine'
  | 'weeklyLine'
  | 'windowBarLine'
  | 'exceededWarning'
  | 'partialFailures'
  | 'noData'
  | 'errorText'

export const commandcodeCommand: Record<LocaleId, Record<CommandCodeCommandKey, string>> = {
  zh: {
    title: '📊 Command Code 用量{account}',
    accountTitle: '📊 {label}{badges}',
    accountSeparator: '────────────────────',
    activeBadge: '  ✅ 当前使用',
    invalidCredentialBadge: '  ⛔ 密钥无效',
    cooldownBadge: '  ⏳ 限额冷却中，重置 {when}',
    rateLimitBadge: '  ⏳ 已达限额（等待窗口探测）',
    unconfigured: '  (未配置 API 密钥)',
    blockedInvalidKey:
      '⛔ API 密钥无效或已过期 — 服务端拒绝了全部请求（401），请检查该账户的密钥配置',
    blockedServiceUnavailable:
      '⚠️ Command Code 服务暂时不可用（5xx），稍后重试',
    blockedInvalidResponse:
      '⚠️ Command Code 返回了无法读取的响应 — 请检查宿主的 HTTP 代理或响应解压配置',
    blockedNetwork:
      '⚠️ 无法连接 Command Code 服务 — 请检查网络或 API 地址',
    planLine: '  📦 套餐    {name}{status}{period}',
    planPeriodSuffix: ' · 账期截止 {date}',
    usageHeader: '── 请求 ──────────────────────────────',
    requestsLine: '  💬 请求    {n} 次 / 失败 {f}  成功率 {r}%',
    costLine: '  💰 花费    {money}  ({credits} credits)',
    tokensLine: '  🔤 Token   {in} 入 / {out} 出',
    creditsHeader: '── 信用 ──────────────────────────────',
    monthlyLine: '  💳 月额度  {monthly}   (已购 {purchased} / 赠送 {free})',
    barLine: '     └ {bar}  {pct}%',
    windowsHeader: '── 窗口用量 ──────────────────────────',
    fiveHourLine: '  ⏱ 5 小时  {used} / {cap}{warn}',
    weeklyLine: '  📅 每周    {used} / {cap}{warn}',
    windowBarLine: '     └ {bar}  重置 {when}',
    exceededWarning: '  ⚠️ 超限!',
    partialFailures: '⚠️  部分端点失败: {list}',
    noData: '（无数据 — 请检查 API 密钥）',
    errorText: '获取 Command Code 用量失败：{message}',
  },
  en: {
    title: '📊 Command Code usage{account}',
    accountTitle: '📊 {label}{badges}',
    accountSeparator: '────────────────────',
    activeBadge: '  ✅ active',
    invalidCredentialBadge: '  ⛔ invalid key',
    cooldownBadge: '  ⏳ cooling down, resets {when}',
    rateLimitBadge: '  ⏳ rate-limited (waiting for window probe)',
    unconfigured: '  (no API key configured)',
    blockedInvalidKey:
      '⛔ API key invalid or expired — the server rejected every request (401); check the key configured for this account',
    blockedServiceUnavailable:
      '⚠️ Command Code service temporarily unavailable (5xx); try again later',
    blockedInvalidResponse:
      '⚠️ Command Code returned an unreadable response — check the host HTTP proxy or response decoding',
    blockedNetwork:
      '⚠️ could not reach the Command Code service — check your network or the API base setting',
    planLine: '  📦 Plan     {name}{status}{period}',
    planPeriodSuffix: ' · period ends {date}',
    usageHeader: '── Requests ──────────────────────────',
    requestsLine: '  💬 Requests {n} / failed {f}  success rate {r}%',
    costLine: '  💰 Spend    {money}  ({credits} credits)',
    tokensLine: '  🔤 Tokens   {in} in / {out} out',
    creditsHeader: '── Credits ───────────────────────────',
    monthlyLine: '  💳 Monthly  {monthly}   (purchased {purchased} / free {free})',
    barLine: '     └ {bar}  {pct}%',
    windowsHeader: '── Window usage ──────────────────────',
    fiveHourLine: '  ⏱ 5-hour   {used} / {cap}{warn}',
    weeklyLine: '  📅 Weekly   {used} / {cap}{warn}',
    windowBarLine: '     └ {bar}  resets {when}',
    exceededWarning: '  ⚠️ exceeded!',
    partialFailures: '⚠️  some endpoints failed: {list}',
    noData: '(no data — check your API key)',
    errorText: 'Could not fetch Command Code usage: {message}',
  },
}

/**
 * Resolve the active locale for a Host-side command run: explicit `override`
 * (from `Config.lang`) → `LC_ALL` → `LANG` → the `'zh'` fallback that keeps
 * unconfigured deployments on their current output.
 *
 * Matched on the leading tag only — `zh_CN.UTF-8`, `zh-Hans` and `zh` all
 * map to `'zh'`, anything starting with `en` maps to `'en'`, everything else
 * falls back to `'zh'` rather than to half-translated English.
 */
export function pickCommandLocale(
  override: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env as Record<string, string | undefined>,
): LocaleId {
  if (override === 'zh' || override === 'en') return override
  const raw = env.LC_ALL ?? env.LANG ?? ''
  const tag = raw.toLowerCase().split(/[._-]/)[0] ?? ''
  if (tag === 'en') return 'en'
  return 'zh'
}

/** Look up a key in the active locale, with an internal en fallback. */
export function commandCopy(locale: LocaleId, key: CommandCodeCommandKey): string {
  return commandcodeCommand[locale][key] ?? commandcodeCommand.en[key] ?? key
}
