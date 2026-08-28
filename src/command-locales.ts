/**
 * Locale copy for the `/commandcode` usage command and the friendly
 * image-gate error rewrite. Distinct from `./client/locales.ts` (the
 * settings-page namespace `settings.commandcode`): the command runs on the
 * Host and has no access to the client's `ctx.locale`, so the dictionaries
 * are exposed as plain constants for direct lookup; the resolver lives in
 * `pickCommandLocale()`. The image-gate wrapper also lives on the client
 * but is reached from a non-React path that has no `t` in scope, so the
 * same dictionaries serve both surfaces.
 *
 * zh is the source of truth for the key set; en must carry the exact same
 * keys — a mismatch is a compile error at the lookup site.
 */

/** Active locale id recognized by the command and the image-gate wrapper. */
export type LocaleId = 'zh' | 'en'

/** Dictionary keys used by the `/commandcode` command and the image-gate wrapper. */
export type CommandCodeCommandKey =
  | 'title'                   // top heading of a single-account report
  | 'accountTitle'            // per-account heading in the multi-account view
  | 'accountSeparator'        // rule between accounts in the multi-account view
  | 'activeBadge'             // "currently serving" badge
  | 'invalidCredentialBadge'  // mark for an account whose key is invalid
  | 'cooldownBadge'           // mark for an account in rate-limit cooldown
  | 'rateLimitBadge'          // mark when the pool has marked a key rate-limited
  | 'unconfigured'            // one-account row when the slot has no key
  | 'blockedInvalidKey'       // top-of-report block when the whole account is 401
  | 'blockedServiceUnavailable' // 5xx
  | 'blockedNetwork'          // network unreachable
  | 'planLine'                // "  📦 套餐    {name}{status}{period}"
  | 'planPeriodSuffix'        // " · 账期截止 {date}" / " · period ends {date}"
  | 'usageHeader'             // "── 请求 ─────..."
  | 'requestsLine'            // "  💬 请求    {n} 次 / 失败 {f}  成功率 {r}%"
  | 'costLine'                // "  💰 花费    {money}  ({credits} credits)"
  | 'tokensLine'              // "  🔤 Token   {in} 入 / {out} 出"
  | 'creditsHeader'           // "── 信用 ─────..."
  | 'monthlyLine'             // "  💳 月额度  {monthly}   (已购 {purchased} / 赠送 {free})"
  | 'barLine'                 // "     └ {bar}  {pct}%"
  | 'windowsHeader'           // "── 窗口用量 ─────..."
  | 'fiveHourLine'            // "  ⏱ 5 小时  {used} / {cap}{warn}"
  | 'weeklyLine'              // "  📅 每周    {used} / {cap}{warn}"
  | 'windowBarLine'           // "     └ {bar}  重置 {when}"
  | 'exceededWarning'         // the trailing "  ⚠️ 超限!" / "  ⚠️ exceeded!"
  | 'resetSuffix'             // "重置 {when}" (the suffix after the bar)
  | 'partialFailures'         // "⚠️  部分端点失败: {list}"
  | 'noData'                  // "(no data — check your API key)"
  | 'errorText'               // "Could not fetch Command Code usage: {message}"
  | 'imageGate'               // image-gate rejection rewrite (with {model})

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
    resetSuffix: '重置 {when}',
    partialFailures: '⚠️  部分端点失败: {list}',
    noData: '(no data — check your API key)',
    errorText: 'Could not fetch Command Code usage: {message}',
    imageGate:
      '当前会话已包含图片，而模型 {model} 不支持图片输入；'
      + '请选择支持图片的模型，或先移除会话中的图片。',
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
    resetSuffix: 'resets {when}',
    partialFailures: '⚠️  some endpoints failed: {list}',
    noData: '(no data — check your API key)',
    errorText: 'Could not fetch Command Code usage: {message}',
    imageGate:
      'This session already contains images, and model {model} does not accept'
      + ' image input; please select an image-capable model, or remove the'
      + ' images from the session first.',
  },
}

/**
 * Resolve the active locale for a Host-side command run.
 *
 * Priority: explicit `override` (from `Config.lang`) → `LC_ALL` → `LANG` →
 * the conventional fallback (`'zh'`, matching the existing single-language
 * behavior so unconfigured deployments keep their current output).
 *
 * The values are matched on the leading tag only — `zh_CN.UTF-8`,
 * `zh-Hans`, `zh` all map to `'zh'`; everything starting with `en` maps to
 * `'en'`; anything else falls back to `'zh'` (a non-`en` shell that
 * already has Chinese in the terminal is the closest sensible default;
 * a Western shell that happens to be neither keeps the existing Chinese
 * output rather than swapping to half-translated English).
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
