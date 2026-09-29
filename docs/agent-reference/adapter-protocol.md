# Adapter and wire contracts

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **Zero data retention (`Config.zdr`, default off)**: `connectGenerate()` sends `x-cmd-zdr: 1` on BOTH chat
  transports for EVERY request when enabled. The provider refuses a model without an available ZDR upstream
  with `422 cmd_zdr_no_providers`; `generateHttpError()` diagnoses it bilingually. NEVER omit the header
  based on `KNOWN_NON_ZDR_MODELS` or retry without it: that would silently lose the privacy guarantee. The
  snapshot in `src/capabilities.ts` is informational and may lag provider coverage or capacity.
  `tests/adapter.test.ts` checks both transports, off by default, unsupported models retaining the header,
  and 422 diagnosis.
- **Wire protocol** (reverse-engineered, command-code@1.28.4; re-verified through 1.68.0):
  - `POST {apiBase}/alpha/generate` — CLI transport body `{ config, memory, taste, skills, params: { model,
    messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`. Used for
    Go-plan accounts (the only plan without Provider API access) and as the fallback when
    `/provider/v1/chat/completions` returns `upgrade_required`. Historical reasoning IS replayed here as a
    `{ type: 'reasoning', text }` part of the assistant content array, in content order — the official CLI's
    `toWireMessages` converts every `thinking` block that way (command-code@1.54.0), and the provider
    rejects a DeepSeek thinking-mode tool loop whose assistant tool calls arrive without their reasoning
    (`The reasoning_content in the thinking mode must be passed back to the API.`, issue #34). Do not
    "restore" the old drop-reasoning behavior: it was ported from the pi plugin and is no longer upstream's
    shape.
  - `POST {apiBase}/provider/v1/chat/completions` — documented OpenAI-format transport with a flat body `{
    model, messages, tools?, max_tokens, temperature, stream, reasoning_effort? }`. Used for accounts with
    Provider API access; historical reasoning is replayed as `reasoning_content`.
  - **Every tool's root schema is normalized to `type: 'object'`** by `toolParametersSchema()` before either
    body is built (issue #35). The gateway validates the root of each function schema and rejects the entire
    request otherwise (`Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"',
    got 'type: null'`). The harness's own `defineTool` always declares that root, so the failing schema
    comes from a tool registered outside it — a third-party plugin's or MCP bridge's hand-written schema (a
    type-less `{ properties, required }`), an empty `{}`, or a generator's root `$ref`. A schema that
    already declares an object root passes through untouched; a type-less object-shaped one gains the type;
    a root `$ref` is inlined from its local `$defs`/`definitions`; an `allOf`/`anyOf`/`oneOf` root is
    flattened (branch properties unioned, `required` kept only where every alternative demands it); anything
    else degrades to a permissive free-form object, since a refused request helps no one. Only the root is
    touched and every path returns a copy (the harness may deep-freeze tool schemas), and the walk is
    depth-bounded so a self-referential JS schema cannot spin. `toolParametersSchema()` is applied at both
    call sites, so the CLI `input_schema` and the OpenAI `function.parameters` cannot drift apart.
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
    supported_endpoints }] }`. The `supported_endpoints` member is new as of command-code@1.55.0/1.56.0 and
    is the authoritative per-model route list (65 × `['/chat/completions','/responses']`, 9 Claude ids ×
    `['/messages']` (`claude-opus-5-5` is the ninth), and 8 × `['/chat/completions']` as of the 2026-09-27
    public catalog, which serves 82 models); this adapter ignores it and keeps the `claude-*` prefix rule in
    `requiresMessagesEndpoint()`, which agrees with it today.
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
    (undocumented — their Error Codes page has no 413). Both transports inline every historical image as
    base64 and the harness never reclaims history, so a long session (a vision self-check loop reading back
    dozens of screenshots) used to cross the cap once and then fail EVERY later request on this route with
    HTTP 413, while the same conversation worked on another provider. `stream()` therefore builds both
    bodies from a PROJECTED history, never the raw one, and the offload set is a DURABLE session fact:
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
  Historical reasoning blocks are replayed on BOTH transports for tool-loop continuity — as a `{ type:
  'reasoning', text }` assistant part on `/alpha/generate` (the official CLI's shape) and as
  `reasoning_content` on `/provider/v1/chat/completions` (see the wire-protocol bullet; issue #34). Only
  tool calls with a paired tool result are replayed on both transports. **Tool-result images** (`read_image`
  returns text + a nested `image` block): neither wire can hold an image inside a tool result — the CLI's
  `tool-result.output` is text-only (the official CLI's own `toV2ToolOutput` filters out everything but
  text) and Chat Completions forbids non-text `role: 'tool'` content — so `toolResultMedia()` splits each
  result and both converters emit the bytes in a user message immediately after the tool message, led by the
  `Attached image(s) from tool result:` note (the shape `@deepseek-ai/dsh-llm-deepseek` uses). Deduplicated
  by attachment id per result; an image-only result gets a `(image returned; see the attached image)` tool
  text instead of an empty string; a result without a paired call drops its images with the result. Never
  flatten a tool result with `blockText` alone again — that is issue #30. The `hasImageContent` gate (model
  Vision capability + attachment seam) already recurses into tool results, so these images ride the same
  `readImage` resolver user attachments use.
- **Errors**: throw `LlmError` with stable codes. 401 → `INVALID_CREDENTIAL`; 429 → `RATE_LIMIT`;
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
  non-retryable `PROVIDER_STREAM_ERROR` instead of entering the 1000-attempt cadence. Never route a
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
  (`CommandCodeAdapter.stream()`, `src/stream-trace.ts`). A terminal CLI `finish` or OpenAI `finish_reason`
  is necessary but not sufficient for success: reasoning alone, empty text, whitespace, and `tool_calls: []`
  are not an answer. Hold the success `finish` until validation; DSH 0.1.7 converts an adapter throw into an
  error finish, so throwing after publishing success creates two terminal events. A terminal response with
  no text/tools maps to retryable `EMPTY_RESPONSE`, except a length/max-token finish maps to non-retryable
  `OUTPUT_TOKEN_LIMIT` and explicit content filtering remains non-retryable. Preserve received usage on
  failures; report the actual finish reason, request budget, output tokens and reasoning tokens (unknown
  when absent). A length finish proves a limit, not that every token was spent reasoning. Without any
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
- **The Claude family is Messages-only, so it takes the CLI transport — and that decision must NOT be
  cached** (`MESSAGES_ONLY_MODELS`/`requiresMessagesEndpoint()` in `src/capabilities.ts`, the first lines of
  `resolveProtocol()` in `src/adapter.ts`; issue #46). The Provider API serves the whole Claude family only
  through `/provider/v1/messages` (Anthropic Messages shape): posted to `/provider/v1/chat/completions`, all
  eight catalog Claude ids answer `400 Model "<id>" must be called via /provider/v1/messages (Anthropic
  Messages shape)`. Measured 2026-09-16 by posting all 69 catalog models to that endpoint — exactly those
  eight refused, and every one of them is routed normally by `/alpha/generate` (a lower-plan key gets the
  ordinary `MODEL_NOT_IN_PLAN` 403 there, never a routing error), which is why the adapter carries NO
  Messages transport. The bug this fixes is a routing one: the pre-stream fallback only recognised the
  Go-plan `upgrade_required` 403, so the 400 surfaced as `PROVIDER_HTTP_ERROR` — and because the non-Go
  tiers are exactly the ones `resolveProtocol()` sends to the Provider API, the accounts ENTITLED to Claude
  (Pro for Sonnet, Provider/Max for Opus) were the ones that could never use it. `resolveProtocol(apiKey,
  model)` now returns `'cli'` for these models on any tier AND under a forced `'openai'` preference, since
  that option is documented as "prefer the Provider API, still fall back" rather than a hard gate. **The
  call to `rememberProtocol()` is deliberately absent on that path**: `protocolCache` is keyed by API key
  ALONE, so remembering it would pin the whole ACCOUNT to the CLI transport and drag DeepSeek, GLM and Qwen
  — all correctly served by the Provider API — along with it until the entry expired.
  `tests/adapter.test.ts` pins the route, the `claude-*` prefix rule that covers a model shipping after this
  release, and that a Claude request followed by a DeepSeek one still lands on the Provider API.
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
