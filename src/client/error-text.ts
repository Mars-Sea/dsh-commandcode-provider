/**
 * Turn a caught value into readable text for the settings page's error UI.
 *
 * @module dsh-commandcode-provider/client/error-text
 */

/**
 * `error instanceof Error ? error.message : String(error)` degrades to the
 * literal string `[object Object]` for a plain object with no `Error`
 * prototype — which is exactly what a Remote call across the webview/host
 * boundary can hand back: `dsh-typert-protocol` serializes a rejection for
 * the wire, and a structurally-cloned value loses its prototype chain even
 * when the host threw a real `Error` (issue #74). Reading a `message` string
 * off the plain object first recovers the original text in that case; only a
 * value with neither an `Error` prototype nor a usable `message` field falls
 * through to a JSON dump.
 */
export function readableErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}
