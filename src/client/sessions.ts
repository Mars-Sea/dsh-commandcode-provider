/**
 * Friendly-error wrapper for the harness's image-session gate.
 *
 * The host rejects switching to a text-only model while the session already
 * contains images with a `model-unavailable` error
 * (`dsh-host-apiproxy`'s `session.selectModel` handler). That rejection is
 * intentional and cannot be relaxed from the plugin side — the adapter's
 * `inputModalities` is exactly what makes the guard work. What we CAN do is
 * make the error message friendlier: wrap the shared
 * `connection.api.sessions.selectModel` face so a `model-unavailable`
 * rejection shows a clear, actionable hint (with the requested model name)
 * instead of the raw English harness message.
 *
 * The wrapper is deliberately narrow: only the `model-unavailable` code is
 * rewritten, only when the message matches the image-session gate, and only
 * the message text changes — the error code and details pass through
 * untouched so any caller that switches on `error.code` keeps working.
 *
 * The wire types are spelled structurally here (not imported from
 * `@deepseek-ai/dsh-host-apiproxy`) so this client bundle does not drag an
 * extra peer dependency into the package; the shapes are stable and the
 * client build inlines them anyway.
 *
 * The wrapper takes a `getLocale` thunk because it is reached from a
 * non-React path that has no `t` in scope; the supplied thunk reads the
 * active locale at call time (typically `() => ctx.locale.getLocale().active`
 * in the client entry), and the message template lives in the shared
 * `commandcodeCommand` dictionary used by the Host-side `/commandcode`
 * command — the same bilingual surface serves both.
 *
 * This module is deliberately free of React and other client-platform
 * imports so the node test runner can exercise it directly.
 */

import { commandcodeCommand, type LocaleId } from '../command-locales.ts'

/** The `model-unavailable` error details: provider + model id. */
interface ModelUnavailableDetails {
  provider: string
  model: string
}

/** The narrow slice of the RPC error we need to inspect and rewrite. */
interface RpcErrorLike {
  code: string
  message: string
  details?: ModelUnavailableDetails
}

/**
 * The narrow slice of a unary RPC result we need to inspect and rewrite.
 * The wire shape from `sessions.selectModel` (via `AbstractApiClient.callUnary`)
 * is the full envelope `{ rpcId, result: { ok, error? } }` — the error lives
 * under `result.result`, not at the top level. `RpcResultLike` models that.
 */
interface RpcResultLike {
  rpcId: string
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error: RpcErrorLike }
}

/** One selectModel call: payload in, envelope out. */
type SelectModelCall = (
  payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
  signal?: AbortSignal,
) => Promise<RpcResultLike>

/** The shared sessions wire face we wrap. */
interface SessionsLike {
  selectModel: SelectModelCall
}

/** Whether a selectModel rejection is the harness's image-session gate. */
export function isImageSessionRejection(
  result: RpcResultLike,
): result is RpcResultLike & { result: { ok: false; error: RpcErrorLike } } {
  return (
    !result.result.ok &&
    result.result.error.code === 'model-unavailable' &&
    result.result.error.message.includes('does not accept image input')
  )
}

/** Wrap the shared sessions API so selectModel failures read friendlier. */
export function withFriendlyImageError(
  sessions: SessionsLike,
  getLocale: () => LocaleId,
): SessionsLike {
  const selectModel = sessions.selectModel.bind(sessions)
  return {
    ...sessions,
    selectModel: async (payload, signal) => {
      const result = await selectModel(payload, signal)
      if (!isImageSessionRejection(result)) return result
      const model = result.result.error.details?.model ?? payload.model
      const template = commandcodeCommand[getLocale()].imageGate
        ?? commandcodeCommand.en.imageGate
      return {
        ...result,
        result: {
          ...result.result,
          error: {
            ...result.result.error,
            message: template.replace('{model}', model),
          },
        },
      }
    },
  }
}

/**
 * The pre-0.1.2 connection handle that exposed the shared session API under
 * `connection.api.sessions`. In 0.1.2 the connection service became a
 * transport/generation handle and model selection moved to `remote.session`,
 * so this legacy field is deliberately optional.
 */
export interface ConnectionLike {
  api?: { sessions?: SessionsLike }
}

/**
 * Install the friendly-error wrapper when a legacy sessions face is present.
 *
 * @returns whether the wrapper was installed. The rewrite is only UX polish;
 * a 0.1.2 connection has no `api.sessions`, and its absence must never block
 * the plugin from mounting its settings, credential, or usage surfaces.
 */
export function installFriendlyImageError(
  connection: ConnectionLike,
  getLocale: () => LocaleId,
): boolean {
  const api = connection.api
  const sessions = api?.sessions
  if (api === undefined || sessions === undefined || typeof sessions.selectModel !== 'function') return false
  api.sessions = withFriendlyImageError(sessions, getLocale)
  return true
}
