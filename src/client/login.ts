/**
 * Browser controller for the settings page's login panel.
 *
 * The panel drives the Host-half browser login (the official
 * `command-code login` loopback dance) through the Typert Gateway: `begin`
 * asks the Host to bind the callback server and returns the Studio URL, the
 * controller polls `loginStatus` once a second while the attempt is live, and
 * `cancel` tears it down. The key itself never crosses to the browser — the
 * Host validates and stores it through the credentials seam.
 *
 * Transport-level failures (no mounted Remote, an older Host without the
 * login endpoints) land in the dedicated `unavailable` phase so the page can
 * point back at manual paste. Deliberately JSX-free, mirroring
 * `./settings.ts` and `./usage.ts`.
 *
 * @module dsh-commandcode-provider/client/login
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandCodeLoginFailureReason, CommandCodeLoginStatus } from '../login-wire.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsCommandCodeKey } from './locales.ts'

/** The endpoint-level Remote surface this controller calls. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'commandcode/loginBegin': () => Promise<RemoteResult<CommandCodeLoginStatus>>
    'commandcode/loginStatus': () => Promise<RemoteResult<CommandCodeLoginStatus>>
    'commandcode/loginCancel': () => Promise<RemoteResult<CommandCodeLoginStatus>>
  }
}

/** The narrow slice of the mounted Remote this controller calls. */
export interface LoginRemote {
  loginBegin(): Promise<LoginCallResult>
  loginStatus(): Promise<LoginCallResult>
  loginCancel(): Promise<LoginCallResult>
}

/** One Remote call's outcome as the controller sees it. */
export type LoginCallResult =
  | { ok: true; value: CommandCodeLoginStatus }
  | { ok: false; error: { message: string } }

/** The panel's full state face. */
export interface LoginPageState {
  /**
   * `idle` — nothing started; `starting` — begin() in flight; `waiting` —
   * the Studio URL is live and polling; `success`/`failed` — terminal;
   * `unavailable` — the Remote itself could not be reached (old Host, mount
   * failure), manual paste is the way.
   */
  phase: 'idle' | 'starting' | 'waiting' | 'success' | 'failed' | 'unavailable'
  /** The Studio authorization URL while `waiting`. */
  authUrl: string | undefined
  /** The account display name on `success`. */
  userName: string | undefined
  /** The key's Studio label on `success`. */
  keyName: string | undefined
  /** The stable failure reason when `failed`. */
  reason: CommandCodeLoginFailureReason | undefined
  /** Secondary failure detail when `failed`/`unavailable`. */
  message: string | undefined
}

/** How often a live attempt is polled. */
const POLL_INTERVAL_MS = 1_000

/**
 * The login panel's fetch/poll lifecycle. One poll loop at a time; a fresh
 * `begin()` supersedes any previous loop via a generation token.
 */
export class CommandCodeLoginController {
  private readonly remote: () => LoginRemote | undefined
  private readonly listeners = new Set<() => void>()
  private readonly pollMs: number
  /** Monotonic token; only the latest loop may publish polling results. */
  private generation = 0
  private disposed = false

  private phase: LoginPageState['phase'] = 'idle'
  private authUrl: string | undefined
  private userName: string | undefined
  private keyName: string | undefined
  private reason: CommandCodeLoginFailureReason | undefined
  private message: string | undefined

  constructor(remote: () => LoginRemote | undefined, pollMs = POLL_INTERVAL_MS) {
    this.remote = remote
    this.pollMs = pollMs
  }

  /** Subscribe to state projections. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Build the current panel state face. */
  state(): LoginPageState {
    return {
      phase: this.phase,
      authUrl: this.authUrl,
      userName: this.userName,
      keyName: this.keyName,
      reason: this.reason,
      message: this.message,
    }
  }

  /** Start (or rejoin) a login attempt and begin polling its status. */
  async begin(): Promise<void> {
    if (this.disposed || this.phase === 'starting' || this.phase === 'waiting') return
    const generation = ++this.generation
    this.set({ phase: 'starting', authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: undefined })
    const remote = this.remote()
    if (remote === undefined) {
      this.set({ phase: 'unavailable', authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: 'login remote is not mounted' })
      return
    }
    let result: LoginCallResult
    try {
      result = await remote.loginBegin()
    } catch (error: unknown) {
      // A transport throw (gateway hiccup) reads the same as a rejected call.
      result = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
    if (this.superseded(generation)) return
    if (!result.ok) {
      this.set({ phase: 'unavailable', authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: result.error.message })
      return
    }
    this.apply(result.value)
    if (this.currentPhase === 'waiting') void this.poll(generation)
  }

  /** Cancel a waiting attempt. */
  async cancel(): Promise<void> {
    if (this.disposed || (this.phase !== 'starting' && this.phase !== 'waiting')) return
    const generation = ++this.generation
    const remote = this.remote()
    if (remote === undefined) return
    let result: LoginCallResult
    try {
      result = await remote.loginCancel()
    } catch {
      // The Host may be gone; reflect the local cancel regardless.
      this.set({ phase: 'failed', authUrl: undefined, userName: undefined, keyName: undefined, reason: 'cancelled', message: undefined })
      return
    }
    if (this.superseded(generation)) return
    if (result.ok) this.apply(result.value)
    else this.set({ phase: 'failed', authUrl: undefined, userName: undefined, keyName: undefined, reason: 'cancelled', message: undefined })
  }

  /** Stop polling and release listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.listeners.clear()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Poll until the attempt leaves `waiting` or a newer loop supersedes us. */
  private async poll(generation: number): Promise<void> {
    // A getter read (not the field) so control-flow narrowing across `await`
    // cannot claim the phase is frozen.
    while (!this.disposed && !this.superseded(generation) && this.currentPhase === 'waiting') {
      await sleep(this.pollMs)
      if (this.disposed || this.superseded(generation) || this.currentPhase !== 'waiting') return
      const remote = this.remote()
      if (remote === undefined) {
        this.set({ phase: 'unavailable', authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: 'login remote is not mounted' })
        return
      }
      let result: LoginCallResult
      try {
        result = await remote.loginStatus()
      } catch {
        continue // one missed poll is not an outage; the next tick retries
      }
      if (this.superseded(generation) || this.currentPhase !== 'waiting') return
      if (result.ok) this.apply(result.value)
    }
  }

  private get currentPhase(): LoginPageState['phase'] {
    return this.phase
  }

  /** Project one Host status onto the panel face. */
  private apply(status: CommandCodeLoginStatus): void {
    const base = { authUrl: undefined, userName: undefined, keyName: undefined, reason: undefined, message: undefined }
    if (status.state === 'waiting') {
      this.set({ ...base, phase: 'waiting', authUrl: status.authUrl })
      return
    }
    if (status.state === 'success') {
      this.set({ ...base, phase: 'success', userName: status.userName, keyName: status.keyName })
      return
    }
    if (status.state === 'failed') {
      this.set({ ...base, phase: 'failed', reason: status.reason, message: status.message })
      return
    }
    // `idle` mid-poll means the Host restarted; the attempt is gone.
    this.set({ ...base, phase: 'failed', reason: 'cancelled', message: 'the login attempt is no longer active' })
  }

  /** Replace the whole state face and notify. Explicit over partial patches. */
  private set(state: LoginPageState): void {
    this.phase = state.phase
    this.authUrl = state.authUrl
    this.userName = state.userName
    this.keyName = state.keyName
    this.reason = state.reason
    this.message = state.message
    this.publish()
  }

  private superseded(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Hint copy for the login panel / card row (JSX-free so node tests drive it)
// ---------------------------------------------------------------------------

/**
 * The per-reason copy for a failed login attempt. Shared by the settings
 * page's login panel and the Models-page card's login row — the same reasons
 * can surface from either surface.
 */
export function loginFailureCopy(
  reason: CommandCodeLoginFailureReason | undefined,
  t: Translate<SettingsCommandCodeKey>,
): string {
  if (reason === 'denied') return t('loginDenied')
  if (reason === 'timeout') return t('loginTimeout')
  if (reason === 'invalid-key') return t('loginInvalidKey')
  if (reason === 'network') return t('loginNetwork')
  if (reason === 'unavailable') return t('loginStoreFailed')
  if (reason === 'cancelled') return t('loginCancelled')
  return t('loginFailedGeneric')
}

/** One login panel row's computed hint: text, class stem, and optional title. */
export interface LoginHint {
  text: string
  className: string
  /** Tooltip shown when the row carries secondary failure detail. */
  title: string | undefined
}

/**
 * The hint text + class for one login panel state, shared by the settings
 * page's `LoginPanel` and the Models-page card's login row so both surfaces
 * can never drift apart. Pure: no timers, no state — the components render it.
 */
export function loginHint(
  state: LoginPageState,
  t: Translate<SettingsCommandCodeKey>,
): LoginHint {
  if (state.phase === 'starting' || state.phase === 'waiting') {
    return {
      text: t(state.phase === 'starting' ? 'loginStarting' : 'loginWaiting'),
      className: 'cc-hint',
      title: undefined,
    }
  }
  if (state.phase === 'success') {
    const keyName = state.keyName !== undefined && state.keyName !== '' ? ` · ${state.keyName}` : ''
    return {
      text: `${t('loginSuccess')} ${state.userName ?? ''}${keyName}`.trim(),
      className: 'cc-loginDone',
      title: undefined,
    }
  }
  if (state.phase === 'failed') {
    return {
      text: loginFailureCopy(state.reason, t),
      className: 'cc-loginError',
      title: state.message,
    }
  }
  if (state.phase === 'unavailable') {
    return {
      text: `${t('loginUnavailable')} ${state.message ?? ''}`.trim(),
      className: 'cc-loginError',
      title: undefined,
    }
  }
  return { text: t('loginHintIdle'), className: 'cc-hint', title: undefined }
}
