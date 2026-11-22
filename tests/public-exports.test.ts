/**
 * The public export surface must never shrink (AGENTS.md: preserve the public
 * exports from `src/index.ts`; the PR rule is "只增不改").
 *
 * This exists because a refactor once dropped `CommandCodeSearchProviderDeps`
 * — a type-only re-export — and every other check stayed green: `tsc` does not
 * miss a name nobody imports, and `tests/package-exports.test.ts` only proves
 * entry-point FILES exist. A type-only export is invisible to a runtime import,
 * so the surface is read from the source text here.
 *
 * Adding exports is free. Removing or renaming one fails this test, which is
 * the point: downstream plugins may already import it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Every name `src/index.ts` exported at the commit this work branched from.
 *
 * Regenerate deliberately (never to silence this test): diff the current list
 * against the published `lib/index.d.ts` of the last release and explain any
 * removal in the PR.
 */
const BASELINE: readonly string[] = [
  'ACTIVE_ACCOUNT_AUTO', 'ApiKeyValidation', 'BILLING_ACCESS_TTL_MS',
  'COMMANDCODE_SEARCH_PROVIDER_ID', 'COMMAND_CODE_CLI_VERSION', 'CommandCodeAccountConfig',
  'CommandCodeAccountPool', 'CommandCodeAccountSlot', 'CommandCodeAccountState',
  'CommandCodeAccountUsage', 'CommandCodeAccountsReport', 'CommandCodeAdapter',
  'CommandCodeAdapterDeps', 'CommandCodeBillingAccess', 'CommandCodeCommandDeps',
  'CommandCodeConnectionOptions', 'CommandCodeLoginCredentials', 'CommandCodeLoginFailureReason',
  'CommandCodeLoginFlow', 'CommandCodeLoginFlowDeps', 'CommandCodeLoginStatus',
  'CommandCodeModelAccountRule', 'CommandCodeSearchProvider', 'CommandCodeSearchProviderDeps',
  'CommandCodeSearchSelection', 'CommandCodeTuiSettingsDeps', 'CommandCodeUsageDeps',
  'CommandCodeUsageReport', 'CommandCodeUsageService', 'Config',
  'DEFAULT_API_BASE', 'DEFAULT_GENERATE_MAX_TOKENS', 'DEFAULT_MAX_OUTPUT_TOKENS',
  'DEFAULT_MODELS_CACHE_PATH', 'DEFAULT_REQUEST_TIMEOUT_MS', 'DEFAULT_STREAM_IDLE_TIMEOUT_MS',
  'DEFAULT_WEB_SEARCH_PROVIDER_ID', 'KNOWN_DEALS', 'KNOWN_EFFORTS',
  'KNOWN_IMAGE_MODELS', 'KNOWN_NON_ZDR_MODELS', 'KNOWN_PEAK_PRICING',
  'KNOWN_PLANS', 'KNOWN_SUBSCRIPTION_PLANS', 'KNOWN_THINKING_MODELS',
  'LANG_AUTO', 'LOGIN_ALLOWED_ORIGINS', 'LOGIN_BEGIN_ENDPOINT',
  'LOGIN_BODY_LIMIT_BYTES', 'LOGIN_CANCEL_ENDPOINT', 'LOGIN_MAX_PORT_ATTEMPTS',
  'LOGIN_START_PORT', 'LOGIN_STATUS_ENDPOINT', 'LOGIN_TIMEOUT_MS',
  'LoginFlowFacade', 'PLAN_LABELS', 'PLAN_ORDER',
  'PROVIDER', 'ResolveAttachments', 'ResolvedCommandCodeOptions',
  'TuiSettingsField', 'TuiSettingsFieldOption', 'TuiSettingsFieldWrite',
  'TuiSettingsGroup', 'TuiSettingsSection', 'TuiSettingsSectionsService',
  'USAGE_REPORT_ENDPOINT', 'WEB_SELECTION_NAMESPACE', 'WebSearchSelectionHandle',
  'WebSelectionLogger', 'WebSelectionSettings', 'accountUsable',
  'apply', 'applyCommandCodeTuiSettings', 'applyCommands',
  'applyUsageRemote', 'buildCommandAuthUrl', 'buildCommandCodeTuiSection',
  'capabilityDescription', 'commandCodeSearchSelection', 'commandDefinition',
  'compareByPlan', 'createCommandCodeSearchSelection', 'dealLabel',
  'formatContext', 'inject', 'loginStatusSchema',
  'matchModelRule', 'modelVisibleInPlan', 'name',
  'parseLoginStatus', 'peakPricingLabel', 'peakPricingState',
  'planLabel', 'projectSlugFromPath', 'resolveAdapterOptions',
  'resolveAuthFileApiKey', 'selectAccountForModel', 'selectActiveAccount',
  'studioBaseForApiBase', 'subscriptionPlanInfo', 'supportsZeroDataRetention',
  'usageReportSchema', 'validateCommandApiKey',
]

/** Every name one `src/index.ts` source text exports. */
function exportNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from|$)/g)) {
    for (const part of match[1]!.split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '')
      if (trimmed === '') continue
      names.add(trimmed.split(/\s+as\s+/).pop()!.trim())
    }
  }
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1]!)
  }
  return names
}

test('src/index.ts keeps every previously public export', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const exported = exportNames(source)
  const missing = BASELINE.filter((name) => !exported.has(name))
  assert.deepEqual(missing, [], `public exports disappeared: ${missing.join(', ')}`)
})

test('the export scanner sees both runtime and type-only exports', () => {
  const names = exportNames([
    'export { a, b as c } from \'./x.ts\'',
    'export type { D, E } from \'./y.ts\'',
    'export type F = string',
    'export const g = 1',
    'export interface H {}',
  ].join('\n'))
  assert.deepEqual([...names].sort(), ['D', 'E', 'F', 'H', 'a', 'c', 'g'])
})
