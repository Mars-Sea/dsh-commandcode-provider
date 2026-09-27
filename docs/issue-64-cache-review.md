# Issue #64: cache regression review

The current patch improves CLI request alignment and diagnostics. It does **not** establish that the intermittent cache misses reported in [issue #64](https://github.com/Mars-Sea/dsh-commandcode-provider/issues/64) are fixed. The reporter's original requests and a comparable post-change session are unavailable here; local tests cannot measure the gateway's cache or prove its internal prompt layout.

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

- `node --import tsx --test tests/adapter.test.ts tests/stream-trace.test.ts`: 205/205 passed.
- `npm run typecheck`: passed.
- `npm test`: 678/678 passed when local loopback listening was permitted. The sandboxed first run had 22 login-test failures from denied local port binding; no login code was changed for this review.
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

The trace includes raw **response** content, so review it before sharing. Request hashes do not make the entire file safe to publish. No paid generation or authenticated cache benchmark was performed during this review.
