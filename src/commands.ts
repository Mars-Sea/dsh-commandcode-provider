/**
 * `/commandcode` slash command — read-only provider diagnostics.
 *
 * Three subcommands (one registered command, parsed in the handler):
 *
 *   /commandcode status          credential + catalog + config summary
 *   /commandcode models [query]  list/search the live model catalog
 *   /commandcode check <model>   is this model usable on the current plan?
 *
 * Command Code exposes no account/usage API (every `/provider/v1/*` account
 * or usage path returns 404), so everything here answers from the model
 * catalog, the local credential state, and one cheap probe request.
 *
 * @module dsh-commandcode-provider/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { CommandCodeAdapter, KNOWN_EFFORTS } from './adapter.ts'
import type { CommandCodeConnectionOptions } from './adapter.ts'
/** Everything the command needs beyond the adapter itself. */
export interface CommandCodeCommandDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for listModels / stream). */
  adapter: CommandCodeAdapter<C>
  /** Current connection facts. */
  options: () => C
  /** Resolve the effective API key, or undefined when none exists anywhere. */
  resolveApiKey: (connection: C) => Promise<string | undefined>
}

const MAX_STATUS_MODELS = 8
const MAX_MODELS_LIST = 30

/** Render a bounded list of model ids. */
function renderModels(ids: readonly string[], max: number): string {
  if (ids.length === 0) return '  (no models)'
  const shown = ids.slice(0, max)
  const more = ids.length > max ? `\n  … and ${ids.length - max} more` : ''
  return `\n${shown.map((id) => `  - ${id}`).join('\n')}${more}`
}

/**
 * Probe one model with a 4-token request. A `MODEL_NOT_IN_PLAN` error means
 * the model exists but is outside the current plan; a 401 means the key is
 * rejected; anything else that reaches the API still proves reachability.
 */
async function probeModel<C extends CommandCodeConnectionOptions>(
  adapter: CommandCodeAdapter<C>,
  model: string,
): Promise<string> {
  try {
    const stream = adapter.stream({
      provider: 'commandcode',
      model,
      messages: [{
        id: MessageId('cc-probe'),
        role: 'user',
        content: [{ type: 'text', text: 'Reply: OK' }],
        source: { kind: 'user' },
      }],
      maxTokens: 4,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'finish') return 'usable'
    }
    return 'usable'
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const plan = /MODEL_NOT_IN_PLAN/.exec(message)
    if (plan) return 'not in your plan (MODEL_NOT_IN_PLAN)'
    if (/401|INVALID_CREDENTIAL|UNAUTHORIZED/.test(message)) return 'credential rejected (401)'
    return `reachable, but the probe failed (${message.slice(0, 60)})`
  }
}

/** Parse `/commandcode <subcommand> <args>`. */
function parseSubcommand(args: string): { sub: string; rest: string } {
  const trimmed = args.trim()
  const match = /^([a-z]+)(?:\s+(.*))?$/.exec(trimmed)
  if (match === null) return { sub: '', rest: trimmed }
  return { sub: match[1]!, rest: match[2]?.trim() ?? '' }
}

/** The one registered `/commandcode` command. */
export function commandDefinition<C extends CommandCodeConnectionOptions>(
  deps: CommandCodeCommandDeps<C>,
): CommandDefinition {
  const { adapter, options, resolveApiKey } = deps

  return {
    name: 'commandcode',
    description: 'Command Code provider diagnostics: status, models, check',
    input: { hint: 'status | models [query] | check <model>' },
    handler: async (invocation) => {
      const { sub, rest } = parseSubcommand(invocation.rawInput)

      // ---- status ---------------------------------------------------------
      if (sub === '' || sub === 'status') {
        const connection = options()
        const key = await resolveApiKey(connection)
        const keyLabel = key === undefined
          ? 'MISSING (store COMMANDCODE_API_KEY via the Models page, or run `command-code login`)'
          : 'configured'
        const catalog = await adapter.listModels('commandcode')
        return {
          kind: 'success',
          text: [
            'Command Code provider status',
            `  provider: commandcode`,
            `  api base: ${connection.apiBase}`,
            `  api key: ${keyLabel}`,
            `  models: ${catalog.length} (live or cached)`,
            renderModels(catalog.map((m) => m.id), MAX_STATUS_MODELS),
            '',
            'Try: /commandcode models <query> · /commandcode check <model>',
          ].join('\n'),
        }
      }

      // ---- models ---------------------------------------------------------
      if (sub === 'models') {
        const query = rest.toLowerCase()
        const catalog = await adapter.listModels('commandcode')
        const matches = query.length === 0
          ? catalog
          : catalog.filter(
            (m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query),
          )
        const reasoning = matches.filter((m) => KNOWN_EFFORTS[m.id] !== undefined)
        return {
          kind: 'success',
          text: [
            matches.length === 0
              ? `No Command Code models match "${rest}".`
              : `Command Code models${query ? ` matching "${rest}"` : ''} (${matches.length}):`,
            renderModels(matches.map((m) => m.id), MAX_MODELS_LIST),
            reasoning.length > 0 ? `\nReasoning models: ${reasoning.map((m) => m.id).join(', ')}` : '',
            '',
            'Check a model against your plan: /commandcode check <model>',
          ].filter(Boolean).join('\n'),
        }
      }

      // ---- check ----------------------------------------------------------
      if (sub === 'check') {
        const model = rest
        if (model.length === 0) {
          return {
            kind: 'error',
            text: 'Usage: /commandcode check <model-id> — list models with /commandcode models',
          }
        }
        const connection = options()
        const key = await resolveApiKey(connection)
        if (key === undefined) {
          return {
            kind: 'error',
            text: 'No Command Code API key configured. Store COMMANDCODE_API_KEY via the Models page or run `command-code login`.',
          }
        }
        const result = await probeModel(adapter, model)
        return { kind: 'success', text: `Command Code model "${model}": ${result}` }
      }

      // ---- unknown subcommand ---------------------------------------------
      return {
        kind: 'error',
        text: `Unknown /commandcode subcommand "${sub}". Usage: status | models [query] | check <model>`,
      }
    },
  }
}

/** Register the command on `ctx.commands` (called from the plugin entry). */
export function applyCommands<C extends CommandCodeConnectionOptions>(
  ctx: Context,
  deps: CommandCodeCommandDeps<C>,
): void {
  ctx.commands.register(commandDefinition(deps))
}
