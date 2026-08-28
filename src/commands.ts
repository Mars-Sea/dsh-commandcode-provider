/**
 * `/commandcode` slash command — account usage dashboard.
 *
 *   /commandcode            show account, usage, and credit state
 *   /commandcode status     same as bare `/commandcode`
 *
 * Backed by the Command Code account endpoints the official CLI uses
 * (`/alpha/whoami`, `/alpha/usage/summary`, `/alpha/billing/credits`),
 * exposed through `CommandCodeAdapter.getUsage()`.
 *
 * The command is Host-side and has no access to the client's `ctx.locale`;
 * the active locale is resolved through `deps.getLocale()` (supplied by the
 * plugin entry from `Config.lang` and the shell's `LC_ALL`/`LANG`). All
 * user-facing copy lives in `./command-locales.ts`; the dictionaries
 * resolve to identical keys, so a missing or unknown locale falls back to
 * `en` rather than dropping text.
 *
 * @module dsh-commandcode-provider/commands
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import that loads the module augmentation (`ctx.commands`).
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { CommandCodeAdapter } from './adapter.ts'
import type { CommandCodeConnectionOptions, CommandCodeUsageReport } from './adapter.ts'
import type { CommandCodeAccountUsage, CommandCodeAccountsReport } from './usage-wire.ts'
import { commandCopy, type LocaleId } from './command-locales.ts'

/** Everything the command needs beyond the adapter itself. */
export interface CommandCodeCommandDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for getUsage / listModels). */
  adapter: CommandCodeAdapter<C>
  /**
   * Multi-account report source (wired by the plugin entry). Absent in
   * programmatic setups, the command falls back to a single
   * `adapter.getUsage()` report.
   */
  reports?: () => Promise<CommandCodeAccountsReport>
  /**
   * Resolve the active locale for one command run. The plugin entry wires
   * this from `Config.lang` and the shell's `LC_ALL`/`LANG`. Absent in
   * programmatic setups (notably the existing test), the command renders
   * with the default locale (`'zh'`) — historically the only language the
   * command ever shipped in.
   */
  getLocale?: () => LocaleId
}

// ---------------------------------------------------------------------------
// Number / time formatting (locale-independent; the locale only changes
// the surrounding labels)
// ---------------------------------------------------------------------------

/** Format a dollar amount. */
function money(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Format a dollar amount compactly (2 decimals). */
function moneyShort(value: number): string {
  return `$${value.toFixed(2)}`
}

/** Format a large token count compactly (1.9M style). */
function tokensCompact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

/** Format a millis timestamp as a local date; `n/a` when unset. */
function resetLabel(ms: number): string {
  if (ms <= 0) return 'n/a'
  return new Date(ms).toLocaleString()
}

/**
 * A 10-cell horizontal bar: `██████████` for 100%, `███░░░░░░░` for ~33%.
 * Handles caps of 0 (no limit) and out-of-range values.
 */
function bar(used: number, cap: number): string {
  if (cap <= 0) return '—'
  const ratio = Math.max(0, Math.min(1, used / cap))
  const filled = Math.round(ratio * 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/** Render one account's rotation mark / cooldown as a short badge. */
function markLabel(entry: CommandCodeAccountUsage, locale: LocaleId): string {
  if (entry.mark === 'invalid-credential') return commandCopy(locale, 'invalidCredentialBadge')
  if (entry.cooldownUntil > 0) {
    return commandCopy(locale, 'cooldownBadge').replace('{when}', resetLabel(entry.cooldownUntil))
  }
  if (entry.mark === 'rate-limit') return commandCopy(locale, 'rateLimitBadge')
  return ''
}

/** Render the usage report as a structured, aligned, bar-chart text view. */
function renderReport(report: CommandCodeUsageReport, locale: LocaleId, title?: string): string {
  const lines: string[] = []
  const account = report.account ? ` (${report.account.userName || report.account.name})` : ''

  lines.push(
    title ?? commandCopy(locale, 'title').replace('{account}', account),
    '',
  )

  // A total failure names its cause up front; the per-endpoint failure list
  // at the bottom would bury it.
  if (report.blocked === 'invalid-key') {
    lines.push(commandCopy(locale, 'blockedInvalidKey'), '')
  } else if (report.blocked === 'service-unavailable') {
    lines.push(commandCopy(locale, 'blockedServiceUnavailable'), '')
  } else if (report.blocked === 'network') {
    lines.push(commandCopy(locale, 'blockedNetwork'), '')
  }

  if (report.plan && report.plan.name !== '') {
    const p = report.plan
    const status = p.status !== '' && p.status !== 'active' ? ` (${p.status})` : ''
    const period = p.currentPeriodEnd > 0
      ? commandCopy(locale, 'planPeriodSuffix').replace('{date}', new Date(p.currentPeriodEnd).toLocaleDateString())
      : ''
    lines.push(commandCopy(locale, 'planLine')
      .replace('{name}', p.name)
      .replace('{status}', status)
      .replace('{period}', period), '')
  }

  if (report.usage) {
    const u = report.usage
    lines.push(
      commandCopy(locale, 'usageHeader'),
      commandCopy(locale, 'requestsLine')
        .replace('{n}', String(u.completedCount))
        .replace('{f}', String(u.failedCount))
        .replace('{r}', String(u.successRate)),
      commandCopy(locale, 'costLine')
        .replace('{money}', money(u.totalCost))
        .replace('{credits}', moneyShort(u.totalCredits)),
      commandCopy(locale, 'tokensLine')
        .replace('{in}', tokensCompact(u.totalTokensIn))
        .replace('{out}', tokensCompact(u.totalTokensOut)),
      '',
    )
  }

  if (report.credits) {
    const c = report.credits
    const monthlyPct = c.monthlyCredits > 0
      ? `${((c.monthlyCredits / (c.monthlyCredits + c.purchasedCredits)) * 100).toFixed(0)}%`
      : '—'
    lines.push(
      commandCopy(locale, 'creditsHeader'),
      commandCopy(locale, 'monthlyLine')
        .replace('{monthly}', moneyShort(c.monthlyCredits))
        .replace('{purchased}', moneyShort(c.purchasedCredits))
        .replace('{free}', moneyShort(c.freeCredits)),
      commandCopy(locale, 'barLine')
        .replace('{bar}', bar(c.monthlyCredits, c.monthlyCredits + c.purchasedCredits))
        .replace('{pct}', monthlyPct),
      '',
      commandCopy(locale, 'windowsHeader'),
      commandCopy(locale, 'fiveHourLine')
        .replace('{used}', moneyShort(c.fiveHour.used))
        .replace('{cap}', moneyShort(c.fiveHour.cap))
        .replace('{warn}', c.fiveHour.exceeded ? commandCopy(locale, 'exceededWarning') : ''),
      commandCopy(locale, 'windowBarLine')
        .replace('{bar}', bar(c.fiveHour.used, c.fiveHour.cap))
        .replace('{when}', resetLabel(c.fiveHour.resetAt)),
      commandCopy(locale, 'weeklyLine')
        .replace('{used}', moneyShort(c.weekly.used))
        .replace('{cap}', moneyShort(c.weekly.cap))
        .replace('{warn}', c.weekly.exceeded ? commandCopy(locale, 'exceededWarning') : ''),
      commandCopy(locale, 'windowBarLine')
        .replace('{bar}', bar(c.weekly.used, c.weekly.cap))
        .replace('{when}', resetLabel(c.weekly.resetAt)),
      '',
    )
  }

  if (report.failures.length > 0) {
    lines.push(commandCopy(locale, 'partialFailures').replace('{list}', report.failures.join('; ')), '')
  }
  if (!report.account && !report.usage && !report.credits) {
    lines.push(commandCopy(locale, 'noData'), '')
  }

  return lines.join('\n').trimEnd()
}

/** The one registered `/commandcode` command. */
export function commandDefinition<C extends CommandCodeConnectionOptions>(
  deps: CommandCodeCommandDeps<C>,
): CommandDefinition {
  const { adapter } = deps
  return {
    name: 'commandcode',
    description: 'Command Code account usage dashboard',
    input: { hint: '[status]' },
    handler: async () => {
      const locale: LocaleId = deps.getLocale?.() ?? 'zh'
      try {
        if (deps.reports !== undefined) {
          const { accounts } = await deps.reports()
          const sections = accounts.map((entry) => {
            const badges = `${entry.active ? commandCopy(locale, 'activeBadge') : ''}${markLabel(entry, locale)}`
            const title = commandCopy(locale, 'accountTitle')
              .replace('{label}', entry.label)
              .replace('{badges}', badges)
            if (!entry.configured) return `${title}\n\n${commandCopy(locale, 'unconfigured')}`
            return renderReport(entry.report, locale, title)
          })
          return { kind: 'success', text: sections.join(`\n\n${commandCopy(locale, 'accountSeparator')}\n\n`) }
        }
        const report = await adapter.getUsage()
        return { kind: 'success', text: renderReport(report, locale) }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'error',
          text: commandCopy(locale, 'errorText').replace('{message}', message),
        }
      }
    },
  }
}

/** Register the command on `ctx.commands` (called from the plugin entry). */
export function applyCommands<C extends CommandCodeConnectionOptions>(
  ctx: Context,
  deps: CommandCodeCommandDeps<C>,
): void {
  ctx.commands.register(commandDefinition(deps))
}
