# Issue #67: "historical sessions keep failing" — review

Reported symptoms (`issues/67`, and the maintainer's own reproduction):

- `/alpha/generate` (Go-plan route): `Command Code API request to … /alpha/generate did not respond within 60000ms`, only in an old session; a new session works.
- `Command Code stream error: Provider returned an empty response`, retried with a growing delay (`重试延迟：30795ms`), in a long/restored session.

Both are retryable codes on a byte-identical payload, so what the user sees is one failure repeated, never a diagnosis. Three separate mechanisms produce them; only one is a plugin defect that can be repaired locally, and it is verified below with live A/B measurements.

## 1. The retry storm itself (`重试延迟：30795ms`)

`providerRetryPolicy()` (`src/adapter.ts:2041`) whitelists `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` with **`maxRetries: 1000`** and a 500 ms → 15 min backoff. Every attempt re-uploads the whole restored history. Nothing in the request path ever shrinks for these codes: `dsh-compaction-basic` only acts on `agent/request-error` with `CONTEXT_WINDOW_EXCEEDED` (engine `dsh-compaction-basic/lib/index.js:862`), which none of the reported wordings map to. The observed delays in the stored sessions (516 / 1050 / 2011 / 4110 / 8548 / 15172 / **33161** ms) are exactly that ladder; 30795 ms is rung 7 with jitter.

In the maintainer's own sessions the same failure appears in a *new* session too (`session-2a832bfb`, step 19, 7 retries then success; `session-72d5f2a9`, turn 3, 7 retries then the user aborted). So "historical session" is a proxy for **long history**, not for session age.

## 2. Where each message comes from

| Wording | Origin | Adapter code (`src/adapter.ts`) | Harness recovery |
| --- | --- | --- | --- |
| `Provider returned an empty response` | in-band `error` event of either transport (the gateway's upstream produced nothing) | `SERVER` — retryable (`streamErrorToLlmError`, :358) | 1000-attempt retry |
| `did not respond within 60000ms` | client-side connect timer (`connectGenerate`, :1796) — headers never arrived | `TIMEOUT` — retryable | 1000-attempt retry |
| `The stealth model could not complete the request.` | HTTP 400 carrying Vercel AI Gateway's `provider_error` blob | `PROVIDER_HTTP_ERROR` — **not** retryable | none (turn dies) |
| `maximum context length is N tokens … (X of text input, Y in the output)` | gateway refusal for an over-window request | `CONTEXT_WINDOW_EXCEEDED` | compaction + retry |

Only the last one is understood as a size problem, and it is the one that names the context window in so many words.

## 3. Verified defect: the output reservation is never checked against the window

The provider charges `max_tokens` to the context window, and says so itself (`/alpha/generate`): *"you requested about 3009885 tokens (3008861 of text input, 1024 in the output)"*.

The adapter asks for **64 000 output tokens on every request**, whatever the prompt already occupies:

```
modelMax  = catalog[model].maxTokens ?? 65_536        // = min(context_length, 65_536)
maxTokens = min(options.maxTokens ?? modelMax, modelMax, DEFAULT_GENERATE_MAX_TOKENS /* 64_000 */)
```

(`src/adapter.ts:2619-2625`; DSH materialises `defaultMaxTokens` — `src/adapter.ts:2183` — into every call, which is why the session headers all carry `maxTokens: 64000`.) There is no term for "how much of the window the prompt just used".

Live measurement on `stealth/pixel-canary` (window 262 144), one-shot probes through the real adapter (`scripts/probe-oversize.mjs`, trace on):

| Prompt | `max_tokens` | Prompt+output | Result |
| --- | --- | --- | --- |
| 1.6 MB lorem (249 566 input tokens, measured) | 1 024 | 250 590 | **200** — but headers only at 74 350 ms: `TIMEOUT` under the default 60 s budget, finished in 79.9 s under a 300 s one |
| same prompt, byte-identical | 64 000 | 313 566 | **400, "The stealth model could not complete the request."** → `PROVIDER_HTTP_ERROR` |
| 1.31 MB lorem (~205 k tokens) | 64 000 | ~269 000 | **400, same nested gateway error** → `PROVIDER_HTTP_ERROR` |

Same payload, same session, same model: only the output reservation differs. A restored session of ~205 k tokens on a 262 k-window model therefore *cannot* be served at `max_tokens: 64000`, yet the refusal does not mention the context window, so the adapter reports it as a permanent provider rejection and the harness never compacts. `stepfun/Step-3.5-Flash` shows the same arithmetic from the other side (the endpoint clamps the request to 32 768 and then refuses with "you requested 32768 output tokens … at least 229377 input tokens": 229 377 = 262 144 − 32 768 + 1).

The engine's side of the contract *does* reserve the output (`dsh-compaction-basic` subtracts `session.requestHeader().config.maxTokens` from `contextWindow` before choosing a compaction threshold), so the intent is that prompt + 64 k never exceeds the window. The adapter itself never re-derives the reservation from the prompt it just built, so any drift between the harness's estimate and the provider's count (a restored session before its first usage report, CJK-heavy text, tool/image estimates) lands exactly on this boundary — with three wordings, two of which are handled as transient or permanent rather than as "reduce the surface".

## 4. Why the harness's own pressure check doesn't save these sessions

`dsh-compaction-basic` does compact proactively between steps (`agent/pre-step` → `compactIfNeeded(agent, 'pressure')`, threshold = `min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroom)`), so the design is sound. It is only as good as the estimate it compares against, and the engine's token meter prices text at a fixed `CHARS_PER_TOKEN = 4` (UTF-16 length, `@deepseek-ai/dsh-token-meter/estimate`). Measured against the provider's own tokenizer (`scripts/probe-cjk-drift.mjs`, 20 000 characters, `stealth/space-bunny-alpha`):

| Text | meter estimate | provider count | drift |
| --- | --- | --- | --- |
| Chinese (20 000 chars, 52 944 UTF-8 bytes) | 5 004 | **12 518** (12 369 input + 149 cache read) | **2.50×** under-count |

The meter can correct itself from reported `usage`, but only while the anchor holds — `anchor.header` must be `optionalHeaderEquals` the current request header (`dsh-token-meter/lib/index.js:646`). A restored session, a changed model/effort/maxTokens, or a changed tool list invalidates that anchor, and the whole surface is then re-priced at 4 chars/token. A Chinese-heavy restored history is therefore estimated ~2.5× low, compaction stays under its threshold, and the first request of the turn goes out with the full 64 000-token reservation attached to a prompt the harness believes is far smaller than it is. The failing request reports no usage (it fails), so nothing ever re-anchors: the session cannot recover by itself.

## 5. The 60 s connect budget is per attempt, and the ROUTE — not the payload — decides what it means

`requestTimeoutMs` (default 60 000) bounds only the *headers* wait, per attempt (`connectGenerate`).

Re-measured on 2026-09-28. Two numbers have to be kept apart here, and an earlier version of this section mixed them: a request's **total** time includes the model producing every token, so it says nothing about how long the headers took.

**Headers, measured directly** (`max_tokens: 16` to collapse the generation, so what is left is the header wait; 26 250-token prompt, one account):

| route | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| `/alpha/generate` | 2.12 s | 2.56 s | 2.75 s | **2.56 s** |
| `/provider/v1/chat/completions` | 5.52 s | 2.98 s | 3.70 s | **3.70 s** |

**Totals**, for the record and NOT header evidence — same model and account, `max_tokens: 1024`:

| prompt | `/alpha/generate` | `/provider/v1/chat/completions` |
| --- | --- | --- |
| 200 000 chars | 11.1 s | 116.7 s |
| 1 200 000 chars | 17.9 s | 30.5 s |

Conclusions:

- **The transport is a real but modest signal: ~1.1 s of median header time**, with the Provider API route swinging across a 2.5 s span where the CLI route moved 0.6 s. The mechanism is read out of the official CLI rather than inferred from these numbers: `createNodeTransport` sets no timeout and passes only the caller's `signal`, so `/alpha/generate` has the gateway answer headers before the model starts, while `/provider/v1/chat/completions` cannot answer until its upstream emits a first token. Whatever that upstream is doing is therefore charged to the header wait, which is why only that route gets the "raise the timeout" advice.
- **Size does not predict the delay.** A 1 MiB body threshold was drafted on the strength of a 74 350 ms figure this file used to quote for a 1.6 MB chat-route prompt; that figure does not reproduce, and the totals above show why a size rule is wrong rather than merely unproven — the 200 k prompt finished 10× slower than the 1.2 M one. Size-based branching would have labelled the 116.7 s request a network problem and the 30.5 s one a size problem. The advice follows the route alone, and the timeout message says outright that size is not the cause.
- **The 116.7 s total is not a header timeout.** Its headers arrived in about 3.7 s; the rest was the model generating and whatever queueing the provider was doing that minute. It is recorded here as unexplained rather than attributed to the route, and it is NOT a reason to think 60 s was too small — see §5b.

A third run is worth keeping: a 6 000 000-char prompt on the chat route returned 400 in 11.3 s and the shipped `readWindowLimitEvidence` path reclassified it to `CONTEXT_WINDOW_EXCEEDED` ("请求接近模型上下文上限，服务商无法完成——正在压缩上下文后重试"), so the compaction route this review argued for does fire on a real over-window request.

## 5b. The 60 s default was five times stricter than the CLI it emulates

Decompiled from `command-code@1.66.0` (`dist/cli.mjs`): `createNodeTransport`'s fetch is `t(url, { method, headers, body, signal: r.signal })` — **no timeout of any kind**. The model request goes through `transport.postStream({ route: "/alpha/generate", …, signal: t.signal })`, so the only bound is the caller's signal, and the request inherits Node/undici's own default. Measured on Node 22.22.0 against a local server that accepts the connection and never sends headers: **`TypeError: fetch failed` at 301.0 s**.

The four `AbortSignal.timeout` calls in the whole bundle are all elsewhere: `describeImages`, the `web_fetch` tool's `fetchSignal`, PowerShell execution and foreground commands — the last two from the user's own `--timeout`.

So the default is now 300 s. The 60 s that preceded it was five times stricter than the CLI being emulated, and being stricter only ever costs legitimate requests: the Provider API route charges its upstream's time-to-first-token to the header wait, and that is unbounded by anything the adapter controls. The cost is accepted deliberately: a dead gateway now takes longer to name itself, and §7.3's streak is what bounds that (three attempts, then a diagnosis).

**What is NOT a reason for 300 s, recorded so it is not repeated:** the 116.7 s total in §5. It is a *total*, its headers arrived in ~3.7 s, and "60 s could not complete a 117 s request" is therefore false. The 300 s default rests solely on matching the official CLI's measured behaviour.

## 6. What is *not* a defect

- A clearly over-window request is classified correctly on both transports: `/alpha/generate` → in-band `maximum context length` → `CONTEXT_WINDOW_EXCEEDED`; `/provider/v1/chat/completions` → 400 `exceeds the model's context window` → `CONTEXT_WINDOW_EXCEEDED`. Both reach compaction.
- The reported `Provider returned an empty response` is not payload-deterministic: the exact failing payload of `session-72d5f2a9` (226 759-byte body, 32 tools, `effort: high`, `maxTokens: 64000`, 161 messages) replayed **4/4 clean** (2.5-3.8 s) half an hour later. The same account's stored history shows the sibling condition as `503 Upstream model provider is temporarily unavailable` (19 and 53 retries in two sessions) — a provider-side capacity episode. That wording needs to be *survivable*, not "explained".

## 7. Shipped in this working tree (was: proposed repair)

> **2026-09-30 update (issue #74): item 1 below was REVERTED.** `requestContextBudget()` pre-shrank every
> request's `max_tokens` from an estimate of the prompt just built, and that shrink grew more aggressive as a
> conversation grew — which is exactly the "output gets cut short as the session gets longer" symptom issue
> #74 reported, on ordinary conversations nowhere near actually overflowing the window. Before reverting, a
> live A/B probe (2026-09-30, `stealth/space-bunny-alpha`, free, 1,000,000-token window) sent a genuinely
> over-window request — ~19.6% over, the same relative overshoot as the ambiguous-400 case measured below —
> with the client-side shrink skipped entirely (`contextWindow` left `undefined`, so `requestContextBudget()`
> took its early-return branch and sent `max_tokens` unshrunk). The endpoint answered with an unambiguous
> `400 … exceeds the model's context window`, which `isContextOverflowDetail()` (item 2 below, still in place
> and NOT reverted) classified as `CONTEXT_WINDOW_EXCEEDED` on its own — no client-side estimate needed. The
> original ambiguous-400 wording quoted just below was measured specifically on `stealth/pixel-canary`, which
> was itself unavailable (503/404) at probe time, so that exact model/wording combination could not be
> re-verified live; item 1 is being kept reverted on the strength of the `space-bunny-alpha` evidence, with
> that gap recorded rather than hidden. See [决策记录](决策记录.md) §一.5 for the fuller record and what would
> justify reinstating some form of client-side clamp.
>
> Items 2–4 are UNCHANGED and still shipped.
1. ~~**Clamp the output reservation to the remaining window**~~ — REVERTED 2026-09-30 (issue #74); was `requestContextBudget()` in `src/adapter.ts`. It estimated the prompt from the body it just built and took `maxTokens = min(requested, max(floor, window − estimate − headroom))`, and its `sizePressure` flag gated the 400 reclassification below. Verified on a real over-window request: a 6 M-char prompt returned the reclassified `CONTEXT_WINDOW_EXCEEDED` in 11.3 s. See the update note above for why it was removed.
2. **Recognise the size-driven wordings** — IMPLEMENTED as `readWindowLimitEvidence()` / `generateHttpError()`'s `isContextOverflowDetail` branch, which maps the nested gateway `provider_error` to `CONTEXT_WINDOW_EXCEEDED` from the wording alone (item 1's `sizePressure` gate on the SEPARATE ambiguous-`provider_error` branch was removed together with item 1; this wording-based branch is untouched). Left deliberately alone: an in-band empty response and a headers timeout are NOT mapped to it, because measurement (§5) shows neither is caused by size.
3. **Bound the identical-payload loop** — IMPLEMENTED as a header-timeout streak on the adapter instance. dsh-llm's `NormalRetryPolicyConfig` carries one scalar `maxRetries` beside the code list, so there is no per-code limit to lower; the third consecutive headers timeout on one unchanged payload instead leaves the whitelist as `PROVIDER_HTTP_ERROR` and says why. `RATE_LIMIT` / `SERVER` / `TRANSPORT` keep retrying, because each carries a real "come back later" signal. The streak lives across `stream()` calls because dsh-llm-retry re-invokes the same instance, and any answer from the gateway ends it.
4. **Word the timeout for the cause it has** — the message no longer sends everyone to their proxy. On `/alpha/generate` it names provider queueing, Go-plan capacity, or a network/proxy path and says a longer budget will not help; on `/provider/v1/chat/completions` it names the upstream first token and suggests a concrete `requestTimeoutMs`. Both say outright that prompt size is not the cause, which §5's table is the evidence for.
5. **Upstream (DSH) follow-up:** still open. The meter's fixed 4-chars/token fallback is what lets a Chinese-heavy history slip past compaction; `bytes / 4` would be conservative for CJK as well. The adapter-side clamp is the safety net until that lands.

## Reproduction

```bash
export COMMANDCODE_API_KEY=$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.dsh/.credentials.yaml'))['refs']['COMMANDCODE_API_KEY'])")
# A/B the output reservation on a 262k-window model
PROMPT_CHARS=1600000 PROBE_MODEL=stealth/pixel-canary PROBE_MAX_TOKENS=1024  node --import tsx scripts/probe-oversize.mjs  # 200, headers at ~74s (TIMEOUT at the default 60s budget)
PROMPT_CHARS=1600000 PROBE_MODEL=stealth/pixel-canary PROBE_MAX_TOKENS=64000 node --import tsx scripts/probe-oversize.mjs  # 400 provider_error
# over-window wording per transport (both classified CONTEXT_WINDOW_EXCEEDED)
PROBE_PROTOCOL=cli PROMPT_CHARS=12000000 PROBE_MODEL=stealth/space-bunny-alpha PROBE_MAX_TOKENS=1024 node --import tsx scripts/probe-oversize.mjs
```

```bash
# estimate drift for the harness's meter
CJK_CHARS=20000 node --import tsx scripts/probe-cjk-drift.mjs
LATIN_CHARS=20000 node --import tsx scripts/probe-cjk-drift.mjs
```

Raw traces land in `/tmp/oversize-*.jsonl` (`DSH_COMMANDCODE_TRACE`); they are the artifact that separates a gateway refusal from an adapter misread. `scripts/probe-oversize.mjs`, `scripts/probe-cjk-drift.mjs`, `scripts/replay-session.mjs` and `scripts/replay-batch.sh` are local (untracked) investigation tools.

No paid benchmark was run: every measurement above used the free `stealth/*` models except two `stepfun/Step-3.5-Flash` calls (~510 k input tokens, ≈ $0.05).
