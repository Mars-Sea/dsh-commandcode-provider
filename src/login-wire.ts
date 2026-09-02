/**
 * Wire contract for the Command Code login Remote endpoints
 * (`commandcode/loginBegin`, `commandcode/loginStatus`,
 * `commandcode/loginCancel`).
 *
 * The settings page can start a browser login against the official Command
 * Code Studio (the same loopback flow `command-code login` performs) instead
 * of pasting an API key. The loopback server must live in the Host half — it
 * binds a local port and receives the key — so the page drives it through the
 * Typert Gateway exactly like the usage report.
 *
 * This module is the single source both halves share, deliberately
 * dependency-free (`import type` edges only): the strict status validator the
 * client trusts, the three descriptors both halves register, and the two
 * contribution objects. The state shape mirrors the Host-only flow machine in
 * `src/login.ts` as plain JSON.
 *
 * @module dsh-commandcode-provider/login-wire
 */

import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import {
  makeRemoteDescriptor,
  REMOTE_PACKAGE,
} from './wire-shared.ts'

/** Why a login attempt ended in `failed` (stable across versions for copy). */
export type CommandCodeLoginFailureReason =
  /** The Studio page reported the authorization was denied by the user. */
  | 'denied'
  /** No callback arrived within the flow's timeout window. */
  | 'timeout'
  /** The delivered key failed `/alpha/whoami` validation (401). */
  | 'invalid-key'
  /** The validation request could not reach the API. */
  | 'network'
  /** The key could not be stored (credentials seam unavailable). */
  | 'unavailable'
  /** The attempt was cancelled by the user or torn down with the plugin. */
  | 'cancelled'
  /** Anything else. */
  | 'error'

/** One login attempt's full state face, as carried over the wire. */
export interface CommandCodeLoginStatus {
  /**
   * `idle` — no attempt; `waiting` — the loopback server is up and the
   * Studio URL is live; `success` — the key validated and was stored;
   * `failed` — see `reason`/`message`.
   */
  state: 'idle' | 'waiting' | 'success' | 'failed'
  /** The Studio authorization URL while `waiting`. */
  authUrl?: string
  /** The account display name reported by the Studio, on `success`. */
  userName?: string
  /** The key's label from the Studio, on `success`. */
  keyName?: string
  /** Why the attempt failed, when `failed`. */
  reason?: CommandCodeLoginFailureReason
  /** Human-readable failure detail, when `failed` (secondary to `reason`). */
  message?: string
}

/** The canonical endpoint paths of the three login Remotes. */
export const LOGIN_BEGIN_ENDPOINT = 'commandcode/loginBegin'
export const LOGIN_STATUS_ENDPOINT = 'commandcode/loginStatus'
export const LOGIN_CANCEL_ENDPOINT = 'commandcode/loginCancel'

const REASONS: readonly CommandCodeLoginFailureReason[] = [
  'denied', 'timeout', 'invalid-key', 'network', 'unavailable', 'cancelled', 'error',
]

/** The shared read/validate helpers, prefixed with the login endpoint so
 * rejection messages name the offending boundary. */
/** Reject one boundary value with a field-naming error. A module-level
 * function declaration (not the factory's destructured arrow) so TypeScript's
 * control-flow analysis recognizes it as never-returning and narrows `state`
 * after the guard below. */
function reject(field: string): never {
  throw new TypeError(`commandcode/login result: invalid ${field}`)
}

/**
 * Parse one untrusted boundary value into a {@link CommandCodeLoginStatus}.
 * Every field is shape-checked so a malformed frame fails the boundary
 * instead of leaking into the page.
 */
export function parseLoginStatus(value: unknown): CommandCodeLoginStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject('status')
  const source = value as Record<string, unknown>
  const state = source.state
  if (state !== 'idle' && state !== 'waiting' && state !== 'success' && state !== 'failed') {
    reject('state')
  }
  const status: CommandCodeLoginStatus = { state }
  if (source.authUrl !== undefined) {
    if (typeof source.authUrl !== 'string') reject('authUrl')
    status.authUrl = source.authUrl
  }
  if (source.userName !== undefined) {
    if (typeof source.userName !== 'string') reject('userName')
    status.userName = source.userName
  }
  if (source.keyName !== undefined) {
    if (typeof source.keyName !== 'string') reject('keyName')
    status.keyName = source.keyName
  }
  if (source.reason !== undefined) {
    if (!REASONS.includes(source.reason as CommandCodeLoginFailureReason)) reject('reason')
    status.reason = source.reason as CommandCodeLoginFailureReason
  }
  if (source.message !== undefined) {
    if (typeof source.message !== 'string') reject('message')
    status.message = source.message
  }
  return status
}

/** The strict result codec shared by all three login endpoints. */
export const loginStatusSchema: TypertSchema<CommandCodeLoginStatus> = {
  parse: parseLoginStatus,
}

/** Build one login invocation descriptor (uniform result, no parameters). */
function loginDescriptor(endpoint: string, method: string): InvocationDescriptor {
  return makeRemoteDescriptor<CommandCodeLoginStatus>(
    endpoint,
    method,
    `${REMOTE_PACKAGE}#CommandCodeLoginStatus`,
    loginStatusSchema,
  )
}

/** The three login descriptors, shared verbatim by Host registration and Client mount. */
export const LOGIN_DESCRIPTORS: readonly InvocationDescriptor[] = [
  loginDescriptor(LOGIN_BEGIN_ENDPOINT, 'loginBegin'),
  loginDescriptor(LOGIN_STATUS_ENDPOINT, 'loginStatus'),
  loginDescriptor(LOGIN_CANCEL_ENDPOINT, 'loginCancel'),
]

/** The Host-face contribution fragment registered on `ctx.typert`. */
export const LOGIN_HOST_CONTRIBUTION = {
  package: REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: LOGIN_DESCRIPTORS,
}

/** The Client-face contribution fragment mounted on `ctx.remote`. */
export const LOGIN_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: REMOTE_PACKAGE,
  descriptors: LOGIN_DESCRIPTORS,
}
