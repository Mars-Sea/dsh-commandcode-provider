# Issue #64: cache regression review

The current patch improves CLI request alignment and diagnostics. It does **not** establish that the intermittent cache misses reported in [issue #64](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/64) are fixed. A synthetic authenticated replay now reproduces the same first-image cache boundary on the real `/alpha/generate` service; the reporter's original requests and the gateway's internal prompt layout remain unavailable.

## 2026-09-29 the Messages route: a separate zero, found by billing rather than by cache

Everything above concerns the CLI transport. The Claude family does not use it — it answers only on `/provider/v1/messages` — and that route had a different and quieter defect: **it sent no cache marker at all**.

The evidence is a 10-turn `claude-sonnet-5-5` session's own billed rows. Repricing each against Claude Sonnet 5.5's published rates (`input` $2/M, `output` $10/M, `cache read` $0.20/M, `cache write` $2.5/M) reproduces all ten to the cent, for example `37898 × $2/M + 1312 × $10/M = $0.088916` against a logged `$0.0889`, and `$0.56484` across the session. A single cached token anywhere in those ten requests would have moved the total, so the whole session ran at the undiscounted rate. `mapMessagesUsage()` was not at fault: it already maps `cache_read_input_tokens` and `cache_creation_input_tokens`, and it was faithfully reporting the zero the request had asked for. `buildMessagesBody()` was the cause — it set `system` to a bare string and marked nothing, and Anthropic's caching is opt-in per block, so an unmarked prefix is re-prefilled at full price on every turn. This is the opposite failure mode from #64, and #64's CLI experiments could not have found it.

**The fix copies the official client's breakpoints rather than inventing them.** No quota remained for a live A/B, so the placements come from what Command Code's own clients send to this same endpoint. Three artifacts were fetched and each was checked against its registry-published sha512 digest before reading:

| Artifact | Digest | What it establishes |
| --- | --- | --- |
| `command-code@1.68.0` | matches | The CLI's only `cache_control` is in `toWireSystem()`. It never posts to `/provider/v1/messages` at all (0 occurrences), so it is silent on this route. |
| `CommandCodeAI/pi-commandcode-provider` (official repo) | n/a (source) | Calls this endpoint through the Anthropic SDK and reads `pricing.cache_read` / `pricing.cache_write` from the model list to price results. |
| `@earendil-works/pi-ai@0.87.1` | matches | Its `anthropic-messages` transport sets exactly three markers: the `system` block, the last tool (when `compat.supportsCacheControlOnTools`), and the last block of the last `user` message. TTL stays unset unless retention is `long` on a `supportsLongCacheRetention` model. |

The adapter now sets the same three. The last user turn is what makes it pay: DSH resends the entire history each request, so a marker there is a rolling boundary, whereas the `system`-only marker the CLI uses would leave everything after the first turn uncached. The session reprices to $0.1869, a 66.9% reduction, with no other field changed.

**What this does not prove.** That the gateway honours `cache_control` on this endpoint is inferred, not measured: the official pi provider depends on the field for its own cost display, so a gateway stripping it would misprice every Claude session visibly. The exposure is bounded in both directions — a gateway that ignored the field would change nothing, and one that honoured it without a hit would bill only the first turn's write at $2.5/M against $2/M, with later turns hitting inside the 5-minute window. A live A/B remains the acceptance check once quota exists: post the same history twice, with and without the markers, and compare `cache_creation_input_tokens` / `cache_read_input_tokens`.

## 2026-09-28 image-path follow-up

The reporter's [0.11.17 follow-up](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/64#issuecomment-5854327366) narrows the symptom: all 15 misses in a 161-request session immediately followed a tool result that added an image, and the cached prefix repeatedly stopped near the first image boundary. This is a correlation, not yet a wire-level proof of the cause.

An integrity-verified `command-code@1.66.0` CLI artifact exposed a protocol mismatch missed in the first review. The CLI accepts `{ type: 'image', source: { type: 'base64', media_type, data } }` internally, but its `toWireMessages()` posts `{ type: 'image', image: 'data:<mime>;base64,...', mimeType: '<mime>' }` to `/alpha/generate`. The plugin had been posting the internal shape. It also discarded `readImageRequest()`'s returned `mediaType`, labelling a JPEG/WebP request variant with the stored attachment's MIME on both transports. The attachment-local implementation gives request variants a deterministic identity and caches their encoded bytes, so byte instability is not established by code inspection alone.

The working-tree repair sends the final CLI image shape and preserves request-version MIME. Focused tests exercise a tool-result image, a stored PNG whose request variant is JPEG, and append-only replay of earlier image-bearing messages. Existing trace fingerprints can compare the shared `messages.items` prefix around a miss. A synthetic authenticated image-heavy replay is reported below; it reproduces a cache boundary despite identical historical wire messages. This means the image wire correction alone does not close the issue.

## 2026-09-28 authenticated service replay

`node --import tsx scripts/probe-cache-live.mjs` used the current adapter build, the local Command Code credential, `/alpha/generate`, `deepseek/deepseek-v4.1-flash`, one stable CLI thread ID per run, 26 fixed tool declarations, about 54k initial prompt tokens, and three generated 1800×1200 images returned by synthetic tool calls. The request-image bytes came from the real dsh 0.1.7-rc.2 attachment projection. The second run inserted a text-only tool result as a control. A third run used `LIVE_IMAGE_NOTE_MODE=none` to remove the plugin's explanatory text from image-carrier user messages before sending, matching the official CLI's image-only carrier more closely. All 28 generation responses were HTTP 200. The report records only numeric usage, timings, and SHA-256 request fingerprints, never the credential or raw conversation.

| Second-run request | Cache read | Uncached input | Observation |
| --- | ---: | ---: | --- |
| text after image 1 | 54,912 | 126 | Warm prefix including image 1 |
| text-only tool result | 54,912 | 470 | No cache-read regression |
| text after tool result | 55,296 | 103 | Prefix grows normally |
| image 2 | 54,016 | 2,468 | Cache read falls by 1,280 tokens |
| text after image 2 | 56,448 | 51 | Cache recovers |
| image 3 | 54,016 | 3,568 | Cache read falls by 2,432 tokens |
| text after image 3 | 57,472 | 127 | Cache recovers |

The first run showed the same pattern: cache read was 54,912 after image 1, 54,016 when image 2 arrived, 56,064 in the next text request, 53,888 when image 3 arrived, and 57,216 in the next text request. In all three runs the fixed `config`, `system`, `tools`, and `threadId` had one hash; every prior serialized message hash stayed byte-identical as new messages were appended. The image request variants were deterministic and reused through the attachment service. Thus the measured retreat to the first-image boundary is not explained by a changed historical request prefix, changing tool declarations, protocol fallback, or local image re-encoding. It is observed in the service's returned cache counters; the exact gateway/model cache mechanism remains unknown.

The image-only carrier did not remove the drop: the third run's cache read was 55,296 after the text-only control, 54,016 with image 2, 56,320 on the next text request, 54,016 with image 3, and 57,472 on the next text request. Its historical wire-message hashes also stayed identical. The explanatory line is therefore not the trigger in this fixture.

This shorter replay proves the failure mode exists with the corrected image wire shape. It does not reproduce the reporter's 161-request/242k-token scale or its 30–39 second slow steps: re-prefill here was only 1.3–2.4k tokens, with first output around 5–7 seconds. The original issue also has an image-bearing session without cache drops, so image insertion is correlated with, but not a sufficient universal condition for, the failure. A provider-side cache-layout investigation or an explicitly chosen history tradeoff is still needed for a real fix.

## 2026-09-28 cache mitigation experiments

An image-part `cache_control: { type: 'ephemeral' }` appeared to help on a replay that reused the preceding fixture. A fresh-prefix A/B disproved that result: both marked and unmarked requests fell from 41,728 cached tokens to 40,448 when image 2 arrived, then from 42,752 to 40,448 with image 3. The earlier apparent benefit was compatible with cache warming from prior runs, so this marker is not sent by the adapter. A text cache marker appended after each image ended one run with `EMPTY_RESPONSE` on image 2 after a long HTTP-200 stream; it supplied no positive evidence of a fix.

A separate four-request A/B grew the conversation by roughly 21k tokens after image 1, then appended image 2. With all images replayed, the `growth-text` request reported 23,296 cached / 20,820 uncached, while image 2 returned to 22,144 cached / 23,033 uncached: the newly grown text was re-prefilled. In the offload variant, image 1 was durably represented as a text placeholder after the model answered. The successful retry reported 43,136 cached / 70 uncached for `growth-text`, then **43,136 cached / 1,131 uncached** when image 2 arrived. The offload variant's first attempt timed out during `growth-text`; the retry reused the same fixture, so its growth text was already warm. The decisive observation is that image 2 retained that 43,136-token prefix rather than returning to 22,144. The first image still reached the model before being offloaded, and image 2 remained on the wire.

The opt-in `offloadSeenImagesForCache` setting implements that mitigation through dsh's existing `IMAGE_OFFLOAD_REQUIRED` → durable `image/offload` → retry contract. It acts only on the CLI route and only on retained images followed by an assistant response from the same model. It is off by default: replacing old pixels with placeholders changes later model context, and a user image without a local file may need to be attached again. This is not a server-side fix. The longer 161-request case should still be tested with the option enabled before making a cost or latency claim for that scale.

A further fresh-prefix run exercised the **implemented adapter option** rather than premarking the fixture. `LIVE_ADAPTER_OFFLOAD=1` caused the adapter to raise `IMAGE_OFFLOAD_REQUIRED`; the probe passed the requested count through dsh 0.1.7-rc.2's real `offloadOldestImages()` selector over synthetic session events, applied its `image/offload` targets, and retried. All four `/alpha/generate` requests returned HTTP 200. After image 1, the growth-text request offloaded one old image and reported 22,144 cached / 21,062 uncached tokens. Image 2 then reported **43,136 cached / 1,155 uncached** tokens, preserving the grown prefix. The probe's fake session reproduces the DSH selection contract but is not a full running Host; `npm run test:engine` separately verifies the staged plugin and offload failure shape against that engine. The result is stored in `/private/tmp/commandcode-issue64-adapter-offload-b.json` as counters and hashes only.

## 2026-09-28 root-cause boundary

A fresh-prefix, four-request control kept all images and changed several plugin-only wire details to the official CLI's shape: tool declarations omitted `type: 'function'`, top-level `permissionMode` was `standard`, `temperature` was omitted, and the tool-result image carrier contained no explanatory text. The fixed request fields and all preceding serialized messages remained byte-identical as the conversation grew. The growth-text request reported 23,296 cached / 20,820 uncached tokens; image 2 still retreated to **22,272 cached / 22,905 uncached** tokens. All four service responses were HTTP 200. The numeric/hash report is `/private/tmp/commandcode-issue64-cli-parity.json`.

This excludes those particular client-side differences as a fix for this synthetic case. It does not prove the complete CLI and plugin requests are identical, nor reveal the gateway's rendered multimodal prompt, backend routing, or cache key. A fidelity-preserving repair would need the service to reuse the same cached prefix when a new image is appended, or a documented protocol mechanism that provides that behavior. Without such a mechanism, dropping old image pixels is a context tradeoff rather than a root-cause fix. A comparable image-heavy run through the official CLI, captured with sanitized request and response identifiers, would determine whether the failure is shared with the CLI before asking Command Code to inspect the gateway's prompt and cache decisions.

## Upstream evidence

Public artifacts were fetched on 2026-09-26 with the repository's upstream skill, with npm tarball integrity verification. The original cache comparison covers [command-code 1.65.2](https://registry.npmjs.org/command-code/1.65.2), used by the reporter, and [1.65.5](https://registry.npmjs.org/command-code/1.65.5), latest at that collection time. The working tree subsequently synchronized the CLI header and model snapshot to 1.66.0; that sync does not establish a cache fix.

| Item | Verified behavior and implication |
| --- | --- |
| `threadId` | `createModelClient` passes the run/session ID through `toWireThreadId`. DSH's ordinary session ID is `session-<UUID>`, so the adapter now maps it deterministically to a wire-compatible UUID across requests and Host restarts. The reporter already tested fixed versus random IDs without improvement, so this is not an established root cause. |
| `system` | `toWireSystem` converts sections to text blocks and adds `cache_control: { type: 'ephemeral' }` only to marked sections. `createSystemPromptBuilder` separates base/workspace sections from IDE context; `composeSystemPrompt` adds extension/deferred-tool context afterward. The plugin receives a folded DSH system prompt, so wrapping it as one block does not recreate the CLI's section boundaries or guarantee cache hits. |
| `promptCache` | The normal agent-loop call does not set it. The transport copies an undefined value, which JSON serialization omits. The explicit `"off"` call sites are the verifier and compaction calls. No evidence supports adding a made-up `"on"` or boolean setting to normal plugin requests. |
| `permissionMode` | `toWirePermissionMode` normalizes absent/default values to `"standard"`; other values describe the CLI's permission mode. It is not a demonstrated cache switch. This review leaves the plugin's omission unchanged rather than asserting a mapping from DSH's separate approval model. |
| Dynamic context | The plugin sends `memory`, `taste`, and `skills` as null; config contains no per-step tool output or live git status. Config's UTC date can change at midnight, and settings/system/tools/history can change when their inputs change. The [0.33.0 changelog](https://commandcode.ai/changelog#v0.33.0) confirms a cache overhaul, but its text does not expose the gateway's final prompt construction. It cannot prove this plugin bypasses or inherits that fix. |
| CLI `traceIds` | `startChatSpan` creates an OpenTelemetry span locally, calls `onTraceId`, and injects `traceparent` into the request. The stored CLI trace IDs are not evidence that the server returns the same IDs in its response. The plugin now retains IDs the server actually supplies; missing IDs remain missing. |

## Gaps repaired in the existing patch

- Request fingerprinting previously ran even with tracing disabled, repeatedly serializing and hashing the body. It now runs only while the trace is enabled and writable.
- OpenAI requests were read through the CLI-only `body.params` path, reporting no model/messages/tools. Each protocol now uses its real body layout.
- A whole-history hash changes on every append and cannot locate a rewritten prefix. Ordered per-message hashes now distinguish an ordinary append from the first changed historical message.
- Records had only a model scope and relative time, making concurrent same-model requests ambiguous. Each trace now has a unique `streamId`, an absolute opening time, a session ID on requests when supplied, and numbered connection attempts.
- Every received response, including HTTP rejection before fallback/rotation, records status and allowlisted correlation headers. Only the successful attempt's identifiers reach its assistant message.
- Successful responses retain supplied IDs in DSH's `message.source.replayState.response`, even with tracing disabled. An HTTP rejection or stream failure retains a supplied request ID in `failure.requestId`. No request credentials, arbitrary response headers, or raw request text are added to diagnostics.

The response allowlist is `x-request-id`, `request-id`, `x-trace-id`, `x-generation-id`, and `traceparent`. Stream identifiers are collected only from explicit correlation fields, OpenAI completion IDs, and CLI `response-metadata.id`; tool-call IDs are not treated as generation IDs. These readers are tolerant of absent metadata and do not assert that every endpoint emits each field.

## Validation and remaining acceptance check

Regression tests drive the actual adapter through both transports, verify that four growing tool-loop requests preserve serialized historical prefixes, locate an intentionally rewritten historical message, exercise OpenAI-to-CLI fallback, preserve IDs through DSH's real `BlockAssembler`, and keep request IDs on HTTP/stream errors. A counter-based test first reproduced redundant serialization with tracing off and passes after the guard was added.

Validation completed on the working tree:

- `node --import tsx --test tests/adapter.test.ts`: 191/191 passed after the opt-in mitigation and its durable-node guard were added.
- `npm run typecheck`: passed.
- `npm test`: 691/691 passed when local loopback listening was permitted. The sandboxed first run had 22 login-test failures from denied local port binding; no login code was changed for this review.
- `npm run build`: passed; the generated `lib/` reflects the working tree, including its other ongoing changes.
- `npm run test:engine -- --engine /Users/mars-sea/.npm/_npx/4f4f47d9854f3c73`: passed against an existing DSH 0.1.7-rc.2 engine.
- `git diff --check`: passed.

To complete the cache check, reproduce a comparable multi-step session with the changed build loaded and tracing enabled. For the Windows environment in the issue, set the variable in the PowerShell window that starts the Host:

```powershell
$env:DSH_COMMANDCODE_TRACE = "$env:TEMP\cc-cache64.jsonl"
dsh web
```

Group records by `streamId`, then compare requests with the same session, model and protocol. Compare `config`, `system`, `tools`, and the shared prefix of `messages.items`; a changing whole-body/history hash alone is expected. Compare the corresponding `end.usage` counts with DSH's session usage. Uncached input, cache reads, and cache writes are disjoint counts; add them for total prompt tokens.

If the shared input prefix changes, inspect the corresponding DSH system/context/tool/history update. If it remains identical while cache reads collapse, the trace narrows the investigation to gateway/provider behavior without proving which internal mechanism caused it. Use the recorded response IDs when present for upstream investigation. Separate cache hit rate from time to first output: the original report includes high-hit requests that were still slow.

The trace includes raw **response** content, so review it before sharing. Request hashes do not make the entire file safe to publish. The authenticated benchmark above uses a separate synthetic fixture and does not enable raw-response tracing.
