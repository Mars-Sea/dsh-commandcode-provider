/**
 * Wire-contract tests for the `commandcode/report` Remote (node:test).
 *
 * The descriptor is shared verbatim by the Host registration and the Client
 * mount, and the hand-rolled strict schema is the only boundary validation
 * either side performs — these tests pin both.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  USAGE_HOST_CONTRIBUTION,
  USAGE_REMOTE_CONTRIBUTION,
  USAGE_REPORT_DESCRIPTOR,
  USAGE_REPORT_ENDPOINT,
  usageReportSchema,
} from '../src/usage-wire.ts'
import type { CommandCodeUsageReport } from '../src/adapter.ts'
import type { CommandCodeAccountUsage, CommandCodeAccountsReport } from '../src/usage-wire.ts'

/** Wrap one report in the multi-account wire shape. */
function wrap(...accounts: CommandCodeAccountUsage[]): CommandCodeAccountsReport {
  return { accounts }
}

/** One valid account entry around a report. */
function makeAccount(report: CommandCodeUsageReport, over: Partial<CommandCodeAccountUsage> = {}): CommandCodeAccountUsage {
  return {
    id: 'default',
    label: 'Default',
    configured: true,
    active: true,
    mark: '',
    cooldownUntil: 0,
    report,
    ...over,
  }
}

/** A fully populated, valid report. */
function makeReport(): CommandCodeUsageReport {
  return {
    account: { id: 'u1', name: 'Mars', userName: 'mars-sea' },
    usage: {
      totalCount: 42,
      totalCost: 1.2345,
      successRate: 97.6,
      completedCount: 41,
      failedCount: 1,
      totalTokensIn: 1_900_000,
      totalTokensOut: 120_000,
      totalCredits: 1.2,
      periodBasis: 'billing-period',
    },
    credits: {
      monthlyCredits: 50,
      purchasedCredits: 10,
      freeCredits: 2,
      fiveHour: { used: 1.5, cap: 5, exceeded: false, resetAt: 1_800_000_000_000 },
      weekly: { used: 12, cap: 100, exceeded: true, resetAt: 1_800_100_000_000 },
    },
    plan: {
      planId: 'individual-pro',
      name: 'Pro',
      status: 'active',
      monthlyCredits: 30,
      currentPeriodEnd: 1_800_200_000_000,
    },
    failures: [],
  }
}

test('schema accepts a fully populated report', () => {
  const value = wrap(makeAccount(makeReport()))
  const parsed = usageReportSchema.parse(value)
  assert.deepEqual(parsed, value)
})

test('schema accepts multiple accounts with distinct rotation state', () => {
  const value = wrap(
    makeAccount(makeReport()),
    makeAccount({ failures: [] }, {
      id: 'account-2',
      label: 'Go #2',
      active: false,
      mark: 'rate-limit',
      cooldownUntil: 1_800_050_000_000,
    }),
  )
  assert.deepEqual(usageReportSchema.parse(value), value)
})

test('schema accepts a minimal report (failures only)', () => {
  const value = wrap(makeAccount({ failures: ['/alpha/whoami: HTTP 500'] }))
  assert.deepEqual(usageReportSchema.parse(value), value)
})

test('schema accepts and preserves a blocked classification', () => {
  const value = wrap(makeAccount({ failures: ['/alpha/whoami: HTTP 401'], blocked: 'invalid-key' }))
  assert.deepEqual(usageReportSchema.parse(value), value)
  assert.equal(usageReportSchema.parse(value).accounts[0]?.report.blocked, 'invalid-key')
})

test('schema rejects an unknown blocked reason', () => {
  const value = wrap(makeAccount({ failures: ['x'], blocked: 'quantum' as never }))
  assert.throws(() => usageReportSchema.parse(value), /invalid blocked/)
})

test('schema accepts an empty accounts array', () => {
  assert.deepEqual(usageReportSchema.parse({ accounts: [] }), { accounts: [] })
})

test('schema rejects a missing or malformed accounts array', () => {
  assert.throws(() => usageReportSchema.parse({}), /accounts/)
  assert.throws(() => usageReportSchema.parse({ accounts: 'two' }), /accounts/)
})

test('schema rejects an account entry with a wrong-typed field', () => {
  const bad = wrap({ ...makeAccount({ failures: [] }), active: 'yes' })
  assert.throws(() => usageReportSchema.parse(bad), /account\.active/)
  const badCooldown = wrap({ ...makeAccount({ failures: [] }), cooldownUntil: Number.NaN })
  assert.throws(() => usageReportSchema.parse(badCooldown), /account\.cooldownUntil/)
})

test('schema rejects non-object and array roots', () => {
  assert.throws(() => usageReportSchema.parse(null), /invalid result/)
  assert.throws(() => usageReportSchema.parse('report'), /invalid result/)
  assert.throws(() => usageReportSchema.parse([{ accounts: [] }]), /invalid result/)
})

test('schema rejects a missing or malformed failures array', () => {
  assert.throws(() => usageReportSchema.parse(wrap({ ...makeAccount({ failures: [] }), report: {} })), /failures/)
  const bad = wrap(makeAccount({ failures: [500] as unknown as string[] }))
  assert.throws(() => usageReportSchema.parse(bad), /failures/)
})

test('schema rejects a section with a wrong-typed field', () => {
  const report = makeReport()
  const bad = wrap(makeAccount({ ...report, usage: { ...report.usage, totalCost: 'a lot' as unknown as number } }))
  assert.throws(() => usageReportSchema.parse(bad), /usage\.totalCost/)
})

test('schema rejects a window limit with a non-boolean exceeded flag', () => {
  const report = makeReport()
  const bad = wrap(makeAccount({
    ...report,
    credits: { ...report.credits!, fiveHour: { ...report.credits!.fiveHour, exceeded: 'yes' as unknown as boolean } },
  }))
  assert.throws(() => usageReportSchema.parse(bad), /fiveHour\.exceeded/)
})

test('schema rejects non-finite numbers', () => {
  const report = makeReport()
  const bad = wrap(makeAccount({ ...report, usage: { ...report.usage!, totalTokensIn: Number.NaN } }))
  assert.throws(() => usageReportSchema.parse(bad), /usage\.totalTokensIn/)
})

test('schema accepts a plan with a null monthlyCredits (unknown plan)', () => {
  const report = makeReport()
  const withUnknownPlan = wrap(makeAccount({
    ...report,
    plan: {
      planId: 'individual-enterprise',
      name: 'individual-enterprise',
      status: 'trialing',
      monthlyCredits: null,
      currentPeriodEnd: 0,
    },
  }))
  assert.deepEqual(usageReportSchema.parse(withUnknownPlan), withUnknownPlan)
})

test('schema rejects a plan with a wrong-typed monthlyCredits', () => {
  const report = makeReport()
  const bad = wrap(makeAccount({ ...report, plan: { ...report.plan!, monthlyCredits: 'unlimited' as unknown as null } }))
  assert.throws(() => usageReportSchema.parse(bad), /plan\.monthlyCredits/)
})

test('the shared descriptor targets the commandcodeUsage service endpoint', () => {
  assert.equal(USAGE_REPORT_DESCRIPTOR.id, `@mars-sea/dsh-commandcode-provider#${USAGE_REPORT_ENDPOINT}`)
  assert.equal(USAGE_REPORT_DESCRIPTOR.service, 'commandcodeUsage')
  assert.equal(USAGE_REPORT_DESCRIPTOR.namespace, 'commandcode')
  assert.equal(USAGE_REPORT_DESCRIPTOR.method, 'report')
  assert.deepEqual(USAGE_REPORT_DESCRIPTOR.invocation, { kind: 'direct' })
  assert.deepEqual(USAGE_REPORT_DESCRIPTOR.parameters, [])
  assert.equal(USAGE_REPORT_DESCRIPTOR.result.mode, 'strict')
})

test('host and client contributions carry the same descriptor object', () => {
  assert.equal(USAGE_HOST_CONTRIBUTION.face, 'host')
  assert.deepEqual(USAGE_HOST_CONTRIBUTION.model, { services: [], events: [], objects: [] })
  assert.equal(USAGE_HOST_CONTRIBUTION.invocations[0], USAGE_REPORT_DESCRIPTOR)
  assert.equal(USAGE_REMOTE_CONTRIBUTION.descriptors[0], USAGE_REPORT_DESCRIPTOR)
  assert.equal(USAGE_HOST_CONTRIBUTION.package, USAGE_REMOTE_CONTRIBUTION.package)
})

// ---------------------------------------------------------------------------
// Model-catalog Remote (`commandcode/models`)
// ---------------------------------------------------------------------------

import { MODELS_DESCRIPTOR, MODELS_ENDPOINT, modelsSchema } from '../src/usage-wire.ts'

test('models schema accepts a catalog of models', () => {
  const parsed = modelsSchema.parse({ models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] })
  assert.deepEqual(parsed, { models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] })
})

test('models schema accepts an empty catalog', () => {
  assert.deepEqual(modelsSchema.parse({ models: [] }), { models: [] })
})

test('models schema rejects a malformed catalog', () => {
  assert.throws(() => modelsSchema.parse({}), /models/)
  assert.throws(() => modelsSchema.parse({ models: 'two' }), /models/)
  assert.throws(() => modelsSchema.parse({ models: [{ id: 42, name: 'x' }] }), /model\.id/)
})

test('models descriptor targets the commandcodeUsage service and models method', () => {
  assert.equal(MODELS_DESCRIPTOR.id, `@mars-sea/dsh-commandcode-provider#${MODELS_ENDPOINT}`)
  assert.equal(MODELS_DESCRIPTOR.service, 'commandcodeUsage')
  assert.equal(MODELS_DESCRIPTOR.namespace, 'commandcode')
  assert.equal(MODELS_DESCRIPTOR.method, 'models')
})
