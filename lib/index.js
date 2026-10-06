import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { CONTEXT_WINDOW_EXCEEDED_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, assertUsableApiKey, attributionHeaders, errorChain, isContextWindowExceededError, offloadedImageText, projectOffloadedImages, requiredImageOffload, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createServer } from "node:http";
import { createServer as createServer$1 } from "node:net";
import { WebError } from "@deepseek-ai/dsh-web";
//#region src/cost-facts.ts
const zeroCostTokens = () => ({
	uncachedInputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
});
const COST_TOKEN_KEYS = [
	"uncachedInputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens"
];
function peakHour(at, windows) {
	const time = new Date(at);
	return time.getUTCDay() !== 0 && time.getUTCDay() !== 6 && windows.some(([start, end]) => time.getUTCHours() >= start && time.getUTCHours() < end);
}
/**
* All prompt billing buckets determine a request's band, never cumulative
* session input.
*
* A tiered model returns the matching band and does NOT then apply `peak`: the
* page publishes those two dimensions independently and no row carries both
* today, so the combination becoming real is visible before it reaches a user.
* This ordering is a latent choice, not a verified upstream rule.
*/
function requestRates(price, at, contextTokens, table) {
	const tier = price.contextTiers?.find((tier) => tier.maxContext === void 0 || contextTokens <= tier.maxContext);
	if (tier !== void 0) return tier;
	return price.peak !== void 0 && at !== null && peakHour(at, table.peakHours) ? price.peak : price;
}
/** Cache version and wire guard: changing bands/rates must refold historical groups. */
function pricingKey(table) {
	const rates = (r) => [
		r.inputCost,
		r.outputCost,
		r.cacheReadCost,
		r.cacheWriteCost ?? null
	];
	const canonical = JSON.stringify([
		"commandCodeCost-v1",
		table.peakHours,
		table.models.map((p) => [
			p.id,
			p.slug,
			p.free === true,
			rates(p),
			p.peak ? rates(p.peak) : null,
			p.contextTiers?.map((t) => [t.maxContext ?? null, rates(t)]) ?? null
		])
	]);
	let hash = 2166136261;
	for (const c of canonical) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
	return hash;
}
/** Only safe to merge requests whose billing classification is identical. */
function costGroupKey(group, table) {
	const price = table.models.find((p) => p.id === group.model || p.slug === group.model);
	return JSON.stringify([
		group.provider,
		group.model,
		price === void 0 ? null : requestRates(price, group.at, group.contextTokens, table),
		group.at === null
	]);
}
//#endregion
//#region src/plan-tiers.ts
/** Shared plan-tier presentation facts; safe to inline into the browser bundle. */
const PLAN_TIER_ORDER = [
	"go",
	"goat",
	"pro",
	"provider",
	"max"
];
const PLAN_LABELS = {
	go: "Go",
	goat: "GOAT",
	pro: "Pro",
	provider: "Provider",
	max: "Max"
};
const PLAN_ORDER = Object.fromEntries(PLAN_TIER_ORDER.map((tier, index) => [tier, index]));
//#endregion
//#region src/capabilities.ts
/**
* Static capability snapshot for the Command Code provider: model →
* reasoning-effort levels, vision/thinking flags, model → minimum plan tier,
* subscription-plan labels, deals, and hourly (peak/off-peak) pricing.
*
* Everything here is synced from official sources — the command-code CLI
* bundle's model table (`dist/cli.mjs`, re-verified at command-code@1.74.3) and
* the official plan/pricing/model docs; see the dsh-commandcode-upstream skill
* for the extraction procedures. Keeping the snapshot in its own module
* confines those frequent sync diffs here: src/adapter.ts holds only the stable
* wire/runtime logic. The read helpers live here too, for the same reason.
*
* Ported from pi-commandcode-provider (MIT); originally part of src/adapter.ts
* and split out so upstream syncs stay reviewable.
*/
const KNOWN_EFFORTS = {
	"Qwen/Qwen3.8-Max": [
		"low",
		"medium",
		"xhigh"
	],
	"Qwen/Qwen3.8-Max-0902": [
		"low",
		"medium",
		"xhigh"
	],
	"Qwen/Qwen3.8-27B": [
		"low",
		"medium",
		"xhigh"
	],
	"Qwen/Qwen3.8-Flash": [
		"low",
		"medium",
		"xhigh"
	],
	"Qwen/Qwen3.8-Omni-Flash": [
		"low",
		"medium",
		"xhigh"
	],
	"claude-fable-5-1": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-fable-5": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-opus-4-7": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-opus-4-8": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-opus-5": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-sonnet-4-6": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-sonnet-5": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-sonnet-5-5": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"deepseek/deepseek-v4-flash-fast": [
		"low",
		"high",
		"max"
	],
	"deepseek/deepseek-v4.1-flash": [
		"off",
		"low",
		"high",
		"max"
	],
	"deepseek/deepseek-v4.1-flash-fast": [
		"off",
		"low",
		"high",
		"max"
	],
	"deepseek/deepseek-v4-flash": [
		"off",
		"high",
		"max"
	],
	"deepseek/deepseek-v4-flash-vision-exp": [
		"off",
		"high",
		"max"
	],
	"deepseek/deepseek-v4-pro": [
		"off",
		"high",
		"max"
	],
	"google/gemini-3.1-flash-lite": [
		"low",
		"medium",
		"high"
	],
	"google/gemini-3.5-flash": [
		"low",
		"medium",
		"high"
	],
	"google/gemini-3.5-flash-lite": [
		"low",
		"medium",
		"high"
	],
	"google/gemini-3.6-flash": [
		"low",
		"medium",
		"high"
	],
	"google/gemini-3.7-flash": [
		"low",
		"medium",
		"high"
	],
	"gpt-5.3-codex": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"gpt-5.4": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"gpt-5.4-mini": [
		"low",
		"medium",
		"high"
	],
	"gpt-5.5": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"gpt-5.6-luna": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"gpt-5.6-sol": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"gpt-5.6-terra": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"moonshotai/Kimi-K3": [
		"low",
		"high",
		"max"
	],
	"google/gemini-3.8-flash": [
		"low",
		"medium",
		"high"
	],
	"sakana/fugu-ultra": ["high", "xhigh"],
	"stepfun/Step-5-Preview": [
		"low",
		"medium",
		"high"
	],
	"tencent/hy4-preview": [
		"low",
		"medium",
		"high"
	],
	"xai/grok-4.5": [
		"low",
		"medium",
		"high"
	],
	"xai/grok-4.6": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"xai/grok-4.7": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"z-ai/glm-5.3-flash": [
		"low",
		"high",
		"max"
	],
	"z-ai/glm-5.3-flashx": [
		"low",
		"high",
		"max"
	],
	"zai-org/GLM-5.2": ["high", "max"],
	"zai-org/GLM-5.3": [
		"low",
		"high",
		"max"
	],
	"meta/muse-spark-1.1": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"meta/muse-spark-1.2": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"meta/muse-spark-1.2-contributor": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"meta/muse-spark-1.3": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"meta/muse-spark-1.3-contributor": [
		"low",
		"medium",
		"high",
		"xhigh"
	],
	"gpt-6-astra": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"claude-opus-5-5": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"gpt-6-luna": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"gpt-6-sol": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"MiniMaxAI/MiniMax-M3": [
		"low",
		"medium",
		"high"
	],
	"gpt-6.1-sol": [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	"inclusionai/ling-3.1-flash:free": [
		"low",
		"medium",
		"high"
	]
};
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
const KNOWN_IMAGE_MODELS = /* @__PURE__ */ new Set([
	"MiniMaxAI/MiniMax-M3",
	"Qwen/Qwen3.6-Plus",
	"Qwen/Qwen3.7-Flash",
	"Qwen/Qwen3.7-Plus",
	"Qwen/Qwen3.8-27B",
	"Qwen/Qwen3.8-Flash",
	"Qwen/Qwen3.8-Max",
	"Qwen/Qwen3.8-Max-0902",
	"Qwen/Qwen3.8-Omni-Flash",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4.1-flash",
	"deepseek/deepseek-v4.1-flash-fast",
	"google/gemini-3.1-flash-lite",
	"google/gemini-3.5-flash",
	"google/gemini-3.5-flash-lite",
	"google/gemini-3.6-flash",
	"google/gemini-3.7-flash",
	"google/gemini-3.8-flash",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
	"meta/muse-spark-1.1",
	"meta/muse-spark-1.2",
	"meta/muse-spark-1.2-contributor",
	"meta/muse-spark-1.3",
	"meta/muse-spark-1.3-contributor",
	"moonshotai/Kimi-K2.5",
	"moonshotai/Kimi-K2.6",
	"moonshotai/Kimi-K2.7-Code",
	"moonshotai/Kimi-K2.7-Code-Highspeed",
	"moonshotai/Kimi-K3",
	"sakana/fugu-ultra",
	"stepfun/Step-3.7-Flash",
	"stepfun/Step-5-Preview",
	"thinkingmachines/inkling",
	"thinkingmachines/inkling-small",
	"xai/grok-4.5",
	"xai/grok-4.6",
	"xai/grok-4.7",
	"xiaomi/mimo-v2.5",
	"xiaomi/mimo-v2.6-flash",
	"xiaomi/mimo-v2.6-pro",
	"xiaomi/mimo-v2.6-pro-ultraspeed",
	"z-ai/glm-5.3-flash",
	"z-ai/glm-5.3-flashx"
]);
/**
* Models WITHOUT a zero-data-retention upstream, per the official CLI's own
* registry (`command-code@1.74.3` `dist/cli.mjs`): `modelSupportsZdr(id)` is
* exactly `!nonZdrSet.has(canonicalize(id))`, and `knownModelSupportsZdr`
* carries the same membership in the sibling route table — the UNION of both
* is this set. Reading only the sibling route table dropped
* `meituan/LongCat-2.0`, which sat in `modelSupportsZdr` alone through
* 1.73.0; the 1.74.3 table lists it in NEITHER set, so as of this snapshot it
* is no longer excluded. The official docs (commandcode.ai/docs/resources/
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
* `minimax/minimax-m3-free` is the one entry the public catalog
* (`/provider/v1/models`) does not serve (it is CLI/pricing-visible and hidden
* from the picker); it stays listed because the CLI carries it and a Go-plan
* request can still name it.
*
* Keep in sync via the dsh-commandcode-upstream skill: the CLI's registry data
* (its `zdr:{only:[…]}` provider routes and the per-provider `zdr`/`noTraining`
* flags) is upstream-internal routing, not a per-model contract, so this table
* is the snapshot of the exclusion set and nothing more. It is a rare change:
* 20 members held across 1.62.0 → 1.64.0, 1.65.0 and 1.66.0 each added exactly
* one (the two stealth-preview models below), 1.67.0 added one
* (`deepseek/deepseek-v4.1-flash-fast`), 1.68.0 changed nothing, and 1.74.1
* removed one (`meituan/LongCat-2.0`). The 1.74.2/1.74.3 pair changed nothing
* here either — 22 members as of 2026-10-06.
*
* `stealth/pixel-canary` and `stealth/space-bunny-alpha` are the members whose
* models themselves are retired (see `KNOWN_EFFORTS`): the CLI keeps naming both
* in the ZDR anchors even though it hides their rows and dropped them from the
* catalog, so they stay listed here rather than being pruned with the rest of
* the tables — `supportsZeroDataRetention` stays truthful for any id a stale
* session still names.
*/
const KNOWN_NON_ZDR_MODELS = /* @__PURE__ */ new Set([
	"MiniMaxAI/MiniMax-M3",
	"Qwen/Qwen3.8-Max-0902",
	"deepseek/deepseek-v4.1-flash-fast",
	"meta/muse-spark-1.1",
	"meta/muse-spark-1.2",
	"meta/muse-spark-1.2-contributor",
	"meta/muse-spark-1.3",
	"meta/muse-spark-1.3-contributor",
	"minimax/minimax-m3-free",
	"poolside/laguna-s-2.1-free",
	"sakana/fugu-ultra",
	"stealth/space-bunny-alpha",
	"stealth/pixel-canary",
	"stepfun/Step-3.7-Flash",
	"stepfun/Step-5-Preview",
	"xai/grok-4.5",
	"xai/grok-4.6",
	"xiaomi/mimo-v2.6-flash",
	"xiaomi/mimo-v2.6-pro",
	"xiaomi/mimo-v2.6-pro-ultraspeed",
	"z-ai/glm-5.3-flashx",
	"zai-org/GLM-5.2-Fast"
]);
/**
* Whether the CLI snapshot lists a ZDR-capable upstream for `modelId`. This is
* informational, never a reason to omit the header when ZDR is enabled: the
* provider may add coverage or lack capacity after this snapshot was taken.
*/
function supportsZeroDataRetention(modelId) {
	return !KNOWN_NON_ZDR_MODELS.has(modelId);
}
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
const KNOWN_THINKING_MODELS = /* @__PURE__ */ new Set([
	"Qwen/Qwen3.6-Max-Preview",
	"Qwen/Qwen3.6-Plus",
	"Qwen/Qwen3.7-Flash",
	"Qwen/Qwen3.7-Max",
	"Qwen/Qwen3.7-Plus",
	"moonshotai/Kimi-K2.7-Code",
	"moonshotai/Kimi-K2.7-Code-Highspeed",
	"stepfun/Step-3.5-Flash",
	"stepfun/Step-3.7-Flash",
	"tencent/hy3-paid",
	"nvidia/nemotron-3-ultra-550b-a55b",
	"thinkingmachines/inkling",
	"thinkingmachines/inkling-small",
	"poolside/laguna-s-2.1-free",
	"meituan/LongCat-2.0",
	"inclusionai/ling-3.0-flash-sante:free"
]);
/**
* Catalog models the Provider API serves ONLY through `/provider/v1/messages`
* (Anthropic Messages shape). Every other model in the catalog answers on
* `/provider/v1/chat/completions`.
*
* Measured 2026-09-16 (command-code@1.54.0, 69 models posted to
* `/provider/v1/chat/completions`): exactly the then-entire Claude family
* refused with HTTP 400 `Model "<id>" must be called via
* /provider/v1/messages (Anthropic Messages shape)`, and every one of them is
* routed normally by `/alpha/generate`.
*
* Re-measured 2026-09-29 against the 84-model catalog: the same ten
* `claude-*` ids are the only ones carrying `supported_endpoints:
* ["/messages"]`, and posting a non-Claude model to the endpoint answers 400
* `Model "<id>" is not supported on this endpoint. Use
* /provider/v1/chat/completions for OpenAI and OSS models.` The adapter routes
* on that field when the catalog supplies it, so this set is the FALLBACK for
* a cached or hand-built catalog, not the primary source — see
* `requiresMessagesEndpoint()`.
*
* Note what this list is NOT: it is not a plan gate. `claude-sonnet-5` is
* Pro-tier and `claude-opus-4-8` Provider-tier, so the accounts entitled to
* these models are exactly the non-Go ones, which `resolveProtocol()` sends to
* the Provider API by default — picking any Claude model there failed every
* request before this snapshot existed.
*
* `requiresMessagesEndpoint()` additionally treats any `claude-*` id as
* Messages-only, so a Claude model added upstream is still routed correctly
* by an un-updated plugin instead of hard-failing with the 400 above. The
* worst case of that rule going stale the other way (upstream teaching
* `/provider/v1/chat/completions` to serve Claude) is one model riding a
* transport it already works on.
*
* Keep in sync when models ship (see the dsh-commandcode-upstream skill).
*/
const MESSAGES_ONLY_MODELS = /* @__PURE__ */ new Set([
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-haiku-4-5-20251001"
]);
/** True when the Provider API will only serve `modelId` via `/provider/v1/messages`. */
function requiresMessagesEndpoint(modelId) {
	return MESSAGES_ONLY_MODELS.has(modelId) || modelId.startsWith("claude-");
}
/**
* Per-model output ceilings, which `/provider/v1/models` does NOT publish (it
* carries `context_length` and `supported_endpoints` only) while every endpoint
* refuses a larger `max_tokens` per model. Sending the context window as the
* output budget is what produced issue #71: `claude-sonnet-5-5` has a
* 1 000 000-token window and a 128 000-token ceiling, the adapter derived
* 131072, and the endpoint refused every request of a fresh process.
*
* **Generated — do not hand-edit.** `scripts/sync-output-limits.mjs` rewrites
* this literal from models.dev; run it after a catalog sync, and use its
* `--check` in CI. Command Code resells these models through their VENDOR's own
* API, so the vendor's published ceiling is the value recorded: 76 of the 86
* catalog ids as of 2026-09-30. Each row carries a comment naming the entry it
* came from.
*
* Two of those 76 rest on more than a vendor lookup. `gpt-6.1-sol` (128000) comes
* from OpenAI's own row and is corroborated by every other provider carrying it.
* `inclusionai/ling-3.1-flash:free` (32768) is hand-recorded in the script's
* `MANUAL_CEILINGS`: models.dev has no `ling-3.1` entry yet, so it takes the Ling
* family's uniform ceiling. Both are still correctable — a stricter gateway costs
* one refused request, and `streamRequest()` remembers what the endpoint said.
*
* The 10 unlisted models are ones no vendor publishes and the aggregators
* disagree about. They are NOT a gap: a refusal states the ceiling in full, and
* `streamRequest()` reads it off, retries once and remembers it for the model
* (issue #71). A vendor figure the gateway turns out to be stricter than costs
* one round trip; a conservative guess costs half of every answer, forever —
* which is why the unlisted path defers to the endpoint rather than to a
* fallback here.
*
* An unlisted Messages-route model still falls back to
* {@link DEFAULT_MESSAGES_MAX_TOKENS} before any request is made, so a ceiling
* is never absent when the body is built.
*/
const MODEL_OUTPUT_TOKEN_LIMITS = /* @__PURE__ */ new Map([
	["claude-fable-5", 128e3],
	["claude-fable-5-1", 128e3],
	["claude-haiku-4-5-20251001", 64e3],
	["claude-opus-4-7", 128e3],
	["claude-opus-4-8", 128e3],
	["claude-opus-5", 128e3],
	["claude-opus-5-5", 128e3],
	["claude-sonnet-4-6", 128e3],
	["claude-sonnet-5", 128e3],
	["claude-sonnet-5-5", 128e3],
	["deepseek/deepseek-v4-flash", 393216],
	["deepseek/deepseek-v4-flash-vision-exp", 393216],
	["deepseek/deepseek-v4-pro", 393216],
	["google/gemini-3.1-flash-lite", 65536],
	["google/gemini-3.5-flash", 65536],
	["google/gemini-3.5-flash-lite", 65536],
	["google/gemini-3.6-flash", 65536],
	["google/gemini-3.7-flash", 65536],
	["google/gemini-3.8-flash", 65536],
	["gpt-5.3-codex", 128e3],
	["gpt-5.4", 128e3],
	["gpt-5.4-mini", 128e3],
	["gpt-5.5", 128e3],
	["gpt-5.6-luna", 128e3],
	["gpt-5.6-sol", 128e3],
	["gpt-5.6-terra", 128e3],
	["gpt-6-astra", 128e3],
	["gpt-6-luna", 128e3],
	["gpt-6-sol", 128e3],
	["gpt-6.1-sol", 128e3],
	["inclusionai/ling-3.0-flash-sante:free", 32768],
	["inclusionai/ling-3.1-flash:free", 32768],
	["meituan/LongCat-2.0", 131072],
	["meta/muse-spark-1.1", 131072],
	["meta/muse-spark-1.2", 131072],
	["meta/muse-spark-1.2-contributor", 131072],
	["meta/muse-spark-1.3", 131072],
	["meta/muse-spark-1.3-contributor", 131072],
	["MiniMaxAI/MiniMax-M2.5", 131072],
	["MiniMaxAI/MiniMax-M2.7", 131072],
	["MiniMaxAI/MiniMax-M3", 512e3],
	["moonshotai/Kimi-K2.6", 262144],
	["moonshotai/Kimi-K2.7-Code", 262144],
	["moonshotai/Kimi-K2.7-Code-Highspeed", 262144],
	["moonshotai/Kimi-K3", 1048576],
	["nvidia/nemotron-3-ultra-550b-a55b", 65536],
	["poolside/laguna-s-2.1-free", 32768],
	["Qwen/Qwen3.6-Max-Preview", 65536],
	["Qwen/Qwen3.6-Plus", 65536],
	["Qwen/Qwen3.7-Flash", 131072],
	["Qwen/Qwen3.7-Max", 131072],
	["Qwen/Qwen3.7-Plus", 131072],
	["Qwen/Qwen3.8-Flash", 131072],
	["Qwen/Qwen3.8-Max", 131072],
	["Qwen/Qwen3.8-Omni-Flash", 131072],
	["sakana/fugu-ultra", 1e6],
	["stealth/pixel-canary", 131072],
	["stealth/space-bunny-alpha", 524288],
	["stepfun/Step-3.5-Flash", 256e3],
	["stepfun/Step-3.7-Flash", 256e3],
	["stepfun/Step-5-Preview", 65536],
	["thinkingmachines/inkling", 65536],
	["xai/grok-4.5", 5e5],
	["xai/grok-4.6", 5e5],
	["xai/grok-4.7", 5e5],
	["xiaomi/mimo-v2.5", 131072],
	["xiaomi/mimo-v2.5-pro", 131072],
	["xiaomi/mimo-v2.6-flash", 131072],
	["xiaomi/mimo-v2.6-pro", 131072],
	["xiaomi/mimo-v2.6-pro-ultraspeed", 131072],
	["z-ai/glm-5.3-flash", 131072],
	["z-ai/glm-5.3-flashx", 131072],
	["zai-org/GLM-5", 131072],
	["zai-org/GLM-5.1", 131072],
	["zai-org/GLM-5.2", 131072],
	["zai-org/GLM-5.3", 131072]
]);
/**
* The minimum subscription plan a model is included in, per the official plan
* pages (`/docs/plans/go`, `/docs/plans/goat`, `/docs/plans/pro`,
* `/docs/plans/max` and `/docs/resources/pricing-limits`). Each plan's model
* list is a superset of the one below it: Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max.
* Models absent from every plan list (Claude Opus/Fable, Fugu Ultra) are
* Provider-tier. Re-verified at command-code@1.74.3 (2026-10-06): 84 catalog
* ids at 52/61/75/83 cumulative, a strict superset chain — the only removals
* since 1.49.0 are the two retired stealth previews (Pixel Canary at 1.73.1,
* Space Bunny Alpha at 1.74.3), no tier ever moved, and per-entry tags below
* name the release that added each row.
*
* The Provider API exposes no plan metadata, so this snapshot is the source of
* truth for the picker's plan annotation — it answers "which plan do I need to
* actually use this model?" at a glance. Plan labels use the official tier
* names (`Go`, `GOAT`, `Pro`, `Provider`), with `Max` implying Provider.
*
* Keep in sync with the official plan pages when they change (see the
* dsh-commandcode-upstream skill).
*/
const KNOWN_PLANS = {
	"MiniMaxAI/MiniMax-M2.5": "go",
	"MiniMaxAI/MiniMax-M2.7": "go",
	"MiniMaxAI/MiniMax-M3": "go",
	"Qwen/Qwen3.6-Max-Preview": "go",
	"Qwen/Qwen3.6-Plus": "go",
	"Qwen/Qwen3.7-Flash": "go",
	"Qwen/Qwen3.7-Max": "go",
	"Qwen/Qwen3.7-Plus": "go",
	"Qwen/Qwen3.8-27B": "go",
	"Qwen/Qwen3.8-Flash": "go",
	"Qwen/Qwen3.8-Max": "go",
	"Qwen/Qwen3.8-Max-0902": "go",
	"Qwen/Qwen3.8-Omni-Flash": "go",
	"deepseek/deepseek-v4-flash-fast": "go",
	"deepseek/deepseek-v4.1-flash": "go",
	"deepseek/deepseek-v4.1-flash-fast": "go",
	"deepseek/deepseek-v4-flash": "go",
	"deepseek/deepseek-v4-flash-vision-exp": "go",
	"deepseek/deepseek-v4-pro": "go",
	"gpt-5.6-luna": "go",
	"gpt-6-luna": "go",
	"meituan/LongCat-2.0": "go",
	"inclusionai/ling-3.0-flash-sante:free": "go",
	"inclusionai/ling-3.1-flash:free": "go",
	"meta/muse-spark-1.2-contributor": "go",
	"meta/muse-spark-1.3-contributor": "go",
	"moonshotai/Kimi-K2.5": "go",
	"moonshotai/Kimi-K2.6": "go",
	"moonshotai/Kimi-K2.7-Code": "go",
	"moonshotai/Kimi-K2.7-Code-Highspeed": "go",
	"moonshotai/Kimi-K3": "go",
	"nvidia/nemotron-3-ultra-550b-a55b": "go",
	"poolside/laguna-s-2.1-free": "go",
	"stepfun/Step-3.5-Flash": "go",
	"stepfun/Step-3.7-Flash": "go",
	"stepfun/Step-5-Preview": "go",
	"tencent/hy3-paid": "go",
	"tencent/hy4-preview": "go",
	"thinkingmachines/inkling": "go",
	"thinkingmachines/inkling-small": "go",
	"xai/grok-4.5": "go",
	"xiaomi/mimo-v2.5": "go",
	"xiaomi/mimo-v2.5-pro": "go",
	"xiaomi/mimo-v2.6-flash": "go",
	"xiaomi/mimo-v2.6-pro": "go",
	"z-ai/glm-5.3-flash": "go",
	"z-ai/glm-5.3-flashx": "go",
	"zai-org/GLM-5": "go",
	"zai-org/GLM-5.1": "go",
	"zai-org/GLM-5.2": "go",
	"zai-org/GLM-5.2-Fast": "go",
	"zai-org/GLM-5.3": "go",
	"claude-sonnet-5-5": "goat",
	"google/gemini-3.7-flash": "goat",
	"google/gemini-3.8-flash": "goat",
	"gpt-5.6-sol": "goat",
	"meta/muse-spark-1.2": "goat",
	"meta/muse-spark-1.3": "goat",
	"xai/grok-4.6": "goat",
	"xai/grok-4.7": "goat",
	"xiaomi/mimo-v2.6-pro-ultraspeed": "goat",
	"claude-haiku-4-5-20251001": "pro",
	"claude-sonnet-4-6": "pro",
	"claude-sonnet-5": "pro",
	"google/gemini-3.1-flash-lite": "pro",
	"google/gemini-3.5-flash": "pro",
	"google/gemini-3.5-flash-lite": "pro",
	"google/gemini-3.6-flash": "pro",
	"gpt-5.3-codex": "pro",
	"gpt-5.4": "pro",
	"gpt-5.4-mini": "pro",
	"gpt-5.5": "pro",
	"gpt-5.6-terra": "pro",
	"gpt-6-sol": "pro",
	"meta/muse-spark-1.1": "pro",
	"claude-fable-5-1": "provider",
	"claude-fable-5": "provider",
	"claude-opus-4-7": "provider",
	"claude-opus-4-8": "provider",
	"claude-opus-5-5": "provider",
	"claude-opus-5": "provider",
	"gpt-6-astra": "provider",
	"sakana/fugu-ultra": "provider",
	"gpt-6.1-sol": "max"
};
/**
* Whether a model is free (requests cost no credits), per the pricing page's
* deals (`KNOWN_DEALS` `free: true`). Free models lead the picker regardless
* of tier — they are usable by every account, so they are the best default
* candidates.
*/
function isFreeModel(modelId) {
	return KNOWN_DEALS[modelId]?.free === true;
}
/**
* Comparator for the model picker: free models first (zero credit cost, usable
* by every account), then by plan tier (lowest first), then by model name,
* then by id as a tiebreak. Models with no known plan sort last.
*/
function compareByPlan(a, b) {
	const freeDelta = Number(isFreeModel(b.id)) - Number(isFreeModel(a.id));
	if (freeDelta !== 0) return freeDelta;
	const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
	const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
	if (pa !== pb) return pa - pb;
	const nameDiff = a.name.localeCompare(b.name);
	if (nameDiff !== 0) return nameDiff;
	return a.id.localeCompare(b.id);
}
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
const KNOWN_SUBSCRIPTION_PLANS = {
	"individual-go": {
		name: "Go",
		monthlyCredits: 10,
		tierWeight: 0
	},
	"individual-go-v1": {
		name: "Go",
		monthlyCredits: 10,
		tierWeight: 0
	},
	"individual-goat": {
		name: "GOAT",
		monthlyCredits: 70,
		tierWeight: 1
	},
	"individual-pro": {
		name: "Pro",
		monthlyCredits: 30,
		tierWeight: 2
	},
	"individual-pro-v1": {
		name: "Pro",
		monthlyCredits: 80,
		tierWeight: 2
	},
	"individual-provider": {
		name: "Provider",
		monthlyCredits: 15,
		tierWeight: 3
	},
	"individual-max": {
		name: "Max",
		monthlyCredits: 150,
		tierWeight: 4
	},
	"individual-ultra": {
		name: "Ultra",
		monthlyCredits: 300,
		tierWeight: 4
	},
	"teams-pro": {
		name: "Teams Pro",
		monthlyCredits: 40,
		tierWeight: 2
	}
};
/** Plan-id prefixes, longest first — the CLI's prefix-match order. */
const SUBSCRIPTION_PLAN_PREFIXES = Object.keys(KNOWN_SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length);
/**
* Resolve a subscription `planId` (e.g. `individual-pro-v1`) to its display
* name and monthly credit total, mirroring the CLI's `getPlanInfo`:
* normalize (lowercase, `_` → `-`), then longest-prefix match so
* `individual-pro-v1` wins over `individual-pro`. Unknown ids return
* `undefined`.
*/
function subscriptionPlanInfo(planId) {
	const normalized = planId.toLowerCase().replace(/_/g, "-");
	const prefix = SUBSCRIPTION_PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate));
	return prefix === void 0 ? void 0 : KNOWN_SUBSCRIPTION_PLANS[prefix];
}
/**
* Whether the picker lists `modelId` for an account with the given billing
* access. Fails open at every uncertainty: no billing data, an unknown plan,
* a non-finite weight (corrupt billing fact), or a model outside
* {@link KNOWN_PLANS} all keep the model visible — the server remains the
* final gate (`403 MODEL_NOT_IN_PLAN`).
*/
function modelVisibleInPlan(modelId, access) {
	if (access === void 0) return true;
	if (access.onDemandCredits > 0) return true;
	if (access.tierWeight === void 0 || !Number.isFinite(access.tierWeight)) return true;
	const tier = KNOWN_PLANS[modelId];
	if (tier === void 0) return true;
	const weight = PLAN_ORDER[tier];
	if (weight === void 0) return true;
	return weight <= access.tierWeight;
}
/**
* Whether the picker lists `modelId` for a whole POOL of accounts: true when
* at least one of them includes it. The picker's plan filter is asked this
* rather than {@link modelVisibleInPlan} for a single account because the pool
* — not any one account — is what serves a request: keying the list on
* whichever account rotation happened to reach made models appear and vanish
* as accounts rotated, and hid models the user's other accounts could run.
*
* An account whose facts are unknown counts as "may include it" (the same
* fail-open rule `modelVisibleInPlan` applies one level down), and an empty
* pool is "show everything": hiding a model somebody can run is the one
* failure this filter must never cause.
*/
function modelVisibleForAnyAccount(modelId, accounts) {
	if (accounts === void 0 || accounts.length === 0) return true;
	return accounts.some((access) => modelVisibleInPlan(modelId, access));
}
const KNOWN_DEALS = {
	"MiniMaxAI/MiniMax-M3": { label: "50% off" },
	"xiaomi/mimo-v2.5-pro": { label: "99% off" },
	"xiaomi/mimo-v2.5": { label: "98% off" },
	"poolside/laguna-s-2.1-free": {
		label: "FREE",
		free: true
	},
	"inclusionai/ling-3.0-flash-sante:free": {
		label: "FREE",
		free: true
	},
	"inclusionai/ling-3.1-flash:free": {
		label: "FREE",
		free: true
	}
};
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
const KNOWN_PEAK_PRICING = /* @__PURE__ */ new Set([
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4.1-flash",
	"deepseek/deepseek-v4.1-flash-fast"
]);
/**
* Peak hours (UTC, hour-of-day range end-exclusive): 01–03 and 06–09.
* Weekday-only — see `peakPricingState()`; weekends are fully off-peak.
*
* Exported because the vendored price table (`./model-prices.ts`) ships these
* windows to the browser with the table itself: the composer prices a session
* against the very schedule this snapshot knows rather than restating it, so
* there is one place to update when the windows move.
*/
const PEAK_HOUR_RANGES = [[1, 4], [6, 10]];
/**
* Whether `now` (defaults to `Date.now()`) falls inside a peak-pricing window,
* ignoring which model is asking. Peak rates apply Monday–Friday (UTC) only,
* so a weekend timestamp is off-peak even inside {@link PEAK_HOUR_RANGES}.
*
* Model-independent on purpose: `peakPricingState()` adds the membership test
* on top for the picker's label, while the price table selects peak rates from
* a row's own `peak` block — so a model whose catalog id spelling differs from
* the one in {@link KNOWN_PEAK_PRICING} still gets the right half of the day.
*/
function isPeakPricingHour(now = Date.now()) {
	return peakHour(now, PEAK_HOUR_RANGES);
}
/**
* As {@link isPeakPricingHour}, plus the {@link KNOWN_PEAK_PRICING} membership
* test; `undefined` for models outside the snapshot.
*/
function peakPricingState(modelId, now = Date.now()) {
	if (!KNOWN_PEAK_PRICING.has(modelId)) return void 0;
	return isPeakPricingHour(now) ? "peak" : "off-peak";
}
/**
* Compact label for the current peak/off-peak state: `Peak` (full price) or
* `Half` (off-peak, half price). These English nouns match the picker's other
* markers (`Go`, `Image`, `FREE`), and since they appear only on time-of-day
* priced models they double as a "priced by the hour" signal. Returns undefined
* for models without time-of-day pricing.
*/
function peakPricingLabel(modelId, now = Date.now()) {
	const state = peakPricingState(modelId, now);
	if (state === void 0) return void 0;
	return state === "peak" ? "Peak" : "Half";
}
/**
* Official display label for a model's minimum plan, or undefined for models
* outside the snapshot (e.g. future catalog additions).
*/
function planLabel(modelId) {
	const plan = KNOWN_PLANS[modelId];
	return plan === void 0 ? void 0 : PLAN_LABELS[plan];
}
/**
* The active deal label for a model, or undefined when the model has no deal
* or the deal has expired. Expiry is judged against `now` (defaults to
* `Date.now()`), so a snapshot that has gone stale stops showing its discount
* the moment the official end date passes — the user never believes a lapsed
* deal is still live. Permanent deals (no `expiresAt`) never lapse.
*/
function dealLabel(modelId, now = Date.now()) {
	const deal = KNOWN_DEALS[modelId];
	if (deal === void 0) return void 0;
	if (deal.expiresAt !== void 0 && now >= Date.parse(deal.expiresAt)) return void 0;
	return deal.label;
}
/**
* Compact human-readable context window, e.g. `1_000_000 -> "1M"`,
* `256_000 -> "256K"`, `262_144 -> "262K"` (floor to the nearest K).
* Returns undefined for unknown/absent sizes; values under 1K render raw.
*/
function formatContext(contextWindow) {
	if (contextWindow === void 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
	if (contextWindow >= 1e6) {
		const m = contextWindow / 1e6;
		const rounded = Math.round(m * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
	}
	if (contextWindow < 1e3) return String(Math.floor(contextWindow));
	return `${Math.floor(contextWindow / 1e3)}K`;
}
/**
* Compact one-line summary for the model picker: plan tier, then any active
* deal (discount or FREE), then the current peak/off-peak state (`Peak`/`Half`)
* for time-of-day-priced models, then `Image` for Vision-capable models, then
* the context window. Text-only models simply omit the Image marker — "Text
* only" adds nothing the picker needs to show.
*/
function capabilityDescription(modelId, contextWindow, now = Date.now()) {
	const parts = [];
	const plan = planLabel(modelId);
	if (plan !== void 0) parts.push(plan);
	const deal = dealLabel(modelId, now);
	if (deal !== void 0) parts.push(deal);
	const peak = peakPricingLabel(modelId, now);
	if (peak !== void 0) parts.push(peak);
	if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push("Image");
	const ctx = formatContext(contextWindow);
	if (ctx !== void 0) parts.push(ctx);
	return parts.join(" · ");
}
//#endregion
//#region src/model-prices.ts
/**
* The plan tiers a per-model allowance exists for, cheapest first. Ordering
* matters: {@link allowanceTierForWeight} matches a tier weight against these
* rather than against hard-coded numbers, so this table and the subscription
* table cannot drift apart silently.
*/
const ALLOWANCE_TIERS = [
	"go",
	"goat",
	"pro"
];
/**
* Which allowance bracket a plan-tier weight belongs to, or undefined when that
* plan has no per-model allowance.
*
* Weights come from `KNOWN_SUBSCRIPTION_PLANS` (go 0 · goat 1 · pro 2 ·
* provider 3 · max/ultra 4) and {@link PLAN_ORDER} is the same scale, which is
* what makes the lookup exact: Provider、Max、Ultra
* 没有本地额度；缺项时不能用相邻套餐的数字代替。
*/
function allowanceTierForWeight(tierWeight) {
	if (tierWeight === void 0) return void 0;
	return ALLOWANCE_TIERS.find((tier) => PLAN_ORDER[tier] === tierWeight);
}
/**
* Every price row the page publishes, ordered by its own slug.
*
* Note on the GPT rows: `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini` and
* `gpt-5.5` carry a LITERAL `cacheWriteCost: 0` — a different fact from a
* missing key, because `ratesOf()` keeps it and the readout then charges
* cache writes at zero instead of reporting them unpriced. That is what the
* page's JSON says; its rendered column shows `—` for exactly these four while
* rendering a genuine zero as `$0.00` elsewhere, so the page contradicts
* itself. The table stays faithful to the machine-readable source and the
* discrepancy is recorded in AGENTS.md rather than papered over here.
*/
const MODEL_PRICE_ROWS = [
	{
		id: "claude-fable-5",
		rates: [
			10,
			50,
			1,
			12.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-fable-5-1",
		rates: [
			10,
			50,
			.25,
			12.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-haiku-4-5",
		rates: [
			1,
			5,
			.1,
			1.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-opus-4-6",
		rates: [
			5,
			25,
			.5,
			6.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-opus-4-7",
		rates: [
			5,
			25,
			.5,
			6.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-opus-4-8",
		rates: [
			5,
			25,
			.5,
			6.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-opus-5",
		rates: [
			5,
			25,
			.5,
			6.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-opus-5-5",
		rates: [
			4,
			20,
			.2,
			5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-sonnet-4-6",
		rates: [
			3,
			15,
			.3,
			3.75
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-sonnet-5",
		rates: [
			2,
			10,
			.2,
			2.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "claude-sonnet-5-5",
		rates: [
			2,
			10,
			.2,
			2.5
		],
		allowance: {
			go: 6,
			goat: 10,
			pro: 20
		}
	},
	{
		id: "deepseek-v4-flash",
		rates: [
			.15,
			.6,
			.003
		],
		peak: [
			.3,
			1.2,
			.006
		],
		allowance: {
			go: 6,
			goat: 60,
			pro: 70
		}
	},
	{
		id: "deepseek-v4-flash-fast",
		rates: [
			.28,
			.56,
			.07
		],
		allowance: {
			go: 8,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		rates: [
			.15,
			.6,
			.003
		],
		peak: [
			.3,
			1.2,
			.006
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "deepseek-v4-pro",
		rates: [
			.66,
			1.98,
			.022
		],
		peak: [
			1.32,
			3.96,
			.044
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "deepseek-v4.1-flash",
		rates: [
			.15,
			.6,
			.003
		],
		peak: [
			.3,
			1.2,
			.006
		],
		allowance: {
			go: 10,
			goat: 60,
			pro: 70
		}
	},
	{
		id: "deepseek-v4.1-flash-fast",
		rates: [
			.16,
			.58,
			.016
		],
		peak: [
			.32,
			1.16,
			.032
		],
		allowance: {
			go: 6,
			goat: 60,
			pro: 70
		}
	},
	{
		id: "fugu-ultra",
		rates: [
			5,
			30,
			.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gemini-3.1-flash-lite",
		rates: [
			.25,
			1.5,
			.03
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gemini-3.5-flash",
		rates: [
			1.5,
			9,
			.15
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gemini-3.5-flash-lite",
		rates: [
			.3,
			2.5,
			.03
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gemini-3.6-flash",
		rates: [
			1.5,
			7.5,
			.15
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gemini-3.7-flash",
		rates: [
			1.5,
			7.5,
			.15,
			.08334
		],
		allowance: {
			go: 6,
			goat: 40,
			pro: 50
		}
	},
	{
		id: "gemini-3.8-flash",
		rates: [
			1.5,
			7.5,
			.15
		],
		allowance: {
			go: 6,
			goat: 40,
			pro: 50
		}
	},
	{
		id: "glm-5",
		rates: [
			1,
			3.2,
			.2
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "glm-5.1",
		rates: [
			1.4,
			4.4,
			.26
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "glm-5.2",
		rates: [
			1.4,
			4.4,
			.26
		],
		allowance: {
			go: 10,
			goat: 70,
			pro: 80
		}
	},
	{
		id: "glm-5.2-fast",
		rates: [
			3,
			10.25,
			.5
		],
		allowance: {
			go: 9,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "glm-5.3",
		rates: [
			1.4,
			4.4,
			.26
		],
		allowance: {
			go: 10,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "glm-5.3-flash",
		rates: [
			.15,
			.5,
			.03
		],
		allowance: {
			go: 10,
			goat: 40,
			pro: 50
		}
	},
	{
		id: "glm-5.3-flashx",
		rates: [
			.37,
			1.25,
			.075
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "gpt-5.3-codex",
		rates: [
			2,
			8,
			.5,
			0
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gpt-5.4",
		rates: [
			2.5,
			15,
			.25,
			0
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gpt-5.4-mini",
		rates: [
			.75,
			4.5,
			.075,
			0
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gpt-5.5",
		rates: [
			5,
			30,
			.5,
			0
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "gpt-5.6-luna",
		rates: [
			.2,
			1.2,
			.02,
			.25
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				.2,
				1.2,
				.02,
				.25
			]
		}, { "rates": [
			.4,
			1.8,
			.04,
			.5
		] }]
	},
	{
		id: "gpt-5.6-sol",
		rates: [
			5,
			30,
			.5,
			6.25
		],
		allowance: {
			go: 6,
			goat: 70,
			pro: 80
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				5,
				30,
				.5,
				6.25
			]
		}, { "rates": [
			10,
			45,
			1,
			12.5
		] }]
	},
	{
		id: "gpt-5.6-terra",
		rates: [
			2,
			12,
			.2,
			2.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				2,
				12,
				.2,
				2.5
			]
		}, { "rates": [
			4,
			18,
			.4,
			5
		] }]
	},
	{
		id: "gpt-6-astra",
		rates: [
			10,
			50,
			1,
			12.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				10,
				50,
				1,
				12.5
			]
		}, { "rates": [
			20,
			75,
			2,
			25
		] }]
	},
	{
		id: "gpt-6-luna",
		rates: [
			.1,
			.5,
			.01,
			.125
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				.1,
				.5,
				.01,
				.125
			]
		}, { "rates": [
			.2,
			.75,
			.02,
			.25
		] }]
	},
	{
		id: "gpt-6-sol",
		rates: [
			2,
			10,
			.2,
			2.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				2,
				10,
				.2,
				2.5
			]
		}, { "rates": [
			4,
			15,
			.4,
			5
		] }]
	},
	{
		id: "gpt-6.1-sol",
		rates: [
			2,
			10,
			.1,
			2.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		},
		contextTiers: [{
			"maxContext": 272e3,
			"rates": [
				2,
				10,
				.1,
				2.5
			]
		}, { "rates": [
			4,
			15,
			.2,
			5
		] }]
	},
	{
		id: "grok-4.5",
		rates: [
			2,
			6,
			.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "grok-4.6",
		rates: [
			2,
			6,
			.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		},
		contextTiers: [{
			"maxContext": 2e5,
			"rates": [
				2,
				6,
				.5
			]
		}, { "rates": [
			4,
			12,
			1
		] }]
	},
	{
		id: "grok-4.7",
		rates: [
			2,
			6,
			.5
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		},
		contextTiers: [{
			"maxContext": 2e5,
			"rates": [
				2,
				6,
				.5
			]
		}, { "rates": [
			4,
			12,
			1
		] }]
	},
	{
		id: "inkling",
		rates: [
			1,
			4.05,
			.17
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "inkling-small",
		rates: [
			.5,
			1.2,
			.1
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "kimi-k2.5",
		rates: [
			.6,
			3,
			.1
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "kimi-k2.6",
		rates: [
			.95,
			4,
			.16
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "kimi-k2.7-code",
		rates: [
			.95,
			4,
			.19
		],
		allowance: {
			go: 9,
			goat: 60,
			pro: 70
		}
	},
	{
		id: "kimi-k2.7-code-highspeed",
		rates: [
			1.9,
			8,
			.38
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "kimi-k3",
		rates: [
			3,
			15,
			.3
		],
		allowance: {
			go: 8,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "longcat-2.0",
		rates: [
			.3,
			1.2,
			.006
		],
		allowance: {
			go: 10,
			goat: 50,
			pro: 60
		}
	},
	{
		id: "mimo-v2.5",
		rates: [
			.14,
			.28,
			.0028
		],
		listRates: [
			.8,
			4,
			.16
		],
		allowance: {
			go: 6,
			goat: 30,
			pro: 40
		}
	},
	{
		id: "mimo-v2.5-pro",
		rates: [
			.435,
			.87,
			.0036
		],
		listRates: [
			2,
			6,
			.4
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "mimo-v2.6-flash",
		rates: [
			.14,
			.28,
			.0028
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "mimo-v2.6-pro",
		rates: [
			.435,
			.87,
			.0036
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "mimo-v2.6-pro-ultraspeed",
		rates: [
			4.35,
			8.7,
			.036
		],
		allowance: {
			go: 6,
			goat: 10,
			pro: 20
		}
	},
	{
		id: "minimax-m2.5",
		rates: [
			.3,
			1.2,
			.03
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "minimax-m2.7",
		rates: [
			.3,
			1.2,
			.06
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "minimax-m3",
		rates: [
			.3,
			1.2,
			.06
		],
		listRates: [
			.6,
			2.4,
			.12
		],
		allowance: {
			go: 8,
			goat: 47,
			pro: 57
		}
	},
	{
		id: "muse-spark-1.1",
		rates: [
			1.25,
			4.25,
			.15
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 20
		}
	},
	{
		id: "muse-spark-1.2",
		rates: [
			1.25,
			4.25,
			.15
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "muse-spark-1.2-contributor",
		rates: [
			.1,
			.2,
			.002
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "muse-spark-1.3",
		rates: [
			1.25,
			4.25,
			.15
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "muse-spark-1.3-contributor",
		rates: [
			.1,
			.2,
			.002
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "nemotron-3-ultra",
		rates: [
			.6,
			2.4,
			.12
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "qwen-3.6-max",
		rates: [
			1.3,
			7.8,
			.26,
			1.63
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "qwen-3.6-plus",
		rates: [
			.5,
			3,
			.1
		],
		allowance: {
			go: 10,
			goat: 33,
			pro: 43
		},
		contextTiers: [{
			"maxContext": 256e3,
			"rates": [
				.5,
				3,
				.1
			]
		}, { "rates": [
			2,
			6,
			.2
		] }]
	},
	{
		id: "qwen-3.7-flash",
		rates: [
			.03,
			.13,
			.006,
			.038
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		},
		contextTiers: [
			{
				"maxContext": 32e3,
				"rates": [
					.03,
					.13,
					.006,
					.038
				]
			},
			{
				"maxContext": 256e3,
				"rates": [
					.1,
					.4,
					.02,
					.125
				]
			},
			{ "rates": [
				.2,
				.8,
				.04,
				.25
			] }
		]
	},
	{
		id: "qwen-3.7-max",
		rates: [
			2.5,
			7.5,
			.5,
			3.13
		],
		allowance: {
			go: 10,
			goat: 33,
			pro: 43
		}
	},
	{
		id: "qwen-3.7-plus",
		rates: [
			.4,
			1.6,
			.08,
			.5
		],
		allowance: {
			go: 10,
			goat: 33,
			pro: 43
		},
		contextTiers: [{
			"maxContext": 256e3,
			"rates": [
				.4,
				1.6,
				.08,
				.5
			]
		}, { "rates": [
			1.2,
			4.8,
			.24,
			1.5
		] }]
	},
	{
		id: "qwen-3.8-27b",
		rates: [
			.4,
			3,
			.04
		],
		allowance: {
			go: 10,
			goat: 70,
			pro: 80
		}
	},
	{
		id: "qwen-3.8-flash",
		rates: [
			.16,
			.47,
			.016
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "qwen-3.8-max",
		rates: [
			2,
			6,
			.25,
			2.5
		],
		allowance: {
			go: 7,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "qwen-3.8-max-0902",
		rates: [
			2,
			6,
			.25
		],
		allowance: {
			go: 7,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "qwen-3.8-omni-flash",
		rates: [
			.15,
			.47,
			.016
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "step-3.5-flash",
		rates: [
			.09,
			.3,
			.02
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "step-3.7-flash",
		rates: [
			.2,
			1.15,
			.04
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "step-5-preview",
		rates: [
			1,
			2.7,
			.05
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "tencent/hy3-paid",
		rates: [
			.14,
			.58,
			.035
		],
		allowance: {
			go: 10,
			goat: 70,
			pro: 80
		}
	},
	{
		id: "tencent/hy4-preview",
		rates: [
			.834,
			2.501,
			.042
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	},
	{
		id: "typesafe/jev",
		rates: [
			.042,
			0,
			0
		],
		allowance: {
			go: 6,
			goat: 20,
			pro: 30
		}
	}
];
/**
* Catalog ids no candidate rule can reach, because the page names the model
* differently from the catalog. `tests/model-prices.test.ts` fails whenever a
* catalog model has no price, so a new miss lands here as a visible decision
* rather than a silently unpriced model.
*/
const PRICE_SLUG_OVERRIDES = { "nvidia/nemotron-3-ultra-550b-a55b": "nemotron-3-ultra" };
/**
* Plausible price slugs for one catalog model id, most specific first.
*
* The page normalizes to lowercase and usually drops the vendor segment, but
* not consistently: `tencent/hy4-preview` keeps its prefix while
* `Qwen/Qwen3.8-Max-0902` becomes `qwen-3.8-max-0902`, with a hyphen the
* catalog id does not have. Generating candidates and taking the first that
* exists in the vendored table absorbs that drift without a hand-maintained map
* of eighty ids.
*/
function priceSlugCandidates(modelId) {
	const lower = modelId.toLowerCase();
	const bare = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
	const out = /* @__PURE__ */ new Set();
	const add = (slug) => {
		const hyphenated = slug.replace(/^([a-z]+)(\d)/, "$1-$2");
		out.add(slug);
		out.add(hyphenated);
		out.add(slug.replace(/-\d{8}$/, ""));
		out.add(slug.replace(/-(preview|latest)$/, ""));
		out.add(hyphenated.replace(/-\d{8}$/, ""));
		out.add(hyphenated.replace(/-(preview|latest)$/, ""));
	};
	add(lower);
	add(bare);
	return [...out];
}
/** The pricing-page slug for one catalog model id, or undefined when unpriced. */
function priceSlugFor(modelId, known) {
	const override = PRICE_SLUG_OVERRIDES[modelId];
	if (override !== void 0) return known.has(override) ? override : void 0;
	return priceSlugCandidates(modelId).find((slug) => known.has(slug));
}
/** Split a stored triplet/quadruplet into the wire rate shape. */
function ratesOf(values) {
	const rates = {
		inputCost: values[0],
		outputCost: values[1],
		cacheReadCost: values[2]
	};
	if (values[3] !== void 0) rates.cacheWriteCost = values[3];
	return rates;
}
/**
* Build the full price row the browser prices a session with.
*
* Every figure switches together: once the deal stops being live, the base
* rates AND each context band come from the pre-discount set, so a session
* priced after a promotion ends can never mix the two.
*/
function wireRow(id, slug, row, now) {
	const promotional = dealLabel(id, now) !== void 0;
	const price = {
		id,
		slug,
		...ratesOf(promotional ? row.rates : row.listRates ?? row.rates)
	};
	if (row.peak !== void 0) price.peak = ratesOf(row.peak);
	if (row.contextTiers !== void 0) price.contextTiers = row.contextTiers.map((tier) => ({
		...ratesOf(promotional ? tier.rates : tier.listRates ?? tier.rates),
		...tier.maxContext === void 0 ? {} : { maxContext: tier.maxContext }
	}));
	return price;
}
/**
* Build the table the composer prices a session with.
*
* Rows are keyed by CATALOG id wherever the two namespaces reconcile, because
* that is what a session reports, and every row also carries its page slug as a
* second lookup key. Price rows no catalog model claims are served under the
* slug alone, so drift in either direction still prices. Free models are served
* explicitly at zero so the composer can say so instead of showing nothing; the
* peak windows travel with the table so the browser applies the very schedule
* this snapshot knows instead of restating it.
*
* `now` (defaults to `Date.now()`) resolves lapsed promotions: a discounted row
* whose `expiresAt` has passed is served at its pre-discount `listRates`, the
* same instant {@link dealLabel} stops showing its badge. The table is rebuilt
* per request, so that switch needs no redeploy.
*/
function modelPriceTable(now = Date.now()) {
	const bySlug = new Map(MODEL_PRICE_ROWS.map((row) => [row.id, row]));
	const known = new Set(bySlug.keys());
	const models = [];
	const claimed = /* @__PURE__ */ new Set();
	for (const catalogId of Object.keys(KNOWN_PLANS)) {
		if (isFreeModel(catalogId) || catalogId.endsWith(":free")) {
			models.push({
				id: catalogId,
				slug: catalogId,
				inputCost: 0,
				outputCost: 0,
				cacheReadCost: 0,
				free: true
			});
			continue;
		}
		const slug = priceSlugFor(catalogId, known);
		if (slug === void 0) continue;
		const row = bySlug.get(slug);
		if (row === void 0) continue;
		claimed.add(slug);
		models.push(wireRow(catalogId, slug, row, now));
	}
	for (const row of MODEL_PRICE_ROWS) {
		if (claimed.has(row.id)) continue;
		models.push(wireRow(row.id, row.id, row, now));
	}
	return {
		models,
		peakHours: PEAK_HOUR_RANGES.map(([start, end]) => [start, end])
	};
}
/** Slug-keyed view of the rows, built once: neither table nor allowance mutates. */
const ROWS_BY_SLUG = new Map(MODEL_PRICE_ROWS.map((row) => [row.id, row]));
const KNOWN_SLUGS = new Set(ROWS_BY_SLUG.keys());
/**
* The per-model monthly allowance for a CATALOG model id, or undefined when the
* page carries none (a model without a price row, or the free stealth previews
* the estimator array omits).
*
* Resolution rides the same slug rules as the price table, so
* `MiniMaxAI/MiniMax-M3` finds the row the page files under `minimax-m3` — the
* settings page must not grow a second mapping that can drift from this one.
* The settings page asks for a model only while rendering a list it already
* has, so this stays a pure lookup with no clock: an allowance is not
* time-dependent (a plan's figure does not lapse the way a promotional rate
* does; when the page re-prices it, the next sync carries it).
*/
function modelAllowanceFor(modelId) {
	const slug = priceSlugFor(modelId, KNOWN_SLUGS);
	if (slug === void 0) return void 0;
	return ROWS_BY_SLUG.get(slug)?.allowance;
}
//#endregion
//#region src/wire-guards.ts
/** Non-throwing value guards for untrusted provider payloads. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function booleanValue(value) {
	return typeof value === "boolean" ? value : void 0;
}
/** 工具参数可为对象或完整 JSON 字符串；不把未完成的字符串片段当作完整参数。 */
function recordOrEmpty(value) {
	if (isRecord(value)) return value;
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		if (isRecord(parsed)) return parsed;
	} catch {}
	return {};
}
//#endregion
//#region src/cost-projection.ts
const record$2 = (v) => isRecord(v) ? v : void 0;
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function tokensOf(value) {
	const u = record$2(value);
	if (!u || !finite(u.inputTokens) || !finite(u.outputTokens)) return void 0;
	if (u.cacheReadTokens !== void 0 && !finite(u.cacheReadTokens) || u.cacheWriteTokens !== void 0 && !finite(u.cacheWriteTokens)) return void 0;
	return {
		uncachedInputTokens: u.inputTokens,
		outputTokens: u.outputTokens,
		cacheReadTokens: u.cacheReadTokens ?? 0,
		cacheWriteTokens: u.cacheWriteTokens ?? 0
	};
}
/** Current v2 settlements store the last usage in their stream; v1 stores chunk events. */
function usageOf(type, data) {
	if (type === "assistant/chunk") {
		const chunk = record$2(data.chunk);
		return chunk?.type === "usage" ? tokensOf(chunk.usage) : void 0;
	}
	if (type !== "assistant/message" && type !== "assistant/attempt") return void 0;
	const direct = tokensOf(data.usage);
	if (direct !== void 0) return direct;
	if (!Array.isArray(data.stream)) return void 0;
	for (let i = data.stream.length - 1; i >= 0; i--) {
		const item = record$2(data.stream[i]);
		const chunk = item?.type === "chunk" ? record$2(item.chunk) : void 0;
		if (chunk?.type === "usage") return tokensOf(chunk.usage);
	}
}
function parseState(value) {
	const s = record$2(value), facts = record$2(s?.facts);
	if (!s || !facts || !finite(facts.pricingKey) || !Array.isArray(facts.groups)) throw new TypeError("invalid commandCodeCost state");
	const group = (v) => {
		const g = record$2(v), t = record$2(g?.tokens);
		return !!g && typeof g.provider === "string" && typeof g.model === "string" && (g.at === null || finite(g.at)) && finite(g.contextTokens) && !!t && COST_TOKEN_KEYS.every((k) => finite(t[k]));
	};
	const sel = record$2(s.selection), last = record$2(s.last);
	if (!(s.selection === null || sel && typeof sel.provider === "string" && typeof sel.model === "string") || !(s.at === null || finite(s.at)) || !facts.groups.every(group) || !(s.last === null || last && finite(last.turn) && finite(last.step) && group(last.group))) throw new TypeError("invalid commandCodeCost state");
	return value;
}
/** Optional registry uses only synchronous parse/view; no new runtime module is required. */
function createCostProjection(table = modelPriceTable()) {
	const version = pricingKey(table);
	return {
		key: "commandCodeCost",
		stateVersion: version,
		stateSchema: { parse: parseState },
		init: () => ({
			selection: null,
			at: null,
			last: null,
			facts: {
				pricingKey: version,
				groups: []
			}
		}),
		apply(state, event) {
			const data = record$2(event.data);
			if (!data) return state;
			if (event.type === "request/header") {
				const config = record$2(record$2(data.header)?.config);
				return {
					...state,
					selection: config && typeof config.provider === "string" && typeof config.model === "string" ? {
						provider: config.provider,
						model: config.model
					} : null
				};
			}
			if (event.type === "step/start" || event.type === "llm/retry-started") return {
				...state,
				at: finite(event.time) ? event.time : null,
				last: null
			};
			const tokens = usageOf(event.type, data);
			if (tokens === void 0 || !finite(data.turn) || !finite(data.step)) return state;
			const previous = state.last?.turn === data.turn && state.last.step === data.step ? state.last.group : void 0;
			const group = {
				provider: state.selection?.provider ?? "",
				model: state.selection?.model ?? "",
				at: state.at,
				contextTokens: tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens,
				tokens
			};
			if (previous && JSON.stringify(previous) === JSON.stringify(group)) return state;
			const groups = state.facts.groups.map((g) => ({
				...g,
				tokens: { ...g.tokens }
			}));
			const byKey = /* @__PURE__ */ new Map();
			groups.forEach((g, i) => {
				const key = costGroupKey(g, table);
				if (!byKey.has(key)) byKey.set(key, i);
			});
			const groupKey = costGroupKey(group, table);
			if (previous) {
				const old = byKey.get(costGroupKey(previous, table));
				if (old !== void 0) for (const k of COST_TOKEN_KEYS) groups[old].tokens[k] -= previous.tokens[k];
			}
			const targetIdx = byKey.get(groupKey);
			let target = targetIdx === void 0 ? void 0 : groups[targetIdx];
			if (!target) {
				target = {
					...group,
					tokens: zeroCostTokens()
				};
				groups.push(target);
			}
			for (const k of COST_TOKEN_KEYS) target.tokens[k] += tokens[k];
			return {
				...state,
				last: {
					turn: data.turn,
					step: data.step,
					group
				},
				facts: {
					pricingKey: version,
					groups: groups.filter((g) => COST_TOKEN_KEYS.some((k) => g.tokens[k] > 0))
				}
			};
		},
		wire: {
			view: (state) => state.facts,
			viewSchema: { parse(value) {
				return parseState({
					selection: null,
					at: null,
					last: null,
					facts: value
				}).facts;
			} }
		}
	};
}
function installCostProjection(ctx) {
	ctx.inject(["sessionProjections"], (c) => {
		const registry = c.get("sessionProjections");
		if (typeof registry?.register === "function") c.effect(() => registry.register(createCostProjection()), "commandcode cost projection");
	});
}
//#endregion
//#region src/response-encoding.ts
/**
* Ask Command Code for plain response bodies. A DSH host using an incompatible
* undici global dispatcher can lose response headers and leave compressed
* JSON, SSE, and pre-stream error bodies undecoded.
*/
const IDENTITY_ENCODING_HEADER = { "accept-encoding": "identity" };
//#endregion
//#region src/timeout-limits.ts
const MAX_TIMEOUT_SECONDS = 3600;
//#endregion
//#region src/model-visibility.ts
/** 网页、终端与模型目录共用的选择规则；显式开关优先于白名单。 */
function modelIsVisible(id, allowlist, overrides) {
	const flag = overrides !== null && typeof overrides === "object" && !Array.isArray(overrides) ? overrides[id] : void 0;
	return typeof flag === "boolean" ? flag : allowlist.length === 0 || allowlist.includes(id);
}
const THROTTLED_CODE = "THROTTLED";
const boundedCodes = /* @__PURE__ */ new Set([
	"EMPTY_RESPONSE",
	"SERVER",
	"TIMEOUT",
	THROTTLED_CODE
]);
const counts$1 = /* @__PURE__ */ new WeakMap();
function absorbTransientFailure(agent, code) {
	if (!boundedCodes.has(code)) return "ignored";
	const used = counts$1.get(agent) ?? 0;
	if (used >= 3) return "exhausted";
	counts$1.set(agent, used + 1);
	return "retry";
}
function resetTransientFailures(agent) {
	counts$1.delete(agent);
}
function transientBudgetMessage(code, message) {
	return `Command Code 请求在 3 次自动重试后仍失败，已停止重试（${code}）。请稍后重新发送；若反复出现，请检查服务状态或请求耗时诊断。 原因：${message}`;
}
//#endregion
//#region src/accounts.ts
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
/**
* Upper bound on the retry wait attached to the all-exhausted `RATE_LIMIT`.
* Must equal the adapter's `backoff.maxDelayMs`: dsh-llm-retry honors a
* provider wait verbatim only at or below that cap — a longer one abandons the
* retry instead of falling back to local backoff, turning "poll until the
* window opens" into "fail now".
*/
const RETRY_MAX_DELAY_MS = 9e5;
/**
* How long an explicitly selected account's rate-limit mark may stand before
* its window is probed again. Without this, a single 429 on the user's pinned
* account demotes it until the process restarts (issue #51); probing at most
* once per interval per key bounds a probe endpoint that keeps failing.
*/
const EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS = 6e4;
/** A labeled, human-readable clock reading for error messages. */
function clockLabel(ms) {
	return new Date(ms).toLocaleString();
}
/**
* Whether an account with this rotation state can serve a request right now.
* `undefined` (never rejected) is usable; a cooldown becomes usable again
* once its reset time passes; `unknown` (429, reset unprobed) and
* `disabled` (401) are not.
*/
function accountUsable(state) {
	if (state === void 0) return true;
	if (state.kind === "cooldown") return state.until > 0 && Date.now() >= state.until;
	return false;
}
/**
* Pick the account that should serve now: the manually preferred slot when it is
* usable, otherwise the first usable account in rotation order; undefined when
* no account is usable. Shared by the pool (request path) and the plugin entry
* (the usage view's active badge) so both always agree.
*/
function selectActiveAccount(accounts, preferredId) {
	const usable = accounts.filter((account) => accountUsable(account.state));
	if (preferredId !== void 0) {
		const preferred = usable.find((account) => account.slot.id === preferredId);
		if (preferred !== void 0) return preferred;
	}
	return usable[0];
}
/**
* The first routing rule whose model list contains the request's model id.
* Undefined when no rule matches.
*/
function matchModelRule(model, rules) {
	if (model === "" || rules === void 0 || rules.length === 0) return void 0;
	for (const rule of rules) if (rule.models.includes(model)) return rule;
}
/**
* The routed account for a request's model: the first usable account whose
* slot id matches the first matching rule's target. Undefined when no rule
* matches or the routed account is not usable (the caller then falls back to
* the normal preferred/rotation selection).
*/
function selectAccountForModel(accounts, model, rules) {
	const rule = matchModelRule(model, rules);
	if (rule === void 0) return void 0;
	return accounts.find((account) => account.slot.id === rule.account && accountUsable(account.state));
}
/** 仅复制账号定义；凭据服务的秘密仍在每次解析时读取。 */
function captureAccountSelection(selection) {
	return Object.freeze({
		slots: Object.freeze(selection.slots.map((slot) => Object.freeze({ ...slot }))),
		preferredId: selection.preferredId,
		modelAccountRules: Object.freeze(selection.modelAccountRules.map((rule) => {
			const models = [...rule.models];
			Object.freeze(models);
			return Object.freeze({
				...rule,
				models
			});
		}))
	});
}
/** 账号选择与展示共用恢复规则；宿主作用域内的状态按网关与密钥共享。 */
var CommandCodeAccountPool = class CommandCodeAccountPool {
	deps;
	/** 当前作用域内按密钥共享的健康状态；不记录到日志。 */
	states = /* @__PURE__ */ new Map();
	/** 当前网关与密钥的显式探测时间，限制失败探测的频率。 */
	explicitProbes = /* @__PURE__ */ new Map();
	scopedStates = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 每个调用持有自己的定义和探测，只有同网关的健康事实共享；不临时改写全局依赖。 */
	scope(context) {
		const selection = captureAccountSelection(context);
		let shared = this.scopedStates.get(context.apiBase);
		if (shared === void 0) {
			shared = {
				states: /* @__PURE__ */ new Map(),
				probes: /* @__PURE__ */ new Map()
			};
			this.scopedStates.set(context.apiBase, shared);
		}
		const scoped = new CommandCodeAccountPool({
			...this.deps,
			slots: () => selection.slots,
			preferredId: () => selection.preferredId,
			modelAccountRules: () => selection.modelAccountRules,
			probeWindow: context.probeWindow
		});
		scoped.states = shared.states;
		scoped.explicitProbes = shared.probes;
		scoped.scopedStates = this.scopedStates;
		return scoped;
	}
	/**
	* Resolve every slot's key, deduplicated by key (first slot wins). Slots
	* without any resolvable key are omitted — they still appear in the
	* settings page as unconfigured, they just cannot serve requests.
	*/
	async resolvedAccounts() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const slot of this.deps.slots()) {
			const key = await this.resolveSlotKey(slot);
			if (key === void 0 || seen.has(key)) continue;
			seen.add(key);
			out.push({
				slot,
				key,
				state: this.states.get(key)
			});
		}
		return out;
	}
	/**
	* Every slot paired with its resolved key and rotation state — NOT
	* deduplicated: two slots sharing one credential both appear (the usage
	* view reports them individually), while slots without any resolvable key
	* are omitted. The serving path uses {@link resolvedAccounts} instead.
	*/
	async describeAccounts() {
		const out = [];
		for (const slot of this.deps.slots()) {
			const key = await this.resolveSlotKey(slot);
			if (key === void 0) continue;
			out.push({
				slot,
				key,
				state: this.states.get(key)
			});
		}
		return out;
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
	async resolveKey(options) {
		const accounts = await this.resolvedAccounts();
		if (accounts.length === 0) return;
		const tried = options?.tried;
		const available = tried === void 0 || tried.length === 0 ? accounts : accounts.filter((account) => !tried.includes(account.key));
		const preferred = this.deps.preferredId?.();
		if (available.length === 0) {
			if (selectActiveAccount(accounts, preferred) !== void 0) return void 0;
			throw allAccountsUnusable(accounts);
		}
		const routed = selectAccountForModel(available, options?.model ?? "", this.deps.modelAccountRules?.());
		if (routed !== void 0) return this.pick(routed);
		const chosen = selectActiveAccount(available, preferred);
		if (chosen !== void 0) {
			const revived = await this.reviveExplicit(available, options?.model ?? "", preferred, chosen);
			return this.pick(revived ?? chosen);
		}
		await this.probeAllMarked(available);
		const latestAccounts = await this.resolvedAccounts();
		const revived = selectActiveAccount(tried === void 0 || tried.length === 0 ? latestAccounts : latestAccounts.filter((account) => !tried.includes(account.key)), preferred);
		if (revived !== void 0) return this.pick(revived);
		if (selectActiveAccount(latestAccounts, preferred) !== void 0) return void 0;
		throw allAccountsUnusable(latestAccounts.length > 0 ? latestAccounts : accounts);
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
	async activeAccount() {
		const accounts = await this.resolvedAccounts();
		if (accounts.length === 0) return void 0;
		const preferred = this.deps.preferredId?.();
		const chosen = selectActiveAccount(accounts, preferred);
		if (chosen !== void 0) return await this.reviveExplicit(accounts, "", preferred, chosen) ?? chosen;
		await this.probeAllMarked(accounts);
		return selectActiveAccount(await this.resolvedAccounts(), preferred);
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
	markRejected(apiKey, rejection, resetAtMs) {
		if (rejection === "invalid-credential") this.states.set(apiKey, {
			kind: "disabled",
			cause: "auth",
			reason: "invalid API key (401)",
			until: 0
		});
		else if (rejection === "throttled") this.states.set(apiKey, {
			kind: "unknown",
			cause: "throttle",
			reason: "rate limited (429)",
			until: 0
		});
		else if (resetAtMs !== void 0 && resetAtMs > Date.now()) this.states.set(apiKey, {
			kind: "cooldown",
			cause: "window",
			reason: "usage window exhausted (429)",
			until: resetAtMs
		});
		else this.states.set(apiKey, {
			kind: "unknown",
			cause: "window",
			reason: "usage window exhausted (429)",
			until: 0
		});
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
	async resolveSlotKey(slot) {
		if (slot.literal !== void 0) {
			const literal = normalizeResolvedKey(slot.literal);
			if (literal !== void 0) return literal;
		}
		if (slot.ref !== void 0) {
			const hit = await this.deps.resolveRef(slot.ref);
			if (hit !== void 0) {
				const resolved = normalizeResolvedKey(hit);
				if (resolved !== void 0) return resolved;
			}
		}
		if (slot.allowAuthFile) {
			const fromFile = this.deps.authFileKey();
			if (fromFile !== void 0) {
				const fileKey = normalizeResolvedKey(fromFile);
				if (fileKey !== void 0) return fileKey;
			}
		}
	}
	/**
	* The account the user explicitly asked for: the slot a model rule routes the
	* request to when that id exists among the resolved slots, else the manually
	* pinned slot. Consulted only on the fallback path, so — unlike
	* {@link selectAccountForModel} — it does NOT require the account to be usable,
	* which is exactly what {@link resolveKey} re-probes.
	*/
	explicitAccount(accounts, model, preferredId) {
		const rule = matchModelRule(model, this.deps.modelAccountRules?.());
		const id = rule !== void 0 && accounts.some((account) => account.slot.id === rule.account) ? rule.account : preferredId;
		return id === void 0 ? void 0 : accounts.find((account) => account.slot.id === id);
	}
	/**
	* Whether an explicitly selected account's mark is due for a window probe.
	* Only an `unknown` mark (a 429 whose reset was never learned) is worth
	* re-probing: a `cooldown` carries its reset and expires by itself, and a
	* `disabled` (401) key stays out until the stored credential changes. The
	* interval bounds a probe endpoint that keeps failing.
	*/
	canProbeExplicit(account) {
		if (account.state?.kind !== "unknown") return false;
		const last = this.explicitProbes.get(account.key);
		return last === void 0 || this.now() - last >= EXPLICIT_ACCOUNT_PROBE_INTERVAL_MS;
	}
	/** The clock the probe throttle reads; injected so a test can travel in time. */
	now() {
		return this.deps.now?.() ?? Date.now();
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
	async probeExplicit(account) {
		this.explicitProbes.set(account.key, this.now());
		let probe;
		try {
			probe = await this.deps.probeWindow(account.key);
		} catch {
			return;
		}
		if (probe === void 0) return void 0;
		if (!probe.exceeded) {
			this.states.delete(account.key);
			return {
				slot: account.slot,
				key: account.key,
				state: void 0
			};
		}
		this.stampWindowMark(account, probe);
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
	stampWindowMark(account, probe) {
		if (probe.resetAt > 0) this.states.set(account.key, {
			kind: "cooldown",
			cause: "window",
			reason: account.state?.reason ?? "usage window exhausted (429)",
			until: probe.resetAt
		});
		else if (account.state?.kind !== "cooldown") this.states.set(account.key, {
			kind: "unknown",
			cause: "window",
			reason: account.state?.reason ?? "usage window exhausted (429)",
			until: 0
		});
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
	async reviveExplicit(accounts, model, preferred, chosen) {
		const explicit = this.explicitAccount(accounts, model, preferred);
		if (explicit === void 0 || explicit.key === chosen.key || !this.canProbeExplicit(explicit)) return;
		return this.probeExplicit(explicit);
	}
	/**
	* Probe every marked account's real usage window when nothing currently
	* resolves. Disabled (401) keys are not probed — an invalid key stays
	* invalid. A throwing probe counts as "unknown" (like a failed one): it
	* must not turn the all-exhausted path into a raw rejection instead of
	* RATE_LIMIT. Shared by {@link resolveKey} and {@link activeAccount}.
	*/
	async probeAllMarked(accounts) {
		await Promise.all(accounts.map(async (account) => {
			if (account.state?.kind === "disabled") return;
			let probe;
			try {
				probe = await this.deps.probeWindow(account.key);
			} catch {
				return;
			}
			if (probe === void 0) return;
			if (!probe.exceeded) {
				this.states.delete(account.key);
				return;
			}
			this.stampWindowMark(account, probe);
		}));
	}
	/** Hand out the chosen account's key. */
	pick(account) {
		return {
			key: account.key,
			slot: account.slot
		};
	}
};
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
function allAccountsUnusable(accounts) {
	if (accounts.filter((account) => account.state?.kind === "disabled").length === accounts.length) return new LlmError(`llm-commandcode: every configured Command Code account (${accounts.length}) was rejected with 401 — check the stored API keys (Models page / settings) or the auth file；已配置的 ${accounts.length} 个 Command Code 账户密钥均被拒绝（401）——请在设置页检查存储的 API 密钥，或重新运行 command-code login`, "INVALID_CREDENTIAL");
	const windowMarked = accounts.map((account) => account.state).filter((state) => state !== void 0).filter((state) => state.cause === "window");
	if (windowMarked.length === 0) return new LlmError(`llm-commandcode: all ${accounts.length} Command Code account(s) are rate limited (429) — the provider did not report an exhausted usage window; retrying；全部 ${accounts.length} 个 Command Code 账户被限流（429）——服务商未报告用量窗口用尽，正在重试`, THROTTLED_CODE);
	const resets = windowMarked.filter((state) => state.kind === "cooldown" && state.until > 0).map((state) => state.until);
	const earliest = resets.length > 0 ? Math.min(...resets) : 0;
	const wait = earliest > 0 ? Math.max(1e3, earliest - Date.now()) : 0;
	return new LlmError(`llm-commandcode: all ${accounts.length} Command Code account(s) have exhausted their usage window` + (earliest > 0 ? `; the earliest window resets at ${clockLabel(earliest)}` : " — the provider published no reset time for it") + ` — requests will succeed again after the reset (or add another account)；已用尽全部 ${accounts.length} 个 Command Code 账户的用量窗口` + (earliest > 0 ? `，最早的重置时间为 ${clockLabel(earliest)}` : "，服务商未公布重置时间") + "——窗口重置后请求会自动恢复（也可以添加更多账户）", "RATE_LIMIT", wait > 0 && wait <= 9e5 ? { providerRetryAfterMs: wait } : void 0);
}
/**
* Normalize one resolved credential to the form every consumer sees. Trim
* only: a blank-after-trim value means "no key" (the slot is omitted and the
* caller reports `MISSING_CREDENTIAL`), while characters an HTTP header cannot
* carry are left for `assertUsableApiKey()` to reject with its own message.
*/
function normalizeResolvedKey(value) {
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
//#endregion
//#region src/provider-errors.ts
/** 连接拒绝与流内错误共享同一分类，避免错误恢复因响应载体不同而漂移。 */
/** Keep the two user-facing languages and error metadata together. */
function bilingual(code, en, zh, options) {
	return new LlmError(`${en}；${zh}`, code, options);
}
/**
* Terminal stream-error markers from the official CLI (`Xw` in command-code's
* cli.mjs): these always mean "retrying cannot succeed", so the adapter must
* not classify them as transient server errors.
*
* Written with spaces rather than the CLI's underscores, because
* {@link hasTerminalStreamMarker} normalizes the separator before matching:
* a JSON body usually carries `premium credits exhausted` while the CLI's own
* list is written `premium_credits_exhausted`, and both are the same refusal
* (the pre-stream classifier normalizes identically).
*/
const TERMINAL_STREAM_ERROR_MARKERS = [
	"premium credits exhausted",
	"model not in plan",
	"insufficient credits"
];
function hasTerminalStreamMarker(message) {
	const normalized = message.toLowerCase().replaceAll("_", " ");
	return TERMINAL_STREAM_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}
/**
* Context-window wording the provider uses to reject a request that outgrew
* the model's window. `isContextWindowExceededError` is the harness's own
* provider-neutral classifier — and the contract `CONTEXT_WINDOW_EXCEEDED`
* exists for — so it decides; the official CLI's `truncated` pattern adds the
* phrasings Command Code's upstreams emit that the harness helper does not
* cover (a bare `prompt is too long`, or a complaint about `max_tokens`).
* The CLI matches these first and answers them by compacting and retrying —
* never by resending the request unchanged.
*/
const CLI_CONTEXT_OVERFLOW_PATTERN = /prompt is too long|context.*(length|window)|max_tokens|maximum.*tokens/i;
function isContextOverflowDetail(detail) {
	return isContextWindowExceededError(detail) || CLI_CONTEXT_OVERFLOW_PATTERN.test(detail);
}
/**
* A request-side `max_tokens` refusal, told apart from a context overflow that
* mentions the same field. Kept narrow on purpose: the overflow pattern also
* matches a bare `max_tokens`, so this must name the specific shapes the
* endpoint uses — a ceiling comparison, its prose about output tokens, or a
* request-validation error on the field.
*/
const OUTPUT_LIMIT_REJECTION = new RegExp([
	"max_tokens:\\s*\\d+\\s*>\\s*\\d+",
	"maximum allowed number of output tokens",
	"invalid input[^\\n]*max_tokens",
	"expected number[^\\n]*at max_tokens"
].join("|"), "i");
/**
* The output ceiling the endpoint states in a `max_tokens` refusal, read off
* its own comparison: `max_tokens: 131072 > 128000` yields 128000.
*
* Only the comparison form is parsed. The other shapes
* {@link OUTPUT_LIMIT_REJECTION} matches — a bare validation error, or the
* prose without the numbers — name no ceiling, and guessing one would be worse
* than failing: a fabricated value is indistinguishable from a real one at the
* point where it decides the next request's budget.
*/
function parseOutputCeiling(detail) {
	const stated = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(detail)?.[1];
	if (stated === void 0) return void 0;
	const ceiling = Number(stated);
	return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : void 0;
}
/**
* Whether one rejection says "ZDR requested, no ZDR-capable upstream": the
* provider spells the code `cmd_zdr_no_providers` in JSON error bodies and
* `CMD_ZDR_NO_PROVIDERS` in plain-text ones (the official CLI's own
* classifier checks both spellings, and its error text tells the user to
* unset `CMD_ZDR`). Underscore-separated matching normalizes the separator, so
* one comparison covers the variants — the same normalization the pre-stream
* rejection classifier and `hasTerminalStreamMarker` already use.
*/
const ZDR_NO_PROVIDERS_PATTERN = /cmd[_\s-]?zdr[_\s-]?no[_\s-]?providers/i;
function isZdrNoProviders(providerCode, providerDetail, errText) {
	return ZDR_NO_PROVIDERS_PATTERN.test(providerCode ?? "") || ZDR_NO_PROVIDERS_PATTERN.test(providerDetail) || ZDR_NO_PROVIDERS_PATTERN.test(errText);
}
/**
* Classify one in-band stream `error` payload into the failure the caller
* throws. Shared by both transports — the CLI transport delivers it as an
* `error` event, the Provider API transport as a top-level `error` member of
* an SSE chunk — so the two cannot drift apart.
*
* The wording decides before the status does, mirroring the official CLI's
* `classifyKind` (which reads the message first). Order is load-bearing:
*
* - A context-window rejection is terminal for THIS request but recoverable by
*   the harness: `dsh-compaction-basic` listens on `agent/request-error` for
*   `CONTEXT_WINDOW_EXCEEDED` and answers it with a compaction + retry of the
*   reduced surface. Reported as retryable `SERVER` instead, the adapter resent
*   the byte-identical oversized request up to `maxRetries` times and the
*   session could never recover (issue #39).
* - Credits/plan wording is terminal, so an exhausted balance or a model
*   outside the plan is not retried as if it were a transient rate limit.
* - Only then does the status/`isRetryable` pair decide.
*/
function streamErrorToLlmError(value, fallbackMessage) {
	const record = isRecord(value) ? value : void 0;
	const message = record ? stringValue(record.message) ?? JSON.stringify(record) : stringValue(value) ?? fallbackMessage ?? "Stream error";
	const statusCode = record === void 0 ? void 0 : numberValue(record.statusCode) ?? numberValue(record.status);
	const isRetryable = record === void 0 ? void 0 : booleanValue(record.isRetryable);
	const detail = [
		stringValue(record?.code),
		stringValue(record?.type),
		message
	].filter((part) => part !== void 0 && part !== "").join(" ");
	const statusOption = statusCode !== void 0 ? { status: statusCode } : void 0;
	if (OUTPUT_LIMIT_REJECTION.test(detail)) {
		const stated = /max_tokens:\s*\d+\s*>\s*\d+/i.exec(detail)?.[0];
		return bilingual("PROVIDER_STREAM_ERROR", `Command Code refused the request's max_tokens for this model` + (stated !== void 0 ? ` (${stated})` : "") + " — the session is not oversized, so compacting it will not help; lower \"Max output tokens\" or pick a model with a larger output ceiling", `Command Code 拒绝了本次请求的 max_tokens（该模型的输出上限更低）` + (stated !== void 0 ? `（${stated}）` : "") + "——会话内容并未超长，压缩上下文无效；请调低「最大输出 token」或改用输出上限更大的模型", statusOption);
	}
	if (isContextOverflowDetail(detail)) return bilingual(CONTEXT_WINDOW_EXCEEDED_CODE, `Command Code stream error: ${message}`, "Command Code API 拒绝了这次请求：内容超出模型上下文窗口。正在压缩上下文后重试；如仍失败，请新建会话或减少上下文", statusOption);
	const terminal = hasTerminalStreamMarker(detail);
	if (!(isRetryable === true || (isRetryable === false || terminal ? false : statusCode !== void 0 ? statusCode !== void 0 && (statusCode === 429 || statusCode >= 500) : true))) return new LlmError(`Command Code stream error: ${message}`, "PROVIDER_STREAM_ERROR", statusOption);
	const rejection = classifyAccountRejection(statusCode ?? 0, JSON.stringify(value) ?? message);
	if (rejection?.reason === "rate-limit" || rejection?.reason === "throttled") {
		const wait = rejection.resetAtMs === void 0 ? 0 : Math.min(RETRY_MAX_DELAY_MS, Math.max(1e3, rejection.resetAtMs - Date.now()));
		return bilingual(rejection.reason === "rate-limit" ? "RATE_LIMIT" : THROTTLED_CODE, `Command Code stream error: ${message}`, rejection.reason === "rate-limit" ? "Command Code 用量窗口已限流，等待恢复" : "Command Code 请求暂时被限流，正在重试", {
			...statusOption,
			...wait > 0 ? { providerRetryAfterMs: wait } : {}
		});
	}
	return new LlmError(`Command Code stream error: ${message}`, "SERVER", statusOption);
}
/**
* Unwrap one level of a double-encoded provider message.
*
* The Messages endpoint sometimes reports a rejection with `error.message`
* holding a whole JSON document rather than the sentence
* (`{"type":"error","error":{"type":"invalid_request_error","message":"{\"type\":
* \"error\",…}"},"request_id":"req_…"}`, measured 2026-09-29). Showing that blob
* to the user hides the actual refusal, so one nesting level is peeled; the
* outer text is returned unchanged when it is not JSON or carries no message.
*/
function unwrapProviderMessage(raw) {
	if (raw === void 0) return void 0;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) return raw;
	try {
		const inner = JSON.parse(trimmed);
		if (!isRecord(inner)) return raw;
		return stringValue(((isRecord(inner.error) ? inner.error : void 0) ?? inner).message) ?? raw;
	} catch {
		return raw;
	}
}
/** Parse a rejected body once, retaining the nested/root distinction. */
function parseProviderError(errText) {
	try {
		const parsed = JSON.parse(errText);
		if (!isRecord(parsed)) return { message: errText };
		const nested = isRecord(parsed.error) ? parsed.error : void 0;
		const body = nested ?? parsed;
		const rawMessage = stringValue(body.message);
		return {
			root: parsed,
			nested,
			code: stringValue(body.code),
			type: stringValue(body.type),
			rawMessage,
			message: unwrapProviderMessage(rawMessage) ?? errText,
			rateLimit: isRecord(body.rateLimit) ? body.rateLimit : void 0
		};
	} catch {
		return { message: errText };
	}
}
/**
* Map a pre-stream generate HTTP failure onto a stable LlmError. Command
* Code folds several business rejections into 403 (plan limits, CLI version,
* model access): prefer the machine-readable `error.code` when present; the
* status alone cannot distinguish them. The status also decides the failure
* CODE via {@link httpErrorCode}, which is what the retry policy routes on —
* a transient 5xx must not be reported as a permanent provider rejection. A
* 429's `Retry-After` header rides along as `providerRetryAfterMs` so
* dsh-llm-retry can wait exactly that long instead of guessing at the backoff
* cadence — capped at RETRY_MAX_DELAY_MS, because in normal mode a longer
* attached wait makes the executor abandon the retry outright.
*
* One body is read, not just its status: a client-side rejection whose
* `error.code`/`type`/`message` names the model context window is reported as
* `CONTEXT_WINDOW_EXCEEDED`, because that failure has a recovery the harness
* performs and a generic provider error does not. Every message built here is
* bilingual — the harness renders it verbatim in its retry chrome.
*/
function generateHttpError(status, errText, retryAfterMs, parsed = parseProviderError(errText)) {
	const providerCode = parsed.nested === void 0 ? void 0 : parsed.code;
	const providerDetail = parsed.nested === void 0 ? "" : [
		parsed.code,
		parsed.type,
		parsed.rawMessage ?? parsed.message
	].filter((part) => part !== void 0 && part !== "").join(" ");
	const detail = providerCode ?? `HTTP ${status}`;
	const overflowDetail = providerDetail !== "" ? providerDetail : errText.slice(0, 500);
	if (status < 500 && OUTPUT_LIMIT_REJECTION.test(overflowDetail)) {
		const stated = /max_tokens:\s*\d+\s*>\s*\d+/.exec(overflowDetail)?.[0] ?? (parsed.message !== void 0 && parsed.message.length <= 200 ? parsed.message : void 0);
		return bilingual("PROVIDER_HTTP_ERROR", `Command Code API error ${status}: this request's max_tokens is not valid for this model` + (stated ? ` (${stated})` : "") + " — the session is not oversized, so compacting it will not help; lower \"Max output tokens\" or pick a model with a larger output ceiling", `Command Code API 返回 ${status}：本次请求的 max_tokens 对该模型不合法` + (stated ? `（${stated}）` : "") + "——会话内容并未超长，压缩上下文无效；请调低「最大输出 token」或改用输出上限更大的模型", { status });
	}
	if (status < 500 && isContextOverflowDetail(overflowDetail)) return bilingual(CONTEXT_WINDOW_EXCEEDED_CODE, `Command Code API error ${status}: the request exceeds the model's context window — this session is being compacted and the request retried`, `Command Code API 返回 ${status}：请求内容超出模型上下文窗口——正在压缩上下文后重试；如仍失败，请新建会话或减少上下文`, { status });
	if (status === 422 && isZdrNoProviders(providerCode, providerDetail, errText)) return bilingual("PROVIDER_HTTP_ERROR", `Command Code API error 422 (${detail}): zero data retention is enforced but no ZDR-capable upstream is available for this model — turn the ZDR setting off (or use another model)`, "Command Code API 返回 422：已开启零数据保留（ZDR），但该模型当前没有可用的 ZDR 上游——请关闭 ZDR 开关，或改用其他模型", { status: 422 });
	if (status === 401) return bilingual("INVALID_CREDENTIAL", `Command Code API error 401 (${detail}): the API key is missing or invalid — check the key stored for COMMANDCODE_API_KEY (Models page) or the auth file`, "Command Code API 返回 401：API 密钥缺失或无效——请在设置页检查 COMMANDCODE_API_KEY 存储的密钥，或检查 auth 文件", { status: 401 });
	if (status === 413) return bilingual("PROVIDER_HTTP_ERROR", "Command Code API error 413: the request body exceeds the provider's size limit (the cap is undocumented, measured at about 50 MB) — the session history is too large to send, usually because of accumulated image attachments. Start a new session, or drop the image-heavy part of this one, and retry", "Command Code API 返回 413：请求体超过服务端的体积上限（官方未公开，实测约 50 MB）——会话历史过大，通常是历史图片累积所致。请新建会话，或移除本会话中图片较多的部分后重试", { status: 413 });
	const diagnosticCode = parsed.code ?? /^\s*(MODEL_NOT_IN_PLAN|INSUFFICIENT_CREDITS|USAGE_EXCEEDED|PREMIUM_CREDITS_EXHAUSTED)\b/i.exec(parsed.message ?? "")?.[1];
	const diagnostic = diagnosticCode !== void 0 && /^[A-Za-z0-9_.:-]{1,80}$/.test(diagnosticCode) ? `（${diagnosticCode}）` : "";
	return new LlmError(`Command Code 请求失败（HTTP ${status}）${diagnostic}：` + (status === 429 ? "请求受到用量或速率限制，请稍后重试并检查账户额度。" : status === 408 ? "服务端处理超时，请稍后重试。" : status >= 500 ? "上游服务暂时无法完成请求，请稍后重试。" : "服务端拒绝了本次请求，请检查模型、套餐和请求设置。"), httpErrorCode(status), {
		status,
		...retryAfterMs !== void 0 && retryAfterMs > 0 && retryAfterMs <= 9e5 ? { providerRetryAfterMs: retryAfterMs } : {}
	});
}
/**
* Classify a pre-stream HTTP status into the failure code the route's retry
* policy keys on. dsh-llm-retry matches `retryableCodes` only — never the
* status, never the provider's `error.type` — so a status that arrives here as
* a permanent code is never retried, whatever it says about itself.
*
* 5xx is the provider's own "temporarily unavailable" class (Cloudflare's
* 520-527 included) and the only sane answer to it is the byte-identical
* resend the retry policy exists to make; 408 is the same story for the
* request itself. Everything else stays permanent: a 400/403/404/409/422
* rejection repeats identically on every attempt.
*/
function httpErrorCode(status) {
	if (status === 429) return THROTTLED_CODE;
	if (status === 408) return "TIMEOUT";
	if (status >= 500) return "SERVER";
	return "PROVIDER_HTTP_ERROR";
}
/**
* Parse an HTTP `Retry-After` value (delay-seconds or an HTTP-date) into
* milliseconds; undefined when absent or unparseable. An HTTP-date in the
* past yields 0, which the caller drops (LlmError wants a positive delay).
* A delay-seconds value whose millisecond product is not finite (e.g. `1e308`)
* also yields undefined: LlmError validates its options and would otherwise
* replace the provider failure with an internal construction error.
*/
function parseRetryAfterMs(value, now = Date.now()) {
	if (value === void 0 || value === null) return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const ms = seconds * 1e3;
		return Number.isFinite(ms) ? Math.round(ms) : void 0;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
}
/**
* Classify a pre-stream rejection that is about the ACCOUNT rather than about
* the request, using the official CLI's own rules (command-code@1.56.0:
* `parseWindowLimitError`, `isInsufficientCreditsRequestError`,
* `parseSpendCapError` and the terminal-marker list
* `["premium_credits_exhausted", "model_not_in_plan", "insufficient credits"]`).
* Undefined means "not an account-scoped rejection": a malformed request, an
* oversized body or a context overflow must fail fast instead of walking the
* whole account pool.
*
* It must recognize the whole account-scoped class, not just 429/401: when it
* did not, an account that could not pay, or could not run the model, stayed
* "usable" in the pool and was handed out again on the next request (issue
* #51's follow-up). The four reasons are defined on
* {@link AccountRotationReason}; what this function owes them is the evidence
* split:
*
*   - `rate-limit` / `throttled`: the code `RATE_LIMITED` is the authoritative
*     signal — the CLI accepts the code OR a 429 status — and only a body that
*     NAMES a window (`error.rateLimit.window`, see {@link readWindowLimitEvidence})
*     may be called a spent one. A bare 429 is a burst/model/spend limiter the
*     billing endpoint cannot see, so it stays `throttled` and the host claims
*     no window (issue #54).
*   - `unavailable`: no credits, or a model outside this account's plan, so it
*     rotates but must NOT mark the key — the fact is about the model or the
*     balance, and either can change without the key changing.
*/
/**
* The provider's structured "this account cannot serve this request" codes.
*
* Status-independent on purpose, mirroring the CLI's classifier, which reads
* the code before any status guard: a 5xx carrying one of these must rotate
* past the account instead of being retried as a transient provider failure,
* because the same request against the same account cannot succeed. Only the
* prose scan below is confined to 4xx.
*/
const ACCOUNT_UNAVAILABLE_CODES = /* @__PURE__ */ new Set([
	"USAGE_EXCEEDED",
	"INSUFFICIENT_CREDITS",
	"PREMIUM_CREDITS_EXHAUSTED",
	"MODEL_NOT_IN_PLAN"
]);
function classifyAccountRejection(status, errText, parsed = parseProviderError(errText)) {
	const code = (parsed.code ?? parsed.type)?.toUpperCase();
	if (status === 429 || code === "RATE_LIMITED") {
		const evidence = readWindowLimitEvidence(errText, parsed);
		if (evidence.window === void 0) return { reason: "throttled" };
		return evidence.resetAtMs === void 0 ? { reason: "rate-limit" } : {
			reason: "rate-limit",
			resetAtMs: evidence.resetAtMs
		};
	}
	if (status === 401) return { reason: "invalid-credential" };
	if (code !== void 0 && ACCOUNT_UNAVAILABLE_CODES.has(code)) return { reason: "unavailable" };
	if (status < 400 || status >= 500) return void 0;
	const lower = errText.toLowerCase().replaceAll("_", " ");
	if (lower.includes("insufficient credits") || lower.includes("premium credits exhausted") || lower.includes("model not in plan") || /insufficient (credit|balance)/.test(lower) || /out of credit/.test(lower) || /not (available|included)[^.]{0,40}plan/.test(lower) || lower.includes("upgrade your plan")) return { reason: "unavailable" };
}
/**
* The usage-window evidence carried by a rejected request, mirroring the CLI's
* `parseWindowLimitError` → `resolveWindowLabel`/`extractResetAtMs` pair.
*
* `window` is present only when the body actually names one: a
* `error.rateLimit.window` of `fiveHour`/`weekly`/`daily`, or the "usage limit
* for your plan" wording (read as `weekly` when it says so, else `fiveHour`).
* That is the CLI's own bar for calling a rejection a WINDOW limit, and it is
* what keeps a bare 429 — a burst limiter, a model-level limit, a spend cap
* `windowLimits` cannot show — from being reported as an exhausted window
* (issue #54).
*
* `resetAtMs` is the reset the body publishes: `error.rateLimit.reset` is
* SECONDS (`1e3 * reset`, like the CLI), and a `resets at <ISO>` stamp in the
* message is honored as the fallback. Either can be present without the other;
* the window label is what decides the classification.
*/
function readWindowLimitEvidence(errText, parsed) {
	const named = stringValue(parsed.rateLimit?.window);
	const message = parsed.message ?? stringValue(parsed.root?.message) ?? "";
	const seconds = numberValue(parsed.rateLimit?.reset);
	const window = named === "fiveHour" || named === "weekly" || named === "daily" ? named : /usage limit for your plan/i.test(message) || /usage limit for your plan/i.test(errText) ? /weekly/i.test(message) ? "weekly" : "fiveHour" : void 0;
	const stamp = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message)?.[1] ?? /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(errText)?.[1];
	const stamped = stamp === void 0 ? void 0 : Date.parse(stamp);
	const published = seconds !== void 0 && seconds > 0 ? Math.round(seconds * 1e3) : stamped !== void 0 && !Number.isNaN(stamped) ? stamped : void 0;
	const resetAtMs = published !== void 0 && Number.isFinite(published) && published - Date.now() <= 2592e6 ? published : void 0;
	return {
		...window === void 0 ? {} : { window },
		...resetAtMs === void 0 ? {} : { resetAtMs }
	};
}
/**
* True when a pre-stream rejection is Command Code's Go-plan gate
* (`upgrade_required`) — the only plan without Provider API access. Only this
* class of rejection should fall back to the CLI `/alpha/generate` transport;
* other 4xx/5xx must surface as ordinary errors so real account/model
* problems are not masked.
*/
function isUpgradeRequiredError(status, errText, parsed = parseProviderError(errText)) {
	if (status !== 403) return false;
	const lower = errText.toLowerCase();
	if (lower.includes("upgrade_required")) return true;
	if (lower.includes("go plan") && lower.includes("api access")) return true;
	if (lower.includes("only plan without api access")) return true;
	if (lower.includes("upgrade to goat or higher")) return true;
	if ((parsed.code ?? parsed.type)?.toLowerCase() === "upgrade_required") return true;
	if (parsed.message?.toLowerCase().includes("go plan") && parsed.message.toLowerCase().includes("api access")) return true;
	return false;
}
//#endregion
//#region src/stream-trace.ts
/**
* Opt-in raw-stream trace for the Command Code transports.
*
* Why this exists: this route's failure mode of record is a response that ENDS
* EARLY — the gateway, a proxy or the network closes the socket mid-generation,
* so the adapter's read loop sees `done` without the transport's terminal event.
* A provider cut, a proxy timeout and a dropped socket are indistinguishable
* from inside the adapter; only the raw wire separates them — which events
* arrived, when the last one landed, how long the socket then sat silent.
*
* Enable it per process:
*
* ```sh
* DSH_COMMANDCODE_TRACE=/tmp/cc-stream.jsonl dsh web
* DSH_COMMANDCODE_TRACE=1 dsh web     # -> $TMPDIR/dsh-commandcode-stream.jsonl
* ```
*
* Any value that is not a flag is a path, and the explicit off-spellings
* (`0`, `false`, `no`, `off`) are read as "off" rather than as a file name.
*
* Every model request appends one JSONL record per raw chunk plus lifecycle
* records (`request`, `response`, `eof`, `idle-timeout`, `read-error`, `end`,
* `stream-close`), each stamped with `streamId` and `at` — milliseconds since
* the trace opened, before connecting. `stream-open.startedAt` is Unix time in
* milliseconds, so interleaved calls and session logs can be correlated.
*
* PRIVACY: the chunk records carry the provider's own payload verbatim, because
* a truncated answer is exactly what is being diagnosed — treat the file as
* conversation content, not as a log safe to share. The request-side record
* records structural counts and SHA-256 fingerprints only; it never carries the
* raw request body, an API key, or any request header. Keep it that way.
*
* Trade-offs: OFF costs one `process.env` read per request; ON appends
* synchronously, one file open per chunk, because the trace must survive a host
* killed mid-diagnosis. A trace that cannot be written turns itself off rather
* than failing the request it observes — a diagnostic must never become the
* outage.
*
* @module
*/
/** Environment variable that turns the trace on. */
const STREAM_TRACE_ENV = "DSH_COMMANDCODE_TRACE";
/** File used when the variable is set to a bare flag instead of a path. */
const STREAM_TRACE_DEFAULT_FILE = "dsh-commandcode-stream.jsonl";
/** One raw chunk is recorded verbatim up to this many characters. */
const STREAM_TRACE_MAX_TEXT = 16384;
/** Values of {@link STREAM_TRACE_ENV} that mean "trace to the default file". */
const FLAG_VALUES = /* @__PURE__ */ new Set([
	"1",
	"true",
	"yes",
	"on"
]);
/**
* Values that explicitly mean OFF.
*
* A user turning the trace off writes `false` as readily as they write `1` to
* turn it on, and without this set every one of these spellings fell through to
* "…so it must be a path" — the trace switched ON and wrote the conversation to
* a file NAMED `false` in the process's working directory.
*/
const OFF_VALUES = /* @__PURE__ */ new Set([
	"0",
	"false",
	"no",
	"off"
]);
/** The inert trace used whenever the switch is off. */
const OFF = {
	enabled: false,
	record: () => void 0,
	close: () => void 0
};
/**
* Resolve the trace file for this process.
*
* @param raw - the variable's raw value; defaults to the live environment.
* @returns the file to append to, or undefined when the trace is off.
*/
function resolveStreamTracePath(raw = process.env[STREAM_TRACE_ENV]) {
	const value = raw?.trim();
	if (value === void 0 || value === "") return void 0;
	const lower = value.toLowerCase();
	if (OFF_VALUES.has(lower)) return void 0;
	if (FLAG_VALUES.has(lower)) return join(tmpdir(), STREAM_TRACE_DEFAULT_FILE);
	return value;
}
/**
* Clamp one recorded payload so a single chunk cannot consume the whole cap.
*
* @param text - the text to record.
* @param max - characters to keep, defaulting to {@link STREAM_TRACE_MAX_TEXT}.
* @returns `text` unchanged, or its head plus a marker naming what was dropped.
*/
function boundTraceText(text, max = STREAM_TRACE_MAX_TEXT) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}
/**
* Open one request's trace.
*
* @param scope - what the records describe (the `provider/model` route).
* @param options - `path` overrides the environment (tests pass a temp file);
*   `now` overrides the clock the `at` stamps are measured with.
* @returns a writer that never throws and never fails the request.
*/
function openStreamTrace(scope, options = {}) {
	const path = options.path ?? resolveStreamTracePath();
	if (path === void 0) return OFF;
	const now = options.now ?? Date.now;
	const startedAt = now();
	const streamId = randomUUID();
	let written = 0;
	let stopped = false;
	let capped = false;
	const terminals = /* @__PURE__ */ new Set();
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		return OFF;
	}
	const write = (record) => {
		if (stopped) return;
		const terminal = record.event === "end" || record.event === "stream-close";
		if (capped && !terminal) return;
		if (terminal && terminals.has(String(record.event))) return;
		let line;
		try {
			line = `${JSON.stringify({
				at: now() - startedAt,
				scope,
				streamId,
				...record
			})}\n`;
		} catch {
			return;
		}
		if (terminal) {
			if (Buffer.byteLength(line) > 16384) return;
			terminals.add(String(record.event));
		} else if (written + Buffer.byteLength(line) > 4194304) {
			capped = true;
			line = `${JSON.stringify({
				at: now() - startedAt,
				scope,
				streamId,
				event: "trace-capped",
				bytes: written
			})}\n`;
		}
		try {
			appendFileSync(path, line);
			written += Buffer.byteLength(line);
		} catch {
			stopped = true;
		}
	};
	write({
		event: "stream-open",
		startedAt
	});
	return {
		get enabled() {
			return !stopped && !capped;
		},
		record(event, fields) {
			write(fields === void 0 ? { event } : {
				event,
				...fields
			});
		},
		close() {
			write({
				event: "stream-close",
				bytes: written
			});
		}
	};
}
//#endregion
//#region src/stream-response.ts
/** 单次成功连接后的响应过程：拥有读取、协议终止、取消、最终用量和本地释放。
* 调度层只转交响应；三种线上事件的装配差异保留在本模块内部。 */
/** 仅供本次消费生命周期使用，不作为服务商错误或用户取消向外传播。 */
var ConsumerStreamClosed = class extends Error {};
/**
* 异步生成器的 return 会排在正在等待的 next 后面，因此必须先通过独立信号
* 唤醒当前读取，再让生成器执行 finally。消费方已结束时不再交付用量或错误。
*/
function ownedResponseStream(callerSignal, run) {
	const consumer = new AbortController();
	const source = run(callerSignal ? AbortSignal.any([callerSignal, consumer.signal]) : consumer.signal)[Symbol.asyncIterator]();
	let closed = false;
	const done = () => ({
		done: true,
		value: void 0
	});
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			if (closed) return done();
			try {
				const result = await source.next();
				return closed ? done() : result;
			} catch (error) {
				if (closed) return done();
				throw error;
			}
		},
		async return() {
			if (!closed) {
				closed = true;
				consumer.abort(new ConsumerStreamClosed("消费方已结束读取"));
			}
			await source.return?.();
			return done();
		}
	};
}
/** 唯一过程入口；诊断或释放失败不能在成功结束后再制造第二个结束。 */
async function* settleStreamResponse(response, context) {
	try {
		yield* readResponse(response, context);
	} finally {
		try {
			context.cleanup();
		} catch {}
		context.trace.close();
	}
}
async function* readResponse(response, context) {
	const { protocol, signal, maxTokens, apiBase, streamIdleTimeoutMs, responseMetadata, trace, timing } = context;
	if (!response.body) {
		trace.record("end", {
			outcome: "empty",
			code: "PROVIDER_PROTOCOL_ERROR"
		});
		throw failureWithRequestId(new LlmError("Command Code API returned no response body", "PROVIDER_PROTOCOL_ERROR"), responseMetadata);
	}
	const reader = response.body.getReader();
	const cancelReader = () => {
		try {
			reader.cancel().catch(() => void 0);
		} catch {}
	};
	const onAbort = () => cancelReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const streamStartedAt = Date.now();
	let chunkCount = 0;
	let totalBytes = 0;
	let lastChunkAt = streamStartedAt;
	let idleTimer;
	let idleFired = false;
	const armIdle = () => {
		if (idleTimer !== void 0) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleFired = true;
			cancelReader();
		}, streamIdleTimeoutMs);
	};
	const clearIdle = () => {
		if (idleTimer !== void 0) {
			clearTimeout(idleTimer);
			idleTimer = void 0;
		}
	};
	const asm = createBlockAssembler();
	let finish;
	let usage;
	let usageEmitted = false;
	let endRecorded = false;
	let protocolStopped = false;
	function* handle(event) {
		captureResponseIdentifiers(responseMetadata, event);
		if (isRecord(event) && (protocol === "messages" && event.type === "message_stop" || protocol === "cli" && event.type === "finish")) protocolStopped = true;
		const chunks = handleEvent(asm, protocol, event);
		for (const chunk of chunks) if (chunk.type === "finish") finish = chunk;
		else if (chunk.type === "usage") usage = chunk.usage;
		for (const chunk of chunks) {
			if (chunk.type === "finish" || chunk.type === "usage") continue;
			signal?.throwIfAborted();
			yield chunk;
		}
	}
	function* handleLine(line) {
		signal?.throwIfAborted();
		if (protocol === "openai" && line.trim().replace(/^data:\s*/, "") === "[DONE]") {
			protocolStopped = true;
			return;
		}
		yield* handle(parseStreamEventLine(line));
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		for (;;) {
			signal?.throwIfAborted();
			let read;
			armIdle();
			try {
				read = await reader.read();
			} catch (error) {
				signal?.throwIfAborted();
				trace.record("read-error", {
					chunks: chunkCount,
					bytes: totalBytes,
					silentMs: Date.now() - lastChunkAt,
					message: errorChain(error)
				});
				throw bilingual("TRANSPORT", `Command Code API stream from ${apiBase} failed while reading: ${errorChain(error)}`, "Command Code API 流式响应中途断开——网络波动所致，重试通常可恢复", { cause: error });
			} finally {
				clearIdle();
			}
			signal?.throwIfAborted();
			const { done, value } = read;
			if (done) {
				trace.record("eof", {
					chunks: chunkCount,
					bytes: totalBytes,
					silentMs: Date.now() - lastChunkAt,
					totalMs: Date.now() - streamStartedAt,
					finishSeen: finish !== void 0,
					idleFired,
					buffered: buffer.length
				});
				if (idleFired) throw bilingual("TIMEOUT", `Command Code API stream from ${apiBase} was idle for ${streamIdleTimeoutMs}ms (no events) and was treated as a dead connection`, `Command Code API 流式响应已 ${streamIdleTimeoutMs} 毫秒无任何事件，被判定为死连接——长思考模型可在设置中调大流空闲超时`);
				if (buffer.trim()) yield* handleLine(buffer);
				break;
			}
			const text = decoder.decode(value, { stream: true });
			if (value.byteLength > 0) timing.first("firstByteMs");
			buffer += text;
			chunkCount += 1;
			totalBytes += value.byteLength;
			lastChunkAt = Date.now();
			trace.record("chunk", {
				n: chunkCount,
				bytes: value.byteLength,
				text: boundTraceText(text)
			});
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const [index, line] of lines.entries()) {
				yield* handleLine(line);
				if (protocolStopped) {
					let ignoredLines = 0;
					for (let rest = index + 1; rest < lines.length; rest++) if (lines[rest]?.trim()) ignoredLines++;
					const buffered = buffer.trim().length;
					if (ignoredLines > 0 || buffered > 0) trace.record("protocol-stop", {
						protocol,
						ignoredLines,
						buffered
					});
					break;
				}
			}
			if (protocolStopped) break;
		}
		signal?.throwIfAborted();
		if (usage !== void 0) {
			usageEmitted = true;
			yield {
				type: "usage",
				usage
			};
		}
		signal?.throwIfAborted();
		if (finish !== void 0) {
			const failure = asm.sawContent ? void 0 : emptyCompletionError(asm.finishReason, maxTokens, usage);
			trace.record("end", {
				outcome: failure === void 0 ? "finished" : failure.code === "OUTPUT_TOKEN_LIMIT" ? "output-token-limit" : "empty",
				finishReason: asm.finishReason,
				...failure === void 0 ? {} : { code: failure.code },
				maxTokens,
				...usage === void 0 ? {} : { usage },
				chunks: chunkCount,
				bytes: totalBytes,
				totalMs: Date.now() - streamStartedAt,
				sawContent: asm.sawContent,
				responseMetadata
			});
			endRecorded = true;
			if (failure !== void 0) throw failure;
			const replayBlocks = asm.replayBlocks;
			yield hasResponseIdentifiers(responseMetadata) || replayBlocks.length > 0 ? {
				...finish,
				replayState: {
					response: responseMetadata,
					...replayBlocks.length > 0 ? { blocks: replayBlocks } : {}
				}
			} : finish;
		} else {
			const elapsed = Date.now() - streamStartedAt;
			const detail = `${chunkCount} chunk(s), ${totalBytes} bytes, ${elapsed}ms`;
			trace.record("end", {
				outcome: asm.sawContent ? "stream-closed" : "empty",
				chunks: chunkCount,
				bytes: totalBytes,
				totalMs: elapsed,
				sawContent: asm.sawContent,
				responseMetadata
			});
			endRecorded = true;
			if (!asm.sawContent) throw bilingual("EMPTY_RESPONSE", "Command Code returned an empty response", "Command Code 返回了空响应，重试通常可恢复");
			throw bilingual("STREAM_CLOSED", `Command Code API stream from ${apiBase} ended before its finish event (${detail}) — the response was closed mid-generation, so this is not the model stopping by itself`, `Command Code API 流式响应在结束事件之前被关闭（生成中途断流），并非模型主动结束——请重试；若频繁出现，可用 ${STREAM_TRACE_ENV}=<文件路径> 抓取原始流以定位断流原因`);
		}
	} catch (error) {
		if (!usageEmitted && usage !== void 0) yield {
			type: "usage",
			usage
		};
		if (!endRecorded) trace.record("end", {
			outcome: signal?.aborted ? signal.reason instanceof ConsumerStreamClosed ? "cancelled" : "aborted" : "error",
			code: error instanceof LlmError ? error.code : "unknown",
			finishReason: asm.finishReason,
			maxTokens,
			...usage === void 0 ? {} : { usage },
			sawContent: asm.sawContent,
			chunks: chunkCount,
			bytes: totalBytes,
			totalMs: Date.now() - streamStartedAt,
			responseMetadata
		});
		endRecorded = true;
		signal?.throwIfAborted();
		throw failureWithRequestId(error, responseMetadata);
	} finally {
		clearIdle();
		signal?.removeEventListener("abort", onAbort);
		if (!endRecorded) trace.record("end", {
			outcome: signal?.aborted && !(signal.reason instanceof ConsumerStreamClosed) ? "aborted" : "cancelled",
			...usage === void 0 ? {} : { usage },
			chunks: chunkCount,
			bytes: totalBytes,
			responseMetadata
		});
		cancelReader();
		try {
			reader.releaseLock();
		} catch {}
	}
}
/** Only provider correlation headers, never a wholesale response-header dump. */
const RESPONSE_ID_HEADERS = [
	"x-request-id",
	"request-id",
	"x-trace-id",
	"x-generation-id",
	"traceparent"
];
function responseIdentifiers(headers) {
	const result = {};
	for (const name of RESPONSE_ID_HEADERS) {
		const value = diagnosticId(headers.get(name));
		if (value !== void 0) result[name] = value;
	}
	return result;
}
function diagnosticId(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 ? value : void 0;
}
function captureResponseIdentifiers(metadata, event) {
	if (!isRecord(event)) return;
	if (metadata.protocol === "openai" && Array.isArray(event.choices) || event.type === "response-metadata") {
		const id = diagnosticId(event.id);
		if (id !== void 0) metadata.responseId = id;
	}
	for (const name of [
		"generationId",
		"providerRequestId",
		"traceId"
	]) {
		const id = diagnosticId(event[name]);
		if (id !== void 0) metadata[name] = id;
	}
}
function hasResponseIdentifiers(metadata) {
	return Object.keys(metadata.headers).length > 0 || metadata.responseId !== void 0 || metadata.generationId !== void 0 || metadata.providerRequestId !== void 0 || metadata.traceId !== void 0;
}
/** Keep the provider's request id on DSH's durable failure, when it supplied one. */
function failureWithRequestId(error, metadata) {
	const id = metadata.providerRequestId ?? metadata.headers["x-request-id"] ?? metadata.headers["request-id"];
	if (!(error instanceof LlmError) || error.failure.requestId !== void 0 || id === void 0) return error;
	return new LlmError(error.message, error.code, {
		...error.failure,
		requestId: ProviderRequestId(id),
		...error.cause === void 0 ? {} : { cause: error.cause }
	});
}
/**
* Thinking text carried by an OpenRouter-shaped `reasoning_details` array,
* concatenated in the order the gateway sent it.
*
* Entries are read by their own text members rather than filtered on `type`:
* DeepSeek sends `{ type: 'reasoning.text', text }` while the OpenAI family
* sends `{ type: 'reasoning.summary', summary }` — the same summary text the
* scalar `delta.reasoning` carries. A `type` filter would drop one family, and
* losing thinking is the failure this exists to prevent. `text` wins per entry,
* but an EMPTY `text` must not shadow a populated `summary` (the Responses wire
* emits `text: ''` placeholders), so the fallback tests for non-empty rather
* than merely present. Encrypted-blob entries carry neither member and
* contribute nothing; no entry carries both, so nothing is counted twice.
*
* Returns undefined when the array yields nothing, so the caller's `??` chain
* keeps falling through instead of treating "no text" as a reasoning delta.
*/
function reasoningDetailsText(value) {
	if (!Array.isArray(value)) return void 0;
	let text = "";
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const exact = stringValue(entry.text);
		const summary = stringValue(entry.summary);
		text += exact !== void 0 && exact !== "" ? exact : summary ?? "";
	}
	return text === "" ? void 0 : text;
}
/**
* One SCALAR thinking delta, treating an empty string as "this chunk carries
* none" — the same rule {@link reasoningDetailsText} applies inside the array.
* The scalar and the array describe the same thinking, so an empty spelling of
* one must not shadow populated text in the other (the Responses wire pads with
* `text: ''`), and `??` alone cannot express that.
*/
function nonEmptyText(value) {
	return value === void 0 || value === "" ? void 0 : value;
}
function parseStreamEventLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
/** Fresh block-assembly state for one stream. */
function createBlockAssembler() {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		sawContent: false,
		finishReason: void 0,
		cliCacheWriteTokens: void 0,
		openAiToolCalls: [],
		messagesBlocks: /* @__PURE__ */ new Map(),
		messagesUsage: void 0,
		replayBlocks: []
	};
}
function* closeText(asm) {
	if (asm.textIndex < 0) return;
	yield {
		type: "block-end",
		index: asm.textIndex,
		block: {
			type: "text",
			text: asm.textContent
		}
	};
	asm.textIndex = -1;
	asm.textContent = "";
}
function* closeReasoning(asm) {
	if (asm.reasoningIndex < 0) return;
	yield {
		type: "block-end",
		index: asm.reasoningIndex,
		block: {
			type: "reasoning",
			text: asm.reasoningContent
		}
	};
	asm.reasoningIndex = -1;
	asm.reasoningContent = "";
}
function* emitOpenAiToolCalls(asm) {
	for (const call of asm.openAiToolCalls) {
		const id = call.id ?? randomUUID();
		const name = call.name ?? "";
		const args = call.arguments || "{}";
		const index = asm.nextIndex++;
		asm.sawContent = true;
		yield {
			type: "block-start",
			index,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index,
			id: ToolCallId(id),
			name,
			argumentsDelta: args
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(id),
				name,
				arguments: args
			}
		};
	}
	asm.openAiToolCalls.length = 0;
}
/**
* Handle one CLI-transport (`/alpha/generate`) stream event, appending
* harness StreamChunks. Pure over the passed assembler — no stream() locals.
*/
function handleCliEvent(asm, event) {
	const chunks = [];
	if (!isRecord(event)) return chunks;
	switch (event.type) {
		case "text-delta": {
			chunks.push(...closeReasoning(asm));
			if (asm.textIndex < 0) {
				asm.textIndex = asm.nextIndex++;
				chunks.push({
					type: "block-start",
					index: asm.textIndex,
					blockType: "text"
				});
			}
			const delta = stringValue(event.text) ?? "";
			asm.textContent += delta;
			if (delta.trim() !== "") asm.sawContent = true;
			chunks.push({
				type: "text-delta",
				index: asm.textIndex,
				text: delta
			});
			break;
		}
		case "reasoning-delta": {
			chunks.push(...closeText(asm));
			if (asm.reasoningIndex < 0) {
				asm.reasoningIndex = asm.nextIndex++;
				chunks.push({
					type: "block-start",
					index: asm.reasoningIndex,
					blockType: "reasoning"
				});
			}
			const delta = stringValue(event.text) ?? "";
			asm.reasoningContent += delta;
			chunks.push({
				type: "reasoning-delta",
				index: asm.reasoningIndex,
				text: delta
			});
			break;
		}
		case "reasoning-start":
			chunks.push(...closeText(asm));
			break;
		case "reasoning-end":
			chunks.push(...closeReasoning(asm));
			break;
		case "tool-call": {
			chunks.push(...closeText(asm), ...closeReasoning(asm));
			const id = stringValue(event.toolCallId) ?? randomUUID();
			const name = stringValue(event.toolName) ?? "";
			const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments));
			const index = asm.nextIndex++;
			asm.sawContent = true;
			chunks.push({
				type: "block-start",
				index,
				blockType: "tool-call"
			}, {
				type: "tool-call-delta",
				index,
				id: ToolCallId(id),
				name,
				argumentsDelta: args
			}, {
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id: ToolCallId(id),
					name,
					arguments: args
				}
			});
			break;
		}
		case "cache-write-tokens": {
			const cacheWrite = numberValue(event.cacheWriteTokens);
			if (cacheWrite !== void 0 && cacheWrite >= 0) asm.cliCacheWriteTokens = cacheWrite;
			break;
		}
		case "finish": {
			asm.finishReason = stringValue(event.finishReason);
			chunks.push(...closeText(asm), ...closeReasoning(asm));
			const usage = isRecord(event.totalUsage) ? event.totalUsage : void 0;
			const capturedCacheWrite = asm.cliCacheWriteTokens;
			if (usage || capturedCacheWrite !== void 0) {
				const details = isRecord(usage?.inputTokenDetails) ? usage.inputTokenDetails : void 0;
				const totalInput = numberValue(usage?.inputTokens) ?? 0;
				const cacheRead = numberValue(details?.cacheReadTokens) ?? 0;
				const reportedCacheWrite = numberValue(details?.cacheWriteTokens) ?? 0;
				const cacheWrite = reportedCacheWrite === 0 && capturedCacheWrite !== void 0 ? capturedCacheWrite : reportedCacheWrite;
				const tokenUsage = {
					inputTokens: numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
					outputTokens: numberValue(usage?.outputTokens) ?? 0,
					cacheReadTokens: cacheRead,
					cacheWriteTokens: cacheWrite
				};
				const reasoningTokens = numberValue((isRecord(usage?.outputTokenDetails) ? usage.outputTokenDetails : void 0)?.reasoningTokens) ?? numberValue(usage?.reasoningTokens);
				if (reasoningTokens !== void 0) tokenUsage.reasoningTokens = reasoningTokens;
				chunks.push({
					type: "usage",
					usage: tokenUsage
				});
			}
			chunks.push({
				type: "finish",
				reason: mapFinishReason(event.finishReason)
			});
			break;
		}
		case "error": throw streamErrorToLlmError(event.error, stringValue(event.message));
	}
	return chunks;
}
/**
* Handle one OpenAI-transport (`/provider/v1/chat/completions`) SSE event.
* Same assembler contract as {@link handleCliEvent}; tool-call fragments
* buffer on the assembler and flush at finish.
*/
function handleOpenAIEvent(asm, event) {
	const chunks = [];
	if (!isRecord(event)) return chunks;
	if (event.error !== void 0) throw streamErrorToLlmError(event.error, stringValue(event.message));
	const choices = event.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		if (event.usage !== void 0) chunks.push({
			type: "usage",
			usage: mapOpenAIUsage(event.usage)
		});
		return chunks;
	}
	const choice = isRecord(choices[0]) ? choices[0] : {};
	const delta = isRecord(choice.delta) ? choice.delta : {};
	const reasoningDelta = nonEmptyText(stringValue(delta.reasoning)) ?? nonEmptyText(stringValue(delta.reasoning_content)) ?? reasoningDetailsText(delta.reasoning_details) ?? "";
	if (reasoningDelta !== "") {
		chunks.push(...closeText(asm));
		if (asm.reasoningIndex < 0) {
			asm.reasoningIndex = asm.nextIndex++;
			chunks.push({
				type: "block-start",
				index: asm.reasoningIndex,
				blockType: "reasoning"
			});
		}
		asm.reasoningContent += reasoningDelta;
		chunks.push({
			type: "reasoning-delta",
			index: asm.reasoningIndex,
			text: reasoningDelta
		});
	}
	const contentDelta = stringValue(delta.content) ?? "";
	if (contentDelta !== "") {
		chunks.push(...closeReasoning(asm));
		if (asm.textIndex < 0) {
			asm.textIndex = asm.nextIndex++;
			chunks.push({
				type: "block-start",
				index: asm.textIndex,
				blockType: "text"
			});
		}
		asm.textContent += contentDelta;
		if (contentDelta.trim() !== "") asm.sawContent = true;
		chunks.push({
			type: "text-delta",
			index: asm.textIndex,
			text: contentDelta
		});
	}
	if (Array.isArray(delta.tool_calls)) for (const rawCall of delta.tool_calls) {
		if (!isRecord(rawCall)) continue;
		asm.sawContent = true;
		const callIndex = numberValue(rawCall.index) ?? 0;
		let existing = asm.openAiToolCalls.find((call) => call.index === callIndex);
		const fn = isRecord(rawCall.function) ? rawCall.function : void 0;
		const id = stringValue(rawCall.id);
		const name = fn === void 0 ? void 0 : stringValue(fn.name);
		const argDelta = fn === void 0 ? void 0 : stringValue(fn.arguments) ?? (fn.arguments === void 0 ? "" : JSON.stringify(fn.arguments));
		if (!existing) {
			existing = {
				index: callIndex,
				name: name ?? "",
				arguments: argDelta ?? ""
			};
			if (id !== void 0) existing.id = id;
			asm.openAiToolCalls.push(existing);
		} else {
			if (id !== void 0 && existing.id === void 0) existing.id = id;
			if (name !== void 0 && existing.name === "") existing.name = name;
			if (argDelta !== void 0) existing.arguments += argDelta;
		}
	}
	if (choice.finish_reason !== void 0 && choice.finish_reason !== null) {
		asm.finishReason = stringValue(choice.finish_reason);
		chunks.push(...closeText(asm), ...closeReasoning(asm), ...emitOpenAiToolCalls(asm));
		if (event.usage !== void 0) chunks.push({
			type: "usage",
			usage: mapOpenAIUsage(event.usage)
		});
		chunks.push({
			type: "finish",
			reason: mapFinishReason(choice.finish_reason)
		});
	}
	return chunks;
}
/**
* Messages `usage` → the harness meter.
*
* The field names are the Anthropic ones, and unlike Chat Completions
* `input_tokens` already excludes cache reads and writes, so it is mapped
* as-is rather than reduced (the shape `dsh-llm-deepseek` implements).
* Measured 2026-09-29: `{ input_tokens, cache_creation_input_tokens,
* cache_read_input_tokens, output_tokens, output_tokens_details:
* { thinking_tokens } }`, plus gateway additions the meter ignores.
*/
function mapMessagesUsage(raw, previous) {
	if (!isRecord(raw)) return void 0;
	const inputTokens = numberValue(raw.input_tokens) ?? previous?.inputTokens ?? 0;
	const outputTokens = numberValue(raw.output_tokens) ?? previous?.outputTokens ?? 0;
	const cacheRead = numberValue(raw.cache_read_input_tokens) ?? previous?.cacheReadTokens ?? 0;
	const cacheWrite = numberValue(raw.cache_creation_input_tokens) ?? previous?.cacheWriteTokens ?? 0;
	const reasoningTokens = numberValue((isRecord(raw.output_tokens_details) ? raw.output_tokens_details : void 0)?.thinking_tokens) ?? previous?.reasoningTokens;
	const usage = {
		inputTokens: Math.max(0, inputTokens),
		outputTokens,
		cacheReadTokens: cacheRead
	};
	if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
	if (reasoningTokens !== void 0) usage.reasoningTokens = reasoningTokens;
	return usage;
}
/** The harness block type one Messages content block maps to. */
function messagesBlockType(native) {
	if (native.type === "text") return "text";
	if (native.type === "thinking") return "reasoning";
	if (native.type === "tool_use") return "tool-call";
}
/**
* Handle one Messages-transport stream event, appending harness StreamChunks.
*
* The event sequence is the Anthropic one measured on 2026-09-29:
* `message_start`, then per content block `content_block_start` /
* `content_block_delta`* / `content_block_stop`, then `message_delta`
* (carrying `stop_reason` and the final usage) and `message_stop`. A `ping`
* keepalive interleaves freely and carries no content. The terminal chunks are
* NOT emitted here: `stream()` holds the success finish until it has validated
* the assembled answer, and it attaches the replay envelope.
*/
function handleMessagesEvent(asm, event) {
	const chunks = [];
	if (!isRecord(event)) return chunks;
	switch (event.type) {
		case "message_start": {
			const usage = mapMessagesUsage((isRecord(event.message) ? event.message : void 0)?.usage);
			if (usage) {
				asm.messagesUsage = usage;
				chunks.push({
					type: "usage",
					usage
				});
			}
			break;
		}
		case "content_block_start": {
			const wireIndex = numberValue(event.index);
			const native = isRecord(event.content_block) ? event.content_block : void 0;
			const type = native ? messagesBlockType(native) : void 0;
			if (wireIndex === void 0 || type === void 0) break;
			const chunkIndex = asm.nextIndex++;
			const state = {
				type,
				text: stringValue(native?.text) ?? "",
				signature: stringValue(native?.signature) ?? "",
				json: "",
				id: stringValue(native?.id) ?? "",
				name: stringValue(native?.name) ?? "",
				chunkIndex
			};
			asm.messagesBlocks.set(wireIndex, state);
			asm.replayBlocks[chunkIndex] = { type };
			chunks.push({
				type: "block-start",
				index: chunkIndex,
				blockType: type
			});
			if (type === "tool-call" && state.id !== "") chunks.push({
				type: "tool-call-delta",
				index: chunkIndex,
				id: ToolCallId(state.id),
				name: state.name,
				argumentsDelta: ""
			});
			break;
		}
		case "content_block_delta": {
			const wireIndex = numberValue(event.index);
			const state = wireIndex === void 0 ? void 0 : asm.messagesBlocks.get(wireIndex);
			const delta = isRecord(event.delta) ? event.delta : void 0;
			if (!state || !delta) break;
			const index = state.chunkIndex;
			if (delta.type === "text_delta" && state.type === "text") {
				const text = stringValue(delta.text) ?? "";
				state.text += text;
				if (text.trim() !== "") asm.sawContent = true;
				chunks.push({
					type: "text-delta",
					index,
					text
				});
			} else if (delta.type === "thinking_delta" && state.type === "reasoning") {
				const text = stringValue(delta.thinking) ?? "";
				state.text += text;
				chunks.push({
					type: "reasoning-delta",
					index,
					text
				});
			} else if (delta.type === "signature_delta" && state.type === "reasoning") {
				state.signature += stringValue(delta.signature) ?? "";
				const entry = asm.replayBlocks[index];
				if (entry) entry.signature = state.signature;
			} else if (delta.type === "input_json_delta" && state.type === "tool-call") {
				const fragment = stringValue(delta.partial_json) ?? "";
				state.json += fragment;
				chunks.push({
					type: "tool-call-delta",
					index,
					id: ToolCallId(state.id),
					name: state.name,
					argumentsDelta: fragment
				});
			}
			break;
		}
		case "content_block_stop": {
			const wireIndex = numberValue(event.index);
			if (wireIndex === void 0) break;
			const state = asm.messagesBlocks.get(wireIndex);
			if (!state) break;
			asm.messagesBlocks.delete(wireIndex);
			const index = state.chunkIndex;
			if (state.type === "text") {
				if (state.text.trim() !== "") asm.sawContent = true;
				chunks.push({
					type: "block-end",
					index,
					block: {
						type: "text",
						text: state.text
					}
				});
			} else if (state.type === "reasoning") chunks.push({
				type: "block-end",
				index,
				block: {
					type: "reasoning",
					text: state.text
				}
			});
			else {
				if (state.id !== "") asm.sawContent = true;
				chunks.push({
					type: "block-end",
					index,
					block: {
						type: "tool-call",
						id: ToolCallId(state.id),
						name: state.name,
						arguments: state.json || "{}"
					}
				});
			}
			break;
		}
		case "message_delta": {
			const reason = stringValue((isRecord(event.delta) ? event.delta : void 0)?.stop_reason);
			if (reason !== void 0) asm.finishReason = reason;
			const usage = mapMessagesUsage(event.usage, asm.messagesUsage);
			if (usage) {
				asm.messagesUsage = usage;
				chunks.push({
					type: "usage",
					usage
				});
			}
			break;
		}
		case "message_stop":
			chunks.push({
				type: "finish",
				reason: mapFinishReason(asm.finishReason)
			});
			break;
		case "ping": break;
		case "error": throw streamErrorToLlmError(event.error ?? event, stringValue(event.message));
	}
	return chunks;
}
function handleEvent(asm, protocol, event) {
	if (protocol === "cli") return handleCliEvent(asm, event);
	return protocol === "messages" ? handleMessagesEvent(asm, event) : handleOpenAIEvent(asm, event);
}
/** 三种协议的结束原因统一映射为宿主分类，保留线上名称用于诊断。 */
function mapFinishReason(reason) {
	if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use") return { kind: "tool-calls" };
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") return { kind: "max-tokens" };
	return { kind: "stop" };
}
/** A terminal marker without text or tools is a failed attempt, not a completed turn. */
function emptyCompletionError(reason, maxTokens, usage) {
	const detail = `finish_reason=${reason ?? "unknown"}, max_tokens=${maxTokens}, outputTokens=${usage?.outputTokens ?? "unknown"}, reasoningTokens=${usage?.reasoningTokens ?? "unknown"}`;
	if (mapFinishReason(reason).kind === "max-tokens") return bilingual("OUTPUT_TOKEN_LIMIT", `Command Code reached the output token limit without producing answer text or a tool call (${detail})`, "Command Code 已达到输出 token 上限，但没有生成正文或工具调用；请调整思考强度，或在模型和接口上限内增加输出预算");
	if (reason === "content_filter" || reason === "content-filter") return bilingual("CONTENT_FILTER", `Command Code filtered the response (${detail})`, "Command Code 拦截了响应，未生成正文或工具调用");
	return bilingual("EMPTY_RESPONSE", `Command Code finished without producing answer text or a tool call (${detail})`, "Command Code 返回了空响应（可能只有思考内容），重试通常可恢复");
}
/** Map an OpenAI Chat Completions usage payload to harness disjoint counts. */
function mapOpenAIUsage(usage) {
	const source = isRecord(usage) ? usage : {};
	const promptTokens = numberValue(source.prompt_tokens) ?? 0;
	const outputTokens = numberValue(source.completion_tokens) ?? 0;
	const totalTokens = numberValue(source.total_tokens);
	const promptDetails = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : void 0;
	const cacheRead = numberValue(promptDetails?.cached_tokens) ?? 0;
	const cacheWrite = numberValue(promptDetails?.cache_creation_input_tokens) ?? 0;
	const reasoningTokens = numberValue((isRecord(source.completion_tokens_details) ? source.completion_tokens_details : void 0)?.reasoning_tokens);
	const usageOut = {
		inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
		outputTokens,
		cacheReadTokens: cacheRead
	};
	if (cacheWrite > 0) usageOut.cacheWriteTokens = cacheWrite;
	if (reasoningTokens !== void 0) usageOut.reasoningTokens = reasoningTokens;
	if (totalTokens !== void 0) usageOut.totalTokens = totalTokens;
	return usageOut;
}
//#endregion
//#region src/image-request.ts
/**
* Long edge one request image may keep, in pixels.
*
* 1568 is Anthropic's documented ceiling — their API downscales anything larger
* before the model sees it — and it sits inside the high-detail band of the
* OpenAI and Gemini tile schemes, so no upstream this gateway reaches reads
* more detail than the target keeps. Screenshots from a Retina display are the
* case this is for: 2880x1800 becomes 1568x980, a 3.4x pixel cut, and the
* models lose nothing they would not have downscaled themselves.
*/
const REQUEST_IMAGE_MAX_LONG_EDGE = 1568;
/**
* Encoded bytes one request image may keep, before base64 expansion. The same
* 1 MiB budget the harness's own multi-provider adapter defaults to; the
* attachment service keeps its smallest quality-ladder output when no quality
* fits, so this bounds bytes without ever refusing an image.
*/
const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1048576;
/**
* Aspect-preserving projection onto a long-edge budget; never enlarges, and
* never returns a zero dimension.
*
* `dsh-attachment` exports an equivalent `longEdgeDimensions`, but it does not
* guard its inputs: a reference whose declared size is 0 or NaN — a malformed
* or fabricated attachment record — would project to a zero-sized target and
* make the encoder refuse the whole request. This local guard is the ONLY
* reason the function is not imported; do not replace it with the upstream one.
* `tests/image-tokens.test.ts` pins the degenerate cases.
*/
function longEdgeDimensions(width, height, longEdge) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {
		width: Math.max(1, Math.round(width) || 1),
		height: Math.max(1, Math.round(height) || 1)
	};
	if (longEdge >= Math.max(width, height)) return {
		width,
		height
	};
	return width >= height ? {
		width: longEdge,
		height: Math.max(1, Math.round(longEdge * height / width))
	} : {
		width: Math.max(1, Math.round(longEdge * width / height)),
		height: longEdge
	};
}
/**
* The request target for one normalized attachment: its aspect ratio under the
* long-edge budget, plus the encoded-byte budget.
*/
function requestImageTarget(ref) {
	const projected = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE);
	return {
		width: projected.width,
		height: projected.height,
		maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES
	};
}
//#endregion
//#region src/image-tokens.ts
/**
* Vision-token accounting for the model families Command Code routes to.
*
* The harness's token meter prices request images through
* `LlmAdapter.imageRequestPricing(provider, model).priceImages(blocks)` and,
* when a route declares nothing, falls back to a structural estimate that
* charges a handful of tokens for ANY image. On an image-heavy session that is
* not a rounding error: a screenshot loop can carry dozens of full-size images
* that the heuristic prices at ~0 tokens each, so context pressure is
* under-reported and the session walks into its own context window.
*
* This route is a gateway in front of many upstreams, so the estimate is per
* FAMILY, using each vendor's published rule, and the families are recognised
* by the catalog id (which names the vendor). Every formula is stated here
* rather than imported: the only in-tree implementations live inside the
* official adapters, and this plugin deliberately does not depend on those
* protocols. These are ESTIMATES for context accounting, not invoices — the
* provider's own usage remains authoritative for a completed request.
*
* @module dsh-commandcode-provider/image-tokens
*/
/**
* Which family prices one catalog model id.
*
* `generic` is not "we do not know the model" but "we cannot tell its visual
* rule apart from the known ones" — the Qwen, MiniMax, xAI, moonshot and
* sakana families all publish patch- or tile-based accounting close to the
* Anthropic rule, so the conservative fallback below covers them without
* pretending to more precision than we have.
*/
function imageTokenFamily(modelId) {
	const id = modelId.toLowerCase();
	const vendor = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
	if (id.startsWith("claude")) return "anthropic";
	if (id.startsWith("gpt") || /^o[1-9]/.test(id)) return "openai";
	if (vendor === "google" || id.startsWith("gemini")) return "google";
	if (vendor === "deepseek") return "deepseek";
	return "generic";
}
/**
* Visual tokens one request image costs on the given family, at the dimensions
* this route would actually send (see `./image-request.ts`).
*/
function imageTokenCost(family, width, height) {
	switch (family) {
		case "anthropic": return anthropicImageTokens(width, height);
		case "openai": return openAiImageTokens(width, height);
		case "google": return googleImageTokens(width, height);
		case "deepseek": return deepSeekImageTokens(width, height);
		default: return genericImageTokens(width, height);
	}
}
/** Convenience for callers that have a model id: family lookup plus the rule. */
function commandCodeImageTokens(modelId, width, height) {
	return imageTokenCost(imageTokenFamily(modelId), width, height);
}
/**
* Anthropic: the image is first scaled to the request long edge (never
* enlarged), then charged roughly one token per 750 pixels.
* Source: Anthropic vision documentation, "Image size and token usage".
*/
function anthropicImageTokens(width, height) {
	const projected = longEdgeDimensions(width, height, REQUEST_IMAGE_MAX_LONG_EDGE);
	return Math.max(1, Math.ceil(projected.width * projected.height / 750));
}
/**
* OpenAI (high detail): scale to fit inside 2048x2048, then scale the shortest
* side to 768 px, then charge an 85-token base plus 170 tokens per 512x512
* tile. Source: OpenAI vision documentation, "Calculating costs".
*/
function openAiImageTokens(width, height) {
	let scaled = {
		width: Math.max(1, width),
		height: Math.max(1, height)
	};
	const longest = Math.max(scaled.width, scaled.height);
	if (longest > 2048) scaled = scaleBy(scaled, 2048 / longest);
	const shortest = Math.min(scaled.width, scaled.height);
	if (shortest > 768) scaled = scaleBy(scaled, 768 / shortest);
	return 85 + 170 * (Math.ceil(scaled.width / 512) * Math.ceil(scaled.height / 512));
}
/**
* Google Gemini: an image whose both sides are at most 384 px costs a flat 258
* tokens; anything larger is cropped into 768x768 tiles of 258 tokens each.
* Source: Gemini image-understanding documentation.
*/
function googleImageTokens(width, height) {
	if (width <= 384 && height <= 384) return 258;
	return 258 * Math.ceil(width / 768) * Math.ceil(height / 768);
}
/** 14-px patches, merged 3x3 into one token cell. */
const DEEPSEEK_PATCH_SIZE = 14;
const DEEPSEEK_DOWNSAMPLE_RATIO = 3;
/** The provider's cap on tokens for one request image. */
const DEEPSEEK_MAX_IMAGE_TOKENS = 1024;
/** Total-pixel floor; a smaller image is enlarged before grid projection. */
const DEEPSEEK_MIN_PIXELS = 295936;
/**
* DeepSeek: pad to 14-px patches, merge each 3x3 patch block into one token
* cell, charge one token per cell plus one separator per row plus two framing
* tokens, and cap one image at 1024 tokens by downscaling it aspect-preserving
* (images below 544x544 are enlarged first).
*
* Mirrors `deepSeekImageTokens` in the official `dsh-llm-deepseek` adapter
* (its `PATCH_SIZE`, `DOWNSAMPLE_RATIO`, `MAX_IMAGE_TOKENS` and `MIN_PIXELS`).
* The official solver picks the largest grid that fits the cap; this restates
* that as a bounded search over the scale factor, which lands on the same grid
* without vendoring the closed-form solver.
*/
function deepSeekImageTokens(width, height) {
	let scaled = {
		width: Math.max(1, width),
		height: Math.max(1, height)
	};
	const pixels = scaled.width * scaled.height;
	if (pixels < DEEPSEEK_MIN_PIXELS) scaled = scaleBy(scaled, Math.sqrt(DEEPSEEK_MIN_PIXELS / pixels));
	const direct = deepSeekGridTokens(scaled.width, scaled.height);
	if (direct <= DEEPSEEK_MAX_IMAGE_TOKENS) return direct;
	let low = 0;
	let high = 1;
	let best = direct;
	for (let step = 0; step < 24; step += 1) {
		const mid = (low + high) / 2;
		const tokens = deepSeekGridTokens(Math.max(1, Math.round(scaled.width * mid)), Math.max(1, Math.round(scaled.height * mid)));
		if (tokens <= DEEPSEEK_MAX_IMAGE_TOKENS) {
			low = mid;
			best = tokens;
		} else high = mid;
	}
	return best;
}
/** One token grid's charge: every row carries a separator, plus two framing tokens. */
function deepSeekGridTokens(width, height) {
	const cellsWide = cellCount(width);
	return cellCount(height) * (cellsWide + 1) + 2;
}
/** Token cells along one padded pixel axis. */
function cellCount(length) {
	const patches = Math.ceil(length / DEEPSEEK_PATCH_SIZE);
	return Math.ceil(patches / DEEPSEEK_DOWNSAMPLE_RATIO);
}
/**
* The conservative fallback for a family we cannot price exactly: the MOST
* expensive of the three simple published rules at these dimensions.
*
* Chosen deliberately. Under-reporting context is what lets a session walk into
* its own context window, while over-reporting only makes the meter cautious;
* for the real families this covers (Qwen's 28-px patches, MiniMax, xAI,
* moonshot, sakana) the Anthropic rule is the close one, and it is the maximum
* at every size except the sub-384-px band, where Gemini's flat 258 wins.
*/
function genericImageTokens(width, height) {
	return Math.max(anthropicImageTokens(width, height), openAiImageTokens(width, height), googleImageTokens(width, height));
}
/** Scale one dimension pair by a positive factor, rounded to whole pixels. */
function scaleBy(size, factor) {
	return {
		width: Math.max(1, Math.round(size.width * factor)),
		height: Math.max(1, Math.round(size.height * factor))
	};
}
//#endregion
//#region src/request-timing.ts
/** 请求耗时只记录阶段、计数和状态；不记录消息、凭据、请求头或错误正文。 */
const REQUEST_TIMING_ENV = "DSH_COMMANDCODE_TIMING";
/** 每次生成独立计时；可注入时钟验证顺序，不依赖真实等待。 */
var RequestTiming = class {
	sink;
	now;
	started;
	summary;
	constructor(model, sink, now = () => performance.now()) {
		this.sink = sink;
		this.now = now;
		this.started = now();
		this.summary = {
			version: 1,
			startedAt: Date.now(),
			model,
			outcome: "cancelled",
			totalMs: 0,
			phasesMs: {
				credentials: 0,
				images: 0,
				body: 0,
				serialization: 0,
				headers: 0
			},
			attempts: []
		};
	}
	/** 返回结束函数，确保成功和异常都计入同一阶段。阶段可嵌套，不能直接相加。 */
	phase(name) {
		if (!this.sink) return () => {};
		const start = this.now();
		return () => {
			this.summary.phasesMs[name] += this.now() - start;
		};
	}
	attempt(protocol, bodyBytes) {
		if (!this.sink) return () => {};
		const start = this.now();
		const attempt = {
			protocol,
			bodyBytes,
			headersMs: 0
		};
		this.summary.attempts.push(attempt);
		return (status) => {
			Object.assign(attempt, {
				headersMs: this.now() - start,
				...status === void 0 ? {} : { status }
			});
			this.summary.phasesMs.headers += attempt.headersMs;
		};
	}
	first(kind) {
		if (this.sink && this.summary[kind] === void 0) this.summary[kind] = this.now() - this.started;
	}
	async close(outcome, errorCode) {
		if (!this.sink) return;
		this.summary.outcome = outcome;
		this.summary.totalMs = this.now() - this.started;
		if (errorCode !== void 0) this.summary.errorCode = errorCode;
		try {
			await this.sink(this.summary);
		} catch {}
	}
};
/** 与原始流诊断独立开关，便于仅收集数值耗时。 */
function openRequestTiming(model, sink) {
	if (sink) return new RequestTiming(model, sink);
	const raw = process.env[REQUEST_TIMING_ENV]?.trim();
	if (!raw || [
		"0",
		"false",
		"no",
		"off"
	].includes(raw.toLowerCase())) return new RequestTiming(model);
	const path = [
		"1",
		"true",
		"yes",
		"on"
	].includes(raw.toLowerCase()) ? join(tmpdir(), "dsh-commandcode-timing.jsonl") : raw;
	return new RequestTiming(model, async (summary) => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(summary)}\n`, { mode: 384 });
	});
}
//#endregion
//#region src/gateway-facts.ts
/** 网关事实的唯一所有者：目录先校验再发布，调用快照与跨调用学习分别持有。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 131072;
const MODEL_CATALOG_TTL_MS = 3e5;
const MODEL_CATALOG_RETRY_MS = 1e4;
const MODEL_CACHE_VERSION = 3;
const learned = /* @__PURE__ */ new Map();
const published = /* @__PURE__ */ new Map();
const generations = /* @__PURE__ */ new Map();
const validLimit = (value) => value !== void 0 && Number.isSafeInteger(value) && value > 0;
const fallbackLimit = (model) => MODEL_OUTPUT_TOKEN_LIMITS.get(model) ?? (requiresMessagesEndpoint(model) ? 64e3 : 131072);
function learnedOutputLimit(apiBase, model) {
	return learned.get(apiBase)?.get(model) ?? Infinity;
}
function modelOutputTokenLimit(apiBase, model) {
	return Math.min(published.get(apiBase)?.get(model) ?? fallbackLimit(model), learnedOutputLimit(apiBase, model));
}
/** 是否更新共享事实与是否值得重试是两个问题；以本次实发预算判断拒绝。 */
function outputCeilingRefusal(apiBase, model, sent, error) {
	if (!(error instanceof LlmError) || !OUTPUT_LIMIT_REJECTION.test(error.message)) return void 0;
	const stated = parseOutputCeiling(error.message);
	if (!validLimit(stated) || stated >= sent) return void 0;
	let limits = learned.get(apiBase);
	if (limits === void 0) learned.set(apiBase, limits = /* @__PURE__ */ new Map());
	const next = Math.min(stated, learnedOutputLimit(apiBase, model));
	limits.set(model, next);
	return next;
}
function normalizeModel(raw, apiBase, disk) {
	if (!isRecord(raw)) return void 0;
	const id = stringValue(raw.id), name = stringValue(raw.name);
	const contextWindow = numberValue(disk ? raw.contextWindow : raw.context_length);
	if (!id || !name || contextWindow === void 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return void 0;
	const limit = numberValue(disk ? raw.publishedMaxTokens : raw.max_output_tokens);
	const endpoints = disk ? raw.supportedEndpoints : raw.supported_endpoints;
	return {
		id,
		name,
		contextWindow,
		maxTokens: Math.min(contextWindow, validLimit(limit) ? limit : fallbackLimit(id), learnedOutputLimit(apiBase, id)),
		...validLimit(limit) ? { publishedMaxTokens: limit } : {},
		supportedEndpoints: Array.isArray(endpoints) ? endpoints.filter((item) => typeof item === "string") : []
	};
}
function parseCatalog$1(value, apiBase) {
	if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data)) throw new LlmError("Unexpected Command Code models response shape", "PROVIDER_PROTOCOL_ERROR");
	const rows = value.data.map((raw) => normalizeModel(raw, apiBase, false)).filter((row) => row !== void 0);
	if (rows.length === 0) throw new LlmError("Command Code returned an empty model catalog", "PROVIDER_PROTOCOL_ERROR");
	return rows;
}
async function readCache(source) {
	const value = JSON.parse(await readFile(source.modelsCachePath, "utf8"));
	if (!isRecord(value) || value.version !== MODEL_CACHE_VERSION || value.apiBase !== source.apiBase || !Array.isArray(value.models)) throw new Error("Invalid model cache source");
	const rows = value.models.map((raw) => normalizeModel(raw, source.apiBase, true)).filter((row) => row !== void 0);
	if (rows.length === 0) throw new Error("Empty model cache");
	return rows;
}
function publish(apiBase, rows) {
	published.set(apiBase, new Map(rows.flatMap((row) => row.publishedMaxTokens === void 0 ? [] : [[row.id, row.publishedMaxTokens]])));
}
async function writeCache(source, rows, mayCommit) {
	await mkdir(dirname(source.modelsCachePath), { recursive: true });
	const temp = `${source.modelsCachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify({
			version: MODEL_CACHE_VERSION,
			apiBase: source.apiBase,
			models: rows
		}, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		if (mayCommit()) await rename(temp, source.modelsCachePath);
	} finally {
		await rm(temp, { force: true }).catch(() => void 0);
	}
}
function copyRows(rows) {
	return rows.map((row) => ({
		...row,
		supportedEndpoints: [...row.supportedEndpoints]
	}));
}
var GatewayFacts = class {
	fetchCatalog;
	state;
	constructor(fetchCatalog) {
		this.fetchCatalog = fetchCatalog;
	}
	forSource(source) {
		const identity = JSON.stringify([source.apiBase, source.modelsCachePath]);
		if (this.state?.source !== identity) this.state = {
			source: identity,
			rows: [],
			expiresAt: 0
		};
		return this.state;
	}
	/** 模型解析保持原有热目录直读；不把生成的磁盘冷读取推广到其他入口。 */
	knownModel(source, model) {
		const row = this.forSource(source).rows.find((candidate) => candidate.id === model);
		return row === void 0 ? void 0 : copyRows([row])[0];
	}
	/** 生成只读取本地目录；捕获状态后不再转向实例的新来源。 */
	async snapshot(source) {
		const state = this.forSource(source);
		if (state.rows.length > 0 || state.expiresAt > 0) return copyRows(state.rows);
		state.disk ??= readCache(source).catch(() => []);
		const rows = await state.disk;
		if (state.rows.length > 0 || state.expiresAt > 0) return copyRows(state.rows);
		if (state.inflight === void 0) state.rows = rows;
		return copyRows(rows);
	}
	async refresh(source, signal) {
		signal?.throwIfAborted();
		const state = this.forSource(source);
		if (Date.now() < state.expiresAt) return copyRows(state.rows);
		if (state.inflight === void 0) {
			const generation = (generations.get(source.apiBase) ?? 0) + 1;
			generations.set(source.apiBase, generation);
			const mayPublish = () => this.state === state && generations.get(source.apiBase) === generation;
			state.inflight = (async () => {
				let rows, ttl = MODEL_CATALOG_TTL_MS;
				try {
					rows = parseCatalog$1(await this.fetchCatalog(source), source.apiBase);
					if (mayPublish()) {
						publish(source.apiBase, rows);
						await writeCache(source, rows, mayPublish).catch(() => void 0);
					}
				} catch {
					ttl = MODEL_CATALOG_RETRY_MS;
					rows = state.rows.length > 0 ? state.rows : await readCache(source).catch(() => []);
					if (mayPublish() && !published.has(source.apiBase) && rows.length > 0) publish(source.apiBase, rows);
				}
				state.rows = rows;
				state.expiresAt = Date.now() + ttl;
				return rows;
			})().finally(() => {
				delete state.inflight;
			});
		}
		const inflight = state.inflight;
		if (!signal) return copyRows(await inflight);
		return copyRows(await new Promise((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			inflight.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
			if (signal.aborted) abort();
		}));
	}
};
//#endregion
//#region src/adapter.ts
/**
* DeepSeek Harness LLM adapter for the Command Code Provider API.
*
* Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
* community-maintained integration; you need your own Command Code account
* and API key or subscription, and Command Code's terms apply.
*
* Owns the three chat transports (`/alpha/generate`, `/provider/v1/chat/completions`,
* `/provider/v1/messages`),
* message conversion and the pre-stream account rotation loop. 目录、发布与
* 上限事实由 ./gateway-facts.ts 持有，本适配器只消费单次调用的独立快照。 已连接响应的读取与收束由 ./stream-response.ts 负责。
* The wire protocol is
* reverse-engineered (command-code@1.28.4, re-verified through 1.73.0);
* docs/agent-reference/adapter-protocol.md holds the full protocol record.
*
* The adapter is deliberately free of cordis/schemastery: it receives a
* per-request options thunk and an API-key resolver from the plugin entry
* (src/index.ts), so a settings change reaches the very next request.
*/
const COMMAND_CODE_CLI_VERSION = "1.74.3";
const DEFAULT_API_BASE = "https://api.commandcode.ai";
/**
* The output budget this bundle asks for, and the ceiling it will never exceed.
*
* 131 072, chosen against a measured provider limit rather than a round guess.
* Probing `/alpha/generate` directly on 2026-09-28: 64 000 → 200, 131 072 → 200,
* 196 608 → 200, **200 000 → 200, 200 704 → 400**, 1 000 000 → 400. The server
* therefore caps `max_tokens` at 200 000, and it does so identically for a
* 262 144-window model (`stealth/pixel-canary`, retired by Command Code on
* 2026-10-01 and named here only as the probe's subject) and a 1 000 000-window
* one (`stealth/space-bunny-alpha`) — the cap is global, not per model. 131 072
* keeps a 35 % margin under it while covering the real output ceiling of the
* models that have one (Claude 64 K, Gemini 64 K, several at 128 K).
*
* The old 64 000 was never a provider requirement: it cost nothing in latency
* (a 64 000 request answered headers in 1.28 s against 1.57 s for 131 072) but
* it did cap what a model could ever say in one turn.
*
* No client-side clamp is applied on top of this: an earlier version pre-shrank
* `max_tokens` from an estimate of the prompt already sent (`requestContextBudget()`,
* issue #67), but that estimate over-corrected on ordinary long conversations —
* exactly the "output gets cut short as the conversation grows" symptom issue #74
* reported — while a live A/B probe (2026-09-30, `stealth/space-bunny-alpha`,
* ~19.6% over its 1,000,000-token window with no client-side shrink) showed the
* endpoint answers a genuine overflow with an unambiguous `400 … exceeds the
* model's context window`, which `isContextOverflowDetail()` below already
* classifies as `CONTEXT_WINDOW_EXCEEDED` independently of this constant. See
* [决策记录](../docs/决策记录.md).
*/
const DEFAULT_GENERATE_MAX_TOKENS = 131072;
const MODELS_TIMEOUT_MS = 1e4;
/** How long the picker's plan-filter billing facts stay cached before refetching. */
const BILLING_ACCESS_TTL_MS = 3e5;
/** The entry-plan tier weight (`individual-go` in KNOWN_SUBSCRIPTION_PLANS). */
const GO_TIER_WEIGHT = 0;
/** Hard cap on account rotations within one request (one attempt per distinct key). */
const MAX_ACCOUNT_ROTATIONS = 16;
/**
* Subscription statuses the CLI treats as live (`Mr` in command-code's
* cli.mjs): the plan gate applies only under one of these.
*/
const ACTIVE_SUBSCRIPTION_STATUSES = /* @__PURE__ */ new Set([
	"active",
	"trialing",
	"past_due"
]);
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
const DEFAULT_REQUEST_TIMEOUT_MS = 3e5;
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* A lone UTF-16 surrogate half: a high surrogate not followed by a low one, or
* a low surrogate not preceded by a high one. Such a half is not a character —
* it only arises from a truncated slice, a lossy decode, or a lone `\uD83D`
* escape — and it survives `JSON.stringify` as an escape (`"\ud83d"`) rather
* than failing locally, so the request leaves the process carrying a string no
* UTF-8 consumer can round-trip. Providers running strict decoders reject it.
*
* This is the same expression `@earendil-works/pi-ai` applies to every outgoing
* string on this endpoint. Valid astral characters (emoji and anything else
* outside the BMP) are PAIRED surrogates and pass through untouched.
*/
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
* A cheap pre-test for "this string contains any surrogate code unit at all",
* paired or not. The exact pattern above needs lookaround, which V8 cannot
* optimize into a fast scan; this one is a plain range test. Real prompts are
* overwhelmingly ASCII-plus-CJK with no surrogates, so the common case pays one
* linear scan instead of the lookaround pass. Measured on a 412 KB request
* body: 1.40 ms with the exact pattern alone against 0.77 ms with this gate,
* where a bare `JSON.stringify` is 0.59 ms.
*/
const ANY_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;
/**
* Drop lone surrogate halves from one outgoing string.
*
* Applied at the single point a request body is serialized, so every field of
* every transport is covered — system text, message content, tool schemas and
* tool results alike — instead of enumerating the fields that can carry text
* and missing one. The value is returned unchanged whenever it holds no
* surrogate at all, which is the ordinary case.
*
* The `test()` call deliberately uses the flagless {@link ANY_SURROGATE_PATTERN}:
* a global regex is stateful, so testing with one would advance `lastIndex` and
* make consecutive calls on the same string alternate between true and false.
* `replace()` resets `lastIndex` itself, so the global pattern is safe there.
*/
function sanitizeSurrogates(value) {
	if (typeof value !== "string") return value;
	return ANY_SURROGATE_PATTERN.test(value) ? value.replace(LONE_SURROGATE_PATTERN, "") : value;
}
/** Hash one request value without retaining or logging its contents. */
function fingerprintValue(value) {
	let serialized;
	try {
		serialized = JSON.stringify(value) ?? String(value);
	} catch {
		serialized = String(value);
	}
	return {
		bytes: Buffer.byteLength(serialized),
		sha256: createHash("sha256").update(serialized).digest("hex")
	};
}
/**
* Structural request facts for issue #64's cache diagnosis.
*
* This deliberately records hashes and counts, never the prompt, tool
* descriptions, image bytes, headers, or credentials. `body` catches changes
* in any wire field; the named sections make a changed system/tools/messages
* prefix visible without making the trace a copy of the conversation.
*/
function requestFingerprint(protocol, body) {
	const params = protocol === "cli" ? recordOrEmpty(body.params) : body;
	const messages = Array.isArray(params.messages) ? params.messages : [];
	const tools = Array.isArray(params.tools) ? params.tools : [];
	return {
		protocol,
		model: typeof params.model === "string" ? params.model : void 0,
		threadId: typeof body.threadId === "string" ? body.threadId : void 0,
		body: fingerprintValue(body),
		config: fingerprintValue(body.config),
		system: fingerprintValue(protocol === "cli" ? params.system : messages.filter((m) => isRecord(m) && m.role === "system")),
		tools: {
			count: tools.length,
			...fingerprintValue(tools)
		},
		messages: {
			count: messages.length,
			roles: messages.map((message) => isRecord(message) && typeof message.role === "string" ? message.role : "unknown"),
			...fingerprintValue(messages),
			items: messages.map((message) => fingerprintValue(message))
		}
	};
}
/** Parse a billing-period timestamp (ISO string or millis) into millis; 0 when absent/invalid. */
function periodEndValue(value) {
	const asNumber = numberValue(value);
	if (asNumber !== void 0) return asNumber;
	const asString = stringValue(value);
	if (asString === void 0) return 0;
	const parsed = Date.parse(asString);
	return Number.isNaN(parsed) ? 0 : parsed;
}
/**
* The advice floor for a Provider-API timeout: doubling a 60 s budget is still
* short for a slow upstream first token, so the suggestion never goes below 5
* minutes. 提示上限与页面可编辑范围相同，重试退避上限不约束单次请求。
*/
const MIN_SUGGESTED_TIMEOUT_MS = 3e5;
/**
* Why one attempt saw no response headers, and what the user can do about it.
*
* The TRANSPORT is the reliable signal; the request size is not — and the
* mechanism is read straight out of the official CLI rather than inferred from
* a timing. `createNodeTransport` passes only the caller's `signal` and sets no
* timeout, so the two routes differ in WHO answers the headers:
* `/alpha/generate` has the gateway answer them before the model starts, while
* `/provider/v1/chat/completions` cannot answer until its upstream emits a
* first token, so whatever that upstream is doing is charged to the header
* wait. Measured 2026-09-28 (26 250-token prompt, `max_tokens: 16`):
* `/alpha/generate` 2.12 / 2.56 / 2.75 s, `/provider/v1/chat/completions`
* 5.52 / 2.98 / 3.70 s — a ~1.1 s median gap, with the Provider API route
* swinging across 2.5 s where the CLI route moved 0.6 s. A larger prompt moves
* neither, which is why an earlier draft that branched on a 1 MiB body
* threshold was wrong: size is not the variable here. Only the route decides.
*
* @param protocol - the transport the attempt used.
* @param timeoutMs - the header budget that just expired.
*/
function headersTimeoutAdvice(protocol, timeoutMs) {
	if (protocol === "openai") {
		const suggestionMs = Math.min(MAX_TIMEOUT_SECONDS * 1e3, Math.max(timeoutMs * 2, MIN_SUGGESTED_TIMEOUT_MS));
		return {
			cause: "upstream-first-token",
			...suggestionMs > timeoutMs ? { suggestionMs } : {}
		};
	}
	return { cause: "gateway" };
}
/**
* How many consecutive header timeouts on ONE unchanged payload stop being a
* blip. The retry policy whitelists `TIMEOUT` with `maxRetries: 1000` and a
* 500 ms → 15 min backoff, which is right for a provider that says when to
* come back but wrong for a gateway that simply never answers: the reporter
* saw the identical multi-megabyte body re-sent for hours (issue #67) instead
* of a diagnosis. Three is where a 60 s budget has already spent three
* minutes waiting, so the cost of being wrong is bounded and the user gets an
* answer either way.
*/
const MAX_CONSECUTIVE_HEADER_TIMEOUTS = 3;
/** Streak key for a session-less call, so those keep the old single-slot semantics instead of never escalating. */
const GLOBAL_HEADER_TIMEOUT_KEY = "\0global";
/** UTF-8 byte length, computed only on the timeout path so a large body is encoded once, not per attempt. */
function utf8ByteLength(text) {
	return new TextEncoder().encode(text).length;
}
/**
* The thrown headers timeout, worded for the cause it actually has.
*
* Every earlier version of this message said "通常是网络或代理问题" for both
* transports, which is actively wrong for a large `/provider/v1/chat/completions`
* prompt: there the model simply needs longer than any budget, and a user sent
* to check their proxy never finds anything. The code stays `TIMEOUT` (still
* retryable) in both branches — only the diagnosis and the advice change.
*/
function headersTimeoutError(input) {
	const { protocol, endpoint, timeoutMs, cause } = input;
	const megabytes = `${(utf8ByteLength(input.body) / 1048576).toFixed(1)} MB`;
	const advice = headersTimeoutAdvice(protocol, timeoutMs);
	if (advice.cause === "upstream-first-token") {
		const suggestion = advice.suggestionMs ?? timeoutMs;
		return bilingual("TIMEOUT", `Command Code API request to ${endpoint} did not respond within ${timeoutMs}ms: this route withholds response headers until the upstream model emits its first token, and it did not start within the budget. Raise "Request timeout" in the plugin's advanced settings to ${suggestion}ms, or compact the session or start a new one. The request body was ${megabytes}, but size is not the cause here — a slow upstream is. ${errorChain(cause)}`, `Command Code API 请求在 ${timeoutMs} 毫秒内未收到响应：该路由要等上游模型吐出第一个 token 才返回响应头，而上游在预算内没有开始作答。可在插件「高级」设置里把「请求超时」调到 ${suggestion} 毫秒，或压缩上下文 / 新开会话。本次请求体约 ${megabytes}，但体积不是原因——慢的是上游。（${errorChain(cause)}）`, { cause });
	}
	return bilingual("TIMEOUT", `Command Code API request to ${endpoint} did not respond within ${timeoutMs}ms: the gateway returned no response headers at all — it answers headers itself before the model replies. This is usually provider queueing, a Go-plan capacity limit, or a network/proxy path problem; a longer timeout will not help, but retrying usually recovers. The request body was ${megabytes}, and size is not the cause on this route. ${errorChain(cause)}`, `Command Code API 请求在 ${timeoutMs} 毫秒内未收到响应：网关完全没有返回响应头——它会在模型开始回答前先返回响应头。这通常是服务商排队、Go 套餐容量限制，或网络/代理链路问题；调大超时不会有帮助，重试通常可恢复。本次请求体约 ${megabytes}，而在该路由上体积不是原因。（${errorChain(cause)}）`, { cause });
}
/** How deep a root `$ref` / combinator chain is followed while normalizing. */
const SCHEMA_NORMALIZE_MAX_DEPTH = 4;
/**
* Whether a type-less node is object-shaped enough to be one with the type
* declared: `properties`/`required`/`additionalProperties` only make sense on
* an object, and a schema carrying them was meant to be one.
*/
function isObjectShaped(node) {
	return isRecord(node.properties) || isRecord(node.patternProperties) || Array.isArray(node.required) || node.additionalProperties !== void 0;
}
/** The `required` names of one schema node, ignoring malformed entries. */
function requiredNames(node) {
	return Array.isArray(node.required) ? node.required.filter((name) => typeof name === "string") : [];
}
/** Resolve a local `#/...` pointer inside the schema that carried it. */
function resolveLocalRef(root, ref) {
	if (!ref.startsWith("#/")) return void 0;
	let node = root;
	for (const rawSegment of ref.slice(2).split("/")) {
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isRecord(node)) return void 0;
		node = node[segment];
	}
	return isRecord(node) ? node : void 0;
}
/**
* Flatten a type-less combinator node into one object schema, so the model
* still sees the branch fields instead of an argument-free tool. `allOf`
* branches must all hold, so their `required` entries are all kept; `anyOf` /
* `oneOf` branches are alternatives, so only a name required by every branch
* survives. Returns undefined when no branch describes an object.
*/
function mergeCombinatorBranches(node, depth) {
	if (depth >= SCHEMA_NORMALIZE_MAX_DEPTH) return void 0;
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	const alternatives = [];
	let sawBranch = false;
	for (const key of [
		"allOf",
		"anyOf",
		"oneOf"
	]) {
		const branches = node[key];
		if (!Array.isArray(branches)) continue;
		const objectBranches = [];
		for (const branch of branches) {
			if (!isRecord(branch)) continue;
			objectBranches.push(toolParametersSchema(branch, depth + 1));
		}
		if (objectBranches.length === 0) continue;
		sawBranch = true;
		const names = objectBranches.map(requiredNames);
		if (key === "allOf") for (const name of names.flat()) required.add(name);
		else if (names.length > 0) alternatives.push(names[0].filter((name) => names.every((list) => list.includes(name))));
		for (const branch of objectBranches) {
			const branchProperties = isRecord(branch.properties) ? branch.properties : {};
			for (const [name, schema] of Object.entries(branchProperties)) if (!(name in properties)) properties[name] = schema;
		}
	}
	if (!sawBranch) return void 0;
	for (const group of alternatives) for (const name of group) required.add(name);
	const merged = {
		type: "object",
		properties
	};
	if (required.size > 0) merged.required = [...required];
	if (node.additionalProperties !== void 0) merged.additionalProperties = node.additionalProperties;
	for (const key of ["description", "title"]) if (node[key] !== void 0) merged[key] = node[key];
	return merged;
}
/**
* Normalize one tool's parameters schema to an object-rooted JSON Schema.
* A schema that already declares an object root is passed through untouched;
* a type-less object-shaped one gains the type; a root `$ref` or combinator is
* resolved/merged; anything else (an array/scalar root, or no schema at all)
* degrades to a permissive free-form object, because a request the provider
* refuses helps no one and the tool's own description is still in the prompt.
* Only the root is touched and every path returns a copy: the harness may
* deep-freeze the caller's schema.
*/
function toolParametersSchema(parameters, depth = 0) {
	if (!isRecord(parameters)) return {
		type: "object",
		properties: {},
		additionalProperties: true
	};
	if (parameters.type === "object") return parameters;
	if (Array.isArray(parameters.type) && parameters.type.includes("object")) return {
		...parameters,
		type: "object"
	};
	if (parameters.type === void 0 || parameters.type === null) {
		if (typeof parameters.$ref === "string" && depth < SCHEMA_NORMALIZE_MAX_DEPTH) {
			const target = resolveLocalRef(parameters, parameters.$ref);
			if (target !== void 0) {
				const { $ref: _ref, ...rest } = parameters;
				return toolParametersSchema({
					...target,
					...rest
				}, depth + 1);
			}
		}
		if (isObjectShaped(parameters)) return {
			...parameters,
			type: "object"
		};
		const merged = mergeCombinatorBranches(parameters, depth);
		if (merged !== void 0) return merged;
		if (typeof parameters.$ref === "string") return {
			...parameters,
			type: "object"
		};
	}
	return {
		type: "object",
		properties: {},
		additionalProperties: true
	};
}
function projectSlugFromPath(pathName) {
	return pathName.toLowerCase().replace(/^[a-z]:/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|(?<!-)-+$/g, "") || "project";
}
/** Extract the key from the CLI's nested credential records (`command-code`). */
function apiKeyFromCredentialRecord(value) {
	if (!isRecord(value)) return void 0;
	const type = stringValue(value.type);
	if (type === "api") return stringValue(value.key);
	if (type === "oauth") return stringValue(value.access);
	return stringValue(value.key) ?? stringValue(value.access);
}
/** Read a usable Command Code credential from the official CLI auth file. */
function resolveAuthFileApiKey() {
	const authPath = join(homedir(), ".commandcode", "auth.json");
	try {
		if (!existsSync(authPath)) return void 0;
		const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
		if (!isRecord(parsed)) return void 0;
		const direct = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode);
		if (direct) return direct;
		return apiKeyFromCredentialRecord(parsed.commandcode) ?? apiKeyFromCredentialRecord(parsed["command-code"]);
	} catch {}
}
/**
* The tool result one message answers, or undefined when it answers none.
*
* The harness models a tool result as its own `role: 'tool'` message carrying
* `toolCallId`/`isError` beside raw content blocks (`MessageRoleMap.tool` is
* the only role a tool result can arrive on). Pairing and emission MUST agree
* on this same view, or a dropped result either drops its call too (making the
* model forget completed work) or leaves an unanswered call on the wire.
*/
function toolResultOf(message) {
	if (message.role !== "tool") return void 0;
	const { toolCallId, content } = message;
	if (typeof toolCallId !== "string" || toolCallId === "") return void 0;
	return {
		toolCallId,
		isError: message.isError ?? false,
		content
	};
}
/**
* Collect the tool calls that have a paired tool result, plus each call's
* name. The name map feeds the `toolName` of replayed tool results: some
* backends (e.g. Google Gemini `functionResponse`) reject a result whose
* function name is empty, so the real name must round-trip (the official
* CLI does the same via its `tool_use_id -> toolName` map).
*/
function pairedToolCalls(messages) {
	const callIds = /* @__PURE__ */ new Set();
	const names = /* @__PURE__ */ new Map();
	const resultIds = /* @__PURE__ */ new Set();
	for (const message of messages) {
		const result = toolResultOf(message);
		if (result) resultIds.add(result.toolCallId);
		for (const block of message.content) if (message.role === "assistant" && block.type === "tool-call") {
			callIds.add(block.id);
			names.set(block.id, block.name);
		}
	}
	return {
		ids: new Set([...callIds].filter((id) => resultIds.has(id))),
		names
	};
}
/**
* The Command Code gateway rejects tool call ids longer than 64 characters
* (`input[N].call_id` must be `<= 64`, issue #23). Cross-provider histories
* can carry longer ids — e.g. switching to Command Code mid-session after
* another provider issued the call — so overlong paired ids are remapped to
* short per-request aliases. Correlation only needs to hold within one
* request (each call travels with its result in the same body), so a
* sequential alias is enough: no durable state, and the harness log keeps the
* original ids.
*/
const MAX_WIRE_TOOL_CALL_ID_LENGTH = 64;
/**
* Map each paired tool-call id to its wire id: ids within the gateway limit
* pass through verbatim, overlong ids get a collision-free `cc-<n>` alias.
* Callers must resolve BOTH the tool-call and its paired tool-result through
* the returned map so the pair stays correlated.
*/
function wireToolCallIds(paired) {
	const wire = /* @__PURE__ */ new Map();
	const taken = /* @__PURE__ */ new Set();
	for (const id of paired) if (id.length <= MAX_WIRE_TOOL_CALL_ID_LENGTH) {
		wire.set(id, id);
		taken.add(id);
	}
	let seq = 1;
	for (const id of paired) {
		if (wire.has(id)) continue;
		let alias = `cc-${seq++}`;
		while (taken.has(alias)) alias = `cc-${seq++}`;
		wire.set(id, alias);
		taken.add(alias);
	}
	return wire;
}
function blockText(block) {
	return block.type === "text" || block.type === "reasoning" ? block.text : "";
}
/**
* Collect text and nested images of one tool result. The harness `read_image`
* tool returns both, so dropping the image half is what made a tool-read image
* invisible to a Vision model (issue #30); deduplication keeps a result that
* repeats one attachment from paying for the same pixels twice.
*/
function toolResultMedia(block) {
	const chunks = [];
	const images = [];
	const seen = /* @__PURE__ */ new Set();
	for (const nested of block.content) {
		if (nested.type === "text" || nested.type === "reasoning") {
			if (nested.text) chunks.push(nested.text);
			continue;
		}
		if (nested.type === "image" && !seen.has(nested.attachment.attachmentId)) {
			seen.add(nested.attachment.attachmentId);
			images.push(nested.attachment);
		}
	}
	return {
		text: chunks.join("\n"),
		images
	};
}
/**
* Result text for the wire's `role: 'tool'` message. A tool that returned only
* an image (and possibly a nested image-only tool result) has no text at all,
* and neither transport accepts an empty tool content string, so it gets a
* descriptor pointing at the user message that follows with the pixels.
*/
function toolResultTextForWire(media) {
	return media.text || (media.images.length > 0 ? "(image returned; see the attached image)" : "");
}
/** Leading line of the user message that carries a tool result's images. */
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result";
/**
* The model-visible note introducing the images carried out of one tool
* result. Neither transport merges them back into the tool result, so this
* line is what tells the model the image it is about to see belongs to the
* tool it just ran rather than to the user; it also leads the part list,
* because an image-first content array is what some gateways reject.
*
* The note names the tool call the image came out of: a turn's carriers are
* emitted as a group after the whole tool group (issue #33), so position
* cannot carry the association — and every `read_image` result renders the
* same envelope text, so two parallel calls would produce two identical
* notes. The id is the WIRE id, the one the model saw on the `tool-call` and
* on the tool message just above, so an overlong cross-provider id is named
* by the alias that replaced it. Count and pixel dimensions are appended
* when the tool's own text does not already state them.
*/
function toolResultImageNote(media, toolCallId) {
	const lead = `${TOOL_RESULT_IMAGE_TEXT} (${toolCallId}):`;
	const first = media.images[0];
	if (first === void 0) return lead;
	const dimensions = `${first.width}x${first.height} px`;
	if (first.width <= 0 || first.height <= 0 || media.text.includes(dimensions)) return lead;
	return `${lead} ${media.images.length > 1 ? `${media.images.length} images, ` : ""}${dimensions}`;
}
function hasImageContent(message) {
	return message.content.some((block) => block.type === "image");
}
/** The budget ladder: the primary rung first, the 413 eviction rung second. */
const REQUEST_IMAGE_BUDGETS = [{
	maxBytes: 33554432,
	maxImages: 60,
	byteQuantum: 16777216,
	countQuantum: 30
}, {
	maxBytes: 8388608,
	maxImages: 12,
	byteQuantum: 8388608,
	countQuantum: 12
}];
/** The engine's own helpers: what a process that injects nothing speaks. */
const ENGINE_IMAGE_POLICY = {
	projectOffloadedImages,
	requiredImageOffload
};
/**
* The failure a route raises instead of evicting on its own. The count is the
* ONE thing the harness needs: `dsh-compaction-image-offload` records it as an
* `image/offload` event, marks that many oldest retained occurrences, and
* retries the step.
*
* Deliberately outside `providerRetryPolicy()`'s whitelist: a byte-identical
* resend cannot succeed, so the retry belongs to the surface mutation, not to
* dsh-llm-retry. On a profile that does not mount that plugin the failure is
* terminal — every shipped profile reaches it through dsh-base.
*/
function imageOffloadRequired(missing, reason = "budget") {
	const options = { offloadImages: missing };
	return new LlmError(reason === "cache" ? `commandcode cache-aware image history: ${missing} already-seen oldest image occurrence(s) must be offloaded before replay.` : `commandcode request images exceed the route budget; ${missing} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, options);
}
/** The budget in the shape the core counter takes (representation + the rung). */
function coreBudget(budget) {
	return {
		representation: "base64",
		...budget
	};
}
/**
* Exact request-version bytes of one retained occurrence. The declared
* normalized size IS what this adapter inlines (the body is built from
* `attachments.readImage`, base64-encoded), so the accounting matches the wire
* byte for byte, and the core helper expands it for `base64` on its own.
*/
const imageVersionBytes = (block) => block.attachment.bytes;
/**
* Request options under one budget rung: the surface's durable marks become
* placeholder text, and an over-budget history FAILS with the count to offload
* instead of being evicted here. Throws rather than returning, so no caller can
* accidentally send a body this route already knows is too large.
*
* The next rung is applied to the CURRENT projection, never to the raw history —
* otherwise the 413 retry could reintroduce images the first rung had already
* evicted.
*/
function withSurfaceOffload(options, policy, budget, cacheOffloadModel) {
	const marked = policy.projectOffloadedImages(options.messages, (ref) => offloadedImageText(ref));
	const messages = marked === options.messages ? options.messages : [...marked];
	const budgetMissing = policy.requiredImageOffload(messages, coreBudget(budget), imageVersionBytes);
	const cacheMissing = cacheOffloadModel === void 0 ? 0 : seenImageOffloadCount(messages, cacheOffloadModel);
	const missing = Math.max(budgetMissing, cacheMissing);
	if (missing > 0) throw imageOffloadRequired(missing, cacheMissing > budgetMissing ? "cache" : "budget");
	return messages === options.messages ? options : {
		...options,
		messages
	};
}
/**
* Count retained images already followed by an answer from this same model.
* The current tool result's image has not yet been seen by the model and must
* stay on the wire. The engine can only offload durable user/tool input nodes;
* assistant output and request-only input have no selectable surface event.
*/
function seenImageOffloadCount(messages, model) {
	let lastAnswer = -1;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant" && message.source.kind === "model" && message.source.provider === "commandcode" && message.source.model === model) lastAnswer = index;
	}
	if (lastAnswer < 0) return 0;
	let count = 0;
	for (let index = 0; index < lastAnswer; index++) {
		const message = messages[index];
		if (message.role !== "user" && message.role !== "tool" || message.id === void 0) continue;
		for (const block of message.content) if (block.type === "image") count++;
	}
	return count;
}
/**
* One image's bytes for the wire: the attachment service's REQUEST VERSION.
*
* `readImage()` answers the stored original, which is what admission accepted —
* not what a provider request should carry. `readImageRequest()` re-encodes to
* the route target in `./image-request.ts` and caches the result under it, so
* the same attachment costs one encode per target instead of one per occurrence,
* and the base64 the wire expands is bounded (both the pixel budget and, more to
* the point here, the encoded bytes).
*/
async function readRequestImage(attachments, ref) {
	return attachments.readImageRequest(ref, requestImageTarget(ref));
}
/** 同一次生成及其协议切换共享图片读取，最多同时准备四张，避免内存峰值失控。 */
function requestImages(attachments, signal, timing) {
	const cache = /* @__PURE__ */ new Map();
	const read = (ref) => {
		signal?.throwIfAborted();
		const key = JSON.stringify([ref.attachmentId, requestImageTarget(ref)]);
		let pending = cache.get(key);
		if (!pending) {
			pending = readRequestImage(attachments, ref);
			cache.set(key, pending);
		}
		return pending;
	};
	read.prepare = async (refs) => {
		if (refs.length === 0) return;
		const finishImages = timing.phase("images");
		let cursor = 0;
		try {
			const workers = Array.from({ length: Math.min(4, refs.length) }, async () => {
				while (cursor < refs.length) {
					signal?.throwIfAborted();
					await read(refs[cursor++]);
				}
			});
			const failure = (await Promise.allSettled(workers)).find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		} finally {
			finishImages();
		}
	};
	return read;
}
/**
* Price one request occurrence.
*
* Two cases cost no vision tokens at all, and both are priced as their
* model-visible TEXT so the caller's estimator can charge that instead (which
* is what stops the meter counting an evicted image as context): a model that
* accepts text only (the harness projects those images to placeholder text
* before the request), and an occurrence the session surface has already
* offloaded (the same placeholder text rides in every later request). A retained
* occurrence on this route contributes no text at all — the pixels are inlined —
* so its price is the family's visual-token count and nothing else.
*/
function priceRequestImage(block, model, imageCapable) {
	const ref = block.attachment;
	if (!imageCapable) return {
		visualTokens: 0,
		text: textOnlyImageText(ref)
	};
	if (block.offloaded === true) return {
		visualTokens: 0,
		text: offloadedImageText(ref)
	};
	const target = requestImageTarget(ref);
	return {
		visualTokens: commandCodeImageTokens(model, target.width, target.height),
		text: ""
	};
}
/**
* Convert one image reference to the final `/alpha/generate` wire format.
* The official CLI accepts a base64 source internally, then toWireMessages()
* sends a data URL plus mimeType. Use the request version's media type because
* readImageRequest() can transcode the stored image to JPEG or WebP.
*/
async function imageToCommandCode(ref, readImage) {
	const version = await readImage(ref);
	return {
		type: "image",
		image: `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}`,
		mimeType: version.mediaType
	};
}
/**
* The signature recorded for the reasoning block at `position` of a
* historical assistant message, or undefined when the message was produced
* by another route or an older plugin version.
*/
function messagesSignatureAt(message, position) {
	const replay = message.source?.replayState;
	if (!isRecord(replay) || !Array.isArray(replay.blocks)) return void 0;
	const entry = replay.blocks[position];
	return isRecord(entry) ? stringValue(entry.signature) : void 0;
}
/**
* The common pairing and image-carrier ordering for both transports. Each
* codec owns its wire shape: CLI content blocks and Chat Completions
* reasoning/tool calls differ beyond the image envelope.
*/
async function convertMessages(messages, readImage, codec) {
	const out = [];
	const { ids: paired, names: toolNames } = pairedToolCalls(messages);
	if (readImage?.prepare) {
		const refs = [];
		for (const message of messages) {
			const result = toolResultOf(message);
			if (message.role === "user" && !result) {
				for (const block of message.content) if (block.type === "image") refs.push(block.attachment);
			} else if (result && paired.has(result.toolCallId)) refs.push(...toolResultMedia(result).images);
		}
		await readImage.prepare(refs);
	}
	const wireIds = wireToolCallIds(paired);
	const pendingImages = [];
	const flushPendingImages = () => {
		for (const message of pendingImages) out.push(message);
		pendingImages.length = 0;
	};
	const encodeImage = (ref) => {
		if (!readImage) throw new LlmError("Image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
		return codec.encodeImage(ref, readImage);
	};
	for (const message of messages) {
		if (message.role === "system") continue;
		const result = toolResultOf(message);
		if (message.role === "user" && !result) {
			flushPendingImages();
			const parts = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push({
					type: "text",
					text: block.text
				});
				if (block.type === "image") parts.push(await encodeImage(block.attachment));
			}
			if (parts.length > 0) out.push(codec.encodeUser(parts));
			continue;
		}
		if (message.role === "assistant") {
			flushPendingImages();
			const assistant = codec.encodeAssistant(message, paired, wireIds);
			if (assistant !== void 0) out.push(assistant);
			continue;
		}
		if (!result || !paired.has(result.toolCallId)) continue;
		const media = toolResultMedia(result);
		const wireId = wireIds.get(result.toolCallId) ?? result.toolCallId;
		out.push(await codec.encodeTool(result, media, wireId, toolNames.get(result.toolCallId) || "unknown", readImage));
		if (!codec.carriesToolResultMedia && media.images.length > 0) {
			const carried = [{
				type: "text",
				text: toolResultImageNote(media, wireId)
			}];
			for (const attachment of media.images) carried.push(await encodeImage(attachment));
			pendingImages.push(codec.encodeUser(carried));
		}
	}
	flushPendingImages();
	return out;
}
const ccMessageCodec = {
	carriesToolResultMedia: false,
	encodeImage: imageToCommandCode,
	encodeUser: (parts) => ({
		role: "user",
		content: parts
	}),
	encodeAssistant: (message, paired, wireIds) => {
		const parts = [];
		for (const block of message.content) if (block.type === "text") parts.push({
			type: "text",
			text: block.text
		});
		else if (block.type === "reasoning") parts.push({
			type: "reasoning",
			text: block.text
		});
		else if (block.type === "tool-call" && paired.has(block.id)) parts.push({
			type: "tool-call",
			toolCallId: wireIds.get(block.id) ?? block.id,
			toolName: block.name,
			input: recordOrEmpty(block.arguments)
		});
		return parts.length > 0 ? {
			role: "assistant",
			content: parts
		} : void 0;
	},
	encodeTool: (result, media, wireId, toolName) => ({
		role: "tool",
		content: [{
			type: "tool-result",
			toolCallId: wireId,
			toolName,
			output: result.isError ? {
				type: "error-text",
				value: toolResultTextForWire(media)
			} : {
				type: "text",
				value: toolResultTextForWire(media)
			}
		}]
	})
};
async function messagesToCC(messages, readImage) {
	return convertMessages(messages, readImage, ccMessageCodec);
}
/**
* Convert one image reference to the OpenAI Chat Completions wire format:
* `{ type: 'image_url', image_url: { url: 'data:...;base64,...' } }`.
*/
async function imageToOpenAI(ref, readImage) {
	const version = await readImage(ref);
	return {
		type: "image_url",
		image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}` }
	};
}
/**
* Convert harness messages to the OpenAI Chat Completions request shape.
*
* Unlike the Command Code CLI transport, this transport is the documented
* Provider API surface. DeepSeek's thinking-mode contract requires historical
* `reasoning_content` to be passed back whenever tools are in play, so this
* converter intentionally DOES replay reasoning blocks as `reasoning_content`
* on assistant messages. Only tool calls with a paired tool result are
* replayed (same policy as the CLI path).
*/
const openAiMessageCodec = {
	carriesToolResultMedia: false,
	encodeImage: imageToOpenAI,
	encodeUser: (parts) => {
		return !parts.some((part) => part.type === "image_url") && parts.length === 1 ? {
			role: "user",
			content: parts[0].text
		} : {
			role: "user",
			content: parts
		};
	},
	encodeAssistant: (message, paired, wireIds) => {
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
		const toolCalls = message.content.filter((block) => block.type === "tool-call" && paired.has(block.id)).map((block) => ({
			id: wireIds.get(block.id) ?? block.id,
			type: "function",
			function: {
				name: block.name,
				arguments: block.arguments
			}
		}));
		if (text === "" && reasoning === "" && toolCalls.length === 0) return void 0;
		const assistant = {
			role: "assistant",
			content: text === "" ? null : text
		};
		if (reasoning !== "") assistant.reasoning_content = reasoning;
		if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
		return assistant;
	},
	encodeTool: (_result, media, wireId) => ({
		role: "tool",
		tool_call_id: wireId,
		content: toolResultTextForWire(media)
	})
};
async function messagesToOpenAI(messages, readImage) {
	return convertMessages(messages, readImage, openAiMessageCodec);
}
/**
* Convert one image reference to the Messages wire shape. Unlike the other two
* transports this one keeps the native media type rather than a data URL, and
* it may be used INSIDE a tool result — `tool_result.content` accepts image
* blocks, which is why this codec sets `carriesToolResultMedia`.
*/
async function imageToMessages(ref, readImage) {
	const version = await readImage(ref);
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: version.mediaType,
			data: Buffer.from(version.data).toString("base64")
		}
	};
}
/** A tool call's `arguments` is a raw JSON string in the harness, an object here. */
function parseToolArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/**
* Convert harness messages to the Anthropic Messages request shape.
*
* Differences from the other two transports, all measured against the live
* endpoint on 2026-09-29:
*
* - Content is always a block array; there is no string shorthand, so a
*   single-text user turn is still `{ role: 'user', content: [{type:'text'…}] }`.
* - Tool results live in a `user` turn as `tool_result` blocks (not a
*   `role: 'tool'` message) and may carry images natively, so no image is
*   split into a separate user message here.
* - A replayed `thinking` block is only valid WITH its `signature`: the
*   endpoint answers `thinking.signature: Field required` without it, and
*   `each thinking block must contain thinking` when the text is empty and
*   the signature is blank. A reasoning block with no recorded signature is
*   therefore dropped rather than sent — replaying it would fail the request,
*   while omitting it is accepted (verified 200 both ways).
* - The conversation must end with a user turn; the endpoint refuses an
*   assistant prefill (`This model does not support assistant message
*   prefill`), which `convertMessages` already guarantees for a tool loop.
*/
const messagesMessageCodec = {
	carriesToolResultMedia: true,
	encodeImage: imageToMessages,
	encodeUser: (parts) => ({
		role: "user",
		content: parts
	}),
	encodeAssistant: (message, paired, wireIds) => {
		const parts = [];
		let position = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				parts.push({
					type: "text",
					text: block.text
				});
				position++;
				continue;
			}
			if (block.type === "reasoning") {
				const signature = messagesSignatureAt(message, position);
				if (signature !== void 0) parts.push({
					type: "thinking",
					thinking: block.text,
					signature
				});
				position++;
				continue;
			}
			if (block.type === "tool-call" && paired.has(block.id)) {
				parts.push({
					type: "tool_use",
					id: wireIds.get(block.id) ?? block.id,
					name: block.name,
					input: parseToolArguments(block.arguments)
				});
				position++;
			}
		}
		return parts.length > 0 ? {
			role: "assistant",
			content: parts
		} : void 0;
	},
	encodeTool: async (result, media, wireId, _toolName, readImage) => {
		const content = [];
		if (readImage) for (const attachment of media.images) content.push(await imageToMessages(attachment, readImage));
		content.push({
			type: "text",
			text: toolResultTextForWire(media)
		});
		const toolResult = {
			type: "tool_result",
			tool_use_id: wireId,
			content
		};
		if (result.isError) toolResult.is_error = true;
		return {
			role: "user",
			content: [toolResult]
		};
	}
};
async function messagesToMessages(messages, readImage) {
	return convertMessages(messages, readImage, messagesMessageCodec);
}
/** Account endpoints fetched by one `getUsage()` run (see the classification there). */
const USAGE_ENDPOINT_COUNT = 4;
/**
* Parse one usage/summary payload into the report's usage section.
* Returns undefined when the endpoint answered nothing usable.
*/
function parseUsageTotals(usage) {
	if (usage === void 0) return void 0;
	return {
		totalCount: numberValue(usage.totalCount) ?? 0,
		totalCost: numberValue(usage.totalCost) ?? 0,
		successRate: numberValue(usage.successRate) ?? 0,
		completedCount: numberValue(usage.completedCount) ?? 0,
		failedCount: numberValue(usage.failedCount) ?? 0,
		totalTokensIn: numberValue(usage.totalTokensIn) ?? 0,
		totalTokensOut: numberValue(usage.totalTokensOut) ?? 0,
		totalCredits: numberValue(usage.totalCredits) ?? 0,
		periodBasis: stringValue(usage.periodBasis) ?? "billing-period"
	};
}
/**
* Parse one window block into a window limit, or undefined when the endpoint
* reported no such window.
*
* Returning undefined (rather than a zeroed window) is load-bearing: the panel
* must not draw a quota row for a window the account never reported, and a
* zeroed window is indistinguishable from a genuinely uncapped one.
*/
function parseWindowLimit(value) {
	const block = isRecord(value) ? value : void 0;
	if (block === void 0) return void 0;
	return {
		used: numberValue(block.used) ?? 0,
		cap: numberValue(block.cap) ?? 0,
		exceeded: block.exceeded === true,
		resetAt: numberValue(block.resetAt) ?? 0
	};
}
/**
* Parse one billing/credits payload into the report's credits section.
* Returns undefined when the endpoint answered nothing usable.
*/
function parseCreditLimits(credits) {
	if (credits === void 0) return void 0;
	const creditsData = isRecord(credits.credits) ? credits.credits : void 0;
	const windowLimits = isRecord(credits.windowLimits) ? credits.windowLimits : void 0;
	const fiveHour = windowLimits !== void 0 && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : void 0;
	const weekly = windowLimits !== void 0 && isRecord(windowLimits.weekly) ? windowLimits.weekly : void 0;
	if (creditsData === void 0 && fiveHour === void 0 && weekly === void 0) return void 0;
	const parsed = {
		monthlyCredits: numberValue(creditsData?.monthlyCredits) ?? 0,
		purchasedCredits: numberValue(creditsData?.purchasedCredits) ?? 0,
		freeCredits: numberValue(creditsData?.freeCredits) ?? 0,
		monthlyReported: numberValue(creditsData?.monthlyCredits) !== void 0,
		purchasedReported: numberValue(creditsData?.purchasedCredits) !== void 0,
		freeReported: numberValue(creditsData?.freeCredits) !== void 0
	};
	const fiveHourLimit = parseWindowLimit(fiveHour);
	const weeklyLimit = parseWindowLimit(weekly);
	if (fiveHourLimit !== void 0) parsed.fiveHour = fiveHourLimit;
	if (weeklyLimit !== void 0) parsed.weekly = weeklyLimit;
	return parsed;
}
/**
* Parse the account identity from whoami plus the plan identity from the
* subscriptions/credits payloads. Returns the org id for the subscriptions
* query alongside, so getUsage fetches whoami first and the rest in parallel.
*/
function parseAccountIdentity(whoami) {
	const whoamiData = whoami !== void 0 && isRecord(whoami.user) ? whoami.user : void 0;
	const orgData = whoami !== void 0 && isRecord(whoami.org) ? whoami.org : void 0;
	return {
		account: whoamiData === void 0 ? void 0 : {
			id: stringValue(whoamiData.id) ?? "",
			name: stringValue(whoamiData.name) ?? "",
			userName: stringValue(whoamiData.userName) ?? ""
		},
		orgId: orgData === void 0 ? void 0 : stringValue(orgData.id)
	};
}
function classifyTotalFailure(failures, failed) {
	if (failures.length !== USAGE_ENDPOINT_COUNT) return void 0;
	if (failed.every((item) => item.kind === "http" && item.status === 401)) return "invalid-key";
	if (failed.every((item) => item.kind === "http" && item.status >= 500)) return "service-unavailable";
	if (failed.every((item) => item.kind === "invalid-response")) return "invalid-response";
	if (failed.every((item) => item.kind === "transport")) return "network";
}
/** UUID shape accepted by the official CLI's `toWireThreadId` helper. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
/**
* Map the harness session identity to the CLI transport's UUID thread ID.
*
* The official CLI creates one thread ID per agent run and reuses it for the
* tool-loop requests that follow. DSH stamps its loop-owned session ID onto
* GenerateOptions, but ordinary IDs are `session-<UUID>`, not bare UUIDs.
* UUIDv5 gives every non-UUID session ID a stable, wire-compatible mapping.
* An already valid UUID remains unchanged; a one-shot call without a session
* ID still gets a fresh thread ID.
* This alone does not establish cache affinity (issue #64's A/B found none).
*/
function cliThreadId(sessionId) {
	if (!sessionId) return randomUUID();
	if (UUID_PATTERN.test(sessionId)) return sessionId;
	const digest = createHash("sha1").update(THREAD_ID_NAMESPACE).update("dsh-commandcode-provider/session/").update(sessionId).digest();
	digest[6] = digest[6] & 15 | 80;
	digest[8] = digest[8] & 63 | 128;
	const hex = digest.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
* The CLI wire's explicit system-section form.
*
* The official CLI's current transport sends system text as an array and marks
* stable sections with Anthropic-compatible ephemeral cache control. DSH's
* adapter has one already-folded system string rather than the CLI's internal
* section list, so preserve that text as one cacheable section. This does not
* recover the CLI's separate static/dynamic boundaries or guarantee a hit.
*/
function cliSystem(systemText) {
	if (!systemText) return "";
	return [{
		type: "text",
		text: systemText,
		cache_control: { type: "ephemeral" }
	}];
}
/**
* The Anthropic ephemeral cache marker, shared by every breakpoint this route
* sets. One object is reused across positions because it is only ever
* serialized, never mutated.
*
* No `ttl` is sent: the default 5-minute entry covers a continuously advancing
* session, and `ttl: "1h"` is a separate billable tier whose read/write prices
* are identical — it would only lengthen survival, not reduce cost.
*/
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" };
/**
* Content-block types that may carry the rolling breakpoint. Matches what the
* official Command Code provider for pi marks through
* `@earendil-works/pi-ai`'s `anthropic-messages` transport (its own list also
* holds pi-internal `tool_addition` / `tool_removal`, which this route never
* emits). Assistant-side blocks are deliberately excluded: a breakpoint on a
* `thinking` or `tool_use` block caches a prefix the next turn invalidates.
*/
const CACHEABLE_BLOCK_TYPES = /* @__PURE__ */ new Set([
	"text",
	"image",
	"tool_result"
]);
/**
* Mark the last user turn as the rolling cache breakpoint.
*
* Anthropic caching is explicit — a prefix is stored only when a
* `cache_control` marker names it — so an unmarked route re-prefills the whole
* replayed history at the full input price on every turn. Measured cost of that
* omission on a 10-turn session: $0.5648, all of it at the undiscounted
* $2/M input rate, against $0.1869 with the three breakpoints this route sets.
*
* The final user message is the rolling boundary: DSH resends the whole
* history each turn, so a marker here grows with the conversation, whereas a
* fixed `system`-only marker would leave every later turn's history
* uncached. {@link messagesMessageCodec} renders both user input and tool
* results as `role: 'user'`, so this covers a tool loop's trailing turn too.
*/
function markLastUserCacheControl(messages) {
	const last = messages[messages.length - 1];
	if (!isRecord(last) || last.role !== "user" || !Array.isArray(last.content)) return;
	const lastBlock = last.content[last.content.length - 1];
	if (isRecord(lastBlock) && typeof lastBlock.type === "string" && CACHEABLE_BLOCK_TYPES.has(lastBlock.type)) lastBlock.cache_control = EPHEMERAL_CACHE_CONTROL;
}
/** Build the legacy CLI (`/alpha/generate`) request body for one call. */
async function buildCliBody(options, connection, facts) {
	return {
		config: {
			workingDir: connection.workingDir,
			date: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
			environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: []
		},
		memory: null,
		taste: null,
		skills: null,
		permissionMode: "standard",
		params: {
			model: options.model,
			messages: await messagesToCC(options.messages, facts.readImage),
			tools: (options.tools ?? []).map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				input_schema: toolParametersSchema(tool.parameters)
			})),
			system: cliSystem(facts.systemText),
			max_tokens: facts.maxTokens,
			temperature: options.temperature ?? .3,
			stream: true,
			...facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}
		},
		threadId: cliThreadId(options.sessionId)
	};
}
/** Build the documented Provider Chat Completions request body for one call. */
async function buildOpenAIBody(options, facts) {
	const openAiMessages = [...facts.systemText ? [{
		role: "system",
		content: facts.systemText
	}] : [], ...await messagesToOpenAI(options.messages, facts.readImage)];
	const openAiTools = (options.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: toolParametersSchema(tool.parameters)
		}
	}));
	return {
		model: options.model,
		messages: openAiMessages,
		...openAiTools.length > 0 ? { tools: openAiTools } : {},
		max_tokens: facts.maxTokens,
		temperature: options.temperature ?? .3,
		stream: true,
		...facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}
	};
}
/**
* Build the Anthropic Messages request body for one call.
*
* Measured deviations from DeepSeek's own Messages API (the shape
* `dsh-llm-deepseek` implements), all confirmed on 2026-09-29:
*
* - `thinking` accepts ONLY `{ type: 'adaptive' }` here. `enabled` and
*   `disabled` are refused with `"thinking.type.enabled" is not supported for
*   this model. Use "thinking.type.adaptive" and "output_config.effort" to
*   control thinking behavior.`, and a `between_tools` value fails validation
*   outright. The model reasons on its own; this switch only admits it.
* - Reasoning strength travels in `output_config.effort`, whose accepted
*   values are `low | medium | high | xhigh | max` — there is no `none`, and
*   `xhigh` is absent from DeepSeek's own type.
* - `stop_sequences` is a real field here, but this adapter still rejects
*   `GenerateOptions.stop` in `stream()` because Command Code documents no
*   equivalent for the other two transports.
* - **`temperature` is never sent.** Adaptive thinking constrains it to 1:
*   `` `temperature` may only be set to 1 when thinking is enabled or in
*   adaptive mode `` (measured 2026-09-29 — every request carrying the other
*   transports' 0.3 default was refused with HTTP 400). Omitting the field
*   is the only way to honour both the thinking switch and a caller that
*   asked for a temperature, so Claude loses sampling control on this route
*   because the endpoint, not this adapter, removed it.
* - `system` travels as a one-block ARRAY carrying `cache_control`, not as the
*   bare string the other two transports send. Anthropic's caching is opt-in
*   per block, and this route is the only Claude path, so the marker is what
*   makes a session's replayed history bill at the cache-read rate instead of
*   the full input rate. See {@link EPHEMERAL_CACHE_CONTROL}.
*/
async function buildMessagesBody(options, facts) {
	const body = {
		model: options.model,
		max_tokens: facts.maxTokens,
		stream: true,
		messages: await messagesToMessages(options.messages, facts.readImage)
	};
	if (facts.selectableEffort) body.thinking = { type: "adaptive" };
	if (facts.systemText) body.system = [{
		type: "text",
		text: facts.systemText,
		cache_control: EPHEMERAL_CACHE_CONTROL
	}];
	if (facts.reasoningEffort) body.output_config = { effort: facts.reasoningEffort };
	const tools = (options.tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: toolParametersSchema(tool.parameters)
	}));
	if (tools.length > 0) {
		tools[tools.length - 1].cache_control = EPHEMERAL_CACHE_CONTROL;
		body.tools = tools;
	}
	markLastUserCacheControl(body.messages);
	return body;
}
/**
* One connect attempt's inputs: everything `connectGenerate` needs beyond
* the per-attempt key and protocol. Passed explicitly (not closed over) so
* the rotation loop's mutation of `protocol`/`body` stays visible at the
* call site.
*/
/** The generate endpoint one protocol posts to. */
function protocolEndpoint(protocol, apiBase) {
	if (protocol === "cli") return `${apiBase}/alpha/generate`;
	return protocol === "messages" ? `${apiBase}/provider/v1/messages` : `${apiBase}/provider/v1/chat/completions`;
}
/** 错误正文只供诊断与分类使用，不能让坏网关占满内存或无限拖住重试。 */
async function readGenerateErrorBody(response, abort, timeoutMs) {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	const limit = 65536;
	let removeAbort = () => void 0;
	const stopped = new Promise((resolve) => {
		if (abort.signal.aborted) resolve(void 0);
		else abort.signal.addEventListener("abort", onAbort, { once: true });
		function onAbort() {
			resolve(void 0);
		}
		removeAbort = () => abort.signal.removeEventListener("abort", onAbort);
	});
	const timer = setTimeout(() => abort.abort(), Math.min(timeoutMs, 3e4));
	try {
		while (bytes < limit) {
			const read = await Promise.race([reader.read(), stopped]);
			if (read === void 0 || read.done) break;
			const remaining = limit - bytes;
			text += decoder.decode(read.value.subarray(0, remaining), { stream: true });
			bytes += read.value.byteLength;
		}
		return text + decoder.decode();
	} catch {
		return text + decoder.decode();
	} finally {
		clearTimeout(timer);
		removeAbort();
		reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
/**
* One pre-stream connect attempt: POST the body and wait for response
* headers only (`requestTimeoutMs` must never bound the body stream). Returns
* the live response plus its cleanup, or the rejection facts for the rotation
* loop to classify. Every failure path cleans up before returning or throwing;
* on success the caller-abort listener outlives the connect phase (it aborts a
* stalled body read), so the streaming tail calls cleanup.
*/
async function connectGenerate(deps, key, protocol, serializedBody) {
	const { options, connection, fetchImpl } = deps;
	const connectAbort = new AbortController();
	let connectTimedOut = false;
	const endpoint = protocolEndpoint(protocol, connection.apiBase);
	const connectTimer = setTimeout(() => {
		connectTimedOut = true;
		connectAbort.abort(new DOMException(`Command Code API request to ${endpoint} did not respond within ${connection.requestTimeoutMs}ms`, "TimeoutError"));
	}, connection.requestTimeoutMs);
	const onCallerAbort = () => {
		connectAbort.abort(options.signal?.reason);
	};
	if (options.signal) {
		if (options.signal.aborted) onCallerAbort();
		else options.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const cleanup = () => {
		clearTimeout(connectTimer);
		if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
	};
	let response;
	const zdr = connection.zdr === true;
	const sharedHeaders = {
		"Content-Type": "application/json",
		...IDENTITY_ENCODING_HEADER,
		Authorization: `Bearer ${key}`,
		...zdr ? { "x-cmd-zdr": "1" } : {},
		...attributionHeaders()
	};
	const headers = protocol === "cli" ? {
		...sharedHeaders,
		"x-command-code-version": COMMAND_CODE_CLI_VERSION,
		"x-cli-environment": "production",
		"x-project-slug": projectSlugFromPath(connection.workingDir),
		"x-taste-learning": "false",
		"x-co-flag": "false"
	} : {
		...sharedHeaders,
		Accept: "text/event-stream"
	};
	const finishHeaders = deps.timing.attempt(protocol, Buffer.byteLength(serializedBody));
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: serializedBody,
			signal: connectAbort.signal
		});
		finishHeaders(response.status);
		clearTimeout(connectTimer);
	} catch (error) {
		finishHeaders();
		cleanup();
		if (options.signal?.aborted) throw error;
		if (connectTimedOut || error instanceof DOMException && error.name === "TimeoutError") throw headersTimeoutError({
			protocol,
			endpoint,
			body: serializedBody,
			timeoutMs: connection.requestTimeoutMs,
			cause: error
		});
		throw bilingual("TRANSPORT", `Command Code API request to ${endpoint} failed: ${errorChain(error)}`, "Command Code API 请求连接失败——通常是网络或代理问题，请检查网络或代理设置后重试", { cause: error });
	}
	deps.onResponse(response);
	if (!response.ok) {
		let errText;
		try {
			errText = await readGenerateErrorBody(response, connectAbort, connection.requestTimeoutMs);
			if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("已取消请求", "AbortError");
		} finally {
			cleanup();
		}
		const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
		return retryAfterMs === void 0 ? {
			status: response.status,
			errText
		} : {
			status: response.status,
			errText,
			retryAfterMs
		};
	}
	return {
		response,
		cleanup
	};
}
var CommandCodeAdapter = class CommandCodeAdapter extends LlmAdapter {
	deps;
	gatewayFacts = new GatewayFacts(async (source) => {
		const { status, record } = await this.fetchJson(`${source.apiBase}/provider/v1/models`, {
			accept: "application/json",
			...IDENTITY_ENCODING_HEADER,
			...attributionHeaders()
		}, MODELS_TIMEOUT_MS);
		if (status < 200 || status >= 300) throw new Error(`models endpoint returned ${status}`);
		return record;
	});
	fetchImpl;
	resolveAttachments;
	/**
	* The durable-offload contract, resolved once (tests may inject a stub). The
	* contract cannot change while the process runs.
	*/
	surfaceOffload;
	billingAccess = /* @__PURE__ */ new Map();
	billingAccessInflight = /* @__PURE__ */ new Map();
	protocolCache = /* @__PURE__ */ new Map();
	/** Namespace account-derived facts by gateway without exposing the key. */
	accountCacheKey(apiBase, apiKey) {
		return JSON.stringify([apiBase, apiKey]);
	}
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
	headerTimeoutStreaks = /* @__PURE__ */ new Map();
	static MAX_HEADER_TIMEOUT_STREAK_ENTRIES = 200;
	constructor(deps) {
		super();
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.resolveAttachments = deps.resolveAttachments;
		this.surfaceOffload = deps.imageOffload ?? ENGINE_IMAGE_POLICY;
	}
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
	gradeHeaderTimeout(error, protocol, body, timeoutMs, sessionId) {
		if (!(error instanceof LlmError && error.code === "TIMEOUT")) return error;
		const key = sessionId ?? GLOBAL_HEADER_TIMEOUT_KEY;
		const fingerprint = `${protocol}:${fingerprintValue(body).sha256}`;
		const previous = this.headerTimeoutStreaks.get(key);
		const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
		if (previous === void 0) {
			if (this.headerTimeoutStreaks.size >= CommandCodeAdapter.MAX_HEADER_TIMEOUT_STREAK_ENTRIES) {
				const oldest = this.headerTimeoutStreaks.keys().next().value;
				if (oldest !== void 0) this.headerTimeoutStreaks.delete(oldest);
			}
		} else this.headerTimeoutStreaks.delete(key);
		this.headerTimeoutStreaks.set(key, {
			fingerprint,
			count
		});
		if (count < MAX_CONSECUTIVE_HEADER_TIMEOUTS) return error;
		this.headerTimeoutStreaks.delete(key);
		return bilingual("PROVIDER_HTTP_ERROR", `Command Code API stopped retrying: the gateway returned no response headers on ${count} consecutive attempts at the same request, each after the full ${timeoutMs}ms budget, so this is not a network blip — it is provider queueing, a Go-plan capacity limit, or a network/proxy path problem. Resending the identical payload again is unlikely to help; wait for the provider to recover, or switch model or account.`, `Command Code API 已停止重试：同一请求连续 ${count} 次在 ${timeoutMs} 毫秒内都没有收到任何响应头，这不是网络抖动，而是服务商排队、Go 套餐容量限制或网络/代理链路问题。继续原样重发同一个请求通常无济于事——可以等服务商恢复，或换模型/换账号。`);
	}
	/**
	* Display metadata for the picker's provider group header. The base class
	* returns the raw route id (`commandcode`, all lowercase) as the name, which
	* is what the model selector shows as this group's sticky title; return the
	* proper display name instead, matching the Models settings page card (the
	* configurable-provider `displayName`). The id must stay equal to the route.
	*/
	providerInfo(provider) {
		return {
			id: provider,
			name: "Command Code"
		};
	}
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
	providerRetryPolicy(_provider) {
		return resolveRetryPolicy({
			mode: "normal",
			maxRetries: 1e3,
			retryableCodes: [
				"EMPTY_RESPONSE",
				"RATE_LIMIT",
				THROTTLED_CODE,
				"SERVER",
				"TIMEOUT",
				"TRANSPORT"
			],
			backoff: {
				initialDelayMs: 500,
				maxDelayMs: RETRY_MAX_DELAY_MS,
				jitterRatio: .1
			}
		}, "llm-commandcode: retryPolicy");
	}
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
	imageRequestPricing(_provider, model) {
		const imageCapable = KNOWN_IMAGE_MODELS.has(model);
		return { priceImages: (images) => images.map((image) => priceRequestImage(image, model, imageCapable)) };
	}
	async listModels(provider, opts) {
		const connection = { ...this.deps.options() };
		const catalog = await this.gatewayFacts.refresh(connection);
		const toInfo = (model) => {
			const vision = KNOWN_IMAGE_MODELS.has(model.id);
			return {
				provider,
				id: model.id,
				name: `${model.name} (CC)`,
				description: capabilityDescription(model.id, model.contextWindow),
				inputModalities: vision ? ["text", "image"] : ["text"]
			};
		};
		if (opts?.unfiltered === true) return catalog.map(toInfo).sort(compareByPlan);
		const accesses = connection.filterModelsByPlan === false ? void 0 : await this.loadPoolBillingAccess(connection);
		const visible = connection.visibleModels;
		const allow = Array.isArray(visible) ? visible.filter((id) => typeof id === "string" && id !== "") : [];
		const overrides = connection.modelVisibility;
		return catalog.filter((model) => modelVisibleForAnyAccount(model.id, accesses)).filter((model) => modelIsVisible(model.id, allow, overrides)).map(toInfo).sort(compareByPlan);
	}
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
	async allowanceTier() {
		const accesses = await this.loadPoolBillingAccess();
		if (accesses === void 0) return void 0;
		let highest;
		for (const access of accesses) {
			const weight = access?.tierWeight;
			if (weight === void 0) continue;
			if (highest === void 0 || weight > highest) highest = weight;
		}
		return allowanceTierForWeight(highest);
	}
	async resolveModel(provider, model, signal) {
		const connection = { ...this.deps.options() };
		const entry = this.gatewayFacts.knownModel(connection, model) ?? (await this.gatewayFacts.refresh(connection, signal)).find((m) => m.id === model);
		const efforts = KNOWN_EFFORTS[model];
		const vision = KNOWN_IMAGE_MODELS.has(model);
		return {
			provider,
			id: model,
			name: entry ? `${entry.name} (CC)` : model,
			description: capabilityDescription(model, entry?.contextWindow),
			inputModalities: vision ? ["text", "image"] : ["text"],
			toolUpdate: "addition-only",
			...entry ? {
				context: { contextWindow: entry.contextWindow },
				defaultMaxTokens: Math.min(entry.maxTokens, DEFAULT_GENERATE_MAX_TOKENS)
			} : {},
			...efforts ? { reasoning: { efforts: efforts.map((effort) => ({
				id: ReasoningEffortId(effort),
				name: effort
			})) } } : {}
		};
	}
	/** The headers every authenticated account endpoint shares. */
	async accountHeaders(apiKey) {
		const connection = this.deps.options();
		const raw = apiKey ?? await this.deps.resolveApiKey(connection);
		const named = connection.apiKeyEnv;
		return {
			Authorization: `Bearer ${assertUsableApiKey(raw, "llm-commandcode", typeof named === "string" && named !== "" ? named : "the stored credential")}`,
			...IDENTITY_ENCODING_HEADER,
			"x-command-code-version": COMMAND_CODE_CLI_VERSION,
			"x-cli-environment": "production",
			...attributionHeaders()
		};
	}
	/**
	* Fetch one JSON GET and return its HTTP status with a parsed record. The
	* catalog, billing probe, and usage report each apply their own failure
	* policy. Non-2xx and invalid JSON bodies come back without a record; only
	* a fetch failure propagates to the caller.
	*
	* `timeoutMs` is the caller's budget, unless it provides its own signal.
	* The usage report passes the connection's request budget rather than the
	* catalog/picker's shorter default.
	*/
	async fetchJson(url, headers, timeoutMs = MODELS_TIMEOUT_MS, signal) {
		const response = await this.fetchImpl(url, {
			headers,
			signal: signal ?? AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) return { status: response.status };
		let parsed;
		try {
			parsed = await response.json();
		} catch {
			return {
				status: response.status,
				invalidResponse: true
			};
		}
		return isRecord(parsed) ? {
			status: response.status,
			record: parsed
		} : {
			status: response.status,
			invalidResponse: true
		};
	}
	/**
	* Every account's billing facts behind the picker's plan filter, in the
	* pool's rotation order and cached per key for {@link BILLING_ACCESS_TTL_MS}
	* (so the extra accounts cost their three requests once per TTL, not once
	* per picker load). `undefined` means the filter cannot be evaluated at all
	* — no key resolved — which {@link modelVisibleForAnyAccount} reads as
	* "show everything".
	*/
	async loadPoolBillingAccess(connection = { ...this.deps.options() }) {
		const keys = await this.poolAccountKeys(connection);
		if (keys.length === 0) return void 0;
		const apiBase = connection.apiBase;
		return Promise.all(keys.map((key) => this.loadBillingAccessForKey(apiBase, key)));
	}
	/**
	* The API keys the picker's plan filter must consult: every account the host
	* can serve from, in rotation order, when the host exposes one. A host
	* without a pool (or without the seam) reports just the key that would serve
	* this request — exactly the pre-pool behaviour.
	*/
	async poolAccountKeys(connection) {
		try {
			const usable = (await this.deps.resolveAccountKeys?.(connection) ?? []).filter((key) => typeof key === "string" && key !== "");
			if (usable.length > 0) return usable;
		} catch {}
		try {
			return [await this.deps.resolveApiKey(connection)];
		} catch {
			return [];
		}
	}
	/**
	* One account's billing facts, cached for {@link BILLING_ACCESS_TTL_MS} and
	* shared across concurrent callers. `undefined` means "unknown — show
	* everything" (fail-open).
	*/
	async loadBillingAccessForKey(apiBase, apiKey) {
		const cacheKey = this.accountCacheKey(apiBase, apiKey);
		const cached = this.billingAccess.get(cacheKey);
		if (cached !== void 0 && Date.now() - cached.at < 3e5) return cached.value;
		const existing = this.billingAccessInflight.get(cacheKey);
		if (existing !== void 0) return existing;
		const inflight = this.fetchBillingAccess(apiBase, apiKey).then((value) => {
			this.billingAccess.set(cacheKey, {
				value,
				at: Date.now()
			});
			return value;
		}).finally(() => {
			this.billingAccessInflight.delete(cacheKey);
		});
		this.billingAccessInflight.set(cacheKey, inflight);
		return inflight;
	}
	/**
	* The billing facts behind the picker's plan filter, mirroring the CLI's
	* `createBilling` flow: whoami yields the org id, then the subscriptions
	* and credits endpoints answer in parallel. The plan id is honored only
	* when the subscription reports an active-ish status (the CLI's rule); when
	* the subscriptions endpoint fails entirely, `credits.planId` is the
	* fallback (the CLI stamps plan identity from it too). Any failure resolves
	* to `undefined` (fail-open) rather than breaking the picker.
	*/
	async fetchBillingAccess(apiBase, apiKey) {
		try {
			const headers = await this.accountHeaders(apiKey);
			const getJson = async (path) => (await this.fetchJson(`${apiBase}${path}`, headers)).record;
			const whoami = await getJson("/alpha/whoami");
			const orgData = whoami && isRecord(whoami.org) ? whoami.org : void 0;
			const orgId = orgData === void 0 ? void 0 : stringValue(orgData.id);
			const [subscription, credits] = await Promise.all([getJson(orgId === void 0 ? "/alpha/billing/subscriptions" : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`), getJson("/alpha/billing/credits")]);
			const subData = subscription && isRecord(subscription.data) ? subscription.data : void 0;
			const creditsData = credits && isRecord(credits.credits) ? credits.credits : void 0;
			if (subData === void 0 && creditsData === void 0) return void 0;
			let planId;
			if (subData !== void 0) {
				const status = stringValue(subData.status);
				if (status !== void 0 && ACTIVE_SUBSCRIPTION_STATUSES.has(status)) planId = stringValue(subData.planId);
			} else planId = stringValue(creditsData?.planId);
			return {
				tierWeight: planId === void 0 ? void 0 : subscriptionPlanInfo(planId)?.tierWeight,
				onDemandCredits: (numberValue(creditsData?.purchasedCredits) ?? 0) + (numberValue(creditsData?.freeCredits) ?? 0)
			};
		} catch {
			return;
		}
	}
	/** Fresh cached billing tier weight for a key, or undefined when not known. */
	cachedBillingTierWeight(apiBase, apiKey) {
		const hit = this.billingAccess.get(this.accountCacheKey(apiBase, apiKey));
		if (hit === void 0 || Date.now() - hit.at >= 3e5) return void 0;
		return hit.value?.tierWeight;
	}
	/** Cached protocol decision for a key, or undefined when expired/unknown. */
	cachedProtocol(apiBase, apiKey) {
		const hit = this.protocolCache.get(this.accountCacheKey(apiBase, apiKey));
		if (hit === void 0 || Date.now() - hit.at >= 9e5) return void 0;
		return hit.protocol;
	}
	rememberProtocol(apiBase, apiKey, protocol) {
		this.protocolCache.set(this.accountCacheKey(apiBase, apiKey), {
			protocol,
			at: Date.now()
		});
	}
	/**
	* True when the catalog routes `model` to `/provider/v1/messages`.
	*
	* The catalog's own `supported_endpoints` is authoritative (it is what
	* upstream publishes per model); `requiresMessagesEndpoint()` — the
	* `claude-*` prefix rule — is the fallback for a catalog entry that carries
	* no route list, which is the shape every pre-1.55 cache file has.
	*/
	routesToMessages(model, entry) {
		if (entry !== void 0 && entry.supportedEndpoints.length > 0) return entry.supportedEndpoints.includes("/messages");
		return requiresMessagesEndpoint(model);
	}
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
	resolveProtocol(connection, apiKey, model, entry) {
		const { apiBase, protocol: forced } = connection;
		if (forced === "cli") return forced;
		if (this.routesToMessages(model, entry)) return "messages";
		if (forced === "openai") return forced;
		const cached = this.cachedProtocol(apiBase, apiKey);
		if (cached !== void 0) return cached;
		if (this.cachedBillingTierWeight(apiBase, apiKey) === GO_TIER_WEIGHT) {
			this.rememberProtocol(apiBase, apiKey, "cli");
			return "cli";
		}
		return "openai";
	}
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
	async getUsage(apiKey, capturedConnection) {
		const connection = capturedConnection ?? { ...this.deps.options() };
		const base = connection.apiBase;
		let headers;
		try {
			headers = await this.accountHeaders(apiKey);
		} catch (error) {
			if (error instanceof LlmError && error.code === "INVALID_CREDENTIAL") return {
				failures: [error.message],
				blocked: "invalid-key"
			};
			throw error;
		}
		const failures = [];
		const failed = [];
		const getJson = async (path) => {
			try {
				const { status, record, invalidResponse } = await this.fetchJson(`${base}${path}`, headers, connection.requestTimeoutMs);
				if (record === void 0) {
					failures.push(`${path}: HTTP ${status}${invalidResponse ? " returned an unreadable or invalid JSON body" : ""}`);
					failed.push(invalidResponse ? {
						kind: "invalid-response",
						status
					} : {
						kind: "http",
						status
					});
					return;
				}
				return record;
			} catch (error) {
				failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				failed.push({ kind: "transport" });
				return;
			}
		};
		const report = { failures };
		const { account, orgId } = parseAccountIdentity(await getJson("/alpha/whoami"));
		if (account !== void 0) report.account = account;
		const [usage, credits, subscription] = await Promise.all([
			getJson("/alpha/usage/summary"),
			getJson("/alpha/billing/credits"),
			getJson(orgId === void 0 ? "/alpha/billing/subscriptions" : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`)
		]);
		const totals = parseUsageTotals(usage);
		if (totals !== void 0) report.usage = totals;
		const limits = parseCreditLimits(credits);
		if (limits !== void 0) report.credits = limits;
		const subData = subscription !== void 0 && isRecord(subscription.data) ? subscription.data : void 0;
		const creditsData = credits !== void 0 && isRecord(credits.credits) ? credits.credits : void 0;
		const planId = stringValue(subData?.planId) ?? stringValue(creditsData?.planId);
		if (subData !== void 0 || planId !== void 0) {
			const info = planId === void 0 ? void 0 : subscriptionPlanInfo(planId);
			report.plan = {
				planId: planId ?? "",
				name: info?.name ?? planId ?? "",
				status: stringValue(subData?.status) ?? "",
				monthlyCredits: info?.monthlyCredits ?? null,
				currentPeriodEnd: periodEndValue(subData?.currentPeriodEnd)
			};
		}
		const blocked = classifyTotalFailure(failures, failed);
		if (blocked !== void 0) report.blocked = blocked;
		return report;
	}
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
	async probeWindowLimits(apiKey, connection = { ...this.deps.options() }) {
		try {
			const { record: parsed } = await this.fetchJson(`${connection.apiBase}/alpha/billing/credits`, await this.accountHeaders(apiKey));
			if (parsed === void 0) return void 0;
			const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : void 0;
			if (windowLimits === void 0) return void 0;
			let reported = false;
			let exceeded = false;
			let resetAt = 0;
			for (const raw of [windowLimits.fiveHour, windowLimits.weekly]) {
				const window = isRecord(raw) ? parseWindowLimit(raw) : void 0;
				if (window === void 0) continue;
				reported = true;
				if (!window.exceeded) continue;
				exceeded = true;
				if (window.resetAt > 0 && window.resetAt - Date.now() <= 2592e6) resetAt = Math.max(resetAt, window.resetAt);
			}
			if (!reported) return void 0;
			return {
				exceeded,
				resetAt: exceeded ? resetAt : 0
			};
		} catch {
			return;
		}
	}
	stream(options) {
		const connection = Object.freeze({ ...this.deps.options() });
		const facts = {
			connection,
			catalog: this.gatewayFacts.snapshot(connection),
			fallbackLimit: modelOutputTokenLimit(connection.apiBase, options.model)
		};
		return ownedResponseStream(options.signal, (signal) => this.streamWithTiming(options, signal, facts));
	}
	async *streamWithTiming(options, signal, facts) {
		const timing = openRequestTiming(options.model, this.deps.onRequestTiming);
		let outcome = "cancelled";
		let errorCode;
		try {
			for await (const chunk of this.streamRequest({
				...options,
				signal
			}, timing, facts)) {
				if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") timing.first("firstContentMs");
				if (chunk.type === "finish") outcome = "finished";
				yield chunk;
			}
		} catch (error) {
			outcome = options.signal?.aborted ? "aborted" : signal.aborted ? "cancelled" : "error";
			if (outcome !== "cancelled") errorCode = error instanceof LlmError ? error.code : "unknown";
			throw error;
		} finally {
			await timing.close(outcome, errorCode);
		}
	}
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
	async *streamRequest(options, timing, facts) {
		options.signal?.throwIfAborted();
		const { connection } = facts;
		const catalog = await facts.catalog;
		options.signal?.throwIfAborted();
		const modelEntry = catalog.find((row) => row.id === options.model);
		const initialMax = Math.min(options.maxTokens ?? Infinity, modelEntry?.maxTokens ?? facts.fallbackLimit, DEFAULT_GENERATE_MAX_TOKENS);
		const budget = {
			max: initialMax,
			sent: initialMax
		};
		for (let attempt = 0;; attempt++) {
			let delivered = false;
			try {
				for await (const chunk of this.streamAttempt(options, timing, connection, modelEntry, budget)) {
					delivered = true;
					yield chunk;
				}
				return;
			} catch (error) {
				const ceiling = delivered ? void 0 : outputCeilingRefusal(connection.apiBase, options.model, budget.sent, error);
				if (attempt > 0 || ceiling === void 0) throw error;
				budget.max = Math.min(budget.max, ceiling);
			}
		}
	}
	async *streamAttempt(options, timing, connection, modelEntry, budget) {
		options.signal?.throwIfAborted();
		if (options.stop?.length) throw new LlmError("Command Code adapter does not support stop sequences", "UNSUPPORTED_OPTION");
		const hasImages = options.messages.some(hasImageContent);
		let readImage;
		if (hasImages) {
			if (!KNOWN_IMAGE_MODELS.has(options.model)) throw new LlmError(`Command Code model "${options.model}" does not support image input; switch to a Vision-capable model (see the model registry)`, "UNSUPPORTED_CONTENT");
			const attachments = this.resolveAttachments?.();
			if (attachments === void 0) throw new LlmError("Command Code image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
			readImage = requestImages(attachments, options.signal, timing);
		}
		const finishCredentials = timing.phase("credentials");
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(connection, options.model);
		} finally {
			finishCredentials();
		}
		options.signal?.throwIfAborted();
		let maxTokens = Math.min(budget.max, learnedOutputLimit(connection.apiBase, options.model));
		const effort = options.reasoningEffort;
		const supported = KNOWN_EFFORTS[options.model];
		const declared = effort !== void 0 && supported?.includes(effort) ? effort : void 0;
		const reasoningEffort = effort === "off" && declared === void 0 ? void 0 : declared;
		const systemText = [options.system ?? "", ...options.messages.filter((m) => m.role === "system").map((m) => m.content.map(blockText).filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
		let protocol = this.resolveProtocol(connection, apiKey, options.model, modelEntry);
		let requestOptions = withSurfaceOffload(options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0], connection.offloadSeenImagesForCache === true && protocol === "cli" ? options.model : void 0);
		const buildBody = async (target) => {
			const finishBody = timing.phase("body");
			try {
				const facts = {
					maxTokens,
					reasoningEffort,
					selectableEffort: supported !== void 0 && supported.length > 0,
					systemText,
					readImage
				};
				const built = target === "cli" ? await buildCliBody(requestOptions, connection, facts) : target === "messages" ? await buildMessagesBody(requestOptions, facts) : await buildOpenAIBody(requestOptions, facts);
				if (target === "cli") recordOrEmpty(built.params).max_tokens = maxTokens;
				else built.max_tokens = maxTokens;
				return built;
			} finally {
				finishBody();
			}
		};
		let body = await buildBody(protocol);
		const serializedBodies = /* @__PURE__ */ new WeakMap();
		const trace = openStreamTrace(`${options.provider}/${options.model}`);
		const tried = /* @__PURE__ */ new Set();
		let attemptNumber = 0;
		let responseMetadata = {
			protocol,
			headers: {}
		};
		const connectDeps = {
			options,
			connection,
			fetchImpl: this.fetchImpl,
			timing,
			onResponse: (response) => {
				this.headerTimeoutStreaks.delete(options.sessionId ?? GLOBAL_HEADER_TIMEOUT_KEY);
				responseMetadata = {
					protocol,
					headers: responseIdentifiers(response.headers)
				};
				trace.record("response", {
					protocol,
					endpoint: protocolEndpoint(protocol, connection.apiBase),
					status: response.status,
					attempt: attemptNumber,
					accountsTried: tried.size,
					maxTokens,
					...reasoningEffort === void 0 ? {} : { reasoningEffort },
					headers: responseMetadata.headers
				});
			}
		};
		let connected;
		try {
			for (;;) {
				tried.add(apiKey);
				attemptNumber++;
				responseMetadata = {
					protocol,
					headers: {}
				};
				const lower = Math.min(maxTokens, learnedOutputLimit(connection.apiBase, options.model));
				if (lower < maxTokens) {
					maxTokens = lower;
					budget.max = Math.min(budget.max, lower);
					if (protocol === "cli") recordOrEmpty(body.params).max_tokens = lower;
					else body.max_tokens = lower;
					serializedBodies.delete(body);
				}
				budget.sent = maxTokens;
				if (trace.enabled) trace.record("request", {
					attempt: attemptNumber,
					sessionId: options.sessionId,
					...requestFingerprint(protocol, body)
				});
				let serialized = serializedBodies.get(body);
				if (serialized === void 0) {
					const finishSerialization = timing.phase("serialization");
					try {
						serialized = JSON.stringify(body, (_key, value) => sanitizeSurrogates(value));
					} finally {
						finishSerialization();
					}
					serializedBodies.set(body, serialized);
				}
				const attempt = await connectGenerate(connectDeps, apiKey, protocol, serialized);
				if ("response" in attempt) {
					connected = attempt;
					break;
				}
				const providerError = parseProviderError(attempt.errText);
				if (protocol !== "cli" && isUpgradeRequiredError(attempt.status, attempt.errText, providerError)) {
					const wasMessages = protocol === "messages";
					protocol = "cli";
					if (!wasMessages) this.rememberProtocol(connection.apiBase, apiKey, "cli");
					requestOptions = withSurfaceOffload(options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0], connection.offloadSeenImagesForCache === true ? options.model : void 0);
					body = await buildBody("cli");
					continue;
				}
				if (attempt.status === 413 && REQUEST_IMAGE_BUDGETS.length > 1) {
					const missing = this.surfaceOffload.requiredImageOffload(requestOptions.messages, coreBudget(REQUEST_IMAGE_BUDGETS[1]), imageVersionBytes);
					if (missing > 0) throw imageOffloadRequired(missing);
				}
				const rotate = this.deps.rotateApiKey;
				const rejection = classifyAccountRejection(attempt.status, attempt.errText, providerError);
				if (rejection !== void 0 && rotate !== void 0 && options.signal?.aborted !== true && tried.size < MAX_ACCOUNT_ROTATIONS) {
					const next = await rotate(apiKey, rejection.reason, connection, options.model, {
						tried: [...tried],
						...rejection.resetAtMs !== void 0 && { resetAtMs: rejection.resetAtMs }
					});
					if (next !== void 0 && !tried.has(next)) {
						apiKey = next;
						const nextProtocol = this.resolveProtocol(connection, apiKey, options.model, modelEntry);
						if (nextProtocol !== protocol) {
							protocol = nextProtocol;
							requestOptions = withSurfaceOffload(options, this.surfaceOffload, REQUEST_IMAGE_BUDGETS[0], connection.offloadSeenImagesForCache === true && protocol === "cli" ? options.model : void 0);
							body = await buildBody(protocol);
						}
						continue;
					}
				}
				if (rejection !== void 0 && (rejection.reason === "rate-limit" || rejection.reason === "throttled")) {
					const reset = rejection.resetAtMs;
					const wait = reset === void 0 ? attempt.retryAfterMs ?? 0 : Math.min(Math.max(1e3, reset - Date.now()), RETRY_MAX_DELAY_MS);
					const when = reset === void 0 ? void 0 : new Date(reset).toISOString();
					const window = rejection.reason === "rate-limit";
					throw bilingual(window ? "RATE_LIMIT" : THROTTLED_CODE, (window ? "llm-commandcode: the Command Code account is rate limited" : "llm-commandcode: the Command Code account is rate limited (429) — the provider did not report an exhausted usage window") + (when === void 0 ? "" : ` — the provider reports it resets at ${when}`), (window ? "当前 Command Code 账户已被限流" : "当前 Command Code 账户被限流（429），服务商未报告用量窗口用尽") + (when === void 0 ? "" : `，服务商给出的重置时间为 ${when}`), {
						status: attempt.status,
						...wait > 0 && wait <= 9e5 ? { providerRetryAfterMs: wait } : {}
					});
				}
				throw generateHttpError(attempt.status, attempt.errText, attempt.retryAfterMs, providerError);
			}
		} catch (error) {
			trace.record("connect-error", {
				message: boundTraceText(errorChain(error)),
				responseMetadata
			});
			trace.close();
			if (options.signal?.aborted) throw error;
			throw failureWithRequestId(this.gradeHeaderTimeout(error, protocol, body, connection.requestTimeoutMs, options.sessionId), responseMetadata);
		}
		if (connected === void 0) throw new LlmError("Command Code API connection failed without a response", "TRANSPORT");
		const { response, cleanup } = connected;
		yield* settleStreamResponse(response, {
			protocol,
			signal: options.signal,
			maxTokens,
			apiBase: connection.apiBase,
			streamIdleTimeoutMs: connection.streamIdleTimeoutMs,
			cleanup,
			trace,
			timing,
			responseMetadata
		});
	}
};
//#endregion
//#region src/command-locales.ts
const commandcodeCommand = {
	zh: {
		title: "📊 Command Code 用量{account}",
		accountTitle: "📊 {label}{badges}",
		accountSeparator: "────────────────────",
		activeBadge: "  ✅ 当前使用",
		invalidCredentialBadge: "  ⛔ 密钥无效",
		cooldownBadge: "  ⏳ 限额冷却中，重置 {when}",
		rateLimitBadge: "  ⏳ 已达限额（等待窗口探测）",
		unconfigured: "  (未配置 API 密钥)",
		blockedInvalidKey: "⛔ API 密钥无效或已过期 — 服务端拒绝了全部请求（401），请检查该账户的密钥配置",
		blockedServiceUnavailable: "⚠️ Command Code 服务暂时不可用（5xx），稍后重试",
		blockedInvalidResponse: "⚠️ Command Code 返回了无法读取的响应 — 请检查宿主的 HTTP 代理或响应解压配置",
		blockedNetwork: "⚠️ 无法连接 Command Code 服务 — 请检查网络或 API 地址",
		planLine: "  📦 套餐    {name}{status}{period}",
		planPeriodSuffix: " · 账期截止 {date}",
		usageHeader: "── 请求 ──────────────────────────────",
		requestsLine: "  💬 请求    {n} 次 / 失败 {f}  成功率 {r}%",
		costLine: "  💰 花费    {money}  ({credits} credits)",
		tokensLine: "  🔤 Token   {in} 入 / {out} 出",
		creditsHeader: "── 信用 ──────────────────────────────",
		monthlyLine: "  💳 月额度  {monthly}   (已购 {purchased} / 赠送 {free})",
		barLine: "     └ {bar}  {pct}%",
		windowsHeader: "── 窗口用量 ──────────────────────────",
		fiveHourLine: "  ⏱ 5 小时  {used} / {cap}{warn}",
		weeklyLine: "  📅 每周    {used} / {cap}{warn}",
		windowBarLine: "     └ {bar}  重置 {when}",
		exceededWarning: "  ⚠️ 超限!",
		partialFailures: "⚠️  部分端点失败: {list}",
		noData: "（无数据 — 请检查 API 密钥）",
		errorText: "获取 Command Code 用量失败：{message}"
	},
	en: {
		title: "📊 Command Code usage{account}",
		accountTitle: "📊 {label}{badges}",
		accountSeparator: "────────────────────",
		activeBadge: "  ✅ active",
		invalidCredentialBadge: "  ⛔ invalid key",
		cooldownBadge: "  ⏳ cooling down, resets {when}",
		rateLimitBadge: "  ⏳ rate-limited (waiting for window probe)",
		unconfigured: "  (no API key configured)",
		blockedInvalidKey: "⛔ API key invalid or expired — the server rejected every request (401); check the key configured for this account",
		blockedServiceUnavailable: "⚠️ Command Code service temporarily unavailable (5xx); try again later",
		blockedInvalidResponse: "⚠️ Command Code returned an unreadable response — check the host HTTP proxy or response decoding",
		blockedNetwork: "⚠️ could not reach the Command Code service — check your network or the API base setting",
		planLine: "  📦 Plan     {name}{status}{period}",
		planPeriodSuffix: " · period ends {date}",
		usageHeader: "── Requests ──────────────────────────",
		requestsLine: "  💬 Requests {n} / failed {f}  success rate {r}%",
		costLine: "  💰 Spend    {money}  ({credits} credits)",
		tokensLine: "  🔤 Tokens   {in} in / {out} out",
		creditsHeader: "── Credits ───────────────────────────",
		monthlyLine: "  💳 Monthly  {monthly}   (purchased {purchased} / free {free})",
		barLine: "     └ {bar}  {pct}%",
		windowsHeader: "── Window usage ──────────────────────",
		fiveHourLine: "  ⏱ 5-hour   {used} / {cap}{warn}",
		weeklyLine: "  📅 Weekly   {used} / {cap}{warn}",
		windowBarLine: "     └ {bar}  resets {when}",
		exceededWarning: "  ⚠️ exceeded!",
		partialFailures: "⚠️  some endpoints failed: {list}",
		noData: "(no data — check your API key)",
		errorText: "Could not fetch Command Code usage: {message}"
	}
};
/**
* Resolve the active locale for a Host-side command run: explicit `override`
* (from `Config.lang`) → `LC_ALL` → `LANG` → the `'zh'` fallback that keeps
* unconfigured deployments on their current output.
*
* Matched on the leading tag only — `zh_CN.UTF-8`, `zh-Hans` and `zh` all
* map to `'zh'`, anything starting with `en` maps to `'en'`, everything else
* falls back to `'zh'` rather than to half-translated English.
*/
function pickCommandLocale(override, env = process.env) {
	if (override === "zh" || override === "en") return override;
	if (((env.LC_ALL ?? env.LANG ?? "").toLowerCase().split(/[._-]/)[0] ?? "") === "en") return "en";
	return "zh";
}
/** Look up a key in the active locale, with an internal en fallback. */
function commandCopy(locale, key) {
	return commandcodeCommand[locale][key] ?? commandcodeCommand.en[key] ?? key;
}
//#endregion
//#region src/display-format.ts
/** Shared, dependency-free formatting for Host commands and browser surfaces. */
function formatMoney(value) {
	return `$${value.toFixed(2)}`;
}
function formatMoneyExact(value) {
	return `$${value.toFixed(4)}`;
}
function formatTokensCompact(value) {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return String(value);
}
/** The input is already in percent units; callers add the percent sign. */
function formatSuccessRate(value) {
	return String(Number(value.toFixed(2)));
}
/** One window's fill ratio in [0, 1]; zero when uncapped. */
function windowRatio(used, cap) {
	if (cap <= 0) return 0;
	return Math.max(0, Math.min(1, used / cap));
}
/** Local date-time, with the empty state chosen by the caller. */
function formatResetAt(ms) {
	return ms <= 0 ? "" : new Date(ms).toLocaleString();
}
//#endregion
//#region src/commands.ts
const money = formatMoneyExact;
const moneyShort = formatMoney;
const tokensCompact = formatTokensCompact;
const successRateText = formatSuccessRate;
/** A local date, or `n/a` when the provider published no reset time. */
function resetLabel(ms) {
	return formatResetAt(ms) || "n/a";
}
/**
* A 10-cell horizontal bar: `██████████` for 100%, `███░░░░░░░` for ~33%.
* Handles caps of 0 (no limit) and out-of-range values.
*/
function bar(used, cap) {
	if (cap <= 0) return "—";
	const ratio = windowRatio(used, cap);
	const filled = Math.round(ratio * 10);
	return "█".repeat(filled) + "░".repeat(10 - filled);
}
/** Render one account's rotation mark / cooldown as a short badge. */
function markLabel(entry, locale) {
	if (entry.mark === "invalid-credential") return commandCopy(locale, "invalidCredentialBadge");
	if (entry.cooldownUntil > 0) return commandCopy(locale, "cooldownBadge").replace("{when}", resetLabel(entry.cooldownUntil));
	if (entry.mark === "rate-limit") return commandCopy(locale, "rateLimitBadge");
	return "";
}
/** Render the usage report as a structured, aligned, bar-chart text view. */
function renderReport(report, locale, title) {
	const lines = [];
	const account = report.account ? ` (${report.account.userName || report.account.name})` : "";
	lines.push(title ?? commandCopy(locale, "title").replace("{account}", account), "");
	if (report.blocked === "invalid-key") lines.push(commandCopy(locale, "blockedInvalidKey"), "");
	else if (report.blocked === "service-unavailable") lines.push(commandCopy(locale, "blockedServiceUnavailable"), "");
	else if (report.blocked === "invalid-response") lines.push(commandCopy(locale, "blockedInvalidResponse"), "");
	else if (report.blocked === "network") lines.push(commandCopy(locale, "blockedNetwork"), "");
	if (report.plan && report.plan.name !== "") {
		const p = report.plan;
		const status = p.status !== "" && p.status !== "active" ? ` (${p.status})` : "";
		const period = p.currentPeriodEnd > 0 ? commandCopy(locale, "planPeriodSuffix").replace("{date}", new Date(p.currentPeriodEnd).toLocaleDateString()) : "";
		lines.push(commandCopy(locale, "planLine").replace("{name}", p.name).replace("{status}", status).replace("{period}", period), "");
	}
	if (report.usage) {
		const u = report.usage;
		lines.push(commandCopy(locale, "usageHeader"), commandCopy(locale, "requestsLine").replace("{n}", String(u.completedCount)).replace("{f}", String(u.failedCount)).replace("{r}", successRateText(u.successRate)), commandCopy(locale, "costLine").replace("{money}", money(u.totalCost)).replace("{credits}", moneyShort(u.totalCredits)), commandCopy(locale, "tokensLine").replace("{in}", tokensCompact(u.totalTokensIn)).replace("{out}", tokensCompact(u.totalTokensOut)), "");
	}
	if (report.credits) {
		const c = report.credits;
		const balanceTotal = c.monthlyCredits + c.purchasedCredits;
		const ratioKnown = c.monthlyReported !== false && c.purchasedReported !== false && balanceTotal > 0;
		lines.push(commandCopy(locale, "creditsHeader"), commandCopy(locale, "monthlyLine").replace("{monthly}", c.monthlyReported === false ? "—" : moneyShort(c.monthlyCredits)).replace("{purchased}", c.purchasedReported === false ? "—" : moneyShort(c.purchasedCredits)).replace("{free}", c.freeReported === false ? "—" : moneyShort(c.freeCredits)), ...ratioKnown ? [commandCopy(locale, "barLine").replace("{bar}", bar(c.monthlyCredits, balanceTotal)).replace("{pct}", (c.monthlyCredits / balanceTotal * 100).toFixed(0))] : [], "");
		const windowLines = [];
		if (c.fiveHour !== void 0) windowLines.push(commandCopy(locale, "fiveHourLine").replace("{used}", moneyShort(c.fiveHour.used)).replace("{cap}", moneyShort(c.fiveHour.cap)).replace("{warn}", c.fiveHour.exceeded ? commandCopy(locale, "exceededWarning") : ""), commandCopy(locale, "windowBarLine").replace("{bar}", bar(c.fiveHour.used, c.fiveHour.cap)).replace("{when}", resetLabel(c.fiveHour.resetAt)));
		if (c.weekly !== void 0) windowLines.push(commandCopy(locale, "weeklyLine").replace("{used}", moneyShort(c.weekly.used)).replace("{cap}", moneyShort(c.weekly.cap)).replace("{warn}", c.weekly.exceeded ? commandCopy(locale, "exceededWarning") : ""), commandCopy(locale, "windowBarLine").replace("{bar}", bar(c.weekly.used, c.weekly.cap)).replace("{when}", resetLabel(c.weekly.resetAt)));
		if (windowLines.length > 0) lines.push(commandCopy(locale, "windowsHeader"), ...windowLines, "");
	}
	if (report.failures.length > 0) lines.push(commandCopy(locale, "partialFailures").replace("{list}", report.failures.join("; ")), "");
	if (!report.account && !report.usage && !report.credits) lines.push(commandCopy(locale, "noData"), "");
	return lines.join("\n").trimEnd();
}
/** The one registered `/commandcode` command. */
function commandDefinition(deps) {
	const { adapter } = deps;
	return {
		name: "commandcode",
		description: "Command Code account usage dashboard",
		input: { hint: "[status]" },
		handler: async () => {
			const locale = deps.getLocale?.() ?? "zh";
			try {
				if (deps.reports !== void 0) {
					const { accounts } = await deps.reports();
					return {
						kind: "success",
						text: accounts.map((entry) => {
							const badges = `${entry.active ? commandCopy(locale, "activeBadge") : ""}${markLabel(entry, locale)}`;
							const title = commandCopy(locale, "accountTitle").replace("{label}", entry.label).replace("{badges}", badges);
							if (!entry.configured) return `${title}\n\n${commandCopy(locale, "unconfigured")}`;
							return renderReport(entry.report, locale, title);
						}).join(`\n\n${commandCopy(locale, "accountSeparator")}\n\n`)
					};
				}
				return {
					kind: "success",
					text: renderReport(await adapter.getUsage(), locale)
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					kind: "error",
					text: commandCopy(locale, "errorText").replace("{message}", message)
				};
			}
		}
	};
}
/** Register the command on `ctx.commands` (called from the plugin entry). */
function applyCommands(ctx, deps) {
	ctx.commands.register(commandDefinition(deps));
}
//#endregion
//#region src/wire-shared.ts
/** The npm package identity every contribution and descriptor claims. */
const REMOTE_PACKAGE = "@mars-sea/dsh-commandcode-provider";
/** The Cordis service key the Gateway resolves every Command Code Remote from. */
const REMOTE_SERVICE = "commandcodeUsage";
/** The wire namespace all Command Code endpoints share. */
const REMOTE_NAMESPACE = "commandcode";
/**
* Build the validator helpers one endpoint uses. `prefix` names the endpoint
* in the rejection message (e.g. `commandcode/report result:`), so each wire
* file keeps its own diagnostic phrasing while sharing the helper bodies.
*
* The helpers return the reject call directly in the failure branch: since
* `reject` is typed `never`, the ternary's union collapses to the success type
* without relying on TypeScript's control-flow analysis of a never-returning
* call (which only recognizes function declarations, not the destructured
* arrow `reject` callers receive from this factory). Callers that need the
* narrowing in an `if` must therefore assign inside the positive branch.
*/
function makeBoundaryValidator(prefix) {
	const reject = (field) => {
		throw new TypeError(`${prefix} invalid ${field}`);
	};
	const record = (value, field) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : reject(field);
	const stringField = (source, key, field) => typeof source[key] === "string" ? source[key] : reject(field);
	const numberField = (source, key, field) => typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] : reject(field);
	const booleanField = (source, key, field) => typeof source[key] === "boolean" ? source[key] : reject(field);
	return {
		reject,
		record,
		stringField,
		numberField,
		booleanField
	};
}
/** Use the same strict-codec shape for invocation parameters and results. */
function makeStrictCodec(typeSymbol, schema) {
	return {
		mode: "strict",
		typeSymbol,
		create: () => schema
	};
}
/**
* Build one strict invocation descriptor. Every Command Code Remote shares the
* `commandcode` namespace, the `commandcodeUsage` service, and a strict result
* — only the endpoint, method, result type symbol, and schema differ.
*/
function makeRemoteDescriptor(endpoint, method, typeSymbol, schema) {
	return {
		id: `${REMOTE_PACKAGE}#${endpoint}`,
		service: REMOTE_SERVICE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: [],
		result: makeStrictCodec(typeSymbol, schema)
	};
}
//#endregion
//#region src/usage-wire.ts
/** The npm package identity both contribution registrations claim. */
const USAGE_REMOTE_PACKAGE = REMOTE_PACKAGE;
/** Canonical `<namespace>/<method>` endpoint of the usage report Remote. */
const USAGE_REPORT_ENDPOINT = "commandcode/report";
/**
* The shared read/validate helpers for the usage report endpoint, prefixed
* so rejection messages name the offending boundary.
*/
const { reject: reject$1, record: record$1, stringField: stringField$1, numberField, booleanField } = makeBoundaryValidator("commandcode/report result:");
/**
* Parse one quota window, or undefined when the frame carries no such window.
*
* The distinction is load-bearing at this boundary: an ABSENT window means the
* billing endpoint reported none (an unlimited plan), while a present block with
* `cap: 0` means uncapped spend that was really reported. Collapsing the two
* would draw a zeroed quota row for an account that has no such limit.
*/
function windowLimit(value, field) {
	if (value === void 0) return void 0;
	const source = record$1(value, field);
	return {
		used: numberField(source, "used", `${field}.used`),
		cap: numberField(source, "cap", `${field}.cap`),
		exceeded: booleanField(source, "exceeded", `${field}.exceeded`),
		resetAt: numberField(source, "resetAt", `${field}.resetAt`)
	};
}
/**
* Parse one untrusted boundary value into a {@link CommandCodeUsageReport}.
* Optional sections stay optional; every present field is shape-checked so a
* malformed frame fails the boundary instead of rendering garbage.
*/
function parseUsageReport(value) {
	const source = record$1(value, "report");
	const failures = source.failures;
	if (!Array.isArray(failures) || failures.some((entry) => typeof entry !== "string")) reject$1("failures");
	const report = { failures };
	if (source.blocked !== void 0) {
		const blocked = source.blocked;
		if (blocked === "invalid-key" || blocked === "service-unavailable" || blocked === "invalid-response" || blocked === "network") report.blocked = blocked;
		else reject$1("blocked");
	}
	if (source.account !== void 0) {
		const account = record$1(source.account, "account");
		report.account = {
			id: stringField$1(account, "id", "account.id"),
			name: stringField$1(account, "name", "account.name"),
			userName: stringField$1(account, "userName", "account.userName")
		};
	}
	if (source.usage !== void 0) {
		const usage = record$1(source.usage, "usage");
		report.usage = {
			totalCount: numberField(usage, "totalCount", "usage.totalCount"),
			totalCost: numberField(usage, "totalCost", "usage.totalCost"),
			successRate: numberField(usage, "successRate", "usage.successRate"),
			completedCount: numberField(usage, "completedCount", "usage.completedCount"),
			failedCount: numberField(usage, "failedCount", "usage.failedCount"),
			totalTokensIn: numberField(usage, "totalTokensIn", "usage.totalTokensIn"),
			totalTokensOut: numberField(usage, "totalTokensOut", "usage.totalTokensOut"),
			totalCredits: numberField(usage, "totalCredits", "usage.totalCredits"),
			periodBasis: stringField$1(usage, "periodBasis", "usage.periodBasis")
		};
	}
	if (source.credits !== void 0) {
		const credits = record$1(source.credits, "credits");
		const parsed = {
			monthlyCredits: numberField(credits, "monthlyCredits", "credits.monthlyCredits"),
			purchasedCredits: numberField(credits, "purchasedCredits", "credits.purchasedCredits"),
			freeCredits: numberField(credits, "freeCredits", "credits.freeCredits")
		};
		if (credits.monthlyReported !== void 0) parsed.monthlyReported = booleanField(credits, "monthlyReported", "credits.monthlyReported");
		for (const flag of ["purchasedReported", "freeReported"]) if (credits[flag] !== void 0) parsed[flag] = booleanField(credits, flag, `credits.${flag}`);
		const fiveHour = windowLimit(credits.fiveHour, "credits.fiveHour");
		const weekly = windowLimit(credits.weekly, "credits.weekly");
		if (fiveHour !== void 0) parsed.fiveHour = fiveHour;
		if (weekly !== void 0) parsed.weekly = weekly;
		report.credits = parsed;
	}
	if (source.plan !== void 0) {
		const plan = record$1(source.plan, "plan");
		const monthly = plan.monthlyCredits;
		if (monthly !== null && (typeof monthly !== "number" || !Number.isFinite(monthly))) reject$1("plan.monthlyCredits");
		report.plan = {
			planId: stringField$1(plan, "planId", "plan.planId"),
			name: stringField$1(plan, "name", "plan.name"),
			status: stringField$1(plan, "status", "plan.status"),
			monthlyCredits: monthly,
			currentPeriodEnd: numberField(plan, "currentPeriodEnd", "plan.currentPeriodEnd")
		};
	}
	return report;
}
/** Parse one untrusted boundary value into a {@link CommandCodeAccountUsage}. */
function parseAccountUsage(value) {
	const source = record$1(value, "account");
	return {
		id: stringField$1(source, "id", "account.id"),
		label: stringField$1(source, "label", "account.label"),
		configured: booleanField(source, "configured", "account.configured"),
		active: booleanField(source, "active", "account.active"),
		mark: stringField$1(source, "mark", "account.mark"),
		cooldownUntil: numberField(source, "cooldownUntil", "account.cooldownUntil"),
		report: parseUsageReport(source.report)
	};
}
/** Parse the wire result into a {@link CommandCodeAccountsReport}. */
function parseAccountsReport(value) {
	const accounts = record$1(value, "result").accounts;
	if (Array.isArray(accounts)) return { accounts: accounts.map(parseAccountUsage) };
	return reject$1("accounts");
}
/**
* The strict result codec both halves attach to the descriptor. Hand-rolled:
* the client bundle may not require a schema library, and `TypertSchema` is
* deliberately minimal so one `parse` function satisfies it.
*/
const usageReportSchema = { parse: parseAccountsReport };
/** The Host-face contribution registered on `ctx.typert`. */
const USAGE_HOST_CONTRIBUTION = {
	package: USAGE_REMOTE_PACKAGE,
	face: "host",
	schemas: [],
	model: {
		services: [],
		events: [],
		objects: []
	},
	invocations: [makeRemoteDescriptor(USAGE_REPORT_ENDPOINT, "report", `${USAGE_REMOTE_PACKAGE}#CommandCodeAccountsReport`, usageReportSchema)]
};
/** Canonical `<namespace>/<method>` endpoint of the model-catalog Remote. */
const MODELS_ENDPOINT = "commandcode/models";
/**
* The shared read/validate helpers for the model-catalog endpoint — a
* separate instance so catalog boundary errors name `commandcode/models`,
* not the report endpoint.
*/
const { record: catalogRecord, stringField: catalogString, numberField: catalogNumber } = makeBoundaryValidator("commandcode/models result:");
/** Parse one untrusted boundary value into a {@link CommandCodeCatalogModel}. */
function parseCatalogModel(value) {
	const source = catalogRecord(value, "model");
	const model = {
		id: catalogString(source, "id", "model.id"),
		name: catalogString(source, "name", "model.name")
	};
	if (source.tier !== void 0) model.tier = catalogString(source, "tier", "model.tier");
	if (source.allowance !== void 0) model.allowance = catalogNumber(source, "allowance", "model.allowance");
	return model;
}
/** Parse the wire result into a {@link CommandCodeCatalog}. */
function parseCatalog(value) {
	const models = catalogRecord(value, "result").models;
	if (Array.isArray(models)) return { models: models.map(parseCatalogModel) };
	throw new TypeError("commandcode/models result: invalid models");
}
/**
* The model-catalog invocation descriptor, sharing the same `commandcodeUsage`
* service and `commandcode` namespace as the usage report.
*/
const MODELS_DESCRIPTOR = makeRemoteDescriptor(MODELS_ENDPOINT, "models", `${USAGE_REMOTE_PACKAGE}#CommandCodeCatalog`, { parse: parseCatalog });
/** Canonical `<namespace>/<method>` endpoint of the price-table Remote. */
const PRICES_ENDPOINT = "commandcode/prices";
/**
* The shared read/validate helpers for the price-table endpoint — its own
* instance so price boundary errors name `commandcode/prices`.
*/
const { reject: priceReject, record: priceRecord, stringField: priceString, numberField: priceNumber, booleanField: priceBoolean } = makeBoundaryValidator("commandcode/prices result:");
/** Parse one rate block (`rates`, or a model's `peak` override). */
function parseRates(source, field) {
	const rates = {
		inputCost: priceNumber(source, "inputCost", `${field}.inputCost`),
		outputCost: priceNumber(source, "outputCost", `${field}.outputCost`),
		cacheReadCost: priceNumber(source, "cacheReadCost", `${field}.cacheReadCost`)
	};
	if (source.cacheWriteCost !== void 0) rates.cacheWriteCost = priceNumber(source, "cacheWriteCost", `${field}.cacheWriteCost`);
	return rates;
}
/** Parse one untrusted boundary value into a {@link CommandCodeModelPrice}. */
function parseModelPrice(value) {
	const source = priceRecord(value, "model");
	const price = {
		id: priceString(source, "id", "model.id"),
		slug: priceString(source, "slug", "model.slug"),
		...parseRates(source, "model")
	};
	if (source.peak !== void 0) price.peak = parseRates(priceRecord(source.peak, "model.peak"), "model.peak");
	if (source.contextTiers !== void 0) {
		if (!Array.isArray(source.contextTiers) || source.contextTiers.length === 0) priceReject("contextTiers");
		let previous = 0;
		price.contextTiers = source.contextTiers.map((value, index, tiers) => {
			const tier = priceRecord(value, "contextTier");
			const out = parseRates(tier, "contextTier");
			if (tier.maxContext !== void 0) {
				const max = priceNumber(tier, "maxContext", "contextTier.maxContext");
				if (!Number.isSafeInteger(max) || max <= previous || index === tiers.length - 1) priceReject("contextTier.maxContext");
				previous = max;
				out.maxContext = max;
			} else if (index !== tiers.length - 1) priceReject("contextTier.maxContext");
			return out;
		});
	}
	if (source.free !== void 0) price.free = priceBoolean(source, "free", "model.free");
	return price;
}
/** Parse the wire result into a {@link CommandCodePriceTable}. */
function parsePriceTable(value) {
	const source = priceRecord(value, "result");
	const models = source.models;
	if (!Array.isArray(models)) priceReject("models");
	const peakHours = source.peakHours;
	if (!Array.isArray(peakHours)) priceReject("peakHours");
	return {
		models: models.map(parseModelPrice),
		peakHours: peakHours.map((window) => {
			if (!Array.isArray(window) || window.length !== 2) priceReject("peakHours[]");
			const [start, end] = window;
			if (typeof start !== "number" || typeof end !== "number") priceReject("peakHours[]");
			return [start, end];
		})
	};
}
/**
* The price-table invocation descriptor, sharing the same `commandcodeUsage`
* service and `commandcode` namespace as the report and catalog endpoints.
*/
const PRICES_DESCRIPTOR = makeRemoteDescriptor(PRICES_ENDPOINT, "prices", `${USAGE_REMOTE_PACKAGE}#CommandCodePriceTable`, { parse: parsePriceTable });
//#endregion
//#region src/login-wire.ts
/** The canonical endpoint paths of the three login Remotes. */
const LOGIN_BEGIN_ENDPOINT = "commandcode/loginBegin";
const LOGIN_STATUS_ENDPOINT = "commandcode/loginStatus";
const LOGIN_CANCEL_ENDPOINT = "commandcode/loginCancel";
const REASONS = [
	"denied",
	"timeout",
	"invalid-key",
	"network",
	"unavailable",
	"cancelled",
	"error"
];
/** The shared read/validate helpers, prefixed with the login endpoint so
* rejection messages name the offending boundary. */
const { reject, record, stringField } = makeBoundaryValidator("commandcode/login result:");
/**
* Parse one untrusted boundary value into a {@link CommandCodeLoginStatus}.
* Every field is shape-checked so a malformed frame fails the boundary
* instead of leaking into the page.
*/
function parseLoginStatus(value) {
	const source = record(value, "status");
	const state = source.state;
	if (state === "idle" || state === "waiting" || state === "success" || state === "failed") {
		const status = { state };
		if (source.authUrl !== void 0) status.authUrl = stringField(source, "authUrl", "authUrl");
		if (source.userName !== void 0) status.userName = stringField(source, "userName", "userName");
		if (source.keyName !== void 0) status.keyName = stringField(source, "keyName", "keyName");
		if (source.reason !== void 0) {
			const reason = source.reason;
			if (typeof reason === "string" && REASONS.includes(reason)) status.reason = reason;
			else reject("reason");
		}
		if (source.message !== void 0) status.message = stringField(source, "message", "message");
		return status;
	}
	return reject("state");
}
/** The strict result codec shared by all three login endpoints. */
const loginStatusSchema = { parse: parseLoginStatus };
/** Optional account target; the Host still checks it against saved slots. */
const loginTargetSchema = { parse(value) {
	if (value === void 0 || typeof value === "string") return value;
	return reject("targetRef");
} };
/** Build one login invocation descriptor. Only begin accepts an account ref. */
function loginDescriptor(endpoint, method) {
	const descriptor = makeRemoteDescriptor(endpoint, method, `${REMOTE_PACKAGE}#CommandCodeLoginStatus`, loginStatusSchema);
	return method === "loginBegin" ? {
		...descriptor,
		parameters: [{
			name: "targetRef",
			wire: "targetRef",
			source: "json",
			codec: makeStrictCodec(`${REMOTE_PACKAGE}#CommandCodeLoginTargetRef`, loginTargetSchema),
			acceptsUndefined: true
		}]
	} : descriptor;
}
/** The Host-face contribution fragment registered on `ctx.typert`. */
const LOGIN_HOST_CONTRIBUTION = {
	package: REMOTE_PACKAGE,
	face: "host",
	schemas: [],
	invocations: [
		loginDescriptor(LOGIN_BEGIN_ENDPOINT, "loginBegin"),
		loginDescriptor(LOGIN_STATUS_ENDPOINT, "loginStatus"),
		loginDescriptor(LOGIN_CANCEL_ENDPOINT, "loginCancel")
	]
};
//#endregion
//#region src/enrollment-wire.ts
const guard = makeBoundaryValidator("commandcode/enrollment");
const phases = [
	"creating",
	"waiting",
	"writing",
	"naming",
	"finished",
	"cancelling",
	"cancelled",
	"failed",
	"cleanup-needed"
];
function parseEnrollmentState(value) {
	const source = guard.record(value, "state");
	const phase = source.phase;
	if (!phases.includes(phase)) return guard.reject("phase");
	const state = {
		id: guard.stringField(source, "id", "id"),
		ref: guard.stringField(source, "ref", "ref"),
		phase,
		message: guard.stringField(source, "message", "message")
	};
	for (const field of ["authUrl", "suggestedName"]) if (source[field] !== void 0) state[field] = guard.stringField(source, field, field);
	return state;
}
function parseEnrollmentInput(value) {
	const source = guard.record(value, "input");
	const id = guard.stringField(source, "id", "id");
	if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) return guard.reject("id");
	if (source.mode !== "browser" && source.mode !== "manual") return guard.reject("mode");
	const input = {
		id,
		pageId: parsePage(source).pageId,
		mode: source.mode,
		label: guard.stringField(source, "label", "label").trim(),
		automaticName: guard.booleanField(source, "automaticName", "automaticName")
	};
	if (!input.label || input.label.length > 200) return guard.reject("label");
	if (input.mode === "manual") {
		input.key = guard.stringField(source, "key", "key").trim();
		if (!input.key) return guard.reject("key");
	} else if (source.key !== void 0) return guard.reject("key");
	return input;
}
function parsePage(value) {
	const source = guard.record(value, "page");
	const pageId = guard.stringField(source, "pageId", "pageId");
	if (!/^[a-zA-Z0-9-]{16,80}$/.test(pageId)) return guard.reject("pageId");
	return { pageId };
}
const actionSchema = { parse(value) {
	const source = guard.record(value, "action");
	const action = {
		id: guard.stringField(source, "id", "id"),
		...parsePage(source)
	};
	if (!/^[a-zA-Z0-9-]{16,80}$/.test(action.id)) return guard.reject("id");
	if (source.name !== void 0) action.name = guard.stringField(source, "name", "name").trim();
	if (action.name !== void 0 && (!action.name || action.name.length > 200)) return guard.reject("name");
	return action;
} };
const stateSchema = { parse: parseEnrollmentState };
const listSchema = { parse(value) {
	return Array.isArray(value) ? value.map(parseEnrollmentState) : guard.reject("list");
} };
const ENROLLMENT_DESCRIPTORS = [
	...[
		"enrollmentBegin",
		"enrollmentStatus",
		"enrollmentCancel",
		"enrollmentName",
		"enrollmentRetry"
	].map((method) => ({
		...makeRemoteDescriptor(`commandcode/${method}`, method, `${REMOTE_PACKAGE}#EnrollmentState`, stateSchema),
		parameters: [{
			name: "input",
			wire: "input",
			source: "json",
			codec: makeStrictCodec(`${REMOTE_PACKAGE}#${method}Input`, method === "enrollmentBegin" ? { parse: parseEnrollmentInput } : actionSchema)
		}]
	})),
	{
		...makeRemoteDescriptor("commandcode/enrollmentPending", "enrollmentPending", `${REMOTE_PACKAGE}#EnrollmentStateList`, listSchema),
		parameters: [{
			name: "input",
			wire: "input",
			source: "json",
			codec: makeStrictCodec(`${REMOTE_PACKAGE}#EnrollmentPage`, { parse: parsePage })
		}]
	},
	{
		...makeRemoteDescriptor("commandcode/enrollmentWatch", "enrollmentWatch", `${REMOTE_PACKAGE}#EnrollmentReady`, { parse(value) {
			return value === true ? true : guard.reject("ready");
		} }),
		mode: "stream",
		parameters: [{
			name: "input",
			wire: "input",
			source: "json",
			codec: makeStrictCodec(`${REMOTE_PACKAGE}#EnrollmentPage`, { parse: parsePage })
		}]
	}
];
//#endregion
//#region src/usage-remote.ts
/**
* The Remote receiver: a Cordis service the Gateway resolves by key
* (`commandcodeUsage`) and binds to the wire namespace (`commandcode`). The
* base class stamps the `typertRemote` binding the Gateway validates on every
* dispatch; no decorators are needed because the descriptor is registered
* explicitly (strict path) rather than discovered from source markers.
*/
var CommandCodeUsageService = class extends TypertRemoteService {
	deps;
	constructor(ctx, deps) {
		super(ctx, "commandcodeUsage", { namespace: "commandcode" });
		this.deps = deps;
	}
	/**
	* Account, usage, and credit state for the settings page's account card.
	* Degrades per endpoint like the `/commandcode` command (failures land in
	* `report.failures`); throws `MISSING_CREDENTIAL` when no key resolves, which
	* the Gateway folds into the failure branch the page renders as a hint.
	*/
	async report() {
		if (this.deps.reports !== void 0) return this.deps.reports();
		return { accounts: [{
			id: "default",
			label: "Default",
			configured: true,
			active: true,
			mark: "",
			cooldownUntil: 0,
			report: await this.deps.adapter.getUsage()
		}] };
	}
	/**
	* The full model catalog for the settings page's model editors. The browser
	* never calls the Command Code API directly — the Host serves the catalog
	* (already fetched/cached by the adapter) so models can be picked from the
	* live list instead of typed by hand.
	*/
	async models() {
		return this.deps.listModels?.() ?? { models: [] };
	}
	/**
	* The model price table the composer prices an in-progress session with.
	* Static vendored data, served Host-side so the browser bundle never carries
	* a copy that could drift from the snapshot, and so a price update reaches an
	* open page without a rebuild.
	*/
	async prices() {
		return (this.deps.prices ?? modelPriceTable)();
	}
	/**
	* Start (or rejoin) a browser-login attempt and return its fresh status —
	* `waiting` carrying the Studio URL. Rejects when the flow cannot start
	* (no free loopback port, disposed plugin).
	*/
	async loginBegin(targetRef) {
		return this.requireLogin().begin(targetRef);
	}
	/** Poll a login attempt's status. */
	async loginStatus() {
		return this.deps.login?.status() ?? { state: "idle" };
	}
	/** Cancel a waiting attempt; returns the post-cancel status. */
	async loginCancel() {
		this.deps.login?.cancel();
		return this.deps.login?.status() ?? { state: "idle" };
	}
	async enrollmentBegin(input) {
		const manager = this.requireEnrollment();
		const owner = this.enrollmentOwner(input);
		if (!manager.hasPage(owner)) throw new Error("账号开通页面观察流未建立");
		return manager.begin(owner, input);
	}
	async enrollmentStatus(input) {
		return this.requireEnrollment().status(this.enrollmentOwner(input), input.id);
	}
	async enrollmentCancel(input) {
		return this.requireEnrollment().cancel(this.enrollmentOwner(input), input.id);
	}
	async enrollmentName(input) {
		return this.requireEnrollment().name(this.enrollmentOwner(input), input.id, input.name);
	}
	async enrollmentRetry(input) {
		return this.requireEnrollment().retry(this.enrollmentOwner(input), input.id, input.name);
	}
	async enrollmentPending(input) {
		return this.requireEnrollment().pending(this.enrollmentOwner(input));
	}
	async *enrollmentWatch(input) {
		const invocation = this.ctx.invocation;
		if (!invocation) throw new Error("账号开通必须从已连接的页面调用");
		const release = this.requireEnrollment().watch(this.enrollmentOwner(input));
		let abort;
		try {
			const ended = new Promise((resolve) => {
				abort = () => resolve();
				invocation.signal.addEventListener("abort", abort, { once: true });
				if (invocation.signal.aborted) resolve();
			});
			if (invocation.signal.aborted) return;
			yield true;
			await ended;
		} finally {
			if (abort) invocation.signal.removeEventListener("abort", abort);
			release();
		}
	}
	enrollmentOwner(input) {
		return `${this.enrollmentPeer().id}:${input.pageId}`;
	}
	enrollmentPeer() {
		const invocation = this.ctx.invocation;
		if (!invocation) throw new Error("账号开通必须从已连接的页面调用");
		return invocation.peer;
	}
	requireEnrollment() {
		if (!this.deps.enrollment) throw new Error("宿主不支持账号开通，请更新插件");
		return this.deps.enrollment;
	}
	requireLogin() {
		const login = this.deps.login;
		if (login === void 0) throw new Error("login flow is not wired in this setup; paste the API key instead");
		return login;
	}
};
/**
* Provide the usage service and register its Remote descriptor. The registry
* contribution is tied to this fiber's lifetime: the registry's own
* `register()` effect would otherwise outlive the plugin.
*/
function applyUsageRemote(ctx, deps) {
	ctx.inject(["typert"], (remoteCtx) => {
		new CommandCodeUsageService(remoteCtx, deps);
		const unregister = remoteCtx.typert.register({
			...USAGE_HOST_CONTRIBUTION,
			invocations: [
				...USAGE_HOST_CONTRIBUTION.invocations,
				MODELS_DESCRIPTOR,
				PRICES_DESCRIPTOR,
				...LOGIN_HOST_CONTRIBUTION.invocations,
				...ENROLLMENT_DESCRIPTORS
			]
		});
		remoteCtx.effect(() => () => void unregister(), "dsh-commandcode-provider: usage remote");
	});
}
//#endregion
//#region src/login.ts
/**
* Host half of the Command Code browser login (the loopback flow), mirroring
* what the official `command-code login` CLI command performs.
*
* 1. Bind a temporary HTTP server on `127.0.0.1`, first available port from
*    5959 upward (10 attempts).
* 2. Generate a random state token and open
*    `{studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state={state}`.
* 3. After the user signs in, the Studio page POSTs the credentials JSON
*    `{ apiKey, state, userId, userName, keyName }` to the loopback callback —
*    no OAuth code exchange, the page holds the final API key.
* 4. The delivered key is validated against `GET {apiBase}/alpha/whoami`
*    before anything is stored.
*
* The server contract is CLI-mirrored: POST-only `/callback`, a 10 KB body
* cap, JSON responses (`{success:true}` / `{success:false,error}`), and
* state-token equality as the anti-forgery check. Three deliberate hardenings
* over the CLI build: the CORS origin is echoed only when allowlisted (the
* CLI falls back to the first origin), `Connection: close`, and the denial
* branch checks the state token before it ends the attempt.
*
* Storage stays out of this module: the plugin entry supplies
* {@link CommandCodeLoginFlowDeps.storeKey}, which writes through the dsh
* credentials seam so the next request resolves the new key with no restart.
* Everything external (fetch, ports, randomness, timing) is injectable for
* node tests; the tests drive a real loopback server end to end.
*
* @module dsh-commandcode-provider/login
*/
/** 登录总期限包含浏览器回调、密钥验证与存储，不能在收到回调后撤掉保护。 */
const LOGIN_TIMEOUT_MS = 12e4;
/** First local port the flow tries (mirrors the CLI). */
const LOGIN_START_PORT = 5959;
/** How many consecutive ports to try from {@link LOGIN_START_PORT}. */
const LOGIN_MAX_PORT_ATTEMPTS = 10;
/** Reject callback bodies larger than this (mirrors the CLI). */
const LOGIN_BODY_LIMIT_BYTES = 1e4;
/** The Studio origins allowed to POST credentials to the loopback server. */
const LOGIN_ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"https://staging.commandcode.ai",
	"https://commandcode.ai"
];
/** The Studio route that performs the browser-side login. */
const STUDIO_AUTH_PATH = "/studio/auth/cli";
/** Resolve a browser-login destination without allowing arbitrary credential writes. */
function loginCredentialRef(targetRef, defaultRef, accounts) {
	if (targetRef === void 0) return defaultRef;
	if (targetRef === defaultRef || !accounts.some((account) => account.apiKeyEnv === targetRef)) throw new Error("the target account must be saved before browser sign-in");
	return targetRef;
}
/** Compose the Studio authorization URL (pure, exported for tests). */
function buildCommandAuthUrl(options) {
	const callback = `http://localhost:${options.port}/callback`;
	return `${options.studioBase}${STUDIO_AUTH_PATH}?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(options.state)}`;
}
/** Map an API base onto the Studio base the CLI pairs it with. */
function studioBaseForApiBase(apiBase) {
	if (/^https:\/\/staging-api\.commandcode\.ai/i.test(apiBase)) return "https://staging.commandcode.ai";
	if (/^http:\/\/localhost(:\d+)?$/i.test(apiBase)) return "http://localhost:3000";
	return "https://commandcode.ai";
}
/**
* Validate one candidate key against `/alpha/whoami` (pure, exported for
* tests). Mirrors the CLI's verdicts: 401 → invalid_key, other non-OK →
* server_error, transport failure → network_error.
*/
async function validateCommandApiKey(fetchImpl, apiBase, apiKey, signal) {
	try {
		const response = await fetchImpl(`${apiBase}/alpha/whoami`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				...IDENTITY_ENCODING_HEADER,
				Authorization: `Bearer ${apiKey}`
			},
			...signal === void 0 ? {} : { signal }
		});
		response.body?.cancel().catch(() => void 0);
		if (response.status === 401) return {
			valid: false,
			error: "invalid_key"
		};
		if (response.ok) return { valid: true };
		return {
			valid: false,
			error: "server_error"
		};
	} catch {
		return {
			valid: false,
			error: "network_error"
		};
	}
}
/** Whether one loopback port is free right now. */
function checkPortAvailable(port) {
	return new Promise((resolve) => {
		const probe = createServer$1();
		probe.once("error", () => resolve(false));
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}
/** Whether a callback body carries every credential field the CLI requires. */
function isCallbackCredentials(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return typeof record.apiKey === "string" && record.apiKey !== "" && typeof record.state === "string" && typeof record.userId === "string" && typeof record.userName === "string" && typeof record.keyName === "string";
}
/**
* One browser-login attempt machine. Single-flight by design: `begin()` while
* waiting returns the live attempt's status instead of starting a second one;
* a start that is still binding its port is REJOINED through
* {@link CommandCodeLoginFlow.begin}'s in-flight promise, because the status
* face cannot say `waiting` until that bind settles; a terminal state makes the
* next `begin()` start fresh.
*/
var CommandCodeLoginFlow = class {
	deps;
	listeners = /* @__PURE__ */ new Set();
	statusValue = { state: "idle" };
	server;
	timer;
	attemptAbort;
	/** Settle hooks of the live attempt's callback promise. */
	settle;
	/**
	* Attempt generation. A delivered callback keeps validating the key
	* asynchronously (`complete()`), and that window is open to a cancel or a
	* fresh `begin()`; the generation lets a late completion recognize that it
	* no longer owns the status face and stop instead of storing a credential
	* the user cancelled.
	*/
	attemptSeq = 0;
	/**
	* The start currently binding a port, if any. Every `begin()` arriving before
	* it settles joins it: two independent starts would each bind a loopback
	* server, and only the LAST one is reachable by `teardown()` — the orphan
	* keeps answering `/callback` for the process's lifetime, and ten of them
	* exhaust the port window so browser login dies until the Host restarts.
	*/
	starting;
	/** A live attempt's destination; different rows may not rejoin it. */
	targetRef;
	/** A `cancel()` that arrived while a start was still binding (see {@link CommandCodeLoginFlow.cancel}). */
	cancelPending = false;
	/** 取消只能阻止尚未发出的写入；补偿者须等这些实际存储任务结束。 */
	pendingStores = /* @__PURE__ */ new Set();
	disposed = false;
	constructor(deps) {
		this.deps = deps;
	}
	/** Subscribe to state transitions. @returns the disposer. */
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** The current attempt's status face. */
	status() {
		return this.statusValue;
	}
	/**
	* Start an attempt (or rejoin the live one) and resolve with its status —
	* `waiting` carrying the Studio URL once the loopback server is up.
	* Rejects only when the flow cannot start at all (no free port, disposed).
	*/
	async begin(targetRef) {
		if (this.disposed) throw new Error("login flow has been disposed");
		this.deps.validateTargetRef?.(targetRef);
		if (this.statusValue.state === "waiting" && this.server !== void 0) {
			if (this.targetRef !== targetRef) throw new Error("another account login is already in progress");
			return this.statusValue;
		}
		if (this.starting !== void 0) {
			if (this.targetRef !== targetRef) throw new Error("another account login is already in progress");
			return this.starting;
		}
		this.cancelPending = false;
		this.targetRef = targetRef;
		const starting = this.startAttempt(targetRef);
		this.starting = starting;
		try {
			return await starting;
		} finally {
			if (this.starting === starting) this.starting = void 0;
		}
	}
	/**
	* The binding half of {@link CommandCodeLoginFlow.begin}: one attempt, one
	* server, one published `waiting` status. Callers reach it only through
	* `begin()`'s single-flight fence.
	*/
	async startAttempt(targetRef) {
		this.teardown();
		const attempt = ++this.attemptSeq;
		this.attemptAbort = new AbortController();
		const port = await this.findPort();
		const expectedState = this.deps.randomToken?.(32) ?? randomBytes(32).toString("base64url");
		const settled = new Promise((resolve, reject) => {
			this.settle = {
				resolve,
				reject
			};
		});
		await this.bindServer(port, expectedState);
		if (this.disposed || this.cancelPending) {
			const cancelled = !this.disposed;
			this.cancelPending = false;
			this.teardown();
			if (cancelled) this.setStatus({
				state: "failed",
				reason: "cancelled"
			});
			return this.statusValue;
		}
		const apiBase = this.readApiBase();
		this.setStatus({
			state: "waiting",
			authUrl: buildCommandAuthUrl({
				studioBase: studioBaseForApiBase(apiBase),
				port,
				state: expectedState
			})
		});
		this.timer = setTimeout(() => {
			if (!this.ownsAttempt(attempt)) return;
			this.teardown();
			this.setStatus({
				state: "failed",
				reason: "timeout",
				message: "登录未在规定时间内完成，请重试。"
			});
		}, this.deps.timeoutMs ?? 12e4);
		this.timer.unref?.();
		settled.then((credentials) => this.complete(attempt, credentials, targetRef), (failure) => this.failFrom(attempt, failure));
		return this.statusValue;
	}
	/**
	* Cancel a waiting attempt; terminal states are untouched. A start that is
	* still binding a port is flagged instead of ignored — it cannot be torn
	* down from here (its server does not exist yet), so `startAttempt` observes
	* the flag once the bind settles and retires it.
	*/
	cancel() {
		if (this.disposed) return;
		if (this.statusValue.state === "waiting") {
			this.teardown();
			this.setStatus({
				state: "failed",
				reason: "cancelled"
			});
			return;
		}
		if (this.starting !== void 0) this.cancelPending = true;
	}
	/** 结束验证/监听并等待已开始的写入，供账号开通过程安全补偿。 */
	async cancelAndDrain() {
		this.cancel();
		await this.starting?.catch(() => void 0);
		this.cancel();
		await Promise.allSettled([...this.pendingStores]);
	}
	/** Stop everything; a waiting attempt ends cancelled. Idempotent. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelPending = false;
		const wasWaiting = this.statusValue.state === "waiting";
		this.teardown();
		if (wasWaiting) this.setStatus({
			state: "failed",
			reason: "cancelled"
		});
	}
	readApiBase() {
		return (typeof this.deps.apiBase === "function" ? this.deps.apiBase() : this.deps.apiBase) ?? "https://api.commandcode.ai";
	}
	setStatus(next) {
		this.statusValue = next;
		for (const listener of [...this.listeners]) listener();
	}
	/** First free port among the consecutive candidates. */
	async findPort() {
		const startPort = this.deps.startPort ?? 5959;
		const attempts = this.deps.maxPortAttempts ?? 10;
		for (let index = 0; index < attempts; index += 1) {
			const candidate = startPort + index;
			if (await checkPortAvailable(candidate)) return candidate;
		}
		throw new Error(`No available port found after ${attempts} attempts starting from port ${startPort}`);
	}
	/**
	* Bind the attempt's loopback server, resolving when the port is live.
	* Pre-bind failures reject (surfacing from `begin()`); a later server error
	* settles the live attempt as a tagged failure instead.
	*/
	bindServer(port, expectedState) {
		return new Promise((resolve, reject) => {
			let binding = true;
			const server = createServer((request, response) => this.handleCallback(request, response, expectedState));
			this.server = server;
			server.once("error", (error) => {
				if (this.server !== server) {
					closeServer(server);
					return;
				}
				this.server = void 0;
				closeServer(server);
				const tagged = new LoginSettleError("error", `Could not bind the login callback server on port ${port}: ${error.code ?? error.message}`);
				if (binding) {
					binding = false;
					reject(tagged);
				} else this.settle?.reject(tagged);
			});
			server.listen(port, "127.0.0.1", () => {
				if (!binding) return;
				binding = false;
				resolve();
			});
		});
	}
	/** One request against the attempt's callback endpoint (CLI-mirrored). */
	handleCallback(request, response, expectedState) {
		response.setHeader("Connection", "close");
		response.setHeader("Access-Control-Allow-Origin", corsOrigin(request.headers.origin));
		response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		response.setHeader("Content-Type", "application/json");
		const json = (code, body) => {
			response.writeHead(code);
			response.end(JSON.stringify(body));
		};
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		if ((request.url?.split("?")[0] ?? "/") !== "/callback") {
			json(404, {
				success: false,
				error: "Not found"
			});
			return;
		}
		if (request.method !== "POST") {
			json(405, {
				success: false,
				error: "Method not allowed. Use POST."
			});
			return;
		}
		let bodyBytes = 0;
		let body = "";
		request.on("data", (chunk) => {
			bodyBytes += chunk.length;
			body += chunk.toString();
			if (bodyBytes > 1e4) request.destroy();
		});
		request.on("end", () => {
			if (request.destroyed) return;
			let payload;
			try {
				payload = JSON.parse(body);
			} catch {
				json(400, {
					success: false,
					error: "Invalid JSON"
				});
				return;
			}
			if (typeof payload === "object" && payload !== null && "error" in payload) {
				const denial = payload;
				if (denial.state !== expectedState) {
					json(403, {
						success: false,
						error: "Invalid state token"
					});
					return;
				}
				const description = denial.error_description ?? denial.error;
				this.settleAttempt(json, 200, { success: true }, new LoginSettleError(denial.error === "access_denied" ? "denied" : "error", typeof description === "string" && description !== "" ? description : "Authorization failed"));
				return;
			}
			if (!isCallbackCredentials(payload)) {
				json(400, {
					success: false,
					error: "Missing required fields"
				});
				return;
			}
			if (payload.state !== expectedState) {
				json(403, {
					success: false,
					error: "Invalid state token"
				});
				return;
			}
			this.settleAttempt(json, 200, { success: true }, void 0, { ...payload });
		});
		request.on("error", () => {});
	}
	/** Answer a decisive callback, stop listening, and settle the attempt. */
	settleAttempt(json, code, body, failure, credentials) {
		json(code, body);
		const settle = this.settle;
		if (failure !== void 0) this.teardown();
		else this.closeCallback();
		if (settle === void 0) return;
		if (failure !== void 0) settle.reject(failure);
		else if (credentials !== void 0) settle.resolve(credentials);
	}
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
	async complete(attempt, credentials, targetRef) {
		if (!this.ownsAttempt(attempt)) return;
		const validation = await validateCommandApiKey(this.deps.fetchImpl ?? fetch, this.readApiBase(), credentials.apiKey, this.attemptAbort?.signal);
		if (!this.ownsAttempt(attempt)) return;
		if (!validation.valid) {
			const reason = validation.error === "invalid_key" ? "invalid-key" : validation.error === "network_error" ? "network" : "error";
			this.teardown();
			this.setStatus({
				state: "failed",
				reason,
				message: `/alpha/whoami rejected the delivered key (${validation.error}).`
			});
			return;
		}
		if (!this.ownsAttempt(attempt)) return;
		try {
			this.deps.validateTargetRef?.(targetRef);
			const store = Promise.resolve().then(() => {
				if (this.ownsAttempt(attempt)) return this.deps.storeKey(credentials, targetRef);
			});
			this.pendingStores.add(store);
			try {
				await store;
			} finally {
				this.pendingStores.delete(store);
			}
		} catch (error) {
			if (!this.ownsAttempt(attempt)) return;
			this.teardown();
			this.setStatus({
				state: "failed",
				reason: "unavailable",
				message: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		if (!this.ownsAttempt(attempt)) return;
		this.teardown();
		this.setStatus({
			state: "success",
			userName: credentials.userName,
			keyName: credentials.keyName
		});
	}
	/** Whether one attempt still owns the status face (not cancelled, replaced, or disposed). */
	ownsAttempt(attempt) {
		return !this.disposed && this.attemptSeq === attempt && this.statusValue.state === "waiting";
	}
	/** Map a tagged settle rejection onto the status face. */
	failFrom(attempt, failure) {
		if (!(failure instanceof LoginSettleError)) return;
		if (!this.ownsAttempt(attempt)) return;
		this.teardown();
		this.setStatus({
			state: "failed",
			reason: failure.reason,
			message: failure.message
		});
	}
	clearTimer() {
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
	}
	/** 消费一次回调后关闭监听；保留总期限以约束后续验证。 */
	closeCallback() {
		closeServer(this.server);
		this.server = void 0;
		this.settle = void 0;
	}
	/** 结束整个尝试，同时中止验证请求，迟到结果由所有权检查拦截。 */
	teardown() {
		this.clearTimer();
		this.attemptAbort?.abort();
		this.attemptAbort = void 0;
		this.closeCallback();
	}
};
/** Close one loopback server without letting "not running"/"already closed" escape. */
function closeServer(server) {
	try {
		server?.close();
	} catch {}
}
/** A tagged settle failure carrying the stable copy reason. */
var LoginSettleError = class extends Error {
	reason;
	constructor(reason, message) {
		super(message);
		this.reason = reason;
		this.name = "LoginSettleError";
	}
};
/** Echo the Origin header only when the Studio allowlist contains it. */
function corsOrigin(origin) {
	return origin !== void 0 && LOGIN_ALLOWED_ORIGINS.includes(origin) ? origin : "";
}
//#endregion
//#region src/enrollment.ts
const terminal = (state) => [
	"finished",
	"cancelled",
	"failed",
	"cleanup-needed",
	"naming"
].includes(state.phase);
var AccountEnrollmentManager = class {
	deps;
	tasks = /* @__PURE__ */ new Map();
	writes = Promise.resolve();
	closed = false;
	pages = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.deps = deps;
	}
	/** 每页独立的持续调用才代表页面生命期；宿主的 operator Peer 由所有浏览器共享。 */
	watch(owner) {
		if (this.closed || this.pages.has(owner)) throw new Error("账号开通页面已关闭或重复连接");
		this.pages.add(owner);
		return () => {
			this.pages.delete(owner);
			this.disconnect(owner);
		};
	}
	hasPage(owner) {
		return this.pages.has(owner);
	}
	/** begin 不等待整个过程；客户端预先生成的 id 让早到的取消也能生效。 */
	begin(owner, input) {
		this.prune();
		if (this.tasks.get(input.id)) return this.owned(owner, input.id).state;
		if (this.closed) throw new Error("账号开通服务已关闭");
		if (this.records().some((record) => record.id === input.id)) throw new Error("已有未完成记录，请先处理");
		const task = {
			owner,
			cancelled: false,
			state: {
				id: input.id,
				ref: "",
				phase: "creating",
				message: "正在创建账号"
			}
		};
		this.tasks.set(input.id, task);
		task.work = this.run(task, input).catch(() => {
			task.state = {
				...task.state,
				phase: "cleanup-needed",
				message: "收尾未完成，请重试"
			};
		});
		return task.state;
	}
	status(owner, id) {
		if (this.tasks.get(id)) return this.owned(owner, id).state;
		const record = this.records().find((record) => record.id === id);
		if (!record) throw new Error("账号开通过程不存在");
		return this.recovered(record);
	}
	pending(owner) {
		return this.records().filter((record) => {
			const task = this.tasks.get(record.id);
			return !task || (task.owner === "" || task.owner === owner) && terminal(task.state);
		}).map((record) => this.tasks.get(record.id)?.state ?? this.recovered(record));
	}
	/** 离开已登录的待命名过程等同接受已有名称，其余阶段等待写入结束再补偿。 */
	async cancel(owner, id) {
		this.prune();
		let task = this.tasks.get(id);
		if (!task) {
			if (this.records().some((record) => record.id === id)) return this.retry(owner, id);
			task = {
				owner,
				cancelled: true,
				state: {
					id,
					ref: "",
					phase: "cancelled",
					message: "已取消"
				}
			};
			this.tasks.set(id, task);
			return task.state;
		}
		task = this.owned(owner, id);
		if (task.state.phase === "naming") return this.name(owner, id);
		if (terminal(task.state)) return task.state;
		task.cancelled = true;
		task.state = {
			...task.state,
			phase: "cancelling",
			message: "正在等待写入结束并清理"
		};
		await task.flow?.cancelAndDrain();
		await task.work;
		return task.state;
	}
	disconnect(owner) {
		for (const [id, task] of this.tasks) if (task.owner === owner) this.cancel(owner, id).catch(() => {}).finally(() => {
			task.owner = "";
		});
	}
	dispose() {
		this.closed = true;
		for (const task of this.tasks.values()) this.disconnect(task.owner);
	}
	async name(owner, id, name) {
		const task = this.tasks.get(id);
		if (task) this.owned(owner, id);
		const record = this.records().find((item) => item.id === id);
		if (!record && task?.state.phase === "finished") return task.state;
		if (!record || record.phase !== "naming" && task?.state.phase !== "naming") throw new Error("账号尚未进入待命名阶段");
		try {
			await this.change((value) => {
				const accounts = value.accounts ?? [];
				if (!accounts.some((account) => account.apiKeyEnv === record.ref)) throw new Error("账号已被移除");
				return {
					...name?.trim() ? { accounts: accounts.map((account) => account.apiKeyEnv === record.ref ? {
						...account,
						label: name.trim()
					} : account) } : {},
					accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).filter((item) => item.id !== id)
				};
			});
			return this.publish(task, {
				id,
				ref: record.ref,
				phase: "finished",
				message: "账号开通完成"
			});
		} catch {
			return this.publish(task, {
				id,
				ref: record.ref,
				phase: "naming",
				message: "账号已登录，名称保存失败，请重试或接受已有名称",
				...name ? { suggestedName: name } : {}
			});
		}
	}
	async retry(owner, id, name) {
		const existing = this.tasks.get(id);
		if (existing) {
			this.owned(owner, id);
			await existing.work;
			if (!terminal(existing.state)) throw new Error("账号开通仍在进行");
		}
		const record = this.records().find((item) => item.id === id);
		if (!record) return this.status(owner, id);
		if (record.phase === "naming" || existing?.state.phase === "naming") return this.name(owner, id, name);
		const task = existing ?? {
			owner,
			cancelled: true,
			writeStarted: true,
			state: this.recovered(record)
		};
		this.tasks.set(id, task);
		task.work = this.cleanup(task).catch(() => {
			task.state = {
				...task.state,
				phase: "cleanup-needed",
				message: "清理未完成，请重试"
			};
		});
		await task.work;
		return task.state;
	}
	async run(task, input) {
		try {
			await this.change(async (value) => {
				const base = value.apiKeyEnv ?? "COMMANDCODE_API_KEY";
				const occupied = /* @__PURE__ */ new Set([
					base,
					...(value.accounts ?? []).map((account) => account.apiKeyEnv),
					...value.credentialCleanupRefs ?? [],
					...(value.accountEnrollmentTasks ?? []).map((item) => item.ref)
				]);
				let n = 2;
				let ref = "";
				for (let attempt = 0; attempt < 128; attempt++, n++) {
					if (occupied.has(`${base}_${n}`)) continue;
					const candidate = `${base}_${n}`;
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) throw new Error("凭据引用无效");
					const info = await this.deps.describe(candidate);
					if (info.configured) continue;
					if (!info.writable) throw new Error("凭据不可写");
					ref = candidate;
					break;
				}
				if (!ref) throw new Error("没有可用凭据引用");
				task.state = {
					...task.state,
					ref
				};
				return {
					accounts: [...value.accounts ?? [], {
						label: input.label,
						apiKeyEnv: ref
					}],
					accountEnrollmentTasks: [...value.accountEnrollmentTasks ?? [], {
						id: input.id,
						ref,
						phase: "pending",
						label: input.label
					}]
				};
			});
			if (task.cancelled) return await this.cleanup(task);
			const info = await this.deps.describe(task.state.ref);
			if (info.configured || !info.writable) throw new Error("凭据引用已占用或不可写");
			let suggested;
			if (input.mode === "manual") await this.store(task, input.key);
			else {
				const flow = this.deps.login(async (credentials) => {
					await this.store(task, credentials.apiKey);
				});
				task.flow = flow;
				const result = await new Promise((resolve, reject) => {
					const off = flow.onChange(() => {
						const status = flow.status();
						if (status.state === "success" || status.state === "failed") {
							off();
							resolve(status);
						}
					});
					flow.begin(task.state.ref).then((status) => {
						if (!task.cancelled && status.state === "waiting") task.state = {
							...task.state,
							phase: "waiting",
							message: "等待浏览器登录",
							...status.authUrl ? { authUrl: status.authUrl } : {}
						};
						if (task.cancelled) flow.cancelAndDrain();
					}, (error) => {
						off();
						reject(error);
					});
				});
				if (result.state !== "success") throw new Error("浏览器登录未完成");
				suggested = input.automaticName ? result.userName?.trim() : void 0;
			}
			if (task.cancelled) return await this.cleanup(task);
			task.state = {
				...task.state,
				phase: "naming",
				message: "账号已登录，正在保存名称",
				...suggested ? { suggestedName: suggested } : {}
			};
			try {
				await this.change((value) => ({ accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).map((item) => item.id === input.id ? {
					...item,
					phase: "naming",
					label: suggested || item.label
				} : item) }));
			} catch {
				if (task.state.phase === "finished") return;
				task.state = {
					...task.state,
					message: "账号已登录，名称保存失败，请重试或接受已有名称"
				};
				return;
			}
			await this.name(task.owner, input.id, suggested);
		} catch {
			if (task.cleanupStarted) throw new Error("账号清理未完成");
			await task.flow?.cancelAndDrain();
			if (task.state.ref && this.records().some((item) => item.id === task.state.id)) await this.cleanup(task);
			else task.state = {
				...task.state,
				phase: task.cancelled ? "cancelled" : "failed",
				message: task.cancelled ? "已取消" : "账号开通失败，未创建账号"
			};
		} finally {
			task.flow?.dispose();
		}
	}
	async store(task, key) {
		if (task.cancelled) throw new Error("已取消");
		task.state = {
			...task.state,
			phase: "writing",
			message: "正在保存凭据"
		};
		task.writeStarted = true;
		await this.deps.set(task.state.ref, key);
		if (!(await this.deps.describe(task.state.ref)).configured) throw new Error("凭据写入未确认");
	}
	async cleanup(task) {
		task.cleanupStarted = true;
		const { id, ref } = task.state;
		const snapshot = this.settings().read();
		if ((snapshot.value.apiKeyEnv ?? "COMMANDCODE_API_KEY") === ref || snapshot.base?.accounts?.some((account) => account.apiKeyEnv === ref)) throw new Error("不能清理默认或继承账号");
		await this.change((value) => {
			const record = (value.accountEnrollmentTasks ?? []).find((item) => item.id === id);
			if (!record || record.phase === "naming") throw new Error("不能清理已登录账号");
			return {
				accounts: (value.accounts ?? []).filter((account) => account.apiKeyEnv !== ref),
				modelAccountRules: (value.modelAccountRules ?? []).filter((rule) => rule.account !== ref),
				...value.activeAccount === ref ? { activeAccount: "" } : {},
				credentialCleanupRefs: [.../* @__PURE__ */ new Set([...value.credentialCleanupRefs ?? [], ref])],
				accountEnrollmentTasks: (value.accountEnrollmentTasks ?? []).map((item) => item.id === id ? {
					...item,
					phase: "cleanup"
				} : item)
			};
		});
		const value = this.settings().read().value;
		if ((value.apiKeyEnv ?? "COMMANDCODE_API_KEY") === ref || (value.accounts ?? []).some((account) => account.apiKeyEnv === ref) || (value.modelAccountRules ?? []).some((rule) => rule.account === ref) || value.activeAccount === ref) throw new Error("引用仍被使用，不能清理");
		const info = await this.deps.describe(ref);
		if (info.configured && task.writeStarted) {
			if (!info.writable) throw new Error("凭据不可清理");
			await this.deps.unset(ref);
			if ((await this.deps.describe(ref)).configured) throw new Error("凭据删除未确认");
		}
		await this.change((current) => ({
			accountEnrollmentTasks: (current.accountEnrollmentTasks ?? []).filter((item) => item.id !== id),
			credentialCleanupRefs: (current.credentialCleanupRefs ?? []).filter((item) => item !== ref)
		}));
		task.state = {
			id,
			ref,
			phase: task.cancelled ? "cancelled" : "failed",
			message: task.cancelled ? "已取消并清理" : "开通失败，已清理临时账号"
		};
	}
	settings() {
		const settings = this.deps.settings();
		if (!settings?.writable) throw new Error("设置服务不可写");
		return settings;
	}
	records() {
		return this.deps.settings()?.read().value.accountEnrollmentTasks ?? [];
	}
	change(patch) {
		const work = this.writes.catch(() => {}).then(async () => {
			const settings = this.settings();
			const { value, revision } = settings.read();
			const fields = await patch(value);
			await settings.mutate(Object.entries(fields).map(([key, item]) => ({
				op: "set",
				path: [key],
				value: item
			})), revision);
		});
		this.writes = work;
		return work;
	}
	owned(owner, id) {
		const task = this.tasks.get(id);
		if (!task || task.owner !== "" && task.owner !== owner) throw new Error("不能操作其他连接的开通过程");
		if (task.owner === "") task.owner = owner;
		return task;
	}
	publish(task, state) {
		if (task) task.state = state;
		return state;
	}
	/** 只淘汰已完成且没有恢复日志的旧状态，活跃过程和未收尾事实始终保留。 */
	prune() {
		if (this.tasks.size < 256) return;
		const recorded = new Set(this.records().map((record) => record.id));
		for (const [id, task] of this.tasks) {
			if (this.tasks.size < 256) break;
			if (terminal(task.state) && !recorded.has(id) && !this.pages.has(task.owner)) this.tasks.delete(id);
		}
	}
	recovered(record) {
		return {
			id: record.id,
			ref: record.ref,
			phase: record.phase === "naming" ? "naming" : "cleanup-needed",
			message: record.phase === "naming" ? "已登录账号等待确认名称" : "账号开通收尾未完成，请重试",
			...record.phase === "naming" ? { suggestedName: record.label } : {}
		};
	}
};
//#endregion
//#region src/web-search.ts
/**
* Command Code web-search provider over `ctx.web`.
*
* The official CLI's built-in `web_search` tool POSTs
* `{ query, numResults, allowedDomains?, blockedDomains? }` to
* `{apiBase}/alpha/web-search` and reads `{ results: [{ title, url, snippet }] }`
* back, authenticating with the SAME `Authorization: Bearer <key>` and
* `x-command-code-version` headers the model adapter uses. This provider
* therefore reuses the plugin's existing credential chain and `apiBase`, so
* the model-facing `web_search` tool needs no separate configuration.
*
* @module dsh-commandcode-provider/web-search
*/
/** Stable id this provider registers under in `ctx.web`. */
const COMMANDCODE_SEARCH_PROVIDER_ID = "commandcode";
/**
* The factory-declared search provider id dsh ships by default (from
* `dsh-base`'s cordis patch `web.config.searchProvider`). A documented
* reference only: disabling this plugin's `webSearch` toggle restores the
* PREVIOUSLY selected backend, never this default (issue #26).
*/
const DEFAULT_WEB_SEARCH_PROVIDER_ID = "deepseek-official";
/** Fresh selection state: the plugin starts out not owning the selection. */
function commandCodeSearchSelection() {
	return {
		owner: false,
		displaced: void 0,
		preexisting: false
	};
}
/**
* Reach one end of the `webSearch` toggle without trampling sibling search
* providers (issue #26).
*
* - Enabling writes `commandcode` and remembers whatever it displaced. When
*   the plugin already owns the selection, the original `displaced` is kept —
*   the field currently holds our own id, which must never be mistaken for the
*   user's backend.
* - Disabling hands the selection back to the remembered backend only when
*   this plugin actually took it over. A fresh boot straight into
*   `webSearch: false`, or a `preexisting` field, leaves it ALONE: writing the
*   empty memory back would clear the user's own `searchProvider: commandcode`
*   pin and hand the selection to dsh-web's auto-select, where a second usable
*   provider makes every later search throw `WEB_PROVIDER_AMBIGUOUS`.
*
* Never throws: like the low-level rewrite, a hardened runtime shape degrades
* to registered-but-unselected.
*/
function applyCommandCodeSearchSelection(web, state, enable) {
	try {
		const field = web;
		if (enable) {
			if (state.owner) {
				field.searchProviderId = COMMANDCODE_SEARCH_PROVIDER_ID;
				return;
			}
			const prior = field.searchProviderId;
			state.preexisting = prior === COMMANDCODE_SEARCH_PROVIDER_ID;
			state.displaced = state.preexisting ? void 0 : prior;
			field.searchProviderId = COMMANDCODE_SEARCH_PROVIDER_ID;
			state.owner = true;
			return;
		}
		if (state.owner) {
			state.owner = false;
			if (!state.preexisting) field.searchProviderId = state.displaced;
			state.preexisting = false;
			return;
		}
	} catch {}
}
/** Command Code's lower/upper bound on `numResults` (from the CLI's `web_search` schema). */
const MIN_NUM_RESULTS = 1;
const MAX_NUM_RESULTS = 10;
/** CLI default when the caller sets no result cap. */
const DEFAULT_NUM_RESULTS = 5;
/** The endpoint the search POST goes to; `{apiBase}` is prepended. */
const SEARCH_ROUTE = "/alpha/web-search";
/**
* Clamp a DSH `maxResults` bound into Command Code's 1–10 range, applying the
* CLI default of 5 when the caller supplied none.
*/
function clampNumResults(maxResults) {
	return maxResults === void 0 ? DEFAULT_NUM_RESULTS : Math.max(MIN_NUM_RESULTS, Math.min(MAX_NUM_RESULTS, Math.round(maxResults)));
}
/** Build a `WebSearchSource` from one raw `{ title, url, snippet }` result, omitting empty optional fields. */
function toSource(result) {
	const url = result.url?.trim();
	if (url === void 0 || url.length === 0) return void 0;
	const title = result.title?.trim();
	const snippet = result.snippet?.trim();
	return {
		url,
		...title !== void 0 && title.length > 0 ? { title } : {},
		...snippet !== void 0 && snippet.length > 0 ? { snippet } : {}
	};
}
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Command Code web search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal, void 0);
}
/**
* A `ctx.web` search provider backed by the Command Code Provider API, reusing
* the plugin's credential chain and `apiBase` so the model-facing `web_search`
* tool needs no separate configuration. Selection between multiple search
* providers is the web seam's job (pin `searchProvider: commandcode` if
* ambiguous).
*/
var CommandCodeSearchProvider = class {
	deps;
	id = COMMANDCODE_SEARCH_PROVIDER_ID;
	constructor(deps) {
		this.deps = deps;
	}
	/** Cheap local check; must not make network calls. Presence of a parseable base is enough. */
	available() {
		const base = this.deps.apiBase();
		return base.length > 0 && URL.canParse(base);
	}
	async search(request, signal) {
		throwIfAborted(signal);
		const apiBase = this.deps.apiBase();
		if (!URL.canParse(apiBase)) throw new WebError(`Command Code web search is misconfigured: apiBase ${JSON.stringify(apiBase)} is not a valid URL`, "WEB_PROVIDER_ERROR");
		const key = await this.resolveKey(signal, apiBase);
		throwIfAborted(signal);
		const endpoint = `${apiBase.replace(/\/$/, "")}${SEARCH_ROUTE}`;
		const body = {
			query: request.query,
			numResults: clampNumResults(request.maxResults)
		};
		let response;
		try {
			response = await (this.deps.fetchImpl ?? fetch)(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...IDENTITY_ENCODING_HEADER,
					Authorization: `Bearer ${key}`,
					"x-command-code-version": COMMAND_CODE_CLI_VERSION,
					"x-cli-environment": "production",
					...attributionHeaders()
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Command Code web search request failed: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Command Code web search failed (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed === "object" && parsed !== null ? parsed?.error : void 0;
				if (typeof detail === "string" && detail.length > 0) message += `: ${detail}`;
				else if (typeof detail === "object" && detail !== null) {
					const code = detail?.code;
					const inner = detail?.message;
					if (typeof code === "string" || typeof inner === "string") message += `: ${typeof code === "string" ? code : ""}${typeof code === "string" && typeof inner === "string" ? " — " : ""}${typeof inner === "string" ? inner : ""}`;
				}
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				const slice = (await response.text().catch(() => "")).trim().slice(0, 200);
				if (slice !== "") message += `: ${slice}`;
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError("Command Code web search returned an unparseable response body", "WEB_PROVIDER_ERROR", { cause: error });
		}
		const results = payload?.results;
		if (!Array.isArray(results)) throw new WebError("Command Code web search returned no results array (the server may have rejected the query)", "WEB_PROVIDER_ERROR");
		const sources = [];
		const seen = /* @__PURE__ */ new Set();
		for (const item of results) {
			if (typeof item !== "object" || item === null) continue;
			const source = toSource(item);
			if (source === void 0 || seen.has(source.url)) continue;
			seen.add(source.url);
			sources.push(source);
		}
		return {
			sources,
			truncated: false
		};
	}
	async resolveKey(signal, apiBase) {
		let key;
		try {
			key = await this.deps.resolveKey(apiBase);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof Error && typeof error.code === "string") {
				const code = error.code;
				if (code === "MISSING_CREDENTIAL") throw new WebError(error.message, "WEB_PROVIDER_CREDENTIAL_MISSING", { cause: error });
				if (code === "INVALID_CREDENTIAL" || code === "RATE_LIMIT") throw new WebError(error.message, "WEB_PROVIDER_ERROR", { cause: error });
			}
			throw new WebError(`Command Code web search credential resolution failed: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (key === void 0 || key.length === 0) throw new WebError("Command Code web search has no API key; store COMMANDCODE_API_KEY through the credentials service (the web Models page writes it), export it in the launching environment, set config.apiKey, or run `command-code login` to write ~/.commandcode/auth.json", "WEB_PROVIDER_CREDENTIAL_MISSING");
		return key;
	}
};
//#endregion
//#region src/tui-settings.ts
/** The selector value meaning "no pinned account — follow rotation order". */
const ACTIVE_ACCOUNT_AUTO = "auto";
/** The selector value meaning "no language override — follow the shell locale". */
const LANG_AUTO = "auto";
/** Tiers in picker order; a model outside this set joins the "Other" group. */
const TIER_ORDER = PLAN_TIER_ORDER;
/** The group holding models this build's catalog does not know. */
const OTHER_GROUP_ID = "models-other";
/**
* Every model this build knows, in checkbox order: plan tier (Go first), then
* free before paid inside a tier, then by id.
*
* The list is the static capability snapshot rather than a live catalog read
* on purpose — a settings page must draw synchronously. A model added
* upstream after this build still reaches the user: an empty allowlist shows
* everything, and a model named in the allowlist but absent here is rendered
* by the "Other" group instead of disappearing.
*/
function commandCodeTuiModelChoices() {
	return Object.keys(KNOWN_PLANS).map((id) => ({
		id,
		tier: KNOWN_PLANS[id] ?? "",
		free: isFreeModel(id),
		hint: capabilityDescription(id)
	})).sort((a, b) => {
		const tierDelta = tierRank(a.tier) - tierRank(b.tier);
		if (tierDelta !== 0) return tierDelta;
		if (a.free !== b.free) return a.free ? -1 : 1;
		return a.id.localeCompare(b.id);
	});
}
/** Sort rank of a tier key; unknown tiers trail every known one. */
function tierRank(tier) {
	const rank = TIER_ORDER.indexOf(tier);
	return rank === -1 ? TIER_ORDER.length : rank;
}
/** The stored allowlist as a clean id list (non-strings and blanks dropped). */
function storedIds(value) {
	return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id !== "") : [];
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
function buildCommandCodeTuiSection(deps) {
	const ref = deps.apiKeyRef();
	const slots = deps.accountSlots();
	const choices = (deps.modelChoices ?? commandCodeTuiModelChoices)();
	const catalogIds = choices.map((choice) => choice.id);
	const known = new Set(catalogIds);
	const stored = storedIds(deps.visibleModels());
	const overrides = deps.modelVisibility?.() ?? {};
	const extras = [.../* @__PURE__ */ new Set([...stored, ...Object.keys(overrides)])].filter((id) => !known.has(id));
	const tierGroups = TIER_ORDER.filter((tier) => choices.some((choice) => choice.tier === tier)).map((tier) => ({
		id: `models-${tier}`,
		title: `${PLAN_LABELS[tier] ?? tier} models`,
		descriptions: { zh: `${PLAN_LABELS[tier] ?? tier} 模型` }
	}));
	const unranked = choices.filter((choice) => tierRank(choice.tier) === TIER_ORDER.length);
	const otherGroup = unranked.length > 0 || extras.length > 0 ? [{
		id: OTHER_GROUP_ID,
		title: "Other models",
		descriptions: { zh: "其他模型" }
	}] : [];
	/**
	* One checkbox: a boolean at a path of its OWN (`modelVisibility.<id>`).
	*
	* The path must be unique per model. dsh-TUI keys a staged draft by the
	* field's path (`fieldKey`), so N checkboxes sharing `visibleModels` share
	* ONE draft: every one of them then parses that same draft on save, all N
	* write ops address the same path, and only the LAST field's op survives —
	* which silently rewrote the allowlist from the last catalog model instead
	* of the one that was toggled. 保存显式布尔值，不能因为与白名单相同就
	* 清除用户层：清除后可能重新露出基础配置中的相反开关。
	*/
	const modelField = (id, hint, group) => ({
		path: ["modelVisibility", id],
		group,
		kind: "boolean",
		label: id,
		...hint === "" ? {} : { hint },
		format: (value) => {
			if (typeof value === "boolean") return String(value);
			const listed = storedIds(deps.visibleModels());
			return String(listed.length === 0 || listed.includes(id));
		},
		parse: (text) => {
			return {
				kind: "set",
				value: text.trim() === "true"
			};
		}
	});
	return {
		ns: deps.ns,
		title: deps.title ?? "Command Code",
		descriptions: { zh: "Command Code（非官方）" },
		groups: [
			{
				id: "connection",
				title: "Connection",
				descriptions: { zh: "连接" }
			},
			{
				id: "models",
				title: "Models",
				descriptions: { zh: "模型" }
			},
			...tierGroups,
			...otherGroup,
			{
				id: "advanced",
				title: "Advanced",
				descriptions: { zh: "高级" }
			}
		],
		fields: [
			{
				path: ["apiKey"],
				group: "connection",
				kind: "text",
				label: "API key",
				descriptions: { zh: "API 密钥" },
				secret: { ref },
				hint: `Stored in the credential store as ${ref}, never in configuration files.`,
				hintDescriptions: { zh: `保存在凭据库（${ref}），不会写入配置文件。` }
			},
			{
				path: ["apiBase"],
				group: "connection",
				kind: "text",
				label: "API base",
				descriptions: { zh: "API 地址" },
				placeholder: "https://api.commandcode.ai",
				hint: "Leave empty for the public Command Code Provider API.",
				hintDescriptions: { zh: "留空即使用官方 Command Code Provider API。" },
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			},
			{
				path: ["zdr"],
				group: "advanced",
				kind: "boolean",
				label: "Zero data retention (ZDR)",
				descriptions: { zh: "零数据保留（ZDR）" },
				hint: "Route requests only through upstreams that retain nothing and never train on prompts (the CLI's CMD_ZDR=1). Models without an available ZDR upstream fail instead of losing protection; ZDR is usually billed at higher pass-through rates. Off by default.",
				hintDescriptions: { zh: "请求只经由不留存数据、也不用于训练的上游（等价于 CLI 的 CMD_ZDR=1）。没有可用 ZDR 上游的模型会报错，不会降级为非 ZDR 请求；ZDR 通常按更高的透传价计费。默认关闭。" },
				format: (value) => value === true ? "true" : "false",
				parse: (text) => ({
					kind: "set",
					value: text.trim() === "true"
				})
			},
			{
				path: ["offloadSeenImagesForCache"],
				group: "advanced",
				kind: "boolean",
				label: "Stop replaying images already seen",
				descriptions: { zh: "已看过的图片不再重复发送" },
				hint: "CLI transport only. After this model has answered, durably replace older images with text to keep later prompt text cacheable. Old pixels need a fresh file read or attachment to inspect again. Off by default.",
				hintDescriptions: { zh: "仅 CLI 传输。模型看过图片并回复后，永久用文字替代旧图，以保留后续文本缓存；重看旧图需要重新读取文件或附加。默认关闭。" },
				format: (value) => value === true ? "true" : "false",
				parse: (text) => ({
					kind: "set",
					value: text.trim() === "true"
				})
			},
			{
				path: ["filterModelsByPlan"],
				group: "models",
				kind: "boolean",
				label: "Hide out-of-plan models",
				descriptions: { zh: "隐藏套餐外的模型" },
				hint: "Keeps models above your subscription tier out of the picker. Fails open.",
				hintDescriptions: { zh: "在选择器里隐藏超出当前订阅档位的模型；判断不出来时全部显示。" },
				format: (value) => value === false ? "false" : "true",
				parse: (text) => ({
					kind: "set",
					value: text.trim() === "true"
				})
			},
			...choices.filter((choice) => tierRank(choice.tier) !== TIER_ORDER.length).map((choice) => modelField(choice.id, choice.hint, `models-${choice.tier}`)),
			...unranked.map((choice) => modelField(choice.id, choice.hint, OTHER_GROUP_ID)),
			...extras.map((id) => modelField(id, capabilityDescription(id), OTHER_GROUP_ID)),
			{
				path: ["activeAccount"],
				group: "advanced",
				kind: "text",
				label: "Active account",
				descriptions: { zh: "当前账号" },
				hint: "A pinned account id, or auto to follow the rotation order.",
				hintDescriptions: { zh: "固定使用某个账号的 id；auto 表示按轮换顺序自动选择。" },
				options: [{
					value: ACTIVE_ACCOUNT_AUTO,
					label: "Automatic (rotation order)",
					descriptions: { zh: "自动（按轮换顺序）" }
				}, ...slots.map((slot) => ({
					value: slot.id,
					label: slot.label,
					descriptions: { zh: slot.label }
				}))],
				format: (value) => typeof value === "string" && value.trim() !== "" ? value : ACTIVE_ACCOUNT_AUTO,
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" || trimmed === "auto" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			},
			{
				path: ["lang"],
				group: "advanced",
				kind: "text",
				label: "Command language",
				descriptions: { zh: "命令语言" },
				hint: "Language of the /commandcode dashboard; auto follows the shell locale.",
				hintDescriptions: { zh: "/commandcode 用量面板的语言；auto 跟随终端 locale。" },
				options: [
					{
						value: LANG_AUTO,
						label: "Automatic (shell locale)",
						descriptions: { zh: "自动（跟随终端 locale）" }
					},
					{
						value: "zh",
						label: "中文"
					},
					{
						value: "en",
						label: "English"
					}
				],
				format: (value) => value === "zh" || value === "en" ? value : LANG_AUTO,
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" || trimmed === "auto" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			}
		]
	};
}
/**
* The `tuiSettingsSections` service, read defensively.
*
* The service name is declared by dsh-TUI's own module augmentation, which
* this package deliberately does not import, so the typed `Context` has no
* such property. The read goes through the REFLECTIVE `ctx.get` rather than a
* bare property access: cordis refuses a property read for a service the fiber
* never declared in `inject` (`cannot get property … without inject`), and an
* unmeet seam must degrade to "no section" instead of throwing out of the
* plugin's boot.
*/
function tuiSettingsService(ctx) {
	let candidate;
	try {
		candidate = ctx.get("tuiSettingsSections");
	} catch {
		return;
	}
	if (typeof candidate !== "object" || candidate === null) return void 0;
	const register = candidate.register;
	if (typeof register !== "function") return void 0;
	return { register: register.bind(candidate) };
}
/**
* Identity of everything in the section that can change at runtime: the
* credential reference behind the API-key field, the account slots behind the
* active-account selector, and the stored-but-unknown allowlist entries that
* get a checkbox of their own. Re-registration is skipped while this matches,
* so ordinary settings writes never churn the screen's section list — the
* checkboxes themselves read their state live and need no re-declaration.
*/
function sectionSignature(section) {
	const active = section.fields.find((field) => field.path.join(".") === "activeAccount");
	return JSON.stringify({
		secret: section.fields.find((field) => field.secret !== void 0)?.secret?.ref ?? "",
		options: active?.options?.map((option) => option.value) ?? [],
		other: section.fields.filter((field) => field.group === OTHER_GROUP_ID).map((field) => field.label)
	});
}
/**
* Register the Command Code section on a dsh-TUI host.
*
* @returns a refresh function that re-registers the section when a fact it
*   renders changed — the plugin entry calls it from its
*   `loader/volatile-update` listener — or `undefined` when the seam is
*   unusable. The returned function is inert after the fiber is torn down.
*/
function applyCommandCodeTuiSettings(ctx, deps) {
	const service = tuiSettingsService(ctx);
	if (service === void 0) return void 0;
	let disposed = false;
	let current;
	const refresh = () => {
		if (disposed) return;
		const section = buildCommandCodeTuiSection(deps);
		const signature = sectionSignature(section);
		if (current?.signature === signature) return;
		current?.dispose();
		current = void 0;
		try {
			current = {
				signature,
				dispose: service.register(section)
			};
		} catch (error) {
			ctx.logger?.warn(`llm-commandcode: could not register the dsh-TUI settings section: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	refresh();
	ctx.effect(() => () => {
		disposed = true;
		current?.dispose();
		current = void 0;
	}, "dsh-commandcode-provider: tui settings section");
	return refresh;
}
//#endregion
//#region src/transport-retry.ts
/**
* A bounded retry budget for `TRANSPORT` failures (issue #39, second report).
*
* The route policy (`providerRetryPolicy` in `./adapter.ts`) is near-unbounded
* on purpose — 1000 attempts doubling to a 15-minute cap — for failures the
* provider ASKS to have retried. A connection that cannot be established is
* not that: a blip the first few attempts absorb, or an outage no in-request
* waiting fixes (attempt 11 alone already waits 512 s). So transport failures
* get their own budget, cleared at each new STEP (one step = one model
* request). `agent/status` → `idle` is NOT the reset (one `running` phase spans
* a turn's steps), and neither is `assistant/attempt` (appended for the FAILED
* attempt itself, which would clear the budget on every failure).
*
* Not counted here: the adapter's in-`stream()` pre-stream recovery (account
* rotation, the 413 step-down, the Provider-API → CLI switch) — invisible to
* the caller and bounded on its own.
*
* @module
*/
/** Failure code this budget covers. */
const TRANSPORT_FAILURE_CODE = "TRANSPORT";
/** One agent's live transport-failure count, keyed weakly so a dropped agent cannot leak. */
const counts = /* @__PURE__ */ new WeakMap();
/**
* Count one attempt's outcome against the transport budget.
*
* @param agent - the identity the budget is scoped to (the agent object).
* @param failureCode - the failed attempt's `LlmFailure.code`.
* @param maxRetries - transport retries to absorb before the failure surfaces.
* @returns `'ignored'` for any non-transport code (the route policy decides
*   those, unchanged), `'retry'` while the budget has room, `'exhausted'` once
*   it does not.
*/
function absorbTransportFailure(agent, failureCode, maxRetries) {
	if (failureCode !== "TRANSPORT") return "ignored";
	const used = counts.get(agent) ?? 0;
	if (used >= maxRetries) return "exhausted";
	counts.set(agent, used + 1);
	return "retry";
}
/** Clear one agent's transport budget (a new step starts, or the turn ended). */
function resetTransportFailures(agent) {
	counts.delete(agent);
}
/**
* What one session event means for the transport budget.
*
* Pure and exported on purpose: the choice of event is the part of this design
* that is easy to get plausibly wrong (see the module comment), so it is stated
* once, where a test can pin it.
*
* @param type - the appended session event's type.
* @returns `'reset'` for a new step, `'forget'` when the turn ended (the
*   session → agent mapping is no longer needed), otherwise `'none'`.
*/
function transportResetAction(type) {
	if (type === "step/start") return "reset";
	if (type === "turn/end") return "forget";
	return "none";
}
/**
* The diagnosis a capped turn ends with. Bilingual, because the harness renders
* a failed turn's message verbatim and this plugin's other user-facing failures
* are too; it names the retry budget and the checks that actually help instead
* of the bare "fetch failed" chain the retry chrome would otherwise show.
*/
function transportBudgetMessage(failureMessage, maxRetries) {
	return `${failureMessage}；Command Code API 连接在连续重试后仍失败——已停止重试以免整轮卡死。插件已自动重试 ${maxRetries} 次。通常说明当前网络到 api.commandcode.ai 的连接不通，常见原因是代理未生效：DSH 只读取环境变量 HTTPS_PROXY/HTTP_PROXY（系统代理/PAC 不会被读取），请确认启动 DSH 的终端里已导出代理，或先关闭代理直连后重试。网络恢复后直接重发即可 — Command Code API transport still failed after ${maxRetries} automatic retries, which were stopped so the turn could not stall for minutes. This is a connectivity problem between this machine and api.commandcode.ai, not a context-window or request-size rejection. Common cause: the proxy is not reaching the harness — DSH reads HTTPS_PROXY/HTTP_PROXY from the environment only (a Windows system proxy/PAC setting is not consulted), so export it in the launching shell, or turn the proxy off and retry. Resend when the network recovers; the budget is per request and has been reset`;
}
//#endregion
//#region src/config-volatile.ts
/**
* Volatile-config helpers for dsh 0.1.7's schema-derived profile Config.
*
* 0.1.7's `settings.describe()` projects each entry's schema through
* `volatileForm()`, so a form contains ONLY nodes carrying `meta.volatile`
* and a form edit is refused unless its path lies beneath a marked node. The
* loader then resolves each marked field into a frozen `{ get() }` reference
* that is written IN PLACE (no remount) and announced with
* `loader/volatile-update`. Two helpers keep the rest of the plugin reading a
* PLAIN `Config`: `markVolatile()` applies the mark, and
* `unwrapVolatileConfig()` reads every top-level field through its reference
* when one is present — FRESH per call, because a reference's identity is
* stable while its value changes.
*
* Only TOP-LEVEL fields are marked (a form write names a top-level path such
* as `accounts` or `modelVisibility.<id>`), so one unwrap level is complete.
* The literal `apiKey` secret stays unmarked on purpose: no settings surface
* writes it — page and TUI both write keys through the credentials seam — so a
* config-file edit to it reloading the fiber is correct for a secret literal.
*
* @module dsh-commandcode-provider/config-volatile
*/
/**
* Mark one schema field volatile.
*
* `.volatile()` is unconditional: it is a schemastery 3.18.3 feature and the
* only supported engine (`dsh 0.2.1-alpha.1`) pins `~3.18.5-alpha.1`, so the
* method is always present. It is reached through a structural member so the caller's
* declared field type survives — the mark changes what the schema PARSES to (a
* live reference), not the plugin-facing `Config` shape.
*/
function markVolatile(schema) {
	return schema.volatile();
}
/**
* Mark every field of a Config field dict volatile, except the named
* composition-only secrets (`apiKey` here, which no settings surface writes).
*/
function markVolatileFields(fields, skip = []) {
	return Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, skip.includes(name) ? schema : markVolatile(schema)]));
}
/**
* Whether a resolved config value is a volatile reference.
*
* Duck-typed on the two properties `createVolatile` produces (frozen object
* with a `get` method) rather than cosmokit's private `write` symbol, because
* cosmokit is not a peer of this bundle. Config values are plain parsed JSON
* (or `!!jsExpr` wrappers), which are never frozen, so the test cannot
* misfire on an ordinary field.
*/
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.isFrozen(value) && typeof value.get === "function";
}
/**
* Read one config object as PLAIN values.
*
* Every top-level field found to be a volatile reference is read through
* `.get()` — freshly on every call, so a live update lands on the very next
* read (the loader resolves EVERY marked node into a reference, unset fields
* included, so a loader-parsed config always yields a fresh object here). The
* pass-through for a field that is not a reference is what keeps the unmarked
* `apiKey` literal readable.
*/
function unwrapVolatileConfig(config) {
	const source = config;
	if (typeof source !== "object" || source === null) return config;
	const plain = {};
	for (const [field, value] of Object.entries(source)) plain[field] = isVolatileRef(value) ? value.get() : value;
	return plain;
}
//#endregion
//#region src/index.ts
/**
* dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
* Code (unofficial; ported from pi-commandcode-provider@0.5.1, MIT).
*
* Registers the `commandcode` provider route on `ctx.llm` and declares it in
* the configurable-provider directory, so the web Models page shows a
* "Command Code" card and the model picker lists the live catalog. Connection
* facts are resolved per request from the live profile Config (volatile
* fields, unwrapped per read) and the credential seam, so a changed key,
* endpoint or cache path reaches the next request without a restart.
*
* ```yaml
* - id: llm-commandcode
*   name: "@mars-sea/dsh-commandcode-provider"
*   config:
*     apiKeyEnv: COMMANDCODE_API_KEY
* ```
*
* The `name` is the full package specifier as installed in the profile's
* node_modules: the loader imports it as a module, and pnpm links packages by
* their true (scoped) name — a bare `dsh-commandcode-provider` fails to
* resolve (ERR_MODULE_NOT_FOUND) and crashes the app on boot. The value must
* be quoted in YAML: an unquoted scalar starting with `@` fails to parse.
*
* @module dsh-commandcode-provider
*/
const name = "llm-commandcode";
const inject = ["llm"];
const NS = "llm-commandcode";
const DEFAULT_API_KEY_ENV = "COMMANDCODE_API_KEY";
/** The single provider route this plugin owns. */
const PROVIDER = "commandcode";
/** Default models cache path (mirrors the pi plugin's on-disk cache). */
const DEFAULT_MODELS_CACHE_PATH = join(homedir(), ".commandcode", "models-cache.json");
/**
* The Config schema: every field volatile except the composition-only `apiKey`
* secret. 0.1.7's settings forms are projected from the schema's
* `meta.volatile` nodes, so an unmarked field would be invisible to AND
* unwritable from the settings page. The loader also hands `apply()` a live
* reference per marked field, so writes commit in place without remounting
* this fiber — the `loader/volatile-update` listener at the bottom of `apply`
* re-derives the two facts that are not re-read per request.
*/
const Config = z.object(markVolatileFields({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	apiKey: z.string().role("secret"),
	apiBase: z.string(),
	workingDir: z.string(),
	modelsCachePath: z.string(),
	requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
	streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
	offloadSeenImagesForCache: z.boolean().default(false),
	transportMaxRetries: z.number().min(0).max(50),
	filterModelsByPlan: z.boolean(),
	visibleModels: z.array(z.string()),
	modelVisibility: z.dict(z.boolean()),
	webSearch: z.boolean().default(true),
	showSidebarQuota: z.boolean().default(false),
	accounts: z.array(z.object({
		label: z.string(),
		apiKeyEnv: z.string().role("credential-ref"),
		/** Literal key for one extra slot; see the top-level `apiKey` secret note. */
		apiKey: z.string().role("secret")
	})),
	activeAccount: z.string(),
	credentialCleanupRefs: z.array(z.string().role("credential-ref")),
	accountEnrollmentTasks: z.array(z.object({
		id: z.string(),
		ref: z.string().role("credential-ref"),
		phase: z.union([
			"pending",
			"naming",
			"cleanup"
		]),
		label: z.string()
	})),
	modelAccountRules: z.array(z.object({
		models: z.array(z.string()),
		account: z.string()
	})),
	zdr: z.boolean().default(false),
	lang: z.string().pattern(/^(zh|en)$/).default("zh")
}, ["apiKey"]));
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every default is re-judged here — for the composition entry at load and for
* every settings-backed read.
*/
function resolveAdapterOptions(config) {
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		apiBase: config.apiBase ?? "https://api.commandcode.ai",
		workingDir: config.workingDir ?? process.cwd(),
		modelsCachePath: config.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH,
		requestTimeoutMs: config.requestTimeoutMs ?? 3e5,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 3e5,
		offloadSeenImagesForCache: config.offloadSeenImagesForCache === true,
		filterModelsByPlan: config.filterModelsByPlan ?? true,
		visibleModels: Array.isArray(config.visibleModels) ? config.visibleModels.filter((id) => typeof id === "string" && id !== "") : void 0,
		modelVisibility: readModelVisibility(config.modelVisibility),
		zdr: config.zdr === true
	};
}
/**
* Per-model visibility overrides, cleaned for the adapter: a non-object or a
* non-boolean entry is dropped rather than reaching the picker filter, and an
* all-empty map reads as no map. Returns a fresh id → boolean map, or
* undefined when nothing is set.
*/
function readModelVisibility(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && typeof entry[1] === "boolean");
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}
function apply(ctx, config) {
	installCostProjection(ctx);
	const current = () => unwrapVolatileConfig(config);
	const options = () => {
		const raw = current();
		return {
			...resolveAdapterOptions(raw),
			accountSelection: captureAccountSelection({
				slots: slots(raw),
				preferredId: preferredId(raw),
				modelAccountRules: raw.modelAccountRules ?? []
			})
		};
	};
	const slots = (raw = current()) => {
		const list = [{
			id: "default",
			label: "Default",
			ref: credentialRef(raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
			literal: raw.apiKey,
			allowAuthFile: true
		}];
		for (const [index, account] of (raw.accounts ?? []).entries()) {
			const refName = typeof account.apiKeyEnv === "string" && account.apiKeyEnv.trim() !== "" ? account.apiKeyEnv.trim() : void 0;
			const literal = typeof account.apiKey === "string" && account.apiKey !== "" ? account.apiKey : void 0;
			if (raw.accountEnrollmentTasks?.some((task) => task.ref === refName && task.phase !== "naming")) continue;
			if (refName === void 0 && literal === void 0) continue;
			list.push({
				id: refName ?? `account-${index + 2}`,
				label: typeof account.label === "string" && account.label.trim() !== "" ? account.label.trim() : `Account ${index + 2}`,
				ref: refName === void 0 ? void 0 : credentialRef(refName),
				literal,
				allowAuthFile: false
			});
		}
		return list;
	};
	const preferredId = (config = current()) => {
		const raw = config.activeAccount;
		return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
	};
	const resolveRef = async (ref) => {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) return (await credentials.resolve(ref))?.value;
		const ambient = launchEnvironmentOf(ctx).get(ref);
		return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
	};
	const pool = new CommandCodeAccountPool({
		slots,
		resolveRef,
		authFileKey: resolveAuthFileApiKey,
		probeWindow: (apiKey) => adapter.probeWindowLimits(apiKey),
		preferredId,
		modelAccountRules: () => current().modelAccountRules ?? []
	});
	const scopedPool = (connection) => pool.scope({
		apiBase: connection.apiBase,
		...connection.accountSelection,
		probeWindow: (key) => adapter.probeWindowLimits(key, connection)
	});
	const resolveApiKey = async (connection, model) => {
		const resolved = await scopedPool(connection).resolveKey(model === void 0 ? {} : { model });
		if (resolved !== void 0) return assertUsableApiKey(resolved.key, "llm-commandcode", resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`);
		const ref = connection.apiKeyEnv;
		throw new LlmError(`llm-commandcode: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), export it in the launching environment, set config.apiKey, or run \`command-code login\` to write ~/.commandcode/auth.json`, "MISSING_CREDENTIAL");
	};
	const adapter = new CommandCodeAdapter({
		options,
		resolveApiKey,
		rotateApiKey: async (rejectedKey, rejection, connection, model, rotation) => {
			const accounts = scopedPool(connection);
			if (rejection !== "unavailable") accounts.markRejected(rejectedKey, rejection, rotation?.resetAtMs);
			const tried = rotation?.tried?.length ? rotation.tried : [rejectedKey];
			const resolved = await accounts.resolveKey(model === void 0 ? { tried } : {
				tried,
				model
			});
			return resolved === void 0 ? void 0 : assertUsableApiKey(resolved.key, "llm-commandcode", resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`);
		},
		resolveAttachments: () => {
			const attachments = ctx.get("attachments");
			return attachments === void 0 ? void 0 : attachments;
		},
		resolveAccountKeys: async (connection) => {
			return (await scopedPool(connection).resolvedAccounts()).map((account) => account.key);
		}
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Command Code",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	const transportMaxRetries = () => {
		const value = current().transportMaxRetries;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 5;
		return Math.min(Math.trunc(value), 50);
	};
	const sessionAgents = /* @__PURE__ */ new WeakMap();
	ctx.on("agent/request-error", async ({ agent, provider, failure, signal }, next) => {
		if (signal.aborted || provider !== "commandcode") return next();
		const session = Reflect.get(agent, "session");
		if (typeof session === "object" && session !== null) sessionAgents.set(session, agent);
		const transient = absorbTransientFailure(agent, failure.code);
		if (transient === "exhausted") throw new Error(transientBudgetMessage(failure.code, failure.message));
		if (transient === "retry") return next();
		const decision = absorbTransportFailure(agent, failure.code, transportMaxRetries());
		if (decision === "ignored") return next();
		if (decision === "retry") return { kind: "retry" };
		const message = transportBudgetMessage(failure.message, transportMaxRetries());
		ctx.logger.warn(`llm-commandcode: transport retry budget exhausted for ${PROVIDER} (${TRANSPORT_FAILURE_CODE})`);
		throw new Error(message);
	});
	ctx.on("session/event", (session, event) => {
		const action = transportResetAction(event.type);
		if (action === "forget") {
			sessionAgents.delete(session);
			return;
		}
		if (action !== "reset") return;
		const agent = sessionAgents.get(session);
		if (agent !== void 0) {
			resetTransportFailures(agent);
			resetTransientFailures(agent);
		}
	});
	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "idle") {
			resetTransportFailures(agent);
			resetTransientFailures(agent);
		}
	});
	const usageReports = async () => {
		const connection = options();
		const accounts = scopedPool(connection);
		const active = await accounts.activeAccount();
		const described = await accounts.describeAccounts();
		const byId = new Map(described.map((account) => [account.slot.id, account]));
		return { accounts: await Promise.all(connection.accountSelection.slots.map(async (slot) => {
			const account = byId.get(slot.id);
			let report;
			if (account === void 0) report = { failures: [] };
			else try {
				report = await adapter.getUsage(account.key, connection);
			} catch (error) {
				report = { failures: [error instanceof Error ? error.message : String(error)] };
			}
			const state = account?.state;
			const usable = accountUsable(state);
			return {
				id: slot.id,
				label: slot.label,
				configured: account !== void 0,
				active: account !== void 0 && active?.slot.id === slot.id,
				mark: usable ? "" : state?.kind === "disabled" ? "invalid-credential" : "rate-limit",
				cooldownUntil: !usable && state?.kind === "cooldown" ? state.until : 0,
				report
			};
		})) };
	};
	const commandLocale = () => pickCommandLocale(current().lang);
	ctx.inject(["commands"], (commandCtx) => {
		applyCommands(commandCtx, {
			adapter,
			reports: usageReports,
			getLocale: commandLocale
		});
	});
	const loginFlow = new CommandCodeLoginFlow({
		apiBase: () => options().apiBase,
		validateTargetRef: (targetRef) => {
			loginCredentialRef(targetRef, current().apiKeyEnv ?? DEFAULT_API_KEY_ENV, current().accounts ?? []);
		},
		storeKey: async ({ apiKey }, targetRef) => {
			const ref = credentialRef(loginCredentialRef(targetRef, current().apiKeyEnv ?? DEFAULT_API_KEY_ENV, current().accounts ?? []));
			const credentials = ctx.get("credentials");
			if (credentials === void 0) throw new Error("the credentials service is unavailable in this profile; paste the key manually");
			await credentials.set(ref, apiKey);
		}
	});
	ctx.effect(() => () => loginFlow.dispose(), "dsh-commandcode-provider: login flow");
	const catalogForEditors = async () => {
		const models = await adapter.listModels(PROVIDER, { unfiltered: true });
		const bracket = await adapter.allowanceTier();
		return { models: models.map((model) => {
			const tier = KNOWN_PLANS[model.id];
			const allowance = bracket === void 0 ? void 0 : modelAllowanceFor(model.id)?.[bracket];
			return {
				id: model.id,
				name: model.name.replace(/\s*\(CC\)$/, ""),
				...tier === void 0 ? {} : { tier },
				...allowance === void 0 ? {} : { allowance }
			};
		}) };
	};
	let enrollmentSettings;
	const enrollment = new AccountEnrollmentManager({
		settings: () => enrollmentSettings,
		describe: async (ref) => {
			const credentials = ctx.get("credentials");
			if (!credentials) throw new Error("凭据服务不可用");
			return credentials.describe(credentialRef(ref));
		},
		set: async (ref, key) => {
			const credentials = ctx.get("credentials");
			if (!credentials) throw new Error("凭据服务不可用");
			await credentials.set(credentialRef(ref), key);
		},
		unset: async (ref) => {
			const credentials = ctx.get("credentials");
			if (!credentials) throw new Error("凭据服务不可用");
			await credentials.unset(credentialRef(ref));
		},
		login: (storeKey) => new CommandCodeLoginFlow({
			apiBase: () => options().apiBase,
			storeKey
		})
	});
	ctx.effect(() => () => enrollment.dispose(), "dsh-commandcode-provider: account enrollment");
	applyUsageRemote(ctx, {
		adapter,
		reports: usageReports,
		login: loginFlow,
		enrollment,
		listModels: catalogForEditors
	});
	const searchSelection = commandCodeSearchSelection();
	const applySearchSelection = (enabled) => {
		if (webRuntime !== void 0) applyCommandCodeSearchSelection(webRuntime, searchSelection, enabled);
	};
	let webRuntime;
	ctx.inject(["web"], (webCtx) => {
		webRuntime = webCtx.web;
		webCtx.web.registerSearchProvider(new CommandCodeSearchProvider({
			resolveKey: async (apiBase) => {
				const connection = options();
				if (apiBase !== void 0) connection.apiBase = apiBase;
				const resolved = await scopedPool(connection).resolveKey();
				return resolved === void 0 ? void 0 : resolved.key;
			},
			apiBase: () => options().apiBase
		}));
		applySearchSelection(current().webSearch ?? true);
		webCtx.effect(() => () => {
			webRuntime = void 0;
			applyCommandCodeSearchSelection(webCtx.web, searchSelection, false);
		}, "dsh-commandcode-provider: web search selection");
	});
	let refreshTuiSettings;
	ctx.inject(["tuiSettingsSections"], (tuiCtx) => {
		refreshTuiSettings = applyCommandCodeTuiSettings(tuiCtx, {
			ns: NS,
			apiKeyRef: () => current().apiKeyEnv ?? DEFAULT_API_KEY_ENV,
			accountSlots: () => slots().map((slot) => ({
				id: slot.id,
				label: slot.label
			})),
			visibleModels: () => options().visibleModels ?? [],
			modelVisibility: () => options().modelVisibility
		});
		tuiCtx.effect(() => () => {
			refreshTuiSettings = void 0;
		}, "dsh-commandcode-provider: tui settings handle");
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const settings = settingsCtx.settings;
		enrollmentSettings = {
			get writable() {
				return settings.writable;
			},
			read: () => {
				const descriptor = settings.describe().find((item) => item.ns === NS);
				if (!descriptor) throw new Error("账号设置不存在");
				return {
					value: descriptor.value,
					revision: descriptor.revision,
					...descriptor.base ? { base: descriptor.base } : {}
				};
			},
			mutate: (ops, revision) => settings.mutate(NS, ops, revision)
		};
		settingsCtx.effect(() => () => {
			enrollmentSettings = void 0;
		}, "dsh-commandcode-provider: enrollment settings");
		settingsCtx.effect(() => {
			const dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber);
			return () => {
				dispose();
			};
		}, "dsh-commandcode-provider: settings auto-form policy");
	});
	const loaderEvents = ctx;
	ctx.effect(() => {
		const off = loaderEvents.on("loader/volatile-update", () => {
			applySearchSelection(current().webSearch ?? true);
			refreshTuiSettings?.();
		});
		return () => {
			if (typeof off === "function") off();
		};
	}, "dsh-commandcode-provider: volatile config updates");
}
//#endregion
export { ACTIVE_ACCOUNT_AUTO, BILLING_ACCESS_TTL_MS, COMMANDCODE_SEARCH_PROVIDER_ID, COMMAND_CODE_CLI_VERSION, CommandCodeAccountPool, CommandCodeAdapter, CommandCodeLoginFlow, CommandCodeSearchProvider, CommandCodeUsageService, Config, DEFAULT_API_BASE, DEFAULT_GENERATE_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODELS_CACHE_PATH, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PROVIDER_ID, KNOWN_DEALS, KNOWN_EFFORTS, KNOWN_IMAGE_MODELS, KNOWN_NON_ZDR_MODELS, KNOWN_PEAK_PRICING, KNOWN_PLANS, KNOWN_SUBSCRIPTION_PLANS, KNOWN_THINKING_MODELS, LANG_AUTO, LOGIN_ALLOWED_ORIGINS, LOGIN_BEGIN_ENDPOINT, LOGIN_BODY_LIMIT_BYTES, LOGIN_CANCEL_ENDPOINT, LOGIN_MAX_PORT_ATTEMPTS, LOGIN_START_PORT, LOGIN_STATUS_ENDPOINT, LOGIN_TIMEOUT_MS, PLAN_LABELS, PLAN_ORDER, PROVIDER, USAGE_REPORT_ENDPOINT, accountUsable, apply, applyCommandCodeSearchSelection, applyCommandCodeTuiSettings, applyCommands, applyUsageRemote, buildCommandAuthUrl, buildCommandCodeTuiSection, capabilityDescription, commandCodeSearchSelection, commandDefinition, compareByPlan, dealLabel, formatContext, inject, loginStatusSchema, matchModelRule, modelVisibleInPlan, name, parseLoginStatus, peakPricingLabel, peakPricingState, planLabel, projectSlugFromPath, resolveAdapterOptions, resolveAuthFileApiKey, selectAccountForModel, selectActiveAccount, studioBaseForApiBase, subscriptionPlanInfo, supportsZeroDataRetention, usageReportSchema, validateCommandApiKey };

//# sourceMappingURL=index.js.map