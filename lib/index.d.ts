import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from "@deepseek-ai/dsh-llm";
import { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { TypertRemoteService, TypertSchema } from "@deepseek-ai/dsh-typert-protocol";
import { WebRuntime, WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { CommandDefinition } from "@deepseek-ai/dsh-commands";
//#region src/adapter.d.ts
declare const COMMAND_CODE_CLI_VERSION = "1.53.1";
declare const DEFAULT_API_BASE = "https://api.commandcode.ai";
declare const DEFAULT_GENERATE_MAX_TOKENS = 64000;
declare const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
/** How long the picker's plan-filter billing facts stay cached before refetching. */
declare const BILLING_ACCESS_TTL_MS: number;
/** Endpoint protocol selected for one generate call. */
type CommandCodeProtocol = 'cli' | 'openai';
/** Head-of-request timeout: how long to wait for the first response byte. */
declare const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
declare function projectSlugFromPath(pathName: string): string;
/** Read a usable Command Code credential from the official CLI auth file. */
declare function resolveAuthFileApiKey(): string | undefined;
/** Connection facts resolved fresh per request by the plugin entry. */
interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/chat/completions`, `/provider/v1/models`). */
  apiBase: string;
  /** Working directory reported to the API (project slug, config block). */
  workingDir: string;
  /** Model catalog cache path. */
  modelsCachePath: string;
  /**
   * Milliseconds to wait for generate response headers / first byte (default 60s).
   * Must not bound the subsequent body stream — long generations are gated by
   * {@link streamIdleTimeoutMs} and the caller AbortSignal instead.
   */
  requestTimeoutMs: number;
  /** Milliseconds a stream may stall before it is treated as a dead connection (default 300s). */
  streamIdleTimeoutMs: number;
  /**
   * Whether the picker hides models above the account's subscription tier
   * (default true). The filter fails open: unknown plan, billing-endpoint
   * failure, a positive on-demand credit balance, or an unmapped model all
   * keep the full catalog visible. Set false to always list every model.
   */
  filterModelsByPlan?: boolean;
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything"; applies after the subscription-tier filter.
   * The settings page persists it; the catalog endpoint serves the full
   * catalog regardless so the page can always offer every model.
   */
  visibleModels?: string[] | undefined;
  /**
   * Per-model visibility overrides, keyed by catalog id. Written by the
   * terminal settings page, whose checkbox list gives every model its own
   * boolean field: a field writes one value at one path, so membership in
   * {@link visibleModels} cannot be expressed from there, while a flag can.
   * An id present here decides that model on its own (true = listed, false =
   * hidden); an id absent here follows {@link visibleModels} exactly as it did
   * before, so composition configs and the web page are unaffected.
   */
  modelVisibility?: Readonly<Record<string, boolean>> | undefined;
  /**
   * Optional protocol hint. `'auto'` (default) uses billing/cache plus
   * Provider API fallback; `'cli'` forces `/alpha/generate`; `'openai'`
   * prefers `/provider/v1/chat/completions` but still falls back to the CLI
   * transport on `upgrade_required` (Go-plan keys have no Provider API
   * access — failing outright would strand them). This is a
   * connection-level test/operator seam and is intentionally not part of
   * the plugin's user settings schema.
   */
  protocol?: 'auto' | CommandCodeProtocol;
}
/**
 * Resolve the durable attachment service, or undefined when the host does not
 * provide one. Called lazily only when a request actually carries images, so a
 * text-only request never depends on the attachment seam.
 */
type ResolveAttachments = () => AttachmentStore | undefined;
/** Everything the adapter needs beyond the request itself. */
interface CommandCodeAdapterDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** Resolve the current connection facts (fresh per request, settings-aware). */
  options: () => C;
  /**
   * Resolve a usable API key for the given connection facts and the request's
   * model id, or throw `MISSING_CREDENTIAL`. The model is optional: hosts
   * without model-aware routing ignore it.
   */
  resolveApiKey: (connection: C, model?: string) => Promise<string>;
  /**
   * Multi-account rotation hook: the request sent with `rejectedKey` was
   * refused with 429 (`rate-limit`) or 401 (`invalid-credential`) before
   * any response body streamed. The host marks that key and returns the next
   * account's key to retry with, or `undefined` to surface the failure.
   * Only pre-stream rejections rotate — a mid-stream failure never replays a
   * partially consumed generation against another account.
   */
  rotateApiKey?: (rejectedKey: string, rejection: 'rate-limit' | 'invalid-credential', connection: C, model?: string) => Promise<string | undefined>;
  /** HTTP transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Resolve the optional durable attachment service for image input (tests); defaults to none. */
  resolveAttachments?: ResolveAttachments;
}
/** Account identity from `/alpha/whoami`. */
interface CommandCodeAccount {
  id: string;
  name: string;
  userName: string;
}
/** Usage summary from `/alpha/usage/summary`. */
interface CommandCodeUsage {
  totalCount: number;
  totalCost: number;
  successRate: number;
  completedCount: number;
  failedCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCredits: number;
  periodBasis: string;
}
/** Credit/limit state from `/alpha/billing/credits`. */
interface CommandCodeCredits {
  monthlyCredits: number;
  purchasedCredits: number;
  freeCredits: number;
  /** Five-hour rolling window limits. */
  fiveHour: {
    used: number;
    cap: number;
    exceeded: boolean;
    resetAt: number;
  };
  /** Weekly window limits. */
  weekly: {
    used: number;
    cap: number;
    exceeded: boolean;
    resetAt: number;
  };
}
/** Subscription plan state from `/alpha/billing/subscriptions`. */
interface CommandCodePlan {
  /** Raw subscription plan id (e.g. `individual-pro`); empty when unreported. */
  planId: string;
  /** Display name (e.g. `Pro`); falls back to the raw id for unknown plans. */
  name: string;
  /** Raw subscription status (`active`, `trialing`, `past_due`, …); empty when unreported. */
  status: string;
  /** The plan's monthly credit total per {@link KNOWN_SUBSCRIPTION_PLANS}; null for unknown plans. */
  monthlyCredits: number | null;
  /** Billing period end in millis; 0 when the endpoint did not report one. */
  currentPeriodEnd: number;
}
/**
 * Why every account endpoint failed at once (the report then carries no data
 * at all, so the degraded per-endpoint view would hide the root cause behind
 * a generic "partial data" note). Undefined for partial failures.
 */
type UsageBlockReason = 'invalid-key' | 'service-unavailable' | 'network';
/** Everything the usage endpoints report, fetched together. */
interface CommandCodeUsageReport {
  account?: CommandCodeAccount;
  usage?: CommandCodeUsage;
  credits?: CommandCodeCredits;
  plan?: CommandCodePlan;
  /** Endpoint failures degrade the report instead of failing it. */
  failures: string[];
  /**
   * The single reason every endpoint failed, when they all did: `invalid-key`
   * (every call rejected with 401 — the stored key is wrong or expired),
   * `service-unavailable` (every call answered 5xx), or `network` (no HTTP
   * response at all). Undefined when any endpoint succeeded.
   */
  blocked?: UsageBlockReason;
}
declare class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private readonly deps;
  private catalog;
  private readonly fetchImpl;
  private readonly resolveAttachments;
  private readonly billingAccess;
  private readonly billingAccessInflight;
  private readonly protocolCache;
  constructor(deps: CommandCodeAdapterDeps<C>);
  /**
   * Display metadata for the picker's provider group header. The base class
   * returns the raw route id (`commandcode`, all lowercase) as the name, which
   * is what the model selector shows as this group's sticky title; return the
   * proper display name instead, matching the Models settings page card (the
   * configurable-provider `displayName`). The id must stay equal to the route.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * Near-unbounded retry for transient failures only (`mode: 'normal'` with
   * an explicit 1000-attempt cap — opencode-style persistence without the
   * unbounded loop): `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/
   * `EMPTY_RESPONSE` retry up to 1000 times with waits doubling from 500 ms
   * and capping at 15 minutes (±10% jitter), so an exhausted 5-hour window
   * recovers in-session instead of failing after two tries. Permanent
   * failures (an invalid key's `INVALID_CREDENTIAL`, `UNSUPPORTED_CONTENT`,
   * plan rejections) are absent from the whitelist and surface immediately
   * instead of looping. Waits the pool/adapter attach as
   * `providerRetryAfterMs` are honored verbatim at or below the 15-minute
   * cap and never attached above it (in normal mode a longer attached wait
   * makes the executor abandon the retry outright — see RETRY_MAX_DELAY_MS).
   *
   * Captured once at route registration (dsh-llm snapshots this value), so a
   * future config knob for it would apply on profile restart, not per request.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
  /** Refresh the catalog (live fetch, cache fallback) and return it. */
  private loadCatalog;
  listModels(provider: string, opts?: {
    unfiltered?: boolean;
  }): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /** The headers every authenticated account endpoint shares. */
  private accountHeaders;
  /**
   * Fetch one account endpoint and parse its JSON body. Returns the HTTP
   * status alongside the parsed record so each caller applies its own
   * failure accounting: the billing probe fails open silently, the usage
   * report books failures per endpoint. Non-2xx and non-record bodies come
   * back without a record; only a transport throw propagates to the caller.
   */
  private fetchEndpointJson;
  /**
   * The billing facts behind the picker's plan filter, cached for
   * {@link BILLING_ACCESS_TTL_MS} and shared across concurrent callers.
   * `undefined` means "unknown — show everything" (fail-open).
   */
  private loadBillingAccess;
  /**
   * The billing facts behind the picker's plan filter, mirroring the CLI's
   * `createBilling` flow: whoami yields the org id, then the subscriptions
   * and credits endpoints answer in parallel. The plan id is honored only
   * when the subscription reports an active-ish status (the CLI's rule); when
   * the subscriptions endpoint fails entirely, `credits.planId` is the
   * fallback (the CLI stamps plan identity from it too). Any failure resolves
   * to `undefined` (fail-open) rather than breaking the picker.
   */
  private fetchBillingAccess;
  /** Fresh cached billing tier weight for a key, or undefined when not known. */
  private cachedBillingTierWeight;
  /** Cached protocol decision for a key, or undefined when expired/unknown. */
  private cachedProtocolUseCli;
  private rememberProtocol;
  /**
   * Choose the initial protocol for one request. A fresh protocol cache entry
   * wins; otherwise a cached (not network-fetched) billing tier of Go is
   * treated as CLI-only. Unknown accounts default to Provider API and fall
   * back only after an `upgrade_required` rejection.
   */
  private resolveProtocol;
  /**
   * Fetch account, usage, credit, and subscription state from the Command
   * Code account endpoints (`/alpha/whoami`, `/alpha/usage/summary`,
   * `/alpha/billing/credits`, `/alpha/billing/subscriptions`).
   * Each endpoint degrades independently: a failed one lands in `failures`
   * while the rest still report, so a transient outage never blanks the whole
   * view. Requires a usable API key (throws `MISSING_CREDENTIAL` otherwise).
   * Pass `apiKey` to report on a specific account of a multi-account pool;
   * the default resolves the currently active account.
   */
  getUsage(apiKey?: string): Promise<CommandCodeUsageReport>;
  /**
   * Probe one account's five-hour window from `/alpha/billing/credits`. The
   * multi-account pool calls this when every account is marked exhausted: an
   * account whose window no longer reports `exceeded` is revived, and the
   * `resetAt` values feed the "earliest reset" error message. Returns
   * `undefined` when the probe itself failed (transport, non-200, or a
   * payload without window limits) — a failed probe never changes pool state.
   */
  probeFiveHourWindow(apiKey: string): Promise<{
    exceeded: boolean;
    resetAt: number;
  } | undefined>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//#endregion
//#region src/accounts.d.ts
/** One extra account's raw configuration (composition config or settings). */
interface CommandCodeAccountConfig {
  /** Display label shown in the usage dashboard and settings page. */
  label?: string;
  /** Credential reference (environment-variable style name) holding this account's API key. */
  apiKeyEnv?: string;
  /** Literal API key (composition config only; never stored in settings). */
  apiKey?: string;
}
/** One account slot after config normalization. */
interface CommandCodeAccountSlot {
  /** Stable id: `default` for the implicit first account, `account-N` for extras. */
  id: string;
  /** Display label (user-provided or generated). */
  label: string;
  /** Credential reference resolved through the seam; undefined for literal-only slots. */
  ref?: CredentialRef | undefined;
  /** Literal key from composition config. */
  literal?: string | undefined;
  /** Whether the official CLI auth file may back this slot (default slot only). */
  allowAuthFile: boolean;
}
/** Why a key stopped serving requests. */
type AccountRejection = 'rate-limit' | 'invalid-credential';
/** One key's rotation state. */
interface CommandCodeAccountState {
  kind:
  /** Marked by a 429; the window's reset time is unknown until probed. */
  'unknown' |
  /** Probed (or marked with a known reset): unusable until `until` (millis). */
  'cooldown' |
  /** Marked by a 401: skipped until the stored credential changes. */
  'disabled';
  /** Human-readable reason for the mark (e.g. `rate limited (429)`). */
  reason: string;
  /** Cooldown end in millis; 0 for the other kinds. */
  until: number;
}
/** A slot paired with its resolved key (both pool-internal and UI-facing). */
interface ResolvedAccount {
  slot: CommandCodeAccountSlot;
  key: string;
  /** The key's current rotation state; undefined means usable. */
  state: CommandCodeAccountState | undefined;
}
/** Five-hour window facts probed from `/alpha/billing/credits`. */
interface FiveHourWindowProbe {
  exceeded: boolean;
  resetAt: number;
}
/** Everything the pool needs from the host; all seams are injected. */
interface CommandCodeAccountPoolDeps {
  /** The current account slots, re-read per resolution so settings changes apply live. */
  slots(): readonly CommandCodeAccountSlot[];
  /** Resolve one credential reference through the credentials service or the launch environment. */
  resolveRef(ref: CredentialRef): Promise<string | undefined>;
  /** The official CLI auth-file key (`~/.commandcode/auth.json`); default slot only. */
  authFileKey(): string | undefined;
  /** Probe one key's five-hour window; undefined when the probe itself failed. */
  probeWindow(apiKey: string): Promise<FiveHourWindowProbe | undefined>;
  /**
   * The manually selected account (a slot id, e.g. `default` or an extra's
   * credential reference), re-read per resolution. The preferred account
   * serves whenever it is usable; an unknown id or an exhausted preferred
   * account falls back to the first usable slot.
   */
  preferredId?(): string | undefined;
  /**
   * Model → account routing rules, re-read per resolution so settings changes
   * apply live. Each rule lists catalog model ids (see
   * {@link CommandCodeModelAccountRule}) to an account slot id. When the
   * request's model matches a rule and that account is usable, it serves
   * before the preferred/rotation selection; an unusable routed account falls
   * back to the normal selection (the router is a hint, never a hard gate).
   */
  modelAccountRules?(): readonly CommandCodeModelAccountRule[];
}
/**
 * One "route these models to that account" rule. `models` lists catalog ids
 * (`deepseek/deepseek-v4-pro`, …); `account` is a slot id (`default` or an
 * extra account's credential reference). A request whose model id is in the
 * list routes to that account. The first matching rule in list order wins.
 */
interface CommandCodeModelAccountRule {
  /** Catalog model ids to match against the request's model. */
  models: string[];
  /** Account slot id to prefer for matching models. */
  account: string;
}
/**
 * Whether an account with this rotation state can serve a request right now.
 * `undefined` (never rejected) is usable; a cooldown becomes usable again
 * once its reset time passes; `unknown` (429, reset unprobed) and
 * `disabled` (401) are not.
 */
declare function accountUsable(state: CommandCodeAccountState | undefined): boolean;
/**
 * Pick the account that should serve now: the manually preferred slot when it
 * is usable, otherwise the first usable account in rotation order; undefined
 * when no account is usable. Shared by the pool (request path) and the plugin
 * entry (the usage view's active badge) so both always agree.
 */
declare function selectActiveAccount(accounts: readonly ResolvedAccount[], preferredId: string | undefined): ResolvedAccount | undefined;
/**
 * The first routing rule whose model list contains the request's model id.
 * Undefined when no rule matches.
 */
declare function matchModelRule(model: string, rules: readonly CommandCodeModelAccountRule[] | undefined): CommandCodeModelAccountRule | undefined;
/**
 * The routed account for a request's model: the first usable account whose
 * slot id matches the first matching rule's target. Undefined when no rule
 * matches or the routed account is not usable (the caller then falls back to
 * the normal preferred/rotation selection).
 */
declare function selectAccountForModel(accounts: readonly ResolvedAccount[], model: string, rules: readonly CommandCodeModelAccountRule[] | undefined): ResolvedAccount | undefined;
/**
 * The account pool. Rotation state is keyed by API key (never logged), so two
 * slots resolving to the same credential share one mark, and a key changed in
 * the credentials service starts with a clean slate.
 */
declare class CommandCodeAccountPool {
  private readonly deps;
  /** Rotation state by API key. */
  private readonly states;
  constructor(deps: CommandCodeAccountPoolDeps);
  /**
   * Resolve every slot's key, deduplicated by key (first slot wins). Slots
   * without any resolvable key are omitted — they still appear in the
   * settings page as unconfigured, they just cannot serve requests.
   */
  resolvedAccounts(): Promise<ResolvedAccount[]>;
  /**
   * Every slot paired with its resolved key and rotation state — NOT
   * deduplicated: two slots sharing one credential both appear (the usage
   * view reports them individually), while slots without any resolvable key
   * are omitted. The serving path uses {@link resolvedAccounts} instead.
   */
  describeAccounts(): Promise<ResolvedAccount[]>;
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
  resolveKey(options?: {
    exclude?: string;
    model?: string;
  }): Promise<{
    key: string;
    slot: CommandCodeAccountSlot;
  } | undefined>;
  /**
   * Record a rejection against one key. `rate-limit` (429) marks the key
   * exhausted with an unknown reset (probed lazily at the next resolution
   * once every account is marked); `invalid-credential` (401) disables the
   * key until the stored credential changes.
   */
  markRejected(apiKey: string, rejection: AccountRejection): void;
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
  private resolveSlotKey;
  /** Hand out the chosen account's key. */
  private pick;
}
//#endregion
//#region src/capabilities.d.ts
/**
 * Static capability snapshot for the Command Code provider: model →
 * reasoning-effort levels, vision/thinking flags, model → minimum plan tier,
 * subscription-plan labels, deals, and hourly (peak/off-peak) pricing.
 *
 * Everything in this module is synced from official sources (the command-code
 * CLI bundle's model table and the official plan/pricing/model docs — see the
 * dsh-commandcode-upstream skill for the exact extraction procedures), and
 * changes whenever an upstream CLI release reshuffles models/plans/prices.
 * Keeping the snapshot in its own module confines those frequent sync diffs
 * here: src/adapter.ts holds only the stable wire/runtime logic and imports
 * these tables + read helpers.
 *
 * Snapshot read helpers (planLabel, dealLabel, formatContext,
 * capabilityDescription, peakPricing*, compareByPlan, modelVisibleInPlan,
 * subscriptionPlanInfo, isFreeModel) live here too — they exist only to read
 * the tables, so a sync never has to touch src/adapter.ts.
 *
 * Ported from pi-commandcode-provider (MIT); originally part of src/adapter.ts
 * and split out so upstream syncs stay reviewable.
 */
declare const KNOWN_EFFORTS: Readonly<Record<string, readonly string[]>>;
/**
 * Models whose Capabilities include Vision, per the official Command Code
 * model registry (`https://commandcode.ai/docs/reference/cli/models`, generated
 * from the same registry as `cmd --list-models` / the `/model` picker).
 *
 * The Provider API does not expose modality metadata, so this snapshot is the
 * source of truth for image-input gating. Command Code's own CLI falls back to
 * a client-side VISION side-call for text-only models; this adapter does not
 * reproduce that interactive feature, so images sent to a model outside this
 * list are refused loudly (`UNSUPPORTED_CONTENT`) instead of being dropped or
 * sent to a model that cannot read them.
 *
 * Keep in sync with the official registry when new models ship (see the
 * dsh-commandcode-upstream skill).
 */
declare const KNOWN_IMAGE_MODELS: ReadonlySet<string>;
/**
 * Models the official CLI's model table (command-code@1.53.0) marks
 * `reasoning:!0` but defines no selectable `reasoning_effort` levels — they
 * think automatically, with Command Code driving the depth. This is the
 * authoritative "thinks, effort not adjustable" set: `KNOWN_EFFORTS` (which
 * mirrors the CLI's effort map exactly) stays the sole source for selectable
 * effort levels, and this snapshot is not surfaced in the picker's compact
 * description — it exists for programmatic consumers.
 *
 * Source: the command-code@1.53.0 bundled model table (dist/cli.mjs),
 * cross-checked with https://commandcode.ai/docs/reference/cli/models.
 * (`stealth/ox-alpha` left this set in command-code@1.32.1, which gave it
 * selectable `['low', 'high', 'max']` efforts; the preview then ended in
 * 1.34.0, removing the model from the catalog entirely. `tencent/hy4-preview`
 * joined this set in command-code@1.37.0 — reasoning:!0, no efforts, 1M
 * context, routed through OpenRouter — then gained selectable
 * `['low', 'medium', 'high']` efforts in command-code@1.38.0 and moved to
 * `KNOWN_EFFORTS`. `moonshotai/Kimi-K3` followed the same path in
 * command-code@1.39.3 — it gained `['low', 'high', 'max']` efforts and moved
 * to `KNOWN_EFFORTS`. command-code@1.42.0 added `meituan/LongCat-2.0:free`
 * (reasoning:!0, no efforts). command-code@1.45.0 gave the Muse Spark family
 * (1.1, 1.2, 1.2-contributor, 1.3, 1.3-contributor) selectable
 * `['low', 'medium', 'high', 'xhigh']` efforts — they moved to `KNOWN_EFFORTS`.
 * command-code@1.51.3 gave `MiniMaxAI/MiniMax-M3` selectable
 * `['low', 'medium', 'high']` efforts — it moved to `KNOWN_EFFORTS` too.
 * command-code@1.52.0 added `inclusionai/ling-3.0-flash-sante:free`
 * (reasoning:!0, no efforts).)
 * command-code@1.53.0 added `deepseek/deepseek-v4.1-flash` with selectable
 * ['low', 'high', 'max'] efforts, so it lives in `KNOWN_EFFORTS`, not here.)
 * Keep in sync via the dsh-commandcode-upstream skill.
 */
declare const KNOWN_THINKING_MODELS: ReadonlySet<string>;
/**
 * The minimum subscription plan a model is included in, per the official plan
 * pages (`/docs/plans/go`, `/docs/plans/goat`, `/docs/plans/pro`, `/docs/plans/max`
 * and `/docs/resources/pricing-limits`). Each plan's model list is a superset of
 * the one below it: Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max. Models absent from every
 * plan list (Claude Opus/Fable, Fugu Ultra) are Provider-tier.
 * `claude-fable-5-1` (Claude Fable 5.1, added in command-code@1.40.0) is
 * Provider/Max-tier exactly like `claude-fable-5` — its availability matrix on
 * the official plan/pricing pages grants individual-provider/max/ultra and
 * teams-pro only, and the CLI's plan-access map blocks it on Go/GOAT/Pro.
 * command-code@1.41.0 added `Qwen/Qwen3.8-Max-0902` (Go) and 1.42.0 added
 * `meituan/LongCat-2.0:free` (Go, free promo); command-code@1.43.0 added
 * `google/gemini-3.8-flash` (GOAT) and 1.44.0 added `meta/muse-spark-1.3`
 * (GOAT) plus its Contributor sibling (Go); command-code@1.52.0 added the
 * free `inclusionai/ling-3.0-flash-sante:free` (Go); command-code@1.53.0
 * added `deepseek/deepseek-v4.1-flash` (Go).
 *
 * The Provider API exposes no plan metadata, so this snapshot is the source of
 * truth for the picker's plan annotation — it answers "which plan do I need to
 * actually use this model?" at a glance. Plan labels use the official tier
 * names (`Go`, `GOAT`, `Pro`, `Provider`), with `Max` implying Provider.
 *
 * Keep in sync with the official plan pages when they change (see the
 * dsh-commandcode-upstream skill).
 */
declare const KNOWN_PLANS: Readonly<Record<string, string>>;
/** Official display labels for each plan tier. */
declare const PLAN_LABELS: Readonly<Record<string, string>>;
/**
 * Plan-tier sort weights, low to high. Models outside the snapshot (unknown
 * plans) sort after every known tier, keeping known models predictable.
 */
declare const PLAN_ORDER: Readonly<Record<string, number>>;
/**
 * Comparator for the model picker: free models first (zero credit cost, usable
 * by every account), then by plan tier (lowest first), then by model name,
 * then by id as a tiebreak. Models with no known plan sort last.
 */
declare function compareByPlan(a: {
  id: string;
  name: string;
}, b: {
  id: string;
  name: string;
}): number;
/**
 * Subscription plan table, synced from the official CLI bundle's plan maps
 * (located by the `"individual-go"` key in command-code@1.53.0 `dist/cli.mjs`,
 * re-verified unchanged through 1.53.0): subscription `planId`
 * prefix → display name and the plan's monthly credit total. This is the
 * account's own subscription (from `/alpha/billing/subscriptions`) — distinct
 * from {@link KNOWN_PLANS}, which maps catalog models to their minimum tier.
 *
 * `tierWeight` is plugin-added (not from the CLI maps): the plan's rank on
 * the {@link PLAN_ORDER} scale, used by the picker's plan filter
 * ({@link modelVisibleInPlan}) to hide models above the account's tier.
 */
declare const KNOWN_SUBSCRIPTION_PLANS: Readonly<Record<string, {
  name: string;
  monthlyCredits: number;
  tierWeight: number;
}>>;
/**
 * Resolve a subscription `planId` (e.g. `individual-pro-v1`) to its display
 * name and monthly credit total, mirroring the CLI's `getPlanInfo`:
 * normalize (lowercase, `_` → `-`), then longest-prefix match so
 * `individual-pro-v1` wins over `individual-pro`. Unknown ids return
 * `undefined`.
 */
declare function subscriptionPlanInfo(planId: string): {
  name: string;
  monthlyCredits: number;
  tierWeight: number;
} | undefined;
/**
 * The billing facts the picker's plan filter needs, fetched by mirroring the
 * CLI's `createBilling` flow (whoami → orgId, then `/alpha/billing/subscriptions`
 * for the plan id and `/alpha/billing/credits` for the on-demand balances).
 */
interface CommandCodeBillingAccess {
  /** Account plan tier weight on the {@link PLAN_ORDER} scale; undefined when the plan is unknown. */
  tierWeight: number | undefined;
  /**
   * Purchased + free on-demand credit balance. The official access model
   * (`evaluateModelAccess` in the CLI) allows every model when the account
   * holds any on-demand credits — the plan gate only applies at zero balance.
   */
  onDemandCredits: number;
}
/**
 * Whether the picker lists `modelId` for an account with the given billing
 * access. Fails open at every uncertainty: no billing data, an unknown plan,
 * a non-finite weight (corrupt billing fact), or a model outside
 * {@link KNOWN_PLANS} all keep the model visible — the server remains the
 * final gate (`403 MODEL_NOT_IN_PLAN`).
 */
declare function modelVisibleInPlan(modelId: string, access: CommandCodeBillingAccess | undefined): boolean;
/**
 * Active pricing deals per the official pricing page
 * (`/docs/resources/pricing-limits#deals`). Each entry records the model's
 * promotional label and — critically — when it expires, so the picker never
 * shows a stale discount after the plugin's snapshot has gone out of date.
 *
 * - `expiresAt` is an ISO timestamp. When it is in the past (checked at
 *   render time against `Date.now()`), the deal label is hidden until the
 *   snapshot is refreshed from the official page. `undefined` means
 *   "no expiry" (permanent).
 * - `free` marks models whose requests cost no credits (Laguna S 2.1), shown
 *   as a `FREE` badge; it degrades to a plain discount once the deal lapses.
 *
 * Keep in sync with the official pricing page when deals change (see the
 * dsh-commandcode-upstream skill).
 */
interface KnownDeal {
  /** Promotional label, e.g. "50% off" or "2× usage". */
  label: string;
  /** Deal end date (ISO). `undefined` = permanent / no expiry. */
  expiresAt?: string;
  /** Model is free (requests cost no credits). */
  free?: boolean;
}
declare const KNOWN_DEALS: Readonly<Record<string, KnownDeal>>;
/**
 * Models with time-of-day (peak/off-peak) pricing, per the official pricing
 * page (`/docs/resources/pricing-limits`). Since 2026-08-16 16:00 UTC, DeepSeek
 * charges by the hour: peak hours are 01:00–04:00 and 06:00–10:00 UTC (7h per
 * weekday, full price) **Monday to Friday only**; the other 17 hours of a
 * weekday and every hour of Saturday/Sunday (UTC) are off-peak at half price.
 * The V4 Flash Vision (exp) variant (command-code@1.32.0) shares the V4 Flash
 * windows and peak prices ($0.44/$1.32) — each row's hover annotation states
 * exactly 2× that row's displayed off-peak prices. The picker shows the
 * *current* state as a compact
 * label (`Peak`/`Half`) matching the English noun style of the other markers
 * (`Image`, `FREE`), so a developer can tell at a glance whether calling the
 * model right now is cheap or expensive.
 *
 * Authoritative extraction: the pricing page embeds a model JSON array whose
 * hourly-priced entries carry a `timeOfDay` block
 * (`{ windows: "01–04 & 06–10 UTC, Mon–Fri", peakHoursPerDay: 7,
 * offPeakHoursPerDay: 17, peak: {...}, offPeak: {...} }`). Exactly four models
 * carry it: V4 Pro, V4 Flash, V4 Flash Vision (exp), and V4.1 Flash (added in
 * command-code@1.53.0 at $0.15/$0.60 off-peak, $0.30/$1.20 peak — the same
 * schedule as the other three).
 *
 * Extraction caution: the rendered HTML rows are a trap. Each annotation div
 * sits inside its OWN row's container, immediately before the NEXT row starts,
 * so flattening the page to text makes every annotation look like it belongs
 * to the model printed after it — that is how `deepseek/deepseek-v4-flash-fast`
 * was wrongly added here (its row is flat-priced at $0.28/$0.56/$0.07 and has
 * no `timeOfDay` block). Trust the embedded JSON's `timeOfDay` membership and
 * the 2× price relation, never the flat-text neighbor.
 *
 * Keep in sync with the official pricing page when the model set, the peak
 * windows, or the weekday rule change (see the dsh-commandcode-upstream skill).
 */
declare const KNOWN_PEAK_PRICING: ReadonlySet<string>;
/**
 * Whether `now` (defaults to `Date.now()`) falls in a peak-pricing window for
 * time-of-day-priced models. Peak rates apply Monday–Friday (UTC) only: the
 * official rule charges Saturday and Sunday completely off-peak for all 24
 * hours, so a weekend timestamp is off-peak even inside `PEAK_HOUR_RANGES`.
 * `undefined` for models outside the snapshot.
 */
declare function peakPricingState(modelId: string, now?: number): 'peak' | 'off-peak' | undefined;
/**
 * Compact label for the current peak/off-peak state: `Peak` (full price) or
 * `Half` (off-peak, half price). These English nouns match the picker's other
 * markers (`Go`, `Image`, `FREE`), and since they appear only on time-of-day
 * priced models they double as a "priced by the hour" signal. Returns undefined
 * for models without time-of-day pricing.
 */
declare function peakPricingLabel(modelId: string, now?: number): string | undefined;
/**
 * Official display label for a model's minimum plan, or undefined for models
 * outside the snapshot (e.g. future catalog additions).
 */
declare function planLabel(modelId: string): string | undefined;
/**
 * The active deal label for a model, or undefined when the model has no deal
 * or the deal has expired. Expiry is judged against `now` (defaults to
 * `Date.now()`), so a snapshot that has gone stale stops showing its discount
 * the moment the official end date passes — the user never believes a lapsed
 * deal is still live. Permanent deals (no `expiresAt`) never lapse.
 */
declare function dealLabel(modelId: string, now?: number): string | undefined;
/**
 * Compact human-readable context window, e.g. `1_000_000 -> "1M"`,
 * `256_000 -> "256K"`, `262_144 -> "262K"` (floor to the nearest K).
 * Returns undefined for unknown/absent sizes; values under 1K render raw.
 */
declare function formatContext(contextWindow: number | undefined): string | undefined;
/**
 * Compact one-line summary for the model picker: plan tier, then any active
 * deal (discount or FREE), then the current peak/off-peak state (`Peak`/`Half`)
 * for time-of-day-priced models, then `Image` for Vision-capable models, then
 * the context window. Text-only models simply omit the Image marker — "Text
 * only" adds nothing the picker needs to show.
 */
declare function capabilityDescription(modelId: string, contextWindow?: number, now?: number): string;
//#endregion
//#region src/usage-wire.d.ts
/** One account's usage entry in the multi-account report. */
interface CommandCodeAccountUsage {
  /** Stable slot id (`default`, `account-2`, …). */
  id: string;
  /** Display label (user-provided or generated). */
  label: string;
  /** Whether an API key resolved for this account. */
  configured: boolean;
  /** Whether this account currently serves requests (first usable slot). */
  active: boolean;
  /** Rotation mark: `''` (usable), `'rate-limit'`, or `'invalid-credential'`. */
  mark: string;
  /** Known cooldown end in millis; 0 when unknown or not cooling down. */
  cooldownUntil: number;
  /** The per-account report; `failures`-only when the fetch itself failed. */
  report: CommandCodeUsageReport;
}
/** The settings page's account card data: one entry per configured account. */
interface CommandCodeAccountsReport {
  accounts: CommandCodeAccountUsage[];
}
/** Canonical `<namespace>/<method>` endpoint of the usage report Remote. */
declare const USAGE_REPORT_ENDPOINT = "commandcode/report";
/**
 * The strict result codec both halves attach to the descriptor. Hand-rolled:
 * the client bundle may not require a schema library, and `TypertSchema` is
 * deliberately minimal so one `parse` function satisfies it.
 */
declare const usageReportSchema: TypertSchema<CommandCodeAccountsReport>;
/** One catalog entry the settings page's model editors offer. */
interface CommandCodeCatalogModel {
  /** Catalog model id (e.g. `deepseek/deepseek-v4-pro`). */
  id: string;
  /** Display name from the catalog. */
  name: string;
  /**
   * Minimum plan-tier key for this model (a `KNOWN_PLANS` value: `go`,
   * `goat`, `pro`, `provider`, `max`), or undefined for models outside the
   * snapshot. The settings page groups the model-editor dropdowns under
   * tier headings from this — the browser cannot import the Host's
   * capability snapshot, so the Host stamps it per entry.
   */
  tier?: string;
}
/** The model-catalog Remote result: the full catalog, sorted for picking. */
interface CommandCodeCatalog {
  models: CommandCodeCatalogModel[];
}
/**
 * One model's per-token rates, in USD per 1,000,000 tokens — the unit the
 * official pricing page publishes in.
 */
interface CommandCodeModelRates {
  /** Uncached (billed) input tokens. */
  inputCost: number;
  /** Completion tokens. */
  outputCost: number;
  /** Input tokens served from the provider's cache. */
  cacheReadCost: number;
  /**
   * Input tokens written into the provider's cache. Present for a minority of
   * models — the page publishes no cache-write rate for the rest, whose
   * cache-write tokens are therefore UNPRICED. Do not substitute a multiple of
   * the input rate for a missing value.
   */
  cacheWriteCost?: number;
}
/** One model's rates plus the peak-hour override for time-of-day models. */
interface CommandCodeModelPrice extends CommandCodeModelRates {
  /**
   * Lookup key: the catalog model id when a catalog model maps to this row,
   * otherwise the pricing page's own slug. A session reports catalog ids, so
   * this is the primary key the browser looks up by.
   */
  id: string;
  /** The pricing page's slug for this row — the secondary lookup key. */
  slug: string;
  /**
   * Rates charged inside the peak windows. The row's own top-level rates are
   * the off-peak rates, so a row WITH this block is time-of-day priced and a
   * row without it is flat-priced.
   */
  peak?: CommandCodeModelRates;
  /**
   * Whether the model costs nothing on every plan right now (a free deal or a
   * `:free` catalog variant). Served explicitly at zero rates so a surface can
   * say "free" rather than showing nothing.
   */
  free?: boolean;
}
/** The price-table Remote result: every known model's rates. */
interface CommandCodePriceTable {
  /**
   * Every priced model, keyed by {@link CommandCodeModelPrice.id} (catalog id
   * first, pricing slug as the fallback) and carrying its slug as a second
   * lookup key. A model absent from this list has no known price and must
   * render no cost at all rather than a guess.
   */
  models: CommandCodeModelPrice[];
  /**
   * Peak-pricing windows as `[startHour, endHour)` in UTC, end-exclusive,
   * applying Monday–Friday only. Shipped with the table so the browser prices
   * against the Host snapshot's schedule instead of restating it.
   */
  peakHours: Array<[number, number]>;
}
//#endregion
//#region src/command-locales.d.ts
/**
 * Locale copy for the `/commandcode` usage command and the friendly
 * image-gate error rewrite. Distinct from `./client/locales.ts` (the
 * settings-page namespace `settings.commandcode`): the command runs on the
 * Host and has no access to the client's `ctx.locale`, so the dictionaries
 * are exposed as plain constants for direct lookup; the resolver lives in
 * `pickCommandLocale()`. The image-gate wrapper also lives on the client
 * but is reached from a non-React path that has no `t` in scope, so the
 * same dictionaries serve both surfaces.
 *
 * zh is the source of truth for the key set; en must carry the exact same
 * keys — a mismatch is a compile error at the lookup site.
 */
/** Active locale id recognized by the command and the image-gate wrapper. */
type LocaleId = 'zh' | 'en';
//#endregion
//#region src/commands.d.ts
/** Everything the command needs beyond the adapter itself. */
interface CommandCodeCommandDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for getUsage / listModels). */
  adapter: CommandCodeAdapter<C>;
  /**
   * Multi-account report source (wired by the plugin entry). Absent in
   * programmatic setups, the command falls back to a single
   * `adapter.getUsage()` report.
   */
  reports?: () => Promise<CommandCodeAccountsReport>;
  /**
   * Resolve the active locale for one command run. The plugin entry wires
   * this from `Config.lang` and the shell's `LC_ALL`/`LANG`. Absent in
   * programmatic setups (notably the existing test), the command renders
   * with the default locale (`'zh'`) — historically the only language the
   * command ever shipped in.
   */
  getLocale?: () => LocaleId;
}
/** The one registered `/commandcode` command. */
declare function commandDefinition<C extends CommandCodeConnectionOptions>(deps: CommandCodeCommandDeps<C>): CommandDefinition;
/** Register the command on `ctx.commands` (called from the plugin entry). */
declare function applyCommands<C extends CommandCodeConnectionOptions>(ctx: Context, deps: CommandCodeCommandDeps<C>): void;
//#endregion
//#region src/login-wire.d.ts
/** Why a login attempt ended in `failed` (stable across versions for copy). */
type CommandCodeLoginFailureReason =
/** The Studio page reported the authorization was denied by the user. */
'denied' |
/** No callback arrived within the flow's timeout window. */
'timeout' |
/** The delivered key failed `/alpha/whoami` validation (401). */
'invalid-key' |
/** The validation request could not reach the API. */
'network' |
/** The key could not be stored (credentials seam unavailable). */
'unavailable' |
/** The attempt was cancelled by the user or torn down with the plugin. */
'cancelled' |
/** Anything else. */
'error';
/** One login attempt's full state face, as carried over the wire. */
interface CommandCodeLoginStatus {
  /**
   * `idle` — no attempt; `waiting` — the loopback server is up and the
   * Studio URL is live; `success` — the key validated and was stored;
   * `failed` — see `reason`/`message`.
   */
  state: 'idle' | 'waiting' | 'success' | 'failed';
  /** The Studio authorization URL while `waiting`. */
  authUrl?: string;
  /** The account display name reported by the Studio, on `success`. */
  userName?: string;
  /** The key's label from the Studio, on `success`. */
  keyName?: string;
  /** Why the attempt failed, when `failed`. */
  reason?: CommandCodeLoginFailureReason;
  /** Human-readable failure detail, when `failed` (secondary to `reason`). */
  message?: string;
}
/** The canonical endpoint paths of the three login Remotes. */
declare const LOGIN_BEGIN_ENDPOINT = "commandcode/loginBegin";
declare const LOGIN_STATUS_ENDPOINT = "commandcode/loginStatus";
declare const LOGIN_CANCEL_ENDPOINT = "commandcode/loginCancel";
/**
 * Parse one untrusted boundary value into a {@link CommandCodeLoginStatus}.
 * Every field is shape-checked so a malformed frame fails the boundary
 * instead of leaking into the page.
 */
declare function parseLoginStatus(value: unknown): CommandCodeLoginStatus;
/** The strict result codec shared by all three login endpoints. */
declare const loginStatusSchema: TypertSchema<CommandCodeLoginStatus>;
//#endregion
//#region src/usage-remote.d.ts
/**
 * The browser-login face the usage service exposes (`commandcode/login*`).
 * Backed by the Host-half {@link !CommandCodeLoginFlow} when the plugin entry
 * wired one; absent, `status`/`cancel` degrade to the idle status while
 * `begin` rejects with a plain message (so the page's manual paste path
 * stays the fallback instead of hanging).
 */
interface LoginFlowFacade {
  /** Start (or rejoin) an attempt; rejects when it cannot start at all. */
  begin(): Promise<CommandCodeLoginStatus>;
  /** The current attempt's status. */
  status(): CommandCodeLoginStatus;
  /** Cancel a waiting attempt. */
  cancel(): void;
}
/** Everything the usage service needs beyond its Cordis context. */
interface CommandCodeUsageDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for getUsage). */
  adapter: CommandCodeAdapter<C>;
  /**
   * Multi-account report source (wired by the plugin entry). Absent in
   * programmatic setups, the service falls back to a single default-account
   * entry around `adapter.getUsage()`.
   */
  reports?: () => Promise<CommandCodeAccountsReport>;
  /**
   * Model-catalog source for the settings page's model editors (the
   * routing-rule editor and the visible-models filter; wired by the plugin
   * entry). Absent, the `models` endpoint answers an empty list — the page's
   * editors degrade to the empty state.
   */
  listModels?: () => Promise<CommandCodeCatalog>;
  /**
   * Price-table source for the composer's session-cost figure. Defaults to the
   * vendored snapshot, so the endpoint can never silently serve an empty table
   * — an unpriced cost is the failure this feature is meant to remove. Override
   * only to stub it in a test.
   */
  prices?: () => CommandCodePriceTable;
  /**
   * The browser-login flow (wired by the plugin entry). Absent means the
   * login endpoints answer `idle` / reject with a plain message — the page's
   * manual paste path stays the fallback.
   */
  login?: LoginFlowFacade;
}
/**
 * The Remote receiver: a Cordis service the Gateway resolves by key
 * (`commandcodeUsage`) and binds to the wire namespace (`commandcode`). The
 * base class stamps the `typertRemote` binding the Gateway validates on every
 * dispatch; no decorators are needed because the descriptor is registered
 * explicitly (strict path) rather than discovered from source markers.
 */
declare class CommandCodeUsageService<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends TypertRemoteService {
  private readonly deps;
  constructor(ctx: Context, deps: CommandCodeUsageDeps<C>);
  /**
   * Account, usage, and credit state for the settings page's account card —
   * one entry per pool account when the plugin entry wired `reports`, a
   * single default-account entry otherwise. Degrades per endpoint like the
   * `/commandcode` command (failures land in `report.failures`); throws
   * `MISSING_CREDENTIAL` when no key resolves, which the Gateway folds into
   * the failure branch the page renders as a hint.
   */
  report(): Promise<CommandCodeAccountsReport>;
  /**
   * The full model catalog for the settings page's model editors (the
   * routing-rule editor and the visible-models filter). The browser never
   * calls the Command Code API directly — the Host serves the catalog
   * (already fetched/cached by the adapter) so models can be picked from
   * the live list instead of typed by hand.
   */
  models(): Promise<CommandCodeCatalog>;
  /**
   * The model price table the composer prices an in-progress session with.
   * Static vendored data (the official pricing page's rates), served Host-side
   * so the browser bundle never carries a copy that could drift from the
   * snapshot, and so a price update reaches an open page without a rebuild.
   */
  prices(): Promise<CommandCodePriceTable>;
  /**
   * Start (or rejoin) a browser-login attempt and return its fresh status —
   * `waiting` carrying the Studio URL. Rejects when the flow cannot start
   * (no free loopback port, disposed plugin); the Gateway folds the throw
   * into the failure branch the page renders.
   */
  loginBegin(): Promise<CommandCodeLoginStatus>;
  /** Poll a login attempt's status. */
  loginStatus(): Promise<CommandCodeLoginStatus>;
  /** Cancel a waiting attempt; returns the post-cancel status. */
  loginCancel(): Promise<CommandCodeLoginStatus>;
  private requireLogin;
}
/**
 * Provide the usage service and register its Remote descriptor. The registry
 * contribution is tied to this fiber's lifetime: the registry's own
 * `register()` effect would otherwise outlive the plugin.
 */
declare function applyUsageRemote<C extends CommandCodeConnectionOptions>(ctx: Context, deps: CommandCodeUsageDeps<C>): void;
//#endregion
//#region src/login.d.ts
/** Give up on the browser after this long without a callback (mirrors the CLI). */
declare const LOGIN_TIMEOUT_MS = 120000;
/** First local port the flow tries (mirrors the CLI). */
declare const LOGIN_START_PORT = 5959;
/** How many consecutive ports to try from {@link LOGIN_START_PORT}. */
declare const LOGIN_MAX_PORT_ATTEMPTS = 10;
/** Reject callback bodies larger than this (mirrors the CLI). */
declare const LOGIN_BODY_LIMIT_BYTES = 10000;
/** The Studio origins allowed to POST credentials to the loopback server. */
declare const LOGIN_ALLOWED_ORIGINS: readonly string[];
/** Credentials as delivered by the Studio's callback POST. */
interface CommandCodeLoginCredentials {
  apiKey: string;
  userId: string;
  userName: string;
  keyName: string;
}
/** Outcome of validating a delivered key against `/alpha/whoami`. */
type ApiKeyValidation = {
  valid: true;
} | {
  valid: false;
  error: 'invalid_key' | 'server_error' | 'network_error';
};
interface CommandCodeLoginFlowDeps {
  /**
   * The Provider API base used for `/alpha/whoami` validation; also selects
   * the matching Studio base (staging api → staging studio). A thunk is fine:
   * it is re-read when each attempt starts, so a settings change reaches the
   * next login. Defaults to the public API base.
   */
  apiBase?: string | (() => string | undefined);
  /** Attempt timeout in millis; defaults to {@link LOGIN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** First port to try; defaults to {@link LOGIN_START_PORT}. */
  startPort?: number;
  /** Consecutive-port attempts; defaults to {@link LOGIN_MAX_PORT_ATTEMPTS}. */
  maxPortAttempts?: number;
  /** Validation fetch seam; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Randomness seam; defaults to `node:crypto` randomBytes(32) base64url. */
  randomToken?: (byteLength: number) => string;
  /**
   * Receives the validated credentials after a successful login. Rejecting
   * fails the attempt with `unavailable`.
   */
  storeKey(credentials: CommandCodeLoginCredentials): Promise<void>;
}
/** Compose the Studio authorization URL (pure, exported for tests). */
declare function buildCommandAuthUrl(options: {
  studioBase: string;
  port: number;
  state: string;
}): string;
/** Map an API base onto the Studio base the CLI pairs it with. */
declare function studioBaseForApiBase(apiBase: string): string;
/**
 * Validate one candidate key against `/alpha/whoami` (pure, exported for
 * tests). Mirrors the CLI's verdicts: 401 → invalid_key, other non-OK →
 * server_error, transport failure → network_error.
 */
declare function validateCommandApiKey(fetchImpl: typeof fetch, apiBase: string, apiKey: string): Promise<ApiKeyValidation>;
/**
 * One browser-login attempt machine. Single-flight by design: `begin()` while
 * waiting returns the live attempt's status instead of starting a second one;
 * a terminal state makes the next `begin()` start fresh.
 */
declare class CommandCodeLoginFlow {
  private readonly deps;
  private readonly listeners;
  private statusValue;
  private server;
  private timer;
  /** Settle hooks of the live attempt's callback promise. */
  private settle;
  /**
   * Attempt generation. A delivered callback keeps validating the key
   * asynchronously (`complete()`), and that window is open to a cancel or a
   * fresh `begin()`; the generation lets a late completion recognize that it
   * no longer owns the status face and stop instead of storing a credential
   * the user cancelled and flipping the page back to success.
   */
  private attemptSeq;
  private disposed;
  constructor(deps: CommandCodeLoginFlowDeps);
  /** Subscribe to state transitions. @returns the disposer. */
  onChange(listener: () => void): () => void;
  /** The current attempt's status face. */
  status(): CommandCodeLoginStatus;
  /**
   * Start an attempt (or rejoin the live one) and resolve with its status —
   * `waiting` carrying the Studio URL once the loopback server is up.
   * Rejects only when the flow cannot start at all (no free port, disposed).
   */
  begin(): Promise<CommandCodeLoginStatus>;
  /** Cancel a waiting attempt; terminal states are untouched. */
  cancel(): void;
  /** Stop everything; a waiting attempt ends cancelled. Idempotent. */
  dispose(): void;
  private readApiBase;
  private setStatus;
  /** First free port among the consecutive candidates. */
  private findPort;
  /**
   * Bind the attempt's loopback server, resolving when the port is live.
   * Pre-bind failures reject (surfacing from `begin()`); a later server error
   * settles the live attempt as a tagged failure instead.
   */
  private bindServer;
  /** One request against the attempt's callback endpoint (CLI-mirrored). */
  private handleCallback;
  /** Answer a decisive callback, stop listening, and settle the attempt. */
  private settleAttempt;
  /**
   * Post-validation completion: whoami check, then hand-off to storage.
   *
   * Every step re-checks {@link ownsAttempt} first: the whoami round-trip and
   * the credential write are awaits, and the user may cancel (or start another
   * attempt) while one is in flight. A completion that no longer owns the
   * attempt must not write the key or publish a status — otherwise cancel
   * would report "cancelled" while the credential landed anyway, and the page
   * would silently flip to success.
   */
  private complete;
  /** Whether one attempt still owns the status face (not cancelled, replaced, or disposed). */
  private ownsAttempt;
  /** Map a tagged settle rejection onto the status face. */
  private failFrom;
  private clearTimer;
  /** Close the server and watchdog without touching the published status. */
  private teardown;
}
//#endregion
//#region src/web-search.d.ts
/** Stable id this provider registers under in `ctx.web`. */
declare const COMMANDCODE_SEARCH_PROVIDER_ID = "commandcode";
/**
 * The factory-declared search provider id dsh ships by default (from
 * `dsh-base`'s cordis patch `web.config.searchProvider`). Kept as a
 * documented reference only: disabling this plugin's `webSearch` toggle
 * restores the previously selected backend (see
 * {@link applyCommandCodeSearchSelection}) — it never forces this default,
 * because forcing it is what used to silence sibling search plugins such as
 * modsearch even with Command Code search turned off (issue #26).
 */
declare const DEFAULT_WEB_SEARCH_PROVIDER_ID = "deepseek-official";
/**
 * Point the web seam's search selection at this plugin's provider (`commandcode`).
 * Sets the runtime field; the next search call honours it because `search()`
 * re-reads `searchProviderId` each time. Returns the prior id (or undefined).
 * Never throws: a hardened/frozen runtime shape must not break the
 * settings-save path that calls this — the provider simply stays
 * registered-but-unselected (the boot-time `searchProvider: commandcode`
 * cordis patch is the durable alternative).
 *
 * @deprecated Prefer {@link applyCommandCodeSearchSelection}: this overload
 * always overwrites the displaced backend with the factory default on
 * disable, so turning Command Code search off silences whichever provider
 * was selected before (e.g. modsearch) instead of restoring it (issue #26).
 */
declare function selectCommandCodeSearchProvider(web: WebRuntime, enable: boolean): string | undefined;
/**
 * Tracked web-search selection state for one mounted `WebRuntime`.
 *
 * `owner` marks whether this plugin currently owns the selection (i.e. it
 * wrote `commandcode` and has not given it back yet). `displaced` is the
 * backend id the plugin displaced when it took over — restored when the
 * toggle turns off or the plugin unloads. `undefined` means "nothing was
 * configured, leave auto-select" and must round-trip untouched: writing the
 * factory default instead would still override a sibling plugin's own
 * constructor-time pin.
 */
interface CommandCodeSearchSelection {
  owner: boolean;
  displaced: string | undefined;
}
/** Fresh selection state: the plugin starts out not owning the selection. */
declare function commandCodeSearchSelection(): CommandCodeSearchSelection;
/**
 * Reach one end of the `webSearch` toggle without trampling sibling search
 * providers (issue #26).
 *
 * - Enabling writes `commandcode` and remembers whatever it displaced. When
 *   the plugin already owns the selection (e.g. a settings save while still
 *   on), the original `displaced` value is kept — the field currently holds
 *   our own id, which must never be mistaken for the user's backend.
 * - Disabling hands the selection back to the remembered backend. When the
 *   state holds no memory (a fresh boot straight into `webSearch: false`),
 *   the field is left alone: the runtime's current value — a sibling's
 *   cordis pin such as `searchProvider: modsearch`, or unset for
 *   auto-select — already says what the user wants.
 * - When the field already reads `commandcode` at first touch (e.g. a
 *   surviving runtime the plugin did not set, or a manual
 *   `searchProvider: commandcode` pin), `displaced` stays undefined so the
 *   later disable is a no-op rather than a guess at the factory default.
 *
 * Never throws: like the low-level rewrite, a hardened runtime shape degrades
 * to registered-but-unselected.
 */
declare function applyCommandCodeSearchSelection(web: WebRuntime, state: CommandCodeSearchSelection, enable: boolean): void;
/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
interface CommandCodeSearchProviderDeps {
  /** Resolve one usable Command Code key (credential seam → env → auth file), or undefined when none. */
  resolveKey(): Promise<string | undefined>;
  /** The API base host (defaults to `https://api.commandcode.ai`). */
  apiBase(): string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}
/**
 * A `ctx.web` search provider backed by the Command Code Provider API. Reuses
 * the plugin's credential chain and `apiBase`, so search "just works" with the
 * existing key — the model-facing `web_search` tool needs no separate
 * configuration. Selection between multiple search providers is the web seam's
 * job (pin `searchProvider: commandcode` if ambiguous).
 */
declare class CommandCodeSearchProvider implements WebSearchProvider {
  private readonly deps;
  readonly id = "commandcode";
  constructor(deps: CommandCodeSearchProviderDeps);
  /** Cheap local check; must not make network calls. Presence of a parseable base is enough. */
  available(): boolean;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  private resolveKey;
}
//#endregion
//#region src/tui-settings.d.ts
/** Provider-owned translations for one title, label, or hint. */
interface TuiLocalizedText {
  readonly zh?: string;
  readonly en?: string;
}
/** Control kinds the dsh-TUI settings screen knows how to render. */
type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select';
/** One choice of an options-bearing field. */
interface TuiSettingsFieldOption {
  /** Stored value. */
  readonly value: string;
  /** Display label (English; also the fallback). */
  readonly label: string;
  /** Provider-owned translations for the label. */
  readonly descriptions?: TuiLocalizedText;
}
/** The write one field's draft stages when the section is saved. */
type TuiSettingsFieldWrite = {
  readonly kind: 'set';
  readonly value: unknown;
} | {
  readonly kind: 'clear';
};
/** One editable field inside a section. */
interface TuiSettingsField {
  /** Key path from the section root, in the settings service's `mutate` vocabulary. */
  readonly path: readonly string[];
  /** Short field label (English; also the fallback). */
  readonly label: string;
  /** Provider-owned translations for the label. */
  readonly descriptions?: TuiLocalizedText;
  /** Optional one-line help rendered under the field. */
  readonly hint?: string;
  /** Provider-owned translations for the hint. */
  readonly hintDescriptions?: TuiLocalizedText;
  /** Optional group id; grouped fields render on that group's subpage. */
  readonly group?: string;
  readonly kind: TuiSettingsFieldKind;
  /**
   * Choices for an options-bearing field. A `text` field that carries options
   * is the TUI's own "preset plus custom value" shape: `←`/`→` cycle the
   * presets while Enter opens the text editor.
   */
  readonly options?: readonly TuiSettingsFieldOption[];
  /** Input placeholder for `kind: 'text' | 'number'`. */
  readonly placeholder?: string;
  /**
   * Credential control: the literal never rides the settings document — the
   * draft starts blank on every open, a blank draft writes nothing, and a
   * typed draft writes through the credentials seam under `ref`.
   */
  readonly secret?: {
    readonly ref: string;
  };
  /** Render a stored value as draft text. */
  readonly format?: (value: unknown) => string;
  /** The write a draft text stages; `undefined` marks the draft invalid. */
  readonly parse?: (text: string) => TuiSettingsFieldWrite | undefined;
}
/** Optional navigation group inside one section. */
interface TuiSettingsGroup {
  /** Stable identifier, unique inside the section. */
  readonly id: string;
  /** Group title (English; also the fallback). */
  readonly title: string;
  /** Provider-owned translations for the title. */
  readonly descriptions?: TuiLocalizedText;
}
/** One plugin's section inside the dsh-TUI settings screen. */
interface TuiSettingsSection {
  /** Settings namespace this section edits. */
  readonly ns: string;
  /** Section title (English; also the fallback). */
  readonly title: string;
  /** Provider-owned translations for the title. */
  readonly descriptions?: TuiLocalizedText;
  /** Optional navigation groups, in display order. */
  readonly groups?: readonly TuiSettingsGroup[];
  /** Editable fields, in display order. */
  readonly fields: readonly TuiSettingsField[];
}
/** The slice of the `tuiSettingsSections` service this module uses. */
interface TuiSettingsSectionsService {
  /** Declare a section; the returned disposer withdraws it. */
  register(section: TuiSettingsSection): () => void;
}
/** The selector value meaning "no pinned account — follow rotation order". */
declare const ACTIVE_ACCOUNT_AUTO = "auto";
/** The selector value meaning "no language override — follow the shell locale". */
declare const LANG_AUTO = "auto";
/** One catalog model offered as a checkbox. */
interface TuiModelChoice {
  /** Catalog model id, e.g. `deepseek/deepseek-v4-pro`. */
  readonly id: string;
  /** Minimum plan tier key from `KNOWN_PLANS`. */
  readonly tier: string;
  /** Whether the model is currently free, so it leads its group. */
  readonly free: boolean;
  /** Footer hint for the focused row: plan tier · deal · peak · `Image`. */
  readonly hint: string;
}
/** Everything the section needs from the plugin entry. */
interface CommandCodeTuiSettingsDeps {
  /** The plugin's settings namespace (`llm-commandcode`). */
  ns: string;
  /** Section title; defaults to `Command Code`. */
  title?: string;
  /**
   * The credential reference the API-key field writes through, read per
   * registration so a `Config.apiKeyEnv` change re-targets the field instead
   * of silently writing to the old reference.
   */
  apiKeyRef: () => string;
  /**
   * Account slots for the active-account selector, in rotation order, read
   * per registration. A changed list re-registers the section (see
   * {@link applyCommandCodeTuiSettings}).
   */
  accountSlots: () => readonly {
    id: string;
    label: string;
  }[];
  /**
   * The stored model allowlist, read LIVE at save time. A checkbox judges its
   * inherited state against this, so it must be read when the write runs, not
   * captured when the section was registered. An empty list means "every model
   * is visible" (the adapter's rule).
   */
  visibleModels: () => readonly string[];
  /**
   * The per-model override map the checkboxes write, read per registration so
   * ids this build's catalog does not know still get a row of their own. Same
   * live-read rule as {@link visibleModels}.
   */
  modelVisibility?: () => Readonly<Record<string, boolean>> | undefined;
  /** The models to offer as checkboxes; defaults to the static snapshot. */
  modelChoices?: () => readonly TuiModelChoice[];
}
/**
 * Build the section descriptor. Pure, so tests can pin the exact fields
 * without a dsh-TUI host.
 *
 * Field choices worth keeping: the two option-bearing fields (`activeAccount`,
 * `lang`) are `text` + `options` rather than `select`, because a `select`
 * cannot express "unset" — cycling only ever lands on a declared option, so a
 * `select` would strand the user on a pinned value with no way back to
 * automatic. The `auto` sentinel plus a `parse` that clears the path keeps the
 * unset state reachable. `filterModelsByPlan` formats its EFFECTIVE default
 * (unset means true at the adapter), so a fresh install reads true instead of
 * the screen's "(empty)".
 */
declare function buildCommandCodeTuiSection(deps: CommandCodeTuiSettingsDeps): TuiSettingsSection;
/**
 * Register the Command Code section on a dsh-TUI host.
 *
 * @param ctx - the context of an activated `tuiSettingsSections` injection.
 * @param deps - plugin-owned facts the section reads.
 * @returns a refresh function that re-registers the section when a fact it
 *   renders changed (the plugin entry calls it from its settings `onChange`
 *   hook), or `undefined` when the seam is unusable. The returned function is
 *   inert after the fiber is torn down.
 */
declare function applyCommandCodeTuiSettings(ctx: Context, deps: CommandCodeTuiSettingsDeps): (() => void) | undefined;
//#endregion
//#region src/index.d.ts
declare const name = "llm-commandcode";
declare const inject: string[];
/** The single provider route this plugin owns. */
declare const PROVIDER = "commandcode";
/** Default models cache path (mirrors the pi plugin's on-disk cache). */
declare const DEFAULT_MODELS_CACHE_PATH: string;
/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-commandcode` settings-section shape. Every field is optional:
 * a missing API key resolves through {@link Config.apiKeyEnv} at each request
 * (the web Models page writes it), with the official Command Code CLI auth
 * file (`~/.commandcode/auth.json`) as the last fallback.
 */
interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `COMMANDCODE_API_KEY`. */
  apiKeyEnv?: string;
  /** Literal API key override (composition config only); takes precedence over `apiKeyEnv`. */
  apiKey?: string;
  /** API base; defaults to the public Command Code Provider API. */
  apiBase?: string;
  /** Working directory reported to the API; defaults to the process cwd. */
  workingDir?: string;
  /** Model catalog cache path; defaults to `~/.commandcode/models-cache.json`. */
  modelsCachePath?: string;
  /** Milliseconds to wait for the generate response's first byte; defaults to 60s. */
  requestTimeoutMs?: number;
  /** Milliseconds a stream may stall before being treated as a dead connection; defaults to 300s. */
  streamIdleTimeoutMs?: number;
  /**
   * Whether the model picker hides models above the account's subscription
   * tier; defaults to true. The filter fails open (unknown plan, billing
   * endpoint failure, or a positive on-demand credit balance all keep the
   * full catalog visible). Set false to always list every model.
   */
  filterModelsByPlan?: boolean;
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything". Persisted by the settings page's model
   * filter card; applies after the subscription-tier filter.
   */
  visibleModels?: string[];
  /**
   * Per-model visibility overrides from the terminal settings page's checkbox
   * list, keyed by catalog id (`true` = listed, `false` = hidden). An id here
   * decides that model on its own; an id absent here follows `visibleModels`.
   * dsh-TUI keys a staged edit by the field's path, so the checkboxes need one
   * path per model — a map — because a boolean field cannot express "this id
   * is a member of the array".
   */
  modelVisibility?: Record<string, boolean>;
  /**
   * Extra accounts for multi-account rotation. The top-level
   * `apiKey`/`apiKeyEnv` (plus the CLI auth file) always form the first
   * (`default`) account; each entry here adds one more. When a request is
   * rejected pre-stream with 429 (usage window exhausted) or 401, the next
   * account's key retried transparently; when every account is exhausted the
   * request fails with a `RATE_LIMIT` error naming the earliest window
   * reset. Entries without `apiKey` or `apiKeyEnv` are ignored.
   */
  accounts?: CommandCodeAccountConfig[];
  /**
   * Manually selected active account: a slot id — `default`, or an extra
   * account's credential reference (e.g. `COMMANDCODE_API_KEY_2`). The
   * selected account serves whenever it is usable; an unknown id or an
   * exhausted selected account falls back to the first usable slot (automatic
   * rotation still applies). Unset means "first usable account".
   */
  activeAccount?: string;
  /**
   * Model → account routing rules. Each rule lists catalog model ids to an
   * account slot id (`default`, or an extra account's credential reference).
   * When a request's model is in a rule's list and the routed account is
   * usable, that account serves — before the manual {@link activeAccount} and
   * the passive rotation order. A routed account that is exhausted or invalid
   * falls back to the normal selection, so the router is a hint, never a hard
   * gate. The first matching rule wins.
   */
  modelAccountRules?: CommandCodeModelAccountRule[];
  /**
   * Whether to use Command Code as the backend for dsh's model-facing
   * `web_search` tool. When enabled, the plugin registers a `commandcode`
   * search provider on `ctx.web` AND selects `commandcode` in the web seam
   * (so it wins over the shipped `deepseek-official` or a sibling search
   * plugin's pin), using the SAME Command Code API key/base as chat. When
   * disabled, the selection is handed back to whichever backend was there
   * before — turning it off never forces the factory default, so a sibling
   * search plugin (e.g. modsearch) keeps working (issue #26). The rewrite
   * rides dsh's internal `searchProviderId`, which is read per search call,
   * so a setting change lands on the next search without a restart.
   * Defaults to true.
   */
  webSearch?: boolean;
  /**
   * Language override for the `/commandcode` Host-side command's user-facing
   * copy. Host commands cannot read the client's `ctx.locale`, so this is
   * the explicit knob: `'zh'` or `'en'`. Unset means the command reads
   * `LC_ALL`/`LANG` from the launching shell, falling back to `'zh'`. The
   * web settings page is unaffected — it follows the browser's language
   * preference on its own. Two surfaces, two independent locales. The
   * declared type is `string` (the schemastery `pattern` cannot narrow
   * literal types); an unknown value is treated as "unset" by
   * `pickCommandLocale`.
   */
  lang?: string;
}
declare const Config: z<Config>;
/** One resolution's complete request facts: connection plus credential reference. */
interface ResolvedCommandCodeOptions extends CommandCodeConnectionOptions {
  apiKeyEnv: CredentialRef;
}
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default is re-judged here — for the composition entry at load and for
 * each settings snapshot at its first use.
 */
declare function resolveAdapterOptions(config: Config): ResolvedCommandCodeOptions;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ACTIVE_ACCOUNT_AUTO, type ApiKeyValidation, BILLING_ACCESS_TTL_MS, COMMANDCODE_SEARCH_PROVIDER_ID, COMMAND_CODE_CLI_VERSION, type CommandCodeAccountConfig, CommandCodeAccountPool, type CommandCodeAccountSlot, type CommandCodeAccountState, type CommandCodeAccountUsage, type CommandCodeAccountsReport, CommandCodeAdapter, type CommandCodeAdapterDeps, type CommandCodeBillingAccess, type CommandCodeCommandDeps, type CommandCodeConnectionOptions, type CommandCodeLoginCredentials, type CommandCodeLoginFailureReason, CommandCodeLoginFlow, type CommandCodeLoginFlowDeps, type CommandCodeLoginStatus, type CommandCodeModelAccountRule, CommandCodeSearchProvider, type CommandCodeSearchProviderDeps, type CommandCodeSearchSelection, type CommandCodeTuiSettingsDeps, type CommandCodeUsageDeps, type CommandCodeUsageReport, CommandCodeUsageService, Config, DEFAULT_API_BASE, DEFAULT_GENERATE_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODELS_CACHE_PATH, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PROVIDER_ID, KNOWN_DEALS, KNOWN_EFFORTS, KNOWN_IMAGE_MODELS, KNOWN_PEAK_PRICING, KNOWN_PLANS, KNOWN_SUBSCRIPTION_PLANS, KNOWN_THINKING_MODELS, LANG_AUTO, LOGIN_ALLOWED_ORIGINS, LOGIN_BEGIN_ENDPOINT, LOGIN_BODY_LIMIT_BYTES, LOGIN_CANCEL_ENDPOINT, LOGIN_MAX_PORT_ATTEMPTS, LOGIN_START_PORT, LOGIN_STATUS_ENDPOINT, LOGIN_TIMEOUT_MS, type LoginFlowFacade, PLAN_LABELS, PLAN_ORDER, PROVIDER, type ResolveAttachments, ResolvedCommandCodeOptions, type TuiSettingsField, type TuiSettingsFieldOption, type TuiSettingsFieldWrite, type TuiSettingsGroup, type TuiSettingsSection, type TuiSettingsSectionsService, USAGE_REPORT_ENDPOINT, accountUsable, apply, applyCommandCodeSearchSelection, applyCommandCodeTuiSettings, applyCommands, applyUsageRemote, buildCommandAuthUrl, buildCommandCodeTuiSection, capabilityDescription, commandCodeSearchSelection, commandDefinition, compareByPlan, dealLabel, formatContext, inject, loginStatusSchema, matchModelRule, modelVisibleInPlan, name, parseLoginStatus, peakPricingLabel, peakPricingState, planLabel, projectSlugFromPath, resolveAdapterOptions, resolveAuthFileApiKey, selectAccountForModel, selectActiveAccount, selectCommandCodeSearchProvider, studioBaseForApiBase, subscriptionPlanInfo, usageReportSchema, validateCommandApiKey };
//# sourceMappingURL=index.d.ts.map