# Adapter and wire contracts

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **错误正文读取有界**：收到非成功 HTTP 状态后，正文最多读取 64 KiB，期限为请求超时与 30 秒中的较小值；超时或截断保留原状态和已收片段，用于分类与重试。调用者取消传播原取消原因。成功生成流仍受独立的流空闲期限控制。
- **流式终止与用量**：OpenAI 的 `finish_reason` 后继续读取独立用量，直到 `[DONE]` 或正文结束；Messages 的 `message_delta` 更新累计字段，在 `message_stop` 结束。缺失用量字段保留先前值，不能当作零覆盖，也不能把累计值相加。历史实测的完整末尾用量仍兼容。此边界已用分包模拟回归，本轮没有重新发送付费请求。
- **超时建议与设置范围一致**：OpenAI 请求超时建议使用页面 3600 秒上限，并且只在高于当前值时提供；重试退避上限不用于限制单次请求期限。
- **冷生成预算**：内存目录未预热时合并一次同网关、版本 3 的磁盘目录读取；不额外联网，缺失或来源不符时保持未知窗口行为。文件读取不覆盖并发联网刷新得到的全局输出上限；切换地址或文件会换缓存状态。

- **Lone UTF-16 surrogate halves are stripped from every outgoing request body.** The strip runs as the
  `JSON.stringify` replacer at the single serialization point in `streamRequest()`, so all three transports
  and every field are covered without enumerating text-bearing fields. `sanitizeSurrogates()` returns any
  string with no surrogate unchanged, and a flagless range pre-test (`ANY_SURROGATE_PATTERN`) gates the
  lookaround pattern (`LONE_SURROGATE_PATTERN`) because V8 cannot fast-scan lookaround: 0.77 ms against
  1.40 ms on a 412 KB body, where a bare `JSON.stringify` is 0.59 ms. **The pre-test must stay non-global** —
  a global regex is stateful, so `test()` would advance `lastIndex` and alternate between true and false on
  repeated calls. **Paired surrogates must survive**: a well-formed astral character is a surrogate pair, so
  a naive range filter would delete every emoji. Context: `JSON.stringify` accepts a lone half as the escape
  `"\ud83d"` rather than failing, so this guards a strict upstream decoder, not a local crash — the official
  provider for pi applies the same strip to every outgoing string on this endpoint. `tests/adapter.test.ts`
  pins the strip on all three transports and the emoji round-trip.
- **Zero data retention (`Config.zdr`, default off)**: `connectGenerate()` sends `x-cmd-zdr: 1` on ALL THREE
  transports for EVERY request when enabled. The provider refuses a model without an available ZDR upstream
  with `422 cmd_zdr_no_providers`; `generateHttpError()` diagnoses it bilingually. NEVER omit the header
  based on `KNOWN_NON_ZDR_MODELS` or retry without it: that would silently lose the privacy guarantee. The
  snapshot in `src/capabilities.ts` is informational and may lag provider coverage or capacity.
  `tests/adapter.test.ts` checks the chat transports, off by default, unsupported models retaining the header,
  and 422 diagnosis.
- **Wire protocol** (reverse-engineered, command-code@1.28.4; re-verified through 1.73.0):
  - `POST {apiBase}/alpha/generate` — CLI transport body `{ config, memory, taste, skills, permissionMode,
    params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? },
    threadId }`. The real CLI's request also carries `mode` (server-validated against a fixed enum —
    `agent | learning | custom-agent | custom-agent-create | title-gen | tool-desc | compact | vision | …` —
    but omission is accepted, no error) and `promptCache` (the normal agent-loop turn never sets it either;
    only isolated side calls — image description, compaction, title generation — send it, always `"off"`).
    Neither is sent by this adapter: a 2026-09-30 live probe on a free model, repeated with a realistic
    `max_tokens` budget, found no response-shape difference with or without either field, so this is a known
    but harmless protocol gap, not a bug. `permissionMode` IS sent (`"standard"`) — the CLI's own internal
    default is the string `"default"`, but its `toWirePermissionMode()` normalizes an absent/default value to
    `"standard"` before it reaches the wire (also enum-validated: `default | standard | auto-accept | plan |
    bypass`), so `"standard"` is the real wire value for an ordinary session. This is sent for request-shape
    parity only — see `docs/issue-64-cache-review.md`'s "root-cause boundary" section, which already tested
    this exact value on this transport and excluded it as a fix for the image cache-boundary regression.
    Used for Go-plan accounts (the only plan without Provider API access) and as the fallback when
    `/provider/v1/chat/completions` returns `upgrade_required`. Historical reasoning IS replayed here as a
    `{ type: 'reasoning', text }` part of the assistant content array, in content order — the official CLI's
    `toWireMessages` converts every `thinking` block that way (command-code@1.54.0), and the provider
    rejects a DeepSeek thinking-mode tool loop whose assistant tool calls arrive without their reasoning
    (`The reasoning_content in the thinking mode must be passed back to the API.`, issue #34). Do not
    "restore" the old drop-reasoning behavior: it was ported from the pi plugin and is no longer upstream's
    shape. `x-taste-learning` is sent as `"false"` (was `"true"`); this matches an independent third-party
    Command-Code integration's (magpie's) observed value and is unverified beyond that — not measured against
    the real service to confirm it changes anything.
  - `POST {apiBase}/provider/v1/chat/completions` — documented OpenAI-format transport with a flat body `{
    model, messages, tools?, max_tokens, temperature, stream, reasoning_effort? }`. Used for every account
    with Provider API access whose model the catalog does not route to `/messages`; historical reasoning is
    replayed as `reasoning_content`.
  - `POST {apiBase}/provider/v1/messages` — **Anthropic Messages transport, the only Provider API route the
    Claude family answers** (see the routing bullet below). Every clause below was measured live on
    2026-09-29 against `claude-sonnet-5-5`; the shapes differ from `dsh-llm-deepseek`'s Messages API in two
    places that make copying that adapter fail:
    - `thinking` accepts ONLY `{ type: 'adaptive' }`, and it is sent ONLY when the model publishes
      selectable effort levels. `enabled` and `disabled` are refused
      (`"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and
      "output_config.effort" to control thinking behavior.`) and `between_tools` fails validation outright;
      the switch and the strength it carries are one decision, so a model with neither (e.g.
      `claude-haiku-4-5-20251001`, which the official CLI marks neither `reasoning_effort` nor
      `reasoning:!0`) gets neither field. Reasoning strength travels in `output_config.effort`, whose
      accepted values are `low | medium | high | xhigh | max` — **no `none`, and `xhigh` is absent from
      DeepSeek's own type**, so `reasoningEffort: 'off'` must send no `output_config` at all. The presence
      test reuses the `KNOWN_EFFORTS` lookup `stream()` already performed (`selectableEffort` in
      `GenerateCallFacts`). Measured 2026-09-29: the switch does NOT suppress thinking — six live requests
      across `adaptive` present/absent × `temperature` present/absent all produced a thinking block, so the
      apparent difference in one probe run was the `max` vs `xhigh` effort, not the switch.
    - `max_tokens` is capped PER MODEL and the endpoint names the ceiling in its rejection
      (`max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for
      claude-sonnet-5-5`). `/provider/v1/models` publishes no `max_output_tokens`, so the ceiling comes from
      `MODEL_OUTPUT_TOKEN_LIMITS` in `./capabilities.ts` and an unlisted Messages-route model falls back to
      `DEFAULT_MESSAGES_MAX_TOKENS` (64 000) rather than the global default — see
      `modelOutputTokenLimit()` in `./adapter.ts`. A catalog that has not warmed yet still applies it.
      That table is generated by `scripts/sync-output-limits.mjs` from models.dev and records only ceilings
      the catalog states outright (a first-party vendor row, or unanimity across every provider carrying the
      id); the 10 models whose providers disagree are left out on purpose and learned at runtime instead
      (issue #71).
    - **`max_output_tokens` is read even though the endpoint does not send it.** The gateway's schema has
      the field and the official pi provider already prefers it, but `/provider/v1/models` currently stops
      after `supported_endpoints`; it is read anyway so the published figure takes over the moment it
      appears, with no change here. It lands in `publishedOutputLimits`, which outranks the models.dev
      snapshot and is outranked only by a live rejection, and it is the ONE value the catalog cache carries
      across (`publishedMaxTokens`) because it cannot be re-derived. `maxTokens` in that same file is
      derived and is **recomputed on read** — trusting it would let a cache written before a snapshot update
      pin the old ceiling for as long as the file survives. Above all of them sits
      `DEFAULT_GENERATE_MAX_TOKENS` (131 072), which is a measured **gateway-wide** cap rather than a
      default: 200 000 answers and 200 704 is refused, identically on a 262 144-window model and a
      1 000 000-token one.
    - Stream events are the standard Anthropic sequence: `message_start` (carries input usage), then per
      block `content_block_start` / `content_block_delta`* / `content_block_stop`, then `message_delta`
      (`stop_reason` plus the final usage) and `message_stop`; a `ping` keepalive interleaves freely and
      carries no content. Deltas are `text_delta`, `thinking_delta`, `signature_delta` and
      `input_json_delta` (the last accumulates into the raw JSON string the harness wants).
      `stop_reason` is `end_turn` / `tool_use` / `max_tokens`; `tool_use` maps to `tool-calls`.
    - `usage` carries `input_tokens` (already excluding cache), `output_tokens`,
      `cache_read_input_tokens`, `cache_creation_input_tokens` and
      `output_tokens_details.thinking_tokens`; `mapMessagesUsage()` maps them as-is rather than reducing,
      matching `dsh-llm-deepseek`.
    - **The body sets three ephemeral cache breakpoints** — the `system` block (sent as a one-block ARRAY
      rather than the bare string the other two transports use), the LAST tool declaration, and the last
      block of the last `user` message. Anthropic caching is opt-in per block, so an unmarked request is
      re-prefilled at the full input rate every turn: a 10-turn `claude-sonnet-5-5` session measured
      2026-09-29 billed $0.5648 with every request at the undiscounted rate, against $0.1869 with the three
      markers (−66.9%) and no other field changed. The last user turn is the ROLLING boundary — DSH resends
      the whole history each turn, so a marker there grows with the conversation, whereas a
      `system`-only marker leaves everything after the first turn uncached. `messagesMessageCodec` renders
      tool results as `role: 'user'`, so a tool loop's trailing turn is markable too; `thinking` and
      `tool_use` blocks are never marked. No `ttl` is sent — the 5-minute entry covers an advancing session
      and `ttl: "1h"` reads and writes at identical prices. Placements mirror the official Command Code
      provider for pi, whose `@earendil-works/pi-ai` `anthropic-messages` transport marks exactly these three
      positions on the same endpoint; both were verified against registry-published sha512 digests
      (pi-ai 0.87.1, command-code 1.68.0), not against a live Command Code response — see
      [docs/issue-64-cache-review.md](../issue-64-cache-review.md). If the gateway ever ignores the field,
      the request is unchanged in price and shape.
    - **A replayed `thinking` block requires its `signature`** (`thinking.signature: Field required`, and
      `each thinking block must contain thinking` when the text is empty and the signature blank), yet
      dropping the block entirely is accepted (verified 200 either way) — the OPPOSITE of issue #34, where
      the DeepSeek route refuses a tool loop whose reasoning was not sent back. The signature therefore
      rides the per-block replay envelope (`ReplayEnvelope.blocks`, one entry per emitted block, indexed by
      the same harness chunk index) and `messagesSignatureAt()` restores it; a reasoning block with no
      recorded signature is DROPPED rather than sent half-formed. This is the only transport that writes
      `replayState.blocks`.
    - **`tool_result.content` accepts image blocks**, so tool-result images are NOT split into a following
      user message here (`carriesToolResultMedia`). The other two transports still must, and still do
      (issue #30).
    - `tool_use.id` needs no truncation: 44- and 86-character ids are both accepted as long as
      `tool_result.tool_use_id` matches, so `wireToolCallIds()`' 64-character clamp is CLI-specific.
    - **`temperature` is never sent.** Adaptive thinking constrains it to 1, and a value below that is
      refused outright: `` `temperature` may only be set to 1 when thinking is enabled or in adaptive mode ``
      (measured 2026-09-29). Omission is the only field state that satisfies both the thinking switch and a
      caller that asked for a temperature, so Claude loses sampling control on this route **because the
      endpoint removed it, not because this adapter dropped it**. This was a live-only failure: the unit
      tests all passed while every real request was refused.
    - Rejections come in three shapes and the parser must take all of them: the Anthropic envelope
      (`{"type":"error","error":{"type":…,"message":…}}`), the same envelope with a whole second JSON
      document inside `message` (unwrapped once by `unwrapProviderMessage()` for the message shown to the
      user, while `ParsedProviderError.rawMessage` keeps the original for pattern matching — the embedded
      `type: "provider_error"` is part of how the overflow classifier tells an over-reserved request from an
      ordinary one), and BARE PROSE (`Invalid input: expected number, received undefined at max_tokens`)
      which `parseProviderError()` now keeps as the message instead of discarding. A plan refusal has no
      `code` member — `MODEL_NOT_IN_PLAN` is a message PREFIX — and the prose classifier in
      `classifyAccountRejection()` already reads it, so the account rotates instead of the turn dying. A
      conversation may not end with an assistant turn (`This model does not support assistant message
      prefill`), which the tool loop never produces.
    - A `max_tokens` refusal must NOT reach the context-overflow branch: the overflow pattern matches a
      bare `max_tokens`, so `OUTPUT_LIMIT_REJECTION` claims the request-side shapes first and returns a
      bilingual `PROVIDER_HTTP_ERROR` quoting the endpoint's own numbers. Otherwise the harness would compact
      a session that is not oversized — at full price, on a long context — and be refused identically. The
      same ordering applies inside `streamErrorToLlmError()`, which is the path when the refusal arrives in
      a 200 body rather than as a status; issue #71 reported it in exactly that shape.
    - **An output-ceiling refusal is retried once, at the ceiling the endpoint names.** `streamRequest()`
      wraps `streamAttempt()` and, on failure before the first chunk reaches the host, reads Y out of
      `max_tokens: X > Y`, records it in `learnedOutputLimits` and re-sends. Both refusal shapes are covered
      (HTTP 400 and the in-stream error frame), because the recovery is the same either way. The learned
      value is process-wide and only ever tightens, so the next turn for that model is built correctly
      without spending the 400 again; a warm catalog row cannot mask it because `streamAttempt()` takes the
      smaller of the two. A refusal that arrives after a delta has been delivered is NOT retried — the
      answer is already partly on screen and a second request would duplicate it — and a second refusal
      within one turn surfaces, so the downshift is once per turn, not a loop.
  - **Every tool's root schema is normalized to `type: 'object'`** by `toolParametersSchema()` before either
    body is built (issue #35). The gateway validates the root of each function schema and rejects the entire
    request otherwise (`Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"',
    got 'type: null'`; on the Messages endpoint the same rule reads
    `tools.0.custom.input_schema.type: Field required`). The harness's own `defineTool` always declares that
    root, so the failing schema
    comes from a tool registered outside it — a third-party plugin's or MCP bridge's hand-written schema (a
    type-less `{ properties, required }`), an empty `{}`, or a generator's root `$ref`. A schema that
    already declares an object root passes through untouched; a type-less object-shaped one gains the type;
    a root `$ref` is inlined from its local `$defs`/`definitions`; an `allOf`/`anyOf`/`oneOf` root is
    flattened (branch properties unioned, `required` kept only where every alternative demands it); anything
    else degrades to a permissive free-form object, since a refused request helps no one. Only the root is
    touched and every path returns a copy (the harness may deep-freeze tool schemas), and the walk is
    depth-bounded so a self-referential JS schema cannot spin. `toolParametersSchema()` is applied at all
    three call sites, so the CLI `input_schema`, the OpenAI `function.parameters` and the Messages
    `input_schema` cannot drift apart.
  - Image parts on `/alpha/generate` use the official CLI's FINAL `toWireMessages()` shape: `{ type:
    'image', image: 'data:<mime>;base64,...', mimeType: '<mime>' }`. The `{ type: 'image', source: { type:
    'base64', media_type, data } }` shape is an internal CLI input block, not what it posts. OpenAI
    `/provider/v1/chat/completions` uses `{ type: 'image_url', image_url: { url: 'data:...' } }`. Both
    transports label the `readImageRequest()` variant with its returned `mediaType`, which can differ from
    the stored attachment's type after transcoding (issue #64).
  - CLI stream: SSE-ish JSONL events `text-delta | reasoning-start/delta/end | tool-call | tool-result |
    cache-write-tokens | finish | error`. command-code@1.65.2 added the standalone `cache-write-tokens`
    reading; the official CLI keeps the last finite non-negative value and uses it only when
    `finish.totalUsage.inputTokenDetails.cacheWriteTokens` is zero/missing. `handleCliEvent()` mirrors that
    fallback, including the standalone-event case, so cache writes are not silently dropped from token/cost
    accounting.
  - OpenAI stream: standard SSE chunks with `delta.reasoning` / `delta.reasoning_content` /
    `delta.reasoning_details` / `delta.content` / `delta.tool_calls`, a `finish_reason`, and optional
    `usage`. **The thinking field is per model FAMILY, not global, and the gateway does not normalize the
    spelling** (measured live against the whole catalog, 2026-09-16): DeepSeek answers with the scalar
    `delta.reasoning` PLUS an OpenRouter-shaped `delta.reasoning_details` array (`[{ type: 'reasoning.text',
    text, format, index }]`, chunked one array per delta with `index: 0`), GLM/Qwen/Kimi answer with the
    DeepSeek-native `delta.reasoning_content`, and the OpenAI family answers with the scalar
    `delta.reasoning` PLUS a `reasoning_details` entry `{ type: 'reasoning.summary', summary, format:
    'openai-responses-v1' }` (measured 2026-09-18 on gpt-5.6-luna, 6/6 interleaved rounds: the scalar and
    the array's `summary` carried the identical text every round, ~367 vs ~371 chars, so the two endpoints
    differ in wording only — Gemini was not re-measured and keeps its earlier "neither" reading). All three
    spellings are read, in that order, so no family's thinking is dropped. `reasoningDetailsText()` reads
    each entry's own text members — `text` first, then `summary` — rather than filtering on `type`: BOTH
    array vocabularies are live (`reasoning.text` for DeepSeek, `reasoning.summary` for the OpenAI family),
    so a `type` filter would drop one family and reading only `text` would drop the other. Per entry `text`
    wins, but an EMPTY `text` must not shadow a populated `summary` (the Responses wire emits `text: ''`
    placeholders), so that fallback tests for non-empty rather than merely present; encrypted-blob entries
    carry neither member and contribute nothing, and no entry carries both members, so a summary is never
    counted twice. The array branch is a forward guard rather than the live path for ANY family — every
    family that sends the array also sends a scalar alongside it — and it now covers both array
    vocabularies, which is what makes the guard real for the OpenAI family instead of nominal;
    `tests/adapter.test.ts` pins the array-only path for both vocabularies, the empty-`text` fallback, that
    a scalar beside an array is never double-counted, that encrypted-blob entries contribute nothing, and
    that the block still closes before the text block opens.
  - Catalog: `GET {apiBase}/provider/v1/models` → `{ object: 'list', data: [{ id, name, context_length,
    supported_endpoints }] }`. `supported_endpoints` is the authoritative route list when present;
    `requiresMessagesEndpoint()` supplies the `claude-*` fallback when it is absent. The in-memory directory
    is invalidated when `apiBase` or `modelsCachePath` changes. Version 3 of the disk cache records `apiBase`
    and is read only for that exact gateway; an unscoped older file or a different gateway's file is ignored
    until a successful refresh rewrites it. A refresh still has a five-minute TTL, and failure waits ten
    seconds before another fetch. Output-ceiling facts derived from the directory are also scoped by
    `apiBase`, so a custom gateway cannot constrain another gateway's same-named model.
  - Provider API endpoints (docs, 2026-09-25): `/provider/v1/chat/completions`, `/provider/v1/responses`
    (OpenAI + open models; added in command-code@1.55.0), `/provider/v1/messages` (Claude family only),
    `/provider/v1/models`. The provider also publishes `/provider/v1/systemone` (System One decisions, model
    `typesafe/jev`; NOT a chat route — the model is absent from `/provider/v1/models`), but this plugin no
    longer calls it: the decision-endpoint client and the command guard that fronted it were removed (see
    CHANGELOG). This adapter's two chat transports stay the first plus `/alpha/generate`; neither is
    deprecated.
  - Web search: `POST {apiBase}/alpha/web-search` — body `{ query, numResults, allowedDomains?,
    blockedDomains? }` → `{ results: [{ title, url, snippet }] }`; same `Authorization: Bearer <key>` +
    `x-command-code-version` as generate.
  - Defaults: `apiBase = https://api.commandcode.ai`, `COMMAND_CODE_CLI_VERSION = '1.68.0'`.
  - **Request image budget (issue #37)**: the gateway caps a whole request body at a measured ~50.17 MB
    (undocumented — their Error Codes page has no 413). All three transports inline every historical image as
    base64 and the harness never reclaims history, so a long session (a vision self-check loop reading back
    dozens of screenshots) used to cross the cap once and then fail EVERY later request on this route with
    HTTP 413, while the same conversation worked on another provider. `stream()` therefore builds every
    body from a PROJECTED history, never the raw one, and the offload set is a DURABLE session fact:
    `withSurfaceOffload()` renders the surface's `offloaded` marks through the engine's
    `projectOffloadedImages` (so an evicted image can never be re-sent as pixels) and an over-budget history
    FAILS with `IMAGE_OFFLOAD_REQUIRED` + the count from `requiredImageOffload`, which the default
    `dsh-compaction-image-offload` plugin records as one `image/offload` event and retries — the omission
    then survives restore and fork, and the token meter stops counting evicted images as context. Those
    three symbols are STATIC imports of `@deepseek-ai/dsh-llm` (they are the reason the peer range is pinned
    so tightly: a named import of an absent export is a link-time failure that takes the whole plugin down,
    issue #43). `REQUEST_IMAGE_BUDGETS` is a two-rung ladder: rung 0 is the standing budget (32 MiB base64 /
    60 images, 16 MiB / 30 removal quanta), rung 1 (8 MiB / 12) is asked for ONLY after the gateway actually
    answered 413, because the cap also covers text and tool bytes and cannot be budgeted exactly from here.
    That code stays outside `providerRetryPolicy()`'s whitelist: the surface mutation has to happen before
    any resend can help. The 413 rung becomes another offload request through the same channel, so those
    extra omissions are recorded too, and a rung with nothing left to offload falls through to the 413
    diagnosis rather than asking for an offload that cannot happen — which is also what keeps the branch
    from ever resending a body. A tool-result image evicted this way surfaces as the tool message's own
    placeholder text, so no carrier user message is emitted for it. `generateHttpError` maps 413 to a
    bilingual `PROVIDER_HTTP_ERROR` (NOT retryable by dsh-llm-retry — a byte-identical resend cannot
    succeed) whose message names the undocumented cap and the only user lever left. Pinned by the "Request
    image budget (issue #37)" tests in `tests/adapter.test.ts` (no-op under budget, the count and byte
    rungs, tool-result images counting, OpenAI parity, and the 413 that never resends an image-free body)
    plus the "durable contract (issue #43)" tests, which drive the offload request through the injectable
    `imageOffload` seam. The count's second carrier, `failure.offloadImages`, is what
    `dsh-compaction-image-offload` reads back, and is pinned by `npm run test:engine` against a real engine.
    Two further pieces of the same budget: the bytes that travel are the attachment service's REQUEST
    VERSION, not the stored original (`readImageRequest()` against the target in `src/image-request.ts` — a
    1568-px long edge, inside the Anthropic ceiling and the OpenAI/Gemini high-detail band, and at most 1
    MiB encoded), while the budget itself still accounts the DECLARED normalized size, which is what makes
    it conservative rather than exact; and the token meter prices every occurrence through
    `imageRequestPricing` (`src/image-tokens.ts`), charging the family's published visual-token rule at that
    same request target, zero vision tokens plus the placeholder text for an occurrence the surface
    offloaded or a route that takes text only, and the most expensive known rule for a family we cannot tell
    apart (under-reporting context is what walks a session into its own window).
- **StreamChunk contract** (dsh-llm): each block starts with `block-start`, deltas by `index`, ends with
  `block-end`; `usage` before `finish`; nothing after `finish`. Tool-call `arguments` are raw JSON strings.
  Historical reasoning blocks are replayed on BOTH Chat-shaped transports for tool-loop continuity — as a
  `{ type: 'reasoning', text }` assistant part on `/alpha/generate` (the official CLI's shape) and as
  `reasoning_content` on `/provider/v1/chat/completions` (see the wire-protocol bullet; issue #34). The
  Messages transport has its own rule: its `thinking` block needs a `signature`, travels in the per-block
  replay envelope, and is omitted when no signature was recorded (see the wire-protocol bullet). Only
  tool calls with a paired tool result are replayed. **Tool-result images** (`read_image` returns text + a
  nested `image` block): the CLI wire cannot hold an image inside a tool result — `tool-result.output` is
  text-only (the official CLI's own `toV2ToolOutput` filters out everything but text) — and Chat Completions
  forbids non-text `role: 'tool'` content, so for those TWO transports `toolResultMedia()` splits each result
  and both converters emit the bytes in a user message immediately after the tool message, led by the
  `Attached image(s) from tool result:` note (the shape `@deepseek-ai/dsh-llm-deepseek` uses).
  **Messages is the exception**: its `tool_result.content` accepts image blocks natively, so
  `carriesToolResultMedia` suppresses the split and the bytes stay where the model produced them
  (issue #30). Deduplicated
  by attachment id per result; an image-only result gets a `(image returned; see the attached image)` tool
  text instead of an empty string; a result without a paired call drops its images with the result. Never
  flatten a tool result with `blockText` alone again — that is issue #30. The `hasImageContent` gate (model
  Vision capability + attachment seam) already recurses into tool results, so these images ride the same
  `readImage` resolver user attachments use.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 with a confirmed usage
  window → `RATE_LIMIT`, a bare throttle → `THROTTLED`;
  **pre-stream 5xx → `SERVER` and 408 → `TIMEOUT`** (`httpErrorCode()`, so a gateway blip — e.g.
  Cloudflare's 520 "Upstream model provider is temporarily unavailable" — reaches the retry whitelist
  instead of failing the turn); other HTTP → `PROVIDER_HTTP_ERROR` (403 body's `error.code`, e.g.
  `MODEL_NOT_IN_PLAN`, is parsed into the message). **A context-window rejection →
  `CONTEXT_WINDOW_EXCEEDED`** (the harness's own code: `isContextWindowExceededError` plus the official
  CLI's `truncated` pattern, matched against the provider's `error.code`/`type`/`message`). It is
  deliberately OUTSIDE the retry whitelist because `dsh-compaction-basic`'s `agent/request-error` hook
  compacts the session and retries the reduced surface for that code — resending the byte-identical
  oversized request is exactly the old bug where a long session retried forever (issue #39).
  `streamErrorToLlmError()` is the ONE in-band classifier for both transports (the CLI's `error` event and
  the Provider API chunk's `error` member, which was silently ignored before); it reads the wording before
  the status, so a `statusCode: 500` carrying "prompt is too long" still takes the overflow path, while only
  client-side pre-stream statuses (`status < 500`) are inspected for the wording, so an HTML 5xx page cannot
  mention its way into a compaction. A terminal marker (`insufficient credits` / `model not in plan` /
  `premium credits exhausted`, underscored or spaced — the separator is normalized, like the pre-stream
  classifier) and an explicit `isRetryable: false` OUTRANK a retryable status, so a 5xx carrying one stays
  non-retryable `PROVIDER_STREAM_ERROR` instead of entering the transient-retry budget. Never route a
  transient status onto a code outside `providerRetryPolicy()`'s whitelist: dsh-llm-retry matches the code
  only, never the status. Unsupported options (`stop`) and image input throw `UNSUPPORTED_OPTION` /
  `UNSUPPORTED_CONTENT` rather than silently dropping.
- **Cache diagnostics (issue #64)**: retain the CLI session identity and explicit system text block, but do
  not claim these establish a cache fix. `DSH_COMMANDCODE_TRACE` fingerprints requests only while enabled;
  OpenAI uses its flat body, CLI uses `params`. Ordered per-message hashes distinguish append-only history
  from a rewritten prefix. `streamId`, absolute opening time, session identity and attempt numbers correlate
  calls; each response records only allowlisted correlation headers. Supplied response IDs survive
  successful DSH assembly in `source.replayState.response`; supplied request IDs survive failures in
  `failure.requestId`. Never copy arbitrary headers or raw request text into diagnostics. Tests cover both
  protocols, fallback, prefix stability and the real DSH assembler. See
  [docs/issue-64-cache-review.md](../issue-64-cache-review.md) for upstream evidence and the remaining
  live-session acceptance check.
- **Stream termination must distinguish an answer, an empty completion, and a cut**
  (`CommandCodeAdapter.stream()`, `src/stream-trace.ts`). A terminal CLI `finish`, an OpenAI
  `finish_reason` or a Messages `message_delta` carrying `stop_reason`
  is necessary but not sufficient for success: reasoning alone, empty text, whitespace, and `tool_calls: []`
  are not an answer. Hold the success `finish` until validation; DSH 0.1.7 converts an adapter throw into an
  error finish, so throwing after publishing success creates two terminal events. A terminal response with
  no text/tools maps to retryable `EMPTY_RESPONSE`; a length/max-token finish maps to non-retryable
  `OUTPUT_TOKEN_LIMIT` unconditionally, and explicit content filtering remains non-retryable. **No
  client-side estimate of the prompt's share of the context window feeds this decision** — an earlier
  version pre-shrank the request's own `max_tokens` from such an estimate (`requestContextBudget()`,
  issue #67) and used whether that shrink had reached an emergency floor to route an empty length finish to
  `CONTEXT_WINDOW_EXCEEDED` instead (issue #73). Removed (issue #74): the estimate over-corrected on
  ordinary long conversations — cutting output short as a session grew, independently of whether the window
  was actually in danger — and a live A/B probe (2026-09-30, `stealth/space-bunny-alpha`, ~19.6% over its
  1,000,000-token window with `max_tokens` sent unshrunk) showed the endpoint already answers a genuine
  overflow with an unambiguous `400 … exceeds the model's context window`, which the `isContextOverflowDetail`
  branch below classifies as `CONTEXT_WINDOW_EXCEEDED` on its own wording — no client-side estimate needed.
  A length finish with no content is therefore always `OUTPUT_TOKEN_LIMIT`; a genuine window overflow is
  classified separately, from the provider's own rejection, by `generateHttpError()`'s
  `isContextOverflowDetail` branch or `streamErrorToLlmError()`'s in-band equivalent. See
  [决策记录](../决策记录.md) for the fuller record, including the one case (the original ambiguous-400
  wording last measured on `stealth/pixel-canary`) the live probe could not re-verify because that model was
  itself unavailable at test time. Preserve
  received usage on failures; report the actual finish reason, request budget, output tokens and reasoning
  tokens (unknown when absent). A length finish proves a limit, not that every token was spent reasoning. Without any
  terminal event, preserve `EMPTY_RESPONSE` when no content arrived and `STREAM_CLOSED` after text/tool
  fragments; never execute a buffered tool call from a cut stream. `STREAM_CLOSED` and `OUTPUT_TOKEN_LIMIT`
  stay outside the retry whitelist. Thus an old silent stop cannot be attributed to a particular branch
  without its wire trace. `DSH_COMMANDCODE_TRACE=<path>` (`=1` selects
  `$TMPDIR/dsh-commandcode-stream.jsonl`; `0`/`false`/`no`/`off` are OFF rather than file names, which is
  what an explicit disable used to look like — it wrote the conversation to `./false`) records raw response
  chunks and terminal diagnostics; payload logging stops at 4 MiB but reserves bounded `end`/`stream-close`
  records so long reasoning cannot hide the outcome. Traces contain conversation output; they do not record
  request credentials or headers. Tests cover both transports, limit aliases, missing usage, valid
  text/tools, EOF, and a failure before any success finish. `scripts/probe-stream.mjs` tests a separate
  request; its result is not evidence for a prior session.
- **Routing is decided by the catalog's `supported_endpoints`, with the `claude-*` prefix as the fallback —
  and the decision must NOT be cached** (`routesToMessages()` / `resolveProtocol()` in `src/adapter.ts`,
  `MESSAGES_ONLY_MODELS`/`requiresMessagesEndpoint()` in `src/capabilities.ts`; issue #46). The Provider API
  serves the whole Claude family only through `/provider/v1/messages`: posted to
  `/provider/v1/chat/completions`, every catalog Claude id answers `400 Model "<id>" must be called via
  /provider/v1/messages (Anthropic Messages shape)`, and a non-Claude model posted to `/provider/v1/messages`
  answers `400 Model "<id>" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI
  and OSS models.` (measured 2026-09-29 against the 84-model catalog, whose ten `claude-*` ids are the only
  ones carrying `supported_endpoints: ["/messages"]`; 66 carry `["/chat/completions","/responses"]` and 8
  carry `["/chat/completions"]`). **`/provider/v1/messages` is therefore a first-class transport, not a
  fallback** — see the wire-protocol bullet for its measured contract. `resolveProtocol(apiBase, apiKey, model)`
  returns `'messages'` when the catalog entry lists `/messages`, and otherwise falls back to
  `requiresMessagesEndpoint()` so a catalog entry without a route list (every pre-1.55 cache file, and a
  hand-built one) still routes a newly shipped Claude model instead of hard-failing. This holds on any tier
  AND under a forced `'openai'` preference, since that option is documented as "prefer the Provider API, still
  fall back" rather than a hard gate. **The call to `rememberProtocol()` is deliberately absent on this
  path**: `protocolCache` is keyed by gateway and API key, while the decision also depends on the MODEL; remembering it
  would pin the whole ACCOUNT to one transport and drag DeepSeek, GLM and Qwen along with it until the entry
  expired. The same rule governs the `upgrade_required` downgrade: a Messages refusal is not cached, while a
  Chat Completions one is. A Go-plan account never reaches either, because its cached billing tier already
  routes to the CLI transport — which is the only reason that transport still exists.
  `tests/adapter.test.ts` pins the route, the catalog-over-name precedence, the `claude-*` fallback for an
  entry with no route list, and that a Claude request followed by a DeepSeek one still lands on Chat
  Completions.
- **Tool-result history has two supported envelopes** (`toolResultOf()` in `src/adapter.ts`). Through 0.1.6
  the Harness emits a `role: 'user'` message with a first `tool-result` block; 0.1.7 emits `role: 'tool'`,
  message-level `toolCallId`/`isError`, and raw text/image blocks. Pairing AND both serializers must consume
  the same normalized view. Dropping modern results also drops their paired assistant calls, so every model
  loses completed work and can repeat a tool or stop after a statement of intent. Keep errors, image
  carriers, parallel-result grouping and long-id aliases intact across both envelopes. In the LEGACY
  envelope a present non-tool `source.kind` excludes the message; absent source falls back to the first
  block (issue #47). Such an excluded result must not count as paired. Do not read `message.source.kind`
  without the optional guard. Unit tests cover both generations and mixed histories; `npm run test:engine`
  captures both transports using the target engine's actual message constructors, because the development
  peers alone cannot expose this contract drift.
- **Adapter is cordis-free** by design: `src/adapter.ts` takes a per-request `options()` thunk +
  `resolveApiKey()` from the plugin entry, so settings changes reach the next request without
  re-registration. It also accepts an injectable `fetchImpl` for tests.
