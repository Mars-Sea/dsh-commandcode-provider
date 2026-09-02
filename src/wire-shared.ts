/**
 * Shared boundary-validation and Remote-descriptor plumbing for the plugin's
 * hand-rolled Typert wire contracts (`commandcode/report`, `commandcode/models`,
 * `commandcode/login*`).
 *
 * Every Remote this plugin serves crosses the Typert Gateway with a strict
 * result schema: the Host half registers a descriptor against a Cordis service
 * (`src/usage-remote.ts`) and the browser half mounts the matching contribution
 * on `ctx.remote` (`src/client/index.ts`). The wire contract is deliberately
 * dependency-free so the client bundle can inline it — a pure-TS helper module
 * imported by the wire files keeps it that way while removing the schema
 * helpers and descriptor boilerplate they used to duplicate.
 *
 * @module dsh-commandcode-provider/wire-shared
 */

import type { InvocationDescriptor, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** The npm package identity every contribution and descriptor claims. */
export const REMOTE_PACKAGE = '@mars-sea/dsh-commandcode-provider'

/** The Cordis service key the Gateway resolves every Command Code Remote from. */
export const REMOTE_SERVICE = 'commandcodeUsage'

/** The wire namespace all Command Code endpoints share. */
export const REMOTE_NAMESPACE = 'commandcode'

/** The read/validate helpers one boundary codec needs. */
export interface BoundaryValidator {
  /** Reject one boundary value with a field-naming error. */
  reject(field: string): never
  /** Narrow an unknown value to a plain record, or reject. */
  record(value: unknown, field: string): Record<string, unknown>
  /** Read one required string field (`field` is the dotted error label). */
  stringField(source: Record<string, unknown>, key: string, field: string): string
  /** Read one required finite number field (`field` is the dotted error label). */
  numberField(source: Record<string, unknown>, key: string, field: string): number
  /** Read one required boolean field (`field` is the dotted error label). */
  booleanField(source: Record<string, unknown>, key: string, field: string): boolean
}

/**
 * Build the validator helpers one endpoint uses Sequence. `prefix` names the
 * endpoint in the rejection message (e.g. `commandcode/report result:`), so
 * each wire file keeps its own diagnostic phrasing while sharing the helper
 * bodies.
 *
 * The helpers return the reject call directly in the failure branch: since
 * `reject` is typed `never`, the ternary's union collapses to the success type
 * without relying on TypeScript's control-flow analysis of a never-returning
 * call (which only recognizes function declarations, not the destructured
 * arrow `reject` callers receive from this factory).
 */
export function makeBoundaryValidator(prefix: string): BoundaryValidator {
  const reject = (field: string): never => {
    throw new TypeError(`${prefix} invalid ${field}`)
  }
  const record = (value: unknown, field: string): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : reject(field)
  const stringField = (source: Record<string, unknown>, key: string, field: string): string =>
    typeof source[key] === 'string' ? source[key] as string : reject(field)
  const numberField = (source: Record<string, unknown>, key: string, field: string): number =>
    typeof source[key] === 'number' && Number.isFinite(source[key] as number)
      ? source[key] as number
      : reject(field)
  const booleanField = (source: Record<string, unknown>, key: string, field: string): boolean =>
    typeof source[key] === 'boolean' ? source[key] as boolean : reject(field)
  return { reject, record, stringField, numberField, booleanField }
}

/**
 * Build one strict invocation descriptor. Every Command Code Remote shares the
 * `commandcode` namespace, the `commandcodeUsage` service, and a strict
 * `mode: 'strict'` result — only the endpoint, method, result type symbol, and
 * schema differ — so the boilerplate lives here once and each endpoint supplies
 * only its own facts.
 */
export function makeRemoteDescriptor<Output>(
  endpoint: string,
  method: string,
  typeSymbol: string,
  schema: TypertSchema<Output>,
): InvocationDescriptor {
  return {
    id: `${REMOTE_PACKAGE}#${endpoint}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol,
      schema,
    },
  }
}