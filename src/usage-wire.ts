/**
 * Wire contract for the Command Code account-usage Remote
 * (`commandcode/report`).
 *
 * The settings page renders the same account/usage/credit facts the
 * `/commandcode` command prints, but the browser never holds the API key —
 * the report must be produced Host-side and cross the Connection RPC carrier.
 * The harness exposes plugin-defined Host methods through the Typert Gateway:
 * the Host half registers a strict invocation descriptor against a Cordis
 * service (`src/usage-remote.ts`), and the browser half mounts the matching
 * Remote contribution on `ctx.remote` (`src/client/index.ts`).
 *
 * This module is the single source both halves share: the result validator
 * (a hand-rolled {@link TypertSchema}, so neither half needs a schema library)
 * and the exact descriptor object, so the endpoint can never drift apart.
 * It is deliberately dependency-free — the client bundle inlines it, and only
 * `import type` edges leave it (erased at build).
 *
 * @module dsh-commandcode-provider/usage-wire
 */

import type { CommandCodeUsageReport } from './adapter.ts'
import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** The npm package identity both contribution registrations claim. */
export const USAGE_REMOTE_PACKAGE = '@mars-sea/dsh-commandcode-provider'

/** Canonical `<namespace>/<method>` endpoint of the usage report Remote. */
export const USAGE_REPORT_ENDPOINT = 'commandcode/report'

/** Reject one boundary value with a field-naming error. */
function reject(field: string): never {
  throw new TypeError(`commandcode/report result: invalid ${field}`)
}

/** Read one required finite number field (`field` is the dotted error label). */
function numberField(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) reject(field)
  return value
}

/** Read one required string field (`field` is the dotted error label). */
function stringField(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key]
  if (typeof value !== 'string') reject(field)
  return value
}

/** Read one required boolean field (`field` is the dotted error label). */
function booleanField(source: Record<string, unknown>, key: string, field: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') reject(field)
  return value
}

/** Narrow an unknown value to a plain record, or reject. */
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject(field)
  return value as Record<string, unknown>
}

/** Validate one window-limit block (`fiveHour` / `weekly`). */
function windowLimit(value: unknown, field: string): { used: number; cap: number; exceeded: boolean; resetAt: number } {
  const source = record(value, field)
  return {
    used: numberField(source, 'used', `${field}.used`),
    cap: numberField(source, 'cap', `${field}.cap`),
    exceeded: booleanField(source, 'exceeded', `${field}.exceeded`),
    resetAt: numberField(source, 'resetAt', `${field}.resetAt`),
  }
}

/**
 * Parse one untrusted boundary value into a {@link CommandCodeUsageReport}.
 * Optional sections stay optional; every present field is shape-checked so a
 * malformed frame fails the boundary instead of rendering garbage.
 */
function parseUsageReport(value: unknown): CommandCodeUsageReport {
  const source = record(value, 'report')
  const failures = source.failures
  if (!Array.isArray(failures) || failures.some((entry) => typeof entry !== 'string')) reject('failures')
  const report: CommandCodeUsageReport = { failures: failures as string[] }

  if (source.account !== undefined) {
    const account = record(source.account, 'account')
    report.account = {
      id: stringField(account, 'id', 'account.id'),
      name: stringField(account, 'name', 'account.name'),
      userName: stringField(account, 'userName', 'account.userName'),
    }
  }

  if (source.usage !== undefined) {
    const usage = record(source.usage, 'usage')
    report.usage = {
      totalCount: numberField(usage, 'totalCount', 'usage.totalCount'),
      totalCost: numberField(usage, 'totalCost', 'usage.totalCost'),
      successRate: numberField(usage, 'successRate', 'usage.successRate'),
      completedCount: numberField(usage, 'completedCount', 'usage.completedCount'),
      failedCount: numberField(usage, 'failedCount', 'usage.failedCount'),
      totalTokensIn: numberField(usage, 'totalTokensIn', 'usage.totalTokensIn'),
      totalTokensOut: numberField(usage, 'totalTokensOut', 'usage.totalTokensOut'),
      totalCredits: numberField(usage, 'totalCredits', 'usage.totalCredits'),
      periodBasis: stringField(usage, 'periodBasis', 'usage.periodBasis'),
    }
  }

  if (source.credits !== undefined) {
    const credits = record(source.credits, 'credits')
    report.credits = {
      monthlyCredits: numberField(credits, 'monthlyCredits', 'credits.monthlyCredits'),
      purchasedCredits: numberField(credits, 'purchasedCredits', 'credits.purchasedCredits'),
      freeCredits: numberField(credits, 'freeCredits', 'credits.freeCredits'),
      fiveHour: windowLimit(credits.fiveHour, 'credits.fiveHour'),
      weekly: windowLimit(credits.weekly, 'credits.weekly'),
    }
  }

  if (source.plan !== undefined) {
    const plan = record(source.plan, 'plan')
    const monthly = plan.monthlyCredits
    if (monthly !== null && (typeof monthly !== 'number' || !Number.isFinite(monthly))) reject('plan.monthlyCredits')
    report.plan = {
      planId: stringField(plan, 'planId', 'plan.planId'),
      name: stringField(plan, 'name', 'plan.name'),
      status: stringField(plan, 'status', 'plan.status'),
      monthlyCredits: monthly as number | null,
      currentPeriodEnd: numberField(plan, 'currentPeriodEnd', 'plan.currentPeriodEnd'),
    }
  }

  return report
}

/**
 * The strict result codec both halves attach to the descriptor. Hand-rolled:
 * the client bundle may not require a schema library, and `TypertSchema` is
 * deliberately minimal so one `parse` function satisfies it.
 */
export const usageReportSchema: TypertSchema<CommandCodeUsageReport> = {
  parse: parseUsageReport,
}

/**
 * The one invocation descriptor, shared verbatim by the Host registration and
 * the Client mount. `service` names the Cordis key the Gateway resolves the
 * receiver from; `namespace`/`method` name the wire endpoint.
 */
export const USAGE_REPORT_DESCRIPTOR: InvocationDescriptor = {
  id: `${USAGE_REMOTE_PACKAGE}#${USAGE_REPORT_ENDPOINT}`,
  service: 'commandcodeUsage',
  namespace: 'commandcode',
  method: 'report',
  invocation: { kind: 'direct' },
  parameters: [],
  result: {
    mode: 'strict',
    typeSymbol: `${USAGE_REMOTE_PACKAGE}#CommandCodeUsageReport`,
    schema: usageReportSchema,
  },
}

/** The Host-face contribution registered on `ctx.typert`. */
export const USAGE_HOST_CONTRIBUTION = {
  package: USAGE_REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: [USAGE_REPORT_DESCRIPTOR],
}

/** The Client-face contribution mounted on `ctx.remote`. */
export const USAGE_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: USAGE_REMOTE_PACKAGE,
  descriptors: [USAGE_REPORT_DESCRIPTOR],
}
