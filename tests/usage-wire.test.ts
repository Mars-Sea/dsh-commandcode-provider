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
  const parsed = usageReportSchema.parse(makeReport())
  assert.deepEqual(parsed, makeReport())
})

test('schema accepts a minimal report (failures only)', () => {
  const parsed = usageReportSchema.parse({ failures: ['/alpha/whoami: HTTP 500'] })
  assert.deepEqual(parsed, { failures: ['/alpha/whoami: HTTP 500'] })
})

test('schema accepts a report with only some sections', () => {
  const report = makeReport()
  const partial = { account: report.account, failures: [] }
  assert.deepEqual(usageReportSchema.parse(partial), partial)
})

test('schema rejects non-object and array roots', () => {
  assert.throws(() => usageReportSchema.parse(null), /invalid report/)
  assert.throws(() => usageReportSchema.parse('report'), /invalid report/)
  assert.throws(() => usageReportSchema.parse([{ failures: [] }]), /invalid report/)
})

test('schema rejects a missing or malformed failures array', () => {
  assert.throws(() => usageReportSchema.parse({}), /failures/)
  assert.throws(() => usageReportSchema.parse({ failures: [500] }), /failures/)
})

test('schema rejects a section with a wrong-typed field', () => {
  const report = makeReport()
  const bad = { ...report, usage: { ...report.usage, totalCost: 'a lot' } }
  assert.throws(() => usageReportSchema.parse(bad), /usage\.totalCost/)
})

test('schema rejects a window limit with a non-boolean exceeded flag', () => {
  const report = makeReport()
  const bad = {
    ...report,
    credits: { ...report.credits, fiveHour: { ...report.credits!.fiveHour, exceeded: 'yes' } },
  }
  assert.throws(() => usageReportSchema.parse(bad), /fiveHour\.exceeded/)
})

test('schema rejects non-finite numbers', () => {
  const report = makeReport()
  const bad = { ...report, usage: { ...report.usage, totalTokensIn: Number.NaN } }
  assert.throws(() => usageReportSchema.parse(bad), /usage\.totalTokensIn/)
})

test('schema accepts a plan with a null monthlyCredits (unknown plan)', () => {
  const report = makeReport()
  const withUnknownPlan = {
    ...report,
    plan: {
      planId: 'individual-enterprise',
      name: 'individual-enterprise',
      status: 'trialing',
      monthlyCredits: null,
      currentPeriodEnd: 0,
    },
  }
  assert.deepEqual(usageReportSchema.parse(withUnknownPlan), withUnknownPlan)
})

test('schema rejects a plan with a wrong-typed monthlyCredits', () => {
  const report = makeReport()
  const bad = { ...report, plan: { ...report.plan, monthlyCredits: 'unlimited' } }
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
  assert.equal(USAGE_HOST_CONTRIBUTION.invocations[0], USAGE_REPORT_DESCRIPTOR)
  assert.equal(USAGE_REMOTE_CONTRIBUTION.descriptors[0], USAGE_REPORT_DESCRIPTOR)
  assert.equal(USAGE_HOST_CONTRIBUTION.package, USAGE_REMOTE_CONTRIBUTION.package)
})
