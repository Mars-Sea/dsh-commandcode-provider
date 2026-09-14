import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, assertUsableApiKey, attributionHeaders, errorChain, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createServer } from "node:http";
import { createServer as createServer$1 } from "node:net";
import { WebError } from "@deepseek-ai/dsh-web";
//#region src/accounts.ts
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
*
* The pool is deliberately cordis-free (like the adapter): every host fact
* arrives through injected thunks, so node tests can drive it directly.
*
* @module dsh-commandcode-provider/accounts
*/
/**
* Upper bound on the retry wait this pool attaches to the all-exhausted
* `RATE_LIMIT` error. Must equal the `backoff.maxDelayMs` in the adapter's
* `providerRetryPolicy` (which imports it from here): dsh-llm-retry honors a
* provider-specified wait verbatim only at or below that cap — in normal mode
* a LONGER attached wait makes the executor abandon the retry entirely
* instead of falling back to local backoff, which would turn "poll until the
* window opens" into "fail now".
*/
const RETRY_MAX_DELAY_MS = 9e5;
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
* Pick the account that should serve now: the manually preferred slot when it
* is usable, otherwise the first usable account in rotation order; undefined
* when no account is usable. Shared by the pool (request path) and the plugin
* entry (the usage view's active badge) so both always agree.
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
/**
* The account pool. Rotation state is keyed by API key (never logged), so two
* slots resolving to the same credential share one mark, and a key changed in
* the credentials service starts with a clean slate.
*/
var CommandCodeAccountPool = class {
	deps;
	/** Rotation state by API key. */
	states = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
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
	async resolveKey(options) {
		const accounts = await this.resolvedAccounts();
		if (accounts.length === 0) return;
		const routed = selectAccountForModel(accounts, options?.model ?? "", this.deps.modelAccountRules?.());
		if (routed !== void 0) return this.pick(routed);
		const preferred = this.deps.preferredId?.();
		const chosen = selectActiveAccount(accounts, preferred);
		if (chosen !== void 0) return this.pick(chosen);
		await Promise.all(accounts.map(async (account) => {
			if (account.state?.kind === "disabled") return;
			if (options?.exclude !== void 0 && account.key === options.exclude) return;
			let probe;
			try {
				probe = await this.deps.probeWindow(account.key);
			} catch {
				return;
			}
			if (probe === void 0) return;
			if (!probe.exceeded) this.states.delete(account.key);
			else this.states.set(account.key, {
				kind: "cooldown",
				reason: account.state?.reason ?? "rate limited (429)",
				until: probe.resetAt
			});
		}));
		const latest = await this.resolvedAccounts();
		const revived = selectActiveAccount(latest, preferred);
		if (revived !== void 0) return this.pick(revived);
		if (latest.filter((account) => account.state?.kind === "disabled").length === latest.length) throw new LlmError(`llm-commandcode: every configured Command Code account (${latest.length}) was rejected with 401 — check the stored API keys (Models page / settings) or the auth file；已配置的 ${latest.length} 个 Command Code 账户密钥均被拒绝（401）——请在设置页检查存储的 API 密钥，或重新运行 command-code login`, "INVALID_CREDENTIAL");
		const resets = latest.map((account) => account.state).filter((state) => state !== void 0 && state.kind === "cooldown" && state.until > 0).map((state) => state.until);
		const earliest = resets.length > 0 ? Math.min(...resets) : 0;
		const wait = earliest > 0 ? Math.max(1e3, earliest - Date.now()) : 0;
		throw new LlmError(`llm-commandcode: all ${latest.length} Command Code account(s) have exhausted their usage window` + (earliest > 0 ? `; the earliest window resets at ${clockLabel(earliest)}` : "") + ` — requests will succeed again after the reset (or add another account)；已用尽全部 ${latest.length} 个 Command Code 账户的用量窗口` + (earliest > 0 ? `，最早的重置时间为 ${clockLabel(earliest)}` : "") + "——窗口重置后请求会自动恢复（也可以添加更多账户）", "RATE_LIMIT", wait > 0 && wait <= 9e5 ? { providerRetryAfterMs: wait } : void 0);
	}
	/**
	* Record a rejection against one key. `rate-limit` (429) marks the key
	* exhausted with an unknown reset (probed lazily at the next resolution
	* once every account is marked); `invalid-credential` (401) disables the
	* key until the stored credential changes.
	*/
	markRejected(apiKey, rejection) {
		if (rejection === "invalid-credential") this.states.set(apiKey, {
			kind: "disabled",
			reason: "invalid API key (401)",
			until: 0
		});
		else this.states.set(apiKey, {
			kind: "unknown",
			reason: "rate limited (429)",
			until: 0
		});
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
	/** Hand out the chosen account's key. */
	pick(account) {
		return {
			key: account.key,
			slot: account.slot
		};
	}
};
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
//#region src/capabilities.ts
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
	"deepseek/deepseek-v4-flash-fast": [
		"low",
		"high",
		"max"
	],
	"deepseek/deepseek-v4.1-flash": [
		"low",
		"high",
		"max"
	],
	"deepseek/deepseek-v4-flash": ["high", "max"],
	"deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
	"deepseek/deepseek-v4-pro": ["high", "max"],
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
	"z-ai/glm-5.3-flash": [
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
	"MiniMaxAI/MiniMax-M3": [
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
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4.1-flash",
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
	"thinkingmachines/inkling",
	"thinkingmachines/inkling-small",
	"xai/grok-4.5",
	"xai/grok-4.6",
	"xiaomi/mimo-v2.5",
	"z-ai/glm-5.3-flash"
]);
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
	"meituan/LongCat-2.0:free",
	"inclusionai/ling-3.0-flash-sante:free"
]);
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
	"deepseek/deepseek-v4-flash-fast": "go",
	"deepseek/deepseek-v4.1-flash": "go",
	"deepseek/deepseek-v4-flash": "go",
	"deepseek/deepseek-v4-flash-vision-exp": "go",
	"deepseek/deepseek-v4-pro": "go",
	"gpt-5.6-luna": "go",
	"meituan/LongCat-2.0:free": "go",
	"inclusionai/ling-3.0-flash-sante:free": "go",
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
	"tencent/hy3-paid": "go",
	"tencent/hy4-preview": "go",
	"thinkingmachines/inkling": "go",
	"thinkingmachines/inkling-small": "go",
	"xai/grok-4.5": "go",
	"xiaomi/mimo-v2.5": "go",
	"xiaomi/mimo-v2.5-pro": "go",
	"z-ai/glm-5.3-flash": "go",
	"zai-org/GLM-5": "go",
	"zai-org/GLM-5.1": "go",
	"zai-org/GLM-5.2": "go",
	"zai-org/GLM-5.2-Fast": "go",
	"zai-org/GLM-5.3": "go",
	"google/gemini-3.7-flash": "goat",
	"google/gemini-3.8-flash": "goat",
	"gpt-5.6-sol": "goat",
	"meta/muse-spark-1.2": "goat",
	"meta/muse-spark-1.3": "goat",
	"xai/grok-4.6": "goat",
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
	"meta/muse-spark-1.1": "pro",
	"claude-fable-5-1": "provider",
	"claude-fable-5": "provider",
	"claude-opus-4-7": "provider",
	"claude-opus-4-8": "provider",
	"claude-opus-5": "provider",
	"gpt-6-astra": "provider",
	"sakana/fugu-ultra": "provider"
};
/** Official display labels for each plan tier. */
const PLAN_LABELS = {
	go: "Go",
	goat: "GOAT",
	pro: "Pro",
	provider: "Provider",
	max: "Max"
};
/**
* Plan-tier sort weights, low to high. Models outside the snapshot (unknown
* plans) sort after every known tier, keeping known models predictable.
*/
const PLAN_ORDER = {
	go: 0,
	goat: 1,
	pro: 2,
	provider: 3,
	max: 4
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
const KNOWN_SUBSCRIPTION_PLANS = {
	"individual-go": {
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
const KNOWN_DEALS = {
	"MiniMaxAI/MiniMax-M3": { label: "50% off" },
	"xiaomi/mimo-v2.5-pro": { label: "99% off" },
	"xiaomi/mimo-v2.5": { label: "98% off" },
	"poolside/laguna-s-2.1-free": {
		label: "FREE",
		free: true
	},
	"meituan/LongCat-2.0:free": {
		label: "FREE",
		free: true
	},
	"inclusionai/ling-3.0-flash-sante:free": {
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
* The V4 Flash Vision (exp) variant (command-code@1.32.0) shares the V4 Flash
* rates exactly — $0.15/$0.60 off-peak and $0.30/$1.20 peak, per the page's own
* `timeOfDay` block, not merely 2× its own off-peak figures: a rate that is
* internally consistent can still be the wrong row, which is why the vendored
* price table (`./model-prices.ts`) is synced from the page and not hand-kept.
* The picker shows the
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
const KNOWN_PEAK_PRICING = /* @__PURE__ */ new Set([
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4.1-flash"
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
	const at = new Date(now);
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return false;
	const hour = at.getUTCHours();
	return PEAK_HOUR_RANGES.some(([start, end]) => hour >= start && hour < end);
}
/**
* Whether `now` (defaults to `Date.now()`) falls in a peak-pricing window for
* time-of-day-priced models. Peak rates apply Monday–Friday (UTC) only: the
* official rule charges Saturday and Sunday completely off-peak for all 24
* hours, so a weekend timestamp is off-peak even inside `PEAK_HOUR_RANGES`.
* `undefined` for models outside the snapshot.
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
//#region src/adapter.ts
/**
* DeepSeek Harness LLM adapter for the Command Code Provider API.
*
* Ported from pi-commandcode-provider@0.5.1 (MIT). This is an unofficial,
* community-maintained integration; you need your own Command Code account
* and API key or subscription, and Command Code's terms apply.
*
* Wire protocol (reverse-engineered by the pi plugin, command-code@1.28.4;
* re-verified against command-code@1.53.1 — endpoints, request shape, and
* stream events unchanged):
*   POST {apiBase}/alpha/generate
*   body: { config, memory, taste, skills, params: { model, messages, tools,
*          system, max_tokens, temperature, stream, reasoning_effort? }, threadId }
*   SSE-ish JSONL events: text-delta | reasoning-start/delta/end | tool-call
*                         | tool-result | finish | error
*   Model catalog: GET {apiBase}/provider/v1/models -> { object: 'list', data: [...] }
*
* The adapter is deliberately free of cordis/schemastery: it receives a
* per-request options thunk and an API-key resolver from the plugin entry
* (src/index.ts), so a settings change reaches the very next request.
*/
const COMMAND_CODE_CLI_VERSION = "1.53.1";
const DEFAULT_API_BASE = "https://api.commandcode.ai";
const DEFAULT_GENERATE_MAX_TOKENS = 64e3;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
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
/** Head-of-request timeout: how long to wait for the first response byte. */
const DEFAULT_REQUEST_TIMEOUT_MS = 6e4;
/** Stream idle timeout: a generation that stalls this long is a dead connection. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const MODEL_CACHE_VERSION = 1;
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
* Terminal stream-error markers from the official CLI (`Xw` in command-code's
* cli.mjs): these always mean "retrying cannot succeed", so the adapter must
* not classify them as transient server errors.
*/
const TERMINAL_STREAM_ERROR_MARKERS = [
	"premium_credits_exhausted",
	"model_not_in_plan",
	"insufficient credits"
];
function hasTerminalStreamMarker(message) {
	const lower = message.toLowerCase();
	return TERMINAL_STREAM_ERROR_MARKERS.some((marker) => lower.includes(marker));
}
function recordOrEmpty(value) {
	if (isRecord(value)) return value;
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		if (isRecord(parsed)) return parsed;
	} catch {}
	return {};
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
function parseCatalogResponse(value) {
	if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data)) throw new LlmError("Unexpected Command Code models response shape", "PROVIDER_PROTOCOL_ERROR");
	const models = [];
	for (const entry of value.data) {
		if (!isRecord(entry)) continue;
		const id = stringValue(entry.id);
		const name = stringValue(entry.name);
		const contextLength = numberValue(entry.context_length);
		if (!id || !name || !contextLength || contextLength <= 0) continue;
		models.push({
			id,
			name,
			contextWindow: contextLength,
			maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS)
		});
	}
	if (models.length === 0) throw new LlmError("Command Code returned an empty model catalog", "PROVIDER_PROTOCOL_ERROR");
	return models;
}
async function readModelsCache(cachePath) {
	const parsed = JSON.parse(await readFile(cachePath, "utf-8"));
	if (!isRecord(parsed) || parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.models)) throw new Error(`Invalid model cache at ${cachePath}`);
	return parsed.models;
}
async function writeModelsCache(cachePath, models) {
	await mkdir(dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.${process.pid}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify({
			version: MODEL_CACHE_VERSION,
			models
		}, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
		await rename(tmp, cachePath);
	} finally {
		await rm(tmp, { force: true }).catch(() => void 0);
	}
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
	for (const message of messages) for (const block of message.content) {
		if (message.role === "assistant" && block.type === "tool-call") {
			callIds.add(block.id);
			names.set(block.id, block.name);
		}
		if (block.type === "tool-result") resultIds.add(block.toolCallId);
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
* sequential alias is enough: no durable state, no cross-request stability,
* and the harness log keeps the original ids.
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
* invisible to a Vision model (issue #30). Deduplication keeps a result that
* repeats one attachment from paying for the same pixels twice.
*/
function toolResultMedia(block) {
	const chunks = [];
	const images = [];
	const seen = /* @__PURE__ */ new Set();
	const walk = (blocks) => {
		for (const nested of blocks) {
			if (nested.type === "text" || nested.type === "reasoning") {
				if (nested.text) chunks.push(nested.text);
				continue;
			}
			if (nested.type === "image") {
				if (!seen.has(nested.attachment.attachmentId)) {
					seen.add(nested.attachment.attachmentId);
					images.push(nested.attachment);
				}
				continue;
			}
			if (nested.type === "tool-result") walk(nested.content);
		}
	};
	walk(block.content);
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
* The note names the tool call the image came out of, because a turn's
* carriers are emitted as a group after the whole tool group (issue #33):
* position alone would have to carry the association, and every `read_image`
* result renders the same envelope text, so two parallel calls would produce
* two identical notes. The id is the WIRE id — the one the model saw on the
* `tool-call` it issued and on the tool message just above — so an overlong
* cross-provider id is named by the alias that replaced it, not by the
* harness-side id the model never saw.
*
* Count and pixel dimensions are appended when the tool's own text does not
* already state them (a result that returns the image and nothing else).
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
	const check = (blocks) => blocks.some((b) => b.type === "image" || b.type === "tool-result" && check(b.content));
	return check(message.content);
}
/**
* Convert one image reference to the Command Code wire format, as the official
* CLI does: `{ type: 'image', source: { type: 'base64', media_type, data } }`.
* Bytes come from the durable attachment service; the media type is the one
* verified at save time.
*/
async function imageToCommandCode(ref, readImage) {
	const data = await readImage(ref);
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: ref.mediaType,
			data: Buffer.from(data).toString("base64")
		}
	};
}
async function messagesToCC(messages, readImage) {
	const out = [];
	const { ids: paired, names: toolNames } = pairedToolCalls(messages);
	const wireIds = wireToolCallIds(paired);
	const pendingImages = [];
	const flushPendingImages = () => {
		for (const message of pendingImages) out.push(message);
		pendingImages.length = 0;
	};
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user" && message.source.kind !== "tool") {
			flushPendingImages();
			const parts = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push({
					type: "text",
					text: block.text
				});
				if (block.type === "image") {
					if (!readImage) throw new LlmError("Image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
					parts.push(await imageToCommandCode(block.attachment, readImage));
				}
			}
			if (parts.length === 0) continue;
			out.push({
				role: "user",
				content: parts
			});
			continue;
		}
		if (message.role === "assistant") {
			flushPendingImages();
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
			if (parts.length > 0) out.push({
				role: "assistant",
				content: parts
			});
			continue;
		}
		if (message.role === "user" && message.source.kind === "tool") {
			const block = message.content[0];
			if (!block || block.type !== "tool-result" || !paired.has(block.toolCallId)) continue;
			const media = toolResultMedia(block);
			const wireToolCallId = wireIds.get(block.toolCallId) ?? block.toolCallId;
			out.push({
				role: "tool",
				content: [{
					type: "tool-result",
					toolCallId: wireToolCallId,
					toolName: toolNames.get(block.toolCallId) || "unknown",
					output: block.isError ? {
						type: "error-text",
						value: toolResultTextForWire(media)
					} : {
						type: "text",
						value: toolResultTextForWire(media)
					}
				}]
			});
			if (media.images.length > 0) {
				if (!readImage) throw new LlmError("Image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const carried = [{
					type: "text",
					text: toolResultImageNote(media, wireToolCallId)
				}];
				for (const attachment of media.images) carried.push(await imageToCommandCode(attachment, readImage));
				pendingImages.push({
					role: "user",
					content: carried
				});
			}
		}
	}
	flushPendingImages();
	return out;
}
/**
* Convert one image reference to the OpenAI Chat Completions wire format:
* `{ type: 'image_url', image_url: { url: 'data:...;base64,...' } }`.
*/
async function imageToOpenAI(ref, readImage) {
	const data = await readImage(ref);
	return {
		type: "image_url",
		image_url: { url: `data:${ref.mediaType};base64,${Buffer.from(data).toString("base64")}` }
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
async function messagesToOpenAI(messages, readImage) {
	const out = [];
	const { ids: paired } = pairedToolCalls(messages);
	const wireIds = wireToolCallIds(paired);
	const pendingImages = [];
	const flushPendingImages = () => {
		for (const message of pendingImages) out.push(message);
		pendingImages.length = 0;
	};
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user" && message.source.kind !== "tool") {
			flushPendingImages();
			const parts = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push({
					type: "text",
					text: block.text
				});
				if (block.type === "image") {
					if (!readImage) throw new LlmError("Image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
					parts.push(await imageToOpenAI(block.attachment, readImage));
				}
			}
			if (parts.length === 0) continue;
			if (!parts.some((part) => part.type === "image_url") && parts.length === 1) out.push({
				role: "user",
				content: parts[0].text
			});
			else out.push({
				role: "user",
				content: parts
			});
			continue;
		}
		if (message.role === "assistant") {
			flushPendingImages();
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
			if (text === "" && reasoning === "" && toolCalls.length === 0) continue;
			const assistant = {
				role: "assistant",
				content: text === "" ? null : text
			};
			if (reasoning !== "") assistant.reasoning_content = reasoning;
			if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
			out.push(assistant);
			continue;
		}
		if (message.role === "user" && message.source.kind === "tool") {
			const block = message.content[0];
			if (!block || block.type !== "tool-result" || !paired.has(block.toolCallId)) continue;
			const media = toolResultMedia(block);
			const wireToolCallId = wireIds.get(block.toolCallId) ?? block.toolCallId;
			out.push({
				role: "tool",
				tool_call_id: wireToolCallId,
				content: toolResultTextForWire(media)
			});
			if (media.images.length > 0) {
				if (!readImage) throw new LlmError("Image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const carried = [{
					type: "text",
					text: toolResultImageNote(media, wireToolCallId)
				}];
				for (const attachment of media.images) carried.push(await imageToOpenAI(attachment, readImage));
				pendingImages.push({
					role: "user",
					content: carried
				});
			}
		}
	}
	flushPendingImages();
	return out;
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
/** Parse one window-limit block (`fiveHour` / `weekly`). */
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
		monthlyReported: numberValue(creditsData?.monthlyCredits) !== void 0
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
/**
* Classify a TOTAL failure: when every endpoint failed with one class of
* error, the degraded per-endpoint view would hide the root cause behind
* a generic "partial data" note — name it instead.
*/
function classifyTotalFailure(failures, failedStatuses) {
	if (failures.length !== USAGE_ENDPOINT_COUNT) return void 0;
	const codes = failedStatuses.filter((status) => status !== void 0);
	if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code === 401)) return "invalid-key";
	if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code >= 500)) return "service-unavailable";
	if (codes.length === 0) return "network";
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
		params: {
			model: options.model,
			messages: await messagesToCC(options.messages, facts.readImage),
			tools: (options.tools ?? []).map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				input_schema: toolParametersSchema(tool.parameters)
			})),
			system: facts.systemText,
			max_tokens: facts.maxTokens,
			temperature: options.temperature ?? .3,
			stream: true,
			...facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}
		},
		threadId: randomUUID()
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
* One pre-stream connect attempt: POST the body and wait for response
* headers only (`requestTimeoutMs` must never bound the body stream — see
* the caller). Returns the live response plus its cleanup, or the rejection
* facts for the rotation loop to classify. Every failure path cleans up
* before returning or throwing; on success the caller-abort listener
* outlives the connect phase (it aborts a stalled body read), so the
* streaming tail calls cleanup.
*/
async function connectGenerate(deps, key, protocol, body) {
	const { options, connection, fetchImpl } = deps;
	const connectAbort = new AbortController();
	let connectTimedOut = false;
	const endpoint = protocol === "cli" ? `${connection.apiBase}/alpha/generate` : `${connection.apiBase}/provider/v1/chat/completions`;
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
	const headers = protocol === "cli" ? {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
		"x-command-code-version": COMMAND_CODE_CLI_VERSION,
		"x-cli-environment": "production",
		"x-project-slug": projectSlugFromPath(connection.workingDir),
		"x-taste-learning": "true",
		"x-co-flag": "false",
		...attributionHeaders()
	} : {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
		Accept: "text/event-stream",
		...attributionHeaders()
	};
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: connectAbort.signal
		});
		clearTimeout(connectTimer);
	} catch (error) {
		cleanup();
		if (options.signal?.aborted) throw error;
		if (connectTimedOut || error instanceof DOMException && error.name === "TimeoutError") throw new LlmError(`Command Code API request to ${endpoint} did not respond within ${connection.requestTimeoutMs}ms: ${errorChain(error)}；Command Code API 请求在 ${connection.requestTimeoutMs} 毫秒内未收到响应——通常是网络或代理问题，请检查后重试`, "TIMEOUT", { cause: error });
		throw new LlmError(`Command Code API request to ${endpoint} failed: ${errorChain(error)}；Command Code API 请求连接失败——通常是网络或代理问题，请检查网络或代理设置后重试`, "TRANSPORT", { cause: error });
	}
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		cleanup();
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
/** Fresh block-assembly state for one stream. */
function createBlockAssembler() {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		sawContent: false,
		openAiToolCalls: []
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
var CommandCodeAdapter = class extends LlmAdapter {
	deps;
	catalog = [];
	fetchImpl;
	resolveAttachments;
	billingAccess = /* @__PURE__ */ new Map();
	billingAccessInflight = /* @__PURE__ */ new Map();
	protocolCache = /* @__PURE__ */ new Map();
	constructor(deps) {
		super();
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.resolveAttachments = deps.resolveAttachments;
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
	providerRetryPolicy(_provider) {
		return resolveRetryPolicy({
			mode: "normal",
			maxRetries: 1e3,
			retryableCodes: [
				"EMPTY_RESPONSE",
				"RATE_LIMIT",
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
	/** Refresh the catalog (live fetch, cache fallback) and return it. */
	async loadCatalog(signal) {
		const { apiBase, modelsCachePath } = this.deps.options();
		try {
			const response = await this.fetchImpl(`${apiBase}/provider/v1/models`, {
				headers: {
					accept: "application/json",
					...attributionHeaders()
				},
				signal: signal ?? AbortSignal.timeout(1e4)
			});
			if (!response.ok) throw new Error(`models endpoint returned ${response.status}`);
			this.catalog = parseCatalogResponse(await response.json());
			await writeModelsCache(modelsCachePath, this.catalog).catch(() => void 0);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.catalog = await readModelsCache(modelsCachePath).catch(() => this.catalog);
		}
		return this.catalog;
	}
	async listModels(provider, opts) {
		const catalog = await this.loadCatalog();
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
		const access = this.deps.options().filterModelsByPlan === false ? void 0 : await this.loadBillingAccess();
		const visible = this.deps.options().visibleModels;
		const allow = Array.isArray(visible) && visible.length > 0 ? new Set(visible.filter((id) => typeof id === "string" && id !== "")) : void 0;
		const overrides = this.deps.options().modelVisibility;
		return catalog.filter((model) => modelVisibleInPlan(model.id, access)).filter((model) => {
			const override = overrides?.[model.id];
			if (typeof override === "boolean") return override;
			return allow === void 0 || allow.has(model.id);
		}).map(toInfo).sort(compareByPlan);
	}
	async resolveModel(provider, model, signal) {
		const entry = this.catalog.find((m) => m.id === model) ?? (await this.loadCatalog(signal)).find((m) => m.id === model);
		const efforts = KNOWN_EFFORTS[model];
		const vision = KNOWN_IMAGE_MODELS.has(model);
		return {
			provider,
			id: model,
			name: entry ? `${entry.name} (CC)` : model,
			description: capabilityDescription(model, entry?.contextWindow),
			inputModalities: vision ? ["text", "image"] : ["text"],
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
		return {
			Authorization: `Bearer ${apiKey ?? await this.deps.resolveApiKey(connection)}`,
			"x-command-code-version": COMMAND_CODE_CLI_VERSION,
			"x-cli-environment": "production",
			...attributionHeaders()
		};
	}
	/**
	* Fetch one account endpoint and parse its JSON body. Returns the HTTP
	* status alongside the parsed record so each caller applies its own
	* failure accounting: the billing probe fails open silently, the usage
	* report books failures per endpoint. Non-2xx and non-record bodies come
	* back without a record; only a transport throw propagates to the caller.
	*/
	async fetchEndpointJson(url, headers) {
		const response = await this.fetchImpl(url, {
			headers,
			signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
		});
		if (!response.ok) return { status: response.status };
		const parsed = await response.json();
		return {
			status: response.status,
			...isRecord(parsed) ? { record: parsed } : {}
		};
	}
	/**
	* The billing facts behind the picker's plan filter, cached for
	* {@link BILLING_ACCESS_TTL_MS} and shared across concurrent callers.
	* `undefined` means "unknown — show everything" (fail-open).
	*/
	async loadBillingAccess() {
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(this.deps.options());
		} catch {
			return;
		}
		const cached = this.billingAccess.get(apiKey);
		if (cached !== void 0 && Date.now() - cached.at < 3e5) return cached.value;
		const existing = this.billingAccessInflight.get(apiKey);
		if (existing !== void 0) return existing;
		const inflight = this.fetchBillingAccess(apiKey).then((value) => {
			this.billingAccess.set(apiKey, {
				value,
				at: Date.now()
			});
			return value;
		}).finally(() => {
			this.billingAccessInflight.delete(apiKey);
		});
		this.billingAccessInflight.set(apiKey, inflight);
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
	async fetchBillingAccess(apiKey) {
		try {
			const connection = this.deps.options();
			const headers = await this.accountHeaders(apiKey);
			const base = connection.apiBase;
			const getJson = async (path) => (await this.fetchEndpointJson(`${base}${path}`, headers)).record;
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
	cachedBillingTierWeight(apiKey) {
		const hit = this.billingAccess.get(apiKey);
		if (hit === void 0 || Date.now() - hit.at >= 3e5) return void 0;
		return hit.value?.tierWeight;
	}
	/** Cached protocol decision for a key, or undefined when expired/unknown. */
	cachedProtocolUseCli(apiKey) {
		const hit = this.protocolCache.get(apiKey);
		if (hit === void 0 || Date.now() - hit.at >= 9e5) return void 0;
		return hit.useCli;
	}
	rememberProtocol(apiKey, useCli) {
		this.protocolCache.set(apiKey, {
			useCli,
			at: Date.now()
		});
	}
	/**
	* Choose the initial protocol for one request. A fresh protocol cache entry
	* wins; otherwise a cached (not network-fetched) billing tier of Go is
	* treated as CLI-only. Unknown accounts default to Provider API and fall
	* back only after an `upgrade_required` rejection.
	*/
	resolveProtocol(apiKey) {
		const forced = this.deps.options().protocol;
		if (forced === "cli" || forced === "openai") return forced;
		const cached = this.cachedProtocolUseCli(apiKey);
		if (cached !== void 0) return cached ? "cli" : "openai";
		if (this.cachedBillingTierWeight(apiKey) === GO_TIER_WEIGHT) {
			this.rememberProtocol(apiKey, true);
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
	*/
	async getUsage(apiKey) {
		const base = this.deps.options().apiBase;
		const headers = await this.accountHeaders(apiKey);
		const failures = [];
		const failedStatuses = [];
		const getJson = async (path) => {
			try {
				const { status, record } = await this.fetchEndpointJson(`${base}${path}`, headers);
				if (record === void 0) {
					failures.push(`${path}: HTTP ${status}`);
					failedStatuses.push(status);
					return;
				}
				return record;
			} catch (error) {
				failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				failedStatuses.push(void 0);
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
		const blocked = classifyTotalFailure(failures, failedStatuses);
		if (blocked !== void 0) report.blocked = blocked;
		return report;
	}
	/**
	* Probe one account's five-hour window from `/alpha/billing/credits`. The
	* multi-account pool calls this when every account is marked exhausted: an
	* account whose window no longer reports `exceeded` is revived, and the
	* `resetAt` values feed the "earliest reset" error message. Returns
	* `undefined` when the probe itself failed (transport, non-200, or a
	* payload without window limits) — a failed probe never changes pool state.
	*/
	async probeFiveHourWindow(apiKey) {
		try {
			const connection = this.deps.options();
			const response = await this.fetchImpl(`${connection.apiBase}/alpha/billing/credits`, {
				headers: await this.accountHeaders(apiKey),
				signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
			});
			if (!response.ok) return void 0;
			const parsed = await response.json();
			if (!isRecord(parsed)) return void 0;
			const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : void 0;
			const fiveHour = windowLimits && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : void 0;
			if (fiveHour === void 0) return void 0;
			return {
				exceeded: fiveHour.exceeded === true,
				resetAt: numberValue(fiveHour.resetAt) ?? 0
			};
		} catch {
			return;
		}
	}
	async *stream(options) {
		if (options.stop?.length) throw new LlmError("Command Code adapter does not support stop sequences", "UNSUPPORTED_OPTION");
		const hasImages = options.messages.some(hasImageContent);
		let readImage;
		if (hasImages) {
			if (!KNOWN_IMAGE_MODELS.has(options.model)) throw new LlmError(`Command Code model "${options.model}" does not support image input; switch to a Vision-capable model (see the model registry)`, "UNSUPPORTED_CONTENT");
			const attachments = this.resolveAttachments?.();
			if (attachments === void 0) throw new LlmError("Command Code image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
			readImage = (ref) => attachments.readImage(ref).then((stored) => stored.data);
		}
		const connection = this.deps.options();
		let apiKey = await this.deps.resolveApiKey(connection, options.model);
		const modelMax = this.catalog.find((m) => m.id === options.model)?.maxTokens ?? 65536;
		const maxTokens = Math.min(options.maxTokens ?? modelMax, modelMax, DEFAULT_GENERATE_MAX_TOKENS);
		const effort = options.reasoningEffort;
		const supported = KNOWN_EFFORTS[options.model];
		const reasoningEffort = effort && effort !== "off" && supported?.includes(effort) ? effort : void 0;
		const systemText = [options.system ?? "", ...options.messages.filter((m) => m.role === "system").map((m) => m.content.map(blockText).filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
		let protocol = this.resolveProtocol(apiKey);
		const buildBody = async (target) => target === "cli" ? buildCliBody(options, connection, {
			maxTokens,
			reasoningEffort,
			systemText,
			readImage
		}) : buildOpenAIBody(options, {
			maxTokens,
			reasoningEffort,
			systemText,
			readImage
		});
		let body = await buildBody(protocol);
		const tried = /* @__PURE__ */ new Set();
		const connectDeps = {
			options,
			connection,
			fetchImpl: this.fetchImpl
		};
		let connected;
		for (;;) {
			tried.add(apiKey);
			const attempt = await connectGenerate(connectDeps, apiKey, protocol, body);
			if ("response" in attempt) {
				connected = attempt;
				break;
			}
			if (protocol === "openai" && isUpgradeRequiredError(attempt.status, attempt.errText)) {
				protocol = "cli";
				this.rememberProtocol(apiKey, true);
				body = await buildBody("cli");
				continue;
			}
			const rotate = this.deps.rotateApiKey;
			if ((attempt.status === 429 || attempt.status === 401) && rotate !== void 0 && options.signal?.aborted !== true && tried.size < MAX_ACCOUNT_ROTATIONS) {
				const next = await rotate(apiKey, attempt.status === 429 ? "rate-limit" : "invalid-credential", connection, options.model);
				if (next !== void 0 && !tried.has(next)) {
					apiKey = next;
					continue;
				}
			}
			throw generateHttpError(attempt.status, attempt.errText, attempt.retryAfterMs);
		}
		if (connected === void 0) throw new LlmError("Command Code API connection failed without a response", "TRANSPORT");
		const { response, cleanup } = connected;
		if (!response.body) {
			cleanup();
			throw new LlmError("Command Code API returned no response body", "PROVIDER_PROTOCOL_ERROR");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let idleTimer;
		let idleFired = false;
		const armIdle = () => {
			if (idleTimer !== void 0) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleFired = true;
				reader.cancel().catch(() => void 0);
			}, connection.streamIdleTimeoutMs);
		};
		const clearIdle = () => {
			if (idleTimer !== void 0) {
				clearTimeout(idleTimer);
				idleTimer = void 0;
			}
		};
		const asm = createBlockAssembler();
		const handle = (event) => handleEvent(asm, protocol, event);
		try {
			let finished = false;
			for (;;) {
				let read;
				armIdle();
				try {
					read = await reader.read();
				} catch (error) {
					if (options.signal?.aborted) throw error;
					throw new LlmError(`Command Code API stream from ${connection.apiBase} failed while reading: ${errorChain(error)}；Command Code API 流式响应中途断开——网络波动所致，重试通常可恢复`, "TRANSPORT", { cause: error });
				} finally {
					clearIdle();
				}
				const { done, value } = read;
				if (done) {
					if (idleFired) throw new LlmError(`Command Code API stream from ${connection.apiBase} was idle for ${connection.streamIdleTimeoutMs}ms (no events) and was treated as a dead connection；Command Code API 流式响应已 ${connection.streamIdleTimeoutMs} 毫秒无任何事件，被判定为死连接——长思考模型可在设置中调大流空闲超时`, "TIMEOUT");
					if (buffer.trim()) for (const chunk of handle(parseStreamEventLine(buffer))) {
						yield chunk;
						if (chunk.type === "finish") finished = true;
					}
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const chunks = handle(parseStreamEventLine(line));
					for (const chunk of chunks) {
						yield chunk;
						if (chunk.type === "finish") finished = true;
					}
				}
				if (finished) break;
			}
			if (!finished) {
				yield* closeText(asm);
				yield* closeReasoning(asm);
				if (protocol === "openai") yield* emitOpenAiToolCalls(asm);
				if (!asm.sawContent) throw new LlmError("Command Code returned an empty response；Command Code 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
				yield {
					type: "finish",
					reason: { kind: "stop" }
				};
			}
		} finally {
			clearIdle();
			cleanup();
			await reader.cancel().catch(() => void 0);
			reader.releaseLock();
		}
	}
};
/**
* Map a pre-stream generate HTTP failure onto a stable LlmError. Command
* Code folds several business rejections into 403 (plan limits, CLI version,
* model access): prefer the machine-readable `error.code` when present; the
* status alone cannot distinguish them. A 429's `Retry-After` rides along as
* `providerRetryAfterMs` so dsh-llm-retry can wait exactly that long instead
* of guessing at the backoff cadence — capped at RETRY_MAX_DELAY_MS, because
* in normal mode a longer attached wait makes the executor abandon the retry
* outright instead of falling back to local backoff.
*/
function generateHttpError(status, errText, retryAfterMs) {
	let providerCode;
	try {
		const parsed = JSON.parse(errText);
		if (isRecord(parsed) && isRecord(parsed.error)) providerCode = stringValue(parsed.error.code);
	} catch {}
	const detail = providerCode ?? `HTTP ${status}`;
	if (status === 401) return new LlmError(`Command Code API error 401 (${detail}): the API key is missing or invalid — check the key stored for COMMANDCODE_API_KEY (Models page) or the auth file；Command Code API 返回 401：API 密钥缺失或无效——请在设置页检查 COMMANDCODE_API_KEY 存储的密钥，或检查 auth 文件`, "INVALID_CREDENTIAL", { status: 401 });
	return new LlmError(`Command Code API error ${status}${detail === `HTTP ${status}` ? "" : ` (${detail})`}: ${errText.slice(0, 500)}`, status === 429 ? "RATE_LIMIT" : "PROVIDER_HTTP_ERROR", {
		status,
		...retryAfterMs !== void 0 && retryAfterMs > 0 && retryAfterMs <= 9e5 ? { providerRetryAfterMs: retryAfterMs } : {}
	});
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
			asm.sawContent = true;
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
		case "finish": {
			chunks.push(...closeText(asm), ...closeReasoning(asm));
			const usage = isRecord(event.totalUsage) ? event.totalUsage : void 0;
			if (usage) {
				const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : void 0;
				const totalInput = numberValue(usage.inputTokens) ?? 0;
				const cacheRead = numberValue(details?.cacheReadTokens) ?? 0;
				const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0;
				const tokenUsage = {
					inputTokens: numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
					outputTokens: numberValue(usage.outputTokens) ?? 0,
					cacheReadTokens: cacheRead,
					cacheWriteTokens: cacheWrite
				};
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
		case "error": {
			const err = isRecord(event.error) ? event.error : void 0;
			const detail = isRecord(event.error) ? stringValue(event.error.message) ?? JSON.stringify(event.error) : stringValue(event.error) ?? stringValue(event.message) ?? "Stream error";
			const statusCode = err ? numberValue(err.statusCode) : void 0;
			const isRetryable = err ? booleanValue(err.isRetryable) : void 0;
			const retryableStatus = statusCode !== void 0 && (statusCode === 429 || statusCode >= 500);
			const terminal = hasTerminalStreamMarker(detail);
			if (!(isRetryable === true || (statusCode !== void 0 ? retryableStatus : isRetryable !== false && !terminal))) throw new LlmError(`Command Code stream error: ${detail}`, "PROVIDER_STREAM_ERROR", statusCode !== void 0 ? { status: statusCode } : void 0);
			throw new LlmError(`Command Code stream error: ${detail}`, "SERVER", statusCode !== void 0 ? { status: statusCode } : void 0);
		}
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
	const reasoningDelta = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content) ?? "";
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
		asm.sawContent = true;
		chunks.push({
			type: "text-delta",
			index: asm.textIndex,
			text: contentDelta
		});
	}
	if (Array.isArray(delta.tool_calls)) {
		asm.sawContent = true;
		for (const rawCall of delta.tool_calls) {
			if (!isRecord(rawCall)) continue;
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
	}
	if (choice.finish_reason !== void 0 && choice.finish_reason !== null) {
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
/** Dispatch one parsed stream event to the active transport's handler. */
function handleEvent(asm, protocol, event) {
	return protocol === "openai" ? handleOpenAIEvent(asm, event) : handleCliEvent(asm, event);
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
* Map a stream finish reason onto the harness taxonomy. The two transports
* spell tool-calls differently (`tool-calls` on the CLI transport,
* `tool_calls` on the OpenAI transport) but share every other reason, so
* one function serves both — a new reason cannot drift between them.
*/
function mapFinishReason(reason) {
	if (reason === "tool-calls" || reason === "tool_calls") return { kind: "tool-calls" };
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") return { kind: "max-tokens" };
	return { kind: "stop" };
}
/**
* True when a Provider API pre-stream rejection is Command Code's Go-plan
* gate (`upgrade_required`). Only this exact class of rejection should fall
* back to the CLI /alpha/generate transport; other 4xx/5xx must surface as
* ordinary errors so real account/model problems are not masked.
*/
function isUpgradeRequiredError(status, errText) {
	if (status !== 403) return false;
	const lower = errText.toLowerCase();
	if (lower.includes("upgrade_required")) return true;
	if (lower.includes("go plan") && lower.includes("api access")) return true;
	if (lower.includes("only plan without api access")) return true;
	if (lower.includes("upgrade to goat or higher")) return true;
	try {
		const parsed = JSON.parse(errText);
		if (isRecord(parsed)) {
			const error = isRecord(parsed.error) ? parsed.error : parsed;
			if ((stringValue(error.code) ?? stringValue(error.type))?.toLowerCase() === "upgrade_required") return true;
			const message = stringValue(error.message) ?? "";
			if (message.toLowerCase().includes("go plan") && message.toLowerCase().includes("api access")) return true;
		}
	} catch {}
	return false;
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
		resetSuffix: "重置 {when}",
		partialFailures: "⚠️  部分端点失败: {list}",
		noData: "（无数据 — 请检查 API 密钥）",
		errorText: "获取 Command Code 用量失败：{message}",
		imageGate: "当前会话已包含图片，而模型 {model} 不支持图片输入；请选择支持图片的模型，或先移除会话中的图片。"
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
		resetSuffix: "resets {when}",
		partialFailures: "⚠️  some endpoints failed: {list}",
		noData: "(no data — check your API key)",
		errorText: "Could not fetch Command Code usage: {message}",
		imageGate: "This session already contains images, and model {model} does not accept image input; please select an image-capable model, or remove the images from the session first."
	}
};
/**
* Resolve the active locale for a Host-side command run.
*
* Priority: explicit `override` (from `Config.lang`) → `LC_ALL` → `LANG` →
* the conventional fallback (`'zh'`, matching the existing single-language
* behavior so unconfigured deployments keep their current output).
*
* The values are matched on the leading tag only — `zh_CN.UTF-8`,
* `zh-Hans`, `zh` all map to `'zh'`; everything starting with `en` maps to
* `'en'`; anything else falls back to `'zh'` (a non-`en` shell that
* already has Chinese in the terminal is the closest sensible default;
* a Western shell that happens to be neither keeps the existing Chinese
* output rather than swapping to half-translated English).
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
//#region src/commands.ts
/** Format a dollar amount. */
function money(value) {
	return `$${value.toFixed(4)}`;
}
/** Format a dollar amount compactly (2 decimals). */
function moneyShort(value) {
	return `$${value.toFixed(2)}`;
}
/** Format a large token count compactly (1.9M style). */
function tokensCompact(value) {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return String(value);
}
/**
* Format a success-rate percentage (already in percent units): at most two
* decimals, trailing zeros trimmed — mirrors `formatSuccessRate` in
* `./client/usage.ts`, which the settings card uses.
*/
function successRateText(value) {
	return String(Number(value.toFixed(2)));
}
/** Format a millis timestamp as a local date; `n/a` when unset. */
function resetLabel(ms) {
	if (ms <= 0) return "n/a";
	return new Date(ms).toLocaleString();
}
/**
* A 10-cell horizontal bar: `██████████` for 100%, `███░░░░░░░` for ~33%.
* Handles caps of 0 (no limit) and out-of-range values.
*/
function bar(used, cap) {
	if (cap <= 0) return "—";
	const ratio = Math.max(0, Math.min(1, used / cap));
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
		const monthlyPct = c.monthlyCredits > 0 ? `${(c.monthlyCredits / (c.monthlyCredits + c.purchasedCredits) * 100).toFixed(0)}%` : "—";
		lines.push(commandCopy(locale, "creditsHeader"), commandCopy(locale, "monthlyLine").replace("{monthly}", moneyShort(c.monthlyCredits)).replace("{purchased}", moneyShort(c.purchasedCredits)).replace("{free}", moneyShort(c.freeCredits)), commandCopy(locale, "barLine").replace("{bar}", bar(c.monthlyCredits, c.monthlyCredits + c.purchasedCredits)).replace("{pct}", monthlyPct), "");
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
* Build the validator helpers one endpoint uses. `prefix` names the
* endpoint in the rejection message (e.g. `commandcode/report result:`), so
* each wire file keeps its own diagnostic phrasing while sharing the helper
* bodies.
*
* The helpers return the reject call directly in the failure branch: since
* `reject` is typed `never`, the ternary's union collapses to the success type
* without relying on TypeScript's control-flow analysis of a never-returning
* call (which only recognizes function declarations, not the destructured
* arrow `reject` callers receive from this factory).
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
/**
* Build one strict invocation descriptor. Every Command Code Remote shares the
* `commandcode` namespace, the `commandcodeUsage` service, and a strict
* `mode: 'strict'` result — only the endpoint, method, result type symbol, and
* schema differ — so the boilerplate lives here once and each endpoint supplies
* only its own facts.
*/
function makeRemoteDescriptor(endpoint, method, typeSymbol, schema) {
	return {
		id: `${REMOTE_PACKAGE}#${endpoint}`,
		service: REMOTE_SERVICE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: [],
		result: {
			mode: "strict",
			typeSymbol,
			schema
		}
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
/** Validate one window-limit block (`fiveHour` / `weekly`). */
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
		if (blocked === "invalid-key" || blocked === "service-unavailable" || blocked === "network") report.blocked = blocked;
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
const { record: catalogRecord, stringField: catalogString } = makeBoundaryValidator("commandcode/models result:");
/** Parse one untrusted boundary value into a {@link CommandCodeCatalogModel}. */
function parseCatalogModel(value) {
	const source = catalogRecord(value, "model");
	const model = {
		id: catalogString(source, "id", "model.id"),
		name: catalogString(source, "name", "model.name")
	};
	if (source.tier !== void 0) model.tier = catalogString(source, "tier", "model.tier");
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
//#region src/model-prices.ts
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
		]
	},
	{
		id: "claude-fable-5-1",
		rates: [
			10,
			50,
			.25,
			12.5
		]
	},
	{
		id: "claude-haiku-4-5",
		rates: [
			1,
			5,
			.1,
			1.25
		]
	},
	{
		id: "claude-opus-4-6",
		rates: [
			5,
			25,
			.5,
			6.25
		]
	},
	{
		id: "claude-opus-4-7",
		rates: [
			5,
			25,
			.5,
			6.25
		]
	},
	{
		id: "claude-opus-4-8",
		rates: [
			5,
			25,
			.5,
			6.25
		]
	},
	{
		id: "claude-opus-5",
		rates: [
			5,
			25,
			.5,
			6.25
		]
	},
	{
		id: "claude-sonnet-4-6",
		rates: [
			3,
			15,
			.3,
			3.75
		]
	},
	{
		id: "claude-sonnet-5",
		rates: [
			2,
			10,
			.2,
			2.5
		]
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
		]
	},
	{
		id: "deepseek-v4-flash-fast",
		rates: [
			.28,
			.56,
			.07
		]
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
		]
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
		]
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
		]
	},
	{
		id: "fugu-ultra",
		rates: [
			5,
			30,
			.5
		]
	},
	{
		id: "gemini-3.1-flash-lite",
		rates: [
			.25,
			1.5,
			.03
		]
	},
	{
		id: "gemini-3.5-flash",
		rates: [
			1.5,
			9,
			.15
		]
	},
	{
		id: "gemini-3.5-flash-lite",
		rates: [
			.3,
			2.5,
			.03
		]
	},
	{
		id: "gemini-3.6-flash",
		rates: [
			1.5,
			7.5,
			.15
		]
	},
	{
		id: "gemini-3.7-flash",
		rates: [
			1.5,
			7.5,
			.15,
			.08334
		]
	},
	{
		id: "gemini-3.8-flash",
		rates: [
			1.5,
			7.5,
			.15
		]
	},
	{
		id: "glm-5",
		rates: [
			1,
			3.2,
			.2
		]
	},
	{
		id: "glm-5.1",
		rates: [
			1.4,
			4.4,
			.26
		]
	},
	{
		id: "glm-5.2",
		rates: [
			1.4,
			4.4,
			.26
		]
	},
	{
		id: "glm-5.2-fast",
		rates: [
			3,
			10.25,
			.5
		]
	},
	{
		id: "glm-5.3",
		rates: [
			1.4,
			4.4,
			.26
		]
	},
	{
		id: "glm-5.3-flash",
		rates: [
			.15,
			.5,
			.03
		]
	},
	{
		id: "gpt-5.3-codex",
		rates: [
			2,
			8,
			.5,
			0
		]
	},
	{
		id: "gpt-5.4",
		rates: [
			2.5,
			15,
			.25,
			0
		]
	},
	{
		id: "gpt-5.4-mini",
		rates: [
			.75,
			4.5,
			.075,
			0
		]
	},
	{
		id: "gpt-5.5",
		rates: [
			5,
			30,
			.5,
			0
		]
	},
	{
		id: "gpt-5.6-luna",
		rates: [
			.2,
			1.2,
			.02,
			.25
		]
	},
	{
		id: "gpt-5.6-sol",
		rates: [
			5,
			30,
			.5,
			6.25
		]
	},
	{
		id: "gpt-5.6-terra",
		rates: [
			2,
			12,
			.2,
			2.5
		]
	},
	{
		id: "gpt-6-astra",
		rates: [
			10,
			50,
			1,
			12.5
		]
	},
	{
		id: "grok-4.5",
		rates: [
			2,
			6,
			.5
		]
	},
	{
		id: "grok-4.6",
		rates: [
			2,
			6,
			.5
		]
	},
	{
		id: "inkling",
		rates: [
			1,
			4.05,
			.17
		]
	},
	{
		id: "inkling-small",
		rates: [
			.5,
			1.2,
			.1
		]
	},
	{
		id: "kimi-k2.5",
		rates: [
			.6,
			3,
			.1
		]
	},
	{
		id: "kimi-k2.6",
		rates: [
			.95,
			4,
			.16
		]
	},
	{
		id: "kimi-k2.7-code",
		rates: [
			.95,
			4,
			.19
		]
	},
	{
		id: "kimi-k2.7-code-highspeed",
		rates: [
			1.9,
			8,
			.38
		]
	},
	{
		id: "kimi-k3",
		rates: [
			3,
			15,
			.3
		]
	},
	{
		id: "mimo-v2.5",
		rates: [
			.14,
			.28,
			.0028
		]
	},
	{
		id: "mimo-v2.5-pro",
		rates: [
			.435,
			.87,
			.0036
		]
	},
	{
		id: "minimax-m2.5",
		rates: [
			.3,
			1.2,
			.03
		]
	},
	{
		id: "minimax-m2.7",
		rates: [
			.3,
			1.2,
			.06
		]
	},
	{
		id: "minimax-m3",
		rates: [
			.3,
			1.2,
			.06
		]
	},
	{
		id: "muse-spark-1.1",
		rates: [
			1.25,
			4.25,
			.15
		]
	},
	{
		id: "muse-spark-1.2",
		rates: [
			1.25,
			4.25,
			.15
		]
	},
	{
		id: "muse-spark-1.2-contributor",
		rates: [
			.1,
			.2,
			.002
		]
	},
	{
		id: "muse-spark-1.3",
		rates: [
			1.25,
			4.25,
			.15
		]
	},
	{
		id: "muse-spark-1.3-contributor",
		rates: [
			.1,
			.2,
			.002
		]
	},
	{
		id: "nemotron-3-ultra",
		rates: [
			.6,
			2.4,
			.12
		]
	},
	{
		id: "qwen-3.6-max",
		rates: [
			1.3,
			7.8,
			.26,
			1.63
		]
	},
	{
		id: "qwen-3.6-plus",
		rates: [
			.5,
			3,
			.1
		]
	},
	{
		id: "qwen-3.7-flash",
		rates: [
			.03,
			.13,
			.006,
			.038
		]
	},
	{
		id: "qwen-3.7-max",
		rates: [
			2.5,
			7.5,
			.5,
			3.13
		]
	},
	{
		id: "qwen-3.7-plus",
		rates: [
			.4,
			1.6,
			.08,
			.5
		]
	},
	{
		id: "qwen-3.8-27b",
		rates: [
			.4,
			3,
			.04
		]
	},
	{
		id: "qwen-3.8-flash",
		rates: [
			.16,
			.47,
			.016
		]
	},
	{
		id: "qwen-3.8-max",
		rates: [
			2,
			6,
			.25,
			2.5
		]
	},
	{
		id: "qwen-3.8-max-0902",
		rates: [
			2,
			6,
			.25
		]
	},
	{
		id: "step-3.5-flash",
		rates: [
			.1,
			.3,
			.02
		]
	},
	{
		id: "step-3.7-flash",
		rates: [
			.2,
			1.15,
			.04
		]
	},
	{
		id: "tencent/hy3-paid",
		rates: [
			.14,
			.58,
			.035
		]
	},
	{
		id: "tencent/hy4-preview",
		rates: [
			.834,
			2.501,
			.042
		]
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
* exists in the vendored table absorbs that drift without a hand-maintained
* map of seventy ids.
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
/** Build the full price row the browser prices a session with. */
function wireRow(id, slug, row) {
	const price = {
		id,
		slug,
		...ratesOf(row.rates)
	};
	if (row.peak !== void 0) price.peak = ratesOf(row.peak);
	return price;
}
/**
* Build the table the composer prices a session with.
*
* Rows are keyed by CATALOG id wherever the two namespaces reconcile, because
* that is what a session reports, and every row also carries its page slug as a
* second lookup key. Price rows no catalog model claims are served under the
* slug alone, so drift in either direction still prices: a page rename the
* catalog has not followed, or a model the catalog snapshot has not learned
* yet. Free models are served explicitly at zero so the composer can say so
* instead of showing nothing.
*
* The peak windows travel with the table, so the browser applies the very
* schedule this snapshot knows instead of restating it.
*/
function modelPriceTable() {
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
		models.push(wireRow(catalogId, slug, row));
	}
	for (const row of MODEL_PRICE_ROWS) {
		if (claimed.has(row.id)) continue;
		models.push(wireRow(row.id, row.id, row));
	}
	return {
		models,
		peakHours: PEAK_HOUR_RANGES.map(([start, end]) => [start, end])
	};
}
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
/** Build one login invocation descriptor (uniform result, no parameters). */
function loginDescriptor(endpoint, method) {
	return makeRemoteDescriptor(endpoint, method, `${REMOTE_PACKAGE}#CommandCodeLoginStatus`, loginStatusSchema);
}
/** The three login descriptors, shared verbatim by Host registration and Client mount. */
const LOGIN_DESCRIPTORS = [
	loginDescriptor(LOGIN_BEGIN_ENDPOINT, "loginBegin"),
	loginDescriptor(LOGIN_STATUS_ENDPOINT, "loginStatus"),
	loginDescriptor(LOGIN_CANCEL_ENDPOINT, "loginCancel")
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
	* Account, usage, and credit state for the settings page's account card —
	* one entry per pool account when the plugin entry wired `reports`, a
	* single default-account entry otherwise. Degrades per endpoint like the
	* `/commandcode` command (failures land in `report.failures`); throws
	* `MISSING_CREDENTIAL` when no key resolves, which the Gateway folds into
	* the failure branch the page renders as a hint.
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
	* The full model catalog for the settings page's model editors (the
	* routing-rule editor and the visible-models filter). The browser never
	* calls the Command Code API directly — the Host serves the catalog
	* (already fetched/cached by the adapter) so models can be picked from
	* the live list instead of typed by hand.
	*/
	async models() {
		return this.deps.listModels?.() ?? { models: [] };
	}
	/**
	* The model price table the composer prices an in-progress session with.
	* Static vendored data (the official pricing page's rates), served Host-side
	* so the browser bundle never carries a copy that could drift from the
	* snapshot, and so a price update reaches an open page without a rebuild.
	*/
	async prices() {
		return (this.deps.prices ?? modelPriceTable)();
	}
	/**
	* Start (or rejoin) a browser-login attempt and return its fresh status —
	* `waiting` carrying the Studio URL. Rejects when the flow cannot start
	* (no free loopback port, disposed plugin); the Gateway folds the throw
	* into the failure branch the page renders.
	*/
	async loginBegin() {
		return this.requireLogin().begin();
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
				...LOGIN_DESCRIPTORS
			]
		});
		remoteCtx.effect(() => () => void unregister(), "dsh-commandcode-provider: usage remote");
	});
}
//#endregion
//#region src/login.ts
/**
* Host half of the Command Code browser login (the loopback flow).
*
* Mirrors what the official `command-code login` CLI command performs
* (reverse-engineered from `command-code@1.32.1`, `createAuthFlowController`
* + `createAuthServer` in its bundle):
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
* Server behaviour is mirrored exactly: POST-only `/callback`, a 10 KB body
* cap, JSON responses (`{success:true}` / `{success:false,error}`), CORS for
* the Studio origins only, and state-token equality as the anti-forgery
* check. One deliberate hardening over the CLI build: the CORS origin is
* echoed only when it is allowlisted (the CLI falls back to the first
* origin), which browsers treat identically.
*
* Storage stays out of this module: the plugin entry supplies
* {@link CommandCodeLoginFlowDeps.storeKey}, which writes through the dsh
* credentials seam so the next request resolves the new key with no restart.
* Everything external (fetch, ports, randomness, timing) is injectable for
* node tests; the tests drive a real loopback server end to end.
*
* @module dsh-commandcode-provider/login
*/
/** Give up on the browser after this long without a callback (mirrors the CLI). */
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
async function validateCommandApiKey(fetchImpl, apiBase, apiKey) {
	try {
		const response = await fetchImpl(`${apiBase}/alpha/whoami`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`
			}
		});
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
* a terminal state makes the next `begin()` start fresh.
*/
var CommandCodeLoginFlow = class {
	deps;
	listeners = /* @__PURE__ */ new Set();
	statusValue = { state: "idle" };
	server;
	timer;
	/** Settle hooks of the live attempt's callback promise. */
	settle;
	/**
	* Attempt generation. A delivered callback keeps validating the key
	* asynchronously (`complete()`), and that window is open to a cancel or a
	* fresh `begin()`; the generation lets a late completion recognize that it
	* no longer owns the status face and stop instead of storing a credential
	* the user cancelled and flipping the page back to success.
	*/
	attemptSeq = 0;
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
	async begin() {
		if (this.disposed) throw new Error("login flow has been disposed");
		if (this.statusValue.state === "waiting" && this.server !== void 0) return this.statusValue;
		this.teardown();
		const attempt = ++this.attemptSeq;
		const port = await this.findPort();
		const expectedState = this.deps.randomToken?.(32) ?? randomBytes(32).toString("base64url");
		const settled = new Promise((resolve, reject) => {
			this.settle = {
				resolve,
				reject
			};
		});
		await this.bindServer(port, expectedState);
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
			this.teardown();
			this.setStatus({
				state: "failed",
				reason: "timeout",
				message: "No browser callback arrived within the login window."
			});
		}, this.deps.timeoutMs ?? 12e4);
		this.timer.unref?.();
		settled.then((credentials) => this.complete(attempt, credentials), (failure) => this.failFrom(attempt, failure));
		return this.statusValue;
	}
	/** Cancel a waiting attempt; terminal states are untouched. */
	cancel() {
		if (this.disposed || this.statusValue.state !== "waiting") return;
		this.teardown();
		this.setStatus({
			state: "failed",
			reason: "cancelled"
		});
	}
	/** Stop everything; a waiting attempt ends cancelled. Idempotent. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
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
				if (this.server !== server) return;
				this.server = void 0;
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
		this.teardown();
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
	* attempt must not write the key or publish a status — otherwise cancel
	* would report "cancelled" while the credential landed anyway, and the page
	* would silently flip to success.
	*/
	async complete(attempt, credentials) {
		if (!this.ownsAttempt(attempt)) return;
		const validation = await validateCommandApiKey(this.deps.fetchImpl ?? fetch, this.readApiBase(), credentials.apiKey);
		if (!this.ownsAttempt(attempt)) return;
		if (!validation.valid) {
			const reason = validation.error === "invalid_key" ? "invalid-key" : validation.error === "network_error" ? "network" : "error";
			this.setStatus({
				state: "failed",
				reason,
				message: `/alpha/whoami rejected the delivered key (${validation.error}).`
			});
			return;
		}
		if (!this.ownsAttempt(attempt)) return;
		try {
			await this.deps.storeKey(credentials);
		} catch (error) {
			if (!this.ownsAttempt(attempt)) return;
			this.setStatus({
				state: "failed",
				reason: "unavailable",
				message: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		if (!this.ownsAttempt(attempt)) return;
		this.clearTimer();
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
	/** Close the server and watchdog without touching the published status. */
	teardown() {
		this.clearTimer();
		this.server?.close();
		this.server = void 0;
		this.settle = void 0;
	}
};
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
//#region src/web-search.ts
/**
* dsh-commandcode-provider — Command Code web search provider over `ctx.web`.
*
* The official Command Code CLI ships a built-in `web_search` tool that POSTs
* `{ query, numResults, allowedDomains?, blockedDomains? }` to
* `{apiBase}/alpha/web-search` and reads `{ results: [{ title, url, snippet }] }`
* back. It authenticates with the SAME `Authorization: Bearer <key>` header and
* `x-command-code-version` the model adapter uses, so this provider reuses the
* plugin's existing credential chain (`COMMANDCODE_API_KEY` → credentials seam →
* `~/.commandcode/auth.json`) — no separate DeepSeek key, no extra endpoint.
*
* This mirrors the host-side `@deepseek-ai/dsh-web-search-deepseek` provider in
* shape: a cordis-free class registered into the web seam, resolving its key per
* search, mapping each server-side result to the harness's normalized
* `WebSearchSource`. The web seam owns `maxResults` truncation.
*
* @module dsh-commandcode-provider/web-search
*/
/** Stable id this provider registers under in `ctx.web`. */
const COMMANDCODE_SEARCH_PROVIDER_ID = "commandcode";
/**
* The factory-declared search provider id dsh ships by default (from
* `dsh-base`'s cordis patch `web.config.searchProvider`). Kept as a
* documented reference only: disabling this plugin's `webSearch` toggle
* restores the previously selected backend (see
* {@link applyCommandCodeSearchSelection}) — it never forces this default,
* because forcing it is what used to silence sibling search plugins such as
* modsearch even with Command Code search turned off (issue #26).
*/
const DEFAULT_WEB_SEARCH_PROVIDER_ID = "deepseek-official";
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
function selectCommandCodeSearchProvider(web, enable) {
	try {
		const field = web;
		const prior = field.searchProviderId;
		field.searchProviderId = enable ? COMMANDCODE_SEARCH_PROVIDER_ID : DEFAULT_WEB_SEARCH_PROVIDER_ID;
		return prior;
	} catch {
		return;
	}
}
/** Fresh selection state: the plugin starts out not owning the selection. */
function commandCodeSearchSelection() {
	return {
		owner: false,
		displaced: void 0
	};
}
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
function applyCommandCodeSearchSelection(web, state, enable) {
	try {
		const field = web;
		if (enable) {
			if (state.owner) {
				field.searchProviderId = COMMANDCODE_SEARCH_PROVIDER_ID;
				return;
			}
			const prior = field.searchProviderId;
			state.displaced = prior === "commandcode" ? void 0 : prior;
			field.searchProviderId = COMMANDCODE_SEARCH_PROVIDER_ID;
			state.owner = true;
			return;
		}
		if (state.owner) {
			state.owner = false;
			field.searchProviderId = state.displaced;
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
* A `ctx.web` search provider backed by the Command Code Provider API. Reuses
* the plugin's credential chain and `apiBase`, so search "just works" with the
* existing key — the model-facing `web_search` tool needs no separate
* configuration. Selection between multiple search providers is the web seam's
* job (pin `searchProvider: commandcode` if ambiguous).
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
		const key = await this.resolveKey(signal);
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
	async resolveKey(signal) {
		let key;
		try {
			key = await this.deps.resolveKey();
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
/** Tier display names, mirroring the web dropdown's headings (`model-select.ts`). */
const TIER_TITLES = {
	go: "Go",
	goat: "GOAT",
	pro: "Pro",
	provider: "Provider",
	max: "Max"
};
/** Tiers in picker order; a model outside this set joins the "Other" group. */
const TIER_ORDER = [
	"go",
	"goat",
	"pro",
	"provider",
	"max"
];
/** The group holding models this build's catalog does not know. */
const OTHER_GROUP_ID = "models-other";
/**
* Every model this build knows, in checkbox order: plan tier (Go first), then
* free before paid inside a tier, then by id.
*
* The list is the static capability snapshot rather than a live catalog read
* on purpose — a settings page must draw synchronously, and the snapshot is
* synced from the same upstream table the picker's tier headings come from.
* A model added upstream after this build still reaches the user: an empty
* allowlist shows everything, and a model named in the allowlist but absent
* here is rendered by the "Other" group instead of disappearing.
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
* Field choices worth keeping: the two option-bearing fields (`activeAccount`,
* `lang`) are `text` + `options` rather than `select`, because a `select`
* cannot express "unset" — cycling only ever lands on a declared option, so a
* `select` would strand the user on a pinned value with no way back to
* automatic. The `auto` sentinel plus a `parse` that clears the path keeps the
* unset state reachable. `filterModelsByPlan` formats its EFFECTIVE default
* (unset means true at the adapter), so a fresh install reads true instead of
* the screen's "(empty)".
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
		title: `${TIER_TITLES[tier] ?? tier} models`,
		descriptions: { zh: `${TIER_TITLES[tier] ?? tier} 模型` }
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
	* of the one that was toggled. A per-model key is what makes a checkbox
	* express one model's state.
	*
	* An override equal to what the array already says is written as a CLEAR, so
	* toggling a model back to its inherited state leaves no residue and the
	* document stays minimal.
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
			const on = text.trim() === "true";
			const listed = storedIds(deps.visibleModels());
			return on === (listed.length === 0 || listed.includes(id)) ? { kind: "clear" } : {
				kind: "set",
				value: on
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
				hint: `Stored in the credential store as ${ref}, never in settings.yaml.`,
				hintDescriptions: { zh: `保存在凭据库（${ref}），不会写入 settings.yaml。` }
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
* @param ctx - the context of an activated `tuiSettingsSections` injection.
* @param deps - plugin-owned facts the section reads.
* @returns a refresh function that re-registers the section when a fact it
*   renders changed (the plugin entry calls it from its settings `onChange`
*   hook), or `undefined` when the seam is unusable. The returned function is
*   inert after the fiber is torn down.
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
//#region src/index.ts
/**
* dsh-commandcode-provider — DeepSeek Harness LLM provider plugin for Command
* Code (unofficial; ported from pi-commandcode-provider@0.5.1).
*
* Registers the `commandcode` provider route on `ctx.llm` and declares it in
* the configurable-provider directory, so the web Models page shows a
* "Command Code" card with an API-key field and the model picker lists the
* live Command Code model catalog. Connection facts resolve per request over
* the optional `llm-commandcode` user-settings section and the credential
* seam, so a changed key, endpoint, or cache path reaches the next request
* without a restart.
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
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	apiKey: z.string().role("secret"),
	apiBase: z.string(),
	workingDir: z.string(),
	modelsCachePath: z.string(),
	requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
	streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
	filterModelsByPlan: z.boolean(),
	visibleModels: z.array(z.string()),
	/**
	* Per-model visibility overrides for the terminal settings page's checkbox
	* list, keyed by catalog id. dsh-TUI addresses a staged edit by its field
	* PATH, so two checkboxes sharing one path would overwrite each other's
	* draft and the section's last model would decide every write; a map gives
	* each checkbox a path of its own. An id listed here wins over
	* {@link visibleModels}; ids absent here keep following it.
	*/
	modelVisibility: z.dict(z.boolean()),
	webSearch: z.boolean().default(true),
	accounts: z.array(z.object({
		label: z.string(),
		apiKeyEnv: z.string().role("credential-ref"),
		/** Literal key for one extra slot; see the top-level `apiKey` secret note. */
		apiKey: z.string().role("secret")
	})),
	activeAccount: z.string(),
	modelAccountRules: z.array(z.object({
		models: z.array(z.string()),
		account: z.string()
	})),
	lang: z.string().pattern(/^(zh|en)$/).default("zh")
});
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every default is re-judged here — for the composition entry at load and for
* each settings snapshot at its first use.
*/
function resolveAdapterOptions(config) {
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		apiBase: config.apiBase ?? "https://api.commandcode.ai",
		workingDir: config.workingDir ?? process.cwd(),
		modelsCachePath: config.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH,
		requestTimeoutMs: config.requestTimeoutMs ?? 6e4,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 3e5,
		filterModelsByPlan: config.filterModelsByPlan ?? true,
		visibleModels: Array.isArray(config.visibleModels) ? config.visibleModels.filter((id) => typeof id === "string" && id !== "") : void 0,
		modelVisibility: readModelVisibility(config.modelVisibility)
	};
}
/**
* Per-model visibility overrides, cleaned for the adapter. Programmatic
* construction may bypass Schemastery normalization, so a non-object or a
* non-boolean entry is dropped here instead of reaching the picker filter.
* @param raw - The `modelVisibility` value from any config source.
* @returns A frozen id → boolean map, or undefined when nothing is set.
*/
function readModelVisibility(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && typeof entry[1] === "boolean");
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		const next = resolveAdapterOptions(raw);
		lastRaw = raw;
		lastGood = next;
		return next;
	};
	options();
	const slots = () => {
		const raw = current();
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
	const preferredId = () => {
		const raw = current().activeAccount;
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
		probeWindow: (apiKey) => adapter.probeFiveHourWindow(apiKey),
		preferredId,
		modelAccountRules: () => current().modelAccountRules ?? []
	});
	const resolveApiKey = async (connection, model) => {
		const resolved = await pool.resolveKey(model === void 0 ? {} : { model });
		if (resolved !== void 0) return assertUsableApiKey(resolved.key, "llm-commandcode", resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`);
		const ref = connection.apiKeyEnv;
		throw new LlmError(`llm-commandcode: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), export it in the launching environment, set config.apiKey, or run \`command-code login\` to write ~/.commandcode/auth.json`, "MISSING_CREDENTIAL");
	};
	const adapter = new CommandCodeAdapter({
		options,
		resolveApiKey,
		rotateApiKey: async (rejectedKey, rejection, _connection, model) => {
			pool.markRejected(rejectedKey, rejection);
			const resolved = await pool.resolveKey(model === void 0 ? { exclude: rejectedKey } : {
				exclude: rejectedKey,
				model
			});
			return resolved === void 0 ? void 0 : assertUsableApiKey(resolved.key, "llm-commandcode", resolved.slot.ref ?? `${resolved.slot.label} (config.apiKey)`);
		},
		resolveAttachments: () => {
			const attachments = ctx.get("attachments");
			return attachments === void 0 ? void 0 : attachments;
		}
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Command Code",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	const usageReports = async () => {
		const described = await pool.describeAccounts();
		const byId = new Map(described.map((account) => [account.slot.id, account]));
		const active = selectActiveAccount(await pool.resolvedAccounts(), preferredId());
		return { accounts: await Promise.all(slots().map(async (slot) => {
			const account = byId.get(slot.id);
			let report;
			if (account === void 0) report = { failures: [] };
			else try {
				report = await adapter.getUsage(account.key);
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
		storeKey: async ({ apiKey }) => {
			const ref = credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV);
			const credentials = ctx.get("credentials");
			if (credentials === void 0) throw new Error("the credentials service is unavailable in this profile; paste the key manually");
			await credentials.set(ref, apiKey);
		}
	});
	ctx.effect(() => () => loginFlow.dispose(), "dsh-commandcode-provider: login flow");
	const catalogForEditors = async () => {
		return { models: (await adapter.listModels(PROVIDER, { unfiltered: true })).map((model) => {
			const tier = KNOWN_PLANS[model.id];
			return {
				id: model.id,
				name: model.name.replace(/\s*\(CC\)$/, ""),
				...tier === void 0 ? {} : { tier }
			};
		}) };
	};
	applyUsageRemote(ctx, {
		adapter,
		reports: usageReports,
		login: loginFlow,
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
			resolveKey: async () => {
				const resolved = await pool.resolveKey();
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
		settingsCtx.settings.installSection(ctx, NS, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				applySearchSelection(current().webSearch ?? true);
				refreshTuiSettings?.();
			}
		});
	});
}
//#endregion
export { ACTIVE_ACCOUNT_AUTO, BILLING_ACCESS_TTL_MS, COMMANDCODE_SEARCH_PROVIDER_ID, COMMAND_CODE_CLI_VERSION, CommandCodeAccountPool, CommandCodeAdapter, CommandCodeLoginFlow, CommandCodeSearchProvider, CommandCodeUsageService, Config, DEFAULT_API_BASE, DEFAULT_GENERATE_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODELS_CACHE_PATH, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PROVIDER_ID, KNOWN_DEALS, KNOWN_EFFORTS, KNOWN_IMAGE_MODELS, KNOWN_PEAK_PRICING, KNOWN_PLANS, KNOWN_SUBSCRIPTION_PLANS, KNOWN_THINKING_MODELS, LANG_AUTO, LOGIN_ALLOWED_ORIGINS, LOGIN_BEGIN_ENDPOINT, LOGIN_BODY_LIMIT_BYTES, LOGIN_CANCEL_ENDPOINT, LOGIN_MAX_PORT_ATTEMPTS, LOGIN_START_PORT, LOGIN_STATUS_ENDPOINT, LOGIN_TIMEOUT_MS, PLAN_LABELS, PLAN_ORDER, PROVIDER, USAGE_REPORT_ENDPOINT, accountUsable, apply, applyCommandCodeSearchSelection, applyCommandCodeTuiSettings, applyCommands, applyUsageRemote, buildCommandAuthUrl, buildCommandCodeTuiSection, capabilityDescription, commandCodeSearchSelection, commandDefinition, compareByPlan, dealLabel, formatContext, inject, loginStatusSchema, matchModelRule, modelVisibleInPlan, name, parseLoginStatus, peakPricingLabel, peakPricingState, planLabel, projectSlugFromPath, resolveAdapterOptions, resolveAuthFileApiKey, selectAccountForModel, selectActiveAccount, selectCommandCodeSearchProvider, studioBaseForApiBase, subscriptionPlanInfo, usageReportSchema, validateCommandApiKey };

//# sourceMappingURL=index.js.map