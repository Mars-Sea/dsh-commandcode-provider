/**
 * Host half of the Command Code browser login (the loopback flow).
 *
 * Mirrors what the official `command-code login` CLI command performs
 * (reverse-engineered from `command-code@1.32.1`, `createAuthFlowController`
 * + `createAuthServer` in its bundle):
 *
 * 1. Bind a temporary HTTP server on `127.0.0.1`, first available port from
 *    5959 upward (10 attempts).
 * 2. Generate a random state token and open
 *    `{studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state={state}`.
 * 3. After the user signs in, the Studio page POSTs the credentials JSON
 *    `{ apiKey, state, userId, userName, keyName }` to the loopback callback —
 *    no OAuth code exchange, the page holds the final API key.
 * 4. The delivered key is validated against `GET {apiBase}/alpha/whoami`
 *    before anything is stored.
 *
 * Server behaviour is mirrored exactly: POST-only `/callback`, a 10 KB body
 * cap, JSON responses (`{success:true}` / `{success:false,error}`), CORS for
 * the Studio origins only, and state-token equality as the anti-forgery
 * check. One deliberate hardening over the CLI build: the CORS origin is
 * echoed only when it is allowlisted (the CLI falls back to the first
 * origin), which browsers treat identically.
 *
 * Storage stays out of this module: the plugin entry supplies
 * {@link CommandCodeLoginFlowDeps.storeKey}, which writes through the dsh
 * credentials seam so the next request resolves the new key with no restart.
 * Everything external (fetch, ports, randomness, timing) is injectable for
 * node tests; the tests drive a real loopback server end to end.
 *
 * @module dsh-commandcode-provider/login
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { DEFAULT_API_BASE } from './adapter.ts'
import type { CommandCodeLoginFailureReason, CommandCodeLoginStatus } from './login-wire.ts'

/** Give up on the browser after this long without a callback (mirrors the CLI). */
export const LOGIN_TIMEOUT_MS = 120_000

/** First local port the flow tries (mirrors the CLI). */
export const LOGIN_START_PORT = 5959

/** How many consecutive ports to try from {@link LOGIN_START_PORT}. */
export const LOGIN_MAX_PORT_ATTEMPTS = 10

/** Reject callback bodies larger than this (mirrors the CLI). */
export const LOGIN_BODY_LIMIT_BYTES = 10_000

/** The Studio origins allowed to POST credentials to the loopback server. */
export const LOGIN_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'https://staging.commandcode.ai',
  'https://commandcode.ai',
]

/** The Studio route that performs the browser-side login. */
const STUDIO_AUTH_PATH = '/studio/auth/cli'

/** Credentials as delivered by the Studio's callback POST. */
export interface CommandCodeLoginCredentials {
  apiKey: string
  userId: string
  userName: string
  keyName: string
}

/** Outcome of validating a delivered key against `/alpha/whoami`. */
export type ApiKeyValidation =
  | { valid: true }
  | { valid: false; error: 'invalid_key' | 'server_error' | 'network_error' }

export interface CommandCodeLoginFlowDeps {
  /**
   * The Provider API base used for `/alpha/whoami` validation; also selects
   * the matching Studio base (staging api → staging studio). A thunk is fine:
   * it is re-read when each attempt starts, so a settings change reaches the
   * next login. Defaults to the public API base.
   */
  apiBase?: string | (() => string | undefined)
  /** Attempt timeout in millis; defaults to {@link LOGIN_TIMEOUT_MS}. */
  timeoutMs?: number
  /** First port to try; defaults to {@link LOGIN_START_PORT}. */
  startPort?: number
  /** Consecutive-port attempts; defaults to {@link LOGIN_MAX_PORT_ATTEMPTS}. */
  maxPortAttempts?: number
  /** Validation fetch seam; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Randomness seam; defaults to `node:crypto` randomBytes(32) base64url. */
  randomToken?: (byteLength: number) => string
  /**
   * Receives the validated credentials after a successful login. Rejecting
   * fails the attempt with `unavailable`.
   */
  storeKey(credentials: CommandCodeLoginCredentials): Promise<void>
}

/** Compose the Studio authorization URL (pure, exported for tests). */
export function buildCommandAuthUrl(options: { studioBase: string; port: number; state: string }): string {
  const callback = `http://localhost:${options.port}/callback`
  return `${options.studioBase}${STUDIO_AUTH_PATH}?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(options.state)}`
}

/** Map an API base onto the Studio base the CLI pairs it with. */
export function studioBaseForApiBase(apiBase: string): string {
  if (/^https:\/\/staging-api\.commandcode\.ai/i.test(apiBase)) return 'https://staging.commandcode.ai'
  if (/^http:\/\/localhost(:\d+)?$/i.test(apiBase)) return 'http://localhost:3000'
  return 'https://commandcode.ai'
}

/**
 * Validate one candidate key against `/alpha/whoami` (pure, exported for
 * tests). Mirrors the CLI's verdicts: 401 → invalid_key, other non-OK →
 * server_error, transport failure → network_error.
 */
export async function validateCommandApiKey(
  fetchImpl: typeof fetch,
  apiBase: string,
  apiKey: string,
): Promise<ApiKeyValidation> {
  try {
    const response = await fetchImpl(`${apiBase}/alpha/whoami`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    })
    if (response.status === 401) return { valid: false, error: 'invalid_key' }
    if (response.ok) return { valid: true }
    return { valid: false, error: 'server_error' }
  } catch {
    return { valid: false, error: 'network_error' }
  }
}

/** Whether one loopback port is free right now. */
function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** Whether a callback body carries every credential field the CLI requires. */
function isCallbackCredentials(value: unknown): value is CommandCodeLoginCredentials & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.apiKey === 'string' && record.apiKey !== ''
    && typeof record.state === 'string'
    && typeof record.userId === 'string'
    && typeof record.userName === 'string'
    && typeof record.keyName === 'string'
}

/**
 * One browser-login attempt machine. Single-flight by design: `begin()` while
 * waiting returns the live attempt's status instead of starting a second one;
 * a terminal state makes the next `begin()` start fresh.
 */
export class CommandCodeLoginFlow {
  private readonly deps: CommandCodeLoginFlowDeps
  private readonly listeners = new Set<() => void>()

  private statusValue: CommandCodeLoginStatus = { state: 'idle' }
  private server: Server | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Settle hooks of the live attempt's callback promise. */
  private settle: {
    resolve(credentials: CommandCodeLoginCredentials): void
    reject(failure: LoginSettleError): void
  } | undefined
  private disposed = false

  constructor(deps: CommandCodeLoginFlowDeps) {
    this.deps = deps
  }

  /** Subscribe to state transitions. @returns the disposer. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The current attempt's status face. */
  status(): CommandCodeLoginStatus {
    return this.statusValue
  }

  /**
   * Start an attempt (or rejoin the live one) and resolve with its status —
   * `waiting` carrying the Studio URL once the loopback server is up.
   * Rejects only when the flow cannot start at all (no free port, disposed).
   */
  async begin(): Promise<CommandCodeLoginStatus> {
    if (this.disposed) throw new Error('login flow has been disposed')
    if (this.statusValue.state === 'waiting') return this.statusValue
    this.teardown()

    const port = await this.findPort()
    const expectedState = this.deps.randomToken?.(32) ?? randomBytes(32).toString('base64url')

    // The attempt settles exactly once: fulfilled with delivered credentials,
    // rejected with a tagged failure the mapping below turns into copy.
    const settled = new Promise<CommandCodeLoginCredentials>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    // A bind failure must surface before the attempt reports `waiting`.
    await this.bindServer(port, expectedState)

    const apiBase = this.readApiBase()
    this.setStatus({
      state: 'waiting',
      authUrl: buildCommandAuthUrl({ studioBase: studioBaseForApiBase(apiBase), port, state: expectedState }),
    })

    // Watchdog mirrors the CLI's 2-minute window.
    this.timer = setTimeout(() => {
      this.teardown()
      this.setStatus({
        state: 'failed',
        reason: 'timeout',
        message: 'No browser callback arrived within the login window.',
      })
    }, this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS)
    this.timer.unref?.()

    void settled.then(
      (credentials) => this.complete(credentials),
      (failure) => this.failFrom(failure),
    )
    return this.statusValue
  }

  /** Cancel a waiting attempt; terminal states are untouched. */
  cancel(): void {
    if (this.disposed || this.statusValue.state !== 'waiting') return
    this.teardown()
    this.setStatus({ state: 'failed', reason: 'cancelled' })
  }

  /** Stop everything; a waiting attempt ends cancelled. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const wasWaiting = this.statusValue.state === 'waiting'
    this.teardown()
    if (wasWaiting) this.setStatus({ state: 'failed', reason: 'cancelled' })
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private readApiBase(): string {
    const raw = typeof this.deps.apiBase === 'function' ? this.deps.apiBase() : this.deps.apiBase
    return raw ?? DEFAULT_API_BASE
  }

  private setStatus(next: CommandCodeLoginStatus): void {
    this.statusValue = next
    for (const listener of [...this.listeners]) listener()
  }

  /** First free port among the consecutive candidates. */
  private async findPort(): Promise<number> {
    const startPort = this.deps.startPort ?? LOGIN_START_PORT
    const attempts = this.deps.maxPortAttempts ?? LOGIN_MAX_PORT_ATTEMPTS
    for (let index = 0; index < attempts; index += 1) {
      const candidate = startPort + index
      if (await checkPortAvailable(candidate)) return candidate
    }
    throw new Error(`No available port found after ${attempts} attempts starting from port ${startPort}`)
  }

  /**
   * Bind the attempt's loopback server, resolving when the port is live.
   * Pre-bind failures reject (surfacing from `begin()`); a later server error
   * settles the live attempt as a tagged failure instead.
   */
  private bindServer(port: number, expectedState: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let binding = true
      const server = createHttpServer((request, response) => this.handleCallback(request, response, expectedState))
      this.server = server
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (this.server !== server) return
        this.server = undefined
        const tagged = new LoginSettleError(
          'error',
          `Could not bind the login callback server on port ${port}: ${error.code ?? error.message}`,
        )
        if (binding) {
          binding = false
          reject(tagged)
        } else {
          this.settle?.reject(tagged)
        }
      })
      server.listen(port, '127.0.0.1', () => {
        if (!binding) return
        binding = false
        resolve()
      })
    })
  }

  /** One request against the attempt's callback endpoint (CLI-mirrored). */
  private handleCallback(request: IncomingMessage, response: ServerResponse, expectedState: string): void {
    // One-shot responses: the server dies with the attempt, and a client
    // pooling the connection would otherwise race its next request against
    // the close.
    response.setHeader('Connection', 'close')
    response.setHeader('Access-Control-Allow-Origin', corsOrigin(request.headers.origin))
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Content-Type', 'application/json')
    const json = (code: number, body: Record<string, unknown>) => {
      response.writeHead(code)
      response.end(JSON.stringify(body))
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    const path = request.url?.split('?')[0] ?? '/'
    if (path !== '/callback') {
      json(404, { success: false, error: 'Not found' })
      return
    }
    if (request.method !== 'POST') {
      json(405, { success: false, error: 'Method not allowed. Use POST.' })
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > LOGIN_BODY_LIMIT_BYTES) request.destroy()
    })
    request.on('end', () => {
      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        json(400, { success: false, error: 'Invalid JSON' })
        return
      }
      // The Studio reports a denied authorization as an error object.
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const denial = payload as Record<string, unknown>
        const description = denial.error_description ?? denial.error
        this.settleAttempt(json, 200, { success: true }, new LoginSettleError(
          denial.error === 'access_denied' ? 'denied' : 'error',
          typeof description === 'string' && description !== '' ? description : 'Authorization failed',
        ))
        return
      }
      if (!isCallbackCredentials(payload)) {
        json(400, { success: false, error: 'Missing required fields' })
        return
      }
      if (payload.state !== expectedState) {
        // Not terminal: a stale tab replaying an old state must not kill the
        // live attempt — answer 403 and keep waiting (the CLI does the same).
        json(403, { success: false, error: 'Invalid state token' })
        return
      }
      this.settleAttempt(json, 200, { success: true }, undefined, { ...payload })
    })
    request.on('error', () => {})
  }

  /** Answer a decisive callback, stop listening, and settle the attempt. */
  private settleAttempt(
    json: (code: number, body: Record<string, unknown>) => void,
    code: number,
    body: Record<string, unknown>,
    failure?: LoginSettleError,
    credentials?: CommandCodeLoginCredentials,
  ): void {
    json(code, body)
    // Capture the settle hooks BEFORE teardown clears them.
    const settle = this.settle
    this.teardown()
    if (settle === undefined) return
    if (failure !== undefined) settle.reject(failure)
    else if (credentials !== undefined) settle.resolve(credentials)
  }

  /** Post-validation completion: whoami check, then hand-off to storage. */
  private async complete(credentials: CommandCodeLoginCredentials): Promise<void> {
    if (this.disposed || this.statusValue.state !== 'waiting') return
    const validation = await validateCommandApiKey(
      this.deps.fetchImpl ?? fetch,
      this.readApiBase(),
      credentials.apiKey,
    )
    if (!validation.valid) {
      const reason: CommandCodeLoginFailureReason = validation.error === 'invalid_key'
        ? 'invalid-key'
        : validation.error === 'network_error' ? 'network' : 'error'
      this.setStatus({
        state: 'failed',
        reason,
        message: `/alpha/whoami rejected the delivered key (${validation.error}).`,
      })
      return
    }
    try {
      await this.deps.storeKey(credentials)
    } catch (error: unknown) {
      this.setStatus({
        state: 'failed',
        reason: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (this.disposed) return
    this.clearTimer()
    this.setStatus({ state: 'success', userName: credentials.userName, keyName: credentials.keyName })
  }

  /** Map a tagged settle rejection onto the status face. */
  private failFrom(failure: unknown): void {
    if (!(failure instanceof LoginSettleError)) return
    if (this.disposed || this.statusValue.state !== 'waiting') return
    this.setStatus({ state: 'failed', reason: failure.reason, message: failure.message })
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Close the server and watchdog without touching the published status. */
  private teardown(): void {
    this.clearTimer()
    this.server?.close()
    this.server = undefined
    this.settle = undefined
  }
}

/** A tagged settle failure carrying the stable copy reason. */
class LoginSettleError extends Error {
  constructor(public readonly reason: CommandCodeLoginFailureReason, message: string) {
    super(message)
    this.name = 'LoginSettleError'
  }
}

/** Echo the Origin header only when the Studio allowlist contains it. */
function corsOrigin(origin: string | undefined): string {
  return origin !== undefined && LOGIN_ALLOWED_ORIGINS.includes(origin) ? origin : ''
}
