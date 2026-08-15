/**
 * DeepSeek Harness LLM adapter for the Command Code Provider API.
 *
 * Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
 * community-maintained integration; you need your own Command Code account
 * and API key or subscription, and Command Code's terms apply.
 *
 * Wire protocol (reverse-engineered by the pi plugin, command-code@1.26.0):
 *   POST {apiBase}/alpha/generate
 *   body: { config, memory, taste, skills, params: { model, messages, tools,
 *          system, max_tokens, temperature, stream, reasoning_effort? }, threadId }
 *   SSE-ish JSONL events: text-delta | reasoning-start/delta/end | tool-call
 *                         | tool-result | finish | error
 *   Model catalog: GET {apiBase}/provider/v1/models -> { object: 'list', data: [...] }
 *
 * The adapter is deliberately free of cordis/schemastery: it receives a
 * per-request options thunk and an API-key resolver from the plugin entry
 * (src/index.ts), so a settings change reaches the very next request.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  attributionHeaders,
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// Static capability snapshot (from the official command-code@1.26.0 bundled
// model catalog, dist/cli.mjs). The Provider API does not expose reasoning
// metadata; models omitted here let Command Code choose their reasoning
// depth, matching the official CLI.
// ---------------------------------------------------------------------------

export const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
}

export const COMMAND_CODE_CLI_VERSION = '1.26.0'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const DEFAULT_GENERATE_MAX_TOKENS = 64_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const MODELS_TIMEOUT_MS = 10_000
const MODEL_CACHE_VERSION = 1

// ---------------------------------------------------------------------------
// Small helpers (ported from converters.ts / models.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Credential fallback from the official Command Code CLI auth file. Used as
// the last fallback by the plugin entry, so a user who already logged in with
// `command-code login` can reuse that credential. Only the official CLI's own
// file is read — pi/OMP auth files are intentionally not scanned, so their
// credentials and formats cannot surprise this adapter.
// ---------------------------------------------------------------------------

/** Extract the key from the CLI's nested credential records (`command-code`). */
function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === 'api') return stringValue(value.key)
  if (type === 'oauth') return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/** Read a usable Command Code credential from the official CLI auth file. */
export function resolveAuthFileApiKey(): string | undefined {
  const authPath = join(homedir(), '.commandcode', 'auth.json')
  try {
    if (!existsSync(authPath)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (!isRecord(parsed)) return undefined
    const direct = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode)
    if (direct) return direct
    const nested =
      apiKeyFromCredentialRecord(parsed.commandcode) ??
      apiKeyFromCredentialRecord(parsed['command-code'])
    return nested
  } catch {
    // Ignore malformed or unreadable auth file.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Model catalog discovery with on-disk cache fallback (ported from models.ts)
// ---------------------------------------------------------------------------

interface CommandCodeModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

function parseCatalogResponse(value: unknown): CommandCodeModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new LlmError('Unexpected Command Code models response shape', 'PROVIDER_PROTOCOL_ERROR')
  }
  const models: CommandCodeModel[] = []
  for (const entry of value.data) {
    if (!isRecord(entry)) continue
    const id = stringValue(entry.id)
    const name = stringValue(entry.name)
    const contextLength = numberValue(entry.context_length)
    if (!id || !name || !contextLength || contextLength <= 0) continue
    models.push({
      id,
      name,
      contextWindow: contextLength,
      maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
    })
  }
  if (models.length === 0) {
    throw new LlmError('Command Code returned an empty model catalog', 'PROVIDER_PROTOCOL_ERROR')
  }
  return models
}

async function readModelsCache(cachePath: string): Promise<CommandCodeModel[]> {
  const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf-8'))
  if (!isRecord(parsed) || parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid model cache at ${cachePath}`)
  }
  return parsed.models as CommandCodeModel[]
}

async function writeModelsCache(cachePath: string, models: CommandCodeModel[]): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const tmp = `${cachePath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    await rename(tmp, cachePath)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Message conversion: harness Message[] -> Command Code wire messages.
// Reasoning blocks are intentionally NOT replayed (matches the pi plugin and
// the official CLI: prior private reasoning must not leak into later turns).
// Only tool calls with a paired tool result are replayed.
// ---------------------------------------------------------------------------

function pairedToolCallIds(messages: readonly Message[]): Set<string> {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call') callIds.add(block.id)
      if (block.type === 'tool-result') resultIds.add(block.toolCallId)
    }
  }
  return new Set([...callIds].filter((id) => resultIds.has(id)))
}

function blockText(block: ContentBlock): string {
  return block.type === 'text' || block.type === 'reasoning' ? block.text : ''
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool-result' }>): string {
  return block.content.map(blockText).filter(Boolean).join('\n')
}

function hasImageContent(message: Message): boolean {
  const check = (blocks: readonly ContentBlock[]): boolean =>
    blocks.some(
      (b) => b.type === 'image' || (b.type === 'tool-result' && check(b.content)),
    )
  return check(message.content)
}

function messagesToCC(messages: readonly Message[]): unknown[] {
  const out: unknown[] = []
  const paired = pairedToolCallIds(messages)

  for (const message of messages) {
    if (message.role === 'system') continue // folded into params.system by the caller

    if (message.role === 'user' && message.source.kind !== 'tool') {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        if (block.type === 'image') {
          // ImageBlock carries an attachment ref owned by the attachment
          // service; resolving it to bytes requires that service. Fail loudly
          // instead of silently dropping (adapter contract).
          throw new LlmError(
            'Image input is not wired to the attachment service in this adapter yet',
            'UNSUPPORTED_CONTENT',
          )
        }
      }
      out.push({ role: 'user', content: parts })
      continue
    }

    if (message.role === 'assistant') {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool-call' && paired.has(block.id)) {
          parts.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: recordOrEmpty(block.arguments),
          })
        }
        // reasoning blocks: skipped by design (see header comment)
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }

    // tool-result message (user role, single tool-result block)
    if (message.role === 'user' && message.source.kind === 'tool') {
      const block = message.content[0]
      if (!block || block.type !== 'tool-result' || !paired.has(block.toolCallId)) continue
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: block.toolCallId,
            toolName: '',
            output: block.isError
              ? { type: 'error-text', value: toolResultText(block) }
              : { type: 'text', value: toolResultText(block) },
          },
        ],
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Connection facts resolved fresh per request by the plugin entry. */
export interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/models`). */
  apiBase: string
  /** Working directory reported to the API (project slug, config block). */
  workingDir: string
  /** Model catalog cache path. */
  modelsCachePath: string
}

/** Everything the adapter needs beyond the request itself. */
export interface CommandCodeAdapterDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** Resolve the current connection facts (fresh per request, settings-aware). */
  options: () => C
  /** Resolve a usable API key for the given connection facts, or throw `MISSING_CREDENTIAL`. */
  resolveApiKey: (connection: C) => Promise<string>
  /** HTTP transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Account identity from `/alpha/whoami`. */
export interface CommandCodeAccount {
  id: string
  name: string
  userName: string
}

/** Usage summary from `/alpha/usage/summary`. */
export interface CommandCodeUsage {
  totalCount: number
  totalCost: number
  successRate: number
  completedCount: number
  failedCount: number
  totalTokensIn: number
  totalTokensOut: number
  totalCredits: number
  periodBasis: string
}

/** Credit/limit state from `/alpha/billing/credits`. */
export interface CommandCodeCredits {
  monthlyCredits: number
  purchasedCredits: number
  freeCredits: number
  /** Five-hour rolling window limits. */
  fiveHour: { used: number; cap: number; exceeded: boolean; resetAt: number }
  /** Weekly window limits. */
  weekly: { used: number; cap: number; exceeded: boolean; resetAt: number }
}

/** Everything the usage endpoints report, fetched together. */
export interface CommandCodeUsageReport {
  account?: CommandCodeAccount
  usage?: CommandCodeUsage
  credits?: CommandCodeCredits
  /** Endpoint failures degrade the report instead of failing it. */
  failures: string[]
}

export class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private catalog: CommandCodeModel[] = []
  private readonly fetchImpl: typeof fetch

  constructor(private readonly deps: CommandCodeAdapterDeps<C>) {
    super()
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /**
   * Command Code is a metered subscription API: 429 (rate limit) and 5xx
   * (transient server errors) are worth retrying at the agent-step boundary,
   * which is where dsh-llm-retry executes the policy returned here. The
   * default policy already retries `RATE_LIMIT` and `SERVER`; declaring it
   * explicitly documents the intent and gives the plugin entry a stable hook
   * to override (e.g. a stricter cap for a metered plan).
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(undefined, 'llm-commandcode: retryPolicy')
  }

  /** Refresh the catalog (live fetch, cache fallback) and return it. */
  private async loadCatalog(signal?: AbortSignal): Promise<CommandCodeModel[]> {
    const { apiBase, modelsCachePath } = this.deps.options()
    try {
      const response = await this.fetchImpl(`${apiBase}/provider/v1/models`, {
        headers: { accept: 'application/json', ...attributionHeaders() },
        signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`models endpoint returned ${response.status}`)
      }
      this.catalog = parseCatalogResponse(await response.json())
      await writeModelsCache(modelsCachePath, this.catalog).catch(() => undefined)
    } catch (error) {
      if (signal?.aborted) throw error
      // A catalog refresh failure is a degradation, not a request failure:
      // fall back to the last successful catalog on disk (or the in-memory
      // one from an earlier successful load). The adapter still serves any
      // model the user names; only the advisory selector loses entries.
      this.catalog = await readModelsCache(modelsCachePath).catch(() => this.catalog)
    }
    return this.catalog
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.loadCatalog()
    return catalog.map((model) => ({
      provider,
      id: model.id,
      name: `${model.name} (CC)`,
      inputModalities: ['text' as const],
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry =
      this.catalog.find((m) => m.id === model) ??
      (await this.loadCatalog(signal)).find((m) => m.id === model)

    const efforts = KNOWN_EFFORTS[model]
    return {
      provider,
      id: model,
      name: entry ? `${entry.name} (CC)` : model,
      inputModalities: ['text' as const],
      ...(entry
        ? {
            context: { contextWindow: entry.contextWindow },
            defaultMaxTokens: Math.min(entry.maxTokens, DEFAULT_GENERATE_MAX_TOKENS),
          }
        : {}),
      // Omit `reasoning` entirely for models without known effort support:
      // the harness then treats the model as having no selectable efforts.
      ...(efforts
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({
                id: ReasoningEffortId(effort),
                name: effort,
              })),
            },
          }
        : {}),
    }
  }

  /**
   * Fetch account, usage, and credit state from the Command Code account
   * endpoints (`/alpha/whoami`, `/alpha/usage/summary`, `/alpha/billing/credits`).
   * Each endpoint degrades independently: a failed one lands in `failures`
   * while the rest still report, so a transient outage never blanks the whole
   * view. Requires a usable API key (throws `MISSING_CREDENTIAL` otherwise).
   */
  async getUsage(): Promise<CommandCodeUsageReport> {
    const connection = this.deps.options()
    const apiKey = await this.deps.resolveApiKey(connection)
    const base = connection.apiBase
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'x-command-code-version': COMMAND_CODE_CLI_VERSION,
      'x-cli-environment': 'production',
      ...attributionHeaders(),
    }
    const failures: string[] = []

    const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const response = await this.fetchImpl(`${base}${path}`, { headers })
        if (!response.ok) {
          failures.push(`${path}: HTTP ${response.status}`)
          return undefined
        }
        const parsed: unknown = await response.json()
        return isRecord(parsed) ? parsed : undefined
      } catch (error: unknown) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    const report: CommandCodeUsageReport = { failures }

    // whoami -> account identity.
    const whoami = await getJson('/alpha/whoami')
    const whoamiData = whoami && isRecord(whoami.user) ? whoami.user : undefined
    if (whoamiData) {
      report.account = {
        id: stringValue(whoamiData.id) ?? '',
        name: stringValue(whoamiData.name) ?? '',
        userName: stringValue(whoamiData.userName) ?? '',
      }
    }

    // usage/summary -> totals.
    const usage = await getJson('/alpha/usage/summary')
    if (usage) {
      report.usage = {
        totalCount: numberValue(usage.totalCount) ?? 0,
        totalCost: numberValue(usage.totalCost) ?? 0,
        successRate: numberValue(usage.successRate) ?? 0,
        completedCount: numberValue(usage.completedCount) ?? 0,
        failedCount: numberValue(usage.failedCount) ?? 0,
        totalTokensIn: numberValue(usage.totalTokensIn) ?? 0,
        totalTokensOut: numberValue(usage.totalTokensOut) ?? 0,
        totalCredits: numberValue(usage.totalCredits) ?? 0,
        periodBasis: stringValue(usage.periodBasis) ?? 'billing-period',
      }
    }

    // billing/credits -> credit + window limits.
    const credits = await getJson('/alpha/billing/credits')
    const creditsData = credits && isRecord(credits.credits) ? credits.credits : undefined
    const windowLimits = credits && isRecord(credits.windowLimits) ? credits.windowLimits : undefined
    const fiveHour = windowLimits && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined
    const weekly = windowLimits && isRecord(windowLimits.weekly) ? windowLimits.weekly : undefined
    if (creditsData || fiveHour || weekly) {
      report.credits = {
        monthlyCredits: numberValue(creditsData?.monthlyCredits) ?? 0,
        purchasedCredits: numberValue(creditsData?.purchasedCredits) ?? 0,
        freeCredits: numberValue(creditsData?.freeCredits) ?? 0,
        fiveHour: {
          used: numberValue(fiveHour?.used) ?? 0,
          cap: numberValue(fiveHour?.cap) ?? 0,
          exceeded: fiveHour?.exceeded === true,
          resetAt: numberValue(fiveHour?.resetAt) ?? 0,
        },
        weekly: {
          used: numberValue(weekly?.used) ?? 0,
          cap: numberValue(weekly?.cap) ?? 0,
          exceeded: weekly?.exceeded === true,
          resetAt: numberValue(weekly?.resetAt) ?? 0,
        },
      }
    }

    return report
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop?.length) {
      // The Command Code wire format has no documented stop field; refuse
      // loudly instead of silently dropping a request field.
      throw new LlmError('Command Code adapter does not support stop sequences', 'UNSUPPORTED_OPTION')
    }
    if (options.messages.some(hasImageContent)) {
      throw new LlmError(
        'Image input is not wired to the attachment service in this adapter yet',
        'UNSUPPORTED_CONTENT',
      )
    }

    const connection = this.deps.options()
    const apiKey = await this.deps.resolveApiKey(connection)
    const entry = this.catalog.find((m) => m.id === options.model)
    const modelMax = entry?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    const maxTokens = Math.min(
      options.maxTokens ?? modelMax,
      modelMax,
      DEFAULT_GENERATE_MAX_TOKENS,
    )

    const effort = options.reasoningEffort as string | undefined
    const supported = KNOWN_EFFORTS[options.model]
    const reasoningEffort =
      effort && effort !== 'off' && supported?.includes(effort) ? effort : undefined

    const systemText = [
      options.system ?? '',
      ...options.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content.map(blockText).filter(Boolean).join('\n')),
    ]
      .filter(Boolean)
      .join('\n\n')

    const body = {
      config: {
        workingDir: connection.workingDir,
        date: new Date().toISOString().split('T')[0],
        environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
        structure: [],
        isGitRepo: false,
        currentBranch: '',
        mainBranch: '',
        gitStatus: '',
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      params: {
        model: options.model,
        messages: messagesToCC(options.messages),
        tools: (options.tools ?? []).map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        system: systemText,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${connection.apiBase}/alpha/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'x-command-code-version': COMMAND_CODE_CLI_VERSION,
          'x-cli-environment': 'production',
          'x-project-slug': projectSlugFromPath(connection.workingDir),
          'x-taste-learning': 'true',
          'x-co-flag': 'false',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error: unknown) {
      // Caller cancellation must propagate as-is, not be relabeled.
      if (options.signal?.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy, reset) in a bare `TypeError: fetch failed` whose actionable
      // detail lives on `cause`. Wrapping with the endpoint and chaining the
      // cause lets `errorChain` render the full diagnosis at every reporting
      // boundary, and gives the retry policy a stable `TRANSPORT` code.
      throw new LlmError(
        `Command Code API request to ${connection.apiBase}/alpha/generate failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      // Command Code folds several business rejections into 403 (plan limits,
      // CLI version, model access). Prefer the machine-readable `error.code`
      // when present; the status alone cannot distinguish them.
      let providerCode: string | undefined
      try {
        const parsed: unknown = JSON.parse(errText)
        if (isRecord(parsed) && isRecord(parsed.error)) {
          providerCode = stringValue(parsed.error.code)
        }
      } catch {
        // Plain-text bodies: rely on the status mapping below.
      }
      const detail = providerCode ?? `HTTP ${response.status}`
      if (response.status === 401) {
        // An invalid or missing credential is a config problem, not a
        // transport failure: retrying it identically cannot succeed.
        throw new LlmError(
          `Command Code API error 401 (${detail}): the API key is missing or invalid — check the`
          + ' key stored for COMMANDCODE_API_KEY (Models page) or the auth file',
          'INVALID_CREDENTIAL',
          { status: 401 },
        )
      }
      throw new LlmError(
        `Command Code API error ${response.status}${detail === `HTTP ${response.status}` ? '' : ` (${detail})`}: ${errText.slice(0, 500)}`,
        response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_HTTP_ERROR',
        { status: response.status },
      )
    }
    if (!response.body) {
      throw new LlmError('Command Code API returned no response body', 'PROVIDER_PROTOCOL_ERROR')
    }

    // --- SSE/JSONL event stream -> harness StreamChunk protocol ---
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Block assembly state: at most one text block and one reasoning block
    // are open at a time (same assumption as the pi plugin).
    let nextIndex = 0
    let textIndex = -1
    let textContent = ''
    let reasoningIndex = -1
    let reasoningContent = ''
    let sawContent = false

    const closeText = function* (): Generator<StreamChunk> {
      if (textIndex < 0) return
      yield {
        type: 'block-end',
        index: textIndex,
        block: { type: 'text', text: textContent },
      }
      textIndex = -1
      textContent = ''
    }
    const closeReasoning = function* (): Generator<StreamChunk> {
      if (reasoningIndex < 0) return
      yield {
        type: 'block-end',
        index: reasoningIndex,
        block: { type: 'reasoning', text: reasoningContent },
      }
      reasoningIndex = -1
      reasoningContent = ''
    }

    const handleEvent = (event: unknown): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      if (!isRecord(event)) return chunks

      switch (event.type) {
        case 'text-delta': {
          chunks.push(...closeReasoning())
          if (textIndex < 0) {
            textIndex = nextIndex++
            chunks.push({ type: 'block-start', index: textIndex, blockType: 'text' })
          }
          const delta = stringValue(event.text) ?? ''
          textContent += delta
          sawContent = true
          chunks.push({ type: 'text-delta', index: textIndex, text: delta })
          break
        }
        case 'reasoning-delta': {
          chunks.push(...closeText())
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++
            chunks.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
          }
          const delta = stringValue(event.text) ?? ''
          reasoningContent += delta
          chunks.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta })
          break
        }
        case 'reasoning-start':
          chunks.push(...closeText())
          break
        case 'reasoning-end':
          chunks.push(...closeReasoning())
          break
        case 'tool-call': {
          chunks.push(...closeText(), ...closeReasoning())
          const id = stringValue(event.toolCallId) ?? randomUUID()
          const name = stringValue(event.toolName) ?? ''
          const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments))
          const index = nextIndex++
          sawContent = true
          chunks.push(
            { type: 'block-start', index, blockType: 'tool-call' },
            { type: 'tool-call-delta', index, id: CallId(id), name, argumentsDelta: args },
            {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id: CallId(id), name, arguments: args },
            },
          )
          break
        }
        case 'finish': {
          chunks.push(...closeText(), ...closeReasoning())
          const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
          if (usage) {
            const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
            const totalInput = numberValue(usage.inputTokens) ?? 0
            const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
            const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
            // Harness TokenUsage counts are disjoint: uncached input only.
            const tokenUsage: TokenUsage = {
              inputTokens:
                numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
              outputTokens: numberValue(usage.outputTokens) ?? 0,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
            }
            chunks.push({ type: 'usage', usage: tokenUsage })
          }
          chunks.push({ type: 'finish', reason: mapFinishReason(event.finishReason) })
          break
        }
        case 'error': {
          const detail = isRecord(event.error)
            ? (stringValue(event.error.message) ?? JSON.stringify(event.error))
            : (stringValue(event.error) ?? stringValue(event.message) ?? 'Stream error')
          throw new LlmError(`Command Code stream error: ${detail}`, 'PROVIDER_STREAM_ERROR')
        }
      }
      return chunks
    }

    try {
      let finished = false
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>
        try {
          read = await reader.read()
        } catch (error: unknown) {
          // A mid-stream transport failure (connection reset, TLS teardown)
          // surfaces here. Caller cancellation propagates as-is; anything
          // else is a transport failure with a stable code.
          if (options.signal?.aborted) throw error
          throw new LlmError(
            `Command Code API stream from ${connection.apiBase} failed while reading`,
            'TRANSPORT',
            { cause: error },
          )
        }
        const { done, value } = read
        if (done) {
          if (buffer.trim()) for (const chunk of handleEvent(parseStreamEventLine(buffer))) yield chunk
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const chunks = handleEvent(parseStreamEventLine(line))
          for (const chunk of chunks) {
            yield chunk
            if (chunk.type === 'finish') finished = true
          }
        }
        if (finished) break
      }
      if (!finished) {
        // Stream ended without a finish event: close open blocks and
        // terminate according to the adapter contract (usage, then finish).
        yield* closeText()
        yield* closeReasoning()
        if (!sawContent) {
          throw new LlmError('Command Code returned an empty response', 'EMPTY_RESPONSE')
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

function mapFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool-calls') return { kind: 'tool-calls' }
  if (
    reason === 'length' ||
    reason === 'max_tokens' ||
    reason === 'max-tokens' ||
    reason === 'max_output_tokens'
  ) {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}
