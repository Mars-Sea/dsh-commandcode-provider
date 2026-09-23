/**
 * dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
 * Code (unofficial; ported from pi-commandcode-provider@0.5.1).
 *
 * Registers the `commandcode` provider route on `ctx.llm` and declares it in
 * the configurable-provider directory, so the web Models page shows a
 * "Command Code" card with an API-key field and the model picker lists the
 * live Command Code model catalog. Connection facts resolve per request over
 * the plugin's live config — the `llm-commandcode` settings section through
 * dsh 0.1.6, profile Config (volatile fields, unwrapped per read) from 0.1.7
 * — and the credential seam, so a changed key, endpoint, or cache path
 * reaches the next request without a restart.
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
import { CommandCodeLoginFlow } from './login.ts'
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
import {
  COMMAND_GUARD_DEFAULT_THRESHOLD,
  COMMAND_GUARD_DEFAULT_TIMEOUT_MS,
  COMMAND_GUARD_MAX_THRESHOLD,
  COMMAND_GUARD_MAX_TIMEOUT_MS,
  COMMAND_GUARD_MIN_THRESHOLD,
  COMMAND_GUARD_MIN_TIMEOUT_MS,
  applyCommandGuard,
  type CommandGuardSettings,
} from './command-guard.ts'
import { runSystemOne } from './systemone.ts'
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
export { CommandCodeSearchProvider, COMMANDCODE_SEARCH_PROVIDER_ID, DEFAULT_WEB_SEARCH_PROVIDER_ID, applyCommandCodeSearchSelection, commandCodeSearchSelection, selectCommandCodeSearchProvider } from './web-search.ts'
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
   * Transport failures one request absorbs before the failure is surfaced;
   * defaults to 5. The route's retry policy is near-unbounded on purpose (1000
   * attempts, waits doubling to 15 minutes) because that shape is for the
   * failures a provider asks to have retried — an exhausted rate-limit window,
   * a gateway 520. A transport failure is not one of those: the first attempts
   * recover an ordinary blip (the default 5 retries are scheduled 0.5/1/2/4/8 s
   * after the failures before them, so ~15.5 s of grace), and after that the
   * wait is pure stall, so the retries are capped here. Raise it on a genuinely
   * flaky link; 0 surfaces every transport failure immediately.
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
  /**
   * Whether the Web sidebar shows the plans & quota card
   * (`sidebar.footer.action`). Defaults to false: the card is opt-in, so an
   * unset document renders no quota surface in the sidebar and mounts no
   * background usage poll for it. Only the sidebar entry is affected — the
   * dashboard cell behind it stays registered, it simply has no trigger until
   * the toggle is on. Read by the browser client; the adapter ignores it.
   */
  showSidebarQuota?: boolean
  /**
   * Whether the Command Code decision model (`typesafe/jev`) may auto-approve
   * shell commands that dsh was about to ask about. Defaults to FALSE: the
   * guard turns a model's opinion into a one-shot approval grant, so it is
   * opt-in, and the command text (plus the agent's own description of it) is
   * sent to Command Code to judge. Only commands a policy already wanted a
   * human to look at are ever judged, and only a confident "safe" verdict
   * (`commandGuardThreshold`) skips the prompt — every other outcome, including
   * any failure of the decision call itself, delegates to the normal approval
   * flow. See `./command-guard.ts`.
   */
  commandGuard?: boolean
  /**
   * Minimum probability of "safe" that lets the guard skip the approval prompt;
   * defaults to 0.9. Lowering it approves more, on less evidence.
   */
  commandGuardThreshold?: number
  /**
   * Milliseconds the guard waits for a decision before falling back to the
   * human prompt; defaults to 1500. This is a latency budget for an interactive
   * approval, not a request timeout — a decision that arrives late is useless,
   * because the user is staring at a prompt.
   */
  commandGuardTimeoutMs?: number
  /**
   * Whether requests enforce zero data retention: the provider then routes
   * them only through upstreams that keep no prompts/completions and never
   * train on them (its own opt-in, `CMD_ZDR=1` in the CLI / `x-cmd-zdr: 1` on
   * the Provider API). Defaults to FALSE: `zdr` changes WHERE a request is
   * served. Every chat request carries the header when enabled; a model with
   * no ZDR-capable upstream fails with 422 `cmd_zdr_no_providers` instead of
   * being routed through an upstream that retains data. ZDR capacity is
   * priced pass-through and usually costs more, and the price readout keeps
   * quoting the ordinary catalog rates (the real per-request price shows in
   * Command Code's Studio). The decision endpoint behind the command guard is
   * never ZDR-enforced — see `./systemone.ts`.
   */
  zdr?: boolean
  /**
   * Language override for the `/commandcode` Host-side command's user-facing
   * copy. Host commands cannot read the client's `ctx.locale`, so this is
   * the explicit knob: `'zh'` or `'en'`. Unset means the command reads
   * `LC_ALL`/`LANG` from the launching shell, falling back to `'zh'`. The
   * web settings page is unaffected — it follows the browser's language
   * preference on its own. Two surfaces, two independent locales. The
   * declared type is `string` (the schemastery `pattern` cannot narrow
   * literal types); an unknown value is treated as "unset" by
   * `pickCommandLocale`.
   */
  lang?: string
}

/**
 * The Config schema's fields, freshly built on every call.
 *
 * A FACTORY, not a shared dict, and that is load-bearing: the exported
 * {@link Config} marks every field volatile while {@link LegacySettingsSchema}
 * must carry no mark at all, and schemastery's schema instances are
 * single-purpose objects — sharing one dict would leak the marks into the
 * legacy registration (see `config-volatile.ts` for why that is a boot-time
 * `ValidationError` on ≤0.1.6 engines whose schemastery resolved to ≥3.18.3).
 *
 * @returns One fresh schema instance per Config field.
 */
function configFields() {
  return {
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    // `role('secret')` is load-bearing, not decoration: a literal key is the one
    // credential path this plugin cannot keep out of a settings document (the
    // page writes through the credentials seam instead), so the harness must
    // strip it from every descriptor read (`settings.describe()` runs with
    // `redactSecrets: true`). Without the role the literal rides back to the
    // browser verbatim — including on a remote-Host setup, where that is another
    // machine. Same declaration as the official providers' `apiKey` field.
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
    transportMaxRetries: z.number().min(0).max(MAX_TRANSPORT_MAX_RETRIES),
    filterModelsByPlan: z.boolean(),
    visibleModels: z.array(z.string()),
    /**
     * Per-model visibility overrides for the terminal settings page's checkbox
     * list, keyed by catalog id. dsh-TUI addresses a staged edit by its field
     * PATH, so two checkboxes sharing one path would overwrite each other's
     * draft and the section's last model would decide every write; a map gives
     * each checkbox a path of its own. An id listed here wins over
     * {@link Config.visibleModels}; ids absent here keep following it.
     */
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
    // The command guard. The probability bounds mirror
    // COMMAND_GUARD_MIN/MAX_THRESHOLD and the budget bounds mirror
    // COMMAND_GUARD_MIN/MAX_TIMEOUT_MS in `./command-guard.ts`; the client's
    // field specs mirror them again (the browser bundle cannot import that
    // node-side module), and `tests/command-guard.test.ts` pins the pair.
    commandGuard: z.boolean().default(false),
    commandGuardThreshold: z.number().min(COMMAND_GUARD_MIN_THRESHOLD).max(COMMAND_GUARD_MAX_THRESHOLD),
    commandGuardTimeoutMs: z.number().min(COMMAND_GUARD_MIN_TIMEOUT_MS).max(COMMAND_GUARD_MAX_TIMEOUT_MS),
    // Off by default: turning it on changes which upstream serves the request
    // (and usually what it costs), so nobody gets ZDR routing by accident.
    zdr: z.boolean().default(false),
    lang: z.string().pattern(/^(zh|en)$/).default('zh' as const),
  }
}

/**
 * The 0.1.7-generation schema: every field volatile except the
 * composition-only `apiKey` secret.
 *
 * dsh 0.1.7's settings forms are projected from the schema's `meta.volatile`
 * nodes, so an unmarked field would be invisible to AND unwritable from the
 * settings page and refused by form-edit path validation — and on that
 * generation the loader hands `apply()` a live reference per marked field,
 * committing later writes without remounting this fiber (the
 * `loader/volatile-update` listener at the bottom of `apply` covers the facts
 * that are not re-derived per read). The mark is inert on engines whose
 * schemastery predates `.volatile()`.
 */
export const Config: z<Config> = z.object(markVolatileFields(configFields(), ['apiKey']))

/**
 * The ≤0.1.6-generation registration schema: the same fields, NO volatile
 * marks.
 *
 * The legacy `installSection(owner, ns, schema, entry, hooks)` re-validates the
 * `entry` it is handed (`register()` → `resolve()` → `schema(mergeLayers(base,
 * section))`) and its `describe()` structuredClones that same `entry`. Since
 * schemastery ≥3.18.3 creates references at parse time on EVERY generation —
 * `dsh-settings` through 0.1.6 declares `schemastery: ^3.18.2`, so old engines
 * freshly installed today resolve 3.18.3 — a marked schema plus the raw
 * reference-carrying `config` is a boot-time `ValidationError` there. This
 * schema is therefore unmarked, and `apply` pairs it with
 * `unwrapVolatileConfig(config)`.
 */
export const LegacySettingsSchema: z<Config> = z.object(configFields()) as z<Config>

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
    // The connection carries the switch; the adapter enforces it on every
    // chat request rather than depending on a client-side coverage snapshot.
    zdr: config.zdr === true,
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

/**
 * The settings service faces this plugin adapts across generations, typed
 * structurally because the installed `@deepseek-ai/dsh-settings` .d.ts
 * describes only the generation it was built against — `installSection` through
 * 0.1.6, `configure` from 0.1.7 — so naming either method statically would not
 * compile against the other.
 */
interface SettingsServiceSeam {
  /** ≤0.1.6: register the section over the settings document. */
  installSection?(
    owner: Context,
    ns: string,
    schema: typeof Config,
    entry: Config,
    hooks: { setSource: (source: () => Config) => void; onChange: () => void },
  ): void
  /** ≥0.1.7: declare this instance's auto-form policy (a disposer). */
  configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
}

export function apply(ctx: Context, config: Config): void {
  installCostProjection(ctx)
  // The raw composition config as handed to `apply`. Everything downstream
  // reads through `current()`, which unwraps volatile references on every
  // call — so this closure is the ONLY place a stale plain snapshot can
  // hide, and on plain-config engines it hands back the same object
  // identity the options memo keys on.
  let source: () => Config = () => config
  const current = (): Config => unwrapVolatileConfig(source())
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
    probeWindow: (apiKey: string) => adapter.probeWindowLimits(apiKey),
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
    // Pre-stream account-scoped rejection: mark the rejected key when the
    // reason warrants it and hand the adapter the next account's key. When
    // every account is exhausted the pool throws the RATE_LIMIT /
    // INVALID_CREDENTIAL error that names the earliest reset — that error, not
    // the raw provider rejection, is what the caller sees.
    rotateApiKey: async (
      rejectedKey: string,
      rejection: AccountRotationReason,
      _connection: ResolvedCommandCodeOptions,
      model?: string,
      rotation?: { tried: readonly string[]; resetAtMs?: number },
    ): Promise<string | undefined> => {
      // Only the two account-health reasons become marks: an `unavailable`
      // rejection (no credits, a model outside this account's plan) says
      // nothing durable about the key, so the pool rotates past it without
      // remembering — a `:free` model is still served by a credits-empty
      // account. `rate-limit` (a window the provider named) and `throttled` (a
      // 429 that named none) both mark, but with different causes, so the
      // pool's own diagnosis never reports a plain throttle as an exhausted
      // usage window (issue #54). The provider's own `resetAtMs`, when the body
      // carried one, turns the rate-limit mark into a cooldown that expires by
      // itself.
      if (rejection !== 'unavailable') pool.markRejected(rejectedKey, rejection, rotation?.resetAtMs)
      // The whole tried set, not just the rejected key, reaches the pool: a
      // rejection that does not mark the key would otherwise be re-offered on
      // every attempt and a four-account pool could never reach the accounts
      // behind it. The model rides along so model-routing rules pick the next
      // account for the same model. An EMPTY set must not be forwarded — the
      // pool reads it as "nothing was tried" and drops the filter this set
      // exists for, so it falls back to the rejected key like a missing one.
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
    // rotation moved between them (and hid models the other accounts could
    // run). Read live, so adding or removing an account applies to the next
    // picker load.
    resolveAccountKeys: async (): Promise<readonly string[]> => {
      const accounts = await pool.resolvedAccounts()
      return accounts.map((account) => account.key)
    },
  })
  // The Models page card: a configurable provider with a settings address.
  // settingsPath [] means the whole `llm-commandcode` section configures it.
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Command Code', settingsNs: NS, settingsPath: [] },
  ])
  // The live route: this is what makes models requestable under `commandcode`.
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Bounded retry for TRANSPORT failures (issue #39, second report). The route
  // policy is near-unbounded on purpose (see `providerRetryPolicy`), because
  // an exhausted rate-limit window or a gateway 520 is a failure that ASKS to
  // be retried — but a connection that cannot be established is not, and at the
  // long-context sizes this plugin serves the unbounded cadence turned a
  // 10-second TCP connect timeout into an ~8-minute stall (the reporter's
  // 11/1000 row, whose "482s" is the wait before the 11th attempt). So the
  // first few transport failures are absorbed here and the rest surface with a
  // diagnosis. `dsh-llm-retry` keeps its window for every other code.
  //
  // The failure is surfaced by THROWING out of the waterfall: the agent loop
  // wraps the rejection into the turn's error, so the retry chain stops here.
  // The failure's own message is carried in the thrown message (the loop may
  // re-wrap with the original), and the diagnostic also goes to the log, which
  // nothing can rewrite.
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
  // service, so its language is resolved here from `Config.lang` (explicit
  // override) and the launching shell's `LC_ALL`/`LANG` (inferred default);
  // resolved per invocation so a settings change reaches the next command
  // run without a restart.
  const commandLocale = (): LocaleId => pickCommandLocale(current().lang)
  ctx.inject(['commands'], (commandCtx) => {
    applyCommands(commandCtx, { adapter, reports: usageReports, getLocale: commandLocale })
  })

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

  // The command guard's live settings. Declared BEFORE the inject below
  // because an inject callback can run synchronously (when the seam is already
  // mounted) and a `const` declared after it would be a temporal-dead-zone
  // throw. Every fact is re-read per ask, so a settings write lands on the very
  // next approval.
  const commandGuardSettings = (): CommandGuardSettings => {
    const raw = current()
    return {
      enabled: raw.commandGuard === true,
      threshold: raw.commandGuardThreshold ?? COMMAND_GUARD_DEFAULT_THRESHOLD,
      timeoutMs: raw.commandGuardTimeoutMs ?? COMMAND_GUARD_DEFAULT_TIMEOUT_MS,
    }
  }

  // The command guard: an AI second opinion in front of the human approval
  // prompt. dsh's approval seam is an optional service, and the guard is only
  // meaningful where it exists (no approval service means no asks to answer at
  // all), so the listeners ride `ctx.inject(['approval'], …)` exactly like
  // `web` and `tuiSettingsSections`: a profile without the seam never activates
  // this fiber, and an engine that predates the service stays inert.
  //
  // The decision endpoint uses the plugin's ordinary credential chain and base
  // URL — no separate key — and every failure inside it delegates to the human
  // (`./command-guard.ts` documents the ladder).
  ctx.inject(['approval'], (approvalCtx) => {
    applyCommandGuard(approvalCtx, {
      settings: commandGuardSettings,
      decide: (request, decideOptions) => runSystemOne(
        {
          apiBase: () => options().apiBase,
          resolveApiKey: () => resolveApiKey(options()),
        },
        request,
        decideOptions,
      ),
      log: (message) => {
        ctx.logger.info(`llm-commandcode: ${message}`)
      },
    })
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

  // Settings became an optional service in dsh 0.1.2 and was REWRITTEN in
  // 0.1.7 (the settings.yaml document became schema-derived profile Config
  // forms; `installSection` no longer exists there), so the registration is
  // chosen by capability rather than by version:
  //   ≤0.1.6  `installSection` registers the `llm-commandcode` section over
  //           the settings document, hands `current` the merged reader via
  //           `setSource`, and calls `onChange` after every write — the
  //           `webSearch` toggle reaches the web seam's next search without
  //           a restart (the tracked selection remembers the displaced
  //           backend, issue #26, so flipping the toggle is a handoff), and
  //           the dsh-TUI section refreshes its key field and account
  //           selector, which are frozen into the declaration the host
  //           renders (a no-op unless one of those facts actually moved, so
  //           ordinary writes never churn the screen);
  //   ≥0.1.7  `configure({ auto: false })` declares that this plugin ships
  //           its own page (so SettingsForms publishes no auto-generated form
  //           for this entry), config IS the live source, and the
  //           `loader/volatile-update` listener below replaces `onChange`.
  // Profiles without a settings service continue to use the composition
  // entry captured by `source` above. The legacy branch also keeps our
  // namespace in ≤0.1.6's describe directory — that generation's wire only
  // lists installSection REGISTRATIONS, so dropping it would blank the
  // settings page on every old engine.
  //
  // The 0.1.7 one-time settings.yaml import needs no cooperation from here:
  // the section id and the profile entry id are the SAME string
  // (`llm-commandcode`), which is exactly the identity the engine's
  // `importLegacyDocument` looks the entry up by.
  ctx.inject(['settings'], (settingsCtx) => {
    const service = settingsCtx.settings as unknown as SettingsServiceSeam
    if (typeof service.installSection === 'function') {
      // The legacy registration gets the UNMARKED schema and an UNWRAPPED base.
      // schemastery ≥3.18.3 turns marked fields into frozen `{ get() }`
      // references at parse time on every generation (dsh-settings ≤0.1.6
      // declares `schemastery: ^3.18.2`, so a freshly installed old engine
      // resolves 3.18.3), and this generation re-validates the base it is
      // handed (`register()` → `resolve()` → `schema(base)`) before cloning it
      // for the directory. Marked schema + raw config therefore throws
      // `ValidationError: expected boolean but got [object Object]` AT BOOT —
      // see `config-volatile.ts` for the full chain.
      service.installSection(ctx, NS, LegacySettingsSchema, unwrapVolatileConfig(config), {
        setSource: (next) => {
          source = next
        },
        onChange: () => {
          applySearchSelection(current().webSearch ?? true)
          refreshTuiSettings?.()
        },
      })
      return
    }
    if (typeof service.configure === 'function') {
      settingsCtx.effect(() => {
        const dispose = service.configure?.({ auto: false }, ctx.fiber)
        return () => {
          dispose?.()
        }
      }, 'dsh-commandcode-provider: settings auto-form policy')
    }
  })

  // dsh 0.1.7's loader commits volatile config IN PLACE — no remount — and
  // notifies the OWNING fiber (`loader/volatile-update`, every value already
  // committed before dispatch). The facts that are not re-derived from
  // `current()` per use re-apply here: the web seam's selection (its private
  // field is written, not read back from config) and the TUI section (its
  // option lists are frozen into the declaration). On ≤0.1.6 the same body
  // runs from installSection's `onChange` above; older loaders simply never
  // emit this event, so registering it unconditionally is harmless. Typed
  // structurally because the event is declared by `cordis-plugin-loader`,
  // which is not a peer of this bundle.
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
