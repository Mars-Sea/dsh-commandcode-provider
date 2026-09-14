/**
 * English copy for the Command Code **plans & quota panel** (the sidebar
 * footer card and the center-column dashboard it opens).
 *
 * Deliberately NOT part of the `settings.commandcode` locale namespace: that
 * namespace follows the harness's active language, and this surface is
 * specified to read in English regardless of it. Keeping the strings out of
 * the locale registry is what makes that a fact rather than a preference —
 * there is no dictionary lookup that could resolve to Chinese.
 *
 * The settings page keeps its own bilingual `settings.commandcode` namespace
 * (see `./locales.ts`); the two never mix.
 *
 * @module dsh-commandcode-provider/client/panel-copy
 */

/**
 * The plans & quota panel key set. `zh` in the settings namespace is the
 * source of truth there; here English is the only locale, so this union is
 * the key set.
 */
export type PanelKey =
  /** Footer card title and panel heading. */
  | 'nav'
  /** Panel sub-heading under the title. */
  | 'subtitle'
  /** Refresh button / in-flight label. */
  | 'refresh'
  | 'refreshing'
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

/** The panel's literal string table. */
export const PANEL_COPY: Record<PanelKey, string> = {
  nav: 'Command Code',
  subtitle: 'Plans, credits and quota windows',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
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

/** Look up one panel string. The fallback key keeps a bad call visible, never blank. */
export function panelText(key: PanelKey): string {
  return PANEL_COPY[key] ?? key
}
