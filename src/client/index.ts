/**
 * Browser half of the dsh-commandcode-provider bundle.
 *
 * The host rejects switching to a text-only model while the session already
 * contains images with a harness-level `model-unavailable` error
 * (`dsh-host-apiproxy`'s `session.selectModel` handler). That rejection is
 * intentional and cannot be relaxed from the plugin side — the adapter's
 * `inputModalities` is exactly what makes the guard work. What we CAN do is
 * make the error message friendlier: this client plugin wraps the shared
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
 */

import type { Context } from '@deepseek-ai/cordis'

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

/** The connection handle shape we read `api.sessions` from. */
interface ConnectionLike {
  api: { sessions: SessionsLike }
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
export function withFriendlyImageError(sessions: SessionsLike): SessionsLike {
  const selectModel = sessions.selectModel.bind(sessions)
  return {
    ...sessions,
    selectModel: async (payload, signal) => {
      const result = await selectModel(payload, signal)
      if (!isImageSessionRejection(result)) return result
      const model = result.result.error.details?.model ?? payload.model
      return {
        ...result,
        result: {
          ...result.result,
          error: {
            ...result.result.error,
            message:
              `当前会话已包含图片，而模型 ${model} 不支持图片输入；`
              + '请选择支持图片的模型，或先移除会话中的图片。',
          },
        },
      }
    },
  }
}

/**
 * Client plugin body: install the selectModel wrapper on the connection's
 * shared api. `inject: ['connection']` gates activation until the connection
 * service is provided (the same pattern the harness's own client plugins
 * use), and `connection.api.sessions` is a stable object the model-selection
 * UI reads fresh on every call — so wrapping it once covers both the /model
 * popup and the composer seat, across reconnects.
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection === undefined) return
  connection.api.sessions = withFriendlyImageError(connection.api.sessions)
}

export const inject: readonly string[] = ['connection']
