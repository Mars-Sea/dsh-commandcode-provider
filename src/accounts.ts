/**
 * Multi-account pool for the Command Code provider (host side).
 *
 * One Command Code subscription (e.g. the Go plan's 5-hour window) is
 * metered; a user with several subscriptions wants a request that hits one
 * account's limit to continue on the next account without a visible failure.
 * This module owns that rotation:
 *
 *   - {@link CommandCodeAccountPool.resolveKey} hands out the first account
 *     whose key is not currently marked exhausted, resolving each slot's key
 *     lazily (literal config key → credential seam → launch environment → the
 *     official CLI auth file for the default slot only).
 *   - {@link CommandCodeAccountPool.markRejected} records a 429 (rate limit,
 *     window unknown) or 401 (invalid key, disabled until the config changes)
 *     against the exact API key, so several slots sharing one key share one
 *     state.
 *   - When every account is marked, the pool probes each key's
 *     `/alpha/billing/credits` window limits (through the injected
 *     {@link CommandCodeAccountPoolDeps.probeWindow}): an account whose window
 *     no longer reports `exceeded` is revived, otherwise the pool throws a
 *     `RATE_LIMIT` error naming the earliest reset time.
 *
 * The pool is deliberately cordis-free (like the adapter): every host fact
 * arrives through injected thunks, so node tests can drive it directly.
 *
 * @module dsh-commandcode-provider/accounts
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** One extra account's raw configuration (composition config or settings). */
export interface CommandCodeAccountConfig {
  /** Display label shown in the usage dashboard and settings page. */
  label?: string
  /** Credential reference (environment-variable style name) holding this account's API key. */
  apiKeyEnv?: string
  /** Literal API key (composition config only; never stored in settings). */
  apiKey?: string
}

/** One account slot after config normalization. */
export interface CommandCodeAccountSlot {
  /** Stable id: `default` for the implicit first account, `account-N` for extras. */
  id: string
  /** Display label (user-provided or generated). */
  label: string
  /** Credential reference resolved through the seam; undefined for literal-only slots. */
  ref?: CredentialRef | undefined
  /** Literal key from composition config. */
  literal?: string | undefined
  /** Whether the official CLI auth file may back this slot (default slot only). */
  allowAuthFile: boolean
}

/** Why a key stopped serving requests. */
export type AccountRejection = 'rate-limit' | 'invalid-credential'

/** One key's rotation state. */
export interface CommandCodeAccountState {
  kind:
    /** Marked by a 429; the window's reset time is unknown until probed. */
    | 'unknown'
    /** Probed (or marked with a known reset): unusable until `until` (millis). */
    | 'cooldown'
    /** Marked by a 401: skipped until the stored credential changes. */
    | 'disabled'
  /** Human-readable reason for the mark (e.g. `rate limited (429)`). */
  reason: string
  /** Cooldown end in millis; 0 for the other kinds. */
  until: number
}

/** A slot paired with its resolved key (both pool-internal and UI-facing). */
export interface ResolvedAccount {
  slot: CommandCodeAccountSlot
  key: string
  /** The key's current rotation state; undefined means usable. */
  state: CommandCodeAccountState | undefined
}

/** Five-hour window facts probed from `/alpha/billing/credits`. */
export interface FiveHourWindowProbe {
  exceeded: boolean
  resetAt: number
}

/** Everything the pool needs from the host; all seams are injected. */
export interface CommandCodeAccountPoolDeps {
  /** The current account slots, re-read per resolution so settings changes apply live. */
  slots(): readonly CommandCodeAccountSlot[]
  /** Resolve one credential reference through the credentials service or the launch environment. */
  resolveRef(ref: CredentialRef): Promise<string | undefined>
  /** The official CLI auth-file key (`~/.commandcode/auth.json`); default slot only. */
  authFileKey(): string | undefined
  /** Probe one key's five-hour window; undefined when the probe itself failed. */
  probeWindow(apiKey: string): Promise<FiveHourWindowProbe | undefined>
  /**
   * The manually selected account (a slot id, e.g. `default` or an extra's
   * credential reference), re-read per resolution. The preferred account
   * serves whenever it is usable; an unknown id or an exhausted preferred
   * account falls back to the first usable slot.
   */
  preferredId?(): string | undefined
}

/** A labeled, human-readable clock reading for error messages. */
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleString()
}

/**
 * Whether an account with this rotation state can serve a request right now.
 * `undefined` (never rejected) is usable; a cooldown becomes usable again
 * once its reset time passes; `unknown` (429, reset unprobed) and
 * `disabled` (401) are not.
 */
export function accountUsable(state: CommandCodeAccountState | undefined): boolean {
  if (state === undefined) return true
  if (state.kind === 'cooldown') return state.until > 0 && Date.now() >= state.until
  return false
}

/**
 * Pick the account that should serve now: the manually preferred slot when it
 * is usable, otherwise the first usable account in rotation order; undefined
 * when no account is usable. Shared by the pool (request path) and the plugin
 * entry (the usage view's active badge) so both always agree.
 */
export function selectActiveAccount(
  accounts: readonly ResolvedAccount[],
  preferredId: string | undefined,
): ResolvedAccount | undefined {
  const usable = accounts.filter((account) => accountUsable(account.state))
  if (preferredId !== undefined) {
    const preferred = usable.find((account) => account.slot.id === preferredId)
    if (preferred !== undefined) return preferred
  }
  return usable[0]
}

/**
 * The account pool. Rotation state is keyed by API key (never logged), so two
 * slots resolving to the same credential share one mark, and a key changed in
 * the credentials service starts with a clean slate.
 */
export class CommandCodeAccountPool {
  /** Rotation state by API key. */
  private readonly states = new Map<string, CommandCodeAccountState>()
  constructor(private readonly deps: CommandCodeAccountPoolDeps) {}

  /**
   * Resolve every slot's key, deduplicated by key (first slot wins). Slots
   * without any resolvable key are omitted — they still appear in the
   * settings page as unconfigured, they just cannot serve requests.
   */
  async resolvedAccounts(): Promise<ResolvedAccount[]> {
    const out: ResolvedAccount[] = []
    const seen = new Set<string>()
    for (const slot of this.deps.slots()) {
      const key = await this.resolveSlotKey(slot)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push({ slot, key, state: this.states.get(key) })
    }
    return out
  }

  /**
   * Every slot paired with its resolved key and rotation state — NOT
   * deduplicated: two slots sharing one credential both appear (the usage
   * view reports them individually), while slots without any resolvable key
   * are omitted. The serving path uses {@link resolvedAccounts} instead.
   */
  async describeAccounts(): Promise<ResolvedAccount[]> {
    const out: ResolvedAccount[] = []
    for (const slot of this.deps.slots()) {
      const key = await this.resolveSlotKey(slot)
      if (key === undefined) continue
      out.push({ slot, key, state: this.states.get(key) })
    }
    return out
  }

  /**
   * Hand out the first usable account's key (the manually preferred account
   * when usable, else rotation order). Returns `undefined` when no account
   * resolves any key at all (the caller then reports the missing credential).
   * Throws `RATE_LIMIT` — naming the earliest window reset — or
   * `INVALID_CREDENTIAL` when accounts exist but none can serve.
   *
   * `options.exclude` skips one key during the probe-revival pass: the
   * rotation hook excludes the just-rejected key so a probe that clears its
   * window cannot re-offer the same key within the same request (the adapter
   * refuses already-tried keys; the next request picks the revived key up).
   */
  async resolveKey(options?: { exclude?: string }): Promise<{ key: string; slot: CommandCodeAccountSlot } | undefined> {
    const accounts = await this.resolvedAccounts()
    if (accounts.length === 0) {
      return undefined
    }
    const chosen = selectActiveAccount(accounts, this.deps.preferredId?.())
    if (chosen !== undefined) return this.pick(chosen)

    // Every key is marked: probe the real windows before giving up. Disabled
    // (401) keys are not probed — an invalid key stays invalid.
    await Promise.all(accounts.map(async (account) => {
      if (account.state?.kind === 'disabled') return
      if (options?.exclude !== undefined && account.key === options.exclude) return
      const probe = await this.deps.probeWindow(account.key)
      if (probe === undefined) return
      if (!probe.exceeded) {
        this.states.delete(account.key)
      } else {
        this.states.set(account.key, {
          kind: 'cooldown',
          reason: account.state?.reason ?? 'rate limited (429)',
          until: probe.resetAt,
        })
      }
    }))

    const revived = selectActiveAccount(await this.resolvedAccounts(), this.deps.preferredId?.())
    if (revived !== undefined) return this.pick(revived)

    const latest = await this.resolvedAccounts()
    const disabled = latest.filter((account) => account.state?.kind === 'disabled')
    if (disabled.length === latest.length) {
      throw new LlmError(
        `llm-commandcode: every configured Command Code account (${latest.length}) was rejected with 401`
          + ' — check the stored API keys (Models page / settings) or the auth file',
        'INVALID_CREDENTIAL',
      )
    }
    const resets = latest
      .map((account) => account.state)
      .filter((state): state is CommandCodeAccountState => state !== undefined && state.kind === 'cooldown' && state.until > 0)
      .map((state) => state.until)
    const earliest = resets.length > 0 ? Math.min(...resets) : 0
    throw new LlmError(
      `llm-commandcode: all ${latest.length} Command Code account(s) have exhausted their usage window`
        + (earliest > 0 ? `; the earliest window resets at ${clockLabel(earliest)}` : '')
        + ' — requests will succeed again after the reset (or add another account)',
      'RATE_LIMIT',
    )
  }

  /**
   * Record a rejection against one key. `rate-limit` (429) marks the key
   * exhausted with an unknown reset (probed lazily at the next resolution
   * once every account is marked); `invalid-credential` (401) disables the
   * key until the stored credential changes.
   */
  markRejected(apiKey: string, rejection: AccountRejection): void {
    if (rejection === 'invalid-credential') {
      this.states.set(apiKey, { kind: 'disabled', reason: 'invalid API key (401)', until: 0 })
    } else {
      this.states.set(apiKey, { kind: 'unknown', reason: 'rate limited (429)', until: 0 })
    }
  }

  /** One account's key: literal → credential seam → auth file (default slot). */
  private async resolveSlotKey(slot: CommandCodeAccountSlot): Promise<string | undefined> {
    if (slot.literal !== undefined && slot.literal !== '') return slot.literal
    if (slot.ref !== undefined) {
      const hit = await this.deps.resolveRef(slot.ref)
      if (hit !== undefined && hit !== '') return hit
    }
    if (slot.allowAuthFile) {
      const fromFile = this.deps.authFileKey()
      if (fromFile !== undefined && fromFile !== '') return fromFile
    }
    return undefined
  }

  /** Hand out the chosen account's key. */
  private pick(account: ResolvedAccount): { key: string; slot: CommandCodeAccountSlot } {
    return { key: account.key, slot: account.slot }
  }
}
