/**
 * dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
 * Code (unofficial, community-maintained).
 *
 * Registers the `commandcode` provider route on `ctx.llm` and declares it in
 * the configurable-provider directory, so the web Models page shows a
 * "Command Code" card with an API-key field and the model picker lists the
 * live Command Code model catalog. Connection facts resolve per request over
 * the optional `llm-commandcode` user-settings section and the credential
 * seam, so a changed key, endpoint, or cache path reaches the next request
 * without a restart.
 *
 * ```yaml
 * - id: llm-commandcode
 *   name: "@xer-on/dsh-commandcode-provider"
 *   config:
 *     apiKeyEnv: COMMANDCODE_API_KEY
 * ```
 *
 * The `name` is the full package specifier as installed in the profile's
 * node_modules: the loader imports it as a module, and pnpm links packages by
 * their true (scoped) name — a bare `dsh-commandcode-provider` fails to
 * resolve (ERR_MODULE_NOT_FOUND) and crashes the app on boot. The value must
 * be quoted in YAML: an unquoted scalar starting with `@` fails to parse.
 *
 * @module dsh-commandcode-provider
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { CommandCodeAdapter, DEFAULT_API_BASE, resolveAuthFileApiKey } from './adapter.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.ts'
import type { CommandCodeConnectionOptions, CommandCodeUsageReport } from './adapter.ts'
import { CommandCodeAccountPool, accountUsable, selectActiveAccount } from './accounts.ts'
import type { CommandCodeAccountConfig, CommandCodeAccountSlot, CommandCodeModelAccountRule } from './accounts.ts'
import { applyUsageRemote } from './usage-remote.ts'
import type { CommandCodeAccountsReport, CommandCodeCatalog } from './usage-wire.ts'
import { CommandCodeLoginFlow } from './login.ts'
import type { CommandCodeLoginCredentials } from './login.ts'
import { CommandCodeSearchProvider, applyCommandCodeSearchSelection, commandCodeSearchSelection } from './web-search.ts'
import { applyCommandCodeTuiSettings } from './tui-settings.ts'
import { KNOWN_PLANS } from './capabilities.ts'

export {
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_GENERATE_MAX_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  CommandCodeAdapter,
  BILLING_ACCESS_TTL_MS,
  projectSlugFromPath,
  resolveAuthFileApiKey,
} from './adapter.ts'
export {
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_THINKING_MODELS,
  KNOWN_PLANS,
  KNOWN_SUBSCRIPTION_PLANS,
  KNOWN_DEALS,
  KNOWN_PEAK_PRICING,
  PLAN_LABELS,
  PLAN_ORDER,
  capabilityDescription,
  compareByPlan,
  dealLabel,
  formatContext,
  modelVisibleInPlan,
  peakPricingLabel,
  peakPricingState,
  planLabel,
  subscriptionPlanInfo,
} from './capabilities.ts'
export type { CommandCodeAdapterDeps, CommandCodeConnectionOptions, CommandCodeUsageReport, ResolveAttachments } from './adapter.ts'
export type { CommandCodeBillingAccess } from './capabilities.ts'
export { applyUsageRemote, CommandCodeUsageService } from './usage-remote.ts'
export type { CommandCodeUsageDeps, LoginFlowFacade } from './usage-remote.ts'
export { USAGE_REPORT_ENDPOINT, usageReportSchema } from './usage-wire.ts'
export type { CommandCodeAccountUsage, CommandCodeAccountsReport } from './usage-wire.ts'
export {
  LOGIN_BEGIN_ENDPOINT,
  LOGIN_STATUS_ENDPOINT,
  LOGIN_CANCEL_ENDPOINT,
  parseLoginStatus,
  loginStatusSchema,
} from './login-wire.ts'
export type {
  CommandCodeLoginStatus,
  CommandCodeLoginFailureReason,
} from './login-wire.ts'
export {
  LOGIN_TIMEOUT_MS,
  LOGIN_START_PORT,
  LOGIN_MAX_PORT_ATTEMPTS,
  LOGIN_BODY_LIMIT_BYTES,
  LOGIN_ALLOWED_ORIGINS,
  buildCommandAuthUrl,
  studioBaseForApiBase,
  validateCommandApiKey,
  CommandCodeLoginFlow,
} from './login.ts'
export type {
  CommandCodeLoginCredentials,
  CommandCodeLoginFlowDeps,
  ApiKeyValidation,
} from './login.ts'
export { CommandCodeAccountPool, accountUsable, selectActiveAccount, matchModelRule, selectAccountForModel } from './accounts.ts'
export type { CommandCodeAccountConfig, CommandCodeAccountSlot, CommandCodeAccountState, CommandCodeModelAccountRule } from './accounts.ts'
export { CommandCodeSearchProvider, COMMANDCODE_SEARCH_PROVIDER_ID, DEFAULT_WEB_SEARCH_PROVIDER_ID, applyCommandCodeSearchSelection, commandCodeSearchSelection, selectCommandCodeSearchProvider } from './web-search.ts'
export type { CommandCodeSearchSelection } from './web-search.ts'
export type { CommandCodeSearchProviderDeps } from './web-search.ts'
export { ACTIVE_ACCOUNT_AUTO, applyCommandCodeTuiSettings, buildCommandCodeTuiSection } from './tui-settings.ts'
export type {
  CommandCodeTuiSettingsDeps,
  TuiSettingsField,
  TuiSettingsFieldOption,
  TuiSettingsFieldWrite,
  TuiSettingsGroup,
  TuiSettingsSection,
  TuiSettingsSectionsService,
} from './tui-settings.ts'

export const name = 'llm-commandcode'
export const inject = ['llm']

const NS = 'llm-commandcode'
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** The single provider route this plugin owns. */
export const PROVIDER = 'commandcode'
/** Default models cache path (mirrors the official CLI's on-disk cache). */
export const DEFAULT_MODELS_CACHE_PATH = join(homedir(), '.commandcode', 'models-cache.json')

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-commandcode` settings-section shape. Every field is optional:
 * a missing API key resolves through {@link Config.apiKeyEnv} at each request
 * (the web Models page writes it), with the official Command Code CLI auth
 * file (`~/.commandcode/auth.json`) as the last fallback.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `COMMANDCODE_API_KEY`. */
  apiKeyEnv?: string
  /** Literal API key override (composition config only); takes precedence over `apiKeyEnv`. */
  apiKey?: string
  /** API base; defaults to the public Command Code Provider API. */
  apiBase?: string
  /** Working directory reported to the API; defaults to the process cwd. */
  workingDir?: string
  /** Model catalog cache path; defaults to `~/.commandcode/models-cache.json`. */
  modelsCachePath?: string
  /** Milliseconds to wait for the generate response's first byte; defaults to 60s. */
  requestTimeoutMs?: number
  /** Milliseconds a stream may stall before being treated as a dead connection; defaults to 300s. */
  streamIdleTimeoutMs?: number
  /**
   * Whether the model picker hides models above the account's subscription
   * tier; defaults to true. The filter fails open (unknown plan, billing
   * endpoint failure, or a positive on-demand credit balance all keep the
   * full catalog visible). Set false to always list every model.
   */
  filterModelsByPlan?: boolean
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything". Persisted by the settings page's model
   * filter card; applies after the subscription-tier filter.
   */
  visibleModels?: string[]
  /**
   * Per-model visibility overrides from the terminal settings page's checkbox
   * list, keyed by catalog id (`true` = listed, `false` = hidden). An id here
   * decides that model on its own; an id absent here follows `visibleModels`.
   * dsh-TUI keys a staged edit by the field's path, so the checkboxes need one
   * path per model — a map — because a boolean field cannot express "this id
   * is a member of the array".
   */
  modelVisibility?: Record<string, boolean>
  /**
   * Extra accounts for multi-account rotation. The top-level
   * `apiKey`/`apiKeyEnv` (plus the CLI auth file) always form the first
   * (`default`) account; each entry here adds one more. When a request is
   * rejected pre-stream with 429 (usage window exhausted) or 401, the next
   * account's key retried transparently; when every account is exhausted the
   * request fails with a `RATE_LIMIT` error naming the earliest window
   * reset. Entries without `apiKey` or `apiKeyEnv` are ignored.
   */
  accounts?: CommandCodeAccountConfig[]
  /**
   * Manually selected active account: a slot id — `default`, or an extra
   * account's credential reference (e.g. `COMMANDCODE_API_KEY_2`). The
   * selected account serves whenever it is usable; an unknown id or an
   * exhausted selected account falls back to the first usable slot (automatic
   * rotation still applies). Unset means "first usable account".
   */
  activeAccount?: string
  /**
   * Model → account routing rules. Each rule lists catalog model ids to an
   * account slot id (`default`, or an extra account's credential reference).
   * When a request's model is in a rule's list and the routed account is
   * usable, that account serves — before the manual {@link activeAccount} and
   * the passive rotation order. A routed account that is exhausted or invalid
   * falls back to the normal selection, so the router is a hint, never a hard
   * gate. The first matching rule wins.
   */
  modelAccountRules?: CommandCodeModelAccountRule[]
  /**
   * Whether to use Command Code as the backend for dsh's model-facing
   * `web_search` tool. When enabled, the plugin registers a `commandcode`
   * search provider on `ctx.web` AND selects `commandcode` in the web seam
   * (so it wins over the shipped `deepseek-official` or a sibling search
   * plugin's pin), using the SAME Command Code API key/base as chat. When
   * disabled, the selection is handed back to whichever backend was there
   * before — turning it off never forces the factory default, so a sibling
   * search plugin (e.g. modsearch) keeps working (issue #26). The rewrite
   * rides dsh's internal `searchProviderId`, which is read per search call,
   * so a setting change lands on the next search without a restart.
   * Defaults to true.
   */
  webSearch?: boolean
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // `role('secret')` is load-bearing, not decoration: a literal key is the one
  // credential path this plugin cannot keep out of a settings document (the
  // page writes through the credentials seam instead), so the harness must
  // strip it from every descriptor read (`settings.describe()` runs with
  // `redactSecrets: true`). Without the role the literal rides back to the
  // browser verbatim — including on a remote-Host setup, where that is another
  // machine. Same declaration as the official providers' `apiKey` field.
  apiKey: z.string().role('secret'),
  apiBase: z.string(),
  workingDir: z.string(),
  modelsCachePath: z.string(),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  filterModelsByPlan: z.boolean(),
  visibleModels: z.array(z.string()),
  /**
   * Per-model visibility overrides for the terminal settings page's checkbox
   * list, keyed by catalog id. dsh-TUI addresses a staged edit by its field
   * PATH, so two checkboxes sharing one path would overwrite each other's
   * draft and the section's last model would decide every write; a map gives
   * each checkbox a path of its own. An id listed here wins over
   * {@link visibleModels}; ids absent here keep following it.
   */
  modelVisibility: z.dict(z.boolean()),
  webSearch: z.boolean().default(true),
  accounts: z.array(z.object({
    label: z.string(),
    apiKeyEnv: z.string().role('credential-ref'),
    /** Literal key for one extra slot; see the top-level `apiKey` secret note. */
    apiKey: z.string().role('secret'),
  })),
  activeAccount: z.string(),
  modelAccountRules: z.array(z.object({
    models: z.array(z.string()),
    account: z.string(),
  })),
})

/** One resolution's complete request facts: connection plus credential reference. */
export interface ResolvedCommandCodeOptions extends CommandCodeConnectionOptions {
  apiKeyEnv: CredentialRef
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default is re-judged here — for the composition entry at load and for
 * each settings snapshot at its first use.
 */
export function resolveAdapterOptions(config: Config): ResolvedCommandCodeOptions {
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    workingDir: config.workingDir ?? process.cwd(),
    modelsCachePath: config.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    filterModelsByPlan: config.filterModelsByPlan ?? true,
    visibleModels: Array.isArray(config.visibleModels)
      ? config.visibleModels.filter((id) => typeof id === 'string' && id !== '')
      : undefined,
    // Only real booleans survive: a hand-edited document can carry anything,
    // and a malformed flag must fall back to the array rather than hide a
    // model. An all-empty map is the same as no map.
    modelVisibility: readModelVisibility(config.modelVisibility),
  }
}

/**
 * Per-model visibility overrides, cleaned for the adapter. Programmatic
 * construction may bypass Schemastery normalization, so a non-object or a
 * non-boolean entry is dropped here instead of reaching the picker filter.
 * @param raw - The `modelVisibility` value from any config source.
 * @returns A frozen id → boolean map, or undefined when nothing is set.
 */
function readModelVisibility(raw: unknown): Readonly<Record<string, boolean>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, boolean] => entry[0] !== '' && typeof entry[1] === 'boolean',
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCommandCodeOptions | undefined
  const options = (): ResolvedCommandCodeOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const next = resolveAdapterOptions(raw)
    lastRaw = raw
    lastGood = next
    return next
  }
  options()

  // The account slots, rebuilt from the live config on every resolution so
  // a settings-page accounts change reaches the very next request. The
  // top-level apiKey/apiKeyEnv (+ the CLI auth file) form the default
  // account; each config.accounts entry adds one more.
  const slots = (): CommandCodeAccountSlot[] => {
    const raw = current()
    const list: CommandCodeAccountSlot[] = [{
      id: 'default',
      label: 'Default',
      ref: credentialRef(raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
      literal: raw.apiKey,
      allowAuthFile: true,
    }]
    for (const [index, account] of (raw.accounts ?? []).entries()) {
      const refName = typeof account.apiKeyEnv === 'string' && account.apiKeyEnv.trim() !== ''
        ? account.apiKeyEnv.trim()
        : undefined
      const literal = typeof account.apiKey === 'string' && account.apiKey !== '' ? account.apiKey : undefined
      if (refName === undefined && literal === undefined) continue
      list.push({
        // Slot ids must survive account-list edits: an extra's id is its
        // credential reference (stable across reorders/removals), falling
        // back to the positional id only for literal-only composition
        // entries, which no settings document can name anyway.
        id: refName ?? `account-${index + 2}`,
        label: typeof account.label === 'string' && account.label.trim() !== ''
          ? account.label.trim()
          : `Account ${index + 2}`,
        ref: refName === undefined ? undefined : credentialRef(refName),
        literal,
        allowAuthFile: false,
      })
    }
    return list
  }

  // The manually selected account (settings page / config), re-read per
  // resolution like every other settings-backed fact.
  const preferredId = (): string | undefined => {
    const raw = current().activeAccount
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  }

  const resolveRef = async (ref: ReturnType<typeof credentialRef>): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      // The credentials seam layers the process environment, the
      // provider-managed store, and `.env` files itself — a miss here is
      // genuinely unconfigured, not "not in the store".
      const hit = await credentials.resolve(ref)
      return hit?.value
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }

  // The multi-account pool: passive rotation only — a key is marked when a
  // request using it is actually rejected (429/401), and the marks are
  // re-checked against the live window limits only once every account is
  // marked, so the steady state costs zero extra API calls.
  // Explicit annotations break the pool↔adapter inference cycle (the pool's
  // probe calls the adapter; the adapter's rotation hook calls the pool).
  const pool: CommandCodeAccountPool = new CommandCodeAccountPool({
    slots,
    resolveRef,
    authFileKey: resolveAuthFileApiKey,
    // The adapter reference is assigned right below; the probe runs only at
    // request time, never during plugin startup.
    probeWindow: (apiKey: string) => adapter.probeFiveHourWindow(apiKey),
    preferredId,
    // Model → account routing rules, re-read per resolution like every
    // settings-backed fact.
    modelAccountRules: (): readonly CommandCodeModelAccountRule[] => current().modelAccountRules ?? [],
  })

  const resolveApiKey = async (connection: ResolvedCommandCodeOptions, model?: string): Promise<string> => {
    const resolved = await pool.resolveKey(model === undefined ? {} : { model })
    if (resolved !== undefined) {
      return assertUsableApiKey(resolved.key, 'llm-commandcode', resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`)
    }
    const ref = connection.apiKeyEnv
    throw new LlmError(
      `llm-commandcode: no API key for provider route "${PROVIDER}"; store ${ref} through the`
      + ' credentials service (the web Models page writes it), export it in the launching'
      + ' environment, set config.apiKey, or run `command-code login` to write'
      + ' ~/.commandcode/auth.json',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter: CommandCodeAdapter<ResolvedCommandCodeOptions> = new CommandCodeAdapter({
    options,
    resolveApiKey,
    // Pre-stream 429/401: mark the rejected key and hand the adapter the next
    // account's key. When every account is exhausted the pool throws the
    // RATE_LIMIT/INVALID_CREDENTIAL error that names the earliest reset —
    // that error, not the raw 429, is what the caller sees.
    rotateApiKey: async (rejectedKey: string, rejection: 'rate-limit' | 'invalid-credential', _connection: ResolvedCommandCodeOptions, model?: string): Promise<string | undefined> => {
      pool.markRejected(rejectedKey, rejection)
      // Exclude the just-rejected key from probe-revival: a probe clearing its
      // window must not re-offer the same key within this request (the
      // adapter refuses already-tried keys); the next request picks it up.
      // The model rides along so model-routing rules pick the next account
      // for the same model.
      const resolved = await pool.resolveKey(
        model === undefined ? { exclude: rejectedKey } : { exclude: rejectedKey, model },
      )
      // Normalize like the initial resolution does: the pool keys its state
      // by the resolved key, so the adapter must send (and report back) the
      // same normalized form or the marks would miss.
      return resolved === undefined
        ? undefined
        : assertUsableApiKey(resolved.key, 'llm-commandcode', resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`)
    },
    // The durable attachment service carries image bytes referenced by
    // ImageBlock; resolved lazily only when a request actually has images.
    resolveAttachments: () => {
      const attachments = ctx.get('attachments')
      return attachments === undefined ? undefined : attachments
    },
  })
  // The Models page card: a configurable provider with a settings address.
  // settingsPath [] means the whole `llm-commandcode` section configures it.
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Command Code', settingsNs: NS, settingsPath: [] },
  ])
  // The live route: this is what makes models requestable under `commandcode`.
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Per-account usage for the settings page's account card and the sidebar
  // panel: every pool account (configured or not) gets one entry, each
  // fetched with its own key so plan/credit facts never mix.
  const usageReports = async (): Promise<CommandCodeAccountsReport> => {
    // describeAccounts (not deduped) so two slots sharing one credential are
    // both reported as configured; the active badge follows the deduped
    // serving selection.
    const described = await pool.describeAccounts()
    const byId = new Map(described.map((account) => [account.slot.id, account]))
    const active = selectActiveAccount(await pool.resolvedAccounts(), preferredId())
    const entries = await Promise.all(slots().map(async (slot) => {
      const account = byId.get(slot.id)
      let report: CommandCodeUsageReport
      if (account === undefined) {
        report = { failures: [] }
      } else {
        try {
          report = await adapter.getUsage(account.key)
        } catch (error: unknown) {
          report = { failures: [error instanceof Error ? error.message : String(error)] }
        }
      }
      const state = account?.state
      // The mark mirrors servability: a usable account (never marked, or a
      // cooldown whose reset passed) shows no mark; a cooldown without a
      // known reset still shows "rate-limit" (it is not serving).
      const usable = accountUsable(state)
      return {
        id: slot.id,
        label: slot.label,
        configured: account !== undefined,
        active: account !== undefined && active?.slot.id === slot.id,
        mark: usable ? '' : state?.kind === 'disabled' ? 'invalid-credential' : 'rate-limit',
        cooldownUntil: !usable && state?.kind === 'cooldown' ? state.until : 0,
        report,
      }
    }))
    return { accounts: entries }
  }

  // The settings page's account card: getUsage exposed to the browser through
  // the Typert Gateway (`commandcode/report`). Rides the optional `typert`
  // registry service, so profiles without the web stack never activate it.
  // The same service also exposes the browser-login flow: the Host binds a
  // loopback callback server (the official `command-code login` dance) and
  // stores the delivered key through the credentials seam under the same
  // reference the default slot resolves — no restart, no settings document.
  const loginFlow = new CommandCodeLoginFlow({
    apiBase: () => options().apiBase,
    storeKey: async ({ apiKey }: CommandCodeLoginCredentials): Promise<void> => {
      const ref = credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV)
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('the credentials service is unavailable in this profile; paste the key manually')
      }
      await credentials.set(ref, apiKey)
    },
  })
  ctx.effect(() => () => loginFlow.dispose(), 'dsh-commandcode-provider: login flow')
  // The full model catalog for the settings page's model editors (the
  // routing-rule editor and the visible-models filter): served Host-side
  // from the adapter's cached/fetched catalog (sorted for picking), so the
  // browser never calls the Command Code API directly. Unfiltered, so an
  // editor never loses its own options — e.g. a rule can route a GOAT-only
  // model while the picker (plan-filtered + allowlisted) hides it. Each
  // entry carries its plan-tier key so the editors can group under tier
  // headings without importing the Host's capability snapshot.
  const catalogForEditors = async (): Promise<CommandCodeCatalog> => {
    const models = await adapter.listModels(PROVIDER, { unfiltered: true })
    return {
      models: models.map((model) => {
        const tier = KNOWN_PLANS[model.id]
        return {
          id: model.id,
          name: model.name.replace(/\s*\(CC\)$/, ''),
          ...(tier === undefined ? {} : { tier }),
        }
      }),
    }
  }
  applyUsageRemote(ctx, { adapter, reports: usageReports, login: loginFlow, listModels: catalogForEditors })

  // Web search over the Command Code Provider API, exposed through the web
  // capability seam (`ctx.web`). Rides the optional `web` service: a child
  // fiber injects it, so the provider registers whenever the profile mounts
  // the web stack and the fiber never activates when it does not (profiles
  // without web remain an LLM-provider-only plugin). It reuses the SAME
  // credential chain as the model adapter (pool.resolveKey → env → auth file)
  // and the same apiBase, so DSH's model-facing web_search tool needs no
  // separate key or endpoint config — a Command Code key works as-is.
  //
  // Whether the `commandcode` provider WINS over the shipped `deepseek-official`
  // (or a sibling search plugin's pin, e.g. modsearch) is controlled by
  // `Config.webSearch` (default on). The web seam has no public runtime
  // selector, so the plugin writes its private `searchProviderId` field (read
  // per call) via `applyCommandCodeSearchSelection`. A settings change lands
  // on the next search without a restart. See src/web-search.ts for why this
  // runtime write is safe and what it depends on.
  //
  // The tracked selection remembers whichever backend was displaced, so
  // turning the toggle off hands the selection back to it (issue #26) — the
  // disable path never forces the factory default. Disposing the fiber (the
  // plugin unloads) restores it the same way: without that, the stale
  // `commandcode` pin would outlive its unregistered provider and every
  // search would fail with WEB_PROVIDER_CONFIGURED_MISSING.
  const searchSelection = commandCodeSearchSelection()
  const applySearchSelection = (enabled: boolean): void => {
    if (webRuntime !== undefined) {
      applyCommandCodeSearchSelection(webRuntime, searchSelection, enabled)
    }
  }
  let webRuntime: WebRuntime | undefined
  ctx.inject(['web'], (webCtx) => {
    webRuntime = webCtx.web
    webCtx.web.registerSearchProvider(new CommandCodeSearchProvider({
      resolveKey: async () => {
        const resolved = await pool.resolveKey()
        return resolved === undefined ? undefined : resolved.key
      },
      apiBase: () => options().apiBase,
    }))
    // Apply the selection at boot too, so a profile WITHOUT the manual
    // `searchProvider: commandcode` cordis patch still routes web search to
    // Command Code once this plugin loads (default `webSearch` on).
    applySearchSelection(current().webSearch ?? true)
    // The fiber's disposer restores the displaced backend the same way the
    // toggle-off path does (`webCtx.effect` registers the inner function as
    // the fiber's teardown; a bare `return` from the inject callback would
    // not). Without this, the stale `commandcode` pin would outlive its
    // unregistered provider and every search would fail with
    // WEB_PROVIDER_CONFIGURED_MISSING.
    webCtx.effect(() => () => {
      webRuntime = undefined
      applyCommandCodeSearchSelection(webCtx.web, searchSelection, false)
    }, 'dsh-commandcode-provider: web search selection')
  })

  // The terminal front door (dsh-TUI) settings page. dsh-TUI owns its own
  // settings screen and only asks plugins to DECLARE what is editable, so
  // without this a TUI-only user has no way to enter the API key — the web
  // Models page is the only other surface that writes it, and dsh-TUI's
  // `/provider` wizard manages its own `llm-pi-ai` routes exclusively
  // (issue #28). The seam is an optional service, exactly like `commands`
  // and `web`: on a profile without dsh-TUI the fiber never activates, and
  // the plugin stays a plain LLM-provider bundle. The API-key field is a
  // secret field, so the literal goes to the credentials seam and never into
  // a settings document.
  let refreshTuiSettings: (() => void) | undefined
  ctx.inject(['tuiSettingsSections'], (tuiCtx) => {
    refreshTuiSettings = applyCommandCodeTuiSettings(tuiCtx, {
      ns: NS,
      // Read per registration, so a `Config.apiKeyEnv` change re-targets the
      // key field instead of leaving it writing to the previous reference.
      apiKeyRef: () => current().apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      // The account slots behind the active-account selector. The section is
      // re-registered when this list changes (the refresh call below), since
      // the host renders a fixed option list per declaration.
      accountSlots: () => slots().map((slot) => ({ id: slot.id, label: slot.label })),
      // The model allowlist is read LIVE on every toggle: a checkbox judges
      // its inherited state against the current document, not against
      // whatever the declaration happened to be registered with. The override
      // map is read here too, so an id this build's catalog does not place
      // still gets a row of its own.
      visibleModels: () => options().visibleModels ?? [],
      modelVisibility: () => options().modelVisibility,
    })
    tuiCtx.effect(() => () => {
      refreshTuiSettings = undefined
    }, 'dsh-commandcode-provider: tui settings handle')
  })

  // Settings became an optional service in dsh 0.1.2. Register the section
  // through its provider when present; profiles without settings continue to
  // use the composition entry captured by `current` above.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      // Re-apply the web search selection on every settings change so the
      // `webSearch` toggle reaches the web seam's next search without a
      // restart. The tracked state remembers the displaced backend (issue
      // #26), so flipping the toggle is a handoff, not an overwrite. The
      // adapter's own facts are resolved per request, so nothing else needs
      // registration-level action here.
      //
      // The dsh-TUI section is refreshed from the same hook: its key field
      // follows `apiKeyEnv` and its account selector follows `accounts`, and
      // both are frozen into the declaration the host renders. The refresh is
      // a no-op unless one of those facts actually moved, so ordinary writes
      // (the key itself, the model filters) never churn the screen.
      onChange: () => {
        applySearchSelection(current().webSearch ?? true)
        refreshTuiSettings?.()
      },
    })
  })
}
