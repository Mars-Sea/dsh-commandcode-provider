/**
 * dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
 * Code (unofficial; ported from pi-commandcode-provider@0.5.1, MIT).
 *
 * Registers the `commandcode` provider route on `ctx.llm` and declares it in
 * the configurable-provider directory, so the web Models page shows a
 * "Command Code" card and the model picker lists the live catalog. Connection
 * facts are resolved per request from the live profile Config (volatile
 * fields, unwrapped per read) and the credential seam, so a changed key,
 * endpoint or cache path reaches the next request without a restart.
 *
 * ```yaml
 * - id: llm-commandcode
 *   name: "@mars-sea/dsh-commandcode-provider"
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

import { installCostProjection } from './cost-projection.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { CommandCodeAdapter, DEFAULT_API_BASE, resolveAuthFileApiKey } from './adapter.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.ts'
import type { AccountRotationReason, CommandCodeConnectionOptions, CommandCodeUsageReport } from './adapter.ts'
import { CommandCodeAccountPool, accountUsable, selectActiveAccount } from './accounts.ts'
import type { CommandCodeAccountConfig, CommandCodeAccountSlot, CommandCodeModelAccountRule } from './accounts.ts'
import { applyCommands } from './commands.ts'
import { applyUsageRemote } from './usage-remote.ts'
import type { CommandCodeAccountsReport, CommandCodeCatalog } from './usage-wire.ts'
import { CommandCodeLoginFlow, loginCredentialRef } from './login.ts'
import type { CommandCodeLoginCredentials } from './login.ts'
import { pickCommandLocale, type LocaleId } from './command-locales.ts'
import { CommandCodeSearchProvider, applyCommandCodeSearchSelection, commandCodeSearchSelection } from './web-search.ts'
import { applyCommandCodeTuiSettings } from './tui-settings.ts'
import {
  DEFAULT_TRANSPORT_MAX_RETRIES,
  MAX_TRANSPORT_MAX_RETRIES,
  TRANSPORT_FAILURE_CODE,
  absorbTransportFailure,
  resetTransportFailures,
  transportBudgetMessage,
  transportResetAction,
} from './transport-retry.ts'
import { KNOWN_PLANS } from './capabilities.ts'
import { markVolatileFields, unwrapVolatileConfig } from './config-volatile.ts'

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
  KNOWN_NON_ZDR_MODELS,
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
  supportsZeroDataRetention,
} from './capabilities.ts'
import { modelAllowanceFor } from './model-prices.ts'
export type { CommandCodeAdapterDeps, CommandCodeConnectionOptions, CommandCodeUsageReport, ResolveAttachments } from './adapter.ts'
export type { CommandCodeBillingAccess } from './capabilities.ts'
export { applyCommands, commandDefinition } from './commands.ts'
export type { CommandCodeCommandDeps } from './commands.ts'
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
export { CommandCodeSearchProvider, COMMANDCODE_SEARCH_PROVIDER_ID, DEFAULT_WEB_SEARCH_PROVIDER_ID, applyCommandCodeSearchSelection, commandCodeSearchSelection } from './web-search.ts'
export type { CommandCodeSearchSelection } from './web-search.ts'
export type { CommandCodeSearchProviderDeps } from './web-search.ts'
export { ACTIVE_ACCOUNT_AUTO, LANG_AUTO, applyCommandCodeTuiSettings, buildCommandCodeTuiSection } from './tui-settings.ts'
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
/** Default models cache path (mirrors the pi plugin's on-disk cache). */
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
   * Opt-in cache mitigation for the CLI route: after this model has answered,
   * durably offload its earlier images before later turns. Old pixels then
   * require a fresh read/attachment if the model needs to inspect them again.
   * Defaults to false to preserve full image history.
   */
  offloadSeenImagesForCache?: boolean
  /**
   * Transport failures one request absorbs before the failure is surfaced;
   * defaults to 5. The route's retry policy is near-unbounded on purpose
   * (1000 attempts, waits doubling to 15 minutes) because that shape is for
   * the failures a provider asks to have retried; a transport failure is not
   * one of those, and after ~15.5 s of grace the wait is pure stall, so it is
   * capped here (issue #39). 0 surfaces every transport failure immediately.
   */
  transportMaxRetries?: number
  /**
   * Whether the model picker hides models above the account's subscription
   * tier; defaults to true. The filter fails open (unknown plan, billing
   * endpoint failure, or a positive on-demand credit balance all keep the
   * full catalog visible). Set false to always list every model.
   */
  filterModelsByPlan?: boolean
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything"; applied after the subscription-tier filter.
   */
  visibleModels?: string[]
  /**
   * Per-model visibility overrides from the terminal settings page's checkbox
   * list, keyed by catalog id (`true` = listed, `false` = hidden). An id here
   * decides that model on its own; an id absent here follows `visibleModels`.
   * dsh-TUI keys a staged edit by the field's path, so the checkboxes need one
   * path per model — a map.
   */
  modelVisibility?: Record<string, boolean>
  /**
   * Extra accounts for multi-account rotation. The top-level
   * `apiKey`/`apiKeyEnv` (plus the CLI auth file) always form the first
   * (`default`) account; each entry here adds one more, and an entry with
   * neither `apiKey` nor `apiKeyEnv` is ignored. A pre-stream 429/401 marks
   * the key and the next account's key is retried transparently.
   */
  accounts?: CommandCodeAccountConfig[]
  /**
   * Manually selected active account: a slot id — `default`, or an extra
   * account's credential reference (e.g. `COMMANDCODE_API_KEY_2`). It serves
   * whenever usable; an unknown id or an exhausted one falls back to rotation
   * order. Unset means "first usable account".
   */
  activeAccount?: string
  /**
   * Model → account routing rules, each listing catalog model ids for an
   * account slot id. A matching rule's account serves before {@link
   * activeAccount} and the passive rotation order; an unusable routed account
   * falls back, so the router is a hint, never a hard gate. First match wins.
   */
  modelAccountRules?: CommandCodeModelAccountRule[]
  /**
   * Whether to use Command Code as the backend for dsh's model-facing
   * `web_search` tool. Enabled registers a `commandcode` search provider on
   * `ctx.web` AND selects it over the shipped `deepseek-official` (or a
   * sibling plugin's pin), reusing the SAME key and apiBase as chat. Disabling
   * hands the selection back to whichever backend was there before, so a
   * sibling search plugin (e.g. modsearch) keeps working (issue #26). The
   * write rides dsh's internal `searchProviderId`, read per search call, so a
   * setting change lands on the next search without a restart. Defaults true.
   */
  webSearch?: boolean
  /**
   * Whether the Web sidebar shows the plans & quota card
   * (`sidebar.footer.action`). Defaults to false, so an unset document mounts
   * no sidebar quota surface and no background usage poll for it; the
   * dashboard cell behind it stays registered. Read by the browser client; the
   * adapter ignores it.
   */
  showSidebarQuota?: boolean
  /**
   * Whether requests enforce zero data retention: the provider then routes
   * them only through upstreams that keep no prompts/completions and never
   * train on them (its own opt-in, `CMD_ZDR=1` in the CLI / `x-cmd-zdr: 1` on
   * the Provider API). Defaults to FALSE: `zdr` changes WHERE a request is
   * served. Every chat request carries the header when enabled, and a model
   * with no ZDR-capable upstream fails with 422 `cmd_zdr_no_providers` rather
   * than losing the guarantee. ZDR capacity is priced pass-through and usually
   * costs more; the price readout keeps quoting the ordinary catalog rates
   * (the real per-request price shows in Command Code's Studio).
   */
  zdr?: boolean
  /**
   * Language override for the `/commandcode` Host-side command's user-facing
   * copy. Host commands cannot read the client's `ctx.locale`, so this is the
   * explicit knob: `'zh'` or `'en'`, defaulting to `'zh'`. The web settings
   * page is unaffected — it follows the browser's language preference on its
   * own. The declared type is `string` (the schemastery `pattern` cannot
   * narrow literal types); `pickCommandLocale` treats an unknown value as
   * "unset" and then reads `LC_ALL`/`LANG`, which is only reachable when
   * `lang` is absent from a programmatically built config.
   */
  lang?: string
}

/**
 * The Config schema: every field volatile except the composition-only `apiKey`
 * secret. 0.1.7's settings forms are projected from the schema's
 * `meta.volatile` nodes, so an unmarked field would be invisible to AND
 * unwritable from the settings page. The loader also hands `apply()` a live
 * reference per marked field, so writes commit in place without remounting
 * this fiber — the `loader/volatile-update` listener at the bottom of `apply`
 * re-derives the two facts that are not re-read per request.
 */
export const Config: z<Config> = z.object(markVolatileFields({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // `role('secret')` is load-bearing, not decoration: a literal key is the one
  // credential path this plugin cannot keep out of a profile Config document
  // (the page writes through the credentials seam instead), so the harness must
  // strip it from every descriptor read (`settings.describe()` runs with
  // `redactSecrets: true`). Without the role the literal rides back to the
  // browser verbatim — including on a remote-Host setup, where that is another
  // machine.
  // DELIBERATELY not volatile: no settings surface writes it (both the web
  // page and the dsh-TUI section write keys through the credentials seam), so
  // it stays composition-only, and a config-file edit to it reloading this
  // fiber is the correct behavior for a secret literal.
  apiKey: z.string().role('secret'),
  apiBase: z.string(),
  workingDir: z.string(),
  modelsCachePath: z.string(),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  offloadSeenImagesForCache: z.boolean().default(false),
  transportMaxRetries: z.number().min(0).max(MAX_TRANSPORT_MAX_RETRIES),
  filterModelsByPlan: z.boolean(),
  visibleModels: z.array(z.string()),
  modelVisibility: z.dict(z.boolean()),
  webSearch: z.boolean().default(true),
  showSidebarQuota: z.boolean().default(false),
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
  // Off by default: turning it on changes which upstream serves the request
  // (and usually what it costs), so nobody gets ZDR routing by accident.
  zdr: z.boolean().default(false),
  lang: z.string().pattern(/^(zh|en)$/).default('zh' as const),
}, ['apiKey']))

/** One resolution's complete request facts: connection plus credential reference. */
export interface ResolvedCommandCodeOptions extends CommandCodeConnectionOptions {
  apiKeyEnv: CredentialRef
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default is re-judged here — for the composition entry at load and for
 * every settings-backed read.
 */
export function resolveAdapterOptions(config: Config): ResolvedCommandCodeOptions {
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    workingDir: config.workingDir ?? process.cwd(),
    modelsCachePath: config.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    offloadSeenImagesForCache: config.offloadSeenImagesForCache === true,
    filterModelsByPlan: config.filterModelsByPlan ?? true,
    visibleModels: Array.isArray(config.visibleModels)
      ? config.visibleModels.filter((id) => typeof id === 'string' && id !== '')
      : undefined,
    // Only real booleans survive: a hand-edited document can carry anything,
    // and a malformed flag must fall back to the array rather than hide a
    // model.
    modelVisibility: readModelVisibility(config.modelVisibility),
    // The connection carries the switch; the adapter enforces it on every
    // chat request rather than depending on a client-side coverage snapshot.
    zdr: config.zdr === true,
  }
}

/**
 * Per-model visibility overrides, cleaned for the adapter: a non-object or a
 * non-boolean entry is dropped rather than reaching the picker filter, and an
 * all-empty map reads as no map. Returns a fresh id → boolean map, or
 * undefined when nothing is set.
 */
function readModelVisibility(raw: unknown): Readonly<Record<string, boolean>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, boolean] => entry[0] !== '' && typeof entry[1] === 'boolean',
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

export function apply(ctx: Context, config: Config): void {
  installCostProjection(ctx)
  // The raw composition config as handed to `apply`. Everything downstream
  // reads through `current()`, which unwraps volatile references on every call
  // — the loader commits a settings write IN PLACE on the reference, so a
  // cached plain snapshot would go stale on the very next write.
  const current = (): Config => unwrapVolatileConfig(config)
  const options = (): ResolvedCommandCodeOptions => resolveAdapterOptions(current())

  // The account slots, rebuilt from the live config on every resolution so a
  // settings-page accounts change reaches the very next request.
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

  // The manually selected account, re-read per resolution like every other
  // settings-backed fact.
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
  // request using it is actually rejected, and the marks are re-checked
  // against the live window limits only once every account is marked, so the
  // steady state costs zero extra API calls.
  // Explicit annotations break the pool↔adapter inference cycle (the pool's
  // probe calls the adapter; the adapter's rotation hook calls the pool).
  const pool: CommandCodeAccountPool = new CommandCodeAccountPool({
    slots,
    resolveRef,
    authFileKey: resolveAuthFileApiKey,
    // The adapter reference is assigned right below; the probe runs only at
    // request time, never during plugin startup.
    probeWindow: (apiKey: string) => adapter.probeWindowLimits(apiKey),
    preferredId,
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
    // Pre-stream account-scoped rejection: mark the rejected key when the
    // reason warrants it and hand the adapter the next account's key. When
    // every account is unusable the pool's own RATE_LIMIT / INVALID_CREDENTIAL
    // error is what the caller sees, not the raw provider rejection.
    rotateApiKey: async (
      rejectedKey: string,
      rejection: AccountRotationReason,
      _connection: ResolvedCommandCodeOptions,
      model?: string,
      rotation?: { tried: readonly string[]; resetAtMs?: number },
    ): Promise<string | undefined> => {
      // Only the two account-health reasons become marks: an `unavailable`
      // rejection (no credits, a model outside this account's plan) says
      // nothing durable about the key — a `:free` model is still served by a
      // credits-empty account. `rate-limit` and `throttled` both mark but with
      // different causes, so the pool's own diagnosis never reports a plain
      // throttle as an exhausted usage window (issue #54).
      if (rejection !== 'unavailable') pool.markRejected(rejectedKey, rejection, rotation?.resetAtMs)
      // The whole tried set, not just the rejected key, reaches the pool: a
      // rejection that does not mark the key would otherwise be re-offered on
      // every attempt and a four-account pool could never reach the accounts
      // behind it. The model rides along so model-routing rules pick the next
      // account for the same model. An EMPTY set must not be forwarded — the
      // pool reads it as "nothing was tried" and drops the filter this set
      // exists for.
      const tried = rotation?.tried?.length ? rotation.tried : [rejectedKey]
      const resolved = await pool.resolveKey(
        model === undefined ? { tried } : { tried, model },
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
    // The picker's plan filter asks about the whole pool, not just the account
    // that would serve right now: with several accounts on different plans,
    // keying the list on the serving one made models appear and vanish as
    // rotation moved between them.
    resolveAccountKeys: async (): Promise<readonly string[]> => {
      const accounts = await pool.resolvedAccounts()
      return accounts.map((account) => account.key)
    },
  })
  // The Models page card. An empty `settingsPath` means the whole
  // `llm-commandcode` section configures this provider.
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Command Code', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Bounded retry for TRANSPORT failures (issue #39). The route policy is
  // near-unbounded on purpose (see `providerRetryPolicy`) because an exhausted
  // rate-limit window or a gateway 520 is a failure that ASKS to be retried —
  // a connection that cannot be established is not, and the unbounded cadence
  // turned a 10-second connect timeout into an ~8-minute stall, so the first
  // few transport failures are absorbed here and the rest surface with a
  // diagnosis. `dsh-llm-retry` keeps its window for every other code.
  //
  // The failure is surfaced by THROWING out of the waterfall: the agent loop
  // wraps the rejection into the turn's error, so the retry chain stops here.
  // The failure's own message is carried in the thrown message, and the
  // diagnostic also goes to the log, which nothing can rewrite.
  const transportMaxRetries = (): number => {
    const value = current().transportMaxRetries
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_TRANSPORT_MAX_RETRIES
    return Math.min(Math.trunc(value), MAX_TRANSPORT_MAX_RETRIES)
  }
  // `async` is a type-level requirement, not a behavior change: the waterfall's
  // listener contract is `=> Promise<RequestErrorAction>`, so a handler that
  // returns `next()`'s promise on one path and a bare decision on another does
  // not type-check (`Promise<RequestErrorAction> | { kind: 'retry' }` is not
  // assignable, even though the runtime accepts both).
  //
  // The session → agent map exists for the reset below: `session/event` carries
  // the session, and the agent is the natural budget key (it is what the
  // request-error payload hands over). Weak on BOTH sides so a long-lived Host
  // cannot be held open by sessions whose turn never appended a `turn/end`.
  const sessionAgents = new WeakMap<object, object>()
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    // Checked BEFORE the budget: a cancelled turn is the user's own stop, so it
    // must neither be answered with a retry nor consume the slot a later live
    // failure needs.
    if (signal.aborted) return next()
    const session: unknown = Reflect.get(agent, 'session')
    if (typeof session === 'object' && session !== null) sessionAgents.set(session, agent)
    const decision = absorbTransportFailure(agent, failure.code, transportMaxRetries())
    if (decision === 'ignored') return next()
    // The literal is spelled as the event's own decision type; the union this
    // handler returns (`RequestErrorAction | Promise<RequestErrorAction>`) is
    // what the waterfall accepts, and `{ kind: 'retry' }` alone widens to
    // `string` and stops matching it.
    if (decision === 'retry') return { kind: 'retry' } satisfies RequestErrorAction
    const message = transportBudgetMessage(failure.message, transportMaxRetries())
    ctx.logger.warn(`llm-commandcode: transport retry budget exhausted for ${PROVIDER} (${TRANSPORT_FAILURE_CODE})`)
    throw new Error(message)
  })
  // Reset the budget at each new STEP — one step is exactly one model request
  // (`step/start` is appended immediately before the call), so this is what
  // makes the cap "per logical request" and gives the next step of the same
  // turn its own grace. `agent/status` → `idle` is deliberately NOT the reset
  // signal: `setPhase` emits it only on a status CHANGE, and a turn's steps run
  // inside one `running` phase, so it never fires between them — a budget reset
  // only there would be per-turn, and a network outage would fail every later
  // step of that turn instantly instead of retrying each. `assistant/attempt`
  // is wrong for the opposite reason: the loop appends it for the FAILED
  // attempt before dispatching `agent/request-error`, so resetting on it would
  // clear the budget on every failure. `idle` still clears the agent's count,
  // and the WeakMap drops a finished session on its own.
  ctx.on('session/event', (session, event) => {
    const action = transportResetAction(event.type)
    if (action === 'forget') {
      sessionAgents.delete(session)
      return
    }
    if (action !== 'reset') return
    const agent = sessionAgents.get(session)
    if (agent !== undefined) resetTransportFailures(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') resetTransportFailures(agent)
  })

  // Per-account usage for the /commandcode dashboard and the settings
  // page's account card: every pool account (configured or not) gets one
  // entry, each fetched with its own key so plan/credit facts never mix.
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

  // The /commandcode usage command rides the optional `commands` service: a
  // child fiber injects it, so it registers whenever the profile mounts
  // dsh-commands and the fiber simply never activates when it does not.
  // The command runs Host-side and has no access to the client's locale
  // service, so its language is resolved per invocation from `Config.lang`
  // (explicit override) and the environment's `LC_ALL`/`LANG` (inferred
  // default), so a settings change reaches the next run without a restart.
  const commandLocale = (): LocaleId => pickCommandLocale(current().lang)
  ctx.inject(['commands'], (commandCtx) => {
    applyCommands(commandCtx, { adapter, reports: usageReports, getLocale: commandLocale })
  })

  // The settings page's account card: getUsage exposed to the browser through
  // the Typert Gateway (`commandcode/report`), plus the browser-login flow the
  // same service carries (the Host binds a loopback callback server and stores
  // the delivered key through the credentials seam). Rides the optional
  // `typert` registry service, so profiles without the web stack never
  // activate it.
  const loginFlow = new CommandCodeLoginFlow({
    apiBase: () => options().apiBase,
    validateTargetRef: (targetRef): void => {
      loginCredentialRef(targetRef, current().apiKeyEnv ?? DEFAULT_API_KEY_ENV, current().accounts ?? [])
    },
    storeKey: async ({ apiKey }: CommandCodeLoginCredentials, targetRef): Promise<void> => {
      const ref = credentialRef(loginCredentialRef(targetRef, current().apiKeyEnv ?? DEFAULT_API_KEY_ENV, current().accounts ?? []))
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('the credentials service is unavailable in this profile; paste the key manually')
      }
      await credentials.set(ref, apiKey)
    },
  })
  ctx.effect(() => () => loginFlow.dispose(), 'dsh-commandcode-provider: login flow')
  // The full model catalog for the settings page's model editors: served
  // Host-side from the adapter's cached/fetched catalog, so the browser never
  // calls the Command Code API directly. Unfiltered, so an editor never loses
  // its own options — a rule can route a GOAT-only model the picker hides.
  // Each entry carries its plan-tier key so the editors can group under tier
  // headings without importing the Host's capability snapshot.
  const catalogForEditors = async (): Promise<CommandCodeCatalog> => {
    const models = await adapter.listModels(PROVIDER, { unfiltered: true })
    // Per-model monthly allowance (how far this one model stretches the plan's
    // credit pool). The page publishes one for GOAT and Pro only, so the POOL's
    // bracket decides whether a figure exists at all — a Go/Max/Provider account
    // gets none rather than a neighbouring tier's number. `listModels` above
    // already consulted the same cached billing facts, so this costs one lookup.
    const bracket = await adapter.allowanceTier()
    return {
      models: models.map((model) => {
        const tier = KNOWN_PLANS[model.id]
        const allowance = bracket === undefined ? undefined : modelAllowanceFor(model.id)?.[bracket]
        return {
          id: model.id,
          name: model.name.replace(/\s*\(CC\)$/, ''),
          ...(tier === undefined ? {} : { tier }),
          ...(allowance === undefined ? {} : { allowance }),
        }
      }),
    }
  }
  applyUsageRemote(ctx, { adapter, reports: usageReports, login: loginFlow, listModels: catalogForEditors })

  // Web search over the Command Code Provider API, exposed through the web
  // capability seam (`ctx.web`). Rides the optional `web` service: a child
  // fiber injects it, so the provider registers whenever the profile mounts
  // the web stack and the fiber never activates when it does not. It reuses
  // the SAME credential chain and apiBase as the model adapter, so DSH's
  // model-facing web_search tool needs no separate key or endpoint config.
  //
  // Whether `commandcode` WINS over the shipped `deepseek-official` (or a
  // sibling search plugin's pin, e.g. modsearch) is `Config.webSearch`. The
  // seam has no public runtime selector, so the plugin writes its private
  // `searchProviderId` field (read per call) via
  // `applyCommandCodeSearchSelection`; see src/web-search.ts for why that
  // write is safe. The tracked selection remembers whichever backend was
  // displaced, so turning the toggle off — and disposing the fiber — hands the
  // selection back to it (issue #26) instead of forcing the factory default.
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

  // The dsh-TUI settings page: without it a TUI-only user has no way to enter
  // the API key (issue #28). The seam is optional, exactly like `commands` and
  // `web`, so a profile without dsh-TUI never activates this fiber.
  let refreshTuiSettings: (() => void) | undefined
  ctx.inject(['tuiSettingsSections'], (tuiCtx) => {
    refreshTuiSettings = applyCommandCodeTuiSettings(tuiCtx, {
      ns: NS,
      // Read per registration, so a `Config.apiKeyEnv` change re-targets the
      // key field instead of leaving it writing to the previous reference.
      apiKeyRef: () => current().apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      // The section is re-registered when this list changes (the refresh call
      // below), since the host renders a fixed option list per declaration.
      accountSlots: () => slots().map((slot) => ({ id: slot.id, label: slot.label })),
      // Read live, so a checkbox judges its inherited state against the
      // current document, and an id this build's catalog does not place still
      // gets a row of its own.
      visibleModels: () => options().visibleModels ?? [],
      modelVisibility: () => options().modelVisibility,
    })
    tuiCtx.effect(() => () => {
      refreshTuiSettings = undefined
    }, 'dsh-commandcode-provider: tui settings handle')
  })

  // Settings is an optional service. `configure({ auto: false })` declares that
  // this plugin ships its own page, so SettingsForms publishes no auto-generated
  // form for this entry. A profile without a settings service simply keeps
  // using the composition config `apply()` was handed.
  //
  // The one-time settings.yaml import needs no cooperation from here: the
  // section id and the profile entry id are the SAME string
  // (`llm-commandcode`) — never rename one without the other, or a mismatch
  // strands existing users' non-secret settings in `settings.yaml.imported`.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      const dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber)
      return () => {
        dispose()
      }
    }, 'dsh-commandcode-provider: settings auto-form policy')
  })

  // The loader commits volatile config IN PLACE — no remount — and notifies the
  // OWNING fiber (`loader/volatile-update`, every value already committed
  // before dispatch). The facts that are not re-derived from `current()` per
  // use re-apply here: the web seam's selection (its private field is written,
  // not read back from config) and the TUI section (its option lists are frozen
  // into the declaration). Typed structurally because the event is declared by
  // `cordis-plugin-loader`, which is not a peer of this bundle.
  const loaderEvents = ctx as unknown as {
    on(event: 'loader/volatile-update', listener: () => void): unknown
  }
  ctx.effect(() => {
    const off = loaderEvents.on('loader/volatile-update', () => {
      applySearchSelection(current().webSearch ?? true)
      refreshTuiSettings?.()
    })
    return () => {
      if (typeof off === 'function') (off as () => void)()
    }
  }, 'dsh-commandcode-provider: volatile config updates')
}
