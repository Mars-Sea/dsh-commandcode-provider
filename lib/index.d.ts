import { GenerateOptions, LlmAdapter, LlmError, LlmImageRequestPricing, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk, projectOffloadedImages, requiredImageOffload } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { TypertRemoteService, TypertSchema } from "@deepseek-ai/dsh-typert-protocol";
import { WebRuntime, WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from "@deepseek-ai/dsh-attachment";
import { CommandDefinition } from "@deepseek-ai/dsh-commands";
//#region src/provider-errors.d.ts
/**
 * Why a pre-stream rejection rotates to another account. `rate-limit` (a usage
 * window the provider NAMED), `throttled` (a 429 that named no window) and
 * `invalid-credential` are the three the pool records as marks; `unavailable`
 * is an account-scoped rejection that must NOT become a mark — the account's
 * key is valid and its windows may be open, the ACCOUNT just cannot serve THIS
 * request — so the pool moves on without remembering anything.
 *
 * The window/throttle split decides what the pool may CLAIM, never whether it
 * rotates (issue #54); the evidence that separates them is in
 * {@link classifyAccountRejection}.
 */
type AccountRotationReason = 'rate-limit' | 'throttled' | 'invalid-credential' | 'unavailable';
//#endregion
//#region src/request-timing.d.ts
type Phase = 'credentials' | 'images' | 'body' | 'serialization' | 'headers';
type Outcome = 'finished' | 'error' | 'aborted' | 'cancelled';
interface RequestTimingSummary {
  version: 1;
  startedAt: number;
  model: string;
  outcome: Outcome;
  errorCode?: string;
  totalMs: number;
  phasesMs: Record<Phase, number>;
  firstByteMs?: number;
  firstContentMs?: number;
  attempts: Array<{
    protocol: string;
    bodyBytes: number;
    headersMs: number;
    status?: number;
  }>;
}
type RequestTimingSink = (summary: RequestTimingSummary) => void | Promise<void>;
//#endregion
//#region src/stream-response.d.ts
/**
 * Endpoint protocol selected for one generate call.
 *
 * `messages` is the Anthropic Messages surface at
 * `{apiBase}/provider/v1/messages`, the only Provider API route the Claude
 * family answers (posted to `/chat/completions` they refuse with `400 Model
 * "<id>" must be called via /provider/v1/messages`). `openai` is the
 * documented Chat Completions surface; `cli` is Command Code's private
 * `/alpha/generate` transport, kept for Go-plan keys (the one plan without
 * Provider API access) and as the `upgrade_required` fallback.
 */
type CommandCodeProtocol = 'cli' | 'openai' | 'messages';
//#endregion
//#region src/gateway-facts.d.ts
declare const DEFAULT_MAX_OUTPUT_TOKENS = 131072;
//#endregion
//#region src/adapter.d.ts
declare const COMMAND_CODE_CLI_VERSION = "1.88.2";
declare const DEFAULT_API_BASE = "https://api.commandcode.ai";
/**
 * The output budget this bundle asks for, and the ceiling it will never exceed.
 * The figure and its probe evidence live in `./output-budget.ts` — the module
 * the browser settings page also bounds its input by — and are re-exported here
 * under the historical name so existing importers are unaffected.
 */
declare const DEFAULT_GENERATE_MAX_TOKENS = 131072;
/** How long the picker's plan-filter billing facts stay cached before refetching. */
declare const BILLING_ACCESS_TTL_MS: number;
/**
 * Head-of-request timeout: how long to wait for the first response byte.
 *
 * 300 s, and that number is the official CLI's, not a round choice. Decompiled
 * from `command-code@1.66.0`: its `createNodeTransport` fetch passes only the
 * caller's `signal` and sets no timeout at all, so the model request inherits
 * Node/undici's own default — measured at 301.0 s against a local server that
 * accepts the connection and never sends headers. The previous 60 s default was
 * five times stricter than the CLI it emulates, and being stricter only ever
 * costs legitimate requests: a slow upstream first token on the Provider API
 * route can outlast 60 s, and the official CLI simply waits it out. Measured
 * headers (2026-09-28, 26 250-token prompt, `max_tokens: 16` to separate the
 * header from the generation): `/alpha/generate` 2.12 / 2.56 / 2.75 s,
 * `/provider/v1/chat/completions` 5.52 / 2.98 / 3.70 s — a ~1.1 s median gap
 * with the Provider API route varying over a 2.5 s span against the CLI route's
 * 0.6 s. A gateway that is genuinely dead now takes longer to name itself,
 * which is what the consecutive-timeout streak exists to bound (three
 * attempts, then a diagnosis instead of another re-send).
 */
declare const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
declare function projectSlugFromPath(pathName: string): string;
/** Read a usable Command Code credential from the official CLI auth file. */
declare function resolveAuthFileApiKey(): string | undefined;
/**
 * The engine's durable-offload contract, as one object.
 *
 * Both members are required together: a half-populated policy would either lose
 * the surface's marks (re-sending evicted images as pixels) or lose the count
 * (silently sending an over-budget body), and neither is worth a partial
 * opt-in. The defaults are the engine's own helpers; the object exists so tests
 * can substitute a counting stub.
 */
interface SurfaceImagePolicy {
  /** Render the surface's durable offload marks as placeholder text. */
  projectOffloadedImages: typeof projectOffloadedImages;
  /** How many more leading retained occurrences must be offloaded. */
  requiredImageOffload: typeof requiredImageOffload;
}
/** Connection facts resolved fresh per request by the plugin entry. */
interface CommandCodeConnectionOptions {
  /** API base; the Provider API lives under it (`/alpha/generate`, `/provider/v1/chat/completions`, `/provider/v1/models`). */
  apiBase: string;
  /** Working directory reported to the API (project slug, config block). */
  workingDir: string;
  /** Model catalog cache path. */
  modelsCachePath: string;
  /**
   * Milliseconds to wait for generate response headers / first byte (default
   * 300s, the official CLI's own budget — see
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}).
   * Must not bound the subsequent body stream — long generations are gated by
   * {@link streamIdleTimeoutMs} and the caller AbortSignal instead.
   */
  requestTimeoutMs: number;
  /** Milliseconds a stream may stall before it is treated as a dead connection (default 300s). */
  streamIdleTimeoutMs: number;
  /**
   * Opt-in CLI cache mitigation: after this same model has answered with an
   * image in its history, ask dsh's durable image-offload surface to replace
   * that image before the next replay. This protects the growing text prefix
   * when Command Code's multimodal cache retreats to the first image, but the
   * model cannot inspect the old pixels again without a fresh tool/user image.
   */
  offloadSeenImagesForCache?: boolean;
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
   * 自定义上下文长度（全局值，issue #86）：对没有 {@link contextWindowOverrides}
   * 条目的目录模型，宣告给宿主的上下文窗口改用此值而非目录的
   * `context_length`；选择器标注、`defaultMaxTokens` 预算同样跟随。
   * 留空表示完全跟随目录。
   */
  contextWindow?: number | undefined;
  /**
   * 按模型的自定义上下文长度，键为目录模型 id；优先于 {@link contextWindow}。
   * 非法条目在 `resolveAdapterOptions` 已被清洗，这里只读已判定的值。
   */
  contextWindowOverrides?: Readonly<Record<string, number>> | undefined;
  /**
   * 输出预算上限（issue #74）。未设置＝沿用既有推导（模型公布/学习上限、
   * 网关总上限）。正整数＝用户上限，与推导值取较小者，永远不会超过网关总上限。
   * `0`＝不发送 `max_tokens`，把单轮输出规模交回平台——仅 CLI 与 OpenAI 传输
   * 支持；Messages 端点必填该字段，因此那条链路仍按推导值发送（见
   * `omitOutputTokens()`）。
   */
  maxOutputTokens?: number | undefined;
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
  /**
   * Whether requests enforce zero data retention by sending the
   * `x-cmd-zdr: 1` header (the same opt-in the official CLI exposes as
   * `CMD_ZDR=1`). Default false. Every chat request carries the header when
   * enabled. The provider refuses a model without a ZDR-capable upstream with
   * 422 `cmd_zdr_no_providers`; never retry that request without the header.
   */
  zdr?: boolean;
}
/**
 * Resolve the durable attachment service, or undefined when the host does not
 * provide one. Called lazily only when a request actually carries images, so a
 * text-only request never depends on the attachment seam.
 */
type ResolveAttachments = () => AttachmentStore | undefined;
/**
 * What the rotation hook knows about the request it is rotating within.
 *
 * Not exported: the only consumer is the `rotateApiKey` shape below, so the
 * name never reaches the published `.d.ts` and the package's `exports` map
 * leaves no deep-import path to it.
 */
interface AccountRotationContext {
  /** Every API key this request has already used, just-rejected key included. */
  tried: readonly string[];
  /** The provider's own reset time for a `rate-limit` rejection, in millis. */
  resetAtMs?: number;
}
/** Everything the adapter needs beyond the request itself. */
interface CommandCodeAdapterDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** 可选的数值耗时接收器；不接收提示词、凭据或错误正文。 */
  onRequestTiming?: RequestTimingSink;
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
   * refused before any response body streamed, for an account-scoped reason
   * (see {@link AccountRotationReason}). The host marks that key when the
   * reason warrants it and returns the next account's key to retry with, or
   * `undefined` to surface the failure. Only pre-stream rejections rotate — a
   * mid-stream failure never replays a partially consumed generation against
   * another account.
   *
   * `rotation.tried` lists every key this request has already used (the
   * just-rejected one included). The host must not offer one of them again:
   * with several accounts a rejection that does not mark the key (a plan or
   * balance rejection is model-specific, not account-fatal) would otherwise
   * re-offer the same account on every attempt and the pool could never reach
   * the accounts behind it. `rotation.resetAtMs` carries the provider's own
   * reset time when the rejection body published one, so the host can hold the
   * key out until then instead of waiting for a billing probe to learn the
   * same fact.
   */
  rotateApiKey?: (rejectedKey: string, rejection: AccountRotationReason, connection: C, model?: string, rotation?: AccountRotationContext) => Promise<string | undefined>;
  /**
   * Every API key the host can serve from, in rotation order and deduplicated
   * — the multi-account pool's own list. The picker's plan filter asks all of
   * them, because the pool (not any single account) is what serves a request;
   * a host without a pool omits this seam and the filter falls back to the key
   * that would serve the current request.
   */
  resolveAccountKeys?: (connection: C) => Promise<readonly string[]>;
  /** HTTP transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Resolve the optional durable attachment service for image input (tests); defaults to none. */
  resolveAttachments?: ResolveAttachments;
  /**
   * Request-image policy override (tests); defaults to the engine's own
   * `projectOffloadedImages`/`requiredImageOffload`. Injecting a stub is how a
   * test observes the budget rungs a 413 walks.
   */
  imageOffload?: SurfaceImagePolicy;
}
/** Account identity from `/alpha/whoami`; reached only through `CommandCodeUsageReport`. */
interface CommandCodeAccount {
  id: string;
  name: string;
  userName: string;
}
/** Usage summary from `/alpha/usage/summary`; reached only through `CommandCodeUsageReport`. */
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
  /** 官方汇总返回的统计起点；缺失时不把查询参数当作已确认的统计范围。 */
  periodStart?: number;
}
/** Credit/limit state from `/alpha/billing/credits`. */
interface CommandCodeCredits {
  monthlyCredits: number;
  purchasedCredits: number;
  freeCredits: number;
  /**
   * Whether the endpoint actually published a monthly balance. The scalar
   * above defaults to 0 for shape stability, which is a LIE about an omitted
   * field — and a false "0 left, fully consumed" on the dashboard. Consumers
   * that render the figure must check this first: an explicit `false` means
   * "not reported", not "nothing left".
   *
   * Optional on purpose. `undefined` means the flag itself was never recorded —
   * an older Host half, or a frame from before this field existed — and is read
   * as "assume reported", which is the behavior that shipped. Only an explicit
   * `false` from a Host that knows the balance was omitted suppresses the
   * figure, so a cross-version pair does not lose a real balance.
   */
  monthlyReported?: boolean;
  purchasedReported?: boolean;
  freeReported?: boolean;
  /**
   * Five-hour rolling window limits, absent when the endpoint reported no such
   * window. Absence is NOT "a window with no cap": a reported window with
   * `cap === 0` is uncapped spend, while an absent one was never reported at
   * all, and only the un-reported case must keep a figure off the dashboard.
   */
  fiveHour?: {
    used: number;
    cap: number;
    exceeded: boolean;
    resetAt: number;
  };
  /** Weekly window limits; absent under the same rule as {@link fiveHour}. */
  weekly?: {
    used: number;
    cap: number;
    exceeded: boolean;
    resetAt: number;
  };
}
/** Subscription plan state from `/alpha/billing/subscriptions`; reached only through `CommandCodeUsageReport`. */
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
  /** 官方订阅账期起点，毫秒；旧宿主或未报告该字段时缺省。 */
  currentPeriodStart?: number;
}
/**
 * Why every account endpoint failed at once (the report then carries no data
 * at all, so the degraded per-endpoint view would hide the root cause behind
 * a generic "partial data" note). Undefined for partial failures.
 */
type UsageBlockReason = 'invalid-key' | 'service-unavailable' | 'invalid-response' | 'network';
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
   * `service-unavailable` (every call answered 5xx), `invalid-response`
   * (every call answered but its body was not usable JSON), or `network`
   * (no HTTP response at all). Undefined when any endpoint succeeded.
   */
  blocked?: UsageBlockReason;
}
declare class CommandCodeAdapter<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> extends LlmAdapter {
  private readonly deps;
  private readonly gatewayFacts;
  private readonly fetchImpl;
  private readonly resolveAttachments;
  /**
   * The durable-offload contract, resolved once (tests may inject a stub). The
   * contract cannot change while the process runs.
   */
  private readonly surfaceOffload;
  private readonly billingAccess;
  private readonly billingAccessInflight;
  /**
   * Successful account-endpoint responses, keyed by gateway + key + exact URL.
   *
   * The settings card and the picker's advisory plan filter ask the SAME three
   * endpoints about the SAME account (`/alpha/whoami`, then credits and
   * subscriptions in parallel). Here that is four round trips per surface for
   * two answers — and the card refreshes on a timer, so the picker keeps paying
   * for rows it already has. Sharing the raw responses removes the duplicate
   * without either surface having to know about the other: whoever asks second
   * within {@link ACCOUNT_FACTS_TTL_MS} reads the same record instead of the
   * wire.
   *
   * Only SUCCESSFUL records are kept. A failure must be retried rather than
   * replayed, or an endpoint that recovered a second ago would keep reporting
   * yesterday's outage — and the usage report's per-endpoint `failures` and
   * {@link classifyTotalFailure} verdict would describe a request this process
   * never made.
   */
  private readonly accountJson;
  private readonly protocolCache;
  /** Namespace account-derived facts by gateway without exposing the key. */
  private accountCacheKey;
  /**
   * Consecutive header timeouts for the last request shape, counted ACROSS
   * `stream()` calls: dsh-llm-retry re-invokes this same instance, so this is
   * the only place a streak can live. Keyed by `sessionId` (not by `agent`:
   * `GenerateOptions` carries no agent reference, only `sessionId`) so
   * concurrent sessions on this one shared adapter instance cannot clear or
   * inflate each other's count. A call with no `sessionId` (a one-shot,
   * session-less caller) falls back to {@link GLOBAL_HEADER_TIMEOUT_KEY},
   * matching the old single-slot behavior for exactly that case. Bounded by
   * {@link MAX_HEADER_TIMEOUT_STREAK_ENTRIES} with FIFO eviction (`Map`
   * preserves insertion order) since the key space is per-session rather than
   * per-account/model, so it is not naturally small like `protocolCache`.
   */
  private readonly headerTimeoutStreaks;
  private static readonly MAX_HEADER_TIMEOUT_STREAK_ENTRIES;
  constructor(deps: CommandCodeAdapterDeps<C>);
  /**
   * Grade one failed attempt: a headers timeout that repeats on an unchanged
   * payload eventually leaves the retryable whitelist.
   *
   * `providerRetryPolicy()` cannot express this itself — dsh-llm's
   * `NormalRetryPolicyConfig` carries one `maxRetries` for every listed code.
   * Escalating here stops repeated identical header timeouts with a specific
   * diagnosis; the agent listener separately caps ordinary transient errors.
   *
   * @returns the error to surface: unchanged for any other failure, the
   * original timeout below the threshold, and a terminal one at it.
   */
  private gradeHeaderTimeout;
  /**
   * Display metadata for the picker's provider group header. The base class
   * returns the raw route id (`commandcode`, all lowercase) as the name, which
   * is what the model selector shows as this group's sticky title; return the
   * proper display name instead, matching the Models settings page card (the
   * configurable-provider `displayName`). The id must stay equal to the route.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * The official executor owns backoff and provider reset waits. Its high
   * route-wide cap lets a confirmed `RATE_LIMIT` window recover in-session;
   * our request-error listener limits `SERVER`/`TIMEOUT`/`EMPTY_RESPONSE`/
   * `THROTTLED` to three retries and `TRANSPORT` to its separate budget.
   * Waits double from 500 ms and cap at 15 minutes (±10% jitter). Permanent failures
   * (an invalid key's `INVALID_CREDENTIAL`, `UNSUPPORTED_CONTENT`, plan
   * rejections) are absent from the whitelist and surface immediately instead
   * of looping. Waits the pool/adapter attach as `providerRetryAfterMs` are
   * honored verbatim at or below the 15-minute cap and never attached above it
   * (in normal mode a longer attached wait makes the executor abandon the
   * retry outright — see RETRY_MAX_DELAY_MS).
   *
   * Captured once at route registration (dsh-llm snapshots this value), so a
   * future config knob for it would apply on profile restart, not per request.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
  /**
   * Visual-token pricing for one exact model route (see `./image-tokens.ts`).
   *
   * Without this the token meter prices EVERY image with its structural
   * heuristic — a handful of tokens for a full screenshot — so an image-heavy
   * session reports far less context than it is actually carrying. The price is
   * computed at the dimensions this route would send (the same request target
   * `readImageRequest` encodes to), so the estimate tracks the wire rather than
   * the stored original. One price per occurrence, in order, is a hard
   * requirement — the meter throws when the counts differ.
   */
  imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined;
  /**
   * The dimensions and byte target this route actually puts on the wire.
   *
   * The base default answers with the NORMALIZED original (`image.width`,
   * `image.height`, `image.bytes`), which is right only for an adapter that
   * does not resize. This route always re-encodes through
   * `readImageRequest(ref, requestImageTarget(ref))` — long edge 1568, encoded
   * bytes capped at 1 MiB — so the default would over-report both dimensions
   * and bytes for every image, most visibly for Retina screenshots.
   *
   * `imageRequestPricing` above already prices at this same target; exposing it
   * here keeps the harness's own readers (the CUA screenshot path calls
   * `ctx.llm.imageRequestTarget`) consistent with what the gateway receives.
   * @param _provider - registered provider route; one route per adapter here.
   * @param _model - exact model id; the target is model-independent on this route.
   * @param image - normalized attachment whose request projection is resolved.
   * @returns the same target `readImageRequest` encodes to, before base64 expansion.
   */
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget;
  listModels(provider: string, opts?: {
    unfiltered?: boolean;
  }): Promise<readonly LlmModelInfo[]>;
  /**
   * The per-model allowance bracket this account POOL falls into, or undefined
   * when there is nothing honest to show.
   *
   * The pricing page publishes per-model monthly allowances for Go, GOAT and
   * Pro. A pool whose highest plan is Provider,
   * Max or Ultra gets undefined rather than a neighbouring tier's figure. Taking
   * the HIGHEST tier matches the question the picker already answers for a pool
   * (see `modelVisibleForAnyAccount`): what the user can reach, not what the one
   * account serving this request happens to be. The fail-open shape is the same
   * too — an unreachable billing endpoint yields undefined, which hides the
   * allowance instead of inventing one.
   */
  allowanceTier(): Promise<'go' | 'goat' | 'pro' | undefined>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /**
   * Resolve and validate the key one account-endpoint call will use.
   *
   * Every account endpoint runs the chat path's own `assertUsableApiKey` check,
   * or a key carrying a character no HTTP header can hold throws inside `fetch`
   * BEFORE any I/O — once per endpoint — and the report reads as "the network is
   * down". The credential reference is read structurally: it belongs to the
   * host's resolved options, not to this adapter's connection type, and it only
   * names the key in the rejection message.
   *
   * Separate from {@link accountHeadersFor} so a caller that also needs to key a
   * cache by the same identity does not have to resolve the key twice.
   */
  private usableAccountKey;
  /** The headers every authenticated account endpoint shares. */
  private accountHeaders;
  /** Headers for an already-validated key; see {@link usableAccountKey}. */
  private accountHeadersFor;
  /**
   * Fetch one JSON GET and return its HTTP status with a parsed record. The
   * catalog, billing probe, and usage report each apply their own failure
   * policy. Non-2xx and unusable bodies come back without a record; only
   * a failure before receiving the response propagates to the caller.
   * 正文读取、JSON 解析与顶层结构分别诊断，不能把已收到响应后的断流当成格式错误。
   *
   * `timeoutMs` is the caller's budget, unless it provides its own signal.
   * The usage report passes the connection's request budget rather than the
   * catalog/picker's shorter default.
   */
  private fetchJson;
  /**
   * Every account's billing facts behind the picker's plan filter, in the
   * pool's rotation order and cached per key for {@link BILLING_ACCESS_TTL_MS}
   * (so the extra accounts cost their three requests once per TTL, not once
   * per picker load). `undefined` means the filter cannot be evaluated at all
   * — no key resolved — which {@link modelVisibleForAnyAccount} reads as
   * "show everything".
   */
  private loadPoolBillingAccess;
  /**
   * The API keys the picker's plan filter must consult: every account the host
   * can serve from, in rotation order, when the host exposes one. A host
   * without a pool (or without the seam) reports just the key that would serve
   * this request — exactly the pre-pool behaviour.
   */
  private poolAccountKeys;
  /**
   * One account's billing facts, cached for {@link BILLING_ACCESS_TTL_MS} and
   * shared across concurrent callers. `undefined` means "unknown — show
   * everything" (fail-open).
   */
  private loadBillingAccessForKey;
  /**
   * One account-endpoint GET, served from {@link accountJson} when `share` and
   * the same URL answered successfully within {@link ACCOUNT_FACTS_TTL_MS}.
   *
   * `timeoutMs` is the CALLER's budget; a cache hit spends none of it. Failures
   * are never cached, so this can only ever save a request that would have
   * re-read an answer this process already had.
   *
   * `share: false` marks a VOLATILE endpoint — one whose answer is the number
   * the user is actually looking at, and which must therefore never be replayed
   * from an earlier request. The usage card's summary is exactly that: its
   * headline counts and cost are the reason the card exists, and stamping a
   * cached copy with the current time would misreport when they were read.
   * Identity and billing facts are the opposite: a plan tier or an org id that
   * is 30 s old is still the truth, and those are what the picker duplicates.
   */
  private accountJsonGet;
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
  private cachedProtocol;
  private rememberProtocol;
  /**
   * True when the catalog routes `model` to `/provider/v1/messages`.
   *
   * The catalog's own `supported_endpoints` is authoritative (it is what
   * upstream publishes per model); `requiresMessagesEndpoint()` — the
   * `claude-*` prefix rule — is the fallback for a catalog entry that carries
   * no route list, which is the shape every pre-1.55 cache file has.
   */
  private routesToMessages;
  /**
   * Choose the initial protocol for one request.
   *
   * Models the Provider API serves only through `/provider/v1/messages` (the
   * Claude family) take the Messages transport on any tier and even under a
   * forced `'openai'` preference: that option is documented as "prefer the
   * Provider API, still fall back", and the 400 these models answer with on
   * Chat Completions (`Model "<id>" must be called via /provider/v1/messages`)
   * is a hard refusal, not a preference to honour.
   *
   * That decision is deliberately NOT written to `protocolCache`, which is
   * keyed by gateway and API key: it depends on the model, not just the account, so
   * remembering it would pin the whole ACCOUNT to one transport and drag
   * every other model along (issue #46).
   *
   * Otherwise a fresh protocol cache entry wins, then a cached (not
   * network-fetched) billing tier of Go — the one plan without Provider API
   * access. Unknown accounts default to Chat Completions and fall back to the
   * CLI transport only after an `upgrade_required` rejection.
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
   *
   * Two failure modes are NOT "the network is down", and the report must say
   * so rather than let {@link classifyTotalFailure} blame the connection: a
   * key that no HTTP header can carry (a stray newline from a paste, a
   * full-width character) makes `fetch` throw a `TypeError` before any I/O,
   * for every endpoint at once, so this path runs `assertUsableApiKey` too and
   * answers `blocked: 'invalid-key'`; and the four endpoints get the SAME
   * per-request budget as a chat call (`connection.requestTimeoutMs`, default
   * 60 s), not the catalog's 10 s probe budget, because on a slow link a 10 s
   * cap made every account query time out while chat kept working.
   */
  getUsage(apiKey?: string, capturedConnection?: C): Promise<CommandCodeUsageReport>;
  /**
   * Probe one account's real usage windows from `/alpha/billing/credits`. The
   * multi-account pool calls this when every account is marked exhausted: an
   * account whose windows no longer report `exceeded` is revived, and the
   * `resetAt` values feed the "earliest reset" error message.
   *
   * BOTH windows the endpoint publishes are read, not just `fiveHour`. An
   * account can have an open five-hour window and an exhausted WEEKLY quota at
   * the same time (the two are metered separately), and reading only the
   * shorter one revived such an account as "usable" — the pool then handed it
   * out, the provider rejected the request again, and the next all-marked pass
   * revived it once more (issue #51's follow-up: "切到一个不可用账号").
   * `exceeded` is therefore true when ANY published window is exceeded, and
   * `resetAt` is the LATEST reset among the exceeded ones — the binding
   * constraint, because a clear five-hour window buys nothing while the weekly
   * quota is spent.
   *
   * Returns `undefined` when the probe itself failed (transport, non-200, or a
   * payload with no window limits at all) — a failed probe never changes pool
   * state. The credit balances are deliberately NOT part of this answer: they
   * carry no reset time, and the server remains the final gate on them.
   */
  probeWindowLimits(apiKey: string, connection?: C): Promise<{
    exceeded: boolean;
    resetAt: number;
  } | undefined>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private streamWithTiming;
  /**
   * One turn, with at most one output-ceiling downshift.
   *
   * The ceiling a model accepts is not published anywhere the request can be
   * built from (see `modelOutputTokenLimit`), and the endpoint states it only
   * by refusing. That refusal is worth one retry rather than a failed turn: the
   * harness's own recovery for it — compact the context — cannot help, because
   * nothing about the context is wrong, and resending the identical request
   * would be refused identically (issue #71). Reading the stated ceiling off
   * the rejection turns one wasted turn into one, for good: it is recorded
   * process-wide, so the next request for this model is built correctly
   * without spending the round trip again.
   *
   * Only BEFORE the first chunk reaches the host. Once a delta has been
   * delivered the answer is already partly on screen, and a second request
   * would duplicate it — so from that point the error stands and says what is
   * actually wrong. One downshift per turn, and a second refusal surfaces.
   */
  private streamRequest;
  private streamAttempt;
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
type AccountRejection = 'rate-limit' | 'throttled' | 'invalid-credential';
/** One key's rotation state. */
interface CommandCodeAccountState {
  kind:
  /** Marked by a 429; the window's reset time is unknown until probed. */
  'unknown' |
  /** Probed (or marked with a known reset): unusable until `until` (millis). */
  'cooldown' |
  /** Marked by a 401: skipped until the stored credential changes. */
  'disabled';
  /**
   * The evidence behind the mark — what the pool may CLAIM when it reports that
   * no account can serve. `window`: the provider named a usage window, or a
   * `/alpha/billing/credits` probe read one as exceeded. `throttle`: a 429 that
   * said nothing about a window (a burst limiter, or a model-/spend-level limit
   * the billing endpoint cannot show). `auth`: a 401.
   */
  cause: 'window' | 'throttle' | 'auth';
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
/**
 * One account's real rate-limit state, probed from `/alpha/billing/credits`:
 * `exceeded` is true when ANY of the account's usage windows is spent, and
 * `resetAt` is the latest reset among them (the binding constraint — an open
 * five-hour window buys nothing while the weekly quota is exhausted).
 */
interface AccountWindowProbe {
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
  /** Probe one key's usage windows (BOTH windows the endpoint publishes); undefined when it failed. */
  probeWindow(apiKey: string): Promise<AccountWindowProbe | undefined>;
  /**
   * The manually selected account slot id, re-read per resolution. It serves
   * whenever it is usable; an unknown id or an exhausted preferred account falls
   * back to the first usable slot — and an exhausted one is re-probed on the way
   * (see {@link CommandCodeAccountPool.resolveKey}), so the fallback lasts only
   * as long as the window really is exceeded.
   */
  preferredId?(): string | undefined;
  /**
   * Model → account routing rules, re-read per resolution so settings changes
   * apply live. A matching, usable routed account serves before the
   * preferred/rotation selection; an unusable one falls back to the normal
   * selection — the router is a hint, never a hard gate.
   */
  modelAccountRules?(): readonly CommandCodeModelAccountRule[];
  /**
   * Clock seam for the explicit-account probe throttle, so the "the interval
   * elapsed" half of {@link CommandCodeAccountPool.canProbeExplicit} is testable
   * without waiting a real minute. Production reads `Date.now()`.
   */
  now?(): number;
}
/**
 * One "route these models to that account" rule. `models` lists catalog ids
 * (`deepseek/deepseek-v4-pro`, …); `account` is a slot id (`default` or an extra
 * account's credential reference). The first matching rule in list order wins.
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
 * Pick the account that should serve now: the manually preferred slot when it is
 * usable, otherwise the first usable account in rotation order; undefined when
 * no account is usable. Shared by the pool (request path) and the plugin entry
 * (the usage view's active badge) so both always agree.
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
/** 不包含解析秘密的账号定义；作用域独立复制列表及模型规则。 */
interface CommandCodeAccountSelection {
  slots: readonly CommandCodeAccountSlot[];
  preferredId?: string | undefined;
  modelAccountRules: readonly CommandCodeModelAccountRule[];
}
/** 账号选择与展示共用恢复规则；宿主作用域内的状态按网关与密钥共享。 */
declare class CommandCodeAccountPool {
  private readonly deps;
  /** 当前作用域内按密钥共享的健康状态；不记录到日志。 */
  private states;
  /** 当前网关与密钥的显式探测时间，限制失败探测的频率。 */
  private explicitProbes;
  /**
   * 模型级 `unavailable` 软标记：`key\0model` → 过期时刻（毫秒）。
   * 只影响选择顺序，从不参与 {@link accountUsable}，所以免费模型仍可用。
   */
  private modelUnavailable;
  private scopedStates;
  constructor(deps: CommandCodeAccountPoolDeps);
  /** 每个调用持有自己的定义和探测，只有同网关的健康事实共享；不临时改写全局依赖。 */
  scope(context: CommandCodeAccountSelection & {
    apiBase: string;
    probeWindow: CommandCodeAccountPoolDeps['probeWindow'];
  }): CommandCodeAccountPool;
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
  resolveKey(options?: {
    tried?: readonly string[];
    model?: string;
  }): Promise<{
    key: string;
    slot: CommandCodeAccountSlot;
  } | undefined>;
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
  activeAccount(): Promise<ResolvedAccount | undefined>;
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
  markRejected(apiKey: string, rejection: AccountRejection, resetAtMs?: number): void;
  /**
   * 用量报告读到的窗口结论（设置页账号卡片、`/commandcode` 拉取的
   * `/alpha/billing/credits`）：某个窗口已超限，就按探测的同一口径给这个密钥
   * 打标记——有可信重置时刻记为到期自动恢复的 `cooldown`，否则为 `unknown`。
   *
   * 为什么需要（issue #105）：轮转原本只认真实请求的拒绝，进程重启或冷却过早
   * 到期后，卡片明明显示「每周 100%」，自动模式和「当前使用」徽标仍选列表第一个
   * 账号，下一个请求白撞一次拒绝才换号。报告本来就要拉这个接口，把结论记进池里
   * 不增加任何请求。
   *
   * 只加不减：窗口未超限时不清除已有标记。限流（throttle）或消费上限这类拒绝
   * 在窗口数据里看不到（issue #54），据此清标记会让每次刷新卡片都换来一次注定
   * 被拒的请求；清除仍只走有节流的探测路径。401 禁用的密钥不改。
   */
  noteWindowReport(apiKey: string, verdict: AccountWindowProbe | undefined): void;
  /**
   * Record a model-scoped `unavailable` rejection (no credits, or a model
   * outside this account's plan) as a SHORT-LIVED PREFERENCE demotion.
   *
   * 职责：让同一模型的后续请求先跳过这个账号，而不是每一步都重撞一次
   * `400 insufficient credits`；同时刻意不写进 `states`，所以
   * {@link accountUsable} 与 {@link activeAccount} 都不受影响——余额为空的
   * 账号仍然能服务 `:free` 模型，账号卡片也不会把它标成"不可用"。
   *
   * 为什么按时限而非永久：余额/套餐是可以不换密钥就改变的事实（充值、升级），
   * 而进程内没有任何事件能通知这改变，所以只能靠时钟自行恢复。
   */
  markModelUnavailable(apiKey: string, model: string): void;
  /** Drop every model-scoped mark for one key (a new credential invalidates them). */
  private clearModelUnavailable;
  /**
   * The candidates for THIS model, in preference order: accounts without a live
   * model-scoped mark first, everything else after them.
   *
   * 为什么要"排后"而不是"剔除"：软标记只是偏好（见
   * {@link markModelUnavailable}）。全部候选都被标记时必须退回全量，否则唯一
   * 账号的池子会变成"没有可用账号"，把一次余额不足误报成额度耗尽。
   */
  private withoutModelUnavailable;
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
  private resolveSlotKey;
  /**
   * The account the user explicitly asked for: the slot a model rule routes the
   * request to when that id exists among the resolved slots, else the manually
   * pinned slot. Consulted only on the fallback path, so — unlike
   * {@link selectAccountForModel} — it does NOT require the account to be usable,
   * which is exactly what {@link resolveKey} re-probes.
   */
  private explicitAccount;
  /**
   * Whether an explicitly selected account's mark is due for a window probe.
   * Only an `unknown` mark (a 429 whose reset was never learned) is worth
   * re-probing: a `cooldown` carries its reset and expires by itself, and a
   * `disabled` (401) key stays out until the stored credential changes. The
   * interval bounds a probe endpoint that keeps failing.
   */
  private canProbeExplicit;
  /** The clock the probe throttle reads; injected so a test can travel in time. */
  private now;
  /**
   * Probe one explicitly selected account's window and apply the answer. A
   * window that is no longer exceeded drops the mark, so the user's own
   * selection serves again on this very request; an exceeded one is stamped as
   * a cooldown carrying the provider's reset time, after which
   * {@link accountUsable} lets the account back in with no further probe. A
   * probe that fails changes nothing: the mark stays `unknown` and the next
   * attempt waits out the interval.
   */
  private probeExplicit;
  /**
   * Stamp a probe-read window onto one key. A known reset becomes a cooldown
   * that expires by itself; without one the mark stays `unknown`, so a later
   * probe can still learn it — and a mark that already carries a cooldown
   * keeps it, never trading a known reset for an unknown one. The cause is
   * `window` either way: a probe that read a window as exceeded IS window
   * evidence, whatever the key was marked for. An `until: 0` cooldown would
   * read as "never usable again" to {@link accountUsable}, so `unknown` it is.
   */
  private stampWindowMark;
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
  private reviveExplicit;
  /**
   * Probe every marked account's real usage window when nothing currently
   * resolves. Disabled (401) keys are not probed — an invalid key stays
   * invalid. A throwing probe counts as "unknown" (like a failed one): it
   * must not turn the all-exhausted path into a raw rejection instead of
   * RATE_LIMIT. Shared by {@link resolveKey} and {@link activeAccount}.
   */
  private probeAllMarked;
  /** Hand out the chosen account's key. */
  private pick;
}
//#endregion
//#region src/enrollment-wire.d.ts
interface EnrollmentInput {
  id: string;
  pageId: string;
  mode: 'browser' | 'manual';
  label: string;
  /** 用户未填写名称时，允许使用浏览器登录返回的账号名。 */
  automaticName: boolean;
  key?: string;
}
type EnrollmentPhase = 'creating' | 'waiting' | 'writing' | 'naming' | 'finished' | 'cancelling' | 'cancelled' | 'failed' | 'cleanup-needed';
/**
 * 账号开通状态的语义消息键。
 *
 * 状态消息传键而不是成品文案：界面语言由浏览器侧持有，宿主没有立场去猜；同一条状态
 * 要在中文与英文界面下各自显示，而 `phase` 不足以唯一确定它——`naming` 既有「正在
 * 保存名称」也有「名称保存失败」，`cleanup-needed` 既有「收尾未完成」也有「清理未
 * 完成」，`cancelled` 既有「已取消」也有「已取消并清理」。客户端拿这些键走 `t()`
 * 渲染，不必再匹配自由文本；`SettingsCommandCodeKey` 收录本类型，因此新增键漏写
 * 中文或英文字典都会被类型检查拦下。
 *
 * 其中十五条由宿主产出（`src/enrollment.ts`），`enrollmentCleanupPending` 也在此列——
 * 它在「收尾未完成」时由宿主与页面两侧共用同一个键；另外七条是浏览器侧控制器的专属键
 * （`src/client/enrollment.ts`），只在传输失败或连接断开时由该侧自己产出。宿主抛出的
 * 异常消息不在此列：它们不上屏，客户端在所有失败路径都用自己这一侧的文案覆盖。
 */
type EnrollmentMessageKey = 'enrollmentCreating' | 'enrollmentWaiting' | 'enrollmentWriting' | 'enrollmentNaming' | 'enrollmentNameFailed' | 'enrollmentFinished' | 'enrollmentCancelling' | 'enrollmentCancelled' | 'enrollmentCancelledCleaned' | 'enrollmentFailed' | 'enrollmentFailedCleaned' | 'enrollmentCleanupPending' | 'enrollmentCleanupFailed' | 'enrollmentRecordNaming' | 'enrollmentRecordCleanup' | 'enrollmentBeginFailed' | 'enrollmentCancelUnconfirmed' | 'enrollmentNameRequestFailed' | 'enrollmentCleanupRequestFailed' | 'enrollmentDisconnected' | 'enrollmentHostUnavailable' | 'enrollmentStatusUnavailable';
interface EnrollmentState {
  id: string;
  ref: string;
  phase: EnrollmentPhase;
  /** 要显示的语义键；文案由浏览器侧按界面语言渲染，见 {@link EnrollmentMessageKey}。 */
  messageKey: EnrollmentMessageKey;
  authUrl?: string;
  suggestedName?: string;
}
/** 配置中的恢复日志：先登记，再写凭据；只保留引用与阶段，不保留密钥或连接身份。 */
interface EnrollmentRecord {
  id: string;
  ref: string;
  phase: 'pending' | 'naming' | 'cleanup';
  label: string;
}
interface EnrollmentPage {
  pageId: string;
}
interface EnrollmentAction extends EnrollmentPage {
  id: string;
  name?: string;
}
//#endregion
//#region src/plan-tiers.d.ts
declare const PLAN_LABELS: Readonly<Record<string, string>>;
declare const PLAN_ORDER: Readonly<Record<string, number>>;
//#endregion
//#region src/capabilities.d.ts
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
 * Models WITHOUT a zero-data-retention upstream. Through command-code@1.82.2
 * the CLI's own registry answered this: `modelSupportsZdr(id)` was exactly
 * `!nonZdrSet.has(canonicalize(id))`, and `knownModelSupportsZdr` carried the
 * membership in the sibling route table — the UNION of both was this set, and
 * the two anchors disagreed by one id (`meituan/LongCat-2.0:free`, which 1.74.1
 * dropped from the first anchor while the canonical helper kept it).
 * command-code@1.82.4 removes that disagreement by making the verdict a catalog
 * lookup — `resolveKnownCatalogModel({model,catalog})?.zdr ?? false` — so this
 * set is now the live catalog's `zdr:false` membership and nothing more. The
 * official docs (commandcode.ai/docs/resources/
 * zdr) put coverage in prose — "99% of our models have ZDR-capable upstreams … only
 * a small handful of models are affected" — so the CLI's exclusion list is
 * the only per-model evidence there is; a ZDR request naming one of these
 * fails with HTTP 422 `cmd_zdr_no_providers` instead of routing through a
 * provider that retains.
 *
 * Why a NEGATIVE set, and why "not listed" answers TRUE: 99% of the catalog is
 * covered, so the maintained difference is the exception list. This helper is
 * informational; the adapter sends the ZDR header for EVERY request when the
 * switch is on — the provider remains the routing authority and refuses an
 * unsupported model rather than silently dropping the privacy guarantee.
 *
 * `minimax/minimax-m3-free` is the one entry the public catalog's default view
 * (`/provider/v1/models`) does not serve through the picker (it is CLI/pricing-visible
 * and hidden from the picker); it stays listed because the CLI carries it and a Go-plan
 * request can still name it. At the 1.84.0 sync both this row and
 * `stealth/cat-jam:free` were also served by the `?view=client` catalog, which
 * is where the 1.82.4 verdict came from; the catalog stopped serving cat-jam on
 * 2026-10-20, and the artifact followed at 1.86.1 (see the prune note below).
 *
 * command-code@1.82.4 moved the authority for this verdict: `knownModelSupportsZdr`
 * no longer negates a bundled Set, it returns `resolveKnownCatalogModel({model,
 * catalog})?.zdr ?? false`, so an id the catalog does not carry (or carries with
 * `zdr:false`) is NOT covered. That inverts the default this helper was built on
 * ("not listed" answered TRUE); the snapshot keeps its negative-set shape because
 * 99% of the catalog is still covered, but membership is now read from the
 * `?view=client` catalog and confirmed against the canonical helper set.
 *
 * Keep in sync via the dsh-commandcode-upstream skill: the CLI's registry data
 * (its `zdr:{only:[…]}` provider routes and the per-provider `zdr`/`noTraining`
 * flags) is upstream-internal routing, not a per-model contract, so this table
 * is the snapshot of the exclusion set and nothing more. It is a rare change:
 * 20 members held across 1.62.0 → 1.64.0, 1.65.0 and 1.66.0 each added exactly
 * one (the two stealth-preview models), 1.67.0 added one
 * (`deepseek/deepseek-v4.1-flash-fast`), 1.68.0 changed nothing, and 1.74.1
 * removed one (`meituan/LongCat-2.0`). The 1.74.2/1.74.3 pair changed nothing
 * here either (22 members as of 2026-10-06); 1.77.0 dropped the two retired
 * stealth previews, back to 20 members as of 2026-10-07, and 1.79.0 added the
 * free `stealth/glyph-cluster:free` preview — 21 members as of 2026-10-08.
 *
 * 1.77.0 also settled the two retired stealth previews (see `KNOWN_EFFORTS`):
 * 1.74.3 still named both in the ZDR anchors, so they stayed listed here on
 * purpose — an id a stale session named still got a truthful answer. The 1.77.0
 * artifact names neither in its exclusion set and filters both out of
 * `listSelectableModelIds()`, so they are pruned along with the rest of the
 * tables and `supportsZeroDataRetention` now answers TRUE for them, matching
 * what the current CLI says.
 *
 * 1.82.4 then reversed 1.74.1's removal of `meituan/LongCat-2.0:free` and added
 * the `stealth/cat-jam:free` preview, taking this set to 24 members. The 1.84.0
 * sync (2026-10-16) moves it to 25 with no verdict flip: LongCat's exclusion
 * followed its rename to the paid id, and the free `reflection/beam:free`
 * preview joined on catalog evidence alone. The authoritative membership is the
 * UNION of the artifact's exclusion set and the catalog's `zdr:false` list —
 * neither source alone is complete, which is why this set is not simply "what
 * the CLI says".
 *
 * The 2026-10-20 catalog-only sync changed no membership: `stealth/cat-jam:free`
 * left both catalog views (its `zdr:false` verdict is no longer served), but the
 * 1.84.0 artifact's exclusion set still named it and this set is the union, so
 * membership stayed at 25. The MiniMax M3.1 Flash launch pair is ZDR-covered
 * (`zdr:true` on both ids) and joins no set.
 *
 * 2026-10-21 (command-code@1.86.1 sync) prunes the set 25 -> 18, and for the
 * first time the two sources agree exactly: the 1.86.1 artifact's
 * `modelSupportsZdr` set and the live catalog's `zdr:false` rows are the same 18
 * ids (`knownModelSupportsZdr` is gone from the artifact). +3: `claude-fable-5`,
 * `claude-fable-5-1` and `tencent/hy4-preview`. -10: the nine models the catalog
 * flipped to `zdr:true` (Muse Spark 1.1 / 1.2 / 1.3, Muse Wonder 1.0, Grok 4.5 /
 * 4.6, MiMo V2.6 Flash / Pro, GLM-5.2 Fast) plus `stealth/cat-jam:free`, which
 * no source serves any more. Cat-jam is removed by explicit decision (see the
 * decision record, chapter 7 item 13): keeping a retired id in the negative set
 * is defense for stale sessions, not evidence, and the 1.86.1 artifact itself
 * dropped it. A verdict flip here is positive evidence, never "listed before,
 * absent now".
 */
declare const KNOWN_NON_ZDR_MODELS: ReadonlySet<string>;
/**
 * Whether the CLI snapshot lists a ZDR-capable upstream for `modelId`. This is
 * informational, never a reason to omit the header when ZDR is enabled: the
 * provider may add coverage or lack capacity after this snapshot was taken.
 */
declare function supportsZeroDataRetention(modelId: string): boolean;
/**
 * Models the official CLI's model table marks `reasoning:!0` but defines no
 * selectable `reasoning_effort` levels — they think automatically, with
 * Command Code driving the depth. `KNOWN_EFFORTS` (which mirrors the CLI's
 * effort map exactly) stays the sole source for selectable effort levels, and
 * this snapshot is not surfaced in the picker's compact description — it exists
 * for programmatic consumers.
 *
 * Source: the bundled model table (dist/cli.mjs), cross-checked with
 * https://commandcode.ai/docs/reference/cli/models. Keep in sync via the
 * dsh-commandcode-upstream skill; a model that GAINS selectable efforts leaves
 * this set for `KNOWN_EFFORTS` (Tencent Hy4 Preview, Kimi K3, the Muse Spark
 * family and MiniMax M3 all took that path).
 */
declare const KNOWN_THINKING_MODELS: ReadonlySet<string>;
/**
 * The minimum subscription plan a model is included in, per the official plan
 * pages (`/docs/plans/go`, `/docs/plans/goat`, `/docs/plans/pro`,
 * `/docs/plans/max` and `/docs/resources/pricing-limits`). Each plan's model
 * list is a superset of the one below it: Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max.
 * Models absent from every plan list (Claude Opus/Fable, Fugu Ultra) are
 * Provider-tier. Re-verified at command-code@1.88.2 (2026-10-31) against the
 * live `?view=client` catalog: 106 ids, still a strict superset chain. Mistral
 * Large 4 (1.75.0) was the only addition at the 1.77.0 check; the 1.78.0/1.79.0 pair
 * added Claude Haiku 5.5 at Pro and the free Glyph Cluster preview at Go.
 * 1.79.2 lowers Haiku 5.5's minimum plan to GOAT; 1.80.0 adds Muse Wonder at
 * Max; 1.82.0 adds Gemini 4 Argon at Pro and nothing else moves. The 1.82.4
 * train adds Qwen 3.8 Max Prime at GOAT plus Muse Spark Open, Nemotron 3.5
 * Super VL and the free Cat Jam preview at Go, and drops Ling 3.0 Flash Sante,
 * which left the live catalog. Every other
 * tier is unchanged. The 1.86.1 sync (2026-10-21) adds only the Ornith 1.5 122B
 * launch pair at Go; the 1.87.1 check (2026-10-22) adds no model and moves no
 * tier, the 2026-10-24 check adds only Kimi K3.1 Pro at Go, and the 2026-10-27
 * check adds only GPT-6.1 Terra at Pro.
 * The only removals since 1.49.0 are the two retired stealth previews (Pixel
 * Canary at 1.73.1, Space Bunny Alpha at 1.74.3), Ling 3.0 Flash Sante
 * (2026-10-16) and the retired Cat Jam preview (2026-10-20). Per-entry tags
 * below name the releases that added or moved each row.
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
 * (located by the `"individual-go"` key in `dist/cli.mjs`, re-verified unchanged
 * through command-code@1.73.0): subscription `planId` prefix → display name and
 * the plan's monthly credit total. This is the account's own subscription
 * (from `/alpha/billing/subscriptions`) — distinct from {@link KNOWN_PLANS},
 * which maps catalog models to their minimum tier.
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
 * - `free` marks models whose requests cost no credits, shown as a `FREE`
 *   badge; it degrades to a plain discount once the deal lapses.
 *
 * A deal whose promo ENDS is removed here rather than left to lapse on
 * `expiresAt`: the pricing page drops the entry, so a lapsed row would badge a
 * model the catalog now serves at full price (Grok 4.7 reverts to $2.00 in /
 * $6.00 out after its 2026-09-27 window).
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
 * Exactly five models carry the page's `timeOfDay` block (the five rows below).
 * The picker shows the *current* state as a compact label (`Peak`/`Half`)
 * matching the English noun style of the other markers (`Image`, `FREE`), so a
 * developer can tell at a glance whether calling the model right now is cheap
 * or expensive.
 *
 * Extraction caution: the rendered HTML rows are a trap. Each annotation div
 * sits inside its OWN row's container, immediately before the NEXT row starts,
 * so flattening the page to text makes every annotation look like it belongs
 * to the model printed after it — that is how `deepseek/deepseek-v4-flash-fast`
 * was wrongly added here (its row is flat-priced at $0.28/$0.56/$0.07 and has
 * no `timeOfDay` block). Trust the embedded JSON's `timeOfDay` membership and
 * the 2× price relation, never the flat-text neighbor. A rate that is
 * internally consistent can still be the wrong row (the V4 Flash Vision (exp)
 * variant is priced from the page's own `timeOfDay` block, not from 2× its own
 * off-peak figures), which is why the vendored price table
 * (`./model-prices.ts`) is synced from the page and not hand-kept.
 *
 * Keep in sync with the official pricing page when the model set, the peak
 * windows, or the weekday rule change (see the dsh-commandcode-upstream skill).
 */
declare const KNOWN_PEAK_PRICING: ReadonlySet<string>;
/**
 * As {@link isPeakPricingHour}, plus the {@link KNOWN_PEAK_PRICING} membership
 * test; `undefined` for models outside the snapshot.
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
  /**
   * Per-model MONTHLY allowance in USD: how much of the plan's monthly credit
   * pool this one model may draw, already resolved by the Host against the
   * account pool's highest plan (the pricing page publishes an allowance for
   * Go, GOAT and Pro). Undefined when that plan has no published allowance
   * (Go, Provider, Max, Ultra) or when billing could not be read — the browser
   * shows nothing rather than guessing a neighbouring tier's figure.
   *
   * Deliberately a plain number and not the `{ go, goat, pro }` map: the bracket is
   * a Host decision that already depends on facts the browser does not hold, and
   * shipping both figures would invite a second, divergent rule here. Note this
   * is dollars per MONTH, unlike every rate in `CommandCodePriceTable`.
   */
  allowance?: number;
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
/** One whole-request context band; maxContext is inclusive, absent on the last band. */
interface CommandCodeContextTier extends CommandCodeModelRates {
  maxContext?: number;
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
  contextTiers?: CommandCodeContextTier[];
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
 * zh/en copy for the Host-side `/commandcode` usage command, as plain
 * constants: the command runs on the Host and has no access to the client's
 * `ctx.locale`, so the active locale is resolved by `pickCommandLocale()` and
 * the dictionaries are read by direct lookup. Distinct from
 * `./client/locales.ts` (the settings-page `settings.commandcode` namespace).
 *
 * zh is the source of truth for the key set; `en` must carry exactly the same
 * keys, which the `Record` type makes a compile error.
 */
/** Active locale id for the `/commandcode` command. */
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
   * Resolve the active locale for one command run; the plugin entry wires it
   * from `Config.lang` and the shell's `LC_ALL`/`LANG`. Absent (notably in
   * tests), the command renders with the default locale `'zh'`.
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
//#region src/login.d.ts
/** 登录总期限包含浏览器回调、密钥验证与存储，不能在收到回调后撤掉保护。 */
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
  storeKey(credentials: CommandCodeLoginCredentials, targetRef?: string): Promise<void>;
  /** Reject an account target that is not a saved slot before opening Studio. */
  validateTargetRef?(targetRef: string | undefined): void;
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
declare function validateCommandApiKey(fetchImpl: typeof fetch, apiBase: string, apiKey: string, signal?: AbortSignal): Promise<ApiKeyValidation>;
/**
 * One browser-login attempt machine. Single-flight by design: `begin()` while
 * waiting returns the live attempt's status instead of starting a second one;
 * a start that is still binding its port is REJOINED through
 * {@link CommandCodeLoginFlow.begin}'s in-flight promise, because the status
 * face cannot say `waiting` until that bind settles; a terminal state makes the
 * next `begin()` start fresh.
 */
declare class CommandCodeLoginFlow {
  private readonly deps;
  private readonly listeners;
  private statusValue;
  private server;
  private timer;
  private attemptAbort;
  /** Settle hooks of the live attempt's callback promise. */
  private settle;
  /**
   * Attempt generation. A delivered callback keeps validating the key
   * asynchronously (`complete()`), and that window is open to a cancel or a
   * fresh `begin()`; the generation lets a late completion recognize that it
   * no longer owns the status face and stop instead of storing a credential
   * the user cancelled.
   */
  private attemptSeq;
  /**
   * The start currently binding a port, if any. Every `begin()` arriving before
   * it settles joins it: two independent starts would each bind a loopback
   * server, and only the LAST one is reachable by `teardown()` — the orphan
   * keeps answering `/callback` for the process's lifetime, and ten of them
   * exhaust the port window so browser login dies until the Host restarts.
   */
  private starting;
  /** A live attempt's destination; different rows may not rejoin it. */
  private targetRef;
  /** A `cancel()` that arrived while a start was still binding (see {@link CommandCodeLoginFlow.cancel}). */
  private cancelPending;
  /** 取消只能阻止尚未发出的写入；补偿者须等这些实际存储任务结束。 */
  private readonly pendingStores;
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
  begin(targetRef?: string): Promise<CommandCodeLoginStatus>;
  /**
   * The binding half of {@link CommandCodeLoginFlow.begin}: one attempt, one
   * server, one published `waiting` status. Callers reach it only through
   * `begin()`'s single-flight fence.
   */
  private startAttempt;
  /**
   * Cancel a waiting attempt; terminal states are untouched. A start that is
   * still binding a port is flagged instead of ignored — it cannot be torn
   * down from here (its server does not exist yet), so `startAttempt` observes
   * the flag once the bind settles and retires it.
   */
  cancel(): void;
  /** 结束验证/监听并等待已开始的写入，供账号开通过程安全补偿。 */
  cancelAndDrain(): Promise<void>;
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
   * attempt must not START a key write or publish a status. A write already
   * handed to storage is tracked separately: cancelAndDrain() lets the owning
   * enrollment wait for it before compensation, without pretending it can be
   * aborted halfway through.
   */
  private complete;
  /** Whether one attempt still owns the status face (not cancelled, replaced, or disposed). */
  private ownsAttempt;
  /** Map a tagged settle rejection onto the status face. */
  private failFrom;
  private clearTimer;
  /** 消费一次回调后关闭监听；保留总期限以约束后续验证。 */
  private closeCallback;
  /** 结束整个尝试，同时中止验证请求，迟到结果由所有权检查拦截。 */
  private teardown;
}
//#endregion
//#region src/enrollment.d.ts
interface Account {
  label?: string;
  apiKeyEnv?: string;
  apiKey?: string;
}
interface EnrollmentConfig {
  apiKeyEnv?: string;
  accounts?: Account[];
  accountEnrollmentTasks?: EnrollmentRecord[];
  credentialCleanupRefs?: string[];
  modelAccountRules?: {
    models: string[];
    account: string;
  }[];
  activeAccount?: string;
}
interface EnrollmentSettings {
  writable: boolean;
  read(): {
    value: EnrollmentConfig;
    revision: number;
    base?: EnrollmentConfig;
  };
  mutate(ops: {
    op: 'set';
    path: string[];
    value: unknown;
  }[], revision: number): Promise<void>;
}
interface EnrollmentLogin {
  begin(ref?: string): Promise<CommandCodeLoginStatus>;
  status(): CommandCodeLoginStatus;
  onChange(listener: () => void): () => void;
  cancelAndDrain(): Promise<void>;
  dispose(): void;
}
interface EnrollmentDeps {
  settings(): EnrollmentSettings | undefined;
  describe(ref: string): Promise<{
    configured: boolean;
    writable: boolean;
  }>;
  set(ref: string, key: string): Promise<void>;
  unset(ref: string): Promise<void>;
  login(store: (credentials: CommandCodeLoginCredentials) => Promise<void>): EnrollmentLogin;
}
declare class AccountEnrollmentManager {
  private readonly deps;
  private readonly tasks;
  private writes;
  private closed;
  private readonly pages;
  constructor(deps: EnrollmentDeps);
  /** 每页独立的持续调用才代表页面生命期；宿主的 operator Peer 由所有浏览器共享。 */
  watch(owner: string): () => void;
  hasPage(owner: string): boolean;
  /** begin 不等待整个过程；客户端预先生成的 id 让早到的取消也能生效。 */
  begin(owner: string, input: EnrollmentInput): EnrollmentState;
  status(owner: string, id: string): EnrollmentState;
  pending(owner: string): EnrollmentState[];
  /** 离开已登录的待命名过程等同接受已有名称，其余阶段等待写入结束再补偿。 */
  cancel(owner: string, id: string): Promise<EnrollmentState>;
  disconnect(owner: string): void;
  dispose(): void;
  name(owner: string, id: string, name?: string): Promise<EnrollmentState>;
  retry(owner: string, id: string, name?: string): Promise<EnrollmentState>;
  private run;
  private store;
  private cleanup;
  private settings;
  private records;
  private change;
  private owned;
  private publish;
  /** 只淘汰已完成且没有恢复日志的旧状态，活跃过程和未收尾事实始终保留。 */
  private prune;
  private recovered;
}
//#endregion
//#region src/cost-facts.d.ts
interface CostTokens {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
//#endregion
//#region src/analytics-wire.d.ts
type AnalyticsQuery = {
  mode: 'recent';
  limit: number;
} | {
  mode: 'range';
  from: number;
  to: number;
};
interface AnalyticsMetrics {
  sessions: number;
  requests: number;
  completed: number;
  failed: number;
  cancelled: number;
  unknown: number;
  retries: number;
  usageSamples: number;
  pricedRequests: number;
  cost: number;
  tokens: CostTokens;
  latencySamples: number;
  latencyMs: number;
  ttftSamples: number;
  ttftMs: number;
  decodeSamples: number;
  decodeMs: number;
  decodeTokens: number;
}
interface AnalyticsModel extends AnalyticsMetrics {
  id: string;
}
interface AnalyticsScenario {
  id: string;
  name: string;
  contextWindow: number | null;
  images: boolean;
  efforts: string[];
  cost: number;
  pricedRequests: number;
  excludedRequests: number;
  unknownRequests: number;
}
interface AnalyticsReport {
  generatedAt: number;
  pricingKey: number;
  query: AnalyticsQuery;
  status: 'ready' | 'unavailable';
  scannedSessions: number;
  matchedSessions: number;
  unreadableSessions: number;
  skippedSessions: number;
  truncated: boolean;
  catalogUnavailable: boolean;
  totals: AnalyticsMetrics;
  models: AnalyticsModel[];
  scenarios: AnalyticsScenario[];
  monthlyEstimate: number | null;
}
//#endregion
//#region src/service-probe-wire.d.ts
/** How the probe ended; the browser maps each value to localized copy. */
type ProbeOutcome = 'ok' | 'http-error' | 'timeout' | 'unreachable';
/** The probe facts the Host returns; the browser owns every string. */
interface CommandCodeProbeResult {
  outcome: ProbeOutcome;
  /** HTTP status when a response arrived; 0 when it did not. */
  status: number;
  /** Round-trip time in milliseconds; 0 when no response arrived. */
  latencyMs: number;
  /** When the Host finished the probe (epoch ms, Host clock). */
  checkedAt: number;
}
//#endregion
//#region src/usage-remote.d.ts
/**
 * The browser-login face the usage service exposes (`commandcode/login*`).
 * Backed by the Host-half {@link !CommandCodeLoginFlow} when the plugin entry
 * wired one; absent, `status`/`cancel` degrade to the idle status and `begin`
 * rejects with a plain message, so the page's manual paste path stays the
 * fallback instead of hanging.
 */
interface LoginFlowFacade {
  /** Start (or rejoin) an attempt; rejects when it cannot start at all. */
  begin(targetRef?: string): Promise<CommandCodeLoginStatus>;
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
   * Model-catalog source for the settings page's model editors. Absent, the
   * `models` endpoint answers an empty list — the page's editors degrade to
   * the empty state.
   */
  listModels?: () => Promise<CommandCodeCatalog>;
  /**
   * Price-table source for the composer's session-cost figure. Defaults to the
   * vendored snapshot, so the endpoint can never silently serve an empty table
   * — an unpriced cost is the failure this feature is meant to remove. Override
   * only to stub it in a test.
   */
  prices?: () => CommandCodePriceTable;
  /** The browser-login flow (wired by the plugin entry); see {@link LoginFlowFacade}. */
  login?: LoginFlowFacade;
  enrollment?: AccountEnrollmentManager;
  analytics?: (query: AnalyticsQuery, signal?: AbortSignal) => Promise<AnalyticsReport>;
  /**
   * Host-side connectivity probe for the settings page's service-status row
   * (wired by the plugin entry against the live API base). Absent, the
   * `commandcode/probe` endpoint rejects and the row shows the local
   * connectivity as unknown instead of inventing a result.
   */
  probe?: () => Promise<CommandCodeProbeResult>;
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
   * Account, usage, and credit state for the settings page's account card.
   * Degrades per endpoint like the `/commandcode` command (failures land in
   * `report.failures`); throws `MISSING_CREDENTIAL` when no key resolves, which
   * the Gateway folds into the failure branch the page renders as a hint.
   */
  report(): Promise<CommandCodeAccountsReport>;
  /**
   * The full model catalog for the settings page's model editors. The browser
   * never calls the Command Code API directly — the Host serves the catalog
   * (already fetched/cached by the adapter) so models can be picked from the
   * live list instead of typed by hand.
   */
  models(): Promise<CommandCodeCatalog>;
  /**
   * The model price table the composer prices an in-progress session with.
   * Static vendored data, served Host-side so the browser bundle never carries
   * a copy that could drift from the snapshot, and so a price update reaches an
   * open page without a rebuild.
   */
  prices(): Promise<CommandCodePriceTable>;
  /**
   * One live connectivity probe of the configured API base, run on this Host.
   * The status page's own data lags by design (Upptime publishes on change or
   * once a day), so this is the only real-time half of the status row. The
   * plugin entry wires the probe; a programmatic setup without it gets an
   * explicit failure, which the row renders as unknown.
   */
  probe(): Promise<CommandCodeProbeResult>;
  analytics(query: AnalyticsQuery): Promise<AnalyticsReport>;
  /**
   * Start (or rejoin) a browser-login attempt and return its fresh status —
   * `waiting` carrying the Studio URL. Rejects when the flow cannot start
   * (no free loopback port, disposed plugin).
   */
  loginBegin(targetRef?: string): Promise<CommandCodeLoginStatus>;
  /** Poll a login attempt's status. */
  loginStatus(): Promise<CommandCodeLoginStatus>;
  /** Cancel a waiting attempt; returns the post-cancel status. */
  loginCancel(): Promise<CommandCodeLoginStatus>;
  enrollmentBegin(input: EnrollmentInput): Promise<EnrollmentState>;
  enrollmentStatus(input: EnrollmentAction): Promise<EnrollmentState>;
  enrollmentCancel(input: EnrollmentAction): Promise<EnrollmentState>;
  enrollmentName(input: EnrollmentAction): Promise<EnrollmentState>;
  enrollmentRetry(input: EnrollmentAction): Promise<EnrollmentState>;
  enrollmentPending(input: EnrollmentPage): Promise<EnrollmentState[]>;
  enrollmentWatch(input: EnrollmentPage): AsyncIterable<boolean>;
  private enrollmentOwner;
  private enrollmentPeer;
  private requireEnrollment;
  private requireLogin;
}
/**
 * Provide the usage service and register its Remote descriptor. The registry
 * contribution is tied to this fiber's lifetime: the registry's own
 * `register()` effect would otherwise outlive the plugin.
 */
declare function applyUsageRemote<C extends CommandCodeConnectionOptions>(ctx: Context, deps: CommandCodeUsageDeps<C>): void;
//#endregion
//#region src/web-search.d.ts
/** Stable id this provider registers under in `ctx.web`. */
declare const COMMANDCODE_SEARCH_PROVIDER_ID = "commandcode";
/**
 * The factory-declared search provider id dsh ships by default (from
 * `dsh-base`'s cordis patch `web.config.searchProvider`). A documented
 * reference only: disabling this plugin's `webSearch` toggle restores the
 * PREVIOUSLY selected backend, never this default (issue #26).
 */
declare const DEFAULT_WEB_SEARCH_PROVIDER_ID = "deepseek-official";
/**
 * Profile entry id whose volatile `searchProvider` selects the search backend.
 *
 * The hosting profile declares it in `dsh-base`'s cordis patch as
 * `- id: web` / `name: '@deepseek-ai/dsh-web'`, and the shipped web-search
 * settings page addresses the very same namespace — that page and this plugin
 * are therefore two writers of ONE field (see
 * {@link createCommandCodeSearchSelection} for how they avoid fighting).
 */
declare const WEB_SELECTION_NAMESPACE = "web";
/**
 * Structural view of the host settings service.
 *
 * Spelled structurally rather than imported: only these three members are used,
 * and a narrower contract keeps the tests' double honest. Every member is
 * called inside a `try`, because a host mounted without `configEditor` /
 * `profileContext` throws from `describe()` rather than answering empty.
 */
interface WebSelectionSettings {
  /** Every configurable entry's form view; the `web` row is absent when it has no volatile field. */
  describe(): unknown;
  /** Merge fields into that entry's live config (the official volatile write). */
  update(ns: string, patch: object): Promise<void>;
  /** Reset the entry's live fields, then set the supplied ones. */
  replace(ns: string, section: object): Promise<void>;
}
/** Failure and visibility sink; implementations must never throw. */
interface WebSelectionLogger {
  warn(message: string): void;
  info(message: string): void;
}
/**
 * Tracked web-search selection state.
 *
 * `owner` is true while this plugin is the one asserting the selection: it
 * wrote the value, or found it already equal to ours AND attributed it to a
 * user-layer pin. Disabling only ever gives back what `owner` covers.
 *
 * `preexisting` marks the one case where the value is NOT ours to give back:
 * the field already read `commandcode` while the USER LAYER held nothing, so
 * the value came from the deployment's composed config or
 * `$DSH_WEB_SEARCH_PROVIDER`. Restoring there would write over a pin this
 * plugin never took.
 *
 * `foreign` is a non-`commandcode` pin found in the user layer — the shipped
 * web-search settings page writes `deepseek-search-api`, and any sibling plugin
 * may pin its own id. A foreign pin is never displaced; `foreign` keeps the
 * value so the state (and the log line) can name who owns the backend.
 *
 * `displaced` is the config value at takeover time. It is what the DEGRADED
 * (memory-only) restore writes back; the persisted path restores the composed
 * base instead, because a copy of it in the user layer would outlive a later
 * deployment change.
 */
interface CommandCodeSearchSelection {
  owner: boolean;
  preexisting: boolean;
  foreign: string | undefined;
  displaced: string | undefined;
}
/** Fresh selection state: the plugin starts out not owning the selection. */
declare function commandCodeSearchSelection(): CommandCodeSearchSelection;
/** Dependencies {@link createCommandCodeSearchSelection} resolves per call. */
interface WebSearchSelectionDeps {
  /** The running `web` service whose selection field backs the degraded write. */
  web: WebRuntime;
  /** Host settings service, resolved per use because it may activate after `web`. */
  settings: () => WebSelectionSettings | undefined;
  /** Failure and visibility sink. */
  logger: WebSelectionLogger;
}
/** The handle `src/index.ts` drives; every member is synchronous and non-throwing. */
interface WebSearchSelectionHandle {
  /** Live state, for callers that surface who currently owns the backend. */
  readonly state: CommandCodeSearchSelection;
  /** Align the selection with one end of the `webSearch` toggle. Never throws. */
  apply(enable: boolean): void;
  /** Resolve once every queued write has settled. */
  settled(): Promise<void>;
  /** Fiber release: drop queued writes and restore in memory ONLY — never on disk. */
  release(): void;
}
/**
 * The selection seam over `ctx.web`.
 *
 * ## Why settings rather than the runtime instance
 *
 * 0.2.1-rc.2's `WebRuntime` reads `this.config.searchProvider.get()` on EVERY
 * search and fetch, and the loader commits a settings write into that same
 * reference in place (`Entry._commitVolatile`) without remounting the entry.
 * Writing the reference directly therefore works, but leaves the value out of
 * the profile: the next commit for that entry — including one caused by an
 * unrelated field such as `fetchProvider` — re-resolves the raw config and
 * overwrites it. `ctx.settings.update()` / `replace()` is the documented path
 * and the one the shipped web-search settings page uses, so this plugin takes
 * it first and falls back to the reference only when settings is unavailable or
 * refuses (see `volatileWrite`).
 *
 * ## Two writers, one field
 *
 * The shipped web-search settings page writes `web.searchProvider` too
 * (`deepseek-search-api` / `deepseek-official`). This seam never displaces a
 * pin it did not write: a non-`commandcode` value in the USER LAYER stops the
 * takeover, the value is recorded on {@link CommandCodeSearchSelection.foreign}
 * and named in one `info` line, and the provider stays registered but
 * unselected. A value the user layer does not carry is the deployment's own
 * default, and taking it over is the toggle's whole purpose. A user-layer
 * `commandcode` is treated as ours: nothing else writes that id, so it can only
 * be a previous run of this plugin or a deliberate manual pin, and turning the
 * toggle off restores the composed default in both cases.
 *
 * @param deps - the running `web` service, a settings resolver, and a log sink.
 * @returns a synchronous handle; failures are logged, never thrown.
 */
declare function createCommandCodeSearchSelection(deps: WebSearchSelectionDeps): WebSearchSelectionHandle;
/** Per-request facts the provider needs, all injected so the class stays cordis-free and testable. */
interface CommandCodeSearchProviderDeps {
  /** 使用搜索已捕获的网关解析账号，探测不能在等待后转到另一个网关。 */
  resolveKey(apiBase?: string): Promise<string | undefined>;
  /** The API base host (defaults to `https://api.commandcode.ai`). */
  apiBase(): string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}
/**
 * A `ctx.web` search provider backed by the Command Code Provider API, reusing
 * the plugin's credential chain and `apiBase` so the model-facing `web_search`
 * tool needs no separate configuration. Selection between multiple search
 * providers is the web seam's job (pin `searchProvider: commandcode` if
 * ambiguous).
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
  readonly value: string;
  /** Display label (English; also the fallback). */
  readonly label: string;
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
  readonly descriptions?: TuiLocalizedText;
  /** Optional one-line help rendered under the field. */
  readonly hint?: string;
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
  readonly descriptions?: TuiLocalizedText;
}
/** One plugin's section inside the dsh-TUI settings screen. */
interface TuiSettingsSection {
  /** Settings namespace this section edits. */
  readonly ns: string;
  /** Section title (English; also the fallback). */
  readonly title: string;
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
 * The two option-bearing fields (`activeAccount`, `lang`) are `text` +
 * `options` rather than `select`, because a `select` cannot express "unset" —
 * cycling only ever lands on a declared option, so it would strand the user on
 * a pinned value with no way back to automatic. The `auto` sentinel plus a
 * `parse` that clears the path keeps unset reachable. `filterModelsByPlan`
 * formats its EFFECTIVE default (unset means true at the adapter) so a fresh
 * install reads true instead of the screen's "(empty)".
 */
declare function buildCommandCodeTuiSection(deps: CommandCodeTuiSettingsDeps): TuiSettingsSection;
/**
 * Register the Command Code section on a dsh-TUI host.
 *
 * @returns a refresh function that re-registers the section when a fact it
 *   renders changed — the plugin entry calls it from its
 *   `loader/volatile-update` listener — or `undefined` when the seam is
 *   unusable. The returned function is inert after the fiber is torn down.
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
  /** Milliseconds to wait for the generate response's first byte; defaults to 300s. */
  requestTimeoutMs?: number;
  /** Milliseconds a stream may stall before being treated as a dead connection; defaults to 300s. */
  streamIdleTimeoutMs?: number;
  /**
   * Opt-in cache mitigation for the CLI route: after this model has answered,
   * durably offload its earlier images before later turns. Old pixels then
   * require a fresh read/attachment if the model needs to inspect them again.
   * Defaults to false to preserve full image history.
   */
  offloadSeenImagesForCache?: boolean;
  /**
   * Transport failures one request absorbs before the failure is surfaced;
   * defaults to 5. The route's policy allows long waits for confirmed usage
   * windows, while ordinary transient errors have a separate three-retry
   * budget. A transport failure is not
   * one of those, and after ~15.5 s of grace the wait is pure stall, so it is
   * capped here (issue #39). 0 surfaces every transport failure immediately.
   */
  transportMaxRetries?: number;
  /**
   * Whether the model picker hides models above the account's subscription
   * tier; defaults to true. The filter fails open (unknown plan, billing
   * endpoint failure, or a positive on-demand credit balance all keep the
   * full catalog visible). Set false to always list every model.
   */
  filterModelsByPlan?: boolean;
  /**
   * Visible-model allowlist: catalog model ids shown in pickers. Empty or
   * unset means "show everything"; applied after the subscription-tier filter.
   */
  visibleModels?: string[];
  /**
   * Per-model visibility overrides from the terminal settings page's checkbox
   * list, keyed by catalog id (`true` = listed, `false` = hidden). An id here
   * decides that model on its own; an id absent here follows `visibleModels`.
   * dsh-TUI keys a staged edit by the field's path, so the checkboxes need one
   * path per model — a map.
   */
  modelVisibility?: Record<string, boolean>;
  /**
   * 自定义上下文长度（全局值，issue #86）：宣告给宿主的上下文窗口不再取
   * 模型目录的 `context_length`，而用这个值——上下文计量、自动压缩时机与
   * 选择器上的上下文标注都跟随它。对没有 {@link contextWindowOverrides}
   * 条目的每个目录模型生效；留空（默认）跟随目录。只对目录中存在的模型
   * 生效，未知模型保持既有的「无上下文宣告」。范围 1 – 10 000 000 个整数 token。
   */
  contextWindow?: number;
  /**
   * 按模型的自定义上下文长度，键为目录模型 id；优先于全局
   * {@link contextWindow}。配置校验拒绝非整数及越界值；绕过校验的程序化
   * 调用还会丢弃无效条目，按全局值、目录值的顺序回落。
   */
  contextWindowOverrides?: Record<string, number>;
  /**
   * 单轮输出预算上限（issue #74）。不填（默认）＝沿用既有推导：模型公布或
   * 运行时学到的输出上限、以及网关总上限（131 072）三者取最小。填正整数＝
   * 再与推导值取最小，永远不会突破三者；越界值由配置校验拒绝。
   * 填 `0`＝**不发送** `max_tokens` 字段，把单轮输出规模交回平台自行限制——
   * 这是报告者要的「不再被硬切」，但仅 CLI（`/alpha/generate`）与 OpenAI
   * （`/provider/v1/chat/completions`）两条传输支持：Anthropic Messages 端点
   * 必填该字段，缺失会被上游拒绝，因此 Claude 链路仍按推导值发送。
   * 宿主显式传入的每次调用预算（如会话标题的 64）优先于此设置。
   */
  maxOutputTokens?: number;
  /**
   * Extra accounts for multi-account rotation. The top-level
   * `apiKey`/`apiKeyEnv` (plus the CLI auth file) always form the first
   * (`default`) account; each entry here adds one more, and an entry with
   * neither `apiKey` nor `apiKeyEnv` is ignored. A pre-stream 429/401 marks
   * the key and the next account's key is retried transparently.
   */
  accounts?: CommandCodeAccountConfig[];
  /** 账号开通恢复日志，只保留引用与阶段。 */
  accountEnrollmentTasks?: EnrollmentRecord[];
  /**
   * Manually selected active account: a slot id — `default`, or an extra
   * account's credential reference (e.g. `COMMANDCODE_API_KEY_2`). It serves
   * whenever usable; an unknown id or an exhausted one falls back to rotation
   * order. Unset means "first usable account".
   */
  activeAccount?: string;
  /**
   * Model → account routing rules, each listing catalog model ids for an
   * account slot id. A matching rule's account serves before {@link
   * activeAccount} and the passive rotation order; an unusable routed account
   * falls back, so the router is a hint, never a hard gate. First match wins.
   */
  modelAccountRules?: CommandCodeModelAccountRule[];
  /**
   * Whether to use Command Code as the backend for dsh's model-facing
   * `web_search` tool. Enabled registers a `commandcode` search provider on
   * `ctx.web` AND selects it over the shipped `deepseek-official` (or a sibling
   * plugin's pin), reusing the SAME key and apiBase as chat. Selection is the
   * `web` profile entry's volatile `searchProvider`, written through the host
   * settings service and read by `WebRuntime.search()` on the next call, so a
   * toggle change lands without a restart or a remount. Disabling gives the
   * field back to the deployment's composed value, so a sibling search plugin
   * (e.g. modsearch) keeps working (issue #26) — EXCEPT when the user layer
   * already carries someone else's explicit pin (the shipped web-search
   * settings page writes `deepseek-search-api`): that choice is never
   * displaced, and the provider stays registered but unselected. Defaults true.
   */
  webSearch?: boolean;
  /**
   * Whether the Web sidebar shows the plans & quota card
   * (`sidebar.footer.action`). Defaults to false, so an unset document mounts
   * no sidebar quota surface and no background usage poll for it; the
   * dashboard cell behind it stays registered. Read by the browser client; the
   * adapter ignores it.
   */
  showSidebarQuota?: boolean;
  /**
   * Whether requests enforce zero data retention: the provider then routes
   * them only through upstreams that keep no prompts/completions and never
   * train on them (its own opt-in, `CMD_ZDR=1` in the CLI / `x-cmd-zdr: 1` on
   * the Provider API). Defaults to FALSE: `zdr` changes WHERE a request is
   * served. Every chat request carries the header when enabled, and a model
   * with no ZDR-capable upstream fails with 422 `cmd_zdr_no_providers` rather
   * than losing the guarantee. ZDR capacity is priced pass-through and usually
   * costs more; the price readout keeps quoting the ordinary catalog rates
   * (the real per-request price shows in Command Code's Studio).
   */
  zdr?: boolean;
  /**
   * Language override for the `/commandcode` Host-side command's user-facing
   * copy. Host commands cannot read the client's `ctx.locale`, so this is the
   * explicit knob: `'zh'` or `'en'`, defaulting to `'zh'`. The web settings
   * page is unaffected — it follows the browser's language preference on its
   * own. The declared type is `string` (the schemastery `pattern` cannot
   * narrow literal types); `pickCommandLocale` treats an unknown value as
   * "unset" and then reads `LC_ALL`/`LANG`, which is only reachable when
   * `lang` is absent from a programmatically built config.
   */
  lang?: string;
}
/**
 * The Config schema: every field volatile except the composition-only `apiKey`
 * secret. 0.1.7's settings forms are projected from the schema's
 * `meta.volatile` nodes, so an unmarked field would be invisible to AND
 * unwritable from the settings page. The loader also hands `apply()` a live
 * reference per marked field, so writes commit in place without remounting
 * this fiber — the `loader/volatile-update` listener at the bottom of `apply`
 * re-derives the two facts that are not re-read per request.
 */
declare const Config: z<Config>;
/** One resolution's complete request facts: connection plus credential reference. */
interface ResolvedCommandCodeOptions extends CommandCodeConnectionOptions {
  apiKeyEnv: CredentialRef;
  /** 本次调用的账号定义，与连接从同一次易变配置读取。 */
  accountSelection?: CommandCodeAccountSelection;
}
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default is re-judged here — for the composition entry at load and for
 * every settings-backed read.
 */
declare function resolveAdapterOptions(config: Config): ResolvedCommandCodeOptions;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ACTIVE_ACCOUNT_AUTO, type ApiKeyValidation, BILLING_ACCESS_TTL_MS, COMMANDCODE_SEARCH_PROVIDER_ID, COMMAND_CODE_CLI_VERSION, type CommandCodeAccountConfig, CommandCodeAccountPool, type CommandCodeAccountSlot, type CommandCodeAccountState, type CommandCodeAccountUsage, type CommandCodeAccountsReport, CommandCodeAdapter, type CommandCodeAdapterDeps, type CommandCodeBillingAccess, type CommandCodeCommandDeps, type CommandCodeConnectionOptions, type CommandCodeLoginCredentials, type CommandCodeLoginFailureReason, CommandCodeLoginFlow, type CommandCodeLoginFlowDeps, type CommandCodeLoginStatus, type CommandCodeModelAccountRule, CommandCodeSearchProvider, type CommandCodeSearchProviderDeps, type CommandCodeSearchSelection, type CommandCodeTuiSettingsDeps, type CommandCodeUsageDeps, type CommandCodeUsageReport, CommandCodeUsageService, Config, DEFAULT_API_BASE, DEFAULT_GENERATE_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODELS_CACHE_PATH, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PROVIDER_ID, KNOWN_DEALS, KNOWN_EFFORTS, KNOWN_IMAGE_MODELS, KNOWN_NON_ZDR_MODELS, KNOWN_PEAK_PRICING, KNOWN_PLANS, KNOWN_SUBSCRIPTION_PLANS, KNOWN_THINKING_MODELS, LANG_AUTO, LOGIN_ALLOWED_ORIGINS, LOGIN_BEGIN_ENDPOINT, LOGIN_BODY_LIMIT_BYTES, LOGIN_CANCEL_ENDPOINT, LOGIN_MAX_PORT_ATTEMPTS, LOGIN_START_PORT, LOGIN_STATUS_ENDPOINT, LOGIN_TIMEOUT_MS, type LoginFlowFacade, PLAN_LABELS, PLAN_ORDER, PROVIDER, type ResolveAttachments, ResolvedCommandCodeOptions, type TuiSettingsField, type TuiSettingsFieldOption, type TuiSettingsFieldWrite, type TuiSettingsGroup, type TuiSettingsSection, type TuiSettingsSectionsService, USAGE_REPORT_ENDPOINT, WEB_SELECTION_NAMESPACE, type WebSearchSelectionHandle, type WebSelectionLogger, type WebSelectionSettings, accountUsable, apply, applyCommandCodeTuiSettings, applyCommands, applyUsageRemote, buildCommandAuthUrl, buildCommandCodeTuiSection, capabilityDescription, commandCodeSearchSelection, commandDefinition, compareByPlan, createCommandCodeSearchSelection, dealLabel, formatContext, inject, loginStatusSchema, matchModelRule, modelVisibleInPlan, name, parseLoginStatus, peakPricingLabel, peakPricingState, planLabel, projectSlugFromPath, resolveAdapterOptions, resolveAuthFileApiKey, selectAccountForModel, selectActiveAccount, studioBaseForApiBase, subscriptionPlanInfo, supportsZeroDataRetention, usageReportSchema, validateCommandApiKey };
//# sourceMappingURL=index.d.ts.map