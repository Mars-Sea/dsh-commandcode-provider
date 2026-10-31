window.__ModuleLoader__.load({
	id: "@mars-sea/dsh-commandcode-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/snapshot-store.ts
		/** Notify every subscriber without letting one faulty UI consumer suppress the rest. */
		function notifyListeners(listeners) {
			for (const listener of listeners) try {
				listener();
			} catch (error) {
				console.error("[dsh-commandcode-provider] snapshot subscriber failed:", error);
			}
		}
		/** Create one observable snapshot store. */
		function createSnapshotStore(initial) {
			let snapshot = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(value) {
					if (Object.is(value, snapshot)) return;
					snapshot = value;
					notifyListeners(listeners);
				}
			};
		}
		//#endregion
		//#region src/readable-error.ts
		/**
		* Readable error text for the settings page AND the Host-side failure paths.
		*
		* @module dsh-commandcode-provider/readable-error
		*/
		/**
		* Turn a caught value into readable text.
		*
		* `error instanceof Error ? error.message : String(error)` degrades to the
		* literal string `[object Object]` for a plain object with no `Error`
		* prototype — which is exactly what a Remote call across the webview/host
		* boundary can hand back: `dsh-typert-protocol` serializes a rejection for
		* the wire, and a structurally-cloned value loses its prototype chain even
		* when the host threw a real `Error` (issue #74). Reading a `message` string
		* off the plain object first recovers the original text in that case; only a
		* value with neither an `Error` prototype nor a usable `message` field falls
		* through to a JSON dump.
		*
		* Shared by both halves on purpose. The browser client needs it for rejections
		* that crossed the RPC boundary, and the Host needs it for values that reached
		* it from a transport, a JSON body, or a user-thrown non-Error — the same
		* degradation, one owner.
		*/
		function readableErrorText(error) {
			if (error instanceof Error) return error.message;
			if (typeof error === "string") return error;
			if (error !== null && typeof error === "object") {
				const message = error.message;
				if (typeof message === "string" && message !== "") return message;
				try {
					return JSON.stringify(error);
				} catch {
					return Object.prototype.toString.call(error);
				}
			}
			return String(error);
		}
		//#endregion
		//#region src/client/settings-scope.ts
		/** 组装报告；没有原文时不带 `message` 键（`exactOptionalPropertyTypes`）。 */
		function mutationReport(result, message) {
			return message === void 0 ? { result } : {
				result,
				message
			};
		}
		/**
		* Backoff before re-reading a directory whose FIRST read failed, in millis.
		*
		* Only a failure with NOTHING held retries. With no view the scope keeps its
		* initial `{ status: 'loading', writable: false }` snapshot and the settings
		* page renders fully disabled, while the forwarded invalidation signals need a
		* live Host to fire and the namespace only re-mounts on a reload. A failure
		* with a held view retries nothing — the page already shows the last good
		* document (`tests/settings-scope.test.ts` pins both).
		*/
		const SETTINGS_DESCRIBE_RETRY_MS = [
			1e3,
			2e3,
			4e3
		];
		/** The production timer: a browser/node timeout, no polling. */
		const REAL_SETTINGS_TIMER = {
			set(callback, ms) {
				const handle = setTimeout(callback, ms);
				handle.unref?.();
				return handle;
			},
			clear(handle) {
				clearTimeout(handle);
			}
		};
		/** Shallow equality over the snapshot fields, so an unchanged derive never churns subscribers. */
		function sameSnapshot(a, b) {
			return a.status === b.status && Object.is(a.value, b.value) && Object.is(a.base, b.base) && Object.is(a.user, b.user) && Object.is(a.revision, b.revision) && a.writable === b.writable && a.mode === b.mode;
		}
		/** Accept a decoded row value only when it is the object a settings section is. */
		function decodeRow(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
			return value;
		}
		/**
		* One shared mirror of the Host `settings.describe()` view.
		*
		* The run loop is the harness's own: serialize behind `inFlight`, fold a
		* concurrent invalidation into exactly one rerun, and hold the previous view
		* across a failed read (status stays `ready` with an `error`, or returns to
		* `idle` when nothing was ever held).
		*/
		var SettingsDescribeMirror = class {
			resolveRemote;
			timer;
			store;
			inFlight;
			rerun = false;
			generation = 0;
			/** Pending retry handle and how many of {@link SETTINGS_DESCRIBE_RETRY_MS} are spent. */
			retryHandle;
			retries = 0;
			disposed = false;
			constructor(resolveRemote, timer = REAL_SETTINGS_TIMER) {
				this.resolveRemote = resolveRemote;
				this.timer = timer;
				this.store = createSnapshotStore({
					status: "idle",
					view: null,
					error: null
				});
			}
			getSnapshot() {
				return this.store.getSnapshot();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			/** The cheap idempotent entry: kick a first read. */
			ensure() {
				this.load();
			}
			/**
			* Refresh from the Host. A call during an in-flight read marks one rerun
			* after it settles instead of racing a second wire read.
			* @returns settlement after this call's freshness is reflected.
			*/
			load() {
				if (this.disposed) return Promise.resolve();
				this.clearRetry();
				if (this.inFlight !== void 0) {
					this.rerun = true;
					return this.inFlight;
				}
				const run = Promise.resolve().then(() => this.run());
				this.inFlight = run;
				return run;
			}
			/**
			* Fold one write answer's namespace ROW into the held view without a wire
			* read, and invalidate any read still in flight: a read begun before the
			* write committed must not publish the pre-write document over it. With no
			* held document the answer is not published as a partial document — the
			* next read (or the failed-write recovery) picks it up.
			* @param row - The namespace view a settings write answered with.
			*/
			acceptView(row) {
				const before = this.store.getSnapshot();
				this.generation += 1;
				if (this.inFlight !== void 0) this.rerun = true;
				if (before.view === null) return;
				const held = before.view;
				const namespaces = held.namespaces?.some((candidate) => candidate.ns === row.ns) ? held.namespaces.map((candidate) => candidate.ns === row.ns ? row : candidate) : [...held.namespaces ?? [], row];
				this.store.set({
					...before,
					view: {
						...held,
						namespaces
					}
				});
			}
			async run() {
				try {
					for (;;) {
						const before = this.store.getSnapshot();
						if (before.status === "idle") this.store.set({
							...before,
							status: "loading"
						});
						this.rerun = false;
						const generation = ++this.generation;
						let outcome;
						try {
							const namespace = this.resolveRemote();
							if (namespace === void 0) throw new Error("the settings remote namespace is not mounted");
							const response = await namespace.describe();
							if (response.ok) {
								const value = response.value;
								outcome = typeof value === "object" && value !== null ? { view: value } : { failure: "settings describe answered no view" };
							} else outcome = { failure: response.error?.message ?? "settings describe failed" };
						} catch (error) {
							outcome = { failure: readableErrorText(error) };
						}
						if (generation !== this.generation) continue;
						if ("view" in outcome) {
							this.retries = 0;
							this.store.set({
								status: "ready",
								view: outcome.view,
								error: null
							});
						} else {
							const held = this.store.getSnapshot();
							this.store.set({
								status: held.view === null ? "idle" : "ready",
								view: held.view,
								error: outcome.failure
							});
							if (held.view === null) this.scheduleRetry();
						}
						if (!this.rerun) break;
					}
				} finally {
					this.inFlight = void 0;
				}
			}
			/**
			* Schedule the next retry of a failed FIRST read ({@link SETTINGS_DESCRIBE_RETRY_MS}).
			* Bounded: once the ladder is spent the scope keeps its degraded snapshot,
			* exactly as before, until an invalidation or a namespace re-mount arrives.
			*/
			scheduleRetry() {
				if (this.disposed || this.retries >= SETTINGS_DESCRIBE_RETRY_MS.length) return;
				const delay = SETTINGS_DESCRIBE_RETRY_MS[this.retries];
				this.retries += 1;
				this.retryHandle = this.timer.set(() => {
					this.retryHandle = void 0;
					this.load();
				}, delay);
			}
			/** Cancel a pending retry (a live read is starting, or the scope is going away). */
			clearRetry() {
				if (this.retryHandle !== void 0) this.timer.clear(this.retryHandle);
				this.retryHandle = void 0;
			}
			/** Stop the mirror: no further reads, and no retry may fire after disposal. */
			dispose() {
				this.disposed = true;
				this.clearRetry();
			}
		};
		/**
		* One namespace's derived scope over the shared mirror, plus its serialized
		* Host writes — the face `CommandCodeSettingsController` consumes
		* (`getSnapshot` / `subscribe` / `set` / `unset`).
		*/
		var RemoteSettingsScope = class {
			resolveRemote;
			store;
			mirror;
			namespace;
			tail = Promise.resolve();
			writeGeneration = 0;
			disposed = false;
			unsubscribe;
			/** Revision answered by a superseded write still ahead of the mirror. */
			pendingRevision;
			constructor(resolveRemote, mirror, namespace) {
				this.resolveRemote = resolveRemote;
				this.mirror = mirror;
				this.namespace = namespace;
				this.store = createSnapshotStore({
					status: "loading",
					value: void 0,
					base: void 0,
					user: void 0,
					revision: void 0,
					writable: false,
					mode: "host"
				});
				this.unsubscribe = mirror.subscribe(() => {
					this.derive();
				});
				this.derive();
			}
			getSnapshot() {
				return this.store.getSnapshot();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			/** Queue one field write (the single-path `set` op form). */
			async set(field, value) {
				await this.mutate([{
					op: "set",
					path: [field],
					value
				}]);
			}
			/** Queue one field clear (the single-path `unset` op form). */
			async unset(field) {
				await this.mutate([{
					op: "unset",
					path: [field]
				}]);
			}
			/**
			* Queue one atomic namespace mutation behind the single-flight fence.
			* A rejected write (e.g. `SETTINGS_CONFLICT`) re-reads the Host so the
			* snapshot reports what actually landed; an accepted one folds its answer
			* in directly — unless a newer write already superseded it, in which case
			* that answer's revision becomes the next write's fence.
			*/
			mutate(ops, expectedRevision) {
				const ownedOps = structuredClone(ops);
				const generation = ++this.writeGeneration;
				return this.enqueue(async () => {
					const revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;
					const response = await this.mutateRemote(ownedOps, revision);
					if (!response.ok) {
						await this.recover(generation);
						const message = response.error?.message;
						return message?.includes("SETTINGS_CONFLICT") ? mutationReport("conflict", message) : mutationReport("failed", message);
					}
					const row = response.value;
					if (row?.ns !== this.namespace || decodeRow(row.value) === void 0 || typeof row.revision !== "number") {
						await this.recover(generation);
						return mutationReport("failed");
					}
					if (this.disposed) return mutationReport("accepted");
					if (generation === this.writeGeneration) {
						this.pendingRevision = void 0;
						this.mirror.acceptView(row);
					} else this.pendingRevision = typeof row.revision === "number" ? row.revision : void 0;
					return mutationReport("accepted");
				});
			}
			async mutateRemote(ops, revision) {
				try {
					const namespace = this.resolveRemote();
					if (namespace === void 0) return {
						ok: false,
						error: { message: "the settings remote namespace is not mounted" }
					};
					return await namespace.mutate(this.namespace, ops, revision);
				} catch (error) {
					return {
						ok: false,
						error: { message: readableErrorText(error) }
					};
				}
			}
			/** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
			async recover(generation) {
				if (this.disposed || generation !== this.writeGeneration) return;
				this.pendingRevision = void 0;
				await this.mirror.load();
			}
			/** Derive this namespace's snapshot from the mirror's held view. */
			derive() {
				if (this.disposed) return;
				const mirrored = this.mirror.getSnapshot();
				if (mirrored.view === null || mirrored.view === void 0) return;
				const writable = mirrored.view.writable === true;
				const row = mirrored.view.namespaces?.find((candidate) => candidate.ns === this.namespace);
				if (row === void 0) {
					this.publish({
						status: "unavailable",
						writable
					});
					return;
				}
				const decoded = decodeRow(row.value);
				if (decoded === void 0) return;
				this.publish({
					status: "ready",
					writable,
					value: decoded,
					base: row.base,
					user: row.user,
					revision: typeof row.revision === "number" ? row.revision : void 0
				});
			}
			/** Publish `next` over the current snapshot, skipping the write when nothing changed. */
			publish(next) {
				const current = this.store.getSnapshot();
				const candidate = {
					status: next.status,
					value: "value" in next ? next.value : current.value,
					base: "base" in next ? next.base : current.base,
					user: "user" in next ? next.user : current.user,
					revision: "revision" in next ? next.revision : current.revision,
					writable: next.writable,
					mode: current.mode
				};
				if (sameSnapshot(candidate, current)) return;
				this.store.set(candidate);
			}
			/** Queue operations one at a time; disposal makes the queue inert. */
			enqueue(operation) {
				if (this.disposed) return Promise.resolve(mutationReport("cancelled"));
				const task = this.tail.then(async () => {
					if (this.disposed) return mutationReport("cancelled");
					return operation();
				});
				this.tail = task.then(() => {}, () => {});
				return task;
			}
			/** Stop queued operations, stop deriving, and wait for the current wire call to settle. */
			async dispose() {
				this.disposed = true;
				this.writeGeneration += 1;
				this.unsubscribe?.();
				await this.tail;
			}
		};
		/**
		* Build the plugin's settings scope for one namespace.
		*
		* Subscribes the two signals that can move the Host view — the forwarded
		* `settings/document-updated` invalidation and (when the client exposes it)
		* `connection/reset` — kicks the first describe read, and derives the namespace
		* row on every mirror change.
		*
		* `resolveRemote` must be the INJECT-CAPTURED namespace (see
		* {@link SettingsRemoteResolver}), and the caller that owns that inject calls
		* {@link ManagedSettingsScope.refresh} once the namespace lands — that is what
		* turns the first, namespace-less read into a served one. A profile that never
		* mounts the namespace leaves the page in its degraded (`unavailable`,
		* read-only) state instead of throwing.
		*
		* @param namespace - Settings namespace (profile entry id) this scope binds.
		*/
		function createSettingsScope(context, namespace, resolveRemote, timer = REAL_SETTINGS_TIMER) {
			const mirror = new SettingsDescribeMirror(resolveRemote, timer);
			const scope = new RemoteSettingsScope(resolveRemote, mirror, namespace);
			const disposers = [];
			if (typeof context.remote.$on === "function") {
				const off = context.remote.$on("settings/document-updated", () => {
					mirror.ensure();
				});
				if (typeof off === "function") disposers.push(off);
			}
			if (typeof context.on === "function") {
				const off = context.on("connection/reset", () => {
					mirror.load();
				});
				if (typeof off === "function") disposers.push(off);
			}
			mirror.ensure();
			return {
				getSnapshot: () => scope.getSnapshot(),
				subscribe: (listener) => scope.subscribe(listener),
				set: (field, value) => scope.set(field, value),
				unset: (field) => scope.unset(field),
				mutate: (ops, revision) => scope.mutate(ops, revision),
				refresh: () => {
					mirror.load();
				},
				dispose: async () => {
					for (const dispose of disposers.splice(0)) dispose();
					mirror.dispose();
					await scope.dispose();
				}
			};
		}
		//#endregion
		//#region src/timeout-limits.ts
		/** 两端共用可编辑超时范围，存储仍是整数毫秒；提示不能借用重试退避上限。 */
		const MIN_TIMEOUT_SECONDS = .001;
		const MAX_TIMEOUT_SECONDS = 3600;
		//#endregion
		//#region src/model-visibility.ts
		/** 网页、终端与模型目录共用的选择规则；显式开关优先于白名单。 */
		function modelIsVisible(id, allowlist, overrides) {
			const flag = overrides !== null && typeof overrides === "object" && !Array.isArray(overrides) ? overrides[id] : void 0;
			return typeof flag === "boolean" ? flag : allowlist.length === 0 || allowlist.includes(id);
		}
		/** 只接收布尔事实，手工配置中的其他值不能成为可见性开关。 */
		function readVisibility(raw) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
			return Object.fromEntries(Object.entries(raw).filter(([id, value]) => id !== "" && typeof value === "boolean"));
		}
		/** 自定义上下文长度接受的上界（token）；覆盖任何已知模型窗口仍留有余量。 */
		const CONTEXT_WINDOW_MAX = 1e7;
		/**
		* 判定一个值能否作为自定义上下文长度：边界内的安全整数，符合宿主模型元数据约束。
		*
		* 程序化构造的连接可能绕过 schemastery 归一化，所以 `resolveAdapterOptions`
		* 也要重新判定——越界或非数值直接丢弃，回落到目录公布值，而不是让请求带着
		* 一个网关会拒绝的窗口上线。
		*/
		function isValidContextWindow(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1e7;
		}
		/**
		* 只接收合法条目的按模型覆盖表；空表、非对象与非法数值一律视为未设置。
		* 配置校验会拒绝非整数或越界值；本函数额外保护绕过配置校验的程序化调用，
		* 丢弃坏条目，不把非法窗口交给宿主。返回新对象；未设置时为 `undefined`。
		*/
		function readContextWindowOverrides(raw) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
			const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && isValidContextWindow(entry[1]));
			return entries.length === 0 ? void 0 : Object.fromEntries(entries);
		}
		//#endregion
		//#region src/output-budget.ts
		/**
		* Output-budget bounds shared by the Host, the browser settings page and the
		* adapter (issue #74).
		*
		* The module stays pure (no node imports) so the client bundle can inline it,
		* exactly like `context-window.ts`. The report behind issue #74 asked for a
		* knob that stops the adapter from writing `max_tokens` at all; that is the
		* `0` sentinel here rather than a separate `null` spelling, because the value
		* travels through one numeric settings field on both surfaces.
		*/
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
		* model's context window`, which `isContextOverflowDetail()` classifies as
		* `CONTEXT_WINDOW_EXCEEDED` independently of this constant.
		*
		* A user-set positive budget can only TIGHTEN this, never raise it — a figure
		* above the cap would be refused by the gateway anyway, so the settings field
		* refuses it at the input instead of spending a round trip to learn that.
		*
		* Lives here rather than in `adapter.ts` so the browser settings page can bound
		* its input by the same figure the Host enforces; `adapter.ts` re-exports it
		* under its historical name.
		*/
		const MAX_OUTPUT_TOKEN_LIMIT = 131072;
		/**
		* Whether a value can serve as a user output budget: the omit sentinel, or a
		* whole token count inside the gateway's own ceiling.
		*
		* Programmatically built connections can bypass schemastery normalization, so
		* the resolve step re-judges every value here and drops an out-of-range one
		* back to "unset" instead of letting the request carry a budget the gateway
		* refuses.
		*/
		function isValidMaxOutputTokens(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 131072;
		}
		//#endregion
		//#region src/client/settings-write.ts
		/** 设置写入过程：同一控制器的意图按顺序执行，配置确认与凭据确认分别保留。
		* 生产使用现有远端设置／凭据，测试替换这些依赖；不提供跨服务事务。 */
		const DEFAULT_API_KEY_REF = "COMMANDCODE_API_KEY";
		/** 与宿主路由的第一条匹配规则一致，重复模型只归属于先出现的账号。 */
		function accountModelMap(rules) {
			const claimed = /* @__PURE__ */ new Set();
			const map = /* @__PURE__ */ new Map();
			for (const rule of rules) {
				const list = map.get(rule.account) ?? [];
				for (const model of rule.models) {
					if (claimed.has(model)) continue;
					claimed.add(model);
					list.push(model);
				}
				map.set(rule.account, list);
			}
			return map;
		}
		const record$3 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		const result = () => ({
			config: "none",
			credential: "none",
			issue: void 0,
			refreshFailed: false,
			credentialRef: void 0
		});
		const closedResult = () => ({
			...result(),
			issue: "closed"
		});
		const fieldBaseline = (snapshot, field) => ({
			value: snapshot.value?.[field],
			base: record$3(snapshot.base)[field],
			user: record$3(snapshot.user)[field],
			overridden: Object.hasOwn(record$3(snapshot.user), field)
		});
		/** 不用显示文本比较配置；数组顺序与显式覆盖／继承也是写入事实。 */
		function sameValue(a, b) {
			if (Object.is(a, b)) return true;
			if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
			if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
			const left = record$3(a), right = record$3(b);
			const keys = Object.keys(left);
			return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
		}
		function writeCompleted(outcome) {
			return outcome.issue === void 0 && outcome.config !== "conflict" && outcome.config !== "unconfirmed" && outcome.credential !== "not-issued" && outcome.credential !== "unconfirmed";
		}
		var SettingsWriter = class {
			scope;
			credentials;
			onFactsChanged;
			pending = [];
			running = false;
			closed = false;
			facts = /* @__PURE__ */ new Map();
			/** 每个引用独立的读写世代，防止旧描述覆盖随后确认的凭据修改。 */
			factVersions = /* @__PURE__ */ new Map();
			refreshGeneration = 0;
			refreshFailed = false;
			constructor(scope, credentials, onFactsChanged) {
				this.scope = scope;
				this.credentials = credentials;
				this.onFactsChanged = onFactsChanged;
			}
			credential(ref) {
				return this.facts.get(ref);
			}
			factsRefreshFailed() {
				return this.refreshFailed;
			}
			/** 在入队时捕获意图与目标；执行者不能重新读取页面草稿。 */
			submit(intent) {
				if (this.closed) return Promise.resolve(closedResult());
				const owned = structuredClone(intent);
				const snapshot = this.scope.getSnapshot();
				const ops = owned.kind === "save" ? [...owned.ops] : [];
				if (owned.kind === "save" && owned.visibleModels !== void 0) {
					const list = [...owned.visibleModels];
					const keys = /* @__PURE__ */ new Set();
					for (const layer of [
						snapshot.base,
						snapshot.user,
						snapshot.value
					]) for (const id of Object.keys(readVisibility(record$3(layer).modelVisibility))) keys.add(id);
					ops.push({
						op: "set",
						path: ["visibleModels"],
						value: list
					}, {
						op: "set",
						path: ["modelVisibility"],
						value: Object.fromEntries([...keys].map((id) => [id, list.length === 0 || list.includes(id)]))
					});
				}
				if (owned.kind === "save" && owned.contextWindowOverrides !== void 0) ops.push({
					op: "set",
					path: ["contextWindowOverrides"],
					value: owned.contextWindowOverrides
				});
				const baseline = new Map(ops.map((op) => [op.path[0], structuredClone(fieldBaseline(snapshot, op.path[0]))]));
				const defaultRef = owned.kind === "save" && owned.key !== void 0 || owned.kind === "key" && owned.target === "default" ? this.defaultRef() : void 0;
				return new Promise((resolve) => {
					this.pending.push({
						command: {
							intent: owned,
							ops,
							baseline,
							defaultRef
						},
						resolve
					});
					if (!this.running) this.drain();
				});
			}
			/** 销毁不等待远端；未发出的任务立即结束，已发调用只能自然收束。 */
			dispose() {
				this.closed = true;
				for (const task of this.pending.splice(0)) task.resolve(closedResult());
				this.facts.clear();
				this.factVersions.clear();
			}
			async drain() {
				this.running = true;
				try {
					for (;;) {
						const task = this.pending.shift();
						if (task === void 0) break;
						let outcome;
						try {
							outcome = this.closed ? closedResult() : await this.execute(task.command);
						} catch {
							outcome = {
								...result(),
								config: "unconfirmed"
							};
						}
						task.resolve(outcome);
					}
				} finally {
					this.running = false;
				}
			}
			defaultRef() {
				const ref = this.scope.getSnapshot().value?.apiKeyEnv;
				return typeof ref === "string" && ref !== "" ? ref : DEFAULT_API_KEY_REF;
			}
			value(field) {
				return this.scope.getSnapshot().value?.[field];
			}
			accounts() {
				const raw = this.value("accounts");
				return Array.isArray(raw) ? raw.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
			}
			rules() {
				const raw = this.value("modelAccountRules");
				if (!Array.isArray(raw)) return [];
				return raw.flatMap((item) => {
					const rule = record$3(item);
					const models = Array.isArray(rule.models) ? rule.models.filter((id) => typeof id === "string" && id !== "") : [];
					return models.length ? [{
						models,
						account: typeof rule.account === "string" && rule.account !== "" ? rule.account : "default"
					}] : [];
				});
			}
			cleanupRefs() {
				const raw = this.value("credentialCleanupRefs");
				return Array.isArray(raw) ? [...new Set(raw.filter((ref) => typeof ref === "string" && ref !== ""))] : [];
			}
			bump(ref) {
				const next = (this.factVersions.get(ref) ?? 0) + 1;
				this.factVersions.set(ref, next);
				return next;
			}
			/** 只刷新事实；此入口永远不重放凭据修改。缺少条目不能解释为不存在。 */
			async refreshCredentials(extra = []) {
				if (this.closed) return false;
				const refs = [.../* @__PURE__ */ new Set([
					this.defaultRef(),
					...this.accounts().flatMap((account) => typeof account.apiKeyEnv === "string" ? [account.apiKeyEnv] : []),
					...extra
				])];
				const generation = ++this.refreshGeneration;
				const versions = new Map(refs.map((ref) => [ref, this.bump(ref)]));
				let success = false;
				try {
					const response = await this.credentials.describe(refs);
					if (this.closed) return false;
					success = response.ok && refs.every((ref) => typeof response.value?.[ref]?.configured === "boolean");
					success = success && refs.every((ref) => this.factVersions.get(ref) === versions.get(ref));
					if (success) for (const ref of refs) {
						if (this.factVersions.get(ref) !== versions.get(ref)) continue;
						const view = response.value[ref];
						this.facts.set(ref, {
							configured: view.configured,
							writable: view.writable ?? true
						});
					}
				} catch {}
				if (!this.closed && generation === this.refreshGeneration) {
					this.refreshFailed = !success;
					this.onFactsChanged();
				}
				return success;
			}
			async commit(ops, baseline) {
				if (this.closed) return { result: "cancelled" };
				const snapshot = this.scope.getSnapshot();
				if (!snapshot.writable || this.scope.mutate === void 0) return { result: "failed" };
				if (baseline && [...baseline].some(([field, before]) => !sameValue(before, fieldBaseline(snapshot, field)))) return { result: "conflict" };
				try {
					return await this.scope.mutate(ops, snapshot.revision);
				} catch (error) {
					return {
						result: "failed",
						message: readableErrorText(error)
					};
				}
			}
			async configure(outcome, ops, baseline) {
				if (ops.length === 0) return true;
				const confirmation = await this.commit(ops, baseline);
				outcome.config = confirmation.result === "accepted" ? "confirmed" : confirmation.result === "conflict" ? "conflict" : "unconfirmed";
				if (confirmation.result === "failed" && confirmation.message !== void 0) outcome.hostError = confirmation.message;
				if (confirmation.result === "cancelled" || this.closed) outcome.issue = "closed";
				return confirmation.result === "accepted" && !this.closed;
			}
			async changeCredential(outcome, ref, value, defaultRef) {
				outcome.credential = "not-issued";
				if (this.closed) {
					outcome.issue = "closed";
					return;
				}
				if (defaultRef !== void 0 && this.defaultRef() !== defaultRef) {
					outcome.issue = "target-changed";
					return;
				}
				outcome.credentialRef = ref;
				this.bump(ref);
				try {
					outcome.credential = (value === void 0 ? await this.credentials.unset(ref) : await this.credentials.set(ref, value)).ok ? "confirmed" : "unconfirmed";
				} catch {
					outcome.credential = "unconfirmed";
				}
				if (this.closed) {
					outcome.issue = "closed";
					return;
				}
				this.bump(ref);
				if (outcome.credential === "confirmed") {
					this.facts.set(ref, {
						configured: value !== void 0,
						writable: this.facts.get(ref)?.writable ?? true
					});
					this.onFactsChanged();
				}
				if (defaultRef !== void 0 && this.defaultRef() !== defaultRef) outcome.issue = "target-changed";
				outcome.refreshFailed = !await this.refreshCredentials([ref]);
				if (defaultRef !== void 0 && this.defaultRef() !== defaultRef) outcome.issue = "target-changed";
				if (this.closed) outcome.issue = "closed";
			}
			async execute(command) {
				const outcome = result();
				const intent = command.intent;
				if (!this.scope.getSnapshot().writable) return {
					...outcome,
					config: intent.kind === "key" || intent.kind === "save" && command.ops.length === 0 ? "none" : "unconfirmed",
					credential: intent.kind === "key" || intent.kind === "save" && intent.key !== void 0 ? "not-issued" : "none"
				};
				if (intent.kind === "save") {
					if (intent.key !== void 0) outcome.credential = "not-issued";
					if (!await this.configure(outcome, command.ops, command.baseline)) return outcome;
					if (intent.key !== void 0) await this.changeCredential(outcome, command.defaultRef, intent.key, command.defaultRef);
				} else if (intent.kind === "key") {
					if (intent.value !== void 0 && intent.value.trim() === "") return {
						...outcome,
						credential: "not-issued"
					};
					await this.changeCredential(outcome, command.defaultRef ?? intent.target, intent.value, command.defaultRef);
				} else if (intent.kind === "rename") {
					if (intent.label === "") return {
						...outcome,
						config: "unconfirmed"
					};
					await this.configure(outcome, [{
						op: "set",
						path: ["accounts"],
						value: this.accounts().map((account) => account.apiKeyEnv === intent.ref ? {
							...account,
							label: intent.label
						} : { ...account })
					}]);
				} else if (intent.kind === "active") {
					const base = record$3(this.scope.getSnapshot().base).activeAccount;
					const op = intent.id !== "" || typeof base === "string" && base !== "" ? {
						op: "set",
						path: ["activeAccount"],
						value: intent.id
					} : {
						op: "unset",
						path: ["activeAccount"]
					};
					await this.configure(outcome, [op]);
				} else if (intent.kind === "models") {
					const chosen = [...new Set(intent.models.filter((id) => id !== ""))];
					const taken = new Set(chosen);
					const map = accountModelMap(this.rules());
					for (const [account, models] of map) if (account !== intent.target) map.set(account, models.filter((id) => !taken.has(id)));
					map.set(intent.target, chosen);
					const rules = [...map].flatMap(([account, models]) => models.length ? [{
						account,
						models
					}] : []);
					await this.configure(outcome, [{
						op: "set",
						path: ["modelAccountRules"],
						value: rules
					}]);
				} else {
					if (intent.kind === "remove") {
						if (!this.accounts().some((account) => account.apiKeyEnv === intent.ref) && !this.cleanupRefs().includes(intent.ref)) return {
							...outcome,
							config: "unconfirmed"
						};
						const snapshot = this.scope.getSnapshot();
						const ops = [
							{
								op: "set",
								path: ["accounts"],
								value: this.accounts().filter((account) => account.apiKeyEnv !== intent.ref).map((account) => ({ ...account }))
							},
							{
								op: "set",
								path: ["modelAccountRules"],
								value: this.rules().filter((rule) => rule.account !== intent.ref)
							},
							{
								op: "set",
								path: ["credentialCleanupRefs"],
								value: [.../* @__PURE__ */ new Set([...this.cleanupRefs(), intent.ref])]
							}
						];
						if (this.value("activeAccount") === intent.ref) ops.push(record$3(snapshot.base).activeAccount === intent.ref ? {
							op: "set",
							path: ["activeAccount"],
							value: ""
						} : {
							op: "unset",
							path: ["activeAccount"]
						});
						if (!await this.configure(outcome, ops)) return outcome;
					}
					await this.cleanRemoved(outcome, intent.ref);
				}
				return outcome;
			}
			async cleanRemoved(outcome, ref) {
				if (!this.cleanupRefs().includes(ref)) {
					if (outcome.config !== "confirmed") outcome.config = "unconfirmed";
					outcome.issue = "cleanup-pending";
					return;
				}
				if (this.closed) {
					outcome.issue = "closed";
					return;
				}
				if (!await this.refreshCredentials([ref])) {
					outcome.credential = "not-issued";
					outcome.refreshFailed = true;
					return;
				}
				if (this.closed) {
					outcome.issue = "closed";
					return;
				}
				const inherited = record$3(this.scope.getSnapshot().base).accounts;
				if (!(ref === this.defaultRef() || this.accounts().some((account) => account.apiKeyEnv === ref) || Array.isArray(inherited) && inherited.some((account) => record$3(account).apiKeyEnv === ref) || this.rules().some((rule) => rule.account === ref) || this.value("activeAccount") === ref) && this.facts.get(ref)?.configured === true) {
					await this.changeCredential(outcome, ref, void 0);
					if (!writeCompleted(outcome) || outcome.refreshFailed) {
						if (outcome.issue === void 0 && outcome.credential === "confirmed") outcome.issue = "cleanup-pending";
						return;
					}
				}
				if (this.closed) {
					outcome.issue = "closed";
					return;
				}
				const cleanup = result();
				if (!await this.configure(cleanup, [{
					op: "set",
					path: ["credentialCleanupRefs"],
					value: this.cleanupRefs().filter((entry) => entry !== ref)
				}])) {
					if (outcome.config === "none") {
						outcome.config = cleanup.config;
						if (cleanup.hostError !== void 0) outcome.hostError = cleanup.hostError;
					}
					outcome.issue = cleanup.issue ?? "cleanup-pending";
				} else if (outcome.config === "none") {
					outcome.config = cleanup.config;
					if (cleanup.hostError !== void 0) outcome.hostError = cleanup.hostError;
				}
			}
		};
		//#endregion
		//#region src/client/settings.ts
		/** 设置页面控制器只负责输入校验、草稿版本与页面投影。
		* 保存及即时账号操作由同一个设置写入过程持有；设置与凭据分别确认。 */
		/** The settings namespace the plugin registers (host half, src/index.ts). */
		const COMMANDCODE_NS = "llm-commandcode";
		/** A free-text field; an empty draft clears it. */
		function textField(field) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			};
		}
		/**
		* A numeric field; an empty draft clears it, anything non-numeric blocks
		* save, and an optional inclusive `bounds` range rejects out-of-range values
		* with a specific reason (the Host schema would reject them at save time with
		* only a generic failure — catching it here names the problem while typing).
		* Decimals pass, like the Host schema's `z.number()`.
		*/
		function numberField$2(field, bounds) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					if (!Number.isFinite(parsed)) return {
						kind: "invalid",
						reason: "format"
					};
					if (bounds?.min !== void 0 && parsed < bounds.min) return {
						kind: "invalid",
						reason: "tooSmall"
					};
					if (bounds?.max !== void 0 && parsed > bounds.max) return {
						kind: "invalid",
						reason: "tooLarge"
					};
					return {
						kind: "set",
						value: parsed
					};
				}
			};
		}
		/**
		* The compact token-count shorthand (`32K`, `1M`) in BINARY units, the way
		* context windows are quoted: 32K → 32 768 (32 × 1024), 128K → 131 072,
		* 1M → 1 048 576 (1024 × 1024), so the common power-of-two windows land on
		* their exact values instead of 1000-based rounding. A leading sign is not part
		* of the grammar, so this path can only produce values ≥ 0.
		*/
		const COMPACT_TOKENS = /^(\d+(?:\.\d+)?)\s*([kKmM])$/;
		/**
		* A whole-token count field with optional compact shorthand, shared by the
		* context-length and output-budget inputs (issues #86, #74).
		*
		* Plain text goes through the {@link numberField} parse plus the caller's
		* whole-token validator; shorthand converts to whole tokens first
		* (`Math.round` keeps fractional shorthand like `1.5K` on whole tokens) and is
		* then bounds-checked against the SAME `bounds`, so an overshoot names
		* `tooLarge` here instead of reaching the Host schema, which would reject it at
		* save time with only a generic failure. Empty clears in both paths.
		*
		* `isValid` is what tells the two apart: context lengths start at 1, while the
		* output budget's lower bound IS its omit sentinel (`0` means "send no
		* `max_tokens`"), so no single numeric range can serve both.
		*/
		function tokenCountField(field, bounds, isValid) {
			const plain = numberField$2(field, bounds);
			return {
				field,
				format: plain.format,
				parse: (text) => {
					const compact = COMPACT_TOKENS.exec(text.trim());
					if (compact === null) {
						const parsed = plain.parse(text);
						return parsed.kind === "set" && !isValid(parsed.value) ? {
							kind: "invalid",
							reason: "format"
						} : parsed;
					}
					const value = Math.round(Number(compact[1]) * (compact[2].toLowerCase() === "k" ? 1024 : 1048576));
					if (value < bounds.min) return {
						kind: "invalid",
						reason: "tooSmall"
					};
					if (value > bounds.max) return {
						kind: "invalid",
						reason: "tooLarge"
					};
					return {
						kind: "set",
						value
					};
				}
			};
		}
		/**
		* A boolean field, staged as the strings `'true'`/`'false'` (an empty draft
		* clears it). The component renders a toggle and only ever stages these two
		* strings; anything else blocks save.
		*/
		function booleanField$1(field) {
			return {
				field,
				format: (value) => typeof value === "boolean" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return {
						kind: "set",
						value: true
					};
					if (trimmed === "false") return {
						kind: "set",
						value: false
					};
					return {
						kind: "invalid",
						reason: "format"
					};
				}
			};
		}
		/**
		* The single-turn output budget (issue #74).
		*
		* The range INCLUDES `0`, and `0` is not a budget: it is the sentinel asking
		* the adapter to send no `max_tokens` field at all, leaving the per-turn output
		* size to the platform. The upper bound is the gateway's own cap
		* ({@link MAX_OUTPUT_TOKEN_LIMIT}) rather than an arbitrary one — a larger
		* figure would simply be refused, so the input is where that is worth saying. A
		* blank draft clears the setting back to the derived default, which is the
		* behaviour every existing profile has.
		*/
		function maxOutputTokensField(field) {
			return tokenCountField(field, {
				min: 0,
				max: MAX_OUTPUT_TOKEN_LIMIT
			}, isValidMaxOutputTokens);
		}
		/**
		* 秒制输入保留毫秒精度，兼容已有 1500ms、1ms 等配置。
		*
		* Milliseconds are the wrong unit to show: the defaults are 300000 and the
		* ceiling is 2147483647, so the page asked users to do arithmetic to answer
		* "how long is a reasonable wait". `format` divides, `parse` multiplies, and
		* the stored value never leaves milliseconds.
		*
		* 最多三位小数；不接受更多位数后悄悄取整，避免页面与存储不一致。
		*/
		function secondsField(field, bounds) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value / 1e3) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					if (!Number.isFinite(parsed) || !/^-?(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(trimmed)) return {
						kind: "invalid",
						reason: "format"
					};
					if (parsed < bounds.min) return {
						kind: "invalid",
						reason: "tooSmall"
					};
					if (parsed > bounds.max) return {
						kind: "invalid",
						reason: "tooLarge"
					};
					return {
						kind: "set",
						value: Math.round(parsed * 1e3)
					};
				}
			};
		}
		/** The fields this page edits inside the `llm-commandcode` namespace. */
		const SECTION_FIELDS = [
			textField("apiBase"),
			secondsField("requestTimeoutMs", {
				min: MIN_TIMEOUT_SECONDS,
				max: MAX_TIMEOUT_SECONDS
			}),
			secondsField("streamIdleTimeoutMs", {
				min: MIN_TIMEOUT_SECONDS,
				max: MAX_TIMEOUT_SECONDS
			}),
			numberField$2("transportMaxRetries", {
				min: 0,
				max: 50
			}),
			tokenCountField("contextWindow", {
				min: 1,
				max: CONTEXT_WINDOW_MAX
			}, isValidContextWindow),
			maxOutputTokensField("maxOutputTokens"),
			booleanField$1("offloadSeenImagesForCache"),
			booleanField$1("filterModelsByPlan"),
			booleanField$1("webSearch"),
			booleanField$1("showSidebarQuota"),
			booleanField$1("zdr")
		];
		/** Whether two model-id lists are equal as sets (order-insensitive). */
		function sameModels(a, b) {
			if (a.length !== b.length) return false;
			const set = new Set(a);
			return b.every((id) => set.has(id));
		}
		/** 共享控制器跨普通切页保存草稿，插件销毁才关闭写入过程。 */
		var CommandCodeSettingsController = class {
			scope;
			api;
			specs = new Map(SECTION_FIELDS.map((spec) => [spec.field, spec]));
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			disposers = [];
			disposed = false;
			credentialRef = DEFAULT_API_KEY_REF;
			writer;
			saveResult;
			accountResult;
			/** Staged visible-model allowlist (undefined = no draft). */
			visibleModelsDraft = void 0;
			/** Staged per-model context-length overrides as raw text (undefined = no draft, issue #86). */
			contextWindowOverridesDraft = void 0;
			catalogModels = [];
			catalogFailed = false;
			saving = false;
			failed = false;
			savedCount = 0;
			accountPending = 0;
			accountFailed = void 0;
			constructor(scope, api) {
				this.scope = scope;
				this.api = api;
				this.writer = new SettingsWriter(scope, api.credentials, () => this.publish());
				this.disposers.push(scope.subscribe(() => {
					this.recomputeCredentialRef();
					this.writer.refreshCredentials();
					this.publish();
				}));
				this.recomputeCredentialRef();
				this.writer.refreshCredentials();
				this.refreshCatalog();
			}
			/** Release every subscription held on external sources. Idempotent. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.writer.dispose();
				this.staged.clear();
				this.visibleModelsDraft = void 0;
				this.contextWindowOverridesDraft = void 0;
				for (const dispose of this.disposers) dispose();
				this.disposers.length = 0;
				this.listeners.clear();
			}
			/**
			* The credential reference the section names, or the provider default. A
			* user who renamed `apiKeyEnv` in the profile Config gets a page that
			* addresses the renamed ref instead of silently writing the default —
			* 与模型卡共享同一设置引用。
			*/
			recomputeCredentialRef() {
				const snapshot = this.scope.getSnapshot();
				const named = typeof snapshot.value?.apiKeyEnv === "string" && snapshot.value.apiKeyEnv.length > 0 ? snapshot.value.apiKeyEnv : DEFAULT_API_KEY_REF;
				if (named === this.credentialRef) return;
				this.credentialRef = named;
			}
			/** Subscribe to state projections. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			/** Build the current page state face. */
			state() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				const credential = this.writer.credential(this.credentialRef);
				const accounts = this.effectiveAccounts();
				const active = this.sectionValue("activeAccount");
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					apiKeyConfigured: credential?.configured ?? false,
					apiKeyKnown: credential !== void 0,
					anyAccountConfigured: (credential?.configured ?? false) || accounts.some((account) => account.configured),
					apiKeyWritable: credential?.writable ?? true,
					apiKey: {
						text: this.staged.get("apiKey")?.text ?? "",
						clear: false,
						overridden: false,
						invalid: false,
						invalidReason: void 0
					},
					apiBase: this.field("apiBase"),
					requestTimeoutMs: this.field("requestTimeoutMs"),
					streamIdleTimeoutMs: this.field("streamIdleTimeoutMs"),
					transportMaxRetries: this.field("transportMaxRetries"),
					offloadSeenImagesForCache: this.field("offloadSeenImagesForCache"),
					filterModelsByPlan: this.field("filterModelsByPlan"),
					webSearch: this.field("webSearch"),
					showSidebarQuota: this.field("showSidebarQuota"),
					zdr: this.field("zdr"),
					sidebarQuota: this.sectionValue("showSidebarQuota") === true,
					activeAccount: typeof active === "string" ? active : "",
					accounts,
					accountModels: Object.fromEntries(accountModelMap(this.storedRules())),
					accountBusy: this.accountPending > 0,
					accountFailed: this.accountFailed,
					pendingCredentialCleanup: this.cleanupRefs().filter((ref) => !this.enrollmentRefs(true).includes(ref)),
					accountEnrollmentRefs: this.enrollmentRefs(false),
					visibleModels: this.effectiveVisibleModels(),
					visibleModelsAll: this.visibleModelsDraft === void 0 ? this.storedShowsAll() : this.visibleModelsDraft.length === 0,
					contextWindow: this.field("contextWindow"),
					maxOutputTokens: this.field("maxOutputTokens"),
					contextWindowOverrides: this.effectiveContextWindowOverrides(),
					catalogModels: this.catalogModels,
					catalogFailed: this.catalogFailed,
					dirty: plan.length > 0 || this.visibleModelsDirty() || this.contextWindowOverridesDirty(),
					invalid: plan.some((item) => item.change === void 0) || this.effectiveContextWindowOverrides().some((row) => row.invalid),
					saving: this.saving,
					failed: this.failed,
					savedCount: this.savedCount,
					saveResult: this.saveResult,
					accountResult: this.accountResult,
					credentialRefreshFailed: this.writer.factsRefreshFailed()
				};
			}
			enrollmentRefs(includeNamed) {
				const records = this.sectionValue("accountEnrollmentTasks");
				if (!Array.isArray(records)) return [];
				return records.flatMap((item) => {
					if (typeof item !== "object" || item === null) return [];
					const record = item;
					return typeof record.ref === "string" && (includeNamed || record.phase !== "naming") ? [record.ref] : [];
				});
			}
			/** Stage one field's draft text. */
			edit(field, text) {
				if (field !== "apiKey") this.spec(field);
				this.staged.set(field, {
					text,
					clear: false
				});
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/** Reset one section field to its inherited (composition) value. */
			resetField(field) {
				if (field === "apiKey") {
					this.staged.delete("apiKey");
					this.failed = false;
					this.publish();
					return;
				}
				const spec = this.spec(field);
				this.staged.set(field, {
					text: spec.format(this.baseValue(field)),
					clear: true
				});
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/** Discard every staged edit. */
			discard() {
				if (this.staged.size === 0 && this.visibleModelsDraft === void 0 && this.contextWindowOverridesDraft === void 0 && !this.failed) return;
				this.staged.clear();
				this.visibleModelsDraft = void 0;
				this.contextWindowOverridesDraft = void 0;
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/**
			* Re-read the Host's credential facts without any staged edit. The browser
			* login stores a key Host-side behind the page's back; the plugin entry
			* calls this when a login lands so the configured/writable badges follow.
			*/
			async refreshCredentials() {
				if (!await this.writer.refreshCredentials() || this.disposed) return;
				if (this.saveResult) this.saveResult = {
					...this.saveResult,
					refreshFailed: false
				};
				if (this.accountResult) this.accountResult = {
					...this.accountResult,
					refreshFailed: false
				};
				this.publish();
			}
			/** 冻结点击时的草稿；只清理本次已确认且期间未被替换的对象。 */
			async save() {
				if (this.disposed || this.saving) return;
				const submitted = new Map(this.staged);
				const submittedVisible = this.visibleModelsDraft;
				const submittedContextOverrides = this.contextWindowOverridesDraft;
				const plan = this.plan();
				const visibleDirty = this.visibleModelsDirty();
				const contextOverrides = this.parsedContextWindowOverrides();
				const contextOverridesDirty = this.contextWindowOverridesDirty();
				if (plan.length === 0 && !visibleDirty && !contextOverridesDirty || plan.some((item) => item.change === void 0) || contextOverrides.invalid) return;
				const ops = plan.flatMap((item) => typeof item.change === "object" ? [item.change] : []);
				const key = plan.find((item) => item.field === "apiKey")?.change;
				this.saving = true;
				this.failed = false;
				this.saveResult = void 0;
				const completion = this.writer.submit({
					kind: "save",
					ops,
					...visibleDirty ? { visibleModels: submittedVisible ?? [] } : {},
					...contextOverridesDirty ? { contextWindowOverrides: contextOverrides.values } : {},
					...typeof key === "string" ? { key } : {}
				});
				this.publish();
				const outcome = await completion;
				if (this.disposed) return outcome;
				this.saving = false;
				this.saveResult = outcome;
				this.failed = !writeCompleted(outcome);
				if (!this.failed) this.savedCount += 1;
				for (const [field, draft] of submitted) if ((field === "apiKey" ? outcome.credential === "confirmed" && outcome.issue === void 0 : outcome.config === "confirmed" || writeCompleted(outcome)) && this.staged.get(field) === draft) this.staged.delete(field);
				if ((outcome.config === "confirmed" || writeCompleted(outcome)) && this.visibleModelsDraft === submittedVisible) this.visibleModelsDraft = void 0;
				if ((outcome.config === "confirmed" || writeCompleted(outcome)) && this.contextWindowOverridesDraft === submittedContextOverrides) this.contextWindowOverridesDraft = void 0;
				this.publish();
				return outcome;
			}
			/** Stage the visible-model allowlist (multi-select). */
			editVisibleModels(models) {
				this.visibleModelsDraft = [...models];
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/** Stage "show all models" (clears the allowlist). */
			clearVisibleModels() {
				this.visibleModelsDraft = [];
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/**
			* Stage the whole per-model context-length map (issue #86): one entry per
			* row, the value the row's input shows verbatim (blank = drop the override
			* on save). The component rebuilds the map from its projected rows, so a
			* model reselect moves the value to its new key in the same edit.
			*/
			editContextWindowOverrides(next) {
				this.contextWindowOverridesDraft = { ...next };
				this.failed = false;
				this.saveResult = void 0;
				this.publish();
			}
			/** The stored per-model overrides, already cleaned by the shared validity rule. */
			storedContextWindowOverrides() {
				return { ...readContextWindowOverrides(this.sectionValue("contextWindowOverrides")) };
			}
			/** Effective rows: the staged draft verbatim, or the stored values formatted. */
			effectiveContextWindowOverrides() {
				const draft = this.contextWindowOverridesDraft;
				const source = draft !== void 0 ? draft : Object.fromEntries(Object.entries(this.storedContextWindowOverrides()).map(([model, value]) => [model, String(value)]));
				return Object.entries(source).filter(([model]) => model !== "").map(([model, text]) => {
					const parsed = this.spec("contextWindow").parse(text);
					return {
						model,
						text,
						invalid: parsed.kind === "invalid",
						invalidReason: parsed.kind === "invalid" ? parsed.reason : void 0
					};
				});
			}
			/**
			* The draft parsed for the write: blank rows and unparseable rows drop out
			* (an invalid row blocks save on its own), everything else is the value the
			* writer puts at `contextWindowOverrides`.
			*/
			parsedContextWindowOverrides() {
				const values = {};
				let invalid = false;
				for (const row of this.effectiveContextWindowOverrides()) {
					if (row.invalid) {
						invalid = true;
						continue;
					}
					const parsed = this.spec("contextWindow").parse(row.text);
					if (parsed.kind === "set" && typeof parsed.value === "number") values[row.model] = parsed.value;
				}
				return {
					values,
					invalid
				};
			}
			contextWindowOverridesDirty() {
				if (this.contextWindowOverridesDraft === void 0) return false;
				const values = this.parsedContextWindowOverrides().values;
				const stored = this.storedContextWindowOverrides();
				return [.../* @__PURE__ */ new Set([...Object.keys(values), ...Object.keys(stored)])].some((model) => values[model] !== stored[model]);
			}
			renameAccount(ref, label) {
				return this.runAccountOp("rename", {
					kind: "rename",
					ref,
					label: label.trim()
				});
			}
			/** 配置移除确认后才清理凭据，失败记录留在宿主清理队列。 */
			removeAccount(ref) {
				return this.runAccountOp("remove", {
					kind: "remove",
					ref
				});
			}
			retryCredentialCleanup(ref) {
				return this.runAccountOp("remove", {
					kind: "cleanup",
					ref
				});
			}
			cleanupRefs() {
				const raw = this.sectionValue("credentialCleanupRefs");
				return Array.isArray(raw) ? [...new Set(raw.filter((ref) => typeof ref === "string" && ref !== ""))] : [];
			}
			setAccountKey(target, key) {
				return this.runAccountOp("key", {
					kind: "key",
					target,
					value: key.trim()
				});
			}
			clearAccountKey(target) {
				return this.runAccountOp("key", {
					kind: "key",
					target
				});
			}
			setActiveAccount(id) {
				return this.runAccountOp("active", {
					kind: "active",
					id
				});
			}
			setAccountModels(target, models) {
				return this.runAccountOp("models", {
					kind: "models",
					target,
					models
				});
			}
			/** 即时入口与保存共享写入过程，只在这里维护页面忙碌投影。 */
			async runAccountOp(op, intent) {
				this.accountPending += 1;
				this.accountFailed = void 0;
				this.accountResult = void 0;
				const completion = this.writer.submit(intent);
				this.publish();
				const outcome = await completion;
				this.accountPending -= 1;
				if (this.disposed) return false;
				const ok = writeCompleted(outcome);
				this.accountResult = outcome;
				this.accountFailed = ok ? void 0 : op;
				this.publish();
				return ok;
			}
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`commandcode settings page has no field ${field}`);
				return spec;
			}
			/** One field's rendered state: draft text, whether it is user-overridden, invalid. */
			field(field) {
				const spec = this.spec(field);
				const staged = this.staged.get(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					clear: false,
					overridden: this.stored(field),
					invalid: false,
					invalidReason: void 0
				};
				const parsed = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					clear: staged.clear,
					overridden: parsed.kind === "set",
					invalid: parsed.kind === "invalid",
					invalidReason: parsed.kind === "invalid" ? parsed.reason : void 0
				};
			}
			sectionValue(field) {
				return this.scope.getSnapshot().value?.[field];
			}
			baseValue(field) {
				const base = this.scope.getSnapshot().base;
				return typeof base === "object" && base !== null && !Array.isArray(base) ? base[field] : void 0;
			}
			userLayer() {
				const user = this.scope.getSnapshot().user;
				return typeof user === "object" && user !== null && !Array.isArray(user) ? user : void 0;
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.prototype.hasOwnProperty.call(user, field);
			}
			/** 纯提交计划；不捕获副作用闭包，也不在排队后重新读取草稿。 */
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					if (field === "apiKey") {
						const value = staged.text.trim();
						if (value !== "") plan.push({
							field,
							change: value
						});
						continue;
					}
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({
							field,
							change: {
								op: "unset",
								path: [field]
							}
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const parsed = spec.parse(staged.text);
					const change = parsed.kind === "invalid" ? void 0 : parsed.kind === "clear" ? {
						op: "unset",
						path: [field]
					} : {
						op: "set",
						path: [field],
						value: parsed.value
					};
					plan.push({
						field,
						change
					});
				}
				return plan;
			}
			/**
			* Fetch the model catalog through the Host Remote. Runs once at construction;
			* call again (e.g. from the client entry once the Remote mount lands) to
			* (re)try — a later success clears a prior failure flag, so the editors
			* recover without a page reload.
			*/
			refreshCatalog() {
				const models = this.api.models;
				if (models === void 0) {
					this.catalogFailed = true;
					this.publish();
					return;
				}
				models().then((response) => {
					if (response.ok && Array.isArray(response.value?.models)) {
						const shaped = [];
						for (const model of response.value.models) {
							if (typeof model !== "object" || model === null) continue;
							const entry = model;
							if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
							shaped.push({
								id: entry.id,
								name: entry.name,
								...typeof entry.tier === "string" ? { tier: entry.tier } : {},
								...typeof entry.allowance === "number" && Number.isFinite(entry.allowance) ? { allowance: entry.allowance } : {}
							});
						}
						this.catalogModels = shaped;
						this.catalogFailed = false;
					} else this.catalogFailed = true;
				}, () => {
					this.catalogFailed = true;
				}).then(() => this.publish());
			}
			/** The raw `accounts` array of the stored section, verbatim. */
			rawStoredAccounts() {
				const raw = this.scope.getSnapshot().value?.accounts;
				if (!Array.isArray(raw)) return [];
				return raw.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
			}
			/**
			* The stored extra accounts this page can address: the rows carrying a
			* credential reference. Entries it cannot name (a composition entry with a
			* literal `apiKey`, or an unknown shape) are never dropped — every list
			* write starts from {@link rawStoredAccounts} and copies them verbatim,
			* because the settings layer replaces the whole array.
			*/
			storedExtras() {
				const out = [];
				const seen = /* @__PURE__ */ new Set();
				for (const record of this.rawStoredAccounts()) {
					const ref = record.apiKeyEnv;
					if (typeof ref !== "string" || ref === "" || seen.has(ref)) continue;
					seen.add(ref);
					const label = record.label;
					out.push({
						label: typeof label === "string" && label !== "" ? label : ref,
						ref
					});
				}
				return out;
			}
			effectiveAccounts() {
				return this.storedExtras().map((extra) => ({
					id: extra.ref,
					ref: extra.ref,
					label: extra.label,
					configured: this.writer.credential(extra.ref)?.configured ?? false,
					credentialKnown: this.writer.credential(extra.ref) !== void 0,
					writable: this.writer.credential(extra.ref)?.writable ?? true
				}));
			}
			/** The stored routing rules from the settings section (`modelAccountRules`). */
			storedRules() {
				const raw = this.scope.getSnapshot().value?.modelAccountRules;
				if (!Array.isArray(raw)) return [];
				const out = [];
				for (const entry of raw) {
					if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
					const record = entry;
					const models = Array.isArray(record.models) ? record.models.filter((m) => typeof m === "string" && m !== "") : [];
					if (models.length === 0) continue;
					out.push({
						models,
						account: typeof record.account === "string" && record.account !== "" ? record.account : "default"
					});
				}
				return out;
			}
			/** 原始白名单；空列表延续现有的显示全部语义。 */
			storedAllowlist() {
				const raw = this.scope.getSnapshot().value?.visibleModels;
				if (!Array.isArray(raw)) return [];
				return raw.filter((m) => typeof m === "string" && m !== "");
			}
			storedShowsAll() {
				return this.storedAllowlist().length === 0 && !Object.values(readVisibility(this.scope.getSnapshot().value?.modelVisibility)).includes(false);
			}
			/** 目录、白名单与显式显示的旧模型一起投影，目录失败不删除旧选择。 */
			storedVisibleModels() {
				const list = this.storedAllowlist();
				const flags = readVisibility(this.scope.getSnapshot().value?.modelVisibility);
				return [.../* @__PURE__ */ new Set([
					...list,
					...this.catalogModels.map((model) => model.id),
					...Object.keys(flags)
				])].filter((id) => modelIsVisible(id, list, flags));
			}
			effectiveVisibleModels() {
				if (this.visibleModelsDraft === void 0) return this.storedVisibleModels();
				return this.visibleModelsDraft.length === 0 ? this.catalogModels.map((model) => model.id) : this.visibleModelsDraft;
			}
			visibleModelsDirty() {
				if (this.visibleModelsDraft === void 0) return false;
				if (this.visibleModelsDraft.length === 0) return !this.storedShowsAll();
				return this.storedShowsAll() || !sameModels(this.visibleModelsDraft, this.storedVisibleModels());
			}
			publish() {
				if (this.disposed) return;
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/display-format.ts
		/** Shared, dependency-free formatting for Host commands and browser surfaces. */
		function formatMoney(value) {
			return `$${value.toFixed(2)}`;
		}
		function formatMoneyExact(value) {
			return `$${value.toFixed(4)}`;
		}
		/**
		* 紧凑数字：K/M/B 三级，一切档位决策的唯一实现。
		*
		* 档位必须**回头判断**：先除以档位再四舍五入会算出 `999_999 → "1000.0K"`、
		* `999_999_999 → "1000.0M"` 这类既超长、又落在并不存在的档位上的结果，
		* 因此每个档位算完后若已经够到下一档，就改用下一档重算一次。
		*
		* @param value - 非负计数或词元数。
		* @param keepZeroDecimal - 整数值是否保留一位小数。词元显示沿用 `3.0B` 的旧样式；
		*   计数显示去掉多余的 `.0`，见 {@link formatCompactCount}。
		* @returns 紧凑文本；不足 1000 时原样返回该整数。
		*/
		function compact(value, keepZeroDecimal) {
			const rounded = (scaled) => Math.round(scaled * 10) / 10;
			const text = (scaled) => {
				const fixed = rounded(scaled);
				return keepZeroDecimal ? fixed.toFixed(1) : String(fixed);
			};
			if (value >= 1e9) return `${text(value / 1e9)}B`;
			if (value >= 1e6) return rounded(value / 1e6) >= 1e3 ? `${text(value / 1e9)}B` : `${text(value / 1e6)}M`;
			if (value >= 1e3) return rounded(value / 1e3) >= 1e3 ? `${text(value / 1e6)}M` : `${text(value / 1e3)}K`;
			return String(value);
		}
		/**
		* 紧凑计数：请求数、成功/失败数这类会被窄卡片截断的整数。
		* `1234` → `1.2K`、`12000` → `12K`、`1500000` → `1.5M`，整数不带多余的 `.0`。
		*/
		function formatCompactCount(value) {
			return compact(value, false);
		}
		/** 紧凑词元数：与 {@link formatCompactCount} 共用档位，但整数值保留一位小数（`3.0B`）。 */
		function formatTokensCompact(value) {
			return compact(value, true);
		}
		/**
		* 精确值悬停提示：只在紧凑显示确实丢了信息时才返回文本。
		* 未换算时悬停弹出的文字与卡片上写的一模一样，没有意义，因此返回 `undefined` 让调用方
		* 整个省略 `title`，而不是挂一个内容重复的提示。
		*
		* @param parts - 标签与精确数值，按卡片上的显示顺序。
		* @returns 形如 `请求数 1234567 · 成功 1234567 · 失败 123` 的提示，或 `undefined`。
		*/
		function compactCountTitle(parts) {
			return parts.some(([, value]) => formatCompactCount(value) !== String(value)) ? parts.map(([label, value]) => `${label} ${value}`).join(" · ") : void 0;
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
		/**
		* {@link formatResetAt} without the year and seconds ("10/21 18:41"): the
		* settings page shows several of these per card, and a reset moment never
		* needs seconds. Empty for an unknown time, like the long form.
		*/
		function formatResetAtShort(ms) {
			return ms <= 0 ? "" : new Date(ms).toLocaleString(void 0, {
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		/** 只有官方汇总与订阅共同确认同一起点，才展示完整账期；旧宿主和部分响应保持未知。 */
		function formatUsageBillingPeriod(usageStart, planStart, planEnd) {
			if (usageStart === void 0 || planStart !== usageStart || planEnd === void 0 || usageStart <= 0 || planEnd <= usageStart) return "";
			const start = new Date(usageStart);
			const end = new Date(planEnd);
			if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "";
			return `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
		}
		//#endregion
		//#region src/client/usage.ts
		const IDLE$1 = {
			status: "idle",
			report: void 0,
			error: void 0,
			fetchedAt: void 0
		};
		/**
		* Controller bridging the `commandcode/report` Remote onto the card. Public
		* API mirrors {@link CommandCodeSettingsController}: `state()` projections,
		* `subscribe`, and one `refresh()` action.
		*/
		var CommandCodeUsageController = class {
			remote;
			listeners = /* @__PURE__ */ new Set();
			current = IDLE$1;
			generation = 0;
			inFlight = false;
			disposed = false;
			/** When the last fetch SETTLED successfully, for {@link USAGE_AUTO_REFRESH_COALESCE_MS}. */
			settledAt;
			constructor(remote) {
				this.remote = remote;
			}
			/** Release every subscription. Idempotent; in-flight results are dropped. */
			dispose() {
				this.disposed = true;
				this.generation += 1;
				this.listeners.clear();
			}
			/** Subscribe to state projections. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			/** The current card state face. */
			state() {
				return this.current;
			}
			/**
			* Fetch (or refetch) the report. Concurrent refreshes collapse onto one
			* request; a superseded fetch's late result is dropped, never published.
			*
			* `auto` marks a refresh nobody asked for — a surface appearing, or the
			* background tick. Those also reuse a result fetched within
			* {@link USAGE_AUTO_REFRESH_COALESCE_MS}, because two surfaces mounting a
			* second apart are asking the same question. Every other caller is a user
			* action and always goes to the wire.
			*/
			async refresh(options) {
				if (this.disposed || this.inFlight) return;
				if (options?.auto === true && this.current.status === "ready" && this.settledAt !== void 0 && Date.now() - this.settledAt < 5e3) return;
				const generation = ++this.generation;
				this.inFlight = true;
				this.current = {
					...this.current,
					status: "loading",
					error: void 0
				};
				this.publish();
				try {
					const response = await this.remote.report();
					if (this.disposed || generation !== this.generation) return;
					if (response.ok) {
						const fetchedAt = Date.now();
						this.settledAt = fetchedAt;
						this.current = {
							status: "ready",
							report: response.value,
							error: void 0,
							fetchedAt
						};
					} else this.current = {
						...this.current,
						status: "error",
						error: response.error.message
					};
				} catch (error) {
					if (this.disposed || generation !== this.generation) return;
					this.current = {
						...this.current,
						status: "error",
						error: readableErrorText(error)
					};
				} finally {
					if (generation === this.generation) this.inFlight = false;
				}
				this.publish();
			}
			publish() {
				if (this.disposed) return;
				for (const listener of this.listeners) listener();
			}
		};
		/** Host facts drive the usage card, including keys invisible to browser credentials. */
		function usageCardState(usage) {
			const accounts = usage.report?.accounts ?? [];
			return {
				loading: usage.status === "loading",
				shouldRefresh: usage.status === "idle",
				noKey: accounts.length > 0 && !accounts.some((account) => account.configured)
			};
		}
		//#endregion
		//#region src/client/prices.ts
		const IDLE = {
			status: "idle",
			table: void 0,
			error: void 0
		};
		const RETRY_TIMER = {
			set(callback, ms) {
				const handle = setTimeout(callback, ms);
				handle.unref?.();
				return handle;
			},
			clear(handle) {
				clearTimeout(handle);
			}
		};
		/**
		* Cache over the `commandcode/prices` Remote, with a bounded transient-retry
		* budget (three retries at 1/2/4 s — bounded, not a poll). Public API mirrors
		* {@link CommandCodeUsageController}: `state()`, `subscribe` and `ensure()`;
		* `reload()` additionally drops the cache and restarts the budget when the
		* Host namespace rebinds. A MANUAL `ensure()` still fetches after the budget
		* is spent, and a PERMANENT failure — the Host serving no such endpoint — is
		* terminal for the binding until `reload()`.
		*/
		var CommandCodePricesController = class {
			remote;
			listeners = /* @__PURE__ */ new Set();
			current = IDLE;
			generation = 0;
			inFlight = false;
			disposed = false;
			retryHandle;
			attempts = 0;
			permanent = false;
			timer;
			constructor(remote, timer = RETRY_TIMER) {
				this.timer = timer;
				this.remote = remote;
			}
			/** Release every subscription. Idempotent; in-flight results are dropped. */
			dispose() {
				this.disposed = true;
				this.clearRetry();
				this.listeners.clear();
			}
			/** Subscribe to state projections. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			/** The current state face. */
			state() {
				return this.current;
			}
			/**
			* Fetch the table unless it is already loaded, permanent, or in flight — and
			* unless a bounded retry already owns the next attempt. Only the client
			* entry calls this (on rebind and on a manual refresh), so a mounted readout
			* renders the current state instead of triggering a fetch of its own.
			*/
			ensure() {
				if (this.disposed || this.permanent || this.inFlight || this.current.status === "ready") return;
				this.clearRetry();
				const call = this.remote.prices;
				if (typeof call !== "function") {
					this.permanent = true;
					this.publish({
						status: "error",
						table: void 0,
						error: "the Host serves no commandcode/prices endpoint"
					});
					return;
				}
				const generation = this.generation;
				this.inFlight = true;
				this.attempts += 1;
				this.publish({
					status: "loading",
					table: this.current.table,
					error: void 0
				});
				let request;
				try {
					request = call.call(this.remote);
				} catch (error) {
					request = Promise.reject(error);
				}
				request.then((result) => {
					if (this.disposed || generation !== this.generation) return;
					this.inFlight = false;
					if (result.ok) {
						this.publish({
							status: "ready",
							table: result.value,
							error: void 0
						});
						return;
					}
					this.permanent = result.error.permanent === true;
					this.publish({
						status: "error",
						table: void 0,
						error: result.error.message
					});
					this.scheduleRetry();
				}, (error) => {
					if (this.disposed || generation !== this.generation) return;
					this.inFlight = false;
					this.publish({
						status: "error",
						table: void 0,
						error: readableErrorText(error)
					});
					this.scheduleRetry();
				});
			}
			/** Rebinding a Host invalidates cached prices and restarts the bounded retry budget. */
			reload() {
				if (this.disposed) return;
				this.generation += 1;
				this.inFlight = false;
				this.clearRetry();
				this.permanent = false;
				this.attempts = 0;
				this.current = IDLE;
				this.ensure();
			}
			clearRetry() {
				if (this.retryHandle !== void 0) this.timer.clear(this.retryHandle);
				this.retryHandle = void 0;
			}
			scheduleRetry() {
				if (this.disposed || this.permanent || this.attempts >= 4) return;
				this.retryHandle = this.timer.set(() => {
					this.retryHandle = void 0;
					this.ensure();
				}, 1e3 * 2 ** (this.attempts - 1));
			}
			publish(next) {
				this.current = next;
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/login-page.ts
		/** 收到宿主授权地址后才打开页面；浏览器拦截不应中断登录，界面始终保留手动链接。 */
		function openLoginPage(authUrl) {
			if (typeof window === "undefined") return;
			try {
				window.open(authUrl, "_blank", "noopener,noreferrer");
			} catch {}
		}
		//#endregion
		//#region src/client/login.ts
		/** Keep one account's login status out of every other account's row. */
		function loginStateForTarget(state, targetRef) {
			if (state.targetRef === targetRef) return {
				visible: state,
				busyElsewhere: false
			};
			return {
				visible: {
					...state,
					phase: "idle",
					authUrl: void 0
				},
				busyElsewhere: state.phase === "starting" || state.phase === "waiting"
			};
		}
		/** How often a live attempt is polled. */
		const POLL_INTERVAL_MS = 1e3;
		/**
		* The login panel's fetch/poll lifecycle. One poll loop at a time; a fresh
		* `begin()` supersedes any previous loop via a generation token.
		*/
		var CommandCodeLoginController = class {
			openPage;
			remote;
			listeners = /* @__PURE__ */ new Set();
			pollMs;
			/** Monotonic token; only the latest loop may publish polling results. */
			generation = 0;
			disposed = false;
			phase = "idle";
			targetRef;
			authUrl;
			userName;
			keyName;
			reason;
			message;
			openedPage = false;
			constructor(remote, pollMs = POLL_INTERVAL_MS, openPage = openLoginPage) {
				this.openPage = openPage;
				this.remote = remote;
				this.pollMs = pollMs;
			}
			/** Subscribe to state projections. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			state() {
				return {
					phase: this.phase,
					...this.targetRef === void 0 ? {} : { targetRef: this.targetRef },
					authUrl: this.authUrl,
					userName: this.userName,
					keyName: this.keyName,
					reason: this.reason,
					message: this.message
				};
			}
			/** Start (or rejoin) a login attempt and begin polling its status. */
			async begin(targetRef) {
				if (this.disposed || this.phase === "starting" || this.phase === "waiting") return;
				const generation = ++this.generation;
				this.openedPage = false;
				this.targetRef = targetRef;
				this.set({
					phase: "starting",
					authUrl: void 0,
					userName: void 0,
					keyName: void 0,
					reason: void 0,
					message: void 0
				});
				const remote = this.remote();
				if (remote === void 0) {
					this.set({
						phase: "unavailable",
						authUrl: void 0,
						userName: void 0,
						keyName: void 0,
						reason: void 0,
						message: "login remote is not mounted"
					});
					return;
				}
				let result;
				try {
					result = await remote.loginBegin(targetRef);
				} catch (error) {
					result = {
						ok: false,
						error: { message: readableErrorText(error) }
					};
				}
				if (this.superseded(generation)) return;
				if (!result.ok) {
					this.set({
						phase: "unavailable",
						authUrl: void 0,
						userName: void 0,
						keyName: void 0,
						reason: void 0,
						message: result.error.message
					});
					return;
				}
				this.apply(result.value);
				if (this.currentPhase === "waiting") this.poll(generation);
			}
			/** Cancel a waiting attempt. */
			async cancel() {
				if (this.disposed || this.phase !== "starting" && this.phase !== "waiting") return;
				const generation = ++this.generation;
				const remote = this.remote();
				if (remote === void 0) return;
				let result;
				try {
					result = await remote.loginCancel();
				} catch {
					this.set({
						phase: "failed",
						authUrl: void 0,
						userName: void 0,
						keyName: void 0,
						reason: "cancelled",
						message: void 0
					});
					return;
				}
				if (this.superseded(generation)) return;
				if (result.ok) this.apply(result.value);
				else this.set({
					phase: "failed",
					authUrl: void 0,
					userName: void 0,
					keyName: void 0,
					reason: "cancelled",
					message: void 0
				});
			}
			/** Stop polling and release listeners. Idempotent. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.generation += 1;
				this.listeners.clear();
			}
			/** Poll until the attempt leaves `waiting` or a newer loop supersedes us. */
			async poll(generation) {
				while (!this.disposed && !this.superseded(generation) && this.currentPhase === "waiting") {
					await sleep(this.pollMs);
					if (this.disposed || this.superseded(generation) || this.currentPhase !== "waiting") return;
					const remote = this.remote();
					if (remote === void 0) {
						this.set({
							phase: "unavailable",
							authUrl: void 0,
							userName: void 0,
							keyName: void 0,
							reason: void 0,
							message: "login remote is not mounted"
						});
						return;
					}
					let result;
					try {
						result = await remote.loginStatus();
					} catch {
						continue;
					}
					if (this.superseded(generation) || this.currentPhase !== "waiting") return;
					if (result.ok) this.apply(result.value);
				}
			}
			get currentPhase() {
				return this.phase;
			}
			/** Project one Host status onto the panel face. */
			apply(status) {
				const base = {
					authUrl: void 0,
					userName: void 0,
					keyName: void 0,
					reason: void 0,
					message: void 0
				};
				if (status.state === "waiting") {
					if (status.authUrl && !this.openedPage) {
						this.openedPage = true;
						this.openPage(status.authUrl);
					}
					this.set({
						...base,
						phase: "waiting",
						authUrl: status.authUrl
					});
					return;
				}
				if (status.state === "success") {
					this.set({
						...base,
						phase: "success",
						userName: status.userName,
						keyName: status.keyName
					});
					return;
				}
				if (status.state === "failed") {
					this.set({
						...base,
						phase: "failed",
						reason: status.reason,
						message: status.message
					});
					return;
				}
				this.set({
					...base,
					phase: "failed",
					reason: "cancelled",
					message: "the login attempt is no longer active"
				});
			}
			/** Replace the whole state face and notify. Explicit over partial patches. */
			set(state) {
				this.phase = state.phase;
				this.authUrl = state.authUrl;
				this.userName = state.userName;
				this.keyName = state.keyName;
				this.reason = state.reason;
				this.message = state.message;
				this.publish();
			}
			superseded(generation) {
				return this.disposed || generation !== this.generation;
			}
			publish() {
				if (this.disposed) return;
				for (const listener of [...this.listeners]) listener();
			}
		};
		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}
		/**
		* The per-reason copy for a failed attempt. Shared by the settings page's login
		* panel and the Models-page card's login row — the same reason can surface from
		* either.
		*/
		function loginFailureCopy(reason, t) {
			if (reason === "denied") return t("loginDenied");
			if (reason === "timeout") return t("loginTimeout");
			if (reason === "invalid-key") return t("loginInvalidKey");
			if (reason === "network") return t("loginNetwork");
			if (reason === "unavailable") return t("loginStoreFailed");
			if (reason === "cancelled") return t("loginCancelled");
			return t("loginFailedGeneric");
		}
		/**
		* The hint text + class for one login panel state, shared by the settings
		* page's login panel and the Models-page card's login row so both surfaces
		* can never drift apart. Pure: no timers, no state.
		*/
		function loginHint(state, t) {
			if (state.phase === "starting" || state.phase === "waiting") return {
				text: t(state.phase === "starting" ? "loginStarting" : "loginWaiting"),
				className: "cc-hint",
				title: void 0
			};
			if (state.phase === "success") {
				const keyName = state.keyName !== void 0 && state.keyName !== "" ? ` · ${state.keyName}` : "";
				return {
					text: `${t("loginSuccess")} ${state.userName ?? ""}${keyName}`.trim(),
					className: "cc-loginDone",
					title: void 0
				};
			}
			if (state.phase === "failed") return {
				text: loginFailureCopy(state.reason, t),
				className: "cc-loginError",
				title: state.message
			};
			if (state.phase === "unavailable") return {
				text: `${t("loginUnavailable")} ${state.message ?? ""}`.trim(),
				className: "cc-loginError",
				title: void 0
			};
			return {
				text: t("loginHintIdle"),
				className: "cc-hint",
				title: void 0
			};
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
		const { reject: reject$2, record: record$2, stringField: stringField$2, numberField: numberField$1, booleanField } = makeBoundaryValidator("commandcode/report result:");
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
			const source = record$2(value, field);
			return {
				used: numberField$1(source, "used", `${field}.used`),
				cap: numberField$1(source, "cap", `${field}.cap`),
				exceeded: booleanField(source, "exceeded", `${field}.exceeded`),
				resetAt: numberField$1(source, "resetAt", `${field}.resetAt`)
			};
		}
		/**
		* Parse one untrusted boundary value into a {@link CommandCodeUsageReport}.
		* Optional sections stay optional; every present field is shape-checked so a
		* malformed frame fails the boundary instead of rendering garbage.
		*/
		function parseUsageReport(value) {
			const source = record$2(value, "report");
			const failures = source.failures;
			if (!Array.isArray(failures) || failures.some((entry) => typeof entry !== "string")) reject$2("failures");
			const report = { failures };
			if (source.blocked !== void 0) {
				const blocked = source.blocked;
				if (blocked === "invalid-key" || blocked === "service-unavailable" || blocked === "invalid-response" || blocked === "network") report.blocked = blocked;
				else reject$2("blocked");
			}
			if (source.account !== void 0) {
				const account = record$2(source.account, "account");
				report.account = {
					id: stringField$2(account, "id", "account.id"),
					name: stringField$2(account, "name", "account.name"),
					userName: stringField$2(account, "userName", "account.userName")
				};
			}
			if (source.usage !== void 0) {
				const usage = record$2(source.usage, "usage");
				report.usage = {
					totalCount: numberField$1(usage, "totalCount", "usage.totalCount"),
					totalCost: numberField$1(usage, "totalCost", "usage.totalCost"),
					successRate: numberField$1(usage, "successRate", "usage.successRate"),
					completedCount: numberField$1(usage, "completedCount", "usage.completedCount"),
					failedCount: numberField$1(usage, "failedCount", "usage.failedCount"),
					totalTokensIn: numberField$1(usage, "totalTokensIn", "usage.totalTokensIn"),
					totalTokensOut: numberField$1(usage, "totalTokensOut", "usage.totalTokensOut"),
					totalCredits: numberField$1(usage, "totalCredits", "usage.totalCredits"),
					periodBasis: stringField$2(usage, "periodBasis", "usage.periodBasis")
				};
				if (usage.periodStart !== void 0) report.usage.periodStart = numberField$1(usage, "periodStart", "usage.periodStart");
			}
			if (source.credits !== void 0) {
				const credits = record$2(source.credits, "credits");
				const parsed = {
					monthlyCredits: numberField$1(credits, "monthlyCredits", "credits.monthlyCredits"),
					purchasedCredits: numberField$1(credits, "purchasedCredits", "credits.purchasedCredits"),
					freeCredits: numberField$1(credits, "freeCredits", "credits.freeCredits")
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
				const plan = record$2(source.plan, "plan");
				const monthly = plan.monthlyCredits;
				if (monthly !== null && (typeof monthly !== "number" || !Number.isFinite(monthly))) reject$2("plan.monthlyCredits");
				report.plan = {
					planId: stringField$2(plan, "planId", "plan.planId"),
					name: stringField$2(plan, "name", "plan.name"),
					status: stringField$2(plan, "status", "plan.status"),
					monthlyCredits: monthly,
					currentPeriodEnd: numberField$1(plan, "currentPeriodEnd", "plan.currentPeriodEnd")
				};
				if (plan.currentPeriodStart !== void 0) report.plan.currentPeriodStart = numberField$1(plan, "currentPeriodStart", "plan.currentPeriodStart");
			}
			return report;
		}
		/** Parse one untrusted boundary value into a {@link CommandCodeAccountUsage}. */
		function parseAccountUsage(value) {
			const source = record$2(value, "account");
			return {
				id: stringField$2(source, "id", "account.id"),
				label: stringField$2(source, "label", "account.label"),
				configured: booleanField(source, "configured", "account.configured"),
				active: booleanField(source, "active", "account.active"),
				mark: stringField$2(source, "mark", "account.mark"),
				cooldownUntil: numberField$1(source, "cooldownUntil", "account.cooldownUntil"),
				report: parseUsageReport(source.report)
			};
		}
		/** Parse the wire result into a {@link CommandCodeAccountsReport}. */
		function parseAccountsReport(value) {
			const accounts = record$2(value, "result").accounts;
			if (Array.isArray(accounts)) return { accounts: accounts.map(parseAccountUsage) };
			return reject$2("accounts");
		}
		/** The Client-face contribution mounted on `ctx.remote`. */
		const USAGE_REMOTE_CONTRIBUTION = {
			package: USAGE_REMOTE_PACKAGE,
			descriptors: [makeRemoteDescriptor(USAGE_REPORT_ENDPOINT, "report", `${USAGE_REMOTE_PACKAGE}#CommandCodeAccountsReport`, { parse: parseAccountsReport })]
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
		/** The Client-face contribution for the model-catalog endpoint. */
		const MODELS_REMOTE_CONTRIBUTION = {
			package: USAGE_REMOTE_PACKAGE,
			descriptors: [makeRemoteDescriptor(MODELS_ENDPOINT, "models", `${USAGE_REMOTE_PACKAGE}#CommandCodeCatalog`, { parse: parseCatalog })]
		};
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
		/** The Client-face contribution for the price-table endpoint. */
		const PRICES_REMOTE_CONTRIBUTION = {
			package: USAGE_REMOTE_PACKAGE,
			descriptors: [makeRemoteDescriptor(PRICES_ENDPOINT, "prices", `${USAGE_REMOTE_PACKAGE}#CommandCodePriceTable`, { parse: parsePriceTable })]
		};
		//#endregion
		//#region src/service-probe-wire.ts
		/** Canonical `<namespace>/<method>` endpoint of the probe Remote. */
		const PROBE_ENDPOINT = "commandcode/probe";
		const OUTCOMES = [
			"ok",
			"http-error",
			"timeout",
			"unreachable"
		];
		const { reject: reject$1, record: record$1, stringField: stringField$1, numberField } = makeBoundaryValidator("commandcode/probe result:");
		/** Strict result codec, shared verbatim by the Host registration and Client mount. */
		function parseProbeResult(value) {
			const source = record$1(value, "result");
			const outcome = stringField$1(source, "outcome", "outcome");
			if (!OUTCOMES.includes(outcome)) reject$1("outcome");
			return {
				outcome,
				status: numberField(source, "status", "status"),
				latencyMs: numberField(source, "latencyMs", "latencyMs"),
				checkedAt: numberField(source, "checkedAt", "checkedAt")
			};
		}
		/** The Client-face contribution mounted on `ctx.remote`. */
		const PROBE_REMOTE_CONTRIBUTION = {
			package: REMOTE_PACKAGE,
			descriptors: [makeRemoteDescriptor(PROBE_ENDPOINT, "probe", `${REMOTE_PACKAGE}#CommandCodeProbeResult`, { parse: parseProbeResult })]
		};
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
		/** The Client-face contribution fragment mounted on `ctx.remote`. */
		const LOGIN_REMOTE_CONTRIBUTION = {
			package: REMOTE_PACKAGE,
			descriptors: [
				loginDescriptor(LOGIN_BEGIN_ENDPOINT, "loginBegin"),
				loginDescriptor(LOGIN_STATUS_ENDPOINT, "loginStatus"),
				loginDescriptor(LOGIN_CANCEL_ENDPOINT, "loginCancel")
			]
		};
		//#endregion
		//#region src/enrollment-wire.ts
		const ENROLLMENT_MESSAGE_KEYS = [
			"enrollmentCreating",
			"enrollmentWaiting",
			"enrollmentWriting",
			"enrollmentNaming",
			"enrollmentNameFailed",
			"enrollmentFinished",
			"enrollmentCancelling",
			"enrollmentCancelled",
			"enrollmentCancelledCleaned",
			"enrollmentFailed",
			"enrollmentFailedCleaned",
			"enrollmentCleanupPending",
			"enrollmentCleanupFailed",
			"enrollmentRecordNaming",
			"enrollmentRecordCleanup",
			"enrollmentBeginFailed",
			"enrollmentCancelUnconfirmed",
			"enrollmentNameRequestFailed",
			"enrollmentCleanupRequestFailed",
			"enrollmentDisconnected",
			"enrollmentHostUnavailable",
			"enrollmentStatusUnavailable"
		];
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
			const messageKey = source.messageKey;
			if (!ENROLLMENT_MESSAGE_KEYS.includes(messageKey)) return guard.reject("messageKey");
			const state = {
				id: guard.stringField(source, "id", "id"),
				ref: guard.stringField(source, "ref", "ref"),
				phase,
				messageKey
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
		const ENROLLMENT_REMOTE_CONTRIBUTION = {
			package: REMOTE_PACKAGE,
			descriptors: [
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
			]
		};
		//#endregion
		//#region src/client/random-id.ts
		/**
		* 页面身份（issue #102）。`crypto.randomUUID` 是安全上下文专属：局域网里用
		* `http://<ip>:3080` 打开设置页时它是 `undefined`，而这里在控制器构造期就调用，
		* 异常会落到设置页插槽的错误边界上，整块内容变成空白。`crypto.getRandomValues`
		* 在非安全上下文同样可用，因此只在 `randomUUID` 不可用时按 RFC 4122 自行拼一个 v4。
		*/
		function randomId() {
			const source = globalThis.crypto;
			if (typeof source.randomUUID === "function") return source.randomUUID();
			const bytes = source.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
			bytes[6] = bytes[6] & 15 | 64;
			bytes[8] = bytes[8] & 63 | 128;
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		//#endregion
		//#region src/client/enrollment.ts
		const live = (state) => [
			"creating",
			"waiting",
			"writing",
			"cancelling"
		].includes(state.phase);
		var AccountEnrollmentController = class {
			remote;
			changed;
			pollMs;
			newId;
			openPage;
			store = createSnapshotStore({
				active: void 0,
				pending: [],
				error: void 0
			});
			id;
			timer;
			disposed = false;
			pageId;
			watch;
			ready;
			openedPage = false;
			constructor(remote, changed, pollMs = 750, newId = randomId, openPage = openLoginPage) {
				this.remote = remote;
				this.changed = changed;
				this.pollMs = pollMs;
				this.newId = newId;
				this.openPage = openPage;
				this.pageId = newId();
			}
			/** 支持 React 开发模式的挂载检查；每次挂载仍重新读取宿主事实。 */
			activate() {
				if (this.disposed) this.pageId = this.newId();
				this.disposed = false;
				this.refresh();
			}
			reset() {
				if (!this.id) this.store.set({
					...this.store.getSnapshot(),
					active: void 0,
					error: void 0
				});
			}
			async refresh() {
				try {
					const result = await this.remote().enrollmentPending({ pageId: this.pageId });
					if (result.ok && !this.disposed) this.store.set({
						...this.store.getSnapshot(),
						pending: result.value
					});
				} catch {}
			}
			async begin(input) {
				if (this.id || this.disposed) return;
				const id = this.newId();
				const pageId = this.pageId;
				this.id = id;
				this.openedPage = false;
				this.store.set({
					...this.store.getSnapshot(),
					error: void 0,
					active: {
						id,
						ref: "",
						phase: "creating",
						messageKey: "enrollmentCreating"
					}
				});
				try {
					await this.ensureWatch();
					if (this.disposed || this.id !== id || this.pageId !== pageId) return;
					const result = await this.remote().enrollmentBegin({
						...input,
						id,
						pageId
					});
					if (this.disposed || this.id !== id) {
						await this.remote().enrollmentCancel({
							id,
							pageId
						});
						return;
					}
					this.receive(id, result);
				} catch {
					if (this.id === id) this.cancel();
					this.failure("enrollmentBeginFailed");
				}
			}
			/** 页面可立即离开；宿主仍等待写入和补偿收尾。 */
			cancel() {
				const id = this.id;
				const pageId = this.pageId;
				this.id = void 0;
				this.stopTimer();
				if (!this.disposed) this.store.set({
					...this.store.getSnapshot(),
					active: void 0
				});
				if (id) Promise.resolve().then(() => this.remote().enrollmentCancel({
					id,
					pageId
				})).then(() => {
					this.changed();
					this.refresh();
				}, () => this.failure("enrollmentCancelUnconfirmed"));
			}
			async name(name) {
				const id = this.id;
				if (!id) return;
				try {
					this.receive(id, await this.remote().enrollmentName({
						id,
						pageId: this.pageId,
						...name ? { name } : {}
					}));
				} catch {
					this.failure("enrollmentNameRequestFailed");
				}
			}
			async recover(record, name) {
				try {
					const result = await this.remote().enrollmentRetry({
						id: record.id,
						pageId: this.pageId,
						...name ? { name } : {}
					});
					if (!result.ok) this.failure("enrollmentCleanupPending");
					else if (!this.disposed && this.store.getSnapshot().active?.id === record.id) this.store.set({
						...this.store.getSnapshot(),
						active: result.value,
						error: void 0
					});
					this.changed();
					await this.refresh();
				} catch {
					this.failure("enrollmentCleanupRequestFailed");
				}
			}
			dispose() {
				this.disposed = true;
				this.cancel();
				this.watch?.dispose();
				this.watch = void 0;
				this.ready = void 0;
			}
			ensureWatch() {
				if (this.ready) return this.ready;
				const handle = this.remote().enrollmentWatch({ pageId: this.pageId });
				const iterator = handle[Symbol.asyncIterator]();
				this.watch = handle;
				this.ready = iterator.next().then((first) => {
					if (first.done || first.value !== true || this.watch !== handle) throw new Error("页面观察流未建立");
					(async () => {
						try {
							while (!(await iterator.next()).done);
						} catch {} finally {
							if (this.watch === handle && !this.disposed) {
								this.watch = void 0;
								this.ready = void 0;
								this.cancel();
								this.failure("enrollmentDisconnected");
							}
						}
					})();
				}).catch((error) => {
					handle.dispose();
					if (this.watch === handle) {
						this.watch = void 0;
						this.ready = void 0;
					}
					throw error;
				});
				return this.ready;
			}
			receive(id, result) {
				if (this.disposed || this.id !== id) return;
				if (!result.ok) {
					this.failure("enrollmentHostUnavailable");
					return;
				}
				const active = result.value;
				if (active.phase === "waiting" && active.authUrl && !this.openedPage) {
					this.openedPage = true;
					this.openPage(active.authUrl);
				}
				this.store.set({
					...this.store.getSnapshot(),
					active,
					error: void 0
				});
				if (live(active)) {
					this.stopTimer();
					this.timer = setTimeout(() => {
						this.poll(id);
					}, this.pollMs);
				} else {
					this.changed();
					this.refresh();
					if (active.phase !== "naming") this.id = void 0;
				}
			}
			async poll(id) {
				if (this.disposed || this.id !== id) return;
				try {
					this.receive(id, await this.remote().enrollmentStatus({
						id,
						pageId: this.pageId
					}));
				} catch {
					this.failure("enrollmentStatusUnavailable");
					if (!this.disposed && this.id === id) this.timer = setTimeout(() => {
						this.poll(id);
					}, this.pollMs);
				}
			}
			/** 记下要显示的语义键；文案在渲染处按界面语言取，本控制器不接触成品文本。 */
			failure(key) {
				if (!this.disposed) this.store.set({
					...this.store.getSnapshot(),
					error: key
				});
			}
			stopTimer() {
				if (this.timer) clearTimeout(this.timer);
				this.timer = void 0;
			}
		};
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			openAnalytics: "查看模型用量、成本与性能分析",
			nav: "Command Code",
			title: "Command Code",
			intro: "账户操作立即生效；其余改动点底部「保存」。密钥仅存于本机凭据服务，不回显。",
			apiKey: "API 密钥",
			apiKeyHint: "在 commandcode.ai 控制台创建。留空保存不会覆盖已存储的密钥。",
			apiKeySet: "已配置",
			apiKeyUnset: "未配置",
			apiKeyLocked: "密钥由只读来源提供",
			apiBase: "API 地址",
			requestTimeoutMs: "请求超时",
			requestTimeoutMsHint: "等待首个字节的超时，默认 300 秒；Provider API 要等上游模型吐出第一个 token 才返回，上游慢时可调高。",
			streamIdleTimeoutMs: "流空闲超时",
			streamIdleTimeoutMsHint: "生成流停滞多久视为断连，默认 300 秒（长思考模型可能静默数分钟）。",
			transportMaxRetries: "网络失败重试次数",
			transportMaxRetriesHint: "连接失败时自动重试的次数，默认 5 次（约 15 秒）；填 0 不重试，限流与 5xx 的重试不受影响。",
			offloadSeenImagesForCache: "已看过的图片不再重复发送",
			offloadSeenImagesForCacheHint: "仅 CLI 传输。模型回复过的旧图片改用文字占位，减少新增图片时的缓存回退；重看需重新读取或附加。",
			advancedSettings: "高级设置",
			advancedSettingsHint: "API 地址和网络参数，一般无需修改。",
			groupOverriddenOne: "已自定义 1 项",
			groupOverriddenMany: "已自定义 {count} 项",
			groupInvalid: "有未填好的数字",
			saveLocate: "定位",
			accountsSummaryOne: "1 个账户",
			accountsSummaryMany: "{count} 个账户",
			accountsSummaryIssues: "{count} 个异常",
			visibleModelsSummary: "白名单 {count} 个",
			visibleModelsSummaryAll: "显示全部模型",
			zdrSummaryOn: "ZDR 开启",
			zdrSummaryOff: "ZDR 关闭",
			webSearchSummaryOn: "联网搜索开启",
			webSearchSummaryOff: "联网搜索关闭",
			filterModelsByPlan: "隐藏套餐外模型",
			filterModelsByPlanHint: "只显示套餐内模型；按需余额账户仍显示全部。",
			webSearch: "用 Command Code 承载联网搜索",
			webSearchHint: "用同一密钥承载 dsh 的 web_search；「网页搜索」里已指定其他后端时本开关不生效。",
			showSidebarQuota: "在侧边栏显示额度卡片",
			showSidebarQuotaHint: "在侧边栏底部显示套餐与额度卡片，点击打开完整仪表盘；关闭时不在后台刷新用量。",
			zdr: "零数据保留（ZDR）",
			zdrHint: "仅使用不留存、不训练的上游；可用模型可能更少且价格通常更高。",
			accountsTitle: "账户",
			accountsHint: "可以添加多个账户：当前账户达到用量限额或密钥失效时，请求会自动切换到下一个。",
			accountAdd: "添加账户",
			accountDefault: "默认账户",
			modelSearchPlaceholder: "搜索模型…",
			modelSearchEmpty: "没有匹配的模型。",
			modelStale: "已下架",
			modelAllowance: "${amount}/月",
			modelAllowanceTitle: "该模型每月可用的额度（美元）。套餐内所有模型共用同一个月度额度池，这不是额外赠送的额度。",
			visibleModelsTitle: "模型白名单",
			visibleModelsHint: "只列出勾选的模型，都不勾选＝显示全部。网页与终端共用。",
			visibleModelsPick: "选择要保留的模型…",
			visibleModelsCount: "已选 {count} 个模型",
			visibleModelsShowAll: "显示全部",
			visibleModelsStaleHint: "有 {count} 个已选模型在目录中找不到了（可能已下架），不影响其他模型；可清理或保留。",
			visibleModelsCleanStale: "清理失效（{count}）",
			contextWindow: "自定义上下文长度",
			contextWindowHint: "覆盖目录公布的上下文窗口，影响上下文计量与自动压缩；留空跟随目录，支持 32K、1M。",
			contextOverridesTitle: "按模型覆盖",
			contextOverridesHint: "为单个模型设置上下文长度，优先于上面的全局值；只能选白名单中的模型。",
			contextOverrideAdd: "添加模型",
			contextOverrideRemove: "移除该模型的上下文覆盖",
			contextOverrideModel: "模型",
			contextOverrideValue: "上下文长度",
			contextOverrideNoCatalog: "模型目录尚未加载，暂时无法添加按模型覆盖。",
			contextWindowTooSmall: "上下文长度不能小于 1",
			contextWindowTooLarge: "上下文长度不能大于 10,000,000",
			contextWindowInvalid: "请输入有效的整数 token 数",
			maxOutputTokens: "单轮输出上限",
			maxOutputTokensHint: "留空按模型推导；0＝不发送该字段（仅 CLI 与 OpenAI，Claude 的 Messages 端点必填）。上限 131072，支持 64K。",
			maxOutputTokensTooSmall: "输出上限不能小于 0（0 表示不发送该字段）",
			maxOutputTokensTooLarge: "输出上限不能大于 131072（网关上限）",
			maxOutputTokensInvalid: "请输入 0 或有效的整数 token 数",
			overridden: "已自定义",
			reset: "重置",
			unitSeconds: "秒",
			unitTokens: "tokens",
			unitRetries: "次",
			placeholderCatalog: "跟随目录",
			placeholderAuto: "自动",
			invalidNumber: "无效数字",
			numberTooSmall: "重试次数不能小于 0",
			numberTooLarge: "重试次数不能大于 50",
			durationTooSmall: "不能小于 0.001 秒（1 毫秒）",
			durationTooLarge: "不能大于 3600 秒",
			durationInvalid: "请输入秒数，最多保留三位小数",
			readOnly: "当前配置为只读。",
			save: "保存",
			saving: "保存中",
			saved: "设置已保存",
			saveFailed: "保存失败，请重试。",
			writeConflict: "待提交字段已被其他操作修改，配置未写入；请核对后再保存。",
			writeConfigUnconfirmed: "配置提交未获确认，未写入宿主；请核对后重试。",
			writeConfigUnconfirmedKey: "配置与密钥均未写入宿主；请核对后重试。",
			writeHostError: "宿主返回：{message}",
			writeConfigSaved: "配置已保存。",
			writeKeyNotIssued: "密钥操作尚未发出；请核对后重试。",
			writeKeyUnconfirmed: "密钥操作未获确认；请核对后手动重试。",
			writeKeyConfirmed: "原引用的密钥操作已获确认。",
			writeTargetBefore: "默认密钥引用已变化，本次密钥操作未发出；请核对当前目标。",
			writeTargetAfter: "原引用的密钥操作已发出，默认引用随后变化；请核对两个引用。",
			writeClosed: "客户端已销毁，未发出的操作已停止；已确认的修改保留。",
			writeCleanupPending: "账号修改已确认，清理记录尚未收束，请重试清理。",
			writeRefreshFailed: "密钥状态刷新失败；已获确认的写入仍有效。",
			writeRefreshRetry: "仅刷新密钥状态",
			writeStateUnknown: "密钥状态尚未确认",
			writeCredentialRefNote: "（原引用：{ref}）",
			unsavedChanges: "有未保存的更改",
			saveInvalid: "有字段填写不正确，修正后才能保存",
			discard: "放弃",
			cancel: "取消",
			show: "显示",
			hide: "隐藏",
			usageRefresh: "刷新",
			usageRefreshing: "刷新中…",
			usageLoading: "正在获取账户用量…",
			usageError: "用量获取失败",
			usageRequests: "请求",
			usageFailed: "失败",
			usageSuccessRate: "成功率",
			usageCost: "花费",
			usageCompleted: "成功",
			usageBillingPeriod: "官方账期用量",
			usageTokens: "Token",
			usageTokensIn: "入",
			usageTokensOut: "出",
			usagePurchased: "已购",
			usageFree: "赠送",
			usageFiveHour: "5 小时窗口",
			usageWeekly: "每周窗口",
			usageMonthlyLeft: "月额度剩余",
			usageMonthlyDepleted: "月额度已用完，已购与赠送余额将无法使用。",
			usageExceeded: "已超限",
			usageReset: "重置于",
			usagePartial: "部分端点数据不可用",
			usageKeyInvalid: "API 密钥无效或已过期",
			usageKeyInvalidHint: "服务端拒绝了全部请求（401）。请检查该账户配置的密钥，或到 commandcode.ai 控制台重新生成。",
			usageServiceUnavailable: "Command Code 服务暂时不可用",
			usageServiceUnavailableHint: "服务端返回了错误（5xx），稍后点击刷新重试。",
			usageNetworkError: "无法连接 Command Code 服务",
			usageNetworkHint: "所有请求都没有到达服务端。请检查网络连接或 API 地址设置。",
			usageInvalidResponse: "Command Code 响应无法读取",
			usageInvalidResponseHint: "已收到响应，但正文读取或解析失败。下方详情可区分读取超时、中断与格式异常；可先点击刷新重试。",
			usageUpdated: "更新于",
			usagePeriodEnd: "账期截止",
			usageActive: "当前使用",
			usageCooldown: "限额冷却中",
			usageInvalidKey: "密钥无效",
			usageUnconfigured: "该账户尚未配置 API 密钥。",
			updateAvailable: "可更新",
			updateHint: "已发布新版本，点击查看发布说明；更新插件后刷新本页，提示会自动消失。",
			loginTitle: "通过官方登录获取密钥",
			loginHintIdle: "也可通过网页授权自动获取并保存密钥。",
			loginButton: "登录 Command Code",
			loginStarting: "正在启动本地回调服务…",
			loginWaiting: "等待在浏览器中完成授权；若页面未自动打开，请点击授权链接。",
			loginOpenLink: "打开授权页面",
			loginCancel: "取消登录",
			loginSuccess: "已登录为",
			loginUnavailable: "此环境暂不支持登录流程，请手动粘贴密钥。",
			loginDenied: "授权被拒绝。可重试，或手动粘贴密钥。",
			loginTimeout: "等待超时：未在窗口期内收到授权回调，请重试。",
			loginInvalidKey: "获取到的密钥未通过校验（401），请重试或手动粘贴。",
			loginNetwork: "无法连接 Command Code 服务校验密钥，请检查网络后重试。",
			loginStoreFailed: "密钥无法写入本机凭据服务，请手动粘贴。",
			loginCancelled: "登录已取消。",
			loginFailedGeneric: "登录失败，请重试或手动粘贴密钥。",
			cardTitle: "Command Code",
			cardRouteActive: "已启用",
			cardLoadingHint: "正在读取 Command Code 配置…",
			cardRegistrationHint: "此卡片由 Command Code 插件提供，正在等待设置页装配，稍后即可显示完整内容。",
			accountsRotationHint: "当前账户达到限额或密钥失效时，请求会按列表顺序切换到下一个可用账户。",
			accountModeAuto: "使用方式：自动切换（按列表顺序）",
			accountModePinned: "使用方式：固定使用「{name}」，不可用时仍会自动切换",
			accountStatusPinned: "已固定",
			accountActions: "账户操作",
			accountActionPin: "固定使用此账户",
			accountActionUnpin: "恢复自动切换",
			accountActionLogin: "网页登录获取新密钥",
			accountActionKey: "粘贴新密钥",
			accountActionRename: "重命名",
			accountActionClearKey: "删除密钥",
			accountActionRemove: "移除账户",
			accountRemoveConfirm: "移除「{name}」？它保存的密钥和专用模型设置会一起删除。",
			accountClearKeyConfirm: "删除默认账户保存的密钥？之后会回退到环境变量或官方 CLI 的登录信息。",
			accountConfirmRemove: "移除",
			accountConfirmClear: "删除",
			accountApply: "确定",
			accountNoKeyHint: "还没有密钥：通过网页登录自动获取，或粘贴在 commandcode.ai 控制台创建的 API 密钥。",
			accountAddHint: "网页登录会打开 Command Code 授权页，授权完成后账户自动添加；也可以直接粘贴 API 密钥。",
			accountAddLogin: "网页登录",
			accountAddPaste: "粘贴密钥",
			accountAddConfirm: "添加",
			accountAddCancel: "取消开通",
			accountAddStart: "开始登录",
			accountAddMethod: "添加方式",
			accountAddLinkHint: "若登录页面未自动打开，请点击下方链接。",
			accountAddOpenLink: "打开浏览器登录",
			accountNamePlaceholder: "备注名（可选，网页登录时默认使用账户名）",
			accountNameN: "账户 {n}",
			accountNameSaveRetry: "重试保存名称",
			accountNameAcceptExisting: "接受已有名称",
			accountKeyPlaceholder: "粘贴 API 密钥",
			accountOpFailed: "账户操作未能完成，请重试。",
			accountCleanupPending: "账户已移除，但有密钥尚未清理。可重试，不影响其他账户。",
			accountCleanupRetry: "重试清理密钥",
			accountEnrollmentCleanupRetry: "重试清理",
			accountRefSeparator: "：",
			accountModels: "专用模型",
			accountModelsHint: "选中即专属：优先此账户处理，不可用时自动切换",
			accountModelOwner: "属于 {name}",
			modelPick: "选择模型…",
			modelCount: "已选 {count} 个模型",
			modelCatalogFailed: "模型目录获取失败，暂时无法选择模型；已保存的设置仍会生效。",
			modelsTitle: "模型与上下文",
			privacyTitle: "隐私与安全",
			integrationsTitle: "集成与显示",
			serviceStatusTitle: "服务状态",
			serviceStatusHint: "官方数据来自状态页的公开记录，仅在状态变化或每日汇总时发布；本机连通由宿主刚探测。",
			serviceStatusChecking: "正在检查…",
			serviceStatusUp: "服务正常",
			serviceStatusDegraded: "部分降级",
			serviceStatusDown: "服务中断",
			serviceStatusUnknown: "状态未知",
			serviceStatusOfficial: "官方",
			serviceStatusLocal: "本机",
			serviceStatusUptime: "可用率 {value}",
			serviceStatusBadgeLocalHttp: "本机连接异常",
			serviceStatusBadgeLocalTimeout: "本机连接超时",
			serviceStatusBadgeLocalUnreachable: "本机无法连接",
			serviceStatusUptimeWeek: "7 天 {value}",
			serviceStatusUptimeMonth: "30 天 {value}",
			serviceStatusResponseWeek: "平均响应 {value}",
			serviceStatusUpdatedJustNow: "刚刚更新",
			serviceStatusUpdatedMinutes: "{count} 分钟前更新",
			serviceStatusUpdatedHours: "{count} 小时前更新",
			serviceStatusUpdatedDays: "{count} 天前更新",
			serviceStatusUpdatedUnknown: "更新时间未知",
			serviceStatusLag: "官方数据仅在状态变化或每日汇总时发布，可能滞后数小时。",
			serviceStatusLocalChecking: "正在探测…",
			serviceStatusLocalOk: "连通正常 · {latency} ms",
			serviceStatusLocalHttp: "连接异常（HTTP {status}）",
			serviceStatusLocalTimeout: "连接超时",
			serviceStatusLocalUnreachable: "无法连接",
			serviceStatusLocalUnavailable: "未知（宿主未提供探测）",
			serviceStatusStale: "无法获取状态数据，以下为上次成功获取的结果。",
			serviceStatusUnavailable: "无法获取状态数据。",
			serviceStatusOpen: "打开状态页",
			enrollmentCreating: "正在创建账号",
			enrollmentWaiting: "等待浏览器登录",
			enrollmentWriting: "正在保存凭据",
			enrollmentNaming: "账号已登录，正在保存名称",
			enrollmentNameFailed: "账号已登录，名称保存失败，请重试或接受已有名称",
			enrollmentFinished: "账号开通完成",
			enrollmentCancelling: "正在等待写入结束并清理",
			enrollmentCancelled: "已取消",
			enrollmentCancelledCleaned: "已取消并清理",
			enrollmentFailed: "账号开通失败，未创建账号",
			enrollmentFailedCleaned: "开通失败，已清理临时账号",
			enrollmentCleanupPending: "收尾未完成，请重试",
			enrollmentCleanupFailed: "清理未完成，请重试",
			enrollmentRecordNaming: "已登录账号等待确认名称",
			enrollmentRecordCleanup: "账号开通收尾未完成，请重试",
			enrollmentBeginFailed: "账号开通请求失败，请检查连接后重试",
			enrollmentCancelUnconfirmed: "取消请求未确认，重新连接后请检查未完成记录",
			enrollmentNameRequestFailed: "名称保存失败，请重试或接受已有名称",
			enrollmentCleanupRequestFailed: "收尾请求失败，请检查连接后重试",
			enrollmentDisconnected: "开通连接已断开，宿主正在收尾；重连后请检查未完成记录",
			enrollmentHostUnavailable: "宿主无法完成账号开通，请检查连接与写入权限",
			enrollmentStatusUnavailable: "开通状态暂不可用，正在等待重新连接"
		};
		const en = {
			openAnalytics: "View model usage, cost and performance",
			nav: "Command Code",
			title: "Command Code",
			intro: "Account actions apply immediately; other changes need Save below. The key stays in the local credential service and is never echoed.",
			apiKey: "API key",
			apiKeyHint: "Create one in the commandcode.ai console. Saving with this field blank keeps the stored key.",
			apiKeySet: "Configured",
			apiKeyUnset: "Not configured",
			apiKeyLocked: "Key provided by a read-only source",
			apiBase: "API base URL",
			requestTimeoutMs: "Request timeout",
			requestTimeoutMsHint: "Wait for the first response byte; default 300 s. The Provider API route answers only after the upstream’s first token, so raise it for a slow upstream.",
			streamIdleTimeoutMs: "Stream idle timeout",
			streamIdleTimeoutMsHint: "How long a stalled stream counts as dead; default 300 s (long-thinking models can go quiet for minutes).",
			transportMaxRetries: "Transport retries",
			transportMaxRetriesHint: "Automatic retries after a failed connection; default 5 (~15 s in all). 0 disables them; rate limits and 5xx keep their own retries.",
			offloadSeenImagesForCache: "Stop replaying images already seen",
			offloadSeenImagesForCacheHint: "CLI transport only. Images the model already answered become text placeholders, so a new image no longer rolls back the cache; to see one again, reread or reattach it.",
			advancedSettings: "Advanced",
			advancedSettingsHint: "API base URL and network limits; usually leave as-is.",
			groupOverriddenOne: "1 customized",
			groupOverriddenMany: "{count} customized",
			groupInvalid: "Needs a fix",
			saveLocate: "Show",
			accountsSummaryOne: "1 account",
			accountsSummaryMany: "{count} accounts",
			accountsSummaryIssues: "{count} need attention",
			visibleModelsSummary: "{count} allowlisted",
			visibleModelsSummaryAll: "All models shown",
			zdrSummaryOn: "ZDR on",
			zdrSummaryOff: "ZDR off",
			webSearchSummaryOn: "Web search on",
			webSearchSummaryOff: "Web search off",
			filterModelsByPlan: "Hide out-of-plan models",
			filterModelsByPlanHint: "Show only models in your plan; on-demand credit accounts still see the full catalog.",
			webSearch: "Serve dsh web search with Command Code",
			webSearchHint: "Use the same key for dsh web search. No effect while the Web search settings pin another backend.",
			showSidebarQuota: "Show the quota card in the sidebar",
			showSidebarQuotaHint: "Show a plan and quota card at the bottom of the sidebar that opens the full dashboard; while off, nothing refreshes in the background.",
			zdr: "Zero data retention (ZDR)",
			zdrHint: "Use only upstreams that retain no data and do not train on requests; availability and pricing may differ.",
			accountsTitle: "Accounts",
			accountsHint: "Add more accounts and requests switch to the next one when the current account hits its usage limit or its key stops working.",
			accountAdd: "Add account",
			accountDefault: "Default account",
			modelSearchPlaceholder: "Search models…",
			modelSearchEmpty: "No matching models.",
			modelStale: "Retired",
			modelAllowance: "${amount}/mo",
			modelAllowanceTitle: "Monthly usage this model can draw, in USD. Every model shares one monthly pool — this is not extra credit on top of the plan.",
			visibleModelsTitle: "Model allowlist",
			visibleModelsHint: "Only checked models are listed; none checked shows all. Web and terminal share this.",
			visibleModelsPick: "Select models to keep…",
			visibleModelsCount: "{count} model(s) selected",
			visibleModelsShowAll: "Show all",
			visibleModelsStaleHint: "{count} selected model(s) are no longer in the catalog (possibly retired); other models are unaffected. Clean them up or keep them.",
			visibleModelsCleanStale: "Clean stale ({count})",
			contextWindow: "Custom context length",
			contextWindowHint: "Overrides the catalog’s context window; the context meter and auto-compaction follow it. Empty follows the catalog; 32K or 1M accepted.",
			contextOverridesTitle: "Per-model overrides",
			contextOverridesHint: "Set one model’s context length; it wins over the global value above. Only allowlisted models can be picked.",
			contextOverrideAdd: "Add model",
			contextOverrideRemove: "Remove this model’s context override",
			contextOverrideModel: "Model",
			contextOverrideValue: "Context length",
			contextOverrideNoCatalog: "The model catalog has not loaded yet; per-model overrides cannot be added right now.",
			contextWindowTooSmall: "Context length must be at least 1",
			contextWindowTooLarge: "Context length must not exceed 10,000,000",
			contextWindowInvalid: "Enter a valid whole-token count",
			maxOutputTokens: "Output limit per turn",
			maxOutputTokensHint: "Empty derives it from the model. 0 omits the field (CLI and OpenAI only; Claude’s Messages endpoint requires it). Capped at 131,072; 64K accepted.",
			maxOutputTokensTooSmall: "Output limit must be at least 0 (0 omits the field)",
			maxOutputTokensTooLarge: "Output limit must not exceed 131,072 (the gateway cap)",
			maxOutputTokensInvalid: "Enter 0 or a valid whole-token count",
			overridden: "Customized",
			reset: "Reset",
			unitSeconds: "s",
			unitTokens: "tokens",
			unitRetries: "times",
			placeholderCatalog: "Catalog",
			placeholderAuto: "Auto",
			invalidNumber: "Invalid number",
			numberTooSmall: "Retries must be at least 0",
			numberTooLarge: "Retries must not exceed 50",
			durationTooSmall: "Must be at least 0.001 seconds (1 ms)",
			durationTooLarge: "Must not exceed 3600 seconds",
			durationInvalid: "Enter seconds with at most three decimal places",
			readOnly: "Settings are read-only.",
			save: "Save",
			saving: "Saving",
			saved: "Settings saved",
			saveFailed: "Save failed, please retry.",
			writeConflict: "Pending fields were modified by another operation; the configuration was not written. Please review and save again.",
			writeConfigUnconfirmed: "The configuration submission was not confirmed and was not written. Please review and retry.",
			writeConfigUnconfirmedKey: "Neither the configuration nor the key was written. Please review and retry.",
			writeHostError: "Host returned: {message}",
			writeConfigSaved: "Configuration saved.",
			writeKeyNotIssued: "The key operation has not been issued; please review and retry.",
			writeKeyUnconfirmed: "The key operation was not confirmed; please review and retry manually.",
			writeKeyConfirmed: "The key operation on the original reference has been confirmed.",
			writeTargetBefore: "The default key reference has changed; this key operation was not issued. Please check the current target.",
			writeTargetAfter: "The key operation on the original reference was issued, then the default reference changed. Please check both references.",
			writeClosed: "The client has been destroyed; unissued operations were stopped. Confirmed changes are kept.",
			writeCleanupPending: "The account change was confirmed, but cleanup records are still pending. Please retry cleanup.",
			writeRefreshFailed: "Key status refresh failed; confirmed writes remain valid.",
			writeRefreshRetry: "Refresh key status only",
			writeStateUnknown: "Key status not yet confirmed",
			writeCredentialRefNote: "(original ref: {ref})",
			unsavedChanges: "You have unsaved changes",
			saveInvalid: "Fix the highlighted field before saving",
			discard: "Discard",
			cancel: "Cancel",
			show: "Show",
			hide: "Hide",
			usageRefresh: "Refresh",
			usageRefreshing: "Refreshing…",
			usageLoading: "Fetching account usage…",
			usageError: "Could not fetch usage",
			usageRequests: "Requests",
			usageFailed: "failed",
			usageSuccessRate: "Success rate",
			usageCost: "Spend",
			usageCompleted: "Completed",
			usageBillingPeriod: "Official billing-period usage",
			usageTokens: "Tokens",
			usageTokensIn: "in",
			usageTokensOut: "out",
			usagePurchased: "Purchased",
			usageFree: "Free",
			usageFiveHour: "5-hour window",
			usageWeekly: "Weekly window",
			usageMonthlyLeft: "Monthly left",
			usageMonthlyDepleted: "Monthly credit is used up; purchased and free credit can no longer be spent.",
			usageExceeded: "Exceeded",
			usageReset: "Resets",
			usagePartial: "Some endpoint data unavailable",
			usageKeyInvalid: "API key invalid or expired",
			usageKeyInvalidHint: "The server rejects every request (401). Check the key configured for this account, or generate a new one in the commandcode.ai console.",
			usageServiceUnavailable: "The Command Code service is temporarily unavailable",
			usageServiceUnavailableHint: "The server returned errors (5xx); try Refresh again later.",
			usageNetworkError: "Could not reach the Command Code service",
			usageNetworkHint: "No request reached the server. Check your network connection or the API base setting.",
			usageInvalidResponse: "Could not read the Command Code response",
			usageInvalidResponseHint: "Responses arrived, but reading or parsing their bodies failed. Details below distinguish timeouts, interrupted reads, and invalid formats. Try Refresh again.",
			usageUpdated: "Updated",
			usagePeriodEnd: "Period ends",
			usageActive: "Active",
			usageCooldown: "Cooling down",
			usageInvalidKey: "Invalid key",
			usageUnconfigured: "No API key configured for this account yet.",
			updateAvailable: "update available",
			updateHint: "A newer version has been published; click for release notes. The notice disappears once the plugin is updated.",
			loginTitle: "Sign in to fetch a key",
			loginHintIdle: "Alternatively, sign in to fetch and store a key automatically.",
			loginButton: "Sign in to Command Code",
			loginStarting: "Starting the local callback server…",
			loginWaiting: "Waiting for authorization in your browser. If the page did not open automatically, use the authorization link.",
			loginOpenLink: "Open the authorization page",
			loginCancel: "Cancel sign-in",
			loginSuccess: "Signed in as",
			loginUnavailable: "Sign-in is unavailable in this environment; paste the API key instead.",
			loginDenied: "Authorization was denied. Try again or paste the key manually.",
			loginTimeout: "Timed out waiting for the authorization callback; try again.",
			loginInvalidKey: "The delivered key failed validation (401). Try again or paste it manually.",
			loginNetwork: "Could not reach the Command Code service to validate the key; check your network and retry.",
			loginStoreFailed: "The key could not be stored in the local credential service; paste it manually.",
			loginCancelled: "Sign-in cancelled.",
			loginFailedGeneric: "Sign-in failed; try again or paste the key manually.",
			cardTitle: "Command Code",
			cardRouteActive: "Active",
			cardLoadingHint: "Loading the Command Code configuration…",
			cardRegistrationHint: "This card is contributed by the Command Code plugin and is waiting for the settings page to finish assembling.",
			accountsRotationHint: "When the current account hits its limit or its key stops working, requests switch to the next usable account in list order.",
			accountModeAuto: "Mode: switch automatically (list order)",
			accountModePinned: "Mode: pinned to \"{name}\", still switching when it is unavailable",
			accountStatusPinned: "Pinned",
			accountActions: "Account actions",
			accountActionPin: "Pin this account",
			accountActionUnpin: "Switch automatically",
			accountActionLogin: "Sign in for a new key",
			accountActionKey: "Paste a new key",
			accountActionRename: "Rename",
			accountActionClearKey: "Delete key",
			accountActionRemove: "Remove account",
			accountRemoveConfirm: "Remove \"{name}\"? Its stored key and dedicated models are deleted with it.",
			accountClearKeyConfirm: "Delete the default account's stored key? The provider then falls back to the environment or the official CLI sign-in.",
			accountConfirmRemove: "Remove",
			accountConfirmClear: "Delete",
			accountApply: "Apply",
			accountNoKeyHint: "No key yet: sign in through the browser, or paste an API key created in the commandcode.ai console.",
			accountAddHint: "Sign-in opens the Command Code authorization page and adds the account once you approve; you can also paste an API key.",
			accountAddLogin: "Sign in",
			accountAddPaste: "Paste key",
			accountAddConfirm: "Add",
			accountAddCancel: "Cancel setup",
			accountAddStart: "Start sign-in",
			accountAddMethod: "Method",
			accountAddLinkHint: "If the sign-in page did not open automatically, use the link below.",
			accountAddOpenLink: "Open the sign-in page",
			accountNamePlaceholder: "Name (optional; sign-in uses the account name)",
			accountNameN: "Account {n}",
			accountNameSaveRetry: "Retry saving the name",
			accountNameAcceptExisting: "Accept the existing name",
			accountKeyPlaceholder: "Paste an API key",
			accountOpFailed: "The account change did not complete. Try again.",
			accountCleanupPending: "The account was removed, but credential cleanup is still pending. Retry without affecting other accounts.",
			accountCleanupRetry: "Retry credential cleanup",
			accountEnrollmentCleanupRetry: "Retry cleanup",
			accountRefSeparator: ": ",
			accountModels: "Dedicated models",
			accountModelsHint: "Selected models are dedicated to this account and still switch when unavailable",
			accountModelOwner: "on {name}",
			modelPick: "Choose models…",
			modelCount: "{count} models selected",
			modelCatalogFailed: "The model catalog could not be loaded; saved settings still apply.",
			modelsTitle: "Models & context",
			privacyTitle: "Privacy & security",
			integrationsTitle: "Integrations & display",
			serviceStatusTitle: "Service status",
			serviceStatusHint: "Published data comes from the official status page and is only written on a status change or the daily summary; local connectivity is probed by the host just now.",
			serviceStatusChecking: "Checking…",
			serviceStatusUp: "Operational",
			serviceStatusDegraded: "Degraded performance",
			serviceStatusDown: "Service outage",
			serviceStatusUnknown: "Status unknown",
			serviceStatusOfficial: "Official",
			serviceStatusLocal: "This device",
			serviceStatusUptime: "uptime {value}",
			serviceStatusBadgeLocalHttp: "Connection error here",
			serviceStatusBadgeLocalTimeout: "Timing out here",
			serviceStatusBadgeLocalUnreachable: "Unreachable here",
			serviceStatusUptimeWeek: "7d {value}",
			serviceStatusUptimeMonth: "30d {value}",
			serviceStatusResponseWeek: "avg {value}",
			serviceStatusUpdatedJustNow: "updated just now",
			serviceStatusUpdatedMinutes: "updated {count} min ago",
			serviceStatusUpdatedHours: "updated {count} h ago",
			serviceStatusUpdatedDays: "updated {count} d ago",
			serviceStatusUpdatedUnknown: "update time unknown",
			serviceStatusLag: "Official data is only published on a status change or the daily summary, so it may lag by hours.",
			serviceStatusLocalChecking: "Probing…",
			serviceStatusLocalOk: "Reachable · {latency} ms",
			serviceStatusLocalHttp: "Error (HTTP {status})",
			serviceStatusLocalTimeout: "Timed out",
			serviceStatusLocalUnreachable: "Unreachable",
			serviceStatusLocalUnavailable: "Unknown (host provides no probe)",
			serviceStatusStale: "Status data unavailable; showing the last known result.",
			serviceStatusUnavailable: "Status data unavailable.",
			serviceStatusOpen: "Open status page",
			enrollmentCreating: "Creating the account",
			enrollmentWaiting: "Waiting for the browser sign-in",
			enrollmentWriting: "Saving the credential",
			enrollmentNaming: "Signed in. Saving the name",
			enrollmentNameFailed: "Signed in, but saving the name failed. Retry, or accept the existing name.",
			enrollmentFinished: "Account setup complete",
			enrollmentCancelling: "Waiting for the write to finish, then cleaning up",
			enrollmentCancelled: "Cancelled",
			enrollmentCancelledCleaned: "Cancelled and cleaned up",
			enrollmentFailed: "Account setup failed. No account was created.",
			enrollmentFailedCleaned: "Setup failed; the temporary account was cleaned up.",
			enrollmentCleanupPending: "Cleanup is not finished. Please retry.",
			enrollmentCleanupFailed: "Cleanup failed. Please retry.",
			enrollmentRecordNaming: "Signed-in account waiting for its name to be confirmed",
			enrollmentRecordCleanup: "Account setup was not finished. Please retry.",
			enrollmentBeginFailed: "The account setup request failed. Check the connection and retry.",
			enrollmentCancelUnconfirmed: "The cancel request was not confirmed. After reconnecting, check for unfinished records.",
			enrollmentNameRequestFailed: "Saving the name failed. Retry, or accept the existing name.",
			enrollmentCleanupRequestFailed: "The cleanup request failed. Check the connection and retry.",
			enrollmentDisconnected: "The setup connection dropped; the host is finishing up. After reconnecting, check for unfinished records.",
			enrollmentHostUnavailable: "The host could not complete the account setup. Check the connection and write permissions.",
			enrollmentStatusUnavailable: "Setup status is unavailable; waiting to reconnect."
		};
		/** 同一确认结果在设置页和模型卡使用相同措辞，不从 configured 推断写入结果。 */
		function settingsWriteNotice(result, t) {
			if (!result) return "";
			let key;
			if (result.issue === "closed") key = "writeClosed";
			else if (result.issue === "target-changed") key = result.credential === "not-issued" ? "writeTargetBefore" : "writeTargetAfter";
			else if (result.issue === "cleanup-pending") key = "writeCleanupPending";
			else if (result.config === "conflict") key = "writeConflict";
			else if (result.config === "unconfirmed") key = result.credential === "not-issued" ? "writeConfigUnconfirmedKey" : "writeConfigUnconfirmed";
			else if (result.credential === "unconfirmed") key = "writeKeyUnconfirmed";
			else if (result.credential === "not-issued") key = "writeKeyNotIssued";
			const messages = key ? [t(key)] : [];
			if (result.issue === "target-changed" && result.credentialRef) {
				messages.push(t(result.credential === "confirmed" ? "writeKeyConfirmed" : "writeKeyUnconfirmed"));
				messages.push(t("writeCredentialRefNote").replace("{ref}", result.credentialRef));
			}
			if (key && result.config === "confirmed" && result.issue !== "cleanup-pending") messages.unshift(t("writeConfigSaved"));
			if (result.refreshFailed) messages.push(t("writeRefreshFailed"));
			const hostError = result.hostError;
			if (hostError !== void 0 && hostError.trim() !== "") messages.push(t("writeHostError").replace("{message}", () => hostErrorText(hostError)));
			return messages.join(" ");
		}
		/**
		* 宿主原文压成一行并限长：锁超时、写权限这类诊断足够；换行会撑高提示区，
		* 超长正文（整页 HTML、大对象）也不该被原样铺到设置页上。
		*/
		function hostErrorText(message) {
			const oneLine = message.replace(/\s+/g, " ").trim();
			return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
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
		Object.fromEntries(PLAN_TIER_ORDER.map((tier, index) => [tier, index]));
		//#endregion
		//#region src/client/model-select.ts
		/**
		* Model-select helpers for the settings page's model editors (browser half).
		*
		* The routing-rule editor and the visible-models filter both pick catalog models
		* through the same checkbox multi-select dropdown (`ModelMultiSelect` in
		* section.tsx). The dropdown's data shaping — search filtering, stale-id
		* detection, tier grouping — lives here, React-free, so node tests can drive
		* it directly.
		*
		* The shared tier module is dependency-free and inlined into the client bundle;
		* importing the Host's full capability snapshot here would bloat that bundle.
		*
		* @module dsh-commandcode-provider/model-select
		*/
		/**
		* The dropdown section heading for a catalog model id, or undefined for
		* models outside the known plan tiers (unmapped models and stale ids render
		* unheaded). `knownPlans` is the Host-side `KNOWN_PLANS` table, threaded in
		* by the caller so this module stays dependency-free.
		*/
		function tierHeadingFor(modelId, knownPlans) {
			const tier = knownPlans[modelId];
			if (tier === void 0) return void 0;
			return PLAN_LABELS[tier] ?? tier;
		}
		/**
		* Whether `text` matches `query` as a case-insensitive substring over the
		* model id AND display name. An empty/blank query matches everything.
		*/
		function matchesModelQuery(model, query) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return true;
			return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
		}
		/**
		* Build the dropdown options: the catalog (already in picker order) plus any
		* selected ids the catalog no longer carries, flagged stale so a saved
		* selection never silently loses an entry. Stale rows survive a non-blank
		* {@link matchesModelQuery} search only while they match too, so a search for
		* a live model does not surface unrelated stale ids.
		*/
		function buildModelSelectOptions(catalog, selected, query = "") {
			const catalogIds = new Set(catalog.map((model) => model.id));
			const options = catalog.filter((model) => matchesModelQuery(model, query)).map((model) => ({
				value: model.id,
				label: model.name,
				stale: false,
				...model.allowance === void 0 ? {} : { allowance: model.allowance }
			}));
			const seen = new Set(catalogIds);
			for (const id of selected) {
				if (id === "" || seen.has(id)) continue;
				seen.add(id);
				if (catalogIds.has(id)) continue;
				if (!matchesModelQuery({
					id,
					name: id
				}, query)) continue;
				options.push({
					value: id,
					label: id,
					stale: true
				});
			}
			return options;
		}
		/**
		* Group dropdown options under plan-tier headings (`tierOf` maps a model id to
		* its heading, or undefined for unmapped models — see {@link tierHeadingFor}).
		* Live rows keep their relative order and repeats merge, so a catalog
		* interleaving two tiers still renders one section per tier.
		*/
		function groupModelSelectOptions(options, tierOf) {
			const groups = [];
			const byHeading = /* @__PURE__ */ new Map();
			for (const option of options) {
				const heading = option.stale ? void 0 : tierOf(option.value);
				let group = byHeading.get(heading);
				if (group === void 0) {
					group = {
						heading,
						options: []
					};
					byHeading.set(heading, group);
					groups.push(group);
				}
				group.options.push(option);
			}
			return groups;
		}
		/**
		* Toggle one model id in a selection: remove it when present, append it
		* when absent (append keeps catalog order irrelevant — the picker re-sorts
		* by plan tier on render).
		*/
		function toggleModelSelection(selected, modelId) {
			return selected.includes(modelId) ? selected.filter((value) => value !== modelId) : [...selected, modelId];
		}
		/**
		* The catalog rows a picker may offer under the visible-models allowlist, in
		* catalog order: the whole catalog while "show all" is active (the empty
		* allowlist means exactly that), otherwise only the allowlisted ids. The
		* per-model context override editor uses this so its dropdown agrees with the
		* whitelist on the same card stack — a staged whitelist edit narrows it
		* immediately, since both read the projected page state.
		*/
		function allowlistedModels(catalog, allowlist, showAll) {
			if (showAll) return [...catalog];
			const keep = new Set(allowlist);
			return catalog.filter((model) => keep.has(model.id));
		}
		/**
		* Whether the catalog is trustworthy enough to call an unlisted selection
		* "retired". FALSE while the first fetch is in flight, after a failure, and
		* for a loaded-but-empty catalog — an empty list makes every selected id look
		* stale, which would turn the one-click stale cleanup into a button that
		* silently empties the allowlist. Users who really want it cleared have the
		* explicit "show all" entry.
		*/
		function catalogIsReady(readiness) {
			return readiness.catalogIds.length > 0 && !readiness.catalogFailed;
		}
		/**
		* Selected ids the loaded catalog no longer carries, in selection order.
		* Callers gate user-visible "stale" affordances on {@link catalogIsReady} —
		* the list itself is informational.
		*/
		function staleModelIds(selected, readiness) {
			const catalogIds = new Set(readiness.catalogIds);
			return selected.filter((id) => !catalogIds.has(id));
		}
		//#endregion
		//#region package.json
		var version = "0.16.3";
		var repository = {
			"type": "git",
			"url": "git+https://github.com/Mars-Sea/dsh-commandcode-provider.git"
		};
		//#endregion
		//#region src/client/version.ts
		/**
		* The plugin's own version, read from package.json at build time. The client
		* bundle inlines the JSON import (rolldown resolves it during the tsdown
		* build; node tests read it through tsx), so the rendered value always matches
		* the published package version with no second constant to keep in sync —
		* rendered as a muted footer line so a user can report the exact build.
		*
		* @module dsh-commandcode-provider/client/version
		*/
		/** The published package version. */
		const PLUGIN_VERSION = version;
		/**
		* This package's GitHub releases page, derived from the repository field so
		* the update hint's link target can never drift from the published home.
		* Tolerates both repository shapes (`{ url }` and the plain string form).
		*/
		const PLUGIN_RELEASES_URL = (() => {
			const repo = repository;
			const url = typeof repo === "string" ? repo : repo?.url;
			return `${typeof url === "string" ? url.replace(/^git\+/, "").replace(/\.git$/, "") : "https://github.com/Mars-Sea/dsh-commandcode-provider"}/releases`;
		})();
		/** Abort a hung registry request rather than keep the footer waiting. */
		const FETCH_TIMEOUT_MS = 5e3;
		/**
		* The npm registry document for this package's `latest` dist-tag. The scoped
		* name is path-escaped (`%2F`) so no client normalizes the slash away.
		*/
		const NPM_LATEST_URL = "https://registry.npmjs.org/@mars-sea%2Fdsh-commandcode-provider/latest";
		/**
		* Compare two version strings (`major.minor.patch[-pre]`): negative when `a`
		* sorts before `b`, positive when after, zero when equal.
		*
		* Tolerant by design — a leading `v` is stripped, unparsable numeric parts
		* count as `0`, and semver prerelease rules apply. Enough for release tags,
		* not a full semver validator.
		*/
		function compareVersions(a, b) {
			const left = splitVersion(a);
			const right = splitVersion(b);
			const depth = Math.max(left.core.length, right.core.length);
			for (let index = 0; index < depth; index += 1) {
				const delta = (left.core[index] ?? 0) - (right.core[index] ?? 0);
				if (delta !== 0) return Math.sign(delta);
			}
			if (left.pre.length === 0 && right.pre.length === 0) return 0;
			if (left.pre.length === 0) return 1;
			if (right.pre.length === 0) return -1;
			const width = Math.max(left.pre.length, right.pre.length);
			for (let index = 0; index < width; index += 1) {
				const l = left.pre[index];
				const r = right.pre[index];
				if (l === void 0) return -1;
				if (r === void 0) return 1;
				const lNumeric = /^\d+$/.test(l);
				const rNumeric = /^\d+$/.test(r);
				let delta;
				if (lNumeric && rNumeric) delta = Number(l) - Number(r);
				else if (lNumeric) delta = -1;
				else if (rNumeric) delta = 1;
				else delta = l < r ? -1 : l > r ? 1 : 0;
				if (delta !== 0) return Math.sign(delta);
			}
			return 0;
		}
		/** True when `candidate` is strictly newer than `current`. */
		function isNewerVersion(candidate, current) {
			return compareVersions(candidate, current) > 0;
		}
		/** Split a tolerant version string into numeric core + prerelease ids. */
		function splitVersion(value) {
			const cleaned = value.trim().replace(/^v/i, "");
			const dash = cleaned.indexOf("-");
			const coreText = dash < 0 ? cleaned : cleaned.slice(0, dash);
			const preText = dash < 0 ? void 0 : cleaned.slice(dash + 1);
			return {
				core: coreText === "" ? [0] : coreText.split(".").map((part) => {
					const parsed = Number.parseInt(part, 10);
					return Number.isFinite(parsed) ? parsed : 0;
				}),
				pre: preText === void 0 ? [] : preText.split(".")
			};
		}
		/**
		* Extract the published version from the registry's `/latest` manifest
		* (`{ name, version, … }`). Throws on anything unexpected so callers treat a
		* shape change as a failed attempt, never as bogus data.
		*/
		function parseLatestVersion(payload) {
			if (typeof payload !== "object" || payload === null) throw new Error("npm latest payload is not an object");
			const version = payload.version;
			if (typeof version !== "string" || !/^\d+\.\d+\./.test(version)) throw new Error("npm latest payload has no usable version");
			return version;
		}
		/** Fetch and parse the published `latest` version. Rejects on any failure. */
		async function fetchLatestVersion(fetchImpl = fetch) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			try {
				const response = await fetchImpl(NPM_LATEST_URL, { signal: controller.signal });
				if (!response.ok) throw new Error(`registry responded ${response.status}`);
				return parseLatestVersion(await response.json());
			} finally {
				clearTimeout(timer);
			}
		}
		/** The `localStorage` key holding {@link UpdateCheckRecord}. */
		const UPDATE_CHECK_CACHE_KEY = "@mars-sea/dsh-commandcode-provider/update-check";
		/**
		* A {@link UpdateCheckStore} backed by `localStorage`. Tolerates a missing or
		* throwing storage (SSR-ish contexts, private modes): reads yield `undefined`,
		* writes are dropped.
		*/
		function localStorageUpdateStore(storage = typeof localStorage === "undefined" ? void 0 : localStorage) {
			return {
				read() {
					if (storage === void 0) return void 0;
					try {
						const raw = storage.getItem(UPDATE_CHECK_CACHE_KEY);
						if (raw === null) return void 0;
						const parsed = JSON.parse(raw);
						if (typeof parsed !== "object" || parsed === null) return void 0;
						const at = parsed.at;
						if (typeof at !== "number" || !Number.isFinite(at)) return void 0;
						const version = parsed.version;
						return {
							at,
							version: typeof version === "string" && version !== "" ? version : void 0
						};
					} catch {
						return;
					}
				},
				write(record) {
					if (storage === void 0) return;
					try {
						storage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify(record));
					} catch {}
				}
			};
		}
		/**
		* Run one throttled update check. Resolves with the newest published version
		* when it is newer than `currentVersion`, otherwise `undefined`.
		*
		* Within the throttle window (or on failure) the cached version answers, so
		* the hint keeps working offline; past the window the registry is consulted
		* again and the attempt time is refreshed either way.
		*/
		async function checkForUpdate(options) {
			const { currentVersion, now, store } = options;
			const hintOf = (version) => version !== void 0 && isNewerVersion(version, currentVersion) ? version : void 0;
			const cache = store.read();
			if (cache !== void 0 && now - cache.at < 864e5) return hintOf(cache.version);
			let learned;
			try {
				learned = await fetchLatestVersion(options.fetchImpl);
			} catch {}
			const version = learned ?? cache?.version;
			store.write({
				at: now,
				version
			});
			return hintOf(version);
		}
		//#endregion
		//#region src/client/service-status.ts
		/** The public status page the row links to. */
		const STATUS_PAGE_URL = "https://status.commandcode.ai/";
		/** Upptime data files, freshest host first. */
		const STATUS_SOURCES = ["https://raw.githubusercontent.com/CommandCodeAI/commandcode-status/master/history", "https://cdn.jsdelivr.net/gh/CommandCodeAI/commandcode-status@master/history"];
		/** Files inside a source directory (the monitor's naming, not ours to change). */
		const SUMMARY_FILE = "summary.json";
		const STATE_FILE = "command-code.yml";
		/** The one site the Upptime config monitors. */
		const MONITORED_URL = "https://api.commandcode.ai";
		const MONITORED_SLUG = "command-code";
		/** The `localStorage` key holding the last successful snapshot. */
		const SERVICE_STATUS_CACHE_KEY = "@mars-sea/dsh-commandcode-provider/service-status";
		const LEVELS = [
			"up",
			"degraded",
			"down",
			"unknown"
		];
		function levelOf(value) {
			return typeof value === "string" && LEVELS.includes(value) ? value : void 0;
		}
		function stringOrUndefined(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		function finiteNumber(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : void 0;
		}
		/**
		* Read the monitored site's verdict out of `summary.json`.
		*
		* The file is an array because an Upptime config may monitor several sites; we
		* match our API host, then the known slug, then the first record so a rename on
		* their side degrades to "show what the page shows" rather than to nothing.
		* Rejects only when the payload cannot answer at all — a rejection makes the
		* caller try the next mirror.
		*/
		function parseSummary(payload) {
			if (!Array.isArray(payload)) throw new Error("status summary is not an array");
			const records = payload.filter((entry) => typeof entry === "object" && entry !== null);
			const record = records.find((entry) => entry["url"] === MONITORED_URL) ?? records.find((entry) => entry["slug"] === MONITORED_SLUG) ?? records[0];
			if (record === void 0) throw new Error("status summary has no site record");
			const level = levelOf(record["status"]);
			if (level === void 0) throw new Error("status summary has no usable status");
			return {
				level,
				uptimeWeek: stringOrUndefined(record["uptimeWeek"]),
				uptimeMonth: stringOrUndefined(record["uptimeMonth"]),
				responseTimeWeekMs: finiteNumber(record["timeWeek"])
			};
		}
		/**
		* Read the monitor's own state file (`key: value` YAML the robot writes).
		*
		* Only scalar lines are needed, so this stays a line parser: pulling a YAML
		* library into the client bundle for five fields would be the larger risk. A
		* malformed line is ignored; the caller treats missing fields as unknown rather
		* than failing the whole source, because the summary (not this file) is what
		* carries the verdict.
		*/
		function parseStateFile(text) {
			const fields = /* @__PURE__ */ new Map();
			for (const line of text.split("\n")) {
				const match = /^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$/.exec(line.trim());
				if (match !== null) fields.set(match[1], match[2].trim());
			}
			const checkedRaw = fields.get("lastUpdated");
			const checkedAt = checkedRaw === void 0 ? NaN : Date.parse(checkedRaw);
			const codeRaw = fields.get("code");
			const code = codeRaw === void 0 ? NaN : Number.parseInt(codeRaw, 10);
			const responseRaw = fields.get("responseTime");
			const responseTime = responseRaw === void 0 ? NaN : Number.parseFloat(responseRaw);
			return {
				level: levelOf(fields.get("status")),
				checkedAt: Number.isFinite(checkedAt) ? checkedAt : void 0,
				responseTimeMs: Number.isFinite(responseTime) ? responseTime : void 0,
				code: Number.isFinite(code) ? code : void 0
			};
		}
		/** Fetch one text resource with a hard timeout; rejects on any non-OK answer. */
		async function fetchText(url, fetchImpl, timeoutMs) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetchImpl(url, { signal: controller.signal });
				if (!response.ok) throw new Error(`status source responded ${response.status}`);
				return await response.text();
			} finally {
				clearTimeout(timer);
			}
		}
		/** Read one mirror: the summary is required, the state file is best-effort. */
		async function readSource(base, fetchImpl, timeoutMs) {
			const [summaryText, stateText] = await Promise.all([fetchText(`${base}/${SUMMARY_FILE}`, fetchImpl, timeoutMs), fetchText(`${base}/${STATE_FILE}`, fetchImpl, timeoutMs).catch(() => void 0)]);
			return {
				summary: parseSummary(JSON.parse(summaryText)),
				state: stateText === void 0 ? {} : parseStateFile(stateText)
			};
		}
		/**
		* A {@link ServiceStatusStore} backed by `localStorage`. Tolerates a missing or
		* throwing storage (private modes): reads yield `undefined`, writes are
		* dropped, and the status row still works for the lifetime of the page.
		*/
		function localStorageServiceStatusStore(storage = typeof localStorage === "undefined" ? void 0 : localStorage) {
			return {
				read() {
					if (storage === void 0) return void 0;
					try {
						const raw = storage.getItem(SERVICE_STATUS_CACHE_KEY);
						if (raw === null) return void 0;
						return snapshotFrom(JSON.parse(raw));
					} catch {
						return;
					}
				},
				write(snapshot) {
					if (storage === void 0) return;
					try {
						storage.setItem(SERVICE_STATUS_CACHE_KEY, JSON.stringify(snapshot));
					} catch {}
				}
			};
		}
		/** Validate a cached payload; storage may have been written by an older build. */
		function snapshotFrom(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const record = value;
			const level = levelOf(record["level"]);
			const fetchedAt = finiteNumber(record["fetchedAt"]);
			if (level === void 0 || fetchedAt === void 0) return void 0;
			return {
				level,
				checkedAt: finiteNumber(record["checkedAt"]),
				uptimeWeek: stringOrUndefined(record["uptimeWeek"]),
				uptimeMonth: stringOrUndefined(record["uptimeMonth"]),
				responseTimeWeekMs: finiteNumber(record["responseTimeWeekMs"]),
				live: record["live"] === true,
				stale: record["stale"] === true,
				fetchedAt
			};
		}
		/** The cached snapshot, for an instant first paint before the check lands. */
		function readCachedServiceStatus(store) {
			return store.read();
		}
		/**
		* Resolve the service status, preferring the cache while it is fresh and the
		* freshest mirror otherwise. Resolves with a snapshot in every case; the only
		* "failure" the caller sees is `live: false` (+ `stale` when a cache existed).
		*/
		async function checkServiceStatus(options) {
			const now = options.now ?? Date.now();
			const cached = options.store.read();
			if (cached !== void 0 && now - cached.fetchedAt < 3e5) return cached;
			const fetchImpl = options.fetchImpl ?? fetch;
			const sources = options.sources ?? STATUS_SOURCES;
			const timeoutMs = options.timeoutMs ?? 5e3;
			for (const source of sources) try {
				const { summary, state } = await readSource(source, fetchImpl, timeoutMs);
				const snapshot = {
					level: state.level ?? summary.level,
					checkedAt: state.checkedAt,
					uptimeWeek: summary.uptimeWeek,
					uptimeMonth: summary.uptimeMonth,
					responseTimeWeekMs: summary.responseTimeWeekMs ?? state.responseTimeMs,
					live: true,
					stale: false,
					fetchedAt: now
				};
				options.store.write(snapshot);
				return snapshot;
			} catch {}
			if (cached !== void 0) return {
				...cached,
				live: false,
				stale: true
			};
			return {
				level: "unknown",
				live: false,
				stale: false,
				fetchedAt: now
			};
		}
		/** The published record's age: `官方数据更新：刚刚` / N minutes / hours / days. */
		function updatedCopy(checkedAt, now, t) {
			const age = Math.max(0, now - checkedAt);
			if (age < 6e4) return t("serviceStatusUpdatedJustNow");
			const minutes = Math.floor(age / 6e4);
			if (minutes < 60) return t("serviceStatusUpdatedMinutes", { count: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return t("serviceStatusUpdatedHours", { count: hours });
			return t("serviceStatusUpdatedDays", { count: Math.floor(hours / 24) });
		}
		/** The publication-lag explanation, shown once the record is old enough. */
		function lagCopy(checkedAt, now, t) {
			if (checkedAt === void 0) return void 0;
			return now - checkedAt >= 72e5 ? t("serviceStatusLag") : void 0;
		}
		/** The local-connectivity line and its dot tone. */
		function localCopy(probe, t) {
			if (probe.kind === "checking") return {
				text: t("serviceStatusLocalChecking"),
				tone: "muted"
			};
			if (probe.kind === "unavailable") return {
				text: t("serviceStatusLocalUnavailable"),
				tone: "muted"
			};
			const { result } = probe;
			if (result.outcome === "ok") return {
				text: t("serviceStatusLocalOk", { latency: result.latencyMs }),
				tone: "ok"
			};
			if (result.outcome === "http-error") return {
				text: t("serviceStatusLocalHttp", { status: result.status }),
				tone: "error"
			};
			if (result.outcome === "timeout") return {
				text: t("serviceStatusLocalTimeout"),
				tone: "error"
			};
			return {
				text: t("serviceStatusLocalUnreachable"),
				tone: "error"
			};
		}
		/**
		* A published uptime without its padding zeros: the summary prints two
		* decimals verbatim (`100.00%`), which reads as noise, so `100.00%` becomes
		* `100%` and `99.90%` becomes `99.9%`; anything that is not a plain percentage
		* is shown as published.
		*/
		function compactUptime(value) {
			const match = /^(\d+)(?:\.(\d+))?%$/.exec(value.trim());
			if (match === null) return value;
			const fraction = (match[2] ?? "").replace(/0+$/, "");
			return fraction === "" ? `${match[1]}%` : `${match[1]}.${fraction}%`;
		}
		/** The aggregate segments; empty when this check carried no aggregates. */
		function detailCopy(snapshot, t) {
			const parts = [];
			const uptimes = [];
			if (snapshot.uptimeWeek !== void 0) uptimes.push(t("serviceStatusUptimeWeek", { value: compactUptime(snapshot.uptimeWeek) }));
			if (snapshot.uptimeMonth !== void 0) uptimes.push(t("serviceStatusUptimeMonth", { value: compactUptime(snapshot.uptimeMonth) }));
			if (uptimes.length > 0) parts.push(t("serviceStatusUptime", { value: uptimes.join(" / ") }));
			if (snapshot.responseTimeWeekMs !== void 0) parts.push(t("serviceStatusResponseWeek", { value: `${Math.round(snapshot.responseTimeWeekMs)} ms` }));
			return parts;
		}
		/** The heading verdict: a failed local probe first, else the published one. */
		function badgeOf(probe, official, t) {
			if (probe.kind !== "result" || probe.result.outcome === "ok") return official;
			const { outcome } = probe.result;
			return {
				label: outcome === "http-error" ? t("serviceStatusBadgeLocalHttp") : outcome === "timeout" ? t("serviceStatusBadgeLocalTimeout") : t("serviceStatusBadgeLocalUnreachable"),
				tone: "warn"
			};
		}
		/**
		* Project a snapshot + the live probe into the row's copy. Pure and React-free
		* so the labels, the age buckets, the lag rule and the failure wording are
		* pinned by node tests rather than by rendering.
		*
		* `snapshot === undefined` means the first published-data check is still in
		* flight (the hook paints the cache first, so this only shows on a cold cache).
		* The probe is independent: the row always renders both halves, and the local
		* half never borrows the published verdict.
		*/
		function serviceStatusView(snapshot, probe, t, now) {
			const local = localCopy(probe, t);
			const hint = t("serviceStatusHint");
			if (snapshot === void 0) {
				const label = t("serviceStatusChecking");
				return {
					level: "unknown",
					checking: true,
					label,
					officialTone: "checking",
					badge: badgeOf(probe, {
						label,
						tone: "checking"
					}, t),
					detailParts: [],
					local: local.text,
					localTone: local.tone,
					localChecking: probe.kind === "checking",
					hint,
					linkLabel: t("serviceStatusOpen")
				};
			}
			const label = snapshot.level === "up" ? t("serviceStatusUp") : snapshot.level === "degraded" ? t("serviceStatusDegraded") : snapshot.level === "down" ? t("serviceStatusDown") : t("serviceStatusUnknown");
			const notice = snapshot.live ? void 0 : snapshot.stale ? t("serviceStatusStale") : t("serviceStatusUnavailable");
			const officialTone = snapshot.level === "up" ? "ok" : snapshot.level === "degraded" ? "warn" : snapshot.level === "down" ? "error" : "idle";
			return {
				level: snapshot.level,
				checking: false,
				label,
				officialTone,
				badge: badgeOf(probe, {
					label,
					tone: officialTone
				}, t),
				detailParts: detailCopy(snapshot, t),
				updated: snapshot.checkedAt === void 0 ? t("serviceStatusUpdatedUnknown") : updatedCopy(snapshot.checkedAt, now, t),
				lag: lagCopy(snapshot.checkedAt, now, t),
				local: local.text,
				localTone: local.tone,
				localChecking: probe.kind === "checking",
				notice,
				hint,
				linkLabel: t("serviceStatusOpen")
			};
		}
		//#endregion
		//#region src/client/group-fold.ts
		const FOLD_GROUPS = [
			"accounts",
			"models",
			"privacy",
			"integrations",
			"advanced"
		];
		/** First visit: only Accounts open. */
		const DEFAULT_FOLD_STATE = {
			accounts: true,
			models: false,
			privacy: false,
			integrations: false,
			advanced: false
		};
		/** The `localStorage` key holding the serialized {@link FoldState}. */
		const FOLD_STATE_KEY = "@mars-sea/dsh-commandcode-provider/settings-fold";
		/**
		* Read a stored value back. Anything unusable — absent, not JSON, not an
		* object — yields the defaults; within an object, each group takes its stored
		* flag only when it is a real boolean, so a partial or older record keeps the
		* groups it knows and defaults the rest.
		*/
		function parseFoldState(raw) {
			if (raw === null || raw === void 0 || raw === "") return DEFAULT_FOLD_STATE;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return DEFAULT_FOLD_STATE;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_FOLD_STATE;
			const record = parsed;
			const next = { ...DEFAULT_FOLD_STATE };
			for (const group of FOLD_GROUPS) {
				const value = record[group];
				if (typeof value === "boolean") next[group] = value;
			}
			return next;
		}
		/** Open the given groups, leaving the rest as they are (the save bar's locate action). */
		function expandGroups(state, groups) {
			if (groups.every((group) => state[group])) return state;
			const next = { ...state };
			for (const group of groups) next[group] = true;
			return next;
		}
		/**
		* A {@link FoldStateStore} backed by `localStorage`. A missing or throwing
		* storage (private mode, blocked site data) reads as the defaults and drops
		* writes: the page must render the same either way.
		*/
		function localStorageFoldStore(storage = typeof localStorage === "undefined" ? void 0 : localStorage) {
			return {
				read() {
					if (storage === void 0) return DEFAULT_FOLD_STATE;
					try {
						return parseFoldState(storage.getItem(FOLD_STATE_KEY));
					} catch {
						return DEFAULT_FOLD_STATE;
					}
				},
				write(state) {
					if (storage === void 0) return;
					try {
						storage.setItem(FOLD_STATE_KEY, JSON.stringify(state));
					} catch {}
				}
			};
		}
		//#endregion
		//#region src/client/section.tsx
		/**
		* React component for the "Command Code" settings page (browser half).
		*
		* Renders as a `settings.section` entry — a page at the same settings-nav
		* level as General / Models / Plugins. All copy comes from the
		* `settings.commandcode` locale namespace; all state comes from the
		* `CommandCodeSettingsController` injected by the slot registration.
		*
		* Layout, top to bottom: Accounts (one card per account, status, quota,
		* actions and dedicated models — every operation commits immediately), Models
		* & context (plan filter + visible-model allowlist, then the context-length
		* rows: the global custom window and the per-model overrides, issue #86),
		* Privacy & security (ZDR), Integrations & display (service status, web search,
		* sidebar quota card), and Advanced (API base + network limits). Everything
		* below Accounts is a flat group of rows (title/description left, control
		* right) inside the staged form the floating save bar writes.
		*
		* All five groups fold from their own heading (`FoldableGroup`, 决策记录第十章
		* 第4条): Accounts opens by default, the rest start folded, and the choice is
		* remembered per browser (./group-fold.ts). A folded heading still summarizes its group, and anything
		* inside it that blocks the save is reported on the heading; the save bar's
		* Locate action opens that group and focuses the invalid field.
		*
		* Styles are injected once by the client entry (see src/client/index.ts) and
		* class-prefixed `cc-` to stay local.
		*/
		const ICON_PATHS = {
			swap: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.5 5h9l-2-2" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 11h-9l2 2" })] }),
			chevron: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 6l4 4 4-4" }),
			more: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "3.5",
					r: ".9",
					fill: "currentColor",
					stroke: "none"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: ".9",
					fill: "currentColor",
					stroke: "none"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "12.5",
					r: ".9",
					fill: "currentColor",
					stroke: "none"
				})
			] }),
			chart: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.5 13.5h11" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.5 13.5V8.5M8 13.5V4.5M11.5 13.5V6.5" })] }),
			arrowRight: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3 8h10M9 4l4 4-4 4" }),
			check: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "6"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 8.2 7.2 9.8 10.5 6.5" })] }),
			reset: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.5 2.5v3h3" })] }),
			close: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" }),
			refresh: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 2.5v3h-3" })] }),
			plus: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 3v10M3 8h10" }),
			external: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 2.5h4.5V7" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 2.5 7.5 8.5" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" })
			] }),
			info: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "6"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 7.25v3.5M8 5.25v.01" })] }),
			warn: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 2.5 14 13H2z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 6.5v3M8 11.25v.01" })] }),
			error: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "6"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 6l4 4M10 6l-4 4" })] }),
			lock: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "3",
				y: "7",
				width: "10",
				height: "7",
				rx: "1.5"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" })] })
		};
		function Icon({ name, className = "cc-icon" }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className,
				viewBox: "0 0 16 16",
				width: "16",
				height: "16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: ICON_PATHS[name]
			});
		}
		const PAGE_BUTTON_VARIANT = {
			primary: "cc-btnPrimary",
			outline: "cc-btnSecondary",
			ghost: "cc-btnGhost",
			danger: "cc-btnDanger"
		};
		const PAGE_BUTTON_SIZE = {
			sm: " cc-btnSm",
			md: "",
			lg: " cc-btnLg"
		};
		function PageButton({ variant = "ghost", size = "md", icon, className, type = "button", children, ...rest }) {
			const classes = `cc-btn ${PAGE_BUTTON_VARIANT[variant]}${PAGE_BUTTON_SIZE[size]}${className === void 0 ? "" : ` ${className}`}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				...rest,
				type,
				className: classes,
				children: [icon, children]
			});
		}
		const NOTICE_ICON = {
			neutral: "info",
			success: "check",
			warn: "warn",
			error: "error"
		};
		const NOTICE_CLASS = {
			neutral: "cc-notice",
			success: "cc-notice cc-noticeSuccess",
			warn: "cc-notice cc-noticeWarn",
			error: "cc-notice cc-noticeError"
		};
		/**
		* The one block every result, warning and failure on this page uses (read-only
		* config, a failed account operation, a cleanup still owed, …), so status no
		* longer arrives as loose red paragraphs in a different shape each time.
		* Actions sit under the text; the caller keeps the live-region role.
		*/
		function Notice({ tone = "neutral", icon, title, actions, role = "status", label, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: NOTICE_CLASS[tone],
				role,
				"aria-label": label,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: icon ?? NOTICE_ICON[tone],
					className: "cc-noticeIcon"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-noticeBody",
					children: [
						title !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-noticeTitle",
							children: title
						}) : null,
						children,
						actions !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "cc-noticeActions",
							children: actions
						}) : null
					]
				})]
			});
		}
		/**
		* The Host-side defaults an empty field falls back to, shown as placeholders so
		* an empty box reads "300 s" rather than looking broken. They are literals
		* because the client bundle must not pull in the adapter; `tests/section.test.ts`
		* pins each one to the constant it mirrors (DEFAULT_API_BASE,
		* DEFAULT_REQUEST_TIMEOUT_MS / DEFAULT_STREAM_IDLE_TIMEOUT_MS in seconds,
		* DEFAULT_TRANSPORT_MAX_RETRIES).
		*/
		const FIELD_DEFAULTS = {
			apiBase: "https://api.commandcode.ai",
			requestTimeoutSeconds: "300",
			streamIdleTimeoutSeconds: "300",
			transportMaxRetries: "5"
		};
		const ADVANCED_FIELDS = [
			"apiBase",
			"requestTimeoutMs",
			"streamIdleTimeoutMs",
			"transportMaxRetries",
			"offloadSeenImagesForCache"
		];
		const MODELS_FIELDS = [
			"filterModelsByPlan",
			"contextWindow",
			"maxOutputTokens"
		];
		/**
		* Whether anything the collapsed Advanced card owns is blocking the save. The
		* card is folded on arrival, so this drives the warning badge on its heading.
		*/
		function advancedGroupInvalid(state) {
			return ADVANCED_FIELDS.some((field) => state[field].invalid);
		}
		/**
		* Whether anything the collapsed Models & context group owns is blocking the
		* save (issue #94). Besides its staged drafts — the plan switch and the two
		* numbers — that group owns the per-model context rows, whose drafts are
		* validated one by one: a bad row must surface on the heading just like a bad
		* number, or Save would sit disabled with nothing on screen explaining why.
		*/
		function modelsGroupInvalid(state) {
			return MODELS_FIELDS.some((field) => state[field].invalid) || state.contextWindowOverrides.some((row) => row.invalid);
		}
		/**
		* The groups holding a draft that blocks the save, in page order — what the
		* save bar's locate action opens before focusing the first invalid field.
		* Privacy and Integrations hold switches only and Accounts is not staged, so
		* only these two can ever appear.
		*/
		function invalidGroups(state) {
			const groups = [];
			if (modelsGroupInvalid(state)) groups.push("models");
			if (advancedGroupInvalid(state)) groups.push("advanced");
			return groups;
		}
		/**
		* "N customized" on the Models & context heading: its staged fields that
		* differ from the default, plus one per per-model context override (each row
		* is a customization the user made).
		*/
		function modelsOverriddenCount(state) {
			return MODELS_FIELDS.filter((field) => state[field].overridden).length + state.contextWindowOverrides.length;
		}
		/** "N customized" on the Advanced heading. */
		function advancedOverriddenCount(state) {
			return ADVANCED_FIELDS.filter((field) => state[field].overridden).length;
		}
		/**
		* The effective value of a staged switch: an unset draft (`''`) means the
		* field's default. Used by the summary badges, which must say what the switch
		* on screen says.
		*/
		function stagedSwitch(field, defaultValue) {
			return field.text === "" ? defaultValue : field.text === "true";
		}
		/**
		* Accounts that need attention, for the Accounts heading. Uses the same
		* verdicts as each row's status dot (`statusDotClass`): a rejected key is a
		* hard failure, a cooldown or any other mark a warning.
		*/
		function accountIssues(entries) {
			let count = 0;
			let severe = false;
			for (const entry of entries) {
				if (entry === void 0) continue;
				if (entry.mark === "invalid-credential") {
					count += 1;
					severe = true;
				} else if (entry.mark !== "" || entry.cooldownUntil > 0) count += 1;
			}
			return {
				count,
				severe
			};
		}
		/**
		* One settings row, laid out like the harness's own General page: the title
		* and description on the left, the control on the right, a hairline between
		* rows.
		*/
		function SettingRow({ title, titleFor, titleId, tag, description, error, control, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: className === void 0 ? "cc-row" : `cc-row ${className}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-rowText",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cc-rowTitleLine",
							children: [titleFor !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "cc-rowTitle",
								id: titleId,
								htmlFor: titleFor,
								children: title
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-rowTitle",
								id: titleId,
								children: title
							}), tag]
						}),
						error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-rowError",
							children: error
						}) : null,
						error === void 0 && description !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "cc-rowDesc",
							children: description
						}) : null
					]
				}), control !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "cc-rowControl",
					children: control
				}) : null]
			});
		}
		/**
		* The title-line marker of a field that differs from its default: the
		* "customized" badge with a small reset button right after it (a draft that
		* only clears the stored value shows the button alone). Keeping reset on the
		* title line, not after the control, means no row reserves an empty reset
		* column — every control, account card and heading action ends on the same
		* right edge.
		*/
		function OverrideTag({ label, state, disabled, t, onReset }) {
			if (!state.overridden && !state.clear) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cc-overrideTag",
				children: [state.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cc-badge",
					children: t("overridden")
				}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "cc-resetInline",
					disabled,
					onClick: onReset,
					"aria-label": `${label} — ${t("reset")}`,
					title: t("reset"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "reset",
						className: "cc-icon cc-btnIcon"
					})
				})]
			});
		}
		/** One text/number field row. */
		function Field({ id, label, hint, state, disabled, numeric, decimal, context, output, wide, unit, placeholder, onEdit, onReset, t }) {
			const input = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				id,
				className: unit === void 0 ? `cc-fieldInput ${wide ? "cc-rowInputWide" : "cc-rowInput"}${state.invalid ? " cc-fieldInputInvalid" : ""}` : "cc-fieldInput",
				type: "text",
				inputMode: decimal ? "decimal" : numeric ? "numeric" : void 0,
				"aria-invalid": state.invalid || void 0,
				value: state.text,
				placeholder,
				disabled,
				onChange: (event) => onEdit(event.target.value)
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
				title: label,
				titleFor: id,
				tag: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverrideTag, {
					label,
					state,
					disabled,
					t,
					onReset
				}),
				description: hint,
				error: state.invalid ? invalidCopy(state.invalidReason, t, output === true ? "output" : context === true ? "context" : decimal === true ? "duration" : "number") : void 0,
				control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: unit === void 0 ? input : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: state.invalid ? "cc-unitBox cc-unitBoxInvalid" : "cc-unitBox",
					children: [input, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-unit",
						children: unit
					})]
				}) })
			});
		}
		/** The per-field error copy for a staged draft's failure reason. */
		function invalidCopy(reason, t, mode = "number") {
			if (mode === "duration") {
				if (reason === "tooSmall") return t("durationTooSmall");
				if (reason === "tooLarge") return t("durationTooLarge");
				return t("durationInvalid");
			}
			if (mode === "context") {
				if (reason === "tooSmall") return t("contextWindowTooSmall");
				if (reason === "tooLarge") return t("contextWindowTooLarge");
				return t("contextWindowInvalid");
			}
			if (mode === "output") {
				if (reason === "tooSmall") return t("maxOutputTokensTooSmall");
				if (reason === "tooLarge") return t("maxOutputTokensTooLarge");
				return t("maxOutputTokensInvalid");
			}
			if (reason === "tooSmall") return t("numberTooSmall");
			if (reason === "tooLarge") return t("numberTooLarge");
			return t("invalidNumber");
		}
		/**
		* One boolean field row rendered as a switch. The staged text is `'true'` /
		* `'false'` / `''` (unset → `defaultChecked`); toggling stages the string the
		* boolean field spec parses back into a real boolean on save.
		*
		* The control is the harness's own `Switch` primitive (issue #108), not a
		* restyled checkbox: a `<button role="switch" aria-checked>` whose drawing keys
		* off `aria-checked`, so what it shows cannot drift from what assistive tech
		* reads, and it matches the host's other settings switches. It takes no `id`,
		* so the row title is plain text and the switch carries the label as its
		* accessible name instead of through `<label htmlFor>`.
		*/
		function ToggleField({ id, label, hint, state, disabled, defaultChecked, onEdit, onReset, t }) {
			const checked = state.text === "" ? defaultChecked : state.text === "true";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
				title: label,
				titleId: id,
				tag: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverrideTag, {
					label,
					state,
					disabled,
					t,
					onReset
				}),
				description: hint,
				control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
					className: "cc-switch",
					checked,
					label,
					disabled,
					onChange: (next) => onEdit(next ? "true" : "false")
				})
			});
		}
		/** One stat tile in the account card's summary grid. */
		function UsageStat({ label, value, sub, title }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-usageStat",
				title,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-usageStatLabel",
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-usageStatValue",
						children: value
					}),
					sub !== void 0 && sub !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-usageStatSub",
						children: sub
					}) : null
				]
			});
		}
		/** One window-limit row: label, used/cap, a fill bar, and the reset time. */
		function UsageWindow({ label, limit, t }) {
			const { used, cap, exceeded, resetAt } = limit;
			const ratio = windowRatio(used, cap);
			const reset = formatResetAtShort(resetAt);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-usageWindow",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageWindowHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usageWindowLabel",
								children: label
							}),
							exceeded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usageExceeded",
								children: t("usageExceeded")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usageWindowValue",
								children: cap > 0 ? `${formatMoney(used)} / ${formatMoney(cap)}` : formatMoney(used)
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-usageBar",
						role: "progressbar",
						"aria-label": label,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuenow": Math.round(ratio * 100),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: exceeded ? "cc-usageBarFill cc-usageBarFillWarn" : "cc-usageBarFill",
							style: { transform: `translateX(${(ratio - 1) * 100}%)` }
						})
					}),
					reset !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cc-usageWindowReset",
						children: [
							t("usageReset"),
							" ",
							reset
						]
					}) : null
				]
			});
		}
		/**
		* Left text of the balance label row: the billing period, stated once per card.
		* 用量汇总与订阅起点对齐时给完整区间；对不上（或用量汇总没取到）时退回订阅
		* 自身的截止日，它不依赖对齐也可靠。余额没取到时没有「月额度剩余」可挂，完整
		* 区间前补回「官方账期用量」，避免一串裸日期没有上下文。
		*/
		function balanceLabelText(report, t) {
			const plan = report.plan;
			const usagePeriod = formatUsageBillingPeriod(report.usage?.periodStart, plan?.currentPeriodStart, plan?.currentPeriodEnd);
			const periodText = usagePeriod !== "" ? usagePeriod : plan !== void 0 && plan.currentPeriodEnd > 0 ? `${t("usagePeriodEnd")} ${new Date(plan.currentPeriodEnd).toLocaleDateString()}` : "";
			if (report.credits !== void 0) return periodText !== "" ? `${t("usageMonthlyLeft")} · ${periodText}` : t("usageMonthlyLeft");
			return usagePeriod !== "" ? `${t("usageBillingPeriod")} ${usagePeriod}` : periodText;
		}
		/** One pool account's facts (identity, totals, credits, window limits). */
		function AccountReport({ entry, fetchedAt, t, headless = false }) {
			const report = entry.report;
			const account = report.account;
			const accountName = account === void 0 ? "" : account.userName || account.name;
			const credits = report.credits;
			const plan = report.plan;
			const planName = plan?.name ?? "";
			const planStatus = plan !== void 0 && plan.status !== "" && plan.status !== "active" ? plan.status : "";
			const showPartial = report.failures.length > 0 && report.blocked === void 0;
			const label = balanceLabelText(report, t);
			const updatedText = fetchedAt === void 0 ? "" : `${t("usageUpdated")} ${new Date(fetchedAt).toLocaleTimeString(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			})}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-accountReport",
				children: [
					!headless ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								className: "cc-usageTitle",
								children: entry.label
							}),
							accountName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usageAccount",
								children: accountName
							}) : null,
							planName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badge cc-badgeOutline",
								children: planName
							}) : null
						]
					}) : null,
					planStatus !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usagePlanStatus",
						children: planStatus
					}) : null,
					!entry.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usageHint",
						children: t("usageUnconfigured")
					}) : null,
					report.blocked !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Notice, {
						tone: "error",
						role: "alert",
						title: blockedTitle(report.blocked, t),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: blockedHint(report.blocked, t) }), report.failures.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-noticeDetail",
							title: report.failures.join("; "),
							children: report.failures.join(" · ")
						}) : null]
					}) : null,
					(() => {
						const monthlyKnown = credits !== void 0 && credits.monthlyReported !== false;
						const depleted = credits !== void 0 && monthlyKnown && credits.monthlyCredits <= 0;
						if (label === "" && updatedText === "") return null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: depleted ? "cc-balance cc-balanceEmpty" : "cc-balance",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "cc-balanceRow",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-balanceLabel",
										children: label
									}), updatedText !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-balanceLabel",
										children: updatedText
									}) : null]
								}),
								credits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "cc-balanceRow",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-balanceValue",
										children: monthlyKnown ? formatMoney(Math.max(0, credits.monthlyCredits)) : "—"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-balanceSub",
										children: `${t("usagePurchased")} ${credits.purchasedReported === false ? "—" : formatMoney(credits.purchasedCredits)} · ${t("usageFree")} ${credits.freeReported === false ? "—" : formatMoney(credits.freeCredits)}`
									})]
								}) : null,
								depleted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cc-balanceNote",
									role: "status",
									children: t("usageMonthlyDepleted")
								}) : null
							]
						});
					})(),
					report.usage !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageStats cc-usageStatsActivity",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageRequests"),
								value: formatCompactCount(report.usage.totalCount),
								sub: `${t("usageFailed")} ${formatCompactCount(report.usage.failedCount)}`,
								title: compactCountTitle([
									[t("usageRequests"), report.usage.totalCount],
									[t("usageCompleted"), report.usage.completedCount],
									[t("usageFailed"), report.usage.failedCount]
								])
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageSuccessRate"),
								value: `${formatSuccessRate(report.usage.successRate)}%`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageCost"),
								value: formatMoneyExact(report.usage.totalCost),
								sub: `${formatMoney(report.usage.totalCredits)} credits`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageTokens"),
								value: formatTokensCompact(report.usage.totalTokensIn + report.usage.totalTokensOut),
								sub: `${formatTokensCompact(report.usage.totalTokensIn)} ${t("usageTokensIn")} / ${formatTokensCompact(report.usage.totalTokensOut)} ${t("usageTokensOut")}`
							})
						]
					}) : null,
					credits?.fiveHour !== void 0 || credits?.weekly !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageWindows",
						children: [credits.fiveHour !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageWindow, {
							label: t("usageFiveHour"),
							limit: credits.fiveHour,
							t
						}) : null, credits.weekly !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageWindow, {
							label: t("usageWeekly"),
							limit: credits.weekly,
							t
						}) : null]
					}) : null,
					showPartial ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usagePartial",
						title: report.failures.join("; "),
						children: t("usagePartial")
					}) : null
				]
			});
		}
		/** The headline copy for a report whose every endpoint failed the same way. */
		function blockedTitle(reason, t) {
			if (reason === "invalid-key") return t("usageKeyInvalid");
			if (reason === "service-unavailable") return t("usageServiceUnavailable");
			if (reason === "invalid-response") return t("usageInvalidResponse");
			return t("usageNetworkError");
		}
		/** The actionable hint under a blocked report's headline. */
		function blockedHint(reason, t) {
			if (reason === "invalid-key") return t("usageKeyInvalidHint");
			if (reason === "service-unavailable") return t("usageServiceUnavailableHint");
			if (reason === "invalid-response") return t("usageInvalidResponseHint");
			return t("usageNetworkHint");
		}
		/**
		* A checkbox multi-select dropdown for picking catalog models (the routing-rule
		* rows and the visible-models filter share it). The trigger shows the selection
		* count; the Menu lists every catalog model, grouping under plan-tier headings
		* and flagging selected ids the catalog no longer carries as stale, so a saved
		* selection never silently loses an entry (the VisibleModelsCard offers a
		* one-click cleanup).
		*
		* With `deferCommit` the toggles collect in a local draft that is handed to
		* `onSelect` once, when the menu closes: the per-account picker writes
		* immediately, and one write per click would be a burst of document writes.
		*/
		function ModelMultiSelect({ id, selected: committed, catalog, disabled, deferCommit = false, ownerOf, t, onSelect }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)(void 0);
			const selected = draft ?? committed;
			(0, react.useEffect)(() => {
				if (open) setQuery("");
			}, [open]);
			const close = () => {
				setOpen(false);
				if (draft !== void 0) {
					setDraft(void 0);
					if (draft.length !== committed.length || draft.some((modelId) => !committed.includes(modelId))) onSelect(draft);
				}
			};
			const tiers = (0, react.useMemo)(() => Object.fromEntries(catalog.flatMap((model) => model.tier === void 0 ? [] : [[model.id, model.tier]])), [catalog]);
			const options = buildModelSelectOptions(catalog, selected, query);
			const items = groupModelSelectOptions(options, (modelId) => tierHeadingFor(modelId, tiers)).flatMap((group) => [...group.heading === void 0 ? [] : [{
				type: "label",
				id: `cc-tier-${group.heading}`,
				text: group.heading
			}], ...group.options.map((option) => ({
				id: option.value,
				label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "cc-checkRow",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							className: "cc-check",
							checked: selected.includes(option.value),
							readOnly: true,
							tabIndex: -1
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-checkName",
							children: option.label
						}),
						option.stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badge",
							children: t("modelStale")
						}) : null,
						option.allowance !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badge cc-badgeOutline",
							title: t("modelAllowanceTitle"),
							children: t("modelAllowance", { amount: option.allowance })
						}) : null,
						!selected.includes(option.value) && ownerOf?.(option.value) !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badge cc-badgeOutline",
							children: t("accountModelOwner", { name: ownerOf(option.value) })
						}) : null
					]
				})
			}))]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: close,
				onSelect: (modelId) => {
					const next = toggleModelSelection(selected, modelId);
					if (deferCommit) setDraft(next);
					else onSelect(next);
				},
				selectedIds: selected,
				items,
				footer: options.length === 0 ? [{
					type: "label",
					id: "cc-model-search-empty",
					text: t("modelSearchEmpty")
				}] : [],
				portal: true,
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "cc-modelSelectAnchor",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						id,
						type: "button",
						className: "cc-selector",
						disabled: disabled || catalog.length === 0,
						onClick: () => open ? close() : setOpen(true),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-selectorText",
							children: selected.length === 0 ? t("modelPick") : t("modelCount", { count: selected.length })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "chevron",
							className: "cc-icon cc-selectorChevron"
						})]
					}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "search",
						className: "cc-input cc-modelSearch",
						placeholder: t("modelSearchPlaceholder"),
						"aria-label": t("modelSearchPlaceholder"),
						value: query,
						disabled,
						autoFocus: true,
						onChange: (event) => setQuery(event.target.value)
					}) : null]
				})
			});
		}
		/** The visible-model filter row: an allowlist over the catalog. Empty = show all. */
		function VisibleModelsRow({ t, state, disabled, onSelect, onClear }) {
			const count = state.visibleModels.length;
			const pickT = (key, params) => {
				if (key === "modelPick" || key === "modelCount") return state.visibleModelsAll ? t("visibleModelsShowAll") : t("visibleModelsCount", { count });
				return t(key, params);
			};
			const readiness = {
				catalogIds: state.catalogModels.map((model) => model.id),
				catalogFailed: state.catalogFailed
			};
			const staleIds = staleModelIds(state.visibleModels, readiness);
			const catalogReady = catalogIsReady(readiness);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
				title: t("visibleModelsTitle"),
				titleFor: "cc-visible-models",
				description: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("visibleModelsHint") }), staleIds.length > 0 && catalogReady ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("visibleModelsStaleHint", { count: staleIds.length }) }) : null] }),
				error: state.catalogFailed ? t("modelCatalogFailed") : void 0,
				control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					catalogReady && staleIds.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
						variant: "ghost",
						size: "sm",
						disabled,
						onClick: () => onSelect(state.visibleModels.filter((id) => !staleIds.includes(id))),
						children: t("visibleModelsCleanStale", { count: staleIds.length })
					}) : null,
					!state.visibleModelsAll ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
						variant: "ghost",
						size: "sm",
						disabled,
						onClick: onClear,
						children: t("visibleModelsShowAll")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelMultiSelect, {
						id: "cc-visible-models",
						selected: state.visibleModels,
						catalog: state.catalogModels,
						disabled,
						t: pickT,
						onSelect
					})
				] })
			});
		}
		/**
		* The glanceable header strip: account health, monthly remainder, service
		* status, model scope. Every string reuses one the groups already compute
		* (group summaries, balance labels, the service badge), so the strip adds no
		* locale keys and cannot disagree with the card below it. Cells are plain
		* text, not links — the groups beneath are the place to act.
		*/
		function StatusStrip({ t, state, usage, snapshot, probe }) {
			const rows = accountRows(state, usage, t);
			const issues = accountIssues(rows.map((row) => row.usage));
			const defaultRow = rows.find((row) => row.id === "default");
			const credits = defaultRow?.usage?.report?.credits;
			const monthly = credits !== void 0 && credits.monthlyReported !== false ? credits : void 0;
			const depleted = monthly !== void 0 && monthly.monthlyCredits <= 0;
			const planName = defaultRow?.usage?.report?.plan?.name ?? "";
			const overridden = modelsOverriddenCount(state);
			const view = serviceStatusView(snapshot, probe, t, Date.now());
			const serviceDot = view.badge.tone === "ok" ? "cc-tabDot cc-tabDotOk" : view.badge.tone === "warn" ? "cc-tabDot cc-tabDotWarn" : view.badge.tone === "error" ? "cc-tabDot cc-tabDotError" : "cc-tabDot cc-tabDotBlank";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-statusStrip",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-statusCell",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-statusHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: issues.severe ? "cc-tabDot cc-tabDotError" : issues.count > 0 ? "cc-tabDot cc-tabDotWarn" : "cc-tabDot cc-tabDotOk",
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusLabel",
									children: t("accountsTitle")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusStripValue",
								children: rows.length === 1 ? t("accountsSummaryOne") : t("accountsSummaryMany", { count: rows.length })
							}),
							issues.count > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: t("accountsSummaryIssues", { count: issues.count })
							}) : planName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: planName
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-statusCell",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-statusHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: depleted ? "cc-tabDot cc-tabDotError" : monthly !== void 0 ? "cc-tabDot cc-tabDotOk" : "cc-tabDot cc-tabDotBlank",
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusLabel",
									children: t("usageMonthlyLeft")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusStripValue",
								children: monthly !== void 0 ? formatMoney(Math.max(0, monthly.monthlyCredits)) : "—"
							}),
							credits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: `${t("usagePurchased")} ${credits.purchasedReported === false ? "—" : formatMoney(credits.purchasedCredits)} · ${t("usageFree")} ${credits.freeReported === false ? "—" : formatMoney(credits.freeCredits)}`
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-statusCell",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-statusHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: serviceDot,
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusLabel",
									children: t("serviceStatusTitle")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusStripValue",
								children: view.badge.label
							}),
							view.updated !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: view.updated
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: view.local
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-statusCell",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-statusHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-tabDot",
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusLabel",
									children: t("modelsTitle")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusStripValue",
								children: state.visibleModelsAll ? t("visibleModelsSummaryAll") : t("visibleModelsSummary", { count: state.visibleModels.length })
							}),
							overridden > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-statusSub",
								children: overriddenText(overridden, t)
							}) : null
						]
					})
				]
			});
		}
		/**
		* One top-level group of the page (决策记录第十章第4条). All five groups share
		* this one shape so they cannot drift apart: the heading is an `h3` wrapping a
		* single full-width button — chevron first, then the title and the summary
		* badges — and a group action such as Refresh sits OUTSIDE that button, so
		* using it never folds the group. Which groups are open is page state (see
		* ./group-fold.ts), passed in here.
		*
		* The body stays mounted and is hidden with the `hidden` attribute rather than
		* unrendered: `aria-controls` then always points at a real element, and the
		* save bar's locate action can focus an invalid field right after opening its
		* group. Folding is presentation only and instant toggling is deliberate (it
		* happens too often to be worth a wait); staged drafts, validation and the
		* save path are untouched (第六章第1、2条).
		*/
		function FoldableGroup({ id, title, expanded, onToggle, badges, action, children }) {
			const titleId = `cc-group-${id}-title`;
			const bodyId = `cc-group-${id}-body`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cc-group",
				"aria-labelledby": titleId,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-groupHead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "cc-groupHeading",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "cc-disclosure",
							"aria-expanded": expanded,
							"aria-controls": bodyId,
							onClick: onToggle,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "chevron",
									className: expanded ? "cc-icon cc-foldChevron" : "cc-icon cc-foldChevron cc-foldChevronClosed"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									id: titleId,
									className: "cc-groupTitle",
									children: title
								}),
								badges
							]
						})
					}), action]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					id: bodyId,
					className: "cc-groupBody",
					hidden: !expanded,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-rows",
						children
					})
				})]
			});
		}
		/**
		* A heading's neutral summary as quiet text ("3 allowlisted · 1 customized"),
		* like the harness's own section captions; only warnings and errors get a
		* tinted pill, so a pill always means "look here". Empty parts are skipped.
		*/
		function GroupSummary({ parts }) {
			const text = parts.filter((part) => part !== void 0 && part !== "").join(" · ");
			return text === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-groupSummary",
				children: text
			});
		}
		/** "N customized" for a heading summary; undefined at zero. */
		function overriddenText(count, t) {
			if (count === 0) return void 0;
			return count === 1 ? t("groupOverriddenOne") : t("groupOverriddenMany", { count });
		}
		/**
		* The badge a FOLDED group shows while something inside it blocks the save:
		* its rows are off screen, so without it Save would sit disabled with nothing
		* visible explaining why (issue #94). Expanded, the row errors speak for it.
		*/
		function InvalidBadge({ show, t }) {
			return show ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-badge cc-badgeError",
				children: t("groupInvalid")
			}) : null;
		}
		/**
		* Models & context: the plan filter and the allowlist sit together because both
		* decide what the model picker lists (the allowlist applies after the plan
		* filter), and the context-length fields follow them because they are the same
		* subject seen from the other side — the window each listed model advertises.
		* Those fields carry no heading or divider of their own: they are rows of this
		* group, not a section inside it. Folded by default like every group but
		* Accounts; the heading then summarizes the allowlist size and how much of the
		* group is customized.
		*/
		function ModelsCard({ state, disabled, t, onEdit, onReset, onSelect, onClear, onOverrides, expanded, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(FoldableGroup, {
				id: "models",
				title: t("modelsTitle"),
				expanded,
				onToggle,
				badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupSummary, { parts: [state.visibleModelsAll ? t("visibleModelsSummaryAll") : t("visibleModelsSummary", { count: state.visibleModels.length }), overriddenText(modelsOverriddenCount(state), t)] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InvalidBadge, {
					show: !expanded && modelsGroupInvalid(state),
					t
				})] }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
						id: "cc-filter-models-by-plan",
						label: t("filterModelsByPlan"),
						hint: t("filterModelsByPlanHint"),
						state: state.filterModelsByPlan,
						disabled,
						defaultChecked: true,
						onEdit: (text) => onEdit("filterModelsByPlan", text),
						onReset: () => onReset("filterModelsByPlan"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VisibleModelsRow, {
						t,
						state,
						disabled,
						onSelect,
						onClear
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextCard, {
						state,
						disabled,
						t,
						onEdit,
						onReset,
						onOverrides
					})
				]
			});
		}
		/**
		* Context length (issue #86): the global custom window plus one row per model
		* override, both staged into the same save as the other form fields. Rendered
		* as plain rows of the Models & context group — no heading, no divider of its
		* own: the setting belongs to the models that group already governs, and on the
		* real page a section inside the group read as visual noise. The advertised
		* window is what the harness meters context against and when it compacts, so a
		* lowered value compacts earlier and a raised one follows the model's real
		* capacity when the catalog under-reports it. Precedence: a per-model row, then
		* the global value, then the catalog.
		*
		* The rows live as raw text drafts: blank drops the override on save, an
		* unparseable one blocks the save with its own bounds copy, and the value
		* accepts the compact shorthand the picker prints (`256K`, `1M`). The model
		* select offers only allowlisted models the list does not already carry —
		* one override per model, matching what the Models card lets through — and
		* keeps a stored id the catalog no longer carries (or the whitelist just
		* dropped) as itself so an existing override never silently disappears.
		*/
		function ContextCard({ state, disabled, t, onEdit, onReset, onOverrides }) {
			const rows = state.contextWindowOverrides;
			const used = new Set(rows.map((row) => row.model));
			const available = allowlistedModels(state.catalogModels, state.visibleModels, state.visibleModelsAll).filter((model) => !used.has(model.id));
			const asMap = () => Object.fromEntries(rows.map((row) => [row.model, row.text]));
			const setText = (model, text) => onOverrides({
				...asMap(),
				[model]: text
			});
			const setModel = (from, to) => {
				if (to === "" || to === from || used.has(to)) return;
				const next = {};
				for (const row of rows) next[row.model === from ? to : row.model] = row.text;
				onOverrides(next);
			};
			const removeRow = (model) => {
				const next = asMap();
				delete next[model];
				onOverrides(next);
			};
			const addRow = () => {
				const model = available[0];
				if (model === void 0) return;
				onOverrides({
					...asMap(),
					[model.id]: ""
				});
			};
			const labelOf = (model) => {
				const entry = state.catalogModels.find((candidate) => candidate.id === model);
				return entry === void 0 ? `${model} · ${t("modelStale")}` : `${entry.name} (${model})`;
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					id: "cc-context-window",
					label: t("contextWindow"),
					hint: t("contextWindowHint"),
					state: state.contextWindow,
					disabled,
					context: true,
					unit: t("unitTokens"),
					placeholder: t("placeholderCatalog"),
					onEdit: (text) => onEdit("contextWindow", text),
					onReset: () => onReset("contextWindow"),
					t
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					id: "cc-max-output-tokens",
					label: t("maxOutputTokens"),
					hint: t("maxOutputTokensHint"),
					state: state.maxOutputTokens,
					disabled,
					numeric: true,
					output: true,
					unit: t("unitTokens"),
					placeholder: t("placeholderAuto"),
					onEdit: (text) => onEdit("maxOutputTokens", text),
					onReset: () => onReset("maxOutputTokens"),
					t
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: t("contextOverridesTitle"),
					description: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("contextOverridesHint") }),
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
						variant: "outline",
						size: "sm",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							name: "plus",
							className: "cc-icon cc-btnIcon"
						}),
						disabled: disabled || available.length === 0,
						onClick: addRow,
						children: t("contextOverrideAdd")
					}) })
				}),
				state.catalogFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cc-groupDesc",
					children: t("contextOverrideNoCatalog")
				}) : null,
				rows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-contextTable",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-contextHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("contextOverrideModel") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("contextOverrideValue") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { "aria-hidden": "true" })
						]
					}), rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-contextItem",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-contextSelect",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: "cc-fieldInput cc-contextModel",
									value: row.model,
									"aria-label": t("contextOverrideModel"),
									disabled,
									onChange: (event) => setModel(row.model, event.target.value),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: row.model,
										children: labelOf(row.model)
									}), available.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: model.id,
										children: labelOf(model.id)
									}, model.id))]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "chevron",
									className: "cc-icon cc-contextCaret"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: row.invalid ? "cc-unitBox cc-unitBoxInvalid" : "cc-unitBox",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "cc-fieldInput",
									type: "text",
									"aria-label": t("contextOverrideValue"),
									"aria-invalid": row.invalid || void 0,
									value: row.text,
									disabled,
									onChange: (event) => setText(row.model, event.target.value)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-unit",
									children: t("unitTokens")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-iconButton",
								"aria-label": t("contextOverrideRemove"),
								disabled,
								onClick: () => removeRow(row.model),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "close" })
							}),
							row.invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-rowError cc-contextError",
								children: invalidCopy(row.invalidReason, t, "context")
							}) : null
						]
					}, row.model))]
				}) : null
			] });
		}
		/**
		* Privacy & security: the opt-in that changes where data goes. ZDR restricts
		* which upstream serves a request, so it starts off.
		*/
		function PrivacyCard({ state, disabled, t, onEdit, onReset, expanded, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FoldableGroup, {
				id: "privacy",
				title: t("privacyTitle"),
				expanded,
				onToggle,
				badges: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupSummary, { parts: [stagedSwitch(state.zdr, false) ? t("zdrSummaryOn") : t("zdrSummaryOff")] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
					id: "cc-zdr",
					label: t("zdr"),
					hint: t("zdrHint"),
					state: state.zdr,
					disabled,
					defaultChecked: false,
					onEdit: (text) => onEdit("zdr", text),
					onReset: () => onReset("zdr"),
					t
				})
			});
		}
		/**
		* The service-status row: the official status page's published record and the
		* Host's live probe of the configured API base, both projected by
		* ./service-status.ts (source order, cache TTL, the lag rule and every
		* degradation path live there). It is display-only — it writes no setting and
		* never blocks Save; the link opens the page for the full history.
		*/
		function ServiceStatusRow({ view, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
				title: t("serviceStatusTitle"),
				tag: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
					className: "cc-statusLink cc-statusTitleLink",
					href: STATUS_PAGE_URL,
					target: "_blank",
					rel: "noreferrer",
					children: [view.linkLabel, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "external",
						className: "cc-icon cc-iconInline"
					})]
				}),
				description: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-statusLines",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-statusKey",
							children: t("serviceStatusOfficial")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-statusValue",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
									state: toneDot(view.officialTone),
									size: 8
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusVerdict",
									children: view.label
								}),
								view.detailParts.length > 0 || view.updated !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-statusMeta",
									children: [...view.detailParts, ...view.updated !== void 0 ? [view.updated] : []].map((part, index, parts) => {
										const last = index === parts.length - 1;
										const isAge = view.updated !== void 0 && last;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "cc-statusPart",
											title: isAge ? view.lag ?? view.hint : void 0,
											children: last ? part : `${part}\u00a0·`
										}), last ? null : " "] }, index);
									})
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-statusKey",
							children: t("serviceStatusLocal")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-statusValue",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: localDotState(view),
								size: 8
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: view.localTone === "error" ? "cc-statusVerdict cc-statusBad" : "cc-statusVerdict",
								children: view.local
							})]
						})
					]
				}), view.notice !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cc-statusNotice",
					children: view.notice
				}) : null] })
			});
		}
		/**
		* The status dot and verdict, shared by the status row and the Integrations
		* heading. The primitive's five states already carry the theme's
		* success/warn/error tokens, so the colours are the design system's own.
		*/
		function ServiceStatusBadge({ view }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cc-statusBadge",
				title: view.hint,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: toneDot(view.badge.tone) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: view.badge.tone === "warn" || view.badge.tone === "error" ? "cc-statusLabel cc-statusBad" : "cc-statusLabel",
					children: view.badge.label
				})]
			});
		}
		/** A view tone on the harness StateDot. */
		function toneDot(tone) {
			return tone === "ok" ? "done" : tone === "warn" ? "warning" : tone === "error" ? "error" : tone === "checking" ? "ongoing" : "idle";
		}
		/**
		* The local probe's dot: done/error once it answered, breathing while the
		* request is in flight, idle when the Host offers no probe at all.
		*/
		function localDotState(view) {
			if (view.localTone === "ok") return "done";
			if (view.localTone === "error") return "error";
			return view.localChecking ? "ongoing" : "idle";
		}
		/**
		* Integrations & display: surfaces outside chat that reuse this provider. The
		* status snapshot comes from the page, which probes once per open even while
		* this group is folded — its heading shows the verdict either way.
		*/
		function IntegrationsCard({ state, disabled, t, onEdit, onReset, expanded, onToggle, status, probe }) {
			const view = serviceStatusView(status, probe, t, Date.now());
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(FoldableGroup, {
				id: "integrations",
				title: t("integrationsTitle"),
				expanded,
				onToggle,
				badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServiceStatusBadge, { view }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupSummary, { parts: [stagedSwitch(state.webSearch, true) ? t("webSearchSummaryOn") : t("webSearchSummaryOff")] })] }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServiceStatusRow, {
						view,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
						id: "cc-web-search",
						label: t("webSearch"),
						hint: t("webSearchHint"),
						state: state.webSearch,
						disabled,
						defaultChecked: true,
						onEdit: (text) => onEdit("webSearch", text),
						onReset: () => onReset("webSearch"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
						id: "cc-show-sidebar-quota",
						label: t("showSidebarQuota"),
						hint: t("showSidebarQuotaHint"),
						state: state.showSidebarQuota,
						disabled,
						defaultChecked: false,
						onEdit: (text) => onEdit("showSidebarQuota", text),
						onReset: () => onReset("showSidebarQuota"),
						t
					})
				]
			});
		}
		/**
		* The "Advanced" group: the API base and the network limits. Its heading
		* names the customized count, and while folded, an invalid number (which
		* blocks save); expanded, the row's own error says it.
		*/
		function AdvancedSection({ state, disabled, t, onEdit, onReset, expanded, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(FoldableGroup, {
				id: "advanced",
				title: t("advancedSettings"),
				expanded,
				onToggle,
				badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupSummary, { parts: [overriddenText(advancedOverriddenCount(state), t)] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InvalidBadge, {
					show: !expanded && advancedGroupInvalid(state),
					t
				})] }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-groupDesc",
						children: t("advancedSettingsHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						id: "cc-api-base",
						label: t("apiBase"),
						state: state.apiBase,
						disabled,
						wide: true,
						placeholder: FIELD_DEFAULTS.apiBase,
						onEdit: (text) => onEdit("apiBase", text),
						onReset: () => onReset("apiBase"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						id: "cc-request-timeout",
						label: t("requestTimeoutMs"),
						hint: t("requestTimeoutMsHint"),
						state: state.requestTimeoutMs,
						disabled,
						numeric: true,
						decimal: true,
						unit: t("unitSeconds"),
						placeholder: FIELD_DEFAULTS.requestTimeoutSeconds,
						onEdit: (text) => onEdit("requestTimeoutMs", text),
						onReset: () => onReset("requestTimeoutMs"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						id: "cc-stream-idle-timeout",
						label: t("streamIdleTimeoutMs"),
						hint: t("streamIdleTimeoutMsHint"),
						state: state.streamIdleTimeoutMs,
						disabled,
						numeric: true,
						decimal: true,
						unit: t("unitSeconds"),
						placeholder: FIELD_DEFAULTS.streamIdleTimeoutSeconds,
						onEdit: (text) => onEdit("streamIdleTimeoutMs", text),
						onReset: () => onReset("streamIdleTimeoutMs"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						id: "cc-transport-max-retries",
						label: t("transportMaxRetries"),
						hint: t("transportMaxRetriesHint"),
						state: state.transportMaxRetries,
						disabled,
						numeric: true,
						unit: t("unitRetries"),
						placeholder: FIELD_DEFAULTS.transportMaxRetries,
						onEdit: (text) => onEdit("transportMaxRetries", text),
						onReset: () => onReset("transportMaxRetries"),
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
						id: "cc-offload-seen-images-for-cache",
						label: t("offloadSeenImagesForCache"),
						hint: t("offloadSeenImagesForCacheHint"),
						state: state.offloadSeenImagesForCache,
						disabled,
						defaultChecked: false,
						onEdit: (text) => onEdit("offloadSeenImagesForCache", text),
						onReset: () => onReset("offloadSeenImagesForCache"),
						t
					})
				]
			});
		}
		/**
		* Merge the controller's accounts with the usage report. The default slot is
		* always first; report entries this page cannot manage (literal keys from the
		* composition config) still render, read-only, so the list names every
		* account the pool rotates through.
		*/
		function accountRows(state, usage, t) {
			const report = new Map((usage.report?.accounts ?? []).map((entry) => [entry.id, entry]));
			const defaultUsage = report.get("default");
			const rows = [{
				id: "default",
				label: t("accountDefault"),
				ref: void 0,
				isDefault: true,
				managed: true,
				configured: state.apiKeyConfigured || defaultUsage?.configured === true,
				storedKey: state.apiKeyConfigured,
				credentialKnown: state.apiKeyKnown || typeof defaultUsage?.configured === "boolean",
				keyWritable: state.apiKeyWritable,
				usage: defaultUsage
			}];
			for (const account of state.accounts) {
				const entry = report.get(account.id);
				rows.push({
					id: account.id,
					label: account.label,
					ref: account.ref,
					isDefault: false,
					managed: true,
					configured: account.configured || entry?.configured === true,
					storedKey: account.configured,
					credentialKnown: account.credentialKnown || typeof entry?.configured === "boolean",
					keyWritable: account.writable,
					usage: entry
				});
			}
			const known = new Set(rows.map((row) => row.id));
			for (const entry of usage.report?.accounts ?? []) {
				if (known.has(entry.id)) continue;
				known.add(entry.id);
				rows.push({
					id: entry.id,
					label: entry.label,
					ref: void 0,
					isDefault: false,
					managed: false,
					configured: entry.configured,
					storedKey: false,
					credentialKnown: true,
					keyWritable: false,
					usage: entry
				});
			}
			return rows;
		}
		/**
		* The row's status dot. Read top-down, so a problem always outranks "serving":
		* red for a key the Host rejected, amber while a rate limit is cooling down,
		* green for the account that is actually serving requests. A standby (or not
		* yet configured) account draws NOTHING — `cc-tabDotBlank` is an unfilled,
		* borderless dot that only holds the column so the account names stay aligned
		* with the rows that do have a verdict. Green therefore means "in use", not
		* "healthy": a wall of green dots would say nothing.
		*/
		function statusDotClass(row) {
			const entry = row.usage;
			if (entry?.mark === "invalid-credential") return "cc-tabDot cc-tabDotError";
			if (entry !== void 0 && (entry.mark !== "" || entry.cooldownUntil > 0)) return "cc-tabDot cc-tabDotWarn";
			if (row.configured && entry?.active === true) return "cc-tabDot cc-tabDotOk";
			return "cc-tabDot cc-tabDotBlank";
		}
		/**
		* The same verdict as a sentence, for the dot's tooltip. Undefined on a blank
		* dot: there is no verdict to read out, and a hover hotspot on an invisible
		* 8px mark would only invite the question it cannot usefully answer.
		*/
		function statusDotTitle(row, t) {
			const entry = row.usage;
			if (entry?.mark === "invalid-credential") return t("usageInvalidKey");
			if (entry !== void 0 && (entry.mark !== "" || entry.cooldownUntil > 0)) return t("usageCooldown");
			if (!row.credentialKnown) return t("writeStateUnknown");
			if (!row.configured) return t("apiKeyUnset");
			return entry?.active === true ? t("usageActive") : void 0;
		}
		/** One compact quota meter for a row's summary line. */
		function MiniMeter({ label, limit }) {
			const ratio = windowRatio(limit.used, limit.cap);
			const percent = limit.cap > 0 ? `${Math.round(ratio * 100)}%` : formatMoney(limit.used);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cc-miniMeter",
				title: limit.cap > 0 ? `${formatMoney(limit.used)} / ${formatMoney(limit.cap)}` : void 0,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-miniMeterLabel",
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-miniMeterTrack",
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: limit.exceeded ? "cc-miniMeterFill cc-usageBarFillWarn" : "cc-miniMeterFill",
							style: { transform: `translateX(${(ratio - 1) * 100}%)` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-miniMeterValue",
						children: percent
					})
				]
			});
		}
		/**
		* The monthly credit balance for a row's summary line: the billing endpoint's
		* `monthlyCredits` is what is LEFT, shown as the amount alone.
		*/
		function MonthlyBalance({ label, remaining }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cc-miniMeter",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cc-miniMeterLabel",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cc-miniMeterValue",
					children: formatMoney(Math.max(0, remaining))
				})]
			});
		}
		/** A single-input inline form (paste key, rename) with confirm/cancel. */
		function InlineInput({ id, label, secret, initial, placeholder, confirmLabel, disabled, t, onSubmit, onCancel }) {
			const [value, setValue] = (0, react.useState)(initial ?? "");
			const [visible, setVisible] = (0, react.useState)(false);
			const ready = value.trim() !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "cc-inlineForm",
				onSubmit: (event) => {
					event.preventDefault();
					if (ready && !disabled) onSubmit(value);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					id,
					className: "cc-input",
					type: secret && !visible ? "password" : "text",
					"aria-label": label,
					autoComplete: "new-password",
					spellCheck: false,
					autoFocus: true,
					placeholder,
					value,
					disabled,
					onChange: (event) => setValue(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Escape") onCancel();
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-inlineActions",
					children: [
						secret && value !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "ghost",
							size: "sm",
							type: "button",
							onClick: () => setVisible((shown) => !shown),
							children: visible ? t("hide") : t("show")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-spacer" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "ghost",
							size: "sm",
							type: "button",
							onClick: onCancel,
							children: t("cancel")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "primary",
							size: "sm",
							type: "submit",
							disabled: !ready || disabled,
							children: confirmLabel
						})
					]
				})]
			});
		}
		/** A destructive confirmation, shown in place in the card as an error notice (no modal). */
		function ConfirmBar({ text, confirmLabel, disabled, t, onConfirm, onCancel }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
				tone: "error",
				icon: "warn",
				role: "alertdialog",
				label: text,
				title: text,
				actions: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
					variant: "danger",
					size: "sm",
					disabled,
					onClick: onConfirm,
					children: confirmLabel
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
					variant: "ghost",
					size: "sm",
					onClick: onCancel,
					children: t("cancel")
				})] })
			});
		}
		/** One account row: identity, status, quota summary, actions and expandable details. */
		function AccountItem({ row, rows, state, usage, login, disabled, pinned, t, actions }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const [mode, setMode] = (0, react.useState)(void 0);
			const entry = row.usage;
			const report = entry?.report;
			const accountName = report?.account === void 0 ? "" : report.account.userName || report.account.name;
			const planName = report?.plan?.name ?? "";
			const credits = report?.credits;
			const monthlyReported = credits !== void 0 && credits.monthlyReported !== false;
			const multi = rows.length > 1;
			const loginTarget = row.ref;
			const { visible: loginState, busyElsewhere } = loginStateForTarget(login, loginTarget);
			const loginBusy = loginState.phase === "starting" || loginState.phase === "waiting";
			const showLogin = loginState.phase !== "idle";
			const locked = disabled || !row.managed;
			const keyActions = !locked && row.keyWritable;
			const items = [];
			if (row.managed && multi) items.push(pinned ? {
				id: "unpin",
				label: t("accountActionUnpin"),
				disabled: locked
			} : {
				id: "pin",
				label: t("accountActionPin"),
				disabled: locked || !row.configured
			});
			if (row.managed) {
				if (items.length > 0) items.push({
					type: "separator",
					id: "sep-key"
				});
				items.push({
					id: "login",
					label: t("accountActionLogin"),
					disabled: !keyActions || loginBusy || busyElsewhere
				}, {
					id: "key",
					label: t("accountActionKey"),
					disabled: !keyActions
				});
				if (!row.isDefault) items.push({
					id: "rename",
					label: t("accountActionRename"),
					disabled: locked
				});
				if (row.isDefault && row.storedKey) items.push({
					type: "separator",
					id: "sep-danger"
				}, {
					id: "clearKey",
					label: t("accountActionClearKey"),
					disabled: !keyActions,
					danger: true
				});
				if (!row.isDefault) items.push({
					type: "separator",
					id: "sep-danger"
				}, {
					id: "remove",
					label: t("accountActionRemove"),
					disabled: locked,
					danger: true
				});
			}
			const onAction = (id) => {
				setMenuOpen(false);
				if (id === "pin") actions.setActive(row.id);
				else if (id === "unpin") actions.setActive("");
				else if (id === "login") actions.beginLogin(loginTarget);
				else if (id === "key" || id === "rename" || id === "remove" || id === "clearKey") setMode(id);
			};
			const models = state.accountModels[row.id] ?? [];
			const ownerOf = (modelId) => {
				for (const [account, list] of Object.entries(state.accountModels)) {
					if (account === row.id || !list.includes(modelId)) continue;
					return rows.find((candidate) => candidate.id === account)?.label ?? account;
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: row.usage?.active ? "cc-accountItem cc-accountItemActive" : "cc-accountItem",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-accountHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "cc-accountToggle",
							"aria-expanded": expanded,
							"aria-controls": `cc-account-${row.id}-details`,
							onClick: () => setExpanded((value) => !value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: statusDotClass(row),
									title: statusDotTitle(row, t),
									"aria-hidden": "true"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-accountName",
									children: row.label
								}),
								accountName !== "" && accountName !== row.label ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-usageAccount",
									children: accountName
								}) : null,
								planName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeOutline",
									children: planName
								}) : null,
								entry?.active && multi ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeOk",
									children: t("usageActive")
								}) : null,
								pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge",
									children: t("accountStatusPinned")
								}) : null,
								!row.credentialKnown || !row.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeOutline",
									children: t(row.credentialKnown ? "apiKeyUnset" : "writeStateUnknown")
								}) : null,
								entry?.mark === "invalid-credential" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeError",
									children: t("usageInvalidKey")
								}) : null,
								entry !== void 0 && entry.mark !== "invalid-credential" && (entry.cooldownUntil > 0 || entry.mark === "rate-limit") ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "cc-badge cc-badgeWarn",
									children: [t("usageCooldown"), entry.cooldownUntil > 0 ? ` ${formatResetAtShort(entry.cooldownUntil)}` : ""]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-spacer" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "chevron",
									className: expanded ? "cc-icon cc-foldChevron cc-chevronOpen" : "cc-icon cc-foldChevron"
								})
							]
						}), items.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: menuOpen,
							onClose: () => setMenuOpen(false),
							onSelect: onAction,
							items,
							align: "end",
							portal: true,
							anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-iconButton",
								"aria-label": `${row.label} — ${t("accountActions")}`,
								title: t("accountActions"),
								"aria-haspopup": "menu",
								"aria-expanded": menuOpen,
								onClick: () => setMenuOpen((value) => !value),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { name: "more" })
							})
						}) : null]
					}),
					!expanded && credits !== void 0 && (credits.fiveHour !== void 0 || credits.weekly !== void 0 || monthlyReported) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-accountMeters",
						children: [
							credits.fiveHour !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniMeter, {
								label: t("usageFiveHour"),
								limit: credits.fiveHour
							}) : null,
							credits.weekly !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniMeter, {
								label: t("usageWeekly"),
								limit: credits.weekly
							}) : null,
							monthlyReported ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MonthlyBalance, {
								label: t("usageMonthlyLeft"),
								remaining: credits.monthlyCredits
							}) : null
						]
					}) : null,
					row.credentialKnown && !row.configured && row.managed && mode === void 0 && !showLogin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
						icon: row.keyWritable ? "info" : "lock",
						actions: keyActions ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "primary",
							size: "sm",
							disabled: loginBusy || busyElsewhere,
							onClick: () => actions.beginLogin(loginTarget),
							children: t("accountAddLogin")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "outline",
							size: "sm",
							onClick: () => setMode("key"),
							children: t("accountAddPaste")
						})] }) : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: row.keyWritable ? t("accountNoKeyHint") : t("apiKeyLocked") })
					}) : null,
					showLogin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginStatus, {
						state: loginState,
						t,
						onCancel: actions.cancelLogin
					}) : null,
					mode === "key" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-panel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InlineInput, {
							id: `cc-account-${row.id}-key`,
							label: t("accountKeyPlaceholder"),
							secret: true,
							placeholder: t("accountKeyPlaceholder"),
							confirmLabel: t("accountApply"),
							disabled: disabled || state.accountBusy,
							t,
							onCancel: () => setMode(void 0),
							onSubmit: (value) => {
								actions.setKey(row.id, value).then((ok) => {
									if (ok) setMode(void 0);
								});
							}
						})
					}) : null,
					mode === "rename" && row.ref !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-panel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InlineInput, {
							id: `cc-account-${row.id}-rename`,
							label: t("accountActionRename"),
							initial: row.label,
							confirmLabel: t("accountApply"),
							disabled: disabled || state.accountBusy,
							t,
							onCancel: () => setMode(void 0),
							onSubmit: (value) => {
								actions.rename(row.ref, value).then((ok) => {
									if (ok) setMode(void 0);
								});
							}
						})
					}) : null,
					mode === "remove" && row.ref !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmBar, {
						text: t("accountRemoveConfirm", { name: row.label }),
						confirmLabel: t("accountConfirmRemove"),
						disabled: disabled || state.accountBusy,
						t,
						onCancel: () => setMode(void 0),
						onConfirm: () => {
							actions.remove(row.ref).then((ok) => {
								if (ok) setMode(void 0);
							});
						}
					}) : null,
					mode === "clearKey" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmBar, {
						text: t("accountClearKeyConfirm"),
						confirmLabel: t("accountConfirmClear"),
						disabled: disabled || state.accountBusy,
						t,
						onCancel: () => setMode(void 0),
						onConfirm: () => {
							actions.clearKey(row.id).then((ok) => {
								if (ok) setMode(void 0);
							});
						}
					}) : null,
					expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						id: `cc-account-${row.id}-details`,
						className: "cc-accountDetails",
						children: [entry !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountReport, {
							entry,
							fetchedAt: usage.fetchedAt,
							t,
							headless: true
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-usageHint",
							children: usage.status === "loading" ? t("usageLoading") : t("usageUnconfigured")
						}), multi && row.managed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
							className: "cc-rowFlush",
							title: t("accountModels"),
							titleFor: `cc-account-${row.id}-models`,
							description: t("accountModelsHint"),
							error: state.catalogFailed ? t("modelCatalogFailed") : void 0,
							control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelMultiSelect, {
								id: `cc-account-${row.id}-models`,
								selected: models,
								catalog: state.catalogModels,
								disabled: disabled || state.accountBusy,
								deferCommit: true,
								ownerOf,
								t,
								onSelect: (ids) => void actions.setModels(row.id, ids)
							})
						}) : null]
					}) : null
				]
			});
		}
		/** The live status of one browser sign-in: link while waiting, outcome after. */
		function LoginStatus({ state, t, onCancel }) {
			const hint = loginHint(state, t);
			const busy = state.phase === "starting" || state.phase === "waiting";
			const tone = hint.className === "cc-loginError" ? "error" : hint.className === "cc-loginDone" ? "success" : "neutral";
			const link = state.authUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
				className: "cc-loginLink",
				href: state.authUrl,
				target: "_blank",
				rel: "noreferrer",
				children: [t("loginOpenLink"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
					name: "external",
					className: "cc-icon cc-iconInline"
				})]
			}) : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
				tone,
				actions: link !== null || busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [link, busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
					variant: "ghost",
					size: "sm",
					onClick: onCancel,
					children: t("loginCancel")
				}) : null] }) : void 0,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					title: hint.title,
					children: hint.text
				})
			});
		}
		/** Enrollment phases during which the panel only offers "cancel setup". */
		const ENROLLMENT_BUSY_PHASES = [
			"creating",
			"waiting",
			"writing",
			"cancelling"
		];
		/**
		* What the add-account panel's action row shows, from the enrollment phase
		* and the panel's own inputs — a pure function so the button logic is tested
		* without rendering:
		* - `naming`: the host could not save the name; retry / accept / cancel.
		* - `cancelSetup`: a sign-in or key write is in flight; only "cancel setup",
		*   with the method switch and inputs locked.
		* - `start`: idle; cancel plus the mode's primary action ("Start sign-in", or
		*   "Add" once a key is typed in paste mode).
		*/
		function addAccountPanelView({ phase, mode, keyReady, disabled }) {
			if (phase === "naming") return {
				actions: "naming",
				locked: true,
				canSubmit: false
			};
			if (phase !== void 0 && ENROLLMENT_BUSY_PHASES.includes(phase)) return {
				actions: "cancelSetup",
				locked: true,
				canSubmit: false
			};
			return {
				actions: "start",
				locked: disabled,
				canSubmit: !disabled && (mode === "browser" || keyReady)
			};
		}
		/**
		* 新增面板只负责输入和操作意图；账号、登录、命名与补偿由宿主过程负责。
		* Drawn as the design canvas does: a "sign in / paste key" segmented switch,
		* the optional name, the key field in paste mode, then cancel + the primary
		* action on the right. Leaving paste mode clears the typed key, so a key never
		* lingers in a field the user has moved away from.
		*/
		function AddAccountPanel({ state, disabled, t, enrollment, snapshot, onClose }) {
			const [label, setLabel] = (0, react.useState)("");
			const [mode, setMode] = (0, react.useState)("browser");
			const [key, setKey] = (0, react.useState)("");
			const [keyVisible, setKeyVisible] = (0, react.useState)(false);
			const active = snapshot.active;
			const view = addAccountPanelView({
				phase: active?.phase,
				mode,
				keyReady: key.trim() !== "",
				disabled
			});
			const fallbackName = t("accountNameN", { n: state.accounts.length + 2 });
			(0, react.useEffect)(() => {
				if (active?.phase === "finished") onClose();
			}, [active?.phase, onClose]);
			const start = () => enrollment.begin({
				mode: mode === "browser" ? "browser" : "manual",
				label: label.trim() || fallbackName,
				automaticName: label.trim() === "",
				...mode === "browser" ? {} : { key }
			});
			const close = () => {
				enrollment.cancel();
				onClose();
			};
			const pick = (next) => {
				setMode(next);
				if (next === "browser") {
					setKey("");
					setKeyVisible(false);
				}
			};
			const waitingLink = active?.authUrl && active.phase === "waiting" ? active.authUrl : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "cc-panel",
				"aria-label": t("accountAdd"),
				onSubmit: (event) => {
					event.preventDefault();
					if (view.canSubmit) start();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-panelTitle",
						children: t("accountAdd")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-rowDesc",
						children: t("accountAddHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-seg",
						role: "group",
						"aria-label": t("accountAddMethod"),
						children: ["browser", "paste"].map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: mode === option ? "cc-segItem cc-segOn" : "cc-segItem",
							"aria-pressed": mode === option,
							disabled: view.locked,
							onClick: () => pick(option),
							children: option === "browser" ? t("accountAddLogin") : t("accountAddPaste")
						}, option))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: "cc-fieldInput cc-panelInput",
						type: "text",
						"aria-label": t("accountNamePlaceholder"),
						placeholder: t("accountNamePlaceholder"),
						value: label,
						disabled: view.locked,
						onChange: (event) => setLabel(event.target.value)
					}),
					mode === "paste" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-keyField",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "cc-add-account-key",
							className: "cc-fieldInput cc-panelInput",
							type: keyVisible ? "text" : "password",
							"aria-label": t("accountKeyPlaceholder"),
							placeholder: t("accountKeyPlaceholder"),
							autoComplete: "new-password",
							spellCheck: false,
							autoFocus: true,
							value: key,
							disabled: view.locked,
							onChange: (event) => setKey(event.target.value)
						}), key !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "ghost",
							size: "sm",
							disabled: view.locked,
							onClick: () => setKeyVisible((shown) => !shown),
							children: keyVisible ? t("hide") : t("show")
						}) : null]
					}) : null,
					active ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Notice, {
						actions: waitingLink !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
							className: "cc-loginLink",
							href: waitingLink,
							target: "_blank",
							rel: "noreferrer",
							children: [t("accountAddOpenLink"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "external",
								className: "cc-icon cc-iconInline"
							})]
						}) : void 0,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t(active.messageKey) }), waitingLink !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("accountAddLinkHint") }) : null]
					}) : null,
					snapshot.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
						tone: "error",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t(snapshot.error) })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-panelActions",
						children: view.actions === "naming" && active !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "ghost",
								onClick: close,
								children: t("cancel")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								disabled,
								onClick: () => void enrollment.name(),
								children: t("accountNameAcceptExisting")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "primary",
								disabled,
								onClick: () => void enrollment.name(active.suggestedName || label || fallbackName),
								children: t("accountNameSaveRetry")
							})
						] }) : view.actions === "cancelSetup" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "ghost",
							onClick: close,
							children: t("accountAddCancel")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "ghost",
							onClick: close,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
							variant: "primary",
							type: "submit",
							disabled: !view.canSubmit,
							children: mode === "browser" ? t("accountAddStart") : t("accountAddConfirm")
						})] })
					})
				]
			});
		}
		/**
		* The unified account card: every account the pool rotates through, one row
		* each, with its status and quota inline — so one account's facts no longer
		* have to be cross-read across separate surfaces.
		*
		* Exported for the render test (`tests/accounts-card-render.test.ts`) that pins
		* the first-paint auto-refresh wiring against a real React tree: the page mounts
		* this card, and a test that only checks the injected function exists cannot see
		* the card reaching for it.
		*/
		function AccountsCard({ t, state, usage, login, disabled, actions, onRefresh, onRefreshAuto, openAnalytics, createEnrollment, expanded, onToggle }) {
			const [adding, setAdding] = (0, react.useState)(false);
			const [enrollment] = (0, react.useState)(createEnrollment);
			const snapshot = (0, react.useSyncExternalStore)(enrollment.store.subscribe, enrollment.store.getSnapshot);
			(0, react.useEffect)(() => {
				enrollment.activate();
				return () => enrollment.dispose();
			}, [enrollment]);
			const closeAdd = (0, react.useCallback)(() => setAdding(false), []);
			const { loading, shouldRefresh } = usageCardState(usage);
			(0, react.useEffect)(() => {
				if (shouldRefresh) onRefreshAuto();
			}, [shouldRefresh, onRefreshAuto]);
			const rows = accountRows(state, usage, t).filter((row) => row.ref === void 0 || !state.accountEnrollmentRefs.includes(row.ref));
			const multi = rows.length > 1;
			const pinnedRow = rows.find((row) => row.id === state.activeAccount);
			const issues = accountIssues(rows.map((row) => row.usage));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(FoldableGroup, {
				id: "accounts",
				title: t("accountsTitle"),
				expanded,
				onToggle,
				badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupSummary, { parts: [rows.length === 1 ? t("accountsSummaryOne") : t("accountsSummaryMany", { count: rows.length })] }), issues.count > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: issues.severe ? "cc-badge cc-badgeError" : "cc-badge cc-badgeWarn",
					children: t("accountsSummaryIssues", { count: issues.count })
				}) : null] }),
				action: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
					variant: "ghost",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
						name: "refresh",
						className: "cc-icon cc-btnIcon"
					}),
					disabled: loading,
					onClick: () => {
						onRefresh();
						enrollment.refresh();
					},
					children: loading ? t("usageRefreshing") : t("usageRefresh")
				}),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-groupDesc",
						children: multi ? t("accountsRotationHint") : t("accountsHint")
					}),
					multi ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-accountMode",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								name: "swap",
								className: "cc-icon cc-btnIcon"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: pinnedRow !== void 0 ? t("accountModePinned", { name: pinnedRow.label }) : t("accountModeAuto") }),
							pinnedRow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "ghost",
								size: "sm",
								disabled: disabled || state.accountBusy,
								onClick: () => void actions.setActive(""),
								children: t("accountActionUnpin")
							}) : null
						]
					}) : null,
					(() => {
						const writeNotice = settingsWriteNotice(state.accountResult, t);
						const notices = [];
						if (usage.status === "error") notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "error",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [t("usageError"), usage.error !== void 0 && usage.error !== "" ? ` — ${usage.error}` : ""] })
						}, "usage"));
						if (writeNotice || state.accountFailed !== void 0) notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "error",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: writeNotice || t("accountOpFailed") })
						}, "op"));
						if (state.credentialRefreshFailed || state.accountResult?.refreshFailed || state.saveResult?.refreshFailed) notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "warn",
							actions: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "sm",
								onClick: actions.refreshCredentials,
								children: t("writeRefreshRetry")
							}),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("writeRefreshFailed") })
						}, "refresh"));
						if (!adding && snapshot.error) notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "error",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t(snapshot.error) })
						}, "enroll"));
						if (state.pendingCredentialCleanup.length > 0) notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "warn",
							actions: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "sm",
								disabled: disabled || state.accountBusy,
								onClick: () => {
									for (const ref of state.pendingCredentialCleanup) actions.cleanup(ref);
								},
								children: t("accountCleanupRetry")
							}),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("accountCleanupPending") })
						}, "cleanup"));
						for (const record of snapshot.pending.filter((candidate) => candidate.id !== snapshot.active?.id)) notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "warn",
							actions: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [record.phase === "naming" && record.suggestedName ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "sm",
								disabled,
								onClick: () => void enrollment.recover(record, record.suggestedName),
								children: t("accountNameSaveRetry")
							}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "sm",
								disabled,
								onClick: () => void enrollment.recover(record),
								children: record.phase === "naming" ? t("accountNameAcceptExisting") : t("accountEnrollmentCleanupRetry")
							})] }),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								record.ref,
								t("accountRefSeparator"),
								t(record.messageKey)
							] })
						}, record.id));
						if (snapshot.active?.phase === "cleanup-needed") notices.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							tone: "warn",
							actions: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "sm",
								disabled,
								onClick: () => void enrollment.recover(snapshot.active),
								children: t("accountEnrollmentCleanupRetry")
							}),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t(snapshot.active.messageKey) })
						}, "active-cleanup"));
						return notices.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "cc-notices",
							children: notices
						}) : null;
					})(),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-accountList",
						children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountItem, {
							row,
							rows,
							state,
							usage,
							login,
							disabled,
							pinned: state.activeAccount === row.id,
							t,
							actions
						}, row.id))
					}),
					adding ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddAccountPanel, {
						state,
						disabled,
						t,
						enrollment,
						snapshot,
						onClose: closeAdd
					}) : null,
					!adding || openAnalytics ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-accountActions",
						children: [
							!adding ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
								variant: "outline",
								size: "md",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "plus",
									className: "cc-icon cc-btnIcon"
								}),
								disabled,
								onClick: () => {
									enrollment.reset();
									setAdding(true);
								},
								children: t("accountAdd")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-spacer" }),
							openAnalytics ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PageButton, {
								variant: "ghost",
								size: "md",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "chart",
									className: "cc-icon cc-btnIcon"
								}),
								className: "cc-analyticsEntry",
								onClick: openAnalytics,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-analyticsEntryText",
									children: t("openAnalytics")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									name: "arrowRight",
									className: "cc-icon cc-btnIcon"
								})]
							}) : null
						]
					}) : null
				]
			});
		}
		/**
		* Show the save bar's "saved" confirmation for a short window after each accepted save.
		* The controller only counts saves (`savedCount`); the flash timing lives
		* here so the state machine stays timer-free.
		*/
		function useSavedFlash(tick) {
			const [visible, setVisible] = (0, react.useState)(false);
			const seen = (0, react.useRef)(tick);
			(0, react.useEffect)(() => {
				if (tick === seen.current) return;
				seen.current = tick;
				setVisible(true);
				const timer = setTimeout(() => setVisible(false), 2500);
				return () => clearTimeout(timer);
			}, [tick]);
			return visible;
		}
		/**
		* The update hint: one throttled npm-registry check per page open (the
		* throttle and all failure handling live in ./update.ts). Resolves to the
		* newest published version when it is newer than this build, else undefined —
		* every failure mode degrades to no hint at all.
		*/
		function usePluginUpdate() {
			const [available, setAvailable] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let cancelled = false;
				checkForUpdate({
					currentVersion: PLUGIN_VERSION,
					now: Date.now(),
					store: localStorageUpdateStore()
				}).then((version) => {
					if (!cancelled) setAvailable(version);
				}, () => {});
				return () => {
					cancelled = true;
				};
			}, []);
			return available;
		}
		/**
		* The service status: paint the cached snapshot immediately, then run one
		* throttled check per page open (the TTL and every failure path live in
		* ./service-status.ts, which never rejects). The Host probe runs alongside it
		* and is the row's real-time half — the published record only moves on a status
		* change or the daily summary, so it can legitimately be hours old.
		*/
		function useServiceStatus(probeService) {
			const [snapshot, setSnapshot] = (0, react.useState)(() => readCachedServiceStatus(localStorageServiceStatusStore()));
			const [probe, setProbe] = (0, react.useState)({ kind: "checking" });
			(0, react.useEffect)(() => {
				let cancelled = false;
				checkServiceStatus({ store: localStorageServiceStatusStore() }).then((next) => {
					if (!cancelled) setSnapshot(next);
				}, () => {});
				probeService().then((result) => {
					if (cancelled) return;
					setProbe(result.ok ? {
						kind: "result",
						result: result.value
					} : { kind: "unavailable" });
				}, () => {
					if (!cancelled) setProbe({ kind: "unavailable" });
				});
				return () => {
					cancelled = true;
				};
			}, []);
			return {
				snapshot,
				probe
			};
		}
		/**
		* The page's fold state, read once from this browser's storage and written
		* back on every change (./group-fold.ts holds the defaults and fallbacks).
		*/
		function useGroupFold() {
			const [store] = (0, react.useState)(localStorageFoldStore);
			const [fold, setFoldState] = (0, react.useState)(() => store.read());
			return [fold, (0, react.useCallback)((next) => {
				setFoldState(next);
				store.write(next);
			}, [store])];
		}
		/**
		* What the save bar says. It exists only while there is something to act on
		* or to confirm: pending edits, a save in flight, a failure, or the brief
		* confirmation after a save landed. Account operations never reach it, they
		* commit on their own.
		*/
		function saveBarView(state, savedVisible, t) {
			const notice = settingsWriteNotice(state.saveResult, t);
			if (notice) return {
				visible: true,
				tone: state.failed ? "error" : "pending",
				message: notice,
				actions: state.dirty || state.failed
			};
			if (state.failed) return {
				visible: true,
				tone: "error",
				message: t("saveFailed"),
				actions: state.dirty || state.failed
			};
			if (state.dirty || state.saving) return state.invalid ? {
				visible: true,
				tone: "error",
				message: t("saveInvalid"),
				actions: true
			} : {
				visible: true,
				tone: "pending",
				message: t("unsavedChanges"),
				actions: true
			};
			if (savedVisible) return {
				visible: true,
				tone: "success",
				message: t("saved"),
				actions: false
			};
			return {
				visible: false,
				tone: "success",
				message: "",
				actions: false
			};
		}
		/** The save bar's leading status mark: a soft dot while pending, a glyph once there is an outcome. */
		function SaveBarIcon({ tone }) {
			if (tone === "pending") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-saveBarIcon",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-saveBarPulse" })
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-saveBarIcon",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 16 16",
					width: "16",
					height: "16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "8",
						r: "6.5"
					}), tone === "success" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.2 8.2l1.9 1.9 3.7-3.9" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 4.8v3.6M8 11.1v.1" })]
				})
			});
		}
		/**
		* The floating save bar: pinned to the bottom of the settings scrollport and
		* slid out of view when there is nothing to save. It stays mounted so it can
		* animate out, and keeps showing its last message while it does (the state
		* that hid it has no message of its own).
		*/
		function SaveBar({ view, state, t, onDiscard, onSave, onLocate }) {
			const last = (0, react.useRef)(view);
			if (view.visible) last.current = view;
			const shown = view.visible ? view : last.current;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "cc-saveBarDock",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `cc-saveBar cc-saveBar-${shown.tone}${view.visible ? " cc-saveBarShown" : ""}`,
					role: "region",
					"aria-label": t("save"),
					"aria-hidden": !view.visible,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBarIcon, { tone: shown.tone }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-saveBarText",
							role: "status",
							"aria-live": "polite",
							title: shown.message,
							children: shown.message
						}),
						shown.actions ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cc-saveBarActions",
							children: [
								state.invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
									variant: "ghost",
									size: "lg",
									disabled: !view.visible,
									onClick: onLocate,
									children: t("saveLocate")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
									variant: "ghost",
									size: "lg",
									disabled: !view.visible || !state.dirty && !state.failed || state.saving,
									onClick: onDiscard,
									children: t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PageButton, {
									variant: "primary",
									size: "lg",
									disabled: !view.visible || !state.dirty || state.invalid || state.saving,
									onClick: onSave,
									children: t(state.saving ? "saving" : "save")
								})
							]
						}) : null
					]
				})
			});
		}
		/** The settings page body: accounts, then the staged provider settings. */
		function CommandCodeSettingsPage(props) {
			const { t } = props;
			const state = props.useCommandCodeSettings((snapshot) => snapshot);
			const usage = props.useCommandCodeUsage((snapshot) => snapshot);
			const login = props.useCommandCodeLogin((snapshot) => snapshot);
			const disabled = !state.writable;
			const savedVisible = useSavedFlash(state.savedCount);
			const updateVersion = usePluginUpdate();
			const { renameAccount, removeAccount, retryCredentialCleanup, setAccountKey, clearAccountKey, setActiveAccount, setAccountModels, beginLogin, cancelLogin, refreshCredentials } = props;
			const actions = (0, react.useMemo)(() => ({
				rename: renameAccount,
				remove: removeAccount,
				cleanup: retryCredentialCleanup,
				refreshCredentials,
				setKey: setAccountKey,
				clearKey: clearAccountKey,
				setActive: setActiveAccount,
				setModels: setAccountModels,
				beginLogin,
				cancelLogin
			}), [
				renameAccount,
				removeAccount,
				retryCredentialCleanup,
				setAccountKey,
				clearAccountKey,
				setActiveAccount,
				setAccountModels,
				beginLogin,
				cancelLogin,
				refreshCredentials
			]);
			const bar = saveBarView(state, savedVisible, t);
			const form = {
				state,
				disabled,
				t,
				onEdit: props.edit,
				onReset: props.resetField
			};
			const status = useServiceStatus(props.probeService);
			const [fold, setFold] = useGroupFold();
			const foldProps = (group) => ({
				expanded: fold[group],
				onToggle: () => setFold({
					...fold,
					[group]: !fold[group]
				})
			});
			const sectionRef = (0, react.useRef)(null);
			const [locateTick, setLocateTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (locateTick === 0) return;
				const target = sectionRef.current?.querySelector("[aria-invalid=\"true\"]");
				if (target === null || target === void 0) return;
				target.scrollIntoView({ block: "center" });
				target.focus({ preventScroll: true });
			}, [locateTick]);
			const locate = () => {
				setFold(expandGroups(fold, invalidGroups(state)));
				setLocateTick((tick) => tick + 1);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				ref: sectionRef,
				className: bar.visible ? "cc-section cc-sectionWithBar" : "cc-section",
				"aria-label": t("title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "cc-title",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-intro",
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusStrip, {
						t,
						state,
						usage,
						snapshot: status.snapshot,
						probe: status.probe
					}),
					!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
						icon: "lock",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("readOnly") })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountsCard, {
						t,
						state,
						usage,
						login,
						disabled,
						actions,
						onRefresh: props.refreshUsage,
						onRefreshAuto: props.refreshUsageAuto,
						openAnalytics: props.openAnalytics,
						createEnrollment: props.createEnrollment,
						...foldProps("accounts")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsCard, {
						...form,
						...foldProps("models"),
						onSelect: props.editVisibleModels,
						onClear: props.clearVisibleModels,
						onOverrides: props.editContextWindowOverrides
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PrivacyCard, {
						...form,
						...foldProps("privacy")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IntegrationsCard, {
						...form,
						...foldProps("integrations"),
						status: status.snapshot,
						probe: status.probe
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AdvancedSection, {
						...form,
						...foldProps("advanced")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cc-version",
						children: [
							"Command Code Provider v",
							PLUGIN_VERSION,
							updateVersion !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
								className: "cc-versionLink",
								href: PLUGIN_RELEASES_URL,
								target: "_blank",
								rel: "noreferrer",
								title: t("updateHint"),
								children: [
									"v",
									updateVersion,
									" ",
									t("updateAvailable")
								]
							})] }) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBar, {
						view: bar,
						state,
						t,
						onDiscard: props.discard,
						onSave: props.save,
						onLocate: locate
					})
				]
			});
		}
		//#endregion
		//#region src/client/login-row.tsx
		function LoginRow({ state, targetRef, disabled, disabledHint, t, onBegin, onCancel }) {
			const { visible: visibleState, busyElsewhere } = loginStateForTarget(state, targetRef);
			const busy = visibleState.phase === "starting" || visibleState.phase === "waiting";
			const hint = loginHint(visibleState, t);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-label",
							children: t("loginTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badges",
							children: busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-reset",
								onClick: onCancel,
								children: t("loginCancel")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-reset",
								disabled: disabled || busyElsewhere,
								onClick: onBegin,
								children: t("loginButton")
							})
						})]
					}),
					visibleState.authUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: "cc-loginLink",
							href: visibleState.authUrl,
							target: "_blank",
							rel: "noreferrer",
							children: t("loginOpenLink")
						})
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: hint.className,
						title: hint.title,
						children: disabled && !busy && disabledHint !== void 0 ? disabledHint : hint.text
					})
				]
			});
		}
		/**
		* Find the official editor card among the slot outlet's siblings, or null
		* while it is closed. The Models page renders the editor as an immediate
		* sibling of the outlet wrapper — after it in a provider row (the target of
		* the row's 编辑 toggle), before it in the first-run setup and add-provider
		* cards, where it is always open. The editor is the only such sibling whose
		* CSS module class carries the `editor` stem (`<hash>_editor`); the row header
		* and the add card's provider select never do, so the lookup needs no hash
		* knowledge.
		*/
		function adjacentEditorCard(wrapper) {
			if (wrapper === null) return null;
			for (const sibling of [wrapper.previousElementSibling, wrapper.nextElementSibling]) if (sibling !== null && typeof sibling.className === "string" && sibling.className.includes("editor")) return sibling;
			return null;
		}
		/** The closed-panel style: the outlet stays mounted as the detection anchor. */
		const HIDDEN_STYLE$1 = { display: "none" };
		/**
		* Decide the card's posture from one settings snapshot. Pure: the component
		* subscribes once and passes the snapshot in, so hook order never depends
		* on the registration→live transition. (The owner facts stay on the
		* component — only the snapshot decides the posture.)
		*/
		function cardMode(snapshot) {
			if (snapshot === void 0) return { kind: "registration" };
			return {
				kind: "live",
				ready: snapshot.available,
				controllerConfigured: snapshot.apiKeyConfigured,
				writable: snapshot.writable,
				apiKeyWritable: snapshot.apiKeyWritable
			};
		}
		/** Credential-state badge: the solid pill when set, the muted outline when not. */
		function StatusBadge({ ok, okLabel, pendingLabel }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ok ? "cc-badge" : "cc-badgeMuted",
				children: ok ? okLabel : pendingLabel
			});
		}
		/** The key paste field, with the show/hide toggle over it. */
		function CardKeyField({ state, disabled, t, onEdit }) {
			const [visible, setVisible] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "cc-label",
							htmlFor: "cc-card-api-key",
							children: t("apiKey")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badges",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-reset",
								disabled,
								onClick: () => setVisible((value) => !value),
								children: visible ? t("hide") : t("show")
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cc-card-api-key",
						className: "cc-input",
						type: visible ? "text" : "password",
						autoComplete: "new-password",
						spellCheck: false,
						value: state.text,
						disabled,
						onChange: (event) => onEdit(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: t("apiKeyHint")
					})
				]
			});
		}
		/**
		* The slot component body. Dispatched on every Command Code provider card of
		* the Models page (saved row, first-run setup posture, add-provider draft).
		*
		* Closed (the official 编辑 toggle off) it renders nothing: the row head the
		* Models page owns already names the provider and shows the credential dot, so
		* a page full of providers stays compact. Open, it hides that editor shell and
		* shows the real controls — badges, API-key field, sign-in, discard/save.
		*/
		function CommandCodeProviderCard(props) {
			const { t } = props;
			const state = props.useCommandCodeSettings !== void 0 ? props.useCommandCodeSettings((snapshot) => snapshot) : void 0;
			const mode = cardMode(state);
			const login = props.useCommandCodeLogin !== void 0 ? props.useCommandCodeLogin((snapshot) => snapshot) : void 0;
			const dirty = state?.dirty ?? false;
			const saving = state?.saving ?? false;
			const invalid = state?.invalid ?? false;
			const notice = settingsWriteNotice(state?.saveResult, t) || (state?.failed ? t("saveFailed") : "");
			const savingBlocked = !dirty || invalid;
			const configured = mode.kind === "live" && mode.ready ? mode.controllerConfigured : props.keyConfigured;
			const disabled = mode.kind === "live" && (!mode.writable || state !== void 0 && !mode.apiKeyWritable);
			const showBody = mode.kind === "live" && mode.ready && state !== void 0;
			const rootRef = (0, react.useRef)(null);
			const [editorOpen, setEditorOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const root = rootRef.current;
				if (root === null || typeof MutationObserver === "undefined") return;
				const wrapper = root.closest(`[data-slot="settings.models.provider-card"]`) ?? root.parentElement;
				if (wrapper === null) return;
				const row = wrapper.parentElement;
				if (row === null) return;
				let hiddenEditor = null;
				const sync = () => {
					const editor = adjacentEditorCard(wrapper);
					setEditorOpen(editor !== null);
					if (editor !== null) {
						editor.style.display = "none";
						hiddenEditor = editor;
					}
				};
				sync();
				const observer = new MutationObserver(sync);
				observer.observe(row, { childList: true });
				return () => {
					observer.disconnect();
					if (hiddenEditor !== null) hiddenEditor.style.display = "";
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: "cc-providerCard",
				"data-cc-models-card": "true",
				style: editorOpen ? void 0 : HIDDEN_STYLE$1,
				children: [
					editorOpen && mode.kind === "registration" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: t("cardRegistrationHint")
					}) : null,
					editorOpen && mode.kind === "live" && !mode.ready ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: t("cardLoadingHint")
					}) : null,
					editorOpen && showBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "cc-field",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "cc-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-label",
									children: t("cardTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "cc-badges",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										ok: configured,
										okLabel: t("apiKeySet"),
										pendingLabel: t(state.apiKeyKnown ? "apiKeyUnset" : "writeStateUnknown")
									}), props.provider.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-badge",
										children: t("cardRouteActive")
									}) : null]
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardKeyField, {
							state: state.apiKey,
							disabled,
							t,
							onEdit: (text) => props.edit("apiKey", text)
						}),
						login !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginRow, {
							state: login,
							disabled,
							t,
							onBegin: props.beginLogin,
							onCancel: props.cancelLogin
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cc-footer",
							children: [
								notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cc-failed",
									role: "status",
									children: notice
								}) : null,
								state?.credentialRefreshFailed || state?.saveResult?.refreshFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									onClick: props.refreshCredentials,
									children: t("writeRefreshRetry")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled: !dirty && !state?.failed || saving,
									onClick: props.discard,
									children: t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled: savingBlocked || saving,
									onClick: props.save,
									children: t(saving ? "saving" : "save")
								})
							]
						})
					] }) : null
				]
			});
		}
		//#endregion
		//#region src/client/analytics-copy.ts
		/** 模型分析沿用宿主语言；每个数值有独立标签，缺失样本与试算前提必须可见。 */
		const ANALYTICS_COPY_ZH = {
			analyticsNav: "模型分析",
			quotaNav: "账号额度",
			analysisRecent: "最近会话",
			analysisRange: "指定时间",
			analysisLimit: "会话数量",
			analysisFrom: "开始日期",
			analysisTo: "结束日期",
			analysisApply: "读取统计",
			analysisLoading: "正在读取历史记录…",
			analysisUnavailable: "宿主未提供历史查询服务，无法统计关闭后的会话。",
			analysisEmpty: "所选范围内没有 Command Code 请求记录。",
			analysisInvalid: "请输入 1–100 个会话，或不超过 366 天的有效日期范围。",
			analysisScope: "统计范围",
			analysisScanned: "已读取会话",
			analysisMatched: "含请求会话",
			analysisUnreadable: "读取失败",
			analysisSkipped: "已跳过",
			analysisPartial: "结果不完整：历史超过读取上限，或部分记录不可读。金额只覆盖已读取且可计价的请求。",
			analysisCatalog: "模型目录暂不可用，历史统计仍可查看。",
			analysisUnpriced: "部分请求缺少用量或价格，金额与词元仅为已知小计。展开明细可查看样本覆盖。",
			analysisOverview: "用量总览",
			analysisSections: "分析内容",
			analysisHistory: "历史用量",
			analysisSimulation: "价格试算",
			analysisByModel: "模型用量比较",
			analysisModelHint: "比例条表示占已知成本小计的份额；展开查看明细。",
			analysisIntro: "查看历史用量，比较模型成本与响应表现。",
			analysisModel: "模型",
			analysisCostShare: "已知成本 / 占比",
			analysisNoShare: "无占比",
			analysisShareHint: "占全部已知成本小计",
			analysisSimulationHeading: "相同工作量价格试算",
			analysisSimulationHint: "差额以所选历史全部请求的当前价估算为基准；负数表示成本更低，仅比较完整覆盖的相同工作量。",
			analysisSimulationCost: "试算成本",
			analysisCoverage: "计价覆盖",
			analysisUsd: "美元",
			analysisTokenUnit: "词元",
			analysisScenarioMonthly: "折算 30 天",
			analysisDifference: "较历史基准",
			analysisBaseline: "历史成本基准",
			analysisZeroBaseline: "基准为零，不计算比例",
			analysisNeedRange: "请选择日期范围",
			analysisShortRange: "观察范围不足一天",
			analysisIncomplete: "历史读取不完整",
			analysisNoRequests: "没有请求记录",
			analysisScenarioExcluded: "存在超上下文请求",
			analysisScenarioUnpriced: "存在未知用量或价格",
			analysisBaselineUnpriced: "历史基准未全部计价",
			analysisCost: "已知成本 · 美元",
			analysisRequests: "模型请求",
			analysisSessionCount: "会话数",
			analysisResponse: "平均响应",
			analysisFirstToken: "平均首词元",
			analysisSpeed: "输出速度",
			analysisSeconds: "秒",
			analysisSpeedUnit: "词元/秒",
			analysisPriced: "计价请求",
			analysisTimed: "响应样本",
			analysisFirstTokenSamples: "首词元样本",
			analysisDecodeSamples: "解码样本",
			analysisUsageSamples: "用量样本",
			analysisAverage: "每会话均摊",
			analysisMissing: "无数据",
			analysisDetails: "查看汇总明细",
			analysisTokens: "词元与缓存",
			analysisInput: "未缓存输入",
			analysisOutput: "输出",
			analysisCacheRead: "缓存读取",
			analysisCacheWrite: "缓存写入",
			analysisOutcome: "请求状态",
			analysisCompleted: "完成",
			analysisFailed: "失败",
			analysisRetries: "宿主重试",
			analysisCancelled: "取消",
			analysisUnknown: "未知状态",
			analysisSamples: "统计样本",
			analysisSessionCost: "会话与成本",
			analysisMonthly: "按该时间段折算 30 天",
			analysisMonthlyHint: "仅完整、全部计价且跨度至少一天的日期范围提供折算。",
			analysisRules: "统计口径与试算说明",
			analysisShortBasis: "按当前价格估算，非历史账单。缺失用量与耗时不会补零。",
			analysisBasis: "按当前价格快照重算；不是历史账单，不含订阅费和充值，词元用量不等于账号积分。仅有请求数量、没有任务边界；不计算任务质量或智能评分。旧记录缺失的用量和耗时不会补零。",
			analysisAssumption: "沿用原请求的词元与时段，对比不同模型的价格。换模型后的生成长度、缓存命中、重试和质量可能变化；不会调用模型或自动推荐。",
			analysisContext: "上下文词元",
			analysisCapabilities: "模型能力",
			analysisInputType: "输入类型",
			analysisEfforts: "推理力度",
			analysisExcluded: "超出上下文",
			analysisUnknownPrice: "未知用量或价格",
			analysisSearch: "筛选试算模型",
			analysisSearchPlaceholder: "输入模型名称或标识",
			analysisNoMatches: "没有匹配的模型，请调整筛选条件。",
			analysisImages: "支持图片",
			analysisTextOnly: "仅文本",
			analysisNoEfforts: "未提供推理力度",
			analysisCoverageHint: "耗时从步骤或重试开始计至模型结算；包含前置处理，不含后续工具执行。首词元包含推理与工具参数。速度按有解码计时的输出词元总量计算。试算未校验图片及工具兼容性，也不代表账号已获授权。",
			effortNone: "关闭 (none)",
			effortLow: "低 (low)",
			effortMedium: "中 (medium)",
			effortHigh: "高 (high)",
			effortXhigh: "极高 (xhigh)",
			effortMax: "最高 (max)"
		};
		/** 按项目约定，错误、缺失与读取状态在各语言环境中统一为中文。 */
		const ANALYTICS_COPY_EN = {
			analyticsNav: "Model analysis",
			quotaNav: "Account quota",
			analysisRecent: "Recent sessions",
			analysisRange: "Date range",
			analysisLimit: "Session count",
			analysisFrom: "Start date",
			analysisTo: "End date",
			analysisApply: "Read statistics",
			analysisLoading: ANALYTICS_COPY_ZH.analysisLoading,
			analysisUnavailable: ANALYTICS_COPY_ZH.analysisUnavailable,
			analysisEmpty: ANALYTICS_COPY_ZH.analysisEmpty,
			analysisInvalid: ANALYTICS_COPY_ZH.analysisInvalid,
			analysisScope: "Scope",
			analysisScanned: "Sessions read",
			analysisMatched: "Sessions with requests",
			analysisUnreadable: "Read failures",
			analysisSkipped: "Skipped",
			analysisPartial: ANALYTICS_COPY_ZH.analysisPartial,
			analysisCatalog: ANALYTICS_COPY_ZH.analysisCatalog,
			analysisUnpriced: ANALYTICS_COPY_ZH.analysisUnpriced,
			analysisOverview: "Usage overview",
			analysisSections: "Analysis sections",
			analysisHistory: "Recorded usage",
			analysisSimulation: "Price simulation",
			analysisByModel: "Model usage comparison",
			analysisModelHint: "Bars show each share of the known cost subtotal; expand for details.",
			analysisIntro: "Review recorded usage and compare model cost and response times.",
			analysisModel: "Model",
			analysisCostShare: "Known cost / share",
			analysisNoShare: ANALYTICS_COPY_ZH.analysisNoShare,
			analysisShareHint: "Share of the known cost subtotal",
			analysisSimulationHeading: "Price simulation for the same workload",
			analysisSimulationHint: "Differences use all selected recorded requests repriced at current rates as the baseline. Negative means lower cost; only complete coverage is compared.",
			analysisSimulationCost: "Simulated cost",
			analysisCoverage: "Priced coverage",
			analysisUsd: "USD",
			analysisTokenUnit: "tokens",
			analysisScenarioMonthly: "30-day estimate",
			analysisDifference: "vs. recorded baseline",
			analysisBaseline: "Recorded cost baseline",
			analysisZeroBaseline: ANALYTICS_COPY_ZH.analysisZeroBaseline,
			analysisNeedRange: ANALYTICS_COPY_ZH.analysisNeedRange,
			analysisShortRange: ANALYTICS_COPY_ZH.analysisShortRange,
			analysisIncomplete: ANALYTICS_COPY_ZH.analysisIncomplete,
			analysisNoRequests: ANALYTICS_COPY_ZH.analysisNoRequests,
			analysisScenarioExcluded: ANALYTICS_COPY_ZH.analysisScenarioExcluded,
			analysisScenarioUnpriced: ANALYTICS_COPY_ZH.analysisScenarioUnpriced,
			analysisBaselineUnpriced: ANALYTICS_COPY_ZH.analysisBaselineUnpriced,
			analysisCost: "Known cost · USD",
			analysisRequests: "Model requests",
			analysisSessionCount: "Sessions",
			analysisResponse: "Mean response",
			analysisFirstToken: "Mean first token",
			analysisSpeed: "Output speed",
			analysisSeconds: "s",
			analysisSpeedUnit: "tokens/s",
			analysisPriced: "Priced requests",
			analysisTimed: "Response samples",
			analysisFirstTokenSamples: "First-token samples",
			analysisDecodeSamples: "Decode samples",
			analysisUsageSamples: "Usage samples",
			analysisAverage: "Per session",
			analysisMissing: ANALYTICS_COPY_ZH.analysisMissing,
			analysisDetails: "View aggregate details",
			analysisTokens: "Tokens and cache",
			analysisInput: "Uncached input",
			analysisOutput: "Output",
			analysisCacheRead: "Cache read",
			analysisCacheWrite: "Cache write",
			analysisOutcome: "Request outcomes",
			analysisCompleted: "Completed",
			analysisFailed: "Failed",
			analysisRetries: "Host retries",
			analysisCancelled: "Cancelled",
			analysisUnknown: "Unknown outcome",
			analysisSamples: "Samples",
			analysisSessionCost: "Sessions and cost",
			analysisMonthly: "30-day extrapolation from this range",
			analysisMonthlyHint: "Requires a complete, fully priced date range spanning at least one day.",
			analysisRules: "Statistics and simulation notes",
			analysisShortBasis: "Estimated at current prices, not an invoice. Missing usage and timing stay unknown.",
			analysisBasis: "Repriced with the current snapshot; not an invoice. Excludes subscriptions and top-ups. Tokens are not account credits. Requests have no task boundaries; no task quality or intelligence scores. Missing usage and timing stay unknown.",
			analysisAssumption: "Compares model prices using original tokens and request times. Output length, cache hits, retries and quality may change with another model. Makes no model calls or automatic recommendations.",
			analysisContext: "Context tokens",
			analysisCapabilities: "Model capabilities",
			analysisInputType: "Input type",
			analysisEfforts: "Reasoning efforts",
			analysisExcluded: "Over context limit",
			analysisUnknownPrice: "Unknown usage or price",
			analysisSearch: "Filter simulation models",
			analysisSearchPlaceholder: "Model name or ID",
			analysisNoMatches: ANALYTICS_COPY_ZH.analysisNoMatches,
			analysisImages: "Images supported",
			analysisTextOnly: "Text only",
			analysisNoEfforts: "No reasoning efforts listed",
			analysisCoverageHint: "Response time runs from step/retry start to model settlement, includes preparation and excludes subsequent tools. First token includes reasoning and tool arguments. Speed uses output tokens with decode timing. Simulation does not validate image/tool compatibility or prove account entitlement.",
			effortNone: "None",
			effortLow: "Low",
			effortMedium: "Medium",
			effortHigh: "High",
			effortXhigh: "Extra high",
			effortMax: "Max"
		};
		//#endregion
		//#region src/client/panel-copy.ts
		/**
		* Bilingual copy for the Command Code **plans & quota panel** (the sidebar
		* footer card and the center-column dashboard it opens).
		*
		* The panel follows the harness's active language: `PANEL_LOCALE_NS` is a
		* registered locale namespace (`ctx.locale.register`), both panel slot
		* registrations declare it, and the renderer hands the component a `t` seat
		* whose identity changes on a language switch (so a memoized panel re-renders).
		* {@link buildPanelView} takes that translator as an input and builds every
		* string through it, so the projection stays React-free and testable and no
		* component carries copy of its own. The settings page keeps its own
		* `settings.commandcode` namespace (see `./locales.ts`); the two never mix.
		*
		* @module dsh-commandcode-provider/client/panel-copy
		*/
		/** The locale namespace both panel slots bind their `t` seat to. */
		const PANEL_LOCALE_NS = "panel.commandcode";
		/** The panel's Simplified Chinese string table (the key-set source of truth). */
		const PANEL_COPY_ZH = {
			...ANALYTICS_COPY_ZH,
			nav: "Command Code",
			subtitle: "套餐、额度与配额窗口",
			refresh: "刷新",
			refreshing: "刷新中…",
			close: "关闭",
			closeHint: "返回会话",
			loading: "正在获取账户用量…",
			noKey: "尚未配置 API 密钥",
			noKeyHint: "在 设置 → Command Code 中粘贴密钥或登录后，点击刷新。",
			plan: "套餐",
			credits: "额度",
			limits: "配额窗口",
			usage: "用量",
			completed: "成功",
			usageBillingPeriod: "官方账期用量",
			usagePeriodUnknown: "官方用量汇总，统计周期未确认",
			monthly: "月额度",
			monthlyLimit: "月额度上限",
			monthlyUsed: "本月已用",
			remaining: "剩余",
			purchased: "已购",
			free: "赠送",
			fiveHour: "5 小时窗口",
			weekly: "每周窗口",
			fiveHourShort: "5 小时",
			weeklyShort: "每周",
			windowUnlimited: "不限",
			exceeded: "已超限",
			exhausted: "已用尽",
			resets: "重置于",
			requests: "请求",
			failed: "失败",
			successRate: "成功率",
			spend: "花费",
			tokens: "Token",
			tokensIn: "入",
			tokensOut: "出",
			periodEnds: "账期截止",
			updated: "更新于",
			partial: "部分端点数据不可用",
			active: "当前使用",
			coolingDown: "限额冷却中",
			invalidKey: "密钥无效",
			unconfigured: "未配置",
			unavailable: "无数据",
			errorInvalidKey: "API 密钥无效或已过期",
			errorInvalidKeyHint: "服务端拒绝了全部请求（401）。请检查该账户的密钥，或到 commandcode.ai 控制台重新生成。",
			errorServiceUnavailable: "Command Code 服务暂时不可用",
			errorServiceUnavailableHint: "服务端返回错误（5xx），请稍后点击刷新重试。",
			errorNetwork: "无法连接 Command Code 服务",
			errorNetworkHint: "所有请求都没有到达服务端。请检查网络连接或 API 地址设置。",
			errorInvalidResponse: "Command Code 响应无法读取",
			errorInvalidResponseHint: "已收到响应，但正文读取或解析失败。下方详情可区分读取超时、中断与格式异常；可先点击刷新重试。",
			errorGeneric: "用量获取失败"
		};
		/** The panel's English string table (must mirror {@link PANEL_COPY_ZH}). */
		const PANEL_COPY_EN = {
			...ANALYTICS_COPY_EN,
			nav: "Command Code",
			subtitle: "Plans, credits and quota windows",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			close: "Close",
			closeHint: "Back to the conversation",
			loading: "Loading account usage…",
			noKey: "No API key configured",
			noKeyHint: "Paste a key — or sign in — under Settings → Command Code, then refresh.",
			plan: "Plan",
			credits: "Credits",
			limits: "Quota windows",
			usage: "Usage",
			completed: "completed",
			usageBillingPeriod: "Official billing-period usage",
			usagePeriodUnknown: "Official usage summary; the billing period is unconfirmed",
			monthly: "Monthly",
			monthlyLimit: "Monthly limit",
			monthlyUsed: "Monthly used",
			remaining: "Remaining",
			purchased: "Purchased",
			free: "Free",
			fiveHour: "5-hour window",
			weekly: "Weekly window",
			fiveHourShort: "5-hour",
			weeklyShort: "Weekly",
			windowUnlimited: "unlimited",
			exceeded: "Exceeded",
			exhausted: "Used up",
			resets: "Resets",
			requests: "Requests",
			failed: "failed",
			successRate: "Success rate",
			spend: "Spend",
			tokens: "Tokens",
			tokensIn: "in",
			tokensOut: "out",
			periodEnds: "Period ends",
			updated: "Updated",
			partial: "Some endpoint data unavailable",
			active: "Active",
			coolingDown: "Cooling down",
			invalidKey: "Invalid key",
			unconfigured: "Not configured",
			unavailable: "No data",
			errorInvalidKey: "API key invalid or expired",
			errorInvalidKeyHint: "The server rejected every request (401). Check the key for this account, or generate a new one in the commandcode.ai console.",
			errorServiceUnavailable: "The Command Code service is temporarily unavailable",
			errorServiceUnavailableHint: "The server returned errors (5xx). Try Refresh again in a moment.",
			errorNetwork: "Could not reach the Command Code service",
			errorNetworkHint: "No request reached the server. Check your network connection or the API base setting.",
			errorInvalidResponse: "Could not read the Command Code response",
			errorInvalidResponseHint: "Responses arrived, but reading or parsing their bodies failed. Details below distinguish timeouts, interrupted reads, and invalid formats. Try Refresh again.",
			errorGeneric: "Could not fetch account usage"
		};
		/** Every panel key, in the English table's declaration order. */
		const PANEL_KEYS = Object.keys(PANEL_COPY_EN);
		/**
		* The English translator. Used as the fallback when no locale seat is
		* available (a defensive path: every supported engine supplies one) and as the
		* default in tests that only assert the projection's figures.
		*/
		function panelTextEN(key) {
			return PANEL_COPY_EN[key] ?? key;
		}
		//#endregion
		//#region src/client/panel.ts
		/** `$1.23`, and `$0.0123` only when the amount is too small for cents to show it. */
		function money$1(value) {
			if (value === 0) return formatMoney(0);
			return Math.abs(value) < .01 ? formatMoneyExact(value) : formatMoney(value);
		}
		/**
		* What a figure shows when the endpoint that carries it did not report one. A
		* dash, never a zero: the panel exists to state what the account has spent, so
		* "we were not told" has to look different from "nothing".
		*/
		const UNREPORTED = "—";
		/** Local reset time; empty when the endpoint reported none. */
		function resetText(ms) {
			return formatResetAt(ms);
		}
		/** Local short date; empty when unset. */
		function dateText(ms) {
			if (ms <= 0) return "";
			return new Date(ms).toLocaleDateString();
		}
		/** Local time-of-day; empty when unset. */
		function timeText(ms) {
			if (ms <= 0) return "";
			return new Date(ms).toLocaleTimeString();
		}
		/**
		* Consumption as a percentage, NOT clamped at 100 — an over-quota window
		* reports its real overshoot (150%), which is what the printed figure should
		* say. Bar widths clamp separately via {@link barPercent}.
		*/
		function rawPercent(used, cap) {
			if (cap <= 0) return 0;
			return Math.round(used / cap * 100);
		}
		/** A percentage usable as a CSS width, clamped into [0, 100]. */
		function barPercent(percent) {
			return Math.min(100, Math.max(0, percent));
		}
		/** Build one quota-window view. */
		function windowView(label, limit) {
			const percent = rawPercent(limit.used, limit.cap);
			const capped = limit.cap > 0;
			return {
				label,
				value: capped ? `${money$1(limit.used)} / ${money$1(limit.cap)}` : money$1(limit.used),
				capped,
				percent,
				barPercent: barPercent(percent),
				exceeded: limit.exceeded,
				resetsAt: resetText(limit.resetAt)
			};
		}
		/**
		* Build the monthly credit view from the two endpoints that carry it.
		*
		* The limit is the PLAN's credit total, not the billing endpoint's
		* `monthlyCredits` (that field is a remaining balance — see
		* {@link PanelMonthlyView}), so a plan that publishes no total still shows its
		* balances, just without a ratio.
		*
		* The trap this guards: a MISSING balance is not a consumed one. The billing
		* endpoint is one of four the report fetches in parallel, so it fails on its
		* own while the plan still arrives, and reading the absent balance as 0 turns
		* that partial failure into `limit - 0 = limit` — a confident "100% used" for
		* an account that may have spent nothing. The official CLI draws no meter unless
		* the credits payload is present at all (`hasCreditsInfo`); every derived figure
		* here stays a placeholder until the balance reported.
		*/
		function monthlyView(report) {
			const credits = report.credits;
			const plan = report.plan;
			if (credits === void 0 && plan === void 0) return void 0;
			const limitValue = plan?.monthlyCredits ?? null;
			const remainingReported = credits !== void 0 && credits.monthlyReported !== false;
			const remaining = remainingReported ? Math.max(0, credits.monthlyCredits) : 0;
			const known = limitValue !== null && limitValue > 0 && remainingReported;
			const used = known ? Math.max(0, limitValue - remaining) : 0;
			const percent = known ? rawPercent(used, limitValue) : 0;
			return {
				known,
				limit: limitValue !== null ? money$1(limitValue) : UNREPORTED,
				used: known ? money$1(used) : UNREPORTED,
				remaining: remainingReported ? money$1(remaining) : UNREPORTED,
				purchased: credits !== void 0 && credits.purchasedReported !== false ? money$1(Math.max(0, credits.purchasedCredits)) : UNREPORTED,
				free: credits !== void 0 && credits.freeReported !== false ? money$1(Math.max(0, credits.freeCredits)) : UNREPORTED,
				percent,
				barPercent: barPercent(percent),
				exhausted: known && remaining <= 0,
				periodEnds: dateText(plan?.currentPeriodEnd ?? 0)
			};
		}
		/** Build one account's view. */
		function accountView(entry, t) {
			const { report } = entry;
			const account = report.account;
			const plan = report.plan;
			const credits = report.credits;
			const usage = report.usage;
			const usageRange = formatUsageBillingPeriod(usage?.periodStart, plan?.currentPeriodStart, plan?.currentPeriodEnd);
			const stats = [];
			if (usage !== void 0) {
				stats.push({
					label: "requests",
					value: formatCompactCount(usage.totalCount),
					sub: `${formatCompactCount(usage.completedCount)} ${t("completed")} / ${formatCompactCount(usage.failedCount)} ${t("failed")}`,
					title: compactCountTitle([
						[t("requests"), usage.totalCount],
						[t("completed"), usage.completedCount],
						[t("failed"), usage.failedCount]
					])
				});
				stats.push({
					label: "successRate",
					value: `${formatSuccessRate(usage.successRate)}%`,
					sub: ""
				});
				stats.push({
					label: "spend",
					value: formatMoneyExact(usage.totalCost),
					sub: `${formatMoney(usage.totalCredits)} credits`
				});
				stats.push({
					label: "tokens",
					value: formatTokensCompact(usage.totalTokensIn + usage.totalTokensOut),
					sub: `${formatTokensCompact(usage.totalTokensIn)} ${t("tokensIn")} / ${formatTokensCompact(usage.totalTokensOut)} ${t("tokensOut")}`
				});
			}
			const windows = [];
			if (credits?.fiveHour !== void 0) windows.push(windowView("fiveHour", credits.fiveHour));
			if (credits?.weekly !== void 0) windows.push(windowView("weekly", credits.weekly));
			let mark;
			if (entry.active) mark = "active";
			else if (entry.mark === "invalid-credential") mark = "invalidKey";
			else if (entry.cooldownUntil > 0 || entry.mark === "rate-limit") mark = "coolingDown";
			return {
				id: entry.id,
				label: entry.label,
				owner: account === void 0 ? "" : account.userName || account.name,
				planName: plan?.name ?? "",
				planStatus: plan !== void 0 && plan.status !== "" && plan.status !== "active" ? plan.status : "",
				mark,
				cooldownUntil: entry.cooldownUntil > 0 ? resetText(entry.cooldownUntil) : "",
				unconfigured: !entry.configured,
				periodEnds: dateText(plan?.currentPeriodEnd ?? 0),
				active: entry.active,
				monthly: monthlyView(report),
				windows,
				stats,
				usagePeriod: usage === void 0 ? "" : usageRange ? `${t("usageBillingPeriod")} ${usageRange}` : t("usagePeriodUnknown")
			};
		}
		/** The report-level failure box, or undefined when the report is usable. */
		function failureView(state) {
			const blockedEntry = state.report?.accounts.find((entry) => entry.report.blocked !== void 0);
			const blocked = blockedEntry?.report.blocked;
			const detail = (blockedEntry?.report.failures ?? []).join(" · ");
			if (blocked === "invalid-key") return {
				title: "errorInvalidKey",
				hint: "errorInvalidKeyHint",
				detail
			};
			if (blocked === "service-unavailable") return {
				title: "errorServiceUnavailable",
				hint: "errorServiceUnavailableHint",
				detail
			};
			if (blocked === "network") return {
				title: "errorNetwork",
				hint: "errorNetworkHint",
				detail
			};
			if (blocked === "invalid-response") return {
				title: "errorInvalidResponse",
				hint: "errorInvalidResponseHint",
				detail
			};
			if (state.status === "error" && state.report === void 0) return {
				title: "errorGeneric",
				hint: "errorGeneric",
				detail: state.error ?? ""
			};
		}
		/**
		* Every panel string, resolved once per projection through the translator. One
		* object with all keys (rather than per-field lookups in the components) keeps
		* the copy table and the render sites in lockstep: a key cannot be read from
		* `text` unless {@link PANEL_KEYS} declares it.
		*/
		function panelStrings(t) {
			const out = {};
			for (const key of PANEL_KEYS) out[key] = t(key);
			return out;
		}
		/**
		* Project the shared usage snapshot into the panel's render tree.
		*
		* Deduplication matches the settings card: hand-edited settings can name one
		* credential twice.
		*/
		function buildPanelView(input) {
			const { usage } = input;
			const t = input.t ?? panelTextEN;
			const seen = /* @__PURE__ */ new Set();
			const entries = (usage.report?.accounts ?? []).filter((entry) => {
				if (seen.has(entry.id)) return false;
				seen.add(entry.id);
				return true;
			});
			const accounts = entries.map((entry) => accountView(entry, t));
			const selectedEntry = entries.find((entry) => entry.active) ?? entries[0];
			const selectedView = accounts.find((view) => view.id === selectedEntry?.id);
			const footerBars = [];
			const windowBars = [["fiveHourShort", selectedEntry?.report.credits?.fiveHour], ["weeklyShort", selectedEntry?.report.credits?.weekly]];
			for (const [label, window] of windowBars) {
				if (window === void 0 || window.cap <= 0) continue;
				const percent = rawPercent(window.used, window.cap);
				footerBars.push({
					label,
					percent: `${percent}%`,
					barPercent: barPercent(percent),
					warn: window.exceeded,
					detail: `${money$1(window.used)} / ${money$1(window.cap)}`
				});
			}
			const totalCost = selectedEntry?.report.usage?.totalCost;
			const cost = totalCost === void 0 ? "" : money$1(totalCost);
			let status = "";
			if (entries.length > 0 && !entries.some((entry) => entry.configured)) status = t("unconfigured");
			else if (selectedView?.mark !== void 0 && selectedView.mark !== "active") status = t(selectedView.mark);
			else if (selectedEntry === void 0) status = t("unavailable");
			const planName = selectedView !== void 0 && selectedView.planName !== "" ? selectedView.planName : t("nav");
			const titleParts = planName === t("nav") ? [planName] : [t("nav"), planName];
			for (const bar of footerBars) {
				const figures = bar.detail === "" ? "" : ` ${bar.detail}`;
				titleParts.push(`${t(bar.label)}${figures} (${bar.percent})`);
			}
			if (cost !== "") titleParts.push(`${t("spend")} ${cost}`);
			return {
				text: panelStrings(t),
				planName,
				status,
				footerBars,
				cost,
				footTitle: titleParts.join(" · "),
				accounts,
				selectedId: selectedEntry?.id,
				selected: selectedView,
				loading: usage.status === "loading" && usage.report === void 0,
				noKey: entries.length > 0 && !entries.some((entry) => entry.configured),
				failure: failureView(usage),
				staleError: usage.status === "error" && usage.report !== void 0 ? usage.error ?? "" : void 0,
				partial: usage.report?.accounts.some((entry) => entry.report.failures.length > 0 && entry.report.blocked === void 0) ?? false ? "partial" : void 0,
				updatedAt: timeText(usage.fetchedAt ?? 0)
			};
		}
		/**
		* How often the panel re-reads the report while a surface is mounted. The quota
		* windows move slowly and one report costs four upstream calls, so this is a
		* background freshness tick, not a live meter.
		*/
		const PANEL_AUTO_REFRESH_MS = 12e4;
		/** The default timer (the client bundle runs in a browser; node tests inject one). */
		const REAL_TIMER = {
			set: (callback, ms) => setTimeout(callback, ms),
			clear: (handle) => clearTimeout(handle)
		};
		const DOCUMENT_VISIBILITY = {
			isVisible: () => typeof document === "undefined" ? true : document.visibilityState !== "hidden",
			subscribe: (onChange) => {
				if (typeof document === "undefined") return () => void 0;
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}
		};
		/** Live mount count of {@link startPanelAutoRefresh}. */
		let references = 0;
		/** Owner ticket of the running loop, if any. */
		let activeTicket;
		/** Ticket handed to the next starter. */
		let ticketSeq = 0;
		/** Pending timer handle of the running loop. */
		let handle;
		/**
		* Unsubscribe of the visibility listener owned by the RUNNING loop.
		*
		* Module-level on purpose: only the surface that started the loop receives the
		* subscribe handle, but that surface is not necessarily the last to unmount.
		* Keeping the handle on the same layer as `activeTicket`/`handle` lets any
		* teardown order release it; a function-local handle leaked the listener
		* whenever the starter unmounted first.
		*/
		let visibilityUnsubscribe;
		/**
		* Start the shared auto refresh. One fetch when the surface appears (the sidebar
		* row is the point of the panel — it must be current, not wait for a click), then
		* a tick every {@link PANEL_AUTO_REFRESH_MS} while a surface stays mounted.
		*
		* Reference-counted: the sidebar entry and the dashboard can be mounted at once,
		* so only the first start fetches and only the last stop halts the loop. Every
		* tick goes through `usage.refresh()`, which collapses a concurrent fetch onto
		* the in-flight one. Returns the disposer that drops this surface's reference.
		*
		* A hidden document is still mounted, so its ticks are SKIPPED: a background
		* tab must not keep paying for a four-call report nobody reads. The tick is
		* rescheduled either way, so the loop survives, and becoming visible again
		* fetches at once — the data on screen is by then older than a tick would have
		* left it. The first paint still fetches unconditionally: it is the moment the
		* row appears, and there is nothing to show without it.
		*
		* @param usage - the shared usage controller.
		* @param isConfigured - whether a credential exists right now (re-read per tick).
		* @param timer - timer seam for tests.
		* @param visibility - visibility seam; see {@link AutoRefreshVisibility}.
		*/
		function startPanelAutoRefresh(usage, isConfigured, timer = REAL_TIMER, visibility = DOCUMENT_VISIBILITY) {
			references += 1;
			const ticket = ++ticketSeq;
			const fetch = () => {
				if (isConfigured()) usage.refresh({ auto: true });
			};
			const tick = () => {
				if (activeTicket !== ticket) return;
				if (visibility.isVisible()) fetch();
				handle = timer.set(tick, PANEL_AUTO_REFRESH_MS);
			};
			if (activeTicket === void 0) {
				activeTicket = ticket;
				handle = timer.set(tick, PANEL_AUTO_REFRESH_MS);
				fetch();
				visibilityUnsubscribe = visibility.subscribe?.(() => {
					if (activeTicket !== ticket || !visibility.isVisible()) return;
					fetch();
				});
			}
			let stopped = false;
			return () => {
				if (stopped) return;
				stopped = true;
				references -= 1;
				if (references > 0) return;
				activeTicket = void 0;
				visibilityUnsubscribe?.();
				visibilityUnsubscribe = void 0;
				if (handle !== void 0) {
					timer.clear(handle);
					handle = void 0;
				}
			};
		}
		//#endregion
		//#region src/analytics-wire.ts
		const g = makeBoundaryValidator("commandcode/analytics");
		const nonnegative = (s, k) => {
			const n = g.numberField(s, k, k);
			return n >= 0 ? n : g.reject(k);
		};
		const count$1 = (s, k) => {
			const n = nonnegative(s, k);
			return Number.isSafeInteger(n) ? n : g.reject(k);
		};
		function parseAnalyticsQuery(value) {
			const s = g.record(value, "query");
			if (s.mode === "recent") {
				const limit = count$1(s, "limit");
				if (limit < 1 || limit > 100) return g.reject("limit");
				return {
					mode: "recent",
					limit
				};
			}
			if (s.mode !== "range") return g.reject("mode");
			const from = count$1(s, "from"), to = count$1(s, "to");
			if (to <= from || to - from > 316224e5 || to > 864e13) return g.reject("range");
			return {
				mode: "range",
				from,
				to
			};
		}
		const counts = [
			"sessions",
			"requests",
			"completed",
			"failed",
			"cancelled",
			"unknown",
			"retries",
			"usageSamples",
			"pricedRequests",
			"latencySamples",
			"ttftSamples",
			"decodeSamples"
		];
		const quantities = [
			"cost",
			"latencyMs",
			"ttftMs",
			"decodeMs",
			"decodeTokens"
		];
		const tokenKeys = [
			"uncachedInputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens"
		];
		function metrics(value) {
			const s = g.record(value, "metrics"), result = {};
			for (const k of counts) result[k] = count$1(s, k);
			for (const k of quantities) result[k] = nonnegative(s, k);
			const tokens = g.record(s.tokens, "tokens");
			result.tokens = Object.fromEntries(tokenKeys.map((k) => [k, nonnegative(tokens, k)]));
			if (result.completed + result.failed + result.cancelled + result.unknown !== result.requests || result.pricedRequests > result.usageSamples || result.usageSamples > result.requests || result.retries > result.requests || result.ttftSamples > result.requests || result.latencySamples > result.requests || result.decodeSamples > result.requests) return g.reject("coverage");
			return result;
		}
		const nullable = (s, k) => s[k] === null ? null : nonnegative(s, k);
		function parseAnalyticsReport(value) {
			const s = g.record(value, "report");
			if (s.status !== "ready" && s.status !== "unavailable") return g.reject("status");
			if (!Array.isArray(s.models) || !Array.isArray(s.scenarios) || s.models.length > 1e3 || s.scenarios.length > 1e3) return g.reject("models");
			return {
				generatedAt: count$1(s, "generatedAt"),
				pricingKey: count$1(s, "pricingKey"),
				query: parseAnalyticsQuery(s.query),
				status: s.status,
				scannedSessions: count$1(s, "scannedSessions"),
				matchedSessions: count$1(s, "matchedSessions"),
				unreadableSessions: count$1(s, "unreadableSessions"),
				skippedSessions: count$1(s, "skippedSessions"),
				truncated: g.booleanField(s, "truncated", "truncated"),
				catalogUnavailable: g.booleanField(s, "catalogUnavailable", "catalogUnavailable"),
				totals: metrics(s.totals),
				monthlyEstimate: nullable(s, "monthlyEstimate"),
				models: s.models.map((value) => {
					const m = g.record(value, "model");
					return {
						...metrics(m),
						id: g.stringField(m, "id", "id")
					};
				}),
				scenarios: s.scenarios.map((value) => {
					const m = g.record(value, "scenario");
					if (!Array.isArray(m.efforts) || !m.efforts.every((v) => typeof v === "string")) return g.reject("efforts");
					return {
						id: g.stringField(m, "id", "id"),
						name: g.stringField(m, "name", "name"),
						contextWindow: nullable(m, "contextWindow"),
						images: g.booleanField(m, "images", "images"),
						efforts: m.efforts,
						cost: nonnegative(m, "cost"),
						pricedRequests: count$1(m, "pricedRequests"),
						excludedRequests: count$1(m, "excludedRequests"),
						unknownRequests: count$1(m, "unknownRequests")
					};
				})
			};
		}
		const ANALYTICS_REMOTE_CONTRIBUTION = {
			package: REMOTE_PACKAGE,
			descriptors: [{
				...makeRemoteDescriptor("commandcode/analytics", "analytics", `${REMOTE_PACKAGE}#AnalyticsReport`, { parse: parseAnalyticsReport }),
				parameters: [{
					name: "query",
					wire: "query",
					source: "json",
					codec: makeStrictCodec(`${REMOTE_PACKAGE}#AnalyticsQuery`, { parse: parseAnalyticsQuery })
				}]
			}]
		};
		//#endregion
		//#region src/client/analytics-comparison.ts
		function coverageReason(report, scenario) {
			if (report.status !== "ready") return "unavailable";
			if (report.truncated || report.unreadableSessions > 0 || report.skippedSessions > 0) return "partial";
			if (report.totals.requests === 0) return "empty";
			if (scenario.excludedRequests > 0) return "excluded";
			if (scenario.unknownRequests > 0 || scenario.pricedRequests !== report.totals.requests) return "coverage";
		}
		function compareScenario(report, scenario) {
			const reason = coverageReason(report, scenario);
			let monthly;
			if (reason) monthly = {
				value: null,
				reason
			};
			else if (report.query.mode !== "range") monthly = {
				value: null,
				reason: "recent"
			};
			else {
				const elapsed = Math.min(report.query.to, report.generatedAt) - report.query.from;
				monthly = elapsed >= 864e5 ? { value: scenario.cost * (2592e6 / elapsed) } : {
					value: null,
					reason: "short-range"
				};
			}
			const comparisonReason = reason ?? (report.totals.pricedRequests !== report.totals.requests ? "baseline" : void 0);
			const difference = comparisonReason ? {
				value: null,
				reason: comparisonReason
			} : { value: scenario.cost - report.totals.cost };
			return {
				monthly,
				difference,
				differencePercent: difference.value !== null && report.totals.cost > 0 ? difference.value / report.totals.cost * 100 : null
			};
		}
		//#endregion
		//#region src/client/analytics-view.tsx
		/** 只展示数字快照；筛选提交后才查询，页签、展开与模型筛选不触发历史读取。 */
		function localDate(time) {
			const d = new Date(time);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		/** 日期按用户本地日历展开为半开区间；截止日包括当日全部时间，夏令时不固定加 24 小时。 */
		function dateRange(from, to) {
			const start = /* @__PURE__ */ new Date(`${from}T00:00:00`), end = /* @__PURE__ */ new Date(`${to}T00:00:00`);
			if (localDate(start.getTime()) !== from || localDate(end.getTime()) !== to) throw new TypeError("无效日期");
			end.setDate(end.getDate() + 1);
			return parseAnalyticsQuery({
				mode: "range",
				from: start.getTime(),
				to: end.getTime()
			});
		}
		const money = (n) => `$${n.toFixed(4)}`;
		const digits = (n) => n.toLocaleString();
		const meanSeconds = (ms, samples, text) => samples ? `${(ms / samples / 1e3).toFixed(2)} ${text("analysisSeconds")}` : text("analysisMissing");
		const speed = (m, text) => m.decodeSamples && m.decodeMs ? `${(m.decodeTokens * 1e3 / m.decodeMs).toFixed(1)} ${text("analysisSpeedUnit")}` : text("analysisMissing");
		function effortName(effort, text) {
			const keys = {
				none: "effortNone",
				low: "effortLow",
				medium: "effortMedium",
				high: "effortHigh",
				xhigh: "effortXhigh",
				max: "effortMax"
			};
			return keys[effort] ? text(keys[effort]) : effort;
		}
		function Chevron() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: "ccp-analysisChevron",
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m9 5 7 7-7 7" })
			});
		}
		function AnalysisIcon({ kind }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: "ccp-analysisIcon",
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: kind === "info" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "9"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 11v6M12 7h.01" })] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "10.5",
					cy: "10.5",
					r: "6.5"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m16 16 4.5 4.5" })] })
			});
		}
		function Metric({ label, value, sub, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "ccp-analysisMetric",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-analysisLabel ccp-analysisMetricLabel",
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-analysisValue",
						children: value
					}),
					sub ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-analysisSub",
						children: sub
					}) : null,
					children
				]
			});
		}
		/** 只比较已知成本；没有计价样本或已知小计为零时，不制造百分比。 */
		function knownCostShare(m, totalCost) {
			return m.pricedRequests > 0 && totalCost > 0 ? m.cost / totalCost * 100 : null;
		}
		function CostShare({ m, totalCost, text }) {
			const share = knownCostShare(m, totalCost);
			if (share === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "ccp-analysisSub",
				children: text("analysisNoShare")
			});
			const percentage = `${share.toFixed(1)}%`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "ccp-analysisShare",
				title: `${text("analysisShareHint")} ${percentage}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "ccp-analysisShareTrack",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-analysisShareFill",
						style: { width: `${Math.min(100, Math.max(0, share))}%` }
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "ccp-analysisShareValue",
					children: percentage
				})]
			});
		}
		function DetailGroup({ title, values, text }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "ccp-analysisDetailGroup",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					className: "ccp-analysisDetailTitle",
					children: text(title)
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
					className: "ccp-analysisFacts",
					children: values.map(([key, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-analysisFact",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
							className: "ccp-analysisLabel",
							children: text(key)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: "ccp-analysisFactValue",
							children: value
						})]
					}, key))
				})]
			});
		}
		/** 样本为零时词元仍为未知；汇总和单模型复用相同口径，展开只改变展示。 */
		function MetricsDetails({ m, text }) {
			const tokens = m.tokens, tokenValue = (n) => m.usageSamples ? digits(n) : text("analysisMissing");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "ccp-analysisDetails",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisTokens",
						text,
						values: [
							["analysisInput", tokenValue(tokens.uncachedInputTokens)],
							["analysisOutput", tokenValue(tokens.outputTokens)],
							["analysisCacheRead", tokenValue(tokens.cacheReadTokens)],
							["analysisCacheWrite", tokenValue(tokens.cacheWriteTokens)]
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisOutcome",
						text,
						values: [
							["analysisCompleted", digits(m.completed)],
							["analysisFailed", digits(m.failed)],
							["analysisRetries", digits(m.retries)],
							["analysisCancelled", digits(m.cancelled)],
							["analysisUnknown", digits(m.unknown)]
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisSamples",
						text,
						values: [
							["analysisUsageSamples", digits(m.usageSamples)],
							["analysisPriced", digits(m.pricedRequests)],
							["analysisTimed", digits(m.latencySamples)],
							["analysisFirstTokenSamples", digits(m.ttftSamples)],
							["analysisDecodeSamples", digits(m.decodeSamples)]
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisSessionCost",
						text,
						values: [
							["analysisSessionCount", digits(m.sessions)],
							["analysisRequests", digits(m.requests)],
							["analysisAverage", m.sessions && m.pricedRequests ? money(m.cost / m.sessions) : text("analysisMissing")],
							["analysisSpeed", speed(m, text)]
						]
					})
				]
			});
		}
		function ModelRow({ m, name, totalCost, text }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "ccp-analysisModelRow",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
					className: "ccp-analysisModelSummary",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "ccp-analysisIdentity",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "ccp-analysisModelName",
									children: name || m.id
								}),
								name && name !== m.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "ccp-analysisSub",
									children: m.id
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "ccp-analysisSub ccp-analysisModelCount",
									children: [
										text("analysisRequests"),
										" ",
										digits(m.requests),
										" · ",
										text("analysisSessionCount"),
										" ",
										digits(m.sessions)
									]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisCostShare"),
							value: m.pricedRequests ? money(m.cost) : text("analysisMissing"),
							sub: `${text("analysisPriced")} ${m.pricedRequests}/${m.requests}`,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostShare, {
								m,
								totalCost,
								text
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisResponse"),
							value: meanSeconds(m.latencyMs, m.latencySamples, text)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisFirstToken"),
							value: meanSeconds(m.ttftMs, m.ttftSamples, text)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisSpeed"),
							value: speed(m, text)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, {})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MetricsDetails, {
					m,
					text
				})]
			});
		}
		const estimateReasonKeys = {
			unavailable: "analysisUnavailable",
			empty: "analysisNoRequests",
			partial: "analysisIncomplete",
			excluded: "analysisScenarioExcluded",
			coverage: "analysisScenarioUnpriced",
			baseline: "analysisBaselineUnpriced",
			recent: "analysisNeedRange",
			"short-range": "analysisShortRange"
		};
		const signedMoney = (n) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${money(Math.abs(n))}`;
		function ScenarioRow({ m, report, text }) {
			const { monthly, difference, differencePercent } = compareScenario(report, m);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "ccp-analysisModelRow",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
					className: "ccp-analysisScenarioSummary",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "ccp-analysisIdentity",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-analysisModelName",
								children: m.name
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-analysisSub",
								children: m.id
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisSimulationCost"),
							value: m.pricedRequests ? money(m.cost) : text("analysisMissing"),
							sub: `${text("analysisCoverage")} ${m.pricedRequests}/${report.totals.requests}`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisScenarioMonthly"),
							value: monthly.value === null ? text("analysisMissing") : money(monthly.value),
							sub: monthly.value === null ? text(estimateReasonKeys[monthly.reason]) : text("analysisUsd")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: text("analysisDifference"),
							value: difference.value === null ? text("analysisMissing") : signedMoney(difference.value),
							sub: difference.value === null ? text(estimateReasonKeys[difference.reason]) : differencePercent === null ? text("analysisZeroBaseline") : `${differencePercent > 0 ? "+" : ""}${differencePercent.toFixed(1)}%`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, {})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "ccp-analysisDetails ccp-analysisScenarioDetails",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisSamples",
						text,
						values: [
							["analysisPriced", digits(m.pricedRequests)],
							["analysisExcluded", digits(m.excludedRequests)],
							["analysisUnknownPrice", digits(m.unknownRequests)]
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailGroup, {
						title: "analysisCapabilities",
						text,
						values: [
							["analysisContext", m.contextWindow === null ? text("analysisMissing") : `${digits(m.contextWindow)} ${text("analysisTokenUnit")}`],
							["analysisInputType", text(m.images ? "analysisImages" : "analysisTextOnly")],
							["analysisEfforts", m.efforts.length ? m.efforts.map((e) => effortName(e, text)).join(", ") : text("analysisNoEfforts")]
						]
					})]
				})]
			});
		}
		function AnalyticsView(props) {
			const { text } = props, state = props.useCommandCodeAnalytics((s) => s), report = state.report;
			const [mode, setMode] = (0, react.useState)(report?.query.mode ?? "recent");
			const [limit, setLimit] = (0, react.useState)(report?.query.mode === "recent" ? String(report.query.limit) : "20");
			const [from, setFrom] = (0, react.useState)(localDate(report?.query.mode === "range" ? report.query.from : Date.now() - 25056e5));
			const [to, setTo] = (0, react.useState)(localDate(report?.query.mode === "range" ? report.query.to - 1 : Date.now()));
			const [invalid, setInvalid] = (0, react.useState)(false), [filter, setFilter] = (0, react.useState)("");
			const [page, setPage] = (0, react.useState)("history"), id = (0, react.useId)();
			const refresh = props.refreshAnalytics;
			(0, react.useEffect)(() => {
				if (state.status === "idle") refresh();
			}, [state.status, refresh]);
			const busy = state.status === "loading";
			const apply = () => {
				try {
					const query = mode === "recent" ? parseAnalyticsQuery({
						mode,
						limit: Number(limit)
					}) : dateRange(from, to);
					setInvalid(false);
					refresh(query);
				} catch {
					setInvalid(true);
				}
			};
			const navigateTab = (event) => {
				if (![
					"ArrowLeft",
					"ArrowRight",
					"Home",
					"End"
				].includes(event.key)) return;
				event.preventDefault();
				const next = event.key === "Home" ? "history" : event.key === "End" ? "simulation" : page === "history" ? "simulation" : "history";
				setPage(next);
				event.currentTarget.querySelector(`[data-page="${next}"]`)?.focus();
			};
			const scenarios = report?.scenarios.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
			const names = new Map(report?.scenarios.map((m) => [m.id, m.name]));
			const m = report?.totals;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "ccp-analysis",
				"aria-label": text("analyticsNav"),
				"aria-busy": busy,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "ccp-analysisFilters",
						"data-mode": mode,
						noValidate: true,
						onSubmit: (e) => {
							e.preventDefault();
							if (!busy) apply();
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "ccp-analysisField ccp-analysisScopeField",
								children: [text("analysisScope"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "ccp-analysisSelectShell",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "ccp-analysisInput ccp-analysisSelect",
										value: mode,
										disabled: busy,
										onChange: (e) => setMode(e.target.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "recent",
											children: text("analysisRecent")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "range",
											children: text("analysisRange")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, {})]
								})]
							}),
							mode === "recent" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "ccp-analysisField",
								children: [text("analysisLimit"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "ccp-analysisInput",
									type: "number",
									min: "1",
									max: "100",
									required: true,
									value: limit,
									disabled: busy,
									onChange: (e) => setLimit(e.target.value)
								})]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "ccp-analysisField ccp-analysisDateField",
								children: [text("analysisFrom"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "ccp-analysisInput",
									type: "date",
									required: true,
									value: from,
									disabled: busy,
									onChange: (e) => setFrom(e.target.value)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "ccp-analysisField ccp-analysisDateField",
								children: [text("analysisTo"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "ccp-analysisInput",
									type: "date",
									required: true,
									value: to,
									disabled: busy,
									onChange: (e) => setTo(e.target.value)
								})]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "ccp-analysisApply",
								type: "submit",
								disabled: busy,
								children: text("analysisApply")
							})
						]
					}),
					invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "ccp-analysisMessage ccp-analysisError",
						role: "alert",
						children: text("analysisInvalid")
					}) : null,
					busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "ccp-analysisMessage",
						role: "status",
						children: text("analysisLoading")
					}) : null,
					state.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "ccp-analysisMessage ccp-analysisError",
						role: "alert",
						children: state.error
					}) : null,
					report?.status === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "ccp-analysisMessage",
						role: "status",
						children: text("analysisUnavailable")
					}) : null,
					report?.status === "ready" && m ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ccp-analysisScope",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								text("analysisScope"),
								": ",
								report.query.mode === "recent" ? `${text("analysisRecent")} ${report.query.limit}` : `${localDate(report.query.from)} — ${localDate(report.query.to - 1)}`
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								text("analysisScanned"),
								" ",
								report.scannedSessions,
								" · ",
								text("analysisMatched"),
								" ",
								report.matchedSessions,
								" · ",
								text("analysisUnreadable"),
								" ",
								report.unreadableSessions,
								" · ",
								text("analysisSkipped"),
								" ",
								report.skippedSessions
							] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ccp-analysisOverview",
							role: "group",
							"aria-label": text("analysisOverview"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
									label: text("analysisCost"),
									value: m.pricedRequests ? money(m.cost) : text("analysisMissing"),
									sub: `${text("analysisPriced")} ${m.pricedRequests}/${m.requests}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
									label: text("analysisRequests"),
									value: digits(m.requests),
									sub: `${text("analysisSessionCount")} ${digits(m.sessions)}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
									label: text("analysisResponse"),
									value: meanSeconds(m.latencyMs, m.latencySamples, text),
									sub: `${text("analysisTimed")} ${digits(m.latencySamples)}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
									label: text("analysisFirstToken"),
									value: meanSeconds(m.ttftMs, m.ttftSamples, text),
									sub: `${text("analysisFirstTokenSamples")} ${digits(m.ttftSamples)}`
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "ccp-analysisNote",
							children: text("analysisShortBasis")
						}),
						report.truncated || report.unreadableSessions > 0 || report.skippedSessions > 0 || m.pricedRequests < m.requests ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ccp-analysisMessage ccp-analysisWarning",
							role: "status",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AnalysisIcon, { kind: "info" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [report.truncated || report.unreadableSessions > 0 || report.skippedSessions > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: text("analysisPartial") }) : null, m.pricedRequests < m.requests ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: text("analysisUnpriced") }) : null] })]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "ccp-analysisTabs",
							role: "tablist",
							"aria-label": text("analysisSections"),
							onKeyDown: navigateTab,
							children: ["history", "simulation"].map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								className: "ccp-analysisTab",
								id: `${id}-${tab}-tab`,
								"data-page": tab,
								type: "button",
								role: "tab",
								"aria-selected": page === tab,
								"aria-controls": `${id}-${tab}`,
								tabIndex: page === tab ? 0 : -1,
								onClick: () => setPage(tab),
								children: [text(tab === "history" ? "analysisHistory" : "analysisSimulation"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "ccp-analysisTabCount",
									children: digits(tab === "history" ? report.models.length : report.scenarios.length)
								})]
							}, tab))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "ccp-analysisPanel",
							id: `${id}-history`,
							role: "tabpanel",
							"aria-labelledby": `${id}-history-tab`,
							tabIndex: 0,
							hidden: page !== "history",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-analysisSectionHead",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "ccp-analysisHeading",
										children: text("analysisByModel")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-analysisNote",
										children: text("analysisModelHint")
									})]
								}),
								m.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-analysisEmpty",
									children: text("analysisEmpty")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-analysisModels",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "ccp-analysisTableHead",
										"aria-hidden": "true",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisModel") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisCostShare") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisResponse") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisFirstToken") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisSpeed") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
										]
									}), report.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
										m: model,
										name: names.get(model.id),
										totalCost: m.cost,
										text
									}, model.id))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-analysisFooter",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
										className: "ccp-analysisAggregate",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
											className: "ccp-analysisDisclosure",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, {}), text("analysisDetails")]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MetricsDetails, {
											m,
											text
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "ccp-analysisMonthly",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisMonthly") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												className: "ccp-analysisMonthlyValue",
												children: report.monthlyEstimate === null || report.truncated || report.unreadableSessions || report.skippedSessions ? text("analysisMissing") : money(report.monthlyEstimate)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "ccp-analysisNote",
												children: text("analysisMonthlyHint")
											})
										]
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "ccp-analysisPanel",
							id: `${id}-simulation`,
							role: "tabpanel",
							"aria-labelledby": `${id}-simulation-tab`,
							tabIndex: 0,
							hidden: page !== "simulation",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-analysisAssumption",
									children: text("analysisAssumption")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "ccp-analysisNote ccp-analysisBaseline",
									children: [
										text("analysisBaseline"),
										": ",
										m.pricedRequests === m.requests && m.requests > 0 && !report.truncated && !report.unreadableSessions && !report.skippedSessions ? money(m.cost) : text("analysisMissing"),
										" · ",
										text("analysisMonthlyHint")
									]
								}),
								report.catalogUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-analysisMessage ccp-analysisWarning",
									role: "status",
									children: text("analysisCatalog")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-analysisSectionHead",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "ccp-analysisHeading",
										children: text("analysisSimulationHeading")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-analysisNote",
										children: text("analysisSimulationHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "ccp-analysisField ccp-analysisSearch",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "ccp-analysisSearchLabel",
											children: text("analysisSearch")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "ccp-analysisSearchShell",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AnalysisIcon, { kind: "search" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "ccp-analysisInput",
												type: "search",
												placeholder: text("analysisSearchPlaceholder"),
												value: filter,
												onChange: (e) => setFilter(e.target.value)
											})]
										})]
									})]
								}),
								m.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-analysisEmpty",
									children: text("analysisEmpty")
								}) : scenarios.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-analysisModels",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "ccp-analysisTableHead ccp-analysisScenarioHead",
										"aria-hidden": "true",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisModel") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisSimulationCost") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisScenarioMonthly") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text("analysisDifference") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
										]
									}), scenarios.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScenarioRow, {
										m: model,
										report,
										text
									}, model.id))]
								}) : !report.catalogUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-analysisEmpty",
									role: "status",
									children: text("analysisNoMatches")
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							className: "ccp-analysisRules",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
								className: "ccp-analysisDisclosure",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, {}), text("analysisRules")]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "ccp-analysisRulesBody",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: text("analysisBasis") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: text("analysisCoverageHint") })]
							})]
						})
					] }) : null
				]
			});
		}
		//#endregion
		//#region src/client/panel-view.tsx
		/**
		* React components for the Command Code plans & quota panel: the sidebar footer
		* card and the dashboard it opens in the center column.
		*
		* Both render one {@link PanelView} projected by `./panel.ts` — no fact is
		* derived here. Strings arrive already localized in `view.text`: the slots
		* declare the `panel.commandcode` locale namespace, so the renderer hands this
		* component a `t` seat that is passed into `buildPanelView`, and a language
		* switch mints a new `t` identity, which re-renders both surfaces.
		*
		* The footer card is the panel's home — the shell renders it in the foot area
		* directly above the Settings seat, and unlike a `sidebar.panellist` row (whose
		* chrome and label the SHELL owns) this entry owns its whole surface and
		* therefore calls `open()` itself. Styles ride the stylesheet
		* `./panel-styles.ts` returns; classes are `ccp-` prefixed.
		*
		* @module dsh-commandcode-provider/client/panel-view
		*/
		/** The panel's view, recomputed from both seats on every notification. */
		function usePanelView(props) {
			return buildPanelView({
				usage: props.useCommandCodeUsage((state) => state),
				apiKeyConfigured: props.useCommandCodeSettings((state) => state).anyAccountConfigured,
				t: props.t ?? panelTextEN
			});
		}
		/**
		* The quota ring. One glyph serves the rail button, the footer card's top row
		* and the dashboard header: a faint track plus an arc whose sweep is the
		* consumption, drawn from 12 o'clock. Circumference 2πr = 45.55 at r = 7.25.
		*/
		function Ring({ percent, warn, size }) {
			const clamped = Math.min(100, Math.max(0, percent));
			const circumference = 45.55;
			const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1e3) / 1e3;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "ccp-glyph",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 20 20",
					width: size,
					height: size,
					focusable: "false",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.5",
						opacity: "0.4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: warn ? "var(--dsw-alias-state-error-primary)" : "currentColor",
						strokeWidth: "2.5",
						strokeLinecap: "round",
						strokeDasharray: String(circumference),
						strokeDashoffset: String(dashoffset),
						transform: "rotate(-90 10 10)"
					})]
				})
			});
		}
		/** One labelled bar. `compact` drops the reset line; the footer draws its own. */
		function QuotaBar({ label, value, percent, barPercent, warn, resetsAt, resetsLabel }) {
			const clamped = Math.min(100, Math.max(0, barPercent));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "ccp-window",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-windowHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-windowLabel",
								children: label
							}),
							warn !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-warnTag",
								children: warn
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
							value !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-windowValue",
								children: value
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-windowPct",
								children: percent
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "ccp-bar",
						role: "progressbar",
						"aria-label": label,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuenow": clamped,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: warn !== "" ? "ccp-barFill ccp-barFillWarn" : "ccp-barFill",
							style: { width: `${clamped}%` }
						})
					}),
					resetsAt !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "ccp-windowReset",
						children: [
							resetsLabel,
							" ",
							resetsAt
						]
					}) : null
				]
			});
		}
		/** A labelled figure. */
		function Tile({ label, value, sub, title }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "ccp-tile",
				title,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-tileLabel",
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-tileValue",
						children: value
					}),
					sub !== void 0 && sub !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-tileSub",
						children: sub
					}) : null
				]
			});
		}
		/** The rotation/credential badge line for one account. */
		function markText(account, text) {
			if (account.mark === void 0) return "";
			if (account.mark === "coolingDown" && account.cooldownUntil !== "") return `${text("coolingDown")} · ${account.cooldownUntil}`;
			return text(account.mark);
		}
		/** `Default account` → `D`; used for the card's monogram chip. */
		function initial(label) {
			const trimmed = label.trim();
			return trimmed === "" ? "?" : trimmed[0].toUpperCase();
		}
		/**
		* One account's full report: the monthly limit/usage bar, the two quota
		* windows, then the credit and usage totals.
		*/
		function AccountCard({ account, view }) {
			const text = (key) => view.text[key] ?? key;
			const mark = markText(account, text);
			const monthly = account.monthly;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "ccp-card",
				"aria-label": account.label,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "ccp-cardHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-avatar",
								"aria-hidden": "true",
								children: initial(account.label)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "ccp-cardIdentity",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "ccp-cardTitle",
									children: account.label
								}), account.owner !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "ccp-cardOwner",
									children: account.owner
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
							account.planName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-badge",
								children: account.planName
							}) : null,
							account.planStatus !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-badge ccp-badgeWarn",
								children: account.planStatus
							}) : null,
							mark !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: account.mark === "invalidKey" ? "ccp-badge ccp-badgeError" : "ccp-badgeMuted",
								children: mark
							}) : null,
							account.periodEnds !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "ccp-meta",
								children: [
									text("periodEnds"),
									" ",
									account.periodEnds
								]
							}) : null
						]
					}),
					account.unconfigured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "ccp-hint",
						children: text("unconfigured")
					}) : null,
					monthly !== void 0 && monthly.known ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
						label: text("monthly"),
						value: `${monthly.used} / ${monthly.limit}`,
						percent: `${monthly.percent}%`,
						barPercent: monthly.barPercent,
						warn: monthly.exhausted ? text("exhausted") : "",
						resetsAt: "",
						resetsLabel: ""
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-planRow",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-fieldLabel",
							children: text("plan")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-planName",
							children: account.planName !== "" ? account.planName : text("unavailable")
						})]
					}),
					monthly !== void 0 && monthly.remaining !== "—" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-planRow",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-fieldLabel",
							children: text("remaining")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-planName",
							children: monthly.remaining
						})]
					}) : null,
					account.windows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "ccp-windows",
						children: account.windows.map((window) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
							label: text(window.label),
							value: window.value,
							percent: window.capped ? `${window.percent}%` : text("windowUnlimited"),
							barPercent: window.barPercent,
							warn: window.exceeded ? text("exceeded") : "",
							resetsAt: window.resetsAt,
							resetsLabel: text("resets")
						}, window.label))
					}) : null,
					monthly !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-block",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							className: "ccp-blockTitle",
							children: text("credits")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ccp-tiles",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text("monthlyLimit"),
									value: monthly.limit
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text("monthlyUsed"),
									value: monthly.used
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text("remaining"),
									value: monthly.remaining
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text("purchased"),
									value: monthly.purchased
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text("free"),
									value: monthly.free
								})
							]
						})]
					}) : null,
					account.stats.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "ccp-block",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								className: "ccp-blockTitle",
								children: text("usage")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "ccp-windowReset",
								children: account.usagePeriod
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "ccp-tiles",
								children: account.stats.map((stat) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
									label: text(stat.label),
									value: stat.value,
									sub: stat.sub,
									title: stat.title
								}, stat.label))
							})
						]
					}) : null
				]
			});
		}
		/**
		* The center-column dashboard, registered into the layout's keyed `main` slot
		* under the same id the footer card selects, so the two are one navigation
		* entry: the card shows the plan, the monthly bar and the quota window; the
		* panel shows everything, including the per-account breakdown.
		*/
		function CommandCodePanel(props) {
			const view = usePanelView(props);
			const [fallbackMode, setFallbackMode] = (0, react.useState)("quota");
			const mode = props.useCommandCodePanelMode?.((s) => s) ?? fallbackMode;
			const analyticsBusy = props.useCommandCodeAnalytics?.((s) => s.status === "loading") ?? false;
			const selectMode = (next) => {
				setFallbackMode(next);
				props.selectPanelMode?.(next);
			};
			const text = (key) => view.text[key] ?? key;
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const startAutoRefresh = props.startAutoRefresh;
			(0, react.useEffect)(() => mode === "quota" ? startAutoRefresh() : void 0, [startAutoRefresh, mode]);
			const accounts = view.accounts;
			const selected = accounts.find((account) => account.id === selectedId) ?? view.selected ?? accounts[0];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "ccp-main",
				role: "region",
				"aria-label": text("nav"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `ccp-mainInner${mode === "analysis" ? " ccp-mainInnerAnalysis" : ""}`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "ccp-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-headerText",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: "ccp-title",
										children: mode === "analysis" ? `Command Code · ${text("analyticsNav")}` : text("nav")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-subtitle",
										children: text(mode === "quota" ? "subtitle" : "analysisIntro")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
								mode === "quota" && view.updatedAt !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "ccp-meta",
									children: [
										text("updated"),
										" ",
										view.updatedAt
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									disabled: mode === "quota" ? view.loading : analyticsBusy,
									onClick: () => mode === "quota" ? props.refresh() : props.refreshAnalytics?.(),
									children: mode === "quota" && view.loading ? text("refreshing") : text("refresh")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									className: "ccp-close",
									"aria-label": text("close"),
									title: text("closeHint"),
									onClick: () => props.close(),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
										width: "16",
										height: "16",
										viewBox: "0 0 24 24",
										fill: "none",
										stroke: "currentColor",
										strokeWidth: "1.6",
										strokeLinecap: "round",
										"aria-hidden": "true",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m6 6 12 12M18 6 6 18" })
									})
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
							className: "ccp-tabs",
							"aria-label": text("nav"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: mode === "quota" ? "ccp-tab ccp-tabActive" : "ccp-tab",
								type: "button",
								"aria-pressed": mode === "quota",
								onClick: () => selectMode("quota"),
								children: text("quotaNav")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: mode === "analysis" ? "ccp-tab ccp-tabActive" : "ccp-tab",
								type: "button",
								"aria-pressed": mode === "analysis",
								onClick: () => selectMode("analysis"),
								children: text("analyticsNav")
							})]
						}),
						mode === "analysis" ? props.useCommandCodeAnalytics && props.refreshAnalytics ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AnalyticsView, {
							useCommandCodeAnalytics: props.useCommandCodeAnalytics,
							refreshAnalytics: props.refreshAnalytics,
							text
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "ccp-hint",
							children: text("analysisUnavailable")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							view.noKey ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "ccp-notice",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-noticeTitle",
									children: text("noKey")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "ccp-noticeHint",
									children: text("noKeyHint")
								})]
							}) : null,
							view.failure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "ccp-notice ccp-noticeError",
								role: "alert",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-noticeTitle",
										children: text(view.failure.title)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-noticeHint",
										children: text(view.failure.hint)
									}),
									view.failure.detail !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-noticeDetail",
										children: view.failure.detail
									}) : null
								]
							}) : null,
							!view.noKey && view.failure === void 0 && accounts.length === 0 && view.loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "ccp-hint",
								children: text("loading")
							}) : null,
							view.staleError !== void 0 && view.staleError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "ccp-hint",
								role: "status",
								children: [
									text("errorGeneric"),
									" — ",
									view.staleError
								]
							}) : null,
							accounts.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "ccp-tabs",
								role: "tablist",
								"aria-label": text("nav"),
								children: accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": selected?.id === account.id,
									className: selected?.id === account.id ? "ccp-tab ccp-tabActive" : "ccp-tab",
									onClick: () => setSelectedId(account.id),
									children: account.label
								}, account.id))
							}) : null,
							selected !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountCard, {
								account: selected,
								view
							}) : null,
							view.partial !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "ccp-hint",
								children: text(view.partial)
							}) : null
						] })
					]
				})
			});
		}
		/**
		* The sidebar footer card, registered into `sidebar.footer.action` — the list
		* the shell renders in the foot area directly ABOVE the Settings seat, so the
		* panel reads as a bottom-pinned sibling of Settings rather than a global panel
		* icon at the top of the column.
		*
		* The shell wraps nothing here, so this component owns the surface: the button,
		* its chrome and its accessible name. Expanded, it draws the title row and one
		* block per quota window (5-hour, then weekly) — the window's own spend and
		* limit, its percentage and its bar — and nothing else, because those two
		* windows are the figures an account runs into, so the period total stays in the
		* tooltip. In the 56px rail it collapses to a 36px icon button carrying the ring,
		* matching the shell's own rail geometry; `wide` comes from the shell.
		*
		* Rendering is gated on the settings page's `showSidebarQuota` toggle, which
		* defaults OFF: a fresh install shows no quota surface in the sidebar and runs
		* no background poll. The gate reads the STORED document (the settings
		* controller's `sidebarQuota` fact), so an unsaved draft cannot show the card
		* while a landed save flips it live. The entry stays REGISTERED — this is a
		* render decision, so nothing churns the slot ledger.
		*/
		function CommandCodeFooterEntry(props) {
			const visible = props.useCommandCodeSettings((snapshot) => snapshot.sidebarQuota);
			const view = usePanelView(props);
			const startAutoRefresh = props.startAutoRefresh;
			(0, react.useEffect)(() => {
				if (!visible) return void 0;
				return startAutoRefresh();
			}, [visible, startAutoRefresh]);
			if (!visible) return null;
			const text = (key) => view.text[key] ?? key;
			const headline = view.footerBars[0];
			const title = view.footTitle;
			if (!props.wide) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "ccp-railButton",
				"aria-label": title,
				title,
				onClick: () => props.open(),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
					percent: headline?.barPercent ?? 0,
					warn: headline?.warn ?? false,
					size: 18
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "ccp-foot",
				"aria-label": title,
				title,
				onClick: () => props.open(),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "ccp-footTop",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
							percent: headline?.barPercent ?? 0,
							warn: headline?.warn ?? false,
							size: 16
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-footName",
							children: text("nav")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
						view.status !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-badgeMuted",
							children: view.status
						}) : view.planName !== text("nav") ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "ccp-badge",
							children: view.planName
						}) : null
					]
				}), view.footerBars.map((bar) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "ccp-footRow",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "ccp-footHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-footLabel",
								children: text(bar.label)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
							bar.detail !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-footAmount",
								children: bar.detail
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "ccp-footPct",
								children: bar.percent
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "ccp-footBar",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: bar.warn ? "ccp-footFill ccp-footFillWarn" : "ccp-footFill",
							style: { width: `${bar.barPercent}%` }
						})
					})]
				}, bar.label))]
			});
		}
		//#endregion
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
		function requestRates(price, at, contextTokens, table, peakHourCache) {
			const tier = price.contextTiers?.find((tier) => tier.maxContext === void 0 || contextTokens <= tier.maxContext);
			if (tier !== void 0) return tier;
			if (price.peak === void 0 || at === null) return price;
			let peak = peakHourCache?.get(at);
			if (peak === void 0) {
				peak = peakHour(at, table.peakHours);
				peakHourCache?.set(at, peak);
			}
			return peak ? price.peak : price;
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
		//#endregion
		//#region src/client/session-cost.ts
		/**
		* Session-cost view model for the composer readout.
		*
		* JSX-free and React-free, mirroring `./panel.ts`: it turns the session's token
		* accounting plus the Host's price table into one presentation value AND the
		* exact text the two surfaces of the harness's token-usage UI receive — the
		* amount appended to the shipped pill, and the rows appended to the shipped
		* usage dialog. Node tests therefore drive the whole calculation, and every
		* user-visible string, without a DOM.
		*
		* It prices the session's DURABLE cumulative buckets, which is what the
		* composer's own "N tokens" pill reads too (`tokenUsage`), so the two surfaces
		* can never disagree about how much was used. Dollars are computed here because
		* Command Code publishes per-token rates and bills against dollar-denominated
		* windows; the account's own reported `totalCost` is a billing PERIOD figure,
		* not this session's.
		*
		* Three rules are load-bearing: only Command Code usage is priced (a session
		* served by another provider must render nothing, never a Command Code
		* estimate); a missing rate is never invented (the pricing page publishes a
		* cache-WRITE rate for only some models, so unpriced cache-write tokens are
		* surfaced as such rather than charged at a guessed multiple of the input rate);
		* and unpriceable means invisible — a confident `$0.00` would be a lie, and
		* this module never returns one.
		*
		* @module dsh-commandcode-provider/client/session-cost
		*/
		/** Tokens per published rate unit — the pricing page quotes USD per million. */
		const TOKENS_PER_RATE_UNIT = 1e6;
		/** The provider route whose usage this surface prices. */
		const COMMANDCODE_PROVIDER = "commandcode";
		/**
		* The English copy for this surface.
		*
		* A plain constant, NOT the `settings.commandcode` locale namespace: like the
		* plans & quota panel, the readout stays English on a Chinese harness. Do not
		* route it through `ctx.locale`.
		*/
		const SESSION_COST_COPY = {
			/** Shown instead of an amount when the model costs nothing on every plan. */
			free: "Free",
			/**
			* The separator the readout prefixes itself with, so the cost reads as the
			* last item of the token-usage pill's text run rather than a control beside
			* it. Rendered with the same colour and margins the shipped pill uses
			* between its own items.
			*/
			separator: "·",
			panelTitle: "Session cost",
			/** Marks an estimate from published rates rather than an invoice. */
			approximate: "≈",
			unpricedCacheWrite: "cache write tokens have no published rate",
			/** Tooltip line naming the rate half in force. */
			peakRates: "peak rates",
			offPeakRates: "off-peak rates",
			/** Tooltip line explaining the approximate marker. */
			approximateNote: "estimate from published rates, not the provider invoice",
			/** Row/tooltip label for uncached prompt tokens. */
			uncachedInput: "uncached input",
			/** Row/tooltip label for completion tokens. */
			output: "output",
			/** Row/tooltip label for cache-served input tokens. */
			cacheRead: "cache read",
			/** Row/tooltip label for cache-written input tokens. */
			cacheWrite: "cache write"
		};
		/** A finite, non-negative count — anything else reads as absent. */
		function count(value) {
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
		}
		/**
		* Index a price table for lookup. Rows are keyed by catalog id and by pricing
		* slug, both exact and lowercased, because a session reports a catalog id while
		* a row no catalog model claims is served under the page's slug.
		*/
		function indexTable(table) {
			const index = /* @__PURE__ */ new Map();
			for (const price of table.models) for (const key of [price.id, price.slug]) {
				if (typeof key !== "string" || key === "") continue;
				if (!index.has(key)) index.set(key, price);
				const lower = key.toLowerCase();
				if (!index.has(lower)) index.set(lower, price);
			}
			return index;
		}
		function costOf(usage, rates, free) {
			if (free) return {
				uncachedInput: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 0,
				total: 0,
				unpricedCacheWriteTokens: 0
			};
			const perUnit = (tokens, rate) => tokens * rate / TOKENS_PER_RATE_UNIT;
			const uncachedInput = perUnit(count(usage.uncachedInputTokens), rates.inputCost);
			const output = perUnit(count(usage.outputTokens), rates.outputCost);
			const cacheRead = perUnit(count(usage.cacheReadTokens), rates.cacheReadCost);
			const cacheWriteTokens = count(usage.cacheWriteTokens);
			const cacheWrite = rates.cacheWriteCost === void 0 ? void 0 : perUnit(cacheWriteTokens, rates.cacheWriteCost);
			return {
				uncachedInput,
				cacheRead,
				cacheWrite,
				output,
				total: uncachedInput + output + cacheRead + (cacheWrite ?? 0),
				unpricedCacheWriteTokens: rates.cacheWriteCost === void 0 ? cacheWriteTokens : 0
			};
		}
		/**
		* Amount text for a session cost.
		*
		* The panel's `money()` convention (2 decimals, 4 below a cent) is right for
		* billing windows, but a live session total starts far below a cent, where
		* `toFixed(4)` would print a flat `$0.0000` — broken rather than small. So a
		* total under $0.0001 is stated as a bound instead.
		*/
		function sessionCostAmount(total) {
			if (!Number.isFinite(total) || total <= 0) return formatMoney(0);
			if (total < 1e-4) return `<$0.0001`;
			return total < .01 ? formatMoneyExact(total) : formatMoney(total);
		}
		/** One `label value` clause of the tooltip. */
		function clause(label, tokens) {
			return tokens > 0 ? `${label} ${formatTokensCompact(tokens)}` : void 0;
		}
		/**
		* Build the composer readout, or undefined when there is nothing honest to show.
		*
		* Undefined is the correct answer for a session with no usage yet, a session
		* another provider served, a model the price table does not know, and a table
		* that has not landed — the pill simply is not there.
		*/
		function buildSessionCostView(input) {
			const { usage, table, facts } = input;
			if (!usage || !table || !facts || facts.pricingKey !== pricingKey(table)) return void 0;
			const totals = zeroCostTokens();
			const index = indexTable(table);
			const breakdown = {
				uncachedInput: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 0,
				total: 0,
				unpricedCacheWriteTokens: 0
			};
			let free = true;
			let peak = false;
			let partial = false;
			let priced = false;
			const notes = [];
			for (const group of facts.groups) {
				for (const key of COST_TOKEN_KEYS) totals[key] += group.tokens[key];
				if (group.provider !== COMMANDCODE_PROVIDER) {
					partial = true;
					continue;
				}
				const price = index.get(group.model);
				if (!price) {
					partial = true;
					continue;
				}
				const isFree = price.free === true;
				free &&= isFree;
				if (price.peak && group.at === null) {
					partial = true;
					notes.push("request time unavailable; off-peak lower bound");
				}
				const rates = requestRates(price, group.at, group.contextTokens, table);
				const part = costOf(group.tokens, rates, isFree);
				priced ||= isFree || part.total > 0;
				for (const key of [
					"uncachedInput",
					"cacheRead",
					"output",
					"total",
					"unpricedCacheWriteTokens"
				]) breakdown[key] += part[key];
				breakdown.cacheWrite = (breakdown.cacheWrite ?? 0) + (part.cacheWrite ?? 0);
				if (price.peak) {
					const isPeak = group.at !== null && peakHour(group.at, table.peakHours);
					peak ||= isPeak;
					notes.push(isPeak ? SESSION_COST_COPY.peakRates : SESSION_COST_COPY.offPeakRates);
				}
			}
			const summary = facts.summaryTokens ?? zeroCostTokens();
			if (COST_TOKEN_KEYS.some((key) => totals[key] - summary[key] !== count(usage[key])) || !priced) return void 0;
			const { total, unpricedCacheWriteTokens } = breakdown;
			partial ||= unpricedCacheWriteTokens > 0;
			free &&= !partial;
			if (partial) notes.push("Command Code priced subtotal only; unpriced or other-provider usage excluded");
			notes.push(SESSION_COST_COPY.approximateNote);
			const uncachedInput = totals.uncachedInputTokens;
			const output = totals.outputTokens;
			const cacheRead = totals.cacheReadTokens;
			const cacheWrite = totals.cacheWriteTokens;
			if (uncachedInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return void 0;
			if (!free && total <= 0) return void 0;
			const value = free ? SESSION_COST_COPY.free : `${partial ? "≥" : SESSION_COST_COPY.approximate}${sessionCostAmount(total)}`;
			const money = (amount) => amount === void 0 ? void 0 : sessionCostAmount(amount);
			const rows = [
				{
					key: "uncachedInput",
					label: SESSION_COST_COPY.uncachedInput,
					tokens: uncachedInput,
					costText: money(breakdown.uncachedInput)
				},
				{
					key: "cacheRead",
					label: SESSION_COST_COPY.cacheRead,
					tokens: cacheRead,
					costText: money(breakdown.cacheRead)
				},
				{
					key: "cacheWrite",
					label: SESSION_COST_COPY.cacheWrite,
					tokens: cacheWrite,
					costText: unpricedCacheWriteTokens === cacheWrite && cacheWrite > 0 ? void 0 : money(breakdown.cacheWrite)
				},
				{
					key: "output",
					label: SESSION_COST_COPY.output,
					tokens: output,
					costText: money(breakdown.output)
				}
			];
			if (unpricedCacheWriteTokens > 0) notes.push(SESSION_COST_COPY.unpricedCacheWrite);
			return {
				total,
				value,
				title: [
					`${SESSION_COST_COPY.panelTitle} ${free ? SESSION_COST_COPY.free : sessionCostAmount(total)}`,
					clause(SESSION_COST_COPY.uncachedInput, uncachedInput),
					clause(SESSION_COST_COPY.output, output),
					clause(SESSION_COST_COPY.cacheRead, cacheRead),
					clause(SESSION_COST_COPY.cacheWrite, cacheWrite),
					...notes
				].filter((part) => part !== void 0).join(" · "),
				rows,
				notes: [...new Set(notes)],
				free,
				peak,
				unpricedCacheWriteTokens,
				approximate: !free
			};
		}
		/** Split the appended run into the two nodes the display creates. */
		function sessionCostPillRun(view) {
			return {
				separator: SESSION_COST_COPY.separator,
				value: view.value
			};
		}
		/**
		* Decorate the harness's usage dialog, row by row.
		*
		* The row sequence mirrors the shipped component's conditions exactly — the
		* cache-hit row exists while there is billed prompt input, the cache-write row
		* while those tokens are non-zero — because the display layer matches what it
		* finds positionally. A shape it cannot confirm is a shape it does not touch.
		*
		* A free model decorates nothing: every row's cost is zero by definition, the
		* pill already says `Free`, and a column of `$0.00` would be noise. A bucket
		* whose rate the page does not publish is likewise left unfilled rather than
		* filled with an invented number.
		*/
		function sessionCostRowDecorations(view) {
			const bucket = (key) => view.rows.find((row) => row.key === key)?.tokens ?? 0;
			const price = (key) => {
				if (view.free) return void 0;
				return view.rows.find((row) => row.key === key)?.costText;
			};
			const uncachedInput = bucket("uncachedInput");
			const cacheRead = bucket("cacheRead");
			const cacheWrite = bucket("cacheWrite");
			const output = bucket("output");
			const plan = [];
			if (uncachedInput + cacheRead + cacheWrite > 0) plan.push({
				row: "cacheHit",
				tokens: void 0,
				amount: void 0,
				hidden: false
			});
			plan.push({
				row: "uncachedInput",
				tokens: uncachedInput,
				amount: price("uncachedInput"),
				hidden: false
			});
			plan.push({
				row: "cacheRead",
				tokens: cacheRead,
				amount: price("cacheRead"),
				hidden: false
			});
			if (cacheWrite !== 0) {
				const amount = price("cacheWrite");
				plan.push({
					row: "cacheWrite",
					tokens: cacheWrite,
					amount,
					hidden: amount === void 0
				});
			}
			plan.push({
				row: "output",
				tokens: output,
				amount: price("output"),
				hidden: false
			});
			return plan;
		}
		//#endregion
		//#region src/client/session-cost-display.ts
		/**
		* The shipped composer stats row (dsh-client-ui-chat `StatsPills`).
		*
		* A PREFERENCE, not a requirement: the attribute has been dropped TWICE
		* upstream — in 0.1.6-alpha.2, and again in 0.2.1-alpha.1, where the single
		* `StatsPills` component became two independent dock entries (`activity` and
		* `usage`) and each pill lost the shared row wrapper this selector named. A
		* lookup that insisted on it would silently stop finding the row. When it is
		* absent the search falls back to the dock OUTLET — deliberately the outlet
		* and never the outlet's parent, because the parent is the composer footer,
		* which holds the `ContextMeter` as well, and that meter's trigger is itself a
		* `button[aria-haspopup="dialog"]` rendered AFTER the dock. A parent-scoped
		* "last trigger wins" would append the cost to the context ring instead.
		*
		* The fallback is still correct on 0.2.1-alpha.1: the dock registers `activity`
		* at order 0 and `usage` at order 1, both keep `aria-haspopup="dialog"` on their
		* trigger button, and `data-session-stats-usage` remains unique to the token
		* dialog — so "last trigger wins" still selects the usage pill.
		*/
		const STATS_ROOT = "[data-composer-stats]";
		/**
		* The shipped token-usage dialog's `<dl>`. Unique WITHIN one `StatsPills`
		* render (the per-message turn-usage panel has its own dialog with different
		* markup), but not across the document once two composers are live — see
		* {@link resolveDialog}.
		*/
		const USAGE_DIALOG = "[data-session-stats-usage]";
		/**
		* The usage dialog's trigger. Both pills announce a dialog, but the token one is
		* rendered LAST — and when no step carries timing the time pill is not a button
		* at all, so "last" still selects the token pill in both cases.
		*/
		const DIALOG_TRIGGER = "button[aria-haspopup=\"dialog\"]";
		/**
		* Stable id for the hidden node the appended cost is described by. The pill's own
		* `aria-label` is recomputed by the harness on every render and cannot be
		* extended, so a description is how the cost reaches assistive technology.
		*/
		const A11Y_ID = "dsh-commandcode-session-cost";
		/** How many consecutive misses before the missing anchor is worth a console line. */
		const MISSES_BEFORE_WARNING = 3;
		/**
		* The default observer: `childList` on `body`, and deliberately NOT `subtree`, so
		* streaming text inside the page never wakes it while the panel the harness
		* portals straight onto `body` does.
		*/
		const observeBodyChildren = (target, listener) => {
			if (typeof MutationObserver === "undefined") return void 0;
			const observer = new MutationObserver(listener);
			observer.observe(target, { childList: true });
			return () => observer.disconnect();
		};
		/**
		* Owns the nodes injected into the shipped token-usage UI.
		*
		* One instance per mounted entry. `sync()` is cheap and idempotent: it re-reads
		* both targets on every call, which is what lets it self-heal when React
		* remounts the row or replaces the dialog, and it rewrites a node only when its
		* text actually changed.
		*/
		var SessionCostDisplay = class {
			doc;
			scope;
			observe;
			view = void 0;
			/** Detaches the observer installed by `start()`. */
			detach = void 0;
			/** The button we appended into, while it is still connected. */
			pillHost = void 0;
			/** Our appended root, and the two nodes whose text changes. */
			pillRoot = void 0;
			pillValue = void 0;
			pillA11y = void 0;
			/** Whether WE set `aria-describedby` on the button (so only we take it back). */
			described = false;
			/** The dialog we decorated, the price nodes we own, and the cells we hid. */
			dialogHost = void 0;
			dialogPrices = /* @__PURE__ */ new Map();
			dialogHidden = /* @__PURE__ */ new Set();
			pillMisses = 0;
			constructor(options) {
				this.doc = options.doc;
				this.scope = options.scope;
				this.observe = options.observe ?? observeBodyChildren;
			}
			/** Begin watching for the shipped usage dialog opening and closing. */
			start() {
				if (this.detach !== void 0) return;
				const body = this.doc.body;
				if (body === null || body === void 0) return;
				this.detach = this.observe(body, () => this.apply());
			}
			/**
			* Hand the display the current figure.
			*
			* Undefined — nothing priceable about this session — removes everything this
			* module injected, leaving both shipped surfaces exactly as they ship.
			*/
			sync(view) {
				this.view = view;
				this.apply();
			}
			/** Remove every injected node and stop observing. Safe to call twice. */
			dispose() {
				this.detach?.();
				this.detach = void 0;
				this.removePill();
				this.clearDialog();
				this.view = void 0;
			}
			/** Re-apply the last known view to whatever both targets are right now. */
			apply() {
				this.applyPill();
				this.applyDialog();
			}
			applyPill() {
				const view = this.view;
				if (view === void 0) {
					this.removePill();
					return;
				}
				if (this.pillHost?.isConnected !== true) {
					const button = this.resolvePillButton();
					if (button === null) {
						this.pillMisses += 1;
						if (this.pillMisses === MISSES_BEFORE_WARNING) console.warn("[dsh-commandcode-provider] no shipped token pill in this composer's dock outlet to append the session cost to; the figure stays in the usage dialog only");
						return;
					}
					this.pillMisses = 0;
					this.removePill();
					this.buildPill(button, sessionCostPillRun(view));
				}
				if (this.pillValue !== void 0) {
					const amount = sessionCostPillRun(view).value;
					if (this.pillValue.textContent !== amount) this.pillValue.textContent = amount;
				}
				if (this.pillRoot !== void 0) {
					if (this.pillRoot.title !== view.title) this.pillRoot.title = view.title;
					const approximate = view.approximate ? "true" : null;
					if (this.pillRoot.getAttribute("data-approximate") !== approximate) {
						if (approximate === null) this.pillRoot.removeAttribute("data-approximate");
						else this.pillRoot.setAttribute("data-approximate", approximate);
					}
				}
				if (this.pillA11y !== void 0) {
					const described = `${SESSION_COST_COPY.panelTitle} ${view.value}`;
					if (this.pillA11y.textContent !== described) this.pillA11y.textContent = described;
				}
			}
			/**
			* The shipped token pill, scoped to this entry's own composer.
			*
			* The scope is the dock OUTLET (`display: contents`, one per slot), which holds
			* exactly that slot's entries — the shipped `stats` cell and ours, in their
			* registration order. {@link STATS_ROOT} narrows that to the stats row where
			* the markup marks it; where it does not, the outlet is already the narrowest
			* correct container, because the composer footer's `ContextMeter` sits BESIDE
			* the outlet rather than inside it. A missing scope is "no pill", never a
			* document-wide search: the outlet is what makes this lookup per-composer, and
			* two composers can be live at once.
			*/
			resolvePillButton() {
				const scope = this.scope();
				if (scope === null) return null;
				const triggers = (scope.querySelector(STATS_ROOT) ?? scope).querySelectorAll(DIALOG_TRIGGER);
				return triggers.length === 0 ? null : triggers[triggers.length - 1] ?? null;
			}
			/**
			* Create and append the cost run. The button's child list is static
			* (`[svg, label]`), so appending once is enough for it to stay last.
			*/
			buildPill(button, run) {
				const doc = this.doc;
				const root = doc.createElement("span");
				root.setAttribute("data-composer-session-cost", "");
				const separator = doc.createElement("span");
				separator.textContent = run.separator;
				separator.setAttribute("aria-hidden", "true");
				separator.style.color = "var(--dsw-alias-separator-primary)";
				separator.style.margin = "0 6px 0 0";
				const value = doc.createElement("span");
				value.textContent = run.value;
				value.style.fontWeight = "500";
				const a11y = doc.createElement("span");
				a11y.id = A11Y_ID;
				a11y.style.display = "none";
				root.appendChild(separator);
				root.appendChild(value);
				root.appendChild(a11y);
				button.appendChild(root);
				if (!button.hasAttribute("aria-describedby")) {
					button.setAttribute("aria-describedby", A11Y_ID);
					this.described = true;
				}
				this.pillHost = button;
				this.pillRoot = root;
				this.pillValue = value;
				this.pillA11y = a11y;
			}
			removePill() {
				if (this.pillRoot !== void 0 && this.pillRoot.parentNode !== null) this.pillRoot.parentNode.removeChild(this.pillRoot);
				if (this.described) {
					this.pillHost?.removeAttribute("aria-describedby");
					this.described = false;
				}
				this.pillHost = void 0;
				this.pillRoot = void 0;
				this.pillValue = void 0;
				this.pillA11y = void 0;
			}
			applyDialog() {
				const view = this.view;
				const host = view === void 0 ? null : this.resolveDialog();
				if (host === null || view === void 0) {
					this.clearDialog();
					return;
				}
				this.pruneDialog(host);
				const plan = sessionCostRowDecorations(view);
				const pairs = dialogPairs(host);
				if (!dialogShapeMatches(pairs, plan, this.dialogPrices)) {
					this.clearDialog();
					return;
				}
				const hidden = /* @__PURE__ */ new Set();
				for (const [index, row] of plan.entries()) {
					const pair = pairs[index];
					if (pair === void 0) continue;
					const span = this.dialogPrices.get(pair.dd);
					if (row.hidden) {
						if (pair.dt.style.display !== "none") pair.dt.style.display = "none";
						if (pair.dd.style.display !== "none") pair.dd.style.display = "none";
						hidden.add(pair.dt);
						hidden.add(pair.dd);
						this.removeDialogPrice(pair.dd, span);
						continue;
					}
					if (pair.dt.style.display === "none") pair.dt.style.display = "";
					if (pair.dd.style.display === "none") pair.dd.style.display = "";
					if (row.amount === void 0) {
						this.removeDialogPrice(pair.dd, span);
						continue;
					}
					const price = span ?? this.createDialogPrice(pair.dd, row.row);
					if (price.parentNode !== pair.dd) pair.dd.appendChild(price);
					if (price.textContent !== row.amount) price.textContent = row.amount;
				}
				for (const cell of [...this.dialogHidden]) {
					if (hidden.has(cell)) continue;
					if (cell.style.display === "none") cell.style.display = "";
					this.dialogHidden.delete(cell);
				}
				for (const cell of hidden) this.dialogHidden.add(cell);
				this.dialogHost = host;
			}
			/** Forget the cells and prices a re-rendered dialog took with it. */
			pruneDialog(host) {
				for (const [dd, price] of [...this.dialogPrices]) {
					if (dd.parentNode === host) continue;
					if (price.parentNode !== null) price.parentNode.removeChild(price);
					this.dialogPrices.delete(dd);
				}
				for (const cell of [...this.dialogHidden]) {
					if (cell.parentNode === host) continue;
					if (cell.style.display === "none") cell.style.display = "";
					this.dialogHidden.delete(cell);
				}
			}
			/** The price node for one shipped value cell, appended as its last child. */
			createDialogPrice(dd, row) {
				const price = this.doc.createElement("span");
				price.setAttribute("data-session-cost-price", row);
				price.style.marginLeft = "6px";
				price.style.display = "inline-block";
				price.style.minWidth = "56px";
				price.style.textAlign = "right";
				price.style.fontWeight = "500";
				dd.appendChild(price);
				this.dialogPrices.set(dd, price);
				return price;
			}
			removeDialogPrice(dd, price) {
				if (price === void 0) return;
				if (price.parentNode !== null) price.parentNode.removeChild(price);
				this.dialogPrices.delete(dd);
			}
			/**
			* The shipped usage dialog, or null while it is closed (or ambiguous).
			*
			* The dialog is portaled onto `body`, so unlike the pill it cannot be scoped
			* from this entry, and the attribute is unique per DIALOG rather than per
			* document. While one composer was guaranteed a document-level lookup was
			* exact; 0.1.6-alpha.2 ended that guarantee by mounting an embedded
			* Conversation in the sidebar, so a second composer — its own session, dock and
			* dialog — can be live and open at the same time.
			*
			* There is no DOM link from a dialog back to its trigger (the portaled panel
			* carries no id and no `aria-controls`), so document order says nothing about
			* ownership. The shape confirmation in {@link dialogShapeMatches} would usually
			* reject the stranger, but it compares against THIS entry's counts, so a
			* coincidentally matching dialog would be priced with another session's
			* figures. Ambiguity is therefore answered by declining to decorate at all:
			* a dialog we cannot prove is ours is left alone.
			*/
			resolveDialog() {
				if (this.dialogHost?.isConnected === true) return this.dialogHost;
				this.clearDialog();
				const dialogs = this.doc.querySelectorAll(USAGE_DIALOG);
				return dialogs.length === 1 ? dialogs[0] ?? null : null;
			}
			/** Give the dialog back: every price removed, every hidden row restored. */
			clearDialog() {
				for (const price of this.dialogPrices.values()) if (price.parentNode !== null) price.parentNode.removeChild(price);
				this.dialogPrices.clear();
				for (const cell of this.dialogHidden) if (cell.style.display === "none") cell.style.display = "";
				this.dialogHidden.clear();
				this.dialogHost = void 0;
			}
		};
		/** The shipped dialog's `dt`/`dd` pairs, in document order. */
		function dialogPairs(host) {
			const pairs = [];
			let label = null;
			for (const node of Array.from(host.childNodes)) {
				const tag = tagNameOf(node);
				if (tag === "DT") label = node;
				else if (tag === "DD" && label !== null) {
					pairs.push({
						dt: label,
						dd: node
					});
					label = null;
				}
			}
			return pairs;
		}
		/** `tagName` upper-cased, or an empty string for a non-element node. */
		function tagNameOf(node) {
			const tag = node.tagName;
			return typeof tag === "string" ? tag.toUpperCase() : "";
		}
		/**
		* Whether the dialog really holds the rows this session's buckets predict.
		*
		* The shipped labels belong to the `chat` locale and differ per language, so rows
		* are matched by POSITION, and this is what makes that safe: the row count must
		* agree, the cache-hit row must be the percentage it is, and every other value
		* must carry exactly the token count of the bucket predicted for it. A mismatch
		* means the dialog is not what this view describes, and nothing is decorated.
		*/
		function dialogShapeMatches(pairs, plan, prices) {
			if (pairs.length !== plan.length) return false;
			return plan.every((row, index) => {
				const pair = pairs[index];
				if (pair === void 0) return false;
				const text = hostValueText(pair.dd, prices.get(pair.dd));
				if (row.tokens === void 0) return text.includes("%");
				return digitsOf(text) === String(row.tokens);
			});
		}
		/**
		* A value cell's own text, without the price this module appended to it — the
		* digits of `3,206,544 tok` are the host's, the digits of `$0.07` are ours.
		*/
		function hostValueText(dd, price) {
			let text = "";
			for (const node of Array.from(dd.childNodes)) {
				if (node === price) continue;
				text += node.textContent ?? "";
			}
			return text;
		}
		/** Every digit of a display string, so locale grouping cannot break the match. */
		function digitsOf(text) {
			return text.replace(/\D/g, "");
		}
		//#endregion
		//#region src/client/session-cost-view.tsx
		/**
		* The dock outlet this entry renders inside, i.e. what it scopes itself from.
		*
		* The OUTLET, not its parent. The outlet is one `display:contents` div holding
		* exactly this slot's entries (the shipped `stats` cell and ours), so it is the
		* narrowest container that is still per-composer. Its parent is NOT: from
		* 0.1.6-alpha.2 the composer stacks the dock inside a footer that also holds the
		* `ContextMeter`, whose trigger is another `button[aria-haspopup="dialog"]`
		* rendered after the dock — scoping to the parent would let the cost land on the
		* context ring.
		*/
		const DOCK_ANCHOR = "[data-slot=\"conversation.composer.dock\"]";
		/** Module-level constant so the marker's `style` prop never diffs. */
		const HIDDEN_STYLE = { display: "none" };
		/** Log a missing seat once per page, so a silent no-op stays diagnosable. */
		let warnedMissingSeat = false;
		/**
		* The composer's session-cost entry. Guards the two seats before rendering the
		* mount: a dsh that does not supply the projection seat to dock occupants gets
		* an absent cost and one console line, never a render crash — which the renderer
		* would answer by abdicating the entry with no visible trace.
		*/
		function CommandCodeSessionCost(props) {
			if (typeof props.useProjection !== "function" || typeof props.useCommandCodePrices !== "function") {
				if (!warnedMissingSeat) {
					warnedMissingSeat = true;
					console.error("[dsh-commandcode-provider] the composer does not supply the projection/hook seats the session-cost readout needs; the readout stays hidden");
				}
				return null;
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionCostEntry, { ...props });
		}
		/** The mount: one injection lifetime, one hidden marker. Every hook lives here. */
		function SessionCostEntry(props) {
			const markerRef = (0, react.useRef)(null);
			const displayRef = (0, react.useRef)(null);
			const prices = props.useCommandCodePrices((state) => state);
			const view = buildSessionCostView({
				usage: props.useProjection("tokenUsage"),
				selection: props.useProjection("modelSelection"),
				facts: props.useProjection("commandCodeCost"),
				table: prices.table,
				now: Date.now()
			});
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				const display = new SessionCostDisplay({
					doc: document,
					scope: () => markerRef.current?.closest(DOCK_ANCHOR) ?? null
				});
				displayRef.current = display;
				display.start();
				return () => {
					displayRef.current = null;
					display.dispose();
				};
			}, []);
			(0, react.useEffect)(() => {
				displayRef.current?.sync(view);
			});
			if (view === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref: markerRef,
				style: HIDDEN_STYLE,
				"data-ccp-session-cost-anchor": ""
			});
		}
		//#endregion
		//#region src/client/page-styles.ts
		/**
		* Stylesheet for the Command Code settings page — and the Models-page provider
		* card, which shares its `cc-` classes.
		*
		* Returned as a string, not injected here, so importing this module has no DOM
		* side effect: `./index.ts` installs it once under {@link PAGE_CSS_ID}. It is a
		* module of its own rather than a literal in the entry so `tests/styles.test.ts`
		* can audit every rule without importing the React tree (which pulls
		* `*.module.css` through the primitives package and needs a loader registered
		* first). The rules are GLOBAL CSS, so containment is a contract (issue #48):
		* every selector is qualified by one of our own `cc-` classes. Colours are
		* harness theme aliases with neutral fallbacks, and the `cc-` prefix keeps
		* these clear of the panel's `ccp-` set.
		*
		* @module dsh-commandcode-provider/client/page-styles
		*/
		/**
		* Stylesheet id — the `data-plugin-css` value that makes injection idempotent.
		*
		* The prefix must match this package's real name and the panel stylesheet's
		* (`PANEL_CSS_ID`); the two ids must also stay DISTINCT, since they key two
		* separate style tags and a shared id would make the second injection a no-op.
		*/
		const PAGE_CSS_ID = "@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css";
		/**
		* The settings-page stylesheet.
		*
		* Every size is the design canvas's (the cc-kit.css of the "CommandCode 设置页
		* 重设计" artboards, 2026-10-21, as revised by the 2026-10-29 card redesign):
		* a row is 14px of vertical padding with a .5px hairline between rows, title
		* 14/22, description 12/18, a 24px gap to the control; a group is a 16px-radius
		* card on the raised surface with a 1px border-l2 stroke, its heading 52px
		* high; the page title is 22/28 and group titles 15/22, both 600. The page
		* renders with grayscale antialiasing and descriptive text in label-secondary.
		* A status strip under the header (account health, monthly remainder, service
		* status, model scope) reuses the groups' own summary strings, so it adds no
		* locale keys and cannot disagree with the card below it.
		*
		* Motion (2026-10-29): anything pressable scales on :active (0.97, the 20–28px
		* icon buttons 0.95) over 160ms of one strong ease-out,
		* cubic-bezier(.23,1,.32,1), which the fold chevron, save bar, usage bar,
		* card entrance and notice entrance share; colour and border changes fade over
		* 150ms `ease`. Only transform, opacity and colours animate — never layout.
		* Every :hover rule sits in the one `(hover:hover) and (pointer:fine)` block at
		* the end, so a tap on a touch screen does not leave a stuck hover colour;
		* :active stays outside it, since a press needs feedback on touch too. Folding
		* a group or an account card stays instant: it happens too often to be worth a
		* wait, and a hidden body keeps its `aria-controls` target mounted.
		*
		* Shapes follow one rule — clickable things are pills, fillable things are
		* 8px. Buttons are drawn here (PageButton → cc-btn: md 32px, sm 28px, lg 36px
		* for the save bar), not taken from the harness primitive. Inputs and the
		* model selector are 32px with a 1px border-l3 stroke on the raised surface; a
		* number field draws its unit inside the box (cc-unitBox). Account cards and
		* the per-model override table are 1px border-l2 cards with 12px corners;
		* panels and notices are 12px-radius fills; badges are 20px pills. Errors use
		* state-error-primary; tinted surfaces fall back to a color-mix of the state
		* colour where the theme has no tertiary token. The Models-page provider card
		* shares cc-hint / cc-badgeMuted / cc-input and keeps their colours.
		*/
		const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--cc-ease-out:cubic-bezier(.23,1,.32,1)}
.cc-title{margin:0;color:var(--dsw-alias-label-primary);font-size:22px;font-weight:700;line-height:28px}
.cc-intro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
/* The glanceable header strip: four cells (account health, monthly remainder,
 * service status, model scope) on one card. Labels reuse cc-statusLabel and
 * dots reuse cc-tabDot, so no new colour language is introduced; the strip
 * folds to 2 × 2 in a narrow panel. */
.cc-statusStrip{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;display:grid;margin-top:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.cc-statusCell{flex-direction:column;gap:2px;min-width:0;display:flex;padding:14px 16px}
.cc-statusCell+.cc-statusCell{border-left:1px solid var(--dsw-alias-border-l2)}
.cc-statusHead{align-items:center;gap:6px;display:flex}
.cc-statusStripValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}
.cc-statusSub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
@media (max-width:560px){.cc-statusStrip{grid-template-columns:repeat(2,minmax(0,1fr))}.cc-statusCell:nth-child(3){border-left:0}.cc-statusCell:nth-child(n+3){border-top:1px solid var(--dsw-alias-border-l2)}}
.cc-spacer{flex:1}
/* Groups are cards now (2026-10-29 redesign): a 16px-radius raised surface
 * with a border-l2 stroke, 16px between cards, no divider rules. The entrance
 * is a @starting-style rise with a 40ms stagger per card — transitions, not
 * keyframes, so a re-render never replays it. */
.cc-group{flex-direction:column;display:flex;margin-top:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.04);transition:opacity 320ms var(--cc-ease-out),transform 320ms var(--cc-ease-out)}
@starting-style{.cc-group{opacity:0;transform:translateY(8px)}}
.cc-section>section:nth-of-type(1){transition-delay:0ms}
.cc-section>section:nth-of-type(2){transition-delay:40ms}
.cc-section>section:nth-of-type(3){transition-delay:80ms}
.cc-section>section:nth-of-type(4){transition-delay:120ms}
.cc-section>section:nth-of-type(5){transition-delay:160ms}
.cc-groupHead{align-items:center;gap:8px;display:flex;min-height:52px;padding:0 16px}
.cc-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}
.cc-groupDesc{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-rows>.cc-groupDesc{margin:0 16px}
/* A block straight under a group's description (the account list, its
 * notices, the override table) keeps the same 12px as the account-mode line
 * and the actions row inside the card; a setting row brings its own 12px
 * padding instead. */
.cc-rows>.cc-groupDesc+.cc-notices,.cc-rows>.cc-groupDesc+.cc-accountList,.cc-rows>.cc-groupDesc+.cc-contextTable{margin-top:12px}
.cc-groupHeading{flex:1;min-width:0;margin:0;font:inherit;display:flex}
/* The whole heading row is the fold toggle: chevron, title, summary badges. */
.cc-disclosure{box-sizing:border-box;flex-wrap:wrap;flex:1;align-items:center;gap:6px 8px;min-width:0;min-height:52px;padding:0;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:8px;display:flex}
.cc-foldChevron{color:var(--dsw-alias-label-tertiary);transition:transform .16s var(--cc-ease-out),color .15s ease}
.cc-foldChevronClosed{transform:rotate(-90deg)}
/* Folding stays instant (2026-10-29): the body stays mounted and is hidden with
 * the hidden attribute, so aria-controls always points at a real element
 * and the save bar's locate action can focus an invalid field right after
 * opening its group. */
.cc-groupBody{flex-direction:column;display:flex;padding-top:4px}
.cc-groupBody[hidden]{display:none}
.cc-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-rows{flex-direction:column;display:flex;padding-top:4px}
/* Card inset by default: every direct body child sits 16px off the card edge,
 * and only rows opt out — they carry their own 16px side padding so their
 * hairlines run the card's full width. */
.cc-rows>*{margin-left:16px;margin-right:16px}
.cc-rows>.cc-row{margin-left:0;margin-right:0}
.cc-row{flex-wrap:wrap;align-items:center;gap:8px 24px;display:flex;padding:14px 16px}
.cc-rows>.cc-row+.cc-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-rowFlush{padding:0}
/* The text column starts at 200px (not 300px) so the widest controls — the
 * 280px API base input, the allowlist's button + 200px selector — still sit
 * beside their label in a ~560px settings panel; the description wraps more
 * lines instead of the control dropping to a second line. */
.cc-rowText{flex-direction:column;flex:1 1 200px;gap:2px;min-width:0;display:flex}
.cc-rowTitleLine{align-items:center;gap:8px;display:flex;min-width:0}
.cc-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.cc-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-rowDesc p{margin:0}
.cc-rowDesc p+p{margin-top:4px}
.cc-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-rowControl{flex:none;align-items:center;gap:8px;display:inline-flex;margin-left:auto}
.cc-rowInput{width:200px}
.cc-rowInputWide{width:280px}
/* The row-level field, drawn to the design canvas: 32px, 8px corners, a 1px
 * border-l3 stroke on the raised surface. A number field draws its unit inside
 * the same box (cc-unitBox), right of the value. */
.cc-fieldInput{box-sizing:border-box;flex:none;height:32px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;transition:border-color .15s ease}
.cc-fieldInput::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-fieldInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-fieldInput:disabled{opacity:.5;cursor:default}
.cc-fieldInputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-unitBox{box-sizing:border-box;flex:none;align-items:center;display:inline-flex;width:160px;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .15s ease}
.cc-unitBox:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-unitBoxInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-unitBox:has(>.cc-fieldInput:disabled){opacity:.5}
.cc-unitBox>.cc-fieldInput{flex:1;width:auto;height:30px;border:0;border-radius:0;background:0 0;outline:none;text-align:right;font-variant-numeric:tabular-nums}
.cc-unit{flex:none;padding:0 10px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
/* A customized field's marker on its title line: the badge, then a 20px
 * round reset button. Reset lives here rather than after the control, so no
 * row reserves a reset column and the page keeps one right edge. */
.cc-overrideTag{align-items:center;gap:4px;display:inline-flex}
.cc-resetInline{flex:none;align-items:center;justify-content:center;display:inline-flex;width:20px;height:20px;padding:0;border:0;border-radius:999px;corner-shape:round;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-resetInline:active:not(:disabled){transform:scale(.95)}
.cc-resetInline:disabled{cursor:default;opacity:.4}
.cc-resetInline:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-icon{flex:none;width:16px;height:16px}
/* The page's buttons (PageButton), drawn to the design canvas: one capsule
 * shape, md 32px / 14px text / 14px icon, sm 28px / 12px text, lg 36px for
 * the save bar; primary is the brand fill, secondary the quiet grey fill,
 * ghost label-secondary text, danger the error fill. */
.cc-btn{box-sizing:border-box;flex:none;align-items:center;justify-content:center;gap:6px;display:inline-flex;height:32px;padding:0 14px;border:0;border-radius:999px;corner-shape:round;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer;text-decoration:none;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-btn:active:not(:disabled){transform:scale(.97)}
.cc-btnSm{height:28px;padding:0 10px;gap:4px;font-size:12px;line-height:18px}
.cc-btnLg{height:36px;padding:0 16px}
.cc-btn .cc-btnIcon{width:14px;height:14px}
.cc-btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.cc-btnSecondary{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.cc-btnGhost{background:0 0;color:var(--dsw-alias-label-secondary)}
.cc-btnDanger{background:var(--dsw-alias-state-error-primary);color:#fff}
.cc-btn:disabled{cursor:default;opacity:.4}
.cc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-groupSummary{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge,.cc-badgeMuted{box-sizing:border-box;flex:none;align-items:center;gap:4px;display:inline-flex;height:20px;white-space:nowrap;border-radius:999px;corner-shape:round;padding:0 8px;font-size:12px;font-weight:500;line-height:18px}
.cc-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.cc-badgeMuted{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.cc-badgeOutline{background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.cc-badgeOk{background:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent));color:var(--dsw-alias-state-success-primary,#15803d)}
.cc-badgeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.cc-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:18px}
.cc-reset:disabled{cursor:default;opacity:.4}
.cc-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{opacity:.6;cursor:default}
.cc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.cc-modelSelectAnchor{flex-direction:column;align-items:stretch;gap:6px;display:inline-flex;width:200px}
.cc-selector{box-sizing:border-box;justify-content:space-between;align-items:center;gap:8px;display:inline-flex;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer;transition:border-color .15s ease}
.cc-selector:disabled{cursor:default;opacity:.4}
.cc-selector:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-selectorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-selectorChevron{color:var(--dsw-alias-label-tertiary)}
/* The search box sits inside the Menu anchor, so typing in it never trips
 * the Menu's outside-click close. */
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
/* A hand-drawn box, not the platform's accent-color checkbox: the native
 * control's colours come from color-scheme, which the theme sets once at BOOT
 * and never re-applies in-session, so a native box can paint light-chrome white
 * on a dark page. The mark rides a brand-primary fill, so it takes the brand
 * foreground (the only pairing that survives dark mode's near-white brand), and
 * the outline is a border-l3 hairline because border-l2 leaves an unchecked box
 * invisible against the menu surface. */
.cc-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:3px;left:5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The settings switches are the platform's Switch primitive (issue #108); its
 * module CSS owns the box (36x20 track, 16px thumb, 16px travel), the colours,
 * capsule shape, focus ring and disabled look. This layer only joins the page's
 * motion: the primitive slides the thumb over 120ms ease and snaps the track
 * colour, so here the thumb and track share one 160ms strong ease-out and read
 * as one object, and the switch scales to .95 on press like the other small
 * pressables. The design canvas's 40x24 track is deliberately NOT re-applied
 * (2026-10-30: it made every switch read fatter than the host's own settings
 * switches, so the primitive's box is the single source of truth). The
 * cc-rowControl> qualifier lifts these above the module's single-class rules
 * whatever order the two sheets load in. The thumb is targeted as the button's
 * only child because its module class name is hashed. */
.cc-rowControl>.cc-switch{transition:background-color .16s var(--cc-ease-out),transform .16s var(--cc-ease-out)}
.cc-rowControl>.cc-switch>span{transition:transform .16s var(--cc-ease-out)}
.cc-switch:active:not(:disabled){transform:scale(.95)}
.cc-accountMode{align-items:center;gap:8px;display:flex;margin:12px 16px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-accountList{flex-direction:column;gap:8px;display:flex}
.cc-accountList+.cc-panel{margin:8px 16px 16px}
/* One row under the list: Add account (outline) leads, the analytics exit
 * (ghost) trails; the exit's long label clamps instead of wrapping the row. */
.cc-accountActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex;margin:12px 16px 16px}
.cc-analyticsEntry{max-width:100%;min-width:0}
.cc-analyticsEntryText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-chevronOpen{transform:rotate(180deg)}
.cc-accountItem{flex-direction:column;display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.cc-accountItem>.cc-notice,.cc-accountItem>.cc-panel{margin:0 16px 14px}
.cc-accountItemActive{border-color:var(--dsw-alias-border-l3)}
.cc-accountHead{align-items:center;gap:4px;display:flex;padding:8px 8px 8px 0}
.cc-accountToggle{flex-wrap:wrap;align-items:center;gap:6px 8px;display:flex;flex:1;min-width:0;min-height:44px;padding:0 0 0 16px;background:0 0;border:0;border-radius:12px;color:inherit;cursor:pointer;font:inherit;text-align:left}
.cc-accountToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.cc-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-iconButton{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;padding:0;background:0 0;border:0;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-iconButton:active:not(:disabled){transform:scale(.95)}
.cc-iconButton:disabled{cursor:default;opacity:.4}
.cc-iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* Per-model context-length overrides (issue #86) as the design's small table:
 * a card holding a head row over a model / value / remove grid, a line
 * between rows; a row's error wraps onto its own line across the grid. */
.cc-contextTable{flex-direction:column;display:flex;margin:0 16px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.cc-contextItem{grid-template-columns:minmax(0,1fr) 144px 28px;align-items:center;gap:8px;display:grid;padding:8px 8px 8px 12px}
.cc-contextItem+.cc-contextItem{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-contextHead{grid-template-columns:minmax(0,1fr) 144px 28px;align-items:center;gap:8px;display:grid;height:32px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-contextSelect{position:relative;display:block;min-width:0}
/* appearance:none swaps the platform arrow for the page's own chevron icon. */
.cc-contextModel{box-sizing:border-box;appearance:none;-webkit-appearance:none;width:100%;padding-inline-end:30px;text-overflow:ellipsis;cursor:pointer}
.cc-contextCaret{position:absolute;inset-inline-end:10px;top:50%;color:var(--dsw-alias-label-tertiary);transform:translateY(-50%);pointer-events:none}
.cc-contextSelect:has(.cc-contextModel:disabled) .cc-contextCaret{opacity:.6}
.cc-contextItem>.cc-unitBox{width:100%}
.cc-contextError{grid-column:1/-1}
.cc-tabDot{flex-shrink:0;width:8px;height:8px;border-radius:50%;corner-shape:round}
.cc-tabDotOk{background:var(--dsw-alias-state-success-primary)}
.cc-tabDotBlank{background:0 0;border:0}
.cc-tabDotWarn{background:var(--dsw-alias-state-warn-primary,#d97706)}
.cc-tabDotError{background:var(--dsw-alias-state-error-primary)}
.cc-accountMeters{flex-wrap:wrap;gap:6px 24px;display:flex;padding:0 16px 14px 32px}
.cc-miniMeter{align-items:center;gap:8px;display:inline-flex;font-size:12px;line-height:18px}
.cc-miniMeterLabel{color:var(--dsw-alias-label-secondary)}
.cc-miniMeterTrack{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;width:64px;height:4px}
/* The fill is always full width and slides in from the left under the track's
 * overflow clip: animating transform skips layout, and unlike scaleX it keeps
 * the fill's rounded ends. */
.cc-miniMeterFill{display:block;width:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:transform .24s var(--cc-ease-out)}
.cc-miniMeterValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cc-accountDetails{container-type:inline-size;border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:16px;display:flex;padding:16px}
.cc-inlineForm{flex-direction:column;gap:8px;display:flex}
.cc-inlineActions{align-items:center;gap:8px;display:flex}
.cc-panel{flex-direction:column;gap:12px;display:flex;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.cc-panelInput{width:100%}
.cc-keyField{align-items:center;gap:8px;display:flex}
.cc-panelActions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}
/* The add-account method switch, drawn as the design's segmented control: a
 * pill track on the raised surface, the chosen segment in the brand fill. */
.cc-seg{align-self:flex-start;display:inline-flex;padding:2px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.cc-segItem{height:28px;padding:0 12px;border:0;border-radius:999px;corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-segItem:active:not(:disabled):not(.cc-segOn){transform:scale(.97)}
.cc-segItem:disabled{cursor:default;opacity:.4}
.cc-segItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-segOn{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.cc-panelTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.cc-accountReport{flex-direction:column;gap:16px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usagePlanStatus{flex:none;margin:0;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
/* Two fixed grids, not one auto-fit track: auto-fit wrapped the four activity
 * tiles 3 + 1 at the details' width. The activity row folds to 2 × 2 in a
 * narrow details panel. */
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStatsActivity{grid-template-columns:repeat(4,minmax(0,1fr))}
@container (max-width:460px){.cc-usageStatsActivity{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cc-balance{flex-direction:column;gap:2px;display:flex}
/* 两行左右分栏：标签行左账期、右更新时间；数值行左剩余、右已购与赠送。 */
.cc-balanceRow{flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px;display:flex}
.cc-balanceLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-balanceValue{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}
.cc-balanceSub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-balanceEmpty .cc-balanceValue{color:var(--dsw-alias-state-error-primary)}
.cc-balanceNote{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageStat{min-width:0;flex-direction:column;gap:2px;display:flex;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
.cc-usageStatLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;font-variant-numeric:tabular-nums}
.cc-usageStatSub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-usageWindows{flex-direction:column;gap:14px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;line-height:18px}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-usageExceeded{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;height:4px}
/* The fill is always full width and slides in from the left under the track's
 * overflow clip: animating transform skips layout, and unlike scaleX it keeps
 * the fill's rounded ends. */
.cc-usageBarFill{width:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:transform .24s var(--cc-ease-out)}
.cc-usageBarFillWarn{background:var(--dsw-alias-state-error-primary)}
.cc-usageWindowReset{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.cc-usagePartial{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.cc-notices{flex-direction:column;gap:8px;display:flex;margin-bottom:12px}
.cc-section>.cc-notice{margin-top:12px}
/* One block for every result, warning and blocked state: neutral (read-only,
 * in progress), warn (partly done, needs a retry) and error (failed). The
 * icon and title take the tone; the body stays label-secondary for contrast.
 * A notice settles in from 4px above as it first renders, so a result never
 * jolts the content below it; browsers without @starting-style just show it. */
.cc-notice{box-sizing:border-box;align-items:flex-start;gap:10px;display:flex;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;transition:opacity .2s var(--cc-ease-out),transform .2s var(--cc-ease-out)}
@starting-style{.cc-notice{opacity:0;transform:translateY(-4px)}}
.cc-noticeIcon{flex:none;width:16px;height:16px;margin-top:1px;color:var(--dsw-alias-label-tertiary)}
.cc-noticeBody{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;word-break:break-word}
.cc-noticeBody>p{margin:0}
.cc-noticeTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-noticeActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex;margin-top:8px}
.cc-noticeDetail{color:var(--dsw-alias-label-tertiary)}
.cc-noticeSuccess{background:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent))}
.cc-noticeSuccess>.cc-noticeIcon{color:var(--dsw-alias-state-success-primary,#16a34a)}
.cc-noticeWarn{background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 12%,transparent))}
.cc-noticeWarn>.cc-noticeIcon,.cc-noticeWarn .cc-noticeTitle{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-noticeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.cc-noticeError>.cc-noticeIcon,.cc-noticeError .cc-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.cc-version{margin:32px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-versionLink{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-providerCard{flex-direction:column;display:flex}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-failed{display:inline-block;max-width:260px;min-width:0;color:var(--dsw-alias-state-error-primary);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.cc-loginLink{align-items:center;gap:4px;display:inline-flex;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;font-size:12px;line-height:18px}
.cc-loginLink>.cc-iconInline{width:12px;height:12px}
/* The status row's dot + verdict sit beside the row title; the primitive's own
 * state tokens colour the dot, so only the neutral label and the failure note
 * need styling here. */
.cc-statusBadge{align-items:center;gap:6px;display:inline-flex;white-space:nowrap}
.cc-statusLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-statusNotice{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary));margin:0;font-size:12px;line-height:18px}
/* The service-status row's two sources: a key column (Official / This device)
 * beside a value line that wraps under itself, never under the key. */
.cc-statusLines{grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:4px 12px;display:grid;margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-statusKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.cc-statusValue{flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0;display:flex}
.cc-statusVerdict{color:var(--dsw-alias-label-primary)}
.cc-statusMeta{flex:1 1 200px;min-width:0}
/* One aggregate (uptime, response, age) never breaks inside itself; a line
 * that runs out of room moves the whole next segment down. */
.cc-statusPart{white-space:nowrap}
/* On the title line, flush with the page's single right edge. */
.cc-statusTitleLink{align-items:center;gap:4px;display:inline-flex;margin-left:auto}
.cc-statusBad{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-statusLink{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;font-size:12px;line-height:18px;white-space:nowrap}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-state-error-primary)}
/* The floating save bar: a centered bar pinned to the bottom of the
 * settings scrollport. The dock is a zero-height sticky strip at the end of the
 * page, so the bar overlays the scrolling content instead of taking a row of
 * its own; while shown, the section reserves room at its end so the last line
 * can scroll clear. Hidden, it sinks and fades, and visibility (switched after
 * the transition) takes its buttons out of the tab order. It leaves faster than
 * it arrives and never overshoots: the bar shows on every edit. Its surface is
 * an elevated layer (bg-layer-1 over the settings panel's layer-2) with the
 * platform's prominent elevation and no stroke, and its corners are concentric
 * with the capsule buttons inside it (36px pills inset by 6px in a 48px pill)
 * so the gap around each button is even. */
.cc-sectionWithBar{padding-bottom:80px}
.cc-saveBarDock{position:sticky;bottom:0;z-index:2;height:0;pointer-events:none}
.cc-saveBar{--cc-saveBar-tone:var(--dsw-alias-state-warn-primary,#d97706);position:absolute;left:50%;bottom:20px;box-sizing:border-box;width:max-content;max-width:calc(100% - 24px);align-items:center;gap:10px;display:flex;height:48px;padding:6px 6px 6px 16px;border:0;border-radius:24px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));opacity:0;visibility:hidden;transform:translate(-50%,12px);transition:opacity .16s var(--cc-ease-out),transform .16s var(--cc-ease-out),visibility 0s linear .16s}
.cc-saveBarShown{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .22s var(--cc-ease-out),transform .22s var(--cc-ease-out),visibility 0s}
.cc-saveBar-error{--cc-saveBar-tone:var(--dsw-alias-state-error-primary)}
.cc-saveBar-success{--cc-saveBar-tone:var(--dsw-alias-state-success-primary,#16a34a);padding-right:18px}
.cc-saveBarIcon{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:16px;height:16px;color:var(--cc-saveBar-tone)}
.cc-saveBarPulse{width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--cc-saveBar-tone)}
.cc-saveBarText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-saveBar-error .cc-saveBarText{color:var(--dsw-alias-state-error-primary)}
.cc-saveBarActions{flex-shrink:0;align-items:center;gap:4px;display:flex;margin-left:8px}
/* Hover only where a real pointer hovers. Order matters inside: the invalid
 * borders come after the plain hover borders at equal specificity, so an
 * invalid field keeps its error border under the pointer. */
@media (hover:hover) and (pointer:fine){
.cc-fieldInput:hover:not(:disabled),.cc-unitBox:hover,.cc-selector:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.cc-fieldInputInvalid:hover:not(:disabled),.cc-unitBoxInvalid:hover{border-color:var(--dsw-alias-state-error-primary)}
.cc-resetInline:hover:not(:disabled),.cc-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}
.cc-btnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cc-btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000)}
.cc-segItem:hover:not(:disabled):not(.cc-segOn),.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
/* A whole-row toggle (group heading, account card head) shows it is one
 * target by lifting its chevron; a fill would weigh too much across the row. */
.cc-disclosure:hover .cc-foldChevron,.cc-accountToggle:hover .cc-foldChevron{color:var(--dsw-alias-label-primary)}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
.cc-loginLink:hover,.cc-statusLink:hover{text-decoration:underline;text-underline-position:under}
}
/* Reduced motion drops movement and scale but keeps the fades and colour
 * changes, which carry meaning without motion. Card entrance keeps its fade
 * (the transform is neutralised), and the fold is already instant. */
@media (prefers-reduced-motion:reduce){
.cc-foldChevron,.cc-rowControl>.cc-switch>span,.cc-usageBarFill,.cc-miniMeterFill{transition:none}
.cc-btn,.cc-iconButton,.cc-resetInline,.cc-segItem{transition:background-color .15s ease,color .15s ease}
.cc-rowControl>.cc-switch{transition:background-color .15s ease}
.cc-btn:active:not(:disabled),.cc-iconButton:active:not(:disabled),.cc-resetInline:active:not(:disabled),.cc-segItem:active:not(:disabled):not(.cc-segOn),.cc-switch:active:not(:disabled){transform:none}
.cc-notice{transition:opacity .2s ease}
.cc-group{transition:opacity .2s ease;transform:none!important}
.cc-saveBar{transition:opacity .16s ease,visibility 0s linear .16s}
.cc-saveBarShown{transition:opacity .2s ease,visibility 0s}
}
`;
		//#endregion
		//#region src/client/panel-styles.ts
		/**
		* Stylesheet for the Command Code plans & quota panel (the sidebar footer card
		* and the dashboard it opens).
		*
		* Returned as a string, not injected here, so importing this module has no DOM
		* side effect: `./index.ts` installs it once under {@link PANEL_CSS_ID} and
		* removes it when the fiber unwinds.
		*
		* These rules are GLOBAL CSS, so containment is a contract (issue #48): every
		* selector is qualified by one of our own `ccp-` classes except the sidebar
		* anchor below, which carries its justification in place. `tests/styles.test.ts`
		* audits both stylesheets against the real foreign class stems. Colours are
		* harness theme aliases with neutral fallbacks; the `ccp-` prefix keeps these
		* clear of the settings page's `cc-` set.
		*
		* @module dsh-commandcode-provider/client/panel-styles
		*/
		/**
		* Stylesheet id — the `data-plugin-css` value that makes injection idempotent.
		*
		* The prefix must match this package's real name and the settings-page sheet's
		* (`PAGE_CSS_ID`); the two ids must also stay DISTINCT, since they key two
		* separate style tags and a shared id would make the second injection a no-op.
		*/
		const PANEL_CSS_ID = "@mars-sea/dsh-commandcode-provider/CommandCodePanel.module.css";
		/** The panel stylesheet. */
		const PANEL_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell renders this list ABOVE the Settings seat, so the card is the
   sidebar's bottom-most content, and supplies no chrome: the entry IS the
   button. Deliberately quiet — a surface beside Settings should read as part of
   the column — with one hover step and a hairline border.

   The shell's container is a flex ROW whose occupants each declare a full-width
   line and shrink-proof flex, so as a row it would overflow the column: this
   card cannot shrink and the neighbouring chip would absorb the overflow and
   collapse to nothing. The first rule is that fix, and THE ANCHOR IS
   LOAD-BEARING (issue #48): "footerActions" is not a stem this shell owns alone
   — dsh-client-ui-user-questions renders the ask-user-question dialog's button
   row as Mbwy4a_footerActions, and the unanchored rule stacked THAT row's
   side-by-side buttons on every page. "footArea" is declared by
   dsh-client-ui-sidebar alone (audited across every client bundle of the
   0.1.6-alpha.1 engine, and against our own cc-/ccp- names, which collide with
   no engine class). The DESCENDANT combinator survives a wrapper element
   appearing between the two, so a restructured shell degrades to its own row
   rather than losing the fix. tests/styles.test.ts pins both halves. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.ccp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.ccp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ccp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.ccp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
/* One block per quota window: a head line carrying the window's own spend and
   limit, then the FULL-WIDTH bar under it. Stacking the two lets the card show
   the dollar figures — the reason this surface exists — without squeezing the
   bar into what is left beside them. Mirrors the dashboard's window block. */
.ccp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.ccp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.ccp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.ccp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, which makes display:block load-bearing:
   an inline box ignores width outright, so the fill would collapse to 0x0 and
   the bar would show no usage. */
.ccp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.ccp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own 36px rail cell, so the
   collapsed column keeps a single 18px glyph like its siblings. */
.ccp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.ccp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ccp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph, sized entirely by its own width/height attribute, so the
   footer row, the rail button and the dashboard can each ask for their own. */
.ccp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}

/* ------------------------------------------------------------ dashboard */
.ccp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.ccp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.ccp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.ccp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-spacer{flex:1}
.ccp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}
/* 关闭图标沿用原语义与按钮尺寸，线性 SVG 随宿主文字颜色变化。 */
.ccp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0}
.ccp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

.ccp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.ccp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.ccp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.ccp-noticeError .ccp-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.ccp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.ccp-noticeDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-word}

.ccp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.ccp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.ccp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.ccp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.ccp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.ccp-block{flex-direction:column;gap:8px;display:flex}
.ccp-blockTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}
.ccp-planRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.ccp-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-planName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}

/* The monthly credits and the usage totals share one grid. */
.ccp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.ccp-tile{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-tileLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-tileValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.ccp-tileSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota bars: the monthly bar and the two windows. */
.ccp-windows{flex-direction:column;gap:14px;display:flex}
.ccp-window{flex-direction:column;gap:6px;display:flex}
.ccp-windowHead{align-items:baseline;gap:8px;display:flex}
.ccp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.ccp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.ccp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.ccp-warnTag{white-space:nowrap;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border-radius:999px;padding:0 8px;font-size:12px;font-weight:600;line-height:17px}
.ccp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.ccp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

.ccp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;line-height:17px}
.ccp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.ccp-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.ccp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Account switch: plain buttons, like the settings page's usage carousel. */
.ccp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.ccp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.ccp-tab:hover:not(.ccp-tabActive){color:var(--dsw-alias-label-primary)}
.ccp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (prefers-reduced-motion:reduce){.ccp-footFill,.ccp-barFill{transition:none}}
/* 分析页继承设置页和宿主控件的语义变量；独立选择器不影响账号额度页面。 */
.ccp-mainInnerAnalysis{max-width:1040px;box-sizing:border-box}
/* 宿主侧栏会缩窄中心面板，按实际可用宽度切换列数，而不是仅看浏览器宽度。 */
.ccp-analysis{font-size:14px;line-height:22px;min-width:0;color:var(--dsw-alias-label-primary);container-type:inline-size;container-name:ccp-analysis}
.ccp-analysisFilters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:8px 0 20px}
.ccp-analysisField{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ccp-analysisFilters .ccp-analysisField{flex:0 1 158px}
.ccp-analysisFilters .ccp-analysisScopeField{flex-basis:184px}
.ccp-analysisFilters .ccp-analysisDateField{flex-basis:166px}
/* 对齐原生选择器、日期输入与按钮的边框盒；保留独立箭头留白和点击区域。 */
.ccp-analysisInput{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 11px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}
.ccp-analysisSelectShell{position:relative;display:block;width:100%;min-width:0}
.ccp-analysisSelect{appearance:none;-webkit-appearance:none;padding-inline-end:40px;text-overflow:ellipsis;cursor:pointer;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform)}
.ccp-analysisSelectShell > .ccp-analysisChevron{position:absolute;inset-inline-end:12px;top:50%;transform:translateY(-50%) rotate(90deg);pointer-events:none}
.ccp-analysisSelect:disabled + .ccp-analysisChevron{opacity:.6}
.ccp-analysisInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.ccp-analysisApply{box-sizing:border-box;flex:none;height:36px;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;padding:0 20px;border:0;border-radius:var(--dsw-radius-md,18px);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;margin-left:2px}
.ccp-analysisApply:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ccp-analysisApply:disabled{opacity:.4;cursor:wait}
.ccp-analysisInput:disabled{opacity:.6}
.ccp-analysisInput:focus-visible,.ccp-analysisApply:focus-visible,.ccp-analysisTab:focus-visible,.ccp-analysisPanel:focus-visible,.ccp-analysisModelSummary:focus-visible,.ccp-analysisScenarioSummary:focus-visible,.ccp-analysisDisclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
/* 模型列表会裁切圆角，内收焦点框以保持第一行和最后一行也清晰可见。 */
.ccp-analysisModelSummary:focus-visible,.ccp-analysisScenarioSummary:focus-visible{outline-offset:-3px;border-radius:6px}
.ccp-analysisScope{display:flex;justify-content:space-between;gap:8px 18px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-bottom:12px}
.ccp-analysisScope > span:first-child{color:var(--dsw-alias-label-primary);font-weight:500}
.ccp-analysisOverview{display:grid;grid-template-columns:1.45fr repeat(3,1fr);gap:20px;padding:16px 18px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;font-variant-numeric:tabular-nums}
.ccp-analysisMetric{display:flex;flex-direction:column;gap:3px;min-width:0}
.ccp-analysisLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.ccp-analysisValue{font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.ccp-analysisSub{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:400;overflow-wrap:anywhere}
.ccp-analysisOverview .ccp-analysisMetric{gap:5px}
.ccp-analysisOverview .ccp-analysisValue{font-size:20px;line-height:28px;font-weight:500}
.ccp-analysisNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:9px 0 0}
.ccp-analysisMessage{margin:12px 0 0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-3);font-size:14px;line-height:22px}
.ccp-analysisWarning{display:flex;align-items:flex-start;gap:8px}
.ccp-analysisIcon{flex:none}
.ccp-analysisWarning > .ccp-analysisIcon{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));margin-top:3px}
.ccp-analysisWarning p{margin:0}
.ccp-analysisWarning p + p{margin-top:5px}
.ccp-analysisError{color:var(--dsw-alias-state-error-primary)}
/* 沿用宿主分段控件的轨道、浮层与胶囊尺寸，保留原有页签键盘语义。 */
.ccp-analysisTabs{box-sizing:border-box;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border:0;border-radius:var(--dsw-radius-md,18px);background:var(--dsw-alias-interactive-bg-hover);margin:22px 0 0;max-width:100%}
.ccp-analysisTab{height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm,14px);background:transparent;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.ccp-analysisTab:hover,.ccp-analysisTab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ccp-analysisTab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.ccp-analysisTabCount{display:inline-flex;justify-content:center;min-width:16px;padding:0 4px;margin-left:6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ccp-analysisPanel{padding-top:20px;min-width:0}
.ccp-analysisPanel[hidden]{display:none}
.ccp-analysisSectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.ccp-analysisHeading{font-size:14px;line-height:22px;font-weight:500;margin:0}
.ccp-analysisSectionHead .ccp-analysisNote{margin:0;max-width:56ch}
.ccp-analysisModels{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;overflow:hidden}
.ccp-analysisModelRow + .ccp-analysisModelRow{border-top:.5px solid var(--dsw-alias-border-l2)}
.ccp-analysisTableHead,.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{position:relative;display:grid;grid-template-columns:minmax(190px,2.1fr) minmax(150px,1.45fr) minmax(90px,.9fr) minmax(90px,.9fr) minmax(100px,1fr) 16px;gap:18px;align-items:center;padding:16px 18px;font-variant-numeric:tabular-nums}
.ccp-analysisTableHead{padding-top:11px;padding-bottom:11px;background:var(--dsw-alias-interactive-bg-hover);border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisTableHead > span:not(:first-child){text-align:right}
.ccp-analysisScenarioHead,.ccp-analysisScenarioSummary{grid-template-columns:minmax(190px,2fr) minmax(118px,1.1fr) minmax(155px,1.35fr) minmax(142px,1.15fr) 16px}
.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{cursor:pointer;list-style:none;min-height:60px}
.ccp-analysisModelSummary::-webkit-details-marker,.ccp-analysisScenarioSummary::-webkit-details-marker,.ccp-analysisDisclosure::-webkit-details-marker{display:none}
.ccp-analysisModelSummary:hover,.ccp-analysisScenarioSummary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ccp-analysisIdentity{display:flex;flex-direction:column;gap:2px;min-width:0}
.ccp-analysisModelName{font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.ccp-analysisModelCount{margin-top:3px}
.ccp-analysisModelSummary > .ccp-analysisMetric,.ccp-analysisScenarioSummary > .ccp-analysisMetric{align-items:flex-end}
/* 宽表使用集中表头，但保留每个指标的无障碍标签；窄面板恢复可见标签。 */
.ccp-analysisModelSummary .ccp-analysisMetricLabel,.ccp-analysisScenarioSummary .ccp-analysisMetricLabel,.ccp-analysisSearchLabel{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ccp-analysisShare{display:flex;align-items:center;gap:8px;width:100%;max-width:148px;margin-top:3px}
.ccp-analysisShareTrack{display:block;flex:1;height:4px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px}
.ccp-analysisShareFill{display:block;height:100%;background:var(--dsw-alias-label-secondary);border-radius:999px}
.ccp-analysisShareValue{font-size:12px;line-height:18px;min-width:40px;text-align:right;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisModelRow[open] > .ccp-analysisModelSummary > .ccp-analysisChevron,.ccp-analysisModelRow[open] > .ccp-analysisScenarioSummary > .ccp-analysisChevron,.ccp-analysisAggregate[open] > .ccp-analysisDisclosure > .ccp-analysisChevron,.ccp-analysisRules[open] > .ccp-analysisDisclosure > .ccp-analysisChevron{transform:rotate(90deg)}
.ccp-analysisDetails{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px;padding:16px 18px;background:var(--dsw-alias-bg-module-platform);border-top:.5px solid var(--dsw-alias-border-l2)}
.ccp-analysisDetailTitle{font-size:12px;line-height:18px;font-weight:600;margin:0 0 11px}
.ccp-analysisFacts{margin:0;display:flex;flex-direction:column;gap:8px}
.ccp-analysisFact{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.ccp-analysisFactValue{font-size:14px;line-height:22px;margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}
.ccp-analysisFact .ccp-analysisLabel{flex-shrink:0}
.ccp-analysisFooter{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:14px}
.ccp-analysisAggregate{flex:1;min-width:210px}
.ccp-analysisAggregate > .ccp-analysisDetails{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;margin-top:6px}
.ccp-analysisDisclosure{display:flex;gap:7px;align-items:center;cursor:pointer;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:7px 0}
.ccp-analysisDisclosure > .ccp-analysisChevron{width:14px;height:14px}
.ccp-analysisMonthly{flex:none;max-width:340px;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:2px 8px;align-items:baseline;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding-top:5px}
.ccp-analysisMonthlyValue{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ccp-analysisMonthly .ccp-analysisNote{width:100%;margin:0}
.ccp-analysisAssumption{font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);margin:0 0 18px;max-width:76ch}
.ccp-analysisBaseline{margin:0 0 16px}
.ccp-analysisSearch{flex:0 1 270px}
.ccp-analysisSearchShell{position:relative;display:block}
.ccp-analysisSearchShell > .ccp-analysisIcon{position:absolute;top:10px;left:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.ccp-analysisSearch .ccp-analysisInput{padding-left:35px}
.ccp-analysisScenarioDetails{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
.ccp-analysisScenarioDetails .ccp-analysisFactValue{max-width:70%}
.ccp-analysisEmpty{font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:34px 18px;margin:0;border:1px dashed var(--dsw-alias-border-l4);border-radius:8px}
.ccp-analysisRules{margin-top:22px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.ccp-analysisRulesBody{display:grid;grid-template-columns:1fr 1fr;gap:24px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;margin-top:9px}
.ccp-analysisRulesBody p{margin:0 0 10px}
@container ccp-analysis (max-width:920px){
.ccp-analysisTableHead{display:none}
.ccp-analysisModelSummary{grid-template-columns:repeat(4,minmax(0,1fr)) 16px;gap:12px 18px}
.ccp-analysisScenarioSummary{grid-template-columns:repeat(3,minmax(0,1fr)) 16px;gap:12px 18px}
.ccp-analysisModelSummary > .ccp-analysisIdentity,.ccp-analysisScenarioSummary > .ccp-analysisIdentity{grid-column:1/-2}
.ccp-analysisModelSummary > .ccp-analysisChevron{grid-column:5;grid-row:1;justify-self:end}
.ccp-analysisScenarioSummary > .ccp-analysisChevron{grid-column:4;grid-row:1;justify-self:end}
.ccp-analysisModelSummary > .ccp-analysisMetric,.ccp-analysisScenarioSummary > .ccp-analysisMetric{align-items:flex-start}
.ccp-analysisModelSummary .ccp-analysisMetricLabel,.ccp-analysisScenarioSummary .ccp-analysisMetricLabel{position:static;width:auto;height:auto;padding:0;margin:0;overflow:visible;clip:auto;white-space:normal}
.ccp-analysisDetails{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@container ccp-analysis (max-width:588px){
.ccp-analysisFilters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ccp-analysisFilters[data-mode="range"] .ccp-analysisScopeField{grid-column:1/-1}
.ccp-analysisApply{grid-column:1/-1;margin:0;width:100%}
.ccp-analysisOverview{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 18px;padding:16px}
.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 18px;padding:16px}
.ccp-analysisModelSummary > .ccp-analysisIdentity,.ccp-analysisScenarioSummary > .ccp-analysisIdentity{grid-column:1/-1;padding-right:24px}
.ccp-analysisModelSummary > .ccp-analysisChevron,.ccp-analysisScenarioSummary > .ccp-analysisChevron{position:absolute;top:18px;right:16px;grid-column:auto;grid-row:auto}
.ccp-analysisDetails,.ccp-analysisScenarioDetails{gap:20px;grid-template-columns:1fr;padding:16px}
.ccp-analysisAggregate{width:100%;min-width:0}
.ccp-analysisMonthly{width:100%;max-width:none;justify-content:flex-start;text-align:left;padding-top:0}
.ccp-analysisSectionHead{align-items:flex-start}
.ccp-analysisSectionHead .ccp-analysisSearch{flex-basis:100%;width:100%;order:2}
.ccp-analysisRulesBody{grid-template-columns:1fr;gap:12px}
/* 英文页签带数量时允许换行，避免轨道或文字撑出宿主的窄面板。 */
.ccp-analysisTabs{margin-top:18px;grid-auto-columns:minmax(0,1fr)}
.ccp-analysisTab{height:auto;min-height:28px;padding:4px 8px;white-space:normal}
}
@media (max-width:640px){.ccp-mainInnerAnalysis{padding:20px 16px 32px}}
`;
		//#endregion
		//#region src/client/analytics.ts
		/** 手动读取历史，旧宿主可降级；查询切换和卸载后不接受过期结果。 */
		var AnalyticsController = class {
			remote;
			current = { status: "idle" };
			listeners = /* @__PURE__ */ new Set();
			generation = 0;
			disposed = false;
			query = {
				mode: "recent",
				limit: 20
			};
			constructor(remote) {
				this.remote = remote;
			}
			state() {
				return this.current;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			dispose() {
				this.disposed = true;
				this.generation++;
				this.listeners.clear();
			}
			reload() {
				this.generation++;
				this.set({ status: "idle" });
			}
			refresh(query = this.query) {
				if (this.disposed) return;
				const requested = parseAnalyticsQuery(query);
				this.query = requested;
				const generation = ++this.generation;
				this.set({ status: "loading" });
				const call = this.remote.analytics;
				if (!call) {
					this.set({
						status: "error",
						error: "宿主不支持模型分析，请更新插件"
					});
					return;
				}
				Promise.resolve().then(() => call(requested)).then((result) => {
					if (this.disposed || generation !== this.generation) return;
					if (!result.ok) {
						this.set({
							status: "error",
							error: result.error.message === "宿主不支持模型分析，请更新插件" ? result.error.message : "模型分析读取失败，请稍后刷新或检查宿主日志"
						});
						return;
					}
					this.set({
						status: "ready",
						report: parseAnalyticsReport(result.value)
					});
				}).catch(() => {
					if (!this.disposed && generation === this.generation) this.set({
						status: "error",
						error: "模型分析读取失败，请稍后刷新或检查宿主日志"
					});
				});
			}
			set(state) {
				this.current = state;
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/index.ts
		/** Install one stylesheet by id and return a disposer for its owning effect. */
		function injectCss(id, css) {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "@mars-sea/dsh-commandcode-provider";
			tag.dataset.pluginCss = id;
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => tag.remove();
		}
		/**
		* Plans & quota panel id. It is the layout's `MainPanelId`: one string shared
		* by the `sidebar.footer.action` card and the `main` slot cell, so the card
		* selects this panel and nothing else. `dsh-client-ui-layout` is not a
		* dependency of this bundle, so its brand is applied at the call site instead
		* of importing the package.
		*/
		const PANEL_ID = "commandcode-panel";
		/**
		* The composer figure's entry id in `conversation.composer.dock`. Its own id,
		* never the shipped `stats` cell's: reusing that id would REPLACE the tokens /
		* cache-hit / throughput readout rather than inject into it, and that readout
		* is the harness's to format.
		*/
		const SESSION_COST_ID = "commandcode-session-cost";
		/**
		* Client plugin body. Gates on `slots`, `locale` and `remote` — never on
		* `settingsScope`, whose wrapper service the 0.1.7 settings rewrite removed
		* (the scope below speaks the `remote.settings` wire directly), because
		* gating on a service 0.1.7 does not provide would park EVERY surface below
		* into silence. `settingsScope` must never reappear in the exported inject
		* list at the bottom of this file.
		*/
		function apply(ctx) {
			injectCss(PAGE_CSS_ID, PAGE_CSS);
			ctx.effect(() => ctx.locale.register("settings.commandcode", {
				zh,
				en
			}), "dsh-commandcode-provider: page copy");
			ctx.effect(() => ctx.locale.register(PANEL_LOCALE_NS, {
				zh: PANEL_COPY_ZH,
				en: PANEL_COPY_EN
			}), "dsh-commandcode-provider: panel copy");
			ctx.inject(["remote.credentials"], (remoteCtx) => {
				const credentials = remoteCtx.remote.credentials;
				applyClientSurfaces(remoteCtx, { credentials });
			});
		}
		/** Mount the one shared UI implementation. */
		function applyClientSurfaces(ctx, api) {
			let settingsNamespace;
			const scope = createSettingsScope(ctx, COMMANDCODE_NS, () => settingsNamespace);
			ctx.effect(() => () => {
				scope.dispose();
			}, "dsh-commandcode-provider: settings scope");
			ctx.inject(["remote.settings"], (settingsCtx) => {
				settingsNamespace = settingsCtx.remote.settings;
				scope.refresh();
				settingsCtx.effect(() => () => {
					settingsNamespace = void 0;
				}, "dsh-commandcode-provider: settings namespace");
			});
			let modelsRemote;
			const controller = new CommandCodeSettingsController(scope, {
				...api,
				models: () => modelsRemote?.() ?? Promise.resolve({
					ok: false,
					error: { message: "commandcode/models remote is not mounted" }
				})
			});
			ctx.effect(() => () => controller.dispose(), "dsh-commandcode-provider: settings controller");
			const store = createSnapshotStore(controller.state());
			controller.subscribe(() => store.set(controller.state()));
			ctx.effect(() => {
				const remote = ctx.remote;
				const unregisterReference = remote.$on("credentials/reference-updated", () => {
					controller.refreshCredentials();
				});
				const unregisterRecord = remote.$on("credentials/record-updated", () => {
					controller.refreshCredentials();
				});
				return () => {
					unregisterReference();
					unregisterRecord();
				};
			}, "dsh-commandcode-provider: credential invalidations");
			let usageNamespace;
			let usageMountError;
			let pricesController;
			let refreshUsage;
			let analyticsController;
			const contribution = {
				package: USAGE_REMOTE_CONTRIBUTION.package,
				descriptors: [
					...USAGE_REMOTE_CONTRIBUTION.descriptors,
					...MODELS_REMOTE_CONTRIBUTION.descriptors,
					...PRICES_REMOTE_CONTRIBUTION.descriptors,
					...ANALYTICS_REMOTE_CONTRIBUTION.descriptors,
					...PROBE_REMOTE_CONTRIBUTION.descriptors,
					...LOGIN_REMOTE_CONTRIBUTION.descriptors,
					...ENROLLMENT_REMOTE_CONTRIBUTION.descriptors
				]
			};
			ctx.effect(() => {
				let cancelled = false;
				let unmount;
				ctx.remote.$mount(contribution).then((dispose) => {
					if (cancelled) {
						dispose();
						return;
					}
					unmount = dispose;
					ctx.inject(["remote.commandcode"], (namespaceCtx) => {
						usageNamespace = namespaceCtx.remote.commandcode;
						controller.refreshCatalog();
						pricesController?.reload();
						analyticsController?.reload();
						refreshUsage?.();
						namespaceCtx.effect(() => () => {
							usageNamespace = void 0;
							analyticsController?.reload();
						}, "dsh-commandcode-provider: usage namespace");
					});
				}, (error) => {
					usageMountError = readableErrorText(error);
				});
				return () => {
					cancelled = true;
					usageNamespace = void 0;
					if (unmount !== void 0) unmount();
				};
			}, "dsh-commandcode-provider: usage remote");
			const usageRemote = {
				report: async () => {
					const namespace = usageNamespace;
					if (namespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode/report remote is not mounted" }
					};
					return namespace.report();
				},
				models: async () => {
					const namespace = usageNamespace;
					if (namespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode/models remote is not mounted" }
					};
					return namespace.models();
				},
				prices: async () => {
					const namespace = usageNamespace;
					if (namespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode/prices remote is not mounted" }
					};
					const call = namespace.prices;
					if (typeof call !== "function") return {
						ok: false,
						error: {
							message: "the Host serves no commandcode/prices endpoint",
							permanent: true
						}
					};
					return call.call(namespace);
				}
			};
			modelsRemote = () => usageRemote.models();
			const usageController = new CommandCodeUsageController(usageRemote);
			refreshUsage = () => void usageController.refresh();
			ctx.effect(() => () => usageController.dispose(), "dsh-commandcode-provider: usage controller");
			const usageStore = createSnapshotStore(usageController.state());
			usageController.subscribe(() => usageStore.set(usageController.state()));
			pricesController = new CommandCodePricesController(usageRemote);
			ctx.effect(() => () => pricesController?.dispose(), "dsh-commandcode-provider: price table");
			const pricesStore = createSnapshotStore(pricesController.state());
			pricesController.subscribe(() => pricesStore.set(pricesController.state()));
			analyticsController = new AnalyticsController({ analytics: async (query) => {
				const namespace = usageNamespace;
				if (typeof namespace?.analytics !== "function") return {
					ok: false,
					error: { message: "宿主不支持模型分析，请更新插件" }
				};
				return namespace.analytics(query);
			} });
			const analyticsStore = createSnapshotStore(analyticsController.state());
			analyticsController.subscribe(() => analyticsStore.set(analyticsController.state()));
			ctx.effect(() => () => analyticsController?.dispose(), "commandcode analytics controller");
			const panelMode = createSnapshotStore("quota");
			const openAnalytics = () => {
				panelMode.set("analysis");
				ctx.get("layout")?.selectPanel(PANEL_ID);
			};
			const loginRemote = {
				loginBegin: async (targetRef) => {
					if (usageNamespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode remote is not mounted" }
					};
					return usageNamespace.loginBegin(targetRef);
				},
				loginStatus: async () => {
					if (usageNamespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode remote is not mounted" }
					};
					return usageNamespace.loginStatus();
				},
				loginCancel: async () => {
					if (usageNamespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode remote is not mounted" }
					};
					return usageNamespace.loginCancel();
				}
			};
			const loginController = new CommandCodeLoginController(() => loginRemote);
			ctx.effect(() => () => loginController.dispose(), "dsh-commandcode-provider: login controller");
			const loginStore = createSnapshotStore(loginController.state());
			let lastLoginPhase = loginController.state().phase;
			loginController.subscribe(() => {
				const phase = loginController.state().phase;
				if (phase === "success" && lastLoginPhase !== "success") {
					controller.refreshCredentials();
					usageController.refresh();
				}
				lastLoginPhase = phase;
				loginStore.set(loginController.state());
			});
			const refreshUsageOn = (ok) => {
				const outcome = controller.state().accountResult;
				if (ok || outcome?.config === "confirmed" || outcome?.credential === "confirmed") usageController.refresh();
				return ok;
			};
			const injected = () => ({
				probeService: () => {
					const namespace = usageNamespace;
					if (typeof namespace?.probe !== "function") return Promise.resolve({
						ok: false,
						error: { message: "宿主未提供连通性探测" }
					});
					return namespace.probe();
				},
				createEnrollment: () => new AccountEnrollmentController(() => {
					if (!usageNamespace?.enrollmentBegin) throw new Error("宿主不支持账号开通，请更新插件");
					return usageNamespace;
				}, () => {
					scope.refresh();
					controller.refreshCredentials();
					usageController.refresh();
				}),
				hooks: {
					commandCodeSettings: store,
					commandCodeUsage: usageStore,
					commandCodeLogin: loginStore
				},
				edit: (field, text) => controller.edit(field, text),
				resetField: (field) => controller.resetField(field),
				save: () => void controller.save().then((outcome) => {
					if (outcome?.config === "confirmed" || outcome?.credential === "confirmed") usageController.refresh();
				}),
				discard: () => controller.discard(),
				refreshCredentials: () => void controller.refreshCredentials(),
				refreshUsage: () => void usageController.refresh(),
				refreshUsageAuto: () => void usageController.refresh({ auto: true }),
				...typeof ctx.get("layout")?.selectPanel === "function" ? { openAnalytics } : {},
				beginLogin: (targetRef) => void loginController.begin(targetRef),
				cancelLogin: () => void loginController.cancel(),
				renameAccount: (ref, label) => controller.renameAccount(ref, label),
				removeAccount: (ref) => controller.removeAccount(ref).then((ok) => {
					if (ok || !controller.state().accounts.some((account) => account.ref === ref)) usageController.refresh();
					return ok;
				}),
				retryCredentialCleanup: (ref) => controller.retryCredentialCleanup(ref).then(refreshUsageOn),
				setAccountKey: (target, key) => controller.setAccountKey(target, key).then(refreshUsageOn),
				clearAccountKey: (target) => controller.clearAccountKey(target).then(refreshUsageOn),
				setActiveAccount: (id) => controller.setActiveAccount(id).then(refreshUsageOn),
				setAccountModels: (target, ids) => controller.setAccountModels(target, ids),
				editVisibleModels: (ids) => controller.editVisibleModels(ids),
				clearVisibleModels: () => controller.clearVisibleModels(),
				editContextWindowOverrides: (next) => controller.editContextWindowOverrides(next)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "commandcode",
				order: 12,
				label: () => ctx.locale.bind("settings.commandcode")("nav"),
				locale: "settings.commandcode",
				inject: injected
			}, CommandCodeSettingsPage));
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: "llm-commandcode",
				locale: "settings.commandcode",
				inject: () => ({
					hooks: {
						commandCodeSettings: store,
						commandCodeLogin: loginStore
					},
					edit: (field, text) => controller.edit(field, text),
					save: () => void controller.save().then((outcome) => {
						if (outcome?.config === "confirmed" || outcome?.credential === "confirmed") usageController.refresh();
					}),
					discard: () => controller.discard(),
					refreshCredentials: () => void controller.refreshCredentials(),
					beginLogin: () => void loginController.begin(),
					cancelLogin: () => void loginController.cancel()
				})
			}, CommandCodeProviderCard));
			const panelFace = () => ({
				hooks: {
					commandCodeUsage: usageStore,
					commandCodeSettings: store,
					commandCodeAnalytics: analyticsStore,
					commandCodePanelMode: panelMode
				},
				selectPanelMode: (mode) => panelMode.set(mode),
				refreshAnalytics: (query) => analyticsController?.refresh(query),
				refresh: () => {
					pricesController?.ensure();
					usageController.refresh();
				},
				startAutoRefresh: () => startPanelAutoRefresh(usageController, () => true),
				open: () => {
					panelMode.set("quota");
					ctx.get("layout")?.selectPanel(PANEL_ID);
				},
				close: () => {
					ctx.get("layout")?.selectPanel(null);
				}
			});
			ctx.effect(() => injectCss(PANEL_CSS_ID, PANEL_CSS), "dsh-commandcode-provider: panel styles");
			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: PANEL_LOCALE_NS,
					inject: panelFace
				}, CommandCodePanel));
			} catch (error) {
				console.error("[dsh-commandcode-provider] could not register the plans & quota panel:", error);
			}
			ctx.inject(["layout"], (layoutCtx) => {
				try {
					layoutCtx.slots.inject("sidebar.footer.action", () => layoutCtx.slots.register({
						name: "sidebar.footer.action",
						id: PANEL_ID,
						order: 1,
						locale: PANEL_LOCALE_NS,
						inject: panelFace
					}, CommandCodeFooterEntry));
				} catch (error) {
					console.error("[dsh-commandcode-provider] could not register the sidebar footer card:", error);
				}
			});
			const sessionCostFace = () => ({ hooks: { commandCodePrices: pricesStore } });
			try {
				ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
					name: "conversation.composer.dock",
					id: SESSION_COST_ID,
					inject: sessionCostFace
				}, CommandCodeSessionCost));
			} catch (error) {
				console.error("[dsh-commandcode-provider] could not register the composer session-cost readout:", error);
			}
		}
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map