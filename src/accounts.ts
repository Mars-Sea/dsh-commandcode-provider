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
 *   - An account the user explicitly asked for — the manual pin
 *     ({@link CommandCodeAccountPoolDeps.preferredId}) or a model rule's
 *     routed account — is probed the same way when a mark would demote it, so
 *     a fallback is never permanent (issue #51).
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

/**
 * How long an explicitly selected account's rate-limit mark may stand before
 * its window is probed again. A 429 whose reset was never learned marks the
 * key `unknown`, which {@link accountUsable} refuses forever — deliberately,
 * because the all-marked revival pass is the only thing meant to clear it and
 * it costs one billing call per key. That is fine for a key nobody asked for,
 * and wrong for the one the user pinned: a single 429 would otherwise demote
 * the user's own selection until the process restarts (issue #51). The probe
 * is therefore allowed once per interval per key, which bounds an endpoint
 * that keeps failing while a successful probe resolves the mark for good.
 */
const EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS = 60_000

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

/**
 * One account's real rate-limit state, probed from `/alpha/billing/credits`:
 * `exceeded` is true when ANY of the account's usage windows is spent, and
 * `resetAt` is the latest reset among them (the binding constraint — an open
 * five-hour window buys nothing while the weekly quota is exhausted).
 */
export interface AccountWindowProbe {
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
  /**
   * Probe one key's usage windows — BOTH windows the endpoint publishes (the
   * five-hour and the weekly one), not just the five-hour one; see
   * {@link AccountWindowProbe}. Undefined when the probe itself failed.
   */
  probeWindow(apiKey: string): Promise<AccountWindowProbe | undefined>
  /**
   * The manually selected account (a slot id, e.g. `default` or an extra's
   * credential reference), re-read per resolution. The preferred account
   * serves whenever it is usable; an unknown id or an exhausted preferred
   * account falls back to the first usable slot — and an exhausted one is
   * re-probed on the way (see {@link CommandCodeAccountPool.resolveKey}), so
   * the fallback lasts only as long as the window really is exceeded.
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
  /**
   * Clock seam for the explicit-account probe throttle. Tests drive it so the
   * "the interval elapsed, probe again" half of
   * {@link CommandCodeAccountPool.canProbeExplicit} is reachable without
   * waiting a real minute; production reads `Date.now()`.
   */
  now?(): number
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
  /** Last explicit-revival probe attempt by API key (throttles a failing probe). */
  private readonly explicitProbes = new Map<string, number>()
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
   * `options.tried` lists the keys this request has already used — the
   * just-rejected one included. They are removed from the resolution entirely,
   * which is what lets one request walk a four-account pool: an account-scoped
   * rejection that does not mark the key (no credits, a model outside the
   * account's plan) would otherwise be offered again on every attempt, and the
   * accounts behind it would never be reached.
   *
   * An explicit selection (the pin or a model rule) that a rate-limit mark
   * would demote is probed before the fallback serves, so "falls back while
   * exhausted" never becomes "stays demoted until the process restarts".
   */
  async resolveKey(options?: { tried?: readonly string[]; model?: string }): Promise<{ key: string; slot: CommandCodeAccountSlot } | undefined> {
    const accounts = await this.resolvedAccounts()
    if (accounts.length === 0) {
      return undefined
    }
    // One filter for the whole resolution: the routed, pinned, rotating and
    // probe-revival paths must all agree on which accounts are still in play.
    const tried = options?.tried
    const available = tried === undefined || tried.length === 0
      ? accounts
      : accounts.filter((account) => !tried.includes(account.key))
    const preferred = this.deps.preferredId?.()
    // Every account was already tried in this request. Nothing can be handed
    // back: an account that is merely UNMARKED (a plan or balance rejection
    // marks nothing) leaves the caller's own rejection as the honest answer,
    // so return undefined and let it surface. When every account is marked
    // instead, the pool still owes its own diagnosis — the earliest window
    // reset, with the wait the retry policy sleeps on — and it is built from
    // the marks as they stand, without probing: a probe here would answer a
    // question this request cannot act on, and reviving a key mid-request
    // would make the diagnosis below describe an account that is usable again.
    const diagnoseOnly = available.length === 0
    if (diagnoseOnly) {
      if (selectActiveAccount(accounts, preferred) !== undefined) return undefined
      throw allAccountsUnusable(accounts)
    }
    const routed = selectAccountForModel(available, options?.model ?? '', this.deps.modelAccountRules?.())
    if (routed !== undefined) return this.pick(routed)
    const chosen = selectActiveAccount(available, preferred)
    if (chosen !== undefined) {
      // The explicit account is unusable while another one can serve — the
      // fallback path. Its mark is re-checked against the real window before
      // the user's own selection is demoted for good (issue #51).
      const explicit = this.explicitAccount(available, options?.model ?? '', preferred)
      if (
        explicit !== undefined
        && explicit.key !== chosen.key
        && this.canProbeExplicit(explicit)
      ) {
        const revived = await this.probeExplicit(explicit)
        if (revived !== undefined) return this.pick(revived)
      }
      return this.pick(chosen)
    }

    // Every account still in play is marked: probe the real windows before
    // giving up. Disabled (401) keys are not probed — an invalid key stays
    // invalid. A throwing probe counts as "unknown" (like a failed probe): it
    // must not turn the all-exhausted path into a raw rejection instead of
    // RATE_LIMIT.
    await Promise.all(available.map(async (account) => {
      if (account.state?.kind === 'disabled') return
      let probe: AccountWindowProbe | undefined
      try {
        probe = await this.deps.probeWindow(account.key)
      } catch {
        return
      }
      if (probe === undefined) return
      if (!probe.exceeded) {
        this.states.delete(account.key)
        return
      }
      // A known reset becomes a cooldown that expires by itself. An UNKNOWN one
      // must not: `until: 0` would read as "never usable again" to
      // {@link accountUsable} and take the account out of service for the rest
      // of the process — the very permanence this pool must not have. Keeping
      // the `unknown` mark leaves it eligible for the next probe.
      if (probe.resetAt > 0) {
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
    // async seams, so two calls — not three — is the minimum here.) The tried
    // keys stay filtered out: a probe that clears one must not re-offer a key
    // this request already burned, which is what the adapter refuses anyway.
    const latestAccounts = await this.resolvedAccounts()
    const latest = tried === undefined || tried.length === 0
      ? latestAccounts
      : latestAccounts.filter((account) => !tried.includes(account.key))
    const revived = selectActiveAccount(latest, preferred)
    if (revived !== undefined) return this.pick(revived)

    // Nothing still in play can serve — but an account this request already
    // used may be UNMARKED, because an `unavailable` rejection (no credits, a
    // model outside this account's plan) deliberately marks nothing. That
    // rejection is the honest answer, and returning undefined is how the caller
    // gets to surface it. Throwing the pool's own diagnosis instead would name
    // the wrong cause, count only the tried-filtered subset, and — for
    // RATE_LIMIT — hand dsh-llm-retry a wait that turns a PERMANENT failure
    // into a ~15-minute stall. The no-account-left branch above applies exactly
    // this rule; the two disagreed before, on the very case issue #51's
    // follow-up is about.
    if (selectActiveAccount(latestAccounts, preferred) !== undefined) return undefined
    // The diagnosis always describes the POOL. A second resolution that came
    // back empty — a transient credential-store miss, not a configuration
    // change — would otherwise report "every configured account (0) was
    // rejected with 401", naming neither an account nor a real cause.
    throw allAccountsUnusable(latestAccounts.length > 0 ? latestAccounts : accounts)
  }

  /**
   * Record a rejection against one key. `rate-limit` marks the key exhausted
   * (`429`/`RATE_LIMITED`) — as a `cooldown` until `resetAtMs` when the
   * rejection body published the provider's own reset time, otherwise as an
   * `unknown` mark whose reset is probed lazily — and `invalid-credential`
   * (401) disables the key until the stored credential changes.
   *
   * `resetAtMs` is seconds-to-millis converted by the adapter from the
   * provider's `error.rateLimit.reset`: knowing the real reset immediately is
   * what keeps an exhausted account out of rotation for exactly as long as the
   * provider said, instead of until a probe happens to run.
   */
  markRejected(apiKey: string, rejection: AccountRejection, resetAtMs?: number): void {
    if (rejection === 'invalid-credential') {
      this.states.set(apiKey, { kind: 'disabled', reason: 'invalid API key (401)', until: 0 })
    } else if (resetAtMs !== undefined && resetAtMs > Date.now()) {
      this.states.set(apiKey, { kind: 'cooldown', reason: 'rate limited (429)', until: resetAtMs })
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

  /**
   * The account the user explicitly asked for: the slot a model rule routes
   * the request to when that id exists among the resolved slots, else the
   * manually pinned slot. Consulted only on the fallback path — a usable
   * routed account already returned above — so unlike
   * {@link selectAccountForModel} it does NOT require the account to be
   * usable, which is exactly what {@link resolveKey} re-probes.
   */
  private explicitAccount(
    accounts: readonly ResolvedAccount[],
    model: string,
    preferredId: string | undefined,
  ): ResolvedAccount | undefined {
    const rule = matchModelRule(model, this.deps.modelAccountRules?.())
    const id = rule !== undefined && accounts.some((account) => account.slot.id === rule.account)
      ? rule.account
      : preferredId
    return id === undefined ? undefined : accounts.find((account) => account.slot.id === id)
  }

  /**
   * Whether an explicitly selected account's mark is due for a window probe.
   * Only an `unknown` mark (a 429 whose reset was never learned) is worth
   * re-probing: a `cooldown` already carries its reset time and expires by
   * itself, and a `disabled` (401) key stays out until the stored credential
   * changes. The interval bounds a probe endpoint that keeps failing.
   */
  private canProbeExplicit(account: ResolvedAccount): boolean {
    if (account.state?.kind !== 'unknown') return false
    const last = this.explicitProbes.get(account.key)
    return last === undefined || this.now() - last >= EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS
  }

  /** The clock the probe throttle reads; injected so a test can travel in time. */
  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Probe one explicitly selected account's window and apply the answer. A
   * window that is no longer exceeded drops the mark, so the user's own
   * selection serves again on this very request. An exceeded one is stamped
   * as a cooldown carrying the provider's reset time, after which
   * {@link accountUsable} lets the account back in with no further probe. A
   * probe that fails changes nothing: the mark stays `unknown` and the next
   * attempt waits out the interval.
   */
  private async probeExplicit(account: ResolvedAccount): Promise<ResolvedAccount | undefined> {
    this.explicitProbes.set(account.key, this.now())
    let probe: AccountWindowProbe | undefined
    try {
      probe = await this.deps.probeWindow(account.key)
    } catch {
      return undefined
    }
    if (probe === undefined) return undefined
    if (!probe.exceeded) {
      this.states.delete(account.key)
      // The throttle timestamp SURVIVES the revival. Deleting it read as "this
      // key was never probed", so the next request probed again — and the loop
      // that follows is exactly the one the interval exists to bound: the probe
      // says the window is open, the chat endpoint answers 429 anyway (a spend
      // cap or a model-level limit is invisible to `windowLimits`), the mark
      // returns to `unknown`, and the next request probes once more — one
      // billing GET plus one doomed upstream attempt per request, forever.
      // Keeping the stamp costs nothing when the revival was right: a serving
      // account is never probed at all, and the mark only comes back if the
      // provider rejects it again, which is when the interval should apply.
      return { slot: account.slot, key: account.key, state: undefined }
    }
    // A reset time is what makes the mark expire on its own; without one the
    // mark stays `unknown`, so a later probe can still learn it.
    if (probe.resetAt > 0) {
      this.states.set(account.key, {
        kind: 'cooldown',
        reason: account.state?.reason ?? 'rate limited (429)',
        until: probe.resetAt,
      })
    }
    return undefined
  }

  /** Hand out the chosen account's key. */
  private pick(account: ResolvedAccount): { key: string; slot: CommandCodeAccountSlot } {
    return { key: account.key, slot: account.slot }
  }
}

/**
 * The error for "accounts exist but none of them can serve": all-401 becomes
 * `INVALID_CREDENTIAL`, anything else `RATE_LIMIT` naming the earliest known
 * window reset. Shared by the all-marked tail of {@link CommandCodeAccountPool.resolveKey}
 * and by its already-tried diagnosis, so the two can never drift apart.
 *
 * The attached `providerRetryAfterMs` is the exact wait until the earliest
 * known reset, so dsh-llm-retry sleeps through the window instead of polling
 * at its backoff cadence. It is capped at {@link RETRY_MAX_DELAY_MS}: the
 * executor honors a provider wait verbatim only at or below the policy's
 * `maxDelayMs` — a LONGER attached wait makes it abandon the retry entirely
 * (normal mode), which would turn "poll until the window opens" into "fail
 * now". Longer resets simply ride the capped local backoff and the probe
 * revival.
 */
function allAccountsUnusable(accounts: readonly ResolvedAccount[]): LlmError {
  const disabled = accounts.filter((account) => account.state?.kind === 'disabled')
  if (disabled.length === accounts.length) {
    // Bilingual: the harness UI renders this message verbatim inside its
    // (already localized) retry/turn-error chrome, so both languages ride
    // in one string — English first, then the Chinese reading.
    return new LlmError(
      `llm-commandcode: every configured Command Code account (${accounts.length}) was rejected with 401`
        + ' — check the stored API keys (Models page / settings) or the auth file'
        + `；已配置的 ${accounts.length} 个 Command Code 账户密钥均被拒绝（401）`
        + '——请在设置页检查存储的 API 密钥，或重新运行 command-code login',
      'INVALID_CREDENTIAL',
    )
  }
  const resets = accounts
    .map((account) => account.state)
    .filter((state): state is CommandCodeAccountState => state !== undefined && state.kind === 'cooldown' && state.until > 0)
    .map((state) => state.until)
  const earliest = resets.length > 0 ? Math.min(...resets) : 0
  const wait = earliest > 0 ? Math.max(1000, earliest - Date.now()) : 0
  return new LlmError(
    `llm-commandcode: all ${accounts.length} Command Code account(s) have exhausted their usage window`
      + (earliest > 0 ? `; the earliest window resets at ${clockLabel(earliest)}` : '')
      + ' — requests will succeed again after the reset (or add another account)'
      + `；已用尽全部 ${accounts.length} 个 Command Code 账户的用量窗口`
      + (earliest > 0 ? `，最早的重置时间为 ${clockLabel(earliest)}` : '')
      + '——窗口重置后请求会自动恢复（也可以添加更多账户）',
    'RATE_LIMIT',
    wait > 0 && wait <= RETRY_MAX_DELAY_MS ? { providerRetryAfterMs: wait } : undefined,
  )
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
