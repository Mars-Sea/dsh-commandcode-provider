/**
 * Multi-account pool for the Command Code provider (host side).
 *
 * One subscription's 5-hour window is metered, and a user with several wants a
 * request that hits one account's limit to continue on the next without a
 * visible failure. Rotation is passive: a key is marked only on a real
 * pre-stream rejection, and when nothing can serve, marked keys are revived by
 * probing their real usage windows.
 *
 * The non-obvious rules — which rejection may be REPORTED as a spent window, why
 * a fallback is never permanent, what an explicitly selected account's probe
 * costs — are stated at the members below, and recorded in full in AGENTS.md.
 *
 * Cordis-free like the adapter: every host fact arrives through injected thunks,
 * so node tests can drive the pool directly.
 *
 * @module dsh-commandcode-provider/accounts
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { THROTTLED_CODE } from './transient-retry.ts'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Upper bound on the retry wait attached to the all-exhausted `RATE_LIMIT`.
 * Must equal the adapter's `backoff.maxDelayMs`: dsh-llm-retry honors a
 * provider wait verbatim only at or below that cap — a longer one abandons the
 * retry instead of falling back to local backoff, turning "poll until the
 * window opens" into "fail now".
 */
export const RETRY_MAX_DELAY_MS = 900_000

/**
 * How long an explicitly selected account's rate-limit mark may stand before
 * its window is probed again. Without this, a single 429 on the user's pinned
 * account demotes it until the process restarts (issue #51); probing at most
 * once per interval per key bounds a probe endpoint that keeps failing.
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

/**
 * Why a key stopped serving requests, split by EVIDENCE — what the pool may
 * claim about it — rather than by what it does.
 *
 * `rate-limit` is a USAGE-WINDOW rejection: the provider named one of its
 * metered windows (`error.rateLimit.window`, or a message saying the plan's
 * usage limit was reached — the only two shapes the official CLI's own
 * `parseWindowLimitError`/`resolveWindowLabel` accept). `throttled` is the plain
 * 429: the key leaves rotation for now, but the provider said nothing about a
 * window, so the pool must not describe one as exhausted. Collapsing the two is
 * issue #54: a bare 429 was reported as a spent window while the account card
 * showed both windows barely used.
 */
export type AccountRejection = 'rate-limit' | 'throttled' | 'invalid-credential'

/** One key's rotation state. */
export interface CommandCodeAccountState {
  kind:
    /** Marked by a 429; the window's reset time is unknown until probed. */
    | 'unknown'
    /** Probed (or marked with a known reset): unusable until `until` (millis). */
    | 'cooldown'
    /** Marked by a 401: skipped until the stored credential changes. */
    | 'disabled'
  /**
   * The evidence behind the mark — what the pool may CLAIM when it reports that
   * no account can serve. `window`: the provider named a usage window, or a
   * `/alpha/billing/credits` probe read one as exceeded. `throttle`: a 429 that
   * said nothing about a window (a burst limiter, or a model-/spend-level limit
   * the billing endpoint cannot show). `auth`: a 401.
   */
  cause: 'window' | 'throttle' | 'auth'
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
  /** Probe one key's usage windows (BOTH windows the endpoint publishes); undefined when it failed. */
  probeWindow(apiKey: string): Promise<AccountWindowProbe | undefined>
  /**
   * The manually selected account slot id, re-read per resolution. It serves
   * whenever it is usable; an unknown id or an exhausted preferred account falls
   * back to the first usable slot — and an exhausted one is re-probed on the way
   * (see {@link CommandCodeAccountPool.resolveKey}), so the fallback lasts only
   * as long as the window really is exceeded.
   */
  preferredId?(): string | undefined
  /**
   * Model → account routing rules, re-read per resolution so settings changes
   * apply live. A matching, usable routed account serves before the
   * preferred/rotation selection; an unusable one falls back to the normal
   * selection — the router is a hint, never a hard gate.
   */
  modelAccountRules?(): readonly CommandCodeModelAccountRule[]
  /**
   * Clock seam for the explicit-account probe throttle, so the "the interval
   * elapsed" half of {@link CommandCodeAccountPool.canProbeExplicit} is testable
   * without waiting a real minute. Production reads `Date.now()`.
   */
  now?(): number
}

/**
 * One "route these models to that account" rule. `models` lists catalog ids
 * (`deepseek/deepseek-v4-pro`, …); `account` is a slot id (`default` or an extra
 * account's credential reference). The first matching rule in list order wins.
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
 * Pick the account that should serve now: the manually preferred slot when it is
 * usable, otherwise the first usable account in rotation order; undefined when
 * no account is usable. Shared by the pool (request path) and the plugin entry
 * (the usage view's active badge) so both always agree.
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

/** 不包含解析秘密的账号定义；作用域独立复制列表及模型规则。 */
export interface CommandCodeAccountSelection {
  slots: readonly CommandCodeAccountSlot[]
  preferredId?: string | undefined
  modelAccountRules: readonly CommandCodeModelAccountRule[]
}

/** 仅复制账号定义；凭据服务的秘密仍在每次解析时读取。 */
export function captureAccountSelection(selection: CommandCodeAccountSelection): CommandCodeAccountSelection {
  return Object.freeze({
    slots: Object.freeze(selection.slots.map(slot => Object.freeze({ ...slot }))),
    preferredId: selection.preferredId,
    modelAccountRules: Object.freeze(selection.modelAccountRules.map(rule => {
      const models = [...rule.models]
      Object.freeze(models)
      return Object.freeze({ ...rule, models })
    })),
  })
}

/** 账号选择与展示共用恢复规则；宿主作用域内的状态按网关与密钥共享。 */
export class CommandCodeAccountPool {
  /** 当前作用域内按密钥共享的健康状态；不记录到日志。 */
  private states = new Map<string, CommandCodeAccountState>()
  /** 当前网关与密钥的显式探测时间，限制失败探测的频率。 */
  private explicitProbes = new Map<string, number>()
  private scopedStates = new Map<string, { states: Map<string, CommandCodeAccountState>; probes: Map<string, number> }>()
  constructor(private readonly deps: CommandCodeAccountPoolDeps) {}

  /** 每个调用持有自己的定义和探测，只有同网关的健康事实共享；不临时改写全局依赖。 */
  scope(context: CommandCodeAccountSelection & { apiBase: string; probeWindow: CommandCodeAccountPoolDeps['probeWindow'] }): CommandCodeAccountPool {
    const selection = captureAccountSelection(context)
    let shared = this.scopedStates.get(context.apiBase)
    if (shared === undefined) {
      shared = { states: new Map(), probes: new Map() }
      this.scopedStates.set(context.apiBase, shared)
    }
    const scoped = new CommandCodeAccountPool({
      ...this.deps,
      slots: () => selection.slots,
      preferredId: () => selection.preferredId,
      modelAccountRules: () => selection.modelAccountRules,
      probeWindow: context.probeWindow,
    })
    scoped.states = shared.states
    scoped.explicitProbes = shared.probes
    scoped.scopedStates = this.scopedStates
    return scoped
  }

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
   * Hand out the key for a request: the model-routed account when usable, else
   * the manually preferred account when usable, else the first usable account
   * in rotation order. Returns `undefined` when no account resolves any key,
   * or when an account this request already used is still UNMARKED — the
   * caller's own rejection is the honest answer then. Throws `RATE_LIMIT` /
   * `INVALID_CREDENTIAL` when every account is marked.
   *
   * `options.tried` lists the keys this request already used; they are removed
   * from the resolution entirely, which is what lets one request walk a
   * four-account pool. An explicit selection (pin or model rule) that a
   * rate-limit mark would demote is probed first, so a fallback never becomes
   * permanent (issue #51). Scoped rules stay fixed for the call; credential values re-resolve.
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
    // Every account was already tried in this request: an UNMARKED account
    // leaves the caller's own rejection as the honest answer; when every
    // account is marked instead, the pool owes its own diagnosis — built from
    // the marks as they stand, WITHOUT probing (a probe here answers a
    // question this request cannot act on).
    const diagnoseOnly = available.length === 0
    if (diagnoseOnly) {
      if (selectActiveAccount(accounts, preferred) !== undefined) return undefined
      throw allAccountsUnusable(accounts)
    }
    const routed = selectAccountForModel(available, options?.model ?? '', this.deps.modelAccountRules?.())
    if (routed !== undefined) return this.pick(routed)
    const chosen = selectActiveAccount(available, preferred)
    if (chosen !== undefined) {
      const revived = await this.reviveExplicit(available, options?.model ?? '', preferred, chosen)
      return this.pick(revived ?? chosen)
    }

    // Every account still in play is marked: probe the real windows before
    // giving up.
    await this.probeAllMarked(available)

    // Re-resolve once: the probe pass above may have revived keys, and both the
    // revival check and the error classification read the same post-probe
    // snapshot. (Each resolvedAccounts() re-runs the async seams, so two calls
    // is the minimum here.) The tried keys stay filtered out: a probe that
    // cleared one must not re-offer a key this request already burned.
    const latestAccounts = await this.resolvedAccounts()
    const latest = tried === undefined || tried.length === 0
      ? latestAccounts
      : latestAccounts.filter((account) => !tried.includes(account.key))
    const revived = selectActiveAccount(latest, preferred)
    if (revived !== undefined) return this.pick(revived)

    // Nothing still in play can serve — but an account this request already used
    // may be UNMARKED, because an `unavailable` rejection (no credits, a model
    // outside this account's plan) deliberately marks nothing, and that
    // rejection is the honest answer: returning undefined is how the caller
    // surfaces it. The pool's own diagnosis would name the wrong cause, count
    // only the tried subset, and hand dsh-llm-retry a wait that turns a
    // PERMANENT failure into a ~15-minute stall. The all-tried branch above
    // applies exactly this rule.
    if (selectActiveAccount(latestAccounts, preferred) !== undefined) return undefined
    // The diagnosis always describes the POOL. A second resolution that came
    // back empty — a transient credential-store miss, not a configuration
    // change — would otherwise report "every configured account (0) was
    // rejected with 401", naming neither an account nor a real cause.
    throw allAccountsUnusable(latestAccounts.length > 0 ? latestAccounts : accounts)
  }

  /**
   * Which account is serving right now, for display (the settings page's
   * account card, the sidebar usage stats) — without consuming a request's
   * `tried` budget and without throwing when nothing can serve.
   *
   * Reads and self-heals exactly like {@link resolveKey} would: an `unknown`
   * mark on the pinned account is re-probed (throttled the same way, sharing
   * the same per-key timestamp), and a pool where nothing currently resolves
   * gets one batch probe pass too. Without this, the badge read a possibly
   * stale mark forever — nothing but an actual generate request ever cleared
   * an `unknown` mark, so a page left open with no chat activity kept
   * showing "switched to the fallback account" long after a real request
   * would have quietly recovered (issue #51's follow-up report: the account
   * card and the sidebar stats both stuck on the wrong account).
   *
   * No `model` parameter: the badge describes the pool as a whole, not one
   * request, so model-routing rules are deliberately not consulted here —
   * matching what the direct `selectActiveAccount` call this replaces did.
   */
  async activeAccount(): Promise<ResolvedAccount | undefined> {
    const accounts = await this.resolvedAccounts()
    if (accounts.length === 0) return undefined
    const preferred = this.deps.preferredId?.()
    const chosen = selectActiveAccount(accounts, preferred)
    if (chosen !== undefined) {
      const revived = await this.reviveExplicit(accounts, '', preferred, chosen)
      return revived ?? chosen
    }
    await this.probeAllMarked(accounts)
    return selectActiveAccount(await this.resolvedAccounts(), preferred)
  }

  /**
   * Record a rejection against one key. A `throttled` rejection (the plain 429
   * that named no window) marks the key with the `throttle` cause, leaving
   * rotation exactly like a window mark but keeping the pool's own diagnosis at
   * "rate limited" rather than inventing an exhausted window. `rate-limit`
   * marks a `cooldown` until `resetAtMs` when the body named the provider's own
   * reset, otherwise an `unknown` mark whose window is probed lazily.
   * `invalid-credential` (401) disables the key until the stored credential
   * changes.
   *
   * `resetAtMs` is seconds-to-millis converted by the adapter from
   * `error.rateLimit.reset`; it applies to a window mark only. A plain throttle
   * keeps its window unknown on purpose, so a probe can still find out.
   */
  markRejected(apiKey: string, rejection: AccountRejection, resetAtMs?: number): void {
    if (rejection === 'invalid-credential') {
      this.states.set(apiKey, { kind: 'disabled', cause: 'auth', reason: 'invalid API key (401)', until: 0 })
    } else if (rejection === 'throttled') {
      // Deliberately NOT a cooldown from `resetAtMs`: a throttle carries no
      // window fact, and the `unknown` mark is what keeps the key eligible for
      // the window probe that can still find a real one.
      this.states.set(apiKey, { kind: 'unknown', cause: 'throttle', reason: 'rate limited (429)', until: 0 })
    } else if (resetAtMs !== undefined && resetAtMs > Date.now()) {
      this.states.set(apiKey, { kind: 'cooldown', cause: 'window', reason: 'usage window exhausted (429)', until: resetAtMs })
    } else {
      this.states.set(apiKey, { kind: 'unknown', cause: 'window', reason: 'usage window exhausted (429)', until: 0 })
    }
  }

  /**
   * One account's key: literal → credential seam → auth file (default slot).
   *
   * Every source is normalized here, at the single point where a slot's key
   * enters the pool. The adapter sends the key through
   * `assertUsableApiKey()`, which trims it, and reports that trimmed form back
   * to {@link markRejected}: returning the raw value would file every 429/401
   * mark under a key no later lookup can find — rotation would re-offer the same
   * account, the account card would show no mark, and the usage endpoints would
   * 401 while chat kept working.
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
   * The account the user explicitly asked for: the slot a model rule routes the
   * request to when that id exists among the resolved slots, else the manually
   * pinned slot. Consulted only on the fallback path, so — unlike
   * {@link selectAccountForModel} — it does NOT require the account to be usable,
   * which is exactly what {@link resolveKey} re-probes.
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
   * re-probing: a `cooldown` carries its reset and expires by itself, and a
   * `disabled` (401) key stays out until the stored credential changes. The
   * interval bounds a probe endpoint that keeps failing.
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
   * selection serves again on this very request; an exceeded one is stamped as
   * a cooldown carrying the provider's reset time, after which
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
      // billing GET plus one doomed upstream attempt per request, forever. The
      // stamp costs nothing when the revival was right: a serving account is
      // never probed at all.
      return { slot: account.slot, key: account.key, state: undefined }
    }
    // A reset time is what makes the mark expire on its own; without one the
    // mark stays `unknown` — see `stampWindowMark`.
    this.stampWindowMark(account, probe)
    return undefined
  }

  /**
   * Stamp a probe-read window onto one key. A known reset becomes a cooldown
   * that expires by itself; without one the mark stays `unknown`, so a later
   * probe can still learn it — and a mark that already carries a cooldown
   * keeps it, never trading a known reset for an unknown one. The cause is
   * `window` either way: a probe that read a window as exceeded IS window
   * evidence, whatever the key was marked for. An `until: 0` cooldown would
   * read as "never usable again" to {@link accountUsable}, so `unknown` it is.
   */
  private stampWindowMark(account: ResolvedAccount, probe: AccountWindowProbe): void {
    if (probe.resetAt > 0) {
      this.states.set(account.key, {
        kind: 'cooldown',
        cause: 'window',
        reason: account.state?.reason ?? 'usage window exhausted (429)',
        until: probe.resetAt,
      })
    } else if (account.state?.kind !== 'cooldown') {
      this.states.set(account.key, {
        kind: 'unknown',
        cause: 'window',
        reason: account.state?.reason ?? 'usage window exhausted (429)',
        until: 0,
      })
    }
  }

  /**
   * The explicit-account fallback re-check: when `chosen` (what rotation
   * would currently serve) is not the account the user actually asked for,
   * re-probe that explicit account's mark before accepting the fallback —
   * so a rate-limit mark never demotes the user's own selection for good
   * (issue #51). Returns the revived account, or `undefined` when there is
   * nothing to revive (explicit account already serving, not due for a
   * probe, or the probe found it still exceeded). Shared by {@link resolveKey}
   * (the request path) and {@link activeAccount} (the display path), so both
   * agree on what "currently usable" means instead of drifting apart.
   */
  private async reviveExplicit(
    accounts: readonly ResolvedAccount[],
    model: string,
    preferred: string | undefined,
    chosen: ResolvedAccount,
  ): Promise<ResolvedAccount | undefined> {
    const explicit = this.explicitAccount(accounts, model, preferred)
    if (explicit === undefined || explicit.key === chosen.key || !this.canProbeExplicit(explicit)) {
      return undefined
    }
    return this.probeExplicit(explicit)
  }

  /**
   * Probe every marked account's real usage window when nothing currently
   * resolves. Disabled (401) keys are not probed — an invalid key stays
   * invalid. A throwing probe counts as "unknown" (like a failed one): it
   * must not turn the all-exhausted path into a raw rejection instead of
   * RATE_LIMIT. Shared by {@link resolveKey} and {@link activeAccount}.
   */
  private async probeAllMarked(accounts: readonly ResolvedAccount[]): Promise<void> {
    await Promise.all(accounts.map(async (account) => {
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
      this.stampWindowMark(account, probe)
    }))
  }

  /** Hand out the chosen account's key. */
  private pick(account: ResolvedAccount): { key: string; slot: CommandCodeAccountSlot } {
    return { key: account.key, slot: account.slot }
  }
}

/**
 * The error for "accounts exist but none of them can serve". Three shapes, each
 * claiming only what the pool actually knows:
 *
 *   - every account rejected with 401 → `INVALID_CREDENTIAL`;
 *   - at least one account marked by a NAMED usage window (or by a probe that
 *     read a window as exceeded) → the window diagnosis, naming the earliest
 *     known reset when the provider published one;
 *   - every mark a plain throttle (a 429 that said nothing about a window, and
 *     no probe could confirm one) → a throttle diagnosis that says so.
 *     Claiming "all accounts have exhausted their usage window" here is issue
 *     #54: a bare 429 was reported that way while the account card showed both
 *     windows barely used.
 *
 * The attached `providerRetryAfterMs` is the exact wait until the earliest known
 * window reset, so dsh-llm-retry sleeps through the window instead of polling at
 * its backoff cadence. It is capped at {@link RETRY_MAX_DELAY_MS} — see there for
 * why a longer attached wait is worse than a capped one; longer resets simply
 * ride the capped local backoff and the probe revival. A throttle diagnosis
 * attaches none: its marks carry no reset.
 *
 * Shared by the all-marked tail of {@link CommandCodeAccountPool.resolveKey} and
 * by its already-tried diagnosis, so the two can never drift apart.
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
  const marked = accounts
    .map((account) => account.state)
    .filter((state): state is CommandCodeAccountState => state !== undefined)
  // Only a `window` mark may be described as an exhausted usage window. A
  // throttle mark proves the provider refused the request, never that a metered
  // window is spent — and because it carries no reset (`unknown`, so the next
  // pass may probe), this answer has no time to name one. dsh-llm-retry's own
  // backoff paces the retries.
  const windowMarked = marked.filter((state) => state.cause === 'window')
  if (windowMarked.length === 0) {
    return new LlmError(
      `llm-commandcode: all ${accounts.length} Command Code account(s) are rate limited (429)`
        + ' — the provider did not report an exhausted usage window; retrying'
        + `；全部 ${accounts.length} 个 Command Code 账户被限流（429）`
        + '——服务商未报告用量窗口用尽，正在重试',
      THROTTLED_CODE,
    )
  }
  const resets = windowMarked
    .filter((state) => state.kind === 'cooldown' && state.until > 0)
    .map((state) => state.until)
  const earliest = resets.length > 0 ? Math.min(...resets) : 0
  const wait = earliest > 0 ? Math.max(1000, earliest - Date.now()) : 0
  return new LlmError(
    `llm-commandcode: all ${accounts.length} Command Code account(s) have exhausted their usage window`
      + (earliest > 0
        ? `; the earliest window resets at ${clockLabel(earliest)}`
        : ' — the provider published no reset time for it')
      + ' — requests will succeed again after the reset (or add another account)'
      + `；已用尽全部 ${accounts.length} 个 Command Code 账户的用量窗口`
      + (earliest > 0 ? `，最早的重置时间为 ${clockLabel(earliest)}` : '，服务商未公布重置时间')
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
