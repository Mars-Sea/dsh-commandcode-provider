/**
 * Wire contract for the Command Code account-usage Remote
 * (`commandcode/report`).
 *
 * The settings page's account card renders per-account usage and credit
 * facts, but the browser never holds the API key — the report must be
 * produced Host-side and cross the Connection RPC carrier.
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
 * The shared read/validate helpers for the usage report endpoint, prefixed
 * so rejection messages name the offending boundary.
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

/** One catalog entry the settings page's model editors offer. */
export interface CommandCodeCatalogModel {
  /** Catalog model id (e.g. `deepseek/deepseek-v4-pro`). */
  id: string
  /** Display name from the catalog. */
  name: string
  /**
   * Minimum plan-tier key for this model (a `KNOWN_PLANS` value: `go`,
   * `goat`, `pro`, `provider`, `max`), or undefined for models outside the
   * snapshot. The settings page groups the model-editor dropdowns under
   * tier headings from this — the browser cannot import the Host's
   * capability snapshot, so the Host stamps it per entry.
   */
  tier?: string
}

/** The model-catalog Remote result: the full catalog, sorted for picking. */
export interface CommandCodeCatalog {
  models: CommandCodeCatalogModel[]
}

/** Canonical `<namespace>/<method>` endpoint of the model-catalog Remote. */
export const MODELS_ENDPOINT = 'commandcode/models'

/**
 * The shared read/validate helpers for the model-catalog endpoint — a
 * separate instance so catalog boundary errors name `commandcode/models`,
 * not the report endpoint.
 */
const {
  record: catalogRecord,
  stringField: catalogString,
} = makeBoundaryValidator('commandcode/models result:')

/** Parse one untrusted boundary value into a {@link CommandCodeCatalogModel}. */
function parseCatalogModel(value: unknown): CommandCodeCatalogModel {
  const source = catalogRecord(value, 'model')
  const model: CommandCodeCatalogModel = {
    id: catalogString(source, 'id', 'model.id'),
    name: catalogString(source, 'name', 'model.name'),
  }
  // Tier is optional on the wire (older Hosts predate it); a present
  // non-string is a contract violation, not a silent drop.
  if (source.tier !== undefined) {
    model.tier = catalogString(source, 'tier', 'model.tier')
  }
  return model
}

/** Parse the wire result into a {@link CommandCodeCatalog}. */
function parseCatalog(value: unknown): CommandCodeCatalog {
  const source = catalogRecord(value, 'result')
  const models = source.models
  if (Array.isArray(models)) {
    return { models: models.map(parseCatalogModel) }
  }
  throw new TypeError('commandcode/models result: invalid models')
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

// ---------------------------------------------------------------------------
// Model price table Remote (`commandcode/prices`)
// ---------------------------------------------------------------------------

/**
 * One model's per-token rates, in USD per 1,000,000 tokens — the unit the
 * official pricing page publishes in.
 */
export interface CommandCodeModelRates {
  /** Uncached (billed) input tokens. */
  inputCost: number
  /** Completion tokens. */
  outputCost: number
  /** Input tokens served from the provider's cache. */
  cacheReadCost: number
  /**
   * Input tokens written into the provider's cache. Present for a minority of
   * models — the page publishes no cache-write rate for the rest, whose
   * cache-write tokens are therefore UNPRICED. Do not substitute a multiple of
   * the input rate for a missing value.
   */
  cacheWriteCost?: number
}

/** One model's rates plus the peak-hour override for time-of-day models. */
export interface CommandCodeModelPrice extends CommandCodeModelRates {
  /**
   * Lookup key: the catalog model id when a catalog model maps to this row,
   * otherwise the pricing page's own slug. A session reports catalog ids, so
   * this is the primary key the browser looks up by.
   */
  id: string
  /** The pricing page's slug for this row — the secondary lookup key. */
  slug: string
  /**
   * Rates charged inside the peak windows. The row's own top-level rates are
   * the off-peak rates, so a row WITH this block is time-of-day priced and a
   * row without it is flat-priced.
   */
  peak?: CommandCodeModelRates
  /**
   * Whether the model costs nothing on every plan right now (a free deal or a
   * `:free` catalog variant). Served explicitly at zero rates so a surface can
   * say "free" rather than showing nothing.
   */
  free?: boolean
}

/** The price-table Remote result: every known model's rates. */
export interface CommandCodePriceTable {
  /**
   * Every priced model, keyed by {@link CommandCodeModelPrice.id} (catalog id
   * first, pricing slug as the fallback) and carrying its slug as a second
   * lookup key. A model absent from this list has no known price and must
   * render no cost at all rather than a guess.
   */
  models: CommandCodeModelPrice[]
  /**
   * Peak-pricing windows as `[startHour, endHour)` in UTC, end-exclusive,
   * applying Monday–Friday only. Shipped with the table so the browser prices
   * against the Host snapshot's schedule instead of restating it.
   */
  peakHours: Array<[number, number]>
}

/** Canonical `<namespace>/<method>` endpoint of the price-table Remote. */
export const PRICES_ENDPOINT = 'commandcode/prices'

/**
 * The shared read/validate helpers for the price-table endpoint — its own
 * instance so price boundary errors name `commandcode/prices`.
 */
const {
  reject: priceReject,
  record: priceRecord,
  stringField: priceString,
  numberField: priceNumber,
  booleanField: priceBoolean,
} = makeBoundaryValidator('commandcode/prices result:')

/** Parse one rate block (`rates`, or a model's `peak` override). */
function parseRates(source: Record<string, unknown>, field: string): CommandCodeModelRates {
  const rates: CommandCodeModelRates = {
    inputCost: priceNumber(source, 'inputCost', `${field}.inputCost`),
    outputCost: priceNumber(source, 'outputCost', `${field}.outputCost`),
    cacheReadCost: priceNumber(source, 'cacheReadCost', `${field}.cacheReadCost`),
  }
  // Optional on the wire: only a minority of models publish a cache-write
  // rate, and a present non-number is a contract violation rather than a
  // silent zero.
  if (source.cacheWriteCost !== undefined) {
    rates.cacheWriteCost = priceNumber(source, 'cacheWriteCost', `${field}.cacheWriteCost`)
  }
  return rates
}

/** Parse one untrusted boundary value into a {@link CommandCodeModelPrice}. */
function parseModelPrice(value: unknown): CommandCodeModelPrice {
  const source = priceRecord(value, 'model')
  const price: CommandCodeModelPrice = {
    id: priceString(source, 'id', 'model.id'),
    slug: priceString(source, 'slug', 'model.slug'),
    ...parseRates(source, 'model'),
  }
  if (source.peak !== undefined) price.peak = parseRates(priceRecord(source.peak, 'model.peak'), 'model.peak')
  if (source.free !== undefined) price.free = priceBoolean(source, 'free', 'model.free')
  return price
}

/** Parse the wire result into a {@link CommandCodePriceTable}. */
function parsePriceTable(value: unknown): CommandCodePriceTable {
  const source = priceRecord(value, 'result')
  const models = source.models
  if (!Array.isArray(models)) priceReject('models')
  const peakHours = source.peakHours
  if (!Array.isArray(peakHours)) priceReject('peakHours')
  return {
    models: (models as unknown[]).map(parseModelPrice),
    peakHours: (peakHours as unknown[]).map((window) => {
      if (!Array.isArray(window) || window.length !== 2) priceReject('peakHours[]')
      const [start, end] = window as [unknown, unknown]
      if (typeof start !== 'number' || typeof end !== 'number') priceReject('peakHours[]')
      return [start, end] as [number, number]
    }),
  }
}

/** The strict result codec for the price-table Remote. */
export const pricesSchema: TypertSchema<CommandCodePriceTable> = {
  parse: parsePriceTable,
}

/**
 * The price-table invocation descriptor, sharing the same `commandcodeUsage`
 * service and `commandcode` namespace as the report and catalog endpoints.
 */
export const PRICES_DESCRIPTOR: InvocationDescriptor =
  makeRemoteDescriptor<CommandCodePriceTable>(
    PRICES_ENDPOINT,
    'prices',
    `${USAGE_REMOTE_PACKAGE}#CommandCodePriceTable`,
    pricesSchema,
  )

/** The Client-face contribution for the price-table endpoint. */
export const PRICES_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: USAGE_REMOTE_PACKAGE,
  descriptors: [PRICES_DESCRIPTOR],
}