/**
 * Multi-account pool for the Command Code provider (host side).
 *
 * One Command Code subscription (e.g. the Go plan's 5-hour window) is
 * metered; a user with several subscriptions wants a request that hits one
 * account's limit to continue on the next account without a visible failure.
 * This module owns that rotation:
 *
 *   - {@link CommandCodeAccountPool.resolveKey} hands out the first account
 *     whose key is not currently marked exhausted — or, when the request's
 *     model matches a {@link CommandCodeModelAccountRule} and that account is
 *     usable, the routed account — resolving each slot's key lazily (literal
 *     config key → credential seam → launch environment → the official CLI
 *     auth file for the default slot only).
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

/**
 * Upper bound on the retry wait this pool attaches to the all-exhausted
 * `RATE_LIMIT` error. Must equal the `backoff.maxDelayMs` in the adapter's
 * `providerRetryPolicy` (which imports it from here): dsh-llm-retry honors a
 * provider-specified wait verbatim only at or below that cap — in normal mode
 * a LONGER attached wait makes the executor abandon the retry entirely
 * instead of falling back to local backoff, which would turn "poll until the
 * window opens" into "fail now".
 */
export const RETRY_MAX_DELAY_MS = 900_000

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
  /**
   * Model → account routing rules, re-read per resolution so settings changes
   * apply live. Each rule lists catalog model ids (see
   * {@link CommandCodeModelAccountRule}) to an account slot id. When the
   * request's model matches a rule and that account is usable, it serves
   * before the preferred/rotation selection; an unusable routed account falls
   * back to the normal selection (the router is a hint, never a hard gate).
   */
  modelAccountRules?(): readonly CommandCodeModelAccountRule[]
}

/**
 * One "route these models to that account" rule. `models` lists catalog ids
 * (`deepseek/deepseek-v4-pro`, …); `account` is a slot id (`default` or an
 * extra account's credential reference). A request whose model id is in the
 * list routes to that account. The first matching rule in list order wins.
 */
export interface CommandCodeModelAccountRule {
  /** Catalog model ids to match against the request's model. */
  models: string[]
  /** Account slot id to prefer for matching models. */
  account: string
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
 * The first routing rule whose model list contains the request's model id.
 * Undefined when no rule matches.
 */
export function matchModelRule(
  model: string,
  rules: readonly CommandCodeModelAccountRule[] | undefined,
): CommandCodeModelAccountRule | undefined {
  if (model === '' || rules === undefined || rules.length === 0) return undefined
  for (const rule of rules) {
    if (rule.models.includes(model)) return rule
  }
  return undefined
}

/**
 * The routed account for a request's model: the first usable account whose
 * slot id matches the first matching rule's target. Undefined when no rule
 * matches or the routed account is not usable (the caller then falls back to
 * the normal preferred/rotation selection).
 */
export function selectAccountForModel(
  accounts: readonly ResolvedAccount[],
  model: string,
  rules: readonly CommandCodeModelAccountRule[] | undefined,
): ResolvedAccount | undefined {
  const rule = matchModelRule(model, rules)
  if (rule === undefined) return undefined
  return accounts.find((account) => account.slot.id === rule.account && accountUsable(account.state))
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
   * Hand out the key for a request: the model-routed account when the
   * request's model matches a rule (and that account is usable), else the
   * manually preferred account when usable, else the first usable account in
   * rotation order. Returns `undefined` when no account resolves any key at
   * all (the caller then reports the missing credential). Throws
   * `RATE_LIMIT` — naming the earliest window reset — or
   * `INVALID_CREDENTIAL` when accounts exist but none can serve.
   *
   * `options.model` is the request's model id; routing rules re-read per
   * resolution, so a settings change applies live.
   *
   * `options.exclude` skips one key during the probe-revival pass: the
   * rotation hook excludes the just-rejected key so a probe that clears its
   * window cannot re-offer the same key within the same request (the adapter
   * refuses already-tried keys; the next request picks the revived key up).
   */
  async resolveKey(options?: { exclude?: string; model?: string }): Promise<{ key: string; slot: CommandCodeAccountSlot } | undefined> {
    const accounts = await this.resolvedAccounts()
    if (accounts.length === 0) {
      return undefined
    }
    const routed = selectAccountForModel(accounts, options?.model ?? '', this.deps.modelAccountRules?.())
    if (routed !== undefined) return this.pick(routed)
    const preferred = this.deps.preferredId?.()
    const chosen = selectActiveAccount(accounts, preferred)
    if (chosen !== undefined) return this.pick(chosen)

    // Every key is marked: probe the real windows before giving up. Disabled
    // (401) keys are not probed — an invalid key stays invalid. A throwing
    // probe counts as "unknown" (like a failed probe): it must not turn the
    // all-exhausted path into a raw rejection instead of RATE_LIMIT.
    await Promise.all(accounts.map(async (account) => {
      if (account.state?.kind === 'disabled') return
      if (options?.exclude !== undefined && account.key === options.exclude) return
      let probe: FiveHourWindowProbe | undefined
      try {
        probe = await this.deps.probeWindow(account.key)
      } catch {
        return
      }
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

    // Re-resolve once: the probe pass above may have revived keys (fresh
    // states), and both the revival check and the error classification read
    // the same post-probe snapshot. (Each resolvedAccounts() re-runs the
    // async seams, so two calls — not three — is the minimum here.)
    const latest = await this.resolvedAccounts()
    const revived = selectActiveAccount(latest, preferred)
    if (revived !== undefined) return this.pick(revived)

    const disabled = latest.filter((account) => account.state?.kind === 'disabled')
    if (disabled.length === latest.length) {
      throw new LlmError(
        `llm-commandcode: every configured Command Code account (${latest.length}) was rejected with 401`
          + ' — check the stored API keys (Models page / settings) or re-run command-code login',
        'INVALID_CREDENTIAL',
      )
    }
    const resets = latest
      .map((account) => account.state)
      .filter((state): state is CommandCodeAccountState => state !== undefined && state.kind === 'cooldown' && state.until > 0)
      .map((state) => state.until)
    const earliest = resets.length > 0 ? Math.min(...resets) : 0
    // Hand dsh-llm-retry the exact wait until the earliest known reset so the
    // retry policy sleeps through the window instead of polling at its
    // backoff cadence. Capped at RETRY_MAX_DELAY_MS: the executor honors a
    // provider wait verbatim only at or below the policy's maxDelayMs — a
    // LONGER attached wait makes it abandon the retry entirely (normal mode),
    // which would turn "poll until the window opens" into "fail now". Longer
    // resets simply ride the capped local backoff and the probe revival.
    const wait = earliest > 0 ? Math.max(1000, earliest - Date.now()) : 0
    throw new LlmError(
      `llm-commandcode: all ${latest.length} Command Code account(s) have exhausted their usage window`
        + (earliest > 0 ? `; the earliest window resets at ${clockLabel(earliest)}` : '')
        + ' — requests succeed again after the reset (or add another account)',
      'RATE_LIMIT',
      wait > 0 && wait <= RETRY_MAX_DELAY_MS ? { providerRetryAfterMs: wait } : undefined,
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

  /**
   * One account's key: literal → credential seam → auth file (default slot).
   *
   * Every source is normalized here, at the single point where a slot's key
   * enters the pool. The adapter sends the key through the harness's
   * `assertUsableApiKey()`, which trims it — a stored key from the credentials
   * seam, a `.env` line, or a shell export all pick up surrounding whitespace
   * — and reports that trimmed form back to `markRejected()`. Returning the
   * raw value would file every 429/401 mark under a key no later lookup can
   * find: rotation would re-offer the same account, the account card would show
   * no mark, and the usage endpoints would 401 while chat kept working.
   * Normalizing once makes resolution, probing, marking, and the request path
   * agree on one string.
   */
  private async resolveSlotKey(slot: CommandCodeAccountSlot): Promise<string | undefined> {
    if (slot.literal !== undefined) {
      const literal = normalizeResolvedKey(slot.literal)
      if (literal !== undefined) return literal
    }
    if (slot.ref !== undefined) {
      const hit = await this.deps.resolveRef(slot.ref)
      if (hit !== undefined) {
        const resolved = normalizeResolvedKey(hit)
        if (resolved !== undefined) return resolved
      }
    }
    if (slot.allowAuthFile) {
      const fromFile = this.deps.authFileKey()
      if (fromFile !== undefined) {
        const fileKey = normalizeResolvedKey(fromFile)
        if (fileKey !== undefined) return fileKey
      }
    }
    return undefined
  }

  /** Hand out the chosen account's key. */
  private pick(account: ResolvedAccount): { key: string; slot: CommandCodeAccountSlot } {
    return { key: account.key, slot: account.slot }
  }
}

/**
 * Normalize one resolved credential to the form every consumer sees. Trim
 * only: a blank-after-trim value means "no key" (the slot is omitted and the
 * caller reports `MISSING_CREDENTIAL`), while characters an HTTP header cannot
 * carry are left for `assertUsableApiKey()` to reject with its own message.
 */
function normalizeResolvedKey(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
