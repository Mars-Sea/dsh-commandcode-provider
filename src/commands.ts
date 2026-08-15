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
 * @module dsh-commandcode-provider/commands
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import that loads the module augmentation (`ctx.commands`).
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { CommandCodeAdapter } from './adapter.ts'
import type { CommandCodeConnectionOptions, CommandCodeUsageReport } from './adapter.ts'

/** Everything the command needs beyond the adapter itself. */
export interface CommandCodeCommandDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for getUsage / listModels). */
  adapter: CommandCodeAdapter<C>
}

/** Format a dollar amount. */
function money(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Format a token count with thousands separators. */
function tokens(value: number): string {
  return value.toLocaleString('en-US')
}

/** Format a millis timestamp as a local date. */
function resetLabel(ms: number): string {
  if (ms <= 0) return 'n/a'
  return new Date(ms).toLocaleString()
}

/** Render the usage report as text. */
function renderReport(report: CommandCodeUsageReport): string {
  const lines: string[] = ['Command Code usage']
  if (report.account) {
    const a = report.account
    lines.push(`  account: ${a.name}${a.userName ? ` (@${a.userName})` : ''}`)
  }
  if (report.usage) {
    const u = report.usage
    lines.push(
      `  requests: ${u.completedCount} completed / ${u.failedCount} failed (${u.successRate}% success)`,
      `  cost: ${money(u.totalCost)} (${money(u.totalCredits)} credits, ${u.periodBasis})`,
      `  tokens: ${tokens(u.totalTokensIn)} in / ${tokens(u.totalTokensOut)} out`,
    )
  }
  if (report.credits) {
    const c = report.credits
    lines.push(
      `  credits: ${money(c.monthlyCredits)} monthly / ${money(c.purchasedCredits)} purchased / ${money(c.freeCredits)} free`,
      `  5h window: ${money(c.fiveHour.used)} / ${money(c.fiveHour.cap)}${c.fiveHour.exceeded ? ' (exceeded!)' : ''} — resets ${resetLabel(c.fiveHour.resetAt)}`,
      `  weekly: ${money(c.weekly.used)} / ${money(c.weekly.cap)}${c.weekly.exceeded ? ' (exceeded!)' : ''} — resets ${resetLabel(c.weekly.resetAt)}`,
    )
  }
  if (report.failures.length > 0) {
    lines.push('', `  (some endpoints failed: ${report.failures.join('; ')})`)
  }
  if (!report.account && !report.usage && !report.credits) {
    lines.push('  (no data — check your API key)')
  }
  return lines.join('\n')
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
      try {
        const report = await adapter.getUsage()
        return { kind: 'success', text: renderReport(report) }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'error',
          text: `Could not fetch Command Code usage: ${message}`,
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
