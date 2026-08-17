/**
 * dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
 * Code (unofficial; ported from pi-commandcode-provider@0.5.1).
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

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CommandCodeAdapter, DEFAULT_API_BASE, resolveAuthFileApiKey } from './adapter.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './adapter.ts'
import type { CommandCodeConnectionOptions } from './adapter.ts'
import { applyCommands } from './commands.ts'

export {
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_GENERATE_MAX_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  CommandCodeAdapter,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_THINKING_MODELS,
  KNOWN_PLANS,
  KNOWN_DEALS,
  KNOWN_PEAK_PRICING,
  PLAN_LABELS,
  PLAN_ORDER,
  capabilityDescription,
  compareByPlan,
  dealLabel,
  formatContext,
  peakPricingLabel,
  peakPricingState,
  planLabel,
  projectSlugFromPath,
  resolveAuthFileApiKey,
} from './adapter.ts'
export type { CommandCodeAdapterDeps, CommandCodeConnectionOptions, CommandCodeUsageReport, ResolveAttachments } from './adapter.ts'
export { applyCommands, commandDefinition } from './commands.ts'
export type { CommandCodeCommandDeps } from './commands.ts'

export const name = 'llm-commandcode'
export const inject = ['llm']

const NS = settingsNamespace('llm-commandcode')
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
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  apiKey: z.string(),
  apiBase: z.string(),
  workingDir: z.string(),
  modelsCachePath: z.string(),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
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
  }
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

  const resolveApiKey = async (connection: ResolvedCommandCodeOptions): Promise<string> => {
    // 1. A literal key in composition config wins outright.
    const literal = current().apiKey
    if (literal) return assertUsableApiKey(literal, 'llm-commandcode', 'config.apiKey')
    // 2. The credential seam (web Models page) or the trusted environment.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-commandcode', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-commandcode', ref)
      }
    }
    // 3. Last resort: reuse the official Command Code CLI login (~/.commandcode/auth.json).
    const authFileKey = resolveAuthFileApiKey()
    if (authFileKey) return assertUsableApiKey(authFileKey, 'llm-commandcode', '~/.commandcode/auth.json')
    throw new LlmError(
      `llm-commandcode: no API key for provider route "${PROVIDER}"; store ${ref} through the`
      + ' credentials service (the web Models page writes it), export it in the launching'
      + ' environment, set config.apiKey, or run `command-code login` to write'
      + ' ~/.commandcode/auth.json',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CommandCodeAdapter({
    options,
    resolveApiKey,
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

  // The /commandcode usage command rides the optional `commands` service: a
  // child fiber injects it, so it registers whenever the profile mounts
  // dsh-commands and the fiber simply never activates when it does not.
  ctx.inject(['commands'], (commandCtx) => {
    applyCommands(commandCtx, { adapter })
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // Everything the adapter reads is resolved per request, so a settings
    // change needs no registration-level action.
    onChange: () => {},
  })
}
