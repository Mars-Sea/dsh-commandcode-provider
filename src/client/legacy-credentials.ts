/** Legacy ApiProxy credentials adapter for pre-0.1.2 DSH clients. */

import type { SettingsPageApi } from './settings.ts'

interface LegacyFailure {
  message: string
}

interface LegacyResponse<T> {
  result:
    | { ok: true; value: T }
    | { ok: false; error: LegacyFailure }
}

/** The pre-0.1.2 `connection.api.credentials` face. */
export interface LegacyCredentialsApi {
  describe(request: { refs: string[] }): Promise<LegacyResponse<{
    credentials: Record<string, { configured: boolean; writable: boolean }>
  }>>
  set(request: { ref: string; value: string }): Promise<LegacyResponse<unknown>>
  unset(request: { ref: string }): Promise<LegacyResponse<unknown>>
}

/** Convert a legacy credentials ApiProxy into the current settings-page face. */
export function adaptLegacyCredentials(
  legacy: LegacyCredentialsApi | undefined,
): SettingsPageApi | undefined {
  if (legacy === undefined) return undefined
  return {
    credentials: {
      describe: async (refs) => {
        const response = await legacy.describe({ refs })
        return response.result.ok
          ? { ok: true, value: response.result.value.credentials }
          : { ok: false, error: response.result.error }
      },
      set: async (ref, value) => {
        const response = await legacy.set({ ref, value })
        return response.result.ok
          ? { ok: true, value: undefined }
          : { ok: false, error: response.result.error }
      },
      unset: async (ref) => {
        const response = await legacy.unset({ ref })
        return response.result.ok
          ? { ok: true, value: undefined }
          : { ok: false, error: response.result.error }
      },
    },
  }
}
