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
import type { CommandCodeAccountUsage, CommandCodeAccountsReport } from './usage-wire.ts'

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
}

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

/** Format a millis timestamp as a local date. */
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

/** Render one account's rotation mark / cooldown as a short badge. */
function markLabel(entry: CommandCodeAccountUsage): string {
  if (entry.mark === 'invalid-credential') return '  ⛔ 密钥无效'
  if (entry.cooldownUntil > 0) return `  ⏳ 限额冷却中，重置 ${resetLabel(entry.cooldownUntil)}`
  if (entry.mark === 'rate-limit') return '  ⏳ 已达限额（等待窗口探测）'
  return ''
}

/** Render the usage report as a structured, aligned, bar-chart text view. */
function renderReport(report: CommandCodeUsageReport, title?: string): string {
  const lines: string[] = []
  const account = report.account ? ` (${report.account.userName || report.account.name})` : ''

  lines.push(title ?? `📊 Command Code 用量${account}`, '')

  // A total failure names its cause up front; the per-endpoint failure list
  // at the bottom would bury it.
  if (report.blocked === 'invalid-key') {
    lines.push('⛔ API 密钥无效或已过期 — 服务端拒绝了全部请求（401），请检查该账户的密钥配置', '')
  } else if (report.blocked === 'service-unavailable') {
    lines.push('⚠️ Command Code 服务暂时不可用（5xx），稍后重试', '')
  } else if (report.blocked === 'network') {
    lines.push('⚠️ 无法连接 Command Code 服务 — 请检查网络或 API 地址', '')
  }

  if (report.plan && report.plan.name !== '') {
    const p = report.plan
    const status = p.status !== '' && p.status !== 'active' ? ` (${p.status})` : ''
    const period = p.currentPeriodEnd > 0 ? ` · 账期截止 ${new Date(p.currentPeriodEnd).toLocaleDateString()}` : ''
    lines.push(`  📦 套餐    ${p.name}${status}${period}`, '')
  }

  if (report.usage) {
    const u = report.usage
    lines.push(
      '── 请求 ──────────────────────────────',
      `  💬 请求    ${u.completedCount} 次 / 失败 ${u.failedCount}  成功率 ${u.successRate}%`,
      `  💰 花费    ${money(u.totalCost)}  (${moneyShort(u.totalCredits)} credits)`,
      `  🔤 Token   ${tokensCompact(u.totalTokensIn)} 入 / ${tokensCompact(u.totalTokensOut)} 出`,
      '',
    )
  }

  if (report.credits) {
    const c = report.credits
    const monthlyPct = c.monthlyCredits > 0
      ? `${((c.monthlyCredits / (c.monthlyCredits + c.purchasedCredits)) * 100).toFixed(0)}%`
      : '—'
    lines.push(
      '── 信用 ──────────────────────────────',
      `  💳 月额度  ${moneyShort(c.monthlyCredits)}   (已购 ${moneyShort(c.purchasedCredits)} / 赠送 ${moneyShort(c.freeCredits)})`,
      `     └ ${bar(c.monthlyCredits, c.monthlyCredits + c.purchasedCredits)}  ${monthlyPct}`,
      '',
      '── 窗口用量 ──────────────────────────',
      `  ⏱ 5 小时  ${moneyShort(c.fiveHour.used)} / ${moneyShort(c.fiveHour.cap)}${c.fiveHour.exceeded ? '  ⚠️ 超限!' : ''}`,
      `     └ ${bar(c.fiveHour.used, c.fiveHour.cap)}  重置 ${resetLabel(c.fiveHour.resetAt)}`,
      `  📅 每周    ${moneyShort(c.weekly.used)} / ${moneyShort(c.weekly.cap)}${c.weekly.exceeded ? '  ⚠️ 超限!' : ''}`,
      `     └ ${bar(c.weekly.used, c.weekly.cap)}  重置 ${resetLabel(c.weekly.resetAt)}`,
      '',
    )
  }

  if (report.failures.length > 0) {
    lines.push(`⚠️  部分端点失败: ${report.failures.join('; ')}`, '')
  }
  if (!report.account && !report.usage && !report.credits) {
    lines.push('(no data — check your API key)', '')
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
      try {
        if (deps.reports !== undefined) {
          const { accounts } = await deps.reports()
          const sections = accounts.map((entry) => {
            const badges = `${entry.active ? '  ✅ 当前使用' : ''}${markLabel(entry)}`
            const title = `📊 ${entry.label}${badges}`
            if (!entry.configured) return `${title}\n\n  (未配置 API 密钥)`
            return renderReport(entry.report, title)
          })
          return { kind: 'success', text: sections.join('\n\n────────────────────\n\n') }
        }
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
