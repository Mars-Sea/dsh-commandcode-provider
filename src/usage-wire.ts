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
 * `import type` edges leave it (erased at build). The boundary-validator
 * helpers and the descriptor boilerplate live in `./wire-shared.ts`, shared
 * with the login wire contract.
 *
 * @module dsh-commandcode-provider/usage-wire
 */

import type { CommandCodeUsageReport, UsageBlockReason } from './adapter.ts'

export type { CommandCodeUsageReport, UsageBlockReason }
import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import {
  makeBoundaryValidator,
  makeRemoteDescriptor,
  REMOTE_PACKAGE,
} from './wire-shared.ts'

/** One account's usage entry in the multi-account report. */
export interface CommandCodeAccountUsage {
  /** Stable slot id (`default`, `account-2`, …). */
  id: string
  /** Display label (user-provided or generated). */
  label: string
  /** Whether an API key resolved for this account. */
  configured: boolean
  /** Whether this account currently serves requests (first usable slot). */
  active: boolean
  /** Rotation mark: `''` (usable), `'rate-limit'`, or `'invalid-credential'`. */
  mark: string
  /** Known cooldown end in millis; 0 when unknown or not cooling down. */
  cooldownUntil: number
  /** The per-account report; `failures`-only when the fetch itself failed. */
  report: CommandCodeUsageReport
}

/** The settings page's account card data: one entry per configured account. */
export interface CommandCodeAccountsReport {
  accounts: CommandCodeAccountUsage[]
}

/** The npm package identity both contribution registrations claim. */
export const USAGE_REMOTE_PACKAGE = REMOTE_PACKAGE

/** Canonical `<namespace>/<method>` endpoint of the usage report Remote. */
export const USAGE_REPORT_ENDPOINT = 'commandcode/report'

/**
 * The shared read/validate helpers, prefixed with the report endpoint so
 * rejection messages name the offending boundary (the catalog endpoint below
 * shares this prefix, matching the historical behavior).
 */
const { reject, record, stringField, numberField, booleanField } =
  makeBoundaryValidator('commandcode/report result:')

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

  if (source.blocked !== undefined) {
    const blocked = source.blocked
    // Positive check: TS's never-return control-flow analysis only recognizes
    // function declarations, not the factory's destructured-arrow `reject`, so
    // narrow `blocked` in the positive branch instead.
    if (blocked === 'invalid-key' || blocked === 'service-unavailable' || blocked === 'network') {
      report.blocked = blocked
    } else {
      reject('blocked')
    }
  }

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

/** Parse one untrusted boundary value into a {@link CommandCodeAccountUsage}. */
function parseAccountUsage(value: unknown): CommandCodeAccountUsage {
  const source = record(value, 'account')
  return {
    id: stringField(source, 'id', 'account.id'),
    label: stringField(source, 'label', 'account.label'),
    configured: booleanField(source, 'configured', 'account.configured'),
    active: booleanField(source, 'active', 'account.active'),
    mark: stringField(source, 'mark', 'account.mark'),
    cooldownUntil: numberField(source, 'cooldownUntil', 'account.cooldownUntil'),
    report: parseUsageReport(source.report),
  }
}

/** Parse the wire result into a {@link CommandCodeAccountsReport}. */
function parseAccountsReport(value: unknown): CommandCodeAccountsReport {
  const source = record(value, 'result')
  const accounts = source.accounts
  if (Array.isArray(accounts)) {
    return { accounts: accounts.map(parseAccountUsage) }
  }
  return reject('accounts')
}

/**
 * The strict result codec both halves attach to the descriptor. Hand-rolled:
 * the client bundle may not require a schema library, and `TypertSchema` is
 * deliberately minimal so one `parse` function satisfies it.
 */
export const usageReportSchema: TypertSchema<CommandCodeAccountsReport> = {
  parse: parseAccountsReport,
}

/**
 * The one invocation descriptor, shared verbatim by the Host registration and
 * the Client mount. `service` names the Cordis key the Gateway resolves the
 * receiver from; `namespace`/`method` name the wire endpoint.
 */
export const USAGE_REPORT_DESCRIPTOR: InvocationDescriptor =
  makeRemoteDescriptor<CommandCodeAccountsReport>(
    USAGE_REPORT_ENDPOINT,
    'report',
    `${USAGE_REMOTE_PACKAGE}#CommandCodeAccountsReport`,
    usageReportSchema,
  )

/** The Host-face contribution registered on `ctx.typert`. */
export const USAGE_HOST_CONTRIBUTION = {
  package: USAGE_REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  // 0.1.2's Typert registry requires every Host contribution to carry its
  // reflection model. This hand-written Remote deliberately has no generated
  // reflection exports, so use the official empty-model form rather than a
  // cast that leaves registry inspection with `model: undefined`.
  model: { services: [], events: [], objects: [] },
  invocations: [USAGE_REPORT_DESCRIPTOR],
}

/** The Client-face contribution mounted on `ctx.remote`. */
export const USAGE_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: USAGE_REMOTE_PACKAGE,
  descriptors: [USAGE_REPORT_DESCRIPTOR],
}

// ---------------------------------------------------------------------------
// Model catalog Remote (`commandcode/models`)
// ---------------------------------------------------------------------------

/** One catalog entry the settings page's routing-rule editor offers. */
export interface CommandCodeCatalogModel {
  /** Catalog model id (e.g. `deepseek/deepseek-v4-pro`). */
  id: string
  /** Display name from the catalog. */
  name: string
}

/** The model-catalog Remote result: the full catalog, sorted for picking. */
export interface CommandCodeCatalog {
  models: CommandCodeCatalogModel[]
}

/** Canonical `<namespace>/<method>` endpoint of the model-catalog Remote. */
export const MODELS_ENDPOINT = 'commandcode/models'

/** Parse one untrusted boundary value into a {@link CommandCodeCatalogModel}. */
function parseCatalogModel(value: unknown): CommandCodeCatalogModel {
  const source = record(value, 'model')
  return {
    id: stringField(source, 'id', 'model.id'),
    name: stringField(source, 'name', 'model.name'),
  }
}

/** Parse the wire result into a {@link CommandCodeCatalog}. */
function parseCatalog(value: unknown): CommandCodeCatalog {
  const source = record(value, 'result')
  const models = source.models
  if (Array.isArray(models)) {
    return { models: models.map(parseCatalogModel) }
  }
  return reject('models')
}

/** The strict result codec for the model-catalog Remote. */
export const modelsSchema: TypertSchema<CommandCodeCatalog> = {
  parse: parseCatalog,
}

/**
 * The model-catalog invocation descriptor, sharing the same `commandcodeUsage`
 * service and `commandcode` namespace as the usage report.
 */
export const MODELS_DESCRIPTOR: InvocationDescriptor =
  makeRemoteDescriptor<CommandCodeCatalog>(
    MODELS_ENDPOINT,
    'models',
    `${USAGE_REMOTE_PACKAGE}#CommandCodeCatalog`,
    modelsSchema,
  )

/** The Client-face contribution for the model-catalog endpoint. */
export const MODELS_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: USAGE_REMOTE_PACKAGE,
  descriptors: [MODELS_DESCRIPTOR],
}